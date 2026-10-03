"""Asset media tickets, thumbnail receipts and metadata backup downloads.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import asyncio
import logging
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from types import ModuleType
from typing import Literal

from botocore.exceptions import ClientError, ConnectionError, HTTPClientError
from fastapi import HTTPException, Header, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

import library_thumbnails
import asset_authority
import head_cache


api: ModuleType


METADATA_BACKUP_OBJECT_KEY = "backups/library-metadata.sqlite"


METADATA_BACKUP_TICKET_TTL_SECONDS = 600


def get_library_metadata_backup(authorization: str | None = Header(default=None)):
    api.require_auth(authorization)
    try:
        metadata = api._s3.head_object(Bucket=api.R2_BUCKET, Key=api.METADATA_BACKUP_OBJECT_KEY)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=404, detail="No library metadata backup published yet")
        raise HTTPException(status_code=502, detail="Metadata backup storage is unavailable")
    return {
        "download_url": api.presign_get(api.METADATA_BACKUP_OBJECT_KEY, api.METADATA_BACKUP_TICKET_TTL_SECONDS),
        "required_headers": {},
        "size_bytes": metadata.get("ContentLength"),
        "content_type": metadata.get("ContentType") or "application/vnd.sqlite3",
        "expires_in": api.METADATA_BACKUP_TICKET_TTL_SECONDS,
    }


MEDIA_TICKET_TTL_SECONDS = 300

# Reserve before submitting: the executor's internal queue must never accumulate
# one batch per caller. A timed-out running HEAD retains its slot until it exits.
MEDIA_TICKET_DEADLINE_SECONDS = 5.0
_HEAD_WORKERS = 8
_head_executor = ThreadPoolExecutor(max_workers=_HEAD_WORKERS, thread_name_prefix="ticket-head")
_head_slots = threading.BoundedSemaphore(_HEAD_WORKERS)
_TRANSPORT_ERRORS = (ConnectionError, HTTPClientError)


def _bounded_ticket_work(items, resolve, *, deadline, cancelled):
    """Return ordered results, with None for work unfinished by the deadline."""
    results = [None] * len(items)
    pending = {}
    next_index = 0
    stopped = threading.Event()

    def run(item):
        if stopped.is_set() or cancelled.is_set() or time.monotonic() >= deadline:
            return None
        value = resolve(item)
        return time.monotonic(), value

    def release_slot(_future):
        _head_slots.release()

    try:
        while (next_index < len(items) or pending) and not cancelled.is_set():
            if time.monotonic() >= deadline:
                break
            while next_index < len(items) and not cancelled.is_set() and time.monotonic() < deadline:
                if not _head_slots.acquire(blocking=False):
                    break
                try:
                    future = _head_executor.submit(run, items[next_index])
                except BaseException:
                    _head_slots.release()
                    raise
                future.add_done_callback(release_slot)
                pending[future] = next_index
                next_index += 1
            remaining = max(0, deadline - time.monotonic())
            if pending:
                done, _ = wait(pending, timeout=min(0.025, remaining), return_when=FIRST_COMPLETED)
                for future in done:
                    index = pending.pop(future)
                    completed = future.result()
                    if completed is not None and completed[0] <= deadline:
                        results[index] = completed[1]
            else:
                cancelled.wait(min(0.025, remaining))
        # Include completions that raced the deadline, but never late results.
        for future, index in pending.items():
            if future.done():
                completed = future.result()
                if completed is not None and completed[0] <= deadline:
                    results[index] = completed[1]
        return results
    finally:
        stopped.set()
        # Do not cancel queued futures: ThreadPoolExecutor retains cancelled queue
        # entries. Retain their permits until a worker drains them, bounding even
        # repeated disconnects while all eight workers are stuck in storage.


class MediaTicketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variant: Literal["thumbnail", "original"]


def _thumbnail_receipt(asset, object_key, *, fresh_head=False):
    fields = dict(asset)
    if (fields.get("committed") == 1 and not fresh_head
            and object_key == fields.get("thumbnail_metadata_key")
            and object_key.startswith("derived/")):
        return head_cache.immutable_metadata(
            object_key, fields.get("thumbnail_size_bytes"), fields.get("thumbnail_content_type"),
            verified=library_thumbnails.trusted_receipt(fields))
    return None


def _ticket_head(asset, variant, object_key, *, fresh_head=False, verify_digest=False,
                 thumbnail_metadata_fills=None):
    # Replication commit updates all of these fields, but presigned PUT can overwrite
    # a mutable key before that transaction (or without committing at all). Identity
    # alone is insufficient. Only digest-verifying clients may reuse original HEADs;
    # the ticket carries the committed digest, so even same-size replacement fails
    # closed. Legacy clients and rows without a digest retain a live HEAD.
    digest = asset["sha256"]
    verified_original = (variant == "original" and verify_digest
                         and isinstance(digest, str) and len(digest) == 64
                         and all(char in "0123456789abcdef" for char in digest))
    fields = dict(asset)
    if fields.get("committed") == 1 and not fresh_head:
        metadata = None
        if (variant == "thumbnail" and object_key.startswith("derived/")
                and object_key == fields.get("thumbnail_metadata_key")):
            metadata = _thumbnail_receipt(asset, object_key, fresh_head=fresh_head)
        elif verified_original and object_key == f"work-artwork/mobile/{digest}":
            # This is the existing byte-addressed original namespace. Neither
            # library/{id}/original nor inbox keys become immutable from a DB SHA.
            metadata = head_cache.immutable_metadata(
                object_key, asset["size_bytes"], asset["content_type"])
        if metadata is not None:
            return metadata
    identity = tuple(asset[field] for field in (
        "object_key", "sha256", "content_type", "size_bytes", "metadata_revision", "updated_at"))
    metadata = head_cache.ticket_heads.head(
        api._s3, api.R2_BUCKET, object_key, identity=identity,
        verified_original=verified_original, fresh=fresh_head)
    if (thumbnail_metadata_fills is not None and fields.get("committed") == 1
            and variant == "thumbnail" and object_key.startswith("derived/")):
        # Only successful server HEAD metadata (possibly in the HEAD cache),
        # validated with the same immutable-key rule as the cold-ticket shortcut.
        receipt = head_cache.immutable_metadata(
            object_key, metadata.get("ContentLength"), metadata.get("ContentType"))
        if receipt is not None:
            bound = (object_key, receipt["ContentLength"], receipt["ContentType"])
            existing = tuple(fields.get(field) for field in (
                "thumbnail_metadata_key", "thumbnail_size_bytes", "thumbnail_content_type"))
            if bound != existing:
                thumbnail_metadata_fills.append((*bound, asset["id"], object_key))
    return metadata


def _persist_thumbnail_metadata(fills):
    if not fills:
        return
    try:
        with api.get_db() as db:
            # One transaction after all HEADs finish; a replacement during HEAD
            # cannot receive the old key's receipt. This is optional ticket metadata.
            with db:
                db.executemany(
                    "UPDATE assets SET thumbnail_metadata_key=?, thumbnail_size_bytes=?, "
                    "thumbnail_content_type=? WHERE id=? AND committed=1 AND thumbnail_key=?",
                    fills)
    except Exception:
        logging.getLogger(api.__name__).warning("Could not persist thumbnail ticket metadata")


def _ticket_digest(asset, variant):
    # Omit the key rather than send null: installed Android builds read a JSON null
    # through optString() as the text "null" and then reject every download.
    digest = asset["sha256"] if variant == "original" else None
    return {"sha256": digest} if isinstance(digest, str) and digest else {}


def create_mobile_media_ticket(
    asset_id: str,
    request: MediaTicketRequest,
    authorization: str | None = Header(default=None),
    lifecycle: Literal["trash"] | None = Query(default=None),
    fresh_head: bool = Query(default=False),
    verify_digest: bool = Query(default=False),
):
    api.client_guard(api.get_db, api.API_TOKEN)(authorization)
    with api.get_db() as db:
        if lifecycle == "trash":
            # Trash scope (mobile Library Trash): only canonically trashed Assets,
            # never normal or tombstoned ones. Without the scope nothing changes.
            asset = asset_authority.trash_ticket_assets(db, [asset_id]).get(asset_id)
        else:
            asset = db.execute(
                "SELECT * FROM visible_assets WHERE id = ? AND committed = 1",
                (asset_id,),
            ).fetchone()
    if asset is None:
        raise HTTPException(status_code=404, detail="Committed asset not found")

    object_key = asset["object_key"] if request.variant == "original" else asset["thumbnail_key"]
    if not object_key:
        raise HTTPException(status_code=409, detail="Requested media variant is unavailable")

    def resolve(_):
        fills = []
        metadata = api._ticket_head(asset, request.variant, object_key, fresh_head=fresh_head,
                                    verify_digest=verify_digest, thumbnail_metadata_fills=fills)
        return metadata, fills

    try:
        resolved = _bounded_ticket_work(
            [None], resolve, deadline=time.monotonic() + MEDIA_TICKET_DEADLINE_SECONDS,
            cancelled=threading.Event())[0]
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=409, detail="Requested media variant is unavailable")
        raise HTTPException(status_code=502, detail="Media storage is unavailable")
    except _TRANSPORT_ERRORS:
        raise HTTPException(status_code=502, detail="Media storage is unavailable")
    if resolved is None:
        raise HTTPException(status_code=502, detail="Media storage is unavailable")

    metadata, thumbnail_metadata_fills = resolved
    api._persist_thumbnail_metadata(thumbnail_metadata_fills)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=api.MEDIA_TICKET_TTL_SECONDS)
    return {
        "url": api.presign_get(object_key, api.MEDIA_TICKET_TTL_SECONDS),
        "expires_at": expires_at.isoformat(),
        "expires_in": api.MEDIA_TICKET_TTL_SECONDS,
        "variant": request.variant,
        "content_type": metadata.get("ContentType") or asset["content_type"],
        "size_bytes": metadata.get("ContentLength"),
        **api._ticket_digest(asset, request.variant),
    }


MAX_MEDIA_TICKET_BATCH = 50


class MediaTicketBatchItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1, max_length=64)
    variant: Literal["thumbnail", "original"]


class MediaTicketBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[MediaTicketBatchItem] = Field(max_length=MAX_MEDIA_TICKET_BATCH)


def create_mobile_media_tickets(
    request: MediaTicketBatchRequest,
    authorization: str | None = Header(default=None),
    lifecycle: Literal["trash"] | None = Query(default=None),
    fresh_head: bool = Query(default=False),
    verify_digest: bool = Query(default=False),
    *,
    _cancelled=None,
    _deadline=None,
):
    """바운스된 썸네일 티켓 묶음 발급. 개별 티켓과 동일한 인증/변형 화이트
    리스트/서명 규칙을 적용하며, 개별 항목 실패는 배치 전체를 실패시키지
    않는다. 임의 object key는 절대 요청할 수 없다 (asset id만 허용).
    """
    cancelled = _cancelled if _cancelled is not None else threading.Event()
    deadline = _deadline if _deadline is not None else time.monotonic() + MEDIA_TICKET_DEADLINE_SECONDS
    api.client_guard(api.get_db, api.API_TOKEN)(authorization)

    # 중복 제거: 같은 asset+variant는 한 번만 서명한다.
    unique: dict[tuple[str, str], None] = {}
    for entry in request.items:
        unique.setdefault((entry.asset_id, entry.variant), None)
    pairs = list(unique.keys())
    if not pairs:
        return {"items": []}

    asset_ids = list(dict.fromkeys(asset_id for asset_id, _ in pairs))
    placeholders = ",".join("?" for _ in asset_ids)
    with api.get_db() as db:
        if lifecycle == "trash":
            assets_by_id = asset_authority.trash_ticket_assets(db, asset_ids)
        else:
            assets_by_id = {
                row["id"]: dict(row)
                for row in db.execute(
                    f"SELECT * FROM visible_assets WHERE committed = 1 AND id IN ({placeholders})",
                    asset_ids,
                ).fetchall()
            }

    def failure(pair, error):
        return {"asset_id": pair[0], "variant": pair[1], "ok": False, "error": error}

    def resolve_ticket(pair: tuple[str, str], metadata=None):
        asset_id, variant = pair
        asset = assets_by_id.get(asset_id)
        if asset is None:
            return failure(pair, "not_found"), []
        object_key = asset["object_key"] if variant == "original" else asset["thumbnail_key"]
        if not object_key:
            return failure(pair, "unavailable"), []
        fills = []
        try:
            if metadata is None:
                metadata = api._ticket_head(asset, variant, object_key, fresh_head=fresh_head,
                                           verify_digest=verify_digest, thumbnail_metadata_fills=fills)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                return failure(pair, "unavailable"), []
            return failure(pair, "storage_unavailable"), []
        except _TRANSPORT_ERRORS:
            return failure(pair, "storage_unavailable"), []
        if cancelled.is_set() or time.monotonic() >= deadline:
            return failure(pair, "storage_unavailable"), []
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=api.MEDIA_TICKET_TTL_SECONDS)
        return {
            "asset_id": asset_id,
            "variant": variant,
            "ok": True,
            "url": api.presign_get(object_key, api.MEDIA_TICKET_TTL_SECONDS),
            "content_type": metadata.get("ContentType") or asset["content_type"],
            "size_bytes": metadata.get("ContentLength"),
            **api._ticket_digest(asset, variant),
            "expires_at": expires_at.isoformat(),
        }, fills

    # Key-bound receipts need no storage work. Resolve them before admission so
    # stalled original HEADs cannot consume thumbnail ticket capacity.
    completed = [None] * len(pairs)
    head_pairs, head_indices = [], []
    for index, pair in enumerate(pairs):
        if cancelled.is_set() or time.monotonic() >= deadline:
            break
        asset = assets_by_id.get(pair[0])
        key = (asset["object_key"] if pair[1] == "original" else asset["thumbnail_key"]) if asset else None
        metadata = (_thumbnail_receipt(asset, key, fresh_head=fresh_head)
                    if asset and key and pair[1] == "thumbnail" else None)
        if asset is None or not key or metadata is not None:
            completed[index] = resolve_ticket(pair, metadata)
        else:
            head_pairs.append(pair)
            head_indices.append(index)
    if head_pairs:
        heads = _bounded_ticket_work(head_pairs, resolve_ticket, deadline=deadline, cancelled=cancelled)
        for index, result in zip(head_indices, heads):
            completed[index] = result
    results, thumbnail_metadata_fills = [], []
    for pair, result in zip(pairs, completed):
        if result is None:
            results.append(failure(pair, "storage_unavailable"))
        else:
            ticket, fills = result
            results.append(ticket)
            thumbnail_metadata_fills.extend(fills)
    if not cancelled.is_set():
        api._persist_thumbnail_metadata(thumbnail_metadata_fills)
    return {"items": results}


async def _create_mobile_media_tickets_http(
    request: MediaTicketBatchRequest,
    http_request: Request,
    authorization: str | None = Header(default=None),
    lifecycle: Literal["trash"] | None = Query(default=None),
    fresh_head: bool = Query(default=False),
    verify_digest: bool = Query(default=False),
):
    # The body has already been parsed by FastAPI; only disconnect remains on the
    # receive channel. Keep DB/auth work off the event loop, using AnyIO's limiter.
    cancelled = threading.Event()
    deadline = time.monotonic() + MEDIA_TICKET_DEADLINE_SECONDS

    async def disconnected():
        while True:
            if (await http_request.receive())["type"] == "http.disconnect":
                cancelled.set()
                return

    work = asyncio.create_task(run_in_threadpool(
        create_mobile_media_tickets, request, authorization, lifecycle, fresh_head, verify_digest,
        _cancelled=cancelled, _deadline=deadline))
    disconnect = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait((work, disconnect), return_when=asyncio.FIRST_COMPLETED)
        if disconnect in done:
            raise asyncio.CancelledError
        return await work
    finally:
        cancelled.set()
        work.cancel()
        disconnect.cancel()
        await asyncio.gather(work, disconnect, return_exceptions=True)


def register_metadata_backup(app, services):
    global api
    api = services
    app.get("/v1/library/metadata-backup")(get_library_metadata_backup)


def register(app, services):
    global api
    api = services
    app.post("/v1/library/assets/{asset_id}/media-ticket")(create_mobile_media_ticket)
    app.post("/v1/library/media-tickets", name="create_mobile_media_tickets")(_create_mobile_media_tickets_http)
