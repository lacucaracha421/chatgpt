"""Server-owned Classification authority: structure, appearance and assignment.

ADR-0037 decision 7 puts the library structure paths first because they are the
easiest for a stale PC snapshot to overwrite, and Classification is one of those
paths. This module owns the canonical Classification model plus the read/command
contract that a later batch activates.

# Domain boundary

Canonical Classification state is exactly:

* classification identity, its ``kind`` and its trimmed non-empty name;
* parent hierarchy;
* icon/color appearance;
* the canonical Asset -> Classification assignment;
* the immutable ``originals`` role that protects one classification from rename,
  move and delete.

Asset *presentation* metadata — kind, content type, sizes, dates, creator,
availability, and the trashed-vs-normal distinction — is deliberately **not**
Classification state. The legacy ``classification_snapshots`` payload mixes the
tree with a per-classification display count; that shape is a read/publication
representation, not the canonical model. A client needing those fields reads them
from the asset domain.

Character series membership is **not** part of this domain either. The PC-only rule
that refuses to move a character-series subtree into the originals scope remains a
local derived constraint; ``classification_series``-style state is not carried here.
See "Deferred" below.

Filesystem paths are never Classification identity: identity is the stable
Classification id and the stable Asset id.

# Assignment is single-valued

An Asset is filed under **one** Classification or none. The canonical relation is
therefore ``(library_id, asset_id) -> classification_id | null`` — deliberately not
Album's independent ``(album, asset)`` desired-state relation. The primary key is the
Asset, so "assign to B" and "unassign" are the same compare-and-set on one lineage,
and two Classifications can never both claim an Asset.

Classification ids remain stable across the transition, so Android's existing
``class:<classification-id>`` collections, the Photo Picker and the SAF
``DocumentsProvider`` tree keep working. A compatibility read may keep exposing a
``classification_ids`` array as ``[]`` or ``[classification_id]``.

# Two independent revisions

Classification entity revision and assignment revision are separate clocks, because
they answer different questions:

* ``classification_authority_state.entity_revision`` versions one Classification's
  own projection (kind, name, parent, appearance, existence);
* ``classification_authority_assignments.entity_revision`` versions one Asset's
  assignment, beginning at 0 for an assignment never seen — an asset with no row is
  unassigned at revision 0.

A rename must never satisfy an assignment compare-and-set and vice versa, so a
client presents the revision of the thing it is editing and a stale one returns a
coded conflict carrying the current state instead of silently winning by arrival.

# Derived kind on move

Moving a classification can change its ``kind``: a ``root`` moved under a parent
becomes a ``tag``, and a ``tag`` moved to the top level becomes a ``root``. This is
the PC's own derivation and it is preserved here, because a replica must not have to
recompute it to understand a move.

# Deleting preserves product semantics atomically

Deleting a classification is not a tombstone-only operation. It reassigns every
directly assigned Asset to the parent (or to unassigned when the deleted node was a
root), deletes the node, and — matching the PC — refuses when the node still has
children or holds the ``originals`` role.

Structure and assignment share one authority domain precisely so this stays atomic, so
the delete is **one** accepted change: the Classification tombstone plus a
deterministic assignment transition (``fromClassificationId`` ->
``toClassificationId``, every matching assignment revision incrementing by exactly
one). A replica holding the immediately preceding cursor has the complete assignment
state — the baseline carries every assignment row, including unassigned and
not-yet-materialized ones — so it applies the whole transition in one local
transaction without a point read. Emitting one change row per affected Asset instead
would let ``GET /changes`` split the tombstone from its reassignments, so a replica
could commit a state where the Classification is deleted but only some assignments
moved. One accepted state-changing command therefore advances the cursor exactly once.

# The protected role is carried in the baseline

``originals`` is immutable authority state, not something a command can produce, so it
is never part of the change log. It is delivered with every baseline page instead, so
a fresh PC rebuilds the protected id from server authority alone. v1 has exactly one
role, so it is carried whole rather than paginated.

# Structural commands are publisher-only in v1

R2 deliberately leaves the character-series-subtree-into-originals rule as a PC-derived
constraint, so the server cannot yet enforce every structural invariant a non-PC client
could violate. ``setAssetClassification`` therefore accepts an ordinary client
credential, while create/rename/move/delete/appearance require the publisher role. The
legacy shared credential is a client and never gains publisher capability, so a non-PC
client cannot originate a structural mutation until the server can enforce every
structural rule itself. Authorization deliberately precedes command validation, so an
under-privileged caller cannot probe the command contract.

# Inactive safety and cutover boundary

Registering this module still changes no product state by itself. While no
``authority_domains(domain='classifications')`` row exists, baseline/change/command
routes report ``authorityInactive`` and every authority-aware legacy path falls back to
the shipped behavior. The publisher-only activation route is explicit and digest-bound:
it derives canonical state only from the stored version-2 staging snapshot inside one
``BEGIN IMMEDIATE`` transaction. Creating the authority row and typed baseline in that
transaction is the cutover fence; merely staging or restarting the server never activates
the domain.

After activation, the old whole-snapshot publisher is fenced, Asset replication continues
but no longer mutates Classification relations, and security-sensitive capture/SAF checks
read canonical authority state. Broader mobile/PC read adoption is intentionally later.

# Deferred to later batches

* the PC durable replica/outbox and write cutover;
* Android Classification replica/read/write slices and migration of general mobile read
  projections away from the legacy compatibility tables;
* production activation/canary and eventual retirement of legacy compatibility paths;
* carrying the character-series id set needed to enforce the series-into-originals
  rule server-side, which is what would let the client-side-only constraint be relaxed.
"""
import datetime
import hashlib
import json
import re
import sqlite3

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import authority

DOMAIN = "classifications"
CONTRACT_VERSION = 1

#: Mirrors ``catalog_bookmarks`` and ``albums`` so every cut-over domain offers one
#: offline window.
RETENTION_DAYS = 180
RECEIPT_RETENTION_DAYS = 180

#: Assignment is single-valued, so the assignment count is bounded by the asset count
#: rather than by a product of two dimensions. The count itself is bounded by
#: pagination rather than by a constant: this batch has no staging path to enforce one
#: against, and inventing an unenforced limit would misstate the contract. 2A.1 owns
#: the staged-baseline bounds when it exists.
MAX_NAME = 200

#: Baseline paging. An unpaginated response could not stay recoverable: the active
#: library already holds 8,907 assignments and commands keep changing them after
#: activation, so a domain that was recoverable at activation must not become
#: unrecoverable later. Page sizes keep the worst-case encoded page inside
#: ``MAX_BASELINE_PAGE_BYTES``; ``test_classification_authority`` measures that at the
#: documented maxima with maximum-length identifiers rather than trusting an estimate.
DEFAULT_CLASSIFICATION_PAGE = 500
MAX_CLASSIFICATION_PAGE = 1_000
DEFAULT_ASSIGNMENT_PAGE = 1_000
MAX_ASSIGNMENT_PAGE = 2_000
MAX_BASELINE_PAGE_BYTES = 2 * 1024 * 1024

CLASSIFICATIONS_SECTION = "classifications"
ASSIGNMENTS_SECTION = "assignments"
SECTIONS = (CLASSIFICATIONS_SECTION, ASSIGNMENTS_SECTION)

KINDS = ("root", "work", "tag")

#: Mirrors ``library/folder_appearance.rs``, which is the PC's source of truth for
#: what the UI can render — ``classification::update_classification_appearance``
#: validates through the same function Albums use. The server must reject anything
#: the client cannot show, so ``test_classification_authority`` compares these lists
#: against that file.
ICON_KEYS = (
    "folder", "photo", "film", "music", "book", "star", "heart", "user", "users",
    "academic-cap", "briefcase", "home", "globe", "map", "calendar", "clock",
    "bookmark", "tag", "sparkles", "bolt", "fire", "trophy", "puzzle", "cube",
    "camera", "video", "tv", "mic", "speaker", "document", "doc-text", "archive",
    "inbox", "gift", "flag", "bell", "moon", "sun", "cloud", "eye", "key", "lock",
    "search", "brush", "chat", "smile", "idea", "rocket",
)
COLOR_KEYS = ("red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan",
              "blue", "indigo", "purple", "pink")

