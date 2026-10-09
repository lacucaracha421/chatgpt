"""Server-owned Collections authority (substrate and slice 1A verification).

Design: ``docs/research/collection-authority-design-20260924.md`` with the §7 user
decisions, on top of ADR-0036/0037/0038. This module owns the canonical Collections
model, its typed commands, the baseline/change feeds, digest-bound staging and the
explicit activation handler. Nothing here runs automatically.

# Domain boundary (one ``collections`` authority domain)

* **Work** — client id, type (``game``/``manga``/``movie``/``av``), ``legacyKind``, name,
  editable metadata and personal fields (``fields``), Showcase flag and order, the
  selected-artwork slots (``selection``, including the spine), display detail
  (``details``: TMDB ``series``/``film`` and ``av``), AV credits and people,
  PC-derived release tracking values (``derived``) and the lifecycle
  ``live`` -> ``trashed`` -> ``tombstoned``.
* **Binding** — ``(work, provider)`` with ``externalId``, ``config``, the stored provider
  ``snapshot`` and its normalized ``values`` (the three-way merge baseline).
* **Artwork** — an immutable record (kind, provider ids, dimensions, original and
  optional thumbnail blob manifests). Bytes live in R2 under the existing
  ``work-artwork/mobile/{sha256}`` keys and must be confirmed by the existing
  prepare/check receipts before ``addArtwork`` is accepted.
* **Volume**, **VolumeSource**, **Ownership** and **Membership** (work <-> Asset desired
  state).

Names are unique per type, case-insensitively with the
same ASCII ``NOCASE`` rule the PC database uses (§6.4). Deleting a work moves it to a
30-day Collections trash (§6.2); only a publisher purge — explicit, or the expiry sweep
— tombstones it, frees its name and provider identity and drops its children.

# Revisions and conflicts

Every entity carries its own revision. Commands present the revision (or, for
``updateWork``, the per-field ``expected`` values) they were composed against; a stale
command receives ``revisionConflict`` with the current entity instead of silently
winning by arrival order. Other coded conflicts: ``nameConflict``,
``providerIdentityTaken``, ``providerSnapshotStale``, ``workDeleted`` (definitive: a
client drops the intent), ``workTrashed`` and ``operationConflict``.

# Inactive safety

Startup creates or upgrades the inactive schema; the AV CHECK rebuild refuses a
non-empty works table. The v2 verification route stages only typed authority rows
in connection-local TEMP tables, with persistent writes denied and the read
transaction rolled back. Memory is roughly the staging document + Collections rows,
not the whole server database. While no ``authority_domains(domain='collections')``
row exists authority feeds/commands answer ``authorityInactive``, the legacy
replica PUT and the personal-edit POST behave exactly as before, and ``/v1/collections``
keeps serving the PC-published replica. Only :func:`activate`, reachable solely from
the publisher-only activation route, creates the epoch.
"""
import datetime
import hashlib
import json
import math
import re
import sqlite3

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import asset_authority
import asset_visibility
import authority
import av_contract

DOMAIN = "collections"
CONTRACT_VERSION = 1

RETENTION_DAYS = 180
RECEIPT_RETENTION_DAYS = 180
#: §6.2: a deleted work stays restorable this long before the sweep tombstones it.
TRASH_RETENTION_DAYS = 30
PURGE_BATCH = 100
#: The tablet 휴지통 list is one bounded read; the 30-day sweep keeps it short.
TRASH_PAGE = 500

TYPES = ("game", "manga", "movie", "av")
LEGACY_KINDS = ("game", "manga", "movie", "gacha", "av")
PROVIDERS = ("tmdb", "igdb", "mangadex", "aladin", "kakao", "steam")
#: The PC only binds each provider to one Collection type.
PROVIDER_TYPES = {"tmdb": "movie", "igdb": "game", "mangadex": "manga",
                  "aladin": "manga", "kakao": "manga", "steam": "game"}
SOURCE_PROVIDERS = ("kakao", "aladin")
SLOTS = ("work", "hero", "backdrop")
SELECTION_KINDS = {"work": "cover", "hero": "hero", "backdrop": "backdrop",
                   "spine": "spine", "back": "back"}
