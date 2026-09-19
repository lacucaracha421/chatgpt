"""Server-owned Album authority: the second real shared domain after bookmarks.

ADR-0037 decision 7 puts the library structure paths first because they are the
easiest for a stale PC snapshot to overwrite. Albums are one of those paths, so this
module owns the canonical Album model plus the activation and fencing contract that
lets the legacy ``album_replica`` snapshot be retired later.

# Domain boundary

Canonical Album state is exactly:

* album identity and its trimmed non-empty name;
* parent hierarchy;
* icon/color appearance;
* Asset <-> Album membership, including its own revision and tombstone state.

Asset *presentation* metadata — collected time, dimensions, video duration, media
variants — is deliberately **not** Album state. The legacy ``album_replica`` snapshot
mixes both because it was a display-oriented read replica; that shape is a legacy
read/publication representation, not the canonical model. A client needing those
fields reads them from the asset domain.

Filesystem paths are never part of Album authority: identity is the stable Album id
and the stable Asset id.

# Two independent revisions

Album entity revision and membership revision are separate clocks, because they
answer different questions:

* ``album_authority_state.entity_revision`` versions one Album's own projection
  (name, parent, appearance, existence);
* ``album_authority_members.entity_revision`` versions one
  ``(albumId, assetId)`` relation, beginning at 0 for a never-seen relation.

A rename must never satisfy a membership compare-and-set, and adding a membership
must never look like a newer Album. Clients therefore present the revision of the
thing they are editing, and a stale one returns a coded conflict with the current
state rather than silently winning by arrival order.

# Staged activation

The canonical rows written at activation are derived **only** from the legacy
snapshot stored on the server, inside the same ``BEGIN IMMEDIATE``. The activation
request contributes no hierarchy or membership content of its own: it names the
library and the digest of the snapshot it expects. That is what binds activation to
the staged baseline cryptographically (the digest) and semantically (the server
re-derives from the stored bytes), so a publisher cannot present snapshot A's digest
while activating unrelated state B.

Activation additionally requires an *authority-ready* snapshot version. A snapshot
published by an older PC carries no appearance, and replacing real PC appearance with
``null`` would silently destroy user data, so that case fails explicitly instead.

# Inactive safety

Nothing here changes behavior while no ``authority_domains(domain='albums')`` row
exists. Read routes reject with ``authorityInactive``, the legacy snapshot route
proceeds exactly as before, and startup only creates empty tables. There is no
automatic activation: :func:`activate` runs solely from the publisher-only route,
which this batch does not call in any environment.
"""
import base64
import binascii
import datetime
import hashlib
import json
import re
import sqlite3

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import authority
import asset_visibility
import classification_authority

DOMAIN = "albums"
CONTRACT_VERSION = 1

#: Mirrors ``catalog_bookmarks`` so every cut-over domain offers one offline window.
RETENTION_DAYS = 180
RECEIPT_RETENTION_DAYS = 180

#: Bounds mirroring the legacy replica contract, which accepts 2,000 albums and
#: 100,000 media rows.
MAX_ALBUMS = 2_000
MAX_MEMBERSHIPS = 100_000
MAX_NAME = 200

#: The authority-ready legacy snapshot shape. Version 1 is what older PC publishers
#: send (albums carry only id/name/parent); version 2 adds appearance; version 3 adds
#: the explicit canonical membership collection. Activation requires 3 because both
#: appearance *and* the status-independent membership set are canonical state that
#: earlier versions cannot supply.
SNAPSHOT_VERSION = 3

#: Version 3 is the first shape that carries canonical membership separately from the
#: display `media` array. Versions below it remain accepted for the display replica.
DISPLAY_SNAPSHOT_VERSIONS = (1, 2)

#: Bound on the staged snapshot a publisher uploads. Measured against the documented
#: maxima rather than inherited: 2,000 Albums + 100,000 display media rows + 100,000
#: canonical relations encode to roughly 55 MiB at maximum-length identifiers, so the
#: previous 16 MiB would have rejected a supported library. This is a publisher-only
#: staging payload, not a normal mobile response, so it is bounded generously while
#: still bounded. ``test_album_authority`` measures the real encoded size.
MAX_STAGING_BYTES = 96 * 1024 * 1024

#: Baseline paging. The baseline is paginated because an unpaginated response cannot
#: stay recoverable: 100,000 memberships do not fit one bounded response, and normal
#: commands can keep adding memberships after activation, so a domain that was
#: recoverable at activation must not become unrecoverable later.
#:
#: Page sizes are chosen so the worst-case encoded page stays far below the 4 MiB
#: Android/native JSON response budget; ``test_album_authority`` measures that at the
#: documented maxima with maximum-length identifiers rather than trusting an estimate.
DEFAULT_ALBUM_PAGE = 500
MAX_ALBUM_PAGE = 1_000
# The Album -> Asset read projection is a *display* page, not an authority page, so it
# is bounded like the existing mobile Asset listing rather than like the baseline.
DEFAULT_ALBUM_ASSET_PAGE = 50
MAX_ALBUM_ASSET_PAGE = 100
#: Tag inside the opaque Asset-page cursor. It exists so a cursor minted for another
#: read cannot be replayed here and silently mis-walk a page.
ALBUM_ASSETS_SORT = "album-assets"

DEFAULT_MEMBERSHIP_PAGE = 1_000
MAX_MEMBERSHIP_PAGE = 2_000
MAX_BASELINE_PAGE_BYTES = 2 * 1024 * 1024

ALBUMS_SECTION = "albums"
MEMBERSHIPS_SECTION = "memberships"
SECTIONS = (ALBUMS_SECTION, MEMBERSHIPS_SECTION)

#: Mirrors ``library/folder_appearance.rs``, which is the PC's source of truth for
#: what the UI can render. The server must reject anything the client cannot show,
#: so ``test_album_authority`` compares these lists against that file.
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

