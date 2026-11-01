"""Private, device-shared Somi metadata. Independent of catalog publication."""
import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

ID = re.compile(r"[A-Za-z0-9_-]{22}")
KEY = re.compile(r"[0-9a-f]{64}")
MAX_INT = 2**63 - 1
DDL = """
CREATE TABLE IF NOT EXISTS revision(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO revision VALUES(1,0);
CREATE TABLE IF NOT EXISTS state(
 post_id TEXT NOT NULL, kind TEXT NOT NULL, changed_at INTEGER NOT NULL,
 revision INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, PRIMARY KEY(post_id,kind));
"""


def validate(post_id, kind, body):
    fields = {"page", "changedAt"} if kind == "progress" else {
        "bookmarked", "title", "writerHandle", "writerName", "coverKey", "postSeconds", "changedAt"}
    if not ID.fullmatch(post_id) or not isinstance(body, dict) or set(body) != fields:
        raise HTTPException(422, "Invalid Somi state")
    numbers = [("changedAt", MAX_INT), ("page", 1000000)] if kind == "progress" else [("changedAt", MAX_INT), ("postSeconds", MAX_INT)]
    for name, maximum in numbers:
        if type(body[name]) is not int or not (1 if name == "page" else 0) <= body[name] <= maximum:
            raise HTTPException(422, "Invalid Somi number")
    if kind == "bookmark":
        if type(body["bookmarked"]) is not bool:
            raise HTTPException(422, "Invalid Somi bookmark")
        for name, maximum in [("title", 1024), ("writerHandle", 256), ("writerName", 256), ("coverKey", 64)]:
            value = body[name]
            if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 for c in value):
                raise HTTPException(422, "Invalid Somi text")
            try:
                value.encode("utf-8")
            except UnicodeError:
                raise HTTPException(422, "Invalid Somi text")
        if body["coverKey"] and not KEY.fullmatch(body["coverKey"]):
            raise HTTPException(422, "Invalid Somi cover key")
    return body


class Store:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.executescript(DDL)
            yield db
        finally:
            db.close()

    def put(self, post_id, kind, body):
        validate(post_id, kind, body)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT changed_at,payload FROM state WHERE post_id=? AND kind=?", (post_id, kind)).fetchone()
            if current and body["changedAt"] <= current[0]:
                return json.loads(current[1])
            db.execute("UPDATE revision SET value=value+1 WHERE id=1")
            revision = db.execute("SELECT value FROM revision WHERE id=1").fetchone()[0]
            result = {**body, "postId": post_id, "kind": kind, "revision": revision}
            db.execute("INSERT INTO state VALUES(?,?,?,?,?) ON CONFLICT(post_id,kind) DO UPDATE SET changed_at=excluded.changed_at,revision=excluded.revision,payload=excluded.payload",
                       (post_id, kind, body["changedAt"], revision, json.dumps(result, ensure_ascii=False)))
            db.commit()
            return result

    def changes(self, since, limit):
        with self.connect() as db:
            db.execute("BEGIN")
            latest = db.execute("SELECT value FROM revision WHERE id=1").fetchone()[0]
            if since > latest:
                raise HTTPException(409, "Somi cursor is ahead of server")
            rows = db.execute("SELECT revision,payload FROM state WHERE revision>? ORDER BY revision LIMIT ?", (since, limit + 1)).fetchall()
            more = len(rows) > limit
            items = [json.loads(row[1]) for row in rows[:limit]]
            return {"items": items, "nextRevision": rows[limit - 1][0] if more else latest,
                    "latestRevision": latest, "hasMore": more}


def register(app, require_client, path):
    store = Store(path)

    @app.get("/v1/somi/state")
    def changes(request: Request, since: int = 0, limit: int = 200, authorization: str | None = Header(default=None)):
        require_client(authorization)
        if set(request.query_params) - {"since", "limit"} or not 0 <= since <= MAX_INT or not 1 <= limit <= 200:
            raise HTTPException(422, "Invalid Somi cursor or limit")
        return store.changes(since, limit)

    async def put(request, post_id, kind, authorization):
        require_client(authorization)
        # Bound the body before decoding; the allowed metadata is far smaller.
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 16384:
                raise HTTPException(413, "Somi state is too large")
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            raise HTTPException(422, "Invalid Somi JSON")
        validate(post_id, kind, body)
        return await run_in_threadpool(store.put, post_id, kind, body)

    @app.put("/v1/somi/bookmarks/{post_id}")
    async def bookmark(post_id: str, request: Request, authorization: str | None = Header(default=None)):
        return await put(request, post_id, "bookmark", authorization)

    @app.put("/v1/somi/progress/{post_id}")
    async def progress(post_id: str, request: Request, authorization: str | None = Header(default=None)):
        return await put(request, post_id, "progress", authorization)
