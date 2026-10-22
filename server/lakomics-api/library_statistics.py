"""Library statistics the server can count, for the tablet 통계 view (parity U27).

PC ``src-tauri/src/library/statistics.rs`` also reports opening activity (most opened, long
unseen, daily opens) and measures local derivative files. Those exist only in the PC's local
database and disk, so they are not here; the tablet labels them as PC-only.

``GET /v1/library/statistics?utcOffsetMinutes=540`` (client), ETag / 304::

    {"version": 1, "assets", "mediaKinds": [{"label": "image"|"gif"|"video", "count"}],
     "favorites": n | null, "unclassified", "originalRecordedBytes",
     "collections": {"total", "byType": {"game", "manga", "movie", "av"}},
     "collectedMonths": [{"label": "YYYY-MM", "count"}, ... <= 24, newest first],
     "artists": [{"id", "label", "count"}, ... <= 10] , "artistsPublishedAt": str | null,
     "classifications": [{"id", "label", "count"}, ... <= 10],
     "utcOffsetMinutes", "listGeneration"}

* Asset counts read ``visible_assets`` with ``committed = 1`` — exactly what ``/v1/library/assets``
  lists (no trash after authority activation, no cover-only Assets).
* ``favorites`` are visible members of the 마음에 들어요 Album; null when the Album authority is
  inactive or that Album does not exist.
* ``originalRecordedBytes`` sums the recorded original sizes, not files on any disk.
* ``collectedMonths`` cut the list's sort key ``COALESCE(collected_at, created_at)`` at
  ``utcOffsetMinutes`` (minutes east of UTC).
* ``artists`` are the PC-published artist snapshot's counts (merged keys count together), largest
  first; hidden artists are included as on the PC statistics.
* ``classifications`` count direct assignments only (not summed into parents), from canonical
  authority state once active, else the replicated relation and the published tree's names.
"""
import json
from datetime import datetime, timedelta, timezone
from types import ModuleType

from fastapi import Header, Query

import album_authority
import authority
import classification_authority
import collection_authority
import conditional
import mobile_collections
from projection_cache import ProjectionCache, heads

TOP = 10
MONTHS = 24
cache = ProjectionCache()

api: ModuleType


def _month(value, shift):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (parsed.astimezone(timezone.utc) + shift).strftime("%Y-%m")


def _favorites(db):
    albums = authority.active_domain(db, album_authority.DOMAIN)
    if albums is None:
        return None
    likes = album_authority.likes_album_id(db, albums["libraryId"], require_unique=False)
    if likes is None:
        return None
    return db.execute("""SELECT COUNT(*) FROM album_authority_members AS liked
        JOIN visible_assets AS asset ON asset.id = liked.asset_id
        WHERE liked.library_id = ? AND liked.album_id = ? AND liked.desired_state = 1
          AND asset.committed = 1""", [albums["libraryId"], likes]).fetchone()[0]


def _classifications(db, active):
    if active is not None:
        rows = db.execute("""SELECT state.classification_id AS id, state.name AS label, COUNT(*) AS count
            FROM classification_authority_assignments AS assignment
            JOIN classification_authority_state AS state
              ON state.library_id = assignment.library_id
             AND state.classification_id = assignment.classification_id AND state.deleted = 0
            JOIN visible_assets AS asset ON asset.id = assignment.asset_id AND asset.committed = 1
            WHERE assignment.library_id = ?
            GROUP BY state.classification_id ORDER BY count DESC, label, id LIMIT ?""",
                          [active["libraryId"], TOP]).fetchall()
        return [dict(row) for row in rows]
    snapshot = db.execute("SELECT payload FROM classification_snapshots WHERE singleton = 1").fetchone()
    names = {entry.get("id"): entry.get("name") for entry in
             (json.loads(snapshot["payload"]).get("entries", []) if snapshot else [])
             if isinstance(entry, dict)}
    rows = db.execute("""SELECT relationship.classification_id AS id, COUNT(*) AS count
        FROM asset_classifications AS relationship
        JOIN visible_assets AS asset ON asset.id = relationship.asset_id AND asset.committed = 1
        GROUP BY relationship.classification_id""").fetchall()
    ranked = sorted(({"id": row["id"], "label": names[row["id"]], "count": row["count"]}
                     for row in rows if isinstance(names.get(row["id"]), str)),
                    key=lambda row: (-row["count"], row["label"], row["id"]))
    return ranked[:TOP]


