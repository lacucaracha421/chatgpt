"""PC-owned incremental effective tag publication and ordinary Asset suggestions.

No media commits or backfills. Tag batches may arrive before their replicated Asset;
all readers join visible committed Assets, so missing/trash rows never contribute.
"""
import hashlib
from typing import Literal

from fastapi import Header, Query, Request
from pydantic import Field, ValidationError
from starlette.concurrency import run_in_threadpool

import conditional
import asset_visibility
import home_publications as common
from home_publications import Strict, fail, text
from library_artists import AssetId

PREFIX = "/v1/library/auto-tags"
MAX_BODY_BYTES = 1024 * 1024
MAX_ASSETS = 100
MAX_VOCABULARY = 500
MAX_TAGS_PER_ASSET = 1000
DDL = """
CREATE TABLE IF NOT EXISTS library_tag_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO library_tag_state VALUES(1,0);
CREATE TABLE IF NOT EXISTS library_tag_vocabulary(
 tag_id TEXT PRIMARY KEY, label TEXT NOT NULL, category TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_tag_assets(
 asset_id TEXT PRIMARY KEY, digest TEXT NOT NULL, creator_key TEXT);
CREATE TABLE IF NOT EXISTS library_asset_tags(
 asset_id TEXT NOT NULL, tag_id TEXT NOT NULL,
 PRIMARY KEY(asset_id,tag_id));
CREATE INDEX IF NOT EXISTS library_asset_tags_by_tag ON library_asset_tags(tag_id,asset_id);
CREATE INDEX IF NOT EXISTS library_tag_assets_by_creator ON library_tag_assets(creator_key,asset_id);
CREATE TABLE IF NOT EXISTS library_tag_counts(tag_id TEXT PRIMARY KEY, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS library_tag_visibility(asset_id TEXT PRIMARY KEY, visible INTEGER NOT NULL);
"""


def startup_db(db):
    db.executescript(DDL)
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "assets" not in tables:
        return  # Standalone publication tests have no media projection.
    db.execute("CREATE INDEX IF NOT EXISTS idx_assets_creator_handle ON assets(creator_handle,id)")
    # A date-order index otherwise tempts SQLite to scan every committed Asset.
    db.execute("CREATE INDEX IF NOT EXISTS idx_assets_committed_id ON assets(committed,id)")
    predicate = (asset_visibility.visibility_clause("a")
                 if {"authority_domains", "asset_authority_state"} <= tables else "1")
    visible = f"EXISTS(SELECT 1 FROM assets a WHERE a.id=library_tag_visibility.asset_id AND a.committed=1 AND {predicate})"
    db.execute("BEGIN IMMEDIATE")
    try:
        # Startup also upgrades already published tag data, under the same write lock.
        db.execute(f"INSERT INTO library_tag_visibility SELECT DISTINCT t.asset_id, "
                   f"EXISTS(SELECT 1 FROM assets a WHERE a.id=t.asset_id AND a.committed=1 AND {predicate}) "
                   "FROM library_asset_tags t WHERE 1 ON CONFLICT(asset_id) DO UPDATE SET visible=excluded.visible")
        db.execute("DELETE FROM library_tag_counts")
        db.execute("INSERT INTO library_tag_counts SELECT t.tag_id,COUNT(*) FROM library_asset_tags t "
                   "JOIN library_tag_visibility v ON v.asset_id=t.asset_id WHERE v.visible=1 GROUP BY t.tag_id")
        install_count_triggers(db, predicate, visible, tables)
        db.commit()
    except BaseException:
        db.rollback()
        raise


