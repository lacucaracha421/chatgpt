"""Artist hub: PC snapshots with ordered tablet edit intents.

Artist management is PC-authoritative (`_tools/app/src-tauri/src/library/artists.rs`,
migration 0100). The PC publishes one full snapshot of every artist it lists - explicit
artists (``artist:<id>``: renamed, pinned, hidden, merged or holding assignments) and implicit
single-key artists (id = the bare creator key) - plus the asset assignments. The tablet
lists, tiers and searches it locally and resolves an asset's artist exactly like the PC's
``asset_artist_scope`` view:

1. an ``assignments`` row for the asset id wins;
2. else the asset's creator key ``creator_handle ?? creator_url`` -> the artist whose ``keys``
   contain it (a merge puts several keys on one artist);
3. else the creator key itself (an implicit artist the snapshot may not list, e.g. hidden by
   the PC's own limits) - or no artist when the asset has no creator.

Clients can rename, hide/unhide and pin/unpin through POST /intents. Publishers read
GET /intents and acknowledge applied sequences with the snapshot's intentCursor.
Unacknowledged intents overlay both client reads, including across stale publications.
Errors are ``{"detail": {"code", "message"}}`` (401 from the guards is
``{"detail": "Unauthorized"}``; a client credential on the publisher route is 401 too).

Artist
------
``{"id", "label", "displayName"|null, "sourceName"|null, "keys": [creatorKey, ... <= 500],
"assetCount", "recentCount", "firstSavedAt"|null, "lastSavedAt"|null, "lastOpenedAt"|null,
"pinned", "hidden", "main", "coverAssetIds": [assetId, ... <= 8]}`` - ``ArtistSummary`` of
the PC (``label`` is what to show; ``main`` = 주요 작가 by the tier rule). ``id``/keys <= 1024
single-line characters; names <= 500; asset ids ``[A-Za-z0-9_-]{1,128}``. Ids and keys are
unique across the snapshot.

1. ``PUT /v1/library/artists`` (publisher), <= 16 MiB: ``{"version": 1, "generatedAt",
   "settings": {"mainMinCount", "recentMinCount", "recentDays"}, "unknown": {"none": n,
   "source": n}, "artists": [Artist, ... <= 20000], "assignments": [{"assetId", "artistId",
   "source": "manual"|"source_url"}, ... <= 50000]}``. ``unknown`` = assets without creator
   (``none``: no source either; ``source``: only a source URL). Every ``artistId`` must be a
   listed artist, asset ids unique. Optional ``intentCursor`` acknowledges applied intents;
   omitted after an acknowledgement, decreasing or future cursors are rejected with 422
   ``artistIntentCursorRejected``. Replaces the snapshot; idempotent (an identical body does
   not move the revision). Reply ``{"version": 1, "revision", "changed": bool, "artists": n,
   "assignments": n}``. Errors: ``422 invalidArtistUpload``, ``413 artistUploadTooLarge``.
2. ``GET /v1/library/artists`` (client): ``{"version": 1, "revision", "publishedAt"|null,
   "generatedAt"|null, "settings"|null, "unknown"|null, "artists": [Artist], "assignments":
   [...], "pending": [{"operationId", "sequence", "artistId", "action", "displayName"}],
   "acknowledgedThrough"}`` in the PC's order, ETag / 304. Pending edits overlay artist
   fields. Empty lists before the first publication.
3. ``GET /v1/library/artists/{id}`` (client; the id URL-encoded as one path segment, ``/`` as
   ``%2F``): ``{"version": 1, "revision", "artist": Artist, "assignedAssetCount": n}``, ETag;
   ``404 artistNotFound``.

4. ``POST /v1/library/artists/intents`` (client): ``{"version": 1, "operationId": UUID,
   "artistId", "action": "rename"|"hide"|"unhide"|"pin"|"unpin", "displayName": str|null}``.
   Rename names are trimmed, single line, <=120 characters; blank/null clears the custom
   name. Other actions only accept an absent/null name. Reply: ``{"version": 1,
   "operationId", "sequence", "revision"}``. Receipts replay unchanged requests; changed
   requests return 409 ``artistIntentConflict``. Unknown targets return 409 ``artistUnknown``;
   500 pending requests return 409 ``artistIntentLimit``.
5. ``GET /v1/library/artists/intents?after=0&limit=100`` (publisher): ordered ``items``
   with ``lastSequence``, ``acknowledgedThrough``, ``prunedThrough``, ``nextCursor`` and
   ``hasMore``, as in Home upcoming. Limit is 1-200. Acknowledged intents are retained for
   30 days/up to 5000 rows; the newest 2000 receipts are retained.

Signal: ``signals.artists`` = served ``revision`` (including overlay changes).
``publisherLogs.artistIntents`` reports ``last``, ``acknowledgedThrough`` and ``prunedThrough``.
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
from home_publications import OperationId, Strict, Timestamp, fail, text

PREFIX = "/v1/library/artists"
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_ARTISTS = 20000
MAX_ASSIGNMENTS = 50000
MAX_CURSOR = 9_007_199_254_740_991
MAX_INTENT_BYTES = 16 * 1024
MAX_PENDING = 500
INTENT_DAYS = 30
INTENT_LOG_MAX = 5000
RECEIPTS_RETAINED = 2000
AssetId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
Count = Annotated[int, Field(ge=0, le=100_000_000)]

DDL = """
CREATE TABLE IF NOT EXISTS library_artist_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 published_at TEXT, digest TEXT, document TEXT);
INSERT OR IGNORE INTO library_artist_state VALUES(1,0,NULL,NULL,NULL);
CREATE TABLE IF NOT EXISTS library_artists(
 artist_id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL, assigned INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS library_artist_keys(
 creator_key TEXT PRIMARY KEY, artist_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS library_artist_keys_by_artist ON library_artist_keys(artist_id,creator_key);
CREATE TABLE IF NOT EXISTS library_artist_assignments(
 asset_id TEXT PRIMARY KEY, artist_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS library_artist_assignments_by_artist ON library_artist_assignments(artist_id,asset_id);
CREATE TABLE IF NOT EXISTS library_artist_intent_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 intent_sequence INTEGER NOT NULL, acknowledged_through INTEGER NOT NULL, pruned_through INTEGER NOT NULL);
INSERT OR IGNORE INTO library_artist_intent_state VALUES(1,0,0,0);
CREATE TABLE IF NOT EXISTS library_artist_intents(
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, artist_id TEXT NOT NULL,
 action TEXT NOT NULL, display_name TEXT, artist_payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_artist_receipts(
 operation_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
"""


def startup_db(db):
    db.executescript(DDL)
    # Materialize the already published snapshot for rolling server-first upgrades.
    db.execute("BEGIN IMMEDIATE")
    try:
        row = _state(db)
        if row["document"] is not None:
            search_projection(db, json.loads(row["document"]))
        db.commit()
    except BaseException:
        db.rollback()
        raise


def search_projection(db, body):
    db.execute("DELETE FROM library_artist_keys")
    db.execute("DELETE FROM library_artist_assignments")
    db.executemany("INSERT INTO library_artist_keys VALUES(?,?)",
                   [(key, artist["id"]) for artist in body["artists"] for key in artist["keys"]])
    db.executemany("INSERT INTO library_artist_assignments VALUES(?,?)",
                   [(row["assetId"], row["artistId"]) for row in body.get("assignments", [])])


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Settings(Strict):
    mainMinCount: int = Field(ge=1, le=100000)
    recentMinCount: int = Field(ge=1, le=100000)
    recentDays: int = Field(ge=1, le=3650)


class Unknown(Strict):
    none: Count
    source: Count


class Artist(Strict):
    id: text(1024)
    label: text(500)
    displayName: text(500) | None = None
    sourceName: text(500) | None = None
    keys: list[text(1024)] = Field(max_length=500)
    assetCount: Count
    recentCount: Count
    firstSavedAt: Timestamp | None = None
    lastSavedAt: Timestamp | None = None
    lastOpenedAt: Timestamp | None = None
    pinned: bool
    hidden: bool
    main: bool
    coverAssetIds: list[AssetId] = Field(default_factory=list, max_length=8)


class Assignment(Strict):
    assetId: AssetId
    artistId: text(1024)
    source: Literal["manual", "source_url"]


class Upload(Strict):
    version: Literal[1]
    generatedAt: Timestamp
    settings: Settings
    unknown: Unknown
    artists: list[Artist] = Field(max_length=MAX_ARTISTS)
    assignments: list[Assignment] = Field(default_factory=list, max_length=MAX_ASSIGNMENTS)
    intentCursor: int | None = Field(default=None, ge=0, le=MAX_CURSOR)


class Intent(Strict):
    version: Literal[1]
    operationId: OperationId
    artistId: text(1024)
    action: Literal["rename", "hide", "unhide", "pin", "unpin"]
    displayName: str | None = None

    @model_validator(mode="after")
    def clean(self):
        if self.action != "rename" and self.displayName is not None:
            raise ValueError("displayName is only valid for rename")
        if self.displayName is not None:
            name = self.displayName.strip() or None
            if name is not None and (len(name) > 120 or any(char in name for char in "\r\n\x00")):
                raise ValueError("name must be single line and at most 120 characters")
        return self


def _intent_state(db):
    return db.execute("SELECT * FROM library_artist_intent_state WHERE singleton=1").fetchone()


def status_head(db):
    state = _intent_state(db)
    return {"last": state["intent_sequence"], "acknowledgedThrough": state["acknowledged_through"],
            "prunedThrough": state["pruned_through"]}


def _intent(row):
    return {"operationId": row["operation_id"], "sequence": row["sequence"],
            "artistId": row["artist_id"], "action": row["action"], "displayName": row["display_name"]}


def _retain(db, now):
    state = _intent_state(db)
    cutoff = (now - timedelta(days=INTENT_DAYS)).isoformat()
    pruned = db.execute("""SELECT MAX(sequence) FROM library_artist_intents WHERE sequence<=?
        AND (created_at<? OR sequence<=?)""",
        (state["acknowledged_through"], cutoff, state["intent_sequence"] - INTENT_LOG_MAX)).fetchone()[0]
    if pruned is not None:
        db.execute("DELETE FROM library_artist_intents WHERE sequence<=?", (pruned,))
        db.execute("UPDATE library_artist_intent_state SET pruned_through=MAX(pruned_through,?)", (pruned,))
    db.execute("""DELETE FROM library_artist_receipts WHERE operation_id NOT IN
        (SELECT operation_id FROM library_artist_receipts ORDER BY created_at DESC, rowid DESC LIMIT ?)""",
        (RECEIPTS_RETAINED,))


def served_document(db):
    state = _state(db)
    head = _intent_state(db)
    document = json.loads(state["document"]) if state["document"] else {
        "version": 1, "publishedAt": None, "generatedAt": None,
        "settings": None, "unknown": None, "artists": [], "assignments": []}
    document["revision"] = state["revision"]
    document["acknowledgedThrough"] = head["acknowledged_through"]
    pending = db.execute("SELECT * FROM library_artist_intents WHERE sequence>? ORDER BY sequence",
                         (head["acknowledged_through"],)).fetchall()
    by_id = {artist["id"]: artist for artist in document["artists"]}
    by_key = {key: artist for artist in document["artists"] for key in artist["keys"]}
    fallback_labels = {artist["id"]: artist["label"] for artist in document["artists"]}
    for row in pending:
        original = json.loads(row["artist_payload"])
        artist = by_id.get(row["artist_id"])
        if artist is None:
            artist = next((by_key[key] for key in original["keys"] if key in by_key), None)
        if artist is None:
            # Keep a pending target readable even if an older PC omits it.
            artist = original
            document["artists"].append(artist)
            by_id[artist["id"]] = artist
            by_key.update((key, artist) for key in artist["keys"])
            fallback_labels[artist["id"]] = artist["label"]
        if row["action"] == "rename":
            artist["displayName"] = row["display_name"]
            artist["label"] = row["display_name"] or artist["sourceName"] or fallback_labels[artist["id"]]
        elif row["action"] in ("hide", "unhide"):
            artist["hidden"] = row["action"] == "hide"
        else:
            artist["pinned"] = row["action"] == "pin"
    document["pending"] = [_intent(row) for row in pending]
    return document


def _state(db):
    return db.execute("SELECT * FROM library_artist_state WHERE singleton=1").fetchone()


def status_signal(db):
    """``signals.artists``: the served revision, including pending edits."""
    return _state(db)["revision"]


def register(app, get_db, require_client, require_publisher):
    """Install the routes; returns the startup hook (creates empty tables only)."""

    def invalid():
        fail(422, "invalidArtistUpload", "작가 목록을 확인할 수 없습니다.")

    def publish(upload):
        ids = [artist.id for artist in upload.artists]
        keys = [key for artist in upload.artists for key in artist.keys]
        assets = [row.assetId for row in upload.assignments]
        if len(set(ids)) != len(ids) or len(set(keys)) != len(keys) or len(set(assets)) != len(assets):
            invalid()
        known = set(ids)
        if any(row.artistId not in known for row in upload.assignments):
            invalid()
        body = upload.model_dump(exclude={"version", "intentCursor"})
        digest = hashlib.sha256(encode(body).encode()).hexdigest()
        assigned = {}
        for row in upload.assignments:
            assigned[row.artistId] = assigned.get(row.artistId, 0) + 1
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            state = _state(db)
            head = _intent_state(db)
            cursor = upload.intentCursor
            if ((cursor is None and head["acknowledged_through"] > 0)
                    or (cursor is not None and not head["acknowledged_through"] <= cursor <= head["intent_sequence"])):
                fail(422, "artistIntentCursorRejected", "작가 요청 동기화 위치를 확인해 주세요.")
            acknowledged = cursor or 0
            changed = digest != state["digest"]
            revision = state["revision"]
            if changed or acknowledged != head["acknowledged_through"]:
                revision += 1
                db.execute("UPDATE library_artist_state SET revision=? WHERE singleton=1", (revision,))
            db.execute("UPDATE library_artist_intent_state SET acknowledged_through=? WHERE singleton=1", (acknowledged,))
            if changed:
                published = datetime.now(timezone.utc).isoformat()
                document = {"version": 1, "revision": revision, "publishedAt": published, **body}
                db.execute("UPDATE library_artist_state SET revision=?,published_at=?,digest=?,document=? "
                           "WHERE singleton=1", (revision, published, digest, conditional.encode(document).decode()))
                search_projection(db, body)
                db.execute("DELETE FROM library_artists")
                db.executemany("INSERT INTO library_artists VALUES(?,?,?,?)",
                               [(artist["id"], index, encode(artist), assigned.get(artist["id"], 0))
                                for index, artist in enumerate(body["artists"])])
            _retain(db, datetime.now(timezone.utc))
            db.commit()
        return {"version": 1, "revision": revision, "changed": changed, "artists": len(ids),
                "assignments": len(assets), "acknowledgedThrough": acknowledged}

    @app.put(PREFIX)
    async def put_artists(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        raw = await common.bounded_body(request, MAX_BODY_BYTES, "artistUploadTooLarge", "작가 목록 게시 요청이 너무 큽니다.")
        try:
            upload = Upload.model_validate_json(raw)
        except (ValidationError, ValueError):
            invalid()
        return await run_in_threadpool(publish, upload)

    @app.get(PREFIX)
    def get_artists(authorization: str | None = Header(default=None),
                    if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            document = served_document(db)
            attach_cover_ratings(db, document.get("artists", []))
        return conditional.json_response(document, if_none_match)

    def file_intent(intent):
        common.uuid_or_fail(intent.operationId, "invalidArtistIntent", "요청 식별자가 올바르지 않습니다.")
        digest = hashlib.sha256(encode(intent.model_dump()).encode()).hexdigest()
        display_name = (intent.displayName.strip() or None) if intent.displayName is not None else None
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute("SELECT * FROM library_artist_receipts WHERE operation_id=?",
                                 (intent.operationId,)).fetchone()
            if receipt:
                if receipt["payload_digest"] != digest:
                    fail(409, "artistIntentConflict", "다른 내용으로 작가 요청을 재사용할 수 없습니다.")
                return json.loads(receipt["result_json"])
            head = _intent_state(db)
            row = db.execute("SELECT payload FROM library_artists WHERE artist_id=?", (intent.artistId,)).fetchone()
            if row is None:
                row = db.execute("SELECT artist_payload AS payload FROM library_artist_intents "
                                 "WHERE artist_id=? AND sequence>? ORDER BY sequence DESC LIMIT 1",
                                 (intent.artistId, head["acknowledged_through"])).fetchone()
            if row is None:
                fail(409, "artistUnknown", "작가 목록에 없는 작가입니다.")
            if head["intent_sequence"] - head["acknowledged_through"] >= MAX_PENDING:
                fail(409, "artistIntentLimit", "PC가 아직 처리하지 않은 작가 요청이 너무 많습니다.")
            now = datetime.now(timezone.utc)
            sequence = head["intent_sequence"] + 1
            db.execute("INSERT INTO library_artist_intents VALUES(?,?,?,?,?,?,?)",
                       (sequence, intent.operationId, intent.artistId, intent.action, display_name,
                        row["payload"], now.isoformat()))
            db.execute("UPDATE library_artist_intent_state SET intent_sequence=?", (sequence,))
            db.execute("UPDATE library_artist_state SET revision=revision+1 WHERE singleton=1")
            result = {"version": 1, "operationId": intent.operationId, "sequence": sequence,
                      "revision": _state(db)["revision"]}
            db.execute("INSERT INTO library_artist_receipts VALUES(?,?,?,?)",
                       (intent.operationId, digest, encode(result), now.isoformat()))
            _retain(db, now)
            db.commit()
            return result

    @app.post(PREFIX + "/intents")
    async def post_intent(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = await common.bounded_body(request, MAX_INTENT_BYTES, "artistIntentTooLarge", "작가 요청이 너무 큽니다.")
        try:
            intent = Intent.model_validate_json(raw)
        except (ValidationError, ValueError):
            fail(422, "invalidArtistIntent", "작가 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(file_intent, intent)

    # Must precede the catch-all artist id route: this is a publisher-only read.
    @app.get(PREFIX + "/intents")
    def get_intents(after: int = Query(default=0, ge=0, le=MAX_CURSOR),
                    limit: int = Query(default=100, ge=1, le=200),
                    authorization: str | None = Header(default=None),
                    if_none_match: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            head = _intent_state(db)
            last, pruned = head["intent_sequence"], head["pruned_through"]
            if after > last:
                fail(409, "artistCursorRejected", "작가 요청 동기화 위치를 확인해 주세요.")
            if after < pruned:
                fail(409, "artistIntentsExpired", "오래된 작가 요청이 정리되었습니다.", lastSequence=last)
            rows = db.execute("SELECT * FROM library_artist_intents WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({"version": 1, "after": after, "lastSequence": last,
            "acknowledgedThrough": head["acknowledged_through"], "prunedThrough": pruned,
            "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
            "items": [{**_intent(row), "createdAt": row["created_at"]} for row in rows]}, if_none_match)

    @app.get(PREFIX + "/{artist_id:path}")
    def get_artist(artist_id: str, authorization: str | None = Header(default=None),
                   if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            document = served_document(db)
            revision = document["revision"]
            artist = next((row for row in document["artists"] if row["id"] == artist_id), None)
            assigned = sum(row["artistId"] == artist_id for row in document["assignments"])
            if artist: attach_cover_ratings(db, [artist])
            db.rollback()
        if artist is None:
            fail(404, "artistNotFound", "작가를 찾을 수 없습니다.")
        return conditional.json_response({"version": 1, "revision": revision, "artist": artist,
                                          "assignedAssetCount": assigned}, if_none_match)

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()

    return startup


def attach_cover_ratings(db, artists):
    """Read current cover ratings in one indexed batch, outside publication identity."""
    import asset_visibility
    import library_search
    asset_visibility.install(db)
    ids = sorted({id for artist in artists for id in artist.get("coverAssetIds", [])})
    ratings = {}
    if db.execute("SELECT 1 FROM sqlite_temp_master WHERE name='visible_assets'").fetchone():
        ratings = {row["id"]: library_search.content_rating(row) for row in db.execute(
            "SELECT id,content_rating FROM visible_assets WHERE id IN (SELECT value FROM json_each(?))", [json.dumps(ids)])}
    for artist in artists:
        artist["coverContentRatings"] = {id: ratings.get(id) for id in artist.get("coverAssetIds", [])}
