"""Mobile personal Collection edits: my rating, Showcase membership and the memo.

The PC stays the owner of every Collection. A mobile edit is a command the server
accepts, records in an ordered log and applies at once to the published row, so
mobile reads reflect it immediately. The PC pulls the log before it publishes and
reports how far it has applied it (``personalEditCursor``); a publication then
re-applies every later log entry, so a stale snapshot cannot rewind an edit.

Readiness follows the Character exclusion channel: nothing is accepted until an
upgraded PC has published once (the state row exists), and from then on a legacy
snapshot without the handshake is refused.

Manga tracking fields (personal-edit version 2, decided 2026-09-25)
-------------------------------------------------------------------
Mobile may also manage, per manga Collection, 신간 알림 and the owned-volume count - what
the PC's Collection ownership panel edits (`set_release_watch_enabled`,
`set_owned_volume_count` in `_tools/app/src-tauri/src/library/`):

* ``field: "releaseWatch"`` - ``value``/``expected`` are booleans. The PC applies it with
  ``set_release_watch_enabled(collectionId, value)``. Turning it on is refused with
  ``409 releaseWatchUnavailable`` when the published ``releaseWatch.available`` is false;
  if the PC still cannot enable it (binding removed meanwhile) it records the entry as
  applied without change and its next publication shows the real state.
* ``field: "ownedVolumes"`` - ``value`` is ``{"editionIndex": 0-3, "count": 0-2000}``;
  ``expected`` is ``{"editionIndex": <same>, "count": <int or null>}`` (null = edition not
  tracked yet). The PC applies it with ``set_owned_volume_count(collectionId, editionIndex,
  count)`` (volumes 1..count owned as physical, replacing that edition's per-volume
  detail, exactly like the PC's own count control).

Publication keys an upgraded PC adds to each manga Collection (both optional; never on
other types; a legacy snapshot simply lacks them):

* ``releaseWatch: {"enabled": bool, "available": bool}`` - ``enabled`` = a subscription
  exists; ``available`` = the Collection has an Aladin or Kakao binding.
* ``ownedVolumes: [{"editionIndex": 0-3, "count": 0-2000}, ...]`` - one entry per tracked
  edition (`collection_ownership_tracking`, plus any edition with owned volumes); ``count``
  = volumes owned in any format, as the PC panel shows it. Unique editions, <= 4 entries.
* ``releaseSchedule: {"kakao": null | {...}, "mangadex": null | {...}}`` - read-only release
  information (``mobile_collections.ReleaseSchedule``): the Kakao (Korean) volumes with the
  date/status the PC release watch computes, the owned-volume ``editionIndex`` they belong
  to and ``checkedAt``; MangaDex's Japanese volume numbers, ``latestVolume`` and
  ``checkedAt``. A provider without a binding is null. Not editable from clients.

Handshake: a PC that understands these fields publishes ``personalEditVersion: 2`` (same
``libraryId``/``personalEditCursor`` rules as 1) and reads the log with ``editVersion=2``.
Tracking edits are accepted only while the latest handshake publication had version 2 and
the Collection's published payload carries the key (``409
collectionPersonalEditUnsupported`` / ``409 collectionTrackingUnavailable`` otherwise), and
``/v1/collections/status`` advertises ``capabilities.collectionTrackingEdit``. A log read
without ``editVersion=2`` whose page would contain a tracking entry is refused with ``409
collectionPersonalEditUpgradeRequired``, so a version-1 PC fails closed instead of
skipping an entry. Do not downgrade the PC to a version-1 build once tracking edits exist:
it stops at that error until it is upgraded again. Once Collections authority is active, tracking fields are refused
(``409 collectionPersonalEditUnsupported``); authority clients use its own commands.
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
import collection_authority

PREFIX = "/v1/collections/personal-edits"
MAX_CURSOR = 9_007_199_254_740_991
# The PC limit is authoritative (library/collection.rs `normalized_description`).
MAX_MEMO_CHARS = 2000
# Room for a 2000-character Hangul memo as both `value` and `expected` (~6 KB each).
MAX_COMMAND_BYTES = 32 * 1024
FIELDS = ("myScore", "showcase", "memo", "releaseWatch", "ownedVolumes")
TRACKING_FIELDS = ("releaseWatch", "ownedVolumes")
EDIT_VERSION = 2  # the handshake version that understands TRACKING_FIELDS
MAX_OWNED_COUNT = 2000  # library/collection_tracking.rs set_owned_volume_count
ID = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
LIBRARY = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
DDL = """
CREATE TABLE IF NOT EXISTS mobile_collection_edit_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL,
 applied_cursor INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0,
 edit_version INTEGER NOT NULL DEFAULT 1);
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
PAYLOAD_KEYS = {"myScore": "myScore", "showcase": "showcase", "memo": "description",
                "releaseWatch": "releaseWatch", "ownedVolumes": "ownedVolumes"}


