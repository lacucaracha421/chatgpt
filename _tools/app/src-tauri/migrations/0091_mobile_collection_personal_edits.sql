-- Mobile personal Collection edits (my rating, Showcase membership, memo) on the PC:
-- the durable receive cursor, the receipt ledger and the poll throttle.
--
-- The server accepts these edits while the PC is off and keeps an ordered log. The PC
-- stays the owner of every Collection: it pulls the log, applies each entry with a
-- targeted UPDATE and then republishes. Same shape and reasoning as 0089 (Character
-- exclusions): the cursor is scoped to `(endpoint, library_id)` because a `sequence` is
-- only meaningful inside one server's log for one library, and it is read and advanced
-- inside the transaction that applies a page, so a crash re-delivers (a no-op) but never
-- skips an entry.
CREATE TABLE IF NOT EXISTS mobile_collection_personal_edit_sync (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 received_cursor INTEGER NOT NULL DEFAULT 0 CHECK(received_cursor >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id)
);

-- One row per consumed log entry. `value`/`previous_value` are the JSON values from the
-- log (kept for audit); `outcome` records whether the entry changed a local Collection
-- (`applied`) or named a Collection this PC no longer publishes (`skipped`: deleted or AV,
-- PC deletion wins). A repeated operation id with different content, or the same position
-- claimed by another operation, is a divergence and is refused.
CREATE TABLE IF NOT EXISTS mobile_collection_personal_edit_receipts (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 operation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 collection_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK(field IN ('myScore', 'showcase', 'memo')),
 value TEXT NOT NULL,
 previous_value TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('applied', 'skipped')),
 created_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id, operation_id),
 UNIQUE (endpoint, library_id, sequence)
);

-- Durable "at most once a minute" throttle for the idle receive poll, per endpoint.
-- Scheduling state only; the cursor alone decides which entries are new.
CREATE TABLE IF NOT EXISTS mobile_collection_personal_edit_poll (
 endpoint TEXT PRIMARY KEY,
 last_checked INTEGER NOT NULL
);

PRAGMA user_version = 91;
