-- Album authority 2B: PC-side durable replica, revision caches and outbox.
--
-- The album domain follows the same shape the catalog-bookmark pilot proved, with
-- one deliberate difference: Albums are *structural* state, so the send and receive
-- halves do not share a queue and the sync order is
-- `flush intents -> only when clean, receive`.
--
-- An empty set of `album_authority_sync` rows means the PC has not adopted Album
-- authority, which keeps every pre-adoption Album path byte-identical. The row
-- exists only after a complete baseline has been adopted, so its presence *is* the
-- adoption marker.

CREATE TABLE album_authority_sync (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 contract_version INTEGER NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
 updated_at TEXT NOT NULL
);

-- Latest authoritative Album entity revision this PC has observed, plus the
-- tombstone flag. A deleted Album keeps its row here with `deleted = 1` so replaying
-- a later command can present that Album's real revision instead of pretending a
-- missing local row means revision 0.
CREATE TABLE album_authority_revisions (
 album_id TEXT PRIMARY KEY NOT NULL,
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 updated_at TEXT NOT NULL
);

-- Latest authoritative membership relation state, keyed by the relation itself.
-- Tombstones live here and are absent from `asset_albums`: the local membership
-- table answers "which Albums is this Asset in", while this table answers "what is
-- the authoritative revision of this relation", including relations that are
-- currently removed.
CREATE TABLE album_authority_membership_revisions (
 album_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 entity_revision INTEGER NOT NULL CHECK(entity_revision >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(album_id, asset_id)
);
CREATE INDEX album_authority_membership_by_asset
 ON album_authority_membership_revisions(asset_id, album_id);

-- Durable outgoing Album commands. One row is one logical local intent, not one
-- HTTP attempt: `operation_id` is minted when the local mutation is accepted and is
-- reused verbatim on every retry, so the server's receipt resolves a lost response
-- instead of recording a second logical write.
--
-- `seq` gives strict deterministic FIFO order, which this domain requires and the
-- bookmark pilot deliberately did not: a rename must never overtake the create it
-- depends on. Rows are therefore *never* coalesced, even for the same Album.
--
-- `payload` is the exact command body the server expects, serialized once at
-- enqueue time. Storing it byte-for-byte is what makes a retry after a lost
-- response provably identical, and it makes "reused operation id with a different
-- payload" impossible to introduce by accident.
--
-- `state` distinguishes a retryable pending intent from one the authority rejected
-- on structural grounds. A blocked row keeps its payload and its optimistic local
-- effect; it is never rebased automatically, because selecting a winner for a
-- structural edit is a user decision.
CREATE TABLE album_authority_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_id TEXT NOT NULL UNIQUE,
 command_type TEXT NOT NULL,
 album_id TEXT NOT NULL,
 asset_id TEXT,
 epoch INTEGER NOT NULL CHECK(epoch >= 1),
 payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','blocked')),
 conflict_code TEXT,
 conflict_detail TEXT,
 created_at TEXT NOT NULL
);

-- Deterministic send order: strictly oldest first. `seq` alone is sufficient and
-- needs no tiebreaker, being unique by construction.
CREATE INDEX album_authority_outbox_order ON album_authority_outbox(seq);

PRAGMA user_version = 82;
