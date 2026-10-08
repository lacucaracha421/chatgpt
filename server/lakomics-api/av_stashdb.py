"""StashDB person relay. Credentials and provider image addresses stay server-side."""
from __future__ import annotations

import io
import json
import re
import threading
import time
import warnings
from collections import OrderedDict
from datetime import date
from typing import Literal
from urllib.parse import urlencode, urlsplit

from fastapi import Header, Query, Request, Response
from starlette.concurrency import run_in_threadpool

import collection_authority as ca
import work_providers as wp
import av_contract

KEY_ENV = "LAKOMICS_STASHDB_API_KEY"
ENDPOINT = "https://stashdb.org/graphql"
FIELDS = ("id name aliases disambiguation gender birth_date career_start_year career_end_year "
          "height breast_type cup_size band_size waist_size hip_size "
          "urls { url site { name } } images { id url width height }")
MAX_JSON = 1024 * 1024
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_IMAGE_PIXELS = 24 * 1024 * 1024
PREFIX = "/v1/providers/stashdb"
relay = wp.Relay()
# Reuse Relay's nonblocking admission, error mapping and deadline without changing
# the GraphQL/TMDB/IGDB lanes. Images have no inter-request pacing.
image_relay = wp.Relay()
image_relay.locks["stashdb"] = threading.BoundedSemaphore(4)
DETAIL_TTL = 10 * 60
MAX_DETAIL_ENTRIES = 128
MAX_PREVIEW_BYTES = 64 * 1024 * 1024
cache_lock = threading.Lock()
detail_cache = OrderedDict()
preview_cache = OrderedDict()
preview_bytes = 0


def cache_performer(value):
    global preview_bytes
    id_ = value["stashdbId"]
    with cache_lock:
        previous = detail_cache.get(id_)
        old_images = {i["id"]: i for i in previous[1]["images"]} if previous else {}
        new_images = {i["id"]: i for i in value["images"]}
        detail_cache[id_] = (time.monotonic() + DETAIL_TTL, value)
        detail_cache.move_to_end(id_)
        while len(detail_cache) > MAX_DETAIL_ENTRIES:
            detail_cache.popitem(last=False)
        # A fresh response may remove photos or change the URL for an existing ID.
        for key in list(preview_cache):
            if key[0] == id_ and old_images.get(key[1]) != new_images.get(key[1]):
                preview_bytes -= len(preview_cache.pop(key))
    return value


def cached_detail(id_, deadline):
    wp.require_keys("stashdb")
    with cache_lock:
        entry = detail_cache.get(id_)
        if entry is not None:
            if entry[0] > time.monotonic():
                detail_cache.move_to_end(id_)
                return entry[1]
            del detail_cache[id_]
    # Only cache misses need the GraphQL lane; don't extend the image deadline.
    return relay.paced("stashdb", lambda _: detail(id_, deadline))


def cached_preview(key):
    with cache_lock:
        data = preview_cache.get(key)
        if data is not None:
            preview_cache.move_to_end(key)
        return data


def cache_preview(key, data, *, source_url=None):
    global preview_bytes
    with cache_lock:
        if source_url is not None:
            entry = detail_cache.get(key[0])
            if entry is None or not any(i["id"] == key[1] and i["url"] == source_url
                                        for i in entry[1]["images"]):
                return  # A refresh raced with the download; don't retain stale bytes.
        previous = preview_cache.pop(key, None)
        if previous is not None:
            preview_bytes -= len(previous)
        if len(data) > MAX_PREVIEW_BYTES:
            return
        preview_cache[key] = data
        preview_bytes += len(data)
        while preview_bytes > MAX_PREVIEW_BYTES:
            _, removed = preview_cache.popitem(last=False)
            preview_bytes -= len(removed)



def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        wp.fail(422, "providerIdentityInvalid", "StashDB 인물 또는 사진 ID가 올바르지 않습니다.")
    return value


def safe_url(value):
    if not isinstance(value, str) or len(value) > 2000 or any(ord(c) < 32 for c in value):
        return False
    try:
        u = urlsplit(value)
        return u.scheme in ("http", "https") and bool(u.hostname) and not u.username and not u.password
    except ValueError:
        return False


