"""Server-owned Asset lifecycle authority: identity, lifecycle state, promotion.

ADR-0038. This module owns the canonical *lifecycle* of an Asset — does it exist for
ordinary reads, is it trashed, is it tombstoned — plus the promotion path that turns an
accepted Capture into a canonical Asset without any PC involvement.

# What this domain does and does not own

Owned here:

* canonical Asset identity for Assets the server creates, and the Capture → Asset mapping;
* lifecycle state (`normal` → `trash` → `tombstoned`), with a per-Asset entity revision;
* the ordered change log, operation receipts, retention floor and domain cursor.

Deliberately **not** owned here:

* media bytes. The log carries object keys and hashes, never content, and no lifecycle
  command deletes an R2 object — that is deferred physical GC (ADR-0038 §7);
* Classification assignment (its own domain) and Album membership (its own domain). Trash
  hides an Asset without re-organizing the library, so those relations are left intact;
* perceptual similarity, which stays PC analysis.

# Promotion is idempotent by construction

`promote_capture` first resolves the verified SHA-256 within the library. Existing normal
content keeps its canonical ID; new content allocates an ID from its first Capture.
The mapping, Asset state and Classification command commit in one transaction. A retry
therefore recomputes the same id and finds the mapping already present, so "same Capture,
retried any number of times, exactly one canonical Asset" holds without a lock and without
depending on which attempt won.

# Activation

The domain stays inactive — and every route here reports `authorityInactive` — until an
operator activates an epoch, exactly like Classification and Album. Until then the legacy
PC-mediated path is byte-for-byte unchanged, which is what makes this a staged rollout.
"""
import hashlib
import json
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from app_lifecycle import lifecycle
from fastapi import HTTPException

import authority
import conditional
import classification_authority

DOMAIN = "assets"
CONTRACT_VERSION = 1

#: History retention, in the same units and for the same reason as the other domains.
RETENTION_DAYS = 180
RECEIPT_RETENTION_DAYS = 180

DEFAULT_ASSET_PAGE = 500
MAX_ASSET_PAGE = 1_000
DEFAULT_CHANGE_PAGE = 200
MAX_CHANGE_PAGE = 500

NORMAL = "normal"
TRASH = "trash"
TOMBSTONED = "tombstoned"
LIFECYCLE_STATES = (NORMAL, TRASH, TOMBSTONED)

TRASH_ASSET = "trashAsset"
RESTORE_ASSET = "restoreAsset"
TOMBSTONE_ASSET = "tombstoneAsset"
LIFECYCLE_COMMAND_TYPES = (TRASH_ASSET, RESTORE_ASSET, TOMBSTONE_ASSET)
#: Reversible commands an ordinary client credential may send (mobile Library Trash).
CLIENT_COMMAND_TYPES = (TRASH_ASSET, RESTORE_ASSET)

ENVELOPE_KEYS = {"libraryId", "epoch", "contractVersion", "operationId", "commandType"}
COMMAND_KEYS = ENVELOPE_KEYS | {"assetId", "expectedEntityRevision"}

LIBRARY_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
ASSET_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
CAPTURE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

#: Namespace for deterministic canonical Asset ids derived from a Capture id. Changing
#: this would re-identify every already-promoted Capture, so it is versioned on purpose.
PROMOTION_NAMESPACE = uuid.UUID("6f2a1d54-9c3b-4f2e-8a17-5d0c9b7e4a31")

DDL = """
-- One row per Asset the server owns the lifecycle of. The Asset id is allocated by the
-- server (never by a client, a filename or a local row id), which is what makes a
-- cloud-created Asset materialize on the PC under the *same* id.
CREATE TABLE IF NOT EXISTS asset_authority_state(
 library_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('normal','trash','tombstoned')),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 -- Materialization metadata: what the PC needs to fetch and verify the bytes. Never
 -- media itself and never a signed URL.
 kind TEXT,
 object_key TEXT,
 content_type TEXT,
 size_bytes INTEGER,
 sha256 TEXT,
 source_url TEXT,
 creator_name TEXT,
 creator_handle TEXT,
 collected_at TEXT,
 source_published_at TEXT,
 import_source TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 lifecycle_changed_at TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(library_id,asset_id));
-- Ordinary reads filter on lifecycle; this index is what keeps that filter indexed
-- rather than a scan over authority state.
CREATE INDEX IF NOT EXISTS asset_authority_by_lifecycle
 ON asset_authority_state(library_id,lifecycle,asset_id);
-- The visibility projection asks "is *this* Asset normal", once per candidate row, so it
-- needs an index that starts at `asset_id`. The lifecycle index above starts at
-- `library_id`, so SQLite cannot use it for that probe and falls back to scanning the
-- whole authority table per candidate - quadratic, and slow enough to exceed the mobile
-- client's request timeout on an ordinary creator aggregation.
CREATE INDEX IF NOT EXISTS asset_authority_live_by_asset
 ON asset_authority_state(asset_id,lifecycle);
-- The durable Capture → Asset mapping. Primary key on the *Capture* is what makes
-- promotion idempotent: a retry finds this row instead of creating a second Asset.
CREATE UNIQUE INDEX IF NOT EXISTS asset_authority_by_content
 ON asset_authority_state(library_id,sha256) WHERE sha256 IS NOT NULL;
CREATE TABLE IF NOT EXISTS asset_authority_capture_map(
 library_id TEXT NOT NULL,
 capture_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 promoted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,capture_id));
CREATE INDEX IF NOT EXISTS asset_authority_capture_map_by_asset
 ON asset_authority_capture_map(library_id,asset_id);
CREATE TABLE IF NOT EXISTS asset_authority_receipts(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 command_type TEXT NOT NULL,
 asset_id TEXT,
 result_payload TEXT NOT NULL,
 accepted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,operation_id));
CREATE TABLE IF NOT EXISTS asset_authority_changes(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 command_type TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 entity_revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,sequence));
CREATE INDEX IF NOT EXISTS asset_authority_changes_operation
 ON asset_authority_changes(library_id,epoch,operation_id);
CREATE INDEX IF NOT EXISTS asset_authority_changes_prune
 ON asset_authority_changes(library_id,epoch,changed_at);
CREATE TABLE IF NOT EXISTS asset_authority_retention(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 pruned_through INTEGER NOT NULL DEFAULT 0 CHECK(pruned_through >= 0),
 pruned_at TEXT,
 PRIMARY KEY(library_id,epoch));
CREATE INDEX IF NOT EXISTS asset_authority_receipts_prune
 ON asset_authority_receipts(library_id,epoch,accepted_at);
-- The reviewed pre-activation lifecycle baseline, staged before the domain exists.
-- Deliberately outside `asset_authority_state`: nothing in this table is read by the
-- visibility projection, which consults canonical state only for an *active* domain, so
-- staging a baseline can never make an Asset visible or hidden on its own.
CREATE TABLE IF NOT EXISTS asset_authority_baseline(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 library_id TEXT NOT NULL,
 -- Digest of the committed server identity set staging was computed against.
 inventory_digest TEXT NOT NULL,
 -- Digest of the exact reviewed lifecycle assignment, which activation must present.
 snapshot_digest TEXT NOT NULL,
 payload TEXT NOT NULL,
 staged_at TEXT NOT NULL);
"""


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        # Additive migration: preserve the last known timestamp for existing Assets.
        columns = {row[1] for row in db.execute("PRAGMA table_info(asset_authority_state)")}
        if "lifecycle_changed_at" not in columns:
            db.execute("ALTER TABLE asset_authority_state ADD COLUMN "
                       "lifecycle_changed_at TEXT NOT NULL DEFAULT ''")
        db.execute("UPDATE asset_authority_state SET lifecycle_changed_at=updated_at "
                   "WHERE lifecycle_changed_at=''")
        db.execute("CREATE INDEX IF NOT EXISTS asset_authority_trash_order ON "
                   "asset_authority_state(library_id,lifecycle,lifecycle_changed_at DESC,asset_id DESC)")
        db.commit()


