"""Server-owned daily packs and shared character album (CARD-GACHA-001).

All grants, draws and album updates use the caller's control database transaction.
No library publication, asset mutation or background accrual is performed here.
"""
import base64
import hashlib
import json
import random
import re
import secrets
from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Literal

from fastapi import Header, Query, Request
from pydantic import Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import album_authority
import asset_visibility
import authority
import conditional
from home_publications import Digest, Strict, bounded_body, fail, text

PREFIX = "/v1/cards"
MAX_BODY_BYTES = 4096
MAX_CUTOUT_BYTES = 2 * 1024 * 1024
TICKET_SECONDS = 300
KST = timezone(timedelta(hours=9))
TIERS = ("n", "r", "sr", "ssr", "ur", "lr")
WEIGHTS = (550, 250, 130, 50, 18, 2)
IMAGE_SQL = "kind IN ('image','gif','animated_gif') AND committed=1"
AssetId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
PACK_ID = re.compile(r"^[db]-[0-9]{8}$")

DDL = """
CREATE TABLE IF NOT EXISTS card_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 accrued_through TEXT, cover_day TEXT, cover_json TEXT);
INSERT OR IGNORE INTO card_state VALUES(1,0,NULL,NULL,NULL);
CREATE TABLE IF NOT EXISTS card_packs(
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('daily','bonus')),
 day TEXT NOT NULL, granted_at TEXT NOT NULL, opened_at TEXT, opened_by TEXT,
 open_operation_id TEXT);
CREATE INDEX IF NOT EXISTS card_packs_unopened ON card_packs(opened_at,day,id);
CREATE TABLE IF NOT EXISTS card_draws(
 pack_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 4),
 character_id TEXT NOT NULL, tier TEXT NOT NULL, art_asset_id TEXT NOT NULL,
 serial INTEGER, was_new INTEGER NOT NULL, card_json TEXT NOT NULL,
 PRIMARY KEY(pack_id,slot));
CREATE INDEX IF NOT EXISTS card_draws_character ON card_draws(character_id,tier,serial);
CREATE TABLE IF NOT EXISTS card_album(
 character_id TEXT NOT NULL, tier TEXT NOT NULL, count INTEGER NOT NULL,
 level INTEGER NOT NULL, art_asset_id TEXT NOT NULL,
 first_drawn_at TEXT NOT NULL, last_drawn_at TEXT NOT NULL,
 PRIMARY KEY(character_id,tier));
CREATE TABLE IF NOT EXISTS card_serials(tier TEXT PRIMARY KEY, next INTEGER NOT NULL);
INSERT OR IGNORE INTO card_serials VALUES('ur',1);
INSERT OR IGNORE INTO card_serials VALUES('lr',1);
CREATE TABLE IF NOT EXISTS card_cutouts(
 asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 content_type TEXT NOT NULL, object_key TEXT NOT NULL, model TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('uploading','ready')), created_at TEXT NOT NULL,
 ready_at TEXT);
"""


def startup_db(db):
    db.executescript(DDL)


class OpenBody(Strict):
    operationId: text(128)


class PrepareBody(Strict):
    assetId: AssetId
    sha256: Digest
    sizeBytes: int = Field(gt=0, le=MAX_CUTOUT_BYTES)
    contentType: Literal["image/webp", "image/png"]
    model: Literal["toonout-1"]


def _now():
    return datetime.now(timezone.utc)


def _iso(instant):
    return instant.astimezone(timezone.utc).isoformat()


def card_day(instant):
    return (instant.astimezone(KST) - timedelta(hours=5)).date()


def day_start(day):
    return datetime.combine(day, time(5), KST)


def status_signal(db):
    return db.execute("SELECT revision FROM card_state WHERE singleton=1").fetchone()[0]


def _bump(db):
    db.execute("UPDATE card_state SET revision=revision+1 WHERE singleton=1")


def saved_count(db, day):
    return db.execute(
        "SELECT COUNT(*) FROM visible_assets WHERE " + IMAGE_SQL +
        " AND julianday(COALESCE(collected_at,created_at))>=julianday(?)"
        " AND julianday(COALESCE(collected_at,created_at))<julianday(?)",
        [_iso(day_start(day)), _iso(day_start(day + timedelta(days=1)))]).fetchone()[0]


