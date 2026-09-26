"""Home 발매 예정: the PC's game/movie release calendar and wishlist (HOME-DASH-001, phase 2).

The PC owns both (`_tools/app/src-tauri/src/library/release_calendar.rs`,
`release_wishlist.rs`): it fetches the ~6-month calendar (IGDB games, TMDB movies with a Korean
release) and tracks the titles the user wished for. It publishes one full snapshot here; the
tablet reads it and files wishlist *intents* (add/remove/mute/unmute/acknowledge) that the PC
reads from an ordered log, applies locally and acknowledges with its next snapshot
(``intentCursor``). Until then the tablet overlays its ``pending`` intents on the snapshot.
The server never edits the snapshot. Nothing runs in the background.

Errors are ``{"detail": {"code", "message"}}`` (401 from the auth guards is
``{"detail": "Unauthorized"}``; a client credential on a publisher route is 401 too).

Title (calendar entry)
----------------------
``{"id": "igdb:1942" | "tmdb:12345", "kind": "game"|"movie", "title", "originalTitle"|null,
"date": "YYYY-MM-DD"|null, "precision": "exact"|"month"|"quarter"|"year"|"tbd",
"region": str|null, "platforms": [str], "releaseType": str|null, "cover": Cover|null,
"popularity": number|null}``

* ``id`` is the PC's stable ``provider:external_id`` (``[A-Za-z0-9_-]{1,64}`` after the colon);
  ``igdb`` <=> ``game``, ``tmdb`` <=> ``movie``.
* ``date`` is the first day of the stated period; null exactly when ``precision`` is ``tbd``.
* ``cover`` - see ``home_publications`` (IGDB/TMDB image URL, or an uploaded artwork blob).
* Limits: title/originalTitle <= 500, region <= 16, platforms <= 32 x 100, releaseType <= 40.

Wishlist item = Title + ``{"source": "calendar"|"manual", "addedAt", "muted": bool,
"released": bool, "events": [{"id", "kind": "date_set"|"date_changed"|"released",
"previousValue"|null, "currentValue"|null, "detectedAt", "readAt"|null}, ... <= 50]}``.

1. ``PUT /v1/home/upcoming`` (publisher) - full snapshot, <= 8 MiB:
   ``{"version": 1, "generatedAt", "rangeStart": "YYYY-MM-DD", "rangeEnd": "YYYY-MM-DD",
   "entries": [Title, ... <= 3000], "wishlist": [WishItem, ... <= 1000],
   "sources": [{"provider": "igdb"|"tmdb", "fetchedAt"|null, "errorCode"|null}, ... <= 2],
   "intentCursor": int|null}``. Replaces the previous snapshot. ``intentCursor`` = the last
   intent sequence the PC has applied (acknowledges the log through it; never moves back).
   Naturally idempotent. Reply ``{"version": 1, "revision", "changed": bool,
   "acknowledgedThrough"}``. Errors: ``422 invalidUpcomingUpload``, ``413
   upcomingUploadTooLarge``, ``409 upcomingIntentCursorRejected`` (cursor beyond the log),
   ``409 homeCoverNotUploaded``.
2. ``GET /v1/home/upcoming`` (client) - ``{"version": 1, "revision", "publishedAt"|null,
   "generatedAt"|null, "rangeStart"|null, "rangeEnd"|null, "entries", "wishlist", "sources",
   "acknowledgedThrough", "pending": [Intent]}`` with ETag / 304. Before the first
   publication the lists are empty and ``publishedAt`` is null.
3. ``POST /v1/home/upcoming/wishlist`` (client) - ``{"version": 1, "operationId": <UUID>,
   "action": "add"|"remove"|"mute"|"unmute"|"acknowledge", "itemId", "eventIds": [...]}``
   (``eventIds`` 1-100 unique ids only with ``acknowledge``). ``itemId`` must be a published
   entry or wishlist item, or have a pending intent (``409 upcomingItemUnknown``). Appends one
   intent. Reply ``{"version": 1, "operationId", "sequence", "revision"}``. Idempotent by
   ``operationId`` (same body replays the reply; another body is ``409 operationConflict``).
   ``409 upcomingIntentLimit`` beyond ``MAX_PENDING`` unacknowledged intents. ``422
   invalidUpcomingIntent``, ``413 upcomingIntentTooLarge``.
4. ``GET /v1/home/upcoming/wishlist/intents?after=<int>&limit=<1-200>`` (publisher) -
   ``{"version": 1, "after", "lastSequence", "acknowledgedThrough", "prunedThrough",
   "nextCursor", "hasMore", "items": [Intent]}``, ETag. Intent = ``{"sequence",
   "operationId", "action", "itemId", "eventIds": [...]|null, "createdAt"}``. ``409
   upcomingCursorRejected`` when ``after > lastSequence``; ``409 upcomingIntentsExpired``
   (with ``lastSequence``) when ``after < prunedThrough``. The PC applies intents in order
   (unknown ids and no-op changes are fine) and then publishes with ``intentCursor``.

Signals: ``signals.upcoming`` (tablet) = ``revision`` (moves on a changed snapshot, a new
intent and an acknowledgement); ``publisherLogs.upcomingIntents`` = ``{"last",
"acknowledgedThrough", "prunedThrough"}``.

Retention: acknowledged intents older than ``INTENT_DAYS`` days or beyond the newest
``INTENT_LOG_MAX`` are pruned; receipts keep the newest ``RECEIPTS_RETAINED``.
"""
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import Header, Query, Request
from pydantic import Field, StringConstraints, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool

