"""Mobile character-candidate review: a PC-published candidate feed and a mobile decision log.

The server runs no inference and owns no membership: the PC publishes the candidates it
scored, mobile devices record decisions, and the PC applies them. Everything stays
inactive until a PC adopts the feature with its first feed PUT (which carries
`decisionCursor`); before that the index advertises nothing and old APKs/PCs are
untouched. A "맞음" (accepted) decision only hides the candidate from the feed; gallery
membership changes when the PC publishes its next navigation snapshot. A pending
"아님" (rejected) decision for a current member hides that member, exactly like a
pending manual exclusion.
"""
import base64
import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import authority
import character_exclusions as exclusions

PREFIX = "/v1/library/characters/review"
MAX_CURSOR = exclusions.MAX_CURSOR
MAX_FEED_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 5_000
MAX_TARGETS = 1_000
MAX_REFERENCES = 4
MAX_SKIPPED = 1_000
SKIPPED_RETAINED = 1_000
MAX_COMMAND_BYTES = 8192
SOURCES = ("s36", "b36", "doubtful")
ID = exclusions.ID
LIBRARY = exclusions.LIBRARY
DIGEST = exclusions.DIGEST
# Opaque PC markers (policy version, fingerprint, basis, generation time). The server
# stores and returns them verbatim and never interprets them.
Token = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:+-]{1,128}$")]
Reason = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{1,64}$")]
Verdict = Annotated[str, StringConstraints(pattern=r"^[a-z_]{1,32}$")]
Source = Literal["s36", "b36", "doubtful"]
Decision = Literal["accepted", "rejected", "cleared"]

DDL = """
CREATE TABLE IF NOT EXISTS mobile_character_review_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL,
 feed_revision TEXT NOT NULL, feed_cursor INTEGER NOT NULL DEFAULT 0,
 applied_cursor INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0,
 policy_version TEXT NOT NULL, generated_at TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_character_review_targets (
 target_id TEXT PRIMARY KEY, name TEXT NOT NULL, series_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, reference_ids TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_character_review_items (
 position INTEGER PRIMARY KEY, target_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 s36 INTEGER NOT NULL, b36 INTEGER NOT NULL, doubtful INTEGER NOT NULL,
 verdict TEXT NOT NULL, knn3 REAL, basis TEXT NOT NULL, UNIQUE(target_id, asset_id));
CREATE TABLE IF NOT EXISTS mobile_character_review_decisions (
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL,
 target_id TEXT NOT NULL, asset_id TEXT NOT NULL, decision TEXT NOT NULL, origin TEXT NOT NULL,
 basis TEXT, asset_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mobile_character_review_decisions_pair
 ON mobile_character_review_decisions(target_id, asset_id, sequence);
CREATE TABLE IF NOT EXISTS mobile_character_review_skipped (
 sequence INTEGER PRIMARY KEY, reason TEXT NOT NULL);
"""

# The newest decision for a feed item's pair that the given cursor has not covered yet.
# A pending accept/reject hides the candidate; a pending `cleared` (undo) shows it again.
LATEST_PENDING = """(SELECT d.decision FROM mobile_character_review_decisions d
    WHERE d.target_id=i.target_id AND d.asset_id=i.asset_id AND d.sequence>?
    ORDER BY d.sequence DESC LIMIT 1)"""


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Target(Strict):
    name: str = Field(min_length=1, max_length=2000)
    seriesId: ID
    fingerprint: Token
    referenceAssetIds: list[ID] = Field(max_length=MAX_REFERENCES)


class Item(Strict):
    assetId: ID
    targetId: ID
    sources: list[Source] = Field(min_length=1, max_length=3)
    verdict: Verdict
    knn3: float | None = None
    basis: Token


class Skipped(Strict):
    sequence: int = Field(ge=1, le=MAX_CURSOR)
    reason: Reason


class Feed(Strict):
    version: Literal[1]
    libraryId: LIBRARY
    baseRevision: DIGEST | None
    decisionCursor: int = Field(ge=0, le=MAX_CURSOR)
    policyVersion: Token
    generatedAt: Token
    skipped: list[Skipped] = Field(max_length=MAX_SKIPPED)
    targets: dict[ID, Target]
    items: list[Item] = Field(max_length=MAX_ITEMS)