def fail(status=422, code="invalidAssetCommand", message="자산 명령이 올바르지 않습니다.", **extra):
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def payload_digest(library_id, epoch, contract_version, command_type, asset_id, revision):
    """Stable digest of a command's *meaning*, so a reused operation id is detected."""
    canonical = json.dumps(
        [library_id, epoch, contract_version, command_type, asset_id, revision],
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def valid_asset_id(value):
    return isinstance(value, str) and bool(ASSET_ID_PATTERN.fullmatch(value))


def canonical_asset_id(library_id, capture_id):
    """The canonical Asset id for a promoted Capture.

    Derived from `(library, capture)` through a fixed namespace so it is *stable*: the
    promotion retry recomputes the same id, which is what lets the mapping row be a
    primary-key idempotency guard rather than a race. It is deliberately not a counter —
    a counter would need a lock and would still be unsafe across a retried transaction.
    """
    return str(uuid.uuid5(PROMOTION_NAMESPACE, f"{library_id}:{capture_id}"))


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def state_row(db, library_id, asset_id):
    return db.execute(
        "SELECT lifecycle,entity_revision,kind,object_key,content_type,size_bytes,sha256,"
        "source_url,creator_name,creator_handle,collected_at,source_published_at,"
        "import_source,created_at,updated_at"
        " FROM asset_authority_state WHERE library_id=? AND asset_id=?",
        [library_id, asset_id]).fetchone()


def state_projection(row, asset_id):
    """The canonical delta a replica applies. Never contains media or secrets."""
    return {
        "assetId": asset_id,
        "lifecycle": row[0],
        "entityRevision": row[1],
        "kind": row[2],
        "objectKey": row[3],
        "contentType": row[4],
        "sizeBytes": row[5],
        "sha256": row[6],
        "sourceUrl": row[7],
        "creatorName": row[8],
        "creatorHandle": row[9],
        "collectedAt": row[10],
        "sourcePublishedAt": row[11],
        "importSource": row[12],
        "createdAt": row[13],
        "updatedAt": row[14],
    }


def authority_lifecycle(db, library_id, asset_id):
    """The canonical lifecycle for `asset_id`, or None when this domain has no row.

    Returns None while the domain is inactive, which is what lets the legacy writer treat
    "no authority opinion" and "authority says nothing about this Asset" identically.
    """
    if authority.active_domain(db, DOMAIN, library_id) is None:
        return None
    row = db.execute(
        "SELECT lifecycle FROM asset_authority_state WHERE library_id=? AND asset_id=?",
        [library_id, asset_id]).fetchone()
    return row[0] if row is not None else None


def authority_owns_lifecycle(db, library_id, asset_id):
    """Whether the server owns this Asset's lifecycle, so a legacy write must be fenced.

    True only when the domain is active *and* this Asset has canonical state. An Asset the
    authority has never seen is not fenced: the domain owns lifecycle for the Assets it
    knows about, and refusing every unknown Asset would block the ordinary PC-created
    path for no safety gain.
    """
    return authority_lifecycle(db, library_id, asset_id) is not None


def visible_asset_ids(db, library_id, asset_ids):
    """Subset of `asset_ids` an ordinary read may expose.

    Returns None when the domain is inactive, which callers read as "no authority
    opinion" and fall back to legacy visibility — the fence is on writes, not reads,
    so an inactive domain must not change what a read returns.
    """
    if authority.active_domain(db, DOMAIN, library_id) is None:
        return None
    if not asset_ids:
        return set()
    placeholders = ",".join("?" for _ in asset_ids)
    rows = db.execute(
        f"SELECT asset_id FROM asset_authority_state WHERE library_id=?"
        f" AND lifecycle='normal' AND asset_id IN ({placeholders})",
        [library_id, *asset_ids]).fetchall()
    return {row[0] for row in rows}


def hidden_asset_ids(db, library_id, asset_ids):
    """Subset that authority says is NOT normally visible; None while inactive."""
    if authority.active_domain(db, DOMAIN, library_id) is None:
        return None
    if not asset_ids:
        return set()
    placeholders = ",".join("?" for _ in asset_ids)
    rows = db.execute(
        f"SELECT asset_id FROM asset_authority_state WHERE library_id=?"
        f" AND lifecycle IN ('{TRASH}','{TOMBSTONED}') AND asset_id IN ({placeholders})",
        [library_id, *asset_ids]).fetchall()
    return {row[0] for row in rows}


CODE_ASSET_TOMBSTONED = "assetTombstoned"


def require_linkable(db, asset_id, *, adding, missing_code):
    """The Asset link rule for Classification assignment and Album membership.

    ADR-0038 §4: relationships survive trash, so a `trash` Asset may still be assigned,
    moved or added exactly like a `normal` one - otherwise a phone that trashes an Asset
    would jam the PC's queued organization of that same Asset. A `tombstoned` Asset is
    gone: every change is refused with the definitive `assetTombstoned`, which a client
    drops instead of retrying.

    `adding` additionally requires a committed Asset the authority (when active) knows as
    `normal` or `trash`; an unknown Asset fails closed with `missing_code`, the same
    fail-closed rule as the visibility projection. While the domain is inactive the
    legacy committed check is unchanged.
    """
    active = authority.active_domain(db, DOMAIN)
    lifecycle = None
    if active is not None:
        row = db.execute(
            "SELECT lifecycle FROM asset_authority_state WHERE library_id=? AND asset_id=?",
            [active["libraryId"], asset_id]).fetchone()
        lifecycle = row[0] if row is not None else None
        if lifecycle == TOMBSTONED:
            fail(409, CODE_ASSET_TOMBSTONED, "영구 삭제된 자산입니다.", assetId=asset_id)
    if not adding:
        return
    committed = db.execute("SELECT 1 FROM assets WHERE id=? AND committed=1",
                           [asset_id]).fetchone() is not None
    if not committed or (active is not None and lifecycle not in (NORMAL, TRASH)):
        fail(422, missing_code, "자산을 찾을 수 없습니다.", assetId=asset_id)


DEFAULT_TRASH_PAGE = 60
MAX_TRASH_PAGE = 100


def trash_page(db, library_id, cursor, limit):
    """Committed `trash` Assets for the mobile Library Trash, newest trash first.

    Ordered by `lifecycle_changed_at` (the moment the trash was accepted) and then by
    Asset id, so the keyset cursor `(lifecycle_changed_at, asset_id)` is total. Tombstoned Assets
    are never listed: the query reads `lifecycle='trash'` only. Returns raw rows joined
    with the server `assets` row so the caller can reuse the mobile list projection, plus
    the whole-trash count and byte total.
    """
    params = [library_id]
    clause = ""
    if cursor is not None:
        clause = " AND (state.lifecycle_changed_at<? OR (state.lifecycle_changed_at=? AND state.asset_id<?))"
        params += [cursor[0], cursor[0], cursor[1]]
    rows = db.execute(
        "SELECT asset.*, state.entity_revision AS lifecycle_revision,"
        " state.lifecycle_changed_at AS trashed_at"
        " FROM asset_authority_state AS state JOIN assets AS asset ON asset.id=state.asset_id"
        " WHERE state.library_id=? AND state.lifecycle='trash' AND asset.committed=1"
        + clause + " ORDER BY state.lifecycle_changed_at DESC, state.asset_id DESC LIMIT ?",
        [*params, limit + 1]).fetchall()
    totals = db.execute(
        "SELECT COUNT(*), COALESCE(SUM(asset.size_bytes),0)"
        " FROM asset_authority_state AS state JOIN assets AS asset ON asset.id=state.asset_id"
        " WHERE state.library_id=? AND state.lifecycle='trash' AND asset.committed=1",
        [library_id]).fetchone()
    return rows[:limit], len(rows) > limit, totals[0], totals[1]


def trash_ticket_assets(db, asset_ids):
    """`assets` rows for trash-scoped media tickets: committed and canonically `trash`.

    Never a normal or tombstoned Asset, and nothing at all while the domain is inactive -
    an inactive library has no server-side trash to preview.
    """
    active = authority.active_domain(db, DOMAIN)
    if active is None or not asset_ids:
        return {}
    placeholders = ",".join("?" for _ in asset_ids)
    return {row["id"]: dict(row) for row in db.execute(
        "SELECT asset.* FROM assets AS asset JOIN asset_authority_state AS state"
        " ON state.asset_id=asset.id AND state.library_id=?"
        f" WHERE asset.committed=1 AND state.lifecycle='trash' AND asset.id IN ({placeholders})",
        [active["libraryId"], *asset_ids]).fetchall()}


def change_items(db, library_id, epoch, after, limit, ceiling=None):
    items = []
    for row in db.execute(
            "SELECT sequence,command_type,operation_id,asset_id,payload,changed_at"
            " FROM asset_authority_changes WHERE library_id=? AND epoch=?"
            " AND sequence>? AND (? IS NULL OR sequence<=?) ORDER BY sequence LIMIT ?",
            [library_id, epoch, after, ceiling, ceiling, limit]):
        payload = json.loads(row[4])
        items.append({"sequence": row[0], "authorityCursor": row[0], "commandType": row[1],
                      "operationId": row[2], "assetId": row[3], "changedAt": row[5], **payload})
    return items


def pruned_through(db, library_id, epoch):
    row = db.execute(
        "SELECT pruned_through FROM asset_authority_retention"
        " WHERE library_id=? AND epoch=?", [library_id, epoch]).fetchone()
    return row[0] if row else 0


def expired_cursor(row):
    return HTTPException(409, detail={"code": authority.CODE_CURSOR_EXPIRED,
                                      "authorityCursor": row["cursor"],
                                      "retentionDays": RETENTION_DAYS})


def asset_page(db, library_id, after, limit):
    """Canonical Assets for a baseline walk, ordered by Asset id.

    Includes tombstones so expired-history recovery cannot retain stale normal Assets.
    Every page is pinned to one cursor and clients replace the replica atomically.
    """
    rows = db.execute(
        "SELECT asset_id,lifecycle,entity_revision,kind,object_key,content_type,size_bytes,"
        "sha256,source_url,creator_name,creator_handle,collected_at,source_published_at,"
        "import_source,created_at,updated_at"
        " FROM asset_authority_state WHERE library_id=?"
        " AND (? IS NULL OR asset_id>?) ORDER BY asset_id LIMIT ?",
        [library_id, after, after, limit]).fetchall()
    return [state_projection(row[1:], row[0]) for row in rows]


# ---------------------------------------------------------------------------
# Promotion
# ---------------------------------------------------------------------------

def promote_capture(db, *, library_id, capture_id, kind, object_key, content_type,
                    size_bytes, sha256, source_url=None, creator_name=None,
                    creator_handle=None, collected_at=None, source_published_at=None,
                    import_source=None, classification_id=None, now=None):
    """Turn a validated Capture into a canonical Asset, exactly once.

    Idempotent on `(library, capture)`: the canonical Asset id is derived from the pair,
    and the mapping row is inserted with the Asset state in the *same* transaction. A
    retry either finds the mapping and returns it unchanged, or finds neither and
    completes both — so a crash between them is impossible and a second Asset is
    unreachable.

    Returns `(asset_id, created)` where `created` is False for a retry.
    """
    timestamp = now or now_iso()
    active = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        fail(422, "captureDigestUnavailable", "검증된 콘텐츠 해시가 필요합니다.")
    existing = db.execute(
        "SELECT asset_id FROM asset_authority_capture_map WHERE library_id=? AND capture_id=?",
        [library_id, capture_id]).fetchone()
    if existing is not None:
        return existing[0], False

    duplicate = db.execute("SELECT asset_id,lifecycle FROM asset_authority_state "
                           "WHERE library_id=? AND sha256=?", [library_id, sha256]).fetchone()
    if duplicate is not None and duplicate[1] != NORMAL:
        fail(409, "duplicateInTrash" if duplicate[1] == TRASH else "duplicateTombstoned",
             "이미 삭제된 동일한 자료입니다.", assetId=duplicate[0], lifecycle=duplicate[1])
    asset_id = duplicate[0] if duplicate is not None else canonical_asset_id(library_id, capture_id)
    current = state_row(db, library_id, asset_id)
    if current is None:
        db.execute(
            "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,entity_revision,"
            "kind,object_key,content_type,size_bytes,sha256,source_url,creator_name,"
            "creator_handle,collected_at,source_published_at,import_source,created_at,"
            "updated_at,lifecycle_changed_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [library_id, asset_id, NORMAL, kind, object_key, content_type, size_bytes,
             sha256, source_url, creator_name, creator_handle, collected_at,
             source_published_at, import_source, timestamp, timestamp, timestamp])
    if duplicate is None:
        db.execute("INSERT INTO assets(id,kind,object_key,content_type,size_bytes,sha256,"
                   "created_at,updated_at,committed,collected_at,source_url,creator_name,"
                   "creator_handle,source_published_at,import_source) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)",
                   [asset_id,kind,object_key,content_type,size_bytes,sha256,timestamp,timestamp,
                    collected_at,source_url,creator_name,creator_handle,source_published_at,import_source])
    classification = authority.active_domain(db, classification_authority.DOMAIN, library_id)
    if classification is not None:
        assignment = classification_authority.assignment_row(db, library_id, asset_id)
        classification_authority.apply_command(
            db, library_id=library_id, epoch=classification["epoch"],
            contract_version=classification["contractVersion"],
            command_type=classification_authority.ASSIGNMENT,
            operation_id=str(uuid.uuid5(PROMOTION_NAMESPACE, f"assignment:{library_id}:{capture_id}")),
            entity={"assetId": asset_id, "classificationId": classification_id,
                    "expectedRevision": assignment["entity_revision"] if assignment else 0}, now=timestamp)
    elif classification_id is not None:
        fail(409, "classificationAuthorityRequired", "분류 권위를 먼저 활성화해야 합니다.")
    if duplicate is not None:
        db.execute("INSERT INTO asset_authority_capture_map VALUES(?,?,?,?)",
                   [library_id,capture_id,asset_id,timestamp])
        return asset_id, False
    try:
        db.execute(
            "INSERT INTO asset_authority_capture_map(library_id,capture_id,asset_id,promoted_at)"
            " VALUES(?,?,?,?)", [library_id, capture_id, asset_id, timestamp])
    except sqlite3.IntegrityError:
        # A concurrent promotion of the same Capture won the mapping insert; its Asset
        # is the canonical one. Re-reading keeps the two attempts in agreement instead
        # of leaving this one believing it created a second Asset.
        row = db.execute(
            "SELECT asset_id FROM asset_authority_capture_map"
            " WHERE library_id=? AND capture_id=?", [library_id, capture_id]).fetchone()
        if row is None:
            raise
        return row[0], False

    # Publication is an ordinary change row, so a replica receives a promoted Asset
    # through the same `/changes` feed as a lifecycle command. Tombstone-free by
    # construction: the state row above is `normal`.
    row = state_row(db, library_id, asset_id)
    _record_change(db, library_id=library_id, command_type="promoteCapture",
                   asset_id=asset_id, revision=1, operation_id=f"promote:{capture_id}",
                   delta={"asset": state_projection(row, asset_id)}, now=timestamp)
    return asset_id, True


