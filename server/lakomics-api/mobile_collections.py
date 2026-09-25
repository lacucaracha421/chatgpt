"""PC-owned Collection read replica. Artwork remains outside the Asset Library."""
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from botocore.exceptions import ClientError
from app_lifecycle import lifecycle
from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

import authority
import collection_authority
import collection_personal_edits as personal_edits
import collection_releases
import head_cache

MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024
MAX_ARTWORK_BYTES = 16 * 1024 * 1024
MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
ID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
Digest = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
ImageMime = Literal["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp", "image/heic", "image/heif"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ArtworkUpload(StrictModel):
    sha256: Digest
    sizeBytes: int = Field(gt=0, le=MAX_ARTWORK_BYTES)
    contentType: ImageMime


class ArtworkBlob(ArtworkUpload):
    objectKey: str = Field(max_length=100)


class ArtworkCheck(StrictModel):
    items: list[ArtworkUpload] = Field(max_length=256)


class Artwork(StrictModel):
    id: ID
    kind: str = Field(min_length=1, max_length=40)
    selected: bool = False
    thumbnail: ArtworkBlob | None = None
    original: ArtworkBlob | None = None


class Volume(StrictModel):
    id: ID
    volumeNumber: int
    editionIndex: int = Field(ge=0, le=255)
    displayLabel: str = Field(max_length=512)
    coverArtworkId: ID | None = None
    localReleaseDate: str | None = Field(default=None, max_length=100)
    isbn13: str | None = Field(default=None, max_length=100)
    releaseStatus: str | None = Field(default=None, max_length=100)


class Episode(StrictModel):
    id: int
    episodeNumber: int = Field(ge=0)
    name: str = Field(max_length=2000)
    airDate: str | None = Field(default=None, max_length=100)
    runtimeMinutes: int | None = None


class Season(StrictModel):
    id: int
    seasonNumber: int = Field(ge=0)
    name: str = Field(max_length=2000)
    airDate: str | None = Field(default=None, max_length=100)
    posterArtworkId: ID | None = None
    episodes: list[Episode] = Field(default_factory=list, max_length=5000)


class Series(StrictModel):
    status: str | None = Field(default=None, max_length=200)
    cast: list[str] = Field(default_factory=list, max_length=200)
    seasons: list[Season] = Field(default_factory=list, max_length=200)


class FilmCast(StrictModel):
    name: str = Field(max_length=2000)
    character: str = Field(default="", max_length=2000)


class FilmRelease(StrictModel):
    country: str = Field(max_length=20)
    releaseType: int = Field(ge=1, le=6)
    date: str = Field(max_length=100)
    certification: str = Field(default="", max_length=100)


class RelatedFilm(StrictModel):
    movieId: int
    title: str = Field(max_length=2000)
    releaseDate: str | None = Field(default=None, max_length=100)


class RelatedFilms(StrictModel):
    collectionName: str = Field(max_length=2000)
    parts: list[RelatedFilm] = Field(default_factory=list, max_length=200)


class Film(StrictModel):
    cast: list[FilmCast] = Field(default_factory=list, max_length=200)
    releases: list[FilmRelease] = Field(default_factory=list, max_length=500)
    related: RelatedFilms | None = None


class ReleaseWatch(StrictModel):
    """Manga release-watch state (collection_personal_edits ``releaseWatch``)."""
    enabled: bool
    # False when the Collection has no Aladin/Kakao binding: the PC cannot enable it.
    available: bool


class OwnedVolumes(StrictModel):
    """One tracked edition's owned-volume count (collection_personal_edits ``ownedVolumes``)."""
    editionIndex: int = Field(ge=0, le=3)
    count: int = Field(ge=0, le=2000)


VolumeNumber = Annotated[StrictInt, Field(ge=1, le=999)]
EditionIndex = Annotated[StrictInt, Field(ge=0, le=3)]
CheckedAt = Annotated[str, Field(min_length=1, max_length=100)]


def strictly_ascending(volumes):
    numbers = [volume.volumeNumber for volume in volumes]
    if any(later <= earlier for earlier, later in zip(numbers, numbers[1:])):
        raise ValueError("volumes must be unique and ascending by volumeNumber")
    return volumes


class KakaoScheduleVolume(StrictModel):
    volumeNumber: VolumeNumber
    date: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")] | None
    status: Literal["upcoming", "released"] | None

    @field_validator("date")
    @classmethod
    def calendar_date(cls, value):
        if value is not None:
            datetime.strptime(value, "%Y-%m-%d")
        return value


class KakaoSchedule(StrictModel):
    # The owned-volume edition these Korean (Kakao) volumes correspond to.
    editionIndex: EditionIndex
    checkedAt: CheckedAt | None
    volumes: list[KakaoScheduleVolume] = Field(max_length=999)

    @field_validator("volumes")
    @classmethod
    def ascending(cls, volumes):
        return strictly_ascending(volumes)


class MangaDexScheduleVolume(StrictModel):
    volumeNumber: VolumeNumber
    editionIndex: EditionIndex | None


class MangaDexSchedule(StrictModel):
    checkedAt: CheckedAt | None
    latestVolume: VolumeNumber | None
    # One entry per MangaDex (volume, edition) slot: a volume can repeat for another edition.
    volumes: list[MangaDexScheduleVolume] = Field(max_length=999)

    @field_validator("volumes")
    @classmethod
    def ascending(cls, volumes):
        numbers = [volume.volumeNumber for volume in volumes]
        if numbers != sorted(numbers) or len({(v.volumeNumber, v.editionIndex) for v in volumes}) != len(volumes):
            raise ValueError("volumes must be ascending by volumeNumber with unique editions")
        return volumes


class ReleaseSchedule(StrictModel):
    """Per-manga release schedule from an upgraded PC (personalEditVersion 2): the
    Korean edition's Kakao volumes with dates/status as the PC release watch computes
    them, and the Japanese volumes MangaDex lists. null = no binding for that provider."""
    kakao: KakaoSchedule | None
    mangadex: MangaDexSchedule | None


class Collection(StrictModel):
    id: ID
    name: str = Field(min_length=1, max_length=2000)
    type: Literal["game", "manga", "movie"]
    description: str | None = Field(default=None, max_length=10000)
    coverAssetId: ID | None = None
    selectedWorkArtworkId: ID | None = None
    selectedHeroArtworkId: ID | None = None
    selectedBackdropArtworkId: ID | None = None
    assetCount: int = Field(default=0, ge=0)
    unreadReleaseCount: int = Field(default=0, ge=0)
    year: int | None = None
    originalTitle: str | None = Field(default=None, max_length=2000)
    runtimeMinutes: int | None = None
    author: str | None = Field(default=None, max_length=2000)
    director: str | None = Field(default=None, max_length=2000)
    developer: str | None = Field(default=None, max_length=2000)
    publisher: str | None = Field(default=None, max_length=2000)
    platforms: str | None = Field(default=None, max_length=6000)
    productionCompany: str | None = Field(default=None, max_length=2000)
    releaseDate: str | None = Field(default=None, max_length=100)
    externalScore: int | None = None
    myScore: float | None = None
    genres: str | None = Field(default=None, max_length=6000)
    overview: str | None = Field(default=None, max_length=20000)
    showcase: bool = False
    showcaseOrder: int | None = None
    seasonDateRange: list[str] | None = Field(default=None, min_length=2, max_length=2)
    createdAt: str = Field(max_length=100)
    updatedAt: str = Field(max_length=100)
    series: Series | None = None
    film: Film | None = None
    volumes: list[Volume] = Field(default_factory=list, max_length=5000)
    artworks: list[Artwork] = Field(default_factory=list, max_length=10000)
    # Manga tracking state from an upgraded PC (personalEditVersion 2). Absent/null in
    # legacy snapshots and never stored as null, so legacy payloads stay unchanged.
    releaseWatch: ReleaseWatch | None = None
    ownedVolumes: list[OwnedVolumes] | None = Field(default=None, max_length=4)
    releaseSchedule: ReleaseSchedule | None = None


class Replica(StrictModel):
    version: Literal[1]
    baseRevision: Digest | None
    collections: list[Collection] = Field(max_length=10000)
    # Personal-edit handshake from an upgraded PC (see collection_personal_edits).
    personalEditVersion: Literal[1, 2] | None = None
    libraryId: personal_edits.LIBRARY | None = None
    personalEditCursor: int | None = Field(default=None, ge=0, le=personal_edits.MAX_CURSOR)


class TicketRequest(StrictModel):
    variant: Literal["thumbnail", "original"] = "thumbnail"


def artwork_key(digest: str) -> str:
    return "work-artwork/mobile/" + digest


def encode(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def stored(item: Collection) -> dict:
    """The stored payload; optional tracking keys are omitted rather than stored as null."""
    payload = item.model_dump()
    for key in ("releaseWatch", "ownedVolumes", "releaseSchedule"):
        if payload[key] is None:
            del payload[key]
    if "ownedVolumes" in payload:
        payload["ownedVolumes"].sort(key=lambda entry: entry["editionIndex"])
    return payload


def public_item(item: dict, detail: bool = False) -> dict:
    result = {key: value for key, value in item.items() if key not in ("volumes", "artworks", "series", "film")}
    visible = None if detail else {item.get("selectedWorkArtworkId"), item.get("selectedHeroArtworkId"), item.get("selectedBackdropArtworkId")}
    result["artworkVersions"] = {art["id"]: {variant: (art.get(variant) or {}).get("sha256") for variant in ("thumbnail", "original")} for art in item["artworks"] if visible is None or art["id"] in visible}
    if detail:
        result["series"] = item.get("series")
        # Replicas published before Film details simply have no film block.
        result["film"] = item.get("film")
        result["volumes"] = item["volumes"]
        result["artworks"] = [
            {"id": art["id"], "kind": art["kind"], "selected": art["selected"],
             "thumbnailAvailable": art["thumbnail"] is not None, "originalAvailable": art["original"] is not None,
             "thumbnailDigest": (art.get("thumbnail") or {}).get("sha256"),
             "originalDigest": (art.get("original") or {}).get("sha256")}
            for art in item["artworks"]
        ]
    return result


def register_collections(app, get_db, require_auth, storage, bucket, presign_get, presign_put,
                         require_client=None, require_publisher=None):
    reader = require_client or require_auth
    publisher = require_publisher or require_auth

    def startup_collections():
        with get_db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS mobile_collection_replica (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision TEXT NOT NULL,
                    published_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mobile_collections (
                    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
                    showcase INTEGER NOT NULL, showcase_order INTEGER, payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_mobile_collections_type_name
                    ON mobile_collections(type, name COLLATE NOCASE, id);
                CREATE TABLE IF NOT EXISTS mobile_collection_artwork (
                    sha256 TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, content_type TEXT NOT NULL
                );
            """)
            db.executescript(personal_edits.DDL)
            personal_edits.migrate(db)
            collection_releases.startup_db(db)
            # Collections authority tables only; the domain stays inactive until an
            # explicit publisher activation.
            collection_authority.startup_db(db)
            db.commit()

    lifecycle(app).on_startup(startup_collections)

    def legacy_state(db):
        row = db.execute("SELECT revision,published_at FROM mobile_collection_replica WHERE singleton=1").fetchone()
        return (row["revision"], row["published_at"]) if row else (None, None)

    def served(db):
        """The Collections authority read state, or None while the PC replica is served."""
        return collection_authority.served_state(db)

    def state(db, active=None):
        """``(revision, publishedAt)`` of what ``/v1/collections`` serves."""
        if active is not None:
            return active["revision"], active["publishedAt"]
        return legacy_state(db)

    def table(active):
        # Same columns and payload shape, so one query path serves both sources.
        return "collection_authority_projection" if active is not None else "mobile_collections"

    def finalize(db, active, payload):
        if active is not None:
            collection_authority.finalize_item(db, active["libraryId"], payload)
        return payload

    # Registered before `/v1/collections/{collection_id}`, which would otherwise match it.
    personal_edits.register(app, get_db, reader, publisher, lambda db: legacy_state(db)[0])
    collection_releases.register(app, get_db, reader, publisher)
    collection_authority.register(app, get_db, reader, publisher)

    def head(blob: ArtworkUpload, *, ticket=False):
        key, storage_bucket = artwork_key(blob.sha256), bucket()
        try:
            client = storage()
            metadata = head_cache.ticket_heads.head(
                client, storage_bucket, key,
                identity=(blob.sizeBytes, blob.contentType) if ticket else None)
        except ClientError as exc:
            if str(exc.response.get("Error", {}).get("Code", "")) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise HTTPException(502, "Artwork storage unavailable") from exc
        except Exception as exc:
            raise HTTPException(502, "Artwork storage unavailable") from exc
        if metadata.get("ContentLength") != blob.sizeBytes or metadata.get("ContentType") != blob.contentType:
            head_cache.ticket_heads.invalidate(client, storage_bucket, key)
            raise HTTPException(409, "Stored artwork does not match its manifest")
        return True

    @app.post("/v1/collections/artworks/prepare")
    def prepare_artwork(body: ArtworkUpload, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        key = artwork_key(body.sha256)
        exists = head(body)
        with get_db() as db:
            if exists:
                db.execute("INSERT INTO mobile_collection_artwork VALUES (?,?,?) ON CONFLICT(sha256) DO UPDATE SET size_bytes=excluded.size_bytes,content_type=excluded.content_type", (body.sha256, body.sizeBytes, body.contentType))
            else:
                db.execute("DELETE FROM mobile_collection_artwork WHERE sha256=?", (body.sha256,))
            db.commit()
        return {"objectKey": key, "uploadUrl": None if exists else presign_put(key, body.contentType, 600),
                "requiredHeaders": {"Content-Type": body.contentType}}

    @app.post("/v1/collections/artworks/check")
    def check_artworks(body: ArtworkCheck, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        # These are receipts of exact storage HEAD checks, also trusted by commit_snapshot.
        # Unknown files still go through prepare/upload/confirmation before publication.
        manifests = {item.sha256: item for item in body.items}
        if len(manifests) != len(body.items):
            raise HTTPException(422, "Duplicate artwork checks")
        with get_db() as db:
            rows = db.execute("SELECT sha256,size_bytes,content_type FROM mobile_collection_artwork WHERE sha256 IN (" + ",".join("?" for _ in manifests) + ")", list(manifests)).fetchall() if manifests else []
        confirmed = {row["sha256"]: (row["size_bytes"], row["content_type"]) for row in rows}
        return {"missing": [item.sha256 for item in body.items if confirmed.get(item.sha256) != (item.sizeBytes, item.contentType)]}

    def roles(authorization):
        """Which snapshot forms this caller may send, decided before reading the body.

        The shared token keeps the legacy snapshot form (the currently deployed PC);
        the handshake reads the edit log, so it needs the publisher role. A caller
        that is neither, such as a client-role token, is refused at once."""
        try:
            require_auth(authorization)
        except HTTPException:
            publisher(authorization)  # 401 for every other caller
            return {"handshake"}
        return {"legacy", "handshake"} if publisher is require_auth else {"legacy"}

    @app.put("/v1/collections/replica")
    async def publish_replica(request: Request, authorization: str | None = Header(default=None)):
        allowed = roles(authorization)
        chunks = bytearray()
        async for chunk in request.stream():
            if len(chunks) + len(chunk) > MAX_SNAPSHOT_BYTES:
                raise HTTPException(413, "Collection snapshot too large")
            chunks.extend(chunk)
        return await run_in_threadpool(commit_snapshot, chunks, allowed)

    def fenced(db):
        # ADR-0037 decision 7: once the Collections epoch is active, the legacy PC
        # snapshot can never overwrite authority state. A no-op while inactive.
        authority.fence_legacy_write(db, collection_authority.DOMAIN)

    def commit_snapshot(chunks, allowed):
        with get_db() as db:
            fenced(db)
        try:
            snapshot = Replica.model_validate_json(chunks)
        except ValidationError as exc:
            # Never echo a submitted local path, provider config or arbitrary payload.
            raise HTTPException(422, "Invalid collection snapshot") from exc
        if ("legacy" if snapshot.personalEditVersion is None else "handshake") not in allowed:
            raise HTTPException(401, "Unauthorized")
        personal_edits.validate_handshake(snapshot)
        ids = [item.id for item in snapshot.collections]
        if len(set(ids)) != len(ids):
            raise HTTPException(422, "Duplicate collection IDs")
        with get_db() as db:
            if legacy_state(db)[0] != snapshot.baseRevision:
                raise HTTPException(409, "Collection snapshot changed; refresh before publishing")
        blobs = {}
        for item in snapshot.collections:
            artworks = {art.id for art in item.artworks}
            if len(artworks) != len(item.artworks) or len({v.id for v in item.volumes}) != len(item.volumes):
                raise HTTPException(422, "Duplicate artwork or volume IDs")
            references = [item.selectedWorkArtworkId, item.selectedHeroArtworkId, item.selectedBackdropArtworkId]
            references.extend(volume.coverArtworkId for volume in item.volumes)
            if item.series:
                references.extend(season.posterArtworkId for season in item.series.seasons)
            if any(reference is not None and reference not in artworks for reference in references):
                raise HTTPException(422, "Artwork reference is outside its collection")
            for art in item.artworks:
                for variant, blob in (("thumbnail", art.thumbnail), ("original", art.original)):
                    if blob is None:
                        continue
                    if blob.objectKey != artwork_key(blob.sha256) or (variant == "thumbnail" and blob.sizeBytes > MAX_THUMBNAIL_BYTES):
                        raise HTTPException(422, "Invalid artwork manifest")
                    if blob.sha256 in blobs and blobs[blob.sha256] != blob:
                        raise HTTPException(422, "Conflicting artwork manifests")
                    blobs[blob.sha256] = blob
            if item.ownedVolumes is not None and len({o.editionIndex for o in item.ownedVolumes}) != len(item.ownedVolumes):
                raise HTTPException(422, "Duplicate owned-volume editions")
            if len(encode(public_item(item.model_dump(), True)).encode()) > 3 * 1024 * 1024:
                raise HTTPException(413, "Collection detail too large")
        # Preparation confirms each completed upload. Reuse those immutable hash
        # receipts so metadata publication does not repeat thousands of S3 calls.
        with get_db() as db:
            confirmed = {row["sha256"]: (row["size_bytes"], row["content_type"]) for row in db.execute("SELECT * FROM mobile_collection_artwork")}
        unconfirmed = [blob for blob in blobs.values() if confirmed.get(blob.sha256) != (blob.sizeBytes, blob.contentType)]
        # Bounded fallback for a client that did not confirm its uploads first.
        if len(unconfirmed) > 32:
            raise HTTPException(409, "Confirm uploaded artwork before publishing")
        for blob in unconfirmed:
            if not head(blob):
                raise HTTPException(409, "Upload all artwork before publishing")
        items = [stored(item) for item in sorted(snapshot.collections, key=lambda item: item.id)]
        published = datetime.now(timezone.utc).isoformat()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            fenced(db)
            if legacy_state(db)[0] != snapshot.baseRevision:
                raise HTTPException(409, "Collection snapshot changed; refresh before publishing")
            personal_edits.publication_guard(db, snapshot)
            identity = items
            if snapshot.personalEditVersion is not None:
                # Pending edits re-applied below change what is served, so they are
                # part of the revision too.
                identity = {"collections": items, "libraryId": snapshot.libraryId,
                            "personalEditCursor": snapshot.personalEditCursor,
                            "lastPersonalEditSequence": personal_edits.last_sequence(db)}
            revision = hashlib.sha256(encode(identity).encode()).hexdigest()
            db.execute("DELETE FROM mobile_collections")
            db.executemany("INSERT INTO mobile_collection_artwork VALUES (?,?,?) ON CONFLICT(sha256) DO UPDATE SET size_bytes=excluded.size_bytes,content_type=excluded.content_type", [(blob.sha256, blob.sizeBytes, blob.contentType) for blob in unconfirmed])
            db.executemany("INSERT INTO mobile_collections VALUES (?,?,?,?,?,?)", [
                (item["id"], item["type"], item["name"], int(item["showcase"]), item["showcaseOrder"], encode(item)) for item in items
            ])
            personal_edits.acknowledge_publication(db, snapshot)
            db.execute("INSERT INTO mobile_collection_replica VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,published_at=excluded.published_at", (revision, published))
            db.commit()
        return {"ok": True, "revision": revision, "publishedAt": published, "collections": len(items), "artworks": len(blobs)}

    @app.get("/v1/collections")
    def list_collections(type: Literal["game", "manga", "movie"] | None = None,
                         q: str = Query(default="", max_length=200), showcase: bool = False,
                         sort: Literal["name", "recent", "media_date"] = "name",
                         direction: Literal["asc", "desc"] = "asc",
                         rating: str = Query(default="all", pattern=r"^(all|unrated|[0-4](?:\.0|\.5)?|5(?:\.0)?)$"),
                         limit: int = Query(default=48, ge=1, le=48), cursor: str | None = Query(default=None, max_length=3000),
                         authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            # A consistent read transaction binds metadata rows to this revision.
            db.execute("BEGIN")
            active = served(db)
            source = table(active)
            revision, published = state(db, active)
            offset = 0
            # Showcase is a manual exhibition; library filters never alter it.
            rating_value = float(rating) if rating not in ("all", "unrated") else rating
            scope = [revision, type, q, showcase, None if showcase else sort,
                     None if showcase else direction, "all" if showcase else rating_value]
            if cursor:
                try:
                    decoded = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                    if decoded["scope"] != scope:
                        raise HTTPException(409, "Collection list changed; restart pagination")
                    offset = decoded["offset"]
                    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 10000:
                        raise ValueError()
                except HTTPException:
                    raise
                except Exception as exc:
                    raise HTTPException(422, "Invalid collection cursor") from exc
            clauses, parameters = [], []
            if type:
                clauses.append("type=?"); parameters.append(type)
            if showcase:
                clauses.append("showcase=1")
            if q:
                clauses.append("name LIKE ? ESCAPE '\\'")
                parameters.append("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
            if not showcase and rating != "all":
                if rating == "unrated":
                    clauses.append("json_extract(payload,'$.myScore') IS NULL")
                else:
                    clauses.append("json_extract(payload,'$.myScore')=?")
                    parameters.append(rating_value)
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            if showcase:
                order = "showcase_order IS NULL, showcase_order, name COLLATE NOCASE,id"
            elif sort == "media_date":
                date = "CASE WHEN NULLIF(json_extract(payload,'$.releaseDate'),'') IS NOT NULL THEN CAST(REPLACE(json_extract(payload,'$.releaseDate'),'-','') AS INTEGER) ELSE json_extract(payload,'$.year')*10000 END"
                order = f"({date}) IS NULL, ({date}) {direction}, name COLLATE NOCASE,id"
            elif sort == "recent":
                order = f"json_extract(payload,'$.createdAt') {direction}, name COLLATE NOCASE,id"
            else:
                order = f"name COLLATE NOCASE {direction}, id"
            total = db.execute(f"SELECT COUNT(*) FROM {source}" + where, parameters).fetchone()[0]
            rows = db.execute(f"SELECT payload FROM {source}" + where + " ORDER BY " + order + " LIMIT ? OFFSET ?", [*parameters, limit + 1, offset]).fetchall()
            payloads = [finalize(db, active, json.loads(row["payload"])) for row in rows[:limit]]
        next_cursor = base64.urlsafe_b64encode(encode({"scope": scope, "offset": offset + limit}).encode()).decode() if len(rows) > limit else None
        return {"ready": revision is not None, "revision": revision, "publishedAt": published, "filterVersion": 1, "totalCount": total,
                "items": [public_item(payload) for payload in payloads], "nextCursor": next_cursor}

    @app.get("/v1/collections/status")
    def publication_status(authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            active = served(db)
            revision, published = state(db, active)
            advertisement = personal_edits.advertisement(db)
            if active is not None:
                # Installed APKs keep sending personal edits; the server translates them
                # into `updateWork`, so the capability no longer depends on the PC.
                advertisement = {**advertisement, "capabilities": {"collectionPersonalEdit": True,
                                                                     "collectionTrackingEdit": False},
                                 "libraryId": active["libraryId"]}
        return {"revision": revision, "publishedAt": published, **advertisement}

    @app.get("/v1/collections/{collection_id}")
    def get_collection(collection_id: ID, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            active = served(db)
            revision, _ = state(db, active)
            row = db.execute(f"SELECT payload FROM {table(active)} WHERE id=?", (collection_id,)).fetchone()
            payload = None if row is None else finalize(db, active, json.loads(row["payload"]))
        if payload is None:
            raise HTTPException(404, "Collection is not published")
        return {"revision": revision, "item": public_item(payload, True)}

    @app.post("/v1/collections/{collection_id}/artworks/{artwork_id}/media-ticket")
    def artwork_ticket(collection_id: ID, artwork_id: ID, body: TicketRequest, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            row = db.execute(f"SELECT payload FROM {table(served(db))} WHERE id=?", (collection_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Collection is not published")
        art = next((art for art in json.loads(row["payload"])["artworks"] if art["id"] == artwork_id), None)
        if art is None or art[body.variant] is None:
            raise HTTPException(404, "Artwork variant unavailable")
        blob = ArtworkBlob.model_validate(art[body.variant])
        if not head(blob, ticket=True):
            with get_db() as db:
                db.execute("DELETE FROM mobile_collection_artwork WHERE sha256=?", [blob.sha256])
                db.commit()
            raise HTTPException(404, "Artwork unavailable")
        return {"url": presign_get(blob.objectKey, 300), "expires_in": 300, "sha256": blob.sha256,
                "content_type": blob.contentType, "size_bytes": blob.sizeBytes}

    return startup_collections
