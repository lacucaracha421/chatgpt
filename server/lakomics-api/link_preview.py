"""Kept-link previews for the tablet (parity U02, 2026-10-22).

``POST /v1/home/link-preview`` (client) with ``{"url": "https://..."}`` returns
``{"title", "siteName", "imageUrl"}`` for one link the user just kept, the same fields the PC
reads in ``_tools/app/src-tauri/src/link_preview.rs``. The encrypted Notes stay client-owned:
the tablet writes the preview into its own note entry; only the requested URL is sent, in the
body so access logs never carry it, and it is never logged here.

Bounds: HTTPS on port 443 only, no credentials in the URL; every host (also each redirect
hop and the fixed oEmbed fallbacks) must resolve only to global addresses, and the connected
peer must be one of them, so private, loopback, link-local and tailnet (100.64/10) targets
are refused; at most 3 redirects; a 6-second budget per preview; at most 512 KiB of HTML
(a prefix is enough for the head); two previews at a time. Results (including failures) are
cached in memory for a while, keyed by a hash of the URL.
"""
import codecs
import hashlib
import html
import ipaddress
import json
import re
import socket
import threading
import time
from collections import OrderedDict
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

import httpx
from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

ROUTE = "/v1/home/link-preview"
MAX_BODY_BYTES = 4096
MAX_URL_BYTES = 2048
HTML_LIMIT = 512 * 1024
JSON_LIMIT = 256 * 1024
BUDGET_SECONDS = 6.0
MAX_REDIRECTS = 3
CACHE_ENTRIES = 256
CACHE_SECONDS = 6 * 60 * 60
FAILURE_SECONDS = 10 * 60
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


class PreviewRefused(Exception):
    """The URL or one of its hops is not allowed (no retry helps)."""


class PreviewUnavailable(Exception):
    """The page could not be read or had nothing usable."""


def check_url(value):
    """The URL as fetched, or PreviewRefused. HTTPS, port 443, no credentials."""
    if not isinstance(value, str) or not value or len(value.encode()) > MAX_URL_BYTES:
        raise PreviewRefused()
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError as exc:
        raise PreviewRefused() from exc
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or port not in (None, 443):
        raise PreviewRefused()
    return parts._replace(fragment="").geturl()


def public_addresses(host):
    """Every address ``host`` resolves to, all of them global, or PreviewRefused."""
    try:
        rows = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise PreviewUnavailable() from exc
    addresses = set()
    for row in rows:
        try:
            address = ipaddress.ip_address(row[4][0].split("%", 1)[0])
        except ValueError as exc:
            raise PreviewRefused() from exc
        mapped = getattr(address, "ipv4_mapped", None)
        if not address.is_global or (mapped is not None and not mapped.is_global):
            raise PreviewRefused()
        addresses.add(str(mapped or address))
    if not addresses:
        raise PreviewUnavailable()
    return addresses


def _peer(response):
    stream = response.extensions.get("network_stream")
    try:
        peer = stream.get_extra_info("server_addr") if stream is not None else None
        address = ipaddress.ip_address(peer[0])
    except (TypeError, ValueError, IndexError):
        return None
    mapped = getattr(address, "ipv4_mapped", None)
    return str(mapped or address)


def fetch(url, accept, limit, deadline, referer=None):
    """GET one public HTTPS resource: ``(final_url, content_type, bytes)``."""
    for _ in range(MAX_REDIRECTS + 1):
        url = check_url(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PreviewUnavailable()
        host = urlsplit(url).hostname
        allowed = public_addresses(host)
        headers = {"User-Agent": UA, "Accept": accept}
        if referer and host == "www.pixiv.net":
            headers["Referer"] = referer
        try:
            with httpx.Client(timeout=httpx.Timeout(remaining), follow_redirects=False, trust_env=False) as client:
                with client.stream("GET", url, headers=headers) as response:
                    if _peer(response) not in allowed:
                        raise PreviewRefused()
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise PreviewUnavailable()
                        url = urljoin(url, location)
                        continue
                    if response.status_code != 200:
                        raise PreviewUnavailable()
                    content_type = response.headers.get("content-type", "").lower()
                    if content_type.startswith("image/"):
                        return url, content_type, b""
                    data = bytearray()
                    for chunk in response.iter_bytes():
                        data.extend(chunk)
                        if time.monotonic() > deadline:
                            raise PreviewUnavailable()
                        if len(data) >= limit:
                            if not content_type.startswith("text/html"):
                                raise PreviewUnavailable()
                            del data[limit:]
                            break
                    return url, content_type, bytes(data)
        except httpx.HTTPError as exc:
            raise PreviewUnavailable() from exc
    raise PreviewUnavailable()


META = re.compile(r"""<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>""", re.I | re.S)
ATTR = re.compile(r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.I | re.S)
TITLE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.I | re.S)
HIDDEN = re.compile(r"<!--.*?-->|<script\b[^>]*>.*?</script\s*>|<style\b[^>]*>.*?</style\s*>", re.I | re.S)
CHARSET = re.compile(r"""charset\s*=\s*["']?([a-zA-Z0-9_-]+)""", re.I)


