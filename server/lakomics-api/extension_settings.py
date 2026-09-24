"""Small, revisioned collector menu settings in a server-owned library scope.

The current server hosts one user's library. Its extension pairing credentials
identify installations, not users: never key this document by a client id.
The caller supplies the existing extension guard and a trusted scope resolver;
a future multi-library host must resolve scope from the authenticated principal.
"""
import json
import re
from typing import Annotated

from app_lifecycle import lifecycle
from fastapi import Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

MAX_BYTES = 16 * 1024
PATH = "/v1/extension/settings"
DDL = """
CREATE TABLE IF NOT EXISTS extension_settings (
    scope TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    payload TEXT NOT NULL
);
"""
FolderId = Annotated[str, StringConstraints(min_length=1, max_length=240, pattern=r"^\S+$")]


class MenuSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: int = Field(ge=1, le=1)
    listOrder: dict[FolderId, list[FolderId]]
    hiddenClassificationIds: list[FolderId]


class WriteSettings(MenuSettings):
    expectedRevision: int | None = Field(default=None, ge=0, le=9007199254740991)


def register(app, get_db, require_client, *, resolve_scope):
    """Register routes and startup DDL; return startup for isolated fixtures.

    ``require_client(authorization)`` must return an authenticated principal.
    For the collector, wire ``require_admin_or_extension``, not api_auth's
    catalog-only ``client_guard``. ``resolve_scope(principal)`` is server-owned.
    No scope is accepted from a URL, request body, or caller-selected header.
    """
    def startup():
        with get_db() as db:
            db.executescript(DDL)
            db.commit()

    lifecycle(app).on_startup(startup)

    def scope_for(authorization):
        principal = require_client(authorization)
        scope = resolve_scope(principal)
        if not isinstance(scope, str) or not scope or len(scope) > 240:
            raise HTTPException(403, "No extension settings scope")
        return scope

    def read(db, scope):
        row = db.execute(
            "SELECT revision,payload FROM extension_settings WHERE scope=?", (scope,)
        ).fetchone()
        if row is None:
            return {"schemaVersion": 1, "listOrder": {}, "hiddenClassificationIds": [], "revision": 0}
        return {**json.loads(row[1]), "revision": row[0]}

    def headers(revision):
        return {"ETag": f'"{revision}"', "Cache-Control": "private, no-cache"}

    @app.get(PATH)
    def get_settings(authorization: str | None = Header(default=None),
                     if_none_match: str | None = Header(default=None)):
        scope = scope_for(authorization)
        with get_db() as db:
            document = read(db, scope)
        response_headers = headers(document["revision"])
        if if_none_match == response_headers["ETag"]:
            return Response(status_code=304, headers=response_headers)
        return JSONResponse(document, headers=response_headers)

    async def bounded_body(request: Request):
        # Bound the actual stream, including chunked bodies and JSON whitespace,
        # before parsing; Content-Length alone is not an enforcement boundary.
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_BYTES:
                raise HTTPException(413, "Extension settings exceed 16 KiB")
            raw.extend(chunk)
        try:
            return WriteSettings.model_validate_json(bytes(raw))
        except ValidationError as exc:
            raise HTTPException(422, exc.errors(include_input=False, include_context=False)) from exc

    @app.put(PATH)
    def put_settings(body: Annotated[WriteSettings, Depends(bounded_body)],
                     authorization: str | None = Header(default=None),
                     if_match: str | None = Header(default=None)):
        # SQLite lock waits and the existing authentication guard run in
        # FastAPI's worker pool, not in the ASGI event loop.
        scope = scope_for(authorization)
        expected = body.expectedRevision
        if if_match is not None:
            if not re.fullmatch(r'"(0|[1-9][0-9]{0,15})"', if_match):
                raise HTTPException(400, "If-Match must be a quoted revision")
            header_revision = int(if_match[1:-1])
            if expected is not None and expected != header_revision:
                raise HTTPException(400, "Revision preconditions disagree")
            expected = header_revision
        if expected is None:
            raise HTTPException(428, "An expected revision is required")
        payload = body.model_dump(exclude={"expectedRevision"})
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with get_db() as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                current = read(db, scope)
                if current["revision"] != expected:
                    raise HTTPException(409, {"code": "settings_conflict", "revision": current["revision"]})
                revision = expected + 1
                db.execute(
                    """INSERT INTO extension_settings(scope,revision,payload) VALUES(?,?,?)
                    ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload""",
                    (scope, revision, encoded),
                )
                db.commit()
            except BaseException:
                db.rollback()
                raise
        return JSONResponse({**payload, "revision": revision}, headers=headers(revision))

    return startup