#: Classification ids are PC UUIDs, except the migrated ``lakomics-originals`` root,
#: so the charset is the same one Albums and Assets already use.
CLASSIFICATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
ASSET_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
LIBRARY_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: Explicit command names, as ADR-0037 decision 2 requires instead of an ambiguous
#: toggle. The command name is part of the payload digest, so the same operation id
#: reused with another command conflicts.
CREATE = "createClassification"
RENAME = "renameClassification"
MOVE = "moveClassification"
APPEARANCE = "updateClassificationAppearance"
DELETE = "deleteClassification"
ASSIGNMENT = "setAssetClassification"
COMMAND_TYPES = (CREATE, RENAME, MOVE, APPEARANCE, DELETE, ASSIGNMENT)

#: Common envelope plus the exact per-command keys. A body carrying anything else is
#: a caller bug rather than a silently ignored hint.
ENVELOPE_KEYS = {"libraryId", "epoch", "contractVersion", "operationId", "commandType"}
COMMAND_KEYS = {
    CREATE: {"classificationId", "kind", "name", "parentId", "iconKey", "colorKey"},
    RENAME: {"classificationId", "name", "expectedRevision"},
    MOVE: {"classificationId", "parentId", "expectedRevision"},
    APPEARANCE: {"classificationId", "iconKey", "colorKey", "expectedRevision"},
    DELETE: {"classificationId", "expectedRevision"},
    # The assignment is keyed by the Asset, and its desired value is a classification
    # id or ``null`` for the canonical unassigned state. ``expectedRevision`` is 0 for
    # an Asset whose assignment was never changed, so it accepts 0 while a
    # classification expectation must be >= 1.
    ASSIGNMENT: {"assetId", "classificationId", "expectedRevision"},
}

DDL = """
CREATE TABLE IF NOT EXISTS classification_authority_state(
 library_id TEXT NOT NULL,
 classification_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('root','work','tag')),
 name TEXT NOT NULL,
 parent_id TEXT,
 icon_key TEXT,
 color_key TEXT,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,classification_id));
-- The PC database keeps one name per sibling set case-insensitively (migration
-- 0001). A tombstone must not reserve its name, so the index is partial; the PC
-- index is not, because the PC deletes the row instead of tombstoning it.
CREATE UNIQUE INDEX IF NOT EXISTS classification_authority_sibling_name
 ON classification_authority_state(library_id, COALESCE(parent_id,''), name COLLATE NOCASE)
 WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS classification_authority_by_parent
 ON classification_authority_state(library_id, deleted, parent_id, name COLLATE NOCASE);
-- One row per Asset: assignment is single-valued, so the Asset is the primary key.
-- ``classification_id`` NULL is the canonical unassigned state, retained as a
-- revision rather than as absence, so a later assign can present the revision it
-- observed. Revision 0 means "no row": an assignment never changed.
CREATE TABLE IF NOT EXISTS classification_authority_assignments(
 library_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 classification_id TEXT,
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,asset_id));
CREATE INDEX IF NOT EXISTS classification_authority_assignments_by_classification
 ON classification_authority_assignments(library_id,classification_id,asset_id);
-- The protected roles carried from the staging baseline. No command mutates this
-- table: the ``originals`` classification is a property of the library's structure,
-- not something a client may reassign.
CREATE TABLE IF NOT EXISTS classification_authority_roles(
 library_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('originals')),
 classification_id TEXT NOT NULL,
 PRIMARY KEY(library_id,role));
CREATE TABLE IF NOT EXISTS classification_authority_receipts(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 command_type TEXT NOT NULL,
 classification_id TEXT,
 asset_id TEXT,
 result_payload TEXT NOT NULL,
 accepted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,operation_id));
-- One row per accepted change. A state-changing command occupies exactly one sequence:
-- an atomic delete carries its whole assignment transition in that single payload, so
-- `/changes` can never split a delete into an externally committable partial state.
-- Idempotency is owned by the receipts table, which is keyed by operation id and is the
-- single place a retry is resolved.
CREATE TABLE IF NOT EXISTS classification_authority_changes(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 command_type TEXT NOT NULL,
 classification_id TEXT,
 asset_id TEXT,
 entity_revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,sequence));
CREATE INDEX IF NOT EXISTS classification_authority_changes_operation
 ON classification_authority_changes(library_id,epoch,operation_id);
-- Retention floor: `change_cursor - pruned_through` is exactly the number of
-- retained sequences, which distinguishes an expired cursor from a corrupt or
-- ahead-of-server one once rows may be deleted.
CREATE TABLE IF NOT EXISTS classification_authority_retention(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 pruned_through INTEGER NOT NULL DEFAULT 0 CHECK(pruned_through >= 0),
 pruned_at TEXT,
 PRIMARY KEY(library_id,epoch));
CREATE INDEX IF NOT EXISTS classification_authority_changes_prune
 ON classification_authority_changes(library_id,epoch,changed_at);
CREATE INDEX IF NOT EXISTS classification_authority_receipts_prune
 ON classification_authority_receipts(library_id,epoch,accepted_at);
"""


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        db.commit()


def fail(status=422, code="invalidClassificationCommand",
         message="분류 요청이 올바르지 않습니다.", **extra):
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def digest(value):
    """Deterministic digest of a JSON-able value, stable across key order."""
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def normalize_name(value):
    """Trimmed, non-empty, bounded. Mirrors ``normalized_name`` on the PC."""
    if not isinstance(value, str):
        fail(422, "invalidClassificationCommand", "분류 이름이 올바르지 않습니다.")
    name = value.strip()
    if not name:
        fail(422, "emptyClassificationName", "분류 이름은 비어 있을 수 없습니다.")
    if len(name) > MAX_NAME:
        fail(422, "classificationNameTooLong", "분류 이름이 너무 깁니다.")
    return name


def valid_appearance(icon_key, color_key):
    """Mirrors ``folder_appearance::validate``: absent is valid, unknown is not."""
    return ((icon_key is None or icon_key in ICON_KEYS)
            and (color_key is None or color_key in COLOR_KEYS))


def require_appearance(icon_key, color_key):
    if not valid_appearance(icon_key, color_key):
        fail(422, "invalidClassificationAppearance",
             "분류 아이콘 또는 색상을 사용할 수 없습니다.")
    return icon_key, color_key


def valid_classification_id(value):
    return isinstance(value, str) and bool(CLASSIFICATION_ID_PATTERN.fullmatch(value))


def valid_asset_id(value):
    return isinstance(value, str) and bool(ASSET_ID_PATTERN.fullmatch(value))


def validate_parent(kind, parent):
    """Reject a kind/parent combination the PC database could not hold.

    ``validate_parent`` on the PC is the source: a root has no parent, a work hangs
    directly under a root, and a tag must have some parent (a root, a work or another
    tag). A missing parent is a different state and is reported separately, so a
    caller can tell "this combination is invalid" from "that parent does not exist".
    """
    if kind == "root":
        valid = parent is None
    elif kind == "work":
        valid = parent is not None and parent["kind"] == "root"
    else:
        valid = parent is not None
    if not valid:
        fail(422, "invalidClassificationParent",
             "분류 종류에 맞지 않는 상위 분류입니다.",
             kind=kind, parentId=parent["classification_id"] if parent is not None else None)


def derived_kind(kind, parent):
    """The kind a move produces, mirroring the PC's own derivation.

    A ``root`` moved under a parent becomes a ``tag``; a ``tag`` moved to the top
    level becomes a ``root``. A ``work`` is unchanged here and is refused by
    :func:`validate_parent` when it would lose its root parent.
    """
    if kind == "root" and parent is not None:
        return "tag"
    if kind == "tag" and parent is None:
        return "root"
    return kind


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def classification_row(db, library_id, classification_id):
    # `classification_id` is selected so the same row can be reported by
    # `validate_parent` and by the conflict/404 bodies without a second read.
    return db.execute(
        "SELECT classification_id,kind,name,parent_id,icon_key,color_key,deleted,"
        "entity_revision FROM classification_authority_state"
        " WHERE library_id=? AND classification_id=?",
        [library_id, classification_id]).fetchone()


def classification_projection(row):
    """The full resulting Classification projection a client applies, or ``None``."""
    if row is None:
        return None
    return {"id": row["classification_id"], "kind": row["kind"], "name": row["name"],
            "parentId": row["parent_id"], "iconKey": row["icon_key"],
            "colorKey": row["color_key"], "deleted": bool(row["deleted"]),
            "entityRevision": row["entity_revision"]}


def assignment_row(db, library_id, asset_id):
    return db.execute(
        "SELECT classification_id,entity_revision"
        " FROM classification_authority_assignments WHERE library_id=? AND asset_id=?",
        [library_id, asset_id]).fetchone()


def assignment_projection(asset_id, classification_id, entity_revision):
    """One Asset's canonical assignment. ``classificationId`` NULL is unassigned."""
    return {"assetId": asset_id, "classificationId": classification_id,
            "entityRevision": entity_revision}


