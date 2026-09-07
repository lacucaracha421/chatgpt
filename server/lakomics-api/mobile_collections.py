"""PC-owned Collection read replica. Artwork remains outside the Asset Library."""
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from botocore.exceptions import ClientError
from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

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
    volumes: list[Volume] = Field(default_factory=list, max_length=5000)
    artworks: list[Artwork] = Field(default_factory=list, max_length=10000)


class Replica(StrictModel):
    version: Literal[1]
    baseRevision: Digest | None
    collections: list[Collection] = Field(max_length=10000)


class TicketRequest(StrictModel):
    variant: Literal["thumbnail", "original"] = "thumbnail"


def artwork_key(digest: str) -> str:
    return "work-artwork/mobile/" + digest


def encode(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def public_item(item: dict, detail: bool = False) -> dict:
    result = {key: value for key, value in item.items() if key not in ("volumes", "artworks")}
    if detail:
        result["volumes"] = item["volumes"]
        result["artworks"] = [
            {"id": art["id"], "kind": art["kind"], "selected": art["selected"],
             "thumbnailAvailable": art["thumbnail"] is not None, "originalAvailable": art["original"] is not None}
            for art in item["artworks"]
        ]
    return result


def register_collections(app, get_db, require_auth, storage, bucket, presign_get, presign_put):
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
            db.commit()

    app.on_event("startup")(startup_collections)

    def state(db):
        row = db.execute("SELECT revision,published_at FROM mobile_collection_replica WHERE singleton=1").fetchone()
        return (row["revision"], row["published_at"]) if row else (None, None)

    def head(blob: ArtworkUpload):
        try:
            metadata = storage().head_object(Bucket=bucket(), Key=artwork_key(blob.sha256))
        except ClientError as exc:
            if str(exc.response.get("Error", {}).get("Code", "")) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise HTTPException(502, "Artwork storage unavailable") from exc
        except Exception as exc:
            raise HTTPException(502, "Artwork storage unavailable") from exc
        if metadata.get("ContentLength") != blob.sizeBytes or metadata.get("ContentType") != blob.contentType:
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

    @app.put("/v1/collections/replica")
    async def publish_replica(request: Request, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        chunks = bytearray()
        async for chunk in request.stream():
            if len(chunks) + len(chunk) > MAX_SNAPSHOT_BYTES:
                raise HTTPException(413, "Collection snapshot too large")
            chunks.extend(chunk)
        return await run_in_threadpool(commit_snapshot, chunks)

    def commit_snapshot(chunks):
        try:
            snapshot = Replica.model_validate_json(chunks)
        except ValidationError as exc:
            # Never echo a submitted local path, provider config or arbitrary payload.
            raise HTTPException(422, "Invalid collection snapshot") from exc
        ids = [item.id for item in snapshot.collections]
        if len(set(ids)) != len(ids):
            raise HTTPException(422, "Duplicate collection IDs")
        with get_db() as db:
            if state(db)[0] != snapshot.baseRevision:
                raise HTTPException(409, "Collection snapshot changed; refresh before publishing")
        blobs = {}
        for item in snapshot.collections:
            artworks = {art.id for art in item.artworks}
            if len(artworks) != len(item.artworks) or len({v.id for v in item.volumes}) != len(item.volumes):
                raise HTTPException(422, "Duplicate artwork or volume IDs")
            references = [item.selectedWorkArtworkId, item.selectedHeroArtworkId, item.selectedBackdropArtworkId]
            references.extend(volume.coverArtworkId for volume in item.volumes)
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
        items = [item.model_dump() for item in sorted(snapshot.collections, key=lambda item: item.id)]
        revision = hashlib.sha256(encode(items).encode()).hexdigest()
        published = datetime.now(timezone.utc).isoformat()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            if state(db)[0] != snapshot.baseRevision:
                raise HTTPException(409, "Collection snapshot changed; refresh before publishing")
            db.execute("DELETE FROM mobile_collections")
            db.executemany("INSERT INTO mobile_collection_artwork VALUES (?,?,?) ON CONFLICT(sha256) DO UPDATE SET size_bytes=excluded.size_bytes,content_type=excluded.content_type", [(blob.sha256, blob.sizeBytes, blob.contentType) for blob in unconfirmed])
            db.executemany("INSERT INTO mobile_collections VALUES (?,?,?,?,?,?)", [
                (item["id"], item["type"], item["name"], int(item["showcase"]), item["showcaseOrder"], encode(item)) for item in items
            ])
            db.execute("INSERT INTO mobile_collection_replica VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,published_at=excluded.published_at", (revision, published))
            db.commit()
        return {"ok": True, "revision": revision, "publishedAt": published, "collections": len(items), "artworks": len(blobs)}

    @app.get("/v1/collections")
    def list_collections(type: Literal["game", "manga", "movie"] | None = None,
                         q: str = Query(default="", max_length=200), showcase: bool = False,
                         limit: int = Query(default=48, ge=1, le=48), cursor: str | None = Query(default=None, max_length=3000),
                         authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            # A consistent read transaction binds metadata rows to this revision.
            db.execute("BEGIN")
            revision, published = state(db)
            offset = 0
            scope = [revision, type, q, showcase]
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
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            order = "showcase_order IS NULL, showcase_order, name COLLATE NOCASE,id" if showcase else "name COLLATE NOCASE,id"
            rows = db.execute("SELECT payload FROM mobile_collections" + where + " ORDER BY " + order + " LIMIT ? OFFSET ?", [*parameters, limit + 1, offset]).fetchall()
        next_cursor = base64.urlsafe_b64encode(encode({"scope": scope, "offset": offset + limit}).encode()).decode() if len(rows) > limit else None
        return {"ready": revision is not None, "revision": revision, "publishedAt": published,
                "items": [public_item(json.loads(row["payload"])) for row in rows[:limit]], "nextCursor": next_cursor}

    @app.get("/v1/collections/{collection_id}")
    def get_collection(collection_id: ID, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            revision, _ = state(db)
            row = db.execute("SELECT payload FROM mobile_collections WHERE id=?", (collection_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Collection is not published")
        return {"revision": revision, "item": public_item(json.loads(row["payload"]), True)}

    @app.post("/v1/collections/{collection_id}/artworks/{artwork_id}/media-ticket")
    def artwork_ticket(collection_id: ID, artwork_id: ID, body: TicketRequest, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            row = db.execute("SELECT payload FROM mobile_collections WHERE id=?", (collection_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Collection is not published")
        art = next((art for art in json.loads(row["payload"])["artworks"] if art["id"] == artwork_id), None)
        if art is None or art[body.variant] is None:
            raise HTTPException(404, "Artwork variant unavailable")
        blob = ArtworkBlob.model_validate(art[body.variant])
        if not head(blob):
            raise HTTPException(404, "Artwork unavailable")
        return {"url": presign_get(blob.objectKey, 300), "expires_in": 300,
                "content_type": blob.contentType, "size_bytes": blob.sizeBytes}

    return startup_collections
