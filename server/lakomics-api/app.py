import hashlib
import json
import logging
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from app_lifecycle import lifecycle
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.requests import ClientDisconnect

import asset_filters
import asset_visibility
import change_signal
import read_budget

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "lakomics.sqlite3"
API_TOKEN = os.environ.get("LAKOMICS_API_TOKEN", "")
#: How long one request waits for a writer before failing. Readers never wait once the
#: control database runs in WAL mode (see ``startup``); this bounds writer-on-writer waits.
DB_BUSY_TIMEOUT_SECONDS = 10

app = FastAPI(title="Lakomics Cloud API", version="0.1.0")
app.add_middleware(read_budget.ReadBudgetMiddleware)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


#: Bumped whenever a control-database connection changed a row; wakes `/v1/sync/status`
#: long-polls. A hint only: writers that bypass `get_db` are caught by the waiters' recheck.
write_signal = change_signal.WriteSignal()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=DB_BUSY_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    budget = read_budget.install(conn) if read_budget.http_read.get() else None
    try:
        asset_visibility.install(conn)
        yield conn
    except sqlite3.OperationalError as exc:
        if budget is not None:
            budget.translate(exc)
        raise
    finally:
        changed = conn.total_changes > 0
        conn.close()
        if changed:
            write_signal.bump()


@app.exception_handler(ClientDisconnect)
async def client_disconnected(request: Request, exc: ClientDisconnect):
    """The peer closed the connection while its request body was still arriving.

    Nobody is left to receive an answer, so this is not a server fault: without this
    handler the exception escapes the application and the server logs a traceback
    and a 500 for what is an incomplete upload. The status only reaches the access log.
    """
    return Response(status_code=400)


async def read_bounded_body(request: Request, limit: int, too_large: str) -> bytes:
    """The whole request body, or 413 as soon as it is known to exceed ``limit``.

    A declared ``Content-Length`` is rejected before any byte is read; a chunked body is
    rejected mid-stream, so no more than ``limit`` bytes are ever held in memory.
    """
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                raise HTTPException(status_code=413, detail=too_large)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(status_code=413, detail=too_large)
        data.extend(chunk)
    return bytes(data)


def body_validation_error(exc: ValidationError) -> RequestValidationError:
    """The same 422 document FastAPI produces for a declared body parameter."""
    return RequestValidationError([
        {"type": error["type"], "loc": ("body", *error["loc"]), "msg": error["msg"],
         "input": error.get("input")}
        for error in exc.errors(include_url=False)])


def require_auth(authorization: str | None):
    if not API_TOKEN:
        raise HTTPException(status_code=500, detail="API token is not configured")

    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_upload_client(authorization: str | None):
    """Keep legacy upload calls working while the PC publishes with its own role."""
    if API_TOKEN and authorization == f"Bearer {API_TOKEN}":
        return
    require_publisher(authorization)