def install_count_triggers(db, predicate, visible, tables):
    """Update exact visible counts in the writer's transaction, including lifecycle changes."""
    def trigger(name, event, table, body, when=""):
        db.execute(f"CREATE TRIGGER IF NOT EXISTS {name} {event} ON {table} {when} BEGIN {body} END")

    def counts(delta, asset_id):
        return (f"INSERT INTO library_tag_counts SELECT tag_id,{delta} FROM library_asset_tags "
                f"WHERE asset_id={asset_id} ON CONFLICT(tag_id) DO UPDATE SET count=count+excluded.count;")

    trigger("tag_visibility_insert", "AFTER INSERT", "library_tag_visibility",
            counts("NEW.visible", "NEW.asset_id"))
    trigger("tag_visibility_update", "AFTER UPDATE OF visible", "library_tag_visibility",
            counts("NEW.visible-OLD.visible", "NEW.asset_id"), "WHEN NEW.visible != OLD.visible")
    trigger("tag_visibility_delete", "AFTER DELETE", "library_tag_visibility",
            counts("-OLD.visible", "OLD.asset_id"))
    trigger("tag_relation_prepare", "BEFORE INSERT", "library_asset_tags",
            f"INSERT OR IGNORE INTO library_tag_visibility VALUES(NEW.asset_id,"
            f"EXISTS(SELECT 1 FROM assets a WHERE a.id=NEW.asset_id AND a.committed=1 AND {predicate}));")
    for event, row, delta in (("INSERT", "NEW", "1"), ("DELETE", "OLD", "-1")):
        trigger(f"tag_relation_{event.lower()}", f"AFTER {event}", "library_asset_tags",
                f"INSERT INTO library_tag_counts SELECT {row}.tag_id,{delta} "
                f"FROM library_tag_visibility WHERE asset_id={row}.asset_id AND visible=1 "
                "ON CONFLICT(tag_id) DO UPDATE SET count=count+excluded.count;")

    def refresh(condition):
        return f"UPDATE library_tag_visibility SET visible={visible} WHERE {condition};"

    trigger("tag_asset_insert", "AFTER INSERT", "assets", refresh("asset_id=NEW.id"))
    trigger("tag_asset_update", "AFTER UPDATE OF id,committed", "assets",
            refresh("asset_id IN (OLD.id,NEW.id)"))
    trigger("tag_asset_delete", "AFTER DELETE", "assets", refresh("asset_id=OLD.id"))
    if {"authority_domains", "asset_authority_state"} <= tables:
        for event, condition in (("INSERT", "asset_id=NEW.asset_id"),
                                 ("DELETE", "asset_id=OLD.asset_id"),
                                 ("UPDATE OF asset_id,library_id,lifecycle", "asset_id IN (OLD.asset_id,NEW.asset_id)")):
            trigger("tag_canonical_" + event.split()[0].lower(), "AFTER " + event,
                    "asset_authority_state", refresh(condition))
        for event, when in (("INSERT", "NEW.domain='assets'"), ("DELETE", "OLD.domain='assets'"),
                            ("UPDATE OF library_id,domain", "OLD.domain='assets' OR NEW.domain='assets'")):
            trigger("tag_domain_" + event.split()[0].lower(), "AFTER " + event,
                    "authority_domains", refresh("1"), "WHEN " + when)


class Tag(Strict):
    id: text(200)
    label: text(500)
    category: Literal["general", "character", "copyright", "artist", "meta", "rating"]


class Asset(Strict):
    assetId: AssetId
    creatorKey: text(1024) | None = None
    tags: list[text(200)] = Field(max_length=MAX_TAGS_PER_ASSET)


class Upload(Strict):
    version: Literal[1]
    vocabulary: list[Tag] = Field(default_factory=list, max_length=MAX_VOCABULARY)
    assets: list[Asset] = Field(default_factory=list, max_length=MAX_ASSETS)


