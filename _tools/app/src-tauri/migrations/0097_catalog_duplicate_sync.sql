-- Manga Catalog duplicate-edition review on the PC (`catalog_duplicate_sync.rs`).
--
-- The PC compares its whole catalog with the `catalog_review.rs` rules, merges confident
-- pairs automatically (a local `confirm`: one edition group, both works kept, nothing hidden
-- or deleted), uploads its candidate set to the server
-- (`PUT /v1/mobile-catalog/duplicates/candidates`) and applies the decisions mobile devices
-- record there (`GET /v1/mobile-catalog/duplicates/decisions`).
--
-- Per-endpoint schedule and cursor. `decision_cursor` is the last server log position this
-- PC recorded (exclusive `after` of the next read). `uploaded_input` fingerprints the local
-- state of the last completed candidate upload, so the catalog is compared and uploaded
-- again only after it (or a decision) changed.
CREATE TABLE IF NOT EXISTS catalog_duplicate_sync (
 endpoint TEXT PRIMARY KEY,
 decision_cursor INTEGER NOT NULL DEFAULT 0 CHECK(decision_cursor >= 0),
 last_polled INTEGER NOT NULL DEFAULT 0,
 uploaded_input TEXT,
 retry_after INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);

-- One row per work pair the PC decided automatically or received a server decision for.
-- Work ids are ordered like the server orders them (`left_work_id < right_work_id`); the
-- local decision row in `online_catalog_review_decisions` uses the same two ids.
--
-- * `server_decision`: the pair's current server state (`keepBoth`, `hideEdition`,
--   `notDuplicate`; NULL = none or cleared).
-- * `human`: 1 once a person decided the pair on mobile (or on this PC); automation never
--   confirms such a pair again.
-- * `origin`: who owns the local decision row (`auto` = automatic merge, `server` = a mobile
--   decision); NULL = this sync owns no row for the pair.
-- * `desired` / `applied`: the local decision this sync wants (NULL = remove its row) and
--   whether it is in place. A decision whose works are not in the local catalog yet waits
--   here (`blocked = 'workMissing'`) and applies once the catalog catches up.
-- * `report` / `auto_operation_id`: reporting an automatic merge to the server as `keepBoth`
--   (`pending`, `reported`, or `dropped` when a person decided first). The operation id is
--   kept so a retry is idempotent and the PC recognizes its own entry in the decision log.
CREATE TABLE IF NOT EXISTS catalog_duplicate_pairs (
 left_work_id TEXT NOT NULL,
 right_work_id TEXT NOT NULL,
 server_decision TEXT CHECK(server_decision IN ('keepBoth', 'hideEdition', 'notDuplicate')),
 server_sequence INTEGER NOT NULL DEFAULT 0,
 human INTEGER NOT NULL DEFAULT 0 CHECK(human IN (0, 1)),
 origin TEXT CHECK(origin IN ('auto', 'server')),
 desired TEXT CHECK(desired IN ('confirm', 'falsePositive')),
 applied INTEGER NOT NULL DEFAULT 1 CHECK(applied IN (0, 1)),
 blocked TEXT,
 report TEXT CHECK(report IN ('pending', 'reported', 'dropped')),
 auto_operation_id TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (left_work_id, right_work_id),
 CHECK(left_work_id < right_work_id)
) WITHOUT ROWID;

PRAGMA user_version = 97;
