-- Mobile character-candidate review on the PC: the decision receive cursor, the receipt
-- ledger, the receive poll throttle and the candidate feed's durable publication state.
--
-- Mobile devices record "맞음 / 아님 / 되돌리기" decisions on the server while the PC may be
-- off; the server keeps an ordered log. The PC stays the only owner of character membership:
-- it pulls the log, applies each entry through the ordinary character decision path and then
-- republishes. Same shape and reasoning as 0089 (Character exclusions) and 0091 (Collection
-- personal edits): the cursor is scoped to `(endpoint, library_id)` because a `sequence` is only
-- meaningful inside one server's log for one library, and it is read and advanced inside the
-- transaction that applies a page, so a crash re-delivers (a no-op) but never skips an entry.
--
-- `acknowledged_cursor` is the position the last *successful* navigation snapshot carried as
-- `reviewDecisionCursor`. The candidate feed PUT reuses it as its `decisionCursor`, so the feed
-- never claims decisions the published memberships do not reflect yet.
CREATE TABLE IF NOT EXISTS mobile_character_review_sync (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 received_cursor INTEGER NOT NULL DEFAULT 0 CHECK(received_cursor >= 0),
 acknowledged_cursor INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_cursor >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id)
);

-- One row per consumed log entry.
--
-- `outcome` says what the entry did: `applied` (recorded, or already the local state),
-- `superseded` (a newer local decision made outside this channel wins) or `skipped:<reason>`
-- (deterministically inapplicable here: missing target/asset, changed bytes, protected
-- reference, failed eligibility). Skipped entries are reported back in the next feed PUT.
--
-- `decision_sequence` is the `character_decisions.sequence` this entry wrote, or NULL when it
-- wrote nothing. It is what identifies decisions "written by this channel": a mobile undo
-- (`cleared`) may only clear such a decision, never an independent PC decision.
--
-- A repeated operation id with different content, or the same position claimed by another
-- operation, is a divergence and is refused.
CREATE TABLE IF NOT EXISTS mobile_character_review_receipts (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 operation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 target_id TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 asset_sha256 TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected', 'cleared')),
 origin TEXT NOT NULL CHECK(origin IN ('feed', 'viewer')),
 basis TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('applied', 'superseded') OR outcome LIKE 'skipped:%'),
 decision_sequence INTEGER,
 created_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id, operation_id),
 UNIQUE (endpoint, library_id, sequence)
);

CREATE INDEX IF NOT EXISTS mobile_character_review_receipts_decision
 ON mobile_character_review_receipts(decision_sequence) WHERE decision_sequence IS NOT NULL;

-- Durable "at most once a minute" throttle for the idle receive poll, per endpoint.
-- Scheduling state only; the cursor alone decides which entries are new.
CREATE TABLE IF NOT EXISTS mobile_character_review_poll (
 endpoint TEXT PRIMARY KEY,
 last_checked INTEGER NOT NULL
);

-- Candidate feed publication state, per endpoint and library.
--
-- `input_digest` is a cheap fingerprint of what the feed depends on (latest decision sequence,
-- the S36 cache's MAX(scored_at), saved B36 predictions, the acknowledged cursor, the S36
-- series choice). A change marks the feed dirty (debounced like the other lanes); otherwise the
-- feed is rebuilt at most every five minutes, and an unchanged body (`body_digest`) is not sent
-- again. `published_revision` is the server revision the next PUT names as its base;
-- `published_cursor` is the `decisionCursor` last accepted, which bounds the "newly
-- acknowledged" skipped range. `adopted` becomes 1 once the server accepted a feed PUT.
CREATE TABLE IF NOT EXISTS mobile_character_review_feed_state (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 adopted INTEGER NOT NULL DEFAULT 0 CHECK(adopted IN (0, 1)),
 input_digest TEXT,
 published_input_digest TEXT,
 first_dirty INTEGER NOT NULL DEFAULT 0,
 last_dirty INTEGER NOT NULL DEFAULT 0,
 built_at INTEGER NOT NULL DEFAULT 0,
 retry_after INTEGER NOT NULL DEFAULT 0,
 body_digest TEXT,
 published_revision TEXT,
 published_cursor INTEGER NOT NULL DEFAULT 0 CHECK(published_cursor >= 0),
 PRIMARY KEY (endpoint, library_id)
);

PRAGMA user_version = 92;
