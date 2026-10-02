"""Operator-only immutable thumbnail migration. Read-only dry-run is the default.

Never imports app.py, copies a mutable source, or deletes a final/legacy object.
R2 configuration is loaded only for explicitly requested storage operations.
Both apply and rollback require the legacy-upload block and confirmation that
previously issued PUTs have drained. Keep LAKOMICS_BLOCK_LEGACY_THUMBNAIL_UPLOADS
ON in the server and this tool until the apply or rollback operation completes.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import closing, contextmanager
import fcntl
import io
import json
import os
from pathlib import Path
import random
import re
import signal
import sqlite3
import time

import library_thumbnails as thumbs


class LogFailure(RuntimeError):
    """Stop without changing an asset's durable journal state when stdout is lost."""


def connect(path, readonly=False):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ("?mode=ro" if readonly else "?mode=rw"),
                         uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    return db


def install(db):
    # The server deploy owns additive Asset/session schema. Never migrate that schema
    # implicitly from this operational tool, and never rebuild the list triggers here.
    required = set(thumbs.THUMB_FIELDS)
    if not required <= {r[1] for r in db.execute("PRAGMA table_info(assets)")}:
        raise ValueError("Deploy the compatible server schema first")
    db.execute("""CREATE TABLE IF NOT EXISTS thumbnail_migration_runs (
        run_id TEXT PRIMARY KEY, created_at REAL NOT NULL, manifest_complete INTEGER NOT NULL,
        manifest_limit INTEGER)""")
    db.execute("""CREATE TABLE IF NOT EXISTS thumbnail_migration_journal (
        run_id TEXT NOT NULL, asset_id TEXT NOT NULL, state TEXT NOT NULL,
        snapshot TEXT NOT NULL, old_key TEXT NOT NULL, old_revision TEXT,
        new_key TEXT, sha256 TEXT, size_bytes INTEGER, etag TEXT,
        result_snapshot TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, updated_at REAL NOT NULL,
        PRIMARY KEY(run_id,asset_id))""")
    db.execute("CREATE INDEX IF NOT EXISTS thumbnail_journal_state ON thumbnail_migration_journal(run_id,state,asset_id)")
    db.commit()


def candidate_pages(db, batch_size=25):
    last = ""
    while True:
        rows = db.execute("SELECT * FROM assets WHERE committed=1 AND id>? "
                          "AND thumbnail_key='library/' || id || '/thumbnail' ORDER BY id LIMIT ?",
                          (last, batch_size)).fetchall()
        if not rows:
            return
        yield rows
        last = rows[-1]["id"]


def migration_lifecycle_ok(identity):
    if not thumbs.writable_lifecycle(identity):
        return False
    if identity["domain"]:
        library = identity["domain"][0][0]
        return any(row[0] == library and row[1] == "normal" for row in identity["rows"])
    return True


def manifest(db, run_id, limit=None, batch_size=25):
    existing = db.execute("SELECT * FROM thumbnail_migration_runs WHERE run_id=?", (run_id,)).fetchone()
    if existing is not None:
        if not existing["manifest_complete"]:
            raise RuntimeError("Incomplete manifest")
        if limit is not None and existing["manifest_limit"] != limit:
            raise ValueError("A resumed run keeps its original manifest limit")
        return
    # Freeze a single SQLite snapshot of target identities. No storage I/O in this
    # transaction; bounded pages avoid retaining the whole library in Python memory.
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT INTO thumbnail_migration_runs(run_id,created_at,manifest_complete,manifest_limit) VALUES (?,?,0,?)",
                   (run_id, time.time(), limit))
        count = 0
        for rows in candidate_pages(db, batch_size):
            for row in rows:
                if limit is not None and count >= limit:
                    break
                before = thumbs.snapshot(db, row)
                state = "pending" if migration_lifecycle_ok(before["lifecycle"]) and not thumbs.active_upload(db, row["id"]) else "skipped_changed"
                db.execute("""INSERT INTO thumbnail_migration_journal
                    (run_id,asset_id,state,snapshot,old_key,old_revision,updated_at)
                    VALUES (?,?,?,?,?,?,?)""", (run_id, row["id"], state, thumbs.encode(before),
                                                row["thumbnail_key"], thumbs.revision(row), time.time()))
                count += 1
            if limit is not None and count >= limit:
                break
        db.execute("UPDATE thumbnail_migration_runs SET manifest_complete=1 WHERE run_id=?", (run_id,))


