"""Connect a manga Collection to MangaDex / Kakao from the tablet (decided 2026-09-26).

SEARCH runs here, so the tablet can search and pick while the PC is off. APPLYING the
binding (volumes, covers, release data) stays on the PC: the tablet files a bind
request, the PC reads the request log when it is on, runs its existing apply command
and reports the outcome. The server never fetches images and never writes a binding.

The candidates mirror the PC exactly so the PC can apply the tablet's pick unchanged:

* MangaDex - ``library/mangadex.rs`` ``search_url``/``parse_search``: ``GET
  https://api.mangadex.org/manga?title=<q>&limit=20&includes[]=cover_art&includes[]=author
  &includes[]=artist``; title by locale priority ``ko, en, ja-ro, ja``; the PC applies
  ``apply_mangadex({"target": {"kind": "existing", "collectionId"}, "mangaId"})``.
* Kakao - ``library/kakao_books.rs`` + ``aladin_flow.rs``: every page of
  ``GET https://dapi.kakao.com/v3/search/book?query=<q>&target=title&sort=latest&size=50
  &page=n`` (``Authorization: KakaoAK <key>``, at most 50 pages, an unfinished search is
  refused), titles parsed by ``aladin.rs parse_volume_product``, items grouped by
  normalized (base title, author, publisher). The PC applies ``apply_kakao({"collectionId",
  "query", "anchorItemId", "groupFingerprint"})``: it re-runs the same search with
  ``query`` and binds the group whose anchor and fingerprint match, storing
  ``provider_config_json = {"version": 1, "query", "groupFingerprint", "knownItemIds"}``.
  ``knownItemIds`` is computed by the PC from the group at apply time; the server returns
  it only for display/diagnostics.

The PC has no disconnect command for MangaDex or Kakao, so there is no unbind request.

All routes are JSON. Errors are ``{"detail": {"code", "message"}}`` with Korean messages
(401 from the auth guards is ``{"detail": "Unauthorized"}``). Routes are registered by
``mobile_collections.register_collections`` before ``GET /v1/collections/{collection_id}``.

Configuration
-------------
``LAKOMICS_KAKAO_REST_KEY`` - the Kakao REST API key (same key type the PC stores). Read
from the process environment on every Kakao search (a systemd drop-in ``Environment=`` or
``EnvironmentFile=`` line; restart the service after changing it). Sent only to
dapi.kakao.com in the ``Authorization`` header; never logged, echoed or cached. Unset or
malformed -> Kakao search answers ``503 kakaoSearchUnavailable`` and the status reports
``kakaoSearch: false``. MangaDex needs no key.

Outbound hosts: only ``api.mangadex.org`` and ``dapi.kakao.com`` are contacted (HTTPS, no
redirects, no proxy environment, per-request timeouts, response size caps).
``uploads.mangadex.org`` appears only in returned cover URLs.

1. ``GET /v1/collections/bindings/status`` (client)
   ``{"version": 1, "mangadexSearch": true, "kakaoSearch": bool, "bindRequests": true,
   "publisherSeenAt": str|null}``. ``publisherSeenAt`` is the last time a publisher (PC)
   read the bind-request log - null means no PC build that applies requests has run yet.
   ``/v1/collections/status`` carries the same flags as ``collectionBindings``.

2. ``GET /v1/collections/bindings/search/mangadex?query=<2-100 chars>`` (client)
   ``{"version": 1, "provider": "mangadex", "query": <trimmed>, "items": [
   {"mangaId", "title", "alternateTitles": [str], "author": str|null, "year": int|null,
   "status": str|null, "primaryCoverFileName": str|null, "coverUrl": str|null}]}`` (<= 20,
   MangaDex order). ``coverUrl`` = ``https://uploads.mangadex.org/covers/<mangaId>/<file>.256.jpg``
   (MangaDex's 256 px thumbnail; load it directly from the tablet). A malformed item is
   skipped rather than failing the whole search.

3. ``GET /v1/collections/bindings/search/kakao?query=<2-100 chars>`` (client)
   ``{"version": 1, "provider": "kakao", "query": <trimmed>, "items": [
   {"anchorItemId", "groupFingerprint", "title", "author": str|null, "publisher": str|null,
   "volumes": [{"volumeNumber", "providerItemId", "title", "publicationDate": str|null,
   "isbn13": str|null}], "ignoredCount", "volumeCount", "firstVolume": int|null,
   "lastVolume": int|null, "knownItemIds": [str], "thumbnailUrl": str|null}]}`` - the PC's
   ``AladinSeriesCandidate`` plus display fields, in the PC's group order. The tablet must
   send back ``query`` (as returned) with the group's ``anchorItemId``/``groupFingerprint``.
   ``thumbnailUrl`` is Kakao's (https) thumbnail of the group's lowest volume.

   Search errors (both providers): ``422 invalidBindSearch`` (query length),
   ``429 bindSearchRateLimited`` (this client's per-minute limit, or the global Kakao page
   budget is used up), ``429 bindSearchBusy`` (another search of the same provider is
   running right now; "검색 중이에요, 잠시 후 다시") - both with ``retryAfter`` seconds and
   a ``Retry-After`` header - ``503 kakaoSearchUnavailable`` (no key configured), ``503
   kakaoCredentialRejected`` (Kakao answered 401/403), ``503 bindSearchUpstreamRateLimited``
   (provider 429), ``504 bindSearchTimedOut`` (a page or the whole Kakao crawl ran past its
   deadline), ``502 bindSearchUpstreamFailed``, ``502 bindSearchInvalidResponse``, ``422
   kakaoSearchTooBroad`` (more than 50 pages; the PC would refuse it too - use a more
   specific title). Each error carries ``provider``. ``kakaoSearchTooBroad`` and
   ``bindSearchInvalidResponse`` are cached like results (same query, ``CACHE_TTL``).

4. ``POST /v1/collections/bindings/requests`` (client)
   Body ``{"version": 1, "operationId": <UUID>, "collectionId": id, "provider":
   "mangadex"|"kakao", "choice": {...}, "expected": {"externalId": str|null}?}`` (<= 16 KiB).
   * MangaDex choice: ``{"mangaId": <UUID>, "title": str(1-500), "coverUrl": str|null?}``.
     The PC runs ``apply_mangadex`` with ``target = existing collectionId``.
   * Kakao choice: ``{"query": str(2-100, trimmed), "anchorItemId": str(1-128),
     "groupFingerprint": 64 lowercase hex, "title": str(1-500), "author": str|null?,
     "publisher": str|null?, "volumeCount": int|null?, "thumbnailUrl": str|null?}``.
     The PC runs ``apply_kakao({collectionId, query, anchorItemId, groupFingerprint})``.
   * ``title``/``coverUrl``/``author``/``publisher``/``volumeCount``/``thumbnailUrl`` are
     display-only (the tablet shows what is waiting); the PC ignores them.
   * ``expected.externalId`` (optional) is the binding the tablet saw (MangaDex ``mangaId``,
     Kakao anchor item id, null = unbound). The PC should fail the request with reason
     ``bindingChanged`` when its current binding differs.
   Only manga Collections the server currently serves: ``404 collectionNotFound``,
   ``409 collectionNotManga``. One pending request per (collection, provider): a newer
   request marks the pending one ``superseded`` (its ``replaces`` names it). Idempotent by
   ``operationId``: the same body returns the request's current state, another body is
   ``409 operationConflict``. At most ``MAX_PENDING`` pending requests (``409
   bindRequestLimit``). Errors: ``422 invalidBindRequest``, ``413 bindRequestTooLarge``.
   Reply ``{"version": 1, "request": Request}``.

   Request = ``{"requestId": int, "operationId", "collectionId", "provider", "choice",
   "expected": obj|null, "state": "pending"|"applied"|"failed"|"superseded",
   "reason": {"code", "message"}|null, "replaces": int|null, "createdAt", "updatedAt",
   "resolvedAt": str|null}``. ``requestId`` is the log sequence (strictly increasing).

5. ``GET /v1/collections/bindings/requests?collectionId=&state=&limit=`` (client)
   Newest first. ``collectionId`` optional, ``state`` ``all`` (default) | ``pending``,
   ``limit`` 1-50 (default 20); malformed values are ``422 invalidBindRequest``. Reply ``{"version": 1, "items": [Request],
   "pending": {"mangadex": Request|null, "kakao": Request|null}|null}`` (``pending`` only
   with ``collectionId``: show "연결 대기 (PC가 켜지면 적용)"). ETag / ``If-None-Match``.

6. ``GET /v1/collections/bindings/log?after=<int>&limit=<1-200, default 100>`` (publisher)
   Requests with ``requestId > after`` in order: ``{"version": 1, "logEpoch": str, "after",
   "lastSequence", "oldestPendingSequence": int|null, "nextCursor", "hasMore", "items":
   [Request]}``, ETag. The PC applies each item whose ``state`` is ``pending`` in order
   (skipping ``superseded``), reports it (7), then stores ``nextCursor`` together with
   ``logEpoch``. ``logEpoch`` is random and changes at every server start (a database
   restore needs a restart): when the reply's ``logEpoch`` differs from the stored one,
   the PC discards its cursor and reads again from ``after=0`` - only ``pending`` items
   matter, so re-reading is harmless. After a crash it may resume from
   ``oldestPendingSequence - 1``. ``409 bindCursorRejected`` (with ``lastSequence`` and
   ``logEpoch``) when ``after > lastSequence``: restart from 0. ``422 invalidBindRequest``
   for a malformed ``after``/``limit``. Reading the log records ``publisherSeenAt`` (at most
   one write a minute). Pruned rows are only resolved ones, so no cursor ever expires.

7. ``POST /v1/collections/bindings/requests/{requestId}/result`` (publisher)
   Body ``{"version": 1, "state": "applied"|"failed", "reason": {"code":
   [A-Za-z0-9_.-]{1,64}, "message": str(<=500)}|null}`` (``reason`` required for failed;
   show ``message`` on the tablet, so write it in Korean). Transitions: ``pending`` ->
   applied/failed; a ``superseded`` request the PC applied anyway records its real
   outcome (the newer pending request is unaffected); repeating the same state is a
   no-op replay; a different state on a resolved request is ``409 bindResultConflict``.
   ``404 bindRequestNotFound`` - also returned after a resolved request was pruned by
   retention; the PC treats it as done (nothing left to report). ``422
   invalidBindResult``. Reply ``{"version": 1, "request": Request}``.

   Every refusal on these routes, including malformed query/path values, has the
   ``{"code", "message"}`` shape (``invalidBindSearch`` / ``invalidBindRequest`` /
   ``invalidBindResult``); auth is checked first.

Cost bounds (1 CPU VPS): per client at most ``SEARCH_PER_MINUTE`` uncached searches a
minute; at most ``KAKAO_PAGES_PER_MINUTE`` Kakao pages a minute over all clients; one
outbound search per provider at a time (a second one waits at most ``PROVIDER_WAIT``
seconds, then ``bindSearchBusy``); one Kakao crawl ends after ``KAKAO_BUDGET`` seconds in
total; MangaDex calls spaced
``MANGADEX_MIN_INTERVAL`` apart (its public limit is 5 req/s per IP); results cached in
memory for ``CACHE_TTL`` seconds (``CACHE_MAX`` entries, LRU). Resolved requests older than
``RESOLVED_DAYS`` days or beyond the newest ``RESOLVED_MAX`` are pruned inside writes.
"""
import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict, deque
from datetime import datetime, timedelta, timezone
from functools import cmp_to_key
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID, uuid4