def _attributes(tag):
    return {m.group(1).lower(): next(g for g in m.groups()[1:] if g is not None) for m in ATTR.finditer(tag)}


def _text(value):
    return " ".join(html.unescape(value).split())


def _https(value, base):
    try:
        return check_url(urljoin(base, value))
    except PreviewRefused:
        return None


def decode(data, content_type):
    label = CHARSET.search(content_type)
    if label is None:
        head = HIDDEN.sub("", data[:8192].decode("latin-1"))
        for tag in META.finditer(head):
            attrs = _attributes(tag.group(0))
            found = attrs.get("charset") or (CHARSET.search(attrs.get("content", "")) if attrs.get("http-equiv", "").lower() == "content-type" else None)
            if found:
                label = found if isinstance(found, str) else found.group(1)
                break
    else:
        label = label.group(1)
    try:
        codec = codecs.lookup(label or "utf-8").name
    except LookupError:
        codec = "utf-8"
    return data.decode(codec, errors="replace")


def parse(document, base):
    document = HIDDEN.sub("", document)
    values = {}
    for tag in META.finditer(document):
        attrs = _attributes(tag.group(0))
        name, content = attrs.get("property") or attrs.get("name"), attrs.get("content")
        if name and content is not None:
            text = _text(content)
            if text:
                values.setdefault(name.lower(), text)
    title = values.get("og:title") or values.get("twitter:title")
    if not title:
        match = TITLE.search(document)
        title = _text(match.group(1)) if match else ""
    image = next((url for key in ("og:image", "twitter:image", "twitter:image:src")
                  if key in values and (url := _https(values[key], base))), None)
    return {"title": (title or urlsplit(base).hostname or "")[:200], "siteName": values.get("og:site_name"),
            "imageUrl": image}


def _fallback(url):
    """The public oEmbed/API endpoint for an X, YouTube or pixiv link (as on the PC)."""
    parts = urlsplit(url)
    host = (parts.hostname or "").removeprefix("www.")
    path = [p for p in parts.path.split("/") if p]
    if host in ("x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com") and "status" in path:
        index = path.index("status")
        if index + 1 < len(path) and path[index + 1].isdigit():
            query = urlencode({"url": f"https://twitter.com/i/status/{path[index + 1]}", "omit_script": "true", "dnt": "true"})
            return "x", "https://publish.twitter.com/oembed?" + query
    if host in ("youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"):
        if host == "youtu.be":
            video = path[0] if path else ""
        elif path[:1] and path[0] in ("shorts", "embed", "live"):
            video = path[1] if len(path) > 1 else ""
        elif parts.path == "/watch":
            video = parse_qs(parts.query).get("v", [""])[0]
        else:
            video = ""
        if video and re.fullmatch(r"[A-Za-z0-9_-]+", video):
            return "youtube", "https://www.youtube.com/oembed?" + urlencode({"url": f"https://www.youtube.com/watch?v={video}", "format": "json"})
    if host == "pixiv.net" and "artworks" in path:
        index = path.index("artworks")
        if index + 1 < len(path) and path[index + 1].isdigit():
            return "pixiv", f"https://www.pixiv.net/ajax/illust/{path[index + 1]}"
    return None