def _nodes(db):
    current = db.execute("SELECT index_json FROM mobile_character_state WHERE singleton=1").fetchone()
    return [] if current is None else json.loads(current[0])["nodes"]


def eligible_characters(db):
    nodes = _nodes(db)
    series = {n["sourceId"]: n["name"] for n in nodes if n["kind"] == "series"}
    characters = {}
    for node in nodes:
        if node["kind"] != "character" or node.get("role") == "extras" or node.get("excluded"):
            continue
        images = db.execute(
            "SELECT v.id,v.width,v.height FROM mobile_character_members m "
            "JOIN visible_assets v ON v.id=m.asset_id WHERE m.node_id=? AND m.filter='all' "
            "AND v." + IMAGE_SQL + " AND NOT EXISTS (SELECT 1 FROM mobile_character_hidden_members h "
            "WHERE h.node_id=m.node_id AND h.filter=m.filter AND h.asset_id=m.asset_id) ORDER BY v.id",
            [node["id"]]).fetchall()
        if images:
            characters[node["sourceId"]] = {"name": node["name"], "series": series.get(node["seriesId"], ""),
                                             "images": images}
    return characters


def _cover(db, day):
    state = db.execute("SELECT cover_day,cover_json FROM card_state WHERE singleton=1").fetchone()
    if state[0] == day.isoformat():
        return
    rng = random.Random(hashlib.sha256(("cover:" + day.isoformat()).encode()).digest())
    liked = []
    active = authority.active_domain(db, "albums")
    if active:
        likes = album_authority.likes_album_id(db, active["libraryId"], require_unique=False)
        if likes:
            liked = [r[0] for r in db.execute(
                "SELECT v.id FROM visible_assets v JOIN album_authority_members m ON m.asset_id=v.id "
                "WHERE m.library_id=? AND m.album_id=? AND m.desired_state=1 AND v." + IMAGE_SQL +
                " ORDER BY v.id", [active["libraryId"], likes])]
    rng.shuffle(liked)
    picked = liked[:5]
    if len(picked) < 5:
        fallback = sorted({r["id"] for c in eligible_characters(db).values() for r in c["images"]} - set(picked))
        rng.shuffle(fallback)
        picked.extend(fallback[:5 - len(picked)])
    db.execute("UPDATE card_state SET cover_day=?,cover_json=? WHERE singleton=1",
               [day.isoformat(), json.dumps(picked)])
    _bump(db)


def accrue(db, now):
    """First access starts today; missed days are consumed even when the cap is full.

    Today alone is revisited, so a late upload cannot retroactively earn a bonus.
    """
    asset_visibility.install(db)
    today = card_day(now)
    previous = db.execute("SELECT accrued_through FROM card_state WHERE singleton=1").fetchone()[0]
    day = date.fromisoformat(previous) + timedelta(days=1) if previous else today
    day = min(day, today)
    unopened = db.execute("SELECT COUNT(*) FROM card_packs WHERE opened_at IS NULL").fetchone()[0]
    while day <= today:
        for kind, prefix in (("daily", "d"), ("bonus", "b")):
            if unopened >= 3:
                break
            if kind == "bonus" and saved_count(db, day) < 50:
                continue
            changed = db.execute("INSERT OR IGNORE INTO card_packs(id,kind,day,granted_at) VALUES(?,?,?,?)",
                                 [prefix + "-" + day.strftime("%Y%m%d"), kind, day.isoformat(), _iso(now)]).rowcount
            unopened += changed
            if changed:
                _bump(db)
        day += timedelta(days=1)
    if previous is None or previous < today.isoformat():
        db.execute("UPDATE card_state SET accrued_through=? WHERE singleton=1", [today.isoformat()])
        _bump(db)
    _cover(db, today)
    return today


def roll_tier(rng, guaranteed=False):
    start = 2 if guaranteed else 0
    value = rng.randrange(sum(WEIGHTS[start:]))
    for tier, weight in zip(TIERS[start:], WEIGHTS[start:]):
        if value < weight:
            return tier
        value -= weight
    raise AssertionError("unreachable tier roll")


def roll_pack(rng):
    tiers = [roll_tier(rng) for _ in range(5)]
    if all(tier in ("n", "r") for tier in tiers):
        tiers[4] = roll_tier(rng, guaranteed=True)
    return tiers