def _record_change(db, *, library_id, command_type, asset_id, revision, operation_id, delta, now):
    """Append one change row and advance the domain cursor.

    Uses the same single-sequence-per-change rule as the other domains, so a client
    reading `/changes` between pages can never see a half-applied lifecycle transition.
    """
    row = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    cursor = row["cursor"]
    db.execute(
        "INSERT INTO asset_authority_changes(library_id,epoch,sequence,command_type,asset_id,"
        "entity_revision,operation_id,payload,changed_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [library_id, row["epoch"], cursor + 1, command_type, asset_id, revision,
         operation_id, json.dumps(delta, sort_keys=True, ensure_ascii=False), now])
    db.execute(
        "UPDATE authority_domains SET change_cursor=? WHERE library_id=? AND domain=?",
        [cursor + 1, library_id, DOMAIN])
    return cursor + 1


def register_replication(db, library_id, asset_id, now):
    """Publish a verified PC commit into the same canonical replica feed atomically."""
    asset = db.execute("SELECT * FROM assets WHERE id=? AND committed=1", [asset_id]).fetchone()
    if asset is None or not isinstance(asset["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"]):
        fail(422, "contentDigestRequired")
    same = db.execute("SELECT asset_id FROM asset_authority_state WHERE library_id=? AND sha256=?", [library_id, asset["sha256"]]).fetchone()
    if same and same[0] != asset_id:
        fail(409, "canonicalContentConflict", canonicalAssetId=same[0])
    old = state_row(db, library_id, asset_id)
    if old and old[6] is not None and old[6] != asset["sha256"]:
        fail(409, "canonicalContentConflict", canonicalAssetId=asset_id)
    fields = ("kind", "object_key", "content_type", "size_bytes", "sha256", "source_url", "creator_name", "creator_handle", "collected_at", "source_published_at", "import_source")
    values = [asset[k] for k in fields]
    if old and list(old[2:13]) == values:
        return
    # Android requires every emitted change to increase entityRevision. Metadata on
    # a trashed Asset must not invalidate a queued restore, so update it quietly;
    # the next lifecycle change (or baseline read) carries the latest projection.
    quiet_trash_update = old is not None and old[0] == TRASH
    revision = old[1] + 1 if old else 1
    if quiet_trash_update:
        revision = old[1]
    db.execute(
        "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,entity_revision,"
        + ",".join(fields) + ",created_at,updated_at,lifecycle_changed_at) VALUES("
        + ",".join("?" for _ in range(18))
        + ") ON CONFLICT(library_id,asset_id) DO UPDATE SET entity_revision=excluded.entity_revision,"
        + ",".join(k + "=excluded." + k for k in fields) + ",updated_at=excluded.updated_at",
        [library_id, asset_id, NORMAL, revision, *values, asset["created_at"], now, now])
    if quiet_trash_update:
        return
    _record_change(db, library_id=library_id, command_type="replicateAsset", asset_id=asset_id, revision=revision, operation_id=str(uuid.uuid4()), delta={"asset":state_projection(state_row(db,library_id,asset_id),asset_id)}, now=now)


