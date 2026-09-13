"""Versioned PC character read projection. No character mutation authority."""
import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

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
                rows = db.execute("SELECT * FROM assets WHERE committed=1 AND id IN (" +
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
                    **(json.loads(current["index_json"]) if current else {"nodes": [], "scopes": []})}

    @app.get(PREFIX + "/status")
    def publication_status(authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            current = state(db)
        return {"revision": current["revision"] if current else None}

    @app.get(PREFIX + "/assets")
    def browse(node: NodeID, revision: Revision, filter: Filter = "all",
               cursor: str | None = Query(default=None, max_length=1024),
               limit: int = Query(default=40, ge=1, le=100),
               authorization: str | None = Header(default=None)):
        require_auth(authorization)
        position = -1
        if cursor is not None:
            try:
                parsed = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                if not isinstance(parsed, list) or len(parsed) != 4 or parsed[:3] != [revision, node, filter]:
                    raise ValueError()
                position = parsed[3]
                if type(position) is not int or position < 0 or position >= 250_000:
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                raise HTTPException(400, "Invalid character cursor")
        with get_db() as db:
            db.execute("BEGIN")
            current = state(db)
            if not current or current["revision"] != revision:
                raise HTTPException(409, "Character snapshot changed; refresh")
            index = json.loads(current["index_json"])
            scope = next((s for s in index["scopes"] if s["nodeId"] == node and s["filter"] == filter), None)
            if scope is None:
                raise HTTPException(404, "Character scope not found")
            rows = db.execute("SELECT m.position,a.payload FROM mobile_character_members m "
                              "JOIN mobile_character_assets a ON a.id=m.asset_id WHERE m.node_id=? AND m.filter=? "
                              "AND m.position>? ORDER BY m.position LIMIT ?", (node, filter, position, limit + 1)).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            next_cursor = base64.urlsafe_b64encode(encode([revision, node, filter, rows[-1]["position"]]).encode()).decode().rstrip("=") if more else None
            return {"revision": revision, "items": [json.loads(r["payload"]) for r in rows],
                    "totalCount": scope["totalCount"], "sourceCount": scope["sourceCount"],
                    "has_more": more, "next_cursor": next_cursor}

    return startup
