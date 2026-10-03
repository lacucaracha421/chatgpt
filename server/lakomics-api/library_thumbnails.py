"""Verified thumbnail storage and short SQLite publication transactions.

No app import, worker startup, environment loading or storage client creation.
"""
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
import time
import uuid
from dataclasses import dataclass

from fastapi import HTTPException

PREFIX = "derived/library-thumbnails/v1/"
TEMP_PREFIX = "uploads/library-thumbnails/"
MAX_BYTES = 2 * 1024 * 1024
SESSION_SECONDS = 900
UPLOAD_SECONDS = 600
RECLAIM_GRACE = 3600
DIGEST = re.compile(r"[0-9a-f]{64}")
_VERIFY_SLOT = threading.BoundedSemaphore(1)
THUMB_FIELDS = (
    "thumbnail_key", "thumbnail_metadata_key", "thumbnail_size_bytes",
    "thumbnail_content_type", "thumbnail_sha256", "thumbnail_revision",
    "thumbnail_verified", "thumbnail_write_epoch",
)
CAS_FIELDS = THUMB_FIELDS + (
    "metadata_revision", "metadata_commit_id", "object_key", "sha256", "committed",
    "kind", "content_type", "size_bytes", "created_at",
)


def revision(row):
    fields = dict(row)
    key = fields.get("thumbnail_key")
    if not key:
        return None
    return fields.get("thumbnail_revision") or legacy_revision(key)


def legacy_revision(key):
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def immutable_key(digest):
    return PREFIX + digest + ".webp"


def is_immutable(key):
    return bool(key and key.startswith("derived/"))


def trusted_receipt(row):
    row = dict(row)
    digest = row.get("thumbnail_sha256")
    return (row.get("thumbnail_verified") == 1 and isinstance(digest, str)
            and DIGEST.fullmatch(digest) is not None
            and row.get("thumbnail_key") == immutable_key(digest)
            and row.get("thumbnail_metadata_key") == row.get("thumbnail_key"))


def block_legacy_uploads():
    return os.environ.get("LAKOMICS_BLOCK_LEGACY_THUMBNAIL_UPLOADS", "0").lower() in ("1", "true", "yes")


def fail(status, code):
    raise HTTPException(status, detail={"code": code})


def remember_key(db, key):
    # SQLite has no portable SHA-256 function. This small immutable dictionary lets
    # triggers compare the very same fallback token, including on raw DB connections.
    if key:
        db.execute("INSERT OR IGNORE INTO thumbnail_revision_fallbacks VALUES (?,?)",
                   (key, legacy_revision(key)))


