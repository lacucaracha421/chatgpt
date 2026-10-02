"""PC-published classification and saved-X-media snapshots.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import json
from types import ModuleType
from typing import Annotated

from fastapi import HTTPException, Header, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

import authority
import classification_authority
import classification_snapshot


api: ModuleType


# --- Classification snapshot (PC -> VPS publish, extension read) -----------
# The PC Lakomics app owns classification data; the VPS stages the latest published
# snapshot so the mobile extension needs no live PC connection.
#
# Versioning (2A.1, server-first half of the classification rolling upgrade):
#
# * version 1 is the shipped body (`entries` + `published_at`); an absent
#   `snapshotVersion` means 1, so the deployed publisher needs no change;
# * version 2 adds canonical `assignments` and `roles`, and is what a later activation
#   derives authority state from.
#
# The body is read raw rather than through a Pydantic model so the size bound can be
# applied before parsing, and so an absent canonical collection stays distinguishable
# from an explicitly empty one.
MAX_LEGACY_SNAPSHOT_BYTES = 512 * 1024


async def publish_classification_snapshot(
    request: Request,
    authorization: str | None = Header(default=None),
):
    api.require_auth(authorization)

    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > classification_snapshot.MAX_STAGING_BYTES:
                raise HTTPException(status_code=413, detail="Snapshot too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length")

    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > classification_snapshot.MAX_STAGING_BYTES:
            raise HTTPException(status_code=413, detail="Snapshot too large")
        data.extend(chunk)
    if not data:
        raise HTTPException(status_code=422, detail={"code": "invalidClassificationSnapshot",
                                                     "message": "분류 스냅샷을 읽을 수 없습니다."})
    try:
        body = json.loads(data)
    except (ValueError, UnicodeError):
        raise HTTPException(status_code=422, detail={"code": "invalidClassificationSnapshot",
                                                     "message": "분류 스냅샷을 읽을 수 없습니다."})

    # The version decides how strictly the body is validated and how large it may be, so
    # it is resolved before anything else reads the content.
    version = classification_snapshot.resolve_version(body)
    if version < classification_snapshot.AUTHORITY_READY_VERSION:
        # Version 1 keeps its shipped bound and its opaque entries: the deployed
        # publisher is authoritative for its own display shape, and tightening either
        # would be a behavior change to a client this batch must not affect.
        if len(data) > api.MAX_LEGACY_SNAPSHOT_BYTES:
            raise HTTPException(status_code=413, detail="Snapshot too large")

    # Staging stores a validated source, never activated authority state: no
    # `authority_domains` row is written here and the legacy writer is not fenced.
    staged_version, payload, snapshot_digest = classification_snapshot.stage(body)
    incoming_published_at = classification_snapshot._parse_published_at(body["published_at"])

    return await run_in_threadpool(
        _store_classification_snapshot, body, version, payload, snapshot_digest,
        incoming_published_at)


def _store_classification_snapshot(body, version, payload, snapshot_digest, incoming_published_at):
    """Keep the complete SQLite write transaction off the ASGI event loop."""
    with api.get_db() as db:
        # One write transaction covers the authority fence, staleness read and replacement.
        # The fence is inert before cutover; after activation it prevents an old PC
        # snapshot from replacing the canonical hierarchy that activation just adopted.
        db.execute("BEGIN IMMEDIATE")
        try:
            authority.fence_legacy_write(db, classification_authority.DOMAIN)
            row = db.execute(
                "SELECT payload,published_at,revision FROM classification_snapshots WHERE singleton=1"
            ).fetchone()
            revision = 1
            if row is not None:
                decision = classification_snapshot.stale_check(
                    row["published_at"], row["payload"], incoming_published_at, snapshot_digest)
                # The legacy revision counts *display* entry changes and is preserved
                # independently from authority digest identity. Version 2 keeps a
                # legacyEntries sidecar precisely so display-only fields such as
                # assetCount do not disappear or spuriously bump on every publication.
                display_changed = classification_snapshot.entries_changed(
                    row["payload"], body["entries"])
                revision = int(row["revision"]) + int(display_changed)
                if decision == "identical" and not display_changed:
                    # An exact display+canonical retry at the same instant is idempotent.
                    revision = int(row["revision"])
            db.execute(
                """
                INSERT INTO classification_snapshots (singleton, payload, published_at, updated_at, revision)
                VALUES (1, ?, ?, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                    payload = excluded.payload,
                    published_at = excluded.published_at,
                    updated_at = excluded.updated_at,
                    revision = excluded.revision
                """,
                (payload, body["published_at"], api.now_iso(), revision),
            )
            db.commit()
        except BaseException:
            db.rollback()
            raise

    return {"ok": True, "snapshotVersion": version, "snapshotDigest": snapshot_digest,
            "published_at": body["published_at"], "revision": revision}


def get_classification_snapshot(
    authorization: str | None = Header(default=None),
):
    api.require_admin_or_extension(authorization)

    with api.get_db() as db:
        row = db.execute(
            "SELECT payload,revision FROM classification_snapshots WHERE singleton = 1"
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="No classification snapshot published yet")

    # The legacy shape is returned explicitly. A version-2 row keeps its canonical
    # `assignments`/`roles` in the same stored payload, and existing readers must neither
    # receive them nor be required to understand `snapshotVersion`.
    payload = json.loads(row["payload"])
    return {"entries": classification_snapshot.legacy_entries(row["payload"]),
            "published_at": payload.get("published_at"),
            "revision": int(row["revision"])}


def classification_snapshot_meta(
    authorization: str | None = Header(default=None),
):
    api.require_admin_or_extension(authorization)

    with api.get_db() as db:
        row = db.execute(
            "SELECT published_at, updated_at, revision, payload FROM classification_snapshots WHERE singleton = 1"
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="No classification snapshot published yet")

    # `snapshotVersion`/`snapshotDigest` are additive: an older reader that only knows
    # published_at/updated_at/revision keeps working, and a publisher can observe which
    # version the server currently holds before staging a new one.
    payload = json.loads(row["payload"])
    return {"published_at": row["published_at"], "updated_at": row["updated_at"],
            "revision": row["revision"],
            "snapshotVersion": payload.get("snapshotVersion", classification_snapshot.SNAPSHOT_VERSION),
            "snapshotDigest": classification_snapshot.stored_digest(row["payload"])}


# --- Saved X media snapshot (PC -> VPS publish, extension read) ------------

MAX_SAVED_X_MEDIA_KEYS = 20_000


MAX_SAVED_X_MEDIA_KEY_BYTES = 64


MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES = 1024 * 1024


SavedXMediaKey = Annotated[
    str,
    StringConstraints(
        pattern=r"^\d+:[1-9]\d*$",
        max_length=MAX_SAVED_X_MEDIA_KEY_BYTES,
    ),
]


class SavedXMediaSnapshotPublish(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keys: list[SavedXMediaKey] = Field(max_length=MAX_SAVED_X_MEDIA_KEYS)


async def publish_saved_x_media_snapshot(
    request: Request,
    authorization: str | None = Header(default=None),
):
    # The body is streamed against the cap by this route itself, like the command routes,
    # rather than by an application-wide middleware: that middleware buffered the whole
    # upload before checking it, and a client that dropped the connection mid-upload
    # surfaced as an unhandled exception (a traceback and a 500) on every route it wrapped.
    api.require_auth(authorization)
    body = await api.read_bounded_body(request, api.MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES, "Snapshot too large")
    try:
        snapshot = api.SavedXMediaSnapshotPublish.model_validate_json(body)
    except ValidationError as exc:
        raise api.body_validation_error(exc)

    keys = list(dict.fromkeys(snapshot.keys))
    published_at = api.now_iso()
    payload = json.dumps(
        {"keys": keys, "published_at": published_at},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if len(payload.encode("utf-8")) > api.MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES:
        raise HTTPException(status_code=413, detail="Snapshot too large")

    def store():
        with api.get_db() as db:
            db.execute(
                """
                INSERT INTO saved_x_media_snapshots (singleton, payload, published_at, updated_at)
                VALUES (1, ?, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                    payload = excluded.payload,
                    published_at = excluded.published_at,
                    updated_at = excluded.updated_at
                """,
                (payload, published_at, api.now_iso()),
            )
            db.commit()

    await run_in_threadpool(store)
    return {"ok": True, "count": len(keys), "published_at": published_at}


def get_saved_x_media_snapshot(
    authorization: str | None = Header(default=None),
):
    api.require_admin_or_extension(authorization)
    with api.get_db() as db:
        row = db.execute(
            "SELECT payload FROM saved_x_media_snapshots WHERE singleton = 1"
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No saved X media snapshot published yet")
    return json.loads(row["payload"])


def register(app, services):
    global api
    api = services
    app.put("/v1/classifications")(publish_classification_snapshot)
    app.get("/v1/classifications")(get_classification_snapshot)
    app.get("/v1/classifications/meta")(classification_snapshot_meta)
    app.put("/v1/saved-x-media")(publish_saved_x_media_snapshot)
    app.get("/v1/saved-x-media")(get_saved_x_media_snapshot)