class Command(Strict):
    version: Literal[1]
    libraryId: LIBRARY
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    targetId: ID
    assetId: ID
    decision: Decision
    origin: Literal["feed", "viewer"]
    basis: Token | None


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def state(db):
    return db.execute("SELECT * FROM mobile_character_review_state WHERE singleton=1").fetchone()


def status_head(db):
    """Log head for ``/v1/sync/status`` ``publisherLogs.characterReviewDecisions``."""
    current = state(db)
    return current["last_sequence"] if current else 0


def pending_floor(current):
    """Decisions above this sequence are not yet reflected in both PC publications."""
    return min(current["applied_cursor"], current["feed_cursor"])


# --- Hooks used by the character projection and the exclusion channel -----------------

def publication_guard(db, snapshot):
    """The navigation snapshot's `reviewDecisionCursor` may advance but never rewind.

    After adoption a navigation PUT without the field is a legacy/older PC and is refused,
    because its memberships cannot say which review decisions they already reflect.
    """
    current = state(db)
    cursor = snapshot.reviewDecisionCursor
    if current is None:
        if cursor not in (None, 0):
            fail(409, "characterReviewCursorRejected", "캐릭터 검토 기록을 동기화한 뒤 다시 게시해 주세요.")
        return
    if cursor is None:
        fail(409, "characterReviewUnsupported", "캐릭터 검토를 지원하는 PC 앱이 필요합니다.")
    if current["library_id"] != snapshot.libraryId:
        fail(409, "libraryMismatch", "다른 라이브러리의 캐릭터 검토 기록입니다.")
    if not current["applied_cursor"] <= cursor <= current["last_sequence"]:
        fail(409, "characterReviewCursorRejected", "캐릭터 검토 기록을 동기화한 뒤 다시 게시해 주세요.")


def acknowledge_publication(db, snapshot):
    if snapshot.reviewDecisionCursor is not None and state(db) is not None:
        db.execute("UPDATE mobile_character_review_state SET applied_cursor=? WHERE singleton=1",
                   (snapshot.reviewDecisionCursor,))


def identity(db, snapshot):
    """Extra revision identity for a navigation snapshot that carries the review cursor."""
    if snapshot.reviewDecisionCursor is None:
        return {}
    current = state(db)
    return {"reviewDecisionCursor": snapshot.reviewDecisionCursor,
            "lastReviewSequence": current["last_sequence"] if current else 0}


def insert_hidden(db):
    """Union the review log into the hidden-member overlay (called by the exclusion rebuild).

    Only a pair whose newest decision above the navigation cursor is `rejected` is hidden;
    accepts never add a member here (the PC's publication does that).
    """
    current = state(db)
    if current is None:
        return
    db.execute("""INSERT OR IGNORE INTO mobile_character_hidden_members
        SELECT 'character:' || d.target_id,'all',d.asset_id
        FROM mobile_character_review_decisions d
        WHERE d.sequence>? AND d.decision='rejected'
        AND d.sequence=(SELECT MAX(l.sequence) FROM mobile_character_review_decisions l
                        WHERE l.target_id=d.target_id AND l.asset_id=d.asset_id)""",
               (current["applied_cursor"],))


def pending_pair(db, target_id, asset_id):
    """True while a review decision for this pair awaits the PC (the exclusion mirror check)."""
    current = state(db)
    if current is None:
        return False
    return db.execute("""SELECT 1 FROM mobile_character_review_decisions
        WHERE target_id=? AND asset_id=? AND sequence>? LIMIT 1""",
                      (target_id, asset_id, pending_floor(current))).fetchone() is not None


def advertisement(db):
    current = state(db)
    if current is None:
        return {"characterReview": False}, {}
    return {"characterReview": True}, {
        "reviewDecisionCursor": current["last_sequence"],
        "appliedReviewDecisionCursor": current["applied_cursor"],
    }