def install(db):
    additions = {
        "thumbnail_sha256": "TEXT", "thumbnail_revision": "TEXT",
        "thumbnail_write_epoch": "INTEGER NOT NULL DEFAULT 0",
        "thumbnail_verified": "INTEGER NOT NULL DEFAULT 0",
    }
    columns = {r[1] for r in db.execute("PRAGMA table_info(assets)")}
    for column, definition in additions.items():
        if column not in columns:
            db.execute(f"ALTER TABLE assets ADD COLUMN {column} {definition}")
    db.execute("CREATE TABLE IF NOT EXISTS thumbnail_revision_fallbacks "
               "(object_key TEXT PRIMARY KEY, revision TEXT NOT NULL)")
    for row in db.execute("SELECT DISTINCT thumbnail_key FROM assets WHERE thumbnail_key IS NOT NULL"):
        remember_key(db, row[0])
    db.execute("""CREATE TABLE IF NOT EXISTS thumbnail_upload_sessions (
        upload_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, asset_id TEXT NOT NULL, sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, content_type TEXT NOT NULL,
        temp_key TEXT NOT NULL UNIQUE, final_key TEXT NOT NULL,
        epoch INTEGER NOT NULL, snapshot TEXT NOT NULL,
        created_at REAL NOT NULL, expires_at REAL NOT NULL, upload_expires_at REAL NOT NULL,
        state TEXT NOT NULL, commit_context TEXT, result TEXT, reclaimed_at REAL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS thumbnail_sessions_asset "
               "ON thumbnail_upload_sessions(asset_id,state,expires_at)")
    db.execute("CREATE INDEX IF NOT EXISTS thumbnail_sessions_expiry "
               "ON thumbnail_upload_sessions(expires_at,reclaimed_at)")
    # Tablet list payload fields, plus eligibility/order inputs. Authority lifecycle,
    # classification and search changes have their own generation signals. Receipts,
    # commit bookkeeping and ticket-only digests do not alter this list projection.
    visible = {
        "id", "kind", "object_key", "content_type", "size_bytes", "created_at",
        "committed", "committed_at", "collected_at", "source_published_at",
        "source_url", "creator_name", "creator_handle", "import_source",
        "width", "height", "duration_ms",
    }
    watched = [r[1] for r in db.execute("PRAGMA table_info(assets)") if r[1] in visible]
    db.execute("DROP TRIGGER IF EXISTS asset_list_update")
    db.execute("CREATE TRIGGER asset_list_update AFTER UPDATE OF "
               + ",".join('"' + name + '"' for name in watched)
               + " ON assets WHEN " + " OR ".join(f'OLD."{name}" IS NOT NEW."{name}"' for name in watched)
               + " BEGIN UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END")
    def effective(alias):
        return (f"CASE WHEN COALESCE({alias}.thumbnail_key,'')='' THEN NULL ELSE "
                f"COALESCE(NULLIF({alias}.thumbnail_revision,''), "
                f"(SELECT revision FROM thumbnail_revision_fallbacks WHERE object_key={alias}.thumbnail_key),"
                f"'unregistered:' || {alias}.thumbnail_key) END")
    db.execute("DROP TRIGGER IF EXISTS asset_thumbnail_list_update")
    db.execute("CREATE TRIGGER asset_thumbnail_list_update AFTER UPDATE OF thumbnail_key,thumbnail_revision "
               "ON assets WHEN " + effective("OLD") + " IS NOT " + effective("NEW")
               + " BEGIN UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END")


def lifecycle_identity(db, asset_id):
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' "
                                      "AND name IN ('authority_domains','asset_authority_state')")}
    if len(tables) < 2:
        return {"domain": [], "rows": []}
    domain = [list(r) for r in db.execute(
        "SELECT library_id,epoch FROM authority_domains WHERE domain='assets'")]
    rows = [list(r) for r in db.execute(
        "SELECT library_id,lifecycle,entity_revision FROM asset_authority_state WHERE asset_id=? ORDER BY library_id",
        (asset_id,))]
    return {"domain": domain, "rows": rows}


def writable_lifecycle(identity, *, require_registered=False):
    if not identity["domain"]:
        return not any(row[1] != "normal" for row in identity["rows"])
    library = identity["domain"][0][0]
    if require_registered and not any(r[0] == library for r in identity["rows"]):
        return False
    # Pending replication may not have its canonical row until the commit.
    return not any(r[0] == library and r[1] != "normal" for r in identity["rows"])


def snapshot(db, row):
    return {"asset": {field: row[field] for field in CAS_FIELDS},
            "lifecycle": lifecycle_identity(db, row["id"])}


def matches(db, row, before):
    return row is not None and snapshot(db, row) == before


def active_upload(db, asset_id, now=None):
    now = time.time() if now is None else now
    if db.execute("SELECT 1 FROM thumbnail_upload_sessions WHERE asset_id=? "
                  "AND state='pending' AND expires_at>? LIMIT 1", (asset_id, now)).fetchone():
        return True
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_thumbnail_jobs'").fetchone():
        return db.execute("SELECT 1 FROM image_thumbnail_jobs WHERE asset_id=? AND state='running' AND lease_until>?",
                          (asset_id, now)).fetchone() is not None
    return False


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def prepare(db, payload, now=None):
    now = time.time() if now is None else now
    canonical = encode(payload)
    with db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT * FROM thumbnail_upload_sessions WHERE operation_id=?",
                           (payload["operation_id"],)).fetchone()
        if prior is not None:
            if prior["payload"] != canonical:
                fail(409, "thumbnailOperationConflict")
            if prior["state"] != "committed" and (prior["expires_at"] <= now or prior["state"] != "pending"):
                fail(410, "thumbnailSessionExpired")
            return dict(prior)
        row = db.execute("SELECT * FROM assets WHERE id=?", (payload["asset_id"],)).fetchone()
        if row is None:
            fail(404, "thumbnailAssetNotPrepared")
        if not writable_lifecycle(lifecycle_identity(db, row["id"]), require_registered=bool(row["committed"])):
            fail(409, "assetLifecycleOwned")
        expected = payload.get("expected_thumbnail_write_epoch")
        if expected is not None and expected != row["thumbnail_write_epoch"]:
            fail(409, "thumbnailConcurrentChange")
        db.execute("UPDATE assets SET thumbnail_write_epoch=thumbnail_write_epoch+1 WHERE id=?", (row["id"],))
        db.execute("UPDATE thumbnail_upload_sessions SET state='superseded' WHERE asset_id=? AND state='pending'",
                   (row["id"],))
        row = db.execute("SELECT * FROM assets WHERE id=?", (row["id"],)).fetchone()
        upload_id = str(uuid.uuid4())
        db.execute("""INSERT INTO thumbnail_upload_sessions
            (upload_id,operation_id,payload,asset_id,sha256,size_bytes,content_type,temp_key,final_key,
             epoch,snapshot,created_at,expires_at,upload_expires_at,state)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')""",
            (upload_id, payload["operation_id"], canonical, row["id"], payload["sha256"],
             payload["size_bytes"], payload["content_type"], TEMP_PREFIX + upload_id,
             immutable_key(payload["sha256"]), row["thumbnail_write_epoch"], encode(snapshot(db, row)),
             now, now + SESSION_SECONDS, now + UPLOAD_SECONDS))
        return dict(db.execute("SELECT * FROM thumbnail_upload_sessions WHERE upload_id=?", (upload_id,)).fetchone())


