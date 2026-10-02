"""Library Asset listings, classification membership and display projections.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import base64
import binascii
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from types import ModuleType
from typing import Literal

from fastapi import HTTPException, Header, Query

import asset_authority
import asset_filters
import asset_list_query
import authority
import classification_authority
import classification_snapshot
import conditional


api: ModuleType


MOBILE_LIBRARY_DEFAULT_LIMIT = 50


MOBILE_LIBRARY_MAX_LIMIT = 100


def encode_mobile_cursor(sort: str, sort_at: str, asset_id: str) -> str:
    payload = json.dumps([sort, sort_at, asset_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()


def decode_mobile_cursor(cursor: str, expected_sort: str) -> tuple[str, str]:
    """The shipped three-slot ``[sort, sort_at, asset_id]`` cursor of the Revisit listings.

    These reads have no filters and no scope slot of their own, so the legacy shape still is
    their whole cursor; ``asset_filters.decode_cursor`` is not used here.
    """
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if (
        not isinstance(payload, list)
        or len(payload) != 3
        or not all(isinstance(value, str) and value for value in payload)
        or payload[0] != expected_sort
    ):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    return payload[1], payload[2]


def list_mobile_classifications(
    authorization: str | None = Header(default=None),
):
    api.require_auth(authorization)
    with api.get_db() as db:
        # One read transaction, because the structural tree, the assignments its counts
        # describe and the display order must all come from one state: a command committing
        # between two separate reads would ship a tree from one instant with counts from
        # another. `BEGIN` (deferred) takes the read snapshot at the first read below.
        db.execute("BEGIN")
        try:
            snapshot = db.execute(
                "SELECT payload FROM classification_snapshots WHERE singleton = 1").fetchone()
            active = authority.active_domain(db, classification_authority.DOMAIN)
            if active is not None:
                # After cutover the authority command lane is the only writer of structure,
                # so the tree itself must come from canonical state. The frozen publication
                # still supplies display position — the user's existing order — and nothing
                # else: its name/parent/kind/appearance/existence are pre-activation values
                # that accepted commands have already superseded. The sidecar is read from
                # this route's own historical display list, so its pre-cutover order holds.
                payload = json.loads(snapshot["payload"]) if snapshot is not None else {}
                return {
                    "items": classification_authority.compatibility_tree(
                        db, active,
                        classification_snapshot.display_order(payload.get("entries", []))),
                    "published_at": payload.get("published_at"),
                }

            # Before cutover preserve the shipped snapshot projection exactly: the published
            # entries supply the tree and the replicated relations supply the counts.
            if snapshot is None:
                raise HTTPException(status_code=404,
                                    detail="No classification snapshot published yet")
            counts = {
                row["classification_id"]: row["asset_count"]
                for row in db.execute(
                    """
                    SELECT relationship.classification_id, COUNT(*) AS asset_count
                    FROM asset_classifications AS relationship
                    JOIN visible_assets AS asset ON asset.id = relationship.asset_id
                    WHERE asset.committed = 1
                    GROUP BY relationship.classification_id
                    """
                ).fetchall()
            }
        finally:
            db.rollback()

    payload = json.loads(snapshot["payload"])
    items = []
    for sort_index, entry in enumerate(payload.get("entries", [])):
        classification_id = entry.get("id")
        if not isinstance(classification_id, str) or not classification_id:
            continue
        items.append(
            {
                "id": classification_id,
                "kind": entry.get("kind"),
                "name": entry.get("name"),
                "parent_id": entry.get("parentId"),
                "icon_key": entry.get("iconKey"),
                "color_key": entry.get("colorKey"),
                "sort_index": sort_index,
                "asset_count": counts.get(classification_id, 0),
            }
        )
    return {"items": items, "published_at": payload.get("published_at")}


def mobile_tree_membership(classification_id: str, asset_id: str, authorization: str | None = Header(default=None)):
    """Authorization evidence must use current membership and ancestry in one snapshot."""
    api.require_auth(authorization)
    with api.get_db() as db:
        db.execute("BEGIN")
        active = authority.active_domain(db, classification_authority.DOMAIN)
        if active is not None:
            # SAF tree grants are a security decision, so after cutover both the target
            # hierarchy and the Asset's one canonical assignment come from authority.
            if db.execute("SELECT 1 FROM visible_assets WHERE id=? AND committed=1",
                          [asset_id]).fetchone() is None:
                return {"is_child": False}
            target = classification_authority.classification_row(
                db, active["libraryId"], classification_id)
            if target is None or target["deleted"]:
                return {"is_child": False}
            assignment = classification_authority.assignment_row(
                db, active["libraryId"], asset_id)
            current = assignment["classification_id"] if assignment is not None else None
            seen = set()
            while current is not None and current not in seen:
                if current == classification_id:
                    return {"is_child": True}
                seen.add(current)
                row = classification_authority.classification_row(
                    db, active["libraryId"], current)
                if row is None or row["deleted"]:
                    break
                current = row["parent_id"]
            return {"is_child": False}

        # Before cutover preserve the shipped snapshot + replicated-membership behavior.
        snapshot = db.execute("SELECT payload FROM classification_snapshots WHERE singleton=1").fetchone()
        if snapshot is None:
            return {"is_child": False}
        entries = classification_snapshot.legacy_entries(snapshot["payload"])
        parents = {entry["id"]: entry.get("parentId") for entry in entries
                   if isinstance(entry, dict) and isinstance(entry.get("id"), str)}
        if classification_id not in parents:
            return {"is_child": False}
        memberships = db.execute("SELECT ac.classification_id FROM asset_classifications ac JOIN visible_assets a ON a.id=ac.asset_id WHERE a.id=? AND a.committed=1", (asset_id,)).fetchall()
        for membership in memberships:
            current = membership["classification_id"]
            seen = set()
            while current in parents and current not in seen:
                if current == classification_id:
                    return {"is_child": True}
                seen.add(current)
                current = parents[current]
    return {"is_child": False}


def _authority_memberships(db, active, rows):
    """Canonical ``classification_ids`` for a page of Assets, or None while inactive.

    After Classification cutover ``asset_classifications`` is frozen at its pre-activation
    contents, so every compatibility read that ships or filters on membership must ask the
    authority instead. ``active`` is the caller's own authority read, so the page it selected
    and the memberships it projects describe one state. ``None`` means "no active
    authority" and the caller keeps the shipped legacy behavior unchanged.
    """
    if active is None:
        return None
    memberships = classification_authority.assignment_projection_many(
        db, active["libraryId"], {row["id"] for row in rows})
    return {row["id"]: memberships.get(row["id"], []) for row in rows}


def _classified_asset_sql(active):
    if active is not None:
        return ("""EXISTS (SELECT 1 FROM classification_authority_assignments AS assignment
            WHERE assignment.library_id = ? AND assignment.asset_id = asset.id
              AND assignment.classification_id IS NOT NULL)""", [active["libraryId"]])
    return ("""EXISTS (SELECT 1 FROM asset_classifications AS relationship
        WHERE relationship.asset_id = asset.id)""", [])


def list_mobile_classification_assets(
    classification_id: list[str] | None = Query(default=None),
    unclassified: int = Query(default=0, ge=0, le=1),
    tag: list[str] | None = Query(default=None),
    artist: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    toc: int = Query(default=0, ge=0, le=1),
    # Read raw text so pages can ignore even an invalid TOC-only offset.
    utc_offset_minutes: str = Query(default="0", alias="utcOffsetMinutes"),
    if_none_match: str | None = Header(default=None),
    sort: Literal["newest", "oldest"] = "newest",
    limit: int = Query(
        default=MOBILE_LIBRARY_DEFAULT_LIMIT,
        ge=1,
        le=MOBILE_LIBRARY_MAX_LIMIT,
    ),
    media_kind: asset_filters.MediaKind | None = Query(default=None, pattern="^(images|videos)$"),
    aspect_ratio: asset_filters.AspectRatio | None = Query(default=None, pattern="^(square|landscape|portrait)$"),
    # Bounded to the non-negative i64 range SQLite stores. `strict` is deliberately absent:
    # query parameters always arrive as text, so `0` must parse; the integer type plus the
    # bound still refuse a float, a negative value and anything outside the column's range.
    duration_ms_min: int | None = Query(default=None, ge=0, le=asset_filters.BOUND_MAX),
    duration_ms_max: int | None = Query(default=None, ge=0, le=asset_filters.BOUND_MAX),
):
    """The ordinary library gallery, with the shared media filters applied in SQL.

    Filters are evaluated by the database, before the page is cut, so `limit` counts
    matching Assets rather than post-filter survivors of an arbitrary page. The technical
    fields a user filters on — `width`, `height`, `duration_ms` — are read live from the
    canonical Asset row, and pages advertise `filterVersion` even when nothing is filtered
    so a client can tell "this server applied no filter" from "this server ignores filters".
    `toc=1` returns the full month index at `utcOffsetMinutes` (default UTC) for that
    same listing instead of a page; it accepts no cursor and is independent of the
    page limit. Pages ignore `utcOffsetMinutes`.
    """
    api.require_auth(authorization)
    if toc and cursor is not None:
        raise HTTPException(status_code=400, detail="toc and cursor are mutually exclusive")
    applied_offset = 0
    if toc:
        try:
            applied_offset = asset_list_query.parse_utc_offset_minutes(utc_offset_minutes)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    filters = asset_filters.parse(media_kind, aspect_ratio, duration_ms_min, duration_ms_max, tag, artist)
    classifications = asset_filters.identifiers(classification_id, 8, 200)
    # Preserve the shipped cursor scope for absent/single classification requests.
    classification_id = classifications[0] if len(classifications) == 1 else list(classifications) if classifications else None
    scope_identity = {"classification_id": classification_id, "unclassified": 1} if unclassified else classification_id
    classification_clause = ""
    after = None
    if cursor is not None:
        # The cursor carries the filter identity. A cursor minted under different filters must
        # not be resumed here: it would silently walk a listing the client did not ask for.
        # The sort name is bound separately below, so changing the order is refused rather
        # than answered with a mismatched page, and an unfiltered request still accepts a
        # pre-filter `[sort, sort_at, asset_id]` cursor for the same reason.
        parsed = asset_filters.decode_cursor(cursor, "library-assets", filters,
                                             400, "Invalid cursor")
        if len(parsed) == 3:
            if unclassified or len(classifications) > 1:
                raise HTTPException(status_code=400, detail="Invalid cursor")
            # Pre-filter layout. It has no scope slots — the classification is the parameter
            # the request arrived with — so the sort slot is all there is to bind.
            if parsed[0] != sort:
                raise HTTPException(status_code=400, detail="Invalid cursor")
            cursor_sort_at, cursor_asset_id = asset_filters.require_strings(
                parsed[1:], 400, "Invalid cursor")
        elif len(parsed) == 4:
            # New cursors bind the classification as well as the sort and filters.
            if parsed[0] != sort or parsed[1] != scope_identity:
                raise HTTPException(status_code=400, detail="Invalid cursor")
            cursor_sort_at, cursor_asset_id = asset_filters.require_strings(
                parsed[2:], 400, "Invalid cursor")
        else:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        after = (cursor_sort_at, cursor_asset_id)

    # The scope bindings precede the shared technical filter bindings.
    filter_clause, filter_params = asset_filters.filter_clause(filters)

    with api.get_db() as db:
        # One read snapshot for the generation, the filter authority and the rows, so the
        # page's `listGeneration` names exactly the state its rows were read from.
        db.execute("BEGIN")
        generation = api.list_generation(db)
        # One authority read for both the filter and the projection, so a page cannot be
        # selected from one state and projected from another.
        active = authority.active_domain(db, classification_authority.DOMAIN)
        # Collect bindings in clause order rather than inserting at fixed indices,
        # so adding a scope predicate cannot shift a filter's bindings.
        clause_params: list[object] = []
        # Asset lifecycle (ADR-0038) is enforced by the shared `visible_assets`
        # projection, which this query reads, so there is deliberately no second
        # lifecycle predicate here: one rule means a trashed Asset cannot be hidden on
        # one route and visible on another. The projection fails closed, so an Asset
        # whose canonical row is missing is hidden rather than exposed.
        for classification in classifications:
            # Written as a membership test over the classification's own index rather
            # than a correlated EXISTS: the planner turned the latter into a walk of the
            # whole library in sort order with one probe per Asset (about 30 ms for
            # 9,200 Assets), while this form reads the classification's Asset ids from
            # the covering index and sorts only those (about 1-2 ms at any size).
            if active is not None:
                # Single-valued by contract, so this is an exact equality against the
                # authority's canonical assignment rather than a legacy relation test.
                classification_clause += """
                    AND asset.id IN (
                        SELECT assignment.asset_id
                        FROM classification_authority_assignments AS assignment
                        WHERE assignment.library_id = ?
                          AND assignment.classification_id = ?
                    )
                """
                clause_params.append(active["libraryId"])
                clause_params.append(classification)
            else:
                classification_clause += """
                    AND asset.id IN (
                        SELECT relationship.asset_id
                        FROM asset_classifications AS relationship
                        WHERE relationship.classification_id = ?
                    )
                """
                clause_params.append(classification)
        if unclassified:
            classified_sql, classified_params = api._classified_asset_sql(active)
            classification_clause += f" AND NOT {classified_sql}"
            clause_params.extend(classified_params)
        query = asset_list_query.AssetListQuery(
            "visible_assets AS asset",
            f"asset.committed = 1 {classification_clause} {filter_clause}",
            clause_params + filter_params, sort, prefer_id_lookup=filters.artist is not None)
        if toc:
            payload = query.toc(db, generation, lambda previous: asset_filters.encode_cursor(
                "library-assets", filters, [sort, scope_identity, *previous]), applied_offset)
            return asset_filters.search_response(payload, filters, if_none_match, scope_identity if unclassified else list(classifications))
        rows = query.page(db, limit + 1, after)
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        memberships = {row["id"]: [] for row in page_rows}
        if page_rows:
            canonical = api._authority_memberships(db, active, page_rows)
            if canonical is not None:
                memberships = canonical
            else:
                placeholders = ",".join("?" for _ in page_rows)
                for relation in db.execute(
                    f"""
                    SELECT asset_id, classification_id
                    FROM asset_classifications
                    WHERE asset_id IN ({placeholders})
                    ORDER BY asset_id, classification_id
                    """,
                    [row["id"] for row in page_rows],
                ).fetchall():
                    memberships[relation["asset_id"]].append(relation["classification_id"])

    items = [
        {
            "id": row["id"],
            "kind": row["kind"],
            "content_type": row["content_type"],
            "size_bytes": row["size_bytes"],
            "width": api._optional_dimension(row, "width"),
            "height": api._optional_dimension(row, "height"),
            "duration_ms": api._optional_duration_ms(row),
            "collected_at": row["collected_at"],
            "committed_at": row["committed_at"],
            "source_published_at": row["source_published_at"],
            "source_url": row["source_url"],
            "creator_name": row["creator_name"],
            "creator_handle": row["creator_handle"],
            "import_source": row["import_source"],
            "classification_ids": memberships[row["id"]],
            "original_available": bool(row["object_key"]),
            "thumbnail_available": bool(row["thumbnail_key"]),
            "committed": True,
        }
        for row in page_rows
    ]
    next_cursor = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = asset_filters.encode_cursor(
            "library-assets", filters,
            [sort, scope_identity, last["mobile_sort_at"], last["id"]])
    # `listGeneration` is additive: a client binds the page to it in one round trip instead
    # of bracketing the fetch with two `/v1/library/list-generation` reads.
    return conditional.json_response(
        {"items": items, "next_cursor": next_cursor, "has_more": has_more,
         "filterVersion": asset_filters.FILTER_VERSION, "searchVersion": 1, "listGeneration": generation,
         "searchFilters": {"tag": list(filters.tags), "artist": filters.artist, "classification_id": list(classifications),
                           **({"unclassified": 1} if unclassified else {})}},
        if_none_match)


def _summary_now() -> datetime:
    """The clock the library summary reads; a seam so tests can pin "today"."""
    return datetime.now(timezone.utc)


def _summary_bound(instant: datetime) -> str:
    # Bare `YYYY-MM-DDTHH:MM:SS` in UTC. Stored sort timestamps are UTC ISO text in
    # several spellings (`...Z`, `....000Z`, `...+00:00`); every one of them at or after
    # the bound shares or exceeds this prefix, so a plain text comparison — the same one
    # the list's keyset cursor uses — includes an Asset collected exactly at midnight.
    return instant.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def mobile_library_summary(
    authorization: str | None = Header(default=None),
    if_none_match: str | None = Header(default=None),
    # Minutes EAST of UTC (KST = 540). This is the negation of JavaScript's
    # `Date.getTimezoneOffset()`. The day and the Monday-start week are cut at the
    # client's local midnight in this fixed offset.
    tz_offset_minutes: int = Query(default=0, alias="tzOffsetMinutes", ge=-840, le=840),
):
    """Asset and Collection counts for the tablet Home's library card.

    Asset counts read `visible_assets` with `committed = 1`, exactly the rows
    `/v1/library/assets` can list. `images` includes the stored image and animated-GIF kinds;
    `videos` includes the video kind. Dates use that list's sort key
    `COALESCE(collected_at, created_at)`. `unclassified` is a visible Asset with no
    Classification: after the classification authority is active, no assignment row with a
    non-null Classification; before it, no legacy `asset_classifications` row. Collection
    counts read the four published `mobile_collections` types in the same transaction.
    """
    # Client role (shared token, a client token or the publisher), like the media tickets.
    api.client_guard(api.get_db, api.API_TOKEN)(authorization)
    offset = timedelta(minutes=tz_offset_minutes)
    local_now = api._summary_now().astimezone(timezone(offset))
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = api._summary_bound(local_midnight)
    week_start = api._summary_bound(local_midnight - timedelta(days=local_midnight.weekday()))
    with api.get_db() as db:
        db.execute("BEGIN")
        generation = api.list_generation(db)
        active = authority.active_domain(db, classification_authority.DOMAIN)
        classified_sql, classified_params = api._classified_asset_sql(active)
        # One pass over the visible library: the dated counts read the indexed sort key and
        # the classification probe is a primary-key seek per Asset.
        row = db.execute(
            f"""
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(asset.kind IN ('image', 'gif', 'animated_gif')), 0) AS images,
                   COALESCE(SUM(asset.kind = 'video'), 0) AS videos,
                   COALESCE(SUM(COALESCE(asset.collected_at, asset.created_at) >= ?), 0) AS added_today,
                   COALESCE(SUM(COALESCE(asset.collected_at, asset.created_at) >= ?), 0) AS added_week,
                   COALESCE(SUM(NOT {classified_sql}), 0) AS unclassified
            FROM visible_assets AS asset
            WHERE asset.committed = 1
            """,
            [today_start, week_start, *classified_params],
        ).fetchone()
        collections = {kind: 0 for kind in ("game", "manga", "movie", "av")}
        for collection_row in db.execute(
                "SELECT type, COUNT(*) AS total FROM mobile_collections "
                "WHERE type IN ('game','manga','movie','av') GROUP BY type"):
            collections[collection_row["type"]] = collection_row["total"]
    payload = {
        "total": row["total"],
        "images": row["images"],
        "videos": row["videos"],
        "collections": collections,
        "addedToday": row["added_today"],
        "addedThisWeek": row["added_week"],
        "unclassified": row["unclassified"],
        "todayStart": today_start + "Z",
        "weekStart": week_start + "Z",
        "tzOffsetMinutes": tz_offset_minutes,
        "listGeneration": generation,
    }
    return conditional.json_response(payload, if_none_match)


def _optional_dimension(row, column: str) -> int | None:
    """Read an optional dimension. Unknown is ``None``, never a fabricated ``0``."""
    try:
        value = row[column]
    except (IndexError, KeyError):
        return None
    return value if isinstance(value, int) and value > 0 else None


def _optional_duration_ms(row, column: str = "duration_ms") -> int | None:
    """Like ``_optional_dimension``, but zero is a legal duration and is kept."""
    try:
        value = row[column]
    except (IndexError, KeyError):
        return None
    return value if isinstance(value, int) and value >= 0 else None


def mobile_asset_item(row, classification_ids: list[str] | None = None) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
        "width": api._optional_dimension(row, "width"),
        "height": api._optional_dimension(row, "height"),
        "duration_ms": api._optional_duration_ms(row),
        "collected_at": row["collected_at"],
        "committed_at": row["committed_at"],
        "source_published_at": row["source_published_at"],
        "source_url": row["source_url"],
        "creator_name": row["creator_name"],
        "creator_handle": row["creator_handle"],
        "import_source": row["import_source"],
        "classification_ids": list(classification_ids or []),
        "original_available": bool(row["object_key"]),
        "thumbnail_available": bool(row["thumbnail_key"]),
        "thumbnail_revision": api.thumbnail_revision(row),
        "committed": True,
    }


def _mobile_memberships(db: sqlite3.Connection, rows) -> dict[str, list[str]]:
    """Compatibility ``classification_ids`` for a set of Assets, keyed by Asset id.

    Shared by every remaining projection that ships the field, including the Character
    publication's frozen Asset payloads. After Classification cutover the authority command
    lane is the only writer, so this must read canonical assignment state: a membership
    frozen from the legacy table would keep an Asset attached to a Classification it was
    moved away from, and Character publication persists those values.
    """
    canonical = api._authority_memberships(db, authority.active_domain(
        db, classification_authority.DOMAIN), rows)
    if canonical is not None:
        return canonical
    memberships: dict[str, list[str]] = {row["id"]: [] for row in rows}
    if not rows:
        return memberships
    placeholders = ",".join("?" for _ in rows)
    for relation in db.execute(
        f"""
        SELECT asset_id, classification_id
        FROM asset_classifications
        WHERE asset_id IN ({placeholders})
        ORDER BY asset_id, classification_id
        """,
        [row["id"] for row in rows],
    ).fetchall():
        memberships[relation["asset_id"]].append(relation["classification_id"])
    return memberships


def list_mobile_library_trash(
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    limit: int = Query(default=asset_authority.DEFAULT_TRASH_PAGE, ge=1,
                       le=asset_authority.MAX_TRASH_PAGE),
):
    """Mobile Library Trash: committed `trash` Assets, newest trash first.

    Items use the mobile asset projection plus `entityRevision` (the lifecycle
    compare-and-set revision a restore command must present) and `trashedAt`. The
    envelope carries the lifecycle authority identity a command needs. Tombstoned Assets
    are never listed. While the lifecycle domain is inactive there is no server-side
    trash, so the list is empty and `active` is false.
    """
    api.require_client(authorization)
    with api.get_db() as db:
        db.execute("BEGIN")
        try:
            active = authority.active_domain(db, asset_authority.DOMAIN)
            if active is None:
                return {"active": False, "items": [], "next_cursor": None, "has_more": False,
                        "total_count": 0, "total_bytes": 0}
            position = api.decode_mobile_cursor(cursor, "trash-lifecycle-v2") if cursor is not None else None
            rows, has_more, total_count, total_bytes = asset_authority.trash_page(
                db, active["libraryId"], position, limit)
            memberships = api._mobile_memberships(db, rows)
        finally:
            db.rollback()
    items = []
    for row in rows:
        item = api.mobile_asset_item(row, memberships.get(row["id"], []))
        item["lifecycle"] = asset_authority.TRASH
        item["entityRevision"] = row["lifecycle_revision"]
        item["trashedAt"] = row["trashed_at"]
        items.append(item)
    next_cursor = None
    if has_more and rows:
        next_cursor = api.encode_mobile_cursor("trash-lifecycle-v2", rows[-1]["trashed_at"], rows[-1]["id"])
    return {"active": True, "libraryId": active["libraryId"], "epoch": active["epoch"],
            "contractVersion": active["contractVersion"], "cursor": active["cursor"],
            "items": items, "next_cursor": next_cursor, "has_more": has_more,
            "total_count": total_count, "total_bytes": total_bytes}


def register(app, services):
    global api
    api = services
    app.get("/v1/library/classifications")(list_mobile_classifications)
    app.get("/v1/library/classifications/{classification_id}/contains/{asset_id}")(mobile_tree_membership)
    app.get("/v1/library/assets")(list_mobile_classification_assets)
    app.get("/v1/library/summary")(mobile_library_summary)


def register_trash(app, services):
    global api
    api = services
    app.get("/v1/library/trash")(list_mobile_library_trash)