def _artist_revision(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_artist_state'").fetchone():
        return None
    row = db.execute("SELECT revision FROM library_artist_state WHERE singleton=1").fetchone()
    return row[0] if row else None


def _artists(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_artists'").fetchone():
        return [], None
    state = db.execute("SELECT published_at FROM library_artist_state WHERE singleton=1").fetchone()
    rows = [json.loads(row["payload"]) for row in db.execute("SELECT payload FROM library_artists")]
    ranked = sorted(({"id": row["id"], "label": row.get("displayName") or row["label"],
                      "count": row["assetCount"]} for row in rows if row.get("assetCount", 0) > 0),
                    key=lambda row: (-row["count"], row["label"], row["id"]))
    return ranked[:TOP], state["published_at"] if state else None


def statistics(utc_offset_minutes: int = Query(default=0, alias="utcOffsetMinutes", ge=-720, le=840),
               authorization: str | None = Header(default=None),
               if_none_match: str | None = Header(default=None)):
    api.client_guard(api.get_db, api.API_TOKEN)(authorization)
    shift = timedelta(minutes=utc_offset_minutes)
    with api.get_db() as db:
        db.execute("BEGIN")
        try:
            generation = api.list_generation(db)
            collection_state = collection_authority.served_state(db)
            key = cache.key(db, generation, utc_offset_minutes,
                            collection_state["revision"] if collection_state else heads(db, ("mobile_collection_replica",)),
                            # The revision only: the state row also holds the whole snapshot document.
                            _artist_revision(db))
            body = cache.get(key)
            if body is not None:
                return conditional.encoded_response(body, conditional.etag_for(body), if_none_match)
            active = authority.active_domain(db, classification_authority.DOMAIN)
            classified_sql, classified_params = api._classified_asset_sql(active)
            totals = db.execute(f"""SELECT COUNT(*) AS total,
                    COALESCE(SUM(NOT {classified_sql}), 0) AS unclassified,
                    COALESCE(SUM(asset.size_bytes), 0) AS bytes
                FROM visible_assets AS asset WHERE asset.committed = 1""", classified_params).fetchone()
            kinds = [{"label": row["kind"], "count": row["count"]} for row in db.execute(
                "SELECT kind, COUNT(*) AS count FROM visible_assets WHERE committed = 1"
                " GROUP BY kind ORDER BY count DESC, kind")]
            months = {}
            for row in db.execute("SELECT COALESCE(collected_at, created_at) AS saved FROM visible_assets"
                                  " WHERE committed = 1"):
                month = _month(row["saved"], shift)
                if month is not None:
                    months[month] = months.get(month, 0) + 1
            by_type = {kind: 0 for kind in ("game", "manga", "movie", "av")}
            source = mobile_collections.read_table(collection_state)
            for row in db.execute(f"SELECT type, COUNT(*) AS total FROM {source}"
                                  " WHERE type IN ('game','manga','movie','av') GROUP BY type"):
                by_type[row["type"]] = row["total"]
            artists, artists_published = _artists(db)
            payload = {
                "version": 1, "assets": totals["total"], "mediaKinds": kinds,
                "favorites": _favorites(db), "unclassified": totals["unclassified"],
                "originalRecordedBytes": totals["bytes"],
                "collections": {"total": sum(by_type.values()), "byType": by_type},
                "collectedMonths": [{"label": month, "count": months[month]}
                                    for month in sorted(months, reverse=True)[:MONTHS]],
                "artists": artists, "artistsPublishedAt": artists_published,
                "classifications": _classifications(db, active),
                "utcOffsetMinutes": utc_offset_minutes, "listGeneration": generation,
            }
            body = cache.put(key, conditional.encode(payload))
        finally:
            db.rollback()
    return conditional.encoded_response(body, conditional.etag_for(body), if_none_match)


def register(app, services):
    global api
    api = services
    app.get("/v1/library/statistics")(statistics)