def get_session(db, asset_id, upload_id, context, now=None):
    row = db.execute("SELECT * FROM thumbnail_upload_sessions WHERE upload_id=?", (upload_id,)).fetchone()
    if row is None or row["asset_id"] != asset_id:
        fail(404, "thumbnailSessionNotFound")
    if row["commit_context"] is not None and row["commit_context"] != context:
        fail(409, "thumbnailOperationConflict")
    if row["state"] != "committed" and (row["state"] != "pending" or row["expires_at"] <= (time.time() if now is None else now)):
        fail(410, "thumbnailSessionExpired")
    return dict(row)


class InvalidObject(ValueError):
    pass


class IntegrityError(InvalidObject):
    pass


def missing(error):
    response = getattr(error, "response", {})
    return str(response.get("Error", {}).get("Code", "")) in ("404", "NoSuchKey", "NotFound")


def validate_webp(data):
    """Verify both the container and a complete decode in the existing bounded child.

    Pillow never enters the API process. One concurrent decoder per process keeps
    repeated authenticated uploads from multiplying the single-vCPU decode load.
    """
    if (not 12 <= len(data) <= MAX_BYTES or data[:4] != b"RIFF" or data[8:12] != b"WEBP"
            or int.from_bytes(data[4:8], "little") != len(data) - 8):
        raise InvalidObject("webpContainer")
    if not _VERIFY_SLOT.acquire(timeout=5):
        raise TimeoutError("thumbnailDecodeBusy")
    try:
        with tempfile.TemporaryDirectory(prefix="lakomics-verify-thumb-") as directory:
            path = Path(directory) / "thumbnail.webp"
            path.write_bytes(data)
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("image_thumbnail_encode.py")), "--verify-webp", str(path)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5, check=False)
        if result.returncode in (6, 7):
            raise RuntimeError("thumbnailVerifierUnavailable")
        if result.returncode != 0:
            raise InvalidObject("webpDecode")
    except subprocess.TimeoutExpired:
        raise TimeoutError("thumbnailDecodeDeadline") from None
    finally:
        _VERIFY_SLOT.release()