import conditional
import home_publications as common
from home_publications import Cover, Day, OperationId, Strict, Timestamp, fail, text

PREFIX = "/v1/home/upcoming"
MAX_CURSOR = 9_007_199_254_740_991
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_INTENT_BYTES = 16 * 1024
MAX_ENTRIES = 3000
MAX_WISHLIST = 1000
MAX_PENDING = 500
INTENT_DAYS = 30
INTENT_LOG_MAX = 5000
RECEIPTS_RETAINED = 2000
COVER_OWNER = "upcoming"

ItemId = Annotated[str, StringConstraints(pattern=r"^(igdb|tmdb):[A-Za-z0-9_-]{1,64}$")]
EventId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{1,128}$")]
Value = Annotated[str, StringConstraints(max_length=200)]

DDL = """
CREATE TABLE IF NOT EXISTS home_upcoming_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 published_at TEXT, digest TEXT, document TEXT,
 intent_sequence INTEGER NOT NULL, acknowledged_through INTEGER NOT NULL, pruned_through INTEGER NOT NULL);
INSERT OR IGNORE INTO home_upcoming_state VALUES(1,0,NULL,NULL,NULL,0,0,0);
CREATE TABLE IF NOT EXISTS home_upcoming_ids(item_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS home_upcoming_intents(
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, action TEXT NOT NULL, item_id TEXT NOT NULL,
 event_ids TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS home_upcoming_receipts(
 operation_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at TEXT NOT NULL);
"""


def startup_db(db):
    db.executescript(DDL)
    common.startup_db(db)


def now_utc():
    return datetime.now(timezone.utc)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Title(Strict):
    id: ItemId
    kind: Literal["game", "movie"]
    title: text(500)
    originalTitle: text(500) | None = None
    date: Day | None = None
    precision: Literal["exact", "month", "quarter", "year", "tbd"]
    region: text(16) | None = None
    platforms: list[text(100)] = Field(default_factory=list, max_length=32)
    releaseType: text(40) | None = None
    cover: Cover | None = None
    popularity: int | float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _consistent(self):
        if (self.kind == "game") != self.id.startswith("igdb:"):
            raise ValueError("kind does not match provider")
        if (self.precision == "tbd") != (self.date is None):
            raise ValueError("date must be null exactly for tbd")
        return self


class WatchEvent(Strict):
    id: EventId
    kind: Literal["date_set", "date_changed", "released"]
    previousValue: Value | None = None
    currentValue: Value | None = None
    detectedAt: Timestamp
    readAt: Timestamp | None = None


class WishItem(Title):
    source: Literal["calendar", "manual"]
    addedAt: Timestamp
    muted: bool
    released: bool
    events: list[WatchEvent] = Field(default_factory=list, max_length=50)


class Source(Strict):
    provider: Literal["igdb", "tmdb"]
    fetchedAt: Timestamp | None = None
    errorCode: text(64) | None = None


class Upload(Strict):
    version: Literal[1]
    generatedAt: Timestamp
    rangeStart: Day
    rangeEnd: Day
    entries: list[Title] = Field(max_length=MAX_ENTRIES)
    wishlist: list[WishItem] = Field(max_length=MAX_WISHLIST)
    sources: list[Source] = Field(default_factory=list, max_length=2)
    intentCursor: int | None = Field(default=None, ge=0, le=MAX_CURSOR)


