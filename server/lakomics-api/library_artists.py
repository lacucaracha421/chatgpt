"""작가 (Artist hub, ARTIST-001): the PC's artist list, read-only for the tablet.

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

No client writes. Errors are ``{"detail": {"code", "message"}}`` (401 from the guards is
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
   listed artist, asset ids unique. Replaces the snapshot; idempotent (an identical body does
   not move the revision). Reply ``{"version": 1, "revision", "changed": bool, "artists": n,
   "assignments": n}``. Errors: ``422 invalidArtistUpload``, ``413 artistUploadTooLarge``.
2. ``GET /v1/library/artists`` (client): ``{"version": 1, "revision", "publishedAt"|null,
   "generatedAt"|null, "settings"|null, "unknown"|null, "artists": [Artist], "assignments":
   [...]}`` in the PC's order, ETag / 304. Empty lists before the first publication.
3. ``GET /v1/library/artists/{id}`` (client; the id URL-encoded as one path segment, ``/`` as
   ``%2F``): ``{"version": 1, "revision", "artist": Artist, "assignedAssetCount": n}``, ETag;
   ``404 artistNotFound``.

Signal: ``signals.artists`` = ``revision``.
"""
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import Header, Request
from pydantic import Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import conditional
import home_publications as common
from home_publications import Strict, Timestamp, fail, text

PREFIX = "/v1/library/artists"
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_ARTISTS = 20000
MAX_ASSIGNMENTS = 50000
AssetId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
Count = Annotated[int, Field(ge=0, le=100_000_000)]

DDL = """
CREATE TABLE IF NOT EXISTS library_artist_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 published_at TEXT, digest TEXT, document TEXT);
INSERT OR IGNORE INTO library_artist_state VALUES(1,0,NULL,NULL,NULL);
CREATE TABLE IF NOT EXISTS library_artists(
 artist_id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL, assigned INTEGER NOT NULL);
"""


def startup_db(db):
    db.executescript(DDL)


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


def _state(db):
    return db.execute("SELECT * FROM library_artist_state WHERE singleton=1").fetchone()


def status_signal(db):
    """``signals.artists``: the snapshot revision the tablet compares."""
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
        body = upload.model_dump(exclude={"version"})
        digest = hashlib.sha256(encode(body).encode()).hexdigest()
        assigned = {}
        for row in upload.assignments:
            assigned[row.artistId] = assigned.get(row.artistId, 0) + 1
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            state = _state(db)
            changed = digest != state["digest"]
            revision = state["revision"]
            if changed:
                revision += 1
                published = datetime.now(timezone.utc).isoformat()
                document = {"version": 1, "revision": revision, "publishedAt": published, **body}
                db.execute("UPDATE library_artist_state SET revision=?,published_at=?,digest=?,document=? "
                           "WHERE singleton=1", (revision, published, digest, conditional.encode(document).decode()))
                db.execute("DELETE FROM library_artists")
                db.executemany("INSERT INTO library_artists VALUES(?,?,?,?)",
                               [(artist["id"], index, encode(artist), assigned.get(artist["id"], 0))
                                for index, artist in enumerate(body["artists"])])
            db.commit()
        return {"version": 1, "revision": revision, "changed": changed, "artists": len(ids),
                "assignments": len(assets)}

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
            state = _state(db)
        if state["document"] is None:
            return conditional.json_response({
                "version": 1, "revision": state["revision"], "publishedAt": None, "generatedAt": None,
                "settings": None, "unknown": None, "artists": [], "assignments": []}, if_none_match)
        body = state["document"].encode("utf-8")
        return conditional.encoded_response(body, conditional.etag_for(body), if_none_match)

    @app.get(PREFIX + "/{artist_id:path}")
    def get_artist(artist_id: str, authorization: str | None = Header(default=None),
                   if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            revision = _state(db)["revision"]
            row = db.execute("SELECT payload,assigned FROM library_artists WHERE artist_id=?", (artist_id,)).fetchone()
            db.rollback()
        if row is None:
            fail(404, "artistNotFound", "작가를 찾을 수 없습니다.")
        return conditional.json_response({"version": 1, "revision": revision, "artist": json.loads(row["payload"]),
                                          "assignedAssetCount": row["assigned"]}, if_none_match)

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()

    return startup