LIFECYCLES = ("live", "trashed", "tombstoned")

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
LIBRARY_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
HEX_DIGEST_PATTERN = re.compile(r"^[a-f0-9]{64}$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
IMAGE_MIMES = ("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
               "image/bmp", "image/heic", "image/heif")
MAX_SAFE_INTEGER = 9_007_199_254_740_991

#: Command names. The command name is part of the payload digest.
CREATE = "createWork"
UPDATE = "updateWork"
DELETE = "deleteWork"
RESTORE = "restoreWork"
PURGE = "purgeWork"
PURGE_EXPIRED = "purgeExpiredTrash"
SHOWCASE_ORDER = "setShowcaseOrder"
BIND = "bindProvider"
UNBIND = "unbindProvider"
APPLY_SNAPSHOT = "applyProviderSnapshot"
ADD_ARTWORK = "addArtwork"
SELECT_ARTWORK = "selectArtwork"
UPSERT_VOLUME = "upsertVolume"
UPSERT_VOLUME_SOURCE = "upsertVolumeSource"
OWNERSHIP = "setVolumeOwnership"
MEMBERSHIP = "setMembership"
TRACK_OWNERSHIP = "setOwnershipTracking"
RELEASE_SUBSCRIPTION = "setReleaseSubscription"
VOLUME_RANGE = "setVolumeRange"
KAKAO_REVIEW = "setKakaoPartialDismissed"
RECORD_RELEASE = "recordReleaseEvent"
ACK_RELEASE = "acknowledgeReleaseEvents"
AV_DETAILS = "setAvDetails"
AV_CREDITS = "setAvCredits"
PERSON = "setPerson"
PERSON_PORTRAIT = "setPersonPortrait"
PERSON_PROFILE = "setPersonProfile"
PERSON_PROFILE_FIELDS = "setPersonProfileFields"

#: An ordinary client credential may send these, including count tracking/subscriptions.
#: Provider, volume, individual ownership and purge
#: commands (and any unrecognized name) require the publisher role.
CLIENT_COMMAND_TYPES = (CREATE, UPDATE, DELETE, RESTORE, SHOWCASE_ORDER, ADD_ARTWORK,
                        SELECT_ARTWORK, MEMBERSHIP, TRACK_OWNERSHIP, RELEASE_SUBSCRIPTION,
                        VOLUME_RANGE, KAKAO_REVIEW, ACK_RELEASE, AV_DETAILS, AV_CREDITS, PERSON, PERSON_PORTRAIT, PERSON_PROFILE, PERSON_PROFILE_FIELDS)
PUBLISHER_COMMAND_TYPES = (PURGE, PURGE_EXPIRED, BIND, UNBIND, APPLY_SNAPSHOT,
                           UPSERT_VOLUME, UPSERT_VOLUME_SOURCE, OWNERSHIP, RECORD_RELEASE)
COMMAND_TYPES = CLIENT_COMMAND_TYPES + PUBLISHER_COMMAND_TYPES

ENVELOPE_KEYS = {"libraryId", "epoch", "contractVersion", "operationId", "commandType"}
COMMAND_KEYS = {
    KAKAO_REVIEW: {"workId", "dismissed", "expectedVolumes"},
    CREATE: {"workId", "type", "name", "legacyKind", "fields", "binding"},
    UPDATE: {"workId", "changes", "expected", "expectedRevision"},
    AV_DETAILS: {"workId", "changes", "expected"},
    AV_CREDITS: {"workId", "credits", "people", "expectedRevision"},
    PERSON: {"personId", "changes", "expected"},
    PERSON_PORTRAIT: {"personId", "portrait", "expectedRevision"},
    PERSON_PROFILE: {"personId", "stashdbId", "expectedRevision"},
    PERSON_PROFILE_FIELDS: {"personId", "changes", "expected"},
    DELETE: {"workId", "expectedRevision"},
    RESTORE: {"workId", "expectedRevision"},
    PURGE: {"workId", "expectedRevision"},
    PURGE_EXPIRED: set(),
    SHOWCASE_ORDER: {"type", "workIds"},
    BIND: {"workId", "provider", "externalId", "config", "expectedRevision"},
    UNBIND: {"workId", "provider", "expectedRevision"},
    APPLY_SNAPSHOT: {"workId", "provider", "externalId", "snapshot", "values", "details",
                     "baseSnapshotDigest"},
    ADD_ARTWORK: {"workId", "artworkId", "kind", "provider", "providerImageId", "width",
                  "height", "language", "original", "thumbnail"},
    SELECT_ARTWORK: {"workId", "slot", "artworkId", "expectedArtworkId"},
    UPSERT_VOLUME: {"workId", "volumeId", "volumeNumber", "editionIndex", "sortOrder",
                    "displayLabel", "coverArtworkId", "sourceProvider", "sourceCoverId",
                    "deleted", "expectedRevision"},
    UPSERT_VOLUME_SOURCE: {"workId", "volumeNumber", "provider", "providerItemId", "title",
                           "author", "publisher", "isbn13", "publicationDate", "itemUrl",
                           "data", "deleted", "expectedRevision"},
    OWNERSHIP: {"workId", "volumeNumber", "editionIndex", "physical", "digital",
                "expectedRevision"},
    MEMBERSHIP: {"workId", "assetId", "desiredState", "expectedRevision"},
    TRACK_OWNERSHIP: {"workId", "editionIndex", "count", "expectedCount", "expectedRevision"},
    RELEASE_SUBSCRIPTION: {"workId", "enabled", "expectedEnabled", "expectedRevision"},
    ACK_RELEASE: {"workId", "eventIds"},
    RECORD_RELEASE: {"workId", "eventId", "provider", "kind", "volumeNumber", "previousValue", "currentValue", "detectedAt"},
    VOLUME_RANGE: {"workId", "minVolume", "maxVolume", "hideConnectionPrompt",
                   "expectedRange", "expectedRevision"},
}

#: Editable work fields. Limits mirror the shipped mobile replica model so every
#: accepted value can be projected in the shape current APKs read; a command memo keeps
#: the stricter PC limit.
TEXT_FIELDS = {"description": 10000, "originalTitle": 2000, "author": 2000,
               "director": 2000, "developer": 2000, "publisher": 2000, "platforms": 6000,
               "productionCompany": 2000, "releaseDate": 100, "genres": 6000,
               "overview": 20000}
COMMAND_TEXT_LIMITS = {**TEXT_FIELDS, "description": 2000}
INT_FIELDS = ("year", "runtimeMinutes", "externalScore")
WORK_FIELDS = ("description", "coverAssetId", "year", "originalTitle", "runtimeMinutes",
               "author", "director", "developer", "publisher", "platforms",
               "productionCompany", "releaseDate", "externalScore", "myScore", "genres",
               "overview")
RECORD_FIELDS = ("status", "ownedPlatform")
COMMAND_WORK_FIELDS = WORK_FIELDS + RECORD_FIELDS
UPDATABLE = ("name", "showcase") + COMMAND_WORK_FIELDS
# Discrete personal choices rebase automatically; editable text keeps field-level CAS.
REBASE_FIELDS = ("myScore", "showcase", "status", "ownedPlatform")
ITEM_STATUSES = {"game": ("done", "playing", "unplayed"),
                 "manga": ("collecting", "complete"),
                 "movie": ("watched", "watching", "unwatched"),
                 "av": ("watched", "unwatched")}
MAX_COMMAND_NAME = 120
MAX_STAGED_NAME = 2000

#: Provider value fields and their kind. ``values`` sent with a snapshot must be the
#: PC ``provider_snapshot()`` projection of that snapshot; the merge never parses raw
#: provider JSON, so Rust and Python cannot drift on provider-shape parsing.
PROVIDER_VALUE_FIELDS = {
    "tmdb": {"originalTitle": "text", "director": "text", "productionCompany": "text",
             "releaseDate": "text", "runtimeMinutes": "int", "genres": "text",
             "overview": "text", "externalScore": "int"},
    "igdb": {"developer": "text", "publisher": "text", "releaseDate": "text",
             "platforms": "text", "genres": "text", "overview": "text"},
    "mangadex": {"year": "int", "author": "text", "genres": "text", "overview": "text",
                 "originalTitle": "text"},
    "aladin": {},
    "kakao": {},
    # Legacy Steam App IDs are identities only, never work metadata.
    "steam": {},
}

MAX_COMMAND_BYTES_CLIENT = 64 * 1024
MAX_COMMAND_BYTES_PUBLISHER = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
MAX_CONFIG_BYTES = 64 * 1024
MAX_DETAIL_BYTES = 3 * 1024 * 1024
MAX_STAGING_BYTES = 128 * 1024 * 1024
MAX_ACTIVATION_BYTES = 64 * 1024
MAX_WORKS = 10_000
MAX_ARTWORKS_PER_WORK = 10_000
MAX_VOLUMES_PER_WORK = 5_000
MAX_STAGED_ROWS = 500_000
MAX_ORIGINAL_BYTES = 16 * 1024 * 1024
MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

DEFAULT_PAGE = 500
MAX_PAGE = 1_000
DEFAULT_CHANGE_PAGE = 100
MAX_CHANGE_PAGE = 500
#: Byte budget for one baseline or change page, well under the 4 MiB mobile budget. A
#: page always carries at least one row, so a single large row still makes progress.
MAX_PAGE_BYTES = 3 * 1024 * 1024

WORKS_SECTION = "works"
BINDINGS_SECTION = "bindings"
ARTWORKS_SECTION = "artworks"
VOLUMES_SECTION = "volumes"
SOURCES_SECTION = "volumeSources"
OWNERSHIP_SECTION = "ownership"
MEMBERSHIPS_SECTION = "memberships"
SECTIONS = (WORKS_SECTION, BINDINGS_SECTION, ARTWORKS_SECTION, VOLUMES_SECTION,
            SOURCES_SECTION, OWNERSHIP_SECTION, MEMBERSHIPS_SECTION)

PREFIX = "/v1/collections/authority"

DDL = """
CREATE TABLE IF NOT EXISTS collection_authority_works(
 library_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('game','manga','movie','av')),
 legacy_kind TEXT,
 name TEXT NOT NULL,
 fields TEXT NOT NULL,
 showcase INTEGER NOT NULL CHECK(showcase IN (0,1)),
 showcase_order INTEGER,
 selection TEXT NOT NULL,
 details TEXT NOT NULL,
 derived TEXT NOT NULL,
 av_credits TEXT NOT NULL DEFAULT '[]',
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('live','trashed','tombstoned')),
 trashed_at TEXT,
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,work_id));
-- Names are unique per type (§6.4). A trashed work keeps its name so a restore can
-- never collide; only the tombstone frees it.
CREATE UNIQUE INDEX IF NOT EXISTS collection_authority_work_name
 ON collection_authority_works(library_id,type,name COLLATE NOCASE)
 WHERE lifecycle <> 'tombstoned';
CREATE INDEX IF NOT EXISTS collection_authority_work_trash
 ON collection_authority_works(library_id,lifecycle,trashed_at);
CREATE TABLE IF NOT EXISTS collection_authority_bindings(
 library_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 external_id TEXT NOT NULL,
 config TEXT,
 snapshot TEXT,
 snapshot_values TEXT,
 snapshot_digest TEXT,
 snapshot_external_id TEXT,
 last_synced_at TEXT,
 bound INTEGER NOT NULL CHECK(bound IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,work_id,provider));
CREATE UNIQUE INDEX IF NOT EXISTS collection_authority_binding_identity
 ON collection_authority_bindings(library_id,provider,external_id) WHERE bound = 1;
CREATE TABLE IF NOT EXISTS collection_authority_artworks(
 library_id TEXT NOT NULL,
 artwork_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 provider TEXT,
 provider_image_id TEXT,
 width INTEGER,
 height INTEGER,
 language TEXT,
 original TEXT NOT NULL,
 thumbnail TEXT,
 published_order INTEGER,
 selected INTEGER CHECK(selected IN (0,1)),
 entity_revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 PRIMARY KEY(library_id,artwork_id));
CREATE INDEX IF NOT EXISTS collection_authority_artworks_by_work
 ON collection_authority_artworks(library_id,work_id);
CREATE TABLE IF NOT EXISTS collection_authority_volumes(
 library_id TEXT NOT NULL,
 volume_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 volume_number INTEGER NOT NULL,
 edition_index INTEGER NOT NULL,
 sort_order INTEGER NOT NULL,
 display_label TEXT NOT NULL,
 cover_artwork_id TEXT,
 source_provider TEXT,
 source_cover_id TEXT,
 cover_focus_x REAL,
 published TEXT,
 published_order INTEGER,
 deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,volume_id));
CREATE UNIQUE INDEX IF NOT EXISTS collection_authority_volume_slot
 ON collection_authority_volumes(library_id,work_id,volume_number,edition_index)
 WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS collection_authority_volumes_by_work
 ON collection_authority_volumes(library_id,work_id);
CREATE TABLE IF NOT EXISTS collection_authority_volume_sources(
 library_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 volume_number INTEGER NOT NULL,
 provider TEXT NOT NULL,
 provider_item_id TEXT NOT NULL,
 title TEXT NOT NULL,
 author TEXT,
 publisher TEXT,
 isbn13 TEXT,
 publication_date TEXT,
 item_url TEXT,
 data TEXT NOT NULL,
 deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,work_id,volume_number,provider));
CREATE UNIQUE INDEX IF NOT EXISTS collection_authority_volume_source_item
 ON collection_authority_volume_sources(library_id,provider,provider_item_id) WHERE deleted = 0;
CREATE TABLE IF NOT EXISTS collection_authority_ownership(
 library_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 volume_number INTEGER NOT NULL,
 edition_index INTEGER NOT NULL,
 physical INTEGER NOT NULL CHECK(physical IN (0,1)),
 digital INTEGER NOT NULL CHECK(digital IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,work_id,volume_number,edition_index));
CREATE TABLE IF NOT EXISTS collection_authority_members(
 library_id TEXT NOT NULL,
 work_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 0),
 added_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,work_id,asset_id));
CREATE INDEX IF NOT EXISTS collection_authority_members_live
 ON collection_authority_members(library_id,work_id,desired_state,added_at,asset_id);
CREATE INDEX IF NOT EXISTS collection_authority_members_by_asset
 ON collection_authority_members(library_id,asset_id);
CREATE TABLE IF NOT EXISTS collection_authority_receipts(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 command_type TEXT NOT NULL,
 entity_key TEXT NOT NULL,
 result_payload TEXT NOT NULL,
 accepted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,operation_id));
CREATE TABLE IF NOT EXISTS collection_authority_changes(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 command_type TEXT NOT NULL,
 entity_key TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,sequence),
 UNIQUE(library_id,epoch,operation_id));
CREATE TABLE IF NOT EXISTS collection_authority_retention(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 pruned_through INTEGER NOT NULL DEFAULT 0 CHECK(pruned_through >= 0),
 pruned_at TEXT,
 PRIMARY KEY(library_id,epoch));
CREATE INDEX IF NOT EXISTS collection_authority_changes_prune
 ON collection_authority_changes(library_id,epoch,changed_at);
CREATE INDEX IF NOT EXISTS collection_authority_receipts_prune
 ON collection_authority_receipts(library_id,epoch,accepted_at);
-- Digest-bound staged baseline. Staging never writes canonical state.
CREATE TABLE IF NOT EXISTS collection_authority_staging(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 library_id TEXT NOT NULL,
 staged_digest TEXT NOT NULL,
 payload TEXT NOT NULL,
 counts TEXT NOT NULL,
 staged_at TEXT NOT NULL);
-- Materialized read projection in the exact per-item payload shape of the legacy
-- `mobile_collections` replica, so `/v1/collections` keeps one query path. Only live,
-- non-gacha works are projected; assetCount and the fallback cover are computed at read.
CREATE TABLE IF NOT EXISTS collection_authority_projection(
 id TEXT PRIMARY KEY,
 library_id TEXT NOT NULL,
 type TEXT NOT NULL,
 name TEXT NOT NULL,
 showcase INTEGER NOT NULL,
 showcase_order INTEGER,
 payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collection_authority_projection_type_name
 ON collection_authority_projection(type, name COLLATE NOCASE, id);
CREATE TABLE IF NOT EXISTS collection_authority_people(
 library_id TEXT NOT NULL,
 person_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 portrait_image TEXT,
 display_name TEXT,
 name_ja TEXT,
 PRIMARY KEY(library_id,person_id));
"""

TYPED_TABLES = ("collection_authority_works", "collection_authority_bindings",
                "collection_authority_artworks", "collection_authority_volumes",
                "collection_authority_volume_sources", "collection_authority_ownership",
                "collection_authority_members", "collection_authority_receipts",
                "collection_authority_changes", "collection_authority_projection",
                "collection_authority_people")


def startup_db(db):
    old = db.execute("SELECT sql FROM sqlite_master WHERE type='table'"
                     " AND name='collection_authority_works'").fetchone()
    if old is not None and "'av'" not in old[0]:
        # Never rebuild populated authority state. Slice 1A may upgrade only the
        # empty substrate; an active installation needs a separate migration.
        if db.execute("SELECT 1 FROM collection_authority_works LIMIT 1").fetchone():
            raise RuntimeError("Collections AV schema upgrade requires an empty works table")
        db.execute("DROP TABLE collection_authority_works")
    db.executescript(DDL)
    additions = {
        "collection_authority_works": {"av_credits": "TEXT NOT NULL DEFAULT '[]'"},
        "collection_authority_people": {"display_name": "TEXT", "name_ja": "TEXT",
                                        "entity_revision": "INTEGER NOT NULL DEFAULT 1",
                                        "portrait_selection": "TEXT"},
        "collection_authority_artworks": {"published_order": "INTEGER",
                                           "selected": "INTEGER CHECK(selected IN (0,1))"},
        "collection_authority_volumes": {"cover_focus_x": "REAL", "published": "TEXT",
                                          "published_order": "INTEGER"},
    }
    for table, columns in additions.items():
        present = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        for column, declaration in columns.items():
            if column not in present:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def startup(get_db):
    with get_db() as db:
        startup_db(db)
        db.commit()


def fail(status=422, code="invalidCollectionCommand",
         message="컬렉션 요청이 올바르지 않습니다.", **extra):
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def now_iso(moment=None):
    moment = moment or datetime.datetime.now(datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def projection_revision(library_id, epoch, cursor):
    """The `/v1/collections` revision while the domain is active.

    Pure function of the cursor, so a receipt replay reports the revision current APKs
    saw at acceptance, and every accepted change moves it.
    """
    return hashlib.sha256(f"collections-authority:{library_id}:{epoch}:{cursor}".encode()).hexdigest()


# ---------------------------------------------------------------------------
# Provider merge (ported from the PC; shared fixtures in
# tests/fixtures/collection-authority/provider-merge.json)
# ---------------------------------------------------------------------------

def normalized_optional(value):
    """``normalized_optional`` in ``tmdb_flow.rs``: trimmed text, empty -> None."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def _blank(value):
    """``value IS NULL OR trim(value) = ''`` / ``map_or(true, trim().is_empty())``."""
    return value is None or (isinstance(value, str) and not value.strip())


def year_from_date(date):
    """``year_from_date``: the first four *bytes* parsed as an i64, else None.

    Rust slices bytes (``date.get(..4)``), which is ``None`` on a non-char boundary, and
    ``str::parse::<i64>`` accepts one optional sign and ASCII digits only.
    """
    if not isinstance(date, str):
        return None
    raw = date.encode("utf-8")
    if len(raw) < 4:
        return None
    try:
        head = raw[:4].decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not re.fullmatch(r"[+-]?[0-9]+", head):
        return None
    return int(head)


def merge_provider(provider, mode, current, previous, fetched):
    """Fields a provider snapshot may write into a work, exactly as the PC decides.

    ``current`` holds the work's editable fields, ``previous`` the normalized values of
    the binding's stored snapshot (``None`` when there is none) and ``fetched`` the
    normalized values of the new snapshot. ``mode`` is ``connect`` when the binding is
    new or its identity changed, else ``refresh``. Returns ``{field: new value}`` for
    every field the rule allows the provider to write (possibly to the same value).

    * TMDB (``update_provider_metadata``): a field refreshes only while it still equals
      the previous provider value (both-empty counts as equal), so user edits and
      explicit clears survive. ``connect`` (the PC reconnect/existing-work bind) also
      moves ``year`` when it still equals the year of the previous release date.
    * IGDB (``may_fill_from_provider``): a field fills only when it is blank *and* the
      previous provider value was blank. ``connect`` fills a missing ``year``.
    * MangaDex (``refresh_provider_fields``): blanks fill and stale provider values
      are replaced, including clears; differing user values survive. Text equality
      is exact, matching the PC SQL, rather than whitespace-normalized equality.
    * Aladin/Kakao never write work fields; their data lives in volume sources.
    """
    previous = previous or {}
    updates = {}
    if provider == "tmdb":
        for field, kind in PROVIDER_VALUE_FIELDS["tmdb"].items():
            cur, prev = current.get(field), previous.get(field)
            if kind == "text":
                allowed = normalized_optional(cur) == normalized_optional(prev)
            else:
                allowed = cur == prev
            if allowed:
                updates[field] = fetched.get(field)
        if mode == "connect" and current.get("year") == year_from_date(previous.get("releaseDate")):
            updates["year"] = year_from_date(fetched.get("releaseDate"))
    elif provider == "igdb":
        for field in PROVIDER_VALUE_FIELDS["igdb"]:
            if _blank(current.get(field)) and _blank(previous.get(field)):
                updates[field] = fetched.get(field)
        if mode == "connect" and current.get("year") is None:
            updates["year"] = year_from_date(fetched.get("releaseDate"))
    elif provider == "mangadex":
        if current.get("year") is None or current.get("year") == previous.get("year"):
            updates["year"] = fetched.get("year")
        for field in ("author", "genres", "overview", "originalTitle"):
            if _blank(current.get(field)) or current.get(field) == previous.get(field):
                updates[field] = fetched.get(field)
    return updates


def normalize_provider_values(provider, values):
    """Server-side normalization of a snapshot's ``values`` (the PC's own rules)."""
    spec = PROVIDER_VALUE_FIELDS[provider]
    if not isinstance(values, dict) or not set(values) <= set(spec):
        fail(422, "invalidProviderValues", "작품 정보 값이 올바르지 않습니다.", provider=provider)
    result = {}
    for field, kind in spec.items():
        value = values.get(field)
        if kind == "text":
            if value is not None and not isinstance(value, str):
                fail(422, "invalidProviderValues", "작품 정보 값이 올바르지 않습니다.", field=field)
            value = normalized_optional(value)
            if value is not None and len(value) > TEXT_FIELDS.get(field, 2000):
                fail(422, "invalidProviderValues", "작품 정보 값이 너무 깁니다.", field=field)
        else:
            if value is not None and (type(value) is not int or abs(value) > MAX_SAFE_INTEGER):
                fail(422, "invalidProviderValues", "작품 정보 값이 올바르지 않습니다.", field=field)
            if provider == "tmdb" and field == "runtimeMinutes" and value is not None and value <= 0:
                value = None
        result[field] = value
    return result


# ---------------------------------------------------------------------------
# Field validation
# ---------------------------------------------------------------------------

def valid_id(value):
    return isinstance(value, str) and bool(ID_PATTERN.fullmatch(value))


def require_id(value, code="invalidCollectionCommand", nullable=False):
    if value is None and nullable:
        return None
    if not valid_id(value):
        fail(422, code, "ID가 올바르지 않습니다.")
    return value


def _int(value, *, low=-MAX_SAFE_INTEGER, high=MAX_SAFE_INTEGER, nullable=True,
         code="invalidCollectionCommand"):
    if value is None and nullable:
        return None
    if type(value) is not int or not low <= value <= high:
        fail(422, code, "숫자 값이 올바르지 않습니다.")
    return value


def _text(value, limit, *, nullable=True, code="invalidCollectionCommand"):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) > limit:
        fail(422, code, "텍스트 값이 올바르지 않습니다.")
    return value


def normalize_score(value, code="invalidCollectionCommand"):
    """PC rule: null or 0-5 in 0.5 steps."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(422, code, "평점 값이 올바르지 않습니다.")
    try:
        value = float(value)
    except OverflowError:
        fail(422, code, "평점 값이 올바르지 않습니다.")
    if not math.isfinite(value) or not 0.0 <= value <= 5.0 or (value * 2) % 1 != 0:
        fail(422, code, "평점 값이 올바르지 않습니다.")
    return value


def normalize_field(field, value, *, staged=False, code="invalidCollectionCommand"):
    """One editable work field.

    A command value is normalized the PC way (text trimmed, empty -> null). A staged
    value is the PC's stored value and is kept verbatim so the activated projection
    matches the published replica byte for byte; it is only type- and length-checked.
    """
    if field == "coverAssetId":
        return require_id(value, code, nullable=True)
    if field in RECORD_FIELDS:
        if field == "status":
            # Status identifiers are exact, unlike free-text platform labels.
            return _text(value, 40, code=code)
        if value is not None and not isinstance(value, str):
            fail(422, code, "Invalid owned platform.")
        return _text(value if staged else normalized_optional(value), 200, code=code)
    if field == "myScore":
        if staged and value is not None:
            # The replica accepts any finite stored f64. The editing command has
            # a narrower 0..5 half-star rule, which must not reject old records.
            if type(value) not in (int, float):
                fail(422, code, "Invalid stored score.")
            try:
                if math.isfinite(float(value)):
                    return float(value)
            except OverflowError:
                pass
            fail(422, code, "Invalid stored score.")
        return normalize_score(value, code)
    if field in INT_FIELDS:
        return _int(value, code=code)
    limit = (TEXT_FIELDS if staged else COMMAND_TEXT_LIMITS)[field]
    if value is None:
        return None
    if not isinstance(value, str):
        fail(422, code, "텍스트 값이 올바르지 않습니다.", field=field)
    if not staged:
        value = value.strip() or None
    if value is not None and len(value) > limit:
        fail(422, code, "텍스트 값이 너무 깁니다.", field=field)
    return value


def comparable(field, value):
    """The value a field-level compare-and-set compares: normalized, never raw."""
    if field == "showcase":
        return bool(value)
    if field == "myScore":
        return None if value is None else float(value)
    if field == "name":
        return value.strip() if isinstance(value, str) else value
    if field in TEXT_FIELDS or field == "ownedPlatform":
        return normalized_optional(value) if isinstance(value, str) else value
    return value


def validate_record_fields(kind, fields):
    if fields.get("status") is not None and fields["status"] not in ITEM_STATUSES[kind]:
        fail(422, "invalidCollectionCommand", "Invalid work status.")
    if "ownedPlatform" in fields and kind != "game" and fields["ownedPlatform"] is not None:
        fail(409, "collectionRecordUnavailable", "Only games have an owned platform.")


def normalize_name(value, *, limit=MAX_COMMAND_NAME, code="invalidCollectionCommand"):
    if not isinstance(value, str):
        fail(422, code, "작품 이름이 올바르지 않습니다.")
    name = value.strip()
    if not name:
        fail(422, "emptyCollectionName", "작품 이름은 비어 있을 수 없습니다.")
    if len(name) > limit:
        fail(422, "collectionNameTooLong", "작품 이름이 너무 깁니다.")
    return name


def require_type(value, code="invalidCollectionCommand"):
    if value not in TYPES:
        fail(422, code, "컬렉션 종류가 올바르지 않습니다.")
    return value


def nocase(value):
    """SQLite ``NOCASE``: ASCII-only case folding, the rule the unique index applies."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in value)


def blob_manifest(value, *, thumbnail=False, code="invalidCollectionCommand"):
    """An artwork blob manifest: sha256, size, image MIME. ``objectKey`` is derived."""
    if not isinstance(value, dict) or not set(value) <= {"sha256", "sizeBytes", "contentType",
                                                          "objectKey"} \
            or not {"sha256", "sizeBytes", "contentType"} <= set(value):
        fail(422, code, "작품 이미지 정보가 올바르지 않습니다.")
    sha, size, mime = value["sha256"], value["sizeBytes"], value["contentType"]
    limit = MAX_THUMBNAIL_BYTES if thumbnail else MAX_ORIGINAL_BYTES
    if not isinstance(sha, str) or not HEX_DIGEST_PATTERN.fullmatch(sha) \
            or type(size) is not int or not 0 < size <= limit or mime not in IMAGE_MIMES:
        fail(422, code, "작품 이미지 정보가 올바르지 않습니다.")
    key = "work-artwork/mobile/" + sha
    if value.get("objectKey", key) != key:
        fail(422, code, "작품 이미지 정보가 올바르지 않습니다.")
    return {"sha256": sha, "sizeBytes": size, "contentType": mime}


def blob_payload(blob):
    """The legacy replica blob shape, including the derived ``objectKey``."""
    if blob is None:
        return None
    return {**blob, "objectKey": "work-artwork/mobile/" + blob["sha256"]}


def json_object(value, limit, *, nullable=True, code="invalidCollectionCommand"):
    if value is None and nullable:
        return None
    if not isinstance(value, dict) or len(encode(value).encode()) > limit:
        fail(422, code, "JSON 값이 올바르지 않습니다.")
    return value


def validate_details(details, code="invalidCollectionCommand"):
    """TMDB display detail, validated by the shipped replica models (no private keys)."""
    import mobile_collections
    from pydantic import ValidationError

    if details is None:
        return {"series": None, "film": None}
    if not isinstance(details, dict) or not set(details) <= {"series", "film"}:
        fail(422, code, "작품 상세 정보가 올바르지 않습니다.")
    if len(encode(details).encode()) > MAX_DETAIL_BYTES:
        fail(413, code, "작품 상세 정보가 너무 큽니다.")
    try:
        series = None if details.get("series") is None else \
            mobile_collections.Series.model_validate(details["series"]).model_dump()
        film = None if details.get("film") is None else \
            mobile_collections.Film.model_validate(details["film"]).model_dump()
    except ValidationError:
        fail(422, code, "작품 상세 정보가 올바르지 않습니다.")
    return {"series": series, "film": film}


def detail_artwork_references(details):
    series = details.get("series") or {}
    return [season.get("posterArtworkId") for season in series.get("seasons") or []
            if season.get("posterArtworkId") is not None]


def valid_external_id(provider, value):
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > 200:
        return False
    if provider == "tmdb":
        return bool(re.fullmatch(r"(tv:)?[1-9][0-9]{0,17}", value))
    if provider in ("igdb", "steam"):
        return bool(re.fullmatch(r"[1-9][0-9]{0,17}", value))
    return True


# ---------------------------------------------------------------------------
# Entity reads and projections
# ---------------------------------------------------------------------------

def work_row(db, library_id, work_id):
    return db.execute("SELECT * FROM collection_authority_works WHERE library_id=? AND work_id=?",
                      [library_id, work_id]).fetchone()


def work_state(row):
    """Mutable dict form of one work row."""
    return {"workId": row["work_id"], "type": row["type"], "legacyKind": row["legacy_kind"],
            "name": row["name"], "fields": json.loads(row["fields"]),
            "showcase": bool(row["showcase"]), "showcaseOrder": row["showcase_order"],
            "selection": json.loads(row["selection"]), "details": json.loads(row["details"]),
            "derived": json.loads(row["derived"]), "lifecycle": row["lifecycle"],
            "avCredits": json.loads(row["av_credits"]),
            "trashedAt": row["trashed_at"], "entityRevision": row["entity_revision"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def work_projection(db, library_id, work_id):
    row = work_row(db, library_id, work_id)
    return None if row is None else av_work_entity(db, library_id, work_state(row))


def av_person_identity(db, library_id, person_id, payload):
    """Staged people predate name fields; their existing credits own those names."""
    if "displayName" in payload:
        return payload["displayName"], payload.get("nameJa")
    stored = db.execute("SELECT display_name,name_ja FROM collection_authority_people"
                        " WHERE library_id=? AND person_id=?", [library_id, person_id]).fetchone()
    if stored is not None and stored[0] is not None:
        return stored[0], stored[1]
    row = db.execute(
        "SELECT json_extract(c.value,'$.name'),json_extract(c.value,'$.nameJa')"
        " FROM collection_authority_works w,json_each(w.av_credits) c"
        " WHERE w.library_id=? AND json_extract(c.value,'$.personId')=?"
        " ORDER BY w.work_id LIMIT 1", [library_id, person_id]).fetchone()
    if row is None:
        fail(422, "invalidCollectionCommand", "인물 이름을 찾을 수 없습니다.")
    return row[0], row[1]


def av_work_entity(db, library_id, state):
    """Add people within the work, retaining the shipped baseline section layout."""
    if state["type"] != "av":
        return state
    people = []
    for person_id in sorted({c["personId"] for c in state.get("avCredits", [])}):
        row = db.execute("SELECT * FROM collection_authority_people"
                         " WHERE library_id=? AND person_id=?", [library_id, person_id]).fetchone()
        if row is None:
            continue
        payload = json.loads(row["payload"])
        name, name_ja = av_person_identity(db, library_id, person_id, payload)
        people.append({**payload, **_profile_metadata(payload), "personId": person_id, "displayName": name, "nameJa": name_ja,
                       "entityRevision": row["entity_revision"],
                       "portraitSelection": person_portrait_selection(db, library_id, row),
                       "portraitImage": None if row["portrait_image"] is None else json.loads(row["portrait_image"])})
    return {**state, "avPeople": people}


def write_work(db, library_id, state, *, insert=False):
    values = [state["type"], state["legacyKind"], state["name"], encode(state["fields"]),
              int(state["showcase"]), state["showcaseOrder"], encode(state["selection"]),
              encode(state["details"]), encode(state["derived"]), state["lifecycle"],
              state["trashedAt"], state["entityRevision"], state["createdAt"],
              state["updatedAt"], encode(state.get("avCredits", []))]
    try:
        if insert:
            db.execute(
                "INSERT INTO collection_authority_works(type,legacy_kind,name,fields,showcase,"
                "showcase_order,selection,details,derived,lifecycle,trashed_at,entity_revision,"
                "created_at,updated_at,av_credits,library_id,work_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                values + [library_id, state["workId"]])
        else:
            db.execute(
                "UPDATE collection_authority_works SET type=?,legacy_kind=?,name=?,fields=?,"
                "showcase=?,showcase_order=?,selection=?,details=?,derived=?,lifecycle=?,"
                "trashed_at=?,entity_revision=?,created_at=?,updated_at=?,av_credits=?"
                " WHERE library_id=? AND work_id=?", values + [library_id, state["workId"]])
    except sqlite3.IntegrityError:
        holder = db.execute(
            "SELECT work_id FROM collection_authority_works WHERE library_id=? AND type=?"
            " AND name=? COLLATE NOCASE AND lifecycle<>'tombstoned' AND work_id<>?",
            [library_id, state["type"], state["name"], state["workId"]]).fetchone()
        fail(409, "nameConflict", "같은 종류에 같은 이름의 작품이 있습니다.",
             name=state["name"], type=state["type"], workId=holder[0] if holder else None)


def binding_row(db, library_id, work_id, provider):
    return db.execute(
        "SELECT * FROM collection_authority_bindings WHERE library_id=? AND work_id=? AND provider=?",
        [library_id, work_id, provider]).fetchone()


def binding_projection(row):
    if row is None:
        return None
    return {"workId": row["work_id"], "provider": row["provider"],
            "externalId": row["external_id"],
            "config": None if row["config"] is None else json.loads(row["config"]),
            "snapshot": None if row["snapshot"] is None else json.loads(row["snapshot"]),
            "values": None if row["snapshot_values"] is None else json.loads(row["snapshot_values"]),
            "snapshotDigest": row["snapshot_digest"],
            "snapshotExternalId": row["snapshot_external_id"],
            "lastSyncedAt": row["last_synced_at"], "bound": bool(row["bound"]),
            "entityRevision": row["entity_revision"]}


def artwork_projection(row):
    return {"artworkId": row["artwork_id"], "workId": row["work_id"], "kind": row["kind"],
            "provider": row["provider"], "providerImageId": row["provider_image_id"],
            "width": row["width"], "height": row["height"], "language": row["language"],
            "original": json.loads(row["original"]),
            "thumbnail": None if row["thumbnail"] is None else json.loads(row["thumbnail"]),
            "createdAt": row["created_at"], "entityRevision": row["entity_revision"],
            "order": row["published_order"],
            "selected": (bool(row["selected"]) if row["selected"] is not None else None)}


def artwork_row(db, library_id, artwork_id):
    return db.execute(
        "SELECT * FROM collection_authority_artworks WHERE library_id=? AND artwork_id=?",
        [library_id, artwork_id]).fetchone()


def volume_projection(row):
    return {"volumeId": row["volume_id"], "workId": row["work_id"],
            "volumeNumber": row["volume_number"], "editionIndex": row["edition_index"],
            "sortOrder": row["sort_order"], "displayLabel": row["display_label"],
            "coverArtworkId": row["cover_artwork_id"], "sourceProvider": row["source_provider"],
            "sourceCoverId": row["source_cover_id"], "deleted": bool(row["deleted"]),
            "entityRevision": row["entity_revision"]}


def source_projection(row):
    return {"workId": row["work_id"], "volumeNumber": row["volume_number"],
            "provider": row["provider"], "providerItemId": row["provider_item_id"],
            "title": row["title"], "author": row["author"], "publisher": row["publisher"],
            "isbn13": row["isbn13"], "publicationDate": row["publication_date"],
            "itemUrl": row["item_url"], "data": json.loads(row["data"]),
            "deleted": bool(row["deleted"]), "entityRevision": row["entity_revision"]}


def ownership_projection(row):
    return {"workId": row["work_id"], "volumeNumber": row["volume_number"],
            "editionIndex": row["edition_index"], "physical": bool(row["physical"]),
            "digital": bool(row["digital"]), "entityRevision": row["entity_revision"]}


def membership_projection(work_id, asset_id, desired_state, revision, added_at):
    return {"workId": work_id, "assetId": asset_id, "desiredState": bool(desired_state),
            "entityRevision": revision, "addedAt": added_at}


# ---------------------------------------------------------------------------
# Read projection (`/v1/collections`)
# ---------------------------------------------------------------------------

def default_volume_label(number, edition):
    return str(number) if edition == 0 else f"{number}.{edition}"


def season_date_range(details, bindings):
    """Port of the PC ``season_date_range`` over the TMDB TV binding snapshot."""
    binding = next((b for b in bindings if b["provider"] == "tmdb" and b["bound"]
                    and b["external_id"].startswith("tv:") and b["snapshot"]), None)
    if binding is None:
        return None
    snapshot = json.loads(binding["snapshot"])
    series = snapshot.get("series") if isinstance(snapshot, dict) else None
    seasons = series.get("seasons") if isinstance(series, dict) else None
    if isinstance(seasons, dict):
        seasons = list(seasons.values())
    if not isinstance(seasons, list):
        return None
    dates = []
    for season in seasons:
        if not isinstance(season, dict):
            continue
        number = season.get("seasonNumber")
        # SQLite: text sorts above every number; NULL/blob comparisons are not true.
        if isinstance(number, bool) or not (isinstance(number, str) or
                                            (isinstance(number, (int, float)) and number > 0)):
            continue
        air = season.get("airDate")
        if air is not None and not isinstance(air, str):
            return None
        if air is None:
            continue
        try:
            dates.append(datetime.datetime.strptime(air, "%Y-%m-%d").date())
        except ValueError:
            continue
    if not dates:
        return None
    dates.sort()
    return [dates[0].isoformat(), dates[-1].isoformat()]


def build_payload(db, library_id, row):
    """One validated read row, with authority-only volume ranges when present."""
    import mobile_collections

    state = work_state(row)
    work_id, fields = state["workId"], state["fields"]
    selection = state["selection"]
    artworks = db.execute(
        "SELECT * FROM collection_authority_artworks WHERE library_id=? AND work_id=?"
        " ORDER BY published_order IS NULL, published_order,"
        " CASE kind WHEN 'cover' THEN 0 WHEN 'hero' THEN 1 ELSE 2 END, created_at,"
        " artwork_id", [library_id, work_id]).fetchall()
    selected_ids = {value for value in selection.values() if value}
    art_items = [{"id": art["artwork_id"], "kind": art["kind"],
                  "selected": (art["artwork_id"] in selected_ids if art["selected"] is None
                               else bool(art["selected"])),
                  "thumbnail": blob_payload(None if art["thumbnail"] is None else json.loads(art["thumbnail"])),
                  "original": blob_payload(json.loads(art["original"]))} for art in artworks]
    if all(art["published_order"] is None for art in artworks):
        art_items.sort(key=lambda art: 0 if art["selected"] else 1)
        art_items.sort(key=lambda art: {"cover": 0, "hero": 1}.get(art["kind"], 2))
    sources = {}
    for source in db.execute(
            "SELECT volume_number,provider,isbn13,publication_date FROM collection_authority_volume_sources"
            " WHERE library_id=? AND work_id=? AND deleted=0 AND provider IN ('kakao','aladin')",
            [library_id, work_id]):
        current = sources.get(source["volume_number"])
        if current is None or (current["provider"] != "kakao" and source["provider"] == "kakao"):
            sources[source["volume_number"]] = source
    volumes = []
    for volume in db.execute(
            "SELECT * FROM collection_authority_volumes WHERE library_id=? AND work_id=? AND deleted=0"
            " ORDER BY published_order IS NULL, published_order, edition_index, sort_order,"
            " volume_number, volume_id", [library_id, work_id]):
        volume_range = state["derived"].get("volumeRange") or {}
        if (volume_range.get("minVolume") is not None
                and volume["volume_number"] < volume_range["minVolume"]) or (
                volume_range.get("maxVolume") is not None
                and volume["volume_number"] > volume_range["maxVolume"]):
            continue
        source = sources.get(volume["volume_number"])
        volumes.append({"id": volume["volume_id"], "volumeNumber": volume["volume_number"],
                        "editionIndex": volume["edition_index"],
                        "displayLabel": volume["display_label"],
                        "coverArtworkId": volume["cover_artwork_id"],
                        "coverFocusX": volume["cover_focus_x"],
                        "localReleaseDate": source["publication_date"] if source else None,
                        "isbn13": source["isbn13"] if source else None,
                        "releaseStatus": None})
        if volume["published"] is not None:
            volumes[-1].update(json.loads(volume["published"]))
    selected_work = selection.get("work")
    if selected_work is None:
        fallback = db.execute(
            "SELECT artwork.artwork_id FROM collection_authority_volumes AS volume"
            " JOIN collection_authority_artworks AS artwork ON artwork.library_id=volume.library_id"
            " AND artwork.artwork_id=volume.cover_artwork_id"
            " WHERE volume.library_id=? AND volume.work_id=? AND volume.deleted=0"
            " ORDER BY volume.edition_index, volume.sort_order, volume.volume_number,"
            " artwork.artwork_id LIMIT 1", [library_id, work_id]).fetchone()
        selected_work = fallback[0] if fallback else None
    bindings = db.execute(
        "SELECT provider,external_id,bound,snapshot FROM collection_authority_bindings"
        " WHERE library_id=? AND work_id=?", [library_id, work_id]).fetchall()
    av = state["details"].get("av")
    if av is not None:
        person_ids = sorted({credit["personId"] for credit in state["avCredits"]})
        people = {person["person_id"]: person for person in db.execute(
            "SELECT person_id,portrait_image FROM collection_authority_people WHERE library_id=?"
            " AND person_id IN (" + ",".join("?" for _ in person_ids) + ")",
            [library_id, *person_ids])} if person_ids else {}
        credits = []
        for credit in state["avCredits"]:
            person = people.get(credit["personId"])
            image = None if person is None or person["portrait_image"] is None else json.loads(person["portrait_image"])
            credits.append({"id": credit["personId"],
                            **{k: v for k, v in credit.items() if k != "personId"},
                            "portraitImage": image})
        av = {**av, "people": credits}
    payload = {
        "id": work_id, "name": state["name"], "type": state["type"],
        "description": fields.get("description"), "coverAssetId": fields.get("coverAssetId"),
        "selectedWorkArtworkId": selected_work,
        "selectedHeroArtworkId": selection.get("hero"),
        "selectedBackdropArtworkId": selection.get("backdrop"),
        "assetCount": 0,
        "unreadReleaseCount": int(state["derived"].get("unreadReleaseCount") or 0),
        **{field: fields.get(field) for field in WORK_FIELDS
           if field not in ("description", "coverAssetId")},
        "status": fields.get("status"), "ownedPlatform": fields.get("ownedPlatform"),
        **{field: state["derived"].get(field) for field in TRACKING_FIELDS},
        "showcase": state["showcase"], "showcaseOrder": state["showcaseOrder"],
        "seasonDateRange": season_date_range(state["details"], bindings),
        "createdAt": state["createdAt"], "updatedAt": state["updatedAt"],
        "series": state["details"].get("series"), "film": state["details"].get("film"),
        "av": av, "volumes": volumes, "artworks": art_items,
    }
    payload = mobile_collections.stored(mobile_collections.Collection.model_validate(payload))
    volume_range = state["derived"].get("volumeRange")
    if volume_range is not None:
        payload["volumeRange"] = mobile_collections.CollectionVolumeRange.model_validate(
            volume_range).model_dump()
    return payload


def refresh_projection(db, library_id, work_id):
    """Rematerialize one work's served row inside the caller's transaction."""
    db.execute("DELETE FROM collection_authority_projection WHERE id=?", [work_id])
    row = work_row(db, library_id, work_id)
    if row is None or row["lifecycle"] != "live" or row["legacy_kind"] == "gacha":
        return
    payload = build_payload(db, library_id, row)
    db.execute(
        "INSERT INTO collection_authority_projection(id,library_id,type,name,showcase,showcase_order,payload)"
        " VALUES(?,?,?,?,?,?,?)",
        [work_id, library_id, payload["type"], payload["name"], int(payload["showcase"]),
         payload["showcaseOrder"], encode(payload)])


def served_state(db):
    """``(libraryId, epoch, revision, publishedAt)`` while active, else None."""
    row = authority.active_domain(db, DOMAIN)
    if row is None:
        return None
    changed = db.execute(
        "SELECT changed_at FROM collection_authority_changes WHERE library_id=? AND epoch=?"
        " AND sequence=?", [row["libraryId"], row["epoch"], row["cursor"]]).fetchone()
    return {"libraryId": row["libraryId"], "epoch": row["epoch"],
            "revision": projection_revision(row["libraryId"], row["epoch"], row["cursor"]),
            "publishedAt": changed[0] if changed else row["activatedAt"]}


def finalize_items(db, library_id, items, *, detail=False, today=None, include_review=False):
    """Resolve a page's visible member counts/covers without loading member IDs."""
    if not items:
        return items
    asset_visibility.install(db)
    has_view = db.execute(
        "SELECT 1 FROM sqlite_temp_master WHERE type='view' AND name='visible_assets'").fetchone()
    stats = {}
    if has_view:
        placeholders = ",".join("(?,?)" for _ in items)
        parameters = [value for item in items for value in (item["id"], item.get("coverAssetId"))]
        rows = db.execute(f"""
            WITH requested(work_id,cover_id) AS (VALUES {placeholders}),
            members AS (
                SELECT member.work_id, member.asset_id, requested.cover_id,
                       ROW_NUMBER() OVER (PARTITION BY member.work_id
                           ORDER BY member.added_at, member.asset_id) AS position
                FROM requested CROSS JOIN collection_authority_members AS member
                  ON member.work_id=requested.work_id AND member.library_id=?
                CROSS JOIN visible_assets AS asset ON asset.id=member.asset_id AND asset.committed=1
                WHERE member.desired_state=1)
            SELECT work_id, COUNT(*), MAX(CASE WHEN position=1 THEN asset_id END),
                   MAX(CASE WHEN asset_id=cover_id THEN asset_id END)
            FROM members GROUP BY work_id
            """, [*parameters, library_id])
        stats = {row[0]: tuple(row[1:]) for row in rows}
    if detail:
        today = today or datetime.datetime.now(datetime.timezone.utc).date()
        # Only authority-projected volumes carry ids; legacy volume dicts skip the lookup.
        volume_ids = [volume["id"] for item in items for volume in item.get("volumes") or [] if volume.get("id")]
        published_volumes = {row[0] for row in db.execute(
            "SELECT volume_id FROM collection_authority_volumes WHERE library_id=? AND published IS NOT NULL"
            " AND work_id IN (" + ",".join("?" for _ in items) + ")",
            [library_id, *[item["id"] for item in items]])} if volume_ids else set()
    for item in items:
        # Active installations may have projections stored before this optional feature.
        # Resolve it from authority state at read time; no backfill or persistent write.
        item.pop("kakaoReview", None)
        if include_review and item.get("type") == "manga":
            import kakao_review
            row = work_row(db, library_id, item["id"])
            if row is not None:
                bindings = db.execute("SELECT provider,config,snapshot FROM collection_authority_bindings"
                                      " WHERE library_id=? AND work_id=? AND bound=1",
                                      [library_id, item["id"]]).fetchall()
                owned = db.execute("SELECT COALESCE(MAX(volume_number),0),COUNT(DISTINCT volume_number)"
                                   " FROM collection_authority_ownership WHERE library_id=? AND work_id=?"
                                   " AND (physical=1 OR digital=1)", [library_id, item["id"]]).fetchone()
                try:
                    state = work_state(row)
                    review = kakao_review.validated_review(item["id"], state["name"],
                        {b["provider"]: {"snapshot": json.loads(b["snapshot"]) if b["snapshot"] else None,
                                         "config": json.loads(b["config"]) if b["config"] else None}
                         for b in bindings}, owned[0], owned[1], state["derived"].get("volumeRange") or {})
                except (ValueError, TypeError, AttributeError, KeyError):
                    review = None
                if review is not None:
                    item["kakaoReview"] = review
        count, first, cover = stats.get(item["id"], (0, None, None))
        item["assetCount"] = count
        item["coverAssetId"] = cover if cover is not None else first
        if detail:
            for volume in item.get("volumes") or []:
                if volume.get("id") in published_volumes:
                    continue
                status = None
                try:
                    date = datetime.datetime.strptime(volume.get("localReleaseDate") or "", "%Y-%m-%d").date()
                    status = "upcoming" if date > today else "released"
                except ValueError:
                    pass
                volume["releaseStatus"] = status
    return items


def finalize_item(db, library_id, item, today=None, *, include_review=False):
    """Detail reads also resolve date-dependent volume release status."""
    return finalize_items(db, library_id, [item], detail=True, today=today, include_review=include_review)[0]


def projection_artwork(db, work_id, artwork_id):
    row = db.execute("SELECT payload FROM collection_authority_projection WHERE id=?",
                     [work_id]).fetchone()
    if row is None:
        return None, None
    payload = json.loads(row["payload"])
    return payload, next((art for art in payload["artworks"] if art["id"] == artwork_id), None)


# ---------------------------------------------------------------------------
# Command envelope and bookkeeping
# ---------------------------------------------------------------------------

def payload_digest(library_id, epoch, contract_version, command_type, entity):
    return hashlib.sha256(json.dumps(
        [library_id, epoch, contract_version, command_type, entity],
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class Context:
    """One command's transaction-scoped bookkeeping: touched works and delta entities."""

    def __init__(self, db, row, *, command_type, operation_id, now):
        self.db, self.row = db, row
        self.library_id, self.epoch = row["libraryId"], row["epoch"]
        self.command_type, self.operation_id, self.now = command_type, operation_id, now
        self.entities = {}
        self.touched = set()

    def add(self, kind, value, work_id=None):
        if kind == "works":
            value = av_work_entity(self.db, self.library_id, value)
        self.entities.setdefault(kind, []).append(value)
        if work_id is not None:
            self.touched.add(work_id)

    def result(self, *, changed, sequence, cursor, **extra):
        return {"libraryId": self.library_id, "epoch": self.epoch,
                "contractVersion": self.row["contractVersion"],
                "commandType": self.command_type, "operationId": self.operation_id,
                "changed": changed, "changeSequence": sequence, "authorityCursor": cursor,
                "entities": self.entities, "updatedAt": self.now, **extra}


def _receipt(db, ctx, payload_sha, entity_key, result):
    db.execute(
        "INSERT INTO collection_authority_receipts(library_id,epoch,operation_id,payload_digest,"
        "command_type,entity_key,result_payload,accepted_at) VALUES(?,?,?,?,?,?,?,?)",
        [ctx.library_id, ctx.epoch, ctx.operation_id, payload_sha, ctx.command_type,
         entity_key, encode(result), ctx.now])


def _finish(ctx, payload_sha, entity_key, **extra):
    """Commit bookkeeping: unchanged -> receipt only; changed -> cursor, change, receipt.

    Receipt, change row, cursor advance and projection refresh share the caller's
    transaction, so they commit together or not at all.
    """
    db = ctx.db
    person_changed = extra.pop("personChanged", False)
    if not ctx.entities and not person_changed:
        result = ctx.result(changed=False, sequence=None, cursor=ctx.row["cursor"], **extra)
        _receipt(db, ctx, payload_sha, entity_key, result)
        return result
    sequence = ctx.row["cursor"] + 1
    for work_id in sorted(ctx.touched):
        refresh_projection(db, ctx.library_id, work_id)
    result = ctx.result(changed=True, sequence=sequence, cursor=sequence, **extra)
    db.execute("UPDATE authority_domains SET change_cursor=? WHERE library_id=? AND domain=?",
               [sequence, ctx.library_id, DOMAIN])
    db.execute(
        "INSERT INTO collection_authority_changes(library_id,epoch,sequence,command_type,"
        "entity_key,operation_id,payload,changed_at) VALUES(?,?,?,?,?,?,?,?)",
        [ctx.library_id, ctx.epoch, sequence, ctx.command_type, entity_key, ctx.operation_id,
         encode({"entities": ctx.entities}), ctx.now])
    _receipt(db, ctx, payload_sha, entity_key, result)
    return result


def conflict(ctx, kind, current, code="revisionConflict", status=409, **extra):
    raise HTTPException(status, detail={"code": code, "authorityCursor": ctx.row["cursor"],
                                        "current": {kind: current}, **extra})


def require_work(ctx, work_id, *, live=True):
    """The work a command targets. Tombstoned -> definitive ``workDeleted``."""
    row = work_row(ctx.db, ctx.library_id, work_id)
    if row is None:
        fail(404, "workNotFound", "작품을 찾을 수 없습니다.", workId=work_id)
    if row["lifecycle"] == "tombstoned":
        fail(409, "workDeleted", "삭제된 작품입니다.", workId=work_id, definitive=True)
    if live and row["lifecycle"] == "trashed":
        raise HTTPException(409, detail={"code": "workTrashed", "message": "휴지통에 있는 작품입니다.",
                                         "workId": work_id, "authorityCursor": ctx.row["cursor"],
                                         "current": {"work": work_state(row)}})
    return row


def _bump_work(ctx, state):
    state["entityRevision"] += 1
    state["updatedAt"] = ctx.now
    write_work(ctx.db, ctx.library_id, state)
    ctx.add("works", dict(state), state["workId"])


def _next_showcase_order(db, library_id, type_, work_id):
    """PC rule: append after the current maximum within the Collection type."""
    return db.execute(
        "SELECT COALESCE(MAX(showcase_order)+1,0) FROM collection_authority_works"
        " WHERE library_id=? AND type=? AND work_id<>? AND showcase=1 AND lifecycle='live'",
        [library_id, type_, work_id]).fetchone()[0]


def _require_owned_artwork(ctx, work_id, artwork_id, code="artworkNotInWork"):
    if artwork_id is None:
        return None
    art = artwork_row(ctx.db, ctx.library_id, artwork_id)
    if art is None or art["work_id"] != work_id:
        fail(422, code, "작품에 속하지 않은 이미지입니다.", artworkId=artwork_id, workId=work_id)
    return art


def selection_kinds(slot):
    # Manga work covers can be selected volume artwork (the 1A exporter contract).
    return ("cover", "volume_cover") if slot == "work" else (SELECTION_KINDS[slot],)


def _require_confirmed_blob(db, blob):
    """The existing prepare/check receipts: exact storage HEAD confirmations."""
    row = db.execute("SELECT size_bytes,content_type FROM mobile_collection_artwork WHERE sha256=?",
                     [blob["sha256"]]).fetchone()
    if row is None or (row[0], row[1]) != (blob["sizeBytes"], blob["contentType"]):
        fail(409, "artworkBlobUnconfirmed", "이미지를 먼저 업로드하고 확인해 주세요.",
             sha256=blob["sha256"])


def _identity_holder(db, library_id, provider, external_id, work_id):
    row = db.execute(
        "SELECT work_id FROM collection_authority_bindings WHERE library_id=? AND provider=?"
        " AND external_id=? AND bound=1 AND work_id<>?",
        [library_id, provider, external_id, work_id]).fetchone()
    return row[0] if row else None


def _require_identity_free(ctx, provider, external_id, work_id):
    holder = _identity_holder(ctx.db, ctx.library_id, provider, external_id, work_id)
    if holder is not None:
        fail(409, "providerIdentityTaken", "이미 다른 작품에 연결된 작품 정보입니다.",
             provider=provider, externalId=external_id, workId=holder)


def _write_binding(ctx, *, work_id, provider, external_id, config, snapshot, values,
                   snapshot_external_id, last_synced_at, bound, existing):
    if provider == "kakao" and isinstance(config, dict) and "reviewDismissedVolumes" in config:
        import kakao_review
        if not kakao_review.dismissal_matches(config, kakao_review.snapshot_volumes(snapshot)):
            config = {key: value for key, value in config.items() if key != "reviewDismissedVolumes"}
    revision = (existing["entity_revision"] + 1) if existing is not None else 1
    snapshot_text = None if snapshot is None else encode(snapshot)
    values_text = None if values is None else encode(values)
    snapshot_sha = None if snapshot is None else digest(snapshot)
    created = existing["created_at"] if existing is not None else ctx.now
    ctx.db.execute(
        "INSERT INTO collection_authority_bindings(library_id,work_id,provider,external_id,config,"
        "snapshot,snapshot_values,snapshot_digest,snapshot_external_id,last_synced_at,bound,"
        "entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(library_id,work_id,provider) DO UPDATE SET external_id=excluded.external_id,"
        " config=excluded.config,snapshot=excluded.snapshot,snapshot_values=excluded.snapshot_values,"
        " snapshot_digest=excluded.snapshot_digest,snapshot_external_id=excluded.snapshot_external_id,"
        " last_synced_at=excluded.last_synced_at,bound=excluded.bound,"
        " entity_revision=excluded.entity_revision,updated_at=excluded.updated_at",
        [ctx.library_id, work_id, provider, external_id,
         None if config is None else encode(config), snapshot_text, values_text, snapshot_sha,
         snapshot_external_id, last_synced_at, int(bound), revision, created, ctx.now])
    row = binding_row(ctx.db, ctx.library_id, work_id, provider)
    ctx.add("bindings", binding_projection(row), work_id)
    return row


_KEEP = object()


def _apply_snapshot(ctx, state, *, provider, external_id, snapshot, values, details, existing,
                    config=_KEEP):
    """Server-side three-way merge plus binding update. Mutates ``state`` fields.

    ``config`` defaults to keeping the binding's stored config.
    """
    if PROVIDER_TYPES[provider] != state["type"]:
        fail(422, "providerTypeMismatch", "이 작품 종류에 연결할 수 없는 작품 정보입니다.",
             provider=provider, type=state["type"])
    same_identity = (existing is not None and existing["bound"]
                     and existing["external_id"] == external_id)
    if not same_identity:
        _require_identity_free(ctx, provider, external_id, state["workId"])
    mode = ("refresh" if existing is not None and existing["bound"]
            and existing["snapshot_external_id"] == external_id else "connect")
    previous = None
    if existing is not None and existing["bound"] and existing["snapshot_values"] is not None:
        previous = json.loads(existing["snapshot_values"])
    updates = merge_provider(provider, mode, state["fields"], previous, values)
    changed = False
    for field, value in updates.items():
        if state["fields"].get(field) != value:
            state["fields"][field] = value
            changed = True
    if details is not None and details != {key: state["details"].get(key) for key in details}:
        for reference in detail_artwork_references(details):
            _require_owned_artwork(ctx, state["workId"], reference)
        state["details"] = {**state["details"], **details}
        changed = True
    if config is _KEEP:
        config = None if existing is None or existing["config"] is None \
            else json.loads(existing["config"])
    _write_binding(ctx, work_id=state["workId"], provider=provider, external_id=external_id,
                   config=config, snapshot=snapshot, values=values, snapshot_external_id=external_id,
                   last_synced_at=ctx.now, bound=True, existing=existing)
    if provider in SOURCE_PROVIDERS and _sync_release_availability(ctx, state):
        changed = True
    if _refresh_release_schedule(ctx, state):
        changed = True
    return changed, mode


def _tombstone(ctx, row):
    """Purge a trashed work: tombstone, free name/identity, drop every child row."""
    state = work_state(row)
    state["lifecycle"] = "tombstoned"
    state["showcase"], state["showcaseOrder"] = False, None
    for table in ("collection_authority_bindings", "collection_authority_artworks",
                  "collection_authority_volumes", "collection_authority_volume_sources",
                  "collection_authority_ownership", "collection_authority_members"):
        ctx.db.execute(f"DELETE FROM {table} WHERE library_id=? AND work_id=?",
                       [ctx.library_id, state["workId"]])
    _bump_work(ctx, state)


def command_batch_receipt(db, *, library_id, epoch, operation_id, request_payload):
    """Fence and replay a server-built command batch using the existing receipt store."""
    row = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    if row["epoch"] != epoch:
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "컬렉션 권위가 이 라이브러리와 일치하지 않습니다.", domain=DOMAIN)
    payload_sha = payload_digest(library_id, epoch, CONTRACT_VERSION, "providerApply", request_payload)
    receipt = db.execute(
        "SELECT payload_digest,result_payload FROM collection_authority_receipts"
        " WHERE library_id=? AND epoch=? AND operation_id=?",
        [library_id, epoch, operation_id]).fetchone()
    if receipt is not None and receipt["payload_digest"] != payload_sha:
        fail(409, "operationConflict", "같은 작업 ID가 다른 내용으로 이미 사용되었습니다.")
    return row, payload_sha, None if receipt is None else json.loads(receipt["result_payload"])


def apply_command_batch(db, *, library_id, epoch, operation_id, request_payload, commands, now):
    """Validate/execute commands and receipt their orchestration in the caller's transaction.

    The batch receipt freezes the response across later provider changes. It does
    not advance the feed; each ordinary command owns its normal receipt and delta.
    """
    row, payload_sha, cached = command_batch_receipt(
        db, library_id=library_id, epoch=epoch, operation_id=operation_id,
        request_payload=request_payload)
    if cached is not None:
        return cached
    receipts = []
    for command in commands:
        lib, command_epoch, version, command_id, kind, entity = parse_command(command)
        receipts.append(apply_command(db, library_id=lib, epoch=command_epoch,
            contract_version=version, command_type=kind, operation_id=command_id,
            entity=entity, now=now))
    result = {"receipts": receipts}
    ctx = Context(db, row, command_type="providerApply", operation_id=operation_id, now=now)
    _receipt(db, ctx, payload_sha, request_payload["workId"], result)
    return result


def command_preflight(db, *, library_id, epoch, contract_version, command_type, operation_id, entity):
    """Validate authority and replay identity, also before provider I/O outside a transaction."""
    row = authority.require_active(db, DOMAIN, library_id, CONTRACT_VERSION)
    if row["epoch"] != epoch:
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "컬렉션 권위가 이 라이브러리와 일치하지 않습니다.", domain=DOMAIN)
    if contract_version != CONTRACT_VERSION:
        fail(409, authority.CODE_AUTHORITY_CONTRACT_UNSUPPORTED,
             "서버가 지원하지 않는 컬렉션 계약 버전입니다.", domain=DOMAIN)
    payload_sha = payload_digest(library_id, epoch, contract_version, command_type, entity)
    receipt = db.execute(
        "SELECT payload_digest,result_payload FROM collection_authority_receipts"
        " WHERE library_id=? AND epoch=? AND operation_id=?",
        [library_id, epoch, operation_id]).fetchone()
    if receipt is not None:
        if receipt["payload_digest"] != payload_sha:
            fail(409, "operationConflict", "같은 작업 ID가 다른 내용으로 이미 사용되었습니다.")
        return row, payload_sha, json.loads(receipt["result_payload"])
    return row, payload_sha, None


def apply_command(db, *, library_id, epoch, contract_version, command_type, operation_id,
                  entity, now, prepared_profile=None):
    """Execute one typed command inside the caller's ``BEGIN IMMEDIATE``."""
    asset_visibility.install(db)
    row, payload_sha, cached = command_preflight(db, library_id=library_id, epoch=epoch,
        contract_version=contract_version, command_type=command_type, operation_id=operation_id, entity=entity)
    if cached is not None:
        return cached
    ctx = Context(db, row, command_type=command_type, operation_id=operation_id, now=now)
    if command_type == PERSON_PROFILE:
        return _set_person_profile(ctx, entity, payload_sha, prepared_profile)
    handler = HANDLERS[command_type]
    return handler(ctx, entity, payload_sha)


# --- work commands ---------------------------------------------------------

def _create(ctx, entity, payload_sha):
    work_id = entity["workId"]
    if work_row(ctx.db, ctx.library_id, work_id) is not None:
        # A tombstoned id is never reused: reviving it would resurrect children.
        fail(409, "workExists", "같은 ID의 작품이 이미 있습니다.", workId=work_id)
    fields = {field: None for field in COMMAND_WORK_FIELDS}
    fields.update(entity["fields"])
    validate_record_fields(entity["type"], fields)
    if fields["coverAssetId"] is not None:
        asset_authority.require_linkable(ctx.db, fields["coverAssetId"], adding=True,
                                         missing_code="invalidCollectionCover")
    state = {"workId": work_id, "type": entity["type"], "legacyKind": entity["legacyKind"],
             "name": entity["name"], "fields": fields, "showcase": False, "showcaseOrder": None,
             "selection": {slot: None for slot in SELECTION_KINDS},
             "details": {"series": None, "film": None},
             "derived": {"unreadReleaseCount": 0,
                         "releaseWatch": {"enabled": False, "available": False} if entity["type"] == "manga" else None,
                         "ownedVolumes": [] if entity["type"] == "manga" else None,
                         "releaseSchedule": None},
             "lifecycle": "live", "trashedAt": None, "entityRevision": 1,
             "createdAt": ctx.now, "updatedAt": ctx.now}
    write_work(ctx.db, ctx.library_id, state, insert=True)
    # The work is listed before its binding in the delta; its final state is set below.
    ctx.add("works", state, work_id)
    binding = entity["binding"]
    if binding is not None:
        # PC "new work from provider": the merge against empty fields fills everything
        # the provider offers, in the same transaction as the identity check.
        _apply_snapshot(ctx, state, provider=binding["provider"],
                        external_id=binding["externalId"], snapshot=binding["snapshot"],
                        values=binding["values"], details=binding["details"], existing=None,
                        config=binding["config"])
        write_work(ctx.db, ctx.library_id, state)
    return _finish(ctx, payload_sha, work_id)


def _update(ctx, entity, payload_sha):
    work_id = entity["workId"]
    row = require_work(ctx, work_id)
    state = work_state(row)
    current = {**dict.fromkeys(RECORD_FIELDS), "name": state["name"],
               "showcase": state["showcase"], **state["fields"]}
    changes, expected = entity["changes"], entity["expected"]
    validate_record_fields(state["type"], changes)
    if "ownedPlatform" in changes and state["type"] != "game":
        fail(409, "collectionRecordUnavailable", "Only games have an owned platform.")
    if all(comparable(field, current[field]) == comparable(field, value)
           for field, value in changes.items()):
        # Desired state already holds: accepted, receipted, no change row.
        return _finish(ctx, payload_sha, work_id)
    revision_ok = entity["expectedRevision"] == state["entityRevision"]
    fields_ok = all(field in REBASE_FIELDS or
                    (field in expected and comparable(field, current[field]) == comparable(field, expected[field]))
                    for field in changes)
    if not revision_ok and not fields_ok:
        conflict(ctx, "work", state)
    if "coverAssetId" in changes and changes["coverAssetId"] is not None:
        asset_authority.require_linkable(ctx.db, changes["coverAssetId"], adding=True,
                                         missing_code="invalidCollectionCover")
    for field, value in changes.items():
        if field == "name":
            state["name"] = value
        elif field == "showcase":
            if value and not state["showcase"]:
                state["showcaseOrder"] = _next_showcase_order(ctx.db, ctx.library_id,
                                                              state["type"], work_id)
            elif not value:
                state["showcaseOrder"] = None
            state["showcase"] = value
        else:
            state["fields"][field] = value
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, work_id)