def _bearer_value(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return token


def _token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require_extension_client(authorization: str | None) -> str:
    token = _bearer_value(authorization)
    digest = _token_hash(token)
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM extension_clients WHERE token_hash=? AND revoked_at IS NULL",
            (digest,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Unauthorized")
        db.execute("UPDATE extension_clients SET last_seen_at=? WHERE id=?", (now_iso(), row["id"]))
        db.commit()
        return str(row["id"])


def require_admin_or_extension(authorization: str | None) -> str:
    if API_TOKEN and authorization == f"Bearer {API_TOKEN}":
        return "admin"
    return require_extension_client(authorization)


# Keep app.<name> compatibility exports for existing callers and monkeypatches.
# Feature modules read shared services through this module at request time.
import asset_uploads
from asset_uploads import (
    AssetCreate as AssetCreate,
    list_assets as list_assets,
    create_asset as create_asset,
    PresignRequest as PresignRequest,
    is_replication_object_key as is_replication_object_key,
    create_upload_presign as create_upload_presign,
)


THUMBNAIL_RECEIPT_COLUMNS = ("thumbnail_metadata_key", "thumbnail_size_bytes", "thumbnail_content_type")


from library_thumbnails import revision as thumbnail_revision
import library_thumbnails


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
            "metadata_revision": "INTEGER NOT NULL DEFAULT 0",
            "metadata_commit_id": "TEXT",
            # Additive and nullable: an existing library keeps NULL, meaning "unknown" rather
            # than a fabricated 0. Old rows stay NULL until that Asset is re-committed.
            "width": "INTEGER",
            "height": "INTEGER",
            "duration_ms": "INTEGER",
            # Bound to the exact derived key: a later thumbnail replacement must
            # never inherit the previous object's metadata. No historical backfill.
            "thumbnail_metadata_key": "TEXT",
            "thumbnail_size_bytes": "INTEGER",
            "thumbnail_content_type": "TEXT",
        }
        for column, definition in additions.items():
            if column not in columns:
                db.execute(f"ALTER TABLE assets ADD COLUMN {column} {definition}")
        library_thumbnails.install(db)
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


@lifecycle(app).on_startup
def startup():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with get_db() as db:
        # Write-ahead logging is persistent in the database file, so this runs once per
        # deployment. It is what lets the polling reads (`/v1/sync/status` and the change
        # feeds, several per second) proceed while a publication, catalog refresh or
        # thumbnail job holds the write lock: under the default rollback journal every
        # reader waits for the writer's commit and fails with "database is locked"
        # once the busy timeout expires.
        if db.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
            logging.getLogger(__name__).warning(
                "Control database could not switch to WAL; readers may block on writers")
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
        db.executescript("""
            CREATE TABLE IF NOT EXISTS asset_list_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL);
            INSERT OR IGNORE INTO asset_list_generation VALUES(1,0);
            CREATE TRIGGER IF NOT EXISTS asset_list_insert AFTER INSERT ON assets BEGIN
              UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS asset_list_update AFTER UPDATE ON assets BEGIN
              UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS asset_list_delete AFTER DELETE ON assets BEGIN
              UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
        """)
        db.commit()


def list_generation(db):
    """The Asset list generation digest (``/v1/library/list-generation`` and ``signals.listGeneration``)."""
    generation = db.execute("SELECT generation FROM asset_list_generation WHERE singleton=1").fetchone()[0]
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    domains = db.execute("SELECT library_id,domain,epoch,change_cursor FROM authority_domains "
                         "WHERE domain IN ('assets','classifications','albums') ORDER BY domain").fetchall() if 'authority_domains' in tables else []
    characters = db.execute("SELECT revision FROM mobile_character_state WHERE singleton=1").fetchone() if 'mobile_character_state' in tables else None
    snapshot = db.execute("SELECT revision FROM classification_snapshots WHERE singleton=1").fetchone() if 'classification_snapshots' in tables else None
    search_revisions = [list(db.execute(f"SELECT revision FROM {table} WHERE singleton=1").fetchone() or [])
                        if table in tables else None for table in ("library_tag_state", "library_artist_state")]
    value = [search_revisions,generation,[list(row) for row in domains],list(characters) if characters else None,list(snapshot) if snapshot else None]
    return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()


@app.get("/v1/library/list-generation")
def asset_list_generation(authorization: str | None = Header(default=None)):
    require_auth(authorization)
    with get_db() as db:
        db.execute("BEGIN")
        generation = list_generation(db)
    # `filterVersion` is the same "does this server know about X" probe, carried on the
    # call every gallery already makes before a page fetch: an older server omits the
    # field, and the client then refuses to present an unfiltered list as a filtered one.
    return {"generation": generation, "filterVersion": asset_filters.FILTER_VERSION, "searchVersion": 1}


lifecycle(app).on_startup(startup_replication)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "lakomics-api",
        "version": "0.1.0",
    }