ALBUM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
ASSET_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
LIBRARY_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
HEX_DIGEST_PATTERN = re.compile(r"^[a-f0-9]{64}$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: Explicit command names, as ADR-0037 decision 2 requires instead of an ambiguous
#: toggle. The command name is part of the payload digest, so the same operation id
#: reused with another command conflicts.
CREATE = "createAlbum"
RENAME = "renameAlbum"
MOVE = "moveAlbum"
APPEARANCE = "updateAlbumAppearance"
DELETE = "deleteAlbum"
MEMBERSHIP = "setAlbumMembership"
COMMAND_TYPES = (CREATE, RENAME, MOVE, APPEARANCE, DELETE, MEMBERSHIP)

#: Common envelope plus the exact per-command keys. A body carrying anything else is
#: a caller bug rather than a silently ignored hint.
ENVELOPE_KEYS = {"libraryId", "epoch", "contractVersion", "operationId", "commandType"}
COMMAND_KEYS = {
    CREATE: {"albumId", "name", "parentId", "iconKey", "colorKey"},
    RENAME: {"albumId", "name", "expectedRevision"},
    MOVE: {"albumId", "parentId", "expectedRevision"},
    APPEARANCE: {"albumId", "iconKey", "colorKey", "expectedRevision"},
    DELETE: {"albumId", "expectedRevision"},
    # Membership is desired-state with its own revision. `expectedRevision` is 0 for
    # a never-seen relation, so it accepts 0 while an Album expectation must be >= 1.
    MEMBERSHIP: {"albumId", "assetId", "desiredState", "expectedRevision"},
}

DDL = """
CREATE TABLE IF NOT EXISTS album_authority_state(
 library_id TEXT NOT NULL,
 album_id TEXT NOT NULL,
 name TEXT NOT NULL,
 parent_id TEXT,
 icon_key TEXT,
 color_key TEXT,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,album_id));
-- The PC database keeps one name per sibling set case-insensitively (migration
-- 0008). A tombstone must not reserve its name, so the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS album_authority_sibling_name
 ON album_authority_state(library_id, COALESCE(parent_id,''), name COLLATE NOCASE)
 WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS album_authority_by_parent
 ON album_authority_state(library_id, deleted, parent_id, name COLLATE NOCASE);
-- Membership is a desired-state table, not a live-only link table. Retaining the
-- removed row is what lets a later add present that tombstone's revision instead of
-- guessing that the relation never existed.
CREATE TABLE IF NOT EXISTS album_authority_members(
 library_id TEXT NOT NULL,
 album_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,album_id,asset_id));
CREATE INDEX IF NOT EXISTS album_authority_members_live
 ON album_authority_members(library_id,desired_state,album_id,asset_id);
CREATE INDEX IF NOT EXISTS album_authority_members_by_asset
 ON album_authority_members(library_id,asset_id);
CREATE TABLE IF NOT EXISTS album_authority_receipts(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 command_type TEXT NOT NULL,
 album_id TEXT NOT NULL,
 asset_id TEXT,
 result_payload TEXT NOT NULL,
 accepted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,operation_id));
CREATE TABLE IF NOT EXISTS album_authority_changes(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 command_type TEXT NOT NULL,
 album_id TEXT NOT NULL,
 asset_id TEXT,
 entity_revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,sequence),
 UNIQUE(library_id,epoch,operation_id));
-- Retention floor: `change_cursor - pruned_through` is exactly the number of
-- retained sequences, which distinguishes an expired cursor from a corrupt or
-- ahead-of-server one once rows may be deleted.
CREATE TABLE IF NOT EXISTS album_authority_retention(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 pruned_through INTEGER NOT NULL DEFAULT 0 CHECK(pruned_through >= 0),
 pruned_at TEXT,
 PRIMARY KEY(library_id,epoch));
CREATE INDEX IF NOT EXISTS album_authority_changes_prune
 ON album_authority_changes(library_id,epoch,changed_at);
CREATE INDEX IF NOT EXISTS album_authority_receipts_prune
 ON album_authority_receipts(library_id,epoch,accepted_at);
"""


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        db.commit()


def fail(status=422, code="invalidAlbumCommand", message="앨범 요청이 올바르지 않습니다.", **extra):
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def digest(value):
    """Deterministic digest of a JSON-able value, stable across key order."""
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Validation, shared by activation and commands
# ---------------------------------------------------------------------------

def normalize_name(value):
    """Trimmed, non-empty, bounded. Mirrors ``normalized_name`` on the PC."""
    if not isinstance(value, str):
        fail()
    name = value.strip()
    if not name:
        fail(422, "emptyAlbumName", "앨범 이름은 비어 있을 수 없습니다.")
    if len(name) > MAX_NAME:
        fail(422, "albumNameTooLong", "앨범 이름이 너무 깁니다.")
    return name


def valid_appearance(icon_key, color_key):
    """Mirrors ``folder_appearance::validate``: absent is valid, unknown is not."""
    return ((icon_key is None or icon_key in ICON_KEYS)
            and (color_key is None or color_key in COLOR_KEYS))


def require_appearance(icon_key, color_key):
    if not valid_appearance(icon_key, color_key):
        fail(422, "invalidAlbumAppearance", "앨범 아이콘 또는 색상을 사용할 수 없습니다.")
    return icon_key, color_key


def valid_album_id(value):
    return isinstance(value, str) and bool(ALBUM_ID_PATTERN.fullmatch(value))


def valid_asset_id(value):
    return isinstance(value, str) and bool(ASSET_ID_PATTERN.fullmatch(value))


def validate_hierarchy(rows):
    """Reject a hierarchy the PC database could not hold.

    Checks that every live album's parent exists and is live, that no album is its
    own parent, that no reachable ancestor chain revisits an album, and that sibling
    names are unique case-insensitively. Raises a coded 422 so a staging publisher
    repairs the snapshot instead of activating a broken domain.
    """
    by_id = {row["album_id"]: row for row in rows}
    for row in rows:
        parent = row["parent_id"]
        if parent is None:
            continue
        if parent == row["album_id"]:
            fail(422, "invalidAlbumParent", "앨범이 자기 자신을 부모로 가질 수 없습니다.",
                 albumId=row["album_id"])
        if parent not in by_id:
            fail(422, "invalidAlbumParent", "부모 앨범을 찾을 수 없습니다.",
                 albumId=row["album_id"], parentId=parent)
    for row in rows:
        seen = {row["album_id"]}
        current = row["parent_id"]
        while current is not None:
            if current in seen:
                fail(422, "albumCycle", "앨범 계층에 순환이 있습니다.", albumId=row["album_id"])
            seen.add(current)
            current = by_id[current]["parent_id"]
    siblings = {}
    for row in rows:
        key = (row["parent_id"] or "", row["name"].casefold())
        if key in siblings:
            fail(422, "duplicateAlbumName", "같은 위치에 같은 이름의 앨범이 있습니다.",
                 name=row["name"])
        siblings[key] = row["album_id"]


# ---------------------------------------------------------------------------
# Staged snapshot: the single source of canonical Album state at activation
# ---------------------------------------------------------------------------

def staged_snapshot(payload):
    """Validate a stored legacy Album snapshot and derive canonical Album rows.

    Returns ``(rows, pairs, version)``. This is the *only* place activation gets Album
    state from, so the digest check and the derived content describe the same bytes.

    Canonical membership is read from the snapshot's dedicated ``memberships`` field,
    never from the display ``media`` array. Those two differ by design: ``media`` is
    normal-visible display data, while a trashed Asset keeps its Album relations in the
    PC database. Deriving canonical membership from ``media`` would therefore drop the
    relations of trashed Assets at activation, breaking the contract that restoring an
    Asset returns its Albums.

    A version-1 or version-2 snapshot is accepted for staging (older PC publishers must
    keep working) but is not authority-ready. Failing here rather than defaulting
    appearance to ``null``, or membership to the display array, is what prevents
    activation from silently destroying real user state.
    """
    snapshot = json.loads(payload)
    version = snapshot.get("snapshotVersion", 1)
    if type(version) is not int or version < 1:
        fail(422, "invalidAlbumBaseline", "앨범 스냅샷 버전이 올바르지 않습니다.")
    if version < SNAPSHOT_VERSION:
        fail(409, "albumSnapshotNotAuthorityReady",
             "PC가 표시 설정과 전체 연결 목록을 포함한 앨범 스냅샷을 게시해야 권위로 전환할 수 있습니다.",
             snapshotVersion=version, requiredVersion=SNAPSHOT_VERSION)
    albums = snapshot.get("albums")
    if not isinstance(albums, list) or len(albums) > MAX_ALBUMS:
        fail(422, "invalidAlbumBaseline", "앨범 스냅샷의 앨범 수가 올바르지 않습니다.")
    memberships = snapshot.get("memberships")
    if not isinstance(memberships, list):
        fail(422, "invalidAlbumBaseline",
             "앨범 스냅샷에 canonical 연결 목록이 없습니다.", snapshotVersion=version)
    if len(memberships) > MAX_MEMBERSHIPS:
        fail(422, "invalidAlbumBaseline", "앨범 스냅샷의 연결 수가 올바르지 않습니다.")
    rows = []
    seen_ids = set()
    for album in albums:
        if not isinstance(album, dict) or set(album) != {"id", "name", "parent_id",
                                                        "icon_key", "color_key"}:
            fail(422, "invalidAlbumBaseline",
                 "앨범 스냅샷 항목에 표시 설정이 없습니다.",
                 album=album if isinstance(album, dict) else None)
        album_id = album["id"]
        if not valid_album_id(album_id) or album_id in seen_ids:
            fail(422, "invalidAlbumBaseline", "앨범 ID가 올바르지 않거나 중복입니다.",
                 albumId=album_id)
        seen_ids.add(album_id)
        parent_id = album["parent_id"]
        if parent_id is not None and not valid_album_id(parent_id):
            fail(422, "invalidAlbumBaseline", "부모 앨범 ID가 올바르지 않습니다.")
        icon_key, color_key = require_appearance(album["icon_key"], album["color_key"])
        rows.append({"album_id": album_id, "name": normalize_name(album["name"]),
                     "parent_id": parent_id, "icon_key": icon_key, "color_key": color_key})
    validate_hierarchy(rows)
    pairs = set()
    for entry in memberships:
        # The stored shape is the publisher's wire shape, so the keys are camelCase.
        if (not isinstance(entry, dict) or set(entry) != {"albumId", "assetId"}):
            fail(422, "invalidAlbumBaseline", "앨범 연결 항목의 형식이 올바르지 않습니다.")
        album_id, asset_id = entry["albumId"], entry["assetId"]
        if not valid_album_id(album_id) or album_id not in seen_ids:
            fail(422, "invalidAlbumMembership",
                 "존재하지 않는 앨범에 자산이 연결되었습니다.", albumId=album_id)
        if not valid_asset_id(asset_id):
            fail(422, "invalidAlbumMembership", "자산 ID가 올바르지 않습니다.", assetId=asset_id)
        pairs.add((album_id, asset_id))
    return rows, sorted(pairs), version


def baseline_identity(rows, pairs):
    """Deterministic identity of the canonical state a baseline would produce."""
    return digest({
        "albums": [{"id": row["album_id"], "name": row["name"], "parentId": row["parent_id"],
                    "iconKey": row["icon_key"], "colorKey": row["color_key"]} for row in rows],
        "memberships": [{"albumId": album_id, "assetId": asset_id} for album_id, asset_id in pairs],
    })


def read_stored_snapshot(db):
    """The stored legacy snapshot payload, or a coded 409 when unpublished."""
    row = db.execute("SELECT payload FROM album_replica WHERE singleton=1").fetchone()
    if row is None:
        fail(409, "albumReplicaUnavailable",
             "앨범 기준선을 만들려면 먼저 PC가 앨범 스냅샷을 게시해야 합니다.")
    return row[0]


def stored_snapshot_digest(db):
    """Digest identifying exactly the snapshot currently stored.

    The legacy publisher receives this value in its publication response, so the
    activating publisher presents the digest of the snapshot it actually staged.
    """
    return digest(json.loads(read_stored_snapshot(db)))


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def live_albums(db, library_id):
    return db.execute(
        "SELECT album_id,name,parent_id,icon_key,color_key,entity_revision"
        " FROM album_authority_state WHERE library_id=? AND deleted=0 ORDER BY album_id",
        [library_id]).fetchall()


def album_row(db, library_id, album_id):
    return db.execute(
        "SELECT name,parent_id,icon_key,color_key,deleted,entity_revision"
        " FROM album_authority_state WHERE library_id=? AND album_id=?",
        [library_id, album_id]).fetchone()


def album_projection(row):
    """The full resulting Album projection a client applies, or ``None`` if absent."""
    if row is None:
        return None
    return {"id": row["album_id"], "name": row["name"], "parentId": row["parent_id"],
            "iconKey": row["icon_key"], "colorKey": row["color_key"],
            "deleted": bool(row["deleted"]), "entityRevision": row["entity_revision"]}


def membership_row(db, library_id, album_id, asset_id):
    return db.execute(
        "SELECT desired_state,entity_revision FROM album_authority_members"
        " WHERE library_id=? AND album_id=? AND asset_id=?",
        [library_id, album_id, asset_id]).fetchone()


def membership_projection(album_id, asset_id, desired_state, entity_revision):
    return {"albumId": album_id, "assetId": asset_id,
            "desiredState": bool(desired_state), "entityRevision": entity_revision}


def album_page(db, library_id, after, limit):
    """One deterministic Album page, ordered by id.

    ``after`` is an entity-key cursor (the last id of the previous page). It is not a
    synchronization cursor: correctness comes from the frozen snapshot cursor the
    caller already validated.
    """
    return db.execute(
        "SELECT album_id,name,parent_id,icon_key,color_key,entity_revision,deleted"
        " FROM album_authority_state WHERE library_id=? AND album_id>? AND deleted=0"
        " ORDER BY album_id LIMIT ?", [library_id, after, limit]).fetchall()


def membership_page(db, library_id, after, limit):
    """One deterministic membership page, ordered by ``(album_id, asset_id)``.

    Both live and tombstoned relations of *live* Albums appear. A tombstone is
    *revision state*, not visible membership: a fresh client must be able to compose
    the next command for a relation someone already removed, and a baseline that
    omitted the tombstone would leave it able to present only revision 0. That
    produces a false conflict against a revision that was legitimately reached before
    this client existed.

    Relations of a deleted Album are excluded. Deleting an Album tombstones its
    memberships, but no command can target them again — the Album is gone — so their
    revisions are unreachable state that would only make the baseline harder to read.

    Display membership remains ``desiredState: true`` only, so nothing about which
    Albums an Asset appears in changes here.
    """
    album_after, asset_after = split_membership_key(after)
    return db.execute(
        "SELECT m.album_id,m.asset_id,m.desired_state,m.entity_revision"
        " FROM album_authority_members m"
        " JOIN album_authority_state a"
        "   ON a.library_id=m.library_id AND a.album_id=m.album_id AND a.deleted=0"
        " WHERE m.library_id=?"
        " AND (m.album_id>? OR (m.album_id=? AND m.asset_id>?))"
        " ORDER BY m.album_id,m.asset_id LIMIT ?",
        [library_id, album_after, album_after, asset_after, limit]).fetchall()


def membership_key(album_id, asset_id):
    """Composite page key. Neither id charset contains ``:``, so it is unambiguous."""
    return f"{album_id}:{asset_id}"


def split_membership_key(value):
    if not value:
        return "", ""
    album_id, _, asset_id = value.partition(":")
    return album_id, asset_id


def encode_asset_cursor(album_id, sort_at, asset_id):
    payload = json.dumps([ALBUM_ASSETS_SORT, album_id, sort_at, asset_id],
                         separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()


def decode_asset_cursor(cursor, album_id):
    """Resolve one Album Asset page cursor, or reject it.

    ``album_id`` is part of the payload, not just an argument, so a cursor cannot be
    presented with a different Album and silently resume at an unrelated offset.
    """
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        fail(422, "invalidAlbumAssetsCursor", "앨범 자산 커서가 올바르지 않습니다.")
    if (not isinstance(payload, list) or len(payload) != 4
            or not all(isinstance(value, str) and value for value in payload)
            or payload[0] != ALBUM_ASSETS_SORT or payload[1] != album_id):
        fail(422, "invalidAlbumAssetsCursor", "앨범 자산 커서가 올바르지 않습니다.")
    return payload[2], payload[3]


def default_asset_item(row, classification_ids=None):
    """Fallback mobile Asset projection.

    Kept field-for-field identical to ``app.mobile_asset_item``; the shipped app
    injects its own mapper so there is exactly one projection in production.
    """
    return {
        "id": row["id"],
        "kind": row["kind"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
        "width": None,
        "height": None,
        "duration_ms": None,
        "collected_at": row["collected_at"],
        "committed_at": row["committed_at"],
        "source_published_at": row["source_published_at"],
        "source_url": row["source_url"],
        "creator_name": row["creator_name"],
        "creator_handle": row["creator_handle"],
        "import_source": row["import_source"],
        "classification_ids": list(classification_ids or []),
        "original_available": bool(row["object_key"]),
        "thumbnail_available": bool(row["thumbnail_key"]),
        "committed": True,
    }


def asset_classification_ids(db, rows):
    """Classification memberships for one page of Assets.

    Classification is a different domain from Album; it is included only because the
    published mobile Asset projection carries it and a consumer that cached this page
    must not need a second round trip to learn it.

    The membership itself must come from the Classification authority once it is active:
    the legacy relation table is frozen by the cutover, so projecting it here would ship
    an Album's Asset with a Classification the authority no longer holds.
    """
    memberships = {row["id"]: [] for row in rows}
    if not rows:
        return memberships
    active = authority.active_domain(db, classification_authority.DOMAIN)
    if active is not None:
        canonical = classification_authority.assignment_projection_many(
            db, active["libraryId"], {row["id"] for row in rows})
        for asset_id, values in canonical.items():
            if asset_id in memberships:
                memberships[asset_id] = values
        return memberships
    placeholders = ",".join("?" for _ in rows)
    for relation in db.execute(
        f"""
        SELECT asset_id, classification_id
        FROM asset_classifications
        WHERE asset_id IN ({placeholders})
        ORDER BY asset_id, classification_id
        """,
        [row["id"] for row in rows],
    ).fetchall():
        memberships[relation["asset_id"]].append(relation["classification_id"])
    return memberships


def encode_page(library_id, epoch, contract_version, snapshot_cursor, section, items,
                next_after, has_more):
    """One bounded baseline page, or an explicit oversized rejection.

    A page never contains more than one section, so no single response can be mistaken
    for a complete baseline. ``complete`` is true only on the final membership page,
    which is the only point at which a client may adopt the baseline.
    """
    payload = {
        "libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
        "snapshotCursor": snapshot_cursor, "section": section,
        "items": items, "nextAfter": next_after, "hasMore": has_more,
        "complete": section == MEMBERSHIPS_SECTION and not has_more,
    }
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_BASELINE_PAGE_BYTES:
        fail(503, "baselinePageTooLarge", "앨범 기준선 페이지가 허용 크기를 초과합니다.",
             maxBytes=MAX_BASELINE_PAGE_BYTES, actualBytes=len(encoded))
    return payload


def change_items(db, library_id, epoch, after, limit):
    """Ordered, self-contained change rows.

    Each row carries the canonical delta a replica applies, so a client never needs a
    point-read after every change to reconstruct authority state.
    """
    items = []
    for row in db.execute(
            "SELECT sequence,command_type,operation_id,payload,changed_at"
            " FROM album_authority_changes WHERE library_id=? AND epoch=? AND sequence>?"
            " ORDER BY sequence LIMIT ?", [library_id, epoch, after, limit]):
        payload = json.loads(row[3])
        items.append({"sequence": row[0], "authorityCursor": row[0], "commandType": row[1],
                      "operationId": row[2], "changedAt": row[4], **payload})
    return items


def pruned_through(db, library_id, epoch):
    """Highest change sequence already removed by retention pruning (0 if none)."""
    row = db.execute(
        "SELECT pruned_through FROM album_authority_retention WHERE library_id=? AND epoch=?",
        [library_id, epoch]).fetchone()
    return row[0] if row else 0


def expired_cursor(row):
    """409 body telling a client its cursor predates retained history.

    Coded so it is distinguishable from the other 409s on this route; the recovery
    is a fresh Album baseline, never "no changes".
    """
    return HTTPException(409, detail={"code": authority.CODE_CURSOR_EXPIRED,
                                      "authorityCursor": row["cursor"],
                                      "retentionDays": RETENTION_DAYS})


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------

def public_state(library_id, epoch, contract_version, cursor, baseline_digest,
                 baseline_revision, activated_at, albums, memberships):
    return {"libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
            "cursor": cursor, "baselineDigest": baseline_digest,
            "baselineRevision": baseline_revision, "activatedAt": activated_at,
            "albumCount": len(albums), "membershipCount": len(memberships)}


def activate(db, *, library_id, rows, pairs, baseline_digest, baseline_revision, now,
             snapshot_version):
    """One-time activation inside the caller's ``BEGIN IMMEDIATE``.

    ``rows`` and ``pairs`` must already be derived from the stored snapshot by
    :func:`staged_snapshot`; this function writes them and creates the epoch. Typed
    state, the epoch row and the retention floor are written by this call, so the
    caller commits activation and the legacy fence as one unit.

    Idempotent only for an identical retry: the stored baseline digest and revision
    must both match. Anything else against an existing Album authority is rejected,
    because accepting it would replace canonical state nobody re-validated.
    """
    existing = authority.active_domain(db, DOMAIN)
    if existing is not None:
        if (existing["libraryId"] == library_id
                and existing["baselineDigest"] == baseline_digest
                and existing["baselineRevision"] == baseline_revision):
            state = public_state(existing["libraryId"], existing["epoch"],
                                 existing["contractVersion"], existing["cursor"],
                                 existing["baselineDigest"], existing["baselineRevision"],
                                 existing["activatedAt"], rows, pairs)
            # A retry must return the same body as the original acceptance, so the
            # snapshot version the caller staged is re-derived from the same bytes.
            state["snapshotVersion"] = snapshot_version
            return state
        fail(409, "albumAuthorityActive", "앨범 권위가 이미 활성화되어 있습니다.", domain=DOMAIN)

    try:
        db.executemany(
            "INSERT INTO album_authority_state(library_id,album_id,name,parent_id,icon_key,"
            "color_key,deleted,entity_revision,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,0,1,?,?)",
            [[library_id, row["album_id"], row["name"], row["parent_id"], row["icon_key"],
              row["color_key"], now, now] for row in rows])
        # Baseline memberships start live at revision 1: the relation exists because
        # the staged snapshot said so, and a later remove must present that revision.
        db.executemany(
            "INSERT INTO album_authority_members(library_id,album_id,asset_id,desired_state,"
            "entity_revision,created_at,updated_at) VALUES(?,?,?,1,1,?,?)",
            [[library_id, album_id, asset_id, now, now] for album_id, asset_id in pairs])
    except sqlite3.IntegrityError:
        fail(422, "duplicateAlbumName", "같은 위치에 같은 이름의 앨범이 있습니다.")
    db.execute(
        "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
        "baseline_digest,baseline_revision,activated_at) VALUES(?,?,?,?,?,?,?,?)",
        [library_id, DOMAIN, 1, CONTRACT_VERSION, 0, baseline_digest, baseline_revision, now])
    db.execute(
        "INSERT INTO album_authority_retention(library_id,epoch,pruned_through,pruned_at)"
        " VALUES(?,?,0,NULL) ON CONFLICT(library_id,epoch) DO NOTHING", [library_id, 1])
    state = public_state(library_id, 1, CONTRACT_VERSION, 0, baseline_digest,
                         baseline_revision, now, rows, pairs)
    state["snapshotVersion"] = snapshot_version
    return state


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def payload_digest(library_id, epoch, contract_version, command_type, entity):
    """Canonical command identity digest. The operation id is deliberately excluded."""
    return hashlib.sha256(json.dumps(
        [library_id, epoch, contract_version, command_type, entity],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def album_conflict(row, album_id, current):
    """409 body carrying the current authoritative Album projection and domain cursor."""
    return HTTPException(409, detail={
        "code": "revisionConflict",
        "authorityCursor": row["cursor"],
        "current": None if current is None or current["deleted"] else {
            "albumId": album_id, "name": current["name"], "parentId": current["parent_id"],
            "iconKey": current["icon_key"], "colorKey": current["color_key"],
            "entityRevision": current["entity_revision"]}})


def membership_conflict(row, album_id, asset_id, current):
    """409 body carrying the current authoritative membership relation."""
    return HTTPException(409, detail={
        "code": "revisionConflict",
        "authorityCursor": row["cursor"],
        "current": membership_projection(
            album_id, asset_id,
            bool(current["desired_state"]) if current else False,
            current["entity_revision"] if current else 0)})


def result_body(row, *, command_type, changed, sequence, cursor, operation_id, now,
                album=None, membership=None):
    """The acceptance result, shared by the response, the receipt and the change row.

    ``cursor`` is the Album cursor *after* acceptance, which for a changed command is
    its own ``sequence``. Building the result before the cursor advanced would record
    an acceptance cursor one behind the change it describes, and the receipt would
    preserve that error forever.
    """
    return {"libraryId": row["libraryId"], "epoch": row["epoch"],
            "contractVersion": row["contractVersion"], "commandType": command_type,
            "operationId": operation_id, "changed": changed, "changeSequence": sequence,
            "authorityCursor": cursor, "album": album, "membership": membership,
            "updatedAt": now}


def change_delta(result):
    """The canonical delta carried by a change row: exactly one typed payload."""
    if result["membership"] is not None:
        return {"membership": result["membership"]}
    return {"album": result["album"]}


def _record(db, library_id, epoch, operation_id, payload_sha, command_type, album_id,
            asset_id, result, now):
    db.execute(
        "INSERT INTO album_authority_receipts(library_id,epoch,operation_id,payload_digest,"
        "command_type,album_id,asset_id,result_payload,accepted_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [library_id, epoch, operation_id, payload_sha, command_type, album_id, asset_id,
         json.dumps(result, sort_keys=True, ensure_ascii=False), now])


def _accept(db, library_id, epoch, operation_id, payload_sha, command_type, album_id,
            asset_id, result, cursor, now):
    """Record one accepted change: cursor advance, change row and receipt together."""
    db.execute("UPDATE authority_domains SET change_cursor=? WHERE library_id=? AND domain=?",
               [cursor, library_id, DOMAIN])
    db.execute(
        "INSERT INTO album_authority_changes(library_id,epoch,sequence,command_type,album_id,"
        "asset_id,entity_revision,operation_id,payload,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [library_id, epoch, result["changeSequence"], command_type, album_id, asset_id,
         result["album"]["entityRevision"] if result["album"] is not None
         else result["membership"]["entityRevision"],
         operation_id, json.dumps(change_delta(result), sort_keys=True, ensure_ascii=False), now])
    _record(db, library_id, epoch, operation_id, payload_sha, command_type, album_id, asset_id,
            result, now)
    return result


def _live_child_count(db, library_id, album_id):
    return db.execute(
        "SELECT COUNT(*) FROM album_authority_state"
        " WHERE library_id=? AND parent_id=? AND deleted=0", [library_id, album_id]).fetchone()[0]


def _creates_cycle(db, library_id, album_id, parent_id):
    """True when placing ``album_id`` under ``parent_id`` would revisit it."""
    seen = {album_id}
    current = parent_id
    while current is not None:
        if current in seen:
            return True
        seen.add(current)
        row = album_row(db, library_id, current)
        if row is None or row["deleted"]:
            return False
        current = row["parent_id"]
    return False


def apply_command(db, *, library_id, epoch, contract_version, command_type, operation_id,
                  entity, now):
    """Execute one typed Album command inside the caller's ``BEGIN IMMEDIATE``.

    Receipts, canonical state, the ordered change and the domain cursor commit
    together or not at all. Structural commands are compare-and-set on the Album
    entity revision; membership commands are compare-and-set on the membership
    relation's own revision. A stale writer therefore receives the current server
    state instead of overwriting a newer one, and never wins by wall-clock arrival.
    """
    asset_visibility.install(db)
    row = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    if row["epoch"] != epoch:
        # A command composed against another epoch cannot present a meaningful
        # revision, so it is an identity mismatch rather than a conflict to rebase.
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "앨범 권위가 이 라이브러리와 일치하지 않습니다.", domain=DOMAIN)
    if contract_version != CONTRACT_VERSION:
        fail(409, authority.CODE_AUTHORITY_CONTRACT_UNSUPPORTED,
             "서버가 지원하지 않는 앨범 계약 버전입니다.", domain=DOMAIN)
    payload_sha = payload_digest(library_id, epoch, contract_version, command_type, entity)
    receipt = db.execute(
        "SELECT payload_digest,result_payload FROM album_authority_receipts"
        " WHERE library_id=? AND epoch=? AND operation_id=?",
        [library_id, epoch, operation_id]).fetchone()
    if receipt is not None:
        if receipt["payload_digest"] != payload_sha:
            fail(409, "operationConflict", "같은 작업 ID가 다른 내용으로 이미 사용되었습니다.")
        # The recorded result is durable and never depends on later entity changes,
        # so a retry after a lost response applies exactly once with the same cursor.
        return json.loads(receipt["result_payload"])

    album_id = entity["albumId"]
    asset_id = entity.get("assetId")
    cursor = row["cursor"]

    if command_type == CREATE:
        if album_row(db, library_id, album_id) is not None:
            # A tombstoned id is not reusable: reviving it would resurrect membership
            # the delete already removed.
            fail(409, "albumExists", "같은 ID의 앨범이 이미 있습니다.", albumId=album_id)
        parent_id = entity["parentId"]
        if parent_id is not None:
            parent = album_row(db, library_id, parent_id)
            if parent is None or parent["deleted"]:
                fail(422, "invalidAlbumParent", "부모 앨범을 찾을 수 없습니다.", parentId=parent_id)
        try:
            db.execute(
                "INSERT INTO album_authority_state(library_id,album_id,name,parent_id,icon_key,"
                "color_key,deleted,entity_revision,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,0,1,?,?)",
                [library_id, album_id, entity["name"], parent_id, entity["iconKey"],
                 entity["colorKey"], now, now])
        except sqlite3.IntegrityError:
            fail(409, "duplicateAlbumName", "같은 위치에 같은 이름의 앨범이 있습니다.",
                 albumId=album_id)
        sequence = cursor + 1
        album = album_projection({"album_id": album_id, "name": entity["name"],
                                  "parent_id": parent_id, "icon_key": entity["iconKey"],
                                  "color_key": entity["colorKey"], "deleted": 0,
                                  "entity_revision": 1})
        result = result_body(row, command_type=command_type, changed=True, sequence=sequence,
                             cursor=sequence, operation_id=operation_id, now=now, album=album)
        return _accept(db, library_id, epoch, operation_id, payload_sha, command_type,
                       album_id, None, result, sequence, now)

    current = album_row(db, library_id, album_id)
    if current is None or current["deleted"]:
        fail(404, "albumNotFound", "앨범을 찾을 수 없습니다.", albumId=album_id)

    if command_type == MEMBERSHIP:
        relation = membership_row(db, library_id, album_id, asset_id)
        current_state = bool(relation["desired_state"]) if relation is not None else False
        current_revision = relation["entity_revision"] if relation is not None else 0
        desired = entity["desiredState"]
        # ADR-0037 decision 2: an already-matching desired state is idempotent, so it
        # is accepted and receipted without a new change and without demanding a
        # revision the caller could not know. Only a real state change needs CAS.
        if current_state == desired:
            result = result_body(
                row, command_type=command_type, changed=False, sequence=None, cursor=cursor,
                operation_id=operation_id, now=now,
                membership=membership_projection(album_id, asset_id, desired, current_revision))
            _record(db, library_id, epoch, operation_id, payload_sha, command_type, album_id,
                    asset_id, result, now)
            return result
        if current_revision != entity["expectedRevision"]:
            raise membership_conflict(row, album_id, asset_id, relation)
        if desired:
            if db.execute("SELECT 1 FROM visible_assets WHERE id=? AND committed=1",
                          [asset_id]).fetchone() is None:
                fail(422, "invalidAlbumMembership", "자산을 찾을 수 없습니다.", assetId=asset_id)
        new_revision = current_revision + 1
        db.execute(
            "INSERT INTO album_authority_members(library_id,album_id,asset_id,desired_state,"
            "entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(library_id,album_id,asset_id) DO UPDATE SET"
            " desired_state=excluded.desired_state,entity_revision=excluded.entity_revision,"
            " updated_at=excluded.updated_at",
            [library_id, album_id, asset_id, int(desired), new_revision, now, now])
        sequence = cursor + 1
        result = result_body(
            row, command_type=command_type, changed=True, sequence=sequence, cursor=sequence,
            operation_id=operation_id, now=now,
            membership=membership_projection(album_id, asset_id, desired, new_revision))
        return _accept(db, library_id, epoch, operation_id, payload_sha, command_type,
                       album_id, asset_id, result, sequence, now)

    if current["entity_revision"] != entity["expectedRevision"]:
        raise album_conflict(row, album_id, current)

    new_revision = current["entity_revision"] + 1
    target = {"name": current["name"], "parent_id": current["parent_id"],
              "icon_key": current["icon_key"], "color_key": current["color_key"],
              "deleted": 0}
    if command_type == RENAME:
        target["name"] = entity["name"]
    elif command_type == MOVE:
        parent_id = entity["parentId"]
        if parent_id is not None:
            parent = album_row(db, library_id, parent_id)
            if parent is None or parent["deleted"]:
                fail(422, "invalidAlbumParent", "부모 앨범을 찾을 수 없습니다.",
                     parentId=parent_id)
        # The PC rule is the same, but it must hold here too because the server is
        # now the writer of record for this domain.
        if parent_id == album_id or (parent_id is not None
                                     and _creates_cycle(db, library_id, album_id, parent_id)):
            fail(422, "albumCycle", "앨범을 자기 자신이나 하위로 옮길 수 없습니다.",
                 albumId=album_id, parentId=parent_id)
        target["parent_id"] = parent_id
    elif command_type == APPEARANCE:
        target["icon_key"], target["color_key"] = entity["iconKey"], entity["colorKey"]
    else:
        # Delete rejects a non-empty folder, matching the PC rule, and leaves a
        # tombstone so "absent from a delta" is never read as a deletion.
        if _live_child_count(db, library_id, album_id):
            fail(409, "albumHasChildren", "하위 앨범이 있는 앨범은 삭제할 수 없습니다.",
                 albumId=album_id)
        target["deleted"] = 1
        target["parent_id"] = None
    try:
        db.execute(
            "UPDATE album_authority_state SET name=?,parent_id=?,icon_key=?,color_key=?,"
            "deleted=?,entity_revision=?,updated_at=? WHERE library_id=? AND album_id=?",
            [target["name"], target["parent_id"], target["icon_key"], target["color_key"],
             target["deleted"], new_revision, now, library_id, album_id])
    except sqlite3.IntegrityError:
        # A sibling-name UNIQUE violation at a valid current revision is a naming
        # problem, not a concurrency problem. Conflating the two would tell the user
        # to rebase when the real fix is a different name.
        fail(409, "duplicateAlbumName", "같은 위치에 같은 이름의 앨범이 있습니다.",
             albumId=album_id)
    if target["deleted"]:
        # Deleting an Album removes its memberships. They are tombstoned rather than
        # dropped so the relation's revision survives: a later re-add of the same
        # (album, asset) pair must be able to present the revision it observed, and a
        # replica must learn the removal from the log instead of from absence.
        #
        # Each membership's revision is deliberately *not* bumped. The relation was not
        # independently edited — its Album ceased to exist — and the delete change row
        # carries only the Album tombstone, so a bump would create revision state no
        # client could reproduce by replaying that row.
        db.execute(
            "UPDATE album_authority_members SET desired_state=0,updated_at=?"
            " WHERE library_id=? AND album_id=? AND desired_state=1",
            [now, library_id, album_id])
    sequence = cursor + 1
    album = album_projection({"album_id": album_id, "name": target["name"],
                              "parent_id": target["parent_id"], "icon_key": target["icon_key"],
                              "color_key": target["color_key"], "deleted": target["deleted"],
                              "entity_revision": new_revision})
    result = result_body(row, command_type=command_type, changed=True, sequence=sequence,
                         cursor=sequence, operation_id=operation_id, now=now, album=album)
    return _accept(db, library_id, epoch, operation_id, payload_sha, command_type,
                   album_id, None, result, sequence, now)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

PREFIX = "/v1/albums"


def _album_revision(value):
    """Album entity expectations start at 1: an Album always exists with revision 1."""
    if type(value) is not int or value < 1:
        fail(422, "invalidAlbumRevision", "앨범 revision 값이 올바르지 않습니다.")
    return value


def _membership_revision(value):
    """Membership expectations start at 0: a never-seen relation has revision 0."""
    if type(value) is not int or value < 0:
        fail(422, "invalidAlbumRevision", "앨범 연결 revision 값이 올바르지 않습니다.")
    return value


def parse_command(body):
    """Validate the ADR-0037 envelope plus exactly one command's own keys."""
    if not isinstance(body, dict) or not ENVELOPE_KEYS <= set(body):
        fail(422, "invalidAlbumCommand", "앨범 명령 봉투가 불완전합니다.")
    command_type = body["commandType"]
    if command_type not in COMMAND_TYPES:
        fail(422, "unsupportedAlbumCommand", "지원하지 않는 앨범 명령입니다.")
    if set(body) != ENVELOPE_KEYS | COMMAND_KEYS[command_type]:
        fail(422, "invalidAlbumCommand", "앨범 명령 필드가 올바르지 않습니다.")
    library_id = body["libraryId"]
    epoch = body["epoch"]
    contract_version = body["contractVersion"]
    operation_id = body["operationId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidAlbumCommand", "라이브러리 ID가 올바르지 않습니다.")
    if type(epoch) is not int or epoch < 1:
        fail(422, "invalidAlbumCommand", "앨범 권위 epoch 값이 올바르지 않습니다.")
    if type(contract_version) is not int or contract_version < 1:
        fail(422, "invalidAlbumCommand", "앨범 계약 버전이 올바르지 않습니다.")
    if not isinstance(operation_id, str) or not UUID_PATTERN.fullmatch(operation_id):
        fail(422, "invalidAlbumCommand", "작업 ID가 올바르지 않습니다.")
    album_id = body["albumId"]
    if not valid_album_id(album_id):
        fail(422, "invalidAlbumCommand", "앨범 ID가 올바르지 않습니다.")
    entity = {"albumId": album_id}
    if command_type == CREATE:
        parent_id = body["parentId"]
        if parent_id is not None and not valid_album_id(parent_id):
            fail(422, "invalidAlbumCommand", "부모 앨범 ID가 올바르지 않습니다.")
        icon_key, color_key = require_appearance(body["iconKey"], body["colorKey"])
        entity.update(name=normalize_name(body["name"]), parentId=parent_id,
                      iconKey=icon_key, colorKey=color_key)
    elif command_type == RENAME:
        entity["name"] = normalize_name(body["name"])
        entity["expectedRevision"] = _album_revision(body["expectedRevision"])
    elif command_type == MOVE:
        parent_id = body["parentId"]
        if parent_id is not None and not valid_album_id(parent_id):
            fail(422, "invalidAlbumCommand", "부모 앨범 ID가 올바르지 않습니다.")
        entity.update(parentId=parent_id,
                      expectedRevision=_album_revision(body["expectedRevision"]))
    elif command_type == APPEARANCE:
        icon_key, color_key = require_appearance(body["iconKey"], body["colorKey"])
        entity.update(iconKey=icon_key, colorKey=color_key,
                      expectedRevision=_album_revision(body["expectedRevision"]))
    elif command_type == DELETE:
        entity["expectedRevision"] = _album_revision(body["expectedRevision"])
    else:
        asset_id = body["assetId"]
        if not valid_asset_id(asset_id):
            fail(422, "invalidAlbumCommand", "자산 ID가 올바르지 않습니다.")
        if type(body["desiredState"]) is not bool:
            fail(422, "invalidAlbumCommand", "연결 상태 값이 올바르지 않습니다.")
        entity.update(assetId=asset_id, desiredState=body["desiredState"],
                      expectedRevision=_membership_revision(body["expectedRevision"]))
    return library_id, epoch, contract_version, operation_id, command_type, entity


def parse_activation(body):
    """Validate an activation request.

    The body names the snapshot to activate and nothing else. Canonical Album state
    is derived from that snapshot on the server, so a caller cannot supply hierarchy
    or membership content that disagrees with the digest it presented.
    """
    if not isinstance(body, dict) or set(body) != {"libraryId", "expectedSnapshotDigest"}:
        fail(422, "invalidAlbumBaseline",
             "앨범 활성화 요청은 라이브러리와 스냅샷 지문만 포함해야 합니다.")
    library_id = body["libraryId"]
    expected = body["expectedSnapshotDigest"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidAlbumBaseline", "라이브러리 ID가 올바르지 않습니다.")
    if not isinstance(expected, str) or not HEX_DIGEST_PATTERN.fullmatch(expected):
        fail(422, "invalidAlbumBaseline", "기준선 지문이 올바르지 않습니다.")
    return library_id, expected


def parse_baseline_request(params, epoch):
    """Resolve a baseline page request against the frozen snapshot cursor.

    Two cursors are deliberately distinct: ``snapshot`` freezes *which* materialized
    Album state the pages describe, while ``after`` walks the deterministic order
    within one section. Neither is a UI pagination cursor.
    """
    if not LIBRARY_ID_PATTERN.fullmatch(params.get("libraryId", "")) or epoch < 1:
        fail(422, "invalidAlbumBaseline", "앨범 기준선 요청이 올바르지 않습니다.")
    snapshot = params.get("snapshot")
    section = params.get("section")
    if snapshot is None:
        # First request: only the library and epoch are meaningful. A section or
        # cursor here would describe a page of an unfrozen baseline.
        if section is not None or params.get("after") is not None:
            fail(422, "invalidAlbumBaseline",
                 "기준선 첫 요청에는 snapshot/section/after를 지정할 수 없습니다.")
        section = ALBUMS_SECTION
        after = ""
    else:
        if section not in SECTIONS:
            fail(422, "invalidAlbumBaseline", "기준선 section이 올바르지 않습니다.")
        after = params.get("after", "")
    limit = params.get("limit")
    maximum = MAX_ALBUM_PAGE if section == ALBUMS_SECTION else MAX_MEMBERSHIP_PAGE
    default = DEFAULT_ALBUM_PAGE if section == ALBUMS_SECTION else DEFAULT_MEMBERSHIP_PAGE
    if limit is None:
        limit = default
    else:
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            fail(422, "invalidAlbumBaseline", "기준선 limit이 올바르지 않습니다.")
        if not 1 <= limit <= maximum:
            fail(422, "invalidAlbumBaseline", "기준선 limit이 올바르지 않습니다.")
    if snapshot is not None:
        try:
            snapshot = int(snapshot)
        except (TypeError, ValueError):
            fail(422, "invalidAlbumBaseline", "기준선 snapshot 커서가 올바르지 않습니다.")
        if snapshot < 0:
            fail(422, "invalidAlbumBaseline", "기준선 snapshot 커서가 올바르지 않습니다.")
    return snapshot, section, after, limit


def register_album_authority(app, get_db, require_client, require_publisher, asset_item=None):
    # The mobile Asset projection is injected so this module never grows a second
    # definition of the display shape the app already publishes.
    asset_item = asset_item or default_asset_item
    # The FastAPI startup hook receives an event argument, while the closure returned
    # to the caller is invoked directly by tests like the other domain modules. They
    # are kept separate so neither signature surprises the other.
    app.on_event("startup")(lambda _event=None: startup(get_db))

    @app.post(PREFIX + "/authority/activate")
    async def activate_authority(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 64 * 1024:
                fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail(422, "invalidAlbumBaseline", "앨범 활성화 요청을 읽을 수 없습니다.")
        library_id, expected = parse_activation(body)

        def run():
            now = now_iso()
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    # Derive canonical state from the stored snapshot inside this same
                    # transaction. The digest proves which bytes were staged; deriving
                    # from those bytes is what makes that proof mean something.
                    stored = read_stored_snapshot(db)
                    if digest(json.loads(stored)) != expected:
                        fail(409, "albumBaselineChanged",
                             "앨범 기준선이 변경되었습니다. 다시 준비해 주세요.")
                    rows, pairs, snapshot_version = staged_snapshot(stored)
                    # Activation is a trusted migration of the PC's canonical Album
                    # relations. Some relations legitimately point at Assets currently
                    # outside the server replica (for example local trash): retain their
                    # stable ids and revisions here. Album display uses an INNER JOIN to
                    # committed Assets, so these withheld relations remain invisible until
                    # the Asset is materialized later. Ordinary membership commands still
                    # require a committed Asset before accepting desiredState=true.
                    state = activate(db, library_id=library_id, rows=rows, pairs=pairs,
                                     baseline_digest=baseline_identity(rows, pairs),
                                     baseline_revision=expected, now=now,
                                     snapshot_version=snapshot_version)
                    db.commit()
                    return state
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/baseline")
    async def album_baseline(request: Request, libraryId: str, epoch: int,
                             authorization: str | None = Header(default=None)):
        require_client(authorization)
        params = dict(request.query_params)
        if set(params) - {"libraryId", "epoch", "snapshot", "section", "after", "limit"}:
            fail(422, "invalidAlbumBaseline", "앨범 기준선 요청이 올바르지 않습니다.")
        snapshot, section, after, limit = parse_baseline_request(params, epoch)
        if section == ALBUMS_SECTION and after and not valid_album_id(after):
            fail(422, "invalidAlbumBaseline", "기준선 앨범 커서가 올바르지 않습니다.")

        def run():
            with get_db() as db:
                row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                cursor = row["cursor"]
                if snapshot is None:
                    snapshot_cursor = cursor
                else:
                    # Every Album mutation advances this domain's cursor, so equality
                    # with the frozen value is exactly the proof that the materialized
                    # Album state did not change between pages.
                    if snapshot != cursor:
                        fail(409, "baselineChanged",
                             "기준선 페이지를 읽는 동안 앨범이 변경되었습니다. 다시 시작해 주세요.",
                             snapshotCursor=snapshot, authorityCursor=cursor)
                    snapshot_cursor = snapshot
                if section == ALBUMS_SECTION:
                    fetched = album_page(db, libraryId, after, limit + 1)
                    items = [{"id": item["album_id"], "name": item["name"],
                              "parentId": item["parent_id"], "iconKey": item["icon_key"],
                              "colorKey": item["color_key"], "deleted": bool(item["deleted"]),
                              "entityRevision": item["entity_revision"]} for item in fetched[:limit]]
                    has_more = len(fetched) > limit
                    next_after = items[-1]["id"] if has_more and items else None
                else:
                    fetched = membership_page(db, libraryId, after, limit + 1)
                    # `desiredState` is the authoritative value, not a constant: a
                    # tombstone is revision state a client needs to compose its next
                    # command, and it is not visible Album membership.
                    items = [{"albumId": item["album_id"], "assetId": item["asset_id"],
                              "desiredState": bool(item["desired_state"]),
                              "entityRevision": item["entity_revision"]}
                             for item in fetched[:limit]]
                    has_more = len(fetched) > limit
                    next_after = (membership_key(items[-1]["albumId"], items[-1]["assetId"])
                                  if has_more and items else None)
                return encode_page(row["libraryId"], row["epoch"], row["contractVersion"],
                                   snapshot_cursor, section, items, next_after, has_more)
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/assets")
    async def album_assets(request: Request, libraryId: str, epoch: int, albumId: str,
                           cursor: str | None = None, limit: int = DEFAULT_ALBUM_ASSET_PAGE,
                           authorization: str | None = Header(default=None)):
        """Bounded read-only projection of one Album's displayable Assets.

        This is the authority read for Album *contents*. Membership comes from
        authoritative ``desired_state=1`` rows, so a tombstoned relation is absent and
        an Album deleted by a later command is not browsable at all. Asset display
        metadata is joined from the committed Asset table instead of being copied into
        the replica: Album authority owns the relation, the Asset domain owns how an
        Asset is presented.
        """
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "albumId", "cursor", "limit"}:
            fail(422, "invalidAlbumAssets", "앨범 자산 요청이 올바르지 않습니다.")
        if (not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1
                or not ALBUM_ID_PATTERN.fullmatch(albumId)
                or not 1 <= limit <= MAX_ALBUM_ASSET_PAGE):
            fail(422, "invalidAlbumAssets", "앨범 자산 요청이 올바르지 않습니다.")
        after = None if cursor is None else decode_asset_cursor(cursor, albumId)

        def run():
            with get_db() as db:
                row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                album = db.execute(
                    "SELECT deleted FROM album_authority_state"
                    " WHERE library_id=? AND album_id=?", [libraryId, albumId]).fetchone()
                if album is None or album["deleted"]:
                    # A tombstone is not an empty Album. Reporting "no assets" would let
                    # a consumer that still holds the deleted Album render it as empty
                    # rather than as gone.
                    fail(404, "albumNotFound", "앨범을 찾을 수 없습니다.", albumId=albumId)
                if after is None:
                    cursor_clause = ""
                    params = [libraryId, albumId, limit + 1]
                else:
                    # Strict inequality on the (sort key, id) pair: every page is
                    # disjoint from the previous one, so the walk cannot loop.
                    cursor_clause = """
                        AND (
                            COALESCE(asset.collected_at, asset.created_at) < ?
                            OR (
                                COALESCE(asset.collected_at, asset.created_at) = ?
                                AND asset.id < ?
                            )
                        )
                    """
                    params = [libraryId, albumId, after[0], after[0], after[1], limit + 1]
                rows = db.execute(
                    f"""
                    SELECT asset.*,
                           COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
                    FROM album_authority_members AS member
                    JOIN visible_assets AS asset ON asset.id = member.asset_id
                    WHERE member.library_id = ?
                      AND member.album_id = ?
                      AND member.desired_state = 1
                      AND asset.committed = 1
                      {cursor_clause}
                    ORDER BY mobile_sort_at DESC, asset.id DESC
                    LIMIT ?
                    """,
                    params,
                ).fetchall()
                has_more = len(rows) > limit
                page_rows = rows[:limit]
                memberships = asset_classification_ids(db, page_rows)
                items = [asset_item(item, memberships.get(item["id"], []))
                         for item in page_rows]
                next_cursor = None
                if has_more and page_rows:
                    last = page_rows[-1]
                    next_cursor = encode_asset_cursor(albumId, last["mobile_sort_at"], last["id"])
                    if next_cursor == cursor:
                        # Unreachable while the ordering is strict; if it ever happens
                        # a client would page forever, so it must be an error, not a loop.
                        fail(503, "albumAssetsCursorStalled",
                             "앨범 자산 페이지 커서가 진행하지 않았습니다.", albumId=albumId)
                return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                        "contractVersion": row["contractVersion"], "albumId": albumId,
                        "items": items, "nextCursor": next_cursor, "hasMore": has_more}

        return await run_in_threadpool(run)

    @app.get(PREFIX + "/changes")
    async def album_changes(request: Request, libraryId: str, epoch: int, after: int = 0,
                            limit: int = 100, authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "after", "limit"}:
            fail(422, "invalidAlbumCommand", "앨범 변경 요청이 올바르지 않습니다.")
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            fail(422, "invalidAlbumCommand", "앨범 변경 요청이 올바르지 않습니다.")
        if after < 0 or not 1 <= limit <= 500:
            fail(422, "invalidAlbumCommand", "앨범 변경 요청이 올바르지 않습니다.")

        def run():
            with get_db() as db:
                row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
                cursor = row["cursor"]
                if after > cursor:
                    # A cursor beyond the server is authority skew, not retention.
                    # A fresh baseline resolves both, but the distinction matters for
                    # the client's error surface.
                    fail(409, "cursorAhead", "변경 커서가 권위 커서보다 앞서 있습니다.")
                # A cursor at or below the pruned floor has a real gap behind it.
                # Reporting "no changes" would silently drop accepted mutations.
                if after < pruned_through(db, libraryId, epoch):
                    raise expired_cursor(row)
                items = change_items(db, libraryId, epoch, after, limit)
                next_after = items[-1]["sequence"] if items else after
                return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                        "contractVersion": row["contractVersion"], "cursor": cursor,
                        "items": items, "nextAfter": next_after, "hasMore": next_after < cursor}
        return await run_in_threadpool(run)

    @app.put(PREFIX + "/commands")
    async def album_command(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 16 * 1024:
                fail(413)
            data.extend(chunk)
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            fail(422, "invalidAlbumCommand", "앨범 명령을 읽을 수 없습니다.")
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
    """Drop history older than the retention window, keeping tombstones.

    Album *state* is never pruned: a tombstone must outlive its change row, because
    "no change row" must never be read as "this album was deleted".
    """
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    change_cutoff = (moment - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    receipt_cutoff = (moment - datetime.timedelta(days=receipt_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            floored = db.execute(
                "SELECT library_id,epoch,MAX(sequence) FROM album_authority_changes"
                " WHERE changed_at < ? GROUP BY library_id,epoch", [change_cutoff]).fetchall()
            removed = db.execute(
                "DELETE FROM album_authority_changes WHERE changed_at < ?",
                [change_cutoff]).rowcount
            receipts = db.execute(
                "DELETE FROM album_authority_receipts WHERE accepted_at < ?",
                [receipt_cutoff]).rowcount
            stamp = moment.strftime("%Y-%m-%dT%H:%M:%SZ")
            for library_id, epoch, highest in floored:
                db.execute(
                    "INSERT INTO album_authority_retention(library_id,epoch,pruned_through,pruned_at)"
                    " VALUES(?,?,?,?) ON CONFLICT(library_id,epoch) DO UPDATE SET"
                    " pruned_through=MAX(pruned_through,excluded.pruned_through),"
                    " pruned_at=excluded.pruned_at", [library_id, epoch, highest, stamp])
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return {"changes": removed, "receipts": receipts}