# --- Routes -------------------------------------------------------------------------

def check_library(db, library_id):
    owners = [authority.active_domain(db, domain) for domain in ("assets", "classifications")]
    ids = {owner["libraryId"] for owner in owners if owner is not None}
    if not ids:
        fail(409, "characterReviewUnsupported", "서버 라이브러리 연결을 먼저 완료해 주세요.")
    current = state(db)
    excluded = exclusions.state(db)
    if ids != {library_id} or any(row is not None and row["library_id"] != library_id
                                  for row in (current, excluded)):
        fail(409, "libraryMismatch", "다른 라이브러리의 캐릭터 검토 요청입니다.")
    return current


def published_index(db):
    row = db.execute("SELECT * FROM mobile_character_state WHERE singleton=1").fetchone()
    return (row, json.loads(row["index_json"])) if row else (None, None)


def character_nodes(index):
    return {n["sourceId"]: n for n in (index or {}).get("nodes", []) if n["kind"] == "character"}


def encode_cursor(revision, position):
    raw = json.dumps([revision, position], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor):
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        revision, position = json.loads(raw)
    except (ValueError, TypeError):
        fail(400, "invalidCharacterReviewCursor", "검토 목록 위치를 확인할 수 없습니다.")
    if not isinstance(revision, str) or type(position) is not int or position < 0:
        fail(400, "invalidCharacterReviewCursor", "검토 목록 위치를 확인할 수 없습니다.")
    return revision, position