import httpx
from fastapi import Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import collection_authority
import conditional

PREFIX = "/v1/collections/bindings"
KAKAO_KEY_ENV = "LAKOMICS_KAKAO_REST_KEY"
MAX_CURSOR = 9_007_199_254_740_991
MAX_BODY_BYTES = 16 * 1024
MAX_PENDING = 1_000
RESOLVED_DAYS = 30
RESOLVED_MAX = 2_000
SEARCH_PER_MINUTE = 12
CACHE_TTL = 600.0
CACHE_MAX = 32
MANGADEX_MIN_INTERVAL = 0.25
PROVIDER_WAIT = 1.0  # seconds a search waits for the provider's single outbound slot
KAKAO_PAGES_PER_MINUTE = 300  # global Kakao page budget across all clients

MANGADEX_API = "https://api.mangadex.org/manga"
MANGADEX_UPLOADS = "https://uploads.mangadex.org"
MANGADEX_LIMIT = 20
MANGADEX_MAX_BYTES = 4 * 1024 * 1024
MANGADEX_TIMEOUT = 20.0
LOCALE_PRIORITY = ("ko", "en", "ja-ro", "ja")

KAKAO_API = "https://dapi.kakao.com/v3/search/book"
KAKAO_PAGE_SIZE = 50
KAKAO_MAX_PAGES = 50
KAKAO_MAX_BYTES = 2 * 1024 * 1024
KAKAO_TIMEOUT = 20.0
KAKAO_BUDGET = 60.0  # total deadline of one Kakao crawl (all pages), seconds

