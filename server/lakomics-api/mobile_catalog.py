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
import api_auth
import catalog_bookmarks
import mobile_catalog_replica as replica
from mobile_catalog_query import QueryError, parse_query, freeze_query, count_groups, search_groups, detail, editions

PREFIX = "/v1/mobile-catalog"
TTL = 24 * 60 * 60
MAX_READER_PAGES = 2000
LIBRARY_HEADER = "X-Lakomics-Library-Id"
LIBRARY_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
HEX_DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
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

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

def provider_work_id(value):
    """Exact decoded text. Never numeric-normalized: "03" and "3" stay distinct."""
    if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > catalog_bookmarks.MAX_WORK_ID:
        return None
    return value


def register_mobile_catalog(app, get_db, require_auth, artifact_root, secret, gallery_fetcher=None,
                            refresh_fetcher=None, require_client=None, require_publisher=None):
    # Backward-compatible default: existing isolated fixtures keep working with the
    # legacy guard until they pass the role-aware callbacks explicitly.
    require_client = require_client or require_auth
    require_publisher = require_publisher or require_client
    upload_lock = threading.Lock()
    def startup():
        replica.startup(get_db)
        catalog_bookmarks.startup(get_db)
        api_auth.startup(get_db)
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
    def authority_marker(snapshot):
        # Only bookmark-scoped queries bind authority identity so ordinary
        # pagination and ordering survive bookmark mutations. Library identity is
        # bound too: epoch/cursor alone can collide across libraries.
        if snapshot is None:
            return {}
        return {"authorityLibraryId": snapshot["libraryId"], "authorityEpoch": snapshot["epoch"],
                "authorityCursor": snapshot["cursor"]}
    def check_authority(payload, snapshot):
        # scope=all carries no authority markers and is never validated here.
        if payload["query"].get("scope") != "bookmarked":
            return
        present = [key for key in ("authorityLibraryId", "authorityEpoch", "authorityCursor") if key in payload]
        if snapshot is None:
            # Authority went away: a bookmark token carrying markers is stale.
            if present:
                raise HTTPException(409, "Catalog bookmarks changed; refresh")
            return
        if len(present) != 3:
            # Authority became active after this token was issued.
            raise HTTPException(409, "Catalog bookmarks changed; refresh")
        if (payload["authorityLibraryId"] != snapshot["libraryId"] or payload["authorityEpoch"] != snapshot["epoch"]
                or payload["authorityCursor"] != snapshot["cursor"]):
            raise HTTPException(409, "Catalog bookmarks changed; refresh")
    def budget(db):
        deadline = time.monotonic() + 10
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    def unavailable(exc):
        if isinstance(exc, sqlite3.OperationalError) and "interrupted" in str(exc):
            raise HTTPException(503, "Catalog query took too long; refine the search") from exc
        raise HTTPException(503, "Catalog snapshot is temporarily unavailable") from exc

    @app.get(PREFIX + "/status")
    def status(authorization: str | None = Header(default=None)):
        require_client(authorization)
        authority = catalog_bookmarks.load(get_db)
        with get_db() as db:
            current = replica.current(db)
            manifest = db.execute("SELECT manifest FROM mobile_catalog_artifacts WHERE digest=?", [current["content_digest"]]).fetchone() if current else None
            return {"ready": bool(current), "publicationRevision": current["revision"] if current else None, "publishedAt": current["published_at"] if current else None, "sourceRevision": json.loads(manifest[0])["sourceRevision"] if manifest else None, "authorityLibraryId": authority["libraryId"] if authority else None, "authorityEpoch": authority["epoch"] if authority else None, "authorityContractVersion": authority["contractVersion"] if authority else None, "authorityCursor": authority["cursor"] if authority else None, "capabilities": {"providers": ["kHentai"], "read": True, "bookmarkWrite": bool(authority), "refreshRequest": refresh_fetcher is not None}}

    @app.post(PREFIX + "/bookmark-authority/activate")
    async def activate(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 4096:
                replica.fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            replica.fail(422)
        if not isinstance(body, dict) or set(body) != {"libraryId", "expectedPublicationRevision"}:
            replica.fail(422)
        library_id = body["libraryId"]
        expected = body["expectedPublicationRevision"]
        if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
            replica.fail(422)
        if not isinstance(expected, str) or not HEX_DIGEST_PATTERN.fullmatch(expected):
            replica.fail(422)

        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    existing = catalog_bookmarks.authority_row(db)
                    if len(existing) > 1:
                        replica.fail(503, "Catalog bookmark authority is ambiguous")
                    if existing:
                        # Retry after response loss. mobile_catalog_current may have
                        # advanced past the activation baseline through an unrelated
                        # server-internal republication, so the identity of the
                        # request is checked against the immutable historical
                        # publication, not against the current pointer.
                        row = existing[0]
                        historical = db.execute(
                            "SELECT user_revision FROM mobile_catalog_publications WHERE revision=?",
                            [expected]).fetchone()
                        if row["library_id"] != library_id or row["baseline_revision"] != expected or historical is None:
                            replica.fail(409, "Catalog bookmark authority is already active")
                        payload = db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?",
                                             [historical["user_revision"]]).fetchone()
                        if payload is None:
                            replica.fail(409, "Catalog bookmark authority is already active")
                        baseline = sorted(replica.validate_users(json.loads(payload[0]))["bookmarks"], key=replica.encode)
                        if replica.digest(baseline) != row["baseline_digest"]:
                            replica.fail(409, "Catalog bookmark authority is already active")
                        state = catalog_bookmarks.public_state(row, baseline)
                        db.commit()
                        return state
                    prior = replica.current(db)
                    if prior is None or prior["revision"] != expected:
                        replica.fail(409, "Catalog publication changed; refresh before activating")
                    payload = db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?", [prior["user_revision"]]).fetchone()
                    if payload is None:
                        replica.fail(409, "Catalog user snapshot is unavailable; publish again")
                    users = replica.validate_users(json.loads(payload[0]))
                    bookmarks = sorted(users["bookmarks"], key=replica.encode)
                    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    state = catalog_bookmarks.activate(
                        db, library_id=library_id, expected_revision=expected, bookmarks=bookmarks,
                        baseline_digest=replica.digest(bookmarks), current_revision=prior["revision"], now=now)
                    db.commit()
                    return state
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/replicas/{digest}")
    async def upload(digest: str, request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
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
    async def publish(request: Request, authorization: str | None = Header(default=None),
                      library: str | None = Header(default=None, alias=LIBRARY_HEADER)):
        require_publisher(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > replica.MAX_USERS + 4096:
                replica.fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            replica.fail()
        authority = catalog_bookmarks.load(get_db)
        if authority is not None and (library is None or library != authority["libraryId"]):
            # Fast rejection only. The real fence runs inside replica.publish's
            # commit transaction.
            replica.fail(409, "Catalog publication library does not match the active authority")
        return await run_in_threadpool(replica.publish, body, root(), get_db,
                                       external_publisher=True, publisher_library_id=library)

    def authority_read(db, library_id, epoch):
        return catalog_bookmarks.require_authority(db, library_id, epoch)

    @app.get(PREFIX + "/bookmarks")
    async def bookmarks(request: Request, libraryId: str, epoch: int,
                        authorization: str | None = Header(default=None)):
        require_client(authorization)
        # The snapshot is unpaginated: any extra parameter is a caller bug, not a
        # silently ignored hint.
        if set(request.query_params) != {"libraryId", "epoch"}:
            replica.fail(422)
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            replica.fail(422)
        def run():
            with get_db() as db:
                row = authority_read(db, libraryId, epoch)
                items = catalog_bookmarks.snapshot_items(db, libraryId, epoch)
                # The baseline is unpaginated by contract, so it is bounded by its
                # encoded size and fails explicitly rather than returning a subset
                # a client would treat as complete.
                return catalog_bookmarks.encode_snapshot(
                    row["library_id"], row["epoch"], row["contract_version"],
                    row["change_cursor"], items)
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/bookmarks/changes")
    async def bookmark_changes(request: Request, libraryId: str, epoch: int, after: int = 0, limit: int = 100,
                               authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "after", "limit"}:
            replica.fail(422)
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            replica.fail(422)
        if after < 0 or not 1 <= limit <= 500:
            replica.fail(422)
        def run():
            with get_db() as db:
                row = authority_read(db, libraryId, epoch)
                cursor = row["change_cursor"]
                if after > cursor:
                    # A cursor beyond the server is authority skew (an older server
                    # state), not retention: a fresh baseline resolves both, but the
                    # distinction matters for the client's error surface.
                    replica.fail(409, "Change cursor is beyond the authority cursor")
                # Retention floor: a cursor at or below the pruned floor has a real
                # gap behind it. Reporting it as "no changes" would silently drop
                # every mutation in that window, so it is an explicit expiry the
                # client must resolve with a fresh baseline.
                if after < catalog_bookmarks.pruned_through(db, libraryId, epoch):
                    raise catalog_bookmarks.expired_cursor(row)
                items = catalog_bookmarks.change_items(db, libraryId, epoch, after, limit)
                next_after = items[-1]["sequence"] if items else after
                return {"libraryId": row["library_id"], "epoch": row["epoch"],
                        "contractVersion": row["contract_version"], "cursor": cursor,
                        "items": items, "nextAfter": next_after, "hasMore": next_after < cursor}
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/bookmarks/{provider}/{work_id}")
    async def bookmark_command(provider: str, work_id: str, request: Request,
                               authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 4096:
                replica.fail(413)
            body.extend(chunk)
        try:
            command = json.loads(body)
        except (ValueError, UnicodeError):
            replica.fail(422)
        if provider not in catalog_bookmarks.PROVIDERS:
            replica.fail(422)
        exact_work_id = provider_work_id(work_id)
        if exact_work_id is None:
            replica.fail(422)
        expected_keys = {"libraryId", "epoch", "contractVersion", "operationId", "expectedRevision", "desiredState"}
        if not isinstance(command, dict) or set(command) != expected_keys:
            replica.fail(422)
        library_id = command["libraryId"]
        epoch = command["epoch"]
        contract_version = command["contractVersion"]
        operation_id = command["operationId"]
        expected_revision = command["expectedRevision"]
        desired_state = command["desiredState"]
        if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
            replica.fail(422)
        # An unknown contract version is a malformed request, not a state
        # conflict: reject it before touching authority state.
        if type(epoch) is not int or epoch < 1 or type(contract_version) is not int \
                or contract_version != catalog_bookmarks.CONTRACT_VERSION:
            replica.fail(422)
        if not isinstance(operation_id, str) or not UUID_PATTERN.fullmatch(operation_id):
            replica.fail(422)
        if type(expected_revision) is not int or expected_revision < 0:
            replica.fail(422)
        if type(desired_state) is not bool:
            replica.fail(422)

        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    result = catalog_bookmarks.apply_command(
                        db, library_id=library_id, epoch=epoch, contract_version=contract_version,
                        provider=provider, work_id=exact_work_id, desired_state=desired_state,
                        expected_revision=expected_revision, operation_id=operation_id, now=now)
                    db.commit()
                    return result
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/visibility")
    async def update_visibility(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > replica.MAX_USERS:
                replica.fail(413)
            data.extend(chunk)
        try:
            policy = json.loads(data)
        except (ValueError, UnicodeError):
            replica.fail()
        if not isinstance(policy, dict) or set(policy) != {"hiddenCategories", "blockedTags"}:
            replica.fail()
        def publish_policy():
            for attempt in range(3):
                with get_db() as db:
                    current = replica.current(db)
                    if not current:
                        replica.fail(409, "Publish the catalog once before syncing settings")
                    current = dict(current)
                    users = json.loads(db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?", [current["user_revision"]]).fetchone()[0])
                changed = any(users[key] != value for key, value in policy.items())
                users.update(policy)
                replica.validate_users(users)
                if not changed:
                    return {"publicationRevision": current["revision"], "publishedAt": current["published_at"]}
                try:
                    return replica.publish({"version": 1, "baseRevision": current["revision"], "contentDigest": current["content_digest"], "userSnapshot": users}, root(), get_db)
                except HTTPException as error:
                    if error.status_code != 409 or attempt == 2:
                        raise
        return await run_in_threadpool(publish_policy)

    @app.get(PREFIX + "/search")
    def search(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        params = dict(request.query_params)
        authority = catalog_bookmarks.load(get_db)
        if "cursor" in params:
            if set(params) != {"cursor"}:
                replica.fail(400)
            payload = decode(params["cursor"], "search")
            check_authority(payload, authority)
        else:
            query = normalize(params)
            with get_db() as db:
                if replica.current(db) is None:
                    return {"ready": False, "publicationRevision": None, "publishedAt": None, "items": [], "nextCursor": None, "context": None, "countToken": None, "totalCount": None, "countStatus": "unavailable"}
            payload = {"version": 1, "kind": "search", "revision": None, "query": query, "offset": 0, "expires": int(time.time()) + TTL}
            if query["scope"] == "bookmarked":
                payload.update(authority_marker(authority))
        try:
            with replica.open_publication(root(), get_db, payload["revision"], authority) as (db, publication):
                budget(db)
                q = freeze_query(db, payload["query"])
                payload = {**payload, "revision": publication["revision"], "query": q}
                total = replica.prepared_count(db, q)
                prepared = replica.prepared_items(db, q, payload["offset"], q["limit"], total)
                if prepared is not None:
                    items = catalog_bookmarks.patch_items(db, prepared) if authority else prepared
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
        require_client(authorization)
        payload = decode(token, "count")
        authority = catalog_bookmarks.load(get_db)
        check_authority(payload, authority)
        try:
            with replica.open_publication(root(), get_db, payload["revision"], authority) as (db, publication):
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
        require_client(authorization)
        if provider != "kHentai" or not re.fullmatch("[1-9][0-9]{0,18}", work_id) or int(work_id) > 9223372036854775807:
            replica.fail(400)
        payload = decode(context, "context")
        authority = catalog_bookmarks.load(get_db)
        check_authority(payload, authority)
        # The client composes `expectedRevision` from this. It is read in its own
        # short transaction; a base newer than the context token is still
        # validated by the command's compare-and-set, so it can only cause a
        # refusal the client already recovers from, never a wrong write.
        bookmark_revision = 0
        if authority is not None:
            with get_db() as bookmarks_db:
                bookmark_revision = catalog_bookmarks.entity_revision(
                    bookmarks_db, authority["libraryId"], "kHentai", work_id)
        try:
            with replica.open_publication(root(), get_db, payload["revision"], authority) as (db, publication):
                budget(db)
                item = detail(db, int(work_id), payload["query"])
                if item is None:
                    replica.fail(404, "Catalog work is unavailable")
                item["bookmarkRevision"] = bookmark_revision
                return {"publicationRevision": publication["revision"], "item": item}
        except sqlite3.Error as exc:
            unavailable(exc)

    @app.get(PREFIX + "/works/{provider}/{work_id}/reader")
    def reader(provider: str, work_id: str, context: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        if provider != "kHentai" or not re.fullmatch("[1-9][0-9]{0,18}", work_id) or int(work_id) > 9223372036854775807:
            replica.fail(400)
        payload = decode(context, "context")
        authority = catalog_bookmarks.load(get_db)
        check_authority(payload, authority)
        try:
            with replica.open_publication(root(), get_db, payload["revision"], authority) as (db, publication):
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
        require_client(authorization)
        if provider != "kHentai" or not re.fullmatch("[A-Za-z0-9_-]{1,128}", group_id):
            replica.fail(400)
        payload = decode(context, "context")
        authority = catalog_bookmarks.load(get_db)
        check_authority(payload, authority)
        offset = 0
        if cursor:
            page = decode(cursor, "editions")
            if page["revision"] != payload["revision"] or page["group"] != group_id or page["query"] != payload["query"]:
                replica.fail(400)
            offset = page["offset"]
        try:
            with replica.open_publication(root(), get_db, payload["revision"], authority) as (db, publication):
                budget(db)
                q = payload["query"]
                result = editions(db, group_id, q, offset, q["limit"])
                if result is None:
                    replica.fail(404)
                result.update(publicationRevision=publication["revision"], nextCursor=token(payload, "editions", group=group_id, offset=offset+q["limit"]) if offset+q["limit"] < result["totalCount"] else None)
                return result
        except sqlite3.Error as exc:
            unavailable(exc)
    if refresh_fetcher is not None:
        from mobile_catalog_refresh import register_refresh
        register_refresh(app, get_db, root, require_client, refresh_fetcher)
    return startup
