"""Authenticated catalog read API, independent of the legacy upstream proxy."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import re
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool
import mobile_catalog_replica as replica
from mobile_catalog_query import QueryError, parse_query, freeze_query, count_groups, search_groups, detail, editions

PREFIX = "/v1/mobile-catalog"
TTL = 24 * 60 * 60
MAX_READER_PAGES = 2000
READER_PATTERN = re.compile(r"(?is)const\s+gallery\s*=\s*(\{.*?\});\s*</script>")

def parse_reader_pages(html):
    if not isinstance(html, str) or len(html.encode("utf-8")) > 5 * 1024 * 1024:
        replica.fail(502, "Catalog pages are unavailable")
    match = READER_PATTERN.search(html)
    if not match:
        replica.fail(502, "Catalog pages are unavailable")
    try:
        payload = json.loads(match.group(1))
    except (TypeError, ValueError):
        replica.fail(502, "Catalog pages are unavailable")
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, list) or len(files) > MAX_READER_PAGES:
        replica.fail(502, "Catalog pages are unavailable")
    pages = []
    for entry in files:
        image = entry.get("image") if isinstance(entry, dict) else None
        if image is None:
            continue
        if not isinstance(image, dict) or not isinstance(image.get("url"), str) or len(image["url"]) > 16384:
            replica.fail(502, "Catalog pages are unavailable")
        try:
            url = urlsplit(image["url"])
            host = (url.hostname or "").lower()
            if url.scheme != "https" or url.username or url.password or url.fragment or url.port not in (None, 443) or not (host == "siam-cdn.net" or host.endswith(".siam-cdn.net")):
                replica.fail(502, "Catalog pages are unavailable")
        except ValueError:
            replica.fail(502, "Catalog pages are unavailable")
        width, height = image.get("width"), image.get("height")
        if width is not None and (type(width) is not int or not 1 <= width <= 50000):
            replica.fail(502, "Catalog pages are unavailable")
        if height is not None and (type(height) is not int or not 1 <= height <= 50000):
            replica.fail(502, "Catalog pages are unavailable")
        name = entry.get("name") if isinstance(entry, dict) else None
        if not isinstance(name, str) or len(name) > 1000:
            name = None
        expires = None
        raw_expiry = parse_qs(url.query).get("expires", [None])[0]
        if raw_expiry is not None:
            try:
                expires = int(raw_expiry)
            except (TypeError, ValueError):
                expires = None
        pages.append({"index": len(pages), "url": image["url"], "name": name, "width": width, "height": height, "expiresAt": expires})
    if not pages:
        replica.fail(502, "Catalog pages are unavailable")
    return pages

def normalize(params):
    allowed = {"provider", "language", "text", "sort", "scope", "revealBlocked", "limit"}
    if set(params) - allowed:
        replica.fail(400, "Unsupported catalog parameter")
    q = {"provider": "kHentai", "language": "korean", "text": "", "sort": "latest", "scope": "all", "revealBlocked": "false", "limit": "40", **dict(params)}
    if q["provider"] != "kHentai" or q["language"] not in ("all", "korean", "japanese") or q["sort"] not in ("latest", "views", "hotDay", "hotWeek", "hotMonth") or q["scope"] not in ("all", "bookmarked") or q["revealBlocked"] not in ("true", "false"):
        replica.fail(400, "Unsupported catalog query")
    try:
        q["limit"] = int(q["limit"])
        if not 1 <= q["limit"] <= 100:
            raise ValueError()
    except (ValueError, TypeError):
        replica.fail(400)
    q["revealBlocked"] = q["revealBlocked"] == "true"
    try:
        parse_query(q["text"])
    except QueryError as exc:
        raise HTTPException(422, {"code": "invalidQuery", "message": "검색식을 확인해 주세요.", "span": exc.span}) from exc
    return q

def register_mobile_catalog(app, get_db, require_auth, artifact_root, secret, gallery_fetcher=None):
    upload_lock = threading.Lock()
    def startup():
        replica.startup(get_db)
    app.on_event("startup")(startup)
    def root():
        return Path(artifact_root()).resolve()
    def sign(payload):
        encoded = base64.urlsafe_b64encode(replica.encode(payload).encode()).decode().rstrip("=")
        signature = hmac.new(secret().encode(), encoded.encode(), hashlib.sha256).hexdigest()
        return encoded + "." + signature
    def decode(token, kind):
        if not token or len(token) > 12000:
            replica.fail(400, "Invalid catalog cursor")
        try:
            encoded, signature = token.split(".")
            expected = hmac.new(secret().encode(), encoded.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            if payload["version"] != 1 or payload["kind"] != kind:
                raise ValueError()
            if payload["expires"] < time.time():
                replica.fail(409, "Catalog snapshot expired; refresh")
            return payload
        except (ValueError, KeyError, TypeError):
            replica.fail(400, "Invalid catalog cursor")
    def token(payload, kind, **updates):
        return sign({**payload, "kind": kind, **updates})
    def budget(db):
        deadline = time.monotonic() + 10
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    def unavailable(exc):
        if isinstance(exc, sqlite3.OperationalError) and "interrupted" in str(exc):
            raise HTTPException(503, "Catalog query took too long; refine the search") from exc
        raise HTTPException(503, "Catalog snapshot is temporarily unavailable") from exc

    @app.get(PREFIX + "/status")
    def status(authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            current = replica.current(db)
            manifest = db.execute("SELECT manifest FROM mobile_catalog_artifacts WHERE digest=?", [current["content_digest"]]).fetchone() if current else None
            return {"ready": bool(current), "publicationRevision": current["revision"] if current else None, "publishedAt": current["published_at"] if current else None, "sourceRevision": json.loads(manifest[0])["sourceRevision"] if manifest else None, "capabilities": {"providers": ["kHentai"], "read": True, "bookmarkWrite": False, "refreshRequest": False}}

    @app.put(PREFIX + "/replicas/{digest}")
    async def upload(digest: str, request: Request, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        replica.checked_digest(digest)
        if not upload_lock.acquire(blocking=False):
            replica.fail(409, "A catalog projection is already uploading")
        path = None
        try:
            root().mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(prefix="upload-", suffix=".ndjson", dir=root(), delete=False) as file:
                path = Path(file.name)
                size = 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > replica.MAX_CONTENT:
                        replica.fail(413)
                    file.write(chunk)
            return await run_in_threadpool(replica.import_content, path, digest, root(), get_db)
        finally:
            if path:
                path.unlink(missing_ok=True)
            upload_lock.release()

    @app.put(PREFIX + "/publication")
    async def publish(request: Request, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > replica.MAX_USERS + 4096:
                replica.fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            replica.fail()
        return await run_in_threadpool(replica.publish, body, root(), get_db)

    @app.get(PREFIX + "/search")
    def search(request: Request, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        params = dict(request.query_params)
        if "cursor" in params:
            if set(params) != {"cursor"}:
                replica.fail(400)
            payload = decode(params["cursor"], "search")
        else:
            query = normalize(params)
            with get_db() as db:
                if replica.current(db) is None:
                    return {"ready": False, "publicationRevision": None, "publishedAt": None, "items": [], "nextCursor": None, "context": None, "countToken": None, "totalCount": None, "countStatus": "unavailable"}
            payload = {"version": 1, "kind": "search", "revision": None, "query": query, "offset": 0, "expires": int(time.time()) + TTL}
        try:
            with replica.open_publication(root(), get_db, payload["revision"]) as (db, publication):
                budget(db)
                q = freeze_query(db, payload["query"])
                payload = {**payload, "revision": publication["revision"], "query": q}
                total = replica.prepared_count(db, q)
                prepared = replica.prepared_items(db, q, payload["offset"], q["limit"], total)
                if prepared is not None:
                    items = prepared
                    has_more = total is not None and payload["offset"] + len(items) < total
                else:
                    items = search_groups(db, q, payload["offset"], q["limit"] + 1)
                    has_more = (payload["offset"] + q["limit"] < total) if total is not None else len(items) > q["limit"]
                    items = items[:q["limit"]]
                next_cursor = token(payload, "search", offset=payload["offset"] + q["limit"]) if has_more else None
                count_token = None if total is not None else token(payload, "count", offset=0)
                return {"ready": True, "publicationRevision": publication["revision"], "publishedAt": publication["published_at"], "items": items, "nextCursor": next_cursor, "context": token(payload, "context", offset=0), "countToken": count_token, "totalCount": total, "countStatus": "ready" if total is not None else "pending"}
        except sqlite3.Error as exc:
            unavailable(exc)

    @app.get(PREFIX + "/count")
    def count(token: str, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        payload = decode(token, "count")
        try:
            with replica.open_publication(root(), get_db, payload["revision"]) as (db, publication):
                budget(db)
                q = payload["query"]
                n = replica.prepared_count(db, q)
                if n is None:
                    n = count_groups(db, q)
                return {"publicationRevision": publication["revision"], "totalCount": n}
        except sqlite3.Error as exc:
            unavailable(exc)

    @app.get(PREFIX + "/works/{provider}/{work_id}")
    def work(provider: str, work_id: str, context: str, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        if provider != "kHentai" or not re.fullmatch("[1-9][0-9]{0,18}", work_id) or int(work_id) > 9223372036854775807:
            replica.fail(400)
        payload = decode(context, "context")
        try:
            with replica.open_publication(root(), get_db, payload["revision"]) as (db, publication):
                budget(db)
                item = detail(db, int(work_id), payload["query"])
                if item is None:
                    replica.fail(404, "Catalog work is unavailable")
                return {"publicationRevision": publication["revision"], "item": item}
        except sqlite3.Error as exc:
            unavailable(exc)

    @app.get(PREFIX + "/works/{provider}/{work_id}/reader")
    def reader(provider: str, work_id: str, context: str, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        if provider != "kHentai" or not re.fullmatch("[1-9][0-9]{0,18}", work_id) or int(work_id) > 9223372036854775807:
            replica.fail(400)
        payload = decode(context, "context")
        try:
            with replica.open_publication(root(), get_db, payload["revision"]) as (db, publication):
                budget(db)
                if detail(db, int(work_id), payload["query"]) is None:
                    replica.fail(404, "Catalog work is unavailable")
                revision = publication["revision"]
        except sqlite3.Error as exc:
            unavailable(exc)
        if gallery_fetcher is None:
            replica.fail(503, "Catalog reader is unavailable")
        try:
            pages = parse_reader_pages(gallery_fetcher(int(work_id)))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, "Catalog pages are unavailable") from exc
        expiries = [page["expiresAt"] for page in pages if page["expiresAt"] is not None]
        return {"publicationRevision": revision, "provider": provider, "providerWorkId": work_id, "pages": pages, "manifestExpiresAt": min(expiries) if expiries else None}

    @app.get(PREFIX + "/groups/{provider}/{group_id}/editions")
    def group(provider: str, group_id: str, context: str, cursor: str | None = None, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        if provider != "kHentai" or not re.fullmatch("[A-Za-z0-9_-]{1,128}", group_id):
            replica.fail(400)
        payload = decode(context, "context")
        offset = 0
        if cursor:
            page = decode(cursor, "editions")
            if page["revision"] != payload["revision"] or page["group"] != group_id or page["query"] != payload["query"]:
                replica.fail(400)
            offset = page["offset"]
        try:
            with replica.open_publication(root(), get_db, payload["revision"]) as (db, publication):
                budget(db)
                q = payload["query"]
                result = editions(db, group_id, q, offset, q["limit"])
                if result is None:
                    replica.fail(404)
                result.update(publicationRevision=publication["revision"], nextCursor=token(payload, "editions", group=group_id, offset=offset+q["limit"]) if offset+q["limit"] < result["totalCount"] else None)
                return result
        except sqlite3.Error as exc:
            unavailable(exc)
    return startup
