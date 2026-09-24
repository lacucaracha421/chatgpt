"""PC <-> tablet file exchange (보내기/받기), separate from the Library.

One transfer is one file sent from one registered device to another. The server
holds metadata only: bytes go straight to R2 under ``exchange/<toDevice>/<id>``
through presigned URLs, so the VPS never proxies a file body. The object is
deleted as soon as the receiver acknowledges it; undelivered files expire after
24 h and finished rows (the sender's history) are pruned after 7 days.

Identity is per device *and* per credential. Only provisioned ``api_clients``
tokens may use the exchange: the legacy shared token is refused, because a
shared credential cannot keep one device from reading another device's inbox.
A device id is client-generated and bound to the principal that registered it;
every later request acting as that device must come from the same principal.

States: ``uploading -> ready -> delivered``; side exits ``failed``, ``expired``
and ``cancelled``. Every terminal row has its object deleted, tracked by
``object_deleted_at`` so :func:`sweep` retries a failed best-effort delete.

Change notification: a global sequence is bumped on each change, and every
affected device records the new value as its ``revision``. A device's revision
is therefore monotonic, and the maximum over a principal's devices changes
whenever any of them changes (:func:`status`), which ``/v1/sync/status`` exposes.
"""
import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
from typing import Annotated, Literal

from fastapi import Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import api_auth
import conditional
from app_lifecycle import lifecycle

LOG = logging.getLogger("lakomics.file_exchange")

PREFIX = "/v1/exchange"
OBJECT_PREFIX = "exchange/"
GIB = 1024 ** 3
MAX_FILE_BYTES = 2 * GIB
MAX_OUTSTANDING_BYTES = 10 * GIB
MAX_OUTSTANDING_TRANSFERS = 1000
MAX_BATCH_FILES = 100
MAX_BODY_BYTES = 16 * 1024
MAX_FILE_NAME_BYTES = 255
MAX_DEVICES = 20
UPLOAD_URL_SECONDS = 900
TICKET_SECONDS = 600
UPLOADING_TTL_SECONDS = 2 * 3600
READY_TTL_SECONDS = 24 * 3600
HISTORY_SECONDS = 7 * 24 * 3600
LAST_SEEN_RESOLUTION_SECONDS = 300
INBOX_LIMIT = 100
OUTBOX_LIMIT = 200
ORPHAN_SCAN_LIMIT = 1000
SWEEP_INTERVAL_SECONDS = 600
SWEEP_INITIAL_DELAY_SECONDS = 30
SWEEP_ENV = "LAKOMICS_EXCHANGE_SWEEP_ENABLED"
OBJECT_CONTENT_TYPE = "application/octet-stream"

LIVE = ("uploading", "ready")
TERMINAL = ("delivered", "failed", "expired", "cancelled")