# ---------------------------------------------------------------------------
# Lifecycle commands
# ---------------------------------------------------------------------------

#: Legal transitions. Trash is reversible; tombstone is not, at the logical layer.
_TRANSITIONS = {
    (NORMAL, TRASH): True,
    (TRASH, NORMAL): True,
    (TRASH, TOMBSTONED): True,
    (NORMAL, TOMBSTONED): True,
    (TOMBSTONED, TOMBSTONED): True,   # idempotent: tombstoning a tombstone is a no-op
    (NORMAL, NORMAL): True,           # idempotent: trashing a normal Asset twice
    (TRASH, TRASH): True,
}


def apply_command(db, *, library_id, epoch, contract_version, command_type, operation_id,
                  entity, now):
    """Execute one lifecycle command inside the caller's `BEGIN IMMEDIATE`.

    Receipts, canonical state, the ordered change and the domain cursor commit together
    or not at all. Lifecycle is compare-and-set on the Asset's own entity revision, so a
    stale client is told to rebase rather than being allowed to overwrite a newer state
    by arriving later.
    """
    row = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    if row["epoch"] != epoch:
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "자산 권위가 이 라이브러리와 일치하지 않습니다.", domain=DOMAIN)
    if contract_version != CONTRACT_VERSION:
        fail(409, authority.CODE_AUTHORITY_CONTRACT_UNSUPPORTED,
             "서버가 지원하지 않는 자산 계약 버전입니다.", domain=DOMAIN)

    asset_id = entity["assetId"]
    expected = entity["expectedEntityRevision"]
    digest = payload_digest(library_id, epoch, contract_version, command_type, asset_id, expected)
    receipt = db.execute(
        "SELECT payload_digest,result_payload FROM asset_authority_receipts"
        " WHERE library_id=? AND epoch=? AND operation_id=?",
        [library_id, epoch, operation_id]).fetchone()
    if receipt is not None:
        if receipt["payload_digest"] != digest:
            fail(409, "operationConflict", "같은 작업 ID가 다른 내용으로 이미 사용되었습니다.")
        return json.loads(receipt["result_payload"])

    current = state_row(db, library_id, asset_id)
    if current is None:
        fail(404, "assetNotFound", "자산을 찾을 수 없습니다.", assetId=asset_id)
    lifecycle, revision = current[0], current[1]
    if expected != revision:
        # Coded conflict carrying current state, so the client rebases instead of
        # retrying the same stale command forever.
        fail(409, "revisionConflict", "자산 상태가 변경되었습니다. 최신 상태로 다시 시도해 주세요.",
             assetId=asset_id, expectedEntityRevision=expected,
             currentEntityRevision=revision, lifecycle=lifecycle)

    target = {TRASH_ASSET: TRASH, RESTORE_ASSET: NORMAL, TOMBSTONE_ASSET: TOMBSTONED}[command_type]
    if not _TRANSITIONS.get((lifecycle, target), False):
        # Tombstone is terminal at the logical layer: reviving it would resurrect an
        # Asset whose deletion the change log already recorded.
        fail(409, "lifecycleTransitionRefused",
             "허용되지 않는 상태 전이입니다.", assetId=asset_id,
             lifecycle=lifecycle, requested=target)
    if (lifecycle, target) == (lifecycle, lifecycle):
        # A same-state command is accepted and receipted without a change row, so the
        # caller gets a durable answer without demanding a revision it cannot know.
        result = {"libraryId": row["libraryId"], "epoch": row["epoch"],
                  "contractVersion": row["contractVersion"], "commandType": command_type,
                  "operationId": operation_id, "changed": False, "changeSequence": None,
                  "authorityCursor": row["cursor"], "asset": None, "updatedAt": now}
        _save_receipt(db, library_id, epoch, operation_id, digest, command_type, asset_id, result, now)
        return result

    next_revision = revision + 1
    db.execute(
        "UPDATE asset_authority_state SET lifecycle=?,entity_revision=?,updated_at=?,"
        " lifecycle_changed_at=CASE WHEN lifecycle='trash' OR ?='trash' THEN ? "
        "ELSE lifecycle_changed_at END WHERE library_id=? AND asset_id=?",
        [target, next_revision, now, target, now, library_id, asset_id])
    updated = state_row(db, library_id, asset_id)
    projection = state_projection(updated, asset_id)
    sequence = _record_change(
        db, library_id=library_id, command_type=command_type, asset_id=asset_id,
        revision=next_revision, operation_id=operation_id,
        delta={"asset": projection}, now=now)
    result = {"libraryId": row["libraryId"], "epoch": row["epoch"],
              "contractVersion": row["contractVersion"], "commandType": command_type,
              "operationId": operation_id, "changed": True, "changeSequence": sequence,
              "authorityCursor": sequence, "asset": projection, "updatedAt": now}
    _save_receipt(db, library_id, epoch, operation_id, digest, command_type, asset_id, result, now)
    return result