def _card(db, character_id, tier, art_id, count, level, serial, is_new, nodes):
    node = next((n for n in nodes if n["kind"] == "character" and n["sourceId"] == character_id), None)
    series = next((n["name"] for n in nodes if node and n["kind"] == "series"
                   and n["sourceId"] == node["seriesId"]), "")
    art = db.execute("SELECT width,height FROM visible_assets WHERE id=? AND " + IMAGE_SQL, [art_id]).fetchone()
    cutout = db.execute("SELECT 1 FROM card_cutouts WHERE asset_id=? AND state='ready'", [art_id]).fetchone()
    return {"characterId": character_id, "characterName": node["name"] if node else character_id,
            "seriesName": series, "tier": tier, "artAssetId": art_id,
            "artWidth": (art[0] or 0) if art else 0, "artHeight": (art[1] or 0) if art else 0,
            "cutout": {"assetId": art_id} if art and cutout and tier in TIERS[3:] else None,
            "count": count, "level": level, "serial": str(serial) if serial is not None else None,
            "isNew": is_new}


def open_pack(db, pack_id, operation_id, principal, now):
    """Caller holds BEGIN IMMEDIATE, including the idempotency check."""
    accrue(db, now)
    pack = db.execute("SELECT * FROM card_packs WHERE id=?", [pack_id]).fetchone()
    if pack is None:
        fail(404, "packNotFound", "Card pack not found.")
    if pack["opened_at"] is not None:
        cards = [json.loads(r[0]) for r in db.execute(
            "SELECT card_json FROM card_draws WHERE pack_id=? ORDER BY slot", [pack_id])]
        return {"packId": pack_id, "openedAt": pack["opened_at"], "alreadyOpened": True, "cards": cards}
    characters = eligible_characters(db)
    if not characters:
        fail(409, "noCharacters", "No registered characters have visible images.")
    rng = secrets.SystemRandom()
    nodes = _nodes(db)
    cards = []
    for slot, tier in enumerate(roll_pack(rng)):
        character_id = rng.choice(sorted(characters))
        chosen = rng.choice(characters[character_id]["images"])
        old = db.execute("SELECT * FROM card_album WHERE character_id=? AND tier=?", [character_id, tier]).fetchone()
        count = old["count"] + 1 if old else 1
        art_id = old["art_asset_id"] if old else chosen["id"]
        level = min(count, 5)
        serial = None
        if tier in ("ur", "lr"):
            serial = db.execute("SELECT next FROM card_serials WHERE tier=?", [tier]).fetchone()[0]
            db.execute("UPDATE card_serials SET next=next+1 WHERE tier=?", [tier])
        db.execute("INSERT INTO card_album VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_id,tier) "
                   "DO UPDATE SET count=excluded.count,level=excluded.level,last_drawn_at=excluded.last_drawn_at",
                   [character_id, tier, count, level, art_id, _iso(now), _iso(now)])
        card = {"slot": slot, **_card(db, character_id, tier, art_id, count, level, serial, old is None, nodes)}
        # Snapshot display data as well: later duplicates/publications must not change a retry.
        db.execute("INSERT INTO card_draws VALUES(?,?,?,?,?,?,?,?)",
                   [pack_id, slot, character_id, tier, art_id, serial, int(old is None), json.dumps(card)])
        cards.append(card)
    db.execute("UPDATE card_packs SET opened_at=?,opened_by=?,open_operation_id=? WHERE id=?",
               [_iso(now), principal, operation_id, pack_id])
    _bump(db)
    return {"packId": pack_id, "openedAt": _iso(now), "alreadyOpened": False, "cards": cards}


def _cover_view(db, day):
    row = db.execute("SELECT cover_day,cover_json FROM card_state WHERE singleton=1").fetchone()
    if row[0] != day.isoformat():
        return None
    ids = json.loads(row[1])
    visible = {r[0] for r in db.execute("SELECT id FROM visible_assets WHERE " + IMAGE_SQL +
                                      " AND id IN (SELECT value FROM json_each(?))", [json.dumps(ids)])}
    ids = [asset_id for asset_id in ids if asset_id in visible]
    return {"day": row[0], "assetIds": ids} if ids else None


def _cursor(character_id, tier):
    return base64.urlsafe_b64encode(json.dumps([character_id, tier]).encode()).decode().rstrip("=")