UUID = Annotated[str, StringConstraints(
    pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
SHA256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
MIME = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9!#$&^_.+-]{1,63}/[A-Za-z0-9!#$&^_.+-]{1,63}$")]
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

DDL = """
CREATE TABLE IF NOT EXISTS exchange_devices(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pc','android')),
 principal TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 revoked_at TEXT, revision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS exchange_devices_principal ON exchange_devices(principal);
CREATE TABLE IF NOT EXISTS exchange_transfers(
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, from_device TEXT NOT NULL, to_device TEXT NOT NULL,
 file_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
 content_type_hint TEXT, state TEXT NOT NULL CHECK(state IN
  ('uploading','ready','delivered','failed','expired','cancelled')),
 object_key TEXT NOT NULL, request_digest TEXT NOT NULL, created_at TEXT NOT NULL,
 ready_at TEXT, expires_at TEXT NOT NULL, delivered_at TEXT, finished_at TEXT,
 object_deleted_at TEXT, failure TEXT);
CREATE INDEX IF NOT EXISTS exchange_transfers_inbox ON exchange_transfers(to_device,state,created_at);
CREATE INDEX IF NOT EXISTS exchange_transfers_outbox ON exchange_transfers(from_device,created_at);
CREATE INDEX IF NOT EXISTS exchange_transfers_expiry ON exchange_transfers(state,expires_at);
CREATE TABLE IF NOT EXISTS exchange_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO exchange_state VALUES(1,0);
"""


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def fail(status, code, message, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra})


def startup_db(db):
    db.executescript(api_auth.DDL)
    db.executescript(DDL)
    db.commit()


# --- names ------------------------------------------------------------------

# Bidi embeddings/overrides/isolates and marks: they let "gpj.exe" render as "exe.jpg".
_INVISIBLE = frozenset([*range(0x202A, 0x202F), *range(0x2066, 0x206A), 0x200E, 0x200F, 0x061C])


def _visible(text):
    return "".join(ch for ch in unicodedata.normalize("NFC", text)
                   if not (ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F or ord(ch) in _INVISIBLE))


def _truncate_utf8(text, limit):
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def sanitize_file_name(raw):
    """The stored leaf name, or None when nothing usable remains.

    Receivers sanitise again for their own filesystem; this is the portable part:
    NFC, no control or bidi characters, basename only, at most 255 UTF-8 bytes
    with a short extension kept.
    """
    name = re.split(r"[/\\]", _visible(raw))[-1].strip()
    if name in ("", ".", ".."):
        return None
    if len(name.encode("utf-8")) > MAX_FILE_NAME_BYTES:
        stem, dot, extension = name.rpartition(".")
        if dot and stem and 0 < len(extension.encode("utf-8")) <= 32:
            keep = MAX_FILE_NAME_BYTES - len(extension.encode("utf-8")) - 1
            name = _truncate_utf8(stem, keep).rstrip() + "." + extension
        else:
            name = _truncate_utf8(name, MAX_FILE_NAME_BYTES).rstrip()
    return name or None


def sanitize_device_name(raw):
    name = " ".join(_visible(raw).split())
    return name[:64] or None


# --- request bodies ---------------------------------------------------------

class DeviceBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["pc", "android"]


class CreateTransfer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    transferId: UUID
    batchId: UUID | None = None
    toDevice: UUID
    fileName: str = Field(min_length=1, max_length=1024)
    sizeBytes: int = Field(ge=0)
    sha256: SHA256
    contentTypeHint: MIME | None = None


class Ack(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sha256: SHA256


async def _body(request, model):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY_BYTES:
            fail(413, "exchangeRequestTooLarge", "요청이 너무 큽니다.")
    try:
        return model.model_validate_json(bytes(raw))
    except ValidationError:
        fail(422, "invalidExchangeRequest", "파일 전송 요청을 확인할 수 없습니다.")


# --- revision ---------------------------------------------------------------

def bump(db, device_ids=None):
    """Advance the global sequence and stamp it on the affected devices (all live ones if None)."""
    db.execute("UPDATE exchange_state SET revision=revision+1 WHERE singleton=1")
    revision = db.execute("SELECT revision FROM exchange_state WHERE singleton=1").fetchone()[0]
    if device_ids is None:
        db.execute("UPDATE exchange_devices SET revision=? WHERE revoked_at IS NULL", [revision])
    else:
        ids = sorted(set(device_ids))
        db.execute(f"UPDATE exchange_devices SET revision=? WHERE id IN ({','.join('?' * len(ids))})",
                   [revision, *ids])
    return revision


def status(db, principal):
    """``{"revision": n}`` for ``/v1/sync/status``, or None for callers that cannot use the exchange."""
    if principal == api_auth.LEGACY_CLIENT:
        return None
    row = db.execute("SELECT MAX(revision) FROM exchange_devices WHERE principal=? AND revoked_at IS NULL",
                     [principal]).fetchone()
    return {"revision": row[0] or 0}


# --- views ------------------------------------------------------------------

def device_view(row, self_id=None):
    return {"deviceId": row["id"], "name": row["name"], "kind": row["kind"],
            "lastSeenAt": row["last_seen_at"], "self": row["id"] == self_id}


def transfer_view(row, names):
    return {"transferId": row["id"], "batchId": row["batch_id"],
            "fromDevice": row["from_device"], "fromName": names.get(row["from_device"]),
            "toDevice": row["to_device"], "toName": names.get(row["to_device"]),
            "fileName": row["file_name"], "sizeBytes": row["size_bytes"], "sha256": row["sha256"],
            "contentTypeHint": row["content_type_hint"], "state": row["state"],
            "createdAt": row["created_at"], "readyAt": row["ready_at"], "expiresAt": row["expires_at"],
            "deliveredAt": row["delivered_at"], "finishedAt": row["finished_at"], "failure": row["failure"]}


def _names(db, rows):
    ids = sorted({row[key] for row in rows for key in ("from_device", "to_device")})
    if not ids:
        return {}
    return {r["id"]: r["name"] for r in db.execute(
        f"SELECT id,name FROM exchange_devices WHERE id IN ({','.join('?' * len(ids))})", ids)}


def _one(db, row):
    return transfer_view(row, _names(db, [row]))


def _live_device(db, device_id):
    """A registered, unrevoked device whose credential is still live."""
    return db.execute(
        "SELECT d.* FROM exchange_devices d JOIN api_clients c ON c.id=d.principal "
        "WHERE d.id=? AND d.revoked_at IS NULL AND c.revoked_at IS NULL", [device_id]).fetchone()


def _delete_objects(get_db, storage, bucket, keys, clock):
    """Best effort, outside any transaction; the sweeper retries what fails."""
    for key in keys:
        if not key.startswith(OBJECT_PREFIX):
            continue
        try:
            storage().delete_object(Bucket=bucket(), Key=key)
        except Exception as exc:  # noqa: BLE001 - the sweeper retries
            LOG.warning("Exchange object delete deferred: %s", type(exc).__name__)
            continue
        with get_db() as db:
            db.execute("UPDATE exchange_transfers SET object_deleted_at=? "
                       "WHERE object_key=? AND state IN (?,?,?,?) AND object_deleted_at IS NULL",
                       [iso(clock()), key, *TERMINAL])
            db.commit()


def register(app, get_db, require_client, storage, bucket, presign_put, *, clock=time.time):
    """Install the exchange routes. ``storage``/``bucket`` are callables (late-bound R2 client).

    ``require_client`` is ``api_auth.client_guard(...)``; its legacy principal is refused here.
    Returns the startup hook, which only creates empty tables.
    """

    def startup():
        with get_db() as db:
            startup_db(db)

    lifecycle(app).on_startup(startup)

    def principal_of(authorization):
        principal = require_client(authorization)
        if principal == api_auth.LEGACY_CLIENT:
            fail(403, "exchangeDeviceTokenRequired", "이 기기 전용 토큰이 필요합니다.")
        return principal

    def caller(authorization, device_id):
        """(principal, device row) for a registered device owned by the caller's credential."""
        principal = principal_of(authorization)
        if not device_id or not _UUID_RE.match(device_id):
            fail(400, "exchangeDeviceRequired", "기기 식별자가 필요합니다.")
        now = clock()
        with get_db() as db:
            row = db.execute("SELECT * FROM exchange_devices WHERE id=?", [device_id]).fetchone()
            if row is None or row["revoked_at"] is not None:
                fail(404, "exchangeDeviceUnknown", "등록되지 않은 기기입니다.")
            if row["principal"] != principal:
                fail(403, "exchangeDeviceForbidden", "다른 기기의 토큰입니다.")
            db.execute("UPDATE exchange_devices SET last_seen_at=? WHERE id=? AND last_seen_at<?",
                       [iso(now), device_id, iso(now - LAST_SEEN_RESOLUTION_SECONDS)])
            db.commit()
            return principal, row

    def participant(db, transfer_id, device_id, roles):
        row = db.execute("SELECT * FROM exchange_transfers WHERE id=?", [transfer_id]).fetchone()
        allowed = {"sender": row and row["from_device"], "receiver": row and row["to_device"]}
        if row is None or device_id not in {allowed[role] for role in roles}:
            # Not revealed to non-participants.
            fail(404, "transferUnknown", "전송을 찾을 수 없습니다.")
        return row

    def gone(row):
        fail(410, "transferGone", "더 이상 받을 수 없는 전송입니다.", state=row["state"])

    # --- devices ------------------------------------------------------------

    def put_device(authorization, device_id, body):
        principal = principal_of(authorization)
        name = sanitize_device_name(body.name)
        if name is None:
            fail(422, "invalidExchangeRequest", "기기 이름을 확인할 수 없습니다.")
        now = iso(clock())
        cancelled = []
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT d.*, c.revoked_at AS credential_revoked, c.id AS credential "
                             "FROM exchange_devices d LEFT JOIN api_clients c ON c.id=d.principal "
                             "WHERE d.id=?", [device_id]).fetchone()
            if row is None:
                count = db.execute("SELECT COUNT(*) FROM exchange_devices WHERE revoked_at IS NULL").fetchone()[0]
                if count >= MAX_DEVICES:
                    fail(409, "exchangeDeviceLimit", "등록할 수 있는 기기 수를 넘었습니다.")
                db.execute("INSERT INTO exchange_devices VALUES(?,?,?,?,?,?,NULL,0)",
                           [device_id, name, body.kind, principal, now, now])
            else:
                if row["principal"] != principal:
                    if row["credential"] is not None and row["credential_revoked"] is None:
                        fail(403, "exchangeDeviceForbidden", "다른 기기의 토큰으로 등록된 기기입니다.")
                    # The old credential was revoked: the device moves to the new token,
                    # but nothing addressed to the old credential is handed over.
                    cancelled = _cancel_device_transfers(db, device_id, now, inbox_only=True)
                db.execute("UPDATE exchange_devices SET name=?,kind=?,principal=?,last_seen_at=?,revoked_at=NULL "
                           "WHERE id=?", [name, body.kind, principal, now, device_id])
            changed = (row is None or row["name"] != name or row["kind"] != body.kind
                       or row["principal"] != principal or row["revoked_at"] is not None)
            if changed or cancelled:
                bump(db)
            result = db.execute("SELECT * FROM exchange_devices WHERE id=?", [device_id]).fetchone()
            db.commit()
        _delete_objects(get_db, storage, bucket, cancelled, clock)
        return device_view(result, device_id)

    def _cancel_device_transfers(db, device_id, now, inbox_only=False):
        where = "to_device=?" if inbox_only else "(to_device=? OR from_device=?)"
        args = [device_id] if inbox_only else [device_id, device_id]
        rows = db.execute(f"SELECT id,object_key,from_device,to_device FROM exchange_transfers "
                          f"WHERE {where} AND state IN (?,?)", [*args, *LIVE]).fetchall()
        for row in rows:
            db.execute("UPDATE exchange_transfers SET state='cancelled',finished_at=?,failure=? WHERE id=?",
                       [now, "deviceUnregistered", row["id"]])
        return [row["object_key"] for row in rows]

    @app.put(PREFIX + "/devices/{device_id}")
    async def register_device(device_id: UUID, request: Request,
                              authorization: str | None = Header(default=None)):
        await run_in_threadpool(principal_of, authorization)
        body = await _body(request, DeviceBody)
        return await run_in_threadpool(put_device, authorization, device_id, body)

    @app.get(PREFIX + "/devices")
    def list_devices(authorization: str | None = Header(default=None),
                     x_lakomics_device: str | None = Header(default=None),
                     if_none_match: str | None = Header(default=None)):
        _, me = caller(authorization, x_lakomics_device)
        with get_db() as db:
            rows = db.execute(
                "SELECT d.* FROM exchange_devices d JOIN api_clients c ON c.id=d.principal "
                "WHERE d.revoked_at IS NULL AND c.revoked_at IS NULL ORDER BY d.created_at,d.rowid").fetchall()
        return conditional.json_response({"devices": [device_view(r, me["id"]) for r in rows]}, if_none_match)

    @app.delete(PREFIX + "/devices/{device_id}")
    def unregister_device(device_id: UUID, authorization: str | None = Header(default=None)):
        principal = principal_of(authorization)
        now = iso(clock())
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM exchange_devices WHERE id=?", [device_id]).fetchone()
            if row is None or row["principal"] != principal:
                fail(404, "exchangeDeviceUnknown", "등록되지 않은 기기입니다.")
            if row["revoked_at"] is not None:
                return {"deviceId": device_id, "unregistered": True}
            keys = _cancel_device_transfers(db, device_id, now)
            db.execute("UPDATE exchange_devices SET revoked_at=? WHERE id=?", [now, device_id])
            bump(db)
            db.commit()
        _delete_objects(get_db, storage, bucket, keys, clock)
        return {"deviceId": device_id, "unregistered": True}

    # --- transfers ----------------------------------------------------------

    def upload_for(row):
        return {"method": "PUT", "url": presign_put(row["object_key"], OBJECT_CONTENT_TYPE, UPLOAD_URL_SECONDS),
                "expiresIn": UPLOAD_URL_SECONDS, "requiredHeaders": {"Content-Type": OBJECT_CONTENT_TYPE}}

    def create(authorization, device_id, body):
        _, me = caller(authorization, device_id)
        digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True,
                                           separators=(",", ":")).encode()).hexdigest()
        now = clock()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM exchange_transfers WHERE id=?", [body.transferId]).fetchone()
            if existing is not None:
                if existing["from_device"] != me["id"] or existing["request_digest"] != digest:
                    fail(409, "transferIdReused", "이미 다른 내용으로 사용된 전송 식별자입니다.")
                row = existing
            else:
                if body.sizeBytes > MAX_FILE_BYTES:
                    fail(413, "fileTooLarge", "파일이 너무 큽니다.", maxBytes=MAX_FILE_BYTES)
                name = sanitize_file_name(body.fileName)
                if name is None:
                    fail(422, "invalidFileName", "파일 이름을 사용할 수 없습니다.")
                if body.toDevice == me["id"]:
                    fail(422, "cannotSendToSelf", "같은 기기로는 보낼 수 없습니다.")
                if _live_device(db, body.toDevice) is None:
                    fail(404, "targetDeviceUnknown", "받는 기기가 등록 해제되었습니다.")
                count, outstanding = db.execute(
                    "SELECT COUNT(*),COALESCE(SUM(size_bytes),0) FROM exchange_transfers WHERE state IN (?,?)",
                    LIVE).fetchone()
                if count >= MAX_OUTSTANDING_TRANSFERS or outstanding + body.sizeBytes > MAX_OUTSTANDING_BYTES:
                    fail(409, "quotaExceeded", "보관 한도를 넘었습니다.", maxBytes=MAX_OUTSTANDING_BYTES)
                batch = body.batchId or body.transferId
                in_batch = db.execute("SELECT COUNT(*) FROM exchange_transfers WHERE batch_id=? AND from_device=?",
                                      [batch, me["id"]]).fetchone()[0]
                if in_batch >= MAX_BATCH_FILES:
                    fail(409, "batchTooLarge", "한 번에 보낼 수 있는 파일 수를 넘었습니다.",
                         maxFiles=MAX_BATCH_FILES)
                db.execute("INSERT INTO exchange_transfers(id,batch_id,from_device,to_device,file_name,size_bytes,"
                           "sha256,content_type_hint,state,object_key,request_digest,created_at,expires_at) "
                           "VALUES(?,?,?,?,?,?,?,?,'uploading',?,?,?,?)",
                           [body.transferId, batch, me["id"], body.toDevice, name, body.sizeBytes, body.sha256,
                            body.contentTypeHint, f"{OBJECT_PREFIX}{body.toDevice}/{body.transferId}", digest,
                            iso(now), iso(now + UPLOADING_TTL_SECONDS)])
                bump(db, [me["id"]])
                row = db.execute("SELECT * FROM exchange_transfers WHERE id=?", [body.transferId]).fetchone()
            view = _one(db, row)
            db.commit()
        # A fresh URL on every retry while the upload is still open.
        live = row["state"] == "uploading" and row["expires_at"] > iso(now)
        return {**view, "upload": upload_for(row) if live else None}

    @app.post(PREFIX + "/transfers")
    async def create_transfer(request: Request, authorization: str | None = Header(default=None),
                              x_lakomics_device: str | None = Header(default=None)):
        await run_in_threadpool(caller, authorization, x_lakomics_device)
        body = await _body(request, CreateTransfer)
        return await run_in_threadpool(create, authorization, x_lakomics_device, body)

    @app.post(PREFIX + "/transfers/{transfer_id}/complete")
    def complete(transfer_id: UUID, authorization: str | None = Header(default=None),
                 x_lakomics_device: str | None = Header(default=None)):
        _, me = caller(authorization, x_lakomics_device)
        with get_db() as db:
            row = participant(db, transfer_id, me["id"], ["sender"])
            if row["state"] in ("ready", "delivered"):
                return _one(db, row)
            if row["state"] != "uploading" or row["expires_at"] <= iso(clock()):
                gone(row)
        # The network HEAD runs outside any transaction.
        try:
            head = storage().head_object(Bucket=bucket(), Key=row["object_key"])
        except Exception as exc:  # noqa: BLE001 - classified below
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey", "NotFound"):
                fail(409, "uploadMissing", "업로드된 파일이 없습니다.")
            LOG.warning("Exchange upload check failed: %s", type(exc).__name__)
            fail(503, "storageUnavailable", "저장소에 연결할 수 없습니다.")
        size = head.get("ContentLength")
        now = clock()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = participant(db, transfer_id, me["id"], ["sender"])
            if row["state"] != "uploading":
                view = _one(db, row)
                if row["state"] in ("ready", "delivered"):
                    return view
                gone(row)
            if size != row["size_bytes"]:
                db.execute("UPDATE exchange_transfers SET state='failed',finished_at=?,failure='sizeMismatch' "
                           "WHERE id=?", [iso(now), transfer_id])
                bump(db, [row["from_device"]])
                db.commit()
                _delete_objects(get_db, storage, bucket, [row["object_key"]], clock)
                fail(409, "sizeMismatch", "업로드된 파일 크기가 다릅니다.",
                     expectedBytes=row["size_bytes"], actualBytes=size)
            db.execute("UPDATE exchange_transfers SET state='ready',ready_at=?,expires_at=? WHERE id=?",
                       [iso(now), iso(now + READY_TTL_SECONDS), transfer_id])
            bump(db, [row["from_device"], row["to_device"]])
            view = _one(db, db.execute("SELECT * FROM exchange_transfers WHERE id=?", [transfer_id]).fetchone())
            db.commit()
            return view

    @app.get(PREFIX + "/inbox")
    def inbox(authorization: str | None = Header(default=None),
              x_lakomics_device: str | None = Header(default=None),
              if_none_match: str | None = Header(default=None)):
        _, me = caller(authorization, x_lakomics_device)
        with get_db() as db:
            revision = db.execute("SELECT revision FROM exchange_devices WHERE id=?", [me["id"]]).fetchone()[0]
            rows = db.execute("SELECT * FROM exchange_transfers WHERE to_device=? AND state='ready' "
                              "AND expires_at>? ORDER BY created_at,rowid LIMIT ?",
                              [me["id"], iso(clock()), INBOX_LIMIT]).fetchall()
            names = _names(db, rows)
        items = [{key: view[key] for key in ("transferId", "batchId", "fromDevice", "fromName", "fileName",
                                             "sizeBytes", "sha256", "contentTypeHint", "createdAt", "expiresAt")}
                 for view in (transfer_view(row, names) for row in rows)]
        return conditional.json_response({"revision": revision, "items": items}, if_none_match)

    @app.get(PREFIX + "/outbox")
    def outbox(authorization: str | None = Header(default=None),
               x_lakomics_device: str | None = Header(default=None),
               if_none_match: str | None = Header(default=None)):
        _, me = caller(authorization, x_lakomics_device)
        now = clock()
        with get_db() as db:
            revision = db.execute("SELECT revision FROM exchange_devices WHERE id=?", [me["id"]]).fetchone()[0]
            rows = db.execute("SELECT * FROM exchange_transfers WHERE from_device=? AND created_at>? "
                              "ORDER BY created_at DESC,rowid DESC LIMIT ?",
                              [me["id"], iso(now - HISTORY_SECONDS), OUTBOX_LIMIT]).fetchall()
            names = _names(db, rows)
        return conditional.json_response(
            {"revision": revision, "items": [transfer_view(row, names) for row in rows]}, if_none_match)

    @app.post(PREFIX + "/transfers/{transfer_id}/ticket")
    def ticket(transfer_id: UUID, authorization: str | None = Header(default=None),
               x_lakomics_device: str | None = Header(default=None)):
        _, me = caller(authorization, x_lakomics_device)
        with get_db() as db:
            row = participant(db, transfer_id, me["id"], ["receiver"])
        if row["state"] == "uploading":
            fail(409, "transferNotReady", "아직 업로드 중입니다.")
        if row["state"] != "ready" or row["expires_at"] <= iso(clock()):
            gone(row)
        url = storage().generate_presigned_url(
            "get_object", ExpiresIn=TICKET_SECONDS,
            Params={"Bucket": bucket(), "Key": row["object_key"],
                    "ResponseContentType": OBJECT_CONTENT_TYPE, "ResponseContentDisposition": "attachment"})
        return {"transferId": transfer_id, "url": url, "expiresIn": TICKET_SECONDS,
                "sizeBytes": row["size_bytes"], "sha256": row["sha256"], "fileName": row["file_name"]}

    def acknowledge(authorization, device_id, transfer_id, body):
        _, me = caller(authorization, device_id)
        now = iso(clock())
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = participant(db, transfer_id, me["id"], ["receiver"])
            if row["state"] == "delivered":
                return _one(db, row)
            if row["state"] == "uploading":
                fail(409, "transferNotReady", "아직 업로드 중입니다.")
            if row["state"] != "ready":
                gone(row)
            if body.sha256 != row["sha256"]:
                fail(409, "digestMismatch", "받은 파일의 내용이 보낸 파일과 다릅니다.")
            db.execute("UPDATE exchange_transfers SET state='delivered',delivered_at=?,finished_at=? WHERE id=?",
                       [now, now, transfer_id])
            bump(db, [row["from_device"], row["to_device"]])
            db.commit()
        _delete_objects(get_db, storage, bucket, [row["object_key"]], clock)
        with get_db() as db:
            return _one(db, db.execute("SELECT * FROM exchange_transfers WHERE id=?", [transfer_id]).fetchone())

    @app.post(PREFIX + "/transfers/{transfer_id}/ack")
    async def ack(transfer_id: UUID, request: Request, authorization: str | None = Header(default=None),
                  x_lakomics_device: str | None = Header(default=None)):
        await run_in_threadpool(caller, authorization, x_lakomics_device)
        body = await _body(request, Ack)
        return await run_in_threadpool(acknowledge, authorization, x_lakomics_device, transfer_id, body)

    @app.delete(PREFIX + "/transfers/{transfer_id}")
    def cancel(transfer_id: UUID, authorization: str | None = Header(default=None),
               x_lakomics_device: str | None = Header(default=None)):
        _, me = caller(authorization, x_lakomics_device)
        now = iso(clock())
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = participant(db, transfer_id, me["id"], ["sender", "receiver"])
            if row["state"] not in LIVE:
                return _one(db, row)
            reason = "withdrawn" if row["from_device"] == me["id"] else "declined"
            db.execute("UPDATE exchange_transfers SET state='cancelled',finished_at=?,failure=? WHERE id=?",
                       [now, reason, transfer_id])
            bump(db, [row["from_device"], row["to_device"]])
            db.commit()
        _delete_objects(get_db, storage, bucket, [row["object_key"]], clock)
        with get_db() as db:
            return _one(db, db.execute("SELECT * FROM exchange_transfers WHERE id=?", [transfer_id]).fetchone())

    return startup