ALLOWED_HOSTS = ("api.mangadex.org", "dapi.kakao.com")
USER_AGENT = "Lakomics-API/1.0 (self-hosted personal library server)"

CollectionId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
OperationId = Annotated[str, StringConstraints(min_length=36, max_length=36)]
Display = Annotated[str, StringConstraints(min_length=1, max_length=500)]
Url = Annotated[str, StringConstraints(pattern=r"^https://[^\s]{1,2000}$")]

DDL = """
CREATE TABLE IF NOT EXISTS collection_binding_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL,
 publisher_seen_at TEXT, log_epoch TEXT);
INSERT OR IGNORE INTO collection_binding_state(singleton,sequence) VALUES(1,0);
CREATE TABLE IF NOT EXISTS collection_binding_requests(
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL,
 collection_id TEXT NOT NULL, provider TEXT NOT NULL, choice_json TEXT NOT NULL,
 expected_json TEXT, state TEXT NOT NULL, reason_code TEXT, reason_message TEXT,
 replaces INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS idx_collection_binding_requests_target
 ON collection_binding_requests(collection_id, provider, state);
CREATE INDEX IF NOT EXISTS idx_collection_binding_requests_state
 ON collection_binding_requests(state, sequence);
"""


def startup_db(db):
    db.executescript(DDL)
    if "log_epoch" not in {row[1] for row in db.execute("PRAGMA table_info(collection_binding_state)")}:
        db.execute("ALTER TABLE collection_binding_state ADD COLUMN log_epoch TEXT")
    # A new random epoch at every server start: restoring a database backup needs a
    # restart, so a PC can never mistake a restored (rewound) log for the one it read.
    db.execute("UPDATE collection_binding_state SET log_epoch=? WHERE singleton=1", (uuid4().hex,))


def fail(status, code, message, headers=None, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra}, headers=headers)


def now_utc():
    return datetime.now(timezone.utc)


def kakao_key():
    """The configured Kakao REST key, or None when unset/malformed. Never logged."""
    key = os.environ.get(KAKAO_KEY_ENV, "").strip()
    if not key or not all(33 <= ord(ch) <= 126 for ch in key):
        return None
    return key


def capabilities():
    return {"version": 1, "mangadexSearch": True, "kakaoSearch": kakao_key() is not None, "bindRequests": True}


# --- outbound HTTP ---------------------------------------------------------------------

class Upstream(Exception):
    """``kind``: timeout | status | unavailable | invalid."""

    def __init__(self, kind, status=None):
        super().__init__(kind)
        self.kind, self.status = kind, status


_client = None
_client_lock = threading.Lock()


def _http():
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(follow_redirects=False, trust_env=False,
                                   limits=httpx.Limits(max_connections=4, max_keepalive_connections=2))
        return _client


def http_get(url, params, headers, max_bytes, timeout, deadline=None):
    """``bytes`` of a successful GET (status 2xx), else raises ``Upstream``. Tests patch this.

    ``deadline`` (``time.monotonic()`` value) also bounds a slowly trickling body.
    """
    host = urlsplit(url).hostname
    if not url.startswith("https://") or host not in ALLOWED_HOSTS:
        raise Upstream("invalid")
    try:
        with _http().stream("GET", url, params=params, headers={"User-Agent": USER_AGENT, **headers},
                            timeout=httpx.Timeout(timeout, connect=10.0)) as response:
            if not 200 <= response.status_code < 300:
                raise Upstream("status", response.status_code)
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise Upstream("invalid")
                if deadline is not None and time.monotonic() > deadline:
                    raise Upstream("timeout")
            return bytes(body)
    except httpx.TimeoutException:
        raise Upstream("timeout") from None
    except httpx.HTTPError:
        raise Upstream("unavailable") from None


class SearchFailure(tuple):
    """``(status, code, message)`` of a failed search; cacheable when deterministic."""


def _upstream_failure(provider, error):
    if error.kind == "timeout":
        return SearchFailure((504, "bindSearchTimedOut", "검색 응답이 늦어요. 잠시 후 다시 시도해 주세요."))
    if error.kind == "status" and error.status in (401, 403) and provider == "kakao":
        return SearchFailure((503, "kakaoCredentialRejected", "서버의 카카오 API 키가 거부되었습니다."))
    if error.kind == "status" and error.status == 429:
        return SearchFailure((503, "bindSearchUpstreamRateLimited", "검색 요청이 많아요. 잠시 후 다시 시도해 주세요."))
    if error.kind == "invalid":
        return SearchFailure((502, "bindSearchInvalidResponse", "검색 결과를 읽지 못했습니다."))
    return SearchFailure((502, "bindSearchUpstreamFailed", "검색 서비스에 연결하지 못했습니다."))


