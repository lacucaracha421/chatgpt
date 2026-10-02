"""Legacy Asset writes and upload presigning.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import sqlite3
import uuid
from types import ModuleType

from botocore.exceptions import ClientError
from fastapi import HTTPException, Header
from pydantic import BaseModel, Field

import library_thumbnails as thumbs
import asset_authority
import authority


api: ModuleType


class AssetCreate(BaseModel):
    id: str | None = None
    kind: str = Field(default="image")
    object_key: str
    thumbnail_key: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None


def list_assets(
    authorization: str | None = Header(default=None),
    limit: int = 50,
):
    api.require_auth(authorization)

    limit = max(1, min(limit, 200))

    with api.get_db() as db:
        rows = db.execute(
            """
            SELECT *
            FROM visible_assets
            WHERE committed = 1
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    # Preserve the pre-v1 raw-list wire shape; adding a revision here would switch
    # installed clients from ID-only cache keys before their adoption rollout.
    internal = {"thumbnail_sha256", "thumbnail_revision", "thumbnail_write_epoch", "thumbnail_verified"}
    return {"items": [{key: row[key] for key in row.keys() if key not in internal} for row in rows]}


def create_asset(
    asset: AssetCreate,
    authorization: str | None = Header(default=None),
):
    api.require_upload_client(authorization)

    asset_id = asset.id or str(uuid.uuid4())
    ts = api.now_iso()

    try:
        with api.get_db() as db:
            # Serialize the ownership check with activation, commit and the upsert.
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()
            thumbnail_key = asset.thumbnail_key
            if existing is not None and thumbs.is_immutable(existing["thumbnail_key"]):
                thumbnail_key = existing["thumbnail_key"]
            if thumbnail_key and thumbnail_key.startswith(thumbs.PREFIX) and (
                    existing is None or thumbnail_key != existing["thumbnail_key"]):
                thumbs.fail(409, "thumbnailVerifiedUploadRequired")
            thumbs.remember_key(db, thumbnail_key)
            active = authority.active_domain(db, asset_authority.DOMAIN)
            if (existing is not None and existing["committed"] == 1
                    and active is not None and asset_authority.authority_owns_lifecycle(
                        db, active["libraryId"], asset_id)):
                fields = ("kind", "object_key", "thumbnail_key", "content_type", "size_bytes", "sha256")
                if any(existing[field] != (thumbnail_key if field == "thumbnail_key" else getattr(asset, field)) for field in fields):
                    raise HTTPException(status_code=409, detail={"code": "legacyWriterFenced"})
                # An identical retry must not change timestamps or the authority feed.
                return {"ok": True, "id": asset_id, "object_key": asset.object_key}
            db.execute(
                """
                INSERT INTO assets (
                    id,
                    kind,
                    object_key,
                    thumbnail_key,
                    content_type,
                    size_bytes,
                    sha256,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    object_key = excluded.object_key,
                    thumbnail_key = excluded.thumbnail_key,
                    content_type = excluded.content_type,
                    size_bytes = excluded.size_bytes,
                    sha256 = excluded.sha256,
                    updated_at = excluded.updated_at
                """,
                (
                    asset_id,
                    asset.kind,
                    asset.object_key,
                    thumbnail_key,
                    asset.content_type,
                    asset.size_bytes,
                    asset.sha256,
                    ts,
                    ts,
                ),
            )
            if existing is not None and thumbnail_key != existing["thumbnail_key"]:
                db.execute("UPDATE assets SET thumbnail_metadata_key=NULL,thumbnail_size_bytes=NULL, "
                           "thumbnail_content_type=NULL,thumbnail_sha256=NULL,thumbnail_revision=NULL, "
                           "thumbnail_verified=0,thumbnail_write_epoch=thumbnail_write_epoch+1 WHERE id=?", (asset_id,))
            db.commit()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    return {
        "ok": True,
        "id": asset_id,
        "object_key": asset.object_key,
    }


class PresignRequest(BaseModel):
    object_key: str
    content_type: str = "application/octet-stream"


def is_replication_object_key(object_key: str) -> bool:
    parts = object_key.split("/")
    if len(parts) != 3 or parts[0] != "library":
        return False
    asset_id, variant = parts[1:]
    if variant not in ("original", "thumbnail"):
        return False
    try:
        return str(uuid.UUID(asset_id)) == asset_id
    except ValueError:
        return False


def create_upload_presign(
    request: PresignRequest,
    authorization: str | None = Header(default=None),
):
    api.require_upload_client(authorization)

    allowed_prefixes = (
        "images/",
        "thumbnails/",
        "videos/",
        "work-artwork/",
        "backups/",
    )

    if request.object_key.startswith("library/"):
        if not api.is_replication_object_key(request.object_key):
            raise HTTPException(status_code=400, detail="Invalid replication object key")
    elif not request.object_key.startswith(allowed_prefixes):
        raise HTTPException(status_code=400, detail="Invalid object key prefix")

    if ".." in request.object_key or request.object_key.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid object key")

    if (thumbs.block_legacy_uploads() and request.object_key.startswith("library/")
            and request.object_key.endswith("/thumbnail")):
        thumbs.fail(409, "thumbnailUpgradeRequired")

    with api.get_db() as db:
        committed = db.execute(
            "SELECT 1 FROM assets WHERE object_key=? AND committed=1",
            (request.object_key,),
        ).fetchone() is not None
    # Cover the replication key and the legacy image/video upload paths. A stored
    # original is protected even when its key predates those naming conventions.
    original = committed or request.object_key.startswith(("images/", "videos/")) or (
        request.object_key.startswith("library/") and request.object_key.endswith("/original")
    )
    if original:
        api.require_publisher(authorization)
        if committed:
            try:
                api._s3.head_object(Bucket=api.R2_BUCKET, Key=request.object_key)
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey", "NotFound"):
                    raise HTTPException(status_code=503, detail="Original storage check failed") from exc
            else:
                raise HTTPException(status_code=409, detail="Committed original already exists")
    # Uncommitted objects may be uploaded again after a failed commit. A retry
    # after a successful commit gets already_committed from replication/prepare.
    from r2 import presign_put

    expires_in = 600
    upload_url = presign_put(
        request.object_key,
        request.content_type,
        expires_in,
    )

    return {
        "method": "PUT",
        "object_key": request.object_key,
        "upload_url": upload_url,
        "expires_in": expires_in,
        "required_headers": {
            "Content-Type": request.content_type,
        },
    }


def register(app, services):
    global api
    api = services
    app.get("/v1/assets")(list_assets)
    app.post("/v1/assets")(create_asset)
    app.post("/v1/uploads/presign")(create_upload_presign)
