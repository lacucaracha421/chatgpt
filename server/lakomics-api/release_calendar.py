"""Dormant IGDB/TMDB calendar builder; wishlist processing remains on the PC.

LAKOMICS_RELEASE_CALENDAR defaults OFF. Enable only after the PC handover ships;
without a handshake, publish only over a server-owned document or no document.
One daemon performs sequential bounded
refreshes. Public entries match release_calendar.rs + home_publications.rs;
the shared fixture documents the transport contract. Imports of API dependencies
are deferred so provider parity and scheduling can be checked with plain Python.
"""
import calendar
import hashlib
import json
import logging
import math
import os
import re
import threading
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone

ENV = "LAKOMICS_RELEASE_CALENDAR"
FEATURE = "serverReleaseCalendar"
PREFIX = "/v1/home/upcoming/calendar"
PROVIDERS = ("igdb", "tmdb", "tmdb_tv")
PLATFORMS = {6: "PC", 167: "PS5", 48: "PS4", 508: "Switch 2", 130: "Switch",
             169: "Xbox Series", 49: "Xbox One"}
EXCLUDED_TYPES = {"dlc", "dlc addon", "expansion", "bundle", "mod", "episode",
                  "season", "fork", "pack", "update"}
RANK = {"exact": 0, "month": 1, "quarter": 2, "year": 3, "tbd": 4}
IGDB_FIELDS = ("id,name,hypes,cover.image_id,game_type.type,release_dates.date,release_dates.y,"
               "release_dates.m,release_dates.date_format.format,release_dates.category,"
               "release_dates.release_region.region,release_dates.region,release_dates.platform.id,"
               "release_dates.platform.name,release_dates.status.name,game_localizations.name,"
               "game_localizations.region.identifier,game_localizations.region.name")
WAKE_SECONDS = 600
START_DELAY = 30
BATCH_SECONDS = 240
PROVIDER_SECONDS = 180
MAX_REQUESTS = 128  # 2 IGDB + 2 * (3 Discover + 60 details).
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 3000
DDL = """
CREATE TABLE IF NOT EXISTS release_calendar_state(
 provider TEXT PRIMARY KEY, fetched_at TEXT, attempted_at TEXT, error_code TEXT,
 entries_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS release_calendar_owner(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS release_calendar_status(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), status_json TEXT NOT NULL);
"""
_current = None


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def enabled():
    return os.environ.get(ENV, "").strip().lower() in ("1", "true", "yes", "on")


def credentials_present():
    # The same validation as work_providers. Do not read an env file here.
    def valid(name):
        value = os.environ.get(name, "").strip()
        return bool(value and len(value) <= 4096 and all(33 <= ord(c) <= 126 for c in value))
    return all(valid(name) for name in ("LAKOMICS_TMDB_API_KEY", "LAKOMICS_IGDB_CLIENT_ID",
                                       "LAKOMICS_IGDB_CLIENT_SECRET"))


def features():
    # Ownership outlives a draining/restarting thread; run availability is separate.
    return [FEATURE] if enabled() and credentials_present() else []


def startup_db(db):
    db.executescript(DDL)


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError):
        return None


def day(value):
    try:
        value = value.strip()[:10]
        return date.fromisoformat(value) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None
    except (ValueError, AttributeError):
        return None


def integer(value):
    return value if type(value) is int and -(2**63) <= value < 2**63 else None


def text(value):
    return value.strip() or None if isinstance(value, str) else None


def public_text(value, limit):
    if value is None:
        return None
    return "".join(" " if unicodedata.category(c) == "Cc" else c for c in value).strip()[:limit] or None


def popularity(value):
    return float(value) if type(value) in (int, float) else 0.0