asset_uploads.register(app, sys.modules[__name__])
import thumbnail_uploads
thumbnail_uploads.register(app, sys.modules[__name__])


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
CATALOG_ATTEMPTS = 2
CATALOG_BACKOFF_SECONDS = 0.5
CATALOG_TIMEOUT_SECONDS = 6
CATALOG_DOH_URL = "https://cloudflare-dns.com/dns-query"
# k-hentai pages are a few MB at most; a larger body means a hijack or an
# HTML error page loop, so fail instead of buffering forever.
CATALOG_MAX_BODY_BYTES = 5 * 1024 * 1024
# Successful responses live in a small TTL cache keyed by URL so repeated PC
# requests do not hit k-hentai at all. Gallery HTML embeds its own signed-URL
# expiry, and update pages are short-lived, so 60s is safely conservative.
CATALOG_CACHE_TTL_SECONDS = 60
CATALOG_CACHE_MAX_BYTES = 32 * 1024 * 1024
CATALOG_CACHE_MAX_ENTRIES = 128
CATALOG_CURSOR_MAX = 9223372036854775807
from threading import Lock as _CatalogCacheLock

# Dict insertion order is the LRU order; hits move to the end without renewing TTL.
_catalog_cache: dict[str, tuple[float, int, bytes]] = {}
_catalog_cache_lock = _CatalogCacheLock()


def _catalog_cache_expire(now: float) -> None:
    """Called only with the cache lock held, on reads and after slow fetches."""
    for key, (created, _, _) in list(_catalog_cache.items()):
        if now - created >= CATALOG_CACHE_TTL_SECONDS:
            del _catalog_cache[key]


def _catalog_fetch_once(url: str) -> tuple[int, bytes]:
    """Fetch through bounded curl and authenticated DoH resolution."""
    marker = b"\nLAKOMICS_HTTP_STATUS:"
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--location",
        "--max-redirs",
        "3",
        "--connect-timeout",
        str(CATALOG_TIMEOUT_SECONDS),
        "--max-time",
        str(CATALOG_TIMEOUT_SECONDS),
        "--max-filesize",
        str(CATALOG_MAX_BODY_BYTES + 1),
        "--doh-url",
        CATALOG_DOH_URL,
        "--header",
        f"User-Agent: {CATALOG_UA}",
        "--header",
        f"Accept-Language: {CATALOG_ACCEPT_LANGUAGE}",
        "--header",
        "Accept: text/html,application/json;q=0.9,*/*;q=0.8",
        "--output",
        "-",
        "--write-out",
        marker.decode() + "%{http_code}",
        url,
    ]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=CATALOG_TIMEOUT_SECONDS + 1,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return 0, b""

    body, separator, status_bytes = result.stdout.rpartition(marker)
    if not separator:
        return 0, b""
    try:
        status = int(status_bytes)
    except ValueError:
        return 0, b""
    if len(body) > CATALOG_MAX_BODY_BYTES:
        return status, body
    if result.returncode != 0:
        return 0, b""
    return status, body


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
    with _catalog_cache_lock:
        _catalog_cache_expire(now)
        cached = _catalog_cache.pop(url, None)
        if cached is not None:
            _catalog_cache[url] = cached
            _, status, body = cached
            return Response(content=body, status_code=status, media_type="text/html")
    status, body = _catalog_fetch_with_retry(url)
    if status == 0:
        raise HTTPException(
            status_code=502,
            detail="k-hentai temporarily unavailable (DNS/connect/timeout)",
        )
    if status >= 500:
        raise HTTPException(status_code=502, detail=f"k-hentai unreachable (upstream status {status})")
    if status == 404:
        raise HTTPException(status_code=404, detail="work not found on k-hentai")
    if status in (403, 429, 451):
        # Cloudflare/bot 차단 가능성이 있는 403/429/451은 원인을 구분해 노출한다.
        # 상태 코드 외에 민감한 정보(토큰·헤더)는 응답에 포함하지 않는다.
        raise HTTPException(status_code=502, detail=f"k-hentai rejected the request (upstream status {status})")
    if status != 200 or not body:
        raise HTTPException(status_code=502, detail=f"k-hentai returned HTTP {status} with no content")
    if len(body) > CATALOG_MAX_BODY_BYTES:
        raise HTTPException(status_code=502, detail="k-hentai response too large")
    with _catalog_cache_lock:
        finished = time.monotonic()
        _catalog_cache_expire(finished)
        if (finished - now < CATALOG_CACHE_TTL_SECONDS
                and len(body) <= CATALOG_CACHE_MAX_BYTES and CATALOG_CACHE_MAX_ENTRIES > 0):
            _catalog_cache.pop(url, None)
            _catalog_cache[url] = (now, status, body)
            total = sum(len(entry[2]) for entry in _catalog_cache.values())
            while total > CATALOG_CACHE_MAX_BYTES or len(_catalog_cache) > CATALOG_CACHE_MAX_ENTRIES:
                oldest = next(iter(_catalog_cache))
                total -= len(_catalog_cache.pop(oldest)[2])
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


