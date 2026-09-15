-- B6: the PC-side *send* half of catalog-bookmark reconciliation.
--
-- `catalog_bookmark_outbox` is the durable, transactional outbox that carries a
-- locally accepted bookmark mutation to the server authority. One row is one
-- logical intent, not one HTTP attempt: `operation_id` is minted once when the
-- local mutation is accepted and survives retry, lost responses and restarts, so
-- the server's B4 receipts resolve the ambiguity of a repeated request instead of
-- recording a second logical write.
--
-- The row is written in the same transaction as the bookmark-table change, so a
-- crash cannot leave a local mutation without its operation or an operation for a
-- mutation that never committed.
--
-- `UNIQUE(provider, work_id)` coalesces repeated local toggles of the same entity
-- into the newest intent: a superseding mutation is a *new* logical operation and
-- therefore takes a fresh `operation_id` (the server keys receipts by operation id
-- and rejects reuse with a different payload).
--
-- `base_revision` is the `expectedRevision` this intent was composed against, and
-- `epoch` records the authority generation it was composed under. Revisions are
-- only comparable inside one epoch, so an intent carried across an epoch uses a
-- zero base and lets the server's compare-and-set decide. `created_at` is the
-- authority-owned creation time this PC holds for the intent, used to keep a
-- pending add visible locally while a remote baseline is applied.
--
-- This table has no trigger and the bookmark table writes above never consult it:
-- a B5 remote apply (snapshot or change page) writes the bookmark table directly
-- and enqueues nothing.
CREATE TABLE catalog_bookmark_outbox (
 operation_id TEXT PRIMARY KEY,
 provider TEXT NOT NULL,
 work_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 epoch INTEGER NOT NULL CHECK(epoch >= 1),
 base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
 created_at TEXT NOT NULL,
 UNIQUE(provider, work_id)
);

-- Deterministic send order: oldest intent first, operation id breaking ties.
CREATE INDEX catalog_bookmark_outbox_order
 ON catalog_bookmark_outbox(created_at, operation_id);

-- The last authoritative entity revision this PC has observed, per entity, kept
-- for bookmarks *and* tombstones: a re-bookmark of a tombstone must present that
-- tombstone's revision as its `expectedRevision`.
--
-- Written only from server-owned data (snapshot, change page, command result) in
-- the same transaction as the bookmark rows it describes. It is a cache of
-- authority state, never a source of local intent, and it produces no outgoing
-- work.
CREATE TABLE catalog_bookmark_revisions (
 provider TEXT NOT NULL,
 work_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 0),
 PRIMARY KEY(provider, work_id)
) WITHOUT ROWID;

PRAGMA user_version = 81;