# --- MangaDex (mirrors library/mangadex.rs) -------------------------------------------

def _nonempty(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _localized_maps(attributes):
    title = attributes.get("title") or {}
    alternates = attributes.get("altTitles") or []
    maps = [title] + [m for m in alternates if isinstance(m, dict)]
    return [m for m in maps if isinstance(m, dict)]


def _valid_cover_identity(file_name):
    return (isinstance(file_name, str) and 0 < len(file_name) <= 160 and ".." not in file_name
            and re.fullmatch(r"[A-Za-z0-9_.-]+", file_name) is not None
            and file_name.rsplit(".", 1)[-1] in ("jpg", "jpeg", "png", "webp") and "." in file_name)


def _uuid_ok(value):
    try:
        UUID(value)
        return isinstance(value, str)
    except (ValueError, TypeError, AttributeError):
        return False


def mangadex_item(data):
    """One ``MangaDexSearchResult`` (camelCase) or None when the record is unusable."""
    if not isinstance(data, dict) or not _uuid_ok(data.get("id")) or str(UUID(data["id"])) != data["id"]:
        return None
    manga_id = data["id"]
    attributes = data.get("attributes")
    if not isinstance(attributes, dict):
        return None
    maps = _localized_maps(attributes)
    title = next((v for locale in LOCALE_PRIORITY for m in maps if (v := _nonempty(m.get(locale)))), None)
    if title is None:
        return None
    seen, alternates = {title}, []
    for m in maps:  # BTreeMap order: keys sorted
        for _, value in sorted(m.items()):
            value = _nonempty(value)
            if value is not None and value not in seen:
                seen.add(value)
                alternates.append(value)
    relationships = [r for r in data.get("relationships") or [] if isinstance(r, dict)]
    people, names = [], set()
    for relation in relationships:
        if relation.get("type") in ("author", "artist"):
            name = _nonempty((relation.get("attributes") or {}).get("name"))
            if name is not None and name not in names:
                names.add(name)
                people.append(name)
    cover = next((r for r in relationships if r.get("type") == "cover_art"), None)
    file_name = (cover.get("attributes") or {}).get("fileName") if cover else None
    if file_name is not None and not _valid_cover_identity(file_name):
        return None
    year = attributes.get("year")
    status = attributes.get("status")
    return {"mangaId": manga_id, "title": title, "alternateTitles": alternates,
            "author": " · ".join(people) if people else None,
            "year": year if isinstance(year, int) and not isinstance(year, bool) else None,
            "status": status if isinstance(status, str) else None,
            "primaryCoverFileName": file_name,
            "coverUrl": f"{MANGADEX_UPLOADS}/covers/{manga_id}/{file_name}.256.jpg" if file_name else None}


def parse_mangadex(body):
    try:
        envelope = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise Upstream("invalid") from None
    if not isinstance(envelope, dict) or envelope.get("result") != "ok" or not isinstance(envelope.get("data"), list):
        raise Upstream("invalid")
    return [item for item in map(mangadex_item, envelope["data"][:MANGADEX_LIMIT]) if item is not None]


# --- Kakao (mirrors library/kakao_books.rs, aladin.rs, aladin_flow.rs) ------------------

_RFC3339 = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})")
_DECIMAL = re.compile(r"\d+\.\d+")
_EDITION_SUFFIX = re.compile(
    r"\s*(?:[-–—]\s*)?(?:\([^)]*(?:특별판|한정판|초판)[^)]*\)|\[[^\]]*(?:특별판|한정판|초판)[^\]]*\]"
    r"|(?:초판\s*)?(?:한정판|특별판))\s*\Z", re.IGNORECASE)
_COMPLETION_SUFFIX = re.compile(r"\s*[\(\[]\s*완결\s*[\)\]]\s*\Z")
_VOLUME_PATTERNS = (
    re.compile(r"(?:\s|^)(?:제\s*)?(\d+)\s*권\s*\Z", re.IGNORECASE),
    re.compile(r"(?:\s|^)(?:vol(?:ume)?\.?)\s*(\d+)\s*\Z", re.IGNORECASE),
    re.compile(r"(?:\s|-)(\d+)\s*\Z"),
)
_EXCLUDED_TERMS = ("세트", "박스", "가이드", "화집", "소설", "캘린더", "달력", "아트북",
                   "guide", "novel", "calendar", "art book", "box set")


def parse_volume_product(title):
    """``(volume_number, base_title)`` or None - ``aladin.rs parse_volume_product``."""
    lower = "".join(ch.lower() if ch.isascii() else ch for ch in title)
    if any(term in lower for term in _EXCLUDED_TERMS) or _DECIMAL.search(title):
        return None
    title = _COMPLETION_SUFFIX.sub("", title, count=1)
    volume_title = _EDITION_SUFFIX.sub("", title, count=1)
    for pattern in _VOLUME_PATTERNS:
        match = pattern.search(volume_title)
        if match is None:
            continue
        digits = match.group(1)
        if not digits.isascii():
            return None
        number = int(digits)
        if not 1 <= number <= 999:
            return None
        base = volume_title[:match.start()].rstrip(" -.").strip()
        return (number, base) if base else None
    return None


def _form_encode(value):
    """``form_urlencoded::byte_serialize`` (Rust ``url`` crate) for canonical URL hashing."""
    out = []
    for byte in value.encode("utf-8"):
        ch = chr(byte)
        if ch.isascii() and (ch.isalnum() or ch in "*-._"):
            out.append(ch)
        elif ch == " ":
            out.append("+")
        else:
            out.append(f"%{byte:02X}")
    return "".join(out)