def _catalog_refresh_page(language, cursor):
    # Reuse bounded provider transport without making a request to our own API.
    query = f"search=language%3A{language}"
    if cursor is not None:
        query += f"&next-id={cursor}"
    return _catalog_cached_get(f"{KHENTAI_ORIGIN}/ajax/search?{query}").body


@app.get("/v1/catalog/gallery/{work_id}")
def catalog_gallery(work_id: int, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    if work_id <= 0:
        raise HTTPException(status_code=400, detail="work id must be a positive id")
    return _catalog_cached_get(f"{KHENTAI_ORIGIN}/r/{work_id}")


# --- Mobile Capture Inbox v1 -----------------------------------------------


from capture_store import (
    CaptureDownloadError as CaptureDownloadError,
    CaptureValidationError as CaptureValidationError,
    delete_r2_object as delete_r2_object,
    fetch_media_to_r2 as fetch_media_to_r2,
)
from r2 import R2_BUCKET, _s3, presign_get


import capture_routes
from capture_routes import (
    CaptureCreate as CaptureCreate,
    CaptureAcknowledge as CaptureAcknowledge,
    _classification_is_live_for_capture as _classification_is_live_for_capture,
    valid_capture_source_url as valid_capture_source_url,
    create_capture as create_capture,
    pending_capture_payload as pending_capture_payload,
    list_pending_captures as list_pending_captures,
    captures_status_head as captures_status_head,
    confirm_extension_capture as confirm_extension_capture,
    capture_download_ticket as capture_download_ticket,
    list_captures as list_captures,
    mark_capture_imported as mark_capture_imported,
    mark_capture_imported_state as mark_capture_imported_state,
    acknowledge_capture_imported as acknowledge_capture_imported,
)


@lifecycle(app).on_startup
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
                    CHECK (media_type IN ('image', 'video', 'animated_gif')),
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
        table_sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='captures'").fetchone()
        if table_sql and "animated_gif" not in (table_sql["sql"] or ""):
            db.execute("ALTER TABLE captures RENAME TO captures_legacy_gif")
            db.execute(
                """
                CREATE TABLE captures (
                    id TEXT PRIMARY KEY, source_url TEXT NOT NULL, media_url TEXT NOT NULL,
                    classification_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
                    content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, published_at TEXT,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'imported')),
                    created_at TEXT NOT NULL, imported_at TEXT,
                    media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video','animated_gif')),
                    UNIQUE(source_url, media_url, classification_id)
                )
                """
            )
            db.execute(
                "INSERT INTO captures SELECT id,source_url,media_url,classification_id,object_key,content_type,size_bytes,published_at,status,created_at,imported_at,media_type FROM captures_legacy_gif"
            )
            db.execute("DROP TABLE captures_legacy_gif")
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_captures_status_created
            ON captures(status, created_at)
            """
        )
        if "sha256" not in {row["name"] for row in db.execute("PRAGMA table_info(captures)")}:
            db.execute("ALTER TABLE captures ADD COLUMN sha256 TEXT")
            db.execute("ALTER TABLE captures ADD COLUMN promotion_state TEXT")
        db.commit()


@lifecycle(app).on_startup
def startup_classifications():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS classification_snapshots (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                payload TEXT NOT NULL,
                published_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(classification_snapshots)")}
        if "revision" not in columns:
            db.execute("ALTER TABLE classification_snapshots ADD COLUMN revision INTEGER NOT NULL DEFAULT 1")
        db.commit()


@lifecycle(app).on_startup
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


import extension_profile
from extension_profile import (
    PAIRING_TTL_SECONDS as PAIRING_TTL_SECONDS,
    MAX_EXTENSION_PROFILE_BYTES as MAX_EXTENSION_PROFILE_BYTES,
    MAX_EXTENSION_PROFILE_IDS as MAX_EXTENSION_PROFILE_IDS,
    _extension_public_origin as _extension_public_origin,
    ExtensionPairExchange as ExtensionPairExchange,
    ExtensionProfilePatch as ExtensionProfilePatch,
    _read_extension_profile as _read_extension_profile,
    _validate_profile_ids as _validate_profile_ids,
    _validate_list_order as _validate_list_order,
    _classification_entries as _classification_entries,
    _classification_snapshot as _classification_snapshot,
    create_extension_pairing as create_extension_pairing,
    exchange_extension_pairing as exchange_extension_pairing,
    extension_bootstrap as extension_bootstrap,
    get_extension_profile as get_extension_profile,
    patch_extension_profile as patch_extension_profile,
    revoke_current_extension_client as revoke_current_extension_client,
    revoke_extension_client as revoke_extension_client,
)


@lifecycle(app).on_startup
def startup_extension_profile():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS extension_pairings (
                secret_hash TEXT PRIMARY KEY,
                expires_at TEXT NOT NULL,
                used_at TEXT
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS extension_clients (
                id TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_seen_at TEXT,
                revoked_at TEXT
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS extension_profiles (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                revision INTEGER NOT NULL CHECK(revision>=1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        default_payload = json.dumps({
            "schemaVersion": 1,
            "pinnedClassificationIds": [],
            "listOrder": {},
            "preferences": {"autoLikeOnSave": True, "xTranslateEnabled": True},
        }, separators=(",", ":"), sort_keys=True)
        db.execute(
            "INSERT OR IGNORE INTO extension_profiles(singleton,revision,payload,updated_at) VALUES(1,1,?,?)",
            (default_payload, now_iso()),
        )
        db.commit()


extension_profile.register(app, sys.modules[__name__])


import media_tickets
from media_tickets import (
    METADATA_BACKUP_OBJECT_KEY as METADATA_BACKUP_OBJECT_KEY,
    METADATA_BACKUP_TICKET_TTL_SECONDS as METADATA_BACKUP_TICKET_TTL_SECONDS,
    get_library_metadata_backup as get_library_metadata_backup,
    MEDIA_TICKET_TTL_SECONDS as MEDIA_TICKET_TTL_SECONDS,
    MediaTicketRequest as MediaTicketRequest,
    _ticket_head as _ticket_head,
    _persist_thumbnail_metadata as _persist_thumbnail_metadata,
    _ticket_digest as _ticket_digest,
    create_mobile_media_ticket as create_mobile_media_ticket,
    MAX_MEDIA_TICKET_BATCH as MAX_MEDIA_TICKET_BATCH,
    MediaTicketBatchItem as MediaTicketBatchItem,
    MediaTicketBatchRequest as MediaTicketBatchRequest,
    create_mobile_media_tickets as create_mobile_media_tickets,
)


media_tickets.register_metadata_backup(app, sys.modules[__name__])


capture_routes.register(app, sys.modules[__name__])


import library_snapshots
from library_snapshots import (
    MAX_LEGACY_SNAPSHOT_BYTES as MAX_LEGACY_SNAPSHOT_BYTES,
    publish_classification_snapshot as publish_classification_snapshot,
    get_classification_snapshot as get_classification_snapshot,
    classification_snapshot_meta as classification_snapshot_meta,
    MAX_SAVED_X_MEDIA_KEYS as MAX_SAVED_X_MEDIA_KEYS,
    MAX_SAVED_X_MEDIA_KEY_BYTES as MAX_SAVED_X_MEDIA_KEY_BYTES,
    MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES as MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES,
    SavedXMediaKey as SavedXMediaKey,
    SavedXMediaSnapshotPublish as SavedXMediaSnapshotPublish,
    publish_saved_x_media_snapshot as publish_saved_x_media_snapshot,
    get_saved_x_media_snapshot as get_saved_x_media_snapshot,
)


library_snapshots.register(app, sys.modules[__name__])


# --- CLOUD-006 Batch 4: replicated mobile library reads --------------------

import library_assets
from library_assets import (
    MOBILE_LIBRARY_DEFAULT_LIMIT as MOBILE_LIBRARY_DEFAULT_LIMIT,
    MOBILE_LIBRARY_MAX_LIMIT as MOBILE_LIBRARY_MAX_LIMIT,
    encode_mobile_cursor as encode_mobile_cursor,
    decode_mobile_cursor as decode_mobile_cursor,
    list_mobile_classifications as list_mobile_classifications,
    mobile_tree_membership as mobile_tree_membership,
    _authority_memberships as _authority_memberships,
    _classified_asset_sql as _classified_asset_sql,
    list_mobile_classification_assets as list_mobile_classification_assets,
    _summary_now as _summary_now,
    _summary_bound as _summary_bound,
    mobile_library_summary as mobile_library_summary,
    _optional_dimension as _optional_dimension,
    _optional_duration_ms as _optional_duration_ms,
    mobile_asset_item as mobile_asset_item,
    _mobile_memberships as _mobile_memberships,
    list_mobile_library_trash as list_mobile_library_trash,
)


import library_revisit
from library_revisit import (
    encode_revisit_date_cursor as encode_revisit_date_cursor,
    decode_revisit_date_cursor as decode_revisit_date_cursor,
    _revisit_creator_exclusion_sql as _revisit_creator_exclusion_sql,
    _revisit_calendar_distance_sql as _revisit_calendar_distance_sql,
    _revisit_date_bundle as _revisit_date_bundle,
    _revisit_creator_groups as _revisit_creator_groups,
    list_mobile_revisit as list_mobile_revisit,
    list_mobile_revisit_date as list_mobile_revisit_date,
    list_mobile_revisit_creator_assets as list_mobile_revisit_creator_assets,
)


library_assets.register(app, sys.modules[__name__])


library_revisit.register(app, sys.modules[__name__])


media_tickets.register(app, sys.modules[__name__])


library_assets.register_trash(app, sys.modules[__name__])


import asset_replication
from asset_replication import (
    ALLOWED_KINDS as ALLOWED_KINDS,
    MAX_ASSET_DIMENSION as MAX_ASSET_DIMENSION,
    MAX_ASSET_DURATION_MS as MAX_ASSET_DURATION_MS,
    ReplicationVariant as ReplicationVariant,
    ReplicationPrepare as ReplicationPrepare,
    ReplicationCommit as ReplicationCommit,
    replication_variant_keys as replication_variant_keys,
    _replication_row as _replication_row,
    replication_prepare as replication_prepare,
    replication_commit as replication_commit,
)


asset_replication.register(app, sys.modules[__name__])


import album_replica
from album_replica import (
    AlbumReplicaEntry as AlbumReplicaEntry,
    AlbumReplicaMedia as AlbumReplicaMedia,
    AlbumReplicaMembership as AlbumReplicaMembership,
    AlbumReplicaPublish as AlbumReplicaPublish,
    publish_album_replica as publish_album_replica,
    read_album_replica as read_album_replica,
)


@lifecycle(app).on_startup
def startup_album_replica():
    with get_db() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS album_replica (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            payload TEXT NOT NULL, published_at TEXT NOT NULL
        )""")
        db.commit()