def _av_work(ctx, work_id):
    state = work_state(require_work(ctx, work_id))
    if state["type"] != "av":
        fail(409, "collectionAvUnavailable", "AV 작품에서만 사용할 수 있습니다.")
    return state


def _av_value(field, value):
    if field == "genres":
        if (not isinstance(value, list) or len(value) > av_contract.MAX_GENRES
                or any(not isinstance(v, str) or len(v) > av_contract.MAX_GENRE_LENGTH for v in value)):
            fail()
        return value
    if value is not None and not isinstance(value, str):
        fail()
    value = normalized_optional(value)
    if field == "releaseDate":
        if value is not None:
            if not re.fullmatch(av_contract.DATE_PATTERN, value):
                fail()
            try:
                datetime.date.fromisoformat(value)
            except ValueError:
                fail()
        return value
    return _text(value, av_contract.TEXT_LIMITS[field])


def _av_fields(value):
    allowed = {*av_contract.TEXT_LIMITS, "genres", "releaseDate"}
    if not isinstance(value, dict) or not set(value) <= allowed:
        fail()
    return {field: _av_value(field, item) for field, item in value.items()}


def _set_av_details(ctx, entity, payload_sha):
    state = _av_work(ctx, entity["workId"])
    av = state["details"].get("av") or {**dict.fromkeys(av_contract.TEXT_LIMITS),
                                      "genres": [], "releaseDate": None}
    changes, expected = entity["changes"], entity["expected"]
    if all(_av_value(k, av.get(k)) == v for k, v in changes.items()):
        return _finish(ctx, payload_sha, state["workId"])
    if any(_av_value(k, av.get(k)) != expected[k] for k in changes):
        conflict(ctx, "work", av_work_entity(ctx.db, ctx.library_id, state))
    state["details"]["av"] = {**av, **changes}
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, state["workId"])


def _credit_values(credits):
    return sorted([{k: c.get(k) for k in ("personId", "role", "order", "creditName")} for c in credits],
                  key=lambda c: (c["role"], c["order"], c["personId"]))


def _av_text(value, limit, *, nullable=True):
    _text(value, limit, nullable=nullable)
    return normalized_optional(value)


def _set_av_credits(ctx, entity, payload_sha):
    state = _av_work(ctx, entity["workId"])
    # Revision CAS matches other whole-entity replacements. Check it before creating people.
    unchanged = _credit_values(state.get("avCredits", [])) == entity["credits"]
    if not unchanged and entity["expectedRevision"] != state["entityRevision"]:
        conflict(ctx, "work", av_work_entity(ctx.db, ctx.library_id, state))
    supplied = {p["personId"]: p for p in entity["people"]}
    identities = {}
    for person_id in {c["personId"] for c in entity["credits"]}:
        row = ctx.db.execute("SELECT payload FROM collection_authority_people WHERE library_id=? AND person_id=?",
                             [ctx.library_id, person_id]).fetchone()
        if row is not None:
            identities[person_id] = av_person_identity(ctx.db, ctx.library_id, person_id, json.loads(row[0]))
        elif person_id in supplied:
            person = supplied[person_id]
            identities[person_id] = person["displayName"], person["nameJa"]
        else:
            fail(422, "invalidCollectionCommand", "새 인물의 정보가 필요합니다.")
    if unchanged:
        return _finish(ctx, payload_sha, state["workId"])
    # Retain staged identities even after their last relation is removed. The
    # existing memo/profile/portrait payload is never rewritten by this command.
    for old in state.get("avCredits", []):
        ctx.db.execute("UPDATE collection_authority_people SET display_name=?,name_ja=?"
                       " WHERE library_id=? AND person_id=? AND display_name IS NULL",
                       [old["name"], old.get("nameJa"), ctx.library_id, old["personId"]])
    for person_id, person in supplied.items():
        # Concurrent creation never changes the existing payload, even if names differ.
        payload = {"id": person_id, "displayName": person["displayName"], "nameJa": person["nameJa"],
                   "memo": None, "favorite": False, "profile": None, "portrait": None}
        ctx.db.execute("INSERT OR IGNORE INTO collection_authority_people(library_id,person_id,payload,display_name,name_ja) VALUES(?,?,?,?,?)",
                       [ctx.library_id, person_id, encode(payload), person["displayName"], person["nameJa"]])
    old_credits = {(c["personId"], c["role"]): c for c in state.get("avCredits", [])}
    state["avCredits"] = [{**c, "name": identities[c["personId"]][0], "nameJa": identities[c["personId"]][1],
                           "portraitCrop": old_credits.get((c["personId"], c["role"]), {}).get("portraitCrop")}
                          for c in entity["credits"]]
    if state["details"].get("av") is None:
        state["details"]["av"] = {**dict.fromkeys(av_contract.TEXT_LIMITS), "genres": [], "releaseDate": None}
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, state["workId"])


def person_portrait_selection(db, library_id, row):
    if row["portrait_selection"] is not None:
        return json.loads(row["portrait_selection"])
    payload = json.loads(row["payload"])
    if row["portrait_image"] is not None:
        image = json.loads(row["portrait_image"])
        attribution = payload.get("portrait") or {}
        return {"kind": "image", "original": {k: image[k] for k in ("sha256", "sizeBytes", "contentType")},
                "width": image["width"], "height": image["height"],
                "attribution": {"source": attribution.get("source", "local"),
                                **{k: attribution.get(k) for k in ("sourceUrl", "license", "author")}}}
    crop = db.execute("SELECT json_extract(c.value,'$.portraitCrop') FROM collection_authority_works w,"
                      " json_each(w.av_credits) c WHERE w.library_id=? AND json_extract(c.value,'$.personId')=?"
                      " AND json_extract(c.value,'$.portraitCrop') IS NOT NULL ORDER BY w.work_id LIMIT 1",
                      [library_id, row["person_id"]]).fetchone()
    if crop:
        value = json.loads(crop[0])
        return {"kind": "crop", "artworkId": value["artworkId"],
                "rect": {k: value[k] for k in ("x", "y", "w", "h")}}
    return None


def _profile_metadata(payload):
    import av_person_profile
    return av_person_profile.metadata(payload)


