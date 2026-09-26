"""Manga Collection release notifications (신간 알림) shared between the PC and mobile.

Decided 2026-09-25: the PC keeps detecting release events (Aladin/Kakao/MangaDex, see
`_tools/app/src-tauri/src/library/release_watch.rs`) and publishes its UNREAD events here.
Mobile lists them and confirms (확인) them; read state is shared both ways:

* 확인 on mobile marks the event read at once (it leaves the unread list immediately) and
  appends it to a read log. The PC consumes the log and calls its local
  `acknowledge_release_events`.
* Reading on the PC removes the event from the server with the PC's next complete upload:
  each upload is the PC's whole unread set, and its final chunk retires every event of an
  older generation.
* No push. When the PC is off, already-published unread events stay readable and
  acknowledgeable on mobile.

The server stores at most ``MAX_EVENTS`` rows (unread + read-but-still-uploaded), so every
query is a scan of a few thousand rows at most. Nothing runs in the background: retention
runs inside the write transactions.

All routes are JSON. Errors are ``{"detail": {"code", "message"}}`` with Korean messages
(401 from the auth guards is ``{"detail": "Unauthorized"}``). The routes are registered by
``mobile_collections.register_collections`` before ``GET /v1/collections/{collection_id}``,
which would otherwise match ``/v1/collections/releases``.

Event (upload item)
-------------------
``{"eventId", "collectionId", "collectionName", "provider", "kind", "volumeNumber",
"previousValue", "currentValue", "detectedAt"}``

* ``eventId`` - the PC's stable `release_watch_events.id` (UUID), ``[A-Za-z0-9_.:-]{1,128}``.
* ``collectionId`` - ``[A-Za-z0-9_-]{1,128}``; ``collectionName`` 1-2000 characters.
* ``provider`` - ``"aladin" | "kakao" | "mangadex"``.
* ``kind`` - ``"new_volume" | "release_date_changed" | "release_status_changed"``.
* ``volumeNumber`` - integer 1-999 (the PC's CHECK).
* ``previousValue`` / ``currentValue`` - string (<= 200 chars) or null. Dates are the
  provider's ``YYYY-MM-DD``; status values are ``"upcoming" | "released"``.
* ``detectedAt`` - ISO 8601 / RFC 3339 timestamp (no offset = UTC); echoed back as sent.

1. ``PUT /v1/collections/releases/unread`` (publisher)
   Body ``{"version": 1, "operationId": <UUID>, "generation": <decimal string>,
   "final": bool, "items": [Event, ... <= 500]}``, <= 4 MiB, unique ``eventId`` per chunk.
   ``generation`` is a JSON string holding a positive decimal integer without leading zeros
   (``[1-9][0-9]{0,15}``, at most 9007199254740991); use the Unix time in milliseconds
   when the upload started, e.g. ``"1790000000000"``. Generations are ordered numerically:
   a chunk whose generation is lower than the last completed (final) generation is
   refused with ``409 releaseGenerationStale`` (a late retry of an old upload can never
   retire newer events), and the final chunk retires only rows of lower generations.
   Send the whole unread set as chunks of one fresh generation, the last with
   ``final: true`` (an empty unread set is one empty final chunk). Every chunk upserts its
   events at once. Events the server already holds as read stay read (a mobile 확인 is
   never resurrected by an upload that raced it); their ids come back in ``alreadyRead``
   so the PC can acknowledge them locally right away, without waiting for the read log.
   The final chunk deletes every event (unread or read) whose generation is lower: the PC
   no longer has it unread. Upload one generation at a time.
   Reply ``{"version": 1, "operationId", "generation", "final", "items": n,
   "changed": n, "retired": n, "alreadyRead": [eventId], "revision": int}``.
   Idempotent by ``operationId``: the same body replays the stored reply; a different body
   with a used id is ``409 operationConflict``. Errors: ``422 invalidReleaseUpload``,
   ``413 releaseUploadTooLarge``, ``409 releaseGenerationStale``, ``409 releaseEventLimit``
   (more than ``MAX_EVENTS`` rows of this or a newer generation would be stored - rows an
   unfinished upload will retire do not count; nothing is written). Idempotency compares
   the parsed body, so a retry may re-serialize it.

2. ``GET /v1/collections/releases`` (client)
   Query: ``kinds`` (comma list, default ``new_volume,release_date_changed`` - the tablet
   kinds; pass all three to see status changes), ``state`` (``unread`` default | ``read``
   | ``all``), ``collectionId`` (optional), ``limit`` (1-100, default 50), ``cursor``
   (opaque ``nextCursor``). Newest first by ``detectedAt``, keyset pages.
   Reply ``{"version": 1, "revision": int, "generation": str|null, "publishedAt": str|null,
   "counts": {"unread": n, "collections": [{"collectionId", "unread": n}, ...]},
   "items": [Event + {"read": bool, "readAt": str|null}], "nextCursor": str|null,
   "hasMore": bool}``. ``counts`` are unread events of the requested ``kinds`` over all
   Collections (ignoring ``collectionId``/``state``/paging), sorted by ``collectionId`` -
   use them for card badges (``limit=1`` keeps the call tiny). ETag / ``If-None-Match``
   -> 304. Errors: ``422 invalidReleaseRequest``, ``400 invalidReleaseCursor``.

3. ``POST /v1/collections/releases/acknowledge`` (client)
   Body ``{"version": 1, "operationId": <UUID>, "eventIds": [eventId, ... 1-500 unique]}``
   or ``{"version": 1, "operationId": <UUID>, "collectionId": id, "kinds": [kind, ...]?}``
   (every unread event of that Collection whose kind is in ``kinds``, default the two
   tablet kinds, so a status change the tablet never showed stays unread on the PC).
   Marks them read (they leave the unread list at once) and appends one read-log entry per
   newly read event. Reply ``{"version": 1, "operationId", "acknowledged": [eventId],
   "alreadyRead": [eventId], "missing": [eventId], "revision": int, "lastSequence": int}``.
   ``missing`` are ids the server does not hold (already read and retired by the PC) -
   not an error; just refresh. Idempotent by ``operationId`` (``409 operationConflict``
   for a reused id with another body). Errors: ``422 invalidReleaseAcknowledge``,
   ``413 releaseAcknowledgeTooLarge``.

4. ``GET /v1/collections/releases/reads?after=<int>&limit=<1-200, default 100>`` (publisher)
   The read log, ``after`` exclusive. Reply ``{"version": 1, "after", "lastSequence",
   "prunedThrough", "nextCursor", "hasMore", "items": [{"sequence", "operationId",
   "collectionId", "eventId", "createdAt"}]}``, ETag. The PC acknowledges each item
   locally (unknown/already read ids are no-ops) and stores ``nextCursor``.
   ``409 releaseCursorRejected`` when ``after > lastSequence``; ``409
   releaseReadCursorExpired`` (with ``lastSequence``) when ``after < prunedThrough``:
   entries were pruned; resume from ``lastSequence`` and do a complete upload, whose
   ``alreadyRead`` replies cover every still-relevant read event.

Limits of retention: a read event is deleted ``READ_EVENT_DAYS`` days after it was read even
if the PC still uploads it; if the PC stays offline longer than that and never applied the
read (log pruned too), the event can reappear as unread after its next upload.

Retention: read-log entries older than ``READ_LOG_DAYS`` days or beyond the newest
``READ_LOG_MAX`` are pruned; read events older than ``READ_EVENT_DAYS`` days are deleted
even if the PC still uploads them; receipts keep the newest ``RECEIPTS_RETAINED``.
"""
import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

