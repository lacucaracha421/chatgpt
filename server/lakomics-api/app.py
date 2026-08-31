import json
import os
import sqlite3
import time
import urllib.error as urllib_error
import urllib.request as urllib_request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "lakomics.sqlite3"
API_TOKEN = os.environ.get("LAKOMICS_API_TOKEN", "")

app = FastAPI(title="Lakomics Cloud API", version="0.1.0")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def require_auth(authorization: str | None):
    if not API_TOKEN:
        raise HTTPException(status_code=500, detail="API token is not configured")

    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


class AssetCreate(BaseModel):
    id: str | None = None
    kind: str = Field(default="image")
    object_key: str
    thumbnail_key: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None


@app.on_event("startup")
def startup():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                object_key TEXT NOT NULL UNIQUE,
                thumbnail_key TEXT,
                content_type TEXT,
                size_bytes INTEGER,
                sha256 TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.commit()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "lakomics-api",
        "version": "0.1.0",
    }


@app.get("/v1/assets")
def list_assets(
    authorization: str | None = Header(default=None),
    limit: int = 50,
):
    require_auth(authorization)

    limit = max(1, min(limit, 200))

    with get_db() as db:
        rows = db.execute(
            """
            SELECT *
            FROM assets
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return {"items": [dict(row) for row in rows]}


@app.post("/v1/assets")
def create_asset(
    asset: AssetCreate,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    asset_id = asset.id or str(uuid.uuid4())
    ts = now_iso()

    try:
        with get_db() as db:
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
                    asset.thumbnail_key,
                    asset.content_type,
                    asset.size_bytes,
                    asset.sha256,
                    ts,
                    ts,
                ),
            )
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


@app.post("/v1/uploads/presign")
def create_upload_presign(
    request: PresignRequest,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    allowed_prefixes = (
        "images/",
        "thumbnails/",
        "videos/",
        "work-artwork/",
        "backups/",
    )

    if not request.object_key.startswith(allowed_prefixes):
        raise HTTPException(status_code=400, detail="Invalid object key prefix")

    if ".." in request.object_key or request.object_key.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid object key")

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



# --- Online catalog transport v1 (PC -> VPS -> k-hentai) --------------------
# PC searches the local VCK catalog (catalogs/kdata.db) without any network.
# Only two operations need k-hentai reachability, and Korean networks cannot
# reach k-hentai reliably, so the PC asks this VPS (Japan) to fetch on its
# behalf. The endpoints accept only numeric ids; clients can never make the
# VPS fetch an arbitrary URL (no open proxy / no SSRF surface).

KHENTAI_ORIGIN = "https://k-hentai.org"
CATALOG_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
)
CATALOG_ACCEPT_LANGUAGE = "ko,en;q=0.9,en-US;q=0.8,ko-KR;q=0.7"
# Bounded retry: transient network failures and 5xx only; 4xx verdicts from
# k-hentai (expired gallery, unknown id) are final for this request.
CATALOG_ATTEMPTS = 3
CATALOG_BACKOFF_SECONDS = 0.75
# k-hentai pages are a few MB at most; a larger body means a hijack or an
# HTML error page loop, so fail instead of buffering forever.
CATALOG_MAX_BODY_BYTES = 5 * 1024 * 1024
# Successful responses live in a small TTL cache keyed by URL so repeated PC
# requests do not hit k-hentai at all. Gallery HTML embeds its own signed-URL
# expiry, and update pages are short-lived, so 60s is safely conservative.
CATALOG_CACHE_TTL_SECONDS = 60
_catalog_cache: dict[str, tuple[float, int, bytes]] = {}


def _catalog_fetch_once(url: str) -> tuple[int, bytes]:
    # /r/{id}는 비브라우저형 클라이언트(기본 UA/프로토콜 fingerprint)를 451로
    # 거절한다(2026-09 VPS 실측: Lakomics UA 451, 브라우저 UA + Accept-Language
    # 200 — curl/HTTP1.1 여부 무관). 그래서 브라우저형 UA와 Accept-Language를 보낸다.
    request = urllib_request.Request(
        url,
        headers={
            "User-Agent": CATALOG_UA,
            "Accept-Language": CATALOG_ACCEPT_LANGUAGE,
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urllib_request.urlopen(request, timeout=30) as response:
            return response.status, response.read(CATALOG_MAX_BODY_BYTES + 1)
    except urllib_error.HTTPError as error:
        return error.code, b""
    except (urllib_error.URLError, TimeoutError, OSError):
        # DNS/TLS/connect/timeout 실패는 k-hentai 쪽 장애다. 예외를 밖으로
        # 흘려보내면 FastAPI raw 500이 되므로 게이트웨이 오류(0)로 정규화해
        # 재시도 파이프라인이 502로 응답하게 한다. 프로그래머 오류는 잡지 않는다.
        return 0, b""


def _catalog_fetch_with_retry(url: str) -> tuple[int, bytes]:
    last_status = 0
    for attempt in range(CATALOG_ATTEMPTS):
        status, body = _catalog_fetch_once(url)
        if status == 200:
            return status, body
        # 0은 _catalog_fetch_once가 네트워크 장애를 정규화한 게이트웨이 오류다.
        # k-hentai의 영구 4xx 판정(1xx~499)과 달리 재시도 대상이다.
        if 0 < status < 500:
            return status, body
        last_status = status
        if attempt + 1 < CATALOG_ATTEMPTS:
            time.sleep(CATALOG_BACKOFF_SECONDS * (2**attempt))
    return last_status, b""


def _catalog_cached_get(url: str) -> Response:
    now = time.monotonic()
    cached = _catalog_cache.get(url)
    if cached is not None and now - cached[0] < CATALOG_CACHE_TTL_SECONDS:
        _, status, body = cached
        return Response(content=body, status_code=status, media_type="text/html")
    status, body = _catalog_fetch_with_retry(url)
    if status >= 500 or status == 0:
        raise HTTPException(status_code=502, detail=f"k-hentai unreachable (upstream status {status})")
    if status == 404:
        raise HTTPException(status_code=404, detail="work not found on k-hentai")
    if status in (403, 429):
        # Cloudflare/bot 차단 가능성이 있는 403/429는 원인을 구분해 노출한다.
        # 상태 코드 외에 민감한 정보(토큰·헤더)는 응답에 포함하지 않는다.
        raise HTTPException(status_code=502, detail=f"k-hentai rejected the request (upstream status {status})")
    if status != 200 or not body:
        raise HTTPException(status_code=502, detail=f"k-hentai returned HTTP {status} with no content")
    if len(body) > CATALOG_MAX_BODY_BYTES:
        raise HTTPException(status_code=502, detail="k-hentai response too large")
    _catalog_cache[url] = (now, status, body)
    return Response(content=body, status_code=200, media_type="text/html")




@app.get("/v1/catalog/search-page")
def catalog_search_page(
    cursor: int | None = None,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    if cursor is not None and cursor <= 0:
        raise HTTPException(status_code=400, detail="cursor must be a positive id")
    query = "search=language%3Akorean"
    if cursor is not None:
        query += f"&next-id={cursor}"
    return _catalog_cached_get(f"{KHENTAI_ORIGIN}/ajax/search?{query}")


@app.get("/v1/catalog/gallery/{work_id}")
def catalog_gallery(work_id: int, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    if work_id <= 0:
        raise HTTPException(status_code=400, detail="work id must be a positive id")
    return _catalog_cached_get(f"{KHENTAI_ORIGIN}/r/{work_id}")


# --- Mobile Capture Inbox v1 -----------------------------------------------

from urllib.parse import urlparse

from capture_store import (
    CaptureDownloadError,
    CaptureValidationError,
    delete_r2_object,
    fetch_media_to_r2,
)
from r2 import presign_get


class CaptureCreate(BaseModel):
    source_url: str
    media_url: str
    classification_id: str
    published_at: str | None = None
    media_type: Literal["image", "video"] = "image"


class CaptureAcknowledge(BaseModel):
    imported_at: AwareDatetime


@app.on_event("startup")
def startup_captures():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS captures (
                id TEXT PRIMARY KEY,
                source_url TEXT NOT NULL,
                media_url TEXT NOT NULL,
                classification_id TEXT NOT NULL,
                object_key TEXT NOT NULL UNIQUE,
                content_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                published_at TEXT,
                status TEXT NOT NULL
                    CHECK (status IN ('pending', 'imported')),
                created_at TEXT NOT NULL,
                imported_at TEXT,
                media_type TEXT NOT NULL DEFAULT 'image'
                    CHECK (media_type IN ('image', 'video')),
                UNIQUE(source_url, media_url, classification_id)
            )
            """
        )
        columns = {
            row["name"] for row in db.execute("PRAGMA table_info(captures)")
        }
        if "media_type" not in columns:
            db.execute(
                """
                ALTER TABLE captures
                ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'
                """
            )
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_captures_status_created
            ON captures(status, created_at)
            """
        )
        db.commit()


@app.on_event("startup")
def startup_classifications():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS classification_snapshots (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                payload TEXT NOT NULL,
                published_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.commit()


@app.on_event("startup")
def startup_saved_x_media():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_x_media_snapshots (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                payload TEXT NOT NULL,
                published_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.commit()


def valid_x_source_url(value: str) -> bool:
    try:
        url = urlparse(value)
        return (
            url.scheme == "https"
            and url.hostname in {"x.com", "twitter.com"}
            and bool(url.path)
        )
    except Exception:
        return False


@app.post("/v1/captures")
def create_capture(
    capture: CaptureCreate,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    classification_id = capture.classification_id.strip()

    if not classification_id or len(classification_id) > 200:
        raise HTTPException(status_code=400, detail="Invalid classification_id")

    if not valid_x_source_url(capture.source_url):
        raise HTTPException(status_code=400, detail="Invalid X source URL")

    with get_db() as db:
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
        content_type, size_bytes = fetch_media_to_r2(
            capture.media_url,
            object_key,
            capture.media_type,
        )
    except CaptureValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except CaptureDownloadError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    ts = now_iso()

    try:
        with get_db() as db:
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
                    capture.media_type,
                ),
            )
            db.commit()
    except sqlite3.IntegrityError:
        try:
            delete_r2_object(object_key)
        except Exception:
            pass

        with get_db() as db:
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
            "status": "pending",
            "created_at": ts,
            "imported_at": None,
            "media_type": capture.media_type,
        },
    }


def pending_capture_payload(row: sqlite3.Row) -> dict:
    source = urlparse(row["source_url"])
    path_parts = [part for part in source.path.split("/") if part]
    creator_handle = path_parts[0] if path_parts else None
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


@app.get("/v1/captures/pending")
def list_pending_captures(
    authorization: str | None = Header(default=None),
    limit: int = 100,
):
    require_auth(authorization)
    limit = max(1, min(limit, 500))

    with get_db() as db:
        rows = db.execute(
            """
            SELECT *
            FROM captures
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return {"captures": [pending_capture_payload(row) for row in rows]}


