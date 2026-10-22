"""Manga Catalog representative editions chosen on a mobile device (parity U23, 2026-10-22).

The PC owns the representative choice (`online_catalog_group_preferences` in its library,
set from `CatalogEditionsDialog`) and publishes it inside the catalog user snapshot. A
tablet choice is applied here in two steps that commit together:

1. the current publication is republished with the changed preference (the same content
   artifact, a new user snapshot - exactly like ``PUT /visibility``), so every mobile
   reader sees the new representative at once, also while the PC is off;
2. the choice is appended to a small log the PC reads (publisher role), applies to its own
   library and acknowledges. Until then the editions read reports ``representativePending``
   ("PC 반영 대기"). The PC drains the log before it exports a catalog publication, and a
   publication still carries the compare-and-set ``baseRevision``, so a PC publication
   cannot silently drop a tablet choice.

Routes (JSON, ``{"code","message"}`` errors with Korean messages):

* ``POST /v1/mobile-catalog/representatives`` (client) - ``{"version": 1, "operationId":
  UUID, "groupId", "selectedProviderWorkId": "<id>" | null}``; null returns the group to
  automatic selection. Idempotent by ``operationId``.
* ``GET  /v1/mobile-catalog/representatives/pending?limit=`` (publisher) - unacknowledged
  choices in log order.
* ``POST /v1/mobile-catalog/representatives/acknowledge`` (publisher) - ``{"version": 1,
  "through": <sequence>}``.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

import mobile_catalog_replica as replica

PREFIX = "/v1/mobile-catalog/representatives"
MAX_BODY_BYTES = 4096
MAX_SEQUENCE = 9_007_199_254_740_991
RETAINED = 500  # acknowledged rows kept for idempotent replays

DDL = """
CREATE TABLE IF NOT EXISTS catalog_representative_log(
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL,
 handle TEXT NOT NULL, group_id TEXT NOT NULL, anchor_work_id TEXT NOT NULL, selected_work_id TEXT,
 created_at TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_representative_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), acknowledged_through INTEGER NOT NULL);
