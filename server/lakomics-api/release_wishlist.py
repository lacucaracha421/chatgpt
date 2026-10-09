"""Server-owned release wishlist, dormant unless explicitly enabled and seeded.

The core uses only the standard library. API validation/authentication is installed
by register(); provider I/O uses the calendar's transport and its single daemon.
Private seed rows use the PC SQLite column names (including serialized scopes).
"""
import hashlib
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import release_calendar as rc

ENV = "LAKOMICS_RELEASE_WISHLIST"
FEATURE = "serverReleaseWishlist"
PREFIX = "/v1/home/upcoming/wishlist"
MAX_SEED_BYTES = 16 * 1024 * 1024
MAX_ITEMS = 1000
MAX_PRIVATE_ROWS = 100000
MAX_RESULT_BYTES = 384 * 1024  # <=40 retained results remain below 16 MiB.
MAX_CURSOR = 9_007_199_254_740_991
_current = None
DDL = """
CREATE TABLE IF NOT EXISTS release_wishlist_owner(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL DEFAULT 'awaitingSeed'
 CHECK(mode IN ('awaitingSeed','server')), library_id TEXT, endpoint TEXT,
 seed_operation_id TEXT, seed_digest TEXT, seed_result TEXT,
 applied_through INTEGER NOT NULL DEFAULT 0, state_revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO release_wishlist_owner(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS release_wishlist_items(
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
 title TEXT NOT NULL, original_title TEXT, cover TEXT, platforms_json TEXT NOT NULL,
 tracked_platforms_json TEXT, source TEXT NOT NULL, added_at TEXT NOT NULL,
 muted INTEGER NOT NULL, last_checked_at TEXT, next_check_at TEXT, released_at TEXT,
 revision INTEGER NOT NULL, UNIQUE(provider,external_id));
CREATE TABLE IF NOT EXISTS release_wishlist_dates(
 item_id TEXT NOT NULL REFERENCES release_wishlist_items(id) ON DELETE CASCADE,
 region TEXT NOT NULL, platform TEXT NOT NULL, date TEXT, precision TEXT NOT NULL,
 checked_at TEXT NOT NULL, PRIMARY KEY(item_id,region,platform));
CREATE TABLE IF NOT EXISTS release_wishlist_events(
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES release_wishlist_items(id) ON DELETE CASCADE,
 event_kind TEXT NOT NULL, previous_value TEXT, current_value TEXT,
 detected_at TEXT NOT NULL, read_at TEXT);
CREATE INDEX IF NOT EXISTS release_wishlist_due ON release_wishlist_items(muted,next_check_at,id);
CREATE INDEX IF NOT EXISTS release_wishlist_unread ON release_wishlist_events(item_id,read_at,detected_at,id);
CREATE TABLE IF NOT EXISTS release_wishlist_provider_state(
 upstream TEXT PRIMARY KEY, attempted_at TEXT, failures INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, retry_at TEXT);
CREATE TABLE IF NOT EXISTS release_wishlist_status(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), status_json TEXT NOT NULL DEFAULT '{}',
 retained_json TEXT NOT NULL DEFAULT '[]');
INSERT OR IGNORE INTO release_wishlist_status(singleton) VALUES(1);
"""
ITEM_FIELDS = ("id", "kind", "provider", "external_id", "title", "original_title", "cover",
               "platforms_json", "tracked_platforms_json", "source", "added_at", "muted",
               "last_checked_at", "next_check_at", "released_at")
DATE_FIELDS = ("item_id", "region", "platform", "date", "precision", "checked_at")
EVENT_FIELDS = ("id", "item_id", "event_kind", "previous_value", "current_value", "detected_at", "read_at")


class Rejected(ValueError):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


def enabled():
    return os.environ.get(ENV, "").strip().lower() in ("1", "true", "yes", "on")


def startup_db(db):
    db.executescript(DDL)


