"""Capture ingestion, pending downloads and import acknowledgements.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import logging
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from types import ModuleType
from typing import Literal
from urllib.parse import urlparse

from fastapi import HTTPException, Header
from pydantic import AwareDatetime, BaseModel

from app_lifecycle import join_worker, lifecycle

import asset_authority
import authority
import classification_authority
import classification_snapshot
from capture_store import CaptureBusyError, CaptureDownloadError, CaptureValidationError, MAX_CAPTURE_DOWNLOADS


api: ModuleType
_capture_lock = threading.Lock()
_capture_inflight: set[tuple[str, str, str]] = set()


@contextmanager
def _reserve_capture(identity):
    # One uvicorn process: bound both downloading and the post-upload DB phase.
    # A retry must not start another upload before the first row is committed.
    with _capture_lock:
        if identity in _capture_inflight:
            raise HTTPException(503, "Capture in progress; retry shortly", headers={"Retry-After": "5"})
        if len(_capture_inflight) >= MAX_CAPTURE_DOWNLOADS:
            raise HTTPException(503, "Capture downloads busy; retry shortly", headers={"Retry-After": "5"})
        _capture_inflight.add(identity)
    try:
        yield
    finally:
        with _capture_lock:
            _capture_inflight.remove(identity)


class CaptureCreate(BaseModel):
    source_url: str
    media_url: str
    classification_id: str
    published_at: str | None = None
    media_type: Literal["image", "video", "animated_gif"] = "image"
    source: Literal["x", "arca", "dcinside", "web"] = "x"


class CaptureAcknowledge(BaseModel):
    imported_at: AwareDatetime


def _classification_is_live_for_capture(db: sqlite3.Connection, classification_id: str) -> bool:
    """Use canonical authority after cutover, legacy staging before cutover."""
    active = authority.active_domain(db, classification_authority.DOMAIN)
    if active is not None:
        row = classification_authority.classification_row(
            db, active["libraryId"], classification_id)
        return row is not None and not bool(row["deleted"])
    snapshot = db.execute(
        "SELECT payload FROM classification_snapshots WHERE singleton=1").fetchone()
    if snapshot is None:
        return False
    return any(
        isinstance(entry, dict) and entry.get("id") == classification_id
        for entry in classification_snapshot.legacy_entries(snapshot["payload"])
    )


def valid_capture_source_url(value: str, source: str) -> bool:
    try:
        url = urlparse(value)
        if url.scheme != "https" or not url.hostname or not url.path or url.username or url.password or url.fragment:
            return False
        host = url.hostname.lower()
        if source == "x":
            return host in {"x.com", "twitter.com"}
        if source == "arca":
            return host == "arca.live"
        if source == "dcinside":
            return host in {"gall.dcinside.com", "m.dcinside.com"}
        return source == "web"
    except Exception:
        return False


def create_capture(
    capture: CaptureCreate,
    authorization: str | None = Header(default=None),
):
    principal = api.require_admin_or_extension(authorization)

    classification_id = capture.classification_id.strip()

    if not classification_id or len(classification_id) > 200:
        raise HTTPException(status_code=400, detail="Invalid classification_id")
    if principal != "admin":
        with api.get_db() as db:
            if not api._classification_is_live_for_capture(db, classification_id):
                raise HTTPException(status_code=409, detail={"code": "classification_stale"})

    if not api.valid_capture_source_url(capture.source_url, capture.source):
        raise HTTPException(status_code=400, detail="Invalid source URL")

    with _reserve_capture((capture.source_url, capture.media_url, classification_id)):
        return _create_capture_reserved(capture, classification_id)


def _create_capture_reserved(capture, classification_id):
    # Recheck persisted identity after reserving, including retries of completed work.
    with api.get_db() as db:
        existing = db.execute(
            """
            SELECT *
            FROM captures
            WHERE source_url = ? AND media_url = ? AND classification_id = ?
            LIMIT 1
            """,
            (capture.source_url, capture.media_url, classification_id),
        ).fetchone()

    if existing:
        return {
            "ok": True,
            "created": False,
            "capture": dict(existing),
        }

    capture_id = str(uuid.uuid4())
    object_namespace = "videos" if capture.media_type == "video" else "images"
    object_key = f"{object_namespace}/inbox/{capture_id}/original"

    try:
        stored = api.fetch_media_to_r2(
            capture.media_url,
            object_key,
            capture.media_type,
            capture.source,
        )
    except CaptureValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except CaptureBusyError as exc:
        raise HTTPException(status_code=503, detail=str(exc), headers={"Retry-After": "5"})
    except CaptureDownloadError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    content_type, size_bytes = stored
    digest = getattr(stored, "sha256", None)
    stored_media_type = "animated_gif" if content_type == "image/gif" else capture.media_type
    ts = api.now_iso()
    asset_created = False
    committed = False

    try:
        with api.get_db() as db:
            db.execute(
                """
                INSERT INTO captures (
                    id,
                    source_url,
                    media_url,
                    classification_id,
                    object_key,
                    content_type,
                    size_bytes,
                    published_at,
                    status,
                    created_at,
                    imported_at,
                    media_type
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)
                """,
                (
                    capture_id,
                    capture.source_url,
                    capture.media_url,
                    classification_id,
                    object_key,
                    content_type,
                    size_bytes,
                    capture.published_at,
                    ts,
                    stored_media_type,
                ),
            )
            db.execute("UPDATE captures SET sha256=? WHERE id=?", [digest,capture_id])
            active = authority.active_domain(db, asset_authority.DOMAIN)
            promotion_state = None
            if active is not None:
                if digest is None:
                    raise HTTPException(422, detail={"code": "captureDigestUnavailable"})
                try:
                    _, asset_created = asset_authority.promote_capture(
                        db, library_id=active["libraryId"], capture_id=capture_id,
                        kind="gif" if stored_media_type == "animated_gif" else stored_media_type,
                        object_key=object_key, content_type=content_type, size_bytes=size_bytes,
                        sha256=digest, source_url=capture.source_url,
                        collected_at=ts, source_published_at=capture.published_at,
                        import_source="capture", classification_id=classification_id, now=ts)
                    promotion_state = "promoted"
                    db.execute("UPDATE captures SET status='imported',imported_at=? WHERE id=?",[ts,capture_id])
                except HTTPException as exc:
                    if not isinstance(exc.detail,dict) or exc.detail.get("code") not in ("duplicateInTrash","duplicateTombstoned"):
                        raise
                    promotion_state = exc.detail["code"]
                db.execute("UPDATE captures SET promotion_state=? WHERE id=?",[promotion_state,capture_id])
            db.commit()
            committed = True
    except BaseException as exc:
        # Includes open/execute/commit failures and interrupted transactions. The
        # connection has closed (and rolled back) before we remove the upload.
        if not committed:
            try:
                api.delete_r2_object(object_key)
            except Exception:
                pass

        if not isinstance(exc, sqlite3.IntegrityError):
            raise

        with api.get_db() as db:
            existing = db.execute(
                """
                SELECT *
                FROM captures
                WHERE source_url = ? AND media_url = ? AND classification_id = ?
                LIMIT 1
                """,
                (capture.source_url, capture.media_url, classification_id),
            ).fetchone()

        if existing:
            return {
                "ok": True,
                "created": False,
                "capture": dict(existing),
            }

        raise HTTPException(status_code=409, detail="Capture conflict")

    # The trigger's durable job is visible only after the capture transaction commits.
    # This event is process-local; the lock-owning worker still polls for other writers.
    worker = api._image_thumbnail_worker
    if asset_created and worker is not None:
        worker.wake()

    return {
        "ok": True,
        "created": True,
        "capture": {
            "id": capture_id,
            "source_url": capture.source_url,
            "media_url": capture.media_url,
            "classification_id": classification_id,
            "object_key": object_key,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "published_at": capture.published_at,
            "status": "imported" if promotion_state == "promoted" else "pending",
            "sha256": digest,
            "promotion_state": promotion_state,
            "created_at": ts,
            "imported_at": None,
            "media_type": stored_media_type,
        },
    }


def pending_capture_payload(row: sqlite3.Row) -> dict:
    source = urlparse(row["source_url"])
    path_parts = [part for part in source.path.split("/") if part]
    creator_handle = path_parts[0] if source.hostname in {"x.com", "twitter.com"} and path_parts else None
    return {
        "id": row["id"],
        "kind": row["media_type"],
        "object_key": row["object_key"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
        "source_url": row["source_url"],
        "classification_id": row["classification_id"],
        "creator_handle": creator_handle,
        "source_published_at": row["published_at"],
        "created_at": row["created_at"],
    }


def list_pending_captures(
    authorization: str | None = Header(default=None),
    limit: int = 100,
    after_id: str | None = None,
):
    api.require_auth(authorization)
    limit = max(1, min(limit, 500))

    with api.get_db() as db:
        rows = db.execute(
            """
            SELECT *
            FROM captures
            WHERE status = 'pending' AND (? IS NULL OR id > ?)
            ORDER BY id ASC
            LIMIT ?
            """,
            (after_id, after_id, limit),
        ).fetchall()

    return {"captures": [api.pending_capture_payload(row) for row in rows]}


def captures_status_head(db):
    """Capture inbox head for ``/v1/sync/status`` ``publisherLogs.captures``.

    Capture ids are random, so ``latest`` is the newest row's ``rowid``: it moves on every
    new capture even when an import leaves the pending count unchanged.
    """
    pending = db.execute("SELECT COUNT(*) FROM captures WHERE status='pending'").fetchone()[0]
    latest = db.execute("SELECT MAX(rowid) FROM captures").fetchone()[0]
    return {"pending": pending, "latest": latest}


def confirm_extension_capture(
    source_url: str, media_url: str, classification_id: str,
    authorization: str | None = Header(default=None),
):
    api.require_extension_client(authorization)
    with api.get_db() as db:
        row = db.execute(
            "SELECT id,status,media_type,content_type,created_at FROM captures WHERE source_url=? AND media_url=? AND classification_id=? ORDER BY created_at DESC LIMIT 1",
            (source_url, media_url, classification_id),
        ).fetchone()
    return {"found": row is not None, "capture": dict(row) if row is not None else None}


def capture_download_ticket(
    capture_id: str,
    authorization: str | None = Header(default=None),
):
    api.require_auth(authorization)

    with api.get_db() as db:
        row = db.execute(
            "SELECT object_key FROM captures WHERE id = ?",
            (capture_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Capture not found")

    return {
        "method": "GET",
        "download_url": api.presign_get(row["object_key"], 600),
        "required_headers": {},
    }


def list_captures(
    authorization: str | None = Header(default=None),
    status: str | None = None,
    source_url: str | None = None,
    media_url: str | None = None,
    classification_id: str | None = None,
    limit: int = 100,
):
    api.require_auth(authorization)

    limit = max(1, min(limit, 500))

    if status is not None and status not in {"pending", "imported"}:
        raise HTTPException(status_code=400, detail="Invalid capture status")

    clauses = []
    parameters = []
    for column, value in (
        ("status", status),
        ("source_url", source_url),
        ("media_url", media_url),
        ("classification_id", classification_id),
    ):
        if value is not None:
            clauses.append(f"{column} = ?")
            parameters.append(value)

    where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with api.get_db() as db:
        rows = db.execute(
            f"""
            SELECT *
            FROM captures
            {where_clause}
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (*parameters, limit),
        ).fetchall()

    return {"items": [dict(row) for row in rows]}