# --- retention --------------------------------------------------------------

def sweep(get_db, storage, bucket, *, now=None, orphan_limit=ORPHAN_SCAN_LIMIT):
    """One retention pass; safe to run concurrently with requests and never touches another prefix.

    1. expire ``uploading`` rows (2 h) and ``ready`` rows (24 h) past ``expires_at``;
    2. delete the objects of every terminal row not yet deleted;
    3. delete ``exchange/`` objects with no live row (one bounded listing page);
    4. prune terminal rows finished more than 7 days ago, and long-unregistered devices.
    """
    now = time.time() if now is None else now
    summary = {"expired": 0, "objectsDeleted": 0, "orphansDeleted": 0, "rowsPruned": 0, "errors": 0}
    stamp = iso(now)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        due = db.execute("SELECT id,from_device,to_device FROM exchange_transfers WHERE state IN (?,?) "
                         "AND expires_at<=?", [*LIVE, stamp]).fetchall()
        if due:
            db.execute("UPDATE exchange_transfers SET state='expired',finished_at=?,failure='expired' "
                       "WHERE state IN (?,?) AND expires_at<=?", [stamp, *LIVE, stamp])
            bump(db, [device for row in due for device in (row["from_device"], row["to_device"])])
        db.commit()
        summary["expired"] = len(due)
        pending = [r[0] for r in db.execute(
            "SELECT object_key FROM exchange_transfers WHERE state IN (?,?,?,?) AND object_deleted_at IS NULL",
            TERMINAL)]

    client, name = storage(), bucket()
    for key in pending:
        if not key.startswith(OBJECT_PREFIX):
            continue
        try:
            client.delete_object(Bucket=name, Key=key)
        except Exception as exc:  # noqa: BLE001
            summary["errors"] += 1
            LOG.warning("Exchange sweep delete failed: %s", type(exc).__name__)
            continue
        with get_db() as db:
            db.execute("UPDATE exchange_transfers SET object_deleted_at=? WHERE object_key=? "
                       "AND state IN (?,?,?,?)", [stamp, key, *TERMINAL])
            db.commit()
        summary["objectsDeleted"] += 1

    try:
        listing = client.list_objects_v2(Bucket=name, Prefix=OBJECT_PREFIX, MaxKeys=orphan_limit)
        keys = [item["Key"] for item in listing.get("Contents", []) if item["Key"].startswith(OBJECT_PREFIX)]
        if keys:
            with get_db() as db:
                live = {r[0] for r in db.execute(
                    f"SELECT object_key FROM exchange_transfers WHERE object_deleted_at IS NULL "
                    f"AND object_key IN ({','.join('?' * len(keys))})", keys)}
            for key in keys:
                if key in live:
                    continue
                try:
                    client.delete_object(Bucket=name, Key=key)
                    summary["orphansDeleted"] += 1
                except Exception as exc:  # noqa: BLE001
                    summary["errors"] += 1
                    LOG.warning("Exchange orphan delete failed: %s", type(exc).__name__)
    except Exception as exc:  # noqa: BLE001 - listing is a safety net only
        summary["errors"] += 1
        LOG.warning("Exchange orphan scan failed: %s", type(exc).__name__)

    cutoff = iso(now - HISTORY_SECONDS)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        summary["rowsPruned"] = db.execute(
            "DELETE FROM exchange_transfers WHERE state IN (?,?,?,?) AND object_deleted_at IS NOT NULL "
            "AND finished_at<?", [*TERMINAL, cutoff]).rowcount
        db.execute("DELETE FROM exchange_devices WHERE revoked_at IS NOT NULL AND revoked_at<? AND NOT EXISTS("
                   "SELECT 1 FROM exchange_transfers t WHERE t.from_device=exchange_devices.id "
                   "OR t.to_device=exchange_devices.id)", [cutoff])
        db.commit()
    return summary