def retryable(exc):
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return True
    if isinstance(exc, sqlite3.OperationalError):
        return "locked" in str(exc).lower() or "busy" in str(exc).lower()
    response = getattr(exc, "response", {})
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
    code = str(response.get("Error", {}).get("Code", ""))
    return (status == 429 or status >= 500 or code in ("SlowDown", "RequestTimeout", "InternalError", "ServiceUnavailable")
            or type(exc).__name__ in ("ReadTimeoutError", "ConnectTimeoutError", "EndpointConnectionError", "ConnectionClosedError"))


class Storage:
    """One bounded worker; pace *every attempt*, including retries and deletes."""
    def __init__(self, storage, rate=5, metrics=None, deadline=None, stop=None):
        self.storage, self.rate = storage, rate
        self.metrics = metrics if metrics is not None else Counter()
        self.deadline = deadline
        self.next_at = 0.0
        self.stop = stop or (lambda: False)
        for name in ("get_object", "put_object", "head_object", "copy_object", "delete_object", "retries"):
            self.metrics.setdefault(name, 0)

    def __getattr__(self, name):
        if name not in ("get_object", "put_object", "head_object", "delete_object"):
            raise AttributeError(name)
        def call(**kwargs):
            for attempt in range(3):
                now = time.monotonic()
                if self.deadline is not None and now >= self.deadline:
                    raise TimeoutError("migrationDeadline")
                while self.next_at > time.monotonic():
                    if self.stop() or (self.deadline is not None and time.monotonic() >= self.deadline):
                        raise InterruptedError("migrationStopped")
                    time.sleep(min(0.1, max(0, self.next_at - time.monotonic())))
                if self.stop():
                    raise InterruptedError("migrationStopped")
                self.next_at = time.monotonic() + 1 / self.rate
                self.metrics[name] += 1
                try:
                    result = getattr(self.storage, name)(**kwargs)
                    if name == "get_object":
                        self.metrics["download_bytes_declared"] += result.get("ContentLength", 0)
                    elif name == "put_object":
                        self.metrics["upload_bytes"] += len(kwargs["Body"].getbuffer())
                    return result
                except Exception as exc:
                    if attempt == 2 or not retryable(exc):
                        raise
                    self.metrics["retries"] += 1
                    body = kwargs.get("Body")
                    if body is not None:
                        body.seek(0)
                    time.sleep(min(2, 0.25 * (2 ** attempt)) + random.uniform(0, 0.1))
        return call


