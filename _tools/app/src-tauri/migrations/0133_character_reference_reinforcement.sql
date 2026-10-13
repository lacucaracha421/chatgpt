-- PC-local receipts and work queue; never backfill historical manual decisions.
CREATE TABLE IF NOT EXISTS character_reference_reinforcement_queue (
 target_id TEXT PRIMARY KEY REFERENCES character_targets(id) ON DELETE CASCADE,
 retry_at INTEGER NOT NULL DEFAULT 0,
 requested INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS character_reference_reinforcement_runs (
 run_id TEXT PRIMARY KEY,
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 references_json TEXT NOT NULL CHECK(json_valid(references_json)),
 created_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','acknowledged','undone'))
);
CREATE UNIQUE INDEX IF NOT EXISTS character_reference_reinforcement_pending
 ON character_reference_reinforcement_runs(target_id) WHERE state='pending';
PRAGMA user_version = 133;