def _canonical_book_url(raw):
    try:
        url = urlsplit(raw.strip())
        port = url.port
    except ValueError:
        raise Upstream("invalid") from None
    default_port = {"http": 80, "https": 443}.get(url.scheme)
    if (default_port is None or url.hostname != "search.daum.net" or url.path != "/search"
            or url.username is not None or url.password is not None
            or (port is not None and port != default_port)):
        raise Upstream("invalid")
    pairs = parse_qsl(url.query, keep_blank_values=True)
    if not any(k == "w" and v == "bookpage" for k, v in pairs):
        raise Upstream("invalid")
    book_id = next((v for k, v in pairs if k == "bookId" and v), None)
    if book_id is None:
        raise Upstream("invalid")
    return "https://search.daum.net/search?w=bookpage&bookId=" + _form_encode(book_id)


def kakao_item(raw):
    """One parsed Kakao document (dict) or None when the title is not a volume product."""
    if not isinstance(raw, dict):
        raise Upstream("invalid")
    fields = {name: raw.get(name) for name in ("title", "publisher", "isbn", "datetime", "url")}
    authors = raw.get("authors")
    if (any(not isinstance(value, str) for value in fields.values()) or not isinstance(authors, list)
            or any(not isinstance(a, str) for a in authors)):
        raise Upstream("invalid")
    parsed = parse_volume_product(fields["title"])
    if parsed is None:
        return None
    tokens = fields["isbn"].split()
    isbn13 = next((t for t in tokens if len(t) == 13 and t.isascii() and t.isdigit()), None)
    isbn10 = next((t for t in tokens if len(t) == 10 and t.isascii() and t[:9].isdigit()
                   and (t[9].isdigit() or t[9] in "xX")), None)
    item_url = _canonical_book_url(fields["url"]) if fields["url"].strip() else None
    if isbn13:
        item_id = f"isbn13:{isbn13}"
    elif isbn10:
        item_id = f"isbn10:{isbn10.upper()}"
    elif item_url:
        item_id = "url:" + hashlib.sha256(item_url.encode()).hexdigest()
    else:
        raise Upstream("invalid")
    publication_date = None
    if fields["datetime"]:
        # chrono ``parse_from_rfc3339``: ``T``/``t``/space separator, optional fraction, Z or +hh:mm.
        if not _RFC3339.fullmatch(fields["datetime"]):
            raise Upstream("invalid")
        try:
            moment = datetime.fromisoformat(fields["datetime"].upper().replace(" ", "T"))
        except ValueError:
            raise Upstream("invalid") from None
        publication_date = moment.strftime("%Y-%m-%d")
    thumbnail = raw.get("thumbnail")
    return {"itemId": item_id, "title": fields["title"], "author": _nonempty(", ".join(authors)),
            "publisher": _nonempty(fields["publisher"]), "isbn13": isbn13,
            "publicationDate": publication_date, "volumeNumber": parsed[0], "baseTitle": parsed[1],
            "thumbnail": thumbnail if isinstance(thumbnail, str) and re.fullmatch(r"https://\S{1,2000}", thumbnail)
            else None}


def _normalize(value):
    return " ".join(value.split()).lower()


def _group_key(item):
    return "\0".join((_normalize(item["baseTitle"]), _normalize(item["author"] or ""),
                      _normalize(item["publisher"] or "")))


def _prefer(left, right):
    """``compare_duplicate_preference``: volume asc, ISBN first, newest date, item id asc."""
    if left["volumeNumber"] != right["volumeNumber"]:
        return -1 if left["volumeNumber"] < right["volumeNumber"] else 1
    if (left["isbn13"] is None) != (right["isbn13"] is None):
        return -1 if left["isbn13"] is not None else 1
    ld, rd = left["publicationDate"], right["publicationDate"]
    if ld != rd:
        if ld is None:
            return 1
        if rd is None:
            return -1
        return -1 if ld > rd else 1
    return (left["itemId"] > right["itemId"]) - (left["itemId"] < right["itemId"])


def group_kakao(items):
    """Series candidates exactly as ``aladin_flow.rs grouped_items`` (+ display fields)."""
    groups = {}
    for item in items:
        groups.setdefault(_group_key(item), []).append(item)
    candidates = []
    for key in sorted(groups):
        members = sorted(groups[key], key=cmp_to_key(_prefer))
        head = members[0]
        title = head["baseTitle"].strip()
        fingerprint = hashlib.sha256("\0".join((_normalize(title), _normalize(head["author"] or ""),
                                                _normalize(head["publisher"] or ""))).encode()).hexdigest()
        by_volume = {}
        for item in members:
            by_volume.setdefault(item["volumeNumber"], item)
        selected = [by_volume[number] for number in sorted(by_volume)]
        candidates.append({
            "anchorItemId": min(item["itemId"] for item in selected),
            "groupFingerprint": fingerprint, "title": title, "author": head["author"],
            "publisher": head["publisher"],
            "volumes": [{"volumeNumber": i["volumeNumber"], "providerItemId": i["itemId"], "title": i["title"],
                         "publicationDate": i["publicationDate"], "isbn13": i["isbn13"]} for i in selected],
            "ignoredCount": len(members) - len(selected), "volumeCount": len(selected),
            "firstVolume": selected[0]["volumeNumber"], "lastVolume": selected[-1]["volumeNumber"],
            "knownItemIds": sorted(i["itemId"] for i in selected),
            "thumbnailUrl": next((i["thumbnail"] for i in selected if i["thumbnail"]), None)})
    return candidates


class KakaoTooBroad(Exception):
    pass


class PageBudget(Exception):
    def __init__(self, wait):
        super().__init__(wait)
        self.wait = wait