def mark_capture_imported(
    capture_id: str,
    authorization: str | None = Header(default=None),
):
    api.require_auth(authorization)
    return api.mark_capture_imported_state(capture_id, api.now_iso())


def mark_capture_imported_state(capture_id: str, requested_at: str):
    with api.get_db() as db:
        cursor = db.execute(
            """
            UPDATE captures
            SET status = 'imported',
                imported_at = COALESCE(imported_at, ?)
            WHERE id = ?
            """,
            (requested_at, capture_id),
        )
        row = db.execute(
            "SELECT imported_at FROM captures WHERE id = ?",
            (capture_id,),
        ).fetchone()
        db.commit()

    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Capture not found")

    return {
        "ok": True,
        "id": capture_id,
        "status": "imported",
        "imported_at": row["imported_at"],
    }


def acknowledge_capture_imported(
    capture_id: str,
    acknowledgement: CaptureAcknowledge,
    authorization: str | None = Header(default=None),
):
    api.require_auth(authorization)
    return api.mark_capture_imported_state(
        capture_id,
        acknowledgement.imported_at.isoformat(),
    )


def register(app, services):
    global api
    api = services
    reclaimer = InboxReclaimer(services.get_db)
    app.state.capture_reclaimer = reclaimer
    lifecycle(app).on_startup(reclaimer.start)
    lifecycle(app).on_shutdown(reclaimer.stop)
    app.post("/v1/captures")(create_capture)
    app.get("/v1/captures/pending")(list_pending_captures)
    app.get("/v1/extension/captures/confirm")(confirm_extension_capture)
    app.get("/v1/captures/{capture_id}/download")(capture_download_ticket)
    app.get("/v1/captures")(list_captures)
    app.post("/v1/captures/{capture_id}/imported")(mark_capture_imported)
    app.post("/v1/captures/{capture_id}/acknowledge")(acknowledge_capture_imported)


