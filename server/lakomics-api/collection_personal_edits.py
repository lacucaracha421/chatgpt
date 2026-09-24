"""Mobile personal Collection edits: my rating, Showcase membership and the memo.

The PC stays the owner of every Collection. A mobile edit is a command the server
accepts, records in an ordered log and applies at once to the published row, so
mobile reads reflect it immediately. The PC pulls the log before it publishes and
reports how far it has applied it (``personalEditCursor``); a publication then
re-applies every later log entry, so a stale snapshot cannot rewind an edit.

Readiness follows the Character exclusion channel: nothing is accepted until an
upgraded PC has published once (the state row exists), and from then on a legacy
snapshot without the handshake is refused.
"""
import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import authority

PREFIX = "/v1/collections/personal-edits"
MAX_CURSOR = 9_007_199_254_740_991
# The PC limit is authoritative (library/collection.rs `normalized_description`).
MAX_MEMO_CHARS = 2000
# Room for a 2000-character Hangul memo as both `value` and `expected` (~6 KB each).
MAX_COMMAND_BYTES = 32 * 1024
FIELDS = ("myScore", "showcase", "memo")
ID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
LIBRARY = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
DDL = """
CREATE TABLE IF NOT EXISTS mobile_collection_edit_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL,
 applied_cursor INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mobile_collection_edits (
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
 payload_digest TEXT NOT NULL, collection_id TEXT NOT NULL, field TEXT NOT NULL,
 value_json TEXT NOT NULL, base_json TEXT NOT NULL, created_at TEXT NOT NULL,
 result_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_collection_edit_noops (
 operation_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
 created_at TEXT NOT NULL, result_json TEXT NOT NULL);
"""
# Payload key per command field.
PAYLOAD_KEYS = {"myScore": "myScore", "showcase": "showcase", "memo": "description"}


class Edit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    libraryId: LIBRARY
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    collectionId: ID
    field: Literal["myScore", "showcase", "memo"]
    # Both are required (null is a real value); their shape depends on `field`.
    value: Any
    expected: Any


def fail(status, code, message, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra})


def invalid():
    fail(422, "invalidCollectionPersonalEdit", "개인 편집 요청을 확인할 수 없습니다.")


def normalized(field, value, *, limit=MAX_MEMO_CHARS):
    """The PC's own validation: score null or 0–5 in 0.5 steps, bool Showcase, trimmed memo."""
    if field == "myScore":
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            invalid()
        value = float(value)
        if not math.isfinite(value) or not 0.0 <= value <= 5.0 or (value * 2) % 1 != 0:
            invalid()
        return value
    if field == "showcase":
        if not isinstance(value, bool):
            invalid()
        return value
    if value is None:
        return None
    if not isinstance(value, str):
        invalid()
    value = value.strip()
    if len(value) > limit:
        invalid()
    return value or None


def current_value(field, payload):
    value = payload.get(PAYLOAD_KEYS[field])
    if field == "myScore":
        return None if value is None else float(value)
    if field == "showcase":
        return bool(value)
    return value or None


def state(db):
    return db.execute("SELECT * FROM mobile_collection_edit_state WHERE singleton=1").fetchone()


def check_library(db, library_id):
    """Bind edits to the configured server library, exactly like Character exclusions."""
    owners = [authority.active_domain(db, domain) for domain in ("assets", "classifications")]
    ids = {owner["libraryId"] for owner in owners if owner is not None}
    if not ids:
        fail(409, "collectionPersonalEditUnsupported", "서버 라이브러리 연결을 먼저 완료해 주세요.")
    current = state(db)
    if ids != {library_id} or current is not None and current["library_id"] != library_id:
        fail(409, "libraryMismatch", "다른 라이브러리의 컬렉션 편집 요청입니다.")
    return current


def validate_handshake(snapshot):
    """All three handshake fields travel together or not at all."""
    fields = (snapshot.personalEditVersion, snapshot.libraryId, snapshot.personalEditCursor)
    if any(value is None for value in fields) and any(value is not None for value in fields):
        raise HTTPException(422, "Invalid collection snapshot")


def publication_guard(db, snapshot):
    """An upgraded PC can advance the applied cursor; an older PC/backup cannot rewind it."""
    current = state(db)
    if snapshot.personalEditVersion is None:
        if current is not None:
            fail(409, "collectionPersonalEditUnsupported", "컬렉션 개인 편집을 지원하는 PC 앱이 필요합니다.")
        return
    current = check_library(db, snapshot.libraryId)
    floor = current["applied_cursor"] if current else 0
    ceiling = current["last_sequence"] if current else 0
    if not floor <= snapshot.personalEditCursor <= ceiling:
        fail(409, "collectionPersonalEditCursorRejected", "컬렉션 편집 기록을 동기화한 뒤 다시 게시해 주세요.")


def patch(db, collection_id, field, value):
    """Write one field into the served row; returns False when the row is not published."""
    row = db.execute("SELECT type,showcase,showcase_order,payload FROM mobile_collections WHERE id=?",
                     (collection_id,)).fetchone()
    if row is None:
        return False
    payload = json.loads(row["payload"])
    showcase, order = bool(row["showcase"]), row["showcase_order"]
    if field == "showcase":
        if value and not showcase:
            # PC rule: append after the current maximum within the Collection type.
            order = db.execute("""SELECT COALESCE(MAX(showcase_order)+1,0) FROM mobile_collections
                WHERE type=? AND id<>? AND showcase=1""", (row["type"], collection_id)).fetchone()[0]
        elif not value:
            order = None
        showcase = value
        payload["showcase"], payload["showcaseOrder"] = showcase, order
    else:
        payload[PAYLOAD_KEYS[field]] = value
    db.execute("UPDATE mobile_collections SET showcase=?,showcase_order=?,payload=? WHERE id=?",
               (int(showcase), order, encode(payload), collection_id))
    return True