def period(value, precision):
    start = day(value)
    if start is None or precision == "tbd":
        return None
    if precision == "exact":
        return start, start + timedelta(days=1)
    months = {"month": 1, "quarter": 3, "year": 12}[precision]
    number = start.year * 12 + start.month - 1 + months
    year, month = divmod(number, 12)
    try:
        return start, date(year, month + 1, min(start.day, calendar.monthrange(year, month + 1)[1]))
    except ValueError:
        return None


def overlaps(row, start, end):
    span = period(row["date"], row["precision"])
    return span is not None and span[0] < end and span[1] > start


def headline(rows):
    dated = [r for r in rows if r["date"] is not None and r["precision"] != "tbd"]
    for region in ("korea", "asia", "worldwide", None):
        choices = [r for r in dated if region is None or r["region"] == region]
        if choices:
            return min(choices, key=lambda r: (r["date"], RANK[r["precision"]]))
    return {"date": None, "precision": "tbd", "region": rows[0]["region"] if rows else None}


def title_record(id_, kind, name, original, cover, platforms, dates, hype, port=False):
    head = headline(dates)
    return {"id": id_, "kind": kind, "title": name, "originalTitle": original, "cover": cover,
            "platforms": platforms, "date": head["date"], "precision": head["precision"],
            "region": head["region"], "popularity": hype, "dates": dates, "port": port}


def object_rows(value):
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def object_value(value):
    return value if isinstance(value, dict) else {}


def ascii_lower(value):
    return value.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


def igdb_release(raw):
    status = object_value(raw.get("status")).get("name", "")
    if isinstance(status, str) and status.lower() in ("cancelled", "canceled"):
        return None
    platform = PLATFORMS.get(integer(object_value(raw.get("platform")).get("id")))
    if platform is None:
        return None
    region = text(object_value(raw.get("release_region")).get("region"))
    region = ascii_lower(region).replace(" ", "_") if region else {
        1: "europe", 2: "north_america", 3: "australia", 4: "new_zealand", 5: "japan",
        6: "china", 7: "asia", 8: "worldwide", 9: "korea", 10: "brazil"
    }.get(integer(raw.get("region")), "worldwide")
    stamp = integer(raw.get("date"))
    try:
        timestamp = (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=stamp)).date() \
            if stamp is not None else None
    except (OverflowError, ValueError):
        timestamp = None
    year = integer(raw.get("y"))
    year = year if year is not None and -(2**31) <= year < 2**31 else timestamp.year if timestamp else None
    month = integer(raw.get("m"))
    month = month if month is not None and 1 <= month <= 12 else timestamp.month if timestamp else None
    fmt = object_value(raw.get("date_format")).get("format")
    if isinstance(fmt, str):
        fmt = fmt.strip().upper()
    else:
        category = integer(raw.get("category"))
        fmt = {0: "YYYYMMDD", 1: "YYYYMM", 2: "YYYY", 3: "YYYYQ1", 4: "YYYYQ2",
               5: "YYYYQ3", 6: "YYYYQ4"}.get(category, "TBD") if category is not None \
            else "YYYYMMDD" if stamp is not None else "TBD"
    precision, value = "tbd", None
    try:
        if fmt in ("YYYYMMDD", "YYYYMMMMDD"):
            precision, value = "exact", timestamp
        elif fmt in ("YYYYMM", "YYYYMMMM"):
            precision, value = "month", date(year, month, 1)
        elif fmt == "YYYY":
            precision, value = "year", date(year, 1, 1)
        elif re.fullmatch(r"YYYYQ[1-4]", fmt):
            precision, value = "quarter", date(year, (int(fmt[-1]) - 1) * 3 + 1, 1)
    except (TypeError, ValueError):
        value = None
    return {"region": region, "platform": platform, "date": value.isoformat() if value else None,
            "precision": precision if value else "tbd"}