class Intent(Strict):
    version: Literal[1]
    operationId: OperationId
    action: Literal["add", "remove", "mute", "unmute", "acknowledge"]
    itemId: ItemId
    eventIds: list[EventId] | None = Field(default=None, min_length=1, max_length=100)


def _state(db):
    return db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()


def status_signal(db):
    """``signals.upcoming``: the document revision the tablet compares."""
    return _state(db)["revision"]


def status_head(db):
    """``publisherLogs.upcomingIntents``: the intent log head the PC compares with its cursor."""
    state = _state(db)
    return {"last": state["intent_sequence"], "acknowledgedThrough": state["acknowledged_through"],
            "prunedThrough": state["pruned_through"]}


def _intent(row):
    return {"sequence": row["sequence"], "operationId": row["operation_id"], "action": row["action"],
            "itemId": row["item_id"], "eventIds": None if row["event_ids"] is None else json.loads(row["event_ids"]),
            "createdAt": row["created_at"]}


def _retain(db, now):
    state = _state(db)
    cutoff = (now - timedelta(days=INTENT_DAYS)).isoformat()
    pruned = db.execute("""SELECT MAX(sequence) FROM home_upcoming_intents WHERE sequence<=?
        AND (created_at<? OR sequence<=?)""",
                        (state["acknowledged_through"], cutoff, state["intent_sequence"] - INTENT_LOG_MAX)
                        ).fetchone()[0]
    if pruned is not None:
        db.execute("DELETE FROM home_upcoming_intents WHERE sequence<=?", (pruned,))
        db.execute("UPDATE home_upcoming_state SET pruned_through=MAX(pruned_through,?) WHERE singleton=1",
                   (pruned,))
    db.execute("""DELETE FROM home_upcoming_receipts WHERE operation_id NOT IN
        (SELECT operation_id FROM home_upcoming_receipts ORDER BY created_at DESC LIMIT ?)""",
               (RECEIPTS_RETAINED,))


