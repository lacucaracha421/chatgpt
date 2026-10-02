"""Prepare and commit the PC-published Asset replica.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import sqlite3
from types import ModuleType
from typing import Literal

from fastapi import HTTPException, Header
from pydantic import BaseModel, Field

import asset_authority
import authority
import classification_authority


api: ModuleType


# --- CLOUD-006 full-library replication (PC -> VPS/R2) -----------------------
# PC Lakomics 라이브러리가 원본이다. VPS/R2 사본은 읽기 전용 복제본이며 PC에서
# 언제든 다시 만들 수 있어야 한다. prepare → 업로드(기존 presign 재사용) →
# commit의 멱등 3단계로 자산 한 건을 복제한다. committed=1이 되기 전까지
# 모바일 라이브러리 조회에 노출하지 않는다. captures 흐름과 무관하다.

ALLOWED_KINDS = ("image", "gif", "video")


# Match the publisher's u32 dimensions and SQLite's signed i64 duration storage.
MAX_ASSET_DIMENSION = 4_294_967_295


MAX_ASSET_DURATION_MS = 9_223_372_036_854_775_807


class ReplicationVariant(BaseModel):
    object_key: str
    content_type: str
    size_bytes: int = Field(ge=0)
    sha256: str | None = None


class ReplicationPrepare(BaseModel):
    asset_id: str = Field(min_length=1, max_length=64)
    kind: Literal["image", "gif", "video"]
    content_type: str | None = None
    size_bytes: int | None = Field(default=None, ge=0)
    sha256: str | None = None
    collected_at: str | None = None


class ReplicationCommit(BaseModel):
    expected_revision: int | None = Field(default=None, ge=0)
    commit_id: str | None = Field(default=None, min_length=1, max_length=64)
    asset_id: str = Field(min_length=1, max_length=64)
    kind: Literal["image", "gif", "video"]
    original: ReplicationVariant
    thumbnail: ReplicationVariant
    content_type: str
    collected_at: str | None = None
    source_published_at: str | None = None
    source_url: str | None = None
    creator_name: str | None = None
    creator_handle: str | None = None
    import_source: str | None = None
    classification_ids: list[str] = Field(default_factory=list, max_length=200)
    # Optional display metadata; absent leaves the stored value untouched. `strict=True` refuses
    # a float or bool that would otherwise be coerced into a fabricated dimension.
    width: int | None = Field(default=None, ge=1, le=MAX_ASSET_DIMENSION, strict=True)
    height: int | None = Field(default=None, ge=1, le=MAX_ASSET_DIMENSION, strict=True)
    duration_ms: int | None = Field(default=None, ge=0, le=MAX_ASSET_DURATION_MS, strict=True)


def replication_variant_keys(asset_id: str) -> dict[str, str]:
    """variant별 결정적 R2 object key. 재시도·재실행에도 동일한 키를 쓴다."""
    return {
        "original": f"library/{asset_id}/original",
        "thumbnail": f"library/{asset_id}/thumbnail",
    }


def _replication_row(db: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()


def replication_prepare(
    request: ReplicationPrepare,
    authorization: str | None = Header(default=None),
):
    api.require_upload_client(authorization)
    if request.kind not in api.ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail="Invalid media kind")
    ts = api.now_iso()
    keys = api.replication_variant_keys(request.asset_id)
    with api.get_db() as db:
        # 멱등: 같은 asset_id로 다시 prepare하면 상태를 보존하고 같은 키를
        # 돌려준다. 이미 커밋된 자산이면 재업로드 없이 멱등 통과한다.
        existing = api._replication_row(db, request.asset_id)
        if existing is None:
            db.execute(
                """
                INSERT INTO assets (
                    id, kind, object_key, content_type, size_bytes, sha256,
                    collected_at, committed, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (
                    request.asset_id,
                    request.kind,
                    keys["original"],
                    request.content_type,
                    request.size_bytes,
                    request.sha256,
                    request.collected_at,
                    ts,
                    ts,
                ),
            )
            db.commit()
            existing = api._replication_row(db, request.asset_id)
        elif existing["committed"] == 1:
            return {
                "asset_id": request.asset_id,
                "already_committed": True,
                "metadata_revision": existing["metadata_revision"],
                "object_keys": keys,
            }
        if existing["object_key"] != keys["original"]:
            raise HTTPException(
                status_code=409,
                detail="Asset id already bound to different object keys",
            )
    return {
        "asset_id": request.asset_id,
        "already_committed": False,
        "metadata_revision": existing["metadata_revision"],
        "object_keys": keys,
    }