def person_entity(db, library_id, row):
    payload = json.loads(row["payload"])
    name, name_ja = av_person_identity(db, library_id, row["person_id"], payload)
    return {**payload, **_profile_metadata(payload), "personId": row["person_id"], "displayName": name, "nameJa": name_ja,
            "entityRevision": row["entity_revision"],
            "portraitSelection": person_portrait_selection(db, library_id, row),
            "portraitImage": None if row["portrait_image"] is None else json.loads(row["portrait_image"])}


def _person_row(ctx, person_id):
    row = ctx.db.execute("SELECT * FROM collection_authority_people WHERE library_id=? AND person_id=?",
                         [ctx.library_id, person_id]).fetchone()
    if row is None:
        fail(404, "personNotFound", "인물을 찾을 수 없습니다.", personId=person_id)
    return row


def _publish_person(ctx, person_id):
    # Shipped PCs reject extra feed sections: republish the affected works instead.
    rows = ctx.db.execute("SELECT DISTINCT w.* FROM collection_authority_works w,json_each(w.av_credits) c"
                          " WHERE w.library_id=? AND w.lifecycle<>'tombstoned'"
                          " AND json_extract(c.value,'$.personId')=? ORDER BY w.work_id",
                          [ctx.library_id, person_id]).fetchall()
    for row in rows:
        _bump_work(ctx, work_state(row))


def _person_fields(value):
    if not isinstance(value, dict) or not value or not set(value) <= {"memo", "favorite"}:
        fail()
    return {k: _av_text(v, av_contract.MAX_PERSON_MEMO) if k == "memo" else _bool(v)
            for k, v in value.items()}


def _set_person(ctx, entity, payload_sha):
    row = _person_row(ctx, entity["personId"])
    payload = json.loads(row["payload"])
    changes, expected = entity["changes"], entity["expected"]
    current = {k: normalized_optional(payload.get(k)) if k == "memo" else bool(payload.get(k, False))
               for k in changes}
    if current == changes:
        return _finish(ctx, payload_sha, row["person_id"], person=person_entity(ctx.db, ctx.library_id, row))
    if current != expected:
        conflict(ctx, "person", person_entity(ctx.db, ctx.library_id, row))
    payload.update(changes)
    ctx.db.execute("UPDATE collection_authority_people SET payload=?,entity_revision=entity_revision+1"
                   " WHERE library_id=? AND person_id=?", [encode(payload), ctx.library_id, row["person_id"]])
    _publish_person(ctx, row["person_id"])
    return _finish(ctx, payload_sha, row["person_id"], personChanged=True,
                   person=person_entity(ctx.db, ctx.library_id, _person_row(ctx, row["person_id"])))


def _propagate_person_names(ctx, person_id, name, name_ja, previous):
    if (name, name_ja) == previous:
        return
    # Repair all stored name copies, including trash and tombstones; publication
    # below bumps only non-tombstoned works, once each. Preserve creditName.
    rows = ctx.db.execute("SELECT DISTINCT w.* FROM collection_authority_works w,json_each(w.av_credits) c"
                          " WHERE w.library_id=? AND json_extract(c.value,'$.personId')=?",
                          [ctx.library_id, person_id]).fetchall()
    for work in rows:
        credits = json.loads(work["av_credits"])
        for credit in credits:
            if credit["personId"] == person_id:
                credit.update(name=name, nameJa=name_ja)
        ctx.db.execute("UPDATE collection_authority_works SET av_credits=? WHERE library_id=? AND work_id=?",
                       [encode(credits), ctx.library_id, work["work_id"]])


def _set_person_profile_fields(ctx, entity, payload_sha):
    import av_person_profile as profile
    row = _person_row(ctx, entity["personId"])
    payload = json.loads(row["payload"])
    name, name_ja = av_person_identity(ctx.db, ctx.library_id, row["person_id"], payload)
    overrides = payload.get("profileOverrides", {})
    effective = payload.get("profile") or {}
    current = {k: {"value": name if k == "displayName" else name_ja if k == "nameJa" else effective.get(k),
                   "overridden": k in overrides} for k in entity["changes"]}
    desired_overrides = dict(overrides)
    for key, value in entity["changes"].items():
        if value == profile.RESET:
            desired_overrides.pop(key, None)
        else:
            desired_overrides[key] = value
    # Establishing manual ownership counts as a change even at the same value.
    if desired_overrides == overrides:
        return _finish(ctx, payload_sha, row["person_id"], person=person_entity(ctx.db, ctx.library_id, row))
    if current != entity["expected"]:
        conflict(ctx, "person", person_entity(ctx.db, ctx.library_id, row))
    payload.update(profile.metadata(payload))
    name_fields = set(entity["changes"]) & profile.NAME_FIELDS
    if any(key in desired_overrides for key in name_fields):
        payload.setdefault("profileBaseNames", {"displayName": name, "nameJa": name_ja})
    payload["profileOverrides"] = desired_overrides
    payload["profile"] = profile.merged(payload)
    merged = payload["profile"] or {}
    start, end = merged.get("careerStart"), merged.get("careerEnd")
    if (set(entity["changes"]) & {"careerStart", "careerEnd"}
            and start is not None and end is not None and end < start):
        fail(422, "invalidCollectionCommand", "활동 종료 연도가 시작 연도보다 빠릅니다.")
    desired_name, desired_name_ja = (profile.names(payload)
                                   if name_fields and "profileBaseNames" in payload else (name, name_ja))
    desired_name = desired_name if "displayName" in entity["changes"] else name
    desired_name_ja = desired_name_ja if "nameJa" in entity["changes"] else name_ja
    if "displayName" in payload:
        payload["displayName"] = desired_name
    if "nameJa" in payload:
        payload["nameJa"] = desired_name_ja
    from mobile_collections import MAX_PERSON_BYTES
    if len(encode(payload).encode()) > MAX_PERSON_BYTES:
        fail(413, "collectionPayloadTooLarge", "인물 프로필 크기가 허용 범위를 초과했습니다.")
    ctx.db.execute("UPDATE collection_authority_people SET payload=?,display_name=?,name_ja=?,"
                   "entity_revision=entity_revision+1 WHERE library_id=? AND person_id=?",
                   [encode(payload), desired_name, desired_name_ja, ctx.library_id, row["person_id"]])
    _propagate_person_names(ctx, row["person_id"], desired_name, desired_name_ja, (name, name_ja))
    _publish_person(ctx, row["person_id"])
    return _finish(ctx, payload_sha, row["person_id"], personChanged=True,
                   person=person_entity(ctx.db, ctx.library_id, _person_row(ctx, row["person_id"])))


def _set_person_profile(ctx, entity, payload_sha, prepared_profile):
    row = _person_row(ctx, entity["personId"])
    payload = json.loads(row["payload"])
    desired = None
    if entity["stashdbId"] is not None:
        if prepared_profile is None or prepared_profile.get("stashdbId") != entity["stashdbId"]:
            fail(503, "providerUnavailable", "서버에서 프로필을 먼저 조회해야 합니다.")
        desired = prepared_profile["profile"]
    # Refresh is a real fetch, but identical data is a no-op even at an older revision.
    if _profile_metadata(payload)["stashdbProfile"] == desired and payload.get("stashdbId") == entity["stashdbId"]:
        return _finish(ctx, payload_sha, row["person_id"], person=person_entity(ctx.db, ctx.library_id, row))
    if row["entity_revision"] != entity["expectedRevision"]:
        conflict(ctx, "person", person_entity(ctx.db, ctx.library_id, row))
    import av_person_profile
    payload.update(_profile_metadata(payload))
    payload["stashdbProfile"] = desired
    payload["profile"] = av_person_profile.merged(payload)
    payload["stashdbId"] = entity["stashdbId"]
    from mobile_collections import MAX_PERSON_BYTES
    if len(encode(payload).encode()) > MAX_PERSON_BYTES:
        fail(413, "providerResponseTooLarge", "인물 프로필 크기가 허용 범위를 초과했습니다.")
    ctx.db.execute("UPDATE collection_authority_people SET payload=?,entity_revision=entity_revision+1"
                   " WHERE library_id=? AND person_id=?", [encode(payload), ctx.library_id, row["person_id"]])
    _publish_person(ctx, row["person_id"])
    return _finish(ctx, payload_sha, row["person_id"], personChanged=True,
                   person=person_entity(ctx.db, ctx.library_id, _person_row(ctx, row["person_id"])))


def _portrait_input(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        fail()
    if value.get("kind") == "crop" and set(value) == {"kind", "artworkId", "rect"}:
        rect = value["rect"]
        if not isinstance(rect, dict) or set(rect) != {"x", "y", "w", "h"}:
            fail()
        if any(type(v) not in (int, float) or not 0 <= v <= 1 for v in rect.values()):
            fail()
        if rect["w"] <= .02 or rect["h"] <= .02 or rect["x"] + rect["w"] > 1 or rect["y"] + rect["h"] > 1:
            fail()
        return {"kind": "crop", "artworkId": require_id(value["artworkId"]), "rect": rect}
    if value.get("kind") != "image" or set(value) != {"kind", "original", "width", "height", "attribution"}:
        fail()
    original = blob_manifest(value["original"])
    if original["contentType"] != "image/jpeg" or original["sizeBytes"] > av_contract.MAX_PORTRAIT_BYTES:
        fail()
    attribution = value["attribution"]
    if (not isinstance(attribution, dict) or set(attribution) != {"source", "sourceUrl", "license", "author"}
            or attribution["source"] not in ("commons", "stashdb", "local")):
        fail()
    attribution = {"source": attribution["source"], "sourceUrl": _text(attribution["sourceUrl"], 2000),
                   "license": _text(attribution["license"], 500), "author": _text(attribution["author"], 2000)}
    return {"kind": "image", "original": original,
            "width": _int(value["width"], low=1, high=av_contract.MAX_PORTRAIT_DIMENSION, nullable=False),
            "height": _int(value["height"], low=1, high=av_contract.MAX_PORTRAIT_DIMENSION, nullable=False),
            "attribution": attribution}


def _set_person_portrait(ctx, entity, payload_sha):
    person_id, desired = entity["personId"], entity["portrait"]
    row = _person_row(ctx, person_id)
    if desired is not None and desired["kind"] == "image":
        _require_confirmed_blob(ctx.db, desired["original"])
    if person_portrait_selection(ctx.db, ctx.library_id, row) == desired:
        return _finish(ctx, payload_sha, person_id, person=person_entity(ctx.db, ctx.library_id, row))
    if row["entity_revision"] != entity["expectedRevision"]:
        conflict(ctx, "person", person_entity(ctx.db, ctx.library_id, row))
    crop, image, attribution = None, None, None
    if desired is not None and desired["kind"] == "crop":
        art = artwork_row(ctx.db, ctx.library_id, desired["artworkId"])
        if art is None or art["kind"] != "cover":
            fail(422, "invalidPersonPortrait", "표지 이미지를 찾을 수 없습니다.")
        # The PC crops a selected cover; a later cover change must not reject the intent.
        work = work_state(require_work(ctx, art["work_id"]))
        if work["type"] != "av" or not any(c["personId"] == person_id for c in work["avCredits"]):
            fail(422, "invalidPersonPortrait", "이 인물이 나오는 AV 표지가 필요합니다.")
        crop = {"artworkId": desired["artworkId"], **desired["rect"]}
        attribution = {"source": "cover"}
    elif desired is not None:
        image = {**desired["original"], "width": desired["width"], "height": desired["height"]}
        attribution = desired["attribution"]
    payload = json.loads(row["payload"])
    payload["portrait"] = attribution
    ctx.db.execute("UPDATE collection_authority_people SET payload=?,portrait_image=?,portrait_selection=?,"
                   " entity_revision=entity_revision+1 WHERE library_id=? AND person_id=?",
                   [encode(payload), None if image is None else encode(image), encode(desired), ctx.library_id, person_id])
    # Today's work readers use the crop on each credit, and Home tickets own image blobs.
    rows = ctx.db.execute("SELECT * FROM collection_authority_works WHERE library_id=? AND type='av'",
                          [ctx.library_id]).fetchall()
    for work_row_ in rows:
        state = work_state(work_row_)
        if any(c["personId"] == person_id for c in state["avCredits"]):
            for credit in state["avCredits"]:
                if credit["personId"] == person_id:
                    credit["portraitCrop"] = crop
            write_work(ctx.db, ctx.library_id, state)
    import home_publications
    import mobile_collections
    images = [json.loads(r[0]) for r in ctx.db.execute(
        "SELECT portrait_image FROM collection_authority_people WHERE library_id=? AND portrait_image IS NOT NULL",
        [ctx.library_id])]
    home_publications.replace_cover_refs(ctx.db, mobile_collections.PORTRAIT_OWNER, [
        home_publications.BlobCover(**{k: i[k] for k in ("sha256", "sizeBytes", "contentType")}) for i in images])
    _publish_person(ctx, person_id)
    return _finish(ctx, payload_sha, person_id, personChanged=True,
                   person=person_entity(ctx.db, ctx.library_id, _person_row(ctx, person_id)))


def _delete(ctx, entity, payload_sha):
    work_id = entity["workId"]
    row = require_work(ctx, work_id, live=False)
    state = work_state(row)
    if state["lifecycle"] == "trashed":
        return _finish(ctx, payload_sha, work_id)
    if entity["expectedRevision"] != state["entityRevision"]:
        conflict(ctx, "work", state)
    state["lifecycle"], state["trashedAt"] = "trashed", ctx.now
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, work_id)


def _restore(ctx, entity, payload_sha):
    work_id = entity["workId"]
    row = require_work(ctx, work_id, live=False)
    state = work_state(row)
    if state["lifecycle"] == "live":
        return _finish(ctx, payload_sha, work_id)
    if entity["expectedRevision"] != state["entityRevision"]:
        conflict(ctx, "work", state)
    state["lifecycle"], state["trashedAt"] = "live", None
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, work_id)


def _purge(ctx, entity, payload_sha):
    work_id = entity["workId"]
    row = require_work(ctx, work_id, live=False)
    if row["lifecycle"] != "trashed":
        fail(409, "workNotTrashed", "휴지통에 있는 작품만 영구 삭제할 수 있습니다.", workId=work_id)
    if entity["expectedRevision"] != row["entity_revision"]:
        conflict(ctx, "work", work_state(row))
    _tombstone(ctx, row)
    return _finish(ctx, payload_sha, work_id)


def trash_cutoff(now):
    moment = datetime.datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc)
    return now_iso(moment - datetime.timedelta(days=TRASH_RETENTION_DAYS))


def trash_items(db, library_id, limit=TRASH_PAGE):
    """The tablet's 휴지통: trashed works newest first, with the revision a restore expects."""
    rows = db.execute(
        "SELECT work_id,type,name,trashed_at,entity_revision FROM collection_authority_works"
        " WHERE library_id=? AND lifecycle='trashed' AND COALESCE(legacy_kind,'')<>'gacha'"
        " ORDER BY trashed_at DESC, work_id LIMIT ?", [library_id, limit + 1]).fetchall()
    items = []
    for row in rows[:limit]:
        trashed = datetime.datetime.strptime(row["trashed_at"], "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc)
        items.append({"workId": row["work_id"], "type": row["type"], "name": row["name"],
                      "trashedAt": row["trashed_at"],
                      "purgeAt": now_iso(trashed + datetime.timedelta(days=TRASH_RETENTION_DAYS)),
                      "entityRevision": row["entity_revision"]})
    return items, len(rows) > limit


def _purge_expired(ctx, entity, payload_sha):
    rows = ctx.db.execute(
        "SELECT * FROM collection_authority_works WHERE library_id=? AND lifecycle='trashed'"
        " AND trashed_at<=? ORDER BY trashed_at, work_id LIMIT ?",
        [ctx.library_id, trash_cutoff(ctx.now), PURGE_BATCH + 1]).fetchall()
    for row in rows[:PURGE_BATCH]:
        _tombstone(ctx, row)
    return _finish(ctx, payload_sha, "*", hasMore=len(rows) > PURGE_BATCH)


def _showcase_order(ctx, entity, payload_sha):
    type_, desired = entity["type"], entity["workIds"]
    rows = ctx.db.execute(
        "SELECT * FROM collection_authority_works WHERE library_id=? AND type=? AND showcase=1"
        " AND lifecycle='live' ORDER BY showcase_order IS NULL, showcase_order, name COLLATE NOCASE,"
        " work_id", [ctx.library_id, type_]).fetchall()
    current = [row["work_id"] for row in rows]
    if set(current) != set(desired):
        conflict(ctx, "showcase", {"type": type_, "workIds": current})
    by_id = {row["work_id"]: row for row in rows}
    for order, work_id in enumerate(desired):
        if by_id[work_id]["showcase_order"] != order:
            state = work_state(by_id[work_id])
            state["showcaseOrder"] = order
            _bump_work(ctx, state)
    return _finish(ctx, payload_sha, type_)


# --- provider commands -------------------------------------------------------

def _bind(ctx, entity, payload_sha):
    work_id, provider, external_id = entity["workId"], entity["provider"], entity["externalId"]
    row = require_work(ctx, work_id)
    if PROVIDER_TYPES[provider] != row["type"]:
        fail(422, "providerTypeMismatch", "이 작품 종류에 연결할 수 없는 작품 정보입니다.",
             provider=provider, type=row["type"])
    existing = binding_row(ctx.db, ctx.library_id, work_id, provider)
    current_revision = existing["entity_revision"] if existing is not None and existing["bound"] else 0
    if (existing is not None and existing["bound"] and existing["external_id"] == external_id
            and (None if existing["config"] is None else json.loads(existing["config"])) == entity["config"]):
        return _finish(ctx, payload_sha, f"{work_id}:{provider}")
    if entity["expectedRevision"] != current_revision:
        conflict(ctx, "binding", binding_projection(existing))
    _require_identity_free(ctx, provider, external_id, work_id)
    # The stored snapshot stays as the merge base: a later snapshot for the new identity
    # is then a PC-style reconnect (three-way against the previous provider values).
    keep = existing is not None and existing["bound"]
    _write_binding(ctx, work_id=work_id, provider=provider, external_id=external_id,
                   config=entity["config"],
                   snapshot=json.loads(existing["snapshot"]) if keep and existing["snapshot"] else None,
                   values=json.loads(existing["snapshot_values"]) if keep and existing["snapshot_values"] else None,
                   snapshot_external_id=existing["snapshot_external_id"] if keep else None,
                   last_synced_at=existing["last_synced_at"] if keep else None,
                   bound=True, existing=existing)
    state = work_state(row)
    availability_changed = provider in SOURCE_PROVIDERS and _sync_release_availability(ctx, state)
    schedule_changed = _refresh_release_schedule(ctx, state)
    if availability_changed or schedule_changed:
        _bump_work(ctx, state)
    return _finish(ctx, payload_sha, f"{work_id}:{provider}")


def _kakao_review(ctx, entity, payload_sha):
    import kakao_review
    work_id = entity["workId"]
    row = work_row(ctx.db, ctx.library_id, work_id)
    if row is None or row["lifecycle"] != "live":
        return _finish(ctx, payload_sha, f"{work_id}:kakao")
    state = work_state(row)
    existing = binding_row(ctx.db, ctx.library_id, work_id, "kakao")
    if state["type"] != "manga" or existing is None or not existing["bound"]:
        return _finish(ctx, payload_sha, f"{work_id}:kakao")
    volumes = kakao_review.snapshot_volumes(json.loads(existing["snapshot"]) if existing["snapshot"] else None)
    if entity["dismissed"] and volumes != entity["expectedVolumes"]:
        return _finish(ctx, payload_sha, f"{work_id}:kakao")
    config = json.loads(existing["config"]) if existing["config"] else {}
    config = config if isinstance(config, dict) else {}
    previous = dict(config)
    if entity["dismissed"]:
        config["reviewDismissedVolumes"] = volumes
    else:
        config.pop("reviewDismissedVolumes", None)
    if previous != config:
        _write_binding(ctx, work_id=work_id, provider="kakao", external_id=existing["external_id"],
                       config=config, snapshot=json.loads(existing["snapshot"]) if existing["snapshot"] else None,
                       values=json.loads(existing["snapshot_values"]) if existing["snapshot_values"] else None,
                       snapshot_external_id=existing["snapshot_external_id"], last_synced_at=existing["last_synced_at"],
                       bound=True, existing=existing)
    return _finish(ctx, payload_sha, f"{work_id}:kakao")


def _unbind(ctx, entity, payload_sha):
    work_id, provider = entity["workId"], entity["provider"]
    state = work_state(require_work(ctx, work_id))
    existing = binding_row(ctx.db, ctx.library_id, work_id, provider)
    if existing is None or not existing["bound"]:
        return _finish(ctx, payload_sha, f"{work_id}:{provider}")
    if entity["expectedRevision"] != existing["entity_revision"]:
        conflict(ctx, "binding", binding_projection(existing))
    # PC deletes the binding row; the snapshot (merge base) goes with it.
    _write_binding(ctx, work_id=work_id, provider=provider, external_id=existing["external_id"],
                   config=None, snapshot=None, values=None, snapshot_external_id=None,
                   last_synced_at=None, bound=False, existing=existing)
    availability_changed = provider in SOURCE_PROVIDERS and _sync_release_availability(ctx, state)
    schedule_changed = _refresh_release_schedule(ctx, state)
    if availability_changed or schedule_changed:
        _bump_work(ctx, state)
    return _finish(ctx, payload_sha, f"{work_id}:{provider}")


def _apply_provider(ctx, entity, payload_sha):
    work_id, provider = entity["workId"], entity["provider"]
    row = require_work(ctx, work_id)
    existing = binding_row(ctx.db, ctx.library_id, work_id, provider)
    current_digest = existing["snapshot_digest"] if existing is not None and existing["bound"] else None
    if entity["baseSnapshotDigest"] != current_digest:
        conflict(ctx, "binding", binding_projection(existing), code="providerSnapshotStale")
    state = work_state(row)
    changed, mode = _apply_snapshot(ctx, state, provider=provider,
                                    external_id=entity["externalId"],
                                    snapshot=entity["snapshot"], values=entity["values"],
                                    details=entity["details"], existing=existing)
    if changed:
        _bump_work(ctx, state)
    return _finish(ctx, payload_sha, f"{work_id}:{provider}", mergeMode=mode)


# --- artwork commands ----------------------------------------------------------

def _add_artwork(ctx, entity, payload_sha):
    work_id, artwork_id = entity["workId"], entity["artworkId"]
    require_work(ctx, work_id)
    record = {key: entity[key] for key in ("kind", "provider", "providerImageId", "width",
                                             "height", "language", "original", "thumbnail")}
    existing = artwork_row(ctx.db, ctx.library_id, artwork_id)
    if existing is not None:
        stored = artwork_projection(existing)
        if stored["workId"] == work_id and all(stored[key] == value for key, value in record.items()):
            return _finish(ctx, payload_sha, artwork_id)
        # Artwork is immutable; a different record under a used id is a caller bug.
        fail(409, "artworkExists", "같은 ID의 다른 이미지가 이미 있습니다.", artworkId=artwork_id)
    count = ctx.db.execute("SELECT COUNT(*) FROM collection_authority_artworks WHERE library_id=?"
                           " AND work_id=?", [ctx.library_id, work_id]).fetchone()[0]
    if count >= MAX_ARTWORKS_PER_WORK:
        fail(409, "artworkLimit", "작품 이미지가 너무 많습니다.", workId=work_id)
    _require_confirmed_blob(ctx.db, entity["original"])
    if entity["thumbnail"] is not None:
        _require_confirmed_blob(ctx.db, entity["thumbnail"])
    ctx.db.execute(
        "INSERT INTO collection_authority_artworks(library_id,artwork_id,work_id,kind,provider,"
        "provider_image_id,width,height,language,original,thumbnail,entity_revision,created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)",
        [ctx.library_id, artwork_id, work_id, entity["kind"], entity["provider"],
         entity["providerImageId"], entity["width"], entity["height"], entity["language"],
         encode(entity["original"]),
         None if entity["thumbnail"] is None else encode(entity["thumbnail"]), ctx.now])
    ctx.add("artworks", artwork_projection(artwork_row(ctx.db, ctx.library_id, artwork_id)), work_id)
    return _finish(ctx, payload_sha, artwork_id)


def _select_artwork(ctx, entity, payload_sha):
    work_id, slot, artwork_id = entity["workId"], entity["slot"], entity["artworkId"]
    state = work_state(require_work(ctx, work_id))
    current = state["selection"].get(slot)
    if current != artwork_id and current != entity["expectedArtworkId"]:
        conflict(ctx, "work", state)
    art = _require_owned_artwork(ctx, work_id, artwork_id)
    kinds = selection_kinds(slot)
    if art is not None and art["kind"] not in kinds:
        fail(422, "invalidArtworkKind", "Artwork kind does not match the selection slot.")
    # Update flags and revisions in the same transaction as the slot. Include full
    # artwork rows so replicas and installed APK projections see the same choice.
    rows = ctx.db.execute("SELECT * FROM collection_authority_artworks WHERE library_id=?"
                          " AND work_id=? AND kind IN (" + ",".join("?" for _ in kinds) + ")",
                          [ctx.library_id, work_id, *kinds]).fetchall()
    for row in rows:
        selected = row["artwork_id"] == artwork_id
        old = bool(row["selected"]) if row["selected"] is not None else row["artwork_id"] == current
        if old == selected and row["selected"] is not None:
            continue
        ctx.db.execute("UPDATE collection_authority_artworks SET selected=?,"
                       " entity_revision=entity_revision+1 WHERE library_id=? AND artwork_id=?",
                       [int(selected), ctx.library_id, row["artwork_id"]])
        ctx.add("artworks", artwork_projection(artwork_row(ctx.db, ctx.library_id, row["artwork_id"])), work_id)
    if current == artwork_id and not ctx.entities:
        return _finish(ctx, payload_sha, work_id)
    state["selection"][slot] = artwork_id
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, work_id)


# --- volume, ownership and membership commands --------------------------------

def _owned_count(state, edition):
    entries = state["derived"].get("ownedVolumes") or []
    return next((entry["count"] for entry in entries if entry["editionIndex"] == edition), None)


def _set_owned_count(state, edition, count):
    entries = [entry for entry in state["derived"].get("ownedVolumes") or []
               if entry["editionIndex"] != edition]
    entries.append({"editionIndex": edition, "count": count})
    state["derived"]["ownedVolumes"] = sorted(entries, key=lambda entry: entry["editionIndex"])