def register(app, get_db, require_client, require_publisher):
    """Install the routes; returns the startup hook (creates empty tables only)."""

    def invalid_upload():
        fail(422, "invalidUpcomingUpload", "발매 예정 목록을 확인할 수 없습니다.")

    def publish(upload):
        ids = [item.id for item in upload.entries]
        wished = [item.id for item in upload.wishlist]
        if len(set(ids)) != len(ids) or len(set(wished)) != len(wished) or upload.rangeStart > upload.rangeEnd:
            invalid_upload()
        if len({source.provider for source in upload.sources}) != len(upload.sources):
            invalid_upload()
        covers = [item.cover for item in (*upload.entries, *upload.wishlist)]
        common.blobs(covers)
        document = upload.model_dump(exclude={"version", "intentCursor"})
        digest = hashlib.sha256(encode(document).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            state = _state(db)
            cursor = upload.intentCursor
            if cursor is not None and cursor > state["intent_sequence"]:
                db.rollback()
                fail(409, "upcomingIntentCursorRejected", "발매 예정 요청 위치를 확인해 주세요.")
            acknowledged = max(state["acknowledged_through"], cursor or 0)
            changed = digest != state["digest"]
            if changed:
                common.replace_cover_refs(db, COVER_OWNER, covers)
            moment = now_utc()
            if changed or acknowledged != state["acknowledged_through"]:
                db.execute("""UPDATE home_upcoming_state SET revision=revision+1, acknowledged_through=?
                    WHERE singleton=1""", (acknowledged,))
            if changed:
                db.execute("UPDATE home_upcoming_state SET digest=?,document=?,published_at=? WHERE singleton=1",
                           (digest, encode(document), moment.isoformat()))
                db.execute("DELETE FROM home_upcoming_ids")
                db.executemany("INSERT OR IGNORE INTO home_upcoming_ids VALUES(?)",
                               [(item_id,) for item_id in (*ids, *wished)])
            _retain(db, moment)
            result = {"version": 1, "revision": _state(db)["revision"], "changed": changed,
                      "acknowledgedThrough": acknowledged}
            db.commit()
            return result

    @app.put(PREFIX)
    async def put_upcoming(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await common.bounded_body(request, MAX_BODY_BYTES, "upcomingUploadTooLarge",
                                         "발매 예정 게시 요청이 너무 큽니다.")
        try:
            upload = Upload.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_upload()
        return await run_in_threadpool(publish, upload)

    @app.get(PREFIX)
    def get_upcoming(authorization: str | None = Header(default=None),
                     if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            state = _state(db)
            pending = db.execute("SELECT * FROM home_upcoming_intents WHERE sequence>? ORDER BY sequence",
                                 (state["acknowledged_through"],)).fetchall()
            db.rollback()
        document = json.loads(state["document"]) if state["document"] else {
            "generatedAt": None, "rangeStart": None, "rangeEnd": None, "entries": [], "wishlist": [], "sources": []}
        return conditional.json_response({
            "version": 1, "revision": state["revision"], "publishedAt": state["published_at"],
            "generatedAt": document["generatedAt"], "rangeStart": document["rangeStart"],
            "rangeEnd": document["rangeEnd"], "entries": document["entries"], "wishlist": document["wishlist"],
            "sources": document["sources"], "acknowledgedThrough": state["acknowledged_through"],
            "pending": [_intent(row) for row in pending]}, if_none_match)

    def invalid_intent():
        fail(422, "invalidUpcomingIntent", "찜 요청을 확인할 수 없습니다.")

    def file_intent(intent):
        common.uuid_or_fail(intent.operationId, "invalidUpcomingIntent", "요청 식별자가 올바르지 않습니다.")
        if (intent.action == "acknowledge") != (intent.eventIds is not None):
            invalid_intent()
        if intent.eventIds is not None and len(set(intent.eventIds)) != len(intent.eventIds):
            invalid_intent()
        digest = hashlib.sha256(encode(intent.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload_digest,result_json FROM home_upcoming_receipts WHERE operation_id=?",
                             (intent.operationId,)).fetchone()
            if row is not None:
                db.rollback()
                if row["payload_digest"] != digest:
                    fail(409, "operationConflict", "다른 내용으로 찜 요청을 재사용할 수 없습니다.")
                return json.loads(row["result_json"])
            state = _state(db)
            known = db.execute("SELECT 1 FROM home_upcoming_ids WHERE item_id=?", (intent.itemId,)).fetchone() or \
                db.execute("SELECT 1 FROM home_upcoming_intents WHERE item_id=? AND sequence>?",
                           (intent.itemId, state["acknowledged_through"])).fetchone()
            if not known:
                db.rollback()
                fail(409, "upcomingItemUnknown", "발매 예정 목록에 없는 작품입니다.")
            waiting = state["intent_sequence"] - state["acknowledged_through"]
            if waiting >= MAX_PENDING:
                db.rollback()
                fail(409, "upcomingIntentLimit", "PC가 아직 처리하지 않은 찜 요청이 너무 많습니다.")
            moment = now_utc()
            now = moment.isoformat()
            sequence = state["intent_sequence"] + 1
            db.execute("INSERT INTO home_upcoming_intents VALUES(?,?,?,?,?,?)",
                       (sequence, intent.operationId, intent.action, intent.itemId,
                        None if intent.eventIds is None else json.dumps(intent.eventIds), now))
            db.execute("UPDATE home_upcoming_state SET intent_sequence=?,revision=revision+1 WHERE singleton=1",
                       (sequence,))
            _retain(db, moment)
            result = {"version": 1, "operationId": intent.operationId, "sequence": sequence,
                      "revision": _state(db)["revision"]}
            db.execute("INSERT INTO home_upcoming_receipts VALUES(?,?,?,?)",
                       (intent.operationId, digest, json.dumps(result), now))
            db.commit()
            return result

    @app.post(PREFIX + "/wishlist")
    async def post_wishlist(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await common.bounded_body(request, MAX_INTENT_BYTES, "upcomingIntentTooLarge",
                                         "찜 요청이 너무 큽니다.")
        try:
            intent = Intent.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_intent()
        return await run_in_threadpool(file_intent, intent)

    @app.get(PREFIX + "/wishlist/intents")
    def intents(after: int = Query(default=0, ge=0, le=MAX_CURSOR), limit: int = Query(default=100, ge=1, le=200),
                authorization: str | None = Header(default=None),
                if_none_match: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            state = _state(db)
            last, pruned = state["intent_sequence"], state["pruned_through"]
            if after > last:
                db.rollback()
                fail(409, "upcomingCursorRejected", "찜 요청 동기화 위치를 확인해 주세요.")
            if after < pruned:
                db.rollback()
                fail(409, "upcomingIntentsExpired", "오래된 찜 요청이 정리되었습니다.", lastSequence=last)
            rows = db.execute("SELECT * FROM home_upcoming_intents WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            db.rollback()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "after": after, "lastSequence": last, "acknowledgedThrough": state["acknowledged_through"],
            "prunedThrough": pruned, "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
            "items": [_intent(row) for row in rows]}, if_none_match)

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()

    return startup
