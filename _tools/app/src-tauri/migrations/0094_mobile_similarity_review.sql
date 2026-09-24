-- Mobile similarity review on the PC: the decision receive cursor, the receipt ledger, the
-- receive poll throttle, the pair feed's durable publication state, and the queue that
-- compares newly materialized Assets against the library automatically.
--
-- Mobile devices decide open historical pairs ("A 유지 · B 휴지통", "B 유지 · A 휴지통",
-- "둘 다 보관") on the server while the PC may be off; the server keeps an ordered log. The PC
-- stays the only owner of the library: it pulls the log and applies each entry through the
-- ordinary `decide_similarity_review`, which moves the image that is not kept to Library Trash
-- (never a hard delete) and queues the lifecycle command. Same shape as 0092 (Character
-- review). The cursor is scoped to `(endpoint, library_id)` because a `sequence` is only
-- meaningful inside one server's log for one library.
--
-- `received_cursor` is the last log position this PC consumed (applied or deterministically
-- skipped). The pair feed PUT carries it as `decisionCursor`; applied pairs are already
-- resolved locally, so the feed never lists a pair whose decision it claims.
CREATE TABLE IF NOT EXISTS mobile_similarity_review_sync (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 received_cursor INTEGER NOT NULL DEFAULT 0 CHECK(received_cursor >= 0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id)
);

-- One row per consumed log entry.
--
-- `outcome` is `applied` (the decision is the local state now, including a re-delivery after a
-- crash between the decision and this receipt, and a consumed `withdrawn` entry) or
-- `skipped:<reason>` (`resolvedOnPc`, `stale`, `changed`, `assetGone`, `withdrawn`). Skipped
-- entries are reported back in the next feed PUT. A repeated operation id with different
-- content, or the same position claimed by another operation, is a divergence and is refused.
CREATE TABLE IF NOT EXISTS mobile_similarity_review_receipts (
 endpoint TEXT NOT NULL,
 library_id TEXT NOT NULL CHECK(length(library_id) = 32),
 operation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 review_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('keep_existing', 'replace_existing', 'keep_both', 'withdrawn')),
 outcome TEXT NOT NULL CHECK(outcome = 'applied' OR outcome LIKE 'skipped:%'),
 created_at TEXT NOT NULL,
 PRIMARY KEY (endpoint, library_id, operation_id),
 UNIQUE (endpoint, library_id, sequence)
);

-- Durable "at most once a minute" throttle for the receive poll (and the adoption probe),
-- per endpoint. Scheduling state only; the cursor alone decides which entries are new.
CREATE TABLE IF NOT EXISTS mobile_similarity_review_poll (
 endpoint TEXT PRIMARY KEY,
 last_checked INTEGER NOT NULL
);

-- Pair feed publication state, per endpoint and library. Same columns and rules as 0092:
-- `input_digest` is a cheap fingerprint of what the feed depends on; a change marks the feed
-- dirty (debounced), otherwise it is rebuilt at most every five minutes and an unchanged body
-- (`body_digest`) is not sent again. `published_cursor` bounds the "newly reported" skipped
-- range. `adopted` becomes 1 once the server accepted a feed PUT (the first one, with
-- `baseRevision: null`, adopts the feature on the server).
CREATE TABLE IF NOT EXISTS mobile_similarity_review_feed_state (
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

-- Automatic comparison of newly materialized Assets (user decision 2).
--
-- Server-created Assets (mobile saves, cloud captures, uploads from another PC) skip the
-- similarity check at ingestion. When their original bytes land on this PC the materialization
-- state turns `complete`, and this trigger queues the Asset. A bounded background pass then
-- compares its PDQ hash with the library and records `historical` review pairs, so these
-- Assets get duplicate checking without a manual scan. Only the transition is queued; an
-- Asset already complete (a local import echoed by the server) is not.
CREATE TABLE IF NOT EXISTS similarity_auto_compare_queue (
 asset_id TEXT PRIMARY KEY NOT NULL,
 queued_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS similarity_auto_compare_on_materialized
AFTER UPDATE OF materialization ON asset_authority_state
WHEN NEW.materialization = 'complete' AND OLD.materialization IS NOT 'complete'
BEGIN
 INSERT OR IGNORE INTO similarity_auto_compare_queue(asset_id, queued_at)
 VALUES (NEW.asset_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

PRAGMA user_version = 94;