def register(app, get_db, require_client, require_publisher, asset_item, asset_memberships):
    def hydrate(db, ids):
        ids = sorted(set(ids))
        found = {}
        for offset in range(0, len(ids), 500):
            chunk = ids[offset:offset + 500]
            rows = db.execute("SELECT * FROM visible_assets WHERE committed=1 AND id IN (" +
                              ",".join("?" for _ in chunk) + ")", chunk).fetchall()
            memberships = asset_memberships(db, rows)
            for row in rows:
                found[row["id"]] = asset_item(row, memberships[row["id"]])
        return found

    def committed(db, ids):
        ids = sorted(set(ids))
        found = set()
        for offset in range(0, len(ids), 500):
            chunk = ids[offset:offset + 500]
            found |= {r[0] for r in db.execute("SELECT id FROM visible_assets WHERE committed=1 AND id IN (" +
                                               ",".join("?" for _ in chunk) + ")", chunk)}
        return found

    def replace_feed(feed):
        if len(feed.targets) > MAX_TARGETS:
            fail(413, "characterReviewFeedTooLarge", "캐릭터 검토 대상이 너무 많습니다.")
        pairs = set()
        for item in feed.items:
            key = (item.targetId, item.assetId)
            if item.targetId not in feed.targets or key in pairs or len(set(item.sources)) != len(item.sources):
                fail(422, "invalidCharacterReviewFeed", "캐릭터 검토 목록을 확인할 수 없습니다.")
            if item.knn3 is not None and not math.isfinite(item.knn3):
                fail(422, "invalidCharacterReviewFeed", "캐릭터 검토 목록을 확인할 수 없습니다.")
            pairs.add(key)
        for target in feed.targets.values():
            if len(set(target.referenceAssetIds)) != len(target.referenceAssetIds):
                fail(422, "invalidCharacterReviewFeed", "캐릭터 검토 목록을 확인할 수 없습니다.")
        if len({s.sequence for s in feed.skipped}) != len(feed.skipped):
            fail(422, "invalidCharacterReviewFeed", "캐릭터 검토 목록을 확인할 수 없습니다.")
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = check_library(db, feed.libraryId)
            if exclusions.state(db) is None:
                # Review is only adopted over an upgraded (manual-exclusion) publication.
                fail(409, "characterReviewUnsupported", "PC에서 캐릭터 보기를 먼저 업데이트해 주세요.")
            floor = current["feed_cursor"] if current else 0
            ceiling = current["last_sequence"] if current else 0
            if not floor <= feed.decisionCursor <= ceiling or any(s.sequence > feed.decisionCursor for s in feed.skipped):
                fail(409, "characterReviewCursorRejected", "캐릭터 검토 기록을 동기화한 뒤 다시 게시해 주세요.")
            # Only committed, currently visible Assets are kept; the rest wait for the next PUT.
            visible = committed(db, [item.assetId for item in feed.items])
            kept = [item for item in feed.items if item.assetId in visible]
            content = {"libraryId": feed.libraryId, "decisionCursor": feed.decisionCursor,
                       "policyVersion": feed.policyVersion, "generatedAt": feed.generatedAt,
                       "skipped": [s.model_dump() for s in sorted(feed.skipped, key=lambda s: s.sequence)],
                       "targets": {k: v.model_dump() for k, v in feed.targets.items()},
                       "items": [i.model_dump() for i in kept]}
            revision = hashlib.sha256(encode(content).encode()).hexdigest()
            result = {"version": 1, "revision": revision, "items": len(kept),
                      "dropped": len(feed.items) - len(kept)}
            if current is not None and current["feed_revision"] == revision:
                return result
            if feed.baseRevision != (current["feed_revision"] if current else None):
                fail(409, "characterReviewFeedChanged", "캐릭터 검토 목록이 변경되었습니다. 다시 게시해 주세요.")
            now = datetime.now(timezone.utc).isoformat()
            if current is None:
                db.execute("""INSERT INTO mobile_character_review_state
                    (singleton,library_id,feed_revision,feed_cursor,applied_cursor,last_sequence,
                     policy_version,generated_at,published_at) VALUES(1,?,?,?,0,0,?,?,?)""",
                           (feed.libraryId, revision, feed.decisionCursor, feed.policyVersion,
                            feed.generatedAt, now))
                # Adoption changes the index advertisement; move the publication revision so
                # mobile clients polling `/status` pick up the capability.
                published, _ = published_index(db)
                if published is not None:
                    bumped = hashlib.sha256(f"{published['revision']}:review-adopted:{revision}".encode()).hexdigest()
                    db.execute("UPDATE mobile_character_state SET revision=? WHERE singleton=1", (bumped,))
            else:
                db.execute("""UPDATE mobile_character_review_state SET feed_revision=?,feed_cursor=?,
                    policy_version=?,generated_at=?,published_at=? WHERE singleton=1""",
                           (revision, feed.decisionCursor, feed.policyVersion, feed.generatedAt, now))
            db.execute("DELETE FROM mobile_character_review_targets")
            db.execute("DELETE FROM mobile_character_review_items")
            db.executemany("INSERT INTO mobile_character_review_targets VALUES(?,?,?,?,?)",
                           ((k, t.name, t.seriesId, t.fingerprint, json.dumps(t.referenceAssetIds))
                            for k, t in feed.targets.items()))
            db.executemany("INSERT INTO mobile_character_review_items VALUES(?,?,?,?,?,?,?,?,?)",
                           ((position, i.targetId, i.assetId, int("s36" in i.sources), int("b36" in i.sources),
                             int("doubtful" in i.sources), i.verdict, i.knn3, i.basis)
                            for position, i in enumerate(kept)))
            db.executemany("INSERT OR REPLACE INTO mobile_character_review_skipped VALUES(?,?)",
                           ((s.sequence, s.reason) for s in feed.skipped))
            db.execute("""DELETE FROM mobile_character_review_skipped WHERE sequence NOT IN
                (SELECT sequence FROM mobile_character_review_skipped ORDER BY sequence DESC LIMIT ?)""",
                       (SKIPPED_RETAINED,))
            db.commit()
            return result

    @app.put(PREFIX + "/feed")
    async def put_feed(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_FEED_BYTES:
                raise HTTPException(413, "Character review feed too large")
        try:
            feed = Feed.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            fail(422, "invalidCharacterReviewFeed", "캐릭터 검토 목록을 확인할 수 없습니다.")
        return await run_in_threadpool(replace_feed, feed)

    def empty(extra=None):
        return {"version": 1, "ready": False, "libraryId": None, "revision": None, "generatedAt": None,
                "policyVersion": None, "decisionCursor": 0, "appliedDecisionCursor": 0,
                "counts": {"total": 0, "s36": 0, "b36": 0, "doubtful": 0, "pendingPc": 0, "skipped": 0},
                "items": [], "targets": {}, "nextCursor": None, "hasMore": False, **(extra or {})}

    def read_feed(source, target, limit, cursor):
        position = -1
        if cursor is not None:
            revision, position = decode_cursor(cursor)
        with get_db() as db:
            db.execute("BEGIN")
            current = state(db)
            if current is None:
                if cursor is not None:
                    fail(409, "characterReviewChanged", "검토 목록이 변경되었습니다. 처음부터 다시 불러옵니다.")
                return empty()
            if cursor is not None and revision != current["feed_revision"]:
                fail(409, "characterReviewChanged", "검토 목록이 변경되었습니다. 처음부터 다시 불러옵니다.")
            _, index = published_index(db)
            nodes = character_nodes(index)
            series = {n["sourceId"]: n for n in (index or {}).get("nodes", []) if n["kind"] == "series"}
            base = f"""FROM mobile_character_review_items i
                JOIN visible_assets a ON a.id=i.asset_id AND a.committed=1
                WHERE i.target_id IN (SELECT value FROM json_each(?))
                AND COALESCE({LATEST_PENDING},'cleared')='cleared'"""
            params = [json.dumps(sorted(nodes if target is None else ({target} & nodes.keys()))),
                      current["feed_cursor"]]
            counts = db.execute(f"SELECT COUNT(*),SUM(i.s36),SUM(i.b36),SUM(i.doubtful) {base}", params).fetchone()
            # `source` is a closed Literal, so naming its column is not an injection.
            where = f" AND i.{source}=1" if source is not None else ""
            total = counts[0] if source is None else counts[SOURCES.index(source) + 1] or 0
            rows = db.execute(f"SELECT i.* {base}{where} AND i.position>? ORDER BY i.position LIMIT ?",
                              params + [position, limit + 1]).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            targets = {}
            for row in rows:
                if row["target_id"] not in targets:
                    targets[row["target_id"]] = db.execute(
                        "SELECT * FROM mobile_character_review_targets WHERE target_id=?",
                        (row["target_id"],)).fetchone()
            references = {t: json.loads(r["reference_ids"]) if r else [] for t, r in targets.items()}
            assets = hydrate(db, [r["asset_id"] for r in rows] + [a for ids in references.values() for a in ids])
            pending = db.execute("SELECT COUNT(*) FROM mobile_character_review_decisions WHERE sequence>?",
                                 (pending_floor(current),)).fetchone()[0]
            skipped = db.execute("SELECT COUNT(*) FROM mobile_character_review_skipped").fetchone()[0]
            items = []
            for row in rows:
                if row["asset_id"] not in assets:
                    continue
                items.append({"targetId": row["target_id"], "assetId": row["asset_id"],
                              "sources": [s for s in SOURCES if row[s]], "verdict": row["verdict"],
                              "knn3": row["knn3"], "basis": row["basis"], "asset": assets[row["asset_id"]]})
            described = {}
            for target_id, stored in targets.items():
                node = nodes[target_id]
                series_node = series.get(node["seriesId"])
                described[target_id] = {
                    "name": node["name"], "seriesId": node["seriesId"],
                    "seriesName": series_node["name"] if series_node else None,
                    "references": [assets[a] for a in references[target_id] if a in assets],
                }
            return {"version": 1, "ready": True, "libraryId": current["library_id"],
                    "revision": current["feed_revision"], "generatedAt": current["generated_at"],
                    "policyVersion": current["policy_version"],
                    "decisionCursor": current["last_sequence"], "appliedDecisionCursor": current["feed_cursor"],
                    "counts": {"total": total, "s36": counts[1] or 0, "b36": counts[2] or 0,
                               "doubtful": counts[3] or 0, "pendingPc": pending, "skipped": skipped},
                    "items": items, "targets": described,
                    "nextCursor": encode_cursor(current["feed_revision"], rows[-1]["position"]) if more else None,
                    "hasMore": more}

    def asset_targets(asset_id):
        """Characters of the Asset's own series(es) it could be added to from the viewer."""
        with get_db() as db:
            db.execute("BEGIN")
            current = state(db)
            if current is None:
                return {"version": 1, "ready": False, "assetId": asset_id, "targets": []}
            _, index = published_index(db)
            if not hydrate(db, [asset_id]):
                return {"version": 1, "ready": True, "assetId": asset_id, "targets": []}
            in_series = {r[0].split(":", 1)[1] for r in db.execute(
                "SELECT node_id FROM mobile_character_members WHERE asset_id=? AND filter='all' AND node_id LIKE 'series:%'",
                (asset_id,))}
            members = {r[0].split(":", 1)[1] for r in db.execute(
                "SELECT node_id FROM mobile_character_members WHERE asset_id=? AND filter='all' AND node_id LIKE 'character:%'",
                (asset_id,))}
            latest = {r[0]: r[1] for r in db.execute("""SELECT d.target_id,d.decision FROM mobile_character_review_decisions d
                WHERE d.asset_id=? AND d.sequence>? AND d.sequence=(SELECT MAX(l.sequence)
                  FROM mobile_character_review_decisions l WHERE l.target_id=d.target_id AND l.asset_id=d.asset_id)""",
                                                       (asset_id, pending_floor(current)))}
            series = {n["sourceId"]: n for n in (index or {}).get("nodes", []) if n["kind"] == "series"}
            targets = []
            for node in character_nodes(index).values():
                if node["seriesId"] not in in_series or node["sourceId"] in members:
                    continue
                if asset_id in (node.get("protectedAssetIds") or []) or latest.get(node["sourceId"]) == "accepted":
                    continue
                targets.append({"targetId": node["sourceId"], "name": node["name"], "seriesId": node["seriesId"],
                                "seriesName": series.get(node["seriesId"], {}).get("name")})
            return {"version": 1, "ready": True, "assetId": asset_id, "targets": targets}

    @app.get(PREFIX)
    def review(request: Request, source: Source | None = None, target: ID | None = None,
               asset: ID | None = None, limit: int = Query(default=20, ge=1, le=50),
               cursor: str | None = Query(default=None, max_length=512),
               authorization: str | None = Header(default=None)):
        require_client(authorization)
        keys = set(request.query_params.keys())
        if keys - {"source", "target", "limit", "cursor", "asset"} or (asset is not None and keys != {"asset"}):
            raise HTTPException(422, "Invalid character review request")
        if asset is not None:
            return asset_targets(asset)
        return read_feed(source, target, limit, cursor)

    def apply(command):
        try:
            if str(UUID(command.operationId)) != command.operationId:
                raise ValueError()
        except ValueError:
            fail(422, "invalidCharacterReviewDecision", "검토 요청 식별자가 올바르지 않습니다.")
        payload_digest = hashlib.sha256(encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = check_library(db, command.libraryId)
            if current is None:
                fail(409, "characterReviewUnsupported", "PC에서 캐릭터 검토를 먼저 업데이트해 주세요.")
            # Receipt first: a response-lost retry stays valid after later publications.
            receipt = db.execute("SELECT * FROM mobile_character_review_decisions WHERE operation_id=?",
                                 (command.operationId,)).fetchone()
            if receipt is not None:
                if receipt["payload_digest"] != payload_digest:
                    fail(409, "operationConflict", "다른 내용으로 검토 요청을 재사용할 수 없습니다.")
                return json.loads(receipt["result_json"])
            published, index = published_index(db)
            node = character_nodes(index).get(command.targetId)
            if node is None or node.get("protectedAssetIds") is None:
                fail(409, "characterReviewTargetMissing", "캐릭터를 찾을 수 없습니다. 새로고침해 주세요.")
            if command.decision != "cleared" and command.assetId in node["protectedAssetIds"]:
                fail(409, "characterReferenceProtected", "참조 이미지는 PC에서 먼저 해제해 주세요.")
            asset = db.execute("SELECT sha256 FROM visible_assets WHERE id=? AND committed=1",
                               (command.assetId,)).fetchone()
            if asset is None or not isinstance(asset["sha256"], str) or len(asset["sha256"]) != 64:
                fail(409, "characterReviewAssetMissing", "검토할 자산을 찾을 수 없습니다.")
            if command.origin == "viewer" and command.decision != "cleared" and db.execute(
                    "SELECT 1 FROM mobile_character_members WHERE node_id=? AND filter='all' AND asset_id=?",
                    ("series:" + node["seriesId"], command.assetId)).fetchone() is None:
                fail(409, "characterReviewOutsideSeries", "이 자산의 시리즈에 속한 캐릭터만 추가할 수 있습니다.")
            excluded = exclusions.state(db)
            if excluded is not None and db.execute(
                    "SELECT 1 FROM mobile_character_exclusions WHERE target_id=? AND asset_id=? AND sequence>?",
                    (command.targetId, command.assetId, excluded["applied_cursor"])).fetchone():
                fail(409, "pendingCharacterCorrection", "이 자산의 캐릭터 제외가 PC 반영을 기다리고 있습니다.")
            if command.origin == "feed" and db.execute(
                    "SELECT 1 FROM mobile_character_review_items WHERE target_id=? AND asset_id=?",
                    (command.targetId, command.assetId)).fetchone() is None:
                fail(409, "characterReviewChanged", "검토 목록이 바뀌었습니다. 새로고침해 주세요.")
            sequence = current["last_sequence"] + 1
            if sequence > MAX_CURSOR:
                fail(409, "characterReviewCursorRejected", "캐릭터 검토 기록 한도에 도달했습니다.")
            revision = published["revision"]
            member = db.execute("SELECT 1 FROM mobile_character_members WHERE node_id=? AND filter='all' AND asset_id=?",
                                ("character:" + command.targetId, command.assetId)).fetchone()
            if member is not None:
                # A pending reject/undo of a current member changes what galleries show.
                revision = hashlib.sha256(f"{revision}:review:{sequence}:{payload_digest}".encode()).hexdigest()
            result = {"version": 1, "operationId": command.operationId, "libraryId": command.libraryId,
                      "targetId": command.targetId, "assetId": command.assetId,
                      "decision": command.decision, "sequence": sequence,
                      "revision": revision, "pendingPc": True}
            db.execute("INSERT INTO mobile_character_review_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (sequence, command.operationId, payload_digest, command.targetId, command.assetId,
                        command.decision, command.origin, command.basis, asset["sha256"],
                        datetime.now(timezone.utc).isoformat(), json.dumps(result)))
            db.execute("UPDATE mobile_character_review_state SET last_sequence=? WHERE singleton=1", (sequence,))
            if member is not None:
                exclusions.rebuild_hidden(db, index)
                db.execute("UPDATE mobile_character_state SET revision=? WHERE singleton=1", (revision,))
            db.commit()
            return result

    @app.post(PREFIX + "/decisions")
    async def decide(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_COMMAND_BYTES:
                raise HTTPException(413, "Character review decision too large")
        try:
            command = Command.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            fail(422, "invalidCharacterReviewDecision", "검토 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(apply, command)

    @app.get(PREFIX + "/decisions")
    def decisions(libraryId: LIBRARY, after: int = Query(default=0, ge=0, le=MAX_CURSOR),
                  limit: int = Query(default=100, ge=1, le=100),
                  authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            current = check_library(db, libraryId)
            if after > (current["last_sequence"] if current else 0):
                fail(409, "characterReviewCursorRejected", "캐릭터 검토 동기화 위치를 확인해 주세요.")
            rows = db.execute("SELECT * FROM mobile_character_review_decisions WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            return {"version": 1, "libraryId": libraryId, "after": after,
                    "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
                    "items": [{"sequence": r["sequence"], "operationId": r["operation_id"],
                               "targetId": r["target_id"], "assetId": r["asset_id"],
                               "decision": r["decision"], "origin": r["origin"], "basis": r["basis"],
                               "assetSha256": r["asset_sha256"], "createdAt": r["created_at"]} for r in rows]}