import conditional

PREFIX = "/v1/collections/releases"
KINDS = ("new_volume", "release_date_changed", "release_status_changed")
TABLET_KINDS = ("new_volume", "release_date_changed")
MAX_CURSOR = 9_007_199_254_740_991
MAX_ITEMS = 500
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_ACK_BYTES = 128 * 1024
MAX_EVENTS = 5_000
READ_LOG_DAYS = 90
READ_LOG_MAX = 10_000
READ_EVENT_DAYS = 180
RECEIPTS_RETAINED = 2_000

EventId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{1,128}$")]
CollectionId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
OperationId = Annotated[str, StringConstraints(min_length=36, max_length=36)]
Generation = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]{0,15}$")]
Kind = Literal["new_volume", "release_date_changed", "release_status_changed"]
Value = Annotated[str, StringConstraints(max_length=200)]

DDL = """
CREATE TABLE IF NOT EXISTS collection_release_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 read_sequence INTEGER NOT NULL, pruned_through INTEGER NOT NULL,
 generation INTEGER, published_at TEXT);
INSERT OR IGNORE INTO collection_release_state VALUES(1,0,0,0,NULL,NULL);
CREATE TABLE IF NOT EXISTS collection_release_events(
 id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, collection_id TEXT NOT NULL,
 collection_name TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL,
 volume_number INTEGER NOT NULL, previous_value TEXT, current_value TEXT,
 detected_at TEXT NOT NULL, detected_ms INTEGER NOT NULL, generation INTEGER NOT NULL,
 read_at TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_collection_release_events_order
 ON collection_release_events(detected_ms DESC, id DESC);
CREATE TABLE IF NOT EXISTS collection_release_reads(
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, event_id TEXT NOT NULL,
 collection_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_release_receipts(
 operation_id TEXT PRIMARY KEY, route TEXT NOT NULL, payload_digest TEXT NOT NULL,
 result_json TEXT NOT NULL, created_at TEXT NOT NULL);
"""