def read_object(storage, bucket, key, *, digest=None, size=None, deadline=None):
    response = storage.get_object(Bucket=bucket, Key=key)
    body = response["Body"]
    try:
        declared = response.get("ContentLength")
        if (type(declared) is not int or not 0 < declared <= MAX_BYTES
                or (size is not None and declared != size)
                or response.get("ContentType") != "image/webp"):
            raise InvalidObject("thumbnailMetadata")
        data = bytearray()
        while len(data) <= MAX_BYTES:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("thumbnailReadDeadline")
            chunk = body.read(min(65536, MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        data = bytes(data)
        if len(data) != declared or (size is not None and len(data) != size):
            raise InvalidObject("thumbnailLength")
        actual = hashlib.sha256(data).hexdigest()
        if digest is not None and digest != actual:
            raise InvalidObject("thumbnailDigest")
        validate_webp(data)
        return data, actual, response.get("ETag")
    finally:
        body.close()


def publish_buffer(storage, bucket, data, digest, *, deadline=None):
    if not 0 < len(data) <= MAX_BYTES or hashlib.sha256(data).hexdigest() != digest:
        raise InvalidObject("thumbnailPublishDigest")
    key = immutable_key(digest)
    try:
        read_object(storage, bucket, key, digest=digest, size=len(data), deadline=deadline)
        return key
    except InvalidObject as exc:
        raise IntegrityError("thumbnailFinalIntegrity") from exc
    except Exception as exc:
        if not missing(exc):
            raise
    storage.put_object(Bucket=bucket, Key=key, Body=io.BytesIO(data), ContentType="image/webp")
    try:
        read_object(storage, bucket, key, digest=digest, size=len(data), deadline=deadline)
    except InvalidObject as exc:
        raise IntegrityError("thumbnailFinalIntegrity") from exc
    return key


@dataclass(frozen=True)
class VerifiedUpload:
    session: dict
    previous_digest: str | None


def verify_upload(db_factory, storage, bucket, asset_id, upload_id, context, *, standalone=False):
    with db_factory() as db:
        session = get_session(db, asset_id, upload_id, context)
        if session["state"] == "committed":
            return VerifiedUpload(session, None)
        row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if not matches(db, row, json.loads(session["snapshot"])):
            fail(409, "thumbnailConcurrentChange")
        if standalone and not row["committed"]:
            fail(409, "thumbnailAssetNotCommitted")
        previous_digest, old_key = row["thumbnail_sha256"], row["thumbnail_key"]
    deadline = time.monotonic() + 60
    try:
        data, digest, _ = read_object(storage, bucket, session["temp_key"],
                                     digest=session["sha256"], size=session["size_bytes"], deadline=deadline)
        if old_key and previous_digest is None:
            _, previous_digest, _ = read_object(storage, bucket, old_key, deadline=deadline)
        publish_buffer(storage, bucket, data, digest, deadline=deadline)
    except InvalidObject:
        fail(422, "thumbnailVerificationFailed")
    except Exception as exc:
        fail(409 if missing(exc) else 503, "thumbnailObjectMissing" if missing(exc) else "thumbnailStorageUnavailable")
    return VerifiedUpload(session, previous_digest)


def apply_upload(db, verified, context):
    """Caller owns BEGIN IMMEDIATE/commit; no object I/O here."""
    session = get_session(db, verified.session["asset_id"], verified.session["upload_id"], context)
    if session["state"] == "committed":
        return json.loads(session["result"])
    row = db.execute("SELECT * FROM assets WHERE id=?", (session["asset_id"],)).fetchone()
    if not matches(db, row, json.loads(session["snapshot"])):
        fail(409, "thumbnailConcurrentChange")
    token = revision(row) if row["thumbnail_key"] and verified.previous_digest == session["sha256"] else "t1." + session["sha256"]
    remember_key(db, row["thumbnail_key"])
    db.execute("""UPDATE assets SET thumbnail_key=?,thumbnail_metadata_key=?,thumbnail_size_bytes=?,
        thumbnail_content_type='image/webp',thumbnail_sha256=?,thumbnail_revision=?,thumbnail_verified=1,
        thumbnail_write_epoch=thumbnail_write_epoch+1 WHERE id=?""",
        (session["final_key"], session["final_key"], session["size_bytes"], session["sha256"], token, session["asset_id"]))
    result = {"ok": True, "asset_id": session["asset_id"], "upload_id": session["upload_id"],
              "thumbnail_key": session["final_key"], "thumbnail_sha256": session["sha256"],
              "thumbnail_revision": token, "thumbnail_write_epoch": session["epoch"] + 1}
    db.execute("UPDATE thumbnail_upload_sessions SET state='committed',commit_context=?,result=? WHERE upload_id=?",
               (context, encode(result), session["upload_id"]))
    return result


def cleanup_temp(storage, bucket, session):
    try:
        storage.delete_object(Bucket=bucket, Key=session["temp_key"])
        return True
    except Exception:
        return False


def reclaim_temp(db_factory, storage, bucket, limit=25, now=None):
    now = time.time() if now is None else now
    with db_factory() as db:
        rows = db.execute("SELECT * FROM thumbnail_upload_sessions WHERE expires_at<? "
                          "AND (reclaimed_at IS NULL OR reclaimed_at<?) "
                          "ORDER BY COALESCE(reclaimed_at,0),expires_at LIMIT ?",
                          (now - RECLAIM_GRACE, now - RECLAIM_GRACE, min(max(limit, 1), 100))).fetchall()
    deleted = 0
    for row in rows:
        if row["temp_key"] != TEMP_PREFIX + row["upload_id"]:
            continue
        if cleanup_temp(storage, bucket, row):
            with db_factory() as db:
                db.execute("UPDATE thumbnail_upload_sessions SET reclaimed_at=?, "
                           "state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE upload_id=?",
                           (now, row["upload_id"]))
                db.commit()
            deleted += 1
    return deleted