def owned(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='release_wishlist_owner'").fetchone():
        return False
    row = db.execute("SELECT mode FROM release_wishlist_owner WHERE singleton=1").fetchone()
    return row is not None and row[0] == "server"


def features():
    if not enabled() or _current is None:
        return []
    with _current.get_db() as db:
        return [FEATURE] if owned(db) else []


def today(now):
    return now.astimezone(timezone(timedelta(hours=9))).date()


def next_check(now, value, precision):
    if precision == "exact" and (day := rc.day(value)) is not None:
        until = (day - today(now)).days
        if until < -30:
            return None
        if until <= 14:
            return (now + timedelta(hours=6)).isoformat()
    return (now + timedelta(hours=24)).isoformat()


def released_on(value, precision, day):
    return precision == "exact" and rc.day(value) is not None and rc.day(value) <= day


def period_token(value, precision):
    day = rc.day(value)
    if day is None or precision == "tbd":
        return "tbd"
    return {"exact": day.isoformat(), "month": f"{day.year:04d}-{day.month:02d}",
            "quarter": f"{day.year:04d}-Q{(day.month - 1) // 3 + 1}", "year": f"{day.year:04d}"}[precision]


def detect_changes(previous, current, latched, day):
    before, after = period_token(*previous), period_token(*current)
    events = []
    if before != after:
        old, new = rc.period(*previous), rc.period(*current)
        narrowed = current[1] == "exact" and old and new and old[0] <= new[0] < old[1]
        kind = "date_set" if (previous[1] == "tbd" and current[1] != "tbd") or narrowed else "date_changed"
        events.append((kind, before, after))
    if not latched and released_on(*current, day):
        events.append(("released", None, after))
    return events


def identity(id_):
    match = re.fullmatch(r"(igdb|tmdb):([1-9][0-9]*|tv:([1-9][0-9]*):s([1-9][0-9]*))", id_ or "")
    if not match or (match[1] == "igdb" and match[3]):
        raise Rejected("invalidWishlistIdentity")
    numbers = (match[3], match[4]) if match[3] else (match[2],)
    if any(int(n) >= 2**63 for n in numbers):
        raise Rejected("invalidWishlistIdentity")
    return ("anime" if match[3] else "game" if match[1] == "igdb" else "movie", match[1], match[2])


def _timestamp(value, nullable=False):
    if value is None and nullable:
        return
    if not isinstance(value, str) or len(value) > 64 or rc.parse_time(value) is None \
            or rc.parse_time(value).tzinfo is None:
        raise Rejected("invalidWishlistSeed")
    # Do not normalize timestamps: lossless transfer preserves the PC's strings.
    if datetime.fromisoformat(value).tzinfo is None:
        raise Rejected("invalidWishlistSeed")


def _string(value, limit, nullable=False):
    if value is None and nullable:
        return
    if not isinstance(value, str) or len(value) > limit:
        raise Rejected("invalidWishlistSeed")


def _platforms(value, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise Rejected("invalidWishlistSeed")
    values = json.loads(value)
    if not isinstance(values, list) or len(values) > 32:
        raise Rejected("invalidWishlistSeed")
    for item in values:
        _string(item, 1000)
    return values


def validate_seed(body):
    fields = {"version", "operationId", "expectedRevision", "expectedDigest", "libraryId", "endpoint",
              "intentCursor", "items", "dates", "events"}
    if not isinstance(body, dict) or set(body) != fields or type(body["version"]) is not int or body["version"] != 1:
        raise Rejected("invalidWishlistSeed")
    try:
        if str(uuid.UUID(body["operationId"])) != body["operationId"]:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise Rejected("invalidWishlistSeed") from None
    for key in ("expectedRevision", "intentCursor"):
        if type(body[key]) is not int or not 0 <= body[key] <= MAX_CURSOR:
            raise Rejected("invalidWishlistSeed")
    if body["expectedDigest"] is not None and not re.fullmatch(r"[0-9a-f]{64}", body["expectedDigest"]):
        raise Rejected("invalidWishlistSeed")
    for key in ("libraryId", "endpoint"):
        _string(body[key], 2048)
        if not body[key].strip() or any(ord(c) < 32 for c in body[key]):
            raise Rejected("invalidWishlistSeed")
    ids, date_ids, event_ids = set(), set(), set()
    for key, limit in (("items", MAX_ITEMS), ("dates", MAX_PRIVATE_ROWS), ("events", MAX_PRIVATE_ROWS)):
        if not isinstance(body[key], list):
            raise Rejected("invalidWishlistSeed")
        if len(body[key]) > limit:
            raise Rejected("wishlistSeedTooLarge", 413)
    for row in body["items"]:
        if not isinstance(row, dict) or set(row) != set(ITEM_FIELDS):
            raise Rejected("invalidWishlistSeed")
        kind, provider, external = identity(row["id"])
        if (row["kind"], row["provider"], row["external_id"]) != (kind, provider, external) or row["id"] in ids:
            raise Rejected("invalidWishlistSeed")
        ids.add(row["id"])
        _string(row["title"], 10000)
        _string(row["original_title"], 10000, True)
        _string(row["cover"], 4096, True)
        _platforms(row["platforms_json"])
        _platforms(row["tracked_platforms_json"], True)
        if row["source"] not in ("calendar", "manual") or type(row["muted"]) not in (bool, int) or row["muted"] not in (0, 1):
            raise Rejected("invalidWishlistSeed")
        for key in ("added_at", "last_checked_at", "next_check_at", "released_at"):
            _timestamp(row[key], key != "added_at")
    for row in body["dates"]:
        if not isinstance(row, dict) or set(row) != set(DATE_FIELDS) or row["item_id"] not in ids:
            raise Rejected("invalidWishlistSeed")
        key = (row["item_id"], row["region"], row["platform"])
        if key in date_ids:
            raise Rejected("invalidWishlistSeed")
        date_ids.add(key)
        _string(row["region"], 1000)
        _string(row["platform"], 1000)
        if row["precision"] not in rc.RANK or (row["precision"] == "tbd") != (row["date"] is None) \
                or (row["date"] is not None and (rc.day(row["date"]) is None or len(row["date"]) != 10)):
            raise Rejected("invalidWishlistSeed")
        _timestamp(row["checked_at"])
    for row in body["events"]:
        if not isinstance(row, dict) or set(row) != set(EVENT_FIELDS) or row["item_id"] not in ids:
            raise Rejected("invalidWishlistSeed")
        if not isinstance(row["id"], str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", row["id"]) or row["id"] in event_ids:
            raise Rejected("invalidWishlistSeed")
        event_ids.add(row["id"])
        if row["event_kind"] not in ("date_set", "date_changed", "released"):
            raise Rejected("invalidWishlistSeed")
        _string(row["previous_value"], 10000, True)
        _string(row["current_value"], 10000, True)
        _timestamp(row["detected_at"])
        _timestamp(row["read_at"], True)


def bump(db, id_):
    # A persistent monotonic revision also fences deleted/re-added membership.
    db.execute("UPDATE release_wishlist_owner SET state_revision=state_revision+1 WHERE singleton=1")
    revision = db.execute("SELECT state_revision FROM release_wishlist_owner WHERE singleton=1").fetchone()[0]
    db.execute("UPDATE release_wishlist_items SET revision=? WHERE id=?", (revision, id_))
    return revision


def read_dates(db, id_):
    return [dict(r) for r in db.execute("SELECT * FROM release_wishlist_dates WHERE item_id=? ORDER BY region,platform", (id_,))]


def projection(db):
    result = []
    for item in db.execute("SELECT * FROM release_wishlist_items"):
        head = rc.headline(read_dates(db, item["id"]))
        row = {"id": item["id"], "kind": item["kind"], "title": item["title"],
               "originalTitle": item["original_title"], "cover": item["cover"],
               "platforms": json.loads(item["platforms_json"]), **head, "popularity": 0.0, "port": False}
        public = rc.public_title(row)
        if not public["title"]:
            raise Rejected("invalidWishlistTitle")
        public.update(popularity=None, source=item["source"], addedAt=item["added_at"],
                      muted=bool(item["muted"]), released=item["released_at"] is not None)
        events = db.execute("SELECT * FROM release_wishlist_events WHERE item_id=? AND read_at IS NULL "
                            "ORDER BY detected_at DESC,id DESC LIMIT 50", (item["id"],)).fetchall()
        public["events"] = [{"id": e["id"], "kind": e["event_kind"],
                             "previousValue": rc.public_text(e["previous_value"], 200),
                             "currentValue": rc.public_text(e["current_value"], 200),
                             "detectedAt": e["detected_at"], "readAt": e["read_at"]} for e in reversed(events)]
        result.append((head["date"] is None, head["date"] or "", item["title"], item["id"], public))
    if len(result) > MAX_ITEMS:
        raise Rejected("wishlistProjectionTooLarge", 413)
    return [r[-1] for r in sorted(result)]


def store_projection(db, now, validate=lambda doc: doc, replace_covers=lambda db, covers: None):
    """Inside BEGIN IMMEDIATE. Merge the latest calendar, ACK and calendar fence atomically."""
    state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
    previous = json.loads(state["document"]) if state["document"] else None
    document = dict(previous) if previous else {"generatedAt": now.isoformat(), "rangeStart": today(now).isoformat(),
                                              "rangeEnd": today(now).isoformat(), "entries": [], "sources": []}
    document["wishlist"] = projection(db)
    content_changed = previous is None or document["wishlist"] != previous["wishlist"]
    if content_changed:
        document["generatedAt"] = now.isoformat()
    document = validate(document)
    serialized = rc.encode(document)
    if len(serialized.encode()) > rc.MAX_SNAPSHOT_BYTES:
        raise Rejected("wishlistProjectionTooLarge", 413)
    digest = hashlib.sha256(serialized.encode()).hexdigest()
    cursor = db.execute("SELECT applied_through FROM release_wishlist_owner WHERE singleton=1").fetchone()[0]
    if cursor < state["acknowledged_through"] or cursor > state["intent_sequence"]:
        raise Rejected("wishlistCursorConflict", 409)
    changed = digest != state["digest"]
    if changed:
        replace_covers(db, [r["cover"] for r in document["entries"] + document["wishlist"]])
        db.execute("UPDATE home_upcoming_state SET digest=?,document=?,published_at=? WHERE singleton=1",
                   (digest, serialized, now.isoformat()))
        db.execute("DELETE FROM home_upcoming_ids")
        db.executemany("INSERT OR IGNORE INTO home_upcoming_ids VALUES(?)",
                       [(r["id"],) for r in document["entries"] + document["wishlist"]])
    if changed or cursor != state["acknowledged_through"]:
        db.execute("UPDATE home_upcoming_state SET revision=revision+1,acknowledged_through=? WHERE singleton=1", (cursor,))
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='release_calendar_owner' AND type='table'").fetchone():
        db.execute("UPDATE release_calendar_owner SET digest=? WHERE singleton=1", (digest,))
    return changed


def export_private(db):
    owner = dict(db.execute("SELECT * FROM release_wishlist_owner WHERE singleton=1").fetchone())
    return {"version": 1, "owner": owner,
            "items": [dict(r) for r in db.execute("SELECT * FROM release_wishlist_items ORDER BY id")],
            "dates": [dict(r) for r in db.execute("SELECT * FROM release_wishlist_dates ORDER BY item_id,region,platform")],
            "events": [dict(r) for r in db.execute("SELECT * FROM release_wishlist_events ORDER BY item_id,detected_at,id")],
            "providers": [dict(r) for r in db.execute("SELECT * FROM release_wishlist_provider_state ORDER BY upstream")],
            "status": dict(db.execute("SELECT * FROM release_wishlist_status WHERE singleton=1").fetchone())}


def _status(db, **values):
    stored = json.loads(db.execute("SELECT status_json FROM release_wishlist_status WHERE singleton=1").fetchone()[0])
    stored.update(values)
    db.execute("UPDATE release_wishlist_status SET status_json=? WHERE singleton=1", (rc.encode(stored),))


def _insert_rows(db, table, fields, rows):
    db.executemany(f"INSERT INTO {table}({','.join(fields)}) VALUES({','.join('?' for _ in fields)})",
                   [tuple(row[k] for k in fields) for row in rows])


def seed(db, body, now, validate=lambda doc: doc, replace_covers=lambda db, covers: None):
    if not enabled():
        raise Rejected("releaseWishlistDisabled", 404)
    try:
        if len(rc.encode(body).encode()) > MAX_SEED_BYTES:
            raise Rejected("wishlistSeedTooLarge", 413)
        validate_seed(body)
    except (TypeError, KeyError, AttributeError, OverflowError, ValueError) as error:
        if isinstance(error, Rejected):
            raise
        raise Rejected("invalidWishlistSeed") from None
    digest = hashlib.sha256(rc.encode(body).encode()).hexdigest()
    db.execute("BEGIN IMMEDIATE")
    try:
        if not enabled():
            raise Rejected("releaseWishlistDisabled", 404)
        owner = db.execute("SELECT * FROM release_wishlist_owner WHERE singleton=1").fetchone()
        if owner["seed_operation_id"] == body["operationId"]:
            if owner["seed_digest"] != digest:
                raise Rejected("operationConflict", 409)
            result = json.loads(owner["seed_result"])
            db.rollback()
            return result
        if owner["mode"] == "server":
            raise Rejected("serverWishlistOwned", 409)
        state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
        if state["revision"] != body["expectedRevision"] or state["digest"] != body["expectedDigest"]:
            raise Rejected("wishlistSeedConflict", 409)
        cursor = body["intentCursor"]
        if not state["acknowledged_through"] <= cursor <= state["intent_sequence"]:
            raise Rejected("wishlistCursorConflict", 409)
        _insert_rows(db, "release_wishlist_items", ITEM_FIELDS + ("revision",),
                     [{**row, "revision": i + 1} for i, row in enumerate(body["items"])])
        _insert_rows(db, "release_wishlist_dates", DATE_FIELDS, body["dates"])
        _insert_rows(db, "release_wishlist_events", EVENT_FIELDS, body["events"])
        db.execute("UPDATE release_wishlist_owner SET mode='server',library_id=?,endpoint=?,seed_operation_id=?,"
                   "seed_digest=?,applied_through=?,state_revision=? WHERE singleton=1",
                   (body["libraryId"], body["endpoint"], body["operationId"], digest, cursor, len(body["items"])))
        store_projection(db, now, validate, replace_covers)
        apply_intents(db, now, validate, replace_covers, transaction=False)
        state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
        result = {"version": 1, "operationId": body["operationId"], "mode": "server",
                  "revision": state["revision"], "acknowledgedThrough": state["acknowledged_through"]}
        db.execute("UPDATE release_wishlist_owner SET seed_result=? WHERE singleton=1", (rc.encode(result),))
        if not enabled():
            raise Rejected("releaseWishlistDisabled", 404)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def captured_title(value, id_):
    kind, provider, external = identity(id_)
    if not isinstance(value, dict) or value.get("id") != id_ or value.get("kind") != kind \
            or not isinstance(value.get("title"), str) or not value["title"].strip() \
            or value.get("precision") not in rc.RANK:
        raise Rejected("wishlistTitleMissing", 409)
    date = value.get("date")
    if (value["precision"] == "tbd") != (date is None) or (date is not None and rc.day(date) is None):
        raise Rejected("wishlistTitleMissing", 409)
    platforms = value.get("platforms", [])
    if not isinstance(platforms, list) or len(platforms) > 32 or any(not isinstance(p, str) for p in platforms):
        raise Rejected("wishlistTitleMissing", 409)
    cover = value.get("cover")
    raw_cover = None
    if isinstance(cover, dict) and isinstance(cover.get("url"), str):
        url = cover["url"]
        if kind == "game":
            match = re.fullmatch(r"https://images\.igdb\.com/igdb/image/upload/t_cover_big/([A-Za-z0-9_]+)\.jpg", url)
            raw_cover = match[1] if match else None
        else:
            prefix = "https://image.tmdb.org/t/p/w342"
            raw_cover = url[len(prefix):] if url.startswith(prefix + "/") else None
    return rc.title_record(id_, kind, value["title"], value.get("originalTitle"), raw_cover, platforms,
                           [{"region": value.get("region") or "", "platform": p,
                             "date": date, "precision": value["precision"]} for p in (platforms or [""])],
                           0.0, value.get("port") is True)


def insert_watch(db, title, now):
    if db.execute("SELECT 1 FROM release_wishlist_items WHERE id=?", (title["id"],)).fetchone():
        return
    kind, provider, external = identity(title["id"])
    head = rc.headline(title["dates"])
    row = {"id": title["id"], "kind": kind, "provider": provider, "external_id": external,
           "title": title["title"], "original_title": title["originalTitle"], "cover": title["cover"],
           "platforms_json": rc.encode(title["platforms"]),
           "tracked_platforms_json": rc.encode(title["platforms"]) if title["port"] else None,
           "source": "calendar", "added_at": now.isoformat(), "muted": 0,
           "last_checked_at": now.isoformat(), "next_check_at": next_check(now, head["date"], head["precision"]),
           "released_at": now.isoformat() if released_on(head["date"], head["precision"], today(now)) else None,
           "revision": 0}
    _insert_rows(db, "release_wishlist_items", ITEM_FIELDS + ("revision",), [row])
    bump(db, title["id"])
    _insert_rows(db, "release_wishlist_dates", DATE_FIELDS,
                 [{**r, "item_id": title["id"], "checked_at": now.isoformat()} for r in title["dates"]])


def validate_add_capacity(db, id_, value, now):
    """Preflight an ON/owned add before logging it; UUID receipts are checked first.

    Account for the pending ordered membership suffix as well as existing rows.
    This prevents an ordinary over-cap add from stranding later remove/ACK intents.
    Unresolvable legacy titles remain the applier's visible blocked state.
    """
    state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
    document = json.loads(state["document"]) if state["document"] else {"entries": [], "wishlist": []}
    wished = {row["id"]: row for row in projection(db)}
    current_titles = {r["id"]: r for r in document["wishlist"] + document["entries"]}

    def add(item_id, title):
        if item_id in wished:
            return
        if len(wished) >= MAX_ITEMS:
            raise Rejected("wishlistItemLimit", 409)
        if title is None:
            wished[item_id] = {"id": item_id}
            return
        wished[item_id] = {**title, "popularity": None, "port": False, "releaseType": None,
                           "source": "calendar", "addedAt": now.isoformat(), "muted": False,
                           "released": released_on(title.get("date"), title.get("precision"), today(now)), "events": []}

    for row in db.execute("SELECT * FROM home_upcoming_intents WHERE sequence>? ORDER BY sequence", (state["acknowledged_through"],)):
        if row["action"] == "remove":
            wished.pop(row["item_id"], None)
        elif row["action"] == "add":
            title = json.loads(row["title_json"]) if row["title_json"] else current_titles.get(row["item_id"])
            add(row["item_id"], title)
    add(id_, value)
    if len(rc.encode({**document, "wishlist": list(wished.values())}).encode()) > rc.MAX_SNAPSHOT_BYTES:
        raise Rejected("wishlistProjectionTooLarge", 413)


def apply_intents(db, now, validate=lambda doc: doc, replace_covers=lambda db, covers: None,
                  transaction=True, clock=time.monotonic):
    if not enabled() or not owned(db):
        return 0
    if transaction:
        db.execute("BEGIN IMMEDIATE")
    count, deadline = 0, clock() + 2
    try:
        if not enabled():
            if transaction:
                db.rollback()
            return 0
        cursor = db.execute("SELECT applied_through FROM release_wishlist_owner WHERE singleton=1").fetchone()[0]
        state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
        doc = json.loads(state["document"]) if state["document"] else {"entries": [], "wishlist": []}
        titles = {r["id"]: r for r in doc["wishlist"] + doc["entries"]}
        rows = db.execute("SELECT * FROM home_upcoming_intents WHERE sequence>? ORDER BY sequence LIMIT 200", (cursor,)).fetchall()
        _status(db, blockedSequence=None, blockedError=None)
        for intent in rows:
            if clock() >= deadline:
                break
            if intent["sequence"] != cursor + 1:
                _status(db, blockedSequence=cursor + 1, blockedError="wishlistIntentGap")
                break
            db.execute("SAVEPOINT wishlist_intent")
            try:
                id_, action = intent["item_id"], intent["action"]
                existing = db.execute("SELECT * FROM release_wishlist_items WHERE id=?", (id_,)).fetchone()
                if action == "add" and existing is None:
                    value = json.loads(intent["title_json"]) if intent["title_json"] else titles.get(id_)
                    insert_watch(db, captured_title(value, id_), now)
                elif action == "remove":
                    db.execute("DELETE FROM release_wishlist_items WHERE id=?", (id_,))
                    # Explicit deletion also supports tests/connections with FK enforcement off.
                    db.execute("DELETE FROM release_wishlist_dates WHERE item_id=?", (id_,))
                    db.execute("DELETE FROM release_wishlist_events WHERE item_id=?", (id_,))
                    bump(db, id_)
                elif action in ("mute", "unmute") and existing is not None:
                    muted = int(action == "mute")
                    if existing["muted"] != muted:
                        db.execute("UPDATE release_wishlist_items SET muted=? WHERE id=?", (muted, id_))
                        bump(db, id_)
                elif action == "acknowledge" and existing is not None:
                    changed = 0
                    for event_id in json.loads(intent["event_ids"] or "[]"):
                        changed += db.execute("UPDATE release_wishlist_events SET read_at=? "
                                              "WHERE id=? AND item_id=? AND read_at IS NULL",
                                              (now.isoformat(), event_id, id_)).rowcount
                    if changed:
                        bump(db, id_)
                elif action not in ("add", "remove", "mute", "unmute", "acknowledge"):
                    raise Rejected("wishlistIntentInvalid", 409)
                db.execute("UPDATE release_wishlist_owner SET applied_through=? WHERE singleton=1", (intent["sequence"],))
                store_projection(db, now, validate, replace_covers)
                db.execute("RELEASE wishlist_intent")
                cursor = intent["sequence"]
                count += 1
            except Exception as error:
                if not db.in_transaction:
                    # The shared cover validator may roll back the whole transaction.
                    # Do not issue ROLLBACK TO a savepoint that no longer exists.
                    raise
                db.execute("ROLLBACK TO wishlist_intent")
                db.execute("RELEASE wishlist_intent")
                _status(db, blockedSequence=intent["sequence"],
                        blockedError=error.code if isinstance(error, Rejected) else "wishlistPublicationFailed")
                break
        if cursor < state["intent_sequence"] and count == len(rows) and len(rows) < 200:
            _status(db, blockedSequence=cursor + 1, blockedError="wishlistIntentGap")
        if not enabled():
            raise Rejected("releaseWishlistDisabled", 404)
        if transaction:
            db.commit()
        return count
    except Exception:
        if transaction:
            db.rollback()
        raise


def igdb_title(game):
    """ID lookup parity: prefer major platforms, falling back only if none survived."""
    if not isinstance(game, dict):
        raise rc.ProviderFailure("invalid_response")
    id_, name = rc.integer(game.get("id")), rc.text(game.get("name"))
    kind = rc.text(rc.object_value(game.get("game_type")).get("type"))
    if not id_ or id_ < 0 or not name or (kind and kind.lower().replace("_", " ") in rc.EXCLUDED_TYPES):
        return None
    dates, major = [], []
    for raw in rc.object_rows(game.get("release_dates")):
        platform = rc.object_value(raw.get("platform"))
        platform_id = rc.integer(platform.get("id"))
        # Reuse precision/region rules; inject a known platform for the all-platform fallback.
        row = rc.igdb_release({**raw, "platform": {"id": platform_id if platform_id in rc.PLATFORMS else 6}})
        if row is None:
            continue
        row["platform"] = rc.PLATFORMS.get(platform_id, platform.get("name", "").strip()
                                           if isinstance(platform.get("name", ""), str) else "")
        dates.append(row)
        if platform_id in rc.PLATFORMS:
            major.append(row)
    unique = {}
    for row in major or dates:
        key = (row["region"], row["platform"])
        old = unique.get(key)
        if old is None or (row["date"] is not None and (old["date"] is None or
                (row["date"], rc.RANK[row["precision"]]) < (old["date"], rc.RANK[old["precision"]]))):
            unique[key] = row
    dates = list(unique.values())
    platforms = list(dict.fromkeys(r["platform"] for r in dates if r["platform"]))
    order = list(rc.PLATFORMS.values())
    platforms.sort(key=lambda p: order.index(p) if p in order else len(order))
    localized = None
    for loc in rc.object_rows(game.get("game_localizations")):
        region = rc.object_value(loc.get("region"))
        if "KR" in str(region.get("identifier", "")).upper() or "korea" in rc.ascii_lower(str(region.get("name", ""))):
            localized = rc.text(loc.get("name"))
            if localized:
                break
    cover = rc.object_value(game.get("cover")).get("image_id")
    return rc.title_record(f"igdb:{id_}", "game", localized or name, name if localized else None,
                           cover if isinstance(cover, str) and cover else None, platforms, dates, 0.0)


def fetch_games(transport, ids, budget):
    query = f"fields {rc.IGDB_FIELDS}; where id = ({','.join(str(n) for n in ids)}); limit 50;"
    raw = transport.request("igdb", query, budget)
    if not isinstance(raw, list) or len(raw) > 50:
        raise rc.ProviderFailure("invalid_response")
    result, seen = {}, set()
    for game in raw:
        if not isinstance(game, dict) or rc.integer(game.get("id")) not in ids or game["id"] in seen:
            raise rc.ProviderFailure("invalid_response")
        seen.add(game["id"])
        title = igdb_title(game)
        if title:
            result[title["id"]] = title
    return result


def fetch_title(transport, item, budget):
    kind, _, external = identity(item["id"])
    try:
        if kind == "movie":
            movie = transport.request("tmdb", (f"/movie/{external}", {"language": "ko-KR", "append_to_response": "release_dates"}), budget)
            if not isinstance(movie, dict) or rc.integer(movie.get("id")) != int(external):
                raise rc.ProviderFailure("invalid_response")
            # PC requires an object for detail but missing appended dates falls back to worldwide.
            title = rc.movie_title(movie, rc.object_value(movie.get("release_dates")))
        else:
            show_id, season = external[3:].split(":s")
            show = transport.request("tmdb_tv", (f"/tv/{show_id}", {"language": "ko-KR"}), budget)
            if not isinstance(show, dict) or rc.integer(show.get("id")) != int(show_id) or not isinstance(show.get("seasons"), list):
                raise rc.ProviderFailure("invalid_response")
            chosen = next((s for s in rc.object_rows(show["seasons"]) if rc.integer(s.get("season_number")) == int(season)), None)
            if chosen is None:
                return None
            title = rc.anime_title(show, chosen)
        if title is None:
            raise rc.ProviderFailure("invalid_response")
        return title
    except rc.ProviderFailure as error:
        if error.code == "not_found":
            return None
        raise


def apply_check(db, item, fetched, now, validate=lambda doc: doc, replace_covers=lambda db, covers: None):
    """Caller owns transaction. Reject stale membership, mute and ACK revisions."""
    if not enabled() or not owned(db):
        return False
    current = db.execute("SELECT * FROM release_wishlist_items WHERE id=?", (item["id"],)).fetchone()
    if current is None or current["revision"] != item["revision"] or current["muted"]:
        return False
    previous = rc.headline(read_dates(db, item["id"]))
    scoped = fetched
    if fetched is not None and current["tracked_platforms_json"] is not None:
        scope = json.loads(current["tracked_platforms_json"])
        dates = [r for r in fetched["dates"] if r["platform"] in scope]
        scoped = {**fetched, "dates": dates, "platforms": [p for p in scope if any(r["platform"] == p for r in dates)]} if dates else None
    head = rc.headline(scoped["dates"]) if scoped is not None else previous
    events = detect_changes((previous["date"], previous["precision"]), (head["date"], head["precision"]),
                            current["released_at"] is not None, today(now))
    if scoped is not None:
        db.execute("UPDATE release_wishlist_items SET title=?,original_title=?,cover=COALESCE(?,cover),platforms_json=? WHERE id=?",
                   (scoped["title"], scoped["originalTitle"], scoped["cover"], rc.encode(scoped["platforms"]), item["id"]))
        db.execute("DELETE FROM release_wishlist_dates WHERE item_id=?", (item["id"],))
        _insert_rows(db, "release_wishlist_dates", DATE_FIELDS,
                     [{**r, "item_id": item["id"], "checked_at": now.isoformat()} for r in scoped["dates"]])
    for kind, before, after in events:
        db.execute("INSERT INTO release_wishlist_events VALUES(?,?,?,?,?,?,NULL)",
                   (str(uuid.uuid4()), item["id"], kind, before, after, now.isoformat()))
    latched = current["released_at"] or (now.isoformat() if released_on(head["date"], head["precision"], today(now)) else None)
    db.execute("UPDATE release_wishlist_items SET last_checked_at=?,next_check_at=?,released_at=? WHERE id=?",
               (now.isoformat(), next_check(now, head["date"], head["precision"]), latched, item["id"]))
    bump(db, item["id"])
    return store_projection(db, now, validate, replace_covers)


class Budget(rc.Budget):
    """Separate primary-query and actual-outbound (OAuth/retries included) limits."""
    def __init__(self, clock=time.monotonic, stop=None):
        super().__init__(seconds=90, requests=40, clock=clock, stop=stop)
        self.outbound_requests = 0
        self.bytes_left = 16 * 1024 * 1024

    def outbound(self):
        if self.outbound_requests >= 48 or self.bytes_left <= 0 or self.clock() >= self.deadline \
                or (self.stop and self.stop.is_set()):
            raise rc.BudgetExceeded()
        self.outbound_requests += 1

    def consume(self, size):
        self.bytes_left -= size
        if self.bytes_left < 0:
            raise rc.BudgetExceeded()


class Worker:
    def __init__(self, get_db, transport=None, validate=lambda doc: doc,
                 replace_covers=lambda db, covers: None, now=lambda: datetime.now(timezone.utc), clock=time.monotonic):
        self.get_db, self.transport = get_db, transport
        self.validate, self.replace_covers, self.now, self.clock = validate, replace_covers, now, clock
        self.scheduler = None
        self.run_lock, self.stop_event = threading.Lock(), threading.Event()
        self.busy = False

    def alive(self):
        return self.scheduler is not None and self.scheduler.alive() and not self.stop_event.is_set()

    def request(self):
        if self.scheduler:
            self.scheduler.wake_event.set()

    def drain(self):
        self.stop_event.set()

    def status_view(self):
        with self.get_db() as db:
            owner = db.execute("SELECT * FROM release_wishlist_owner WHERE singleton=1").fetchone()
            mode = owner["mode"]
            state = db.execute("SELECT * FROM home_upcoming_state WHERE singleton=1").fetchone()
            row = db.execute("SELECT status_json FROM release_wishlist_status WHERE singleton=1").fetchone()
            lanes = [dict(r) for r in db.execute("SELECT * FROM release_wishlist_provider_state ORDER BY upstream")]
        return {"version": 1, **json.loads(row[0]), "mode": mode, "seedReady": mode == "awaitingSeed",
                "enabled": enabled(), "configured": rc.credentials_present(), "alive": self.alive(),
                "busy": self.busy, "draining": self.stop_event.is_set(), "lanes": lanes,
                "appliedThrough": owner["applied_through"], "revision": state["revision"], "digest": state["digest"],
                "acknowledgedThrough": state["acknowledged_through"], "intentSequence": state["intent_sequence"]}

    def apply_pending(self):
        if not enabled() or self.stop_event.is_set():
            return 0
        with self.get_db() as db:
            try:
                count = apply_intents(db, self.now(), self.validate, self.replace_covers, clock=self.clock)
            except Exception:
                db.rollback()
                cursor = db.execute("SELECT applied_through FROM release_wishlist_owner WHERE singleton=1").fetchone()[0]
                _status(db, blockedSequence=cursor + 1, blockedError="wishlistPublicationFailed")
                db.commit()
                return 0
            if owned(db):
                cursor = db.execute("SELECT applied_through FROM release_wishlist_owner WHERE singleton=1").fetchone()[0]
                head = db.execute("SELECT intent_sequence FROM home_upcoming_state WHERE singleton=1").fetchone()[0]
                status = json.loads(db.execute("SELECT status_json FROM release_wishlist_status WHERE singleton=1").fetchone()[0])
                if cursor < head and count and not status.get("blockedSequence"):
                    self.request()
            return count

    def _failure(self, upstream, error, now):
        seconds = 3600
        if error.code == "rate_limited":
            retry = getattr(error, "retry_after", None)
            if isinstance(retry, (int, float)) and retry >= 0:
                seconds = min(86400, max(1, retry))
        with self.get_db() as db:
            db.execute("INSERT INTO release_wishlist_provider_state VALUES(?,?,1,?,?) ON CONFLICT(upstream) DO UPDATE SET "
                       "attempted_at=excluded.attempted_at,failures=failures+1,error_code=excluded.error_code,retry_at=excluded.retry_at",
                       (upstream, now.isoformat(), error.code, (now + timedelta(seconds=seconds)).isoformat()))
            db.commit()

    def _commit_results(self, results, now):
        retained, changed, checked = [], 0, 0
        for result in results:
            if not enabled() or self.stop_event.is_set():
                retained.append(result)
                continue
            try:
                with self.get_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    changed += int(apply_check(db, result["item"], result["title"], rc.parse_time(result["now"]),
                                               self.validate, self.replace_covers))
                    if not enabled() or self.stop_event.is_set():
                        raise Rejected("releaseWishlistDisabled", 404)
                    db.commit()
                checked += 1
            except Exception:
                retained.append(result)
        with self.get_db() as db:
            db.execute("UPDATE release_wishlist_status SET retained_json=? WHERE singleton=1", (rc.encode(retained),))
            _status(db, publicationError="wishlistPublicationFailed" if retained else None)
            db.commit()
        return changed, checked

    def run_once(self):
        if not enabled() or self.stop_event.is_set() or not self.run_lock.acquire(blocking=False):
            return False
        self.busy = True
        try:
            self.apply_pending()
            with self.get_db() as db:
                if not owned(db):
                    return False
                retained = json.loads(db.execute("SELECT retained_json FROM release_wishlist_status WHERE singleton=1").fetchone()[0])
            now = self.now()
            changed, checked = self._commit_results(retained, now) if retained else (0, 0)
            # Retained publication results are retried before further network work.
            with self.get_db() as db:
                if db.execute("SELECT retained_json FROM release_wishlist_status WHERE singleton=1").fetchone()[0] != "[]":
                    return bool(changed)
                items = [dict(r) for r in db.execute("SELECT * FROM release_wishlist_items WHERE muted=0 AND next_check_at IS NOT NULL ORDER BY next_check_at,id")
                         if rc.parse_time(r["next_check_at"]) <= now]
                lanes = {r["upstream"]: dict(r) for r in db.execute("SELECT * FROM release_wishlist_provider_state")}
                status = json.loads(db.execute("SELECT status_json FROM release_wishlist_status WHERE singleton=1").fetchone()[0])
            if not rc.credentials_present() or self.transport is None:
                return bool(changed)
            budget, results, stopped = Budget(self.clock, self.stop_event), [], None
            rotation = status.get("nextLane", "igdb")
            order = ("tmdb", "igdb") if rotation == "tmdb" else ("igdb", "tmdb")
            selected = []
            for lane in order:
                retry = rc.parse_time(lanes.get(lane, {}).get("retry_at"))
                if retry and retry > now:
                    continue
                selected.extend(r for r in items if r["provider"] == lane)
            selected = selected[:40]
            for lane in order:
                lane_items = [r for r in selected if r["provider"] == lane]
                batches = [lane_items[i:i + 10] for i in range(0, len(lane_items), 10)] if lane == "igdb" else [[r] for r in lane_items]
                for batch in batches:
                    if not enabled() or self.stop_event.is_set():
                        return bool(changed)
                    try:
                        if lane == "igdb":
                            fetched = fetch_games(self.transport, [int(r["external_id"]) for r in batch], budget)
                        else:
                            fetched = {batch[0]["id"]: fetch_title(self.transport, batch[0], budget)}
                        if self.clock() >= budget.deadline:
                            raise rc.BudgetExceeded()
                        batch_results = [{"item": r, "title": fetched.get(r["id"]), "now": now.isoformat()} for r in batch]
                        if any(len(rc.encode(result).encode()) > MAX_RESULT_BYTES for result in batch_results):
                            raise rc.ProviderFailure("invalid_response")
                        results.extend(batch_results)
                        with self.get_db() as db:
                            db.execute("INSERT INTO release_wishlist_provider_state VALUES(?,?,0,NULL,NULL) ON CONFLICT(upstream) DO UPDATE SET "
                                       "attempted_at=excluded.attempted_at,failures=0,error_code=NULL,retry_at=NULL", (lane, now.isoformat()))
                            db.commit()
                    except rc.BudgetExceeded:
                        stopped = "budget"
                        break
                    except rc.ProviderFailure as error:
                        self._failure(lane, error, now)
                        stopped = error.code
                        break
                    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                        self._failure(lane, rc.ProviderFailure("invalid_response"), now)
                        stopped = "invalid_response"
                        break
            if not enabled() or self.stop_event.is_set():
                return bool(changed)
            more_changed, more_checked = self._commit_results(results, now)
            changed, checked = changed + more_changed, checked + more_checked
            with self.get_db() as db:
                _status(db, startedAt=now.isoformat(), finishedAt=self.now().isoformat(), checked=checked, changed=changed,
                        remaining=max(0, len(items) - more_checked), stopReason=stopped,
                        nextLane="tmdb" if rotation == "igdb" else "igdb", requests=budget.requests,
                        outboundRequests=budget.outbound_requests)
                db.commit()
            return bool(changed)
        finally:
            self.busy = False
            self.run_lock.release()


def register(app, get_db, require_client, require_publisher, relay):
    from fastapi import Header, HTTPException, Request
    from starlette.concurrency import run_in_threadpool
    from app_lifecycle import lifecycle
    from collection_release_checks import RunLimiter
    import home_publications as common
    import home_upcoming as home

    def validate(document):
        try:
            return home.Upload.model_validate({"version": 1, **document}).model_dump(exclude={"version", "intentCursor"})
        except ValueError:
            raise Rejected("invalidWishlistProjection") from None

    def covers(db, values):
        common.replace_cover_refs(db, home.COVER_OWNER,
                                  [common.BlobCover.model_validate(v) if isinstance(v, dict) and "sha256" in v else None for v in values])

    worker = Worker(get_db, rc.LiveTransport(relay), validate, covers)
    global _current
    _current = worker
    app.state.release_wishlist_worker = worker
    scheduler = app.state.release_calendar_worker
    worker.scheduler = scheduler
    scheduler.wishlist_worker = worker
    limiter = RunLimiter()

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()
        worker.stop_event.clear()
        worker.apply_pending()

    hooks = lifecycle(app)
    # Install DDL before starting the shared daemon, even with a very short test delay.
    hooks.startup_handlers.remove(scheduler.start)
    hooks.on_startup(startup)
    hooks.on_startup(scheduler.start)
    hooks.on_drain(worker.drain)

    def error(exc):
        raise HTTPException(exc.status, {"code": exc.code, "message": "찜 목록 요청을 확인해 주세요."}) from None

    @app.get(PREFIX + "/status")
    def status(authorization: str | None = Header(default=None)):
        require_client(authorization)
        return worker.status_view()

    @app.get(PREFIX + "/export")
    def recovery(authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            result = export_private(db)
            db.rollback()
        return result

    def handover(body):
        try:
            with get_db() as db:
                return seed(db, body, worker.now(), validate, covers)
        except Rejected as exc:
            error(exc)

    @app.put(PREFIX + "/handover")
    async def put_seed(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        if not enabled():
            error(Rejected("releaseWishlistDisabled", 404))
        raw = await common.bounded_body(request, MAX_SEED_BYTES, "wishlistSeedTooLarge", "찜 목록 이관 요청이 너무 큽니다.")
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            error(Rejected("invalidWishlistSeed"))
        return await run_in_threadpool(handover, body)

    @app.post(PREFIX + "/run")
    async def run(request: Request, authorization: str | None = Header(default=None)):
        principal = str(require_client(authorization) or "client")
        if not enabled():
            error(Rejected("releaseWishlistDisabled", 404))
        raw = await common.bounded_body(request, 1024, "invalidReleaseWishlistRequest", "찜 확인 요청이 너무 큽니다.")
        try:
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) - {"version"} or type(body.get("version", 1)) is not int or body.get("version", 1) != 1:
                raise ValueError()
        except (ValueError, UnicodeError):
            error(Rejected("invalidReleaseWishlistRequest"))
        wait = limiter.admit(principal)
        if wait:
            raise HTTPException(429, {"code": "releaseWishlistRateLimited", "message": "잠시 후 다시 시도해 주세요."},
                                headers={"Retry-After": str(wait)})
        if not worker.alive() or not rc.credentials_present():
            error(Rejected("releaseWishlistUnavailable", 503))
        worker.request()
        return {"version": 1, "queued": True}

    return worker