CONTENT = ("collection_id", "collection_name", "provider", "kind", "volume_number",
           "previous_value", "current_value", "detected_at")


def startup_db(db):
    db.executescript(DDL)


def fail(status, code, message, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra})


def now_utc():
    return datetime.now(timezone.utc)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def parse_instant(value):
    """``datetime`` for an ISO 8601 timestamp (``Z`` accepted, no offset = UTC)."""
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace("z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Event(Strict):
    eventId: EventId
    collectionId: CollectionId
    collectionName: Annotated[str, StringConstraints(min_length=1, max_length=2000)]
    provider: Literal["aladin", "kakao", "mangadex"]
    kind: Kind
    volumeNumber: int = Field(ge=1, le=999)
    previousValue: Value | None = None
    currentValue: Value | None = None
    detectedAt: Annotated[str, StringConstraints(min_length=1, max_length=64)]

    @field_validator("detectedAt")
    @classmethod
    def _instant(cls, value):
        try:
            parse_instant(value)
        except (ValueError, OverflowError):
            raise ValueError("detectedAt must be an ISO 8601 timestamp") from None
        return value


class Upload(Strict):
    version: Literal[1]
    operationId: OperationId
    generation: Generation
    final: bool
    items: list[Event] = Field(max_length=MAX_ITEMS)


class Acknowledge(Strict):
    version: Literal[1]
    operationId: OperationId
    eventIds: list[EventId] | None = Field(default=None, min_length=1, max_length=MAX_ITEMS)
    collectionId: CollectionId | None = None
    kinds: list[Kind] | None = Field(default=None, min_length=1, max_length=3)


def _uuid(value, code, message):
    try:
        if str(UUID(value)) != value:
            raise ValueError()
    except ValueError:
        fail(422, code, message)


async def _bounded(request, limit, code, message):
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        fail(413, code, message)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            fail(413, code, message)
    return bytes(raw)


def _state(db):
    return db.execute("SELECT * FROM collection_release_state WHERE singleton=1").fetchone()


def _bump(db):
    db.execute("UPDATE collection_release_state SET revision=revision+1 WHERE singleton=1")


def status_head(db):
    """Read-log head for ``/v1/sync/status`` ``publisherLogs.releaseReads`` (as ``/reads`` reports it)."""
    current = _state(db)
    return {"last": current["read_sequence"], "prunedThrough": current["pruned_through"]}


def status_signal(db):
    """The list ``revision`` clients compare, for ``/v1/sync/status`` ``signals.releases``."""
    return _state(db)["revision"]


def _receipt(db, operation_id, digest, what):
    row = db.execute("SELECT payload_digest,result_json FROM collection_release_receipts WHERE operation_id=?",
                     (operation_id,)).fetchone()
    if row is None:
        return None
    if row["payload_digest"] != digest:
        fail(409, "operationConflict", f"다른 내용으로 {what} 요청을 재사용할 수 없습니다.")
    return json.loads(row["result_json"])


def _store_receipt(db, operation_id, route, digest, result, now):
    db.execute("INSERT INTO collection_release_receipts VALUES(?,?,?,?,?)",
               (operation_id, route, digest, json.dumps(result), now))


def _retain(db, now):
    """Bounded retention, run inside every write transaction (all tables stay small)."""
    log_cutoff = (now - timedelta(days=READ_LOG_DAYS)).isoformat()
    last = _state(db)["read_sequence"]
    pruned = db.execute("SELECT MAX(sequence) FROM collection_release_reads WHERE created_at<? OR sequence<=?",
                        (log_cutoff, last - READ_LOG_MAX)).fetchone()[0]
    if pruned is not None:
        db.execute("DELETE FROM collection_release_reads WHERE sequence<=?", (pruned,))
        db.execute("UPDATE collection_release_state SET pruned_through=MAX(pruned_through,?) WHERE singleton=1",
                   (pruned,))
    removed = db.execute("DELETE FROM collection_release_events WHERE read_at IS NOT NULL AND read_at<?",
                         ((now - timedelta(days=READ_EVENT_DAYS)).isoformat(),)).rowcount
    if removed:
        _bump(db)
    db.execute("""DELETE FROM collection_release_receipts WHERE operation_id NOT IN
        (SELECT operation_id FROM collection_release_receipts ORDER BY created_at DESC LIMIT ?)""",
               (RECEIPTS_RETAINED,))


def _item(row):
    return {"eventId": row["event_id"], "collectionId": row["collection_id"],
            "collectionName": row["collection_name"], "provider": row["provider"], "kind": row["kind"],
            "volumeNumber": row["volume_number"], "previousValue": row["previous_value"],
            "currentValue": row["current_value"], "detectedAt": row["detected_at"],
            "read": row["read_at"] is not None, "readAt": row["read_at"]}


def _encode_cursor(row):
    return base64.urlsafe_b64encode(f"{row['detected_ms']}:{row['id']}".encode()).decode().rstrip("=")


def _decode_cursor(cursor):
    try:
        ms, row_id = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode().split(":")
        ms, row_id = int(ms), int(row_id)
    except (ValueError, UnicodeDecodeError):
        fail(400, "invalidReleaseCursor", "신간 알림 목록 위치를 확인할 수 없습니다.")
    if not 0 < row_id <= MAX_CURSOR or abs(ms) > MAX_CURSOR:
        fail(400, "invalidReleaseCursor", "신간 알림 목록 위치를 확인할 수 없습니다.")
    return ms, row_id


def _kinds(raw):
    if raw is None:
        return TABLET_KINDS
    kinds = tuple(dict.fromkeys(part.strip() for part in raw.split(",")))
    if not kinds or any(kind not in KINDS for kind in kinds):
        fail(422, "invalidReleaseRequest", "신간 알림 목록 요청을 확인할 수 없습니다.")
    return kinds


def register(app, get_db, require_client, require_publisher):
    """Install the routes. Tables come from ``startup_db`` (called by the Collections startup)."""

    def invalid_upload():
        fail(422, "invalidReleaseUpload", "신간 알림 목록을 확인할 수 없습니다.")

    def upload(publication):
        _uuid(publication.operationId, "invalidReleaseUpload", "게시 요청 식별자가 올바르지 않습니다.")
        ids = [item.eventId for item in publication.items]
        if len(set(ids)) != len(ids):
            invalid_upload()
        generation = int(publication.generation)
        if generation > MAX_CURSOR:
            invalid_upload()
        digest = hashlib.sha256(encode(publication.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            replay = _receipt(db, publication.operationId, digest, "게시")
            if replay is not None:
                return replay
            completed = _state(db)["generation"]
            if completed is not None and generation < completed:
                fail(409, "releaseGenerationStale", "더 새로운 신간 알림 목록이 이미 게시되었습니다.")
            moment = now_utc()
            now = moment.isoformat()
            changed, already_read = 0, []
            for item in publication.items:
                values = (item.collectionId, item.collectionName, item.provider, item.kind, item.volumeNumber,
                          item.previousValue, item.currentValue, item.detectedAt)
                detected_ms = int(parse_instant(item.detectedAt).timestamp() * 1000)
                row = db.execute("SELECT * FROM collection_release_events WHERE event_id=?", (item.eventId,)).fetchone()
                if row is None:
                    db.execute(f"""INSERT INTO collection_release_events(event_id,{','.join(CONTENT)},detected_ms,
                        generation,read_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?)""",
                               (item.eventId, *values, detected_ms, generation, now))
                    changed += 1
                    continue
                if row["read_at"] is not None:
                    already_read.append(item.eventId)
                same = tuple(row[column] for column in CONTENT) == values
                db.execute(f"""UPDATE collection_release_events SET {','.join(c + '=?' for c in CONTENT)},
                    detected_ms=?,generation=MAX(generation,?),updated_at=? WHERE event_id=?""",
                           (*values, detected_ms, generation, now if not same else row["updated_at"],
                            item.eventId))
                changed += not same
            retired = retired_read = 0
            if publication.final:
                retired = db.execute("DELETE FROM collection_release_events WHERE generation<? AND read_at IS NULL",
                                     (generation,)).rowcount
                retired_read = db.execute("DELETE FROM collection_release_events WHERE generation<?",
                                          (generation,)).rowcount
                db.execute("UPDATE collection_release_state SET generation=?,published_at=? WHERE singleton=1",
                           (generation, now))
            if changed or retired or retired_read:
                _bump(db)
            _retain(db, moment)
            # Only rows that survive this upload count: older generations are retired by
            # its final chunk (on a final chunk they are already gone).
            if db.execute("SELECT COUNT(*) FROM collection_release_events WHERE generation>=?",
                          (generation,)).fetchone()[0] > MAX_EVENTS:
                db.rollback()
                fail(409, "releaseEventLimit", "신간 알림이 너무 많습니다. PC에서 확인한 뒤 다시 게시해 주세요.")
            result = {"version": 1, "operationId": publication.operationId, "generation": publication.generation,
                      "final": publication.final, "items": len(ids), "changed": changed, "retired": retired,
                      "alreadyRead": already_read, "revision": _state(db)["revision"]}
            _store_receipt(db, publication.operationId, "upload", digest, result, now)
            db.commit()
            return result

    @app.put(PREFIX + "/unread")
    async def put_unread(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await _bounded(request, MAX_BODY_BYTES, "releaseUploadTooLarge", "신간 알림 게시 요청이 너무 큽니다.")
        try:
            publication = Upload.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_upload()
        return await run_in_threadpool(upload, publication)

    @app.get(PREFIX)
    def listing(request: Request, kinds: str | None = Query(default=None, max_length=100),
                state: Literal["unread", "read", "all"] = Query(default="unread"),
                collectionId: CollectionId | None = Query(default=None),
                limit: int = Query(default=50, ge=1, le=100),
                cursor: str | None = Query(default=None, max_length=64),
                authorization: str | None = Header(default=None),
                if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        if set(request.query_params.keys()) - {"kinds", "state", "collectionId", "limit", "cursor"}:
            fail(422, "invalidReleaseRequest", "신간 알림 목록 요청을 확인할 수 없습니다.")
        selected = _kinds(kinds)
        marks = ",".join("?" * len(selected))
        clauses, params = [f"kind IN ({marks})"], list(selected)
        if state != "all":
            clauses.append("read_at IS NULL" if state == "unread" else "read_at IS NOT NULL")
        if collectionId is not None:
            clauses.append("collection_id=?")
            params.append(collectionId)
        if cursor is not None:
            ms, row_id = _decode_cursor(cursor)
            clauses.append("(detected_ms<? OR (detected_ms=? AND id<?))")
            params.extend((ms, ms, row_id))
        with get_db() as db:
            db.execute("BEGIN")
            current = _state(db)
            rows = db.execute(f"SELECT * FROM collection_release_events WHERE {' AND '.join(clauses)}"
                              " ORDER BY detected_ms DESC, id DESC LIMIT ?", (*params, limit + 1)).fetchall()
            counts = db.execute(f"""SELECT collection_id,COUNT(*) FROM collection_release_events
                WHERE read_at IS NULL AND kind IN ({marks}) GROUP BY collection_id ORDER BY collection_id""",
                                selected).fetchall()
            db.rollback()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "revision": current["revision"],
            "generation": None if current["generation"] is None else str(current["generation"]),
            "publishedAt": current["published_at"],
            "counts": {"unread": sum(r[1] for r in counts),
                       "collections": [{"collectionId": r[0], "unread": r[1]} for r in counts]},
            "items": [_item(r) for r in rows],
            "nextCursor": _encode_cursor(rows[-1]) if more else None, "hasMore": more}, if_none_match)

    def invalid_ack():
        fail(422, "invalidReleaseAcknowledge", "신간 알림 확인 요청을 확인할 수 없습니다.")

    def acknowledge(command):
        _uuid(command.operationId, "invalidReleaseAcknowledge", "확인 요청 식별자가 올바르지 않습니다.")
        by_ids = command.eventIds is not None
        if by_ids == (command.collectionId is not None) or (by_ids and command.kinds is not None):
            invalid_ack()
        if by_ids and len(set(command.eventIds)) != len(command.eventIds):
            invalid_ack()
        digest = hashlib.sha256(encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            replay = _receipt(db, command.operationId, digest, "확인")
            if replay is not None:
                return replay
            moment = now_utc()
            now = moment.isoformat()
            if by_ids:
                marks = ",".join("?" * len(command.eventIds))
                rows = {r["event_id"]: r for r in db.execute(
                    f"SELECT event_id,collection_id,read_at FROM collection_release_events WHERE event_id IN ({marks})",
                    command.eventIds)}
                targets = [rows[i] for i in command.eventIds if i in rows and rows[i]["read_at"] is None]
                already = [i for i in command.eventIds if i in rows and rows[i]["read_at"] is not None]
                missing = [i for i in command.eventIds if i not in rows]
            else:
                kinds = tuple(dict.fromkeys(command.kinds or TABLET_KINDS))
                targets = db.execute(f"""SELECT event_id,collection_id FROM collection_release_events
                    WHERE collection_id=? AND read_at IS NULL AND kind IN ({','.join('?' * len(kinds))})
                    ORDER BY detected_ms DESC, id DESC""", (command.collectionId, *kinds)).fetchall()
                already, missing = [], []
            sequence = _state(db)["read_sequence"]
            for row in targets:
                sequence += 1
                db.execute("UPDATE collection_release_events SET read_at=?,updated_at=? WHERE event_id=?",
                           (now, now, row["event_id"]))
                db.execute("INSERT INTO collection_release_reads VALUES(?,?,?,?,?)",
                           (sequence, command.operationId, row["event_id"], row["collection_id"], now))
            if targets:
                db.execute("UPDATE collection_release_state SET read_sequence=? WHERE singleton=1", (sequence,))
                _bump(db)
            _retain(db, moment)
            result = {"version": 1, "operationId": command.operationId,
                      "acknowledged": [r["event_id"] for r in targets], "alreadyRead": already, "missing": missing,
                      "revision": _state(db)["revision"], "lastSequence": sequence}
            _store_receipt(db, command.operationId, "acknowledge", digest, result, now)
            db.commit()
            return result

    @app.post(PREFIX + "/acknowledge")
    async def post_acknowledge(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await _bounded(request, MAX_ACK_BYTES, "releaseAcknowledgeTooLarge", "신간 알림 확인 요청이 너무 큽니다.")
        try:
            command = Acknowledge.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_ack()
        return await run_in_threadpool(acknowledge, command)

    @app.get(PREFIX + "/reads")
    def reads(after: int = Query(default=0, ge=0, le=MAX_CURSOR), limit: int = Query(default=100, ge=1, le=200),
              authorization: str | None = Header(default=None),
              if_none_match: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            current = _state(db)
            last, pruned = current["read_sequence"], current["pruned_through"]
            if after > last:
                db.rollback()
                fail(409, "releaseCursorRejected", "신간 알림 동기화 위치를 확인해 주세요.")
            if after < pruned:
                db.rollback()
                fail(409, "releaseReadCursorExpired", "오래된 신간 알림 확인 기록이 정리되었습니다. 전체 목록을 다시 게시해 주세요.",
                     lastSequence=last)
            rows = db.execute("SELECT * FROM collection_release_reads WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            db.rollback()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "after": after, "lastSequence": last, "prunedThrough": pruned,
            "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
            "items": [{"sequence": r["sequence"], "operationId": r["operation_id"], "collectionId": r["collection_id"],
                       "eventId": r["event_id"], "createdAt": r["created_at"]} for r in rows]}, if_none_match)

    return startup_db