album_replica.register(app, sys.modules[__name__])


# Collections are a separate read replica; provider artwork never enters assets.
from notes import register_notes

startup_notes = register_notes(app, get_db, require_auth)

from mobile_collections import register_collections
from mobile_catalog import register_mobile_catalog
from api_auth import client_guard, publisher_guard

require_client = client_guard(get_db, API_TOKEN)
require_publisher = publisher_guard(get_db)

import av_lookup_requests

startup_av_lookup_requests = av_lookup_requests.register(
    app, get_db, require_admin_or_extension, require_publisher, require_client=require_client)

startup_mobile_catalog = register_mobile_catalog(
    app, get_db, require_auth, lambda: DB_PATH.parent / "mobile-catalog", lambda: API_TOKEN,
    lambda work_id: _catalog_cached_get(f"{KHENTAI_ORIGIN}/r/{work_id}").body.decode("utf-8"),
    refresh_fetcher=_catalog_refresh_page,
    require_client=require_client, require_publisher=require_publisher,
)

# Manga Catalog duplicate-edition candidates (PC-published) and shared review decisions.
# Startup only creates empty tables; the refresh worker checks the works it adds.
import catalog_duplicates

startup_catalog_duplicates = catalog_duplicates.register(app, get_db, require_client, require_publisher)