INSERT OR IGNORE INTO catalog_representative_state VALUES(1,0);
"""


class Choice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    operationId: str = Field(min_length=36, max_length=36)
    groupId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    selectedProviderWorkId: str | None = Field(default=None, pattern=r"^[1-9][0-9]{0,18}$")


class Acknowledge(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    through: int = Field(ge=0, le=MAX_SEQUENCE)


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


def startup_db(db):
    db.executescript(DDL)
    db.commit()


def _state(db):
    last = db.execute("SELECT COALESCE(MAX(sequence),0) FROM catalog_representative_log").fetchone()[0]
    acknowledged = db.execute("SELECT acknowledged_through FROM catalog_representative_state WHERE singleton=1").fetchone()[0]
    return last, acknowledged


def status_head(db):
    """Log head for ``/v1/sync/status`` ``publisherLogs.catalogRepresentatives``."""
    try:
        return _state(db)[0]
    except Exception:
        return None


def pending_for(db, handle, group_id):
    """Whether a tablet choice for this group still waits for the PC."""
    row = db.execute("""SELECT EXISTS(SELECT 1 FROM catalog_representative_log, catalog_representative_state s
        WHERE s.singleton=1 AND sequence>s.acknowledged_through AND (handle=? OR group_id=?))""",
                     (handle, group_id)).fetchone()
    return bool(row[0])


def _effective(db, group_id):
    row = db.execute("""SELECT p.selected_work_id FROM online_catalog_group_preferences p
        JOIN online_catalog_group_members a ON a.provider=p.provider AND a.work_id=p.anchor_work_id
        WHERE a.provider='kHentai' AND a.group_id=? ORDER BY p.edit_revision DESC LIMIT 1""", (group_id,)).fetchone()
    return row[0] if row else None


def _with_choice(users, anchor, selected):
    preferences = [row for row in users["preferences"] if not (row[0] == "kHentai" and row[1] == anchor)]
    revision = max([row[3] for row in users["preferences"]] or [0]) + 1
    preferences.append(["kHentai", anchor, selected, revision])
    preferences.sort(key=replica.encode)
    return {**users, "preferences": preferences}


async def _bounded(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY_BYTES:
            fail(413, "representativeTooLarge", "요청이 너무 큽니다.")
    return bytes(raw)


def register(app, get_db, root, require_client, require_publisher, on_published=None):
    """Install the routes; the caller runs :func:`startup_db` with its other catalog tables."""

    def replay(operation_id, digest):
        with get_db() as db:
            row = db.execute("SELECT payload_digest,result_json FROM catalog_representative_log WHERE operation_id=?",
                             (operation_id,)).fetchone()
        if row is None:
            return None
        if row[0] != digest:
            fail(409, "operationConflict", "다른 내용으로 요청을 재사용할 수 없습니다.")
        return json.loads(row[1])

    def choose(choice):
        try:
            if str(uuid.UUID(choice.operationId)) != choice.operationId:
                raise ValueError()
        except ValueError:
            fail(422, "invalidRepresentative", "요청 식별자가 올바르지 않습니다.")
        digest = hashlib.sha256(replica.encode(choice.model_dump()).encode()).hexdigest()
        for attempt in range(3):
            stored = replay(choice.operationId, digest)
            if stored is not None:
                return stored
            with get_db() as db:
                if replica.current(db) is None:
                    fail(409, "catalogUnavailable", "카탈로그가 아직 공유되지 않았습니다.")
            with replica.open_publication(root(), get_db) as (db, publication):
                group = db.execute("""SELECT m.group_id,h.anchor_work_id FROM online_catalog_group_handles h
                    JOIN online_catalog_group_members m ON m.provider=h.provider AND m.work_id=h.anchor_work_id
                    WHERE h.provider='kHentai' AND h.group_id=?""", (choice.groupId,)).fetchone()
                if group is None:
                    fail(404, "catalogGroupMissing", "작품을 찾을 수 없습니다. 새로고침해 주세요.")
                group_id, anchor = group
                selected = choice.selectedProviderWorkId
                if selected is not None and not db.execute("""SELECT EXISTS(SELECT 1 FROM online_catalog_group_members
                        WHERE provider='kHentai' AND group_id=? AND work_id=?)""", (group_id, selected)).fetchone()[0]:
                    fail(422, "notAnEdition", "이 작품의 판본이 아닙니다.")
                unchanged = _effective(db, group_id) == selected
            with get_db() as db:
                users = json.loads(db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?",
                                              (publication["user_revision"],)).fetchone()[0])
                pending = pending_for(db, choice.groupId, group_id)
            if unchanged:
                return {"version": 1, "operationId": choice.operationId, "sequence": None, "groupId": choice.groupId,
                        "selectedProviderWorkId": selected, "publicationRevision": publication["revision"],
                        "pending": pending}

            def record(db, revision):
                result = {"version": 1, "operationId": choice.operationId, "groupId": choice.groupId,
                          "selectedProviderWorkId": selected, "publicationRevision": revision, "pending": True}
                cursor = db.execute("""INSERT INTO catalog_representative_log(operation_id,payload_digest,handle,group_id,
                    anchor_work_id,selected_work_id,created_at,result_json) VALUES(?,?,?,?,?,?,?,'{}')""",
                                    (choice.operationId, digest, choice.groupId, group_id, anchor, selected,
                                     datetime.now(timezone.utc).isoformat()))
                result["sequence"] = cursor.lastrowid
                db.execute("UPDATE catalog_representative_log SET result_json=? WHERE sequence=?",
                           (json.dumps(result), cursor.lastrowid))

            try:
                replica.publish({"version": 1, "baseRevision": publication["revision"],
                                 "contentDigest": publication["content_digest"],
                                 "userSnapshot": _with_choice(users, anchor, selected)}, root(), get_db, finalize=record)
            except HTTPException as error:
                # Another publication (PC, refresh, another choice) won the race: start over.
                if error.status_code != 409 or attempt == 2:
                    raise
                continue
            except Exception:
                # A concurrent replay of the same operation committed first.
                if replay(choice.operationId, digest) is None:
                    raise
            if on_published is not None:
                on_published()
            return replay(choice.operationId, digest)
        fail(409, "catalogChanged", "카탈로그가 바뀌었습니다. 다시 시도해 주세요.")

    @app.post(PREFIX)
    async def representative(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await _bounded(request)
        try:
            choice = Choice.model_validate_json(body)
        except (ValidationError, ValueError):
            fail(422, "invalidRepresentative", "대표 판본 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(choose, choice)

    @app.get(PREFIX + "/pending")
    def pending(limit: int = Query(default=100, ge=1, le=200), authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            last, acknowledged = _state(db)
            rows = db.execute("""SELECT sequence,handle,group_id,anchor_work_id,selected_work_id,created_at
                FROM catalog_representative_log WHERE sequence>? ORDER BY sequence LIMIT ?""",
                              (acknowledged, limit + 1)).fetchall()
            db.rollback()
        return {"version": 1, "lastSequence": last, "acknowledgedThrough": acknowledged,
                "hasMore": len(rows) > limit,
                "items": [{"sequence": r[0], "groupId": r[1], "memberGroupId": r[2], "anchorWorkId": r[3],
                           "selectedProviderWorkId": r[4], "createdAt": r[5]} for r in rows[:limit]]}

    def acknowledge(command):
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            last, acknowledged = _state(db)
            if command.through > last:
                fail(409, "representativeCursorRejected", "대표 판본 동기화 위치를 확인해 주세요.")
            through = max(acknowledged, command.through)
            db.execute("UPDATE catalog_representative_state SET acknowledged_through=? WHERE singleton=1", (through,))
            db.execute("DELETE FROM catalog_representative_log WHERE sequence<=? AND sequence<=?",
                       (through, last - RETAINED))
            db.commit()
        return {"version": 1, "acknowledgedThrough": through, "lastSequence": last}

    @app.post(PREFIX + "/acknowledge")
    async def acknowledge_route(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await _bounded(request)
        try:
            command = Acknowledge.model_validate_json(body)
        except (ValidationError, ValueError):
            fail(422, "invalidRepresentative", "확인 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(acknowledge, command)
