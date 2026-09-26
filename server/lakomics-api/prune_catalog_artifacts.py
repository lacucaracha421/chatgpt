"""Mobile catalog retention: automatic in the API, and an operator CLI (dry run default).

Publication and user-snapshot rows are history: rollback validation and bookmark
authority activation retries still use them. Only content artifact rows are GC'd.
The CLI never initializes schemas or creates the control database.

Every catalog writer in the API (PC upload import, publish with its server
materialization and users projection) holds ``<catalog>/.catalog.lock`` shared
while it creates, links and registers files; the pruner holds it exclusively,
non-blocking, for plan + delete. The API prunes by itself (AutoPruner: about a
minute after startup, hourly, and after each publish or refresh); set
LAKOMICS_CATALOG_AUTO_PRUNE=0 to disable it and LAKOMICS_CATALOG_RETENTION_HOURS
(default 3, minimum = the 2-hour token TTL plus a 1-hour safety margin) to
change the retention window. When upgrading from 24-hour tokens, temporarily
keep LAKOMICS_CATALOG_RETENTION_HOURS=48 until 24 hours after the last old API
process stops issuing tokens; then unset it to use the new default.

The CLI's --apply takes the same lock, so it is safe while an API that takes the
lock is running (an older API build without the lock must still be stopped).
If a writer or another pruner holds the lock, --apply refuses; retry. Dry runs
take no lock and are advisory snapshots. From the API package directory:

    .venv/bin/python prune_catalog_artifacts.py --db data/lakomics.sqlite3 --dry-run
    .venv/bin/python prune_catalog_artifacts.py --db data/lakomics.sqlite3 --apply

--api-stopped is still accepted and no longer required. Queued/running refresh
jobs retain every catalog file conservatively, even with expired leases.
Deleting a data link does not free an inode still linked from an operator backup.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack, closing
from dataclasses import dataclass, field
from datetime import datetime
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import threading
import time

import api_auth
import mobile_catalog_replica as replica
from mobile_catalog import TTL

RETENTION_SAFETY_SECONDS = 60 * 60
MIN_RETENTION_SECONDS = TTL + RETENTION_SAFETY_SECONDS
RETENTION_SECONDS = max(3 * 60 * 60, MIN_RETENTION_SECONDS)
TEMP_SECONDS = 60 * 60
AUTO_PRUNE_ENV = "LAKOMICS_CATALOG_AUTO_PRUNE"
RETENTION_ENV = "LAKOMICS_CATALOG_RETENTION_HOURS"
PRUNE_INTERVAL_SECONDS = 60 * 60
PRUNE_INITIAL_DELAY_SECONDS = 60
DIGEST = r"[a-f0-9]{64}"
CONTENT = re.compile(rf"({DIGEST})\.sqlite")
USERS = re.compile(rf"({DIGEST})-users(?:-v2)?\.sqlite")
# tempfile's random suffix is eight characters. In particular, do not sweep
# arbitrary .sqlite files, backups, or digest-named files with a temp prefix.
TEMP = re.compile(r"(?:upload-[a-z0-9_]{8}\.ndjson|(?:catalog|users|refresh-content)-[a-z0-9_]{8}\.sqlite)")
LOG = logging.getLogger(__name__)


def auto_prune_enabled(environ=None):
    value = (os.environ if environ is None else environ).get(AUTO_PRUNE_ENV, "1")
    return value.strip().lower() not in ("0", "false", "no", "off")


def retention_seconds(environ=None):
    """Retention window from the environment; invalid values keep the default."""
    raw = (os.environ if environ is None else environ).get(RETENTION_ENV, "").strip()
    if not raw:
        return RETENTION_SECONDS
    try:
        hours = float(raw)
        if not math.isfinite(hours):
            raise ValueError()
    except ValueError:
        LOG.warning("Ignoring invalid %s; using %d hours", RETENTION_ENV, RETENTION_SECONDS // 3600)
        return RETENTION_SECONDS
    return max(MIN_RETENTION_SECONDS, hours * 3600)


def hours_label(seconds):
    return f"{seconds / 3600:g}h"


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


def plan(db, root_fd, control_info, now, retention=RETENTION_SECONDS):
    """Read one DB snapshot; applying additionally requires the exclusive catalog lock."""
    retention = max(MIN_RETENTION_SECONDS, retention)
    window = hours_label(retention)
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
        elif published >= now - retention:
            keep(retained, row["revision"], f"publication within {window}")
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
        if name == replica.LOCK_NAME:
            entry.reasons.add("catalog lock file")
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
            # Jobs do not persist their materialization source. Materialization now
            # runs under the catalog lock, but stay conservative: a job may still be
            # about to read a source, and jobs only run for minutes.
            entry.reasons.add("queued/running refresh; source uncertain")
        cutoff = TEMP_SECONDS if entry.kind == "temp" else retention
        if info.st_mtime >= now - cutoff:
            entry.reasons.add("mtime within 1h" if entry.kind == "temp" else f"mtime within {window}")
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


@dataclass
class Summary:
    files: int = 0
    selected: int = 0
    deleted: int = 0
    missing: int = 0
    errors: list = field(default_factory=list)
    total_bytes: int = 0
    freed_bytes: int = 0

    @property
    def exit_code(self):
        return 1 if self.errors else 0


def execute_plan(db, root_fd, entries, *, apply=False, output=None, verbose=True):
    """Report and optionally apply a plan; apply requires the exclusive catalog lock.

    Returns a Summary; ``exit_code`` is 1 when any selected file could not be removed.
    """
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
    if verbose:
        for entry in entries:
            action = "DELETE" if entry.delete else "KEEP"
            reason = ", ".join(sorted(entry.reasons)) if entry.reasons else (
                "temp older than 1h" if entry.kind == "temp" else "outside all retention rules")
            print(f"{action} {entry.name!r} size={entry.info.st_size} links={entry.info.st_nlink} rule={reason}", file=output)

    summary = Summary(files=len(entries), selected=len(selected))
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
                summary.deleted += 1
            except FileNotFoundError:
                summary.missing += 1
            except (OSError, ValueError) as exc:
                summary.errors.append(entry.name)
                print(f"ERROR {entry.name!r}: {exc}", file=output)
    else:
        db.rollback()

    inodes = {}
    for entry in selected:
        identity = (entry.info.st_dev, entry.info.st_ino)
        group = inodes.setdefault(identity, [entry.info, 0])
        group[1] += 1
    summary.freed_bytes = sum(info.st_blocks * 512 for info, count in inodes.values() if count == info.st_nlink)
    summary.total_bytes = sum(entry.info.st_size for entry in selected)
    if verbose:
        mode = "APPLY" if apply else "DRY RUN"
        counts = Counter(reason for entry in entries for reason in entry.reasons)
        rules = "; ".join(f"{rule}={count}" for rule, count in sorted(counts.items())) or "none"
        print(f"Kept by rule (files may count under multiple rules): {rules}", file=output)
        print(f"{mode} summary: files={summary.files} retained={summary.files - summary.selected} "
              f"selected={summary.selected} deleted={summary.deleted} already_gone={summary.missing} "
              f"errors={len(summary.errors)} total_file_bytes={summary.total_bytes} "
              f"estimated_bytes_to_free={summary.freed_bytes} "
              "(other hard links and open readers may delay/prevent reclamation)", file=output)
    return summary


def plan_and_execute(db, root_fd, control_info, *, apply, now=None, retention=RETENTION_SECONDS,
                     output=None, verbose=True):
    """Plan in a deferred read snapshot, then apply outside it.

    Under the exclusive catalog lock no catalog writer can register rows or
    change publications, so the plan needs no control-DB write lock; unrelated
    API writers keep running. Artifact rows are deleted in a short transaction.
    """
    db.execute("BEGIN")
    try:
        entries = plan(db, root_fd, control_info, time.time() if now is None else now, retention)
    finally:
        db.rollback()
    return execute_plan(db, root_fd, entries, apply=apply, output=output, verbose=verbose)


def control_database_info(db):
    path = next((row[2] for row in db.execute("PRAGMA database_list") if row[1] == "main"), "")
    if not path:
        raise ValueError("Control database has no file")
    return os.stat(path)


def prune_live(root, get_db, *, now=None, retention=None, output=None, verbose=False):
    """Apply retention while the API runs. Returns None when skipped.

    Skips (never waits) when a writer or another pruner holds the catalog lock,
    and when the catalog directory does not exist yet.
    """
    try:
        root_fd = open_directory(root)
    except FileNotFoundError:
        return None
    try:
        with replica.catalog_lock(dir_fd=root_fd, exclusive=True, blocking=False) as acquired:
            if not acquired:
                return None
            with get_db() as db:
                db.row_factory = sqlite3.Row
                return plan_and_execute(
                    db, root_fd, control_database_info(db), apply=True, now=now,
                    retention=retention_seconds() if retention is None else retention,
                    output=output or sys.stdout, verbose=verbose)
    finally:
        os.close(root_fd)


class AutoPruner:
    """One background thread per API process; the catalog lock keeps runs exclusive.

    Runs shortly after startup, then every ``interval`` seconds and whenever
    ``trigger`` is called (after a publish or refresh). Never raises into callers.
    """

    def __init__(self, root, get_db, *, interval=PRUNE_INTERVAL_SECONDS,
                 initial_delay=PRUNE_INITIAL_DELAY_SECONDS):
        self.root = root if callable(root) else (lambda: root)
        self.get_db = get_db
        self.interval, self.initial_delay = interval, initial_delay
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = None

    def start(self):
        if not auto_prune_enabled():
            LOG.warning("Catalog auto-prune disabled by %s", AUTO_PRUNE_ENV)
            return
        if replica.fcntl is None:
            LOG.warning("Catalog auto-prune unavailable on this platform")
            return
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.wake.clear()  # Triggers before start are covered by the startup run.
        self.thread = threading.Thread(target=self.loop, name="catalog-prune", daemon=True)
        self.thread.start()

    def trigger(self):
        self.wake.set()

    def stop(self, timeout=5):
        self.stop_event.set()
        self.wake.set()
        if self.thread is not None:
            self.thread.join(timeout=timeout)

    def loop(self):
        deadline = time.monotonic() + self.initial_delay
        while not self.stop_event.is_set():
            self.wake.wait(max(0.0, deadline - time.monotonic()))
            if self.stop_event.is_set():
                return
            self.wake.clear()
            self.run_once()
            deadline = time.monotonic() + self.interval

    def run_once(self):
        try:
            summary = prune_live(self.root(), self.get_db)
        except Exception as exc:
            LOG.error("Catalog auto-prune failed; nothing else affected: %s: %s", type(exc).__name__, exc)
            return None
        if summary is None:
            LOG.info("Catalog auto-prune skipped: catalog busy or missing")
            return None
        level = logging.WARNING if summary.deleted or summary.errors else logging.INFO
        LOG.log(level, "Catalog auto-prune: deleted=%d files freed_bytes=%d retained=%d errors=%d",
                summary.deleted, summary.freed_bytes, summary.files - summary.selected, len(summary.errors))
        return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prune expired mobile catalog files; default is dry run.")
    parser.add_argument("--db", type=Path, default=api_auth.DEFAULT_DB,
                        help="existing control database (default: %(default)s)")
    parser.add_argument("--root", type=Path,
                        help="catalog directory (default: mobile-catalog beside --db, as in the API)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="report only (the default); API may be running")
    mode.add_argument("--apply", action="store_true",
                      help="delete files under the catalog lock; safe while the API runs")
    parser.add_argument("--api-stopped", action="store_true",
                        help="accepted for compatibility; no longer required")
    parser.add_argument("--retention-hours", type=float,
                        help=f"retention window (default: {RETENTION_ENV} or "
                             f"{RETENTION_SECONDS / 3600:g}; minimum {MIN_RETENTION_SECONDS / 3600:g})")
    args = parser.parse_args(argv)
    retention = retention_seconds() if args.retention_hours is None else retention_seconds(
        {RETENTION_ENV: str(args.retention_hours)})

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
                # The same lock every API catalog writer holds shared: plan and
                # delete never interleave with an upload, publish or refresh.
                if not stack.enter_context(replica.catalog_lock(dir_fd=root_fd, exclusive=True, blocking=False)):
                    raise ValueError("A catalog writer or another prune holds the catalog lock; retry shortly")
            access = "rw" if args.apply else "ro"
            db = stack.enter_context(closing(sqlite3.connect(
                db_path.as_uri() + f"?mode={access}", uri=True, timeout=10)))
            db.row_factory = sqlite3.Row
            return plan_and_execute(db, root_fd, control_info, apply=args.apply,
                                    retention=retention).exit_code
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print("ABORTED summary: maintenance did not complete; inspect the error before retrying.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
