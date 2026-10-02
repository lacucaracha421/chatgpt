"""Durable, bounded refresh requests executed by the existing API process.

SQLite leases coordinate API processes. Every page checkpoints atomically; an
expired worker is fenced before staging or publication. No PC RPC is involved.
"""
import json
import logging
import threading
import time
import uuid

from app_lifecycle import join_worker, lifecycle
from fastapi import Header, Request
import catalog_duplicates
import mobile_catalog_replica as replica
from catalog_refresh_content import MUTABLE_FIELDS, merge_observation, parse_page

MAX_PAGES = 40
LEASE_SECONDS = 180
REFRESH_INTERVAL_SECONDS = 3600
REFRESH_POLL_SECONDS = 60
MAX_STAGED_BYTES = 16 * 1024 * 1024
RECENT_SECONDS = 30 * 86400
LOG = logging.getLogger(__name__)
DDL = """
CREATE TABLE IF NOT EXISTS mobile_catalog_refresh_jobs(
 id TEXT PRIMARY KEY, language TEXT NOT NULL, state TEXT NOT NULL,
 created REAL NOT NULL, updated REAL NOT NULL, owner TEXT, lease REAL,
 watermark INTEGER NOT NULL, cursor INTEGER, pending_max INTEGER NOT NULL,
 pages INTEGER NOT NULL DEFAULT 0, page_limit INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
 added INTEGER NOT NULL DEFAULT 0, error TEXT, publication_revision TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_catalog_one_refresh
 ON mobile_catalog_refresh_jobs((1)) WHERE state IN ('queued','running');
CREATE TABLE IF NOT EXISTS mobile_catalog_refresh_pages(
 job_id TEXT NOT NULL, work_id INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(job_id,work_id));
CREATE TABLE IF NOT EXISTS mobile_catalog_refresh_receipts(
 operation_id TEXT PRIMARY KEY, language TEXT NOT NULL, job_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_catalog_refresh_streams(
 language TEXT PRIMARY KEY, watermark INTEGER NOT NULL, cursor INTEGER,
 pending_max INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_catalog_refresh_schedule(
 language TEXT PRIMARY KEY, next_due REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_catalog_metadata_streams(
 language TEXT PRIMARY KEY, cursor INTEGER);
CREATE TABLE IF NOT EXISTS mobile_catalog_metadata_jobs(
 job_id TEXT PRIMARY KEY, cursor INTEGER, done INTEGER NOT NULL DEFAULT 0,
 incremental_pages INTEGER NOT NULL DEFAULT 0);
"""


def public_job(row):
    if row is None:
        return None
    return {"id": row["id"], "language": row["language"], "state": row["state"],
            "pages": row["pages"], "added": row["added"], "error": row["error"],
            "hasMore": row["state"] == "completed" and not row["done"],
            "publicationRevision": row["publication_revision"]}