class Migrator:
    def __init__(self, db, storage, bucket, run_id, *, emit=None, stop=None, checkpoint=None):
        self.db, self.storage, self.bucket, self.run_id = db, storage, bucket, run_id
        sink = emit or (lambda data: print(thumbs.encode(data), flush=True))
        def emit_event(data):
            try:
                sink(data)
            except Exception:
                raise LogFailure("migrationLogUnavailable") from None
        self.emit = emit_event
        self.stop = stop or (lambda: False)
        self.checkpoint = checkpoint or (lambda state, asset_id: None)
        self.timings = defaultdict(list)
        self.metrics = Counter()
        self.paused = False

    def record_transaction(self, started):
        elapsed = time.monotonic() - started
        self.timings["transaction"].append(elapsed)
        if elapsed > 0.25 and isinstance(self.storage, Storage):
            self.storage.rate = min(self.storage.rate, max(0.25, self.storage.rate / 2))
            self.metrics["slow_transactions"] += 1
            if self.metrics["slow_transactions"] >= 3:
                self.paused = True

    def stage(self, row, state, **fields):
        started = time.monotonic()
        with self.db:
            self.db.execute("UPDATE thumbnail_migration_journal SET state=?,updated_at=?"
                            + "".join("," + name + "=?" for name in fields)
                            + " WHERE run_id=? AND asset_id=?",
                            (state, time.time(), *fields.values(), self.run_id, row["asset_id"]))
        self.record_transaction(started)
        self.emit({"run_id": self.run_id, "asset_id": row["asset_id"], "state": state, **fields})
        self.checkpoint(state, row["asset_id"])

    def unchanged(self, row):
        current = self.db.execute("SELECT * FROM assets WHERE id=?", (row["asset_id"],)).fetchone()
        before = json.loads(row["snapshot"])
        return (thumbs.matches(self.db, current, before) and migration_lifecycle_ok(before["lifecycle"])
                and not thumbs.active_upload(self.db, row["asset_id"]))

    def process(self, row):
        started = time.monotonic()
        asset_id = row["asset_id"]
        if not self.unchanged(row):
            self.stage(row, "skipped_changed", error_code="concurrentChange")
            return
        deadline = min(time.monotonic() + 60, getattr(self.storage, "deadline", None) or float("inf"))
        digest, size, key, etag = row["sha256"], row["size_bytes"], row["new_key"], row["etag"]
        if row["state"] not in ("copied", "verified"):
            step = time.monotonic()
            data, digest, etag = thumbs.read_object(self.storage, self.bucket, row["old_key"], deadline=deadline)
            self.timings["source_read"].append(time.monotonic() - step)
            size, key = len(data), thumbs.immutable_key(digest)
            self.checkpoint("read", asset_id)
            if self.stop():
                return
            step = time.monotonic()
            # Never copy a mutable source. PUT uses the exact buffer just hashed.
            try:
                thumbs.read_object(self.storage, self.bucket, key, digest=digest, size=size, deadline=deadline)
            except thumbs.InvalidObject as exc:
                raise thumbs.IntegrityError("finalIntegrity") from exc
            except Exception as exc:
                if not thumbs.missing(exc):
                    raise
                self.storage.put_object(Bucket=self.bucket, Key=key, Body=io.BytesIO(data), ContentType="image/webp")
            self.timings["reuse_or_put"].append(time.monotonic() - step)
            self.checkpoint("put", asset_id)
            self.stage(row, "copied", new_key=key, sha256=digest, size_bytes=size, etag=etag, error_code=None)
        if self.stop():
            return
        step = time.monotonic()
        try:
            thumbs.read_object(self.storage, self.bucket, key, digest=digest, size=size, deadline=deadline)
        except thumbs.InvalidObject as exc:
            raise thumbs.IntegrityError("finalIntegrity") from exc
        self.timings["final_verify"].append(time.monotonic() - step)
        self.stage(row, "verified")
        if self.stop():
            return
        tx = time.monotonic()
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if not self.unchanged(row):
                self.db.execute("UPDATE thumbnail_migration_journal SET state='skipped_changed',error_code='concurrentChange',updated_at=? "
                                "WHERE run_id=? AND asset_id=?", (time.time(), self.run_id, asset_id))
                cas = False
            else:
                before = json.loads(row["snapshot"])["asset"]
                thumbs.remember_key(self.db, row["old_key"])
                self.db.execute("""UPDATE assets SET thumbnail_key=?,thumbnail_metadata_key=?,
                    thumbnail_size_bytes=?,thumbnail_content_type='image/webp',thumbnail_sha256=?,
                    thumbnail_revision=?,thumbnail_verified=1,thumbnail_write_epoch=thumbnail_write_epoch+1
                    WHERE id=? AND thumbnail_write_epoch=?""",
                    (key, key, size, digest, row["old_revision"], asset_id, before["thumbnail_write_epoch"]))
                result = self.db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
                self.db.execute("UPDATE thumbnail_migration_journal SET state='committed',result_snapshot=?,updated_at=? "
                                "WHERE run_id=? AND asset_id=?",
                                (thumbs.encode(thumbs.snapshot(self.db, result)), time.time(), self.run_id, asset_id))
                cas = True
        self.record_transaction(tx)
        self.checkpoint("committed", asset_id)
        self.timings["asset"].append(time.monotonic() - started)
        self.emit({"run_id": self.run_id, "asset_id": asset_id, "old_key": row["old_key"], "new_key": key,
                   "sha256": digest, "size_bytes": size, "etag": etag,
                   "state": "committed" if cas else "skipped_changed", "cas": cas,
                   "elapsed_seconds": time.monotonic() - started})

    def apply(self, batch_size=25):
        last = ""
        while not self.stop() and not self.paused:
            rows = self.db.execute("SELECT * FROM thumbnail_migration_journal WHERE run_id=? AND asset_id>? "
                                   "AND state IN ('pending','copied','verified','retryable_error') "
                                   "ORDER BY asset_id LIMIT ?", (self.run_id, last, batch_size)).fetchall()
            if not rows:
                break
            for row in rows:
                if self.stop() or self.paused:
                    return
                last = row["asset_id"]
                # Three bounded attempts per invocation; retryable rows remain in the
                # manifest so an explicit resume never loses them behind the cursor.
                for attempt in range(3):
                    try:
                        self.process(row)
                        break
                    except LogFailure:
                        raise
                    except Exception as exc:
                        self.db.rollback()
                        durable = self.db.execute("SELECT state FROM thumbnail_migration_journal WHERE run_id=? AND asset_id=?",
                                                  (self.run_id, row["asset_id"])).fetchone()
                        if durable is not None and durable[0] == "committed":
                            # A response/log/checkpoint failure after COMMIT is not an
                            # object failure; keep the receipt available for resume/rollback.
                            raise
                        if self.stop():
                            return
                        transient = retryable(exc)
                        self.metrics["errors"] += 1
                        if isinstance(exc, sqlite3.OperationalError):
                            self.metrics["sqlite_busy"] += 1
                            self.paused = self.metrics["sqlite_busy"] >= 3
                        state = "retryable_error" if transient else "permanent_error"
                        code = "objectMissing" if thumbs.missing(exc) else type(exc).__name__
                        self.stage(row, state, error_code=code, attempts=row["attempts"] + attempt + 1)
                        self.emit({"run_id": self.run_id, "asset_id": row["asset_id"], "state": state,
                                   "error_code": code, "attempt": attempt + 1})
                        if isinstance(exc, thumbs.IntegrityError):
                            raise
                        if not transient or attempt == 2 or self.stop() or self.paused:
                            break
                        time.sleep(0.25 * 2 ** attempt + random.uniform(0, 0.1))

    def rollback(self, batch_size=25):
        last = ""
        while not self.stop() and not self.paused:
            rows = self.db.execute("SELECT * FROM thumbnail_migration_journal WHERE run_id=? AND asset_id>? "
                                   "AND state='committed' ORDER BY asset_id LIMIT ?", (self.run_id, last, batch_size)).fetchall()
            if not rows:
                return
            for row in rows:
                if self.stop() or self.paused:
                    return
                last = row["asset_id"]
                try:
                    thumbs.read_object(self.storage, self.bucket, row["old_key"],
                                       digest=row["sha256"], size=row["size_bytes"], deadline=time.monotonic() + 60)
                except Exception as exc:
                    self.emit({"run_id": self.run_id, "asset_id": last, "state": "rollback_error", "error_code": type(exc).__name__})
                    self.metrics["rollback_errors"] += 1
                    continue
                with self.db:
                    self.db.execute("BEGIN IMMEDIATE")
                    current = self.db.execute("SELECT * FROM assets WHERE id=?", (last,)).fetchone()
                    if not thumbs.matches(self.db, current, json.loads(row["result_snapshot"])) or thumbs.active_upload(self.db, last):
                        state = "rollback_skipped"
                    else:
                        old = json.loads(row["snapshot"])["asset"]
                        # Restore physical metadata, but freeze the effective token and
                        # advance the epoch; neither migration nor rollback changes UI bytes.
                        fields = {name: old[name] for name in thumbs.THUMB_FIELDS if name not in ("thumbnail_revision", "thumbnail_write_epoch")}
                        fields["thumbnail_revision"] = row["old_revision"]
                        fields["thumbnail_write_epoch"] = current["thumbnail_write_epoch"] + 1
                        thumbs.remember_key(self.db, row["old_key"])
                        self.db.execute("UPDATE assets SET " + ",".join(name + "=?" for name in fields) + " WHERE id=?",
                                        (*fields.values(), last))
                        state = "rolled_back"
                    self.db.execute("UPDATE thumbnail_migration_journal SET state=?,updated_at=? WHERE run_id=? AND asset_id=?",
                                    (state, time.time(), self.run_id, last))
                self.emit({"run_id": self.run_id, "asset_id": last, "state": state})

    def summary(self):
        def percentiles(values):
            ordered = sorted(values)
            return {"count": len(values), "p50": ordered[int((len(values)-1)*.5)],
                    "p95": ordered[int((len(values)-1)*.95)]} if values else {}
        counts = states(self.db, self.run_id)
        return {"run_id": self.run_id, "states": counts,
                "progress": {"target": sum(counts.values()), "completed": counts.get("committed", 0),
                             "conflicts": counts.get("skipped_changed", 0),
                             "errors": counts.get("permanent_error", 0) + counts.get("retryable_error", 0),
                             "remaining": sum(counts.get(state, 0) for state in ("pending", "copied", "verified", "retryable_error"))},
                "metrics": dict(self.metrics), "storage": dict(getattr(self.storage, "metrics", {})),
                "seconds": {name: percentiles(values) for name, values in self.timings.items()},
                "paused_for_database_pressure": self.paused,
                "foreground_ticket_latency": "not_measured_operator_observation_required"}


