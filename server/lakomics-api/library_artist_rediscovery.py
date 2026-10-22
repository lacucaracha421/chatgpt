"""Artist-page 다시보기 rows for the tablet (parity U15; PC ``artists.rs`` ``on_this_day`` /
``long_unseen``), selected from the actual Assets the artist scope lists.

``GET /v1/library/artist-rediscovery?artist=<id>&localDate=YYYY-MM-DD&utcOffsetMinutes=540``
(client), ETag / 304::

    {"version": 1, "artistId", "localDate",
     "onThisDay": {"total", "yearsAgo", "localDate", "items": [mobile Asset, ... <= 24]} | null,
     "longUnseen": {"total", "items": [...]} | null,
     "longUnseenKnown": bool, "activityAt": artist snapshot publishedAt | null,
     "listGeneration"}

* The scope is the same ``artist`` scope ``/v1/library/assets`` lists (assignment, then creator
  key), read through ``visible_assets``: trash, uncommitted and cover-only Assets never appear.
* ``onThisDay``: Assets saved (``COALESCE(collected_at, created_at)``, the list's sort key) on
  ``localDate``'s month and day in an earlier year at ``utcOffsetMinutes`` (minutes east of
  UTC), from the most recent such year; oldest first.
* ``longUnseen``: Assets saved over 365 days ago and not opened for 365 days. Per-Asset opens are
  PC-local and not published; the server only has the artist's ``lastOpenedAt`` (the latest open
  of any of its Assets, from the PC snapshot). When that is absent or over 365 days old every
  Asset qualifies and the row is exact (oldest saved first); otherwise ``longUnseenKnown`` is
  false and the row is null, because the server cannot tell which Assets were opened.
  Opens on the tablet are not recorded anywhere.
* An artist absent from the published snapshot is 404 ``artistNotFound``.
"""
import json
from datetime import date, datetime, timedelta, timezone
from types import ModuleType

from fastapi import Header, HTTPException, Query

import asset_filters
import conditional
import library_assets

ROW_ITEMS = 24
LONG_UNSEEN_DAYS = 365
#: Candidate rows read per artist; far above any one artist's Asset count.
MAX_CANDIDATES = 50_000

api: ModuleType


def _instant(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _now():
    """Seam for tests."""
    return datetime.now(timezone.utc)


def select_rows(candidates, today, offset, now, last_opened):
    """``(on_this_day, long_unseen, long_unseen_known)`` from ``[(id, saved_at)]``.

    ``on_this_day`` is ``(total, year, ids)``; ``long_unseen`` is ``(total, ids)``.
    """
    shift = timedelta(minutes=offset)
    by_year = {}
    dated = []
    for asset_id, saved in candidates:
        instant = _instant(saved)
        if instant is None:
            continue
        dated.append((instant, asset_id))
        local = (instant + shift).date()
        if local.year < today.year and (local.month, local.day) == (today.month, today.day):
            by_year.setdefault(local.year, []).append((instant, asset_id))
    on_this_day = None
    if by_year:
        year = max(by_year)
        rows = sorted(by_year[year])
        on_this_day = (len(rows), year, [asset_id for _, asset_id in rows[:ROW_ITEMS]])
    cutoff = now - timedelta(days=LONG_UNSEEN_DAYS)
    opened = _instant(last_opened)
    known = opened is None or opened < cutoff
    long_unseen = None
    if known:
        rows = sorted(row for row in dated if row[0] < cutoff)
        if rows:
            long_unseen = (len(rows), [asset_id for _, asset_id in rows[:ROW_ITEMS]])
    return on_this_day, long_unseen, known


def rediscovery(artist: str = Query(min_length=1, max_length=1024),
                local_date: str = Query(alias="localDate", pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"),
                utc_offset_minutes: int = Query(default=0, alias="utcOffsetMinutes", ge=-720, le=840),
                authorization: str | None = Header(default=None),
                if_none_match: str | None = Header(default=None)):
    api.client_guard(api.get_db, api.API_TOKEN)(authorization)
    try:
        today = date.fromisoformat(local_date)
    except ValueError:
        raise HTTPException(422, {"code": "invalidLocalDate", "message": "날짜를 확인할 수 없습니다."}) from None
    filters = asset_filters.parse(artist=artist)
    clause, params = asset_filters.filter_clause(filters)
    with api.get_db() as db:
        db.execute("BEGIN")
        try:
            generation = api.list_generation(db)
            row = db.execute("SELECT payload FROM library_artists WHERE artist_id=?", [artist]).fetchone()
            if row is None:
                raise HTTPException(404, {"code": "artistNotFound", "message": "작가를 찾을 수 없습니다."})
            summary = json.loads(row["payload"])
            published = db.execute("SELECT published_at FROM library_artist_state WHERE singleton=1").fetchone()
            candidates = db.execute(
                "SELECT asset.id, COALESCE(asset.collected_at, asset.created_at) AS saved_at"
                f" FROM visible_assets AS asset WHERE asset.committed=1 {clause} LIMIT ?",
                [*params, MAX_CANDIDATES]).fetchall()
            on_this_day, long_unseen, known = select_rows(
                [(item["id"], item["saved_at"]) for item in candidates], today, utc_offset_minutes,
                _now(), summary.get("lastOpenedAt"))
            wanted = list(dict.fromkeys((on_this_day[2] if on_this_day else []) + (long_unseen[1] if long_unseen else [])))
            rows = db.execute("SELECT asset.* FROM visible_assets AS asset WHERE asset.id IN "
                              "(SELECT value FROM json_each(?))", [json.dumps(wanted)]).fetchall() if wanted else []
            rows = library_assets.image_text_flags(db, rows)
            memberships = api._mobile_memberships(db, rows)
        finally:
            db.rollback()
    items = {row["id"]: api.mobile_asset_item(row, memberships.get(row["id"], [])) for row in rows}
    pick = lambda ids: [items[asset_id] for asset_id in ids if asset_id in items]
    return conditional.json_response({
        "version": 1, "artistId": artist, "localDate": local_date,
        "onThisDay": {"total": on_this_day[0], "yearsAgo": today.year - on_this_day[1],
                      # The matched year has this month/day, so this is a real date (29 Feb too).
                      "localDate": today.replace(year=on_this_day[1]).isoformat(),
                      "items": pick(on_this_day[2])} if on_this_day else None,
        "longUnseen": {"total": long_unseen[0], "items": pick(long_unseen[1])} if long_unseen else None,
        "longUnseenKnown": known,
        "activityAt": published["published_at"] if published else None,
        "listGeneration": generation,
    }, if_none_match)


def register(app, services):
    global api
    api = services
    app.get("/v1/library/artist-rediscovery")(rediscovery)