def _inbox_references(db, keys):
    placeholders = ",".join("?" for _ in keys)
    referenced = set()
    # Read canonical authority without visibility filters, including retained rows.
    for table in ("captures", "assets", "asset_authority_state"):
        if table == "asset_authority_state" and not db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]).fetchone():
            continue
        referenced.update(row[0] for row in db.execute(
            f"SELECT object_key FROM {table} WHERE object_key IN ({placeholders})", keys))
    referenced.update(row[0] for row in db.execute(
        f"SELECT thumbnail_key FROM assets WHERE thumbnail_key IN ({placeholders})", keys))
    return referenced


def reclaim_orphaned_inbox(get_db, storage, bucket, *, cursor=None, limit=25, now=None, stop_event=None):
    """Reclaim at most one page per inbox prefix; no request/startup sweep.

    Run periodically against the API's control DB and R2 bucket, passing the returned
    `cursor` to the next invocation so referenced early keys cannot starve later ones.
    Only UUID capture originals older than 24 hours qualify (well beyond a download
    or upload). Keep *all* capture/Asset references, including trash and tombstones.
    A control-DB write lock fences each final reference check and deletion. It is
    released between objects so a page does not monopolize the API's database.
    Missing core tables, listing errors or reference-query errors fail closed.
    """
    from datetime import datetime, timedelta, timezone

    if not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100 per prefix")
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    positions = dict(cursor or {})
    result = {"scanned": 0, "deleted": 0, "errors": 0, "cursor": positions}
    for prefix in ("images/inbox/", "videos/inbox/"):
        if stop_event is not None and stop_event.is_set():
            return result
        after = positions.get(prefix)
        if after is not None and not after.startswith(prefix):
            raise ValueError("Invalid inbox cursor")
        listing = storage.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=limit,
                                         **({"StartAfter": after} if after else {}))
        objects = listing.get("Contents", [])[:limit]
        candidates = []
        for item in objects:
            result["scanned"] += 1
            key, modified = item.get("Key", ""), item.get("LastModified")
            if not key.startswith(prefix):
                continue
            parts = key[len(prefix):].split("/")
            if len(parts) != 2 or parts[1] != "original":
                continue
            try:
                if str(uuid.UUID(parts[0])) != parts[0]:
                    continue
            except ValueError:
                continue
            if not isinstance(modified, datetime) or modified.tzinfo is None or modified >= cutoff:
                continue
            candidates.append(key)
        if candidates:
            with get_db() as db:
                referenced = _inbox_references(db, candidates)
            for key in candidates:
                if stop_event is not None and stop_event.is_set():
                    return result
                if key in referenced:
                    continue
                with get_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    try:
                        if stop_event is not None and stop_event.is_set():
                            return result
                        if _inbox_references(db, [key]):
                            continue
                        try:
                            storage.delete_object(Bucket=bucket, Key=key)
                            result["deleted"] += 1
                        except Exception:
                            result["errors"] += 1
                    finally:
                        db.rollback()
        positions[prefix] = objects[-1]["Key"] if listing.get("IsTruncated") and objects else None
    return result