def igdb_title(game, start, end):
    id_, name = integer(game.get("id")), text(game.get("name"))
    kind = text(object_value(game.get("game_type")).get("type"))
    if not id_ or id_ < 0 or not name or (kind and kind.lower().replace("_", " ") in EXCLUDED_TYPES):
        return None
    dates = []
    for raw in object_rows(game.get("release_dates")):
        row = igdb_release(raw)
        if row is None:
            continue
        known = next((r for r in dates if (r["region"], r["platform"]) ==
                      (row["region"], row["platform"])), None)
        if known is None:
            dates.append(row)
        elif row["date"] is not None and (known["date"] is None or
                (row["date"], RANK[row["precision"]]) < (known["date"], RANK[known["precision"]])):
            known.update(row)
    port = any((span := period(r["date"], r["precision"])) and span[1] <= start for r in dates)
    dates = [r for r in dates if overlaps(r, start, end)]
    if not dates:
        return None
    localized = None
    for item in object_rows(game.get("game_localizations")):
        region = object_value(item.get("region"))
        if "KR" in str(region.get("identifier", "")).upper() or "korea" in ascii_lower(str(region.get("name", ""))):
            localized = text(item.get("name"))
            if localized:
                break
    platforms = [p for p in PLATFORMS.values() if any(r["platform"] == p for r in dates)]
    cover = object_value(game.get("cover")).get("image_id")
    cover = cover if isinstance(cover, str) and cover else None
    return title_record(f"igdb:{id_}", "game", localized or name, name if localized else None,
                        cover, platforms, dates, popularity(game.get("hypes")), port)


def movie_title(movie, releases):
    id_ = integer(movie.get("id"))
    original = text(movie.get("original_title"))
    name = text(movie.get("title")) or original
    if not id_ or id_ < 0 or not name:
        return None
    korean = [d for country in object_rows(releases.get("results")) if country.get("iso_3166_1") == "KR"
              for r in object_rows(country.get("release_dates")) if integer(r.get("type")) in (2, 3)
              if (d := day(r.get("release_date"))) is not None]
    dates = []
    if korean:
        dates.append({"region": "korea", "platform": "", "date": min(korean).isoformat(), "precision": "exact"})
    primary = day(movie.get("release_date"))
    dates.append({"region": "worldwide", "platform": "", "date": primary.isoformat() if primary else None,
                  "precision": "exact" if primary else "tbd"})
    cover = text(movie.get("poster_path"))
    return title_record(f"tmdb:{id_}", "movie", name, original if original != name else None,
                        cover if cover and cover.startswith("/") else None, [], dates,
                        popularity(movie.get("popularity")))


def anime_title(show, season):
    id_, number = integer(show.get("id")), integer(season.get("season_number"))
    original = text(show.get("original_name"))
    name = text(show.get("name")) or original
    if not id_ or id_ < 0 or not number or number < 1 or not name:
        return None
    label = text(season.get("name"))
    if number > 1:
        compact = label.lower().replace(" ", "") if label else ""
        generic = re.fullmatch(r"(?:season|시즌)[0-9]*", compact) is not None
        if not label or label in (name, original) or not any("가" <= c <= "힣" for c in label) or generic:
            label = f"시즌 {number}"
        title = f"{name} · {label}"
    else:
        title = name
    air = day(season.get("air_date"))
    dates = [{"region": "JP", "platform": "", "date": air.isoformat() if air else None,
              "precision": "exact" if air else "tbd"}]
    cover = next((p for p in (text(season.get("poster_path")), text(show.get("poster_path")))
                  if p and p.startswith("/")), None)
    return title_record(f"tmdb:tv:{id_}:s{number}", "anime", title, original if original != name else None,
                        cover, [], dates, popularity(show.get("popularity")))