def _position(after):
    if not after:
        return "", ""
    try:
        value = json.loads(base64.b64decode(after + "=" * (-len(after) % 4), altchars=b"-_", validate=True))
        if (not isinstance(value, list) or len(value) != 2 or not all(isinstance(v, str) for v in value)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value[0]) or value[1] not in TIERS):
            raise ValueError()
        return tuple(value)
    except (ValueError, UnicodeError):
        fail(422, "invalidCardCursor", "Invalid album cursor.")


async def _body(request, model):
    raw = await bounded_body(request, MAX_BODY_BYTES, "cardBodyTooLarge", "Card request is too large.")
    try:
        return model.model_validate_json(raw)
    except (ValueError, ValidationError):
        fail(422, "invalidCardRequest", "Invalid card request.")


def _asset_id(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        fail(422, "invalidCardAsset", "Invalid asset id.")


def register(app, get_db, require_client, require_publisher, *, storage, bucket, presign_put, presign_get):
    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()

    @app.get(PREFIX + "/state")
    def state(authorization: str | None = Header(default=None), if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            today = accrue(db, _now())
            summary = db.execute("SELECT COUNT(*),COALESCE(SUM(count),0) FROM card_album").fetchone()
            packs = [dict(r) for r in db.execute("SELECT id,kind,day FROM card_packs WHERE opened_at IS NULL ORDER BY day,id")]
            payload = {"version": 1, "revision": status_signal(db), "day": today.isoformat(),
                       "nextResetAt": _iso(day_start(today + timedelta(days=1))), "unopened": packs,
                       "savedToday": saved_count(db, today), "bonusThreshold": 50,
                       "bonusGranted": db.execute("SELECT 1 FROM card_packs WHERE id=?",
                                                  ["b-" + today.strftime("%Y%m%d")]).fetchone() is not None,
                       "cover": _cover_view(db, today), "albumSummary": {"cards": summary[0], "total": summary[1]}}
            db.commit()
        return conditional.json_response(payload, if_none_match)

    def do_open(pack_id, body, principal):
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            result = open_pack(db, pack_id, body.operationId, principal, _now())
            db.commit()
            return result

    @app.post(PREFIX + "/packs/{pack_id}/open")
    async def open_route(pack_id: str, request: Request, authorization: str | None = Header(default=None)):
        principal = await run_in_threadpool(require_client, authorization)
        if not PACK_ID.fullmatch(pack_id):
            fail(422, "invalidPackId", "Invalid pack id.")
        body = await _body(request, OpenBody)
        return await run_in_threadpool(do_open, pack_id, body, principal)

    @app.get(PREFIX + "/album")
    def album(authorization: str | None = Header(default=None),
              after: str | None = Query(default=None, max_length=512), limit: int = Query(default=50, ge=1, le=200)):
        require_client(authorization)
        position = _position(after)
        with get_db() as db:
            db.execute("BEGIN")
            asset_visibility.install(db)
            rows = db.execute("SELECT * FROM card_album WHERE (character_id,tier)>(?,?) "
                              "ORDER BY character_id,tier LIMIT ?", [*position, limit + 1]).fetchall()
            nodes = _nodes(db)
            cards = []
            for row in rows[:limit]:
                serial = db.execute("SELECT MIN(serial) FROM card_draws WHERE character_id=? AND tier=?",
                                    [row["character_id"], row["tier"]]).fetchone()[0]
                cards.append({"slot": None, **_card(db, row["character_id"], row["tier"], row["art_asset_id"],
                                                   row["count"], row["level"], serial, False, nodes),
                              "firstDrawnAt": row["first_drawn_at"]})
            last = rows[limit - 1] if len(rows) > limit else None
            return {"version": 1, "revision": status_signal(db), "cards": cards,
                    "nextCursor": _cursor(last["character_id"], last["tier"]) if last else None}

    def prepare(body):
        key = f"card-cutouts/{body.assetId}/{body.sha256}." + ("webp" if body.contentType == "image/webp" else "png")
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            asset_visibility.install(db)
            if db.execute("SELECT 1 FROM visible_assets WHERE id=? AND " + IMAGE_SQL, [body.assetId]).fetchone() is None:
                fail(404, "cardArtUnavailable", "Card art is unavailable.")
            row = db.execute("SELECT * FROM card_cutouts WHERE asset_id=?", [body.assetId]).fetchone()
            if row and (row["sha256"], row["size_bytes"], row["content_type"], row["model"]) != (
                    body.sha256, body.sizeBytes, body.contentType, body.model):
                # A prepared/ready immutable object cannot be replaced underneath a signed PUT or HEAD.
                fail(409, "cutoutConflict", "A different cutout is already registered for this asset.")
            if row and row["state"] == "ready":
                return {"assetId": body.assetId, "state": "ready", "upload": None}
            db.execute("INSERT OR IGNORE INTO card_cutouts VALUES(?,?,?,?,?,?, 'uploading',?,NULL)",
                       [body.assetId, body.sha256, body.sizeBytes, body.contentType, key, body.model, _iso(_now())])
            db.commit()
        url = presign_put(key, body.contentType, TICKET_SECONDS, content_length=body.sizeBytes)
        return {"assetId": body.assetId, "state": "uploading", "upload": {
            "method": "PUT", "url": url, "expiresIn": TICKET_SECONDS,
            "requiredHeaders": {"Content-Type": body.contentType, "Content-Length": str(body.sizeBytes)}}}

    @app.post(PREFIX + "/cutouts/prepare")
    async def prepare_route(request: Request, authorization: str | None = Header(default=None)):
        await run_in_threadpool(require_publisher, authorization)
        body = await _body(request, PrepareBody)
        return await run_in_threadpool(prepare, body)

    @app.post(PREFIX + "/cutouts/{asset_id}/complete")
    def complete(asset_id: str, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        _asset_id(asset_id)
        with get_db() as db:
            row = db.execute("SELECT * FROM card_cutouts WHERE asset_id=?", [asset_id]).fetchone()
        if row is None:
            fail(404, "cutoutUnavailable", "Cutout has not been prepared.")
        if row["state"] == "ready":
            return {"assetId": asset_id, "state": "ready"}
        try:
            head = storage().head_object(Bucket=bucket(), Key=row["object_key"])
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey", "NotFound"):
                fail(409, "uploadMissing", "Cutout upload is missing.")
            fail(503, "storageUnavailable", "Cutout storage is unavailable.")
        if head.get("ContentLength") != row["size_bytes"]:
            fail(409, "sizeMismatch", "Uploaded cutout size does not match.")
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("UPDATE card_cutouts SET state='ready',ready_at=? "
                                 "WHERE asset_id=? AND state='uploading'", [_iso(_now()), asset_id]).rowcount
            if changed:
                _bump(db)
            db.commit()
        return {"assetId": asset_id, "state": "ready"}

    @app.get(PREFIX + "/cutout-candidates")
    def candidates(authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            asset_visibility.install(db)
            ids = [r[0] for r in db.execute("SELECT DISTINCT a.art_asset_id FROM card_album a "
                "JOIN visible_assets v ON v.id=a.art_asset_id WHERE a.tier IN ('ssr','ur','lr') AND v." + IMAGE_SQL +
                " AND NOT EXISTS (SELECT 1 FROM card_cutouts c WHERE c.asset_id=a.art_asset_id AND c.state='ready') "
                "ORDER BY a.art_asset_id")]
        return {"assetIds": ids}

    @app.post(PREFIX + "/cutouts/{asset_id}/ticket")
    def ticket(asset_id: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        _asset_id(asset_id)
        with get_db() as db:
            db.execute("BEGIN")
            asset_visibility.install(db)
            row = db.execute("SELECT c.* FROM card_cutouts c JOIN visible_assets v ON v.id=c.asset_id "
                             "WHERE c.asset_id=? AND c.state='ready' AND v." + IMAGE_SQL, [asset_id]).fetchone()
            owned = db.execute("SELECT 1 FROM card_album WHERE art_asset_id=? LIMIT 1", [asset_id]).fetchone()
            cover = _cover_view(db, card_day(_now()))
            if row is None or not (owned or cover and asset_id in cover["assetIds"]):
                fail(404, "cutoutUnavailable", "No owned card or today's cover uses this cutout.")
        return {"url": presign_get(row["object_key"], TICKET_SECONDS), "expires_in": TICKET_SECONDS,
                "sha256": row["sha256"], "size_bytes": row["size_bytes"], "content_type": row["content_type"]}

    return startup