def holds_role(db, library_id, classification_id, role="originals"):
    """Whether this classification is the protected ``originals`` role node."""
    return db.execute(
        "SELECT 1 FROM classification_authority_roles"
        " WHERE library_id=? AND role=? AND classification_id=?",
        [library_id, role, classification_id]).fetchone() is not None


def role_projection(db, library_id):
    """The immutable role set a baseline carries, ordered by role.

    No command can produce a role, so it is never a change row; a replica learns it
    from the baseline instead. v1 has exactly one role, so the whole set is carried on
    every baseline page rather than paginated — a second section would cost the client
    a round trip to learn one id, and role count is bounded by the ``CHECK`` constraint
    in the schema rather than by library size.

    It is read on every page rather than only the first so each page is independently
    complete and a client that adopts pages out of order still ends with the right role.
    """
    return [{"role": row["role"], "classificationId": row["classification_id"]}
            for row in db.execute(
                "SELECT role,classification_id FROM classification_authority_roles"
                " WHERE library_id=? ORDER BY role", [library_id])]


def roles_identity(db, library_id):
    """Deterministic identity of the role set, so a client can detect a change.

    A role change is not reachable through the command contract, so this exists for
    replica comparison and diagnostics rather than for conflict detection.
    """
    return digest(role_projection(db, library_id))


def classification_page(db, library_id, after, limit):
    """One deterministic Classification page, ordered by id.

    ``after`` is an entity-key cursor (the last id of the previous page). It is not a
    synchronization cursor: correctness comes from the frozen snapshot cursor the
    caller already validated. Tombstoned classifications are excluded — a deleted
    node has no client-visible projection.
    """
    return db.execute(
        "SELECT classification_id,kind,name,parent_id,icon_key,color_key,"
        "entity_revision,deleted FROM classification_authority_state"
        " WHERE library_id=? AND classification_id>? AND deleted=0"
        " ORDER BY classification_id LIMIT ?", [library_id, after, limit]).fetchall()


def assignment_page(db, library_id, after, limit):
    """One deterministic assignment page, ordered by Asset id.

    Unassigned rows (``classification_id`` NULL) are included, because they are
    *revision state*, not visible assignment: a fresh client must be able to compose
    the next command for an Asset whose assignment someone already cleared, and a
    baseline that omitted the row would leave it presenting revision 0. Display
    membership is ``classification_id IS NOT NULL`` only.

    No join filters this page. Deleting a classification reassigns or clears every
    assignment that named it, so no row can reference a deleted node, and the page is
    a complete description of the assignment lineage.
    """
    return db.execute(
        "SELECT asset_id,classification_id,entity_revision"
        " FROM classification_authority_assignments WHERE library_id=? AND asset_id>?"
        " ORDER BY asset_id LIMIT ?", [library_id, after, limit]).fetchall()


def encode_page(library_id, epoch, contract_version, snapshot_cursor, section, items,
                next_after, has_more, roles):
    """One bounded baseline page, or an explicit oversized rejection.

    A page never contains more than one section, so no single response can be mistaken
    for a complete baseline. ``complete`` is true only on the final assignment page,
    which is the only point at which a client may adopt the baseline.

    ``roles`` rides on every page: the role set is immutable authority state that no
    command can change, so it has no change rows to learn it from, and a fresh replica
    must hold it before it can validate a protected-id structural command. It is small
    and bounded, so carrying it per page costs nothing a second section would not.
    """
    payload = {
        "libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
        "snapshotCursor": snapshot_cursor, "section": section, "roles": list(roles),
        "items": items, "nextAfter": next_after, "hasMore": has_more,
        "complete": section == ASSIGNMENTS_SECTION and not has_more,
    }
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_BASELINE_PAGE_BYTES:
        fail(503, "baselinePageTooLarge", "분류 기준선 페이지가 허용 크기를 초과합니다.",
             maxBytes=MAX_BASELINE_PAGE_BYTES, actualBytes=len(encoded))
    return payload


def change_items(db, library_id, epoch, after, limit, ceiling=None):
    """Ordered, self-contained change rows.

    Each row carries the canonical delta a replica applies, so a client never needs a
    point-read after every change to reconstruct authority state. Every accepted
    state-changing command occupies exactly one sequence.

    ``ceiling`` bounds the rows by the cursor the same response advertises. The caller
    reads them in one snapshot, so the bound is defense in depth rather than the
    consistency mechanism: it guarantees a row the advertised cursor does not account for
    can never be returned, even if a later change stopped reading inside a transaction.
    """
    items = []
    for row in db.execute(
            "SELECT sequence,command_type,operation_id,payload,changed_at"
            " FROM classification_authority_changes WHERE library_id=? AND epoch=?"
            " AND sequence>? AND (? IS NULL OR sequence<=?) ORDER BY sequence LIMIT ?",
            [library_id, epoch, after, ceiling, ceiling, limit]):
        payload = json.loads(row[3])
        items.append({"sequence": row[0], "authorityCursor": row[0], "commandType": row[1],
                      "operationId": row[2], "changedAt": row[4], **payload})
    return items


def pruned_through(db, library_id, epoch):
    """Highest change sequence already removed by retention pruning (0 if none)."""
    row = db.execute(
        "SELECT pruned_through FROM classification_authority_retention"
        " WHERE library_id=? AND epoch=?", [library_id, epoch]).fetchone()
    return row[0] if row else 0


def expired_cursor(row):
    """409 body telling a client its cursor predates retained history.

    Coded so it is distinguishable from the other 409s on this route; the recovery is
    a fresh Classification baseline, never "no changes".
    """
    return HTTPException(409, detail={"code": authority.CODE_CURSOR_EXPIRED,
                                      "authorityCursor": row["cursor"],
                                      "retentionDays": RETENTION_DAYS})



# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------