def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def reapply_pending(db, cursor):
    """Replay edits the snapshot's PC has not received yet, in log order."""
    for row in db.execute("SELECT collection_id,field,value_json FROM mobile_collection_edits WHERE sequence>? ORDER BY sequence",
                          (cursor,)).fetchall():
        # A Collection the PC deleted stays deleted: PC deletion wins.
        patch(db, row["collection_id"], row["field"], json.loads(row["value_json"]))


def acknowledge_publication(db, snapshot):
    """Called after the snapshot rows are reinserted, inside the same transaction."""
    if snapshot.personalEditVersion is None:
        return
    reapply_pending(db, snapshot.personalEditCursor)
    db.execute("""INSERT INTO mobile_collection_edit_state(singleton,library_id,applied_cursor)
        VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET applied_cursor=excluded.applied_cursor""",
               (snapshot.libraryId, snapshot.personalEditCursor))


def last_sequence(db):
    current = state(db)
    return current["last_sequence"] if current else 0


def advertisement(db):
    current = state(db)
    if current is None:
        return {"capabilities": {"collectionPersonalEdit": False}}
    return {"capabilities": {"collectionPersonalEdit": True}, "libraryId": current["library_id"],
            "personalEditCursor": current["last_sequence"],
            "appliedPersonalEditCursor": current["applied_cursor"]}


def register(app, get_db, require_client, require_publisher, replica_revision):
    """``replica_revision(db)`` reads the served revision; routes precede ``/v1/collections/{id}``."""

    def apply(command):
        try:
            if str(UUID(command.operationId)) != command.operationId:
                raise ValueError()
        except ValueError:
            invalid()
        value = normalized(command.field, command.value)
        # A published memo may predate the 2000-character PC limit.
        expected = normalized(command.field, command.expected, limit=10000)
        payload_digest = hashlib.sha256(encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = check_library(db, command.libraryId)
            if current is None:
                fail(409, "collectionPersonalEditUnsupported", "PC 앱을 업데이트한 뒤 컬렉션을 게시해 주세요.")
            # Receipts precede every state check: a response-lost retry stays valid
            # after later edits or publications.
            for table in ("mobile_collection_edits", "mobile_collection_edit_noops"):
                receipt = db.execute(f"SELECT payload_digest,result_json FROM {table} WHERE operation_id=?",
                                     (command.operationId,)).fetchone()
                if receipt is not None:
                    if receipt["payload_digest"] != payload_digest:
                        fail(409, "operationConflict", "다른 내용으로 편집 요청을 재사용할 수 없습니다.")
                    return json.loads(receipt["result_json"])
            row = db.execute("SELECT payload FROM mobile_collections WHERE id=?", (command.collectionId,)).fetchone()
            if row is None:
                fail(404, "collectionNotFound", "PC에서 삭제되었거나 게시되지 않은 작품입니다.")
            now = datetime.now(timezone.utc).isoformat()
            revision = replica_revision(db)
            present = current_value(command.field, json.loads(row["payload"]))
            result = {"version": 1, "operationId": command.operationId, "collectionId": command.collectionId,
                      "field": command.field, "value": value}
            if present == value:
                result.update(sequence=None, revision=revision, changed=False)
                db.execute("INSERT INTO mobile_collection_edit_noops VALUES(?,?,?,?)",
                           (command.operationId, payload_digest, now, json.dumps(result)))
                db.commit()
                return result
            if present != expected:
                fail(409, "collectionPersonalConflict", "다른 기기에서 값이 바뀌었습니다.", current=present)
            sequence = current["last_sequence"] + 1
            if sequence > MAX_CURSOR:
                fail(409, "collectionPersonalEditCursorRejected", "컬렉션 편집 기록 한도에 도달했습니다.")
            revision = hashlib.sha256(f"{revision}:personal-edit:{sequence}:{payload_digest}".encode()).hexdigest()
            result.update(sequence=sequence, revision=revision, changed=True)
            db.execute("INSERT INTO mobile_collection_edits VALUES(?,?,?,?,?,?,?,?,?)",
                       (sequence, command.operationId, payload_digest, command.collectionId, command.field,
                        json.dumps(value), json.dumps(present), now, json.dumps(result)))
            db.execute("UPDATE mobile_collection_edit_state SET last_sequence=? WHERE singleton=1", (sequence,))
            patch(db, command.collectionId, command.field, value)
            # Mobile's publication check compares this revision and refreshes.
            db.execute("UPDATE mobile_collection_replica SET revision=? WHERE singleton=1", (revision,))
            db.commit()
            return result

    @app.post(PREFIX)
    async def edit(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_COMMAND_BYTES:
                raise HTTPException(413, "Collection personal edit too large")
        try:
            command = Edit.model_validate_json(bytes(raw))
        except ValidationError:
            invalid()
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
                fail(409, "collectionPersonalEditCursorRejected", "컬렉션 편집 동기화 위치를 확인해 주세요.")
            rows = db.execute("SELECT * FROM mobile_collection_edits WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            return {"version": 1, "libraryId": libraryId, "after": after,
                    "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
                    "items": [{"sequence": r["sequence"], "operationId": r["operation_id"],
                               "collectionId": r["collection_id"], "field": r["field"],
                               "value": json.loads(r["value_json"]), "previous": json.loads(r["base_json"]),
                               "createdAt": r["created_at"]} for r in rows]}