# HOME-DASH-001 / ARTIST-001: PC-published Home documents (발매 예정 + wishlist intents,
# 오늘의 AV 배우) and the artist list, plus the ticket for the Home covers they reference.
# Startup only creates empty tables.
import home_av_pick
import home_publications
import home_upcoming
import library_artists
import library_search

# Late-bound like the Collection routes, so the shared token is read per request.
def _home_client(authorization):
    return client_guard(get_db, API_TOKEN)(authorization)


lifecycle(app).on_startup(home_upcoming.register(app, get_db, _home_client, require_publisher))
lifecycle(app).on_startup(home_av_pick.register(app, get_db, _home_client, require_publisher))
lifecycle(app).on_startup(library_artists.register(app, get_db, _home_client, require_publisher))
home_publications.register_cover_tickets(app, get_db, _home_client, presign_get)

from r2 import presign_put as _collection_presign_put

startup_mobile_collections = register_collections(
    app, get_db, require_auth, lambda: _s3, lambda: R2_BUCKET,
    presign_get, _collection_presign_put,
    # Late-bound like the character routes, so the shared token is read per request.
    require_client=lambda authorization: client_guard(get_db, API_TOKEN)(authorization),
    require_publisher=require_publisher,
)

from mobile_characters import register_characters

startup_mobile_characters = register_characters(
    app, get_db, require_auth, mobile_asset_item, _mobile_memberships,
    list_generation=list_generation,
    require_client=lambda authorization: client_guard(get_db, API_TOKEN)(authorization),
    require_publisher=require_publisher,
)