def parse_activation(body):
    """Validate the tiny operator request that binds activation to staged bytes."""
    if not isinstance(body, dict) or set(body) != {"libraryId", "expectedSnapshotDigest"}:
        fail(422, "invalidClassificationBaseline", "분류 활성화 요청이 올바르지 않습니다.")
    library_id = body["libraryId"]
    expected = body["expectedSnapshotDigest"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidClassificationBaseline", "라이브러리 ID가 올바르지 않습니다.")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        fail(422, "invalidClassificationBaseline", "분류 기준선 digest가 올바르지 않습니다.")
    return library_id, expected


def _activation_counts(db, library_id):
    return (
        db.execute("SELECT COUNT(*) FROM classification_authority_state WHERE library_id=?",
                   [library_id]).fetchone()[0],
        db.execute("SELECT COUNT(*) FROM classification_authority_assignments WHERE library_id=?",
                   [library_id]).fetchone()[0],
        db.execute("SELECT COUNT(*) FROM classification_authority_roles WHERE library_id=?",
                   [library_id]).fetchone()[0],
    )


def public_state(library_id, epoch, contract_version, cursor, baseline_digest,
                 baseline_revision, activated_at, counts, snapshot_version):
    return {
        "libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
        "cursor": cursor, "baselineDigest": baseline_digest,
        "baselineRevision": baseline_revision, "activatedAt": activated_at,
        "classificationCount": counts[0], "assignmentCount": counts[1],
        "roleCount": counts[2], "snapshotVersion": snapshot_version,
    }


def activate(db, *, library_id, entries, assignments, roles, baseline_digest,
             baseline_revision, now, snapshot_version):
    """Create epoch 1 from one revalidated staged v2 snapshot, atomically.

    The caller owns ``BEGIN IMMEDIATE`` and derives every collection from the stored
    staging row in that same transaction. Creating ``authority_domains`` is the fence:
    after this transaction commits, legacy writers observe the row and cannot overwrite
    canonical state. An identical retry is idempotent; no second baseline can replace an
    active epoch.
    """
    active_domains = authority.active_domains(db)
    libraries = sorted({entry["libraryId"] for entry in active_domains})
    if len(libraries) > 1:
        fail(503, authority.CODE_AUTHORITY_AMBIGUOUS,
             "동기화 권위 상태가 모호합니다.", domain=DOMAIN, libraries=libraries)
    if libraries and libraries[0] != library_id:
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "기존 서버 권위와 다른 라이브러리를 활성화할 수 없습니다.",
             domain=DOMAIN, libraryId=libraries[0])

    existing = authority.active_domain(db, DOMAIN)
    if existing is not None:
        if existing["libraryId"] == library_id and existing["baselineDigest"] == baseline_digest:
            counts = _activation_counts(db, library_id)
            return public_state(existing["libraryId"], existing["epoch"],
                                existing["contractVersion"], existing["cursor"],
                                existing["baselineDigest"], existing["baselineRevision"],
                                existing["activatedAt"], counts, snapshot_version)
        fail(409, "classificationAuthorityActive",
             "분류 권위가 이미 활성화되어 있습니다.", domain=DOMAIN)

    # Typed rows without an authority row indicate an interrupted/manual state that this
    # endpoint did not create. Never guess whether they are disposable.
    for table in ("classification_authority_state", "classification_authority_assignments",
                  "classification_authority_roles", "classification_authority_changes",
                  "classification_authority_receipts", "classification_authority_retention"):
        if db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None:
            fail(409, "classificationAuthorityStateExists",
                 "활성화되지 않은 분류 권위 상태가 이미 존재합니다.", domain=DOMAIN)

    try:
        db.executemany(
            "INSERT INTO classification_authority_state(library_id,classification_id,kind,name,"
            "parent_id,icon_key,color_key,deleted,entity_revision,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,0,1,?,?)",
            [[library_id, row["id"], row["kind"], row["name"], row["parentId"],
              row["iconKey"], row["colorKey"], now, now] for row in entries])
        db.executemany(
            "INSERT INTO classification_authority_assignments(library_id,asset_id,"
            "classification_id,entity_revision,created_at,updated_at) VALUES(?,?,?,1,?,?)",
            [[library_id, row["assetId"], row["classificationId"], now, now]
             for row in assignments])
        db.executemany(
            "INSERT INTO classification_authority_roles(library_id,role,classification_id)"
            " VALUES(?,?,?)",
            [[library_id, row["role"], row["classificationId"]] for row in roles])
    except sqlite3.IntegrityError:
        fail(422, "invalidClassificationBaseline",
             "분류 기준선을 권위 상태로 만들 수 없습니다.")

    db.execute(
        "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
        "baseline_digest,baseline_revision,activated_at) VALUES(?,?,?,?,?,?,?,?)",
        [library_id, DOMAIN, 1, CONTRACT_VERSION, 0, baseline_digest, baseline_revision, now])
    db.execute(
        "INSERT INTO classification_authority_retention(library_id,epoch,pruned_through,pruned_at)"
        " VALUES(?,?,0,NULL)", [library_id, 1])
    counts = (len(entries), len(assignments), len(roles))
    return public_state(library_id, 1, CONTRACT_VERSION, 0, baseline_digest,
                        baseline_revision, now, counts, snapshot_version)

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def payload_digest(library_id, epoch, contract_version, command_type, entity):
    """Canonical command identity digest. The operation id is deliberately excluded."""
    return hashlib.sha256(json.dumps(
        [library_id, epoch, contract_version, command_type, entity],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def classification_conflict(row, classification_id, current):
    """409 body carrying the current authoritative Classification projection."""
    return HTTPException(409, detail={
        "code": "revisionConflict",
        "authorityCursor": row["cursor"],
        "current": None if current is None or current["deleted"] else
        {"id": classification_id, "kind": current["kind"], "name": current["name"],
         "parentId": current["parent_id"], "iconKey": current["icon_key"],
         "colorKey": current["color_key"], "deleted": False,
         "entityRevision": current["entity_revision"]}})


def assignment_conflict(row, asset_id, current):
    """409 body carrying the current authoritative assignment.

    A never-seen assignment is reported as unassigned at revision 0 rather than as an
    absent relation, because that is exactly the value the caller must present next.
    """
    return HTTPException(409, detail={
        "code": "revisionConflict",
        "authorityCursor": row["cursor"],
        "current": assignment_projection(
            asset_id,
            current["classification_id"] if current is not None else None,
            current["entity_revision"] if current is not None else 0)})


def _live_child_count(db, library_id, classification_id):
    return db.execute(
        "SELECT COUNT(*) FROM classification_authority_state"
        " WHERE library_id=? AND parent_id=? AND deleted=0",
        [library_id, classification_id]).fetchone()[0]


def _creates_cycle(db, library_id, classification_id, parent_id):
    """True when placing ``classification_id`` under ``parent_id`` would revisit it.

    The walk starts from the moved node, so making a classification its own parent is
    caught here rather than needing a separate check.
    """
    seen = {classification_id}
    current = parent_id
    while current is not None:
        if current in seen:
            return True
        seen.add(current)
        row = classification_row(db, library_id, current)
        if row is None or row["deleted"]:
            return False
        current = row["parent_id"]
    return False


def _record(db, library_id, epoch, operation_id, payload_sha, command_type,
            classification_id, asset_id, result, now):
    db.execute(
        "INSERT INTO classification_authority_receipts(library_id,epoch,operation_id,"
        "payload_digest,command_type,classification_id,asset_id,result_payload,accepted_at)"
        " VALUES(?,?,?,?,?,?,?,?,?)",
        [library_id, epoch, operation_id, payload_sha, command_type, classification_id,
         asset_id, json.dumps(result, sort_keys=True, ensure_ascii=False), now])


def _delta_revision(delta):
    """The entity revision one change row describes."""
    if "classification" in delta:
        return delta["classification"]["entityRevision"]
    return delta["assignment"]["entityRevision"]


def _commit(db, row, *, library_id, epoch, operation_id, payload_sha, command_type,
            classification_id, asset_id, now, deltas, classification, assignments,
            assignment_transition=None):
    """Write the ordered changes, advance the cursor, record the receipt — together.

    ``deltas`` is empty for an accepted no-op, which is receipted without a change and
    without demanding a revision the caller could not know. A state-changing command
    occupies exactly **one** sequence, so ``changeSequence`` and ``authorityCursor`` are
    both that sequence and the cursor advances once — which is what makes a multi-entity
    effect such as a delete indivisible to a client reading ``/changes`` between pages.
    """
    if len(deltas) > 1:
        raise RuntimeError("classification command must produce exactly one change delta")
    cursor = row["cursor"]
    sequence = cursor + 1 if deltas else None
    for offset, delta in enumerate(deltas):
        db.execute(
            "INSERT INTO classification_authority_changes(library_id,epoch,sequence,"
            "command_type,classification_id,asset_id,entity_revision,operation_id,payload,"
            "changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [library_id, epoch, cursor + 1 + offset, command_type, classification_id,
             asset_id, _delta_revision(delta), operation_id,
             json.dumps(delta, sort_keys=True, ensure_ascii=False), now])
    if deltas:
        db.execute("UPDATE authority_domains SET change_cursor=?"
                   " WHERE library_id=? AND domain=?",
                   [cursor + len(deltas), library_id, DOMAIN])
    result = {"libraryId": row["libraryId"], "epoch": row["epoch"],
              "contractVersion": row["contractVersion"], "commandType": command_type,
              "operationId": operation_id, "changed": bool(deltas),
              "changeSequence": sequence,
              "authorityCursor": (cursor + len(deltas)) if deltas else cursor,
              "classification": classification, "assignments": list(assignments),
              "assignmentTransition": assignment_transition, "updatedAt": now}
    _record(db, library_id, epoch, operation_id, payload_sha, command_type,
            classification_id, asset_id, result, now)
    return result


def _apply_assignment(db, *, row, library_id, epoch, operation_id, payload_sha, entity, now):
    """Execute ``setAssetClassification`` on one Asset's assignment lineage."""
    asset_id = entity["assetId"]
    desired = entity["classificationId"]
    if desired is not None:
        target = classification_row(db, library_id, desired)
        if target is None or target["deleted"]:
            # The target must exist to be assigned; a tombstone is gone, not empty.
            fail(404, "classificationNotFound", "분류를 찾을 수 없습니다.",
                 classificationId=desired)
        if db.execute("SELECT 1 FROM assets WHERE id=? AND committed=1",
                      [asset_id]).fetchone() is None:
            fail(422, "invalidClassificationAssignment", "자산을 찾을 수 없습니다.",
                 assetId=asset_id)
    current = assignment_row(db, library_id, asset_id)
    current_value = current["classification_id"] if current is not None else None
    current_revision = current["entity_revision"] if current is not None else 0

    # ADR-0037 decision 2: an already-matching desired state is idempotent, so it is
    # accepted and receipted without a new change and without demanding a revision the
    # caller could not know. Only a real state change needs compare-and-set.
    if current_value == desired:
        return _commit(
            db, row, library_id=library_id, epoch=epoch, operation_id=operation_id,
            payload_sha=payload_sha, command_type=ASSIGNMENT,
            classification_id=desired, asset_id=asset_id, now=now, deltas=[],
            classification=None,
            assignments=[assignment_projection(asset_id, desired, current_revision)])

    if current_revision != entity["expectedRevision"]:
        raise assignment_conflict(row, asset_id, current)

    new_revision = current_revision + 1
    db.execute(
        "INSERT INTO classification_authority_assignments(library_id,asset_id,"
        "classification_id,entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?)"
        " ON CONFLICT(library_id,asset_id) DO UPDATE SET"
        " classification_id=excluded.classification_id,"
        " entity_revision=excluded.entity_revision,updated_at=excluded.updated_at",
        [library_id, asset_id, desired, new_revision, now, now])
    projection = assignment_projection(asset_id, desired, new_revision)
    return _commit(
        db, row, library_id=library_id, epoch=epoch, operation_id=operation_id,
        payload_sha=payload_sha, command_type=ASSIGNMENT,
        classification_id=desired, asset_id=asset_id, now=now,
        deltas=[{"assignment": projection}], classification=None,
        assignments=[projection])


def _delete(db, *, row, library_id, epoch, operation_id, payload_sha, entity, current,
            classification_id, now):
    """Delete one classification as **one** atomic change.

    The PC moves every directly assigned Asset to the deleted node's parent, or leaves
    them unassigned when it was a root. Both sides are reproduced here, but the result
    is expressed as one deterministic transition rather than one change row per Asset:

    * the Classification tombstone, and
    * ``fromClassificationId`` -> ``toClassificationId`` (``null`` for a root delete),
      with every matching assignment revision incrementing by exactly one.

    Structure and assignment are one authority domain precisely so this cannot be
    observed half-applied. One row per affected Asset would let ``GET /changes`` split
    the tombstone from its reassignments, so a replica could commit a page where the
    Classification is already deleted while only some assignments moved. Because the
    baseline carries *every* assignment row (unassigned and not-yet-materialized ones
    included), a replica at the preceding cursor holds the complete assignment state and
    applies this transition in one local transaction with no point read.

    The update is one predicate, so the increment cannot disagree with the reported
    count: the transition is defined by ``classification_id = from``, and that is
    exactly the set the ``UPDATE`` touches.
    """
    parent_id = current["parent_id"]
    affected = db.execute(
        "SELECT COUNT(*) FROM classification_authority_assignments"
        " WHERE library_id=? AND classification_id=?",
        [library_id, classification_id]).fetchone()[0]

    new_revision = current["entity_revision"] + 1
    db.execute(
        "UPDATE classification_authority_state SET deleted=1,parent_id=NULL,"
        "entity_revision=?,updated_at=? WHERE library_id=? AND classification_id=?",
        [new_revision, now, library_id, classification_id])
    if affected:
        # Every assignment naming the deleted classification moves, and each revision
        # increments by one — the replica reproduces the same numbers locally.
        db.execute(
            "UPDATE classification_authority_assignments SET classification_id=?,"
            "entity_revision=entity_revision+1,updated_at=?"
            " WHERE library_id=? AND classification_id=?",
            [parent_id, now, library_id, classification_id])

    tombstone = classification_projection(
        {"classification_id": classification_id, "kind": current["kind"],
         "name": current["name"], "parent_id": None, "icon_key": current["icon_key"],
         "color_key": current["color_key"], "deleted": 1,
         "entity_revision": new_revision})
    transition = {"fromClassificationId": classification_id,
                  "toClassificationId": parent_id,
                  "affectsAssignments": affected}
    delta = {"classification": tombstone, "assignmentTransition": transition}
    return _commit(
        db, row, library_id=library_id, epoch=epoch, operation_id=operation_id,
        payload_sha=payload_sha, command_type=DELETE, classification_id=classification_id,
        asset_id=None, now=now, deltas=[delta], classification=tombstone,
        assignments=[], assignment_transition=transition)


def apply_command(db, *, library_id, epoch, contract_version, command_type, operation_id,
                  entity, now):
    """Execute one typed Classification command inside the caller's ``BEGIN IMMEDIATE``.

    Receipts, canonical state, the ordered changes and the domain cursor commit
    together or not at all. Structural commands are compare-and-set on the entity
    revision; the assignment command is compare-and-set on the assignment's own
    revision. A stale writer therefore receives the current server state instead of
    overwriting a newer one, and never wins by wall-clock arrival.
    """
    row = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    if row["epoch"] != epoch:
        # A command composed against another epoch cannot present a meaningful
        # revision, so it is an identity mismatch rather than a conflict to rebase.
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "분류 권위가 이 라이브러리와 일치하지 않습니다.", domain=DOMAIN)
    if contract_version != CONTRACT_VERSION:
        fail(409, authority.CODE_AUTHORITY_CONTRACT_UNSUPPORTED,
             "서버가 지원하지 않는 분류 계약 버전입니다.", domain=DOMAIN)
    payload_sha = payload_digest(library_id, epoch, contract_version, command_type, entity)
    receipt = db.execute(
        "SELECT payload_digest,result_payload FROM classification_authority_receipts"
        " WHERE library_id=? AND epoch=? AND operation_id=?",
        [library_id, epoch, operation_id]).fetchone()
    if receipt is not None:
        if receipt["payload_digest"] != payload_sha:
            fail(409, "operationConflict", "같은 작업 ID가 다른 내용으로 이미 사용되었습니다.")
        # The recorded result is durable and never depends on later entity changes, so
        # a retry after a lost response applies exactly once with the same cursor.
        return json.loads(receipt["result_payload"])

    if command_type == ASSIGNMENT:
        return _apply_assignment(db, row=row, library_id=library_id, epoch=epoch,
                                 operation_id=operation_id, payload_sha=payload_sha,
                                 entity=entity, now=now)

    classification_id = entity["classificationId"]
    if command_type == CREATE:
        if classification_row(db, library_id, classification_id) is not None:
            # A tombstoned id is not reusable: reviving it would resurrect a
            # classification whose deletion the assignment log already recorded.
            fail(409, "classificationExists", "같은 ID의 분류가 이미 있습니다.",
                 classificationId=classification_id)
        parent_id = entity["parentId"]
        parent = None
        if parent_id is not None:
            parent = classification_row(db, library_id, parent_id)
            if parent is None or parent["deleted"]:
                fail(404, "classificationNotFound", "상위 분류를 찾을 수 없습니다.",
                     parentId=parent_id)
        validate_parent(entity["kind"], parent)
        try:
            db.execute(
                "INSERT INTO classification_authority_state(library_id,classification_id,"
                "kind,name,parent_id,icon_key,color_key,deleted,entity_revision,created_at,"
                "updated_at) VALUES(?,?,?,?,?,?,?,0,1,?,?)",
                [library_id, classification_id, entity["kind"], entity["name"], parent_id,
                 entity["iconKey"], entity["colorKey"], now, now])
        except sqlite3.IntegrityError:
            fail(409, "duplicateClassificationName", "같은 위치에 같은 이름의 분류가 있습니다.",
                 classificationId=classification_id)
        projection = classification_projection(
            {"classification_id": classification_id, "kind": entity["kind"],
             "name": entity["name"], "parent_id": parent_id, "icon_key": entity["iconKey"],
             "color_key": entity["colorKey"], "deleted": 0, "entity_revision": 1})
        return _commit(
            db, row, library_id=library_id, epoch=epoch, operation_id=operation_id,
            payload_sha=payload_sha, command_type=command_type,
            classification_id=classification_id, asset_id=None, now=now,
            deltas=[{"classification": projection}], classification=projection,
            assignments=[])

    current = classification_row(db, library_id, classification_id)
    if current is None or current["deleted"]:
        fail(404, "classificationNotFound", "분류를 찾을 수 없습니다.",
             classificationId=classification_id)

    # The protected ``originals`` node is refused before the revision check, and for
    # every structural command. Its protection is a property of the library structure,
    # not a concurrency question, so telling a client to rebase a command that can
    # never succeed would be misleading. This matches the PC, which refuses the same
    # three operations on that node.
    if command_type in (RENAME, MOVE, DELETE) and holds_role(
            db, library_id, classification_id):
        fail(409, "protectedClassification",
             "보호된 분류는 이름 변경·이동·삭제할 수 없습니다.",
             classificationId=classification_id)

    if command_type == DELETE:
        # A classification with children cannot be deleted, matching the PC and the
        # PC schema's own `ON DELETE RESTRICT`. Reassignment therefore always has a
        # parent to target unless the deleted node was a root.
        if _live_child_count(db, library_id, classification_id):
            fail(409, "classificationHasChildren",
                 "하위 분류가 있는 분류는 삭제할 수 없습니다.",
                 classificationId=classification_id)
        if current["entity_revision"] != entity["expectedRevision"]:
            raise classification_conflict(row, classification_id, current)
        return _delete(db, row=row, library_id=library_id, epoch=epoch,
                       operation_id=operation_id, payload_sha=payload_sha, entity=entity,
                       current=current, classification_id=classification_id, now=now)

    if current["entity_revision"] != entity["expectedRevision"]:
        raise classification_conflict(row, classification_id, current)

    new_revision = current["entity_revision"] + 1
    target = {"kind": current["kind"], "name": current["name"],
              "parent_id": current["parent_id"], "icon_key": current["icon_key"],
              "color_key": current["color_key"], "deleted": 0}
    if command_type == RENAME:
        target["name"] = entity["name"]
    elif command_type == MOVE:
        parent_id = entity["parentId"]
        parent = None
        if parent_id is not None:
            parent = classification_row(db, library_id, parent_id)
            if parent is None or parent["deleted"]:
                fail(404, "classificationNotFound", "상위 분류를 찾을 수 없습니다.",
                     parentId=parent_id)
        # Order matters and follows the PC: the kind/parent combination is validated
        # first, so "a work cannot become a top-level root" is reported as an invalid
        # parent rather than as a cycle.
        target["kind"] = derived_kind(current["kind"], parent)
        validate_parent(target["kind"], parent)
        if parent_id is not None and _creates_cycle(
                db, library_id, classification_id, parent_id):
            fail(422, "classificationCycle",
                 "분류를 자기 자신이나 하위로 옮길 수 없습니다.",
                 classificationId=classification_id, parentId=parent_id)
        target["parent_id"] = parent_id
    else:
        target["icon_key"], target["color_key"] = entity["iconKey"], entity["colorKey"]
    try:
        db.execute(
            "UPDATE classification_authority_state SET kind=?,name=?,parent_id=?,"
            "icon_key=?,color_key=?,deleted=?,entity_revision=?,updated_at=?"
            " WHERE library_id=? AND classification_id=?",
            [target["kind"], target["name"], target["parent_id"], target["icon_key"],
             target["color_key"], target["deleted"], new_revision, now, library_id,
             classification_id])
    except sqlite3.IntegrityError:
        # A sibling-name UNIQUE violation at a valid current revision is a naming
        # problem, not a concurrency problem. Conflating the two would tell the user to
        # rebase when the real fix is a different name.
        fail(409, "duplicateClassificationName", "같은 위치에 같은 이름의 분류가 있습니다.",
             classificationId=classification_id)
    projection = classification_projection(
        {"classification_id": classification_id, "kind": target["kind"],
         "name": target["name"], "parent_id": target["parent_id"],
         "icon_key": target["icon_key"], "color_key": target["color_key"],
         "deleted": target["deleted"], "entity_revision": new_revision})
    return _commit(
        db, row, library_id=library_id, epoch=epoch, operation_id=operation_id,
        payload_sha=payload_sha, command_type=command_type,
        classification_id=classification_id, asset_id=None, now=now,
        deltas=[{"classification": projection}], classification=projection,
        assignments=[])


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# A dedicated prefix rather than bare ``/v1/classifications/...`` paths, because the
# legacy PC-published snapshot surface already owns ``/v1/classifications`` and
# ``/v1/classifications/meta``. Keeping every authority route under one prefix means
# the authority contract can never be mistaken for, or shadow, that publication.
PREFIX = "/v1/classifications/authority"


