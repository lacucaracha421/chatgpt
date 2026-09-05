import base64
import binascii
import json
import os
import sqlite3
import time
import urllib.error as urllib_error
import urllib.request as urllib_request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Literal

from botocore.exceptions import ClientError
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
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


def startup_replication():
    """CLOUD-006 배치 2: 전체 라이브러리 복제용 가산 스키마.

    기존 captures/스냅샷 기능에 영향을 주지 않는다. 기존 assets 테이블은
    그대로 두고 커밋 상태·모바일 메타데이터 컬럼을 추가하고, 분류 관계는
    별도 테이블로 기록한다.
    """
    with get_db() as db:
        columns = {row["name"] for row in db.execute("PRAGMA table_info(assets)")}
        additions = {
            "committed": "INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))",
            "committed_at": "TEXT",
            "collected_at": "TEXT",
            "source_published_at": "TEXT",
            "source_url": "TEXT",
            "creator_name": "TEXT",
            "creator_handle": "TEXT",
            "import_source": "TEXT",
        }
        for column, definition in additions.items():
            if column not in columns:
                db.execute(f"ALTER TABLE assets ADD COLUMN {column} {definition}")
        db.execute("CREATE INDEX IF NOT EXISTS idx_assets_committed ON assets(committed)")
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS asset_classifications (
                asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                classification_id TEXT NOT NULL,
                added_at TEXT NOT NULL,
                PRIMARY KEY (asset_id, classification_id)
            )
            """
        )
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_asset_classifications_classification
            ON asset_classifications(classification_id, asset_id)
            """
        )
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_assets_mobile_order
            ON assets(committed, COALESCE(collected_at, created_at) DESC, id DESC)
            """
        )
        db.commit()


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


app.on_event("startup")(startup_replication)


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
            WHERE committed = 1
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

    if request.object_key.startswith("library/"):
        if not is_replication_object_key(request.object_key):
            raise HTTPException(status_code=400, detail="Invalid replication object key")
    elif not request.object_key.startswith(allowed_prefixes):
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
CATALOG_CURSOR_MAX = 9223372036854775807
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
    language: str = "korean",
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    if language not in ("korean", "japanese"):
        raise HTTPException(status_code=400, detail="language must be korean or japanese")
    if cursor is not None and cursor <= 0:
        raise HTTPException(status_code=400, detail="cursor must be a positive id")
    if cursor is not None and cursor > CATALOG_CURSOR_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"cursor must be at most {CATALOG_CURSOR_MAX}",
        )
    query = f"search=language%3A{language}"
    if cursor is not None:
        query += f"&next-id={cursor}"
    response = _catalog_cached_get(f"{KHENTAI_ORIGIN}/ajax/search?{query}")
    response.headers["X-Lakomics-Catalog-Language"] = language
    return response


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
from r2 import R2_BUCKET, _s3, presign_get


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


MAX_EXTENSION_BACKUP_BYTES = 256 * 1024


class ExtensionBackupSnapshot(BaseModel):
    version: Literal[1]
    algorithm: Literal["AES-GCM"]
    iv: str = Field(min_length=16, max_length=64)
    ciphertext: str = Field(min_length=16, max_length=MAX_EXTENSION_BACKUP_BYTES * 2)


@app.on_event("startup")
def startup_extension_backup():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS extension_backup_snapshots (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                payload TEXT NOT NULL,
                published_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.commit()


@app.put("/v1/extension-backup")
def publish_extension_backup(
    snapshot: ExtensionBackupSnapshot,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    payload = snapshot.model_dump_json()
    byte_size = len(payload.encode("utf-8"))
    if byte_size > MAX_EXTENSION_BACKUP_BYTES:
        raise HTTPException(status_code=413, detail="Extension backup too large")
    published_at = now_iso()
    with get_db() as db:
        db.execute(
            """
            INSERT INTO extension_backup_snapshots (singleton, payload, published_at, updated_at)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                payload = excluded.payload,
                published_at = excluded.published_at,
                updated_at = excluded.updated_at
            """,
            (payload, published_at, now_iso()),
        )
        db.commit()
    return {"ok": True, "published_at": published_at, "byte_size": byte_size}


@app.get("/v1/extension-backup")
def get_extension_backup(authorization: str | None = Header(default=None)):
    require_auth(authorization)
    with get_db() as db:
        row = db.execute(
            "SELECT payload, published_at FROM extension_backup_snapshots WHERE singleton = 1"
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No extension backup published yet")
    payload = json.loads(row["payload"])
    payload["published_at"] = row["published_at"]
    return payload


METADATA_BACKUP_OBJECT_KEY = "backups/library-metadata.sqlite"
METADATA_BACKUP_TICKET_TTL_SECONDS = 600


@app.get("/v1/library/metadata-backup")
def get_library_metadata_backup(authorization: str | None = Header(default=None)):
    require_auth(authorization)
    try:
        metadata = _s3.head_object(Bucket=R2_BUCKET, Key=METADATA_BACKUP_OBJECT_KEY)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=404, detail="No library metadata backup published yet")
        raise HTTPException(status_code=502, detail="Metadata backup storage is unavailable")
    return {
        "download_url": presign_get(METADATA_BACKUP_OBJECT_KEY, METADATA_BACKUP_TICKET_TTL_SECONDS),
        "required_headers": {},
        "size_bytes": metadata.get("ContentLength"),
        "content_type": metadata.get("ContentType") or "application/vnd.sqlite3",
        "expires_in": METADATA_BACKUP_TICKET_TTL_SECONDS,
    }


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


# --- CLOUD-006 Batch 4: replicated mobile library reads --------------------

MOBILE_LIBRARY_DEFAULT_LIMIT = 50
MOBILE_LIBRARY_MAX_LIMIT = 100
MEDIA_TICKET_TTL_SECONDS = 300


class MediaTicketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variant: Literal["thumbnail", "original"]


def encode_mobile_cursor(sort: str, sort_at: str, asset_id: str) -> str:
    payload = json.dumps([sort, sort_at, asset_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()


def decode_mobile_cursor(cursor: str, expected_sort: str) -> tuple[str, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if (
        not isinstance(payload, list)
        or len(payload) != 3
        or not all(isinstance(value, str) and value for value in payload)
        or payload[0] != expected_sort
    ):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    return payload[1], payload[2]


def encode_revisit_date_cursor(rank: int, sort_at: str, asset_id: str) -> str:
    payload = json.dumps(["revisit-date", str(rank), sort_at, asset_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()


def decode_revisit_date_cursor(cursor: str) -> tuple[int, str, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if (
        not isinstance(payload, list)
        or len(payload) != 4
        or payload[0] != "revisit-date"
        or payload[1] not in {"0", "1", "2"}
        or not all(isinstance(value, str) and value for value in payload[2:])
    ):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    return int(payload[1]), payload[2], payload[3]


@app.get("/v1/library/classifications")
def list_mobile_classifications(
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    with get_db() as db:
        snapshot = db.execute(
            "SELECT payload FROM classification_snapshots WHERE singleton = 1"
        ).fetchone()
        if snapshot is None:
            raise HTTPException(status_code=404, detail="No classification snapshot published yet")
        counts = {
            row["classification_id"]: row["asset_count"]
            for row in db.execute(
                """
                SELECT relationship.classification_id, COUNT(*) AS asset_count
                FROM asset_classifications AS relationship
                JOIN assets AS asset ON asset.id = relationship.asset_id
                WHERE asset.committed = 1
                GROUP BY relationship.classification_id
                """
            ).fetchall()
        }

    payload = json.loads(snapshot["payload"])
    items = []
    for sort_index, entry in enumerate(payload.get("entries", [])):
        classification_id = entry.get("id")
        if not isinstance(classification_id, str) or not classification_id:
            continue
        items.append(
            {
                "id": classification_id,
                "kind": entry.get("kind"),
                "name": entry.get("name"),
                "parent_id": entry.get("parentId"),
                "icon_key": entry.get("iconKey"),
                "color_key": entry.get("colorKey"),
                "sort_index": sort_index,
                "asset_count": counts.get(classification_id, 0),
            }
        )
    return {"items": items, "published_at": payload.get("published_at")}


@app.get("/v1/library/assets")
def list_mobile_classification_assets(
    classification_id: str | None = None,
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    sort: Literal["newest", "oldest"] = "newest",
    limit: int = Query(
        default=MOBILE_LIBRARY_DEFAULT_LIMIT,
        ge=1,
        le=MOBILE_LIBRARY_MAX_LIMIT,
    ),
):
    require_auth(authorization)
    comparison = "<" if sort == "newest" else ">"
    direction = "DESC" if sort == "newest" else "ASC"
    params: list[object] = []
    classification_clause = ""
    if classification_id is not None:
        classification_clause = """
            AND EXISTS (
                SELECT 1
                FROM asset_classifications AS relationship
                WHERE relationship.asset_id = asset.id
                  AND relationship.classification_id = ?
            )
        """
        params.append(classification_id)
    cursor_clause = ""
    if cursor is not None:
        cursor_sort_at, cursor_asset_id = decode_mobile_cursor(cursor, sort)
        cursor_clause = f"""
            AND (
                COALESCE(asset.collected_at, asset.created_at) {comparison} ?
                OR (
                    COALESCE(asset.collected_at, asset.created_at) = ?
                    AND asset.id {comparison} ?
                )
            )
        """
        params.extend([cursor_sort_at, cursor_sort_at, cursor_asset_id])
    params.append(limit + 1)

    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT asset.*,
                   COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
            FROM assets AS asset
            WHERE asset.committed = 1
              {classification_clause}
              {cursor_clause}
            ORDER BY mobile_sort_at {direction}, asset.id {direction}
            LIMIT ?
            """,
            params,
        ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        memberships: dict[str, list[str]] = {row["id"]: [] for row in page_rows}
        if page_rows:
            placeholders = ",".join("?" for _ in page_rows)
            for relation in db.execute(
                f"""
                SELECT asset_id, classification_id
                FROM asset_classifications
                WHERE asset_id IN ({placeholders})
                ORDER BY asset_id, classification_id
                """,
                [row["id"] for row in page_rows],
            ).fetchall():
                memberships[relation["asset_id"]].append(relation["classification_id"])

    items = [
        {
            "id": row["id"],
            "kind": row["kind"],
            "content_type": row["content_type"],
            "size_bytes": row["size_bytes"],
            "width": None,
            "height": None,
            "duration_ms": None,
            "collected_at": row["collected_at"],
            "committed_at": row["committed_at"],
            "source_published_at": row["source_published_at"],
            "source_url": row["source_url"],
            "creator_name": row["creator_name"],
            "creator_handle": row["creator_handle"],
            "import_source": row["import_source"],
            "classification_ids": memberships[row["id"]],
            "original_available": bool(row["object_key"]),
            "thumbnail_available": bool(row["thumbnail_key"]),
            "committed": True,
        }
        for row in page_rows
    ]
    next_cursor = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = encode_mobile_cursor(sort, last["mobile_sort_at"], last["id"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


def _revisit_creator_exclusion_sql(alias: str = "asset") -> str:
    return f"""
          AND (
            {alias}.creator_handle IS NULL OR {alias}.creator_handle = '' OR {alias}.creator_handle NOT IN (
              SELECT eligible.creator_handle FROM assets AS eligible
              WHERE eligible.committed = 1 AND eligible.creator_handle IS NOT NULL AND eligible.creator_handle != ''
              GROUP BY eligible.creator_handle HAVING COUNT(*) >= 3
                AND MIN(COALESCE(eligible.collected_at, eligible.created_at)) <= datetime('now', '-30 days')
            )
          )"""


def _revisit_calendar_distance_sql(timestamp_sql: str, reference_sql: str = "'now'") -> str:
    fixed_asset = f"julianday('2000-' || strftime('%m-%d', {timestamp_sql}))"
    fixed_now = f"julianday('2000-' || strftime('%m-%d', {reference_sql}))"
    delta = f"ABS({fixed_asset} - {fixed_now})"
    # Year 2000 is leap-safe; circular distance makes Dec 31 and Jan 1 adjacent.
    return f"MIN({delta}, 366 - {delta})"


def _revisit_date_bundle(db, limit: int) -> list:
    """과거의 이날 후보: 30일 이전 자산 중 오늘의 월/일 ±7일 근처 수집 자산.
    부족하면 같은 달의 오래된 자산, 그래도 부족하면 결정론적 오래된 자산으로
    확장한다(항상 30일 이전만 포함)."""
    creator_exclusion = _revisit_creator_exclusion_sql("asset")
    calendar_distance = _revisit_calendar_distance_sql("COALESCE(asset.collected_at, asset.created_at)")
    rows = db.execute(
        f"""
        SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
        FROM assets AS asset
        WHERE asset.committed = 1
          AND COALESCE(asset.collected_at, asset.created_at) <= datetime('now', '-30 days')
          {creator_exclusion}
          AND ({calendar_distance}) <= 7
        ORDER BY mobile_sort_at DESC, asset.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    if len(rows) >= limit:
        return rows
    seen = {row["id"] for row in rows}
    month_rows = db.execute(
        f"""
        SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
        FROM assets AS asset
        WHERE asset.committed = 1
          AND COALESCE(asset.collected_at, asset.created_at) <= datetime('now', '-30 days')
          {creator_exclusion}
          AND strftime('%m', COALESCE(asset.collected_at, asset.created_at)) = strftime('%m', 'now')
        ORDER BY mobile_sort_at DESC, asset.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    for row in month_rows:
        if row["id"] not in seen:
            rows.append(row)
            seen.add(row["id"])
            if len(rows) >= limit:
                return rows
    oldest_rows = db.execute(
        f"""
        SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
        FROM assets AS asset
        WHERE asset.committed = 1
          AND COALESCE(asset.collected_at, asset.created_at) <= datetime('now', '-30 days')
          {creator_exclusion}
        ORDER BY mobile_sort_at ASC, asset.id ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    for row in oldest_rows:
        if row["id"] not in seen:
            rows.append(row)
            seen.add(row["id"])
            if len(rows) >= limit:
                break
    return rows[:limit]


def _revisit_creator_groups(db, limit: int) -> list[dict]:
    """작가 그룹 선택: 3개 이상 자산 + 30일 이전 자산 보유 작가를 결정론적으로
    선택한다(최다 자산 작가와 가장 오래된 자산 보유 작가를 번갈아). 홈에는
    최대 3그룹, 그룹당 4~6개 미리보기."""
    creators = db.execute(
        """
        SELECT creator_handle,
               COUNT(*) AS asset_count,
               MIN(COALESCE(assets.collected_at, assets.created_at)) AS oldest_at,
               MAX(COALESCE(assets.collected_at, assets.created_at)) AS newest_at
        FROM assets
        WHERE committed = 1
          AND creator_handle IS NOT NULL
          AND creator_handle != ''
        GROUP BY creator_handle
        HAVING COUNT(*) >= 3
          AND MIN(COALESCE(assets.collected_at, assets.created_at)) <= datetime('now', '-30 days')
        ORDER BY asset_count DESC, creator_handle ASC
        LIMIT 12
        """
    ).fetchall()
    if not creators:
        return []
    chosen = []
    pool = [dict(row) for row in creators]
    seen_handles: set[str] = set()
    pick_by_count = True
    while len(chosen) < 3 and pool:
        if pick_by_count:
            pool.sort(key=lambda row: (-(row["asset_count"] or 0), row["creator_handle"]))
        else:
            pool.sort(key=lambda row: (row["oldest_at"] or "", row["creator_handle"]))
        candidate = pool.pop(0)
        if candidate["creator_handle"] in seen_handles:
            continue
        seen_handles.add(candidate["creator_handle"])
        chosen.append(candidate)
        pick_by_count = not pick_by_count
    groups = []
    for creator in chosen[:3]:
        rows = db.execute(
            """
            SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
            FROM assets AS asset
            WHERE asset.committed = 1
              AND asset.creator_handle = ?
            ORDER BY mobile_sort_at DESC, asset.id DESC
            LIMIT ?
            """,
            (creator["creator_handle"], min(6, max(4, limit // 3))),
        ).fetchall()
        if len(rows) < 2:
            continue
        groups.append({
            "creator_key": creator["creator_handle"],
            "creator_name": rows[0]["creator_name"] or creator["creator_handle"],
            "creator_handle": creator["creator_handle"],
            "asset_count": creator["asset_count"],
            "rows": rows,
        })
    return groups[:3]


def mobile_asset_item(row, classification_ids: list[str] | None = None) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
        "width": None,
        "height": None,
        "duration_ms": None,
        "collected_at": row["collected_at"],
        "committed_at": row["committed_at"],
        "source_published_at": row["source_published_at"],
        "source_url": row["source_url"],
        "creator_name": row["creator_name"],
        "creator_handle": row["creator_handle"],
        "import_source": row["import_source"],
        "classification_ids": list(classification_ids or []),
        "original_available": bool(row["object_key"]),
        "thumbnail_available": bool(row["thumbnail_key"]),
        "committed": True,
    }


def _mobile_memberships(db: sqlite3.Connection, rows) -> dict[str, list[str]]:
    memberships: dict[str, list[str]] = {row["id"]: [] for row in rows}
    if not rows:
        return memberships
    placeholders = ",".join("?" for _ in rows)
    for relation in db.execute(
        f"""
        SELECT asset_id, classification_id
        FROM asset_classifications
        WHERE asset_id IN ({placeholders})
        ORDER BY asset_id, classification_id
        """,
        [row["id"] for row in rows],
    ).fetchall():
        memberships[relation["asset_id"]].append(relation["classification_id"])
    return memberships


@app.get("/v1/library/revisit")
def list_mobile_revisit(
    authorization: str | None = Header(default=None),
    limit: int = Query(default=12, ge=1, le=50),
):
    """Mobile Home 다시보기. PC revisit.rs의 묶음 유형 중 복제본에서 계산
    가능한 두 가지를 제공한다:

    - date "과거의 이날": 30일 이상 지난 자산 중 오늘의 월/일 ±7일 근처 수집
      자산(PC rediscovery 지향). 부족하면 같은 달의 오래된 자산, 그래도
      부족하면 결정론적 오래된 자산으로 확장한다.
    - creator "다시 만난 작가": 같은 작가(creator_handle)가 3개 이상인 그룹을
      그룹 단위로 돌려준다(flat 목록 아님). 홈에서는 작가별 rail로 렌더링된다.

    rediscovery(다시 만난 자산)는 favorite/asset_activity가 PC 전용 상태라
    복제본에 없어 제공하지 않는다. 정렬은 결정론적(collected_at DESC,
    id DESC)이며 랜덤 SQL 정렬은 없다. 읽기 전용 엔드포인트다.
    """
    require_auth(authorization)
    with get_db() as db:
        date_bundle = _revisit_date_bundle(db, limit)
        creator_groups = _revisit_creator_groups(db, limit)

        ids = [row["id"] for row in date_bundle]
        for group in creator_groups:
            ids.extend(row["id"] for row in group["rows"])
        memberships: dict[str, list[str]] = {}
        if ids:
            placeholders = ",".join("?" for _ in ids)
            for relation in db.execute(
                f"""
                SELECT asset_id, classification_id
                FROM asset_classifications
                WHERE asset_id IN ({placeholders})
                ORDER BY asset_id, classification_id
                """,
                ids,
            ).fetchall():
                memberships.setdefault(relation["asset_id"], []).append(
                    relation["classification_id"]
                )

    used: set[str] = set()

    def serialize(rows) -> list[dict]:
        items = []
        for row in rows:
            if row["id"] in used:
                continue
            used.add(row["id"])
            item = mobile_asset_item(row, memberships.get(row["id"], []))
            items.append(item)
        return items

    groups = []
    for group in creator_groups:
        items = serialize(group["rows"])
        if not items:
            continue
        groups.append({
            "creator_key": group["creator_key"],
            "creator_name": group["creator_name"],
            "creator_handle": group["creator_handle"],
            "asset_count": group["asset_count"],
            "items": items,
        })

    return {
        "bundles": [
            {
                "kind": "date",
                "title": "과거의 이날",
                "reason": "예전에 이맘때 저장한 자산",
                "items": serialize(date_bundle),
            },
            {
                "kind": "creator",
                "title": "다시 만난 작가",
                "reason": "예전에 저장한 작가의 작품",
                "groups": groups,
            },
        ]
    }


@app.get("/v1/library/revisit/date")
def list_mobile_revisit_date(
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
):
    """과거의 이날 전체 결과. Home preview와 같은 우선순위(±7일, 같은 달,
    그 외 오래된 자산)를 유지하면서 rank+timestamp+id 커서로 페이지네이션한다."""
    require_auth(authorization)
    timestamp_sql = "COALESCE(asset.collected_at, asset.created_at)"
    calendar_distance = _revisit_calendar_distance_sql(timestamp_sql)
    creator_exclusion = _revisit_creator_exclusion_sql("asset")
    rank_sql = f"""CASE
        WHEN ({calendar_distance}) <= 7 THEN 0
        WHEN strftime('%m', {timestamp_sql}) = strftime('%m', 'now') THEN 1
        ELSE 2
      END"""
    cursor_clause = ""
    params: list[object] = []
    if cursor is not None:
        cursor_rank, cursor_sort_at, cursor_asset_id = decode_revisit_date_cursor(cursor)
        cursor_clause = """
        WHERE revisit_rank > ?
           OR (
             revisit_rank = ? AND (
               mobile_sort_at < ?
               OR (mobile_sort_at = ? AND id < ?)
             )
           )
        """
        params.extend([cursor_rank, cursor_rank, cursor_sort_at, cursor_sort_at, cursor_asset_id])
    params.append(limit + 1)
    with get_db() as db:
        rows = db.execute(
            f"""
            WITH ranked AS (
              SELECT asset.*, {timestamp_sql} AS mobile_sort_at, {rank_sql} AS revisit_rank
              FROM assets AS asset
              WHERE asset.committed = 1
                AND {timestamp_sql} <= datetime('now', '-30 days')
                {creator_exclusion}
            )
            SELECT * FROM ranked
            {cursor_clause}
            ORDER BY revisit_rank ASC, mobile_sort_at DESC, id DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        memberships = _mobile_memberships(db, page_rows)
    items = [mobile_asset_item(row, memberships.get(row["id"], [])) for row in page_rows]
    next_cursor = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = encode_revisit_date_cursor(last["revisit_rank"], last["mobile_sort_at"], last["id"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


@app.get("/v1/library/revisit/creator/{creator_key}/assets")
def list_mobile_revisit_creator_assets(
    creator_key: str,
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    sort: Literal["newest", "oldest"] = "newest",
    limit: int = Query(default=50, ge=1, le=100),
):
    """특정 작가의 전체 자산(홈 '모두 보기'). creator_key는 creator_handle
    값이며 파라미터 바인딩으로만 쿼리된다. 커서는 정렬과 묶여 있어 정렬을
    바꾸면 거절된다."""
    require_auth(authorization)
    comparison = "<" if sort == "newest" else ">"
    direction = "DESC" if sort == "newest" else "ASC"
    params: list[object] = [creator_key]
    cursor_clause = ""
    if cursor is not None:
        cursor_sort_at, cursor_asset_id = decode_mobile_cursor(cursor, sort)
        cursor_clause = f"""
            AND (
                COALESCE(asset.collected_at, asset.created_at) {comparison} ?
                OR (
                    COALESCE(asset.collected_at, asset.created_at) = ?
                    AND asset.id {comparison} ?
                )
            )
        """
        params.extend([cursor_sort_at, cursor_sort_at, cursor_asset_id])
    params.append(limit + 1)
    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
            FROM assets AS asset
            WHERE asset.committed = 1
              AND asset.creator_handle = ?
              {cursor_clause}
            ORDER BY mobile_sort_at {direction}, asset.id {direction}
            LIMIT ?
            """,
            params,
        ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        memberships = _mobile_memberships(db, page_rows)
    items = [mobile_asset_item(row, memberships.get(row["id"], [])) for row in page_rows]
    next_cursor = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = encode_mobile_cursor(sort, last["mobile_sort_at"], last["id"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


@app.post("/v1/library/assets/{asset_id}/media-ticket")
def create_mobile_media_ticket(
    asset_id: str,
    request: MediaTicketRequest,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    with get_db() as db:
        asset = db.execute(
            "SELECT * FROM assets WHERE id = ? AND committed = 1",
            (asset_id,),
        ).fetchone()
    if asset is None:
        raise HTTPException(status_code=404, detail="Committed asset not found")

    object_key = asset["object_key"] if request.variant == "original" else asset["thumbnail_key"]
    if not object_key:
        raise HTTPException(status_code=409, detail="Requested media variant is unavailable")
    try:
        metadata = _s3.head_object(Bucket=R2_BUCKET, Key=object_key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=409, detail="Requested media variant is unavailable")
        raise HTTPException(status_code=502, detail="Media storage is unavailable")

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=MEDIA_TICKET_TTL_SECONDS)
    return {
        "url": presign_get(object_key, MEDIA_TICKET_TTL_SECONDS),
        "expires_at": expires_at.isoformat(),
        "expires_in": MEDIA_TICKET_TTL_SECONDS,
        "variant": request.variant,
        "content_type": metadata.get("ContentType") or asset["content_type"],
        "size_bytes": metadata.get("ContentLength"),
    }


MAX_MEDIA_TICKET_BATCH = 50


class MediaTicketBatchItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1, max_length=64)
    variant: Literal["thumbnail", "original"]


class MediaTicketBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[MediaTicketBatchItem] = Field(max_length=MAX_MEDIA_TICKET_BATCH)


@app.post("/v1/library/media-tickets")
def create_mobile_media_tickets(
    request: MediaTicketBatchRequest,
    authorization: str | None = Header(default=None),
):
    """바운스된 썸네일 티켓 묶음 발급. 개별 티켓과 동일한 인증/변형 화이트
    리스트/서명 규칙을 적용하며, 개별 항목 실패는 배치 전체를 실패시키지
    않는다. 임의 object key는 절대 요청할 수 없다 (asset id만 허용).
    """
    require_auth(authorization)

    # 중복 제거: 같은 asset+variant는 한 번만 서명한다.
    unique: dict[tuple[str, str], None] = {}
    for entry in request.items:
        unique.setdefault((entry.asset_id, entry.variant), None)
    pairs = list(unique.keys())
    if not pairs:
        return {"items": []}

    asset_ids = list(dict.fromkeys(asset_id for asset_id, _ in pairs))
    placeholders = ",".join("?" for _ in asset_ids)
    with get_db() as db:
        assets_by_id = {
            row["id"]: dict(row)
            for row in db.execute(
                f"SELECT * FROM assets WHERE committed = 1 AND id IN ({placeholders})",
                asset_ids,
            ).fetchall()
        }

    def resolve_ticket(pair: tuple[str, str]) -> dict:
        asset_id, variant = pair
        asset = assets_by_id.get(asset_id)
        if asset is None:
            return {"asset_id": asset_id, "variant": variant, "ok": False, "error": "not_found"}
        object_key = asset["object_key"] if variant == "original" else asset["thumbnail_key"]
        if not object_key:
            return {"asset_id": asset_id, "variant": variant, "ok": False, "error": "unavailable"}
        try:
            metadata = _s3.head_object(Bucket=R2_BUCKET, Key=object_key)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                return {"asset_id": asset_id, "variant": variant, "ok": False, "error": "unavailable"}
            return {"asset_id": asset_id, "variant": variant, "ok": False, "error": "storage_unavailable"}
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=MEDIA_TICKET_TTL_SECONDS)
        return {
            "asset_id": asset_id,
            "variant": variant,
            "ok": True,
            "url": presign_get(object_key, MEDIA_TICKET_TTL_SECONDS),
            "content_type": metadata.get("ContentType") or asset["content_type"],
            "size_bytes": metadata.get("ContentLength"),
            "expires_at": expires_at.isoformat(),
        }

    # boto clients support concurrent request use; keep the pool bounded to avoid
    # turning a 50-thumbnail Home batch into 50 serial R2 round trips.
    workers = min(8, len(pairs))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(resolve_ticket, pairs))
    return {"items": results}


# --- CLOUD-006 full-library replication (PC -> VPS/R2) -----------------------
# PC Lakomics 라이브러리가 원본이다. VPS/R2 사본은 읽기 전용 복제본이며 PC에서
# 언제든 다시 만들 수 있어야 한다. prepare → 업로드(기존 presign 재사용) →
# commit의 멱등 3단계로 자산 한 건을 복제한다. committed=1이 되기 전까지
# 모바일 라이브러리 조회에 노출하지 않는다. captures 흐름과 무관하다.

ALLOWED_KINDS = ("image", "gif", "video")


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


def replication_variant_keys(asset_id: str) -> dict[str, str]:
    """variant별 결정적 R2 object key. 재시도·재실행에도 동일한 키를 쓴다."""
    return {
        "original": f"library/{asset_id}/original",
        "thumbnail": f"library/{asset_id}/thumbnail",
    }


def _replication_row(db: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()


@app.post("/v1/replication/prepare")
def replication_prepare(
    request: ReplicationPrepare,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    if request.kind not in ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail="Invalid media kind")
    ts = now_iso()
    keys = replication_variant_keys(request.asset_id)
    with get_db() as db:
        # 멱등: 같은 asset_id로 다시 prepare하면 상태를 보존하고 같은 키를
        # 돌려준다. 이미 커밋된 자산이면 재업로드 없이 멱등 통과한다.
        existing = _replication_row(db, request.asset_id)
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
            existing = _replication_row(db, request.asset_id)
        elif existing["committed"] == 1:
            return {
                "asset_id": request.asset_id,
                "already_committed": True,
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
        "object_keys": keys,
    }


@app.post("/v1/replication/commit")
def replication_commit(
    request: ReplicationCommit,
    authorization: str | None = Header(default=None),
):
    require_auth(authorization)
    if request.kind not in ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail="Invalid media kind")
    ts = now_iso()
    keys = replication_variant_keys(request.asset_id)
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

    with get_db() as db:
        db.execute("BEGIN")
        row = _replication_row(db, request.asset_id)
        if row is None:
            db.execute("ROLLBACK")
            raise HTTPException(
                status_code=404,
                detail="Asset was not prepared; call /v1/replication/prepare first",
            )
        db.execute(
            """
            INSERT INTO assets (
                id, kind, object_key, thumbnail_key, content_type,
                size_bytes, sha256, collected_at, source_published_at,
                source_url, creator_name, creator_handle, import_source,
                committed, committed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
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
                ts,
                ts,
                ts,
            ),
        )
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
        db.commit()
    return {
        "ok": True,
        "asset_id": request.asset_id,
        "committed": True,
        "committed_at": ts,
        "object_keys": keys,
    }