def migrate(db):
    """Add ``edit_version`` to a state table created before personal-edit version 2."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(mobile_collection_edit_state)")}
    if "edit_version" not in columns:
        db.execute("ALTER TABLE mobile_collection_edit_state ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 1")


class Edit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    libraryId: LIBRARY
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    collectionId: ID
    field: Literal["myScore", "showcase", "memo", "releaseWatch", "ownedVolumes"]
    # Both are required (null is a real value); their shape depends on `field`.
    value: Any
    expected: Any


def fail(status, code, message, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra})


def invalid():
    fail(422, "invalidCollectionPersonalEdit", "개인 편집 요청을 확인할 수 없습니다.")


def _small_int(value, high):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= high:
        invalid()
    return value


def normalized(field, value, *, limit=MAX_MEMO_CHARS, expected=False):
    """The PC's own validation: score null or 0–5 in 0.5 steps, bool Showcase, trimmed memo,
    bool release watch, ``{"editionIndex": 0-3, "count": 0-2000}`` (an expected count may
    be null: edition not tracked)."""
    if field == "ownedVolumes":
        if not isinstance(value, dict) or set(value) != {"editionIndex", "count"}:
            invalid()
        count = value["count"]
        return {"editionIndex": _small_int(value["editionIndex"], 3),
                "count": None if expected and count is None else _small_int(count, MAX_OWNED_COUNT)}
    if field == "myScore":
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            invalid()
        try:
            value = float(value)
        except OverflowError:  # a JSON integer beyond float range
            invalid()
        if not math.isfinite(value) or not 0.0 <= value <= 5.0 or (value * 2) % 1 != 0:
            invalid()
        return value
    if field in ("showcase", "releaseWatch"):
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


def current_value(field, payload, command_value=None):
    value = payload.get(PAYLOAD_KEYS[field])
    if field == "releaseWatch":
        return bool(value and value.get("enabled"))
    if field == "ownedVolumes":
        edition = command_value["editionIndex"]
        count = next((entry["count"] for entry in value or () if entry["editionIndex"] == edition), None)
        return {"editionIndex": edition, "count": count}
    if field == "myScore":
        return None if value is None else float(value)
    if field == "showcase":
        return bool(value)
    # Normalized like the command's `expected`, so a published memo with surrounding
    # whitespace cannot conflict with every edit that echoes it back trimmed.
    return (value.strip() if isinstance(value, str) else value) or None


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


def tracking_guard(current, payload, field, value):
    """Tracking edits need a version-2 PC and a manga Collection published with the key."""
    if current["edit_version"] < EDIT_VERSION:
        fail(409, "collectionPersonalEditUnsupported", "PC 앱을 업데이트한 뒤 컬렉션을 게시해 주세요.")
    state_value = payload.get(PAYLOAD_KEYS[field])
    if payload.get("type") != "manga" or state_value is None:
        fail(409, "collectionTrackingUnavailable", "이 작품은 신간 알림과 보유 권수를 관리할 수 없습니다.")
    if field == "releaseWatch" and value and not state_value.get("available"):
        fail(409, "releaseWatchUnavailable", "알라딘 또는 카카오와 연결된 만화만 신간 알림을 켤 수 있습니다.")


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
    if field in TRACKING_FIELDS:
        # A Collection published without the key (legacy snapshot) is left untouched.
        current = payload.get(PAYLOAD_KEYS[field])
        if current is None:
            return True
        if field == "releaseWatch":
            # Never show watching on a Collection the PC cannot watch.
            payload["releaseWatch"] = {**current, "enabled": value and current.get("available", False)}
        else:
            others = [entry for entry in current if entry["editionIndex"] != value["editionIndex"]]
            payload["ownedVolumes"] = sorted([*others, value], key=lambda entry: entry["editionIndex"])
    elif field == "showcase":
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
    db.execute("""INSERT INTO mobile_collection_edit_state(singleton,library_id,applied_cursor,edit_version)
        VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET applied_cursor=excluded.applied_cursor,
        edit_version=excluded.edit_version""",
               (snapshot.libraryId, snapshot.personalEditCursor, snapshot.personalEditVersion))


def last_sequence(db):
    current = state(db)
    return current["last_sequence"] if current else 0


#: Log head for ``/v1/sync/status`` ``publisherLogs.personalEdits``.
status_head = last_sequence


def advertisement(db):
    current = state(db)
    if current is None:
        return {"capabilities": {"collectionPersonalEdit": False, "collectionTrackingEdit": False}}
    return {"capabilities": {"collectionPersonalEdit": True,
                             "collectionTrackingEdit": current["edit_version"] >= EDIT_VERSION},
            "libraryId": current["library_id"],
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
        expected = normalized(command.field, command.expected, limit=10000, expected=True)
        if command.field == "ownedVolumes" and expected["editionIndex"] != value["editionIndex"]:
            invalid()
        payload_digest = hashlib.sha256(encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            # Once Collections authority is active this route is a compatibility shim
            # onto `updateWork`; the PC-bridge log is no longer written.
            active = authority.active_domain(db, collection_authority.DOMAIN)
            if active is None:
                current = check_library(db, command.libraryId)
                if current is None:
                    fail(409, "collectionPersonalEditUnsupported", "PC 앱을 업데이트한 뒤 컬렉션을 게시해 주세요.")
            # Receipts precede every state check: a response-lost retry stays valid
            # after later edits or publications (including one accepted before activation).
            for table in ("mobile_collection_edits", "mobile_collection_edit_noops"):
                receipt = db.execute(f"SELECT payload_digest,result_json FROM {table} WHERE operation_id=?",
                                     (command.operationId,)).fetchone()
                if receipt is not None:
                    if receipt["payload_digest"] != payload_digest:
                        fail(409, "operationConflict", "다른 내용으로 편집 요청을 재사용할 수 없습니다.")
                    return json.loads(receipt["result_json"])
            if active is not None:
                if command.field in TRACKING_FIELDS:
                    fail(409, "collectionPersonalEditUnsupported", "이 편집은 지금 지원되지 않습니다.")
                result = collection_authority.personal_edit(
                    db, active, command, value, expected, collection_authority.now_iso())
                db.commit()
                return result
            row = db.execute("SELECT payload FROM mobile_collections WHERE id=?", (command.collectionId,)).fetchone()
            if row is None:
                fail(404, "collectionNotFound", "PC에서 삭제되었거나 게시되지 않은 작품입니다.")
            now = datetime.now(timezone.utc).isoformat()
            revision = replica_revision(db)
            payload = json.loads(row["payload"])
            if command.field in TRACKING_FIELDS:
                tracking_guard(current, payload, command.field, value)
            present = current_value(command.field, payload, value)
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
                editVersion: int = Query(default=1, ge=1, le=EDIT_VERSION),
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
            if editVersion < EDIT_VERSION and any(r["field"] in TRACKING_FIELDS for r in rows):
                fail(409, "collectionPersonalEditUpgradeRequired", "모바일 편집을 받으려면 PC 앱을 업데이트해 주세요.")
            return {"version": 1, "libraryId": libraryId, "after": after,
                    "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
                    "items": [{"sequence": r["sequence"], "operationId": r["operation_id"],
                               "collectionId": r["collection_id"], "field": r["field"],
                               "value": json.loads(r["value_json"]), "previous": json.loads(r["base_json"]),
                               "createdAt": r["created_at"]} for r in rows]}