def replication_commit(
    request: ReplicationCommit,
    authorization: str | None = Header(default=None),
):
    api.require_upload_client(authorization)
    if request.kind not in api.ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail="Invalid media kind")
    ts = api.now_iso()
    keys = api.replication_variant_keys(request.asset_id)
    if (
        request.original.object_key != keys["original"]
        or request.thumbnail.object_key != keys["thumbnail"]
    ):
        raise HTTPException(
            status_code=400,
            detail="Variant object keys do not match deterministic keys",
        )
    if request.thumbnail.size_bytes <= 0:
        raise HTTPException(status_code=400, detail="Thumbnail variant required")

    with api.get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = api._replication_row(db, request.asset_id)
        if row is None:
            db.execute("ROLLBACK")
            raise HTTPException(
                status_code=404,
                detail="Asset was not prepared; call /v1/replication/prepare first",
            )
        # Asset lifecycle fence (ADR-0038). Once the domain is active the server owns
        # lifecycle state, so a stale PC replication commit must not resurrect a trashed
        # or tombstoned Asset by re-asserting its existence. Rejected as a whole rather
        # than partially applied, so the client learns to reconcile instead of believing
        # the Asset is live again.
        #
        # The library comes from the active domain row rather than the request: this route
        # predates authority and carries no library id, and the product is single-library,
        # so the domain row is the authoritative answer. Deliberately placed after the
        # prepare check so an unprepared Asset keeps its existing 404, and a no-op while
        # the domain is inactive — which keeps the legacy path byte-for-byte unchanged.
        active = authority.active_domain(db, asset_authority.DOMAIN)
        if active is not None:
            lifecycle = asset_authority.authority_lifecycle(
                db, active["libraryId"], request.asset_id)
            if lifecycle is not None and lifecycle != asset_authority.NORMAL:
                db.execute("ROLLBACK")
                raise HTTPException(status_code=409, detail={
                    "code": "assetLifecycleOwned",
                    "message": "서버가 자산 상태를 관리합니다. 최신 상태로 다시 시도해 주세요.",
                    "domain": asset_authority.DOMAIN,
                    "assetId": request.asset_id,
                    "lifecycle": lifecycle,
                })
        if request.expected_revision is None:
            if row["metadata_revision"] > 0:
                raise HTTPException(status_code=409, detail="Revision-aware client required")
        else:
            if not request.commit_id:
                raise HTTPException(status_code=400, detail="commit_id required")
            if row["metadata_commit_id"] == request.commit_id:
                return {"ok": True, "asset_id": request.asset_id, "committed": True,
                        "committed_at": row["committed_at"], "object_keys": keys}
            if row["metadata_revision"] != request.expected_revision:
                raise HTTPException(status_code=409, detail="Stale metadata revision; prepare again")
        db.execute(
            """
            INSERT INTO assets (
                id, kind, object_key, thumbnail_key, content_type,
                size_bytes, sha256, collected_at, source_published_at,
                source_url, creator_name, creator_handle, import_source,
                width, height, duration_ms,
                committed, committed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                object_key = excluded.object_key,
                thumbnail_key = excluded.thumbnail_key,
                content_type = excluded.content_type,
                size_bytes = excluded.size_bytes,
                sha256 = excluded.sha256,
                collected_at = COALESCE(excluded.collected_at, assets.collected_at),
                source_published_at = COALESCE(excluded.source_published_at, assets.source_published_at),
                source_url = COALESCE(excluded.source_url, assets.source_url),
                creator_name = COALESCE(excluded.creator_name, assets.creator_name),
                creator_handle = COALESCE(excluded.creator_handle, assets.creator_handle),
                import_source = COALESCE(excluded.import_source, assets.import_source),
                -- Same rule as the other optional projections: omitting a value keeps what is
                -- already known, so a legacy client cannot erase it and NULL can be filled in.
                width = COALESCE(excluded.width, assets.width),
                height = COALESCE(excluded.height, assets.height),
                duration_ms = COALESCE(excluded.duration_ms, assets.duration_ms),
                committed = 1,
                committed_at = excluded.committed_at,
                updated_at = excluded.updated_at
            """,
            (
                request.asset_id,
                request.kind,
                request.original.object_key,
                request.thumbnail.object_key,
                request.content_type,
                request.original.size_bytes,
                request.original.sha256,
                request.collected_at,
                request.source_published_at,
                request.source_url,
                request.creator_name,
                request.creator_handle,
                request.import_source,
                request.width,
                request.height,
                request.duration_ms,
                ts,
                ts,
                ts,
            ),
        )
        # Asset replication remains valid after Classification cutover, but its embedded
        # legacy relationship projection no longer owns Classification state. Preserve
        # the old writes byte-for-byte while inactive; once authority exists, leave
        # `asset_classifications` untouched so a stale replication commit cannot revert
        # an accepted authority command.
        if authority.active_domain(db, classification_authority.DOMAIN) is None:
            db.execute(
                "DELETE FROM asset_classifications WHERE asset_id = ?",
                (request.asset_id,),
            )
            for classification_id in sorted(set(request.classification_ids)):
                db.execute(
                    """
                    INSERT INTO asset_classifications
                        (asset_id, classification_id, added_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(asset_id, classification_id) DO NOTHING
                    """,
                    (request.asset_id, classification_id, ts),
                )
        if active is not None:
            asset_authority.register_replication(db, active["libraryId"], request.asset_id, ts)
        if request.expected_revision is not None:
            db.execute("UPDATE assets SET metadata_revision=metadata_revision+1, metadata_commit_id=? WHERE id=?",
                       (request.commit_id, request.asset_id))
        db.commit()
    return {
        "ok": True,
        "asset_id": request.asset_id,
        "committed": True,
        "committed_at": ts,
        "object_keys": keys,
    }


def register(app, services):
    global api
    api = services
    app.post("/v1/replication/prepare")(replication_prepare)
    app.post("/v1/replication/commit")(replication_commit)
