-- Dormant Collections replica. No legacy Collection row is changed by migration.
CREATE TABLE collection_authority_sync (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=1),
 contract_version INTEGER NOT NULL CHECK(contract_version=1),
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),
 adopted INTEGER NOT NULL DEFAULT 0 CHECK(adopted IN (0,1)), adopted_at TEXT,
 snapshot_cursor INTEGER, baseline_section INTEGER NOT NULL DEFAULT 0,
 baseline_after TEXT, baseline_count INTEGER NOT NULL DEFAULT 0,
 manifest TEXT, generation TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Section + JSON tuple key preserves each independent server revision lineage.
-- Payload retains fields which the legacy PC schema cannot represent yet.
CREATE TABLE collection_authority_revisions (
 section TEXT NOT NULL CHECK(section IN ('works','bindings','artworks','volumes','volumeSources','ownership','memberships')),
 entity_key TEXT NOT NULL, work_id TEXT NOT NULL,
 entity_revision INTEGER NOT NULL CHECK(entity_revision>=1),
 deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), payload TEXT NOT NULL,
 generation TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(section,entity_key)
);
CREATE INDEX collection_authority_revisions_work ON collection_authority_revisions(work_id);
CREATE TABLE collection_authority_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, contract_version INTEGER NOT NULL,
 command_type TEXT NOT NULL, entity_key TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','blocked','dropped')),
 attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, conflict_code TEXT, conflict_detail TEXT, drop_reason TEXT,
 receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX collection_authority_outbox_fifo ON collection_authority_outbox(state,seq);
CREATE TABLE collection_authority_materialization (
 artwork_id TEXT PRIMARY KEY, work_id TEXT NOT NULL,
 blob_sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216),
 mime_type TEXT NOT NULL, target_path TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
 attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Trash archives the PC subtree before removing its live database projection.
-- Assets and local files are never deleted. Physical purge is a later batch.
CREATE TABLE collection_authority_trash (
 work_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('trashed','tombstoned','absent')),
 trashed_at TEXT NOT NULL, retain_until TEXT NOT NULL, payload TEXT NOT NULL,
 local_snapshot TEXT NOT NULL DEFAULT '{}'
);
-- The existing intent-drop table restricts its domains. Collections records its
-- drop evidence in the durable outbox instead of rebuilding that shared table.
PRAGMA user_version = 122;
