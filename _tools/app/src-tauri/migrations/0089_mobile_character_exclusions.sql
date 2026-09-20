-- Manual mobile character exclusions on the PC: the durable receive cursor and the
-- receipt ledger that makes their delivery idempotent.
--
-- A mobile manual "exclude from this character" is an explicit rejection the server
-- accepts while the PC is off and reflects in its read projection. The PC owns
-- character inference, so it never accepts the correction as *authority*: it receives
-- the ordered server log and records the same rejection locally through the existing
-- character decision path. That keeps one write primitive for characters and leaves
-- automatic inference entirely on the PC.
--
-- # Why a separate adoption row per endpoint
--
-- `received_cursor` is the highest exclusion `sequence` this PC has applied, and the only
-- thing that decides which log rows are new. It is read and advanced inside the transaction
-- that applies a page, so a crash can re-deliver rows (a no-op) but can never skip one, and a
-- page fetched from a position another pass has already moved past can never rewind it. It
-- only ever moves forwards.
--
-- The cursor is scoped to `(endpoint, library_id)` because a `sequence` is only
-- meaningful inside one server's log for one library. Pointing the PC at another
-- server or restoring another library's identity must therefore start a new
-- adoption row with a zero cursor rather than comparing two unrelated clocks.
--
-- A zero `received_cursor` means "no exclusions seen": adopting a server whose log is
-- empty and one that has never been reached are the same observable state, which is
-- what makes the first bootstrap a plain read.
CREATE TABLE IF NOT EXISTS mobile_character_exclusion_sync (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 received_cursor INTEGER NOT NULL DEFAULT 0 CHECK(received_cursor >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id)
);

-- One row per consumed log entry, keyed by origin *and* operation id.
--
-- The key is `(endpoint, library_id, operation_id)`, not the operation id alone: an
-- operation id is only unique inside the server that minted it, so a PC pointed at two
-- servers, or restored under another library identity, must not have one origin's receipt
-- answer for another's.
--
-- `UNIQUE(endpoint, library_id, sequence)` is what detects the log relocating an entry: the
-- same position claimed by a different operation is a divergence the PC cannot reconcile,
-- and it is refused rather than silently applied twice.
--
-- The claim columns are stored so a repeated operation id carrying different content is
-- detected instead of being accepted as an already-consumed no-op. No *decision* state is
-- stored: the rejection lives in `character_decisions`, which remains the single view.
CREATE TABLE IF NOT EXISTS mobile_character_exclusion_receipts (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 operation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 target_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 asset_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id, operation_id),
 UNIQUE (endpoint, library_id, sequence)
);

CREATE INDEX IF NOT EXISTS mobile_character_exclusion_receipts_order
 ON mobile_character_exclusion_receipts(endpoint, library_id, sequence);

-- Durable throttle for the receive poll, one row per endpoint.
--
-- In memory would be simpler and wrong: a restart would immediately re-poll, and the poll is
-- deliberately not gated on a dirty publication, so a crash loop could hammer the log. Storing
-- the last check time keeps "at most once a minute" true across restarts. This is scheduling
-- state only and never decides which entries are new — the cursor does that.
CREATE TABLE IF NOT EXISTS mobile_character_exclusion_poll (
 endpoint TEXT PRIMARY KEY,
 last_checked INTEGER NOT NULL
);

PRAGMA user_version = 89;