def public_title(row):
    cover, kind = row["cover"], row["kind"]
    url = None
    if kind == "game" and cover and re.fullmatch(r"[A-Za-z0-9_]+", cover):
        url = f"https://images.igdb.com/igdb/image/upload/t_cover_big/{cover}.jpg"
    elif kind != "game" and cover and cover.startswith("/") and ".." not in cover \
            and re.fullmatch(r"[A-Za-z0-9/_.-]+", cover):
        url = f"https://image.tmdb.org/t/p/w342{cover}"
    return {"id": row["id"], "kind": kind, "title": public_text(row["title"], 500) or "",
            "originalTitle": public_text(row["originalTitle"], 500), "date": row["date"],
            "precision": row["precision"], "region": public_text(row["region"], 16),
            "platforms": [v for p in row["platforms"] if (v := public_text(p, 100))][:32],
            "releaseType": None, "cover": {"url": url} if url and len(url) <= 2048 else None,
            "popularity": row["popularity"] if math.isfinite(row["popularity"]) and row["popularity"] >= 0 else None,
            "port": row["port"]}


def sorted_entries(rows, start, end):
    rows = [r for r in rows if overlaps(r, start, end)]
    rows.sort(key=lambda r: (r["date"], RANK[r["precision"]], -r["popularity"], r["id"]))
    return [public_title(r) for r in rows]


class ProviderFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class BudgetExceeded(Exception):
    pass


class Budget:
    def __init__(self, seconds=BATCH_SECONDS, requests=MAX_REQUESTS, clock=time.monotonic, stop=None):
        self.clock, self.deadline, self.limit = clock, clock() + seconds, requests
        self.requests, self.stop = 0, stop

    def take(self):
        if self.clock() >= self.deadline or self.requests >= self.limit or (self.stop and self.stop.is_set()):
            raise BudgetExceeded()
        self.requests += 1


class LiveTransport:
    """Reuse the installed relay's credentials, OAuth cache, pacing and safe HTTP reader."""
    def __init__(self, relay):
        self.relay = relay

    def request(self, provider, query, budget):
        import work_providers as wp
        from fastapi import HTTPException
        budget.take()
        upstream = "igdb" if provider == "igdb" else "tmdb"
        lock = self.relay.locks[upstream]
        if not lock.acquire(blocking=False):
            raise BudgetExceeded()  # Yield to interactive work, without provider failure.
        try:
            deadline = min(budget.deadline, budget.clock() + 20)
            if provider == "igdb":
                result = self.relay.igdb(query, deadline, budget=[MAX_JSON_BYTES])
            else:
                path, params = query
                result = self.relay.tmdb(path, deadline, params=params, budget=[MAX_JSON_BYTES])
            if budget.clock() >= budget.deadline:
                raise BudgetExceeded()
            return result
        except wp.UpstreamStatus as error:
            code = "not_found" if error.status == 404 else "invalid_credential" if error.status in (401, 403) \
                else "rate_limited" if error.status == 429 else "unavailable"
            raise ProviderFailure(code) from None
        except HTTPException as error:
            code = error.detail.get("code") if isinstance(error.detail, dict) else None
            raise ProviderFailure({"providerNotConfigured": "credential_not_configured",
                                   "providerTimeout": "timed_out", "providerUnavailable": "unavailable"}
                                  .get(code, "invalid_response")) from None
        except (ValueError, TypeError, AttributeError, KeyError, OverflowError):
            raise ProviderFailure("invalid_response") from None
        finally:
            lock.release()


def igdb_body(start, end, offset):
    def stamp(d):
        return int(datetime.combine(d, datetime.min.time(), timezone.utc).timestamp())
    platforms = ",".join(map(str, PLATFORMS))
    return (f"fields {IGDB_FIELDS}; where release_dates.date >= {stamp(start)} & release_dates.date < {stamp(end)} "
            f"& release_dates.platform = ({platforms}) & hypes >= 30 & version_parent = null "
            f"& (parent_game = null | game_type = (8,9)); sort hypes desc; limit 500; offset {offset};")