def register(app, get_db, require_client, require_publisher):
    def invalid():
        fail(422, "invalidAutoTagUpload", "Invalid effective tag publication")

    def publish(upload):
        ids = [row.assetId for row in upload.assets]
        tag_ids = [row.id for row in upload.vocabulary]
        if len(ids) != len(set(ids)) or len(tag_ids) != len(set(tag_ids)):
            invalid()
        if any(len(row.tags) != len(set(row.tags)) for row in upload.assets):
            invalid()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            known = {row[0] for row in db.execute("SELECT tag_id FROM library_tag_vocabulary")}
            known.update(tag_ids)
            if any(tag not in known for row in upload.assets for tag in row.tags):
                invalid()
            changed = False
            for row in upload.vocabulary:
                old = db.execute("SELECT label,category FROM library_tag_vocabulary WHERE tag_id=?", [row.id]).fetchone()
                if old is None or tuple(old) != (row.label, row.category):
                    db.execute("INSERT INTO library_tag_vocabulary VALUES(?,?,?) ON CONFLICT(tag_id) "
                               "DO UPDATE SET label=excluded.label,category=excluded.category", [row.id, row.label, row.category])
                    changed = True
            for row in upload.assets:
                digest = hashlib.sha256(conditional.encode([row.creatorKey, sorted(row.tags)])).hexdigest()
                old = db.execute("SELECT digest FROM library_tag_assets WHERE asset_id=?", [row.assetId]).fetchone()
                if old is not None and old[0] == digest:
                    continue
                db.execute("INSERT INTO library_tag_assets VALUES(?,?,?) ON CONFLICT(asset_id) "
                           "DO UPDATE SET digest=excluded.digest,creator_key=excluded.creator_key",
                           [row.assetId, digest, row.creatorKey])
                db.execute("DELETE FROM library_asset_tags WHERE asset_id=?", [row.assetId])
                db.executemany("INSERT INTO library_asset_tags VALUES(?,?)", [(row.assetId, tag) for tag in row.tags])
                changed = True
            if changed:
                db.execute("UPDATE library_tag_state SET revision=revision+1 WHERE singleton=1")
            revision = db.execute("SELECT revision FROM library_tag_state WHERE singleton=1").fetchone()[0]
            db.commit()
        return {"version": 1, "revision": revision, "changed": changed,
                "assets": len(ids), "vocabulary": len(tag_ids)}

    @app.put(PREFIX)
    async def put_tags(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        raw = await common.bounded_body(request, MAX_BODY_BYTES, "autoTagUploadTooLarge", "Tag batch is too large")
        try:
            upload = Upload.model_validate_json(raw)
        except (ValueError, ValidationError):
            invalid()
        return await run_in_threadpool(publish, upload)

    @app.get("/v1/library/search/suggestions")
    def suggestions(text: str = Query(default="", max_length=200),
                    limit: int = Query(default=10, ge=1, le=20),
                    authorization: str | None = Header(default=None),
                    if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        needle = normalize(text)
        with get_db() as db:
            db.execute("BEGIN")
            sql = ("SELECT v.tag_id,v.label,v.category,c.count "
                   "FROM library_tag_vocabulary v JOIN library_tag_counts c ON c.tag_id=v.tag_id "
                   "WHERE c.count>0 AND v.category NOT IN ('artist','meta','rating')")
            # Popular suggestions have one rank; return only the requested top rows.
            rows = db.execute(sql + (" ORDER BY c.count DESC,v.tag_id LIMIT ?" if not needle else ""),
                              [limit] if not needle else []).fetchall()
        ranked = []
        for row in rows:
            rank = match_rank(needle, row["tag_id"], row["label"]) if needle else 1
            if rank is not None:
                ranked.append((rank, -row["count"], row["tag_id"], {
                    "kind": "tag", "id": row["tag_id"], "label": row["label"],
                    "category": row["category"], "count": row["count"]}))
        ranked.sort(key=lambda item: item[:3])
        return conditional.json_response({"version": 1, "text": text, "limit": limit,
                                          "items": [row[3] for row in ranked[:limit]]}, if_none_match)

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()
    return startup


def normalize(value):
    return "".join(value.lower().split()).replace("_", "")


def match_rank(needle, *names):
    ranks = []
    for name in names:
        lowered = normalize(name)
        initials = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
        if needle and all(char in initials for char in needle):
            lowered = "".join(initials[(ord(char) - 0xAC00) // 588]
                              if 0xAC00 <= ord(char) <= 0xD7A3 else char for char in lowered)
        if needle in lowered:
            ranks.append(0 if lowered == needle else 1 if lowered.startswith(needle) else 2)
    return min(ranks) if ranks else None