def states(db, run_id):
    return {row[0]: row[1] for row in db.execute(
        "SELECT state,COUNT(*) FROM thumbnail_migration_journal WHERE run_id=? GROUP BY state", (run_id,))}


def report(db, run_id=None):
    counts = Counter()
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for rows in candidate_pages(db):
        for row in rows:
            counts["mutable_candidates"] += 1
            identity = thumbs.lifecycle_identity(db, row["id"])
            if not migration_lifecycle_ok(identity):
                counts["excluded_lifecycle"] += 1
            for lifecycle in {entry[1] for entry in identity["rows"]}:
                if lifecycle in ("trash", "tombstoned"):
                    counts[lifecycle] += 1
            if "thumbnail_upload_sessions" in tables and thumbs.active_upload(db, row["id"]):
                counts["active_uploads"] += 1
            fields = dict(row)
            if fields.get("thumbnail_metadata_key") != row["thumbnail_key"]:
                counts["receipt_missing"] += 1
            if fields.get("thumbnail_size_bytes") is not None and not 0 < fields["thumbnail_size_bytes"] <= thumbs.MAX_BYTES:
                counts["size_anomaly"] += 1
            if fields.get("thumbnail_content_type") not in (None, "image/webp"):
                counts["type_anomaly"] += 1
    result = {"counts": dict(counts), "key_distribution": dict(db.execute(
        "SELECT CASE WHEN thumbnail_key IS NULL THEN 'none' "
        "WHEN thumbnail_key LIKE 'library/%/thumbnail' THEN 'legacy' "
        "WHEN thumbnail_key LIKE 'derived/library-thumbnails/v1/%' THEN 'content_digest' "
        "ELSE 'other' END,COUNT(*) FROM assets GROUP BY 1").fetchall()),
        "quick_check": [r[0] for r in db.execute("PRAGMA quick_check")],
        "foreign_key_violations": sum(1 for _ in db.execute("PRAGMA foreign_key_check"))}
    if run_id and "thumbnail_migration_journal" in tables:
        result["states"] = states(db, run_id)
        result["revision_mismatches"] = 0
        result["receipt_mismatches"] = 0
        result["post_run_changes"] = 0
        for row in db.execute("SELECT * FROM thumbnail_migration_journal WHERE run_id=? AND state='committed'", (run_id,)):
            asset = db.execute("SELECT * FROM assets WHERE id=?", (row["asset_id"],)).fetchone()
            if not thumbs.matches(db, asset, json.loads(row["result_snapshot"])):
                result["post_run_changes"] += 1
                continue
            result["revision_mismatches"] += thumbs.revision(asset) != row["old_revision"]
            result["receipt_mismatches"] += not (thumbs.trusted_receipt(asset) and asset["thumbnail_size_bytes"] > 0
                                                  and asset["thumbnail_content_type"] == "image/webp")
    return result


