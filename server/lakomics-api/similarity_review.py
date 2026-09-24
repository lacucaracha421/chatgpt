"""Mobile similarity review: a PC-published pair feed and a mobile decision log.

Perceptual similarity stays PC analysis (ADR-0007). The PC publishes the open historical
pairs it found, mobile devices record a decision per pair, and the PC applies each one
through its own `decide_similarity_review`. The server never trashes, merges or deletes
anything: the image that is not kept reaches Library Trash only when the PC applies the
decision and its lifecycle command propagates (ADR-0038). Until then galleries are
unchanged; only this review queue hides decided pairs.

Everything stays inactive until a PC adopts the feature with its first feed PUT (which
carries `decisionCursor`); before that the mobile read answers `ready: false` and the
decision route refuses with `similarityReviewUnsupported`.

A pending decision is the newest decision for a review above the applied cursor (the
`decisionCursor` of the latest feed PUT), unless that newest decision is `withdrawn`.
"""
import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import authority

PREFIX = "/v1/library/similarity/review"
MAX_CURSOR = 9_007_199_254_740_991
MAX_FEED_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 5_000
MAX_SKIPPED = 1_000
SKIPPED_RETAINED = 1_000
MAX_COMMAND_BYTES = 8192
MAX_CLASSIFICATIONS = 64
ID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
LIBRARY = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
DIGEST = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
# Opaque PC markers (generation time, collection time). Stored and returned verbatim.
Token = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:+-]{1,128}$")]
Reason = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{1,64}$")]
Format = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9.+-]{1,32}$")]
Label = Annotated[str, StringConstraints(min_length=1, max_length=300)]
Choice = Literal["keep_existing", "replace_existing"]
Decision = Literal["keep_existing", "replace_existing", "keep_both", "withdrawn"]

DDL = """
CREATE TABLE IF NOT EXISTS mobile_similarity_review_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL,
 feed_revision TEXT NOT NULL, feed_cursor INTEGER NOT NULL DEFAULT 0,
 last_sequence INTEGER NOT NULL DEFAULT 0, generated_at TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_similarity_review_items (
 position INTEGER PRIMARY KEY, review_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 distance INTEGER NOT NULL, recommended_asset_id TEXT, recommendation TEXT,
 a_asset_id TEXT NOT NULL, a_sha256 TEXT NOT NULL, a_json TEXT NOT NULL,
 b_asset_id TEXT NOT NULL, b_sha256 TEXT NOT NULL, b_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_similarity_review_decisions (
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL,
 review_id TEXT NOT NULL, decision TEXT NOT NULL, a_asset_id TEXT NOT NULL, b_asset_id TEXT NOT NULL,
 trash_asset_id TEXT, withdraws INTEGER, feed_revision TEXT NOT NULL, a_sha256 TEXT NOT NULL,
 b_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mobile_similarity_review_decisions_review
 ON mobile_similarity_review_decisions(review_id, sequence);
CREATE TABLE IF NOT EXISTS mobile_similarity_review_skipped (
 sequence INTEGER PRIMARY KEY, reason TEXT NOT NULL);
"""

# The newest decision per review above the applied cursor, when it is not a withdrawal.
PENDING = """SELECT d.* FROM mobile_similarity_review_decisions d
    WHERE d.sequence>? AND d.decision!='withdrawn'
    AND d.sequence=(SELECT MAX(l.sequence) FROM mobile_similarity_review_decisions l
                    WHERE l.review_id=d.review_id)"""


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Side(Strict):
    assetId: ID
    sha256: DIGEST
    width: int | None = Field(ge=1, le=1_000_000)
    height: int | None = Field(ge=1, le=1_000_000)
    byteSize: int | None = Field(ge=0, le=MAX_CURSOR)
    format: Format
    sourceLabel: Label | None
    collectedAt: Token | None
    classifications: list[Label] = Field(max_length=MAX_CLASSIFICATIONS)


class Item(Strict):
    reviewId: ID
    kind: Literal["historical"]
    distance: int = Field(ge=0, le=1024)
    recommendedAssetId: ID | None = None
    recommendation: Choice | None = None
    a: Side
    b: Side


