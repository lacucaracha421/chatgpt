"""Durable, bounded refresh requests executed by the existing API process.

SQLite leases coordinate API processes. Every page checkpoints atomically; an
expired worker is fenced before staging or publication. No PC RPC is involved.
"""
import json
import logging
import threading
import time
import uuid

from fastapi import Header, Request
import mobile_catalog_replica as replica
from catalog_refresh_content import parse_page

MAX_PAGES = 40
LEASE_SECONDS = 180
MAX_STAGED_BYTES = 16 * 1024 * 1024
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
"""


def public_job(row):
    if row is None:
        return None
    return {"id": row["id"], "language": row["language"], "state": row["state"],
            "pages": row["pages"], "added": row["added"], "error": row["error"],
            "hasMore": row["state"] == "completed" and not row["done"],
            "publicationRevision": row["publication_revision"]}


class RefreshWorker:
    def __init__(self, get_db, root, fetch_page):
        self.get_db, self.root, self.fetch_page = get_db, root, fetch_page
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
            self.thread.join(timeout=1)

    def status(self):
        with self.get_db() as db:
            row = db.execute("SELECT * FROM mobile_catalog_refresh_jobs ORDER BY created DESC,rowid DESC LIMIT 1").fetchone()
            return public_job(row)

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

    def loop(self):
        while not self.stop.is_set():
            try:
                if self.run_once():
                    continue
            except Exception:
                # Do not log provider bodies, URLs, credentials or SQL parameters.
                LOG.error("Catalog refresh worker could not acquire a job")
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
            db.commit()
        stopped = threading.Event()
        renewer = threading.Thread(target=self.heartbeat, args=(job["id"], owner, stopped), daemon=True)
        renewer.start()
        try:
            while not job["done"] and job["pages"] < job["page_limit"]:
                if self.stop.is_set():
                    return True  # Durable page state is resumed after lease expiry.
                rows = parse_page(self.fetch_page(job["language"], job["cursor"]), job["language"])
                lowest = rows[-1]["work"]["Id"] if rows else None
                if lowest is not None and job["cursor"] is not None and rows[0]["work"]["Id"] >= job["cursor"]:
                    raise ValueError("Catalog cursor did not advance")
                done = len(rows) < 50 or lowest <= job["watermark"]
                pending = max([job["pending_max"], *[row["work"]["Id"] for row in rows]])
                with self.get_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    self.owned(db, job["id"], owner)
                    db.executemany("INSERT OR REPLACE INTO mobile_catalog_refresh_pages VALUES(?,?,?)", [[job["id"], row["work"]["Id"], replica.encode(row)] for row in rows if row["work"]["Id"] > job["watermark"]])
                    size = db.execute("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM mobile_catalog_refresh_pages WHERE job_id=?", [job["id"]]).fetchone()[0]
                    if size > MAX_STAGED_BYTES:
                        raise ValueError("Catalog refresh size limit")
                    db.execute("UPDATE mobile_catalog_refresh_jobs SET cursor=?,pending_max=?,pages=pages+1,done=?,updated=? WHERE id=?", [None if done else lowest, pending, int(done), time.time(), job["id"]])
                    db.commit()
                    job = dict(db.execute("SELECT * FROM mobile_catalog_refresh_jobs WHERE id=?", [job["id"]]).fetchone())
                if not done and self.stop.wait(0.4):
                    return True
            self.publish(job, owner)
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
                added = sum(not catalog.execute("SELECT 1 FROM catalog.Works WHERE Id=?", [row["work"]["Id"]]).fetchone() for row in rows)

            def finalize(db, revision):
                self.owned(db, job["id"], owner)
                for row in rows:
                    old = db.execute("SELECT payload FROM mobile_catalog_server_additions WHERE work_id=?", [row["work"]["Id"]]).fetchone()
                    if old:
                        row = {**row, "tags": sorted({tuple(tag) for tag in json.loads(old[0])["tags"] + row["tags"]})}
                    db.execute("INSERT OR REPLACE INTO mobile_catalog_server_additions VALUES(?,?)", [row["work"]["Id"], replica.encode(row)])
                db.execute("INSERT OR REPLACE INTO mobile_catalog_refresh_streams VALUES(?,?,?,?)", [job["language"], job["pending_max"] if job["done"] else job["watermark"], job["cursor"], job["pending_max"]])
                db.execute("UPDATE mobile_catalog_refresh_jobs SET state='completed',added=?,publication_revision=?,updated=? WHERE id=?", [added, revision, time.time(), job["id"]])
                db.execute("DELETE FROM mobile_catalog_refresh_pages WHERE job_id=?", [job["id"]])

            try:
                replica.publish({"version": 1, "baseRevision": current["revision"], "contentDigest": current["content_digest"], "userSnapshot": users}, self.root(), self.get_db, additions=rows, finalize=finalize)
                return
            except Exception as error:
                if getattr(error, "status_code", None) != 409 or attempt == 2:
                    raise


def register_refresh(app, get_db, root, require_auth, fetch_page):
    worker = RefreshWorker(get_db, root, fetch_page)
    app.on_event("startup")(worker.startup)
    app.on_event("shutdown")(worker.shutdown)

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