def _save_receipt(db, library_id, epoch, operation_id, digest, command_type, asset_id, result, now):
    db.execute(
        "INSERT INTO asset_authority_receipts(library_id,epoch,operation_id,payload_digest,"
        "command_type,asset_id,result_payload,accepted_at) VALUES(?,?,?,?,?,?,?,?)",
        [library_id, epoch, operation_id, digest, command_type, asset_id,
         json.dumps(result, sort_keys=True, ensure_ascii=False), now])


def parse_command(body):
    if not isinstance(body, dict) or set(body) != COMMAND_KEYS:
        fail()
    library_id = body["libraryId"]
    epoch = body["epoch"]
    contract_version = body["contractVersion"]
    operation_id = body["operationId"]
    command_type = body["commandType"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail()
    if not isinstance(epoch, int) or epoch < 1:
        fail()
    if not isinstance(contract_version, int) or contract_version < 1:
        fail()
    if not isinstance(operation_id, str) or not UUID_PATTERN.fullmatch(operation_id):
        fail()
    if command_type not in LIFECYCLE_COMMAND_TYPES:
        fail()
    asset_id = body["assetId"]
    if not valid_asset_id(asset_id):
        fail()
    revision = body["expectedEntityRevision"]
    if not isinstance(revision, int) or revision < 1:
        fail()
    return library_id, epoch, contract_version, operation_id, command_type, {
        "assetId": asset_id, "expectedEntityRevision": revision}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def parse_staged_activation(body):
    """Validate a digest-bound activation request."""
    if not isinstance(body, dict) or set(body) != {"libraryId", "expectedSnapshotDigest"}:
        fail(422, "invalidAssetBaseline", "자산 활성화 요청이 올바르지 않습니다.")
    library_id = body["libraryId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidAssetBaseline", "라이브러리 ID가 올바르지 않습니다.")
    digest = body["expectedSnapshotDigest"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        fail(422, "invalidAssetBaseline", "기준선 다이제스트가 올바르지 않습니다.")
    return library_id, digest


def _staged_summary(db):
    """Whether a baseline is staged and what it covers. Read-only; no payload echoed."""
    stored = staged_baseline(db)
    if stored is None:
        return None
    counts = _baseline_counts(json.loads(stored["payload"])["items"])
    return {"libraryId": stored["library_id"], "inventoryDigest": stored["inventory_digest"],
            "snapshotDigest": stored["snapshot_digest"], "counts": counts,
            "stagedAt": stored["staged_at"]}


# ---------------------------------------------------------------------------
# Pre-activation lifecycle baseline
# ---------------------------------------------------------------------------

def _committed_identity(db):
    """The committed server identity set: (asset id, sha256) pairs, ordered by id."""
    return [(row[0], row[1]) for row in db.execute(
        "SELECT id,sha256 FROM assets WHERE committed=1 ORDER BY id")]


def inventory_digest(identity):
    """Digest over the exact identity set staging and activation both bind to.

    Covers the id set *and* every sha256, so it moves when an Asset is added, removed,
    or re-committed with different bytes. Lifecycle state is deliberately excluded: the
    baseline is what introduces lifecycle, so it cannot be part of the pre-existing
    server identity being digested.
    """
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def baseline_snapshot_digest(library_id, inventory, inventory_digest_value, rows):
    """Digest of the exact reviewed assignment, so activation binds to what was reviewed.

    Two operators staging against the same inventory must produce different digests if
    they disagree about any Asset's lifecycle, which is what makes the reviewed state -
    not merely the inventory - the thing activation commits to.
    """
    canonical = json.dumps(
        [library_id, inventory_digest_value,
         [[row["assetId"], row["lifecycle"], row["sha256"]] for row in rows]],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def current_inventory(db):
    """The committed server inventory a preflight or activation must agree on."""
    identity = _committed_identity(db)
    return identity, inventory_digest(identity)


def content_conflict(db):
    """A duplicate canonical sha256 across committed Assets, or None.

    Two committed Assets sharing bytes means the domain has no single canonical identity
    for that content. Staging refuses rather than picking one, because choosing would
    silently retire an Asset the operator did not review.
    """
    row = db.execute(
        "SELECT sha256 FROM assets WHERE committed=1 AND sha256 IS NOT NULL"
        " GROUP BY sha256 HAVING COUNT(*)>1 ORDER BY sha256 LIMIT 1").fetchone()
    return row[0] if row else None


def parse_baseline(body):
    """Validate the submitted lifecycle baseline envelope and its per-row shape."""
    if not isinstance(body, dict) or set(body) != {
            "libraryId", "inventoryDigest", "items"}:
        fail(422, "invalidAssetBaseline", "자산 기준선 요청이 올바르지 않습니다.")
    library_id = body["libraryId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidAssetBaseline", "라이브러리 ID가 올바르지 않습니다.")
    digest = body["inventoryDigest"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        fail(422, "invalidAssetBaseline", "재고 다이제스트가 올바르지 않습니다.")
    items = body["items"]
    if not isinstance(items, list):
        fail(422, "invalidAssetBaseline", "기준선 항목이 올바르지 않습니다.")
    rows = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"assetId", "lifecycle", "sha256"}:
            fail(422, "invalidAssetBaseline", "기준선 항목이 올바르지 않습니다.")
        asset_id, lifecycle, sha = item["assetId"], item["lifecycle"], item["sha256"]
        if not valid_asset_id(asset_id):
            fail(422, "invalidAssetBaseline", "자산 ID가 올바르지 않습니다.")
        if lifecycle not in LIFECYCLE_STATES:
            fail(422, "invalidAssetBaseline", "수명주기 값이 올바르지 않습니다.")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            fail(422, "invalidAssetBaseline", "콘텐츠 해시가 올바르지 않습니다.")
        if asset_id in seen:
            fail(409, "duplicateBaselineAsset",
                 "기준선에 같은 자산이 두 번 있습니다.", assetId=asset_id)
        seen.add(asset_id)
        rows.append({"assetId": asset_id, "lifecycle": lifecycle, "sha256": sha})
    rows.sort(key=lambda row: row["assetId"])
    return library_id, digest, rows


def stage_baseline(db, *, library_id, expected_inventory, rows, now):
    """Validate and durably stage the reviewed lifecycle baseline. Writes baseline only.

    Refuses anything that would make activation guess: an incomplete coverage set, an
    unknown Asset, a hash that disagrees with the server's committed bytes, or a
    duplicate-content conflict. Nothing here touches `asset_authority_state`, so staging
    cannot change what any read returns.
    """
    if authority.active_domain(db, DOMAIN) is not None:
        fail(409, "assetAuthorityActive", "자산 권위가 이미 활성화되어 있습니다.", domain=DOMAIN)

    identity, actual_inventory = current_inventory(db)
    if actual_inventory != expected_inventory:
        fail(409, "assetBaselineChanged",
             "서버 자산 재고가 준비 시점과 다릅니다. 다시 준비해 주세요.",
             currentInventoryDigest=actual_inventory)

    conflict = content_conflict(db)
    if conflict is not None:
        fail(409, "canonicalContentConflict",
             "기존 중복 콘텐츠를 먼저 정리해야 합니다.", sha256=conflict)

    server = dict(identity)
    staged = {row["assetId"]: row for row in rows}

    unknown = sorted(set(staged) - set(server))
    if unknown:
        fail(409, "unknownBaselineAsset",
             "서버에 없는 자산이 기준선에 포함되어 있습니다.", assetIds=unknown[:20],
             count=len(unknown))
    missing = sorted(set(server) - set(staged))
    if missing:
        # Leaving an Asset out would let activation invent a lifecycle for it, which is
        # precisely how a trashed Asset becomes visible again.
        fail(409, "incompleteBaseline",
             "기준선에 모든 커밋 자산이 포함되어야 합니다.", assetIds=missing[:20],
             count=len(missing))
    mismatch = sorted(asset_id for asset_id, sha in server.items()
                      if staged[asset_id]["sha256"] != sha)
    if mismatch:
        fail(409, "assetHashMismatch",
             "서버와 기준선의 콘텐츠 해시가 다릅니다.", assetIds=mismatch[:20],
             count=len(mismatch))

    snapshot = baseline_snapshot_digest(library_id, identity, actual_inventory, rows)
    payload = json.dumps({"libraryId": library_id, "items": rows},
                         sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    db.execute(
        "INSERT INTO asset_authority_baseline(singleton,library_id,inventory_digest,"
        "snapshot_digest,payload,staged_at) VALUES(1,?,?,?,?,?)"
        " ON CONFLICT(singleton) DO UPDATE SET library_id=excluded.library_id,"
        " inventory_digest=excluded.inventory_digest, snapshot_digest=excluded.snapshot_digest,"
        " payload=excluded.payload, staged_at=excluded.staged_at",
        [library_id, actual_inventory, snapshot, payload, now])
    return {"libraryId": library_id, "inventoryDigest": actual_inventory,
            "snapshotDigest": snapshot, "counts": _baseline_counts(rows),
            "stagedAt": now}


def _baseline_counts(rows):
    counts = {lifecycle: 0 for lifecycle in LIFECYCLE_STATES}
    for row in rows:
        counts[row["lifecycle"]] += 1
    return {"total": len(rows), **counts}


def staged_baseline(db):
    """The staged baseline row, or None. Read-only."""
    return db.execute(
        "SELECT library_id,inventory_digest,snapshot_digest,payload,staged_at"
        " FROM asset_authority_baseline WHERE singleton=1").fetchone()


def parse_staged_activation(body):
    """Validate a digest-bound activation request."""
    if not isinstance(body, dict) or set(body) != {"libraryId", "expectedSnapshotDigest"}:
        fail(422, "invalidAssetBaseline", "자산 활성화 요청이 올바르지 않습니다.")
    library_id = body["libraryId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidAssetBaseline", "라이브러리 ID가 올바르지 않습니다.")
    digest = body["expectedSnapshotDigest"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        fail(422, "invalidAssetBaseline", "기준선 다이제스트가 올바르지 않습니다.")
    return library_id, digest


def activate(db, *, library_id, expected_snapshot, now):
    """Create epoch 1 from the staged, reviewed lifecycle baseline, atomically.

    The caller owns ``BEGIN IMMEDIATE``. Creating `authority_domains` *is* the fence:
    after this commits the legacy PC replication commit observes the row and can no
    longer overwrite canonical lifecycle state. An identical retry is idempotent; a
    second activation is refused.

    Lifecycle comes from the staged baseline rather than from `normal`, because the
    server's own `committed` flag says nothing about an Asset the user already trashed
    or hard-deleted on the PC. Defaulting to `normal` here is exactly the resurrection
    this workflow exists to prevent.
    """
    libraries = sorted({entry["libraryId"] for entry in authority.active_domains(db)})
    if len(libraries) > 1:
        fail(503, authority.CODE_AUTHORITY_AMBIGUOUS,
             "동기화 권위 상태가 모호합니다.", domain=DOMAIN, libraries=libraries)
    if libraries and libraries[0] != library_id:
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "기존 서버 권위와 다른 라이브러리를 활성화할 수 없습니다.",
             domain=DOMAIN, libraryId=libraries[0])

    existing = authority.active_domain(db, DOMAIN)
    if existing is not None:
        if existing["libraryId"] == library_id:
            return {"domain": DOMAIN, "libraryId": library_id, "epoch": existing["epoch"],
                    "contractVersion": existing["contractVersion"],
                    "cursor": existing["cursor"], "activatedAt": existing["activatedAt"],
                    "baselineDigest": existing["baselineDigest"]}
        fail(409, "assetAuthorityActive", "자산 권위가 이미 활성화되어 있습니다.", domain=DOMAIN)

    # Typed rows without an authority row are an interrupted/manual state this endpoint
    # did not create. Never guess whether they are disposable.
    for table in ("asset_authority_state", "asset_authority_capture_map",
                  "asset_authority_changes", "asset_authority_receipts",
                  "asset_authority_retention"):
        if db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None:
            fail(409, "assetAuthorityStateExists",
                 "활성화되지 않은 자산 권위 상태가 이미 존재합니다.", domain=DOMAIN)

    stored = staged_baseline(db)
    if stored is None or stored["library_id"] != library_id:
        fail(409, "assetBaselineMissing",
             "활성화할 자산 기준선이 없습니다. 먼저 기준선을 준비해 주세요.")
    if stored["snapshot_digest"] != expected_snapshot:
        fail(409, "assetBaselineChanged",
             "자산 기준선이 변경되었습니다. 다시 준비해 주세요.",
             snapshotDigest=stored["snapshot_digest"])

    payload = json.loads(stored["payload"])
    rows = payload["items"]

    # Re-validate against the live inventory in the activation transaction: the staged
    # digest binds the reviewed inventory, and this recheck catches a replication commit
    # that landed between staging and activation.
    identity, actual_inventory = current_inventory(db)
    if actual_inventory != stored["inventory_digest"]:
        fail(409, "assetBaselineChanged",
             "서버 자산 재고가 준비 시점과 다릅니다. 다시 준비해 주세요.",
             currentInventoryDigest=actual_inventory)
    conflict = content_conflict(db)
    if conflict is not None:
        fail(409, "canonicalContentConflict",
             "기존 중복 콘텐츠를 먼저 정리해야 합니다.", sha256=conflict)
    server = dict(identity)
    staged = {row["assetId"]: row for row in rows}
    if set(staged) != set(server):
        fail(409, "incompleteBaseline",
             "기준선이 현재 커밋 자산 집합과 일치하지 않습니다.",
             missingCount=len(set(server) - set(staged)),
             unknownCount=len(set(staged) - set(server)))
    mismatch = [asset_id for asset_id, sha in server.items()
                if staged[asset_id]["sha256"] != sha]
    if mismatch:
        fail(409, "assetHashMismatch",
             "서버와 기준선의 콘텐츠 해시가 다릅니다.", assetIds=mismatch[:20],
             count=len(mismatch))

    lifecycle_by_id = {row["assetId"]: row["lifecycle"] for row in rows}
    db.execute(
        "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
        "baseline_digest,baseline_revision,activated_at) VALUES(?,?,1,?,0,?,NULL,?)",
        [library_id, DOMAIN, CONTRACT_VERSION, stored["snapshot_digest"], now])
    # Server canonical metadata wins for everything except lifecycle, which is the one
    # field the reviewed baseline owns. Initial revisions start at 1 and no change rows
    # are written: the baseline *is* epoch 1's starting state, not a sequence of edits.
    for asset_id, sha in identity:
        row = db.execute(
            "SELECT kind,object_key,content_type,size_bytes,sha256,source_url,creator_name,"
            "creator_handle,collected_at,source_published_at,import_source,created_at,updated_at"
            " FROM assets WHERE id=?", [asset_id]).fetchone()
        db.execute(
            "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,entity_revision,"
            "kind,object_key,content_type,size_bytes,sha256,source_url,creator_name,"
            "creator_handle,collected_at,source_published_at,import_source,created_at,updated_at,lifecycle_changed_at)"
            " VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [library_id, asset_id, lifecycle_by_id[asset_id], row[0], row[1], row[2], row[3],
             row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[12]])
    db.execute(
        "INSERT INTO asset_authority_retention(library_id,epoch,pruned_through,pruned_at)"
        " VALUES(?,1,0,NULL)", [library_id])
    db.execute("DELETE FROM asset_authority_baseline WHERE singleton=1")
    return {"domain": DOMAIN, "libraryId": library_id, "epoch": 1,
            "contractVersion": CONTRACT_VERSION, "cursor": 0, "activatedAt": now,
            "baselineDigest": stored["snapshot_digest"],
            "counts": _baseline_counts(rows)}


PREFIX = "/v1/assets/authority"


def register_asset_authority(app, get_db, require_client, require_publisher):
    """Register the Asset authority read/command routes.

    Trash and restore are reversible and accept an ordinary client credential, so the
    phone can move an Asset to the Library Trash and back. Tombstone retires an Asset
    and stays publisher-only: emptying the trash is a PC operation. This mirrors the
    Classification structural/assignment split rather than inventing a third privilege
    level.

    Startup creates the additive tables only. It never activates the domain, promotes a
    Capture or touches existing Asset rows, so a deployment that never activates behaves
    exactly as it did before; registration happens here, as in the Classification and
    Album domains, because a route whose tables were never created fails at request time
    with `no such table` instead of reporting the domain inactive.
    """
    from fastapi import Header, Request
    from fastapi.concurrency import run_in_threadpool

    lifecycle(app).on_startup(lambda _event=None: startup(get_db))

    @app.post(PREFIX + "/activate")
    async def activate_authority(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 64 * 1024:
                fail(413, "invalidAssetBaseline", "자산 활성화 요청이 너무 큽니다.")
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail(422, "invalidAssetBaseline", "자산 활성화 요청을 읽을 수 없습니다.")
        library_id, expected_snapshot = parse_staged_activation(body)

        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    state = activate(db, library_id=library_id,
                                     expected_snapshot=expected_snapshot, now=now_iso())
                    db.commit()
                    return state
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/activation-inventory")
    async def activation_inventory(libraryId: str, after: str | None = None,
                                   limit: int = DEFAULT_ASSET_PAGE,
                                   authorization: str | None = Header(default=None)):
        """Read-only committed Assets and the digest activation will bind to.

        Publisher-only because it exposes the canonical identity set an operator must
        review before activation. Snapshot-consistent: the page and the digest are read
        inside one transaction, so a caller cannot review a set that never existed.
        """
        require_publisher(authorization)
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId):
            fail()
        if not 1 <= limit <= MAX_ASSET_PAGE:
            fail()
        if after is not None and not valid_asset_id(after):
            fail()

        def run():
            with get_db() as db:
                db.execute("BEGIN")
                try:
                    identity, digest = current_inventory(db)
                    rows = [row for row in identity if after is None or row[0] > after]
                    page = rows[:limit]
                    items = []
                    for asset_id, sha in page:
                        meta = db.execute(
                            "SELECT kind,content_type,size_bytes,collected_at,created_at,"
                            "source_url,creator_handle,import_source FROM assets WHERE id=?",
                            [asset_id]).fetchone()
                        items.append({
                            "assetId": asset_id, "sha256": sha,
                            "kind": meta[0], "contentType": meta[1], "sizeBytes": meta[2],
                            "collectedAt": meta[3] or meta[4], "sourceUrl": meta[5],
                            "creatorHandle": meta[6], "importSource": meta[7]})
                    return {"libraryId": libraryId, "inventoryDigest": digest,
                            "total": len(identity), "items": items,
                            "nextAfter": page[-1][0] if len(page) == limit else None,
                            "hasMore": len(rows) > limit,
                            "contentConflictSha256": content_conflict(db),
                            "staged": _staged_summary(db)}
                finally:
                    db.rollback()
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/activation-baseline")
    async def stage_activation_baseline(request: Request,
                                        authorization: str | None = Header(default=None)):
        """Stage the reviewed lifecycle baseline. Inactive-only; never populates state."""
        require_publisher(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 32 * 1024 * 1024:
                fail(413, "invalidAssetBaseline", "자산 기준선 요청이 너무 큽니다.")
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail(422, "invalidAssetBaseline", "자산 기준선 요청을 읽을 수 없습니다.")
        library_id, expected_inventory, rows = parse_baseline(body)

        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    state = stage_baseline(db, library_id=library_id,
                                           expected_inventory=expected_inventory,
                                           rows=rows, now=now_iso())
                    db.commit()
                    return state
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/status")
    async def asset_authority_status(libraryId: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId):
            fail()

        def run():
            with get_db() as db:
                db.execute("BEGIN")
                try:
                    row = authority.active_domain(db, DOMAIN, libraryId)
                    if row is None:
                        return {"active": False, "domain": DOMAIN}
                    return {"active": True, "domain": DOMAIN, "libraryId": row["libraryId"],
                            "epoch": row["epoch"], "contractVersion": row["contractVersion"],
                            "cursor": row["cursor"]}
                finally:
                    db.rollback()
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/changes")
    async def asset_changes(request: Request, libraryId: str, epoch: int,
                            after: int = 0, limit: int = DEFAULT_CHANGE_PAGE,
                            authorization: str | None = Header(default=None),
                            if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "after", "limit"}:
            fail()
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            fail()
        if after < 0 or not 1 <= limit <= MAX_CHANGE_PAGE:
            fail()

        def run():
            with get_db() as db:
                # Identity, cursor, retention floor and rows must describe one snapshot:
                # read as separate autocommit statements a concurrent command could
                # commit between them, and the response would advertise an older cursor
                # while carrying newer rows - which no replica can apply coherently.
                db.execute("BEGIN")
                try:
                    row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                    cursor = row["cursor"]
                    if row["epoch"] != epoch:
                        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH)
                    if after > cursor:
                        fail(409, "cursorAhead", "변경 커서가 권위 커서보다 앞서 있습니다.")
                    if after < pruned_through(db, libraryId, epoch):
                        raise expired_cursor(row)
                    items = change_items(db, libraryId, epoch, after, limit, ceiling=cursor)
                    next_after = items[-1]["sequence"] if items else after
                    return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                            "contractVersion": row["contractVersion"], "cursor": cursor,
                            "items": items, "nextAfter": next_after,
                            "hasMore": next_after < cursor}
                finally:
                    db.rollback()
        return conditional.json_response(await run_in_threadpool(run), if_none_match)

    @app.get(PREFIX + "/baseline")
    async def asset_baseline(request: Request, libraryId: str, epoch: int,
                             after: str | None = None, limit: int = DEFAULT_ASSET_PAGE,
                             expectedCursor: int | None = None,
                             authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "after", "limit", "expectedCursor"}:
            fail()
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            fail()
        if not 1 <= limit <= MAX_ASSET_PAGE:
            fail()
        if after is not None and not valid_asset_id(after):
            fail()

        def run():
            with get_db() as db:
                db.execute("BEGIN")
                try:
                    row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                    if row["epoch"] != epoch:
                        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH)
                    if expectedCursor is not None and expectedCursor != row["cursor"]:
                        fail(409, "baselineChanged", "기준 상태가 변경되었습니다.")
                    items = asset_page(db, libraryId, after, limit)
                    # The cursor is read in the same snapshot, so a caller that installs
                    # this page and then follows `/changes` from it cannot skip a change
                    # that committed between the two requests.
                    return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                            "contractVersion": row["contractVersion"],
                            "cursor": row["cursor"], "items": items,
                            "nextAfter": items[-1]["assetId"] if len(items) == limit else None,
                            "hasMore": len(items) == limit}
                finally:
                    db.rollback()
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/commands")
    async def asset_command(request: Request, authorization: str | None = Header(default=None)):
        # Authenticate, then decide the required role, before any envelope or field
        # validation, so an under-privileged caller learns nothing about the contract.
        # Trash and restore are reversible user intents any signed-in client may send;
        # tombstone (and any unrecognized command) stays publisher-only, which keeps
        # emptying the trash PC-only by construction.
        require_client(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 16 * 1024:
                fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail()
        declared = body.get("commandType") if isinstance(body, dict) else None
        if declared not in CLIENT_COMMAND_TYPES:
            require_publisher(authorization)
        library_id, epoch, contract_version, operation_id, command_type, entity = parse_command(body)
        now = now_iso()

        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    result = apply_command(
                        db, library_id=library_id, epoch=epoch,
                        contract_version=contract_version, command_type=command_type,
                        operation_id=operation_id, entity=entity, now=now)
                    db.commit()
                    return result
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    return lambda: startup(get_db)


def prune(get_db, days=RETENTION_DAYS, receipt_days=RECEIPT_RETENTION_DAYS, now=None):
    """Drop history older than the retention window, keeping lifecycle state.

    Asset *state* is never pruned: a tombstone must outlive its change row, because "no
    change row" must never be read as "this Asset was deleted".
    """
    moment = now or datetime.now(timezone.utc)
    change_cutoff = (moment - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    receipt_cutoff = (moment - timedelta(days=receipt_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            floored = db.execute(
                "SELECT library_id,epoch,MAX(sequence) FROM asset_authority_changes"
                " WHERE changed_at < ? GROUP BY library_id,epoch", [change_cutoff]).fetchall()
            removed = db.execute(
                "DELETE FROM asset_authority_changes WHERE changed_at < ?",
                [change_cutoff]).rowcount
            receipts = db.execute(
                "DELETE FROM asset_authority_receipts WHERE accepted_at < ?",
                [receipt_cutoff]).rowcount
            stamp = moment.strftime("%Y-%m-%dT%H:%M:%SZ")
            for library_id, epoch, highest in floored:
                db.execute(
                    "INSERT INTO asset_authority_retention(library_id,epoch,pruned_through,"
                    "pruned_at) VALUES(?,?,?,?) ON CONFLICT(library_id,epoch) DO UPDATE SET"
                    " pruned_through=MAX(pruned_through,excluded.pruned_through),"
                    " pruned_at=excluded.pruned_at", [library_id, epoch, highest, stamp])
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return {"changes": removed, "receipts": receipts}