class Skipped(Strict):
    sequence: int = Field(ge=1, le=MAX_CURSOR)
    reason: Reason


class Feed(Strict):
    version: Literal[1]
    libraryId: LIBRARY
    baseRevision: DIGEST | None
    decisionCursor: int = Field(ge=0, le=MAX_CURSOR)
    generatedAt: Token
    skipped: list[Skipped] = Field(max_length=MAX_SKIPPED)
    items: list[Item] = Field(max_length=MAX_ITEMS)


class Basis(Strict):
    feedRevision: DIGEST
    aSha256: DIGEST
    bSha256: DIGEST


class Command(Strict):
    version: Literal[1]
    libraryId: LIBRARY
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    reviewId: ID
    decision: Decision
    basis: Basis


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def state(db):
    return db.execute("SELECT * FROM mobile_similarity_review_state WHERE singleton=1").fetchone()


def trash_target(decision, a_asset_id, b_asset_id):
    """The image a decision sends to Library Trash once the PC applies it (historical pairs)."""
    return {"keep_existing": b_asset_id, "replace_existing": a_asset_id}.get(decision)


def pending_decisions(db, current=None):
    current = current if current is not None else state(db)
    if current is None:
        return []
    return db.execute(PENDING, (current["feed_cursor"],)).fetchall()


def pending_trash_assets(db):
    """Assets a pending similarity decision will trash (for the Library Trash mirror check)."""
    return {row["trash_asset_id"] for row in pending_decisions(db) if row["trash_asset_id"]}


def check_library(db, library_id):
    owners = [authority.active_domain(db, domain) for domain in ("assets", "classifications")]
    ids = {owner["libraryId"] for owner in owners if owner is not None}
    if not ids:
        fail(409, "similarityReviewUnsupported", "서버 라이브러리 연결을 먼저 완료해 주세요.")
    current = state(db)
    if ids != {library_id} or (current is not None and current["library_id"] != library_id):
        fail(409, "libraryMismatch", "다른 라이브러리의 유사 이미지 검토 요청입니다.")
    return current


def encode_cursor(revision, position):
    raw = json.dumps([revision, position], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor):
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        revision, position = json.loads(raw)
    except (ValueError, TypeError):
        fail(400, "invalidSimilarityReviewCursor", "검토 목록 위치를 확인할 수 없습니다.")
    if not isinstance(revision, str) or type(position) is not int or position < 0:
        fail(400, "invalidSimilarityReviewCursor", "검토 목록 위치를 확인할 수 없습니다.")
    return revision, position