def fetch_provider(transport, provider, start, end, budget):
    """All-or-nothing per source; never replace a complete cache with a budget-truncated result."""
    titles = []
    if provider == "igdb":
        for page in range(2):
            raw = transport.request(provider, igdb_body(start, end, page * 500), budget)
            if not isinstance(raw, list) or len(raw) > 500:
                raise ProviderFailure("invalid_response")
            for game in object_rows(raw):
                row = igdb_title(game, start, end)
                if row and not any(r["id"] == row["id"] for r in titles):
                    titles.append(row)
            if len(raw) < 500:
                break
        return titles
    discovered = []
    for page in range(1, 4):
        params = {"language": "ko-KR", "sort_by": "popularity.desc", "include_adult": "false", "page": str(page)}
        if provider == "tmdb":
            path = "/discover/movie"
            params.update(region="KR", with_release_type="2|3", include_video="false")
            params.update({"release_date.gte": start.isoformat(), "release_date.lte": (end - timedelta(days=1)).isoformat()})
        else:
            path = "/discover/tv"
            params.update(with_origin_country="JP", with_genres="16")
            params.update({"air_date.gte": start.isoformat(), "air_date.lte": (end - timedelta(days=1)).isoformat()})
        raw = transport.request(provider, (path, params), budget)
        if not isinstance(raw, dict) or not isinstance(raw.get("results"), list) or len(raw["results"]) > 500:
            raise ProviderFailure("invalid_response")
        discovered.extend(raw["results"])
        pages = raw.get("total_pages", 1)
        if type(pages) is not int or pages < 0:
            pages = 1
        if page >= pages:
            break
    if provider == "tmdb_tv":
        discovered.sort(key=lambda r: -popularity(object_value(r).get("popularity")))
    seen = set()
    candidates = discovered[:60] if provider == "tmdb" else discovered
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        id_ = integer(candidate.get("id"))
        if not id_ or id_ < 0 or id_ in seen:
            continue
        if provider == "tmdb":
            primary = day(candidate.get("release_date"))
            if primary and primary < start - timedelta(days=365):
                continue
            raw = transport.request(provider, (f"/movie/{id_}/release_dates", {}), budget)
            if not isinstance(raw, dict):
                raise ProviderFailure("invalid_response")
            row = movie_title(candidate, raw)
            if row and overlaps(row, start, end):
                titles.append(row)
                seen.add(id_)  # PC dedupes only accepted movies, not failed candidates.
        else:
            seen.add(id_)
            try:
                raw = transport.request(provider, (f"/tv/{id_}", {"language": "ko-KR"}), budget)
            except ProviderFailure as error:
                if error.code == "not_found":
                    if len(seen) >= 60:
                        break
                    continue
                raise
            if not isinstance(raw, dict) or integer(raw.get("id")) != id_ or not isinstance(raw.get("seasons"), list):
                raise ProviderFailure("invalid_response")
            for season in object_rows(raw["seasons"]):
                row = anime_title(raw, season)
                if row and overlaps(row, start, end) and not any(r["id"] == row["id"] for r in titles):
                    titles.append(row)
                    if len(titles) > MAX_ENTRIES:
                        raise ProviderFailure("invalid_response")
            if len(seen) >= 60:
                break
    if len(titles) > MAX_ENTRIES:
        raise ProviderFailure("invalid_response")
    return titles


def due(row, now, manual=False):
    fetched, attempted = parse_time(row.get("fetched_at")), parse_time(row.get("attempted_at"))
    if manual:
        return not (fetched and now - fetched < timedelta(hours=1)) \
            and not (attempted and now - attempted < timedelta(minutes=1))
    return (not fetched or now - fetched >= timedelta(hours=24)) \
        and not (row.get("error_code") and attempted and now - attempted < timedelta(hours=1))


def cache_view(row, now):
    row = dict(row)
    fetched = parse_time(row.get("fetched_at"))
    if fetched is None or now - fetched > timedelta(days=180):
        row["expired"] = row.get("fetched_at") is not None or row["entries_json"] != "[]"
        row.update(fetched_at=None, entries_json="[]")
    return row


