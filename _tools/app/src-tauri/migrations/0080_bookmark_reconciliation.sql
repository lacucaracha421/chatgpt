-- PC-side catch-up state for the server-owned catalog bookmark authority.
--
-- B5 owns the *receive* half of reconciliation: this row records which library
-- authority the local replica belongs to and how far that authority's change log
-- has been applied. An empty table means "no authority has been adopted yet",
-- which keeps every pre-B5 read path byte-identical.
--
-- The row exists only after a full snapshot baseline has been adopted, so its
-- presence *is* the baseline marker; a separate flag would be redundant.
-- `cursor` advances only in the same transaction that applies a page's changes,
-- so an interrupted run re-applies a page rather than skipping it.
CREATE TABLE catalog_bookmark_sync (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 contract_version INTEGER NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
 updated_at TEXT NOT NULL
);

PRAGMA user_version = 80;