@contextmanager
def lease(database, run_id):
    path = Path(database).resolve().with_name(Path(database).name + ".thumbnail-" + run_id + ".lock")
    # The stable lock inode is intentionally retained after release.
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--apply", action="store_true")
    modes.add_argument("--rollback", action="store_true")
    modes.add_argument("--report", action="store_true")
    modes.add_argument("--reclaim-temp", action="store_true")
    parser.add_argument("--verify-read", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--workers", type=int, choices=(1,), default=1)
    parser.add_argument("--max-r2-ops-per-second", type=float, default=5)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--run-id")
    parser.add_argument("--legacy-writes-drained", action="store_true",
                        help="Confirm previously issued legacy PUTs have drained; keep the legacy-upload block ON until apply/rollback completes")
    parser.add_argument("--max-seconds", type=float, default=14400)
    args = parser.parse_args(argv)
    if not 1 <= args.batch_size <= 25 or not 0 < args.max_r2_ops_per_second <= 100 or args.max_seconds <= 0:
        parser.error("Use batch-size 1..25, a positive rate <=100 and positive max-seconds")
    if args.verify_read < 0 or args.verify_read > 1000 or (args.limit is not None and args.limit < 1):
        parser.error("verify-read must be 0..1000; limit must be positive")
    writes = args.apply or args.rollback or args.reclaim_temp
    if (args.apply or args.rollback) and not (args.run_id and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args.run_id)):
        parser.error("apply/rollback require a safe run-id (letters, digits, underscore, hyphen)")
    if (args.apply or args.rollback) and not (thumbs.block_legacy_uploads() and args.legacy_writes_drained):
        parser.error("apply/rollback require the legacy-presign block switch and --legacy-writes-drained; keep the block ON until completion")
    if args.verify_read and (writes or args.report):
        parser.error("verify-read belongs to dry-run only")
    stopped = False
    def stop(signum, frame):
        nonlocal stopped
        stopped = True
    previous = signal.signal(signal.SIGTERM, stop)
    deadline = time.monotonic() + args.max_seconds
    storage, bucket = None, os.environ.get("R2_BUCKET", "lakomics-media")
    if writes or args.verify_read:
        import r2
        bucket = r2.R2_BUCKET
        storage = Storage(r2.thumbnail_storage_client(total_max_attempts=1), args.max_r2_ops_per_second, deadline=deadline, stop=lambda: stopped)
    try:
        with closing(connect(args.database, readonly=not writes)) as db:
            print(thumbs.encode({"database": str(Path(args.database).resolve()), "bucket": bucket,
                                "mode": "apply" if args.apply else "rollback" if args.rollback else "reclaim-temp" if args.reclaim_temp else "report" if args.report else "dry-run",
                                **report(db, args.run_id)}), flush=True)
            if args.verify_read:
                count = 0
                for rows in candidate_pages(db, args.batch_size):
                    for row in rows:
                        if count >= args.verify_read or stopped or time.monotonic() >= deadline:
                            break
                        try:
                            data, digest, _ = thumbs.read_object(storage, bucket, row["thumbnail_key"], deadline=min(deadline, time.monotonic()+60))
                            result = {"asset_id": row["id"], "sha256": digest, "size_bytes": len(data), "state": "read_verified"}
                        except Exception as exc:
                            result = {"asset_id": row["id"], "state": "read_error", "error_code": type(exc).__name__}
                        print(thumbs.encode(result), flush=True)
                        count += 1
                    if count >= args.verify_read or stopped or time.monotonic() >= deadline:
                        break
                print(thumbs.encode({"verify_read_count": count, "storage": dict(storage.metrics)}), flush=True)
            if not writes:
                return
            if args.reclaim_temp:
                @contextmanager
                def factory():
                    with closing(connect(args.database)) as conn:
                        yield conn
                print(thumbs.encode({"reclaimed": thumbs.reclaim_temp(factory, storage, bucket, args.limit or 25)}), flush=True)
                return
            with lease(args.database, args.run_id):
                install(db)
                runner = Migrator(db, storage, bucket, args.run_id,
                                  stop=lambda: stopped or time.monotonic() >= deadline)
                try:
                    if args.apply:
                        manifest(db, args.run_id, args.limit, args.batch_size)
                        runner.apply(args.batch_size)
                    else:
                        if db.execute("SELECT 1 FROM thumbnail_migration_runs WHERE run_id=?", (args.run_id,)).fetchone() is None:
                            raise ValueError("Unknown migration run")
                        runner.rollback(args.batch_size)
                finally:
                    print(thumbs.encode({**runner.summary(), "validation": report(db, args.run_id)}), flush=True)
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # No raw SDK exception, URL or credential may enter operational JSONL.
        print(thumbs.encode({"state": "stopped_error", "error_code": type(exc).__name__}), flush=True)
        raise SystemExit(1)