def sweep_enabled(environ=None):
    value = (os.environ if environ is None else environ).get(SWEEP_ENV, "1").strip().lower()
    return value not in ("0", "false", "no", "off")


class ExchangeSweeper:
    """One daemon thread: a pass shortly after start, then every ``interval`` seconds. Never raises."""

    def __init__(self, get_db, storage, bucket, *, interval=SWEEP_INTERVAL_SECONDS,
                 initial_delay=SWEEP_INITIAL_DELAY_SECONDS):
        self.get_db, self.storage, self.bucket = get_db, storage, bucket
        self.interval, self.initial_delay = interval, initial_delay
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if not sweep_enabled():
            LOG.warning("Exchange sweep disabled by %s", SWEEP_ENV)
            return
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.loop, name="exchange-sweep", daemon=True)
        self.thread.start()

    def stop(self, timeout=5):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=timeout)

    def loop(self):
        delay = self.initial_delay
        while not self.stop_event.wait(delay):
            self.run_once()
            delay = self.interval

    def run_once(self):
        try:
            summary = sweep(self.get_db, self.storage, self.bucket)
        except Exception as exc:  # noqa: BLE001
            LOG.error("Exchange sweep failed: %s: %s", type(exc).__name__, exc)
            return None
        if any(summary.values()):
            LOG.info("Exchange sweep: %s", summary)
        return summary