def _tracking_work(ctx, work_id):
    state = work_state(require_work(ctx, work_id))
    if state["type"] != "manga":
        fail(409, "collectionTrackingUnavailable", "Only manga support ownership tracking and subscriptions.")
    return state


def _tracking_cas(ctx, state, entity, current, desired, expected):
    if current != desired and entity["expectedRevision"] != state["entityRevision"] and current != expected:
        conflict(ctx, "work", state)


def _release_available(ctx, work_id):
    return ctx.db.execute("SELECT 1 FROM collection_authority_bindings WHERE library_id=?"
                          " AND work_id=? AND provider IN ('kakao','aladin') AND bound=1",
                          [ctx.library_id, work_id]).fetchone() is not None


def _sync_release_availability(ctx, state):
    if state["type"] != "manga":
        return False
    watch = state["derived"].get("releaseWatch") or {"enabled": False}
    available = _release_available(ctx, state["workId"])
    desired = {"enabled": bool(watch["enabled"] and available), "available": available}
    if state["derived"].get("releaseWatch") == desired:
        return False
    state["derived"]["releaseWatch"] = desired
    return True


def _track_ownership(ctx, entity, payload_sha):
    work_id, edition, count = entity["workId"], entity["editionIndex"], entity["count"]
    state = _tracking_work(ctx, work_id)
    current = _owned_count(state, edition)
    _tracking_cas(ctx, state, entity, current, count, entity["expectedCount"])
    # Count replacement clears digital/detail holdings for this edition, including
    # rows above the requested count. False rows remain as revisioned feed state.
    existing = {row["volume_number"]: row for row in ctx.db.execute(
        "SELECT * FROM collection_authority_ownership WHERE library_id=? AND work_id=? AND edition_index=?",
        [ctx.library_id, work_id, edition])}
    for number in sorted(set(existing) | set(range(1, count + 1))):
        row = existing.get(number)
        physical = int(number <= count)
        if row is not None and row["physical"] == physical and not row["digital"]:
            continue
        revision = (row["entity_revision"] if row is not None else 0) + 1
        ctx.db.execute(
            "INSERT INTO collection_authority_ownership VALUES(?,?,?,?,?,?,?,?)"
            " ON CONFLICT(library_id,work_id,volume_number,edition_index) DO UPDATE SET"
            " physical=excluded.physical,digital=excluded.digital,entity_revision=excluded.entity_revision,"
            " updated_at=excluded.updated_at",
            [ctx.library_id, work_id, number, edition, physical, 0, revision, ctx.now])
        updated = ctx.db.execute("SELECT * FROM collection_authority_ownership WHERE library_id=?"
                                 " AND work_id=? AND volume_number=? AND edition_index=?",
                                 [ctx.library_id, work_id, number, edition]).fetchone()
        ctx.add("ownership", ownership_projection(updated), work_id)
    if current == count and not ctx.entities:
        return _finish(ctx, payload_sha, work_id)
    _set_owned_count(state, edition, count)
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, work_id)


def _release_subscription(ctx, entity, payload_sha):
    work_id, enabled = entity["workId"], entity["enabled"]
    state = _tracking_work(ctx, work_id)
    watch = state["derived"].get("releaseWatch") or {"enabled": False, "available": False}
    current = watch["enabled"]
    _tracking_cas(ctx, state, entity, current, enabled, entity["expectedEnabled"])
    available = _release_available(ctx, work_id)
    if enabled and not available:
        fail(409, "releaseWatchUnavailable", "A Kakao or Aladin binding is required.")
    desired = {"enabled": enabled, "available": available}
    if watch == desired and state["derived"].get("releaseWatch") is not None:
        return _finish(ctx, payload_sha, work_id)
    state["derived"]["releaseWatch"] = desired
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, work_id)


def normalize_volume_range(value):
    if not isinstance(value, dict) or set(value) != {"minVolume", "maxVolume", "hideConnectionPrompt"}:
        fail(422, "invalidCollectionCommand", "Invalid volume range.")
    low = _int(value["minVolume"], low=0, high=9999)
    high = _int(value["maxVolume"], low=0, high=9999)
    if low is not None and high is not None and high < low:
        fail(422, "invalidCollectionCommand", "Invalid volume range.")
    return {"minVolume": low, "maxVolume": high,
            "hideConnectionPrompt": _bool(value["hideConnectionPrompt"])}


def _volume_range(ctx, entity, payload_sha):
    state = _tracking_work(ctx, entity["workId"])
    current = state["derived"].get("volumeRange") or {
        "minVolume": None, "maxVolume": None, "hideConnectionPrompt": False}
    desired = {key: entity[key] for key in ("minVolume", "maxVolume", "hideConnectionPrompt")}
    if current == desired:
        return _finish(ctx, payload_sha, entity["workId"])
    if entity["expectedRevision"] != state["entityRevision"] and entity["expectedRange"] != current:
        conflict(ctx, "work", state)
    state["derived"]["volumeRange"] = desired
    _bump_work(ctx, state)
    return _finish(ctx, payload_sha, entity["workId"])


def _upsert_volume(ctx, entity, payload_sha):
    work_id, volume_id = entity["workId"], entity["volumeId"]
    require_work(ctx, work_id)
    existing = ctx.db.execute(
        "SELECT * FROM collection_authority_volumes WHERE library_id=? AND volume_id=?",
        [ctx.library_id, volume_id]).fetchone()
    if existing is not None and existing["work_id"] != work_id:
        fail(409, "volumeExists", "다른 작품의 권 ID입니다.", volumeId=volume_id)
    label = entity["displayLabel"] or default_volume_label(entity["volumeNumber"],
                                                            entity["editionIndex"])
    desired = {"volume_number": entity["volumeNumber"], "edition_index": entity["editionIndex"],
               "sort_order": entity["sortOrder"], "display_label": label,
               "cover_artwork_id": entity["coverArtworkId"],
               "source_provider": entity["sourceProvider"],
               "source_cover_id": entity["sourceCoverId"], "deleted": int(entity["deleted"])}
    if existing is None and entity["deleted"]:
        return _finish(ctx, payload_sha, volume_id)
    if existing is not None and all(existing[key] == value for key, value in desired.items()):
        return _finish(ctx, payload_sha, volume_id)
    current_revision = existing["entity_revision"] if existing is not None else 0
    if entity["expectedRevision"] != current_revision:
        conflict(ctx, "volume", None if existing is None else volume_projection(existing))
    _require_owned_artwork(ctx, work_id, entity["coverArtworkId"])
    if existing is None:
        live = ctx.db.execute("SELECT COUNT(*) FROM collection_authority_volumes WHERE library_id=?"
                              " AND work_id=? AND deleted=0", [ctx.library_id, work_id]).fetchone()[0]
        if live >= MAX_VOLUMES_PER_WORK:
            fail(409, "volumeLimit", "권이 너무 많습니다.", workId=work_id)
    try:
        ctx.db.execute(
            "INSERT INTO collection_authority_volumes(library_id,volume_id,work_id,volume_number,"
            "edition_index,sort_order,display_label,cover_artwork_id,source_provider,source_cover_id,"
            "deleted,entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(library_id,volume_id) DO UPDATE SET volume_number=excluded.volume_number,"
            " edition_index=excluded.edition_index,sort_order=excluded.sort_order,"
            " display_label=excluded.display_label,cover_artwork_id=excluded.cover_artwork_id,"
            " source_provider=excluded.source_provider,source_cover_id=excluded.source_cover_id,"
            " deleted=excluded.deleted,entity_revision=excluded.entity_revision,"
            " updated_at=excluded.updated_at",
            [ctx.library_id, volume_id, work_id, desired["volume_number"], desired["edition_index"],
             desired["sort_order"], label, desired["cover_artwork_id"], desired["source_provider"],
             desired["source_cover_id"], desired["deleted"], current_revision + 1,
             existing["created_at"] if existing is not None else ctx.now, ctx.now])
    except sqlite3.IntegrityError:
        fail(409, "volumeConflict", "같은 권과 판이 이미 있습니다.", workId=work_id,
             volumeNumber=entity["volumeNumber"], editionIndex=entity["editionIndex"])
    row = ctx.db.execute("SELECT * FROM collection_authority_volumes WHERE library_id=? AND volume_id=?",
                         [ctx.library_id, volume_id]).fetchone()
    ctx.add("volumes", volume_projection(row), work_id)
    state = work_state(require_work(ctx, work_id))
    if _refresh_release_schedule(ctx, state):
        _bump_work(ctx, state)
    return _finish(ctx, payload_sha, volume_id)


def _upsert_source(ctx, entity, payload_sha):
    work_id, number, provider = entity["workId"], entity["volumeNumber"], entity["provider"]
    require_work(ctx, work_id)
    key = f"{work_id}:{number}:{provider}"
    existing = ctx.db.execute(
        "SELECT * FROM collection_authority_volume_sources WHERE library_id=? AND work_id=?"
        " AND volume_number=? AND provider=?", [ctx.library_id, work_id, number, provider]).fetchone()
    desired = {"provider_item_id": entity["providerItemId"], "title": entity["title"],
               "author": entity["author"], "publisher": entity["publisher"],
               "isbn13": entity["isbn13"], "publication_date": entity["publicationDate"],
               "item_url": entity["itemUrl"], "data": encode(entity["data"]),
               "deleted": int(entity["deleted"])}
    if existing is None and entity["deleted"]:
        return _finish(ctx, payload_sha, key)
    if existing is not None and all(existing[k] == v for k, v in desired.items()):
        return _finish(ctx, payload_sha, key)
    current_revision = existing["entity_revision"] if existing is not None else 0
    if entity["expectedRevision"] != current_revision:
        conflict(ctx, "volumeSource", None if existing is None else source_projection(existing))
    try:
        ctx.db.execute(
            "INSERT INTO collection_authority_volume_sources(library_id,work_id,volume_number,"
            "provider,provider_item_id,title,author,publisher,isbn13,publication_date,item_url,data,"
            "deleted,entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(library_id,work_id,volume_number,provider) DO UPDATE SET"
            " provider_item_id=excluded.provider_item_id,title=excluded.title,author=excluded.author,"
            " publisher=excluded.publisher,isbn13=excluded.isbn13,"
            " publication_date=excluded.publication_date,item_url=excluded.item_url,data=excluded.data,"
            " deleted=excluded.deleted,entity_revision=excluded.entity_revision,"
            " updated_at=excluded.updated_at",
            [ctx.library_id, work_id, number, provider, *desired.values(), current_revision + 1,
             existing["created_at"] if existing is not None else ctx.now, ctx.now])
    except sqlite3.IntegrityError:
        fail(409, "providerIdentityTaken", "이미 다른 권에 연결된 도서 정보입니다.",
             provider=provider, externalId=entity["providerItemId"])
    row = ctx.db.execute(
        "SELECT * FROM collection_authority_volume_sources WHERE library_id=? AND work_id=?"
        " AND volume_number=? AND provider=?", [ctx.library_id, work_id, number, provider]).fetchone()
    ctx.add("volumeSources", source_projection(row), work_id)
    state = work_state(require_work(ctx, work_id))
    if _refresh_release_schedule(ctx, state):
        _bump_work(ctx, state)
    return _finish(ctx, payload_sha, key)


def _ownership(ctx, entity, payload_sha):
    work_id, number, edition = entity["workId"], entity["volumeNumber"], entity["editionIndex"]
    state = work_state(require_work(ctx, work_id))
    key = f"{work_id}:{number}:{edition}"
    existing = ctx.db.execute(
        "SELECT * FROM collection_authority_ownership WHERE library_id=? AND work_id=?"
        " AND volume_number=? AND edition_index=?", [ctx.library_id, work_id, number, edition]).fetchone()
    physical, digital = int(entity["physical"]), int(entity["digital"])
    current = (existing["physical"], existing["digital"]) if existing is not None else (0, 0)
    if current == (physical, digital):
        return _finish(ctx, payload_sha, key)
    current_revision = existing["entity_revision"] if existing is not None else 0
    if entity["expectedRevision"] != current_revision:
        conflict(ctx, "ownership", None if existing is None else ownership_projection(existing))
    ctx.db.execute(
        "INSERT INTO collection_authority_ownership(library_id,work_id,volume_number,edition_index,"
        "physical,digital,entity_revision,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        " ON CONFLICT(library_id,work_id,volume_number,edition_index) DO UPDATE SET"
        " physical=excluded.physical,digital=excluded.digital,"
        " entity_revision=excluded.entity_revision,updated_at=excluded.updated_at",
        [ctx.library_id, work_id, number, edition, physical, digital, current_revision + 1, ctx.now])
    row = ctx.db.execute(
        "SELECT * FROM collection_authority_ownership WHERE library_id=? AND work_id=?"
        " AND volume_number=? AND edition_index=?", [ctx.library_id, work_id, number, edition]).fetchone()
    ctx.add("ownership", ownership_projection(row), work_id)
    if state["type"] == "manga" and edition <= 3:
        count = ctx.db.execute("SELECT COUNT(*) FROM collection_authority_ownership WHERE library_id=?"
                               " AND work_id=? AND edition_index=? AND (physical=1 OR digital=1)",
                               [ctx.library_id, work_id, edition]).fetchone()[0]
        _set_owned_count(state, edition, count)
        _bump_work(ctx, state)
    return _finish(ctx, payload_sha, key)


def _membership(ctx, entity, payload_sha):
    work_id, asset_id, desired = entity["workId"], entity["assetId"], entity["desiredState"]
    require_work(ctx, work_id)
    key = f"{work_id}:{asset_id}"
    relation = ctx.db.execute(
        "SELECT * FROM collection_authority_members WHERE library_id=? AND work_id=? AND asset_id=?",
        [ctx.library_id, work_id, asset_id]).fetchone()
    current_state = bool(relation["desired_state"]) if relation is not None else False
    current_revision = relation["entity_revision"] if relation is not None else 0
    # Same link rule as Album membership (ADR-0038 §4): trash keeps relations; a
    # tombstoned Asset is refused definitively.
    asset_authority.require_linkable(ctx.db, asset_id, adding=False,
                                     missing_code="invalidCollectionMembership")
    if current_state == desired:
        return _finish(ctx, payload_sha, key)
    if entity["expectedRevision"] != current_revision:
        conflict(ctx, "membership", membership_projection(
            work_id, asset_id, current_state, current_revision,
            relation["added_at"] if relation is not None else None))
    if desired:
        asset_authority.require_linkable(ctx.db, asset_id, adding=True,
                                         missing_code="invalidCollectionMembership")
    added_at = ctx.now if desired else relation["added_at"]
    ctx.db.execute(
        "INSERT INTO collection_authority_members(library_id,work_id,asset_id,desired_state,"
        "entity_revision,added_at,updated_at) VALUES(?,?,?,?,?,?,?)"
        " ON CONFLICT(library_id,work_id,asset_id) DO UPDATE SET desired_state=excluded.desired_state,"
        " entity_revision=excluded.entity_revision,added_at=excluded.added_at,"
        " updated_at=excluded.updated_at",
        [ctx.library_id, work_id, asset_id, int(desired), current_revision + 1, added_at, ctx.now])
    # assetCount is computed at read time, so the served row itself does not change.
    ctx.add("memberships", membership_projection(work_id, asset_id, desired,
                                                 current_revision + 1, added_at))
    return _finish(ctx, payload_sha, key)


def _refresh_release_schedule(ctx, state):
    if state["type"] != "manga":
        return False
    schedule = {"kakao": None, "mangadex": None}
    bounds = state["derived"].get("volumeRange") or {}
    inside = lambda number: (1 <= number <= 999
        and (bounds.get("minVolume") is None or number >= bounds["minVolume"])
        and (bounds.get("maxVolume") is None or number <= bounds["maxVolume"]))
    for provider in schedule:
        binding = binding_row(ctx.db, ctx.library_id, state["workId"], provider)
        if binding is None or not binding["bound"]:
            continue
        checked = binding["last_synced_at"]
        if provider == "kakao":
            volumes = []
            for row in ctx.db.execute("SELECT volume_number,publication_date FROM collection_authority_volume_sources"
                                      " WHERE library_id=? AND work_id=? AND provider='kakao' AND deleted=0 ORDER BY volume_number",
                                      [ctx.library_id, state["workId"]]):
                if not inside(row[0]):
                    continue
                date, status = None, None
                try:
                    date = datetime.datetime.strptime(row[1], "%Y-%m-%d").date().isoformat()
                    if checked:
                        today = datetime.datetime.fromisoformat(checked.replace("Z", "+00:00")).date().isoformat()
                        status = "upcoming" if date > today else "released"
                except (ValueError, TypeError):
                    pass
                volumes.append({"volumeNumber": row[0], "date": date, "status": status})
            schedule[provider] = {"editionIndex": 0, "checkedAt": checked, "volumes": volumes}
        else:
            # Retain staged/previous monotonic seen slots, including temporary cover removal.
            previous = (state["derived"].get("releaseSchedule") or {}).get("mangadex") or {}
            slots = {(v["volumeNumber"], v.get("editionIndex", 0)) for v in previous.get("volumes", [])}
            slots.update((row[0], row[1]) for row in ctx.db.execute(
                "SELECT volume_number,edition_index FROM collection_authority_volumes"
                " WHERE library_id=? AND work_id=? AND source_provider='mangadex' AND deleted=0",
                [ctx.library_id, state["workId"]]))
            volumes = [{"volumeNumber": n, "editionIndex": e} for n, e in sorted(slots) if inside(n) and 0 <= e <= 3][:999]
            schedule[provider] = {"checkedAt": checked, "latestVolume": volumes[-1]["volumeNumber"] if volumes else None,
                                  "volumes": volumes}
    if state["derived"].get("releaseSchedule") == schedule:
        return False
    state["derived"]["releaseSchedule"] = schedule
    return True


def _release_state(ctx, state):
    """The existing release store serves the shipped tablet; the work feed serves PC."""
    import collection_releases as releases
    rows = ctx.db.execute("SELECT * FROM collection_release_events WHERE collection_id=? ORDER BY id",
                          [state["workId"]]).fetchall()
    events = [{key: value for key, value in releases._item(row).items()
               if key not in ("collectionId", "collectionName", "read")} for row in rows]
    unread = sum(event["readAt"] is None for event in events)
    if (state["derived"].get("releaseEvents") != events
            or state["derived"].get("unreadReleaseCount") != unread):
        state["derived"]["releaseEvents"] = events
        state["derived"]["unreadReleaseCount"] = unread
        _bump_work(ctx, state)


def _record_release(ctx, entity, payload_sha):
    import collection_releases as releases
    state = work_state(require_work(ctx, entity["workId"]))
    if state["type"] != "manga":
        fail(422, "collectionTrackingUnavailable", "만화 작품에서만 신간 알림을 사용할 수 있습니다.")
    releases._retain(ctx.db, releases.parse_instant(ctx.now))
    existing = ctx.db.execute("SELECT * FROM collection_release_events WHERE event_id=?",
                              [entity["eventId"]]).fetchone()
    values = (state["workId"], state["name"], entity["provider"], entity["kind"], entity["volumeNumber"],
              entity["previousValue"], entity["currentValue"], entity["detectedAt"])
    if existing is not None and tuple(existing[key] for key in releases.CONTENT) != values:
        fail(409, "releaseEventExists", "같은 ID의 다른 신간 알림이 이미 있습니다.")
    if existing is None:
        if ctx.db.execute("SELECT COUNT(*) FROM collection_release_events").fetchone()[0] >= releases.MAX_EVENTS:
            fail(409, "releaseEventLimit", "신간 알림이 너무 많습니다.")
        generation = releases._state(ctx.db)["generation"] or 1
        ctx.db.execute("INSERT INTO collection_release_events(event_id,collection_id,collection_name,provider,kind,"
                       "volume_number,previous_value,current_value,detected_at,detected_ms,generation,read_at,updated_at)"
                       " VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
                       [entity["eventId"], *values, int(releases.parse_instant(entity["detectedAt"]).timestamp()*1000), generation, ctx.now])
        releases._bump(ctx.db)
    _release_state(ctx, state)
    return _finish(ctx, payload_sha, state["workId"])


def _ack_release(ctx, entity, payload_sha):
    import collection_releases as releases
    state = work_state(require_work(ctx, entity["workId"]))
    if state["type"] != "manga":
        fail(422, "collectionTrackingUnavailable", "만화 작품에서만 신간 알림을 사용할 수 있습니다.")
    sequence = releases._state(ctx.db)["read_sequence"]
    changed = False
    for event_id in entity["eventIds"]:
        hit = ctx.db.execute("UPDATE collection_release_events SET read_at=?,updated_at=?"
                             " WHERE event_id=? AND collection_id=? AND read_at IS NULL",
                             [ctx.now, ctx.now, event_id, state["workId"]]).rowcount
        if hit:
            changed = True
            sequence += 1
            ctx.db.execute("INSERT INTO collection_release_reads VALUES(?,?,?,?,?)",
                           [sequence, ctx.operation_id, event_id, state["workId"], ctx.now])
    if changed:
        ctx.db.execute("UPDATE collection_release_state SET read_sequence=? WHERE singleton=1", [sequence])
        releases._bump(ctx.db)
    releases._retain(ctx.db, releases.parse_instant(ctx.now))
    _release_state(ctx, state)
    return _finish(ctx, payload_sha, state["workId"])


def acknowledge_release_shim(db, domain, operation_id, grouped, now):
    """Preserve the tablet ACK envelope while atomically revisioning each affected work."""
    from uuid import UUID, uuid5
    for work_id, ids in sorted(grouped.items()):
        for start in range(0, len(ids), 500):
            apply_command(db, library_id=domain["libraryId"], epoch=domain["epoch"],
                          contract_version=CONTRACT_VERSION, command_type=ACK_RELEASE,
                          operation_id=str(uuid5(UUID(operation_id), f"{work_id}:{start}")),
                          entity={"workId": work_id, "eventIds": ids[start:start + 500]}, now=now)


HANDLERS = {
    CREATE: _create, UPDATE: _update, DELETE: _delete, RESTORE: _restore, PURGE: _purge,
    PURGE_EXPIRED: _purge_expired, SHOWCASE_ORDER: _showcase_order, BIND: _bind,
    UNBIND: _unbind, APPLY_SNAPSHOT: _apply_provider, ADD_ARTWORK: _add_artwork,
    SELECT_ARTWORK: _select_artwork, UPSERT_VOLUME: _upsert_volume,
    UPSERT_VOLUME_SOURCE: _upsert_source, OWNERSHIP: _ownership, MEMBERSHIP: _membership,
    TRACK_OWNERSHIP: _track_ownership, RELEASE_SUBSCRIPTION: _release_subscription,
    VOLUME_RANGE: _volume_range, KAKAO_REVIEW: _kakao_review, RECORD_RELEASE: _record_release, ACK_RELEASE: _ack_release,
    AV_DETAILS: _set_av_details, AV_CREDITS: _set_av_credits,
    PERSON_PROFILE_FIELDS: _set_person_profile_fields,
    PERSON: _set_person, PERSON_PORTRAIT: _set_person_portrait, PERSON_PROFILE: _set_person_profile,
}


# ---------------------------------------------------------------------------
# Command parsing
# ---------------------------------------------------------------------------

