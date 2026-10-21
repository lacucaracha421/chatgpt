"""Server-owned favourite characters shared by the PC and tablet.

Per-id commands merge into the latest document in one transaction: add appends
missing ids without changing existing data, remove drops ids, and order moves
listed ids still present ahead of the remaining entries. Update replaces each
supplied payload field as a whole and never brings back a removed character.
Unknown character ids are preserved; clients hide characters that no longer exist.

GET /v1/library/favorite-characters returns {version: 1, revision, entries} with
an ETag. POST accepts {commands: [...]} and returns the same document. Both use
the client credential. Revision 0 means never written; only a changed document
increments the revision. Signal: signals.favoriteCharacters = stored revision.
"""
import json
from typing import Annotated, Literal

import conditional
from app_lifecycle import lifecycle
from fastapi import Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

PREFIX = "/v1/library/favorite-characters"
MAX_ENTRIES = 300

CharacterId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
WorkId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_:.-]{1,128}$")]
ShortText = Annotated[str, StringConstraints(max_length=120)]

DDL = """
CREATE TABLE IF NOT EXISTS favorite_characters (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>=1),
    payload TEXT NOT NULL
);
"""


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    originalName: ShortText | None = None
    birthMonth: int | None = Field(default=None, ge=1, le=12)
    birthDay: int | None = Field(default=None, ge=1, le=31)
    heightCm: float | None = Field(default=None, ge=30, le=300)
    voiceActor: ShortText | None = None
    affiliation: ShortText | None = None
    memo: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def paired_birthday(self):
        if (self.birthMonth is None) != (self.birthDay is None):
            raise ValueError("birthMonth and birthDay must both be set or both be absent")
        return self


class UpdateFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    coverAssetId: CharacterId | None = None
    coverY: float = Field(default=50, ge=0, le=100)
    profile: Profile = Field(default_factory=Profile)
    workIds: list[WorkId] = Field(default_factory=list, max_length=30)
    extraWorks: list[ShortText] = Field(default_factory=list, max_length=30)


class ListCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["add", "remove", "order"]
    ids: list[CharacterId] = Field(max_length=MAX_ENTRIES)


class UpdateCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["update"]
    id: CharacterId
    set: UpdateFields


Command = Annotated[ListCommand | UpdateCommand, Field(discriminator="op")]


class Commands(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commands: list[Command] = Field(min_length=1, max_length=20)


def _stored(db):
    row = db.execute("SELECT revision,payload FROM favorite_characters WHERE singleton=1").fetchone()
    if row is None:
        return 0, []
    return row[0], json.loads(row[1])


def status_signal(db):
    """The stored revision, or 0 before the first write."""
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='favorite_characters'").fetchone() is None:
        return 0
    row = db.execute("SELECT revision FROM favorite_characters WHERE singleton=1").fetchone()
    return row[0] if row else 0


def apply(entries, command):
    """Return the entries after one command, without mutating the input."""
    if command.op == "update":
        changes = command.set.model_dump(exclude_unset=True)
        return [entry | changes if entry["characterId"] == command.id else entry for entry in entries]
    if command.op == "add":
        known = {entry["characterId"] for entry in entries}
        return entries + [
            {"characterId": id, "coverAssetId": None, "coverY": 50,
             "profile": {}, "workIds": [], "extraWorks": []}
            for id in dict.fromkeys(command.ids) if id not in known]
    if command.op == "remove":
        drop = set(command.ids)
        return [entry for entry in entries if entry["characterId"] not in drop]
    present = {entry["characterId"]: entry for entry in entries}
    first = [id for id in dict.fromkeys(command.ids) if id in present]
    chosen = set(first)
    return [present[id] for id in first] + [entry for entry in entries if entry["characterId"] not in chosen]


def register(app, get_db, require_client):
    def startup():
        with get_db() as db:
            db.executescript(DDL)
            db.commit()

    lifecycle(app).on_startup(startup)

    def document(db):
        revision, entries = _stored(db)
        return {"version": 1, "revision": revision, "entries": entries}

    @app.get(PREFIX)
    def get_characters(authorization: str | None = Header(default=None),
                       if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            return conditional.json_response(document(db), if_none_match)

    @app.post(PREFIX)
    def change_characters(body: Commands, authorization: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                revision, current = _stored(db)
                entries = current
                for command in body.commands:
                    entries = apply(entries, command)
                if len(entries) > MAX_ENTRIES:
                    raise HTTPException(409, {"code": "favoriteCharactersFull"})
                if entries != current:
                    db.execute(
                        "INSERT INTO favorite_characters(singleton,revision,payload) VALUES(1,?,?) "
                        "ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
                        (revision + 1, json.dumps(entries, separators=(",", ":"))))
                db.commit()
            except BaseException:
                db.rollback()
                raise
            return conditional.json_response(document(db))

    return startup