def _fallback_preview(provider, data):
    value = json.loads(data)
    if provider == "x":
        paragraph = re.search(r"<p\b[^>]*>(.*?)</p\s*>", HIDDEN.sub("", value.get("html") or ""), re.I | re.S)
        body = _text(re.sub(r"<[^>]*>", "", re.sub(r"<br\s*/?>", " ", paragraph.group(1), flags=re.I))) if paragraph else ""
        author = _text(value.get("author_name") or "")
        title = f"{author}: {body}" if body and author else body
    elif provider == "youtube":
        title = _text(value.get("title") or "")
    else:
        if value.get("error") is True:
            raise PreviewUnavailable()
        title = _text(((value.get("body") or {}).get("title")) or "")
    if not title:
        raise PreviewUnavailable()
    thumbnail = value.get("thumbnail_url")
    return {"title": title[:200], "siteName": {"x": "X", "youtube": "YouTube", "pixiv": "pixiv"}[provider],
            "imageUrl": _https(thumbnail, "https://example.invalid/") if isinstance(thumbnail, str) else None}


GENERIC = {"x", "twitter", "x / ?", "youtube", "- youtube", "pixiv", "x.com", "twitter.com", "www.youtube.com",
           "youtube.com", "www.pixiv.net", "pixiv.net"}


def preview(url, fetcher=fetch):
    url = check_url(url)
    deadline = time.monotonic() + BUDGET_SECONDS
    fallback = _fallback(url)
    try:
        final, content_type, data = fetcher(url, "text/html,application/json;q=0.9,image/*;q=0.8", HTML_LIMIT,
                                            deadline - (BUDGET_SECONDS / 2 if fallback else 0))
        result = ({"title": urlsplit(final).hostname or "", "siteName": None, "imageUrl": final}
                  if content_type.startswith("image/") else parse(decode(data, content_type), final))
    except PreviewUnavailable:
        result = None
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    generic = result is None or result["title"].lower().removeprefix("www.") == host or result["title"].lower() in GENERIC
    if fallback and generic:
        provider, endpoint = fallback
        try:
            _, _, data = fetcher(endpoint, "application/json", JSON_LIMIT, deadline, "https://www.pixiv.net/")
            better = _fallback_preview(provider, data)
            if result is not None and result["imageUrl"]:
                better["imageUrl"] = result["imageUrl"]
            result = better
        except (PreviewUnavailable, PreviewRefused, ValueError, AttributeError, TypeError):
            pass
    if result is None:
        raise PreviewUnavailable()
    return result


class Cache:
    def __init__(self):
        self.lock = threading.Lock()
        self.rows = OrderedDict()

    def get(self, key):
        with self.lock:
            row = self.rows.get(key)
            if row is None or row[0] < time.monotonic():
                self.rows.pop(key, None)
                return None
            self.rows.move_to_end(key)
            return row

    def put(self, key, value, seconds):
        with self.lock:
            self.rows[key] = (time.monotonic() + seconds, value)
            self.rows.move_to_end(key)
            while len(self.rows) > CACHE_ENTRIES:
                self.rows.popitem(last=False)


def register(app, require_client, fetcher=fetch):
    cache = Cache()
    slots = threading.BoundedSemaphore(2)

    def run(url):
        key = hashlib.sha256(url.encode()).hexdigest()
        cached = cache.get(key)
        if cached is not None:
            return cached[1]
        if not slots.acquire(timeout=BUDGET_SECONDS):
            raise HTTPException(503, {"code": "previewBusy", "message": "잠시 후 다시 시도해 주세요."})
        try:
            try:
                result = preview(url, fetcher)
            except PreviewRefused:
                result = None
                failure = (422, {"code": "previewRefused", "message": "미리보기를 가져올 수 없는 주소입니다."})
            except PreviewUnavailable:
                result = None
                failure = (502, {"code": "previewUnavailable", "message": "미리보기를 가져오지 못했습니다."})
            value = result if result is not None else failure
            cache.put(key, value, CACHE_SECONDS if result is not None else FAILURE_SECONDS)
        finally:
            slots.release()
        return value

    @app.post(ROUTE)
    async def link_preview(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY_BYTES:
                raise HTTPException(413, {"code": "previewTooLarge", "message": "요청이 너무 큽니다."})
        try:
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) != {"url"}:
                raise ValueError()
            url = check_url(body["url"])
        except (ValueError, PreviewRefused):
            raise HTTPException(422, {"code": "previewRefused", "message": "미리보기를 가져올 수 없는 주소입니다."})
        value = await run_in_threadpool(run, url)
        if isinstance(value, tuple):
            raise HTTPException(*value)
        return value