def _classification_revision(value):
    """Classification entity expectations start at 1: a live node has revision 1+."""
    if type(value) is not int or value < 1:
        fail(422, "invalidClassificationRevision", "분류 revision 값이 올바르지 않습니다.")
    return value


def _assignment_revision(value):
    """Assignment expectations start at 0: an unassigned Asset has no row."""
    if type(value) is not int or value < 0:
        fail(422, "invalidClassificationRevision", "분류 배정 revision 값이 올바르지 않습니다.")
    return value


def parse_command(body):
    """Validate the ADR-0037 envelope plus exactly one command's own keys."""
    if not isinstance(body, dict) or not ENVELOPE_KEYS <= set(body):
        fail(422, "invalidClassificationCommand", "분류 명령 봉투가 불완전합니다.")
    command_type = body["commandType"]
    if command_type not in COMMAND_TYPES:
        fail(422, "unsupportedClassificationCommand", "지원하지 않는 분류 명령입니다.")
    if set(body) != ENVELOPE_KEYS | COMMAND_KEYS[command_type]:
        fail(422, "invalidClassificationCommand", "분류 명령 필드가 올바르지 않습니다.")
    library_id = body["libraryId"]
    epoch = body["epoch"]
    contract_version = body["contractVersion"]
    operation_id = body["operationId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidClassificationCommand", "라이브러리 ID가 올바르지 않습니다.")
    if type(epoch) is not int or epoch < 1:
        fail(422, "invalidClassificationCommand", "분류 권위 epoch 값이 올바르지 않습니다.")
    if type(contract_version) is not int or contract_version < 1:
        fail(422, "invalidClassificationCommand", "분류 계약 버전이 올바르지 않습니다.")
    if not isinstance(operation_id, str) or not UUID_PATTERN.fullmatch(operation_id):
        fail(422, "invalidClassificationCommand", "작업 ID가 올바르지 않습니다.")
    if command_type == ASSIGNMENT:
        asset_id = body["assetId"]
        if not valid_asset_id(asset_id):
            fail(422, "invalidClassificationCommand", "자산 ID가 올바르지 않습니다.")
        classification_id = body["classificationId"]
        if classification_id is not None and not valid_classification_id(classification_id):
            fail(422, "invalidClassificationCommand", "분류 ID가 올바르지 않습니다.")
        return library_id, epoch, contract_version, operation_id, command_type, {
            "assetId": asset_id, "classificationId": classification_id,
            "expectedRevision": _assignment_revision(body["expectedRevision"])}

    classification_id = body["classificationId"]
    if not valid_classification_id(classification_id):
        fail(422, "invalidClassificationCommand", "분류 ID가 올바르지 않습니다.")
    entity = {"classificationId": classification_id}
    if command_type == CREATE:
        kind = body["kind"]
        if kind not in KINDS:
            fail(422, "invalidClassificationKind", "지원하지 않는 분류 종류입니다.",
                 kind=kind if isinstance(kind, str) else None)
        parent_id = body["parentId"]
        if parent_id is not None and not valid_classification_id(parent_id):
            fail(422, "invalidClassificationCommand", "상위 분류 ID가 올바르지 않습니다.")
        icon_key, color_key = require_appearance(body["iconKey"], body["colorKey"])
        entity.update(kind=kind, name=normalize_name(body["name"]), parentId=parent_id,
                      iconKey=icon_key, colorKey=color_key)
    elif command_type == RENAME:
        entity["name"] = normalize_name(body["name"])
        entity["expectedRevision"] = _classification_revision(body["expectedRevision"])
    elif command_type == MOVE:
        parent_id = body["parentId"]
        if parent_id is not None and not valid_classification_id(parent_id):
            fail(422, "invalidClassificationCommand", "상위 분류 ID가 올바르지 않습니다.")
        entity.update(parentId=parent_id,
                      expectedRevision=_classification_revision(body["expectedRevision"]))
    elif command_type == APPEARANCE:
        icon_key, color_key = require_appearance(body["iconKey"], body["colorKey"])
        entity.update(iconKey=icon_key, colorKey=color_key,
                      expectedRevision=_classification_revision(body["expectedRevision"]))
    else:
        entity["expectedRevision"] = _classification_revision(body["expectedRevision"])
    return library_id, epoch, contract_version, operation_id, command_type, entity