def _revision(value, *, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_SAFE_INTEGER:
        fail(422, "invalidCollectionRevision", "revision 값이 올바르지 않습니다.")
    return value


def _bool(value):
    if type(value) is not bool:
        fail()
    return value


def _provider(value):
    if value not in PROVIDERS:
        fail(422, "unsupportedProvider", "지원하지 않는 작품 정보 제공자입니다.")
    return value


def _external_id(provider, value):
    if not valid_external_id(provider, value):
        fail(422, "invalidProviderIdentity", "작품 정보 ID가 올바르지 않습니다.")
    return value


def _fields(value, allowed):
    if not isinstance(value, dict) or not set(value) <= set(allowed):
        fail()
    result = {}
    for field, item in value.items():
        if field == "name":
            result[field] = normalize_name(item)
        elif field == "showcase":
            result[field] = _bool(item)
        else:
            result[field] = normalize_field(field, item)
    return result


def _expected(value, allowed):
    """``expected`` values are compared after normalization, with lenient limits."""
    if not isinstance(value, dict) or not set(value) <= set(allowed):
        fail()
    result = {}
    for field, item in value.items():
        if field == "name":
            result[field] = _text(item, MAX_STAGED_NAME)
        elif field == "showcase":
            result[field] = _bool(item)
        else:
            result[field] = normalize_field(field, item, staged=True)
    return result


def parse_binding_input(value, work_type, *, allow_config=True):
    keys = {"provider", "externalId", "config", "snapshot", "values", "details"}
    if not isinstance(value, dict) or set(value) != keys:
        fail()
    provider = _provider(value["provider"])
    if PROVIDER_TYPES[provider] != work_type:
        fail(422, "providerTypeMismatch", "이 작품 종류에 연결할 수 없는 작품 정보입니다.",
             provider=provider, type=work_type)
    details = value["details"]
    if details is not None and provider != "tmdb":
        fail()
    return {"provider": provider, "externalId": _external_id(provider, value["externalId"]),
            "config": json_object(value["config"], MAX_CONFIG_BYTES),
            "snapshot": json_object(value["snapshot"], MAX_SNAPSHOT_BYTES, nullable=False),
            "values": normalize_provider_values(provider, value["values"]),
            "details": None if details is None else validate_details(details)}


def parse_command(body):
    """Validate the ADR-0037 envelope plus exactly one command's own keys."""
    if not isinstance(body, dict) or not ENVELOPE_KEYS <= set(body):
        fail(422, "invalidCollectionCommand", "컬렉션 명령 봉투가 불완전합니다.")
    command_type = body["commandType"]
    if command_type not in COMMAND_TYPES:
        fail(422, "unsupportedCollectionCommand", "지원하지 않는 컬렉션 명령입니다.")
    if set(body) != ENVELOPE_KEYS | COMMAND_KEYS[command_type]:
        fail(422, "invalidCollectionCommand", "컬렉션 명령 필드가 올바르지 않습니다.")
    library_id, epoch = body["libraryId"], body["epoch"]
    contract_version, operation_id = body["contractVersion"], body["operationId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, "invalidCollectionCommand", "라이브러리 ID가 올바르지 않습니다.")
    if type(epoch) is not int or epoch < 1:
        fail(422, "invalidCollectionCommand", "컬렉션 권위 epoch 값이 올바르지 않습니다.")
    if type(contract_version) is not int or contract_version < 1:
        fail(422, "invalidCollectionCommand", "컬렉션 계약 버전이 올바르지 않습니다.")
    if not isinstance(operation_id, str) or not UUID_PATTERN.fullmatch(operation_id):
        fail(422, "invalidCollectionCommand", "작업 ID가 올바르지 않습니다.")
    entity = {}
    if "workId" in COMMAND_KEYS[command_type]:
        entity["workId"] = require_id(body["workId"])
    if command_type == CREATE:
        type_ = require_type(body["type"])
        legacy = body["legacyKind"]
        if legacy is not None and legacy not in LEGACY_KINDS:
            fail()
        fields = _fields(body["fields"], COMMAND_WORK_FIELDS)
        validate_record_fields(type_, fields)
        binding = body["binding"]
        entity.update(type=type_, name=normalize_name(body["name"]), legacyKind=legacy,
                      fields=fields,
                      binding=None if binding is None else parse_binding_input(binding, type_))
    elif command_type == UPDATE:
        changes = _fields(body["changes"], UPDATABLE)
        if not changes:
            fail()
        expected = _expected(body["expected"], UPDATABLE)
        revision = body["expectedRevision"]
        if revision is not None:
            revision = _revision(revision, minimum=1)
        elif not set(changes) <= set(expected):
            # Field-level CAS needs an expectation for every touched field.
            fail(422, "invalidCollectionCommand", "변경하는 모든 필드의 기대값이 필요합니다.")
        entity.update(changes=changes, expected=expected, expectedRevision=revision)
    elif command_type == PERSON:
        changes, expected = _person_fields(body["changes"]), _person_fields(body["expected"])
        if set(changes) != set(expected):
            fail()
        entity.update(personId=require_id(body["personId"]), changes=changes, expected=expected)
    elif command_type == PERSON_PROFILE_FIELDS:
        import av_person_profile
        changes, expected = av_person_profile.parse(body["changes"], body["expected"])
        entity.update(personId=require_id(body["personId"]), changes=changes, expected=expected)
    elif command_type == PERSON_PORTRAIT:
        entity.update(personId=require_id(body["personId"]), portrait=_portrait_input(body["portrait"]),
                      expectedRevision=_revision(body["expectedRevision"], minimum=1))
    elif command_type == PERSON_PROFILE:
        stashdb_id = body["stashdbId"]
        if stashdb_id is not None and (not isinstance(stashdb_id, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", stashdb_id)):
            fail(422, "providerIdentityInvalid", "StashDB 인물 ID가 올바르지 않습니다.")
        entity.update(personId=require_id(body["personId"]), stashdbId=stashdb_id,
                      expectedRevision=_revision(body["expectedRevision"], minimum=1))
    elif command_type == AV_DETAILS:
        changes, expected = _av_fields(body["changes"]), _av_fields(body["expected"])
        if not changes or set(changes) != set(expected):
            fail()
        entity.update(changes=changes, expected=expected)
    elif command_type == AV_CREDITS:
        credits, people = body["credits"], body["people"]
        if (not isinstance(credits, list) or len(credits) > av_contract.MAX_CREDITS
                or not isinstance(people, list) or len(people) > av_contract.MAX_CREDITS):
            fail()
        parsed, seen, orders = [], set(), set()
        for credit in credits:
            if not isinstance(credit, dict) or set(credit) != {"personId", "role", "order", "creditName"}:
                fail()
            person_id = require_id(credit["personId"])
            role = credit["role"]
            if role not in ("performer", "director") or (person_id, role) in seen:
                fail()
            seen.add((person_id, role))
            order = _int(credit["order"], low=0, high=av_contract.MAX_CREDITS-1, nullable=False)
            if (role, order) in orders:
                fail()
            orders.add((role, order))
            parsed.append({"personId": person_id, "role": role,
                           "order": order,
                           "creditName": _av_text(credit["creditName"], av_contract.MAX_CREDIT_NAME)})
        new_people, ids = [], set()
        for person in people:
            if not isinstance(person, dict) or set(person) != {"personId", "displayName", "nameJa"}:
                fail()
            person_id = require_id(person["personId"])
            if person_id in ids or not any(c["personId"] == person_id for c in parsed):
                fail()
            ids.add(person_id)
            name = _av_text(person["displayName"], av_contract.MAX_PERSON_NAME, nullable=False)
            if not name:
                fail()
            new_people.append({"personId": person_id, "displayName": name,
                               "nameJa": _av_text(person["nameJa"], av_contract.MAX_PERSON_NAME)})
        # Canonical list order makes desired-state no-ops independent of JSON array ordering.
        parsed.sort(key=lambda c: (c["role"], c["order"], c["personId"]))
        entity.update(credits=parsed, people=sorted(new_people, key=lambda p: p["personId"]),
                      expectedRevision=_revision(body["expectedRevision"], minimum=1))
    elif command_type in (DELETE, RESTORE, PURGE):
        entity["expectedRevision"] = _revision(body["expectedRevision"], minimum=1)
    elif command_type == SHOWCASE_ORDER:
        work_ids = body["workIds"]
        if not isinstance(work_ids, list) or len(work_ids) > MAX_WORKS \
                or len(set(work_ids)) != len(work_ids):
            fail()
        entity.update(type=require_type(body["type"]), workIds=[require_id(i) for i in work_ids])
    elif command_type == BIND:
        provider = _provider(body["provider"])
        entity.update(provider=provider, externalId=_external_id(provider, body["externalId"]),
                      config=json_object(body["config"], MAX_CONFIG_BYTES),
                      expectedRevision=_revision(body["expectedRevision"]))
    elif command_type == UNBIND:
        entity.update(provider=_provider(body["provider"]),
                      expectedRevision=_revision(body["expectedRevision"], minimum=1))
    elif command_type == APPLY_SNAPSHOT:
        provider = _provider(body["provider"])
        base = body["baseSnapshotDigest"]
        if base is not None and (not isinstance(base, str) or not HEX_DIGEST_PATTERN.fullmatch(base)):
            fail()
        # Existing PC Kakao commands may send an empty details object.
        # Only TMDB owns nonempty details; normalize the empty sentinel.
        details = None if provider == "kakao" and body["details"] == {} else body["details"]
        if details is not None and provider != "tmdb":
            fail()
        entity.update(provider=provider, externalId=_external_id(provider, body["externalId"]),
                      snapshot=json_object(body["snapshot"], MAX_SNAPSHOT_BYTES, nullable=False),
                      values=normalize_provider_values(provider, body["values"]),
                      details=None if details is None else validate_details(details),
                      baseSnapshotDigest=base)
    elif command_type == ADD_ARTWORK:
        kind = body["kind"]
        if not isinstance(kind, str) or not 1 <= len(kind) <= 40:
            fail()
        entity.update(artworkId=require_id(body["artworkId"]), kind=kind,
                      provider=_text(body["provider"], 40),
                      providerImageId=_text(body["providerImageId"], 512),
                      width=_int(body["width"], low=1, high=1_000_000),
                      height=_int(body["height"], low=1, high=1_000_000),
                      language=_text(body["language"], 40),
                      original=blob_manifest(body["original"]),
                      thumbnail=None if body["thumbnail"] is None
                      else blob_manifest(body["thumbnail"], thumbnail=True))
    elif command_type == SELECT_ARTWORK:
        if not isinstance(body["slot"], str) or body["slot"] not in SELECTION_KINDS:
            fail()
        entity.update(slot=body["slot"], artworkId=require_id(body["artworkId"], nullable=True),
                      expectedArtworkId=require_id(body["expectedArtworkId"], nullable=True))
    elif command_type == UPSERT_VOLUME:
        provider = body["sourceProvider"]
        entity.update(volumeId=require_id(body["volumeId"]),
                      volumeNumber=_int(body["volumeNumber"], low=1, high=1_000_000, nullable=False),
                      editionIndex=_int(body["editionIndex"], low=0, high=255, nullable=False),
                      sortOrder=_int(body["sortOrder"], nullable=False),
                      displayLabel=_text(body["displayLabel"], 512),
                      coverArtworkId=require_id(body["coverArtworkId"], nullable=True),
                      sourceProvider=_text(provider, 40),
                      sourceCoverId=_text(body["sourceCoverId"], 512),
                      deleted=_bool(body["deleted"]),
                      expectedRevision=_revision(body["expectedRevision"]))
    elif command_type == UPSERT_VOLUME_SOURCE:
        provider = body["provider"]
        if provider not in SOURCE_PROVIDERS:
            fail(422, "unsupportedProvider", "지원하지 않는 도서 정보 제공자입니다.")
        item_id = body["providerItemId"]
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 200:
            fail()
        entity.update(volumeNumber=_int(body["volumeNumber"], low=1, high=999, nullable=False),
                      provider=provider, providerItemId=item_id,
                      title=_text(body["title"], 2000, nullable=False),
                      author=_text(body["author"], 2000), publisher=_text(body["publisher"], 2000),
                      isbn13=_text(body["isbn13"], 100),
                      publicationDate=_text(body["publicationDate"], 100),
                      itemUrl=_text(body["itemUrl"], 2000),
                      data=json_object(body["data"], MAX_CONFIG_BYTES, nullable=False),
                      deleted=_bool(body["deleted"]),
                      expectedRevision=_revision(body["expectedRevision"]))
    elif command_type == OWNERSHIP:
        entity.update(volumeNumber=_int(body["volumeNumber"], low=1, high=1_000_000, nullable=False),
                      editionIndex=_int(body["editionIndex"], low=0, high=255, nullable=False),
                      physical=_bool(body["physical"]), digital=_bool(body["digital"]),
                      expectedRevision=_revision(body["expectedRevision"]))
    elif command_type == KAKAO_REVIEW:
        volumes = body["expectedVolumes"]
        if not isinstance(volumes, list) or len(volumes) > 9999 or any(type(n) is not int or n < 1 for n in volumes) or sorted(set(volumes)) != volumes:
            fail()
        entity.update(dismissed=_bool(body["dismissed"]), expectedVolumes=volumes)
    elif command_type == VOLUME_RANGE:
        entity.update(normalize_volume_range({key: body[key] for key in
                      ("minVolume", "maxVolume", "hideConnectionPrompt")}))
        entity["expectedRange"] = normalize_volume_range(body["expectedRange"])
        entity["expectedRevision"] = (None if body["expectedRevision"] is None
                                      else _revision(body["expectedRevision"], minimum=1))
    elif command_type in (TRACK_OWNERSHIP, RELEASE_SUBSCRIPTION):
        revision = body["expectedRevision"]
        entity["expectedRevision"] = None if revision is None else _revision(revision, minimum=1)
        if command_type == TRACK_OWNERSHIP:
            entity.update(editionIndex=_int(body["editionIndex"], low=0, high=3, nullable=False),
                          count=_int(body["count"], low=0, high=2000, nullable=False),
                          expectedCount=_int(body["expectedCount"], low=0, high=2000))
        else:
            entity.update(enabled=_bool(body["enabled"]), expectedEnabled=_bool(body["expectedEnabled"]))
    elif command_type == RECORD_RELEASE:
        import collection_releases as releases
        from pydantic import ValidationError
        try:
            item = releases.Event.model_validate({"eventId": body["eventId"], "collectionId": entity["workId"],
                  "collectionName": "authority", **{key: body[key] for key in
                  ("provider", "kind", "volumeNumber", "previousValue", "currentValue", "detectedAt")}})
        except (ValidationError, ValueError):
            fail()
        entity.update({key: value for key, value in item.model_dump().items()
                       if key not in ("collectionId", "collectionName")})
    elif command_type == ACK_RELEASE:
        import collection_releases as releases
        ids = body["eventIds"]
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 500
                or any(not isinstance(i, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", i) for i in ids)
                or len(set(ids)) != len(ids)):
            fail()
        entity["eventIds"] = ids
    elif command_type == MEMBERSHIP:
        entity.update(assetId=require_id(body["assetId"]), desiredState=_bool(body["desiredState"]),
                      expectedRevision=_revision(body["expectedRevision"]))
    return library_id, epoch, contract_version, operation_id, command_type, entity


# ---------------------------------------------------------------------------
# Staging (publisher-only, inactive-only) and activation
# ---------------------------------------------------------------------------

STAGING_KEYS = {"libraryId", "personalEditCursor", "works", "bindings", "artworks", "volumes",
                "volumeSources", "ownership", "memberships"}
STAGING_V2_KEYS = STAGING_KEYS | {"stagingVersion", "legacyRevision", "bindingRequestSequence",
                                  "releaseReadCursor", "releaseGeneration", "people"}
TRACKING_FIELDS = ("releaseWatch", "ownedVolumes", "releaseSchedule")


def _staged_list(body, key, limit=MAX_STAGED_ROWS):
    value = body[key]
    if not isinstance(value, list) or len(value) > limit:
        fail(422, "invalidCollectionBaseline", "기준선 목록이 올바르지 않습니다.", section=key)
    return value


def _exact(item, keys, section):
    if not isinstance(item, dict) or set(item) != keys:
        fail(422, "invalidCollectionBaseline", "기준선 항목 형식이 올바르지 않습니다.", section=section)
    return item


def _parse_staging_v1(body, *, allow_missing_original=False):
    """Normalize a PC-exported baseline. Rejections are coded and never echo payloads."""
    code = "invalidCollectionBaseline"
    if not isinstance(body, dict) or set(body) != STAGING_KEYS:
        fail(422, code, "기준선 요청이 올바르지 않습니다.")
    library_id = body["libraryId"]
    if not isinstance(library_id, str) or not LIBRARY_ID_PATTERN.fullmatch(library_id):
        fail(422, code, "라이브러리 ID가 올바르지 않습니다.")
    cursor = _int(body["personalEditCursor"], low=0, nullable=False, code=code)
    works = []
    for item in _staged_list(body, "works", MAX_WORKS):
        item = _exact(item, {"workId", "type", "legacyKind", "name", "fields", "showcase",
                             "showcaseOrder", "selection", "details", "derived", "createdAt",
                             "updatedAt"}, "works")
        fields = item["fields"]
        if not isinstance(fields, dict) or set(fields) != set(WORK_FIELDS):
            fail(422, code, "작품 필드가 올바르지 않습니다.", workId=item.get("workId"))
        selection = item["selection"]
        if not isinstance(selection, dict) or set(selection) != set(SLOTS):
            fail(422, code, "선택 이미지 형식이 올바르지 않습니다.")
        derived = item["derived"]
        if not isinstance(derived, dict) or set(derived) != {"unreadReleaseCount"}:
            fail(422, code, "파생 값 형식이 올바르지 않습니다.")
        if item["legacyKind"] is not None and item["legacyKind"] not in LEGACY_KINDS:
            fail(422, code, "작품 종류가 올바르지 않습니다.")
        works.append({
            "workId": require_id(item["workId"], code), "type": require_type(item["type"], code),
            "legacyKind": item["legacyKind"],
            "name": normalize_name(item["name"], limit=MAX_STAGED_NAME, code=code)
            if isinstance(item["name"], str) and item["name"] == item["name"].strip()
            else fail(422, code, "작품 이름이 올바르지 않습니다."),
            "fields": {field: normalize_field(field, fields[field], staged=True, code=code)
                       for field in WORK_FIELDS},
            "showcase": _bool(item["showcase"]) if type(item["showcase"]) is bool
            else fail(422, code, "Showcase 값이 올바르지 않습니다."),
            "showcaseOrder": _int(item["showcaseOrder"], code=code),
            "selection": {slot: require_id(selection[slot], code, nullable=True) for slot in SLOTS},
            "details": validate_details(item["details"], code),
            "derived": {"unreadReleaseCount": _int(derived["unreadReleaseCount"], low=0,
                                                   nullable=False, code=code)},
            "createdAt": _text(item["createdAt"], 100, nullable=False, code=code),
            "updatedAt": _text(item["updatedAt"], 100, nullable=False, code=code)})
    bindings = []
    for item in _staged_list(body, "bindings"):
        item = _exact(item, {"workId", "provider", "externalId", "config", "snapshot", "values",
                             "lastSyncedAt"}, "bindings")
        provider = item["provider"]
        if provider not in PROVIDERS or not valid_external_id(provider, item["externalId"]):
            fail(422, code, "작품 정보 연결이 올바르지 않습니다.", workId=item.get("workId"))
        bindings.append({"workId": require_id(item["workId"], code), "provider": provider,
                         "externalId": item["externalId"],
                         "config": json_object(item["config"], MAX_CONFIG_BYTES, code=code),
                         "snapshot": json_object(item["snapshot"], MAX_SNAPSHOT_BYTES, code=code),
                         "values": None if item["values"] is None
                         else normalize_provider_values(provider, item["values"]),
                         "lastSyncedAt": _text(item["lastSyncedAt"], 100, code=code)})
    artworks = []
    for item in _staged_list(body, "artworks"):
        item = _exact(item, {"artworkId", "workId", "kind", "provider", "providerImageId", "width",
                             "height", "language", "original", "thumbnail", "createdAt"}, "artworks")
        kind = item["kind"]
        if not isinstance(kind, str) or not 1 <= len(kind) <= 40:
            fail(422, code, "이미지 종류가 올바르지 않습니다.")
        artworks.append({"artworkId": require_id(item["artworkId"], code),
                         "workId": require_id(item["workId"], code), "kind": kind,
                         "provider": _text(item["provider"], 40, code=code),
                         "providerImageId": _text(item["providerImageId"], 512, code=code),
                         "width": _int(item["width"], low=1, high=1_000_000, code=code),
                         "height": _int(item["height"], low=1, high=1_000_000, code=code),
                         "language": _text(item["language"], 40, code=code),
                         "original": None if allow_missing_original and item["original"] is None
                         else blob_manifest(item["original"], code=code),
                         "thumbnail": None if item["thumbnail"] is None
                         else blob_manifest(item["thumbnail"], thumbnail=True, code=code),
                         "createdAt": _text(item["createdAt"], 100, nullable=False, code=code)})
    volumes = []
    for item in _staged_list(body, "volumes"):
        item = _exact(item, {"volumeId", "workId", "volumeNumber", "editionIndex", "sortOrder",
                             "displayLabel", "coverArtworkId", "sourceProvider", "sourceCoverId"},
                      "volumes")
        volumes.append({"volumeId": require_id(item["volumeId"], code),
                        "workId": require_id(item["workId"], code),
                        "volumeNumber": _int(item["volumeNumber"], nullable=False, code=code),
                        "editionIndex": _int(item["editionIndex"], low=0, high=255, nullable=False,
                                             code=code),
                        "sortOrder": _int(item["sortOrder"], nullable=False, code=code),
                        "displayLabel": _text(item["displayLabel"], 512, nullable=False, code=code),
                        "coverArtworkId": require_id(item["coverArtworkId"], code, nullable=True),
                        "sourceProvider": _text(item["sourceProvider"], 40, code=code),
                        "sourceCoverId": _text(item["sourceCoverId"], 512, code=code)})
    sources = []
    for item in _staged_list(body, "volumeSources"):
        item = _exact(item, {"workId", "volumeNumber", "provider", "providerItemId", "title",
                             "author", "publisher", "isbn13", "publicationDate", "itemUrl", "data"},
                      "volumeSources")
        if not isinstance(item["provider"], str) or not item["provider"].strip() \
                or not isinstance(item["providerItemId"], str) or not item["providerItemId"].strip():
            fail(422, code, "도서 정보가 올바르지 않습니다.")
        sources.append({"workId": require_id(item["workId"], code),
                        "volumeNumber": _int(item["volumeNumber"], low=1, high=999, nullable=False,
                                             code=code),
                        "provider": _text(item["provider"], 40, nullable=False, code=code),
                        "providerItemId": _text(item["providerItemId"], 200, nullable=False, code=code),
                        "title": _text(item["title"], 2000, nullable=False, code=code),
                        "author": _text(item["author"], 2000, code=code),
                        "publisher": _text(item["publisher"], 2000, code=code),
                        "isbn13": _text(item["isbn13"], 100, code=code),
                        "publicationDate": _text(item["publicationDate"], 100, code=code),
                        "itemUrl": _text(item["itemUrl"], 2000, code=code),
                        "data": json_object(item["data"], MAX_CONFIG_BYTES, nullable=False, code=code)})
    ownership = []
    for item in _staged_list(body, "ownership"):
        item = _exact(item, {"workId", "volumeNumber", "editionIndex", "physical", "digital"},
                      "ownership")
        if type(item["physical"]) is not bool or type(item["digital"]) is not bool:
            fail(422, code, "소장 정보가 올바르지 않습니다.")
        ownership.append({"workId": require_id(item["workId"], code),
                          "volumeNumber": _int(item["volumeNumber"], low=1, nullable=False, code=code),
                          "editionIndex": _int(item["editionIndex"], low=0, high=255, nullable=False,
                                               code=code),
                          "physical": item["physical"], "digital": item["digital"]})
    memberships = []
    for item in _staged_list(body, "memberships"):
        item = _exact(item, {"workId", "assetId", "addedAt"}, "memberships")
        memberships.append({"workId": require_id(item["workId"], code),
                            "assetId": require_id(item["assetId"], code),
                            "addedAt": _text(item["addedAt"], 100, nullable=False, code=code)})
    key = lambda item: encode(item)  # deterministic order independent of the export order
    return {"libraryId": library_id, "personalEditCursor": cursor,
            "works": sorted(works, key=lambda w: w["workId"]),
            "bindings": sorted(bindings, key=lambda b: (b["workId"], b["provider"])),
            "artworks": sorted(artworks, key=lambda a: a["artworkId"]),
            "volumes": sorted(volumes, key=lambda v: v["volumeId"]),
            "volumeSources": sorted(sources, key=lambda s: (s["workId"], s["volumeNumber"], s["provider"])),
            "ownership": sorted(ownership, key=lambda o: (o["workId"], o["volumeNumber"], o["editionIndex"])),
            "memberships": sorted(memberships, key=key)}


def _replica_value(model, value, section):
    """Validate without exposing Pydantic's errors (which contain input values)."""
    try:
        return model.model_validate(value, strict=True).model_dump()
    except (ValueError, TypeError, OverflowError):
        fail(422, "invalidCollectionBaseline", "Invalid replica value.", section=section)


def parse_staging(body, *, verify=False):
    """Accept the original exact v1 document, or the complete v2 publication contract.

    V2 artwork rows require the exact v1 keys plus ``order`` (nonnegative integer)
    and ``selected`` (boolean). Explicit flags must agree with work slots. The old
    exporter omits the back slot, which is inferred from its selected back artwork.
    V1 rejects both keys; its stored NULL selection retains the slot fallback.
    """
    import mobile_collections as mobile

    if not isinstance(body, dict) or "stagingVersion" not in body:
        if verify:
            fail(422, "invalidCollectionBaseline", "Verification requires staging version 2.")
        return _parse_staging_v1(body)
    code = "invalidCollectionBaseline"
    _exact(body, STAGING_V2_KEYS, "staging")
    if type(body["stagingVersion"]) is not int or body["stagingVersion"] != 2:
        fail(422, code, "Unsupported staging version.")
    extra = {"stagingVersion": 2,
             "legacyRevision": _text(body["legacyRevision"], 2000, nullable=False, code=code)}
    for key in ("bindingRequestSequence", "releaseReadCursor", "releaseGeneration"):
        extra[key] = _int(body[key], low=0, nullable=False, code=code)
    base = {key: body[key] for key in STAGING_KEYS}
    base["works"], base["artworks"], base["volumes"] = [], [], []
    work_extras, art_extras, volume_extras = {}, {}, {}
    work_keys = {"workId", "type", "legacyKind", "name", "fields", "showcase", "showcaseOrder",
                 "selection", "details", "derived", "createdAt", "updatedAt", "avCredits"}
    for work in _staged_list(body, "works", MAX_WORKS):
        _exact(work, work_keys, "works")
        work_id = require_id(work["workId"], code)
        fields = _exact(work["fields"], set(WORK_FIELDS) | {"status", "ownedPlatform"}, "fields")
        selection = work["selection"]
        if not isinstance(selection, dict):
            fail(422, code, "Invalid work selection.")
        _exact(selection, set(SLOTS) | {"spine"} | ({"back"} if "back" in selection else set()), "selection")
        details = _exact(work["details"], {"series", "film", "av"}, "details")
        derived = _exact(work["derived"], {"unreadReleaseCount", *TRACKING_FIELDS}, "derived")
        kind = require_type(work["type"], code)
        status = _text(fields["status"], 40, code=code)
        platform = _text(fields["ownedPlatform"], 200, code=code)
        if status is not None and status not in mobile.ITEM_STATUSES[kind]:
            fail(422, code, "Invalid work status.")
        if platform is not None and kind != "game":
            fail(422, code, "Owned platform requires a game.")
        av = details["av"]
        if av is not None:
            _exact(av, {"productCode", "titleJa", "maker", "label", "series", "genres", "releaseDate"}, "av")
            av = _replica_value(mobile.AvInfo, av, "av")
            del av["people"]
        credits = _staged_list(work, "avCredits", av_contract.MAX_CREDITS)
        if kind != "av" and (av is not None or credits):
            fail(422, code, "AV details and credits require an AV work.")
        if credits and av is None:
            fail(422, code, "AV credits require AV details.")
        parsed_credits = []
        for credit in credits:
            _exact(credit, {"personId", "name", "nameJa", "role", "order", "portraitCrop"}
                   | ({"creditName"} if "creditName" in credit else set()), "avCredits")
            person_id = require_id(credit["personId"], code)
            value = _replica_value(mobile.AvPerson,
                                   {"id": person_id, **{k: v for k, v in credit.items() if k != "personId"}},
                                   "avCredits")
            if "creditName" not in credit:
                value.pop("creditName")
            parsed_credits.append({"personId": person_id,
                                   **{k: v for k, v in value.items() if k not in ("id", "portraitImage")}})
        for key, model in (("releaseWatch", mobile.ReleaseWatch), ("releaseSchedule", mobile.ReleaseSchedule)):
            if derived[key] is not None:
                _replica_value(model, derived[key], key)
        if derived["ownedVolumes"] is not None:
            entries = _staged_list(derived, "ownedVolumes", 4)
            editions = [_replica_value(mobile.OwnedVolumes, entry, "ownedVolumes")["editionIndex"]
                        for entry in entries]
            if len(set(editions)) != len(editions):
                fail(422, code, "Duplicate owned-volume editions.")
        work_extras[work_id] = {"status": status, "ownedPlatform": platform,
                               "spine": require_id(selection["spine"], code, nullable=True),
                               **({"back": require_id(selection["back"], code, nullable=True)}
                                  if "back" in selection else {}),
                               "av": av, "avCredits": parsed_credits,
                               "tracking": {key: derived[key] for key in TRACKING_FIELDS}}
        base["works"].append({**{k: v for k, v in work.items() if k != "avCredits"},
                              "fields": {k: fields[k] for k in WORK_FIELDS},
                              "selection": {k: selection[k] for k in SLOTS},
                              "details": {k: details[k] for k in ("series", "film")},
                              "derived": {"unreadReleaseCount": derived["unreadReleaseCount"]}})
    for art in _staged_list(body, "artworks"):
        if not isinstance(art, dict) or not {"order", "selected"} <= set(art):
            fail(422, code, "Artwork order and selected are required.")
        if type(art["selected"]) is not bool:
            fail(422, code, "Artwork selected must be a boolean.")
        art_extras[require_id(art.get("artworkId"), code)] = {
            "order": _int(art["order"], low=0, nullable=False, code=code),
            "selected": art["selected"]}
        base["artworks"].append({k: v for k, v in art.items() if k not in ("order", "selected")})
    for volume in _staged_list(body, "volumes"):
        if not isinstance(volume, dict) or not {"coverFocusX", "published", "order"} <= set(volume):
            fail(422, code, "Published volume fields are required.")
        focus = volume["coverFocusX"]
        if focus is not None and (type(focus) not in (int, float) or not 0 <= focus <= 1):
            fail(422, code, "Invalid cover focus.")
        published = volume["published"]
        if published is not None:
            _exact(published, {"releaseStatus", "localReleaseDate", "isbn13"}, "published")
            for value in published.values():
                _text(value, 100, code=code)
        volume_extras[require_id(volume.get("volumeId"), code)] = {
            "coverFocusX": focus, "published": published,
            "order": _int(volume["order"], low=0, nullable=False, code=code)}
        base["volumes"].append({k: v for k, v in volume.items()
                                if k not in ("coverFocusX", "published", "order")})
    people = []
    for person in _staged_list(body, "people", mobile.MAX_PEOPLE):
        _exact(person, {"personId", "memo", "favorite", "profile", "portrait", "portraitImage"}, "people")
        person_id = require_id(person["personId"], code)
        value = _replica_value(mobile.Person, {"id": person_id, **{
            k: v for k, v in person.items() if k not in ("personId", "portraitImage")}}, "people")
        if len(encode(value).encode()) > mobile.MAX_PERSON_BYTES:
            fail(422, code, "Person is too large.")
        portrait = person["portraitImage"]
        if portrait is not None:
            portrait = _replica_value(mobile.AvPortraitImage, portrait, "portraitImage")
        people.append({"personId": person_id, **{k: v for k, v in value.items() if k != "id"},
                       "portraitImage": portrait})
    doc = _parse_staging_v1(base, allow_missing_original=verify)
    for work in doc["works"]:
        additions = work_extras[work["workId"]]
        work["fields"].update({k: additions[k] for k in ("status", "ownedPlatform")})
        work["selection"]["spine"] = additions["spine"]
        if "back" in additions:
            work["selection"]["back"] = additions["back"]
        work["details"]["av"] = additions["av"]
        work["derived"].update(additions["tracking"])
        work["avCredits"] = additions["avCredits"]
    for art in doc["artworks"]:
        art.update(art_extras[art["artworkId"]])
    selected_backs = {}
    for art in doc["artworks"]:
        if art["kind"] == "back" and art["selected"]:
            if art["workId"] in selected_backs:
                fail(422, code, "Multiple selected back artworks.")
            selected_backs[art["workId"]] = art["artworkId"]
    for work in doc["works"]:
        if "back" not in work["selection"]:
            work["selection"]["back"] = selected_backs.get(work["workId"])
    for volume in doc["volumes"]:
        volume.update(volume_extras[volume["volumeId"]])
    return {**doc, **extra, "people": sorted(people, key=lambda p: p["personId"])}


def staging_counts(doc):
    return {section: len(doc[section]) for section in (*SECTIONS, "people") if section in doc}


def _baseline_fail(message, **extra):
    fail(409, "collectionBaselineRejected", message, **extra)


def validate_staging(db, doc, *, verify=False, problems=None):
    """§5 step 2: the staged baseline must describe exactly the live legacy state."""
    # Offline diagnostics collect independent relation errors. Normal staging and
    # verify callers retain their fail-fast behavior and transaction boundaries.
    def reject(message, **extra):
        if problems is None:
            _baseline_fail(message, **extra)
        else:
            problems.append({"code": "collectionBaselineRejected", "message": message, **extra})
    library_id = doc["libraryId"]
    libraries = sorted({entry["libraryId"] for entry in authority.active_domains(db)})
    if libraries and libraries != [library_id]:
        fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH,
             "기존 서버 권위와 다른 라이브러리입니다.", libraryId=libraries[0])
    # Every mobile personal edit must already be drained into the exported state.
    state = db.execute("SELECT last_sequence FROM mobile_collection_edit_state WHERE singleton=1").fetchone()
    last = state[0] if state else 0
    if not verify and doc["personalEditCursor"] != last:
        reject("모바일 개인 편집을 모두 반영한 뒤 다시 준비해 주세요.",
                       reason="personalEditCursor", personalEditCursor=last)
    works = {work["workId"]: work for work in doc["works"]}
    if len(works) != len(doc["works"]):
        reject("작품 ID가 중복되었습니다.", reason="duplicateWork")
    live = {row[0]: row[1] for row in db.execute("SELECT id,type FROM mobile_collections")}
    staged = {work_id: work["type"] for work_id, work in works.items()
              if work["legacyKind"] != "gacha"}
    if not verify and staged != live:
        reject("게시된 컬렉션과 기준선의 작품 목록이 다릅니다.", reason="works",
                       missing=sorted(set(live) - set(staged))[:20],
                       unknown=sorted(set(staged) - set(live))[:20],
                       typeMismatch=sorted(i for i in set(live) & set(staged)
                                           if live[i] != staged[i])[:20],
                       liveCount=len(live), stagedCount=len(staged))
    names = {}
    for work in doc["works"]:
        key = (work["type"], nocase(work["name"]))
        if key in names:
            reject("같은 종류에 같은 이름의 작품이 있습니다.", reason="nameConflict",
                           workIds=[names[key], work["workId"]])
        names[key] = work["workId"]
    for work in doc["works"]:
        if not work["showcase"] and work["showcaseOrder"] is not None:
            reject("Showcase 순서가 올바르지 않습니다.", workId=work["workId"])
    artworks = {}
    work_artworks = {}
    confirmed = {row[0]: (row[1], row[2]) for row in db.execute(
        "SELECT sha256,size_bytes,content_type FROM mobile_collection_artwork")}
    for art in doc["artworks"]:
        if art["artworkId"] in artworks:
            reject("이미지 ID가 중복되었습니다.", artworkId=art["artworkId"])
        if art["workId"] not in works:
            reject("작품에 속하지 않은 이미지가 있습니다.", artworkId=art["artworkId"])
        for blob in (art["original"], art["thumbnail"]):
            if not verify and blob is not None and confirmed.get(blob["sha256"]) != (blob["sizeBytes"], blob["contentType"]):
                reject("업로드가 확인되지 않은 이미지가 있습니다.", reason="artworkBlob",
                               sha256=blob["sha256"])
        artworks[art["artworkId"]] = art["workId"]
        work_artworks.setdefault(art["workId"], []).append(art)
    per_work = {}
    for art in doc["artworks"]:
        per_work[art["workId"]] = per_work.get(art["workId"], 0) + 1
        if per_work[art["workId"]] > MAX_ARTWORKS_PER_WORK:
            reject("작품 이미지가 너무 많습니다.", workId=art["workId"])

    def owned(work_id, artwork_id):
        if artwork_id is not None and artworks.get(artwork_id) != work_id:
            reject("다른 작품의 이미지를 참조합니다.", reason="artworkOwnership",
                           workId=work_id, artworkId=artwork_id)

    for work in doc["works"]:
        for artwork_id in work["selection"].values():
            owned(work["workId"], artwork_id)
        for slot in SELECTION_KINDS:
            if slot not in work["selection"]:
                # An older persistent v2 staging row may predate back-slot inference.
                # Require restaging rather than activating a digest with disagreeing flags.
                if any(art.get("selected") and art["kind"] in selection_kinds(slot)
                       for art in work_artworks.get(work["workId"], [])):
                    reject("Selected artwork has no selection slot; restage the baseline.",
                                   reason="artworkSelection", workId=work["workId"])
                continue
            selected = work["selection"][slot]
            kinds = selection_kinds(slot)
            for art in work_artworks.get(work["workId"], []):
                if art["artworkId"] == selected and art["kind"] not in kinds:
                    reject("Artwork kind does not match its slot.", reason="artworkSelection",
                                   artworkId=art["artworkId"])
                if art["kind"] in kinds and "selected" in art and art["selected"] != (art["artworkId"] == selected):
                    reject("Artwork flags disagree with selection slots.", reason="artworkSelection",
                                   artworkId=art["artworkId"])
        for artwork_id in detail_artwork_references(work["details"]):
            owned(work["workId"], artwork_id)
    people = {person["personId"]: person for person in doc.get("people", [])}
    if len(people) != len(doc.get("people", [])):
        reject("Duplicate person IDs.", reason="duplicatePerson")
    for person in people.values():
        portrait = person["portraitImage"]
        if not verify and portrait is not None and confirmed.get(portrait["sha256"]) != (
                portrait["sizeBytes"], portrait["contentType"]):
            reject("Unconfirmed portrait image.", reason="portraitBlob")
    for work in doc["works"]:
        for credit in work.get("avCredits", []):
            if credit["personId"] not in people:
                reject("AV credit references a missing person.", reason="creditPerson")
            crop = credit["portraitCrop"]
            if crop is not None and works.get(artworks.get(crop["artworkId"]), {}).get("type") != "av":
                reject("Portrait crop must reference staged AV artwork.", reason="portraitCrop")
    if doc.get("stagingVersion") == 2:
        for section in ("artworks", "volumes"):
            orders = [(item["workId"], item["order"]) for item in doc[section]]
            if len(set(orders)) != len(orders):
                reject("Duplicate publication order.", reason="order", section=section)
        if not verify and not all(binding["ok"] for binding in verification_bindings(db, doc).values()):
            reject("Publication bindings have changed.", reason="bindings")
    identities, pairs = set(), set()
    for binding in doc["bindings"]:
        if binding["workId"] not in works:
            reject("작품에 속하지 않은 연결이 있습니다.", workId=binding["workId"])
            continue
        if PROVIDER_TYPES[binding["provider"]] != works[binding["workId"]]["type"]:
            reject("작품 종류와 맞지 않는 연결이 있습니다.", workId=binding["workId"])
        pair = (binding["workId"], binding["provider"])
        identity = (binding["provider"], binding["externalId"])
        if pair in pairs or identity in identities:
            reject("작품 정보 연결이 중복되었습니다.", reason="providerIdentityTaken",
                           provider=binding["provider"], externalId=binding["externalId"])
        pairs.add(pair)
        identities.add(identity)
        if (binding["snapshot"] is None) != (binding["values"] is None):
            reject("연결 스냅샷과 값이 함께 있어야 합니다.", workId=binding["workId"])
    slots, volume_counts = set(), {}
    for volume in doc["volumes"]:
        if volume["workId"] not in works:
            reject("작품에 속하지 않은 권이 있습니다.", volumeId=volume["volumeId"])
        slot = (volume["workId"], volume["volumeNumber"], volume["editionIndex"])
        if slot in slots:
            reject("같은 권과 판이 중복되었습니다.", volumeId=volume["volumeId"])
        slots.add(slot)
        volume_counts[volume["workId"]] = volume_counts.get(volume["workId"], 0) + 1
        if volume_counts[volume["workId"]] > MAX_VOLUMES_PER_WORK:
            reject("권이 너무 많습니다.", workId=volume["workId"])
        owned(volume["workId"], volume["coverArtworkId"])
    if len({volume["volumeId"] for volume in doc["volumes"]}) != len(doc["volumes"]):
        reject("권 ID가 중복되었습니다.")
    source_keys, source_items = set(), set()
    for source in doc["volumeSources"]:
        if source["workId"] not in works:
            reject("작품에 속하지 않은 도서 정보가 있습니다.")
        key = (source["workId"], source["volumeNumber"], source["provider"])
        item = (source["provider"], source["providerItemId"])
        if key in source_keys or item in source_items:
            reject("도서 정보가 중복되었습니다.", reason="providerIdentityTaken",
                           provider=source["provider"], externalId=source["providerItemId"])
        source_keys.add(key)
        source_items.add(item)
    owners = set()
    for entry in doc["ownership"]:
        if entry["workId"] not in works:
            reject("작품에 속하지 않은 소장 정보가 있습니다.")
        key = (entry["workId"], entry["volumeNumber"], entry["editionIndex"])
        if key in owners:
            reject("소장 정보가 중복되었습니다.")
        owners.add(key)
    members = set()
    asset_ids = set()
    for entry in doc["memberships"]:
        if entry["workId"] not in works:
            reject("작품에 속하지 않은 연결 자산이 있습니다.")
        key = (entry["workId"], entry["assetId"])
        if key in members:
            reject("작품 자산 연결이 중복되었습니다.")
        members.add(key)
        asset_ids.add(entry["assetId"])
    for work in doc["works"]:
        cover = work["fields"]["coverAssetId"]
        if cover is not None:
            asset_ids.add(cover)
    _validate_assets(db, sorted(asset_ids), reject=reject)


def _validate_assets(db, asset_ids, *, reject=_baseline_fail):
    """Memberships vs Assets: committed, and never tombstoned when Asset authority is active."""
    if not asset_ids:
        return
    known = set()
    for start in range(0, len(asset_ids), 500):
        chunk = asset_ids[start:start + 500]
        known.update(row[0] for row in db.execute(
            "SELECT id FROM assets WHERE committed=1 AND id IN (" + ",".join("?" for _ in chunk) + ")",
            chunk))
    missing = [asset_id for asset_id in asset_ids if asset_id not in known]
    if missing:
        reject("서버에 없는 자산이 연결되어 있습니다.", reason="membershipAssets",
                       assetIds=missing[:20], count=len(missing))
    active = authority.active_domain(db, asset_authority.DOMAIN)
    if active is None:
        return
    lifecycles = {}
    for start in range(0, len(asset_ids), 500):
        chunk = asset_ids[start:start + 500]
        lifecycles.update({row[0]: row[1] for row in db.execute(
            "SELECT asset_id,lifecycle FROM asset_authority_state WHERE library_id=? AND asset_id IN ("
            + ",".join("?" for _ in chunk) + ")", [active["libraryId"], *chunk])})
    bad = [asset_id for asset_id in asset_ids
           if lifecycles.get(asset_id) not in (asset_authority.NORMAL, asset_authority.TRASH)]
    if bad:
        reject("영구 삭제되었거나 권위에 없는 자산이 연결되어 있습니다.",
                       reason="membershipAssets", assetIds=bad[:20], count=len(bad))


def stage(db, doc, now):
    if authority.active_domain(db, DOMAIN) is not None:
        fail(409, "collectionAuthorityActive", "컬렉션 권위가 이미 활성화되어 있습니다.")
    validate_staging(db, doc)
    staged_digest = digest(doc)
    counts = staging_counts(doc)
    db.execute(
        "INSERT INTO collection_authority_staging(singleton,library_id,staged_digest,payload,counts,staged_at)"
        " VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET library_id=excluded.library_id,"
        " staged_digest=excluded.staged_digest,payload=excluded.payload,counts=excluded.counts,"
        " staged_at=excluded.staged_at",
        [doc["libraryId"], staged_digest, encode(doc), encode(counts), now])
    return {"libraryId": doc["libraryId"], "stagedDigest": staged_digest, "counts": counts,
            "stagedAt": now}


def staged_summary(db):
    row = db.execute("SELECT library_id,staged_digest,counts,staged_at FROM collection_authority_staging"
                     " WHERE singleton=1").fetchone()
    if row is None:
        return None
    return {"libraryId": row[0], "stagedDigest": row[1], "counts": json.loads(row[2]),
            "stagedAt": row[3]}


def verification_bindings(db, body):
    """Capture all drain barriers from the same SQLite read snapshot."""
    def staged_int(key):
        value = body.get(key)
        return value if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER else None

    legacy = db.execute("SELECT revision FROM mobile_collection_replica WHERE singleton=1").fetchone()
    revision = legacy[0] if legacy else None
    staged_revision = body.get("legacyRevision")
    if not isinstance(staged_revision, str) or len(staged_revision) > 2000:
        staged_revision = None
    edits = db.execute("SELECT last_sequence,applied_cursor FROM mobile_collection_edit_state"
                       " WHERE singleton=1").fetchone()
    last, applied = tuple(edits) if edits else (0, 0)
    binding = db.execute("SELECT sequence FROM collection_binding_state WHERE singleton=1").fetchone()
    sequence = binding[0] if binding else 0
    pending = db.execute("SELECT COUNT(*) FROM collection_binding_requests WHERE state='pending'").fetchone()[0]
    releases = db.execute("SELECT read_sequence,generation FROM collection_release_state WHERE singleton=1").fetchone()
    read_cursor, generation = (releases[0], releases[1] or 0) if releases else (0, 0)
    return {
        "legacyRevision": {"staged": staged_revision, "server": revision,
                           "ok": staged_revision is not None and staged_revision == revision},
        "personalEdits": {"staged": staged_int("personalEditCursor"), "last": last, "applied": applied,
                          "ok": staged_int("personalEditCursor") == last == applied},
        "bindRequests": {"pending": pending, "staged": staged_int("bindingRequestSequence"),
                         "server": sequence, "ok": pending == 0 and staged_int("bindingRequestSequence") == sequence},
        "releaseReads": {"staged": staged_int("releaseReadCursor"), "server": read_cursor,
                         "ok": staged_int("releaseReadCursor") == read_cursor},
        "releaseGeneration": {"staged": staged_int("releaseGeneration"), "server": generation,
                              "ok": staged_int("releaseGeneration") == generation},
    }


_ABSENT = object()


def _slot_derived_flags(item):
    """Read the published flags of slot kinds from the shown selection, as the PC exporter does.

    A manga's shown work cover can be a fallback volume cover whose stored flag was false; the
    staged baseline flags it from the slot. Both show the same image, so only the slot-derived
    flags are compared. Other kinds keep their published flag.
    """
    slots = {"cover": item.get("selectedWorkArtworkId"),
             "volume_cover": item.get("selectedWorkArtworkId"),
             "hero": item.get("selectedHeroArtworkId"),
             "backdrop": item.get("selectedBackdropArtworkId")}
    artworks = item.get("artworks")
    if not isinstance(artworks, list):
        return item
    item = dict(item)
    item["artworks"] = [
        {**art, "selected": art.get("id") == slots[art.get("kind")]}
        if isinstance(art, dict) and art.get("kind") in slots and "selected" in art else art
        for art in artworks]
    return item


def _value_diffs(live, projected, path=""):
    """Leaf differences, preserving array order and missing-versus-null semantics."""
    if isinstance(live, dict) and isinstance(projected, dict):
        for key in sorted(set(live) | set(projected)):
            yield from _value_diffs(live.get(key, _ABSENT), projected.get(key, _ABSENT),
                                    f"{path}.{key}" if path else key)
    elif isinstance(live, list) and isinstance(projected, list):
        for index in range(max(len(live), len(projected))):
            yield from _value_diffs(live[index] if index < len(live) else _ABSENT,
                                    projected[index] if index < len(projected) else _ABSENT,
                                    path + "[]")
    elif live != projected or (isinstance(live, bool) != isinstance(projected, bool)):
        yield path or "$", live, projected


def _sample_digest(value):
    # Tag absence rather than treating a missing key as an explicit JSON null.
    return digest(["missing"] if value is _ABSENT else ["value", value])[:16]


def _verification_artworks(db, doc):
    confirmed = {row[0]: (row[1], row[2]) for row in db.execute(
        "SELECT sha256,size_bytes,content_type FROM mobile_collection_artwork")}
    missing, unconfirmed, samples = 0, set(), []
    for art in doc["artworks"]:
        issue = art["original"] is None
        missing += int(issue)
        for blob in (art["original"], art["thumbnail"]):
            if blob is not None and confirmed.get(blob["sha256"]) != (blob["sizeBytes"], blob["contentType"]):
                unconfirmed.add(blob["sha256"])
                issue = True
        if issue and len(samples) < 20:
            samples.append(art["artworkId"])
    for person in doc["people"]:
        blob = person["portraitImage"]
        if blob is not None and confirmed.get(blob["sha256"]) != (blob["sizeBytes"], blob["contentType"]):
            unconfirmed.add(blob["sha256"])
            # Portraits have no artwork ID; include only artwork IDs in this list.
    return {"originalMissing": missing, "unconfirmedBlobs": len(unconfirmed), "samples": samples}


def _create_verification_tables(db):
    """Shadow typed authority tables with empty TEMP tables using the canonical DDL."""
    # Execute statements individually: executescript() would commit the caller's
    # read transaction and lose the snapshot shared by bindings and comparison.
    for statement in re.sub(r"--[^\n]*", "", DDL).split(";"):
        statement = statement.strip()
        table = re.match(r"CREATE TABLE IF NOT EXISTS (\w+)", statement)
        index = re.match(r"CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON (\w+)", statement)
        if table and table[1] in TYPED_TABLES:
            db.execute(statement.replace("CREATE TABLE", "CREATE TEMP TABLE", 1))
        elif index and index[2] in TYPED_TABLES:
            db.execute(statement.replace("IF NOT EXISTS ", "IF NOT EXISTS temp.", 1))


def _verification_authorizer(action, arg1, arg2, database, source):
    # query_only also blocks TEMP writes. Deny persistent DML instead, including
    # writes to sqlite_master used by persistent schema changes.
    if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE) and database != "temp":
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def verify_staging(db, body, now):
    """Project staging in TEMP tables inside the caller's read transaction.

    Unqualified authority queries resolve to TEMP; legacy rows, asset visibility,
    artwork receipts and drain barriers remain in main, all in the same read snapshot.
    Rollback removes the TEMP schema even on validation or projection failure.
    No activation handler, storage HEAD or publication receipt write is invoked.
    """
    import mobile_collections as mobile
    from pydantic import ValidationError

    db.set_authorizer(_verification_authorizer)
    try:
        report = {"version": 1, "verdict": "blocked", "checkedAt": now,
                  "bindings": verification_bindings(db, body), "validation": None,
                  "counts": {key: {"staged": len(body[key])} for key in (*SECTIONS, "people")
                             if isinstance(body.get(key), list)},
                  "works": {"live": 0, "staged": 0, "matched": 0, "missing": [], "unknown": [], "typeMismatch": []},
                  "diffs": {"total": 0, "byPath": {}, "samples": []},
                  "people": {"live": 0, "staged": 0, "diffs": 0, "samples": []},
                  "artworks": {"originalMissing": 0, "unconfirmedBlobs": 0, "samples": []}}
        live = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM mobile_collections")}
        live_people = {row[0] for row in db.execute("SELECT id FROM mobile_collection_people")}
        report["works"]["live"] = len(live)
        report["people"]["live"] = len(live_people)
        try:
            doc = parse_staging(body, verify=True)
            staged = {work["workId"]: work for work in doc["works"] if work["legacyKind"] != "gacha"}
            common = set(live) & set(staged)
            mismatched = sorted(key for key in common if live[key]["type"] != staged[key]["type"])
            missing, unknown = sorted(set(live) - set(staged)), sorted(set(staged) - set(live))
            report["works"].update(staged=len(staged), matched=len(common) - len(mismatched),
                                   missing=missing[:20], unknown=unknown[:20], typeMismatch=mismatched[:20])
            staged_people = {person["personId"] for person in doc["people"]}
            report["people"]["staged"] = len(staged_people)
            report["artworks"] = _verification_artworks(db, doc)
            validate_staging(db, doc, verify=True)
            _create_verification_tables(db)
            insert_staging(db, doc, now)
            library_id = doc["libraryId"]
            diffs = report["diffs"]
            # Use the exact public transforms used by /v1/collections. Derived
            # asset counts/covers and release dates are intentionally not masked.
            for work_id in sorted(common):
                payload = build_payload(db, library_id, work_row(db, library_id, work_id))
                for view in ("list", "detail"):
                    projected = json.loads(encode(payload))
                    finalize_items(db, library_id, [projected], detail=view == "detail")
                    left = _slot_derived_flags(mobile.public_item(live[work_id], detail=view == "detail"))
                    right = mobile.public_item(projected, detail=view == "detail")
                    for path, before, after in _value_diffs(left, right):
                        diffs["total"] += 1
                        diffs["byPath"][path] = diffs["byPath"].get(path, 0) + 1
                        if len(diffs["samples"]) < 20:
                            diffs["samples"].append({"workId": work_id, "view": view, "path": path,
                                                     "liveDigest": _sample_digest(before),
                                                     "projectedDigest": _sample_digest(after)})
            for person_id in sorted(live_people | staged_people):
                left = mobile.public_person(db, person_id)
                right = mobile.public_person(db, person_id, library_id)
                for path, before, after in _value_diffs(left, right):
                    report["people"]["diffs"] += 1
                    if len(report["people"]["samples"]) < 20:
                        report["people"]["samples"].append({"personId": person_id, "path": path,
                                                            "liveDigest": _sample_digest(before),
                                                            "projectedDigest": _sample_digest(after)})
        except HTTPException as error:
            detail = error.detail if isinstance(error.detail, dict) else {}
            report["validation"] = {"code": detail.get("code", "invalidCollectionBaseline"),
                                    "message": detail.get("message", "Invalid staging document."),
                                    "detail": {k: detail[k] for k in ("reason", "section") if k in detail}}
        except (ValidationError, sqlite3.IntegrityError):
            report["validation"] = {"code": "invalidCollectionBaseline",
                                    "message": "The staged projection is invalid.", "detail": {}}
        if report["validation"] is None and all(value["ok"] for value in report["bindings"].values()):
            changed = (report["diffs"]["total"] or report["people"]["diffs"]
                       or report["works"]["missing"] or report["works"]["unknown"]
                       or report["works"]["typeMismatch"] or report["artworks"]["originalMissing"]
                       or report["artworks"]["unconfirmedBlobs"])
            report["verdict"] = "differences" if changed else "lossless"
        return report
    finally:
        db.rollback()
        db.set_authorizer(None)


def insert_staging(db, doc, now):
    """Insert validated rows for activation or connection-local verification tables."""
    library_id = doc["libraryId"]
    for work in doc["works"]:
        write_work(db, library_id, {**work, "lifecycle": "live", "trashedAt": None,
                                    "entityRevision": 1}, insert=True)
    for binding in doc["bindings"]:
        db.execute(
            "INSERT INTO collection_authority_bindings(library_id,work_id,provider,external_id,config,"
            "snapshot,snapshot_values,snapshot_digest,snapshot_external_id,last_synced_at,bound,"
            "entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,1,?,?)",
            [library_id, binding["workId"], binding["provider"], binding["externalId"],
             None if binding["config"] is None else encode(binding["config"]),
             None if binding["snapshot"] is None else encode(binding["snapshot"]),
             None if binding["values"] is None else encode(binding["values"]),
             None if binding["snapshot"] is None else digest(binding["snapshot"]),
             None if binding["snapshot"] is None else binding["externalId"],
             binding["lastSyncedAt"], now, now])
    db.executemany(
        "INSERT INTO collection_authority_artworks(library_id,artwork_id,work_id,kind,provider,"
        "provider_image_id,width,height,language,original,thumbnail,entity_revision,created_at,published_order,selected)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
        [[library_id, art["artworkId"], art["workId"], art["kind"], art["provider"],
          art["providerImageId"], art["width"], art["height"], art["language"],
          encode(art["original"]), None if art["thumbnail"] is None else encode(art["thumbnail"]),
          art["createdAt"], art.get("order"), art.get("selected")] for art in doc["artworks"]])
    db.executemany(
        "INSERT INTO collection_authority_volumes(library_id,volume_id,work_id,volume_number,"
        "edition_index,sort_order,display_label,cover_artwork_id,source_provider,source_cover_id,"
        "deleted,entity_revision,created_at,updated_at,cover_focus_x,published,published_order)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,0,1,?,?,?,?,?)",
        [[library_id, v["volumeId"], v["workId"], v["volumeNumber"], v["editionIndex"],
          v["sortOrder"], v["displayLabel"], v["coverArtworkId"], v["sourceProvider"],
          v["sourceCoverId"], now, now, v.get("coverFocusX"),
          None if v.get("published") is None else encode(v["published"]),
          v.get("order")] for v in doc["volumes"]])
    db.executemany(
        "INSERT INTO collection_authority_volume_sources(library_id,work_id,volume_number,provider,"
        "provider_item_id,title,author,publisher,isbn13,publication_date,item_url,data,deleted,"
        "entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,1,?,?)",
        [[library_id, s["workId"], s["volumeNumber"], s["provider"], s["providerItemId"],
          s["title"], s["author"], s["publisher"], s["isbn13"], s["publicationDate"],
          s["itemUrl"], encode(s["data"]), now, now] for s in doc["volumeSources"]])
    db.executemany(
        "INSERT INTO collection_authority_ownership(library_id,work_id,volume_number,edition_index,"
        "physical,digital,entity_revision,updated_at) VALUES(?,?,?,?,?,?,1,?)",
        [[library_id, o["workId"], o["volumeNumber"], o["editionIndex"], int(o["physical"]),
          int(o["digital"]), now] for o in doc["ownership"]])
    db.executemany(
        "INSERT INTO collection_authority_members(library_id,work_id,asset_id,desired_state,"
        "entity_revision,added_at,updated_at) VALUES(?,?,?,1,1,?,?)",
        [[library_id, m["workId"], m["assetId"], m["addedAt"], now] for m in doc["memberships"]])
    db.executemany(
        "INSERT INTO collection_authority_people(library_id,person_id,payload,portrait_image) VALUES(?,?,?,?)",
        [[library_id, person["personId"], encode({"id": person["personId"], **{
            k: v for k, v in person.items() if k not in ("personId", "portraitImage")}}),
          None if person["portraitImage"] is None else encode(person["portraitImage"])]
         for person in doc.get("people", [])])


def activate(db, *, library_id, expected_digest, now):
    """Create epoch 1 from the staged baseline, fence the legacy writers, all at once.

    The caller owns ``BEGIN IMMEDIATE``. Inserting the ``authority_domains`` row *is* the
    fence: the legacy replica PUT calls ``authority.fence_legacy_write`` in its own
    transaction and the personal-edit POST switches to the ``updateWork`` shim. The staged
    document is re-validated against the live legacy rows inside this transaction, so an
    edit or publication that landed after staging refuses activation instead of being lost.
    """
    existing = authority.active_domain(db, DOMAIN)
    if existing is not None:
        if existing["libraryId"] == library_id and existing["baselineDigest"] == expected_digest:
            return {"domain": DOMAIN, "libraryId": library_id, "epoch": existing["epoch"],
                    "contractVersion": existing["contractVersion"], "cursor": existing["cursor"],
                    "baselineDigest": existing["baselineDigest"],
                    "activatedAt": existing["activatedAt"]}
        fail(409, "collectionAuthorityActive", "컬렉션 권위가 이미 활성화되어 있습니다.")
    for table in TYPED_TABLES:
        if db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None:
            fail(409, "collectionAuthorityStateExists",
                 "활성화되지 않은 컬렉션 권위 상태가 이미 존재합니다.")
    stored = db.execute("SELECT library_id,staged_digest,payload FROM collection_authority_staging"
                        " WHERE singleton=1").fetchone()
    if stored is None or stored[0] != library_id:
        fail(409, "collectionBaselineMissing", "활성화할 컬렉션 기준선이 없습니다.")
    if stored[1] != expected_digest:
        fail(409, "collectionBaselineChanged", "컬렉션 기준선이 변경되었습니다. 다시 준비해 주세요.",
             stagedDigest=stored[1])
    doc = json.loads(stored[2])
    if digest(doc) != expected_digest:
        fail(409, "collectionBaselineChanged", "컬렉션 기준선이 변경되었습니다. 다시 준비해 주세요.")
    validate_staging(db, doc)
    insert_staging(db, doc, now)
    legacy = db.execute("SELECT revision FROM mobile_collection_replica WHERE singleton=1").fetchone()
    db.execute(
        "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
        "baseline_digest,baseline_revision,activated_at) VALUES(?,?,1,?,0,?,?,?)",
        [library_id, DOMAIN, CONTRACT_VERSION, expected_digest, legacy[0] if legacy else None, now])
    db.execute("INSERT INTO collection_authority_retention(library_id,epoch,pruned_through,pruned_at)"
               " VALUES(?,1,0,NULL)", [library_id])
    for work in doc["works"]:
        refresh_projection(db, library_id, work["workId"])
    db.execute("DELETE FROM collection_authority_staging WHERE singleton=1")
    return {"domain": DOMAIN, "libraryId": library_id, "epoch": 1,
            "contractVersion": CONTRACT_VERSION, "cursor": 0, "baselineDigest": expected_digest,
            "activatedAt": now, "counts": staging_counts(doc)}


# ---------------------------------------------------------------------------
# Personal-edit compatibility shim (installed APKs keep working after activation)
# ---------------------------------------------------------------------------

SHIM_FIELDS = {"myScore": "myScore", "showcase": "showcase", "memo": "description",
               "status": "status", "ownedPlatform": "ownedPlatform"}


def personal_edit(db, row, command, value, expected, now):
    """Translate one legacy personal edit into a revisioned authority command.

    Response and error codes stay exactly what the shipped APK understands:
    ``collectionPersonalConflict`` with ``current``, ``collectionNotFound`` (the intent is
    dropped), ``operationConflict`` and ``libraryMismatch``. The receipt lives in the
    authority receipts, so a response-lost retry replays the same result.
    """
    if command.libraryId != row["libraryId"]:
        fail(409, "libraryMismatch", "다른 라이브러리의 컬렉션 편집 요청입니다.")
    field = command.field
    if field == "ownedVolumes":
        command_type = TRACK_OWNERSHIP
        entity = {"workId": command.collectionId, **value, "expectedCount": expected["count"],
                  "expectedRevision": None}
    elif field == "releaseWatch":
        command_type = RELEASE_SUBSCRIPTION
        entity = {"workId": command.collectionId, "enabled": value, "expectedEnabled": expected,
                  "expectedRevision": None}
    else:
        command_type = UPDATE
        field = SHIM_FIELDS[field]
        entity = {"workId": command.collectionId, "changes": {field: value},
                  "expected": {field: expected}, "expectedRevision": None}
    try:
        result = apply_command(db, library_id=row["libraryId"], epoch=row["epoch"],
                               contract_version=CONTRACT_VERSION, command_type=command_type,
                               operation_id=command.operationId, entity=entity, now=now)
    except HTTPException as error:
        code = error.detail.get("code") if isinstance(error.detail, dict) else None
        if code == "revisionConflict":
            current = error.detail["current"]["work"]
            if field == "ownedVolumes":
                present = {"editionIndex": value["editionIndex"],
                           "count": _owned_count(current, value["editionIndex"])}
            elif field == "releaseWatch":
                present = bool((current["derived"].get("releaseWatch") or {}).get("enabled"))
            else:
                present = current["showcase"] if field == "showcase" else current["fields"].get(field)
            fail(409, "collectionPersonalConflict", "다른 기기에서 값이 바뀌었습니다.",
                 current=comparable(field, present))
        if code in ("workNotFound", "workDeleted", "workTrashed"):
            fail(404, "collectionNotFound", "삭제되었거나 게시되지 않은 작품입니다.")
        if code == "invalidCollectionCommand":
            fail(422, "invalidCollectionPersonalEdit", "Invalid personal edit.")
        raise
    return {"version": 1, "operationId": command.operationId, "collectionId": command.collectionId,
            "field": command.field, "value": value, "sequence": result["changeSequence"],
            "revision": projection_revision(row["libraryId"], row["epoch"], result["authorityCursor"]),
            "changed": result["changed"]}


# ---------------------------------------------------------------------------
# Feeds
# ---------------------------------------------------------------------------

def pruned_through(db, library_id, epoch):
    row = db.execute("SELECT pruned_through FROM collection_authority_retention WHERE library_id=?"
                     " AND epoch=?", [library_id, epoch]).fetchone()
    return row[0] if row else 0


SECTION_QUERIES = {
    # section: (table, key columns, projection, extra WHERE)
    WORKS_SECTION: ("collection_authority_works", ("work_id",), work_state,
                    "lifecycle<>'tombstoned'"),
    BINDINGS_SECTION: ("collection_authority_bindings", ("work_id", "provider"),
                       binding_projection, "1=1"),
    ARTWORKS_SECTION: ("collection_authority_artworks", ("artwork_id",), artwork_projection, "1=1"),
    VOLUMES_SECTION: ("collection_authority_volumes", ("volume_id",), volume_projection, "1=1"),
    SOURCES_SECTION: ("collection_authority_volume_sources",
                      ("work_id", "volume_number", "provider"), source_projection, "1=1"),
    OWNERSHIP_SECTION: ("collection_authority_ownership",
                        ("work_id", "volume_number", "edition_index"), ownership_projection, "1=1"),
    MEMBERSHIPS_SECTION: ("collection_authority_members", ("work_id", "asset_id"),
                          lambda r: membership_projection(r["work_id"], r["asset_id"],
                                                          r["desired_state"], r["entity_revision"],
                                                          r["added_at"]), "1=1"),
}


def section_count(db, library_id, section):
    table, _, _, where = SECTION_QUERIES[section]
    return db.execute(f"SELECT COUNT(*) FROM {table} WHERE library_id=? AND {where}",
                      [library_id]).fetchone()[0]


def section_page(db, library_id, section, after, limit):
    """One deterministic page ordered by the section key; ``after`` is the last key."""
    table, columns, project, where = SECTION_QUERIES[section]
    params = [library_id]
    clause = ""
    if after is not None:
        clause = f" AND ({','.join(columns)}) > ({','.join('?' for _ in columns)})"
        params.extend(after)
    rows = db.execute(f"SELECT * FROM {table} WHERE library_id=? AND {where}{clause}"
                      f" ORDER BY {','.join(columns)} LIMIT ?", [*params, limit + 1]).fetchall()
    items, keys, size = [], [], 0
    for row in rows[:limit]:
        item = project(row)
        if section == WORKS_SECTION:
            item = av_work_entity(db, library_id, item)
        encoded = len(encode(item).encode())
        if items and size + encoded > MAX_PAGE_BYTES:
            break
        items.append(item)
        keys.append([row[column] for column in columns])
        size += encoded
    has_more = len(items) < len(rows)
    return items, (keys[-1] if has_more and keys else None), has_more


def parse_after(section, value):
    if value is None:
        return None
    try:
        after = json.loads(value)
    except ValueError:
        after = None
    columns = SECTION_QUERIES[section][1]
    if not isinstance(after, list) or len(after) != len(columns) \
            or not all(isinstance(part, (str, int)) and not isinstance(part, bool) for part in after):
        fail(422, "invalidCollectionBaseline", "기준선 after 커서가 올바르지 않습니다.")
    return after


def change_items(db, library_id, epoch, after, limit, ceiling):
    items, size = [], 0
    for row in db.execute(
            "SELECT sequence,command_type,operation_id,payload,changed_at FROM collection_authority_changes"
            " WHERE library_id=? AND epoch=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
            [library_id, epoch, after, ceiling, limit]):
        item = {"sequence": row[0], "authorityCursor": row[0], "commandType": row[1],
                "operationId": row[2], "changedAt": row[4], **json.loads(row[3])}
        encoded = len(row[3].encode()) + 256
        if items and size + encoded > MAX_PAGE_BYTES:
            break
        items.append(item)
        size += encoded
    return items


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _parse_json(data, code):
    try:
        return json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        fail(422, code, "요청을 읽을 수 없습니다.")


async def _read_body(request, limit, code):
    """Bounded body read; parsing runs in the threadpool, never on the event loop."""
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            fail(413, code, "요청이 너무 큽니다.")
        data.extend(chunk)
    return await run_in_threadpool(_parse_json, bytes(data), code)


def _is_publisher(require_publisher, authorization):
    try:
        require_publisher(authorization)
    except HTTPException:
        return False
    return True


def register(app, get_db, require_client, require_publisher):
    """Register the Collections authority routes. Startup is the caller's (tables only)."""

    def transaction(fn, write=True):
        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                try:
                    result = fn(db)
                    if write:
                        db.commit()
                    else:
                        db.rollback()
                    return result
                except BaseException:
                    db.rollback()
                    raise
        return run_in_threadpool(run)

    @app.get(PREFIX + "/status")
    async def collection_authority_status(authorization: str | None = Header(default=None)):
        require_client(authorization)

        def read(db):
            row = authority.active_domain(db, DOMAIN)
            if row is None:
                return {"active": False, "domain": DOMAIN, "features": ["personProfileFields", "kakaoReview"]}
            return {"active": True, "domain": DOMAIN, "features": ["personProfileFields", "kakaoReview"], "libraryId": row["libraryId"],
                    "epoch": row["epoch"], "contractVersion": row["contractVersion"],
                    "cursor": row["cursor"], "activatedAt": row["activatedAt"],
                    "revision": projection_revision(row["libraryId"], row["epoch"], row["cursor"]),
                    "trashRetentionDays": TRASH_RETENTION_DAYS,
                    "retentionDays": RETENTION_DAYS}
        return await transaction(read, write=False)

    @app.get(PREFIX + "/baseline")
    async def collection_authority_baseline(request: Request, libraryId: str, epoch: int,
                                            authorization: str | None = Header(default=None)):
        require_client(authorization)
        params = dict(request.query_params)
        if set(params) - {"libraryId", "epoch", "snapshot", "section", "after", "limit"}:
            fail(422, "invalidCollectionBaseline", "기준선 요청이 올바르지 않습니다.")
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            fail(422, "invalidCollectionBaseline", "기준선 요청이 올바르지 않습니다.")
        snapshot, section = params.get("snapshot"), params.get("section")
        if snapshot is None:
            if section is not None or "after" in params or "limit" in params:
                fail(422, "invalidCollectionBaseline", "첫 기준선 요청에는 manifest만 받을 수 있습니다.")
        else:
            try:
                snapshot = int(snapshot)
            except ValueError:
                fail(422, "invalidCollectionBaseline", "기준선 snapshot 커서가 올바르지 않습니다.")
            if snapshot < 0 or section not in SECTIONS:
                fail(422, "invalidCollectionBaseline", "기준선 section이 올바르지 않습니다.")
        limit = DEFAULT_PAGE
        if params.get("limit") is not None:
            try:
                limit = int(params["limit"])
            except ValueError:
                fail(422, "invalidCollectionBaseline", "기준선 limit이 올바르지 않습니다.")
            if not 1 <= limit <= MAX_PAGE:
                fail(422, "invalidCollectionBaseline", "기준선 limit이 올바르지 않습니다.")
        after = parse_after(section, params.get("after")) if snapshot is not None else None

        def read(db):
            row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
            if row["epoch"] != epoch:
                fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH, "epoch가 일치하지 않습니다.")
            envelope = {"libraryId": row["libraryId"], "epoch": row["epoch"],
                        "contractVersion": row["contractVersion"]}
            if snapshot is None:
                # Manifest: frozen cursor plus the per-section counts a client verifies
                # before adopting the staged pages as complete.
                return {**envelope, "snapshotCursor": row["cursor"],
                        "sections": [{"section": name, "count": section_count(db, libraryId, name)}
                                     for name in SECTIONS]}
            if snapshot != row["cursor"]:
                fail(409, "baselineChanged",
                     "기준선을 읽는 동안 컬렉션이 변경되었습니다. 다시 시작해 주세요.",
                     snapshotCursor=snapshot, authorityCursor=row["cursor"])
            items, next_after, has_more = section_page(db, libraryId, section, after, limit)
            index = SECTIONS.index(section)
            return {**envelope, "snapshotCursor": snapshot, "section": section, "items": items,
                    "nextAfter": None if next_after is None else encode(next_after),
                    "hasMore": has_more,
                    "nextSection": None if has_more or index + 1 == len(SECTIONS)
                    else SECTIONS[index + 1],
                    "complete": not has_more and index + 1 == len(SECTIONS)}
        return await transaction(read, write=False)

    @app.get(PREFIX + "/changes")
    async def collection_authority_changes(request: Request, libraryId: str, epoch: int,
                                           after: int = 0, limit: int = DEFAULT_CHANGE_PAGE,
                                           authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch", "after", "limit"}:
            fail(422, "invalidCollectionChanges", "변경 요청이 올바르지 않습니다.")
        if not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1 or after < 0 \
                or not 1 <= limit <= MAX_CHANGE_PAGE:
            fail(422, "invalidCollectionChanges", "변경 요청이 올바르지 않습니다.")

        def read(db):
            row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
            if row["epoch"] != epoch:
                fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH, "epoch가 일치하지 않습니다.")
            cursor = row["cursor"]
            if after > cursor:
                fail(409, "cursorAhead", "변경 커서가 권위 커서보다 앞서 있습니다.")
            if after < pruned_through(db, libraryId, epoch):
                raise HTTPException(409, detail={"code": authority.CODE_CURSOR_EXPIRED,
                                                 "authorityCursor": cursor,
                                                 "retentionDays": RETENTION_DAYS})
            items = change_items(db, libraryId, epoch, after, limit, cursor)
            next_after = items[-1]["sequence"] if items else after
            return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                    "contractVersion": row["contractVersion"], "cursor": cursor,
                    "items": items, "nextAfter": next_after, "hasMore": next_after < cursor}
        return await transaction(read, write=False)

    @app.get(PREFIX + "/trash")
    async def collection_authority_trash(request: Request, libraryId: str, epoch: int,
                                         authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"libraryId", "epoch"} \
                or not LIBRARY_ID_PATTERN.fullmatch(libraryId) or epoch < 1:
            fail(422, "invalidCollectionTrash", "휴지통 요청이 올바르지 않습니다.")

        def read(db):
            row = authority.require_active(db, DOMAIN, libraryId, CONTRACT_VERSION)
            if row["epoch"] != epoch:
                fail(409, authority.CODE_AUTHORITY_LIBRARY_MISMATCH, "epoch가 일치하지 않습니다.")
            items, has_more = trash_items(db, libraryId)
            return {"libraryId": row["libraryId"], "epoch": row["epoch"],
                    "contractVersion": row["contractVersion"],
                    "retentionDays": TRASH_RETENTION_DAYS, "items": items, "hasMore": has_more}
        return await transaction(read, write=False)

    @app.put(PREFIX + "/commands")
    async def collection_authority_command(request: Request,
                                           authorization: str | None = Header(default=None)):
        # Authenticate and decide the caller's role *before* reading the body, so the
        # body limit follows the role: an ordinary client can never make the server
        # buffer a publisher-sized provider snapshot.
        require_client(authorization)
        publisher = _is_publisher(require_publisher, authorization)
        limit = MAX_COMMAND_BYTES_PUBLISHER if publisher else MAX_COMMAND_BYTES_CLIENT
        body = await _read_body(request, limit, "invalidCollectionCommand")
        declared = body.get("commandType") if isinstance(body, dict) else None
        if declared not in CLIENT_COMMAND_TYPES and not publisher:
            raise HTTPException(401, "Unauthorized")
        library_id, epoch, contract_version, operation_id, command_type, entity = parse_command(body)
        now = now_iso()
        if command_type == PERSON_PROFILE:
            import av_stashdb
            return await run_in_threadpool(av_stashdb.apply_profile_command, get_db,
                library_id=library_id, epoch=epoch, contract_version=contract_version,
                operation_id=operation_id, command_type=command_type, entity=entity, now=now)
        return await transaction(lambda db: apply_command(
            db, library_id=library_id, epoch=epoch, contract_version=contract_version,
            command_type=command_type, operation_id=operation_id, entity=entity, now=now))

    @app.put(PREFIX + "/staging")
    async def collection_authority_stage(request: Request,
                                         authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await _read_body(request, MAX_STAGING_BYTES, "invalidCollectionBaseline")
        doc = await run_in_threadpool(parse_staging, body)
        now = now_iso()
        return await transaction(lambda db: stage(db, doc, now))

    @app.post(PREFIX + "/staging/verify")
    async def collection_authority_verify(request: Request,
                                          authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await _read_body(request, MAX_STAGING_BYTES, "invalidCollectionBaseline")
        if not isinstance(body, dict):
            fail(422, "invalidCollectionBaseline", "Expected a JSON object.")

        def verify(db):
            return verify_staging(db, body, now_iso())
        return await transaction(verify, write=False)

    @app.get(PREFIX + "/staging")
    async def collection_authority_staged(authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        return await transaction(lambda db: {"staged": staged_summary(db)}, write=False)

    @app.delete(PREFIX + "/staging")
    async def collection_authority_discard(authorization: str | None = Header(default=None)):
        require_publisher(authorization)

        def discard(db):
            if authority.active_domain(db, DOMAIN) is not None:
                fail(409, "collectionAuthorityActive", "컬렉션 권위가 이미 활성화되어 있습니다.")
            removed = db.execute("DELETE FROM collection_authority_staging").rowcount
            return {"discarded": bool(removed)}
        return await transaction(discard)

    @app.post(PREFIX + "/activate")
    async def collection_authority_activate(request: Request,
                                            authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await _read_body(request, MAX_ACTIVATION_BYTES, "invalidCollectionBaseline")
        if not isinstance(body, dict) or set(body) != {"libraryId", "expectedStagedDigest"} \
                or not isinstance(body["libraryId"], str) \
                or not LIBRARY_ID_PATTERN.fullmatch(body["libraryId"]) \
                or not isinstance(body["expectedStagedDigest"], str) \
                or not HEX_DIGEST_PATTERN.fullmatch(body["expectedStagedDigest"]):
            fail(422, "invalidCollectionBaseline", "활성화 요청이 올바르지 않습니다.")
        now = now_iso()
        return await transaction(lambda db: activate(
            db, library_id=body["libraryId"], expected_digest=body["expectedStagedDigest"], now=now))


def purge_expired(get_db, now=None, operation_id=None):
    """Maintenance entry for the 30-day trash sweep (same path as ``purgeExpiredTrash``).

    Returns None while the domain is inactive. The caller supplies the schedule; nothing
    in this batch schedules it.
    """
    import uuid

    now = now or now_iso()
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            row = authority.active_domain(db, DOMAIN)
            if row is None:
                db.rollback()
                return None
            result = apply_command(db, library_id=row["libraryId"], epoch=row["epoch"],
                                   contract_version=CONTRACT_VERSION, command_type=PURGE_EXPIRED,
                                   operation_id=operation_id or str(uuid.uuid4()), entity={},
                                   now=now)
            db.commit()
            return result
        except BaseException:
            db.rollback()
            raise


def prune(get_db, days=RETENTION_DAYS, receipt_days=RECEIPT_RETENTION_DAYS, now=None):
    """Drop change/receipt history older than the window. Entity state is never pruned."""
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    change_cutoff = now_iso(moment - datetime.timedelta(days=days))
    receipt_cutoff = now_iso(moment - datetime.timedelta(days=receipt_days))
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            floored = db.execute(
                "SELECT library_id,epoch,MAX(sequence) FROM collection_authority_changes"
                " WHERE changed_at < ? GROUP BY library_id,epoch", [change_cutoff]).fetchall()
            removed = db.execute("DELETE FROM collection_authority_changes WHERE changed_at < ?",
                                 [change_cutoff]).rowcount
            receipts = db.execute("DELETE FROM collection_authority_receipts WHERE accepted_at < ?",
                                  [receipt_cutoff]).rowcount
            for library_id, epoch, highest in floored:
                db.execute(
                    "INSERT INTO collection_authority_retention(library_id,epoch,pruned_through,pruned_at)"
                    " VALUES(?,?,?,?) ON CONFLICT(library_id,epoch) DO UPDATE SET"
                    " pruned_through=MAX(pruned_through,excluded.pruned_through),"
                    " pruned_at=excluded.pruned_at", [library_id, epoch, highest, now_iso(moment)])
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return {"changes": removed, "receipts": receipts}