def image_address(value):
    # Stash-box can return arbitrary URL images; never turn those into an SSRF relay.
    if not safe_url(value):
        return False
    u = urlsplit(value)
    return (u.scheme == "https" and u.netloc in ("stashdb.org", "cdn.stashdb.org")
            and re.fullmatch(r"/images/[A-Za-z0-9_./-]+", u.path) is not None
            and ".." not in u.path and not u.query and not u.fragment)


def normalize_name(value):
    return " ".join("".join(chr(ord(c) - 0xfee0) if '\uff01' <= c <= '\uff5e' else c
                            for c in value).split()).lower()


def valid_date(value):
    if not isinstance(value, str):
        return None
    try:
        if re.fullmatch(r"\d{4}", value) and 1900 <= int(value) <= 2200:
            return value
        if re.fullmatch(r"\d{4}-\d{2}", value):
            date.fromisoformat(value + "-01")
            return value
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date.fromisoformat(value)
            return value
    except ValueError:
        pass
    return None


def number(value, low, high):
    return value if type(value) is int and low <= value <= high else None


def normalize(row):
    id_ = row["id"]
    if not isinstance(id_, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", id_):
        raise ValueError("invalid performer identity")
    name, aliases = row["name"], row.get("aliases", [])
    if (not isinstance(name, str) or not name.strip() or len(name) > 500
            or not isinstance(aliases, list) or len(aliases) > 100
            or any(not isinstance(a, str) or len(a) > 500 for a in aliases)):
        raise ValueError("invalid performer")
    cup = row.get("cup_size")
    cup = cup if isinstance(cup, str) and cup.strip() and len(cup) <= 20 else None
    breast = row.get("breast_type")
    breast = breast if breast in ("NATURAL", "FAKE", "NA") else None
    start, end = number(row.get("career_start_year"), 1900, 2200), number(row.get("career_end_year"), 1900, 2200)
    if start is not None and end is not None and end < start:
        end = None
    urls = [{"url": u["url"], "site": {"name": u["site"]["name"]}} for u in row.get("urls", [])
            if safe_url(u.get("url")) and isinstance(u.get("site", {}).get("name"), str)
            and len(u["site"]["name"]) <= 200][:100]
    images = []
    for i in row.get("images", []):
        if (isinstance(i.get("id"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", i["id"])
                and image_address(i.get("url")) and number(i.get("width"), 1, 2**32 - 1)
                and number(i.get("height"), 1, 2**32 - 1)):
            images.append({k: i[k] for k in ("id", "url", "width", "height")})
    return {"stashdbId": id_, "name": name, "aliases": aliases,
            "birthDate": valid_date(row.get("birth_date")), "heightCm": number(row.get("height"), 1, 300),
            **{k: number(row.get(raw), 1, 200) for k, raw in
               (("bandIn", "band_size"), ("waistIn", "waist_size"), ("hipIn", "hip_size"))},
            "cup": cup, "breastType": breast, "careerStart": start, "careerEnd": end,
            "urls": urls, "images": images[:500]}


def graphql(field, variables, deadline):
    wp.require_keys("stashdb")
    query = (f"query($t:String!){{searchPerformer(term:$t,limit:5){{{FIELDS}}}}}" if field == "searchPerformer"
             else f"query($id:ID!){{findPerformer(id:$id){{{FIELDS}}}}}")
    # Reuse pacing, deadlines, response limits and no-redirect/no-proxy transport.
    raw = relay.json_request("stashdb", ENDPOINT, deadline,
        headers={"ApiKey": wp.credential(KEY_ENV), "Content-Type": "application/json"},
        body=json.dumps({"query": query, "variables": variables}).encode(), budget=[MAX_JSON])
    if not isinstance(raw, dict) or raw.get("errors"):
        wp.fail(502, "providerInvalidResponse", "StashDB 응답이 올바르지 않습니다.")
    return raw["data"][field]


def detail(id_, deadline):
    raw = graphql("findPerformer", {"id": id_}, deadline)
    if raw is None:
        wp.fail(404, "providerNotFound", "StashDB에서 인물을 찾을 수 없습니다.")
    if raw.get("id") != id_ or raw.get("gender") not in (None, "FEMALE"):
        raise ValueError("invalid performer identity or gender")
    return cache_performer(normalize(raw))


def public_detail(value):
    result = {**value, "images": [{**i, "url": PREFIX + "/image?" + urlencode(
        {"stashdbId": value["stashdbId"], "imageId": i["id"]})} for i in value["images"]]}
    result["previewUrl"] = result["images"][0]["url"] if result["images"] else None
    result["imageUrl"] = result["previewUrl"]  # PC candidate field.
    return wp.bounded_result(result)


def search(query, deadline):
    rows = graphql("searchPerformer", {"t": query}, deadline)
    if not isinstance(rows, list) or len(rows) > 5:
        raise ValueError("invalid search results")
    items = [public_detail(cache_performer(normalize(r))) for r in rows if r.get("gender") in (None, "FEMALE")]
    exact = [r for r in items if normalize_name(query) in
             [normalize_name(n) for n in [r["name"], *r["aliases"]]]]
    # Read-only hints, never persist ambiguous/none or auto-attach a single result.
    status = "none" if not items else "matched" if len(exact) == 1 else "ambiguous"
    return wp.bounded_result({"items": items, "status": status,
                              "matchedId": exact[0]["stashdbId"] if status == "matched" else None})


def profile(value):
    result = {"stashdbId": value["stashdbId"], "profile": {"source": "stashdb",
            **{k: v for k, v in value.items() if k not in ("stashdbId", "images", "urls")},
            "urls": [{"site": u["site"]["name"], "url": u["url"]} for u in value["urls"]]}}
    from mobile_collections import MAX_PERSON_BYTES
    if len(ca.encode(result).encode()) > MAX_PERSON_BYTES:
        wp.fail(413, "providerResponseTooLarge", "프로필 크기가 허용 범위를 초과했습니다.")
    return result


def apply_profile_command(get_db, **command):
    # Replay before keys/network. Close the read transaction before calling a provider.
    with get_db() as db:
        row, _, cached = ca.command_preflight(db, **{k: v for k, v in command.items() if k != "now"})
        if cached is not None:
            return cached
        ctx = ca.Context(db, row, command_type=ca.PERSON_PROFILE,
                         operation_id=command["operation_id"], now=command["now"])
        ca._person_row(ctx, command["entity"]["personId"])
    id_ = command["entity"]["stashdbId"]
    prepared = None if id_ is None else relay.paced("stashdb", lambda d: profile(detail(id_, d)))
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            result = ca.apply_command(db, **command, prepared_profile=prepared)
            db.commit()
            return result
        except BaseException:
            db.rollback()
            raise


def resolve_image(id_, image_id, deadline):
    performer = cached_detail(id_, deadline)
    chosen = next((i for i in performer["images"] if i["id"] == image_id), None)
    if chosen is None:
        wp.fail(404, "providerNotFound", "StashDB에서 사진을 찾을 수 없습니다.")
    return chosen


def download_image(chosen, deadline):
    # Same-origin image routes may require auth. Never forward the key to the public CDN.
    headers = {"ApiKey": wp.credential(KEY_ENV)} if urlsplit(chosen["url"]).netloc == "stashdb.org" else {}
    data, mime = wp.outbound(chosen["url"], deadline=deadline, limit=MAX_IMAGE_BYTES, headers=headers, image=True)
    wp.image_dimensions(data, mime, max_pixels=MAX_IMAGE_PIXELS)
    return data, mime, chosen["url"]


def fetch_image(id_, image_id, deadline):
    return download_image(resolve_image(id_, image_id, deadline), deadline)


def fetch_preview(id_, image_id, deadline):
    # Membership must be checked even when preview bytes are already cached.
    chosen = resolve_image(id_, image_id, deadline)
    key = (id_, image_id)
    encoded = cached_preview(key)
    if encoded is None:
        data, mime, _ = download_image(chosen, deadline)
        encoded, _, _ = encode_portrait(data, mime, bound=400, quality=80)
        if time.monotonic() >= deadline:
            wp.fail(504, "providerTimeout", "사진 미리보기 처리 시간이 초과되었습니다.")
        cache_preview(key, encoded, source_url=chosen["url"])
    return encoded, "image/jpeg"


def encode_portrait(data, mime, *, bound=av_contract.MAX_PORTRAIT_DIMENSION, quality=88):
    wp.image_dimensions(data, mime, max_pixels=MAX_IMAGE_PIXELS)
    try:
        from PIL import Image, ImageOps
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ("JPEG", "PNG", "WEBP") or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("unsupported image")
                image = ImageOps.exif_transpose(image)
                frame = image.convert("RGB")
        frame.thumbnail((bound,) * 2, Image.Resampling.LANCZOS)
        output = io.BytesIO()
        frame.save(output, format="JPEG", quality=quality)
        encoded = output.getvalue()
        if not 0 < len(encoded) <= av_contract.MAX_PORTRAIT_BYTES:
            wp.fail(413, "providerResponseTooLarge", "초상 이미지 크기가 허용 범위를 초과했습니다.")
        return encoded, frame.width, frame.height
    except wp.HTTPException:
        raise
    except Exception:
        wp.fail(422, "providerImageInvalid", "초상 이미지 형식이 올바르지 않습니다.")


def store_portrait(id_, image_id, deadline, get_db, storage, bucket):
    data, mime, source_url = fetch_image(id_, image_id, deadline)
    encoded, width, height = encode_portrait(data, mime)
    try:
        original = wp._stored_blob(storage(), bucket(), encoded, "image/jpeg", deadline=deadline)
        if time.monotonic() >= deadline:
            wp.fail(504, "providerTimeout", "초상 이미지 저장 시간이 초과되었습니다.")
        with get_db() as db:
            db.execute("INSERT INTO mobile_collection_artwork VALUES (?,?,?) ON CONFLICT(sha256) "
                       "DO UPDATE SET size_bytes=excluded.size_bytes,content_type=excluded.content_type",
                       (original["sha256"], original["sizeBytes"], original["contentType"]))
            db.commit()
    except wp.HTTPException:
        raise
    except Exception:
        wp.fail(502, "providerArtworkStorageUnavailable", "이미지를 저장할 수 없습니다.")
    return {"original": original, "width": width, "height": height,
            "attribution": {"source": "stashdb", "sourceUrl": source_url, "license": None, "author": None}}


def register(app, get_db, require_client, storage, bucket, *, provider_relay=None):
    global relay
    if provider_relay is not None:
        relay = provider_relay

    @app.get(PREFIX + "/search")
    def performer_search(query: str = Query(min_length=1, max_length=200),
                         authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not query.strip() or any(ord(c) < 32 for c in query):
            wp.fail(422, "providerQueryInvalid", "검색어를 입력해 주세요.")
        return relay.paced("stashdb", lambda d: search(query.strip(), d))

    @app.get(PREFIX + "/image")
    def image(stashdbId: str, imageId: str, size: Literal["preview"] | None = None,
              authorization: str | None = Header(default=None)):
        require_client(authorization)
        identity(stashdbId)
        identity(imageId)
        def fetch(deadline):
            if size == "preview":
                data, mime = fetch_preview(stashdbId, imageId, deadline)
            else:
                data, mime, _ = fetch_image(stashdbId, imageId, deadline)
            return Response(data, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})
        return image_relay.paced("stashdb", fetch)

    @app.post(PREFIX + "/portrait")
    async def portrait(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await ca._read_body(request, 2048, "providerRequestTooLarge")
        if not isinstance(body, dict) or set(body) != {"stashdbId", "imageId"}:
            wp.fail(422, "providerArtworkInvalid", "사진 선택 요청이 올바르지 않습니다.")
        id_, image_id = identity(body["stashdbId"]), identity(body["imageId"])
        return await run_in_threadpool(image_relay.paced, "stashdb", lambda deadline:
            relay.paced("artwork", lambda _: store_portrait(id_, image_id, deadline, get_db, storage, bucket)))

    @app.get(PREFIX + "/performers/{stashdbId}")
    def performer_detail(stashdbId: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        identity(stashdbId)
        return relay.paced("stashdb", lambda d: public_detail(detail(stashdbId, d)))
