"""Small, append-only product-code inbox for the paired collector and PC."""
import hashlib
import json
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from uuid import UUID
from urllib.parse import urlsplit

from app_lifecycle import lifecycle
from fastapi import Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, TypeAdapter, ValidationError, field_validator

MAX_BODY_BYTES = 4096
RATE_LIMIT = 30
RETENTION_DAYS = 30
PRUNE_BATCH = 1000

DDL = """
CREATE TABLE IF NOT EXISTS av_lookup_requests (
 sequence INTEGER PRIMARY KEY,
 request_id TEXT UNIQUE NOT NULL,
 product_code TEXT NOT NULL,
 source_url TEXT,
 body_sha256 TEXT NOT NULL,
 received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS av_lookup_requests_received_at
 ON av_lookup_requests(received_at);
"""


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        db.commit()


class LookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    requestId: str
    productCode: str = Field(min_length=1, max_length=40)
    sourceUrl: str | None = Field(default=None, max_length=2048)

    @field_validator("requestId")
    @classmethod
    def uuid4(cls, value):
        if UUID(value).version != 4:
            raise ValueError("requestId must be a UUID4 string")
        return value

    @field_validator("sourceUrl")
    @classmethod
    def https_url(cls, value):
        if value is not None:
            url = TypeAdapter(HttpUrl).validate_python(value)
            if url.scheme != "https" or not urlsplit(value).netloc or any(c.isspace() for c in value):
                raise ValueError("sourceUrl must be an HTTPS URL")
        return value


class RateLimiter:
    """Sliding window per authenticated credential, local to this API process."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.windows = {}
        self.lock = threading.Lock()

    def check(self, principal):
        now = self.clock()
        with self.lock:
            for key in list(self.windows):
                window = self.windows[key]
                while window and window[0] <= now - 60:
                    window.popleft()
                if not window:
                    del self.windows[key]
            window = self.windows.setdefault(principal, deque())
            if len(window) >= RATE_LIMIT:
                raise HTTPException(429, detail={"code": "avLookupRateLimited"},
                                    headers={"Retry-After": "60"})
            window.append(now)


def receipt(row):
    return {"requestId": row["request_id"], "sequence": row["sequence"],
            "receivedAt": row["received_at"]}


def insert(get_db, body):
    digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True,
                                      separators=(",", ":")).encode()).hexdigest()
    now = datetime.now(timezone.utc)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM av_lookup_requests WHERE request_id=?",
                              (body.requestId,)).fetchone()
        if existing is not None:
            if existing["body_sha256"] != digest:
                raise HTTPException(409, detail={"code": "avLookupConflict"})
            return receipt(existing)
        cursor = db.execute(
            "INSERT INTO av_lookup_requests(request_id,product_code,source_url,body_sha256,received_at) "
            "VALUES(?,?,?,?,?)", (body.requestId, body.productCode, body.sourceUrl, digest, now.isoformat()))
        # Insert first: retaining the new maximum prevents sequence reuse after pruning.
        db.execute("DELETE FROM av_lookup_requests WHERE sequence IN "
                   "(SELECT sequence FROM av_lookup_requests WHERE received_at < ? "
                   "ORDER BY received_at LIMIT ?)",
                   ((now - timedelta(days=RETENTION_DAYS)).isoformat(), PRUNE_BATCH))
        db.commit()
        return {"requestId": body.requestId, "sequence": cursor.lastrowid, "receivedAt": now.isoformat()}


def register(app, get_db, require_capture_client, require_publisher, require_client=None):
    limiter = RateLimiter()

    def require_av_lookup_client(authorization):
        try:
            return require_capture_client(authorization)
        except HTTPException as capture_failure:
            if require_client is None:
                raise
            try:
                return require_client(authorization)
            except HTTPException:
                raise capture_failure

    def setup():
        startup(get_db)

    lifecycle(app).on_startup(setup)

    @app.post("/v1/av-lookups")
    async def create(request: Request, authorization: str | None = Header(default=None)):
        principal = await run_in_threadpool(require_av_lookup_client, authorization)
        limiter.check(principal)
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_BODY_BYTES:
                raise HTTPException(413, detail={"code": "avLookupRequestTooLarge"})
            raw.extend(chunk)
        try:
            body = LookupRequest.model_validate_json(bytes(raw))
        except ValidationError:
            raise HTTPException(422, detail={"code": "invalidAvLookupRequest"})
        return await run_in_threadpool(insert, get_db, body)

    @app.get("/v1/av-lookups")
    def listing(after: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=100),
                authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            rows = db.execute("SELECT * FROM av_lookup_requests WHERE sequence > ? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
        items = [{**receipt(row), "productCode": row["product_code"], "sourceUrl": row["source_url"]}
                 for row in rows[:limit]]
        return {"items": items, "nextAfter": items[-1]["sequence"] if items else after,
                "hasMore": len(rows) > limit}

    return setup
