"""Optional subtitle cache shared by paired extensions in a library scope."""
import json
import time
import zlib
from typing import Annotated, Literal

from app_lifecycle import lifecycle
from fastapi import Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator

PATH = "/v1/extension/subtitles"
MAX_BYTES = 4 * 1024 * 1024
DDL = """
CREATE TABLE IF NOT EXISTS extension_subtitles (
    scope TEXT NOT NULL,
    video TEXT NOT NULL,
    track TEXT NOT NULL,
    mode TEXT NOT NULL,
    payload BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(scope, video, track, mode)
);
CREATE INDEX IF NOT EXISTS extension_subtitles_scope_video
    ON extension_subtitles(scope, video);
"""
Video = Annotated[str, StringConstraints(pattern=r"\A[A-Za-z0-9_-]{6,20}\z")]
Track = Annotated[str, StringConstraints(max_length=40, pattern=r"\A[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\z")]
Mode = Annotated[str, StringConstraints(max_length=80, pattern=r"\A[\x20-\x7e]*\z")]


class CacheKey(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    video: Video
    track: Track
    mode: Mode


class Cue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    startMs: int = Field(ge=0)
    endMs: int = Field(ge=0)
    text: str = Field(max_length=500)
    orig: str | None = Field(default=None, max_length=500)

    @field_validator("endMs")
    @classmethod
    def ordered_times(cls, value, info):
        if "startMs" in info.data and value < info.data["startMs"]:
            raise ValueError("endMs precedes startMs")
        return value

    @field_validator("orig")
    @classmethod
    def original_text(cls, value):
        if value is None:
            raise ValueError("orig must be a string when supplied")
        return value


class GlossaryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: str = Field(max_length=80)
    korean: str = Field(max_length=80)


class WriteSubtitles(CacheKey):
    model: str = Field(max_length=80)
    createdAt: int
    # "register" would shadow a pydantic BaseModel attribute and silently become optional.
    speech_register: Literal["haeyo", "hapnida", "banmal"] | None = Field(alias="register")
    glossary: list[GlossaryEntry] = Field(max_length=240)
    cues: list[Cue] = Field(min_length=1, max_length=20000)


def register(app, get_db, require_client, *, resolve_scope):
    """Use the settings credential/scope boundary and idempotent startup DDL."""
    def startup():
        with get_db() as db:
            db.executescript(DDL)
            db.commit()

    lifecycle(app).on_startup(startup)

    def scope_for(authorization):
        principal = require_client(authorization)
        scope = resolve_scope(principal)
        if not isinstance(scope, str) or not scope or len(scope) > 240:
            raise HTTPException(403, "No extension subtitles scope")
        return scope

    @app.get(PATH)
    def get_subtitles(video: str | None = None, track: str | None = None,
                      mode: str | None = None, authorization: str | None = Header(default=None)):
        scope = scope_for(authorization)
        try:
            key = CacheKey.model_validate({"video": video, "track": track, "mode": mode})
        except ValidationError:
            return JSONResponse({"code": "invalid"}, status_code=400)
        with get_db() as db:
            row = db.execute(
                "SELECT payload FROM extension_subtitles WHERE scope=? AND video=? AND track=? AND mode=?",
                (scope, key.video, key.track, key.mode),
            ).fetchone()
        if row is None:
            return JSONResponse({"code": "not_found"}, status_code=404)
        return JSONResponse(json.loads(zlib.decompress(row[0])), headers={"Cache-Control": "private, no-cache"})

    async def bounded_body(request: Request):
        # Enforce bytes on the stream, including whitespace/chunked requests.
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_BYTES:
                return JSONResponse({"code": "too_large"}, status_code=413)
            raw.extend(chunk)
        try:
            return WriteSubtitles.model_validate_json(bytes(raw))
        except ValidationError:
            return JSONResponse({"code": "invalid"}, status_code=400)

    @app.put(PATH)
    def put_subtitles(body: Annotated[WriteSubtitles | JSONResponse, Depends(bounded_body)],
                      authorization: str | None = Header(default=None)):
        # The guard, compression and SQLite work stay in FastAPI's worker pool.
        scope = scope_for(authorization)
        if isinstance(body, JSONResponse):
            return body
        document = {"version": 1, **body.model_dump(by_alias=True, exclude_unset=True)}
        payload = zlib.compress(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        now = time.time_ns() // 1_000_000
        with get_db() as db:
            db.execute(
                """INSERT INTO extension_subtitles(scope,video,track,mode,payload,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,video,track,mode) DO UPDATE SET
                payload=excluded.payload,updated_at=excluded.updated_at""",
                (scope, body.video, body.track, body.mode, payload, now, now),
            )
            db.commit()
        return {"ok": True}

    @app.delete(PATH)
    def delete_subtitles(authorization: str | None = Header(default=None)):
        scope = scope_for(authorization)
        with get_db() as db:
            deleted = db.execute("DELETE FROM extension_subtitles WHERE scope=?", (scope,)).rowcount
            db.commit()
        return {"ok": True, "deleted": deleted}

    return startup