def parse_baseline_request(params, epoch):
    """Resolve a baseline page request against the frozen snapshot cursor.

    Two cursors are deliberately distinct: ``snapshot`` freezes *which* materialized
    state the pages describe, while ``after`` walks the deterministic order within one
    section. Neither is a UI pagination cursor.
    """
    if not LIBRARY_ID_PATTERN.fullmatch(params.get("libraryId", "")) or epoch < 1:
        fail(422, "invalidClassificationBaseline", "분류 기준선 요청이 올바르지 않습니다.")
    snapshot = params.get("snapshot")
    section = params.get("section")
    if snapshot is None:
        # First request: only the library and epoch are meaningful. A section or cursor
        # here would describe a page of an unfrozen baseline.
        if section is not None or params.get("after") is not None:
            fail(422, "invalidClassificationBaseline",
                 "기준선 첫 요청에는 snapshot/section/after를 지정할 수 없습니다.")
        section = CLASSIFICATIONS_SECTION
        after = ""
    else:
        if section not in SECTIONS:
            fail(422, "invalidClassificationBaseline", "기준선 section이 올바르지 않습니다.")
        after = params.get("after", "")
    limit = params.get("limit")
    if section == CLASSIFICATIONS_SECTION:
        maximum, default = MAX_CLASSIFICATION_PAGE, DEFAULT_CLASSIFICATION_PAGE
    else:
        maximum, default = MAX_ASSIGNMENT_PAGE, DEFAULT_ASSIGNMENT_PAGE
    if limit is None:
        limit = default
    else:
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            fail(422, "invalidClassificationBaseline", "기준선 limit이 올바르지 않습니다.")
        if not 1 <= limit <= maximum:
            fail(422, "invalidClassificationBaseline", "기준선 limit이 올바르지 않습니다.")
    if snapshot is not None:
        try:
            snapshot = int(snapshot)
        except (TypeError, ValueError):
            fail(422, "invalidClassificationBaseline",
                 "기준선 snapshot 커서가 올바르지 않습니다.")
        if snapshot < 0:
            fail(422, "invalidClassificationBaseline",
                 "기준선 snapshot 커서가 올바르지 않습니다.")
    return snapshot, section, after, limit


