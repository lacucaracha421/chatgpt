"""HTTP adapter for the verified library thumbnail contract."""
import json
import time
from typing import Literal

from fastapi import Header
from pydantic import BaseModel, ConfigDict, Field

import library_thumbnails as thumbs

api = None
_storage = None


def storage():
    global _storage
    if _storage is None:
        from r2 import thumbnail_storage_client
        _storage = thumbnail_storage_client()
    return _storage


class ThumbnailPrepare(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(min_length=1, max_length=64)
    operation_id: str = Field(min_length=1, max_length=128)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(ge=1, le=thumbs.MAX_BYTES, strict=True)
    content_type: Literal["image/webp"]
    expected_thumbnail_write_epoch: int | None = Field(default=None, ge=0, strict=True)


class ThumbnailCommit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(min_length=1, max_length=64)
    upload_id: str = Field(min_length=1, max_length=64)


def prepare_thumbnail(request: ThumbnailPrepare, authorization: str | None = Header(default=None)):
    api.require_upload_client(authorization)
    with api.get_db() as db:
        session = thumbs.prepare(db, request.model_dump())
    result = {"asset_id": session["asset_id"], "upload_id": session["upload_id"],
              "upload_object_key": session["temp_key"], "thumbnail_key": session["final_key"],
              "thumbnail_write_epoch": session["epoch"], "expires_at": session["expires_at"],
              "upload_expires_at": session["upload_expires_at"], "upload_url": None,
              "required_headers": {"Content-Type": session["content_type"], "Content-Length": str(session["size_bytes"])},
              "committed": session["state"] == "committed"}
    if result["committed"]:
        result["result"] = json.loads(session["result"])
    else:
        remaining = int(session["upload_expires_at"] - time.time())
        if remaining <= 0:
            thumbs.fail(410, "thumbnailUploadUrlExpired")
        from r2 import presign_put
        result["upload_url"] = presign_put(session["temp_key"], session["content_type"],
                                          expires_in=remaining, content_length=session["size_bytes"])
    return result


def commit_thumbnail(request: ThumbnailCommit, authorization: str | None = Header(default=None)):
    api.require_upload_client(authorization)
    context = "standalone"
    verified = thumbs.verify_upload(api.get_db, storage(), api.R2_BUCKET,
                                    request.asset_id, request.upload_id, context, standalone=True)
    with api.get_db() as db:
        with db:
            db.execute("BEGIN IMMEDIATE")
            result = thumbs.apply_upload(db, verified, context)
    thumbs.cleanup_temp(storage(), api.R2_BUCKET, verified.session)
    return result


def register(app, services):
    global api
    api = services
    app.post("/v1/replication/thumbnails/prepare")(prepare_thumbnail)
    app.post("/v1/replication/thumbnails/commit")(commit_thumbnail)