# Aggregate authority discovery. Read-only: it reports which domains already have
# an authority row and never activates or migrates one. Registered after the domain
# modules so the same startup ordering still creates `authority_domains` first.
from sync_status import register_sync_status

# File exchange (보내기/받기, docs/research/file-exchange-design-20260924.md): separate
# from the Library, own R2 prefix `exchange/`. Off until the PC and Android clients ship.
EXCHANGE_ENABLED = os.environ.get("LAKOMICS_EXCHANGE_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")
if EXCHANGE_ENABLED:
    import file_exchange
    from r2 import presign_put as _exchange_presign_put

    startup_file_exchange = file_exchange.register(
        app, get_db, require_client, lambda: _s3, lambda: R2_BUCKET, _exchange_presign_put)
    _exchange_sweeper = file_exchange.ExchangeSweeper(get_db, lambda: _s3, lambda: R2_BUCKET)
    lifecycle(app).on_startup(_exchange_sweeper.start)
    lifecycle(app).on_shutdown(_exchange_sweeper.stop)

import character_exclusions
import character_review
import collection_bindings
import collection_personal_edits
import collection_releases
import mobile_catalog
import mobile_characters
import mobile_collections
import notes
import similarity_review


def publisher_log_heads(db):
    """``publisherLogs``: the head of every log the PC publisher polls (publisher role only)."""
    return {"characterExclusions": character_exclusions.status_head(db),
            "characterReviewDecisions": character_review.status_head(db),
            "similarityDecisions": similarity_review.status_head(db),
            "catalogDuplicateDecisions": catalog_duplicates.status_head(db),
            "releaseReads": collection_releases.status_head(db),
            "bindings": collection_bindings.status_head(db),
            "personalEdits": collection_personal_edits.status_head(db),
            "captures": captures_status_head(db),
            "upcomingIntents": home_upcoming.status_head(db)}