def assignment_projection_many(db, library_id, asset_ids):
    """Canonical ``classification_ids`` for a page of Assets, keyed by Asset id.

    The mobile Asset projection carries ``classification_ids`` for compatibility, and after
    cutover the *only* writer of an Asset's Classification is the authority command lane:
    ``asset_classifications`` is deliberately left untouched by replication so a stale
    commit cannot revert an accepted command. A read that still joins that table therefore
    reports the pre-activation membership — the Asset keeps appearing under the
    Classification it was moved away from, and a newly assigned Classification stays empty.

    The projectable value is authority-backed exactly as ADR-0037 records: ``[]`` for an
    Asset the authority has never mentioned, and ``[]`` or ``[classification_id]`` for one
    it has. The returned map omits unmentioned Assets rather than naming them, so a caller
    keeps its own empty default and a stale legacy row cannot leak through.

    The query is bounded by the requested Assets rather than by the library. Filtering a
    full-library read would return the same rows while walking every assignment already
    stored (production holds ~8,936), which is the wrong shape for a per-page projection;
    this uses the ``(library_id, asset_id)`` primary key as a seek. Callers therefore pass
    at most one HTTP page of ids.
    """
    if not asset_ids:
        return {}
    # The id list is the page the caller already resolved, so its length is bounded by the
    # route's own limit; SQLite's parameter ceiling is far above any page size.
    ordered = sorted(asset_ids)
    placeholders = ",".join("?" for _ in ordered)
    memberships = {}
    for row in db.execute(
        f"""
        SELECT asset_id, classification_id
        FROM classification_authority_assignments
        WHERE library_id = ?
          AND asset_id IN ({placeholders})
          AND classification_id IS NOT NULL
        ORDER BY asset_id, classification_id
        """,
        [library_id, *ordered],
    ).fetchall():
        membership = memberships.setdefault(row["asset_id"], [])
        membership.append(row["classification_id"])
    return memberships


def classification_counts(db, library_id):
    """Live ``asset_count`` per Classification, computed from canonical assignment state.

    The sidebar count and the membership filter must agree, so both are derived from
    ``classification_authority_assignments``. The count is an index over that one table; the
    classification rows it belongs to come from the published snapshot, not from here.
    """
    counts = {}
    for row in db.execute(
        """
        SELECT classification_id, COUNT(*) AS asset_count
        FROM classification_authority_assignments
        WHERE library_id = ? AND classification_id IS NOT NULL
        GROUP BY classification_id
        """,
        [library_id],
    ).fetchall():
        counts[row["classification_id"]] = row["asset_count"]
    return counts


def _display_key(row, order):
    """The sort key one live Classification has in the shipped flat tree list.

    ``order`` maps an id to the ``(position, parentId)`` it was displayed at in the
    frozen publication — the *only* thing the legacy snapshot still contributes. A
    position ranks a node inside the sibling set it was observed in, so a node that has
    since been moved (its recorded parent no longer matches its authority parent) is an
    arrival in its new set rather than an existing member of it, and cannot carry a
    display slot into a set it never belonged to.

    An unranked node — created after activation, or moved into this set — sorts after
    every ranked node, and unranked nodes order among themselves by ``created_at`` and
    then id. Both are stored authority columns and both are immutable (a rename or a
    second move cannot reshuffle the order), so this is deterministic across requests and
    restarts while a created node stays visible instead of needing a display slot. The id
    breaks the tie because a bulk activation stamps one ``created_at`` on every row.
    """
    ranked = order.get(row["classification_id"]) if order else None
    if ranked is not None and ranked[1] == row["parent_id"]:
        return (0, ranked[0], "", row["classification_id"])
    return (1, 0, row["created_at"], row["classification_id"])


def compatibility_tree(db, active, order=None):
    """The active Classification tree, projected for the shipped compatibility readers.

    One projection for every authority-backed tree reader. The canonical structural state
    is authority-only — existence (a deleted node is absent), id, kind, name, parent,
    icon, color — because after cutover the authority command lane is the only writer, so
    a tree read from the frozen publication keeps showing the pre-activation hierarchy
    however many accepted commands have moved, renamed, created or deleted nodes since.
    ``order`` supplies display position only and can never override those fields.

    The list is flat, exactly as the shipped route is: a consumer re-parents it from
    ``parent_id`` itself and keeps each parent's relative order, so a node's
    ``sort_index`` is its position in the list this returns. Emitting every live row
    guarantees the two properties an authority tree needs: a node is never dropped for
    being unreachable (so a create stays visible) and a deleted node can never linger.

    ``active`` is the caller's own authority read, so the tree it describes and the
    authority identity it was read under are one state. Counts come from the same
    transaction for the same reason.
    """
    library_id = active["libraryId"]
    counts = classification_counts(db, library_id)
    # No ORDER BY: the projection orders the rows itself, so a database sort would only add
    # a temporary B-tree over the whole library. This is one indexed read of the live rows —
    # never one query per Classification.
    rows = db.execute(
        "SELECT classification_id,kind,name,parent_id,icon_key,color_key,created_at"
        " FROM classification_authority_state"
        " WHERE library_id=? AND deleted=0",
        [library_id]).fetchall()
    return [{"id": row["classification_id"], "kind": row["kind"], "name": row["name"],
             "parent_id": row["parent_id"], "icon_key": row["icon_key"],
             "color_key": row["color_key"], "sort_index": index,
             "asset_count": counts.get(row["classification_id"], 0)}
            for index, row in enumerate(sorted(rows, key=lambda row: _display_key(row, order)))]