@app.get("/v1/captures/{capture_id}/download")
def capture_download_ticket(
    capture_id: str,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    with get_db() as db:
        row = db.execute(
            "SELECT object_key FROM captures WHERE id = ?",
            (capture_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Capture not found")

    return {
        "method": "GET",
        "download_url": presign_get(row["object_key"], 600),
        "required_headers": {},
    }


@app.get("/v1/captures")
def list_captures(
    authorization: str | None = Header(default=None),
    status: str | None = None,
    source_url: str | None = None,
    media_url: str | None = None,
    classification_id: str | None = None,
    limit: int = 100,
):
    require_auth(authorization)

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
    with get_db() as db:
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


@app.post("/v1/captures/{capture_id}/imported")
def mark_capture_imported(
    capture_id: str,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    return mark_capture_imported_state(capture_id, now_iso())


def mark_capture_imported_state(capture_id: str, requested_at: str):
    with get_db() as db:
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


@app.post("/v1/captures/{capture_id}/acknowledge")
def acknowledge_capture_imported(
    capture_id: str,
    acknowledgement: CaptureAcknowledge,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    return mark_capture_imported_state(
        capture_id,
        acknowledgement.imported_at.isoformat(),
    )


# --- Classification snapshot (PC -> VPS publish, extension read) -----------
# The PC Lakomics app owns classification data; the VPS only stores the latest
# published snapshot so the mobile extension needs no live PC connection.

class ClassificationSnapshotPublish(BaseModel):
    entries: list[dict]
    published_at: str


MAX_SNAPSHOT_BYTES = 512 * 1024


@app.put("/v1/classifications")
def publish_classification_snapshot(
    snapshot: ClassificationSnapshotPublish,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    payload = snapshot.model_dump_json()
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise HTTPException(status_code=413, detail="Snapshot too large")

    with get_db() as db:
        db.execute(
            """
            INSERT INTO classification_snapshots (singleton, payload, published_at, updated_at)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                payload = excluded.payload,
                published_at = excluded.published_at,
                updated_at = excluded.updated_at
            """,
            (payload, snapshot.published_at, now_iso()),
        )
        db.commit()

    return {"ok": True, "published_at": snapshot.published_at}


@app.get("/v1/classifications")
def get_classification_snapshot(
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    with get_db() as db:
        row = db.execute(
            "SELECT payload FROM classification_snapshots WHERE singleton = 1"
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="No classification snapshot published yet")

    return json.loads(row["payload"])


@app.get("/v1/classifications/meta")
def classification_snapshot_meta(
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)

    with get_db() as db:
        row = db.execute(
            "SELECT published_at, updated_at FROM classification_snapshots WHERE singleton = 1"
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="No classification snapshot published yet")

    return dict(row)


# --- Saved X media snapshot (PC -> VPS publish, extension read) ------------

MAX_SAVED_X_MEDIA_KEYS = 20_000
MAX_SAVED_X_MEDIA_KEY_BYTES = 64
MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES = 1024 * 1024
SavedXMediaKey = Annotated[
    str,
    StringConstraints(
        pattern=r"^\d+:[1-9]\d*$",
        max_length=MAX_SAVED_X_MEDIA_KEY_BYTES,
    ),
]


@app.middleware("http")
async def bound_saved_x_media_snapshot_body(request: Request, call_next):
    if request.method == "PUT" and request.url.path == "/v1/saved-x-media":
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                if int(declared) > MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES:
                    return JSONResponse(status_code=413, content={"detail": "Snapshot too large"})
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
        body = await request.body()
        if len(body) > MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Snapshot too large"})
    return await call_next(request)


class SavedXMediaSnapshotPublish(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keys: list[SavedXMediaKey] = Field(max_length=MAX_SAVED_X_MEDIA_KEYS)


@app.put("/v1/saved-x-media")
def publish_saved_x_media_snapshot(
    snapshot: SavedXMediaSnapshotPublish,
    authorization: str | None = Header(default=None),
    content_length: int | None = Header(default=None),
):
    require_auth(authorization)
    if content_length is not None and content_length > MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES:
        raise HTTPException(status_code=413, detail="Snapshot too large")

    keys = list(dict.fromkeys(snapshot.keys))
    published_at = now_iso()
    payload = json.dumps(
        {"keys": keys, "published_at": published_at},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if len(payload.encode("utf-8")) > MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES:
        raise HTTPException(status_code=413, detail="Snapshot too large")

    with get_db() as db:
        db.execute(
            """
            INSERT INTO saved_x_media_snapshots (singleton, payload, published_at, updated_at)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                payload = excluded.payload,
                published_at = excluded.published_at,
                updated_at = excluded.updated_at
            """,
            (payload, published_at, now_iso()),
        )
        db.commit()
    return {"ok": True, "count": len(keys), "published_at": published_at}


@app.get("/v1/saved-x-media")
def get_saved_x_media_snapshot(
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    with get_db() as db:
        row = db.execute(
            "SELECT payload FROM saved_x_media_snapshots WHERE singleton = 1"
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No saved X media snapshot published yet")
    return json.loads(row["payload"])
