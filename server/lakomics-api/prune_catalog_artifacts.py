"""Server-local mobile catalog retention; default to a read-only dry run.

Publication and user-snapshot rows are history: rollback validation and bookmark
authority activation retries still use them. Only content artifact rows are GC'd.
The CLI never initializes schemas or creates the control database.

Dry runs may run while the API is serving and are advisory snapshots. Applying
requires --api-stopped: the operator acknowledges that lakomics-api.service is
stopped and stays stopped until this command exits. This flag does not stop or
inspect services. BEGIN IMMEDIATE cannot protect uploads/materialization outside
control-DB transactions. Do not run other catalog writers during maintenance.

On the VPS, from the API package directory, use this exact order (adjust --db
only if the service uses another control database):

    sudo systemctl stop lakomics-local-proxy.service
    sudo systemctl stop lakomics-api.service
    .venv/bin/python prune_catalog_artifacts.py --db data/lakomics.sqlite3 --dry-run
    .venv/bin/python prune_catalog_artifacts.py --db data/lakomics.sqlite3 --apply --api-stopped
    sudo systemctl start lakomics-api.service
    sudo systemctl start lakomics-local-proxy.service

Inspect the dry-run output before applying. If either CLI command fails, inspect
the error before proceeding; restart API, then proxy when maintenance is over.
Queued/running refresh jobs are retained conservatively, even with expired leases.
Deleting a data link does not free an inode still linked from an operator backup.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack, closing
from dataclasses import dataclass, field
from datetime import datetime
import fcntl
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time

import api_auth
import mobile_catalog_replica as replica

RETENTION_SECONDS = 48 * 60 * 60
TEMP_SECONDS = 60 * 60
DIGEST = r"[a-f0-9]{64}"
CONTENT = re.compile(rf"({DIGEST})\.sqlite")
USERS = re.compile(rf"({DIGEST})-users(?:-v2)?\.sqlite")
# tempfile's random suffix is eight characters. In particular, do not sweep
# arbitrary .sqlite files, backups, or digest-named files with a temp prefix.
TEMP = re.compile(r"(?:upload-[a-z0-9_]{8}\.ndjson|(?:catalog|users|refresh-content)-[a-z0-9_]{8}\.sqlite)")


@dataclass
class Entry:
    name: str
    info: os.stat_result
    kind: str = "unknown"
    key: str | None = None
    reasons: set[str] = field(default_factory=set)

    @property
    def delete(self):
        return not self.reasons


def open_directory(path):
    """Pin the directory and reject symlinks in every path component."""
    path = Path(os.path.abspath(path))
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def control_backup(root_fd, entry):
    """Protect renamed SQLite control backups even with an artifact-like name.

    Open through a pinned, non-symlink descriptor. immutable avoids creating WAL
    or journal sidecars while inspecting a sealed file. A damaged SQLite header
    is ambiguous, so retain it rather than guessing what the file used to be.
    """
    fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        if os.read(fd, 16) != b"SQLite format 3\x00":
            return False
        try:
            db = sqlite3.connect(f"file:/proc/self/fd/{fd}?mode=ro&immutable=1", uri=True)
            try:
                return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('mobile_catalog_current','mobile_catalog_artifacts','mobile_catalog_publications') LIMIT 1").fetchone() is not None
            finally:
                db.close()
        except sqlite3.Error:
            return True
    finally:
        os.close(fd)


def plan(db, root_fd, control_info, now):
    """Read one DB snapshot; applying additionally requires writer exclusion."""
    publications = list(db.execute("SELECT rowid AS ordinal,* FROM mobile_catalog_publications ORDER BY rowid"))
    artifacts = list(db.execute("SELECT * FROM mobile_catalog_artifacts"))
    current = replica.current(db)
    pointer = db.execute("SELECT publication_revision FROM mobile_catalog_current WHERE singleton=1").fetchone()
    if pointer is not None and current is None:
        raise ValueError("Current publication is missing; refusing to prune")
    retained = {}
    contents = {}

    def keep(mapping, key, reason):
        mapping.setdefault(key, set()).add(reason)

    for row in publications:
        published = timestamp(row["published_at"])
        if published is None:
            keep(retained, row["revision"], "uncertain publication time")
        elif published >= now - RETENTION_SECONDS:
            keep(retained, row["revision"], "publication within 48h")
    if current:
        keep(retained, current["revision"], "current publication")
        # Revisions are immutable, including published_at. There is no separate
        # pointer-change ledger. Use publication time with insertion order as a
        # tie-breaker, including when current points back to an older revision.
        def publication_order(row):
            published = timestamp(row["published_at"])
            return (float("inf") if published is None else published, row["ordinal"])

        ordered = sorted(publications, key=publication_order)
        index = next(i for i, row in enumerate(ordered) if row["revision"] == current["revision"])
        for row in ordered[max(0, index - 2):index]:
            keep(retained, row["revision"], "previous two publications")

    pc = []
    for row in artifacts:
        if row["ready_at"] == "server-refresh":
            continue
        try:
            ready = float(row["ready_at"])
            if not math.isfinite(ready):
                raise ValueError()
            pc.append((ready, row["digest"]))
        except (ValueError, TypeError):
            keep(contents, row["digest"], "uncertain PC upload time")
    if pc:
        newest = max(ready for ready, _ in pc)
        for ready, digest in pc:
            if ready == newest:
                keep(contents, digest, "newest PC upload")

    has_jobs = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mobile_catalog_refresh_jobs'").fetchone()
    active = has_jobs and db.execute("SELECT 1 FROM mobile_catalog_refresh_jobs WHERE state IN ('queued','running') LIMIT 1").fetchone()
    entries = []
    for name in sorted(os.listdir(root_fd)):
        try:
            info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        entry = Entry(name, info)
        entries.append(entry)
        if not stat.S_ISREG(info.st_mode):
            entry.reasons.add("symlink or non-regular entry")
            continue
        if (info.st_dev, info.st_ino) == (control_info.st_dev, control_info.st_ino):
            entry.reasons.add("control database")
            continue
        content, users = CONTENT.fullmatch(name), USERS.fullmatch(name)
        if content:
            entry.kind, entry.key = "content", content[1]
        elif users:
            entry.kind, entry.key = "users", users[1]
        elif TEMP.fullmatch(name):
            entry.kind = "temp"
        else:
            entry.reasons.add("unrecognized name (including backups)")
            continue
        if active:
            # Jobs do not persist their materialization source. Even an expired
            # lease may have a worker still holding a source: do not guess.
            entry.reasons.add("queued/running refresh; source uncertain")
        cutoff = TEMP_SECONDS if entry.kind == "temp" else RETENTION_SECONDS
        if info.st_mtime >= now - cutoff:
            entry.reasons.add("mtime within 1h" if entry.kind == "temp" else "mtime within 48h")
        try:
            if control_backup(root_fd, entry):
                entry.reasons.add("control backup or uncertain SQLite file")
        except FileNotFoundError:
            entry.reasons.add("disappeared during scan")
        if entry.reasons and entry.kind == "users":
            for reason in entry.reasons:
                keep(retained, entry.key, reason)
        if entry.reasons and entry.kind == "content":
            for reason in entry.reasons:
                keep(contents, entry.key, reason)

    for row in publications:
        for reason in retained.get(row["revision"], ()):
            keep(contents, row["content_digest"], reason)
    for entry in entries:
        if entry.kind == "content":
            entry.reasons.update(contents.get(entry.key, ()))
        elif entry.kind == "users":
            entry.reasons.update(retained.get(entry.key, ()))
    return entries


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def execute_plan(db, root_fd, entries, *, apply=False, output=None):
    """For apply, the API stays stopped and the CLI lock spans both phases."""
    output = output or sys.stdout
    selected = [entry for entry in entries if entry.delete]
    # Recheck everything before the first mutation. A changed/vanished file
    # during discovery is reason to retry, not to apply a stale decision.
    if apply:
        for entry in selected:
            try:
                info = os.stat(entry.name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if fingerprint(info) != fingerprint(entry.info):
                raise ValueError(f"Catalog file changed; retry: {entry.name}")
    for entry in entries:
        action = "DELETE" if entry.delete else "KEEP"
        reason = ", ".join(sorted(entry.reasons)) if entry.reasons else (
            "temp older than 1h" if entry.kind == "temp" else "outside all retention rules")
        print(f"{action} {entry.name!r} size={entry.info.st_size} links={entry.info.st_nlink} rule={reason}", file=output)

    deleted = 0
    missing = 0
    errors = []
    if apply:
        db.executemany("DELETE FROM mobile_catalog_artifacts WHERE digest=?",
                       [(entry.key,) for entry in selected if entry.kind == "content"])
        db.commit()
        # Publication and users rows deliberately remain. Missing immutable
        # files are interpreted as an expired snapshot by open_publication.
        for entry in selected:
            try:
                info = os.stat(entry.name, dir_fd=root_fd, follow_symlinks=False)
                # st_nlink/ctime may have changed after unlinking another name
                # of the same inode. Never follow or remove a replacement.
                if (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns) != (
                        entry.info.st_dev, entry.info.st_ino, entry.info.st_mode,
                        entry.info.st_size, entry.info.st_mtime_ns):
                    raise ValueError("file replaced; retained")
                os.unlink(entry.name, dir_fd=root_fd)
                deleted += 1
            except FileNotFoundError:
                missing += 1
            except (OSError, ValueError) as exc:
                errors.append(entry.name)
                print(f"ERROR {entry.name!r}: {exc}", file=output)
    else:
        db.rollback()

    inodes = {}
    for entry in selected:
        identity = (entry.info.st_dev, entry.info.st_ino)
        group = inodes.setdefault(identity, [entry.info, 0])
        group[1] += 1
    reclaimable = sum(info.st_blocks * 512 for info, count in inodes.values() if count == info.st_nlink)
    total = sum(entry.info.st_size for entry in selected)
    mode = "APPLY" if apply else "DRY RUN"
    counts = Counter(reason for entry in entries for reason in entry.reasons)
    rules = "; ".join(f"{rule}={count}" for rule, count in sorted(counts.items())) or "none"
    print(f"Kept by rule (files may count under multiple rules): {rules}", file=output)
    print(f"{mode} summary: files={len(entries)} retained={len(entries) - len(selected)} selected={len(selected)} "
          f"deleted={deleted} already_gone={missing} errors={len(errors)} "
          f"total_file_bytes={total} estimated_bytes_to_free={reclaimable} "
          "(other hard links and open readers may delay/prevent reclamation)", file=output)
    return 1 if errors else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prune expired mobile catalog files; default is dry run.")
    parser.add_argument("--db", type=Path, default=api_auth.DEFAULT_DB,
                        help="existing control database (default: %(default)s)")
    parser.add_argument("--root", type=Path,
                        help="catalog directory (default: mobile-catalog beside --db, as in the API)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="report only (the default); API may be running")
    mode.add_argument("--apply", action="store_true", help="delete files; requires --api-stopped")
    parser.add_argument("--api-stopped", action="store_true",
                        help="acknowledge lakomics-api.service is stopped and stays stopped during pruning")
    args = parser.parse_args(argv)
    if args.apply and not args.api_stopped:
        print("Refusing --apply: stop lakomics-local-proxy.service, then lakomics-api.service; "
              "pass --api-stopped to acknowledge the API is stopped. See the module docstring.", file=sys.stderr)
        return 2

    db_path = Path(os.path.abspath(args.db))
    root = args.root if args.root is not None else db_path.parent / "mobile-catalog"
    try:
        with ExitStack() as stack:
            parent_fd = open_directory(db_path.parent)
            stack.callback(os.close, parent_fd)
            db_fd = os.open(db_path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            stack.callback(os.close, db_fd)
            control_info = os.fstat(db_fd)
            if not stat.S_ISREG(control_info.st_mode):
                raise ValueError("Control database must be a regular file")
            root_fd = open_directory(root)
            stack.callback(os.close, root_fd)
            if args.apply:
                # Serialize operator CLIs through post-commit unlinking. API
                # writers do not share this lock: --api-stopped is essential.
                try:
                    fcntl.flock(root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise ValueError("Another catalog maintenance command holds the directory lock") from exc
            access = "rw" if args.apply else "ro"
            db = stack.enter_context(closing(sqlite3.connect(
                db_path.as_uri() + f"?mode={access}", uri=True, timeout=10)))
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE" if args.apply else "BEGIN")
            entries = plan(db, root_fd, control_info, time.time())
            return execute_plan(db, root_fd, entries, apply=args.apply)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print("ABORTED summary: maintenance did not complete; inspect the error before retrying.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