def search_kakao_items(key, query):
    """Every page, deduplicated by item id; raises on an unfinished search (PC rule).

    The whole crawl shares one ``KAKAO_BUDGET`` deadline and every page draws on the
    global ``KAKAO_PAGES_PER_MINUTE`` budget (``PageBudget`` when it runs out).
    """
    items, seen = [], set()
    deadline = time.monotonic() + KAKAO_BUDGET
    for page in range(1, KAKAO_MAX_PAGES + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Upstream("timeout")
        wait = gate.take_kakao_page()
        if wait:
            raise PageBudget(wait)
        body = http_get(KAKAO_API, [("query", query), ("target", "title"), ("sort", "latest"),
                                    ("size", str(KAKAO_PAGE_SIZE)), ("page", str(page))],
                        {"Authorization": f"KakaoAK {key}"}, KAKAO_MAX_BYTES, min(KAKAO_TIMEOUT, remaining),
                        deadline=deadline)
        try:
            response = json.loads(body)
            is_end = response["meta"]["is_end"]
            documents = response["documents"]
        except (ValueError, UnicodeDecodeError, KeyError, TypeError):
            raise Upstream("invalid") from None
        if (not isinstance(is_end, bool) or not isinstance(documents, list) or len(documents) > KAKAO_PAGE_SIZE
                or (not documents and not is_end)):
            raise Upstream("invalid")
        for raw in documents:
            item = kakao_item(raw)
            if item is not None and item["itemId"] not in seen:
                seen.add(item["itemId"])
                items.append(item)
        if is_end:
            return items
    raise KakaoTooBroad()


# --- throttling and cache --------------------------------------------------------------

class SearchGate:
    """Per-client sliding-window limit, one outbound search per provider, small TTL cache."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.windows = {}
        self.cache = OrderedDict()
        self.provider_locks = {"mangadex": threading.Lock(), "kakao": threading.Lock()}
        self.mangadex_last = 0.0
        self.kakao_pages = deque()

    def cached(self, key):
        with self.lock:
            entry = self.cache.get(key)
            if entry is None:
                return None
            if self.clock() - entry[0] > CACHE_TTL:
                del self.cache[key]
                return None
            self.cache.move_to_end(key)
            return entry[1]

    def store(self, key, value):
        with self.lock:
            self.cache[key] = (self.clock(), value)
            self.cache.move_to_end(key)
            while len(self.cache) > CACHE_MAX:
                self.cache.popitem(last=False)

    def admit(self, principal):
        """Seconds to wait (0 = admitted and counted)."""
        with self.lock:
            now = self.clock()
            window = self.windows.setdefault(principal, deque())
            while window and now - window[0] >= 60:
                window.popleft()
            if len(window) >= SEARCH_PER_MINUTE:
                return max(1, int(60 - (now - window[0])) + 1)
            window.append(now)
            if len(self.windows) > 1000:
                for name in [n for n, w in self.windows.items() if not w or now - w[-1] >= 60]:
                    del self.windows[name]
            return 0

    def take_kakao_page(self):
        """Seconds until a Kakao page may be fetched (0 = taken) - global sliding minute."""
        with self.lock:
            now = self.clock()
            while self.kakao_pages and now - self.kakao_pages[0] >= 60:
                self.kakao_pages.popleft()
            if len(self.kakao_pages) >= KAKAO_PAGES_PER_MINUTE:
                return max(1, int(60 - (now - self.kakao_pages[0])) + 1)
            self.kakao_pages.append(now)
            return 0

    def mangadex_spacing(self):
        with self.lock:
            wait = self.mangadex_last + MANGADEX_MIN_INTERVAL - self.clock()
        if wait > 0:
            time.sleep(wait)
        with self.lock:
            self.mangadex_last = self.clock()


gate = SearchGate()


# --- bind requests ---------------------------------------------------------------------

class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class MangaDexChoice(Strict):
    mangaId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    title: Display
    coverUrl: Url | None = None


class KakaoChoice(Strict):
    query: Annotated[str, StringConstraints(min_length=2, max_length=100)]
    anchorItemId: Annotated[str, StringConstraints(pattern=r"^\S{1,128}$")]
    groupFingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    title: Display
    author: Display | None = None
    publisher: Display | None = None
    volumeCount: int | None = Field(default=None, ge=0, le=10_000)
    thumbnailUrl: Url | None = None


class Expected(Strict):
    externalId: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None


class BindCommand(Strict):
    version: Literal[1]
    operationId: OperationId
    collectionId: CollectionId
    provider: Literal["mangadex", "kakao"]
    choice: dict
    expected: Expected | None = None


class Reason(Strict):
    code: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.-]{1,64}$")]
    message: Annotated[str, StringConstraints(max_length=500)]


class BindResult(Strict):
    version: Literal[1]
    state: Literal["applied", "failed"]
    reason: Reason | None = None


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


async def _bounded(request, limit, code, message):
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        fail(413, code, message)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            fail(413, code, message)
    return bytes(raw)


def _int_param(raw, default, low, high):
    """Decimal integer in ``[low, high]``, ``default`` when absent, None when invalid."""
    if raw is None:
        return default
    if not re.fullmatch(r"[0-9]{1,16}", raw):
        return None
    value = int(raw)
    return value if low <= value <= high else None


def _state(db):
    return db.execute("SELECT * FROM collection_binding_state WHERE singleton=1").fetchone()


def _request(row):
    return {"requestId": row["sequence"], "operationId": row["operation_id"], "collectionId": row["collection_id"],
            "provider": row["provider"], "choice": json.loads(row["choice_json"]),
            "expected": None if row["expected_json"] is None else json.loads(row["expected_json"]),
            "state": row["state"],
            "reason": None if row["reason_code"] is None else {"code": row["reason_code"],
                                                               "message": row["reason_message"] or ""},
            "replaces": row["replaces"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "resolvedAt": row["resolved_at"]}


def _collection_type(db, collection_id):
    table = "collection_authority_projection" if collection_authority.served_state(db) else "mobile_collections"
    row = db.execute(f"SELECT type FROM {table} WHERE id=?", (collection_id,)).fetchone()
    return None if row is None else row[0]


def _retain(db, now):
    db.execute("DELETE FROM collection_binding_requests WHERE state<>'pending' AND updated_at<?",
               ((now - timedelta(days=RESOLVED_DAYS)).isoformat(),))
    db.execute("""DELETE FROM collection_binding_requests WHERE state<>'pending' AND sequence NOT IN
        (SELECT sequence FROM collection_binding_requests WHERE state<>'pending'
         ORDER BY sequence DESC LIMIT ?)""", (RESOLVED_MAX,))


def register(app, get_db, require_client, require_publisher):
    """Install the routes. Tables come from ``startup_db`` (called by the Collections startup)."""

    def principal_of(authorization):
        return str(require_client(authorization) or "client")

    def search(provider, query, authorization):
        principal = principal_of(authorization)
        query = (query or "").strip()
        if not 2 <= len(query) <= 100:
            fail(422, "invalidBindSearch", "검색어를 두 글자 이상 100자 이하로 입력해 주세요.", provider=provider)
        key = kakao_key() if provider == "kakao" else None
        if provider == "kakao" and key is None:
            fail(503, "kakaoSearchUnavailable", "서버에 카카오 검색이 설정되지 않았습니다.", provider=provider)
        cache_key = (provider, query)
        result = gate.cached(cache_key)
        if result is None:
            wait = gate.admit(principal)
            if wait:
                fail(429, "bindSearchRateLimited", "검색을 너무 자주 했어요. 잠시 후 다시 시도해 주세요.",
                     headers={"Retry-After": str(wait)}, provider=provider, retryAfter=wait)
            slot = gate.provider_locks[provider]
            if not slot.acquire(timeout=PROVIDER_WAIT):
                fail(429, "bindSearchBusy", "검색 중이에요. 잠시 후 다시 시도해 주세요.",
                     headers={"Retry-After": "3"}, provider=provider, retryAfter=3)
            try:
                result = gate.cached(cache_key)  # another request may have filled it meanwhile
                if result is None:
                    cacheable = True
                    try:
                        if provider == "mangadex":
                            gate.mangadex_spacing()
                            result = parse_mangadex(http_get(
                                MANGADEX_API, [("title", query), ("limit", str(MANGADEX_LIMIT)),
                                               ("includes[]", "cover_art"), ("includes[]", "author"),
                                               ("includes[]", "artist")],
                                {}, MANGADEX_MAX_BYTES, MANGADEX_TIMEOUT))
                        else:
                            result = group_kakao(search_kakao_items(key, query))
                    except Upstream as error:
                        result = _upstream_failure(provider, error)
                        # Only deterministic failures are cached; transient ones may retry.
                        cacheable = error.kind == "invalid"
                    except KakaoTooBroad:
                        result = SearchFailure((422, "kakaoSearchTooBroad",
                                                "검색 결과가 너무 많습니다. 더 구체적인 제목으로 검색해 주세요."))
                    except PageBudget as budget:
                        fail(429, "bindSearchRateLimited", "검색 요청이 많아요. 잠시 후 다시 시도해 주세요.",
                             headers={"Retry-After": str(budget.wait)}, provider=provider, retryAfter=budget.wait)
                    if cacheable:
                        gate.store(cache_key, result)
            finally:
                slot.release()
        if isinstance(result, SearchFailure):
            fail(result[0], result[1], result[2], provider=provider)
        return {"version": 1, "provider": provider, "query": query, "items": result}

    @app.get(PREFIX + "/status")
    def status(authorization: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            seen = _state(db)["publisher_seen_at"]
        return {**capabilities(), "publisherSeenAt": seen}

    # Query/path values are parsed by hand (not FastAPI validation) so every refusal on
    # these routes has the documented ``{code, message}`` shape and auth runs first.
    @app.get(PREFIX + "/search/mangadex")
    def search_mangadex(request: Request, authorization: str | None = Header(default=None)):
        return search("mangadex", request.query_params.get("query", ""), authorization)

    @app.get(PREFIX + "/search/kakao")
    def search_kakao(request: Request, authorization: str | None = Header(default=None)):
        return search("kakao", request.query_params.get("query", ""), authorization)

    def invalid_request(message="연결 요청을 확인할 수 없습니다."):
        fail(422, "invalidBindRequest", message)

    def bind(command):
        try:
            if str(UUID(command.operationId)) != command.operationId:
                raise ValueError()
        except ValueError:
            invalid_request("연결 요청 식별자가 올바르지 않습니다.")
        try:
            if command.provider == "mangadex":
                choice = MangaDexChoice.model_validate(command.choice)
                if not _uuid_ok(choice.mangaId) or str(UUID(choice.mangaId)) != choice.mangaId:
                    raise ValueError()
            else:
                choice = KakaoChoice.model_validate(command.choice)
                if choice.query != choice.query.strip() or len(choice.query) < 2:
                    raise ValueError()
        except (ValidationError, ValueError):
            invalid_request()
        choice_json = _encode(choice.model_dump())
        expected_json = None if command.expected is None else _encode(command.expected.model_dump())
        digest = hashlib.sha256(_encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM collection_binding_requests WHERE operation_id=?",
                                  (command.operationId,)).fetchone()
            if existing is not None:
                db.rollback()
                if existing["payload_digest"] != digest:
                    fail(409, "operationConflict", "다른 내용으로 연결 요청을 재사용할 수 없습니다.")
                return {"version": 1, "request": _request(existing)}
            kind = _collection_type(db, command.collectionId)
            if kind is None:
                db.rollback()
                fail(404, "collectionNotFound", "컬렉션을 찾을 수 없습니다.")
            if kind != "manga":
                db.rollback()
                fail(409, "collectionNotManga", "만화 작품만 MangaDex·카카오에 연결할 수 있습니다.")
            moment = now_utc()
            now = moment.isoformat()
            pending = db.execute("""SELECT sequence FROM collection_binding_requests
                WHERE collection_id=? AND provider=? AND state='pending' ORDER BY sequence DESC""",
                                 (command.collectionId, command.provider)).fetchall()
            if not pending and db.execute("SELECT COUNT(*) FROM collection_binding_requests WHERE state='pending'"
                                          ).fetchone()[0] >= MAX_PENDING:
                db.rollback()
                fail(409, "bindRequestLimit", "PC에 적용되지 않은 연결 요청이 너무 많습니다. PC를 켜 주세요.")
            for row in pending:
                db.execute("UPDATE collection_binding_requests SET state='superseded',updated_at=?,resolved_at=?"
                           " WHERE sequence=?", (now, now, row["sequence"]))
            sequence = _state(db)["sequence"] + 1
            db.execute("UPDATE collection_binding_state SET sequence=? WHERE singleton=1", (sequence,))
            db.execute("""INSERT INTO collection_binding_requests(sequence,operation_id,payload_digest,collection_id,
                provider,choice_json,expected_json,state,reason_code,reason_message,replaces,created_at,updated_at,
                resolved_at) VALUES(?,?,?,?,?,?,?,'pending',NULL,NULL,?,?,?,NULL)""",
                       (sequence, command.operationId, digest, command.collectionId, command.provider, choice_json,
                        expected_json, pending[0]["sequence"] if pending else None, now, now))
            _retain(db, moment)
            row = db.execute("SELECT * FROM collection_binding_requests WHERE sequence=?", (sequence,)).fetchone()
            db.commit()
            return {"version": 1, "request": _request(row)}

    @app.post(PREFIX + "/requests")
    async def post_request(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await _bounded(request, MAX_BODY_BYTES, "bindRequestTooLarge", "연결 요청이 너무 큽니다.")
        try:
            command = BindCommand.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_request()
        return await run_in_threadpool(bind, command)

    @app.get(PREFIX + "/requests")
    def list_requests(request: Request, authorization: str | None = Header(default=None),
                      if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        query = request.query_params
        collectionId = query.get("collectionId")
        state = query.get("state", "all")
        limit = _int_param(query.get("limit"), 20, 1, 50)
        if (limit is None or state not in ("all", "pending")
                or (collectionId is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", collectionId))):
            invalid_request("연결 요청 목록 요청을 확인할 수 없습니다.")
        clauses, params = [], []
        if collectionId is not None:
            clauses.append("collection_id=?")
            params.append(collectionId)
        if state == "pending":
            clauses.append("state='pending'")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with get_db() as db:
            db.execute("BEGIN")
            rows = db.execute(f"SELECT * FROM collection_binding_requests{where} ORDER BY sequence DESC LIMIT ?",
                              (*params, limit)).fetchall()
            pending = None
            if collectionId is not None:
                pending = {"mangadex": None, "kakao": None}
                for row in db.execute("""SELECT * FROM collection_binding_requests
                        WHERE collection_id=? AND state='pending' ORDER BY sequence""", (collectionId,)):
                    pending[row["provider"]] = _request(row)
            db.rollback()
        return conditional.json_response({"version": 1, "items": [_request(r) for r in rows], "pending": pending},
                                         if_none_match)

    @app.get(PREFIX + "/log")
    def log(request: Request, authorization: str | None = Header(default=None),
            if_none_match: str | None = Header(default=None)):
        require_publisher(authorization)
        after = _int_param(request.query_params.get("after"), 0, 0, MAX_CURSOR)
        limit = _int_param(request.query_params.get("limit"), 100, 1, 200)
        if after is None or limit is None:
            invalid_request("연결 요청 기록 요청을 확인할 수 없습니다.")
        with get_db() as db:
            db.execute("BEGIN")  # deferred: a plain read
            current = _state(db)
            last, epoch = current["sequence"], current["log_epoch"]
            if after > last:
                db.rollback()
                fail(409, "bindCursorRejected", "연결 요청 동기화 위치를 확인해 주세요.", lastSequence=last,
                     logEpoch=epoch)
            rows = db.execute("SELECT * FROM collection_binding_requests WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            oldest = db.execute("SELECT MIN(sequence) FROM collection_binding_requests WHERE state='pending'"
                                ).fetchone()[0]
            db.rollback()
            moment = now_utc()
            seen = current["publisher_seen_at"]
            if seen is None or datetime.fromisoformat(seen) < moment - timedelta(seconds=60):
                # At most one write a minute however often the PC polls.
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE collection_binding_state SET publisher_seen_at=? WHERE singleton=1",
                           (moment.isoformat(),))
                db.commit()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "logEpoch": epoch, "after": after, "lastSequence": last, "oldestPendingSequence": oldest,
            "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
            "items": [_request(r) for r in rows]}, if_none_match)

    def invalid_result():
        fail(422, "invalidBindResult", "연결 결과를 확인할 수 없습니다.")

    def report(request_id, result):
        if result.state == "failed" and result.reason is None:
            invalid_result()
        reason = result.reason
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM collection_binding_requests WHERE sequence=?", (request_id,)).fetchone()
            if row is None:
                db.rollback()
                fail(404, "bindRequestNotFound", "연결 요청을 찾을 수 없습니다.")
            if row["state"] in ("pending", "superseded"):
                moment = now_utc()
                now = moment.isoformat()
                db.execute("""UPDATE collection_binding_requests SET state=?,reason_code=?,reason_message=?,
                    updated_at=?,resolved_at=? WHERE sequence=?""",
                           (result.state, reason.code if reason else None, reason.message if reason else None,
                            now, now, request_id))
                _retain(db, moment)
                row = db.execute("SELECT * FROM collection_binding_requests WHERE sequence=?",
                                 (request_id,)).fetchone()
                db.commit()
            elif row["state"] == result.state:
                db.rollback()
            else:
                db.rollback()
                fail(409, "bindResultConflict", "이미 다른 결과가 기록된 연결 요청입니다.", state=row["state"])
            return {"version": 1, "request": _request(row)}

    @app.post(PREFIX + "/requests/{request_id}/result")
    async def post_result(request_id: str, request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        request_id = _int_param(request_id, None, 1, MAX_CURSOR)
        if request_id is None:
            invalid_result()
        body = await _bounded(request, MAX_BODY_BYTES, "invalidBindResult", "연결 결과가 너무 큽니다.")
        try:
            result = BindResult.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_result()
        return await run_in_threadpool(report, request_id, result)

    return startup_db
