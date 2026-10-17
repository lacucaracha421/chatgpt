"""Shared folder pins ("폴더 고정"): one ordered list of classification ids, server-owned.

The PC sidebar and the tablet both pin folders. The list lives here, so a pin made on one
device shows on the other. It is a small revisioned document (the shape of the extension
settings and notes documents), but edited with per-id commands instead of a whole-document
write, so two devices that edit at once merge instead of conflicting:

* ``add``    appends the ids that are not pinned yet; an id that is already pinned stays where it is.
* ``remove`` drops the ids; an id that is not pinned is ignored.
* ``order``  puts the listed ids that are still pinned in the listed order, ahead of every other
  pin (a pin another device added meanwhile keeps its place after them, an id that was
  unpinned meanwhile is not brought back).

Commands are idempotent, so a client may replay a request whose answer it lost. The revision
moves only when the list really changed, which keeps ``signals.folderPins`` (the tablet's
status long-poll) quiet for no-op writes.

1. ``GET /v1/library/folder-pins`` (client or shared token): ``{"version": 1, "revision",
   "pinnedIds"}`` with an ETag. ``revision`` 0 means the list was never written, which is
   how a PC knows it may import its own local pins once. Ids of folders that no longer exist
   are left out of the answer, and any write drops them from storage and refuses to pin an
   unknown folder (the folder tree is server-owned, so a new folder is known here before any
   device can pin it). While no folder list is known nothing is filtered.
2. ``POST /v1/library/folder-pins`` (client): ``{"commands": [{"op", "ids"}, ...]}``, applied in
   order in one transaction; answers the same document as the GET.

Signal: ``signals.folderPins`` = the stored revision.
"""
import json
from typing import Annotated, Literal

import conditional
from app_lifecycle import lifecycle
from fastapi import Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

PREFIX = "/v1/library/folder-pins"
MAX_PINS = 300

FolderId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]

DDL = """
CREATE TABLE IF NOT EXISTS folder_pins (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>=1),
    payload TEXT NOT NULL
);
"""


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["add", "remove", "order"]
    ids: list[FolderId] = Field(max_length=MAX_PINS)


class Commands(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commands: list[Command] = Field(min_length=1, max_length=20)


def _stored(db):
    row = db.execute("SELECT revision,payload FROM folder_pins WHERE singleton=1").fetchone()
    if row is None:
        return 0, []
    return row[0], json.loads(row[1])


def status_signal(db):
    """``signals.folderPins``: the stored revision (0 until the list is first written)."""
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='folder_pins'").fetchone() is None:
        return 0
    row = db.execute("SELECT revision FROM folder_pins WHERE singleton=1").fetchone()
    return row[0] if row else 0


def stored_pins(db):
    """The stored list, or ``None`` while it was never written (callers keep their own fallback)."""
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='folder_pins'").fetchone() is None:
        return None
    revision, ids = _stored(db)
    return ids if revision else None


def apply(pins, command):
    """The list after one command; pure so the merge rules are visible in one place."""
    if command.op == "add":
        known = set(pins)
        return pins + [id for id in dict.fromkeys(command.ids) if id not in known]
    if command.op == "remove":
        drop = set(command.ids)
        return [id for id in pins if id not in drop]
    pinned = set(pins)
    first = [id for id in dict.fromkeys(command.ids) if id in pinned]
    chosen = set(first)
    return first + [id for id in pins if id not in chosen]


def register(app, get_db, require_client, folder_ids):
    """Register the routes; ``folder_ids(db)`` is the set of existing folder ids, or None when unknown."""
    def startup():
        with get_db() as db:
            db.executescript(DDL)
            db.commit()

    lifecycle(app).on_startup(startup)

    def document(db):
        revision, ids = _stored(db)
        existing = folder_ids(db)
        if existing:
            ids = [id for id in ids if id in existing]
        return {"version": 1, "revision": revision, "pinnedIds": ids}

    @app.get(PREFIX)
    def get_pins(authorization: str | None = Header(default=None),
                 if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            return conditional.json_response(document(db), if_none_match)

    @app.post(PREFIX)
    def change_pins(body: Commands, authorization: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                revision, current = _stored(db)
                pins = current
                for command in body.commands:
                    pins = apply(pins, command)
                existing = folder_ids(db)
                if existing:
                    pins = [id for id in pins if id in existing]
                if len(pins) > MAX_PINS:
                    raise HTTPException(409, {"code": "folderPinsFull"})
                if pins != current:
                    db.execute(
                        "INSERT INTO folder_pins(singleton,revision,payload) VALUES(1,?,?) "
                        "ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
                        (revision + 1, json.dumps(pins, separators=(",", ":"))))
                db.commit()
            except BaseException:
                db.rollback()
                raise
            return conditional.json_response(document(db))

    return startup
