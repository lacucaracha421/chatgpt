-- Classification authority 2B: PC-side durable receive-only replica.
--
-- This batch is **receive only**. It adds the durable state needed to adopt and
-- replay the server's Classification authority; it deliberately adds no outbox,
-- because the send half (2B.1) owns that. Until 2B.1 lands, every local
-- Classification mutation keeps writing `classification_entries` /
-- `asset_classifications` directly and the legacy dirty-generation triggers in
-- migrations 0074/0076 keep publishing them, exactly as before.
--
-- An empty `classification_authority_sync` table means the PC has not adopted
-- Classification authority, which keeps every pre-adoption Classification path
-- byte-identical. The singleton row appears only after a complete baseline has been
-- verified and adopted atomically, so its presence *is* the adoption marker — the
-- restore guard reads it, and migration 0082 records the same convention for Albums.

CREATE TABLE classification_authority_sync (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL CHECK(epoch >= 1),
 contract_version INTEGER NOT NULL CHECK(contract_version >= 1),
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
 updated_at TEXT NOT NULL
);

-- Latest confirmed server revision for a Classification entity, plus its tombstone
-- flag. A deleted Classification keeps its row here with `deleted = 1`: the server
-- deliberately never prunes a tombstone, so "no cache row" must never be read as
-- "this Classification was deleted". Keeping it also lets a later command present
-- that Classification's real revision instead of a fabricated one.
CREATE TABLE classification_authority_revisions (
 classification_id TEXT PRIMARY KEY NOT NULL,
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 updated_at TEXT NOT NULL
);

-- One row per Asset assignment lineage the authority has confirmed.
--
-- Assignment is single-valued on the server (`asset_id -> classification_id | null`),
-- so this is keyed by the Asset rather than by a relation pair.
--
-- Two distinct states are representable, and the difference is load-bearing:
--
-- * **no row** means this PC has never been told about that Asset, so the revision
--   it must present is 0 (absent state);
-- * **a row with `classification_id IS NULL`** is an authoritative *unassigned*
--   state at a real non-zero revision.
--
-- Collapsing the second into the first would make a cleared assignment look like one
-- the server never mentioned, so a later command would present revision 0 for a
-- lineage that legitimately reached 1+.
--
-- Rows are retained even when their Asset is not materialized on this PC (or not yet
-- present), which is why there is no foreign key to `assets`: the authority
-- legitimately knows assignments for Assets this PC has not rebuilt yet, and the
-- visible `asset_classifications` projection is completed later by the deferred
-- materialization step rather than by rejecting the row.
CREATE TABLE classification_authority_assignment_revisions (
 asset_id TEXT PRIMARY KEY NOT NULL,
 classification_id TEXT,
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 updated_at TEXT NOT NULL
);

-- Deferred assignment materialization scans by the value it projects, so an index on
-- the nullable column keeps that step proportional to the rows it can act on rather
-- than to the whole table.
CREATE INDEX classification_authority_assignments_by_classification
 ON classification_authority_assignment_revisions(classification_id);

-- No Classification outbox is created here. 2B.1 adds it together with the send
-- path, the operation-id minting and the conflict states that make it meaningful.

PRAGMA user_version = 83;
