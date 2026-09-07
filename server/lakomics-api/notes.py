"""Opaque encrypted notes. Revisions prevent silent multi-device overwrites."""
import json
from datetime import datetime, timezone
from typing import Annotated

from fastapi import Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ID = Annotated[str, StringConstraints(pattern=r"^[a-f0-9-]{32,64}$")]
HEX = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]+$")]


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, le=1)
    nonce: HEX = Field(min_length=24, max_length=24)
    ciphertext: HEX = Field(min_length=32, max_length=600000)


class WriteNote(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedRevision: int = Field(ge=0)
    operationId: ID
    payload: Envelope


def register_notes(app, get_db, require_auth):
    def startup_notes():
        with get_db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS notes (
                  vault TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
                  operation_id TEXT NOT NULL, payload TEXT NOT NULL,
                  sequence INTEGER NOT NULL, updated_at TEXT NOT NULL,
                  PRIMARY KEY(vault,id));
                CREATE INDEX IF NOT EXISTS notes_changes ON notes(vault,sequence);
                CREATE TABLE IF NOT EXISTS notes_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value INTEGER NOT NULL);
                INSERT OR IGNORE INTO notes_sequence VALUES(1,0);
            """)

    app.on_event("startup")(startup_notes)

    def public(row):
        return {"id": row["id"], "revision": row["revision"],
                "operationId": row["operation_id"], "payload": json.loads(row["payload"]),
                "sequence": row["sequence"], "updatedAt": row["updated_at"]}

    @app.get("/v1/notes/{vault}")
    def changes(vault: ID, after: int = Query(default=0, ge=0),
                limit: int = Query(default=50, ge=1, le=50),
                authorization: str | None = Header(default=None)):
        require_auth(authorization)
        with get_db() as db:
            rows = db.execute("SELECT * FROM notes WHERE vault=? AND sequence>? ORDER BY sequence LIMIT ?",
                              (vault, after, limit + 1)).fetchall()
        page = rows[:limit]
        return {"items": [public(row) for row in page],
                "nextCursor": page[-1]["sequence"] if len(rows) > limit else None}

    @app.put("/v1/notes/{vault}/{note_id}")
    def put(vault: ID, note_id: ID, body: WriteNote,
            authorization: str | None = Header(default=None)):
        require_auth(authorization)
        payload = json.dumps(body.payload.model_dump(), separators=(",", ":"), sort_keys=True)
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM notes WHERE vault=? AND id=?", (vault, note_id)).fetchone()
            if row and row["operation_id"] == body.operationId:
                if row["payload"] != payload:
                    raise HTTPException(409, "Operation payload differs")
                return public(row)
            revision = row["revision"] if row else 0
            if revision != body.expectedRevision:
                raise HTTPException(409, "Note changed on another device")
            db.execute("UPDATE notes_sequence SET value=value+1 WHERE singleton=1")
            sequence = db.execute("SELECT value FROM notes_sequence WHERE singleton=1").fetchone()[0]
            db.execute("""INSERT INTO notes VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault,id) DO UPDATE SET
                revision=excluded.revision,operation_id=excluded.operation_id,payload=excluded.payload,
                sequence=excluded.sequence,updated_at=excluded.updated_at""",
                (vault, note_id, revision + 1, body.operationId, payload, sequence,
                 datetime.now(timezone.utc).isoformat()))
            result = public(db.execute("SELECT * FROM notes WHERE vault=? AND id=?", (vault, note_id)).fetchone())
            db.commit()
            return result

    return startup_notes
