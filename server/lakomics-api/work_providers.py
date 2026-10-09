"""Interactive TMDB/IGDB relay and server-built Collections authority commands."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import threading
import time
import warnings
import uuid
from datetime import date, datetime, timedelta, timezone
from contextlib import contextmanager
from http.client import HTTPException as HTTPClientError
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request as HTTPRequest, build_opener

from botocore.config import Config
from botocore.exceptions import ClientError
from fastapi import Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

import collection_authority as ca
import head_cache
from mobile_collections import MAX_ARTWORK_BYTES, MAX_THUMBNAIL_BYTES, artwork_key

TMDB_KEY_ENV = "LAKOMICS_TMDB_API_KEY"
IGDB_ID_ENV = "LAKOMICS_IGDB_CLIENT_ID"
IGDB_SECRET_ENV = "LAKOMICS_IGDB_CLIENT_SECRET"
TMDB_ORIGIN = "https://api.themoviedb.org/3"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
GAMES_URL = "https://api.igdb.com/v4/games"
MAX_JSON_BYTES = ca.MAX_SNAPSHOT_BYTES
# Raw TMDB detail and season replies carry crew and guest casts the parsed snapshot drops,
# so they are bounded separately from MAX_JSON_BYTES (one ko-KR season measured 2.3 MiB).
MAX_RAW_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_RAW_TOTAL_BYTES = 32 * 1024 * 1024
REQUEST_SECONDS = 25
# Automatic imports are sequential and retain only manifests, never a gallery's bytes.
# PC allows 200 seasons, 16 MiB per authority image and 32 MiB of season posters.
MAX_AUTO_ARTWORK_BYTES = 32 * 1024 * 1024
MAX_AUTO_IMAGE_PIXELS = 16 * 1024 * 1024
ARTWORK_COMMIT_SECONDS = 2
AUTO_IMAGE_SECONDS = 5
IGDB_FIELDS = ("id,name,summary,first_release_date,genres.name,platforms.name,"
               "release_dates.date,release_dates.platform.name,involved_companies.developer,"
               "involved_companies.publisher,involved_companies.company.name,"
               "cover.image_id,cover.width,cover.height,artworks.image_id,artworks.width,"
               "artworks.height,screenshots.image_id,screenshots.width,screenshots.height")
TMDB_SIZES = {"original", "w92", "w154", "w185", "w342", "w500", "w780", "w300", "w1280"}
IGDB_SIZES = {"original", "cover_small", "cover_big", "thumb", "screenshot_med",
              "screenshot_big", "screenshot_huge", "720p", "1080p"}
PREVIEW_SIZES = {"tmdb": {"w185", "w342", "w780"},
                 "igdb": {"t_cover_big", "t_screenshot_med", "t_720p", "t_1080p"}}


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message}) from None


def credential(name):
    value = os.environ.get(name, "").strip()
    return value if value and len(value) <= 4096 and all(33 <= ord(c) <= 126 for c in value) else None


def configured():
    return {"tmdb": credential(TMDB_KEY_ENV) is not None,
            "igdb": bool(credential(IGDB_ID_ENV) and credential(IGDB_SECRET_ENV)),
            "stashdb": credential("LAKOMICS_STASHDB_API_KEY") is not None}


def require_keys(provider):
    if not configured()[provider]:
        fail(503, "providerNotConfigured", f"서버에 {provider.upper()} API 키가 설정되지 않았습니다.")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# urllib does not log request URLs/headers (including the TMDB v3 query key).
# Environment proxies are disabled; destinations are built exclusively below.
_opener = build_opener(ProxyHandler({}), NoRedirect())


class UpstreamStatus(Exception):
    def __init__(self, status, retry_after=None):
        super().__init__("provider HTTP status")
        self.status = status
        self.retry_after = retry_after


def outbound(url, *, deadline, limit=MAX_JSON_BYTES, headers=None, body=None, image=False,
             socket_seconds=5):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
    request = HTTPRequest(url, data=body, headers=headers or {})
    try:
        with _opener.open(request, timeout=min(socket_seconds, remaining)) as response:
            if response.status != 200:
                raise UpstreamStatus(response.status)
            mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if image and mime not in ca.IMAGE_MIMES:
                fail(422, "providerImageInvalid", "이미지 형식의 응답만 저장할 수 있습니다.")
            declared = response.headers.get("Content-Length")
            if declared is not None and int(declared) > limit:
                fail(413, "providerResponseTooLarge", "외부 응답 크기가 허용 범위를 초과했습니다.")
            chunks = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
                # One socket read at a time, so a slow trickle cannot keep a
                # read(65536) waiting beyond the whole download budget.
                chunk = response.read1(min(65536, limit + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
                if len(chunks) > limit:
                    fail(413, "providerResponseTooLarge", "외부 응답 크기가 허용 범위를 초과했습니다.")
            if time.monotonic() >= deadline:
                fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
            return bytes(chunks), mime
    except HTTPError as exc:
        status = exc.code
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        try:
            retry_after = min(86400, max(0, int(retry_after)))
        except (TypeError, ValueError):
            # HTTP-date Retry-After is also valid; never retain headers or URLs.
            from email.utils import parsedate_to_datetime
            try:
                retry_after = min(86400, max(0, (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()))
            except (TypeError, ValueError, OverflowError):
                retry_after = None
        exc.close()
        raise UpstreamStatus(status, retry_after) from None
    except TimeoutError:
        fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
        fail(502, "providerUnavailable", "외부 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.")
    except (OSError, HTTPClientError):
        fail(502, "providerUnavailable", "외부 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.")
    except (ValueError, UnicodeError):
        fail(502, "providerInvalidResponse", "외부 서비스의 응답이 올바르지 않습니다.")


def finite_json_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("nonfinite JSON number")
    return result


def status_error(status):
    if 300 <= status < 400:
        fail(502, "providerRedirectRefused", "외부 서비스의 주소 변경 응답을 허용하지 않습니다.")
    if status == 404:
        fail(404, "providerNotFound", "외부 서비스에서 작품이나 이미지를 찾을 수 없습니다.")
    if status in (401, 403):
        fail(502, "providerUnauthorized", "외부 서비스 API 키를 확인해 주세요.")
    if status == 429:
        fail(429, "providerRateLimited", "외부 서비스 요청이 많습니다. 잠시 후 다시 시도해 주세요.")
    fail(502, "providerUnavailable", "외부 서비스 응답을 받을 수 없습니다.")


class Relay:
    def __init__(self):
        self.locks = {name: threading.Lock() for name in ("tmdb", "igdb", "stashdb", "artwork")}
        self.next_request = {name: 0.0 for name in self.locks}
        self.token_lock = threading.Lock()
        self.token = None
        self.token_credentials = None
        self.token_expiry = 0.0
        self.request_context = threading.local()

    @contextmanager
    def request_scope(self, provider, *, background=False, budget=None):
        """Use the existing provider lock/clock; pacing can yield exclusive work.

        Scope ownership is thread-local so a failed reacquisition cannot release
        another caller's lock. Outbound accounting includes OAuth and 401 retries.
        """
        lock = self.locks[provider]
        acquired = lock.acquire(timeout=0 if background else 0.5)
        if not acquired:
            if background:
                from release_calendar import BudgetExceeded
                raise BudgetExceeded()
            fail(429, "providerBusy", "외부 정보 조회가 진행 중입니다. 잠시 후 다시 시도해 주세요.")
        scope = {"provider": provider, "held": True, "background": background, "budget": budget}
        previous = getattr(self.request_context, "scope", None)
        self.request_context.scope = scope
        try:
            yield
        finally:
            if scope["held"]:
                lock.release()
            self.request_context.scope = previous

    def paced(self, provider, action):
        if provider in ("tmdb", "igdb"):
            try:
                with self.request_scope(provider):
                    return action(time.monotonic() + REQUEST_SECONDS)
            except UpstreamStatus as exc:
                status_error(exc.status)
            except (AttributeError, KeyError, TypeError, ValueError, OverflowError, ValidationError):
                fail(502, "providerInvalidResponse", "외부 서비스의 응답이 올바르지 않습니다.")
        # Briefly wait for a worker request/pacing interval; keep the queue bounded.
        lock = self.locks[provider]
        if not lock.acquire(timeout=0.5 if provider in ("tmdb", "igdb") else 0):
            fail(429, "providerBusy", "외부 정보 조회가 진행 중입니다. 잠시 후 다시 시도해 주세요.")
        try:
            if provider == "artwork":
                time.sleep(max(0, self.next_request[provider] - time.monotonic()))
                self.next_request[provider] = time.monotonic() + 0.1
            return action(time.monotonic() + REQUEST_SECONDS)
        except UpstreamStatus as exc:
            status_error(exc.status)
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError, ValidationError):
            fail(502, "providerInvalidResponse", "외부 서비스의 응답이 올바르지 않습니다.")
        finally:
            lock.release()

    def json_request(self, provider, url, deadline, *, headers=None, body=None, budget=None):
        interval = 0.25 if provider == "igdb" else 0.1
        if provider not in ("igdb", "tmdb"):
            # Preserve the existing StashDB/artwork callers' outer-lock contract.
            wait = max(0, self.next_request[provider] - time.monotonic())
            if time.monotonic() + wait >= deadline:
                fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
            time.sleep(wait)
            self.next_request[provider] = time.monotonic() + interval
            return self._read_json(provider, url, deadline, headers=headers, body=body, budget=budget)
        scope = getattr(self.request_context, "scope", None)
        if scope is None or scope["provider"] != provider:
            with self.request_scope(provider):
                return self.json_request(provider, url, deadline, headers=headers, body=body, budget=budget)
        lock = self.locks[provider]
        while True:
            target = self.next_request[provider]
            wait = max(0, target - time.monotonic())
            if time.monotonic() + wait >= deadline:
                fail(504, "providerTimeout", "외부 정보 조회 시간이 초과되었습니다.")
            if wait <= 0:
                break
            scope["held"] = False
            lock.release()
            time.sleep(wait)
            acquired = lock.acquire(timeout=0 if scope["background"] else min(0.5, max(0, deadline - time.monotonic())))
            if not acquired:
                if scope["background"]:
                    from release_calendar import BudgetExceeded
                    raise BudgetExceeded()
                fail(429, "providerBusy", "외부 정보 조회가 진행 중입니다. 잠시 후 다시 시도해 주세요.")
            scope["held"] = True
            if self.next_request[provider] == target:
                break  # Nobody used the provider while we slept: the interval has passed.
            # An interactive request advanced the clock while we slept; wait again.
        accounting = scope["budget"]
        if accounting is not None and hasattr(accounting, "outbound"):
            accounting.outbound()
        self.next_request[provider] = time.monotonic() + interval
        return self._read_json(provider, url, deadline, headers=headers, body=body, budget=budget, accounting=accounting)

    def _read_json(self, provider, url, deadline, *, headers=None, body=None, budget=None, accounting=None):
        limit = MAX_JSON_BYTES if budget is None else min(MAX_RAW_RESPONSE_BYTES, budget[0])
        if accounting is not None and hasattr(accounting, "bytes_left"):
            limit = min(limit, accounting.bytes_left, 4 * 1024 * 1024)
        data, _ = outbound(url, deadline=deadline, limit=limit, headers=headers, body=body)
        if accounting is not None and hasattr(accounting, "consume"):
            accounting.consume(len(data))
        if budget is not None:
            budget[0] -= len(data)
        def invalid_constant(value):
            raise ValueError("nonfinite JSON number")
        return json.loads(data, parse_constant=invalid_constant, parse_float=finite_json_float)

    def tmdb(self, path, deadline, *, params=None, budget=None):
        key = credential(TMDB_KEY_ENV)
        require_keys("tmdb")
        params = dict(params or {})
        headers = {"Accept": "application/json"}
        if re.fullmatch(r"eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", key):
            headers["Authorization"] = "Bearer " + key
        else:
            params["api_key"] = key
        return self.json_request("tmdb", TMDB_ORIGIN + path + "?" + urlencode(params),
                                 deadline, headers=headers, budget=budget)

    def twitch_token(self, deadline, rejected=None):
        require_keys("igdb")
        credentials = (credential(IGDB_ID_ENV), credential(IGDB_SECRET_ENV))
        with self.token_lock:
            if (self.token and self.token_credentials == credentials
                    and time.monotonic() < self.token_expiry and self.token != rejected):
                return self.token
            self.token = None
        # Pacing releases the provider lock. Holding token_lock across that yield
        # would invert lock order against another IGDB caller's token lookup.
        value = self.json_request("igdb", TOKEN_URL, deadline,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=urlencode({"client_id": credentials[0], "client_secret": credentials[1],
                            "grant_type": "client_credentials"}).encode())
        if not isinstance(value, dict):
            raise ValueError("invalid token")
        token, expiry = value.get("access_token"), value.get("expires_in")
        if not isinstance(token, str) or not token or not all(33 <= ord(c) <= 126 for c in token) \
                or type(expiry) is not int or expiry <= 0:
            raise ValueError("invalid token")
        with self.token_lock:
            self.token, self.token_credentials = token, credentials
            self.token_expiry = time.monotonic() + max(0, expiry - 60)
            return token

    def igdb(self, query, deadline, *, budget=None):
        token = self.twitch_token(deadline)
        for attempt in range(2):
            try:
                return self.json_request("igdb", GAMES_URL, deadline,
                    headers={"Client-ID": credential(IGDB_ID_ENV), "Authorization": "Bearer " + token,
                             "Content-Type": "text/plain"}, body=query.encode(), budget=budget)
            except UpstreamStatus as exc:
                if exc.status != 401 or attempt:
                    raise
                token = self.twitch_token(deadline, rejected=token)


def text(value):
    return value.strip() or None if isinstance(value, str) else None


def unique(values):
    return list(dict.fromkeys(value for value in values if value))


def names(items):
    return unique(text(item.get("name")) for item in items or [])


def joined(items):
    return " · ".join(value for item in items if (value := text(item))) or None


def bounded_result(value):
    if len(ca.encode(value).encode()) > MAX_JSON_BYTES:
        fail(413, "providerResponseTooLarge", "외부 응답 크기가 허용 범위를 초과했습니다.")
    return value


def valid_date(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value[:10]):
            return None
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        return None


def timestamp_date(value):
    try:
        # Avoid Windows CRT limitations on negative Unix timestamps.
        return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=value)).date().isoformat() \
            if type(value) is int else None
    except (ValueError, OverflowError):
        return None


def positive(value):
    return value if type(value) is int and 0 < value <= 1_000_000 else None


def identity(value):
    if type(value) is not int or not 0 < value < 10**18:
        raise ValueError("invalid identity")
    return value


def image_url(provider, path, size):
    if provider == "tmdb":
        if size not in TMDB_SIZES or not re.fullmatch(r"/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)", path):
            fail(422, "providerImagePathInvalid", "TMDB 이미지 경로나 크기가 올바르지 않습니다.")
        return f"https://image.tmdb.org/t/p/{size}{path}"
    if provider == "igdb":
        if size not in IGDB_SIZES or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", path):
            fail(422, "providerImagePathInvalid", "IGDB 이미지 ID나 크기가 올바르지 않습니다.")
        return f"https://images.igdb.com/igdb/image/upload/t_{size}/{path}.jpg"
    fail(422, "providerInvalid", "지원하지 않는 외부 서비스입니다.")


def preview_url(provider, path, size):
    preview_image_url(provider, path, size)
    return "/v1/providers/image?" + urlencode({"provider": provider, "path": path, "size": size})


def preview_image_url(provider, path, size):
    if provider not in PREVIEW_SIZES:
        fail(422, "providerInvalid", "지원하지 않는 외부 서비스입니다.")
    if size not in PREVIEW_SIZES[provider] or not 1 <= len(path) <= 512:
        fail(422, "providerImagePathInvalid", "미리보기 이미지 크기가 올바르지 않습니다.")
    return image_url(provider, path, size[2:] if provider == "igdb" else size)


def candidate(provider, kind, path, width=None, height=None, **extra):
    size = ("w780" if kind == "backdrop" else "w342") if provider == "tmdb" else \
        ("t_cover_big" if kind == "cover" else "t_1080p")
    return {"kind": kind, "path": path,
            "previewUrl": preview_url(provider, path, size),
            "width": positive(width), "height": positive(height), **extra}


def tmdb_images(raw, group, primary):
    result = []
    for image in (raw.get("images") or {}).get(group) or []:
        path = image.get("file_path")
        if path is not None:
            image_url("tmdb", path, "original")
            result.append({"filePath": path, "width": positive(image.get("width")),
                           "height": positive(image.get("height"))})
    path = text(raw.get(primary))
    if path is not None:
        image_url("tmdb", path, "original")
        if not any(image["filePath"] == path for image in result):
            result.insert(0, {"filePath": path, "width": None, "height": None})
    return result


def film_details(raw):
    cast = sorted((raw.get("credits") or {}).get("cast") or [],
                  key=lambda person: person.get("order") if type(person.get("order")) is int else 2**63)
    cast = [{"name": text(p.get("name")), "character": text(p.get("character")) or ""}
            for p in cast if text(p.get("name"))][:8]
    releases = []
    for country in (raw.get("release_dates") or {}).get("results") or []:
        for release in country.get("release_dates") or []:
            day = valid_date(release.get("release_date"))
            kind = release.get("type")
            if day and type(kind) is int and 1 <= kind <= 6:
                releases.append({"country": country.get("iso_3166_1", ""), "releaseType": kind,
                                 "date": day, "certification": text(release.get("certification")) or ""})
    return {"cast": cast, "releases": sorted(releases, key=lambda r: r["date"]), "related": None}


def tmdb_normalize(raw, kind, *, seasons=None, related=None):
    id_ = identity(raw["id"])
    title_key, original_key = ("name", "original_name") if kind == "tv" else ("title", "original_title")
    original = text(raw.get(original_key))
    title = text(raw.get(title_key)) or original
    if not title:
        raise ValueError("missing title")
    original = original if original != title else None
    release = raw.get("first_air_date" if kind == "tv" else "release_date")
    dates = [valid_date(release)]
    for country in (raw.get("release_dates") or {}).get("results") or []:
        dates.extend(valid_date(r.get("release_date")) for r in country.get("release_dates") or [])
    release = min(filter(None, dates), default=None)
    runtime = (raw.get("episode_run_time") or [None])[0] if kind == "tv" else raw.get("runtime")
    directors = [p["name"] for p in raw.get("created_by") or [] if isinstance(p.get("name"), str)] if kind == "tv" else names(
        [p for p in (raw.get("credits") or {}).get("crew") or [] if p.get("job") == "Director"])[:2]
    score, votes = raw.get("vote_average"), raw.get("vote_count")
    score = math.floor(score * 10 + 0.5) if type(score) in (int, float) and math.isfinite(score) \
        and score >= 0 and type(votes) is int and votes > 0 else None
    snapshot = {"id": id_, "title": title, "original_title": original,
                "overview": text(raw.get("overview")), "release_date": release,
                "runtime_minutes": positive(runtime), "genres": names(raw.get("genres")),
                "directors": directors, "production_companies": names(raw.get("production_companies"))[:2],
                "external_score": score, "poster_path": text(raw.get("poster_path")),
                "backdrop_path": text(raw.get("backdrop_path")),
                "posters": tmdb_images(raw, "posters", "poster_path"),
                "backdrops": tmdb_images(raw, "backdrops", "backdrop_path")}
    artwork = [candidate("tmdb", "poster" if group == "posters" else "backdrop", image["filePath"],
                         image["width"], image["height"])
               for group in ("posters", "backdrops") for image in snapshot[group]]
    if kind == "movie":
        snapshot["film"] = film_details(raw)
        snapshot["film"]["related"] = related
        # PC snapshots retain provider poster paths on related films. Display detail does not.
        film = json.loads(json.dumps(snapshot["film"]))
        if film["related"]:
            for part in film["related"]["parts"]:
                part.pop("posterPath", None)
        details = {"series": None, "film": film}
    else:
        snapshot["media_type"] = "tv"
        snapshot["series"] = {"status": text(raw.get("status")), "lastAirDate": text(raw.get("last_air_date")),
                              "seasons": seasons or [],
                              "cast": [p["name"] for p in
                                       ((raw.get("aggregate_credits") or {}).get("cast") or [])[:12]
                                       if isinstance(p.get("name"), str)]}
        series = snapshot["series"]
        details = {"film": None, "series": {"status": series["status"], "cast": series["cast"],
            "seasons": [{k: s[k] for k in ("id", "seasonNumber", "name", "airDate", "posterArtworkId")} |
                        {"episodes": [{k: e[k] for k in ("id", "episodeNumber", "name", "airDate", "runtimeMinutes")}
                                      for e in s["episodes"]]} for s in series["seasons"]]}}
        for season in series["seasons"]:
            if season["posterPath"]:
                artwork.append(candidate("tmdb", "season_poster", season["posterPath"],
                                         seasonId=season["id"], seasonNumber=season["seasonNumber"]))
    values = {"originalTitle": original, "director": joined(directors),
              "productionCompany": joined(snapshot["production_companies"]), "releaseDate": release,
              "runtimeMinutes": snapshot["runtime_minutes"], "genres": joined(snapshot["genres"]),
              "overview": snapshot["overview"], "externalScore": score}
    metadata = {"name": title, "year": int(release[:4]) if release else None, **values}
    return detail_result("tmdb", f"tv:{id_}" if kind == "tv" else str(id_), snapshot,
                         values, details, metadata, artwork)


def detail_result(provider, external_id, snapshot, values, details, metadata, artwork):
    binding = {"provider": provider, "externalId": external_id, "config": None,
               "snapshot": snapshot, "values": values, "details": details}
    # Fail closed on provider payloads that cannot be submitted to the existing authority.
    try:
        ca.parse_binding_input(binding, "movie" if provider == "tmdb" else "game")
        ca._fields({k: v for k, v in metadata.items() if k != "name"}, ca.COMMAND_WORK_FIELDS)
    except HTTPException:
        fail(502, "providerInvalidResponse", "외부 서비스의 작품 정보가 허용 범위를 초과했습니다.")
    return bounded_result({"binding": binding, "metadata": metadata, "artwork": artwork})


def tmdb_detail(relay, kind, id_, deadline):
    budget = [MAX_RAW_TOTAL_BYTES]
    params = {"language": "ko-KR", "include_image_language": "ko,null,en",
              "append_to_response": "aggregate_credits,images" if kind == "tv" else "credits,images,release_dates"}
    raw = relay.tmdb(f"/{kind}/{id_}", deadline, params=params, budget=budget)
    if raw.get("id") != id_:
        raise ValueError("identity mismatch")
    if not text(raw.get("overview")) or (kind == "movie" and not text(raw.get("title"))):
        fallback_params = {"language": "en-US"} if kind == "tv" else {**params, "language": "en-US"}
        fallback = relay.tmdb(f"/{kind}/{id_}", deadline, params=fallback_params, budget=budget)
        if fallback.get("id") != id_:
            raise ValueError("identity mismatch")
        if kind == "tv":
            raw["overview"] = fallback.get("overview")
        else:
            if not text(raw.get("title")) and not text(raw.get("original_title")):
                raw["title"] = fallback.get("title")
            for key in ("overview", "original_title", "release_date"):
                if not text(raw.get(key)):
                    raw[key] = fallback.get(key)
            for key in ("runtime", "vote_average", "vote_count", "credits", "poster_path",
                        "backdrop_path", "images", "release_dates", "belongs_to_collection"):
                if raw.get(key) is None:
                    raw[key] = fallback.get(key)
            for key in ("genres", "production_companies"):
                if not raw.get(key):
                    raw[key] = fallback.get(key)
    seasons = []
    related = None
    if kind == "tv":
        summaries = raw["seasons"]
        if not isinstance(summaries, list) or len(summaries) > 200:
            raise ValueError("invalid seasons")
        seen_ids, seen_numbers = set(), set()
        for summary in summaries:
            number, season_id = summary["season_number"], identity(summary["id"])
            if type(number) is not int or number < 0 or number in seen_numbers or season_id in seen_ids:
                raise ValueError("invalid season identity")
            seen_ids.add(season_id)
            seen_numbers.add(number)
            season = relay.tmdb(f"/tv/{id_}/season/{number}", deadline,
                                params={"language": "ko-KR"}, budget=budget)
            if season.get("id") != season_id or season.get("season_number") != number:
                raise ValueError("season identity mismatch")
            episodes = season["episodes"]
            if not isinstance(episodes, list) or len(episodes) > 2000:
                raise ValueError("invalid episodes")
            parsed, ids, numbers = [], set(), set()
            for episode in episodes:
                eid, enumber = identity(episode["id"]), positive(episode["episode_number"])
                if not enumber or episode.get("season_number") != number or eid in ids or enumber in numbers:
                    raise ValueError("invalid episode identity")
                ids.add(eid)
                numbers.add(enumber)
                parsed.append({"id": eid, "episodeNumber": enumber,
                    "name": text(episode.get("name")) or f"에피소드 {enumber}",
                    "overview": text(episode.get("overview")), "airDate": text(episode.get("air_date")),
                    "runtimeMinutes": positive(episode.get("runtime"))})
            path = season.get("poster_path")
            if path is not None:
                image_url("tmdb", path, "original")
            seasons.append({"id": season_id, "seasonNumber": number,
                "name": text(season.get("name")) or f"시즌 {number}",
                "overview": text(season.get("overview")), "airDate": text(season.get("air_date")),
                "posterPath": path, "posterArtworkId": None,
                "episodes": sorted(parsed, key=lambda e: e["episodeNumber"])})
        seasons.sort(key=lambda s: s["seasonNumber"])
    else:
        collection_id = (raw.get("belongs_to_collection") or {}).get("id")
        if type(collection_id) is int and collection_id > 0:
            try:
                collection = relay.tmdb(f"/collection/{collection_id}", deadline,
                                        params={"language": "ko-KR"}, budget=budget)
                if collection["id"] == collection_id:
                    parts = []
                    for part in collection["parts"]:
                        title = text(part.get("title")) or text(part.get("original_title"))
                        if type(part.get("id")) is int and 0 < part["id"] < 10**18 and part["id"] != id_ and title:
                            path = part.get("poster_path")
                            try:
                                if path is not None:
                                    image_url("tmdb", path, "original")
                            except HTTPException:
                                path = None
                            parts.append({"movieId": part["id"], "title": title,
                                          "releaseDate": valid_date(part.get("release_date")), "posterPath": path})
                    parts.sort(key=lambda p: (p["releaseDate"] is None, p["releaseDate"] or "", p["movieId"]))
                    related = {"collectionName": text(collection.get("name")) or "", "parts": parts}
            except (HTTPException, UpstreamStatus, KeyError, TypeError, ValueError):
                # PC treats collection enrichment as optional too.
                related = None
    return tmdb_normalize(raw, kind, seasons=seasons, related=related)


def igdb_normalize(raw):
    id_ = identity(raw["id"])
    name = text(raw.get("name"))
    if not name:
        raise ValueError("missing name")
    releases = raw.get("release_dates") or []
    dates = [timestamp_date(raw.get("first_release_date"))] + [timestamp_date(r.get("date")) for r in releases]
    release = min(filter(None, dates), default=None)
    companies = raw.get("involved_companies") or []
    developer = joined(unique(text((c.get("company") or {}).get("name")) for c in companies if c.get("developer") is True))
    publisher = joined(unique(text((c.get("company") or {}).get("name")) for c in companies if c.get("publisher") is True))
    platforms = unique([text((r.get("platform") or {}).get("name")) for r in releases] + names(raw.get("platforms")))
    metadata = {"name": name, "year": int(release[:4]) if release else None, "developer": developer,
                "publisher": publisher, "platforms": joined(platforms), "releaseDate": release,
            "genres": joined([g.get("name") for g in raw.get("genres") or []]),
            "overview": text(raw.get("summary"))}
    # Match cloud/collection_baseline.rs provider_values on the original IGDB snapshot.
    company_values = lambda role: joined([text((c.get("company") or {}).get("name"))
                                         for c in companies if c.get(role) is True
                                         and text((c.get("company") or {}).get("name"))])
    value_names = lambda rows: joined([text(r.get("name")) for r in rows or [] if text(r.get("name"))])
    timestamps = [r.get("date") for r in releases] + [raw.get("first_release_date")]
    earliest = min((t for t in timestamps if type(t) is int), default=None)
    values = {"developer": text(raw.get("developer")) or company_values("developer"),
              "publisher": text(raw.get("publisher")) or company_values("publisher"),
              "releaseDate": text(raw.get("release_date")) or timestamp_date(earliest),
              "platforms": value_names(raw.get("platforms")) or joined(
                  [text((r.get("platform") or {}).get("name")) for r in releases
                   if text((r.get("platform") or {}).get("name"))]),
              "genres": value_names(raw.get("genres")),
              "overview": text(raw.get("overview")) or text(raw.get("summary"))}
    artwork = []
    for kind, images in (("cover", [raw["cover"]] if raw.get("cover") else []),
                         ("artwork", raw.get("artworks") or []), ("screenshot", raw.get("screenshots") or [])):
        for image in images:
            artwork.append(candidate("igdb", kind, image["image_id"], image.get("width"), image.get("height")))
    return detail_result("igdb", str(id_), raw, values, None, metadata, artwork)


class ArtworkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(pattern=r"^(tmdb|igdb)$")
    path: str = Field(min_length=1, max_length=512)
    size: str = Field(default="original", max_length=40)


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    commandId: str
    libraryId: str = Field(pattern=ca.LIBRARY_ID_PATTERN.pattern)
    epoch: int = Field(ge=1)
    operation: str = Field(pattern=r"^(create|connect|refresh)$")
    provider: str = Field(pattern=r"^(tmdb|igdb)$")
    externalId: str = Field(max_length=200)
    workId: str
    type: str | None = None


def parse_apply(data):
    try:
        body = ApplyRequest.model_validate_json(data)
        command_id, work_id = uuid.UUID(body.commandId), uuid.UUID(body.workId)
        if command_id.version != 4 or str(command_id) != body.commandId.lower() \
                or str(work_id) != body.workId.lower():
            raise ValueError("invalid UUID")
        pattern = r"(?:tv:)?[1-9][0-9]{0,17}" if body.provider == "tmdb" else r"[1-9][0-9]{0,17}"
        if not re.fullmatch(pattern, body.externalId):
            raise ValueError("invalid provider identity")
        if body.operation == "create":
            if body.type != ca.PROVIDER_TYPES[body.provider]:
                raise ValueError("invalid work type")
        elif "type" in body.model_fields_set:
            raise ValueError("type is create-only")
        body.commandId, body.workId = str(command_id), str(work_id)
        return body
    except (ValidationError, ValueError, TypeError):
        fail(422, "providerApplyInvalid", "작품 정보 적용 요청이 올바르지 않습니다.")


def igdb_detail(relay, id_, deadline):
    rows = relay.igdb(f"where id = {id_}; fields {IGDB_FIELDS}; limit 1;", deadline)
    if not rows:
        fail(404, "providerNotFound", "외부 서비스에서 작품을 찾을 수 없습니다.")
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("id") != id_:
        raise ValueError("identity mismatch")
    return igdb_normalize(rows[0])


def apply_provider(body, relay, get_db, storage, bucket):
    request_payload = body.model_dump(exclude_unset=True)
    namespace = uuid.UUID(body.commandId)
    batch_id = str(uuid.uuid5(namespace, "providerApply"))

    def preflight(db):
        row, _, cached = ca.command_batch_receipt(db, library_id=body.libraryId,
            epoch=body.epoch, operation_id=batch_id, request_payload=request_payload)
        if cached is not None:
            return cached, None
        binding = None
        if body.operation != "create":
            ctx = ca.Context(db, row, command_type="providerApply", operation_id=batch_id, now=ca.now_iso())
            work = ca.require_work(ctx, body.workId)
            if work["type"] != ca.PROVIDER_TYPES[body.provider]:
                fail(422, "providerTypeMismatch", "이 작품 종류에 연결할 수 없는 작품 정보입니다.")
            binding = ca.binding_row(db, body.libraryId, body.workId, body.provider)
            if body.operation == "refresh":
                if binding is None or not binding["bound"]:
                    fail(409, "providerBindingRequired", "새로 고칠 외부 작품 연결이 없습니다.")
                if binding["external_id"] != body.externalId:
                    fail(409, "providerBindingMismatch", "현재 연결된 외부 작품 ID와 일치하지 않습니다.")
        return None, None if binding is None else dict(binding)

    # Read the merge base before lookup; the normal commands CAS against this
    # version after lookup. Never hold a database write lock during provider HTTP.
    with get_db() as db:
        db.execute("BEGIN")
        try:
            cached, binding = preflight(db)
        finally:
            db.rollback()
    if cached is not None:
        return cached
    require_keys(body.provider)

    def fetch(deadline):
        if body.provider == "tmdb":
            kind = "tv" if body.externalId.startswith("tv:") else "movie"
            detail = tmdb_detail(relay, kind, int(body.externalId.split(":")[-1]), deadline)
        else:
            detail = igdb_detail(relay, int(body.externalId), deadline)
        candidates = [a for a in detail["artwork"] if a["kind"] in ("season_poster", "screenshot")]
        # IGDB has no PC count cap besides its bounded response. The authority's
        # per-work ceiling plus the time/aggregate-byte budgets bound this relay.
        candidates = candidates[:ca.MAX_ARTWORKS_PER_WORK]
        existing = {}
        with get_db() as db:
            rows = db.execute("SELECT * FROM collection_authority_artworks WHERE library_id=?"
                              " AND work_id=? AND provider=?",
                              [body.libraryId, body.workId, body.provider]).fetchall()
            known_screenshots = {r["provider_image_id"].rsplit(":screenshot:", 1)[0] for r in rows
                if r["kind"] == "screenshot" and r["provider_image_id"]
                and re.fullmatch(r"[A-Za-z0-9_-]+:screenshot:[a-f0-9]{64}", r["provider_image_id"])}
            if binding and binding["snapshot_external_id"] == body.externalId and binding["snapshot"]:
                previous = (json.loads(binding["snapshot"]).get("series") or {}).get("seasons") or []
                owned = {r["artwork_id"]: r for r in rows}
                for season in previous:
                    art = owned.get(season.get("posterArtworkId"))
                    if art is not None and art["kind"] == "cover":
                        existing[season["id"]] = (season.get("posterPath"), art["artwork_id"])
        seasons = (detail["binding"]["snapshot"].get("series") or {}).get("seasons") or []
        for season in seasons:
            old = existing.get(season["id"])
            if old and old[0] == season.get("posterPath"):
                set_season_artwork(detail, season["id"], old[1])
        # Missing posters first so a long series makes progress on later refreshes.
        candidates.sort(key=lambda a: a.get("seasonId") in existing)
        prepared, total = [], 0

        def download(_):
            nonlocal total
            for art in candidates:
                kind = "cover" if art["kind"] == "season_poster" else "screenshot"
                image = f"season:{art['seasonId']}" if kind == "cover" else art["path"]
                # PC IGDB refresh preserves its gallery. Only fill missing shots
                # here, including ones deferred by a previous request's budget.
                if body.operation == "refresh" and kind == "screenshot" and image in known_screenshots:
                    continue
                remaining = deadline - ARTWORK_COMMIT_SECONDS - time.monotonic()
                if remaining < 1 or total >= MAX_AUTO_ARTWORK_BYTES:
                    break
                try:
                    receipt = store_artwork(ArtworkRequest(provider=body.provider, path=art["path"],
                        size="w342" if kind == "cover" else "original"),
                        min(deadline - ARTWORK_COMMIT_SECONDS, time.monotonic() + AUTO_IMAGE_SECONDS),
                        get_db, storage, bucket, automatic=True,
                        byte_limit=min(MAX_ARTWORK_BYTES, MAX_AUTO_ARTWORK_BYTES - total))
                except (HTTPException, UpstreamStatus):
                    # Optional artwork never turns a valid metadata apply into a failure.
                    continue
                total += receipt["original"]["sizeBytes"]
                prepared.append((art, kind, image, receipt))
            return prepared

        if candidates:
            try:
                relay.paced("artwork", download)
            except HTTPException as exc:
                if exc.status_code != 429:
                    raise
                # Another image import owns the decoder/storage lane. Refresh can retry.
        return detail, prepared

    detail, prepared = relay.paced(body.provider, fetch)

    def command(kind, **fields):
        return {"libraryId": body.libraryId, "epoch": body.epoch, "contractVersion": ca.CONTRACT_VERSION,
                "operationId": str(uuid.uuid5(namespace, kind)), "commandType": kind,
                "workId": body.workId, **fields}

    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            cached, _ = preflight(db)
            if cached is not None:
                db.rollback()
                return cached
            if body.operation == "refresh":
                current = ca.binding_row(db, body.libraryId, body.workId, body.provider)
                if current["entity_revision"] != binding["entity_revision"]:
                    ctx = ca.Context(db, ca.authority.active_domain(db, ca.DOMAIN),
                        command_type=ca.APPLY_SNAPSHOT, operation_id=batch_id, now=ca.now_iso())
                    ca.conflict(ctx, "binding", ca.binding_projection(current), code="providerSnapshotStale")
            artwork_commands = []
            capacity = ca.MAX_ARTWORKS_PER_WORK - db.execute(
                "SELECT COUNT(*) FROM collection_authority_artworks WHERE library_id=? AND work_id=?",
                [body.libraryId, body.workId]).fetchone()[0]
            pending_ids = set()
            for art, kind, image, receipt in prepared:
                # Exactly the PC authority identity; reuse PC-made IDs as well.
                identity_ = f"{image}:{kind}:{receipt['original']['sha256']}"
                existing = db.execute("SELECT artwork_id FROM collection_authority_artworks"
                    " WHERE library_id=? AND work_id=? AND provider=? AND provider_image_id=?"
                    " ORDER BY artwork_id LIMIT 1",
                    [body.libraryId, body.workId, body.provider, identity_]).fetchone()
                artwork_id = existing[0] if existing else str(uuid.uuid5(uuid.UUID(body.workId),
                    body.provider + ":" + identity_))
                if existing is None and artwork_id not in pending_ids:
                    if len(artwork_commands) >= capacity:
                        continue
                    pending_ids.add(artwork_id)
                    artwork_commands.append({**command(ca.ADD_ARTWORK),
                        "operationId": str(uuid.uuid5(namespace, "addArtwork:" + artwork_id)),
                        "artworkId": artwork_id, "kind": kind, "provider": body.provider,
                        "providerImageId": identity_, "original": receipt["original"],
                        "thumbnail": receipt["thumbnail"], "width": receipt["width"],
                        "height": receipt["height"], "language": None})
                if kind == "cover":
                    set_season_artwork(detail, art["seasonId"], artwork_id)
            provider_binding = detail["binding"]
            bound = binding is not None and binding["bound"]
            commands = []
            if body.operation == "create":
                metadata = detail["metadata"]
                # References must resolve after addArtwork, within this same batch.
                commands.append(command(ca.CREATE, type=body.type, name=metadata["name"], legacyKind=None,
                    fields={k: v for k, v in metadata.items() if k != "name"},
                    binding=None if artwork_commands else provider_binding))
            elif body.operation == "connect":
                commands.append(command(ca.BIND, provider=body.provider, externalId=body.externalId,
                    config=provider_binding["config"], expectedRevision=binding["entity_revision"] if bound else 0))
            commands.extend(artwork_commands)
            if body.operation != "create" or artwork_commands:
                commands.append(command(ca.APPLY_SNAPSHOT,
                    **{k: provider_binding[k] for k in ("provider", "externalId", "snapshot", "values", "details")},
                    baseSnapshotDigest=binding["snapshot_digest"] if bound else None))
            result = ca.apply_command_batch(db, library_id=body.libraryId, epoch=body.epoch,
                operation_id=batch_id, request_payload=request_payload, commands=commands, now=ca.now_iso())
            db.commit()
            return result
        except BaseException:
            db.rollback()
            raise


def set_season_artwork(detail, season_id, artwork_id):
    binding = detail["binding"]
    for series in (binding["snapshot"].get("series"), (binding["details"] or {}).get("series")):
        for season in (series or {}).get("seasons") or []:
            if season["id"] == season_id:
                season["posterArtworkId"] = artwork_id


def image_dimensions(data, mime, *, max_pixels=None):
    try:
        from PIL import Image
    except ImportError:
        fail(503, "providerImageDecoderUnavailable", "서버 이미지 확인 기능을 사용할 수 없습니다.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                if max_pixels is not None and width * height > max_pixels:
                    raise ValueError("image pixel budget exceeded")
                if not positive(width) or not positive(height) or Image.MIME.get(image.format) != mime:
                    raise ValueError("invalid image")
                image.verify()
                return width, height
    except Exception:
        fail(422, "providerImageInvalid", "이미지 데이터나 형식이 올바르지 않습니다.")


#: The PC's work-artwork thumbnail (``WORK_ARTWORK_THUMBNAIL_BOUND`` in work_artwork.rs): the
#: image fitted inside 360x360, as WebP. Shelves read this variant; details read the original.
ARTWORK_THUMBNAIL_BOUND = 360
ARTWORK_THUMBNAIL_MIME = "image/webp"


def artwork_thumbnail(data):
    """The thumbnail bytes of an already verified provider image, or None if it cannot be made.

    A missing thumbnail only costs the shelf a larger download, so a failure here never
    fails the artwork itself.
    """
    try:
        from PIL import Image
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                image.draft("RGB", (ARTWORK_THUMBNAIL_BOUND * 2, ARTWORK_THUMBNAIL_BOUND * 2))
                image.seek(0)
                frame = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
        frame.thumbnail((ARTWORK_THUMBNAIL_BOUND, ARTWORK_THUMBNAIL_BOUND), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        frame.save(output, format="WEBP", quality=80, method=4)
        thumbnail = output.getvalue()
        return thumbnail if 0 < len(thumbnail) <= MAX_THUMBNAIL_BYTES else None
    except Exception:
        return None


def _stored_blob(client, storage_bucket, data, mime, *, deadline=None):
    """Put one content-addressed blob (once) and confirm its storage receipt."""
    sha = hashlib.sha256(data).hexdigest()
    key = artwork_key(sha)

    def check_budget():
        if deadline is not None and time.monotonic() >= deadline:
            fail(504, "providerTimeout", "Provider artwork request budget exceeded.")

    check_budget()
    try:
        metadata = client.head_object(Bucket=storage_bucket, Key=key)
    except ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code")) not in ("404", "NoSuchKey", "NotFound"):
            raise
        head_cache.ticket_heads.invalidate(client, storage_bucket, key)
        check_budget()
        client.put_object(Bucket=storage_bucket, Key=key, Body=io.BytesIO(data), ContentType=mime)
        check_budget()
        metadata = client.head_object(Bucket=storage_bucket, Key=key)
    if metadata.get("ContentLength") != len(data) or metadata.get("ContentType") != mime:
        fail(409, "providerArtworkMismatch", "저장된 이미지가 확인 정보와 일치하지 않습니다.")
    return {"sha256": sha, "sizeBytes": len(data), "contentType": mime}


def store_artwork(body, deadline, get_db, storage, bucket, *, automatic=False,
                  byte_limit=MAX_ARTWORK_BYTES):
    url = image_url(body.provider, body.path, body.size)
    data, mime = outbound(url, deadline=deadline, limit=byte_limit, image=True,
        socket_seconds=1 if automatic else 5)
    width, height = image_dimensions(data, mime,
        max_pixels=MAX_AUTO_IMAGE_PIXELS if automatic else None)
    thumbnail_data = artwork_thumbnail(data)
    try:
        client, storage_bucket = storage(), bucket()
        owned_client = None
        if automatic:
            # The service's shared R2 transfer client waits 60s and retries. Use
            # the existing factory with short, non-retrying sockets for this lane.
            import r2
            if hasattr(r2, "_R2Client") and isinstance(client, r2._R2Client):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    fail(504, "providerTimeout", "Provider artwork request budget exceeded.")
                timeout = min(3, max(0.5, remaining / 4))
                owned_client = client = r2._storage_client(Config(signature_version="s3v4",
                    connect_timeout=timeout, read_timeout=timeout,
                    retries={"mode": "standard", "total_max_attempts": 1}, max_pool_connections=1))
        storage_deadline = deadline if automatic else None
        try:
            blob = _stored_blob(client, storage_bucket, data, mime, deadline=storage_deadline)
            thumbnail = None if thumbnail_data is None else _stored_blob(
                client, storage_bucket, thumbnail_data, ARTWORK_THUMBNAIL_MIME, deadline=storage_deadline)
        finally:
            if owned_client is not None:
                owned_client.close()
        with get_db() as db:
            for receipt in (blob, thumbnail):
                if receipt is not None:
                    db.execute("INSERT INTO mobile_collection_artwork VALUES (?,?,?) ON CONFLICT(sha256) "
                               "DO UPDATE SET size_bytes=excluded.size_bytes,content_type=excluded.content_type",
                               (receipt["sha256"], receipt["sizeBytes"], receipt["contentType"]))
            db.commit()
    except HTTPException:
        raise
    except Exception:
        fail(502, "providerArtworkStorageUnavailable", "이미지를 저장할 수 없습니다. 잠시 후 다시 시도해 주세요.")
    return {"provider": body.provider, "providerImageId": body.path, "original": blob,
            "thumbnail": thumbnail, "width": width, "height": height}


def register(app, get_db, require_client, storage, bucket):
    relay = Relay()

    @app.get("/v1/providers/image")
    def image(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        params = dict(request.query_params)
        if set(params) != {"provider", "path", "size"} or len(request.query_params.multi_items()) != 3:
            fail(422, "providerImagePathInvalid", "이미지 요청 정보가 올바르지 않습니다.")
        url = preview_image_url(params["provider"], params["path"], params["size"])
        try:
            data, mime = outbound(url, deadline=time.monotonic() + REQUEST_SECONDS,
                                  limit=MAX_ARTWORK_BYTES, image=True)
        except UpstreamStatus as exc:
            status_error(exc.status)
        return Response(data, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})

    @app.post("/v1/providers/apply")
    async def apply(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        chunks = bytearray()
        async for chunk in request.stream():
            if len(chunks) + len(chunk) > 2048:
                fail(413, "providerRequestTooLarge", "작품 정보 적용 요청 크기가 너무 큽니다.")
            chunks.extend(chunk)
        body = parse_apply(chunks)
        return await run_in_threadpool(apply_provider, body, relay, get_db, storage, bucket)

    @app.get("/v1/providers/status")
    def status(authorization: str | None = Header(default=None)):
        require_client(authorization)
        return configured()

    @app.get("/v1/providers/tmdb/search")
    def tmdb_search(query: str = Query(min_length=1, max_length=200),
                    kind: str = Query(pattern=r"^(movie|tv)$"),
                    year: int | None = Query(default=None, ge=1, le=9999),
                    authorization: str | None = Header(default=None)):
        require_client(authorization)
        require_keys("tmdb")
        if not query.strip():
            fail(422, "providerQueryInvalid", "검색어를 입력해 주세요.")
        def fetch(deadline):
            params = {"query": query.strip(), "language": "ko-KR", "include_adult": "false"}
            if year is not None:
                params["year" if kind == "movie" else "first_air_date_year"] = year
            raw = relay.tmdb(f"/search/{kind}", deadline, params=params)
            if not isinstance(raw.get("results"), list) or len(raw["results"]) > 20:
                raise ValueError("invalid results")
            items = []
            for row in raw["results"]:
                id_ = identity(row["id"])
                original = text(row.get("original_name" if kind == "tv" else "original_title"))
                name = text(row.get("name" if kind == "tv" else "title")) or original
                if not name:
                    raise ValueError("missing title")
                release = text(row.get("first_air_date" if kind == "tv" else "release_date"))
                path = row.get("poster_path")
                items.append({"id": id_, "externalId": f"tv:{id_}" if kind == "tv" else str(id_),
                              "kind": kind, "name": name, "originalTitle": original if original != name else None,
                              "releaseDate": release, "year": ca.year_from_date(release), "path": path,
                              "previewUrl": preview_url("tmdb", path, "w185") if path else None})
            return bounded_result({"items": items})
        return relay.paced("tmdb", fetch)

    @app.get("/v1/providers/tmdb/{kind}/{id}")
    def tmdb_lookup(kind: str, id: int, authorization: str | None = Header(default=None)):
        require_client(authorization)
        require_keys("tmdb")
        if kind not in ("movie", "tv") or not 0 < id < 10**18:
            fail(422, "providerIdentityInvalid", "TMDB 작품 ID나 유형이 올바르지 않습니다.")
        return relay.paced("tmdb", lambda deadline: tmdb_detail(relay, kind, id, deadline))

    @app.get("/v1/providers/igdb/search")
    def igdb_search(query: str = Query(min_length=1, max_length=200),
                    authorization: str | None = Header(default=None)):
        require_client(authorization)
        require_keys("igdb")
        query = query.strip()
        if not query or any(ord(c) < 32 for c in query):
            fail(422, "providerQueryInvalid", "검색어를 입력해 주세요.")
        escaped = query.replace("\\", "\\\\").replace('"', '\\"')
        def fetch(deadline):
            rows = relay.igdb(f'search "{escaped}"; fields {IGDB_FIELDS}; limit 20;', deadline)
            if not isinstance(rows, list) or len(rows) > 20:
                raise ValueError("invalid results")
            items = []
            for row in rows:
                detail = igdb_normalize(row)
                cover = next((a for a in detail["artwork"] if a["kind"] == "cover"), None)
                items.append({"id": row["id"], "externalId": str(row["id"]), **detail["metadata"],
                              "path": cover["path"] if cover else None,
                              "previewUrl": cover["previewUrl"] if cover else None})
            return bounded_result({"items": items})
        return relay.paced("igdb", fetch)

    @app.get("/v1/providers/igdb/{id}")
    def igdb_lookup(id: int, authorization: str | None = Header(default=None)):
        require_client(authorization)
        require_keys("igdb")
        if not 0 < id < 10**18:
            fail(422, "providerIdentityInvalid", "IGDB 작품 ID가 올바르지 않습니다.")
        return relay.paced("igdb", lambda deadline: igdb_detail(relay, id, deadline))

    @app.post("/v1/providers/artwork")
    async def artwork(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        chunks = bytearray()
        async for chunk in request.stream():
            if len(chunks) + len(chunk) > 2048:
                fail(413, "providerRequestTooLarge", "이미지 요청 크기가 너무 큽니다.")
            chunks.extend(chunk)
        try:
            body = ArtworkRequest.model_validate_json(chunks)
        except ValidationError:
            fail(422, "providerArtworkInvalid", "이미지 요청 정보가 올바르지 않습니다.")
        return await run_in_threadpool(relay.paced, "artwork",
            lambda deadline: store_artwork(body, deadline, get_db, storage, bucket))

    return relay
