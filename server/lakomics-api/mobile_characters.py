"""Versioned PC character read projection. No character mutation authority."""
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import asset_filters

PREFIX = "/v1/library/characters"
MAX_BYTES = 24 * 1024 * 1024
MAX_MEMBERS = 1_000_000
# Android's authenticated JSON transport has a 4 MiB response budget.
MAX_INDEX_BYTES = 3 * 1024 * 1024
ID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
NodeID = Annotated[str, StringConstraints(pattern=r"^(series|group|character|folder):[A-Za-z0-9_-]{1,128}$")]
Revision = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
Filter = Literal["all", "unclassified", "needs_review"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Node(Strict):
    id: NodeID
    kind: Literal["series", "group", "character", "folder"]
    sourceId: ID
    seriesId: ID
    parentId: NodeID | None
    name: str = Field(min_length=1, max_length=2000)
    description: str = Field(default="", max_length=10000)
    thumbnailAssetId: ID | None = None
    heroAssetId: ID | None = None
    manualOnly: bool = False
    excluded: bool = False


class Scope(Strict):
    nodeId: NodeID
    filter: Filter
    assetIds: list[ID] = Field(max_length=250_000)


class Replica(Strict):
    version: Literal[1]
    baseRevision: Revision | None
    navigationOrder: list[str] = Field(default_factory=list, max_length=20000)
    nodes: list[Node] = Field(max_length=10_000)
    scopes: list[Scope] = Field(max_length=30_000)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def invalid():
    raise HTTPException(422, "Invalid character snapshot")


def validate(snapshot):
    nodes = {n.id: n for n in snapshot.nodes}
    if len(nodes) != len(snapshot.nodes):
        invalid()
    for n in snapshot.nodes:
        if n.heroAssetId and n.kind != "series":
            invalid()
        if n.id != f"{n.kind}:{n.sourceId}":
            invalid()
        series = nodes.get("series:" + n.seriesId)
        if not series or series.kind != "series":
            invalid()
        parent = nodes.get(n.parentId)
        if n.kind == "series":
            if n.sourceId != n.seriesId or n.parentId is not None:
                invalid()
        elif not parent or parent.seriesId != n.seriesId or parent.kind not in (
            ("series", "group") if n.kind == "character" else ("series",)
        ):
            invalid()
    scopes = set()
    total = 0
    for scope in snapshot.scopes:
        n = nodes.get(scope.nodeId)
        key = (scope.nodeId, scope.filter)
        total += len(scope.assetIds)
        if not n or key in scopes or (n.kind != "series" and scope.filter != "all"):
            invalid()
        if len(set(scope.assetIds)) != len(scope.assetIds) or total > MAX_MEMBERS:
            invalid()
        scopes.add(key)
    expected = {(n.id, f) for n in snapshot.nodes for f in (
        ("all", "unclassified", "needs_review") if n.kind == "series" else ("all",)
    )}
    if scopes != expected:
        invalid()
    return nodes


def register_characters(app, get_db, require_auth, asset_item, asset_memberships):
    def startup():
        with get_db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS mobile_character_state (
                  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                  revision TEXT NOT NULL, published_at TEXT NOT NULL, index_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS mobile_character_assets (
                  id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS mobile_character_members (
                  node_id TEXT NOT NULL, filter TEXT NOT NULL, position INTEGER NOT NULL,
                  asset_id TEXT NOT NULL,
                  PRIMARY KEY(node_id,filter,position), UNIQUE(node_id,filter,asset_id));
            """)
            db.commit()

    app.on_event("startup")(startup)

    def state(db):
        return db.execute("SELECT * FROM mobile_character_state WHERE singleton=1").fetchone()

    def visible_index(db, current):
        index = json.loads(current["index_json"])
        retired = {r[0] for r in db.execute("SELECT a.id FROM assets a WHERE NOT EXISTS (SELECT 1 FROM visible_assets v WHERE v.id=a.id)")}
        if not retired:
            return index
        counts = {(r[0],r[1]):r[2] for r in db.execute("SELECT m.node_id,m.filter,COUNT(*) FROM mobile_character_members m JOIN assets a ON a.id=m.asset_id WHERE NOT EXISTS (SELECT 1 FROM visible_assets v WHERE v.id=a.id) GROUP BY m.node_id,m.filter")}
        for node in index["nodes"]:
            for key in ("thumbnailAssetId","heroAssetId"):
                if node.get(key) in retired:
                    node[key] = None
        for scope in index["scopes"]:
            removed = counts.get((scope["nodeId"],scope["filter"]),0)
            scope["totalCount"] = max(0,scope["totalCount"]-removed)
            scope["sourceCount"] = max(0,scope["sourceCount"]-removed)
        return index

    def publish(snapshot):
        validate(snapshot)
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = state(db)
            # Freeze availability and display metadata with memberships. Uploads
            # completed later become visible at the next explicit publication.
            ids = sorted({id for s in snapshot.scopes for id in s.assetIds} |
                         {n.thumbnailAssetId for n in snapshot.nodes if n.thumbnailAssetId} |
                         {n.heroAssetId for n in snapshot.nodes if n.heroAssetId})
            assets = {}
            for offset in range(0, len(ids), 500):
                chunk = ids[offset:offset + 500]
                rows = db.execute("SELECT * FROM visible_assets WHERE committed=1 AND id IN (" +
                                  ",".join("?" for _ in chunk) + ")", chunk).fetchall()
                memberships = asset_memberships(db, rows)
                for row in rows:
                    assets[row["id"]] = asset_item(row, memberships[row["id"]])
            nodes = []
            for node in snapshot.nodes:
                item = node.model_dump()
                if item["thumbnailAssetId"] not in assets:
                    item["thumbnailAssetId"] = None
                if item["heroAssetId"] not in assets:
                    item["heroAssetId"] = None
                nodes.append(item)
            scopes = [{"nodeId": s.nodeId, "filter": s.filter,
                       "sourceCount": len(s.assetIds),
                       "assetIds": [id for id in s.assetIds if id in assets]} for s in snapshot.scopes]
            revision = hashlib.sha256(encode({"nodes": nodes, "scopes": scopes, "assets": assets, "navigationOrder": snapshot.navigationOrder}).encode()).hexdigest()
            if previous and previous["revision"] == revision:
                return {"revision": revision, "nodes": len(nodes)}
            if snapshot.baseRevision != (previous["revision"] if previous else None):
                raise HTTPException(409, "Character publication changed; refresh before publishing")
            index = {"navigationOrder": snapshot.navigationOrder, "nodes": nodes, "scopes": [{"nodeId": s["nodeId"], "filter": s["filter"],
                     "sourceCount": s["sourceCount"], "totalCount": len(s["assetIds"])} for s in scopes]}
            index_json = encode(index)
            if len(index_json.encode()) > MAX_INDEX_BYTES:
                raise HTTPException(413, "Character index too large")
            db.execute("DELETE FROM mobile_character_members")
            db.execute("DELETE FROM mobile_character_assets")
            db.executemany("INSERT INTO mobile_character_assets VALUES(?,?)", ((id, encode(a)) for id, a in assets.items()))
            db.executemany("INSERT INTO mobile_character_members VALUES(?,?,?,?)",
                           ((s["nodeId"], s["filter"], i, id) for s in scopes for i, id in enumerate(s["assetIds"])))
            db.execute("INSERT INTO mobile_character_state VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET "
                       "revision=excluded.revision,published_at=excluded.published_at,index_json=excluded.index_json",
                       (revision, datetime.now(timezone.utc).isoformat(), index_json))
            db.commit()
            return {"revision": revision, "nodes": len(nodes)}

    @app.put(PREFIX + "/replica")
    async def put(request: Request, authorization: str | None = Header(default=None)):
        require_auth(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BYTES:
                raise HTTPException(413, "Character snapshot too large")
        try:
            snapshot = Replica.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            invalid()
        return await run_in_threadpool(publish, snapshot)

    @app.get(PREFIX)
    def index(authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            current = state(db)
            return {"version": 1, "authority": "pc", "authorityEpoch": 0,
                    "capabilities": {"read": True, "write": False}, "ready": current is not None,
                    "revision": current["revision"] if current else None,
                    "publishedAt": current["published_at"] if current else None,
                    **(visible_index(db, current) if current else {"nodes": [], "scopes": []})}

    @app.get(PREFIX + "/status")
    def publication_status(authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            current = state(db)
        return {"revision": current["revision"] if current else None}

    @app.get(PREFIX + "/assets")
    def browse(request: Request, node: NodeID, revision: Revision, filter: Filter = "all",
               cursor: str | None = Query(default=None, max_length=1024),
               limit: int = Query(default=40, ge=1, le=100),
               media_kind: asset_filters.MediaKind | None = Query(default=None, pattern="^(images|videos)$"),
               aspect_ratio: asset_filters.AspectRatio | None = Query(default=None, pattern="^(square|landscape|portrait)$"),
               duration_ms_min: int | None = Query(default=None, ge=0, le=asset_filters.BOUND_MAX),
               duration_ms_max: int | None = Query(default=None, ge=0, le=asset_filters.BOUND_MAX),
               authorization: str | None = Header(default=None)):
        """One Character scope's Assets, with the shared media filters applied in SQL.

        Two different things are in play, and they are deliberately not symmetric.

        **Membership and order are frozen.** The filter narrows the page; it never changes
        which Assets the scope holds or the position each holds, so `sourceCount` stays the
        publication's own number — it counts the published scope, not this response. The
        cursor position is still a position in that frozen order, which is why a filtered
        walk resumes correctly across pages.

        **`totalCount` counts what the filter matches, not what the page carries.** It is
        counted in the same transaction and under the same predicates as the page, so a
        first page and the walk it starts advertise one number. It is a response-derived
        value, never authority state: nothing here stores it, publishes it, or lets it reach
        the frozen projection. Counts reflect current visibility within published membership.

        **Technical metadata is live too.** `width`, `height` and `duration_ms` are read
        from the canonical visible Asset in the same statement that selects the page, so a
        dimension repaired on the server is usable while the PC is off — including by an
        aspect or duration filter — and a stale stored value is never preferred over the
        live one. An Asset the current visibility path hides is absent from that join and
        so drops out of the page without touching the frozen membership.
        """
        require_auth(authorization)
        # The shipped read declared its parameters explicitly, so an unknown one was ignored
        # rather than refused. Now that this route carries a filter identity inside its
        # cursor, a silently ignored parameter would let a client believe a page was
        # filtered when it was not, so the parameter set is closed explicitly.
        if request.query_params.keys() - {"node", "revision", "filter", "cursor", "limit",
                                           "media_kind", "aspect_ratio",
                                           "duration_ms_min", "duration_ms_max"}:
            raise HTTPException(422, "Invalid character scope request")
        filters = asset_filters.parse(media_kind, aspect_ratio, duration_ms_min, duration_ms_max)
        filter_clause, filter_params = asset_filters.filter_clause(filters)
        position = -1
        if cursor is not None:
            # The scope identity is the cursor's first three slots, so a cursor from another
            # revision, node or filter is rejected before any page is read.
            parsed = asset_filters.decode_cursor(cursor, "character-assets", filters, 400,
                                                 "Invalid character cursor",
                                                 lead=[revision, node, filter])
            if len(parsed) != 4 or parsed[:3] != [revision, node, filter]:
                raise HTTPException(400, "Invalid character cursor")
            position = parsed[3]
            if type(position) is not int or not 0 <= position <= asset_filters.BOUND_MAX:
                raise HTTPException(400, "Invalid character cursor")
        with get_db() as db:
            db.execute("BEGIN")
            current = state(db)
            if not current or current["revision"] != revision:
                raise HTTPException(409, "Character snapshot changed; refresh")
            index = visible_index(db, current)
            scope = next((s for s in index["scopes"] if s["nodeId"] == node and s["filter"] == filter), None)
            if scope is None:
                raise HTTPException(404, "Character scope not found")
            # One statement selects the page, hides deleted Assets and reads the live
            # technical fields, so a page cannot show a dimension from one instant while
            # hiding from another, and metadata repair is visible to the filter itself.
            rows = db.execute(f"""SELECT m.position, a.payload,
                                        asset.width, asset.height, asset.duration_ms
                                  FROM mobile_character_members AS m
                                  JOIN mobile_character_assets AS a ON a.id = m.asset_id
                                  JOIN visible_assets AS asset ON asset.id = m.asset_id
                                  WHERE m.node_id = ? AND m.filter = ? AND m.position > ?
                                  {filter_clause}
                                  ORDER BY m.position LIMIT ?""",
                              [node, filter, position] + filter_params + [limit + 1]).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            # Counted under the page's own predicates, in the same read transaction, so an
            # appended page cannot advertise a different total than the page before it.
            # `position > ?` is deliberately left out: the total describes the scope, not
            # the rest of the walk a cursor happens to have reached.
            total = db.execute(f"""SELECT COUNT(*)
                                   FROM mobile_character_members AS m
                                   JOIN visible_assets AS asset ON asset.id = m.asset_id
                                   WHERE m.node_id = ? AND m.filter = ?
                                   {filter_clause}""",
                               [node, filter] + filter_params).fetchone()[0]
            next_cursor = asset_filters.encode_cursor(
                "character-assets", filters,
                [revision, node, filter, rows[-1]["position"]]) if more else None
            items = []
            for row in rows:
                item = json.loads(row["payload"])
                item.update(asset_filters.technical_fields(row))
                items.append(item)
            return {"revision": revision, "filterVersion": asset_filters.FILTER_VERSION,
                    "items": items, "totalCount": total,
                    "sourceCount": scope["sourceCount"], "has_more": more,
                    "next_cursor": next_cursor}

    return startup