def document_changed(previous, candidate):
    """Freshness alone is recorded in worker state, without changing the public revision."""
    def content(document):
        value = {k: v for k, v in document.items() if k != "generatedAt"}
        value["sources"] = [{**{k: v for k, v in s.items() if k != "fetchedAt"},
                             "cached": s.get("fetchedAt") is not None} for s in document["sources"]]
        return value
    return previous is None or content(previous) != content(candidate)


def store_calendar(db, calendar_doc, now, validate, replace_covers):
    """Inside the caller's BEGIN IMMEDIATE; preserve the latest wishlist and every log cursor.

    API validation and cover reference handling are injected by home_upcoming, so the
    transaction rules can also be tested against SQLite with plain Python.
    """
    state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
    owner = db.execute("SELECT digest FROM release_calendar_owner WHERE singleton=1").fetchone()
    if state["document"] is not None and (owner is None or owner[0] != state["digest"]):
        return False
    previous = json.loads(state["document"]) if state["document"] else None
    document = {**calendar_doc, "wishlist": previous["wishlist"] if previous else [], "generatedAt": now.isoformat()}
    if not document_changed(previous, document):
        return False
    document = validate(document)
    serialized = encode(document)
    if len(serialized.encode()) > MAX_SNAPSHOT_BYTES:
        raise ProviderFailure("invalid_response")
    covers = [r["cover"] for r in document["entries"] + document["wishlist"]]
    replace_covers(db, covers)
    db.execute("UPDATE home_upcoming_state SET revision=revision+1,digest=?,document=?,published_at=? WHERE singleton=1",
               (hashlib.sha256(serialized.encode()).hexdigest(), serialized, now.isoformat()))
    db.execute("INSERT INTO release_calendar_owner VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET digest=excluded.digest",
               (hashlib.sha256(serialized.encode()).hexdigest(),))
    db.execute("DELETE FROM home_upcoming_ids")
    db.executemany("INSERT OR IGNORE INTO home_upcoming_ids VALUES(?)",
                   [(r["id"],) for r in document["entries"] + document["wishlist"]])
    return True


