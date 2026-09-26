"""Manual corrections only: no inference, media reads, or character authority cutover."""
import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import authority

PREFIX = "/v1/library/characters/exclusions"
MAX_CURSOR = 9_007_199_254_740_991
ID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
LIBRARY = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
DIGEST = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
DDL = """
CREATE TABLE IF NOT EXISTS mobile_character_exclusion_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL,
 applied_cursor INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mobile_character_exclusions (
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
 payload_digest TEXT NOT NULL, target_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 asset_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_character_hidden_members (
 node_id TEXT NOT NULL, filter TEXT NOT NULL, asset_id TEXT NOT NULL,
 PRIMARY KEY(node_id,filter,asset_id));
"""
# Indexed pair lookup, shared by page and count queries; never post-filter a page.
VISIBLE_MEMBER = """NOT EXISTS (SELECT 1 FROM mobile_character_hidden_members h
    WHERE h.node_id=m.node_id AND h.filter=m.filter AND h.asset_id=m.asset_id)"""


class Exclusion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    libraryId: LIBRARY
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    targetId: ID
    assetId: ID
    revision: DIGEST


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


def state(db):
    return db.execute("SELECT * FROM mobile_character_exclusion_state WHERE singleton=1").fetchone()


def status_head(db):
    """Log head for ``/v1/sync/status`` ``publisherLogs.characterExclusions``."""
    current = state(db)
    return current["last_sequence"] if current else 0


def check_library(db, library_id):
    # Bind corrections to the already configured server library, never to a device path.
    owners = [authority.active_domain(db, domain) for domain in ("assets", "classifications")]
    ids = {owner["libraryId"] for owner in owners if owner is not None}
    if not ids:
        fail(409, "characterExclusionUnsupported", "서버 라이브러리 연결을 먼저 완료해 주세요.")
    current = state(db)
    if ids != {library_id} or current is not None and current["library_id"] != library_id:
        fail(409, "libraryMismatch", "다른 라이브러리의 캐릭터 제외 요청입니다.")
    return current


def publication_guard(db, snapshot):
    """A PC acknowledgement can advance, but an older PC/backup cannot rewind it."""
    current = state(db)
    if snapshot.manualExclusionVersion is None:
        if current is not None:
            fail(409, "characterExclusionUnsupported", "캐릭터 제외를 지원하는 PC 앱이 필요합니다.")
        return
    current = check_library(db, snapshot.libraryId)
    floor = current["applied_cursor"] if current else 0
    ceiling = current["last_sequence"] if current else 0
    if not floor <= snapshot.exclusionCursor <= ceiling:
        fail(409, "characterExclusionCursorRejected", "캐릭터 제외 기록을 동기화한 뒤 다시 게시해 주세요.")


def acknowledge_publication(db, snapshot, index):
    if snapshot.manualExclusionVersion is not None:
        db.execute("""INSERT INTO mobile_character_exclusion_state(singleton,library_id,applied_cursor)
            VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET applied_cursor=excluded.applied_cursor""",
                   (snapshot.libraryId, snapshot.exclusionCursor))
    rebuild_hidden(db, index)


def rebuild_hidden(db, index):
    """Materialize the small pending overlay on writes, not every gallery read."""
    db.execute("DELETE FROM mobile_character_hidden_members")
    current = state(db)
    if current is None:
        return
    db.execute("""INSERT INTO mobile_character_hidden_members
        SELECT DISTINCT 'character:' || target_id,'all',asset_id
        FROM mobile_character_exclusions WHERE sequence>?""", (current["applied_cursor"],))
    # Pending "아님" review decisions hide current members exactly like exclusions.
    import character_review
    character_review.insert_hidden(db)
    # Groups are unions: rejecting C must not hide an Asset still belonging to D.
    # A group-only member lacking child evidence is retained, not guessed away.
    nodes = json.dumps(index["nodes"], ensure_ascii=False)
    db.execute("""WITH nodes AS (
        SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.parentId') AS parent_id
        FROM json_each(?) WHERE json_extract(value,'$.kind')='character'
    ) INSERT OR IGNORE INTO mobile_character_hidden_members
      SELECT n.parent_id,'all',h.asset_id
      FROM mobile_character_hidden_members h JOIN nodes n ON n.id=h.node_id
      WHERE n.parent_id LIKE 'group:%'
      AND EXISTS (SELECT 1 FROM mobile_character_members m
                  WHERE m.node_id=n.parent_id AND m.filter='all' AND m.asset_id=h.asset_id)
      AND NOT EXISTS (
        SELECT 1 FROM nodes sibling JOIN mobile_character_members m ON m.node_id=sibling.id
        WHERE sibling.parent_id=n.parent_id AND m.filter='all' AND m.asset_id=h.asset_id
        AND NOT EXISTS (SELECT 1 FROM mobile_character_hidden_members hidden
                        WHERE hidden.node_id=m.node_id AND hidden.filter=m.filter AND hidden.asset_id=m.asset_id))
    """, (nodes,))