def register_classification_authority(app, get_db, require_client, require_publisher):
    """Register the Classification authority read/command routes.

    There is deliberately no activation route: this batch ships the inactive substrate
    only, so startup creates empty tables and a deployment that never activates the
    domain behaves exactly as it did before.

    Authorization separates the two write classes, using the shipped role guards rather
    than a new role system. ``setAssetClassification`` is an ordinary client operation,
    because assignment is the product's normal organization action. Every structural
    command requires ``publisher``, because R2 leaves the character-series-into-originals
    rule as a PC-derived constraint: until the server can enforce every structural
    invariant itself, a non-PC client must not be able to originate a structural
    mutation. The legacy shared credential is accepted only as a client by
    ``client_guard`` and is never a publisher, so it cannot acquire that capability
    through this route.
    """
    app.on_event("startup")(lambda _event=None: startup(get_db))

    @app.post(PREFIX + "/activate")
    async def activate_authority(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 64 * 1024:
                fail(413, "invalidClassificationBaseline", "분류 활성화 요청이 너무 큽니다.")
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail(422, "invalidClassificationBaseline", "분류 활성화 요청을 읽을 수 없습니다.")
        library_id, expected = parse_activation(body)

        def run():
            # Local import avoids a module-import cycle: staging deliberately reuses
            # validators from this authority module. At request time both modules are
            # fully initialized.
            import classification_snapshot

            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    stored = db.execute(
                        "SELECT payload,published_at FROM classification_snapshots"
                        " WHERE singleton=1").fetchone()
                    if stored is None:
                        fail(409, "classificationSnapshotMissing",
                             "활성화할 분류 스냅샷이 없습니다.")
                    actual = classification_snapshot.stored_digest(stored["payload"])
                    if actual != expected:
                        fail(409, "classificationBaselineChanged",
                             "분류 기준선이 변경되었습니다. 다시 준비해 주세요.")
                    entries, assignments, roles, snapshot_version = (
                        classification_snapshot.authority_ready_state(stored["payload"]))
                    state = activate(
                        db, library_id=library_id, entries=entries, assignments=assignments,
                        roles=roles, baseline_digest=actual,
                        baseline_revision=stored["published_at"], now=now_iso(),
                        snapshot_version=snapshot_version)
                    db.commit()
                    return state
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/baseline")
    async def classification_baseline(request: Request, libraryId: str, epoch: int,
                                      authorization: str | None = Header(default=None)):
        require_client(authorization)
        params = dict(request.query_params)
        if set(params) - {"libraryId", "epoch", "snapshot", "section", "after", "limit"}:
            fail(422, "invalidClassificationBaseline", "분류 기준선 요청이 올바르지 않습니다.")
        snapshot, section, after, limit = parse_baseline_request(params, epoch)
        if section == CLASSIFICATIONS_SECTION and after and not valid_classification_id(after):
            fail(422, "invalidClassificationBaseline",
                 "기준선 분류 커서가 올바르지 않습니다.")
        if section == ASSIGNMENTS_SECTION and after and not valid_asset_id(after):
            fail(422, "invalidClassificationBaseline",
                 "기준선 배정 커서가 올바르지 않습니다.")

        def run():
            with get_db() as db:
                # One explicit read transaction covers the authority-row/cursor read and
                # the page-state read. Python's sqlite3 does not begin a transaction for
                # a bare SELECT in this configuration, so without this a command could
                # commit between them and the response would be labeled with an older
                # `snapshotCursor` while carrying newer canonical state — a page that
                # describes no state the authority ever held. `BEGIN` (deferred) takes a
                # read snapshot at the first read below and holds it to the end.
                db.execute("BEGIN")
                try:
                    row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                    cursor = row["cursor"]
                    if snapshot is None:
                        snapshot_cursor = cursor
                    else:
                        # Every Classification mutation advances this domain's cursor,
                        # so equality with the frozen value is exactly the proof that the
                        # materialized state did not change between pages. This is the
                        # cross-request check; the read transaction above is what makes
                        # each individual page internally coherent.
                        if snapshot != cursor:
                            fail(409, "baselineChanged",
                                 "기준선 페이지를 읽는 동안 분류가 변경되었습니다."
                                 " 다시 시작해 주세요.",
                                 snapshotCursor=snapshot, authorityCursor=cursor)
                        snapshot_cursor = snapshot
                    if section == CLASSIFICATIONS_SECTION:
                        fetched = classification_page(db, libraryId, after, limit + 1)
                        items = [{"id": item["classification_id"], "kind": item["kind"],
                                  "name": item["name"], "parentId": item["parent_id"],
                                  "iconKey": item["icon_key"], "colorKey": item["color_key"],
                                  "deleted": bool(item["deleted"]),
                                  "entityRevision": item["entity_revision"]}
                                 for item in fetched[:limit]]
                        has_more = len(fetched) > limit
                        next_after = items[-1]["id"] if has_more and items else None
                    else:
                        fetched = assignment_page(db, libraryId, after, limit + 1)
                        # ``classificationId`` is the authoritative value, nullable by
                        # design: an unassigned Asset is revision state a client needs in
                        # order to compose its next command, and it is not visible
                        # membership.
                        items = [assignment_projection(item["asset_id"],
                                                       item["classification_id"],
                                                       item["entity_revision"])
                                 for item in fetched[:limit]]
                        has_more = len(fetched) > limit
                        next_after = items[-1]["assetId"] if has_more and items else None
                    return encode_page(row["libraryId"], row["epoch"],
                                       row["contractVersion"], snapshot_cursor, section,
                                       items, next_after, has_more,
                                       role_projection(db, libraryId))
                finally:
                    db.rollback()
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/changes")
    async def classification_changes(request: Request, libraryId: str, epoch: int,
                                     after: int = 0, limit: int = 100,
                                     authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "after", "limit"}:
            fail(422, "invalidClassificationCommand", "분류 변경 요청이 올바르지 않습니다.")
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            fail(422, "invalidClassificationCommand", "분류 변경 요청이 올바르지 않습니다.")
        if after < 0 or not 1 <= limit <= 500:
            fail(422, "invalidClassificationCommand", "분류 변경 요청이 올바르지 않습니다.")

        def run():
            with get_db() as db:
                # The authority identity, the advertised cursor, the retention floor and
                # the returned change rows must all describe one database snapshot. Read
                # separately — as four autocommit statements — a concurrent command can
                # commit between them, and the response then advertises the older cursor
                # while carrying rows from the newer one. A replica cannot apply that
                # coherently: it would be told `cursor = 10` with `nextAfter = 11`.
                #
                # WAL does not fix this on its own. It gives each *statement* a snapshot,
                # not a group of statements, so the inconsistency is only removed by
                # reading them inside one explicit read transaction. This mirrors the
                # baseline endpoint, which already pins its whole multi-page walk.
                db.execute("BEGIN")
                try:
                    row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                    cursor = row["cursor"]
                    if after > cursor:
                        # A cursor beyond the server is authority skew, not retention. A
                        # fresh baseline resolves both, but the distinction matters for the
                        # client's error surface.
                        fail(409, "cursorAhead", "변경 커서가 권위 커서보다 앞서 있습니다.")
                    # A cursor at or below the pruned floor has a real gap behind it.
                    # Reporting "no changes" would silently drop accepted mutations.
                    if after < pruned_through(db, libraryId, epoch):
                        raise expired_cursor(row)
                    # Bounded by the advertised cursor as well as by `after`, so no row can
                    # be returned that the same response's cursor does not yet account for.
                    # The snapshot already makes this unreachable; the explicit bound keeps
                    # it unreachable if a later change drops the transaction.
                    items = change_items(db, libraryId, epoch, after, limit, ceiling=cursor)
                    next_after = items[-1]["sequence"] if items else after
                    return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                            "contractVersion": row["contractVersion"], "cursor": cursor,
                            "items": items, "nextAfter": next_after, "hasMore": next_after < cursor}
                finally:
                    db.rollback()
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/commands")
    async def classification_command(request: Request,
                                     authorization: str | None = Header(default=None)):
        # Authenticate first, then decide *which* role the declared command needs,
        # before any envelope or field validation runs. Doing it in this order means an
        # under-privileged caller learns nothing about the command contract: a client
        # that declares a structural command is rejected as unauthorized rather than
        # being told whether its payload would have been valid.
        require_client(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 16 * 1024:
                fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail(422, "invalidClassificationCommand", "분류 명령을 읽을 수 없습니다.")
        declared = body.get("commandType") if isinstance(body, dict) else None
        if not isinstance(declared, str) or declared != ASSIGNMENT:
            # Only the assignment command is an ordinary client operation. Anything
            # else — including an unrecognized command name — requires the publisher
            # role, so a non-PC client cannot originate a structural mutation while R2
            # leaves the character-series originals rule to the PC.
            require_publisher(authorization)
        library_id, epoch, contract_version, operation_id, command_type, entity = \
            parse_command(body)
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
    """Drop history older than the retention window, keeping tombstones.

    Classification *state* is never pruned: a tombstone must outlive its change row,
    because "no change row" must never be read as "this classification was deleted".
    """
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    change_cutoff = (moment - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    receipt_cutoff = (moment - datetime.timedelta(days=receipt_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            floored = db.execute(
                "SELECT library_id,epoch,MAX(sequence) FROM classification_authority_changes"
                " WHERE changed_at < ? GROUP BY library_id,epoch", [change_cutoff]).fetchall()
            removed = db.execute(
                "DELETE FROM classification_authority_changes WHERE changed_at < ?",
                [change_cutoff]).rowcount
            receipts = db.execute(
                "DELETE FROM classification_authority_receipts WHERE accepted_at < ?",
                [receipt_cutoff]).rowcount
            stamp = moment.strftime("%Y-%m-%dT%H:%M:%SZ")
            for library_id, epoch, highest in floored:
                db.execute(
                    "INSERT INTO classification_authority_retention(library_id,epoch,"
                    "pruned_through,pruned_at) VALUES(?,?,?,?) ON CONFLICT(library_id,epoch)"
                    " DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through),"
                    " pruned_at=excluded.pruned_at", [library_id, epoch, highest, stamp])
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return {"changes": removed, "receipts": receipts}