def register(app, get_db, require_client, require_publisher, asset_item, asset_memberships):
    def current_hashes(db, ids):
        """Committed, visible (lifecycle `normal`) Assets and their current sha256."""
        ids = sorted(set(ids))
        found = {}
        for offset in range(0, len(ids), 500):
            chunk = ids[offset:offset + 500]
            found.update({r[0]: r[1] for r in db.execute(
                "SELECT id,sha256 FROM visible_assets WHERE committed=1 AND id IN (" +
                ",".join("?" for _ in chunk) + ")", chunk)})
        return found

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

    def invalid_feed():
        fail(422, "invalidSimilarityReviewFeed", "유사 이미지 검토 목록을 확인할 수 없습니다.")

    def replace_feed(feed):
        reviews = set()
        for item in feed.items:
            if item.reviewId in reviews or item.a.assetId == item.b.assetId:
                invalid_feed()
            if (item.recommendedAssetId is None) != (item.recommendation is None):
                invalid_feed()
            if item.recommendedAssetId is not None and item.recommendation != (
                    "keep_existing" if item.recommendedAssetId == item.a.assetId else
                    "replace_existing" if item.recommendedAssetId == item.b.assetId else None):
                invalid_feed()
            reviews.add(item.reviewId)
        if len({s.sequence for s in feed.skipped}) != len(feed.skipped):
            invalid_feed()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = check_library(db, feed.libraryId)
            floor = current["feed_cursor"] if current else 0
            ceiling = current["last_sequence"] if current else 0
            if not floor <= feed.decisionCursor <= ceiling or any(s.sequence > feed.decisionCursor for s in feed.skipped):
                fail(409, "similarityReviewCursorRejected", "유사 이미지 검토 기록을 동기화한 뒤 다시 게시해 주세요.")
            # Only pairs whose two Assets are committed, visible and unchanged are kept.
            hashes = current_hashes(db, [s.assetId for i in feed.items for s in (i.a, i.b)])
            kept = [i for i in feed.items
                    if hashes.get(i.a.assetId) == i.a.sha256 and hashes.get(i.b.assetId) == i.b.sha256]
            content = {"libraryId": feed.libraryId, "decisionCursor": feed.decisionCursor,
                       "generatedAt": feed.generatedAt,
                       "skipped": [s.model_dump() for s in sorted(feed.skipped, key=lambda s: s.sequence)],
                       "items": [i.model_dump() for i in kept]}
            revision = hashlib.sha256(encode(content).encode()).hexdigest()
            result = {"version": 1, "revision": revision, "items": len(kept),
                      "dropped": len(feed.items) - len(kept)}
            if current is not None and current["feed_revision"] == revision:
                return result
            if feed.baseRevision != (current["feed_revision"] if current else None):
                fail(409, "similarityReviewFeedChanged", "유사 이미지 검토 목록이 변경되었습니다. 다시 게시해 주세요.")
            now = datetime.now(timezone.utc).isoformat()
            if current is None:
                db.execute("""INSERT INTO mobile_similarity_review_state
                    (singleton,library_id,feed_revision,feed_cursor,last_sequence,generated_at,published_at)
                    VALUES(1,?,?,?,0,?,?)""", (feed.libraryId, revision, feed.decisionCursor, feed.generatedAt, now))
            else:
                db.execute("""UPDATE mobile_similarity_review_state SET feed_revision=?,feed_cursor=?,
                    generated_at=?,published_at=? WHERE singleton=1""",
                           (revision, feed.decisionCursor, feed.generatedAt, now))
            db.execute("DELETE FROM mobile_similarity_review_items")
            db.executemany("INSERT INTO mobile_similarity_review_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                           ((position, i.reviewId, i.kind, i.distance, i.recommendedAssetId, i.recommendation,
                             i.a.assetId, i.a.sha256, encode(i.a.model_dump()),
                             i.b.assetId, i.b.sha256, encode(i.b.model_dump()))
                            for position, i in enumerate(kept)))
            db.executemany("INSERT OR REPLACE INTO mobile_similarity_review_skipped VALUES(?,?)",
                           ((s.sequence, s.reason) for s in feed.skipped))
            db.execute("""DELETE FROM mobile_similarity_review_skipped WHERE sequence NOT IN
                (SELECT sequence FROM mobile_similarity_review_skipped ORDER BY sequence DESC LIMIT ?)""",
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
                raise HTTPException(413, "Similarity review feed too large")
        try:
            feed = Feed.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            invalid_feed()
        return await run_in_threadpool(replace_feed, feed)

    def empty():
        return {"version": 1, "ready": False, "libraryId": None, "revision": None, "generatedAt": None,
                "decisionCursor": 0, "appliedDecisionCursor": 0,
                "counts": {"open": 0, "pendingPc": 0, "skipped": 0},
                "items": [], "nextCursor": None, "hasMore": False}

    def read_feed(limit, cursor):
        position = -1
        if cursor is not None:
            revision, position = decode_cursor(cursor)
        with get_db() as db:
            db.execute("BEGIN")
            current = state(db)
            if current is None:
                if cursor is not None:
                    fail(409, "similarityReviewChanged", "검토 목록이 변경되었습니다. 처음부터 다시 불러옵니다.")
                return empty()
            if cursor is not None and revision != current["feed_revision"]:
                fail(409, "similarityReviewChanged", "검토 목록이 변경되었습니다. 처음부터 다시 불러옵니다.")
            pending = pending_decisions(db, current)
            decided = json.dumps(sorted({row["review_id"] for row in pending}))
            trashed = json.dumps(sorted({row["trash_asset_id"] for row in pending if row["trash_asset_id"]}))
            # The overlay: a decided pair leaves the queue, and so does every pair that holds
            # an image a pending decision will trash. Changed or hidden Assets drop out too.
            base = """FROM mobile_similarity_review_items i
                JOIN visible_assets a ON a.id=i.a_asset_id AND a.committed=1 AND a.sha256=i.a_sha256
                JOIN visible_assets b ON b.id=i.b_asset_id AND b.committed=1 AND b.sha256=i.b_sha256
                WHERE i.review_id NOT IN (SELECT value FROM json_each(?))
                AND i.a_asset_id NOT IN (SELECT value FROM json_each(?))
                AND i.b_asset_id NOT IN (SELECT value FROM json_each(?))"""
            params = [decided, trashed, trashed]
            total = db.execute(f"SELECT COUNT(*) {base}", params).fetchone()[0]
            rows = db.execute(f"SELECT i.* {base} AND i.position>? ORDER BY i.position LIMIT ?",
                              params + [position, limit + 1]).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            assets = hydrate(db, [r["a_asset_id"] for r in rows] + [r["b_asset_id"] for r in rows])
            skipped = db.execute("SELECT COUNT(*) FROM mobile_similarity_review_skipped").fetchone()[0]
            items = []
            for row in rows:
                if row["a_asset_id"] not in assets or row["b_asset_id"] not in assets:
                    continue
                items.append({"reviewId": row["review_id"], "kind": row["kind"], "distance": row["distance"],
                              "recommendedAssetId": row["recommended_asset_id"],
                              "recommendation": row["recommendation"],
                              "a": {**json.loads(row["a_json"]), "asset": assets[row["a_asset_id"]]},
                              "b": {**json.loads(row["b_json"]), "asset": assets[row["b_asset_id"]]}})
            return {"version": 1, "ready": True, "libraryId": current["library_id"],
                    "revision": current["feed_revision"], "generatedAt": current["generated_at"],
                    "decisionCursor": current["last_sequence"], "appliedDecisionCursor": current["feed_cursor"],
                    "counts": {"open": total, "pendingPc": len(pending), "skipped": skipped},
                    "items": items,
                    "nextCursor": encode_cursor(current["feed_revision"], rows[-1]["position"]) if more else None,
                    "hasMore": more}

    @app.get(PREFIX)
    def review(request: Request, limit: int = Query(default=20, ge=1, le=50),
               cursor: str | None = Query(default=None, max_length=512),
               authorization: str | None = Header(default=None)):
        require_client(authorization)
        if set(request.query_params.keys()) - {"limit", "cursor"}:
            raise HTTPException(422, "Invalid similarity review request")
        return read_feed(limit, cursor)

    def apply(command):
        try:
            if str(UUID(command.operationId)) != command.operationId:
                raise ValueError()
        except ValueError:
            fail(422, "invalidSimilarityReviewDecision", "검토 요청 식별자가 올바르지 않습니다.")
        payload_digest = hashlib.sha256(encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = check_library(db, command.libraryId)
            if current is None:
                fail(409, "similarityReviewUnsupported", "PC에서 유사 이미지 검토를 먼저 업데이트해 주세요.")
            # Receipt first: a response-lost retry stays valid after later publications.
            receipt = db.execute("SELECT * FROM mobile_similarity_review_decisions WHERE operation_id=?",
                                 (command.operationId,)).fetchone()
            if receipt is not None:
                if receipt["payload_digest"] != payload_digest:
                    fail(409, "operationConflict", "다른 내용으로 검토 요청을 재사용할 수 없습니다.")
                return json.loads(receipt["result_json"])
            if command.basis.feedRevision != current["feed_revision"]:
                fail(409, "similarityReviewChanged", "검토 목록이 바뀌었습니다. 새로고침해 주세요.")
            pending = {row["review_id"]: row for row in pending_decisions(db, current)}
            withdraws = None
            if command.decision == "withdrawn":
                # Undo after sending. Only a decision the PC has not consumed yet can be
                # withdrawn; once applied, the image is restored from Library Trash instead.
                target = pending.get(command.reviewId)
                if target is None:
                    latest = db.execute("""SELECT decision,sequence FROM mobile_similarity_review_decisions
                        WHERE review_id=? ORDER BY sequence DESC LIMIT 1""", (command.reviewId,)).fetchone()
                    if latest is not None and latest["decision"] == "withdrawn" and latest["sequence"] > current["feed_cursor"]:
                        fail(409, "similarityDecisionWithdrawn", "이미 취소한 결정입니다.")
                    fail(409, "similarityDecisionApplied", "PC가 이미 반영했습니다. 휴지통에서 복원해 주세요.")
                a_id, b_id, withdraws = target["a_asset_id"], target["b_asset_id"], target["sequence"]
            else:
                item = db.execute("SELECT * FROM mobile_similarity_review_items WHERE review_id=?",
                                  (command.reviewId,)).fetchone()
                if item is None:
                    fail(409, "similarityReviewMissing", "PC에서 이미 정리되었거나 사라진 검토입니다.")
                a_id, b_id = item["a_asset_id"], item["b_asset_id"]
                hashes = current_hashes(db, [a_id, b_id])
                if (command.basis.aSha256, command.basis.bSha256) != (item["a_sha256"], item["b_sha256"]) \
                        or hashes.get(a_id) != item["a_sha256"] or hashes.get(b_id) != item["b_sha256"]:
                    fail(409, "similarityAssetChanged", "이미지가 바뀌었거나 정리되어 검토를 반영할 수 없습니다.")
                if command.reviewId in pending:
                    fail(409, "pendingSimilarityDecision", "이 검토의 결정이 PC 반영을 기다리고 있습니다.")
                trashed = {row["trash_asset_id"] for row in pending.values() if row["trash_asset_id"]}
                if a_id in trashed or b_id in trashed:
                    fail(409, "similarityAssetPendingTrash", "다른 검토에서 휴지통으로 보낼 이미지가 포함되어 있습니다.")
            sequence = current["last_sequence"] + 1
            if sequence > MAX_CURSOR:
                fail(409, "similarityReviewCursorRejected", "유사 이미지 검토 기록 한도에 도달했습니다.")
            trash = trash_target(command.decision, a_id, b_id)
            result = {"version": 1, "operationId": command.operationId, "libraryId": command.libraryId,
                      "reviewId": command.reviewId, "decision": command.decision, "sequence": sequence,
                      "trashAssetId": trash, "withdraws": withdraws, "pendingPc": True}
            db.execute("INSERT INTO mobile_similarity_review_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (sequence, command.operationId, payload_digest, command.reviewId, command.decision,
                        a_id, b_id, trash, withdraws, command.basis.feedRevision, command.basis.aSha256,
                        command.basis.bSha256, datetime.now(timezone.utc).isoformat(), json.dumps(result)))
            db.execute("UPDATE mobile_similarity_review_state SET last_sequence=? WHERE singleton=1", (sequence,))
            db.commit()
            return result

    @app.post(PREFIX + "/decisions")
    async def decide(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_COMMAND_BYTES:
                raise HTTPException(413, "Similarity review decision too large")
        try:
            command = Command.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            fail(422, "invalidSimilarityReviewDecision", "검토 요청을 확인할 수 없습니다.")
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
                fail(409, "similarityReviewCursorRejected", "유사 이미지 검토 동기화 위치를 확인해 주세요.")
            rows = db.execute("SELECT * FROM mobile_similarity_review_decisions WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            return {"version": 1, "libraryId": libraryId, "after": after,
                    "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
                    "items": [{"sequence": r["sequence"], "operationId": r["operation_id"],
                               "reviewId": r["review_id"], "decision": r["decision"],
                               "aAssetId": r["a_asset_id"], "bAssetId": r["b_asset_id"],
                               "trashAssetId": r["trash_asset_id"], "withdraws": r["withdraws"],
                               "basis": {"feedRevision": r["feed_revision"], "aSha256": r["a_sha256"],
                                         "bSha256": r["b_sha256"]},
                               "createdAt": r["created_at"]} for r in rows]}