class InboxReclaimer:
    """One small page hourly, independent of catalog enablement and publish wakeups.

    R2 calls must not stall local catalog pruning. Stop prevents further calls and
    joins share the application deadline; an already running SDK call may outlive it.
    """
    INTERVAL_SECONDS = 3600
    INITIAL_DELAY_SECONDS = 300
    PAGE_LIMIT = 5

    def __init__(self, get_db):
        self.get_db = get_db
        self.stop_event = threading.Event()
        self.thread = None
        self.cursor = {}

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.loop, name="capture-reclaim", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            join_worker(self.thread, 1)

    def run_once(self):
        if self.stop_event.is_set():
            return None
        from r2 import R2_BUCKET, _s3
        result = reclaim_orphaned_inbox(self.get_db, _s3, R2_BUCKET,
                                       cursor=self.cursor, limit=self.PAGE_LIMIT,
                                       stop_event=self.stop_event)
        self.cursor = result["cursor"]
        return result

    def loop(self):
        delay = self.INITIAL_DELAY_SECONDS
        while not self.stop_event.wait(delay):
            try:
                self.run_once()
            except Exception:
                logging.getLogger(__name__).warning("Capture inbox reclaim failed; retry next interval")
            delay = self.INTERVAL_SECONDS


if __name__ == "__main__":
    # Example periodic invocation (persist the returned cursor between runs):
    # python capture_routes.py --reclaim-inbox --cursor '{"images/inbox/": null}'
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Reclaim aged, unreferenced capture inbox originals")
    parser.add_argument("--reclaim-inbox", action="store_true", required=True)
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--cursor", default="{}", help="Previous result's cursor JSON")
    args = parser.parse_args()
    import app as services
    from r2 import R2_BUCKET, _s3

    print(json.dumps(reclaim_orphaned_inbox(services.get_db, _s3, R2_BUCKET,
                                          limit=args.limit, cursor=json.loads(args.cursor))))