class RefreshWorker:
    def __init__(self, get_db, root, fetch_page, on_published=None):
        self.get_db, self.root, self.fetch_page = get_db, root, fetch_page
        self.on_published = on_published
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None

    def startup(self):
        with self.get_db() as db:
            db.executescript(DDL)
        self.stop.clear()
        self.thread = threading.Thread(target=self.loop, name="catalog-refresh", daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            join_worker(self.thread, 1)

    def status(self):
        with self.get_db() as db:
            row = db.execute("SELECT * FROM mobile_catalog_refresh_jobs ORDER BY created DESC,rowid DESC LIMIT 1").fetchone()
            return public_job(row)

    def published_baseline(self, language):
        """Published baseline for one language, or None when it is not schedulable.

        Read through the normal publication handle so the scheduler adds no second
        SQLite connection of its own. Returns the frozen publication revision together
        with the highest published language work id; a zero id means this language owns
        nothing in the published catalog yet and must not be started automatically.
        """
        try:
            with replica.open_publication(self.root(), self.get_db) as (catalog, publication):
                value = catalog.execute("SELECT COALESCE(MAX(WorkId),0) FROM catalog.Tags WHERE Namespace='language' AND Value=?", [language]).fetchone()[0]
        except Exception:
            return None, None
        if not value:
            return None, None
        return value, publication["revision"]

    def request(self, operation_id, language):
        if language not in ("korean", "japanese"):
            replica.fail(400, "Choose Korean or Japanese for refresh")
        try:
            if str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            replica.fail(400, "Invalid refresh operation")
        # Read a frozen baseline outside the write lock, then compare its revision.
        with replica.open_publication(self.root(), self.get_db) as (catalog, publication):
            baseline = catalog.execute("SELECT COALESCE(MAX(WorkId),0) FROM catalog.Tags WHERE Namespace='language' AND Value=?", [language]).fetchone()[0]
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute("SELECT * FROM mobile_catalog_refresh_receipts WHERE operation_id=?", [operation_id]).fetchone()
            if receipt:
                if receipt["language"] != language:
                    replica.fail(409, "Refresh operation was already used")
                prior = db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE id=?", [receipt["job_id"]]).fetchone()
                return public_job(prior)
            active = db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE state IN ('queued','running')").fetchone()
            if active:
                db.execute("INSERT INTO mobile_catalog_refresh_receipts VALUES(?,?,?)", [operation_id, language, active["id"]])
                db.commit()
                return public_job(active)
            if replica.current(db)["revision"] != publication["revision"]:
                replica.fail(409, "Catalog changed; retry refresh")
            stream = db.execute("SELECT * FROM mobile_catalog_refresh_streams WHERE language=?", [language]).fetchone()
            watermark, cursor, pending = (stream["watermark"], stream["cursor"], stream["pending_max"]) if stream else (baseline, None, baseline)
            now = time.time()
            db.execute("""INSERT INTO mobile_catalog_refresh_jobs
              (id,language,state,created,updated,watermark,cursor,pending_max,page_limit)
              VALUES(?,?,'queued',?,?,?,?,?,?)""", [operation_id, language, now, now, watermark, cursor, pending, 1 if watermark == 0 else MAX_PAGES])
            db.execute("INSERT INTO mobile_catalog_refresh_receipts VALUES(?,?,?)", [operation_id, language, operation_id])
            db.commit()
            result = public_job(db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE id=?", [operation_id]).fetchone())
        self.wake.set()
        return result

    def due(self, now=None, languages=("korean", "japanese")):
        """Arm published languages, then queue at most one due incremental pass.

        First adoption waits an hour. A busy worker never postpones the other
        language's deadline; it remains due for the next idle check. Manual and
        failed attempts defer their own language by one hour from last activity.
        """
        now = time.time() if now is None else now
        for language in languages:
            if language not in ("korean", "japanese"):
                continue
            with self.get_db() as db:
                scheduled = db.execute("SELECT next_due FROM mobile_catalog_refresh_schedule WHERE language=?", [language]).fetchone()
                stream = db.execute("SELECT * FROM mobile_catalog_refresh_streams WHERE language=?", [language]).fetchone()
            if scheduled is not None and scheduled[0] > now:
                continue
            # Only adoption needs to inspect the artifact. Do not rescan the catalog
            # on every minute tick once its independent checkpoint exists.
            published, revision = (None, None) if stream else self.published_baseline(language)
            if stream is None and published is None:
                continue
            with self.get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                stream = db.execute("SELECT * FROM mobile_catalog_refresh_streams WHERE language=?", [language]).fetchone()
                if stream is None:
                    current = replica.current(db)
                    if not current or current["revision"] != revision:
                        continue
                    watermark, cursor, pending = published, None, published
                else:
                    watermark, cursor, pending = stream["watermark"], stream["cursor"], stream["pending_max"]
                if not watermark or watermark <= 0:
                    continue
                scheduled = db.execute("SELECT next_due FROM mobile_catalog_refresh_schedule WHERE language=?", [language]).fetchone()
                if scheduled is None:
                    db.execute("INSERT INTO mobile_catalog_refresh_schedule VALUES(?,?)", [language, now + REFRESH_INTERVAL_SECONDS])
                    db.commit()
                    continue
                if scheduled[0] > now:
                    continue
                if db.execute("SELECT 1 FROM mobile_catalog_refresh_jobs WHERE state IN ('queued','running')").fetchone():
                    return []
                last = db.execute("SELECT MAX(updated) FROM mobile_catalog_refresh_jobs WHERE language=?", [language]).fetchone()[0]
                if last is not None and last + REFRESH_INTERVAL_SECONDS > now:
                    db.execute("UPDATE mobile_catalog_refresh_schedule SET next_due=? WHERE language=?", [last + REFRESH_INTERVAL_SECONDS, language])
                    db.commit()
                    continue
                db.execute("""INSERT INTO mobile_catalog_refresh_jobs
                  (id,language,state,created,updated,watermark,cursor,pending_max,page_limit)
                  VALUES(?,?,'queued',?,?,?,?,?,?)""",
                  [str(uuid.uuid4()), language, now, now, watermark, cursor, pending, MAX_PAGES])
                if stream is None:
                    db.execute("INSERT INTO mobile_catalog_refresh_streams VALUES(?,?,?,?)", [language, watermark, cursor, pending])
                db.execute("UPDATE mobile_catalog_refresh_schedule SET next_due=? WHERE language=?", [now + REFRESH_INTERVAL_SECONDS, language])
                db.commit()
            self.wake.set()
            return [language]
        return []

    def loop(self):
        due_check = 0.0
        while not self.stop.is_set():
            try:
                if self.run_once():
                    continue
            except Exception:
                # Do not log provider bodies, URLs, credentials or SQL parameters.
                LOG.error("Catalog refresh worker could not acquire a job")
            poll = time.monotonic()
            if poll - due_check >= REFRESH_POLL_SECONDS:
                due_check = poll
                try:
                    self.due()
                except Exception:
                    LOG.error("Catalog refresh schedule check failed")
            self.wake.wait(5)
            self.wake.clear()

    def owned(self, db, job_id, owner):
        row = db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE id=? AND state='running' AND owner=? AND lease>?", [job_id, owner, time.time()]).fetchone()
        if not row:
            replica.fail(409, "Refresh lease changed")
        return row

    def heartbeat(self, job_id, owner, stopped):
        while not stopped.wait(30):
            try:
                with self.get_db() as db:
                    db.execute("UPDATE mobile_catalog_refresh_jobs SET lease=? WHERE id=? AND owner=? AND state='running' AND lease>?", [time.time() + LEASE_SECONDS, job_id, owner, time.time()])
                    db.commit()
            except Exception:
                LOG.error("Catalog refresh lease renewal failed")

    def run_once(self):
        owner = str(uuid.uuid4())
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE state='queued' OR (state='running' AND lease<?) ORDER BY created LIMIT 1", [time.time()]).fetchone()
            if row is None:
                return False
            job = dict(row)
            db.execute("UPDATE mobile_catalog_refresh_jobs SET state='running',owner=?,lease=?,updated=? WHERE id=?", [owner, time.time() + LEASE_SECONDS, time.time(), job["id"]])
            db.execute("""INSERT OR IGNORE INTO mobile_catalog_metadata_jobs(job_id,cursor)
              VALUES(?,(SELECT cursor FROM mobile_catalog_metadata_streams WHERE language=?))""", [job["id"], job["language"]])
            db.commit()
        stopped = threading.Event()
        renewer = threading.Thread(target=self.heartbeat, args=(job["id"], owner, stopped), daemon=True)
        renewer.start()
        try:
            # Reserve half of a busy run for the recent window so a new-work
            # backlog cannot starve metadata. Both lanes share the hard page cap.
            page_limit = min(job["page_limit"], MAX_PAGES)
            incremental_limit = max(1, page_limit // 2)
            while job["pages"] < page_limit:
                if self.stop.is_set():
                    return True  # Durable page state is resumed after lease expiry.
                with self.get_db() as db:
                    metadata = dict(db.execute("SELECT * FROM mobile_catalog_metadata_jobs WHERE job_id=?", [job["id"]]).fetchone())
                incremental = not job["done"] and metadata["incremental_pages"] < incremental_limit
                if not incremental and metadata["done"]:
                    break
                cursor = job["cursor"] if incremental else metadata["cursor"]
                # Pin the pre-fetch content: a concurrent PC publication must not
                # become the comparison baseline for an older provider response.
                with replica.open_publication(self.root(), self.get_db) as (catalog, _):
                    rows = parse_page(self.fetch_page(job["language"], cursor), job["language"])
                    staged = []
                    for row in rows:
                        work = row["work"]
                        addition = incremental and work["Id"] > job["watermark"]
                        recent = work["Posted"] is not None and work["Posted"] >= job["created"] - RECENT_SECONDS
                        if not addition and not recent:
                            continue
                        existing = catalog.execute(f"SELECT {','.join(MUTABLE_FIELDS)} FROM catalog.Works WHERE Id=?", [work["Id"]]).fetchone()
                        if not addition and existing is None:
                            continue
                        staged.append({**row, "update_only": not addition,
                                       "before": dict(zip(MUTABLE_FIELDS, existing)) if existing is not None else {}})
                lowest = rows[-1]["work"]["Id"] if rows else None
                if lowest is not None and cursor is not None and rows[0]["work"]["Id"] >= cursor:
                    raise ValueError("Catalog cursor did not advance")
                done = job["done"]
                pending, next_cursor = job["pending_max"], job["cursor"]
                if incremental:
                    done = len(rows) < 50 or lowest <= job["watermark"]
                    pending = max([pending, *[row["work"]["Id"] for row in rows]])
                    next_cursor = None if done else lowest
                # Reuse an incremental page only when it is exactly the next
                # sweep page. Unknown dates do not prematurely end the window.
                sweep_page = not incremental or cursor == metadata["cursor"]
                if sweep_page:
                    metadata["done"] = len(rows) < 50 or all(
                        row["work"]["Posted"] is not None and row["work"]["Posted"] < job["created"] - RECENT_SECONDS
                        for row in rows)
                    metadata["cursor"] = None if metadata["done"] else lowest
                with self.get_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    self.owned(db, job["id"], owner)
                    for row in staged:
                        previous = db.execute("SELECT payload FROM mobile_catalog_refresh_pages WHERE job_id=? AND work_id=?", [job["id"], row["work"]["Id"]]).fetchone()
                        row = merge_observation(json.loads(previous[0]) if previous else None, row)
                        db.execute("INSERT OR REPLACE INTO mobile_catalog_refresh_pages VALUES(?,?,?)", [job["id"], row["work"]["Id"], replica.encode(row)])
                    size = db.execute("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM mobile_catalog_refresh_pages WHERE job_id=?", [job["id"]]).fetchone()[0]
                    if size > MAX_STAGED_BYTES:
                        raise ValueError("Catalog refresh size limit")
                    db.execute("UPDATE mobile_catalog_metadata_jobs SET cursor=?,done=?,incremental_pages=incremental_pages+? WHERE job_id=?", [metadata["cursor"], int(metadata["done"]), int(incremental), job["id"]])
                    db.execute("UPDATE mobile_catalog_refresh_jobs SET cursor=?,pending_max=?,pages=pages+1,done=?,updated=? WHERE id=?", [next_cursor, pending, int(done), time.time(), job["id"]])
                    db.commit()
                    job = dict(db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE id=?", [job["id"]]).fetchone())
                if job["pages"] < page_limit and self.stop.wait(0.4):
                    return True
            revision, new_rows = self.publish(job, owner)
            if self.on_published is not None:
                try:
                    self.on_published()
                except Exception:
                    LOG.error("Catalog refresh post-publish hook failed")
            self.check_duplicates(revision, new_rows)
        except Exception:
            with self.get_db() as db:
                changed = db.execute("UPDATE mobile_catalog_refresh_jobs SET state='failed',error=?,updated=? WHERE id=? AND owner=? AND state='running' AND lease>?", ["갱신하지 못했습니다. 기존 목록은 유지됩니다. 다시 시도해 주세요.", time.time(), job["id"], owner, time.time()]).rowcount
                if changed:
                    db.execute("DELETE FROM mobile_catalog_refresh_pages WHERE job_id=?", [job["id"]])
                db.commit()
            LOG.warning("Catalog refresh attempt failed; published catalog retained")
        finally:
            stopped.set()
            renewer.join(timeout=1)
        return True

    def publish(self, job, owner):
        with self.get_db() as db:
            self.owned(db, job["id"], owner)
            rows = [json.loads(row[0]) for row in db.execute("SELECT payload FROM mobile_catalog_refresh_pages WHERE job_id=? ORDER BY work_id", [job["id"]])]
        # A concurrent PC publication may change users/groups. Rebase on its latest
        # snapshot; never publish the user state captured at request time.
        for attempt in range(3):
            with self.get_db() as db:
                current = dict(replica.current(db))
                users = json.loads(db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?", [current["user_revision"]]).fetchone()[0])
            with replica.open_publication(self.root(), self.get_db, current["revision"]) as (catalog, _):
                new_rows = [row for row in rows if not row.get("update_only") and not catalog.execute("SELECT 1 FROM catalog.Works WHERE Id=?", [row["work"]["Id"]]).fetchone()]
            added = len(new_rows)

            def finalize(db, revision):
                self.owned(db, job["id"], owner)
                for row in rows:
                    old = db.execute("SELECT payload FROM mobile_catalog_server_additions WHERE work_id=?", [row["work"]["Id"]]).fetchone()
                    row = merge_observation(json.loads(old[0]) if old else None, row)
                    db.execute("INSERT OR REPLACE INTO mobile_catalog_server_additions VALUES(?,?)", [row["work"]["Id"], replica.encode(row)])
                db.execute("INSERT OR REPLACE INTO mobile_catalog_refresh_streams VALUES(?,?,?,?)", [job["language"], job["pending_max"] if job["done"] else job["watermark"], job["cursor"], job["pending_max"]])
                db.execute("INSERT OR REPLACE INTO mobile_catalog_metadata_streams SELECT ?,cursor FROM mobile_catalog_metadata_jobs WHERE job_id=?", [job["language"], job["id"]])
                db.execute("UPDATE mobile_catalog_refresh_jobs SET state='completed',added=?,publication_revision=?,updated=? WHERE id=?", [added, revision, time.time(), job["id"]])
                db.execute("DELETE FROM mobile_catalog_refresh_pages WHERE job_id=?", [job["id"]])

            try:
                result = replica.publish({"version": 1, "baseRevision": current["revision"], "contentDigest": current["content_digest"], "userSnapshot": users}, self.root(), self.get_db, additions=rows, finalize=finalize)
                return result["publicationRevision"], new_rows
            except Exception as error:
                if getattr(error, "status_code", None) != 409 or attempt == 2:
                    raise

    def check_duplicates(self, revision, new_rows):
        """Duplicate-edition check for the works this refresh added; best effort.

        Runs after the job is committed as completed, outside the catalog lock (a
        read-only publication handle keeps its files readable even if pruned), so a
        failure here never fails, rolls back or re-queues the refresh.
        """
        if not new_rows:
            return None
        try:
            with replica.open_publication(self.root(), self.get_db, revision) as (catalog, publication):
                with self.get_db() as db:
                    stats = catalog_duplicates.check_new_works(db, catalog, new_rows, digest=publication["content_digest"])
            LOG.info("Catalog duplicate check: %d works, %d new candidates", stats["checked"], stats["candidates"])
            return stats
        except Exception:
            LOG.error("Catalog duplicate check failed; the refreshed catalog is kept")
            return None


def register_refresh(app, get_db, root, require_auth, fetch_page, on_published=None):
    worker = RefreshWorker(get_db, root, fetch_page, on_published)
    lifecycle(app).on_startup(worker.startup)
    lifecycle(app).on_shutdown(worker.shutdown)

    @app.get("/v1/mobile-catalog/refresh")
    def status(authorization: str | None = Header(default=None)):
        require_auth(authorization)
        return {"job": worker.status()}

    @app.post("/v1/mobile-catalog/refresh", status_code=202)
    async def request(request: Request, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 1024:
                replica.fail(413)
        try:
            body = json.loads(data)
        except ValueError:
            replica.fail(400)
        if not isinstance(body, dict) or set(body) != {"operationId", "language"}:
            replica.fail(400)
        from starlette.concurrency import run_in_threadpool
        return {"job": await run_in_threadpool(worker.request, body["operationId"], body["language"])}

    return worker