def advertisement(db):
    current = state(db)
    if current is None:
        return {"manualExclusion": False}, {}
    return {"manualExclusion": True}, {
        "libraryId": current["library_id"], "exclusionCursor": current["last_sequence"],
        "appliedExclusionCursor": current["applied_cursor"],
    }


def register(app, get_db, require_client, require_publisher):
    def apply(command):
        try:
            if str(UUID(command.operationId)) != command.operationId:
                raise ValueError()
        except ValueError:
            fail(422, "invalidCharacterExclusion", "제외 요청 식별자가 올바르지 않습니다.")
        payload_digest = hashlib.sha256(json.dumps(command.model_dump(), sort_keys=True).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = check_library(db, command.libraryId)
            if current is None:
                fail(409, "characterExclusionUnsupported", "PC에서 캐릭터 보기를 업데이트해 주세요.")
            # Receipt precedes revision/member checks: a response-lost retry stays valid
            # even after a subsequent PC publication or another exclusion.
            receipt = db.execute("SELECT * FROM mobile_character_exclusions WHERE operation_id=?",
                                 (command.operationId,)).fetchone()
            if receipt is not None:
                if receipt["payload_digest"] != payload_digest:
                    fail(409, "operationConflict", "다른 내용으로 제외 요청을 재사용할 수 없습니다.")
                return json.loads(receipt["result_json"])
            published = db.execute("SELECT * FROM mobile_character_state WHERE singleton=1").fetchone()
            if published is None or published["revision"] != command.revision:
                fail(409, "characterSnapshotChanged", "캐릭터 보기가 변경되었습니다. 새로고침해 주세요.")
            index = json.loads(published["index_json"])
            node_id = "character:" + command.targetId
            node = next((n for n in index["nodes"] if n["id"] == node_id), None)
            if node is None or node.get("protectedAssetIds") is None:
                fail(409, "characterExclusionUnsupported", "PC에서 캐릭터 보기를 업데이트해 주세요.")
            if command.assetId in node["protectedAssetIds"]:
                fail(409, "characterReferenceProtected", "참조 이미지는 PC에서 먼저 해제해 주세요.")
            asset = db.execute("""SELECT a.sha256 FROM visible_assets a
                JOIN mobile_character_members m ON m.asset_id=a.id
                WHERE a.id=? AND a.committed=1 AND m.node_id=? AND m.filter='all'""",
                               (command.assetId, node_id)).fetchone()
            if asset is None or not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"] or ""):
                fail(409, "characterSnapshotChanged", "제외할 자산을 다시 확인해 주세요.")
            # Mirror of the review channel's check: one correction per pair awaits the PC.
            import character_review
            if character_review.pending_pair(db, command.targetId, command.assetId):
                fail(409, "pendingCharacterCorrection", "이 자산의 캐릭터 검토가 PC 반영을 기다리고 있습니다.")
            sequence = current["last_sequence"] + 1
            if sequence > MAX_CURSOR:
                fail(409, "characterExclusionCursorRejected", "캐릭터 제외 기록 한도에 도달했습니다.")
            revision = hashlib.sha256(f"{published['revision']}:{sequence}:{payload_digest}".encode()).hexdigest()
            result = {"version": 1, "operationId": command.operationId,
                      "libraryId": command.libraryId, "targetId": command.targetId,
                      "assetId": command.assetId, "sequence": sequence,
                      "revision": revision, "pendingPc": True}
            db.execute("INSERT INTO mobile_character_exclusions VALUES(?,?,?,?,?,?,?,?)",
                       (sequence, command.operationId, payload_digest, command.targetId, command.assetId,
                        asset["sha256"], datetime.now(timezone.utc).isoformat(), json.dumps(result)))
            db.execute("UPDATE mobile_character_exclusion_state SET last_sequence=? WHERE singleton=1", (sequence,))
            rebuild_hidden(db, index)
            db.execute("UPDATE mobile_character_state SET revision=? WHERE singleton=1", (revision,))
            db.commit()
            return result

    @app.post(PREFIX)
    async def exclude(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8192:
                raise HTTPException(413, "Character exclusion too large")
        try:
            command = Exclusion.model_validate_json(bytes(raw))
        except ValidationError:
            fail(422, "invalidCharacterExclusion", "제외 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(apply, command)

    @app.get(PREFIX)
    def changes(libraryId: LIBRARY, after: int = Query(default=0, ge=0, le=MAX_CURSOR),
                limit: int = Query(default=100, ge=1, le=100),
                authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            current = check_library(db, libraryId)
            if after > (current["last_sequence"] if current else 0):
                fail(409, "characterExclusionCursorRejected", "캐릭터 제외 동기화 위치를 확인해 주세요.")
            rows = db.execute("SELECT * FROM mobile_character_exclusions WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            return {"version": 1, "libraryId": libraryId, "after": after,
                    "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
                    "items": [{"sequence": r["sequence"], "operationId": r["operation_id"],
                               "targetId": r["target_id"], "assetId": r["asset_id"],
                               "assetSha256": r["asset_sha256"], "createdAt": r["created_at"]} for r in rows]}