class Worker:
    def __init__(self, get_db, transport=None, publish=None, clock=time.monotonic,
                 now=lambda: datetime.now(timezone.utc)):
        self.get_db, self.transport, self.publish = get_db, transport, publish
        self.clock, self.now = clock, now
        self.thread = None
        self.stop_event, self.wake_event = threading.Event(), threading.Event()
        self.lock, self.run_lock = threading.Lock(), threading.Lock()
        self.manual = False
        self.busy = False

    def alive(self):
        return self.thread is not None and self.thread.is_alive() and not self.stop_event.is_set()

    def start(self):
        if not enabled() or not credentials_present() or self.alive():
            return
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.wake_event.clear()
        self.thread = threading.Thread(target=self.loop, name="release-calendar", daemon=True)
        self.thread.start()

    def drain(self):
        self.stop_event.set()
        self.wake_event.set()

    def stop(self):
        from app_lifecycle import join_worker
        self.drain()
        if self.thread:
            join_worker(self.thread, 6, lambda: setattr(self, "thread", None))

    def request(self):
        with self.lock:
            self.manual = True
        self.wake_event.set()

    def loop(self):
        self.wake_event.wait(START_DELAY)
        while not self.stop_event.is_set():
            self.wake_event.clear()
            with self.lock:
                manual, self.manual = self.manual, False
            try:
                self.run_once(manual)
            except Exception:
                # Do not log transport payloads, credentials or database contents.
                logging.getLogger(__name__).error("Release calendar wake failed")
            self.wake_event.wait(WAKE_SECONDS)

    def rows(self, db, now):
        stored = {r["provider"]: cache_view(r, now) for r in db.execute("SELECT * FROM release_calendar_state")}
        return {p: stored.get(p, {"provider": p, "fetched_at": None, "attempted_at": None,
                                  "error_code": None, "entries_json": "[]"}) for p in PROVIDERS}

    def status_view(self):
        now = self.now()
        with self.get_db() as db:
            row = db.execute("SELECT status_json FROM release_calendar_status WHERE singleton=1").fetchone()
            states = self.rows(db, now)
        status = json.loads(row[0]) if row else {}
        return {"version": 1, **status, "enabled": enabled(), "configured": credentials_present(),
                "alive": self.alive(), "busy": self.busy,
                "sources": [{"provider": p, "fetchedAt": r["fetched_at"], "attemptedAt": r["attempted_at"],
                             "errorCode": r["error_code"], "due": due(r, now)} for p, r in states.items()]}

    def run_once(self, manual=False):
        if not enabled() or not credentials_present() or self.stop_event.is_set():
            return False
        if not self.run_lock.acquire(blocking=False):
            return False
        self.busy = True
        try:
            return self.build(manual)
        finally:
            self.busy = False
            self.run_lock.release()

    def build(self, manual):
        now = self.now()
        # PC uses Local::today. Pin the server to the user's Korean calendar day,
        # independent of a VPS process timezone (ZoneInfo data is not required).
        today = now.astimezone(timezone(timedelta(hours=9))).date()
        start, end = today - timedelta(days=7), today + timedelta(days=183)
        with self.get_db() as db:
            states = self.rows(db, now)
            previous_status = db.execute("SELECT status_json FROM release_calendar_status WHERE singleton=1").fetchone()
        next_provider = json.loads(previous_status[0]).get("nextProvider") if previous_status else None
        offset = PROVIDERS.index(next_provider) if next_provider in PROVIDERS else 0
        order = PROVIDERS[offset:] + PROVIDERS[:offset]
        budget = Budget(clock=self.clock, stop=self.stop_event)
        attempted, failures, stopped = [], [], None
        next_provider = None
        for provider in order:
            row = states[provider]
            if not due(row, now, manual):
                continue
            if self.clock() >= budget.deadline or self.stop_event.is_set():
                stopped = "budget"
                next_provider = provider
                break
            if self.transport is None:
                raise RuntimeError("calendar transport not installed")
            whole_deadline = budget.deadline
            budget.deadline = min(whole_deadline, self.clock() + PROVIDER_SECONDS)
            try:
                entries = fetch_provider(self.transport, provider, start, end, budget)
                if self.clock() >= budget.deadline or self.stop_event.is_set():
                    raise BudgetExceeded()
                row.update(fetched_at=now.isoformat(), attempted_at=now.isoformat(), error_code=None,
                           entries_json=encode(entries))
            except BudgetExceeded:
                stopped = "budget"
                # A slow source must not indefinitely starve the other sources.
                next_provider = PROVIDERS[(PROVIDERS.index(provider) + 1) % len(PROVIDERS)]
                break  # No partial cache, no failure/backoff; retry on next wake.
            except ProviderFailure as error:
                row.update(attempted_at=now.isoformat(),
                           error_code="invalid_response" if error.code == "not_found" else error.code)
                failures.append(provider)
            except (ValueError, TypeError, AttributeError, KeyError, OverflowError):
                row.update(attempted_at=now.isoformat(), error_code="invalid_response")
                failures.append(provider)
            finally:
                budget.deadline = whole_deadline
            attempted.append(provider)
        if self.stop_event.is_set() or not enabled() or not credentials_present():
            return False
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            for p in PROVIDERS:
                r = states[p]
                if p not in attempted and not r.get("expired"):
                    continue
                db.execute("INSERT INTO release_calendar_state VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET "
                           "fetched_at=excluded.fetched_at,attempted_at=excluded.attempted_at,"
                           "error_code=excluded.error_code,entries_json=excluded.entries_json",
                           (p, r["fetched_at"], r["attempted_at"], r["error_code"], r["entries_json"]))
            db.commit()  # Fetch state survives validation, cover-store or publication failure.
        changed = False
        ready = all(r["fetched_at"] is not None for r in states.values())
        try:
            if ready:
                rows = [r for state in states.values() for r in json.loads(state["entries_json"])]
                entries = sorted_entries(rows, start, end)
                if len(entries) > MAX_ENTRIES:
                    raise ProviderFailure("invalid_response")
                doc = {"rangeStart": start.isoformat(), "rangeEnd": end.isoformat(), "entries": entries,
                       "sources": [{"provider": p, "fetchedAt": states[p]["fetched_at"], "errorCode": states[p]["error_code"]}
                                   for p in ("igdb", "tmdb")]}
                with self.get_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    changed = self.publish(db, doc, now)
                    db.commit()
            elif stopped is None:
                stopped = "incomplete_cache"
        except Exception as error:
            stopped = "publish_failed"
            logging.getLogger(__name__).error("%s", type(error).__name__)
        retry = previous_status and json.loads(previous_status[0]).get("stopReason") == "publish_failed"
        if attempted or stopped or changed or retry:
            status = {"startedAt": now.isoformat(), "finishedAt": self.now().isoformat(),
                      "checked": attempted, "failed": failures, "requests": budget.requests,
                      "changed": changed, "stopReason": stopped, "nextProvider": next_provider}
            with self.get_db() as db:
                db.execute("INSERT INTO release_calendar_status VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET "
                           "status_json=excluded.status_json", (encode(status),))
                db.commit()
        return changed