def status_signals(db):
    """``signals`` (opt-in ``?signals=1``): what the tablet's own status polls compare."""
    return {"listGeneration": list_generation(db),
            "characters": mobile_characters.status_signal(db),
            "collections": mobile_collections.status_signal(db),
            "releases": collection_releases.status_signal(db),
            "catalog": mobile_catalog.status_signal(db),
            "bindingRequests": collection_bindings.status_signal(db),
            "notes": notes.status_signal(db),
            "upcoming": home_upcoming.status_signal(db),
            "avPick": home_av_pick.status_signal(db),
            "artists": library_artists.status_signal(db)}


startup_sync_status = register_sync_status(
    app, get_db, require_client,
    exchange_status=file_exchange.status if EXCHANGE_ENABLED else None,
    publisher_logs=publisher_log_heads, signals=status_signals, write_signal=write_signal)

# Album authority. Startup only creates empty tables: the domain stays PC-owned
# until a publisher activates its epoch through the activation route, which no
# environment calls in this batch. The legacy `album-snapshot` publisher above is
# already fenced by `authority.fence_legacy_write`, which is a no-op until then.
from album_authority import register_album_authority

startup_album_authority = register_album_authority(
    app, get_db, require_client, require_publisher, asset_item=mobile_asset_item,
    list_generation=list_generation)

# Classification authority substrate (2A). Startup only creates empty tables, and
# the module deliberately ships no activation route: the domain stays PC-owned until
# a later batch stages a baseline, fences the legacy writers and activates an epoch.
# Every authority read/command route reports `authorityInactive` while no
# `authority_domains(domain='classifications')` row exists, so the legacy snapshot,
# replication and capture paths above are untouched. Structural commands require the
# publisher role; only `setAssetClassification` accepts an ordinary client credential.
from classification_authority import register_classification_authority

startup_classification_authority = register_classification_authority(
    app, get_db, require_client, require_publisher)

# Asset lifecycle authority (ADR-0038). Startup only creates empty tables, and the
# domain stays inactive — every route reports `authorityInactive`, and `promote_capture`
# refuses — until an operator activates an epoch through the activation route, which no
# environment calls in this batch. Until then the legacy PC-mediated capture and
# replication paths above are untouched: the fence is on writes, and an inactive domain
# reports no visibility opinion either.
from asset_authority import register_asset_authority

startup_asset_authority = register_asset_authority(
    app, get_db, require_client, require_publisher)

# Tag counts observe the shared lifecycle schema, including future activation.
lifecycle(app).on_startup(library_search.register(app, get_db, _home_client, require_publisher))


# Collector semicircle-menu order and hidden folders, so a reinstall restores them.
from extension_settings import register as register_extension_settings

startup_extension_settings = register_extension_settings(
    app, get_db, require_admin_or_extension, resolve_scope=lambda _principal: "primary-library")


# Install after the visibility/authority schemas. No historical Assets are enqueued.
import image_thumbnails

_image_thumbnail_worker = None


@lifecycle(app).on_startup
def startup_image_thumbnails():
    global _image_thumbnail_worker
    from r2 import thumbnail_storage_client

    with get_db() as db:
        image_thumbnails.install(db)
        db.commit()
    if _image_thumbnail_worker is None:
        _image_thumbnail_worker = image_thumbnails.ImageThumbnailWorker(
            DB_PATH, thumbnail_storage_client(), R2_BUCKET)
    _image_thumbnail_worker.start()


@lifecycle(app).on_shutdown
def shutdown_image_thumbnails():
    worker = _image_thumbnail_worker
    if worker is None:
        return

    def released():
        # Lifecycle shutdown defers the join; release the handle only once it exits.
        global _image_thumbnail_worker
        if _image_thumbnail_worker is worker:
            _image_thumbnail_worker = None

    if worker.stop(on_stopped=released):
        released()
