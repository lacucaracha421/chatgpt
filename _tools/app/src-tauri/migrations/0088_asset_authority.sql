-- Confirmed lifecycle is independent of pending user intent and local byte presence.
CREATE TABLE asset_authority (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0),
 contract_version INTEGER NOT NULL CHECK(contract_version=1), cursor INTEGER NOT NULL CHECK(cursor>=0)
);
CREATE TABLE asset_authority_state (
 asset_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('normal','trash','tombstoned')),
 entity_revision INTEGER NOT NULL CHECK(entity_revision>0), sha256 TEXT, size_bytes INTEGER,
 projection TEXT NOT NULL,
 materialization TEXT NOT NULL DEFAULT 'pending' CHECK(materialization IN ('pending','complete','conflict')),
 last_error TEXT, server_created INTEGER NOT NULL DEFAULT 0 CHECK(server_created IN (0,1))
);
CREATE INDEX asset_materialization_candidates ON asset_authority_state(materialization,lifecycle,asset_id);
CREATE TABLE asset_lifecycle_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, contract_version INTEGER NOT NULL,
 asset_id TEXT NOT NULL, desired TEXT NOT NULL CHECK(desired IN ('normal','trash','tombstoned')),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','conflict')),
 created_at TEXT NOT NULL, last_error TEXT
);
CREATE INDEX asset_lifecycle_outbox_by_asset ON asset_lifecycle_outbox(asset_id,sequence);
PRAGMA user_version=88;