def register(app, get_db, require_client, relay):
    from fastapi import Header, HTTPException, Request
    from pydantic import BaseModel, ConfigDict, ValidationError
    from app_lifecycle import lifecycle
    from collection_release_checks import RunLimiter
    import home_publications as common
    import home_upcoming

    worker = Worker(get_db, LiveTransport(relay), home_upcoming.publish_calendar)
    global _current
    _current = worker
    app.state.release_calendar_worker = worker
    limiter = RunLimiter()

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()

    hooks = lifecycle(app)
    hooks.on_startup(startup)
    hooks.on_startup(worker.start)
    hooks.on_drain(worker.drain)
    hooks.on_shutdown(worker.stop)

    def guard(authorization):
        principal = str(require_client(authorization) or "client")
        if not enabled():
            raise HTTPException(404, {"code": "releaseCalendarUnavailable", "message": "서버 발매 캘린더가 켜져 있지 않습니다."})
        return principal

    class RunRequest(BaseModel):
        model_config = ConfigDict(extra="forbid", strict=True)
        version: int = 1

    @app.get(PREFIX + "/status")
    def status(authorization: str | None = Header(default=None)):
        guard(authorization)
        return worker.status_view()

    @app.post(PREFIX + "/run")
    async def run(request: Request, authorization: str | None = Header(default=None)):
        principal = guard(authorization)
        wait = limiter.admit(principal)
        if wait:
            raise HTTPException(429, {"code": "releaseCalendarRateLimited", "message": "잠시 후 다시 시도해 주세요."},
                                headers={"Retry-After": str(wait)})
        body = await common.bounded_body(request, 1024, "invalidReleaseCalendarRequest", "캘린더 요청이 너무 큽니다.")
        try:
            command = RunRequest.model_validate_json(body)
            if command.version != 1:
                raise ValueError()
        except (ValueError, ValidationError):
            raise HTTPException(422, {"code": "invalidReleaseCalendarRequest", "message": "캘린더 요청을 확인해 주세요."}) from None
        if not credentials_present() or not worker.alive():
            raise HTTPException(503, {"code": "releaseCalendarUnavailable", "message": "서버 발매 캘린더를 실행할 수 없습니다."})
        worker.request()
        return {"version": 1, "queued": True}

    return worker
