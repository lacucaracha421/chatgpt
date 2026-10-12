-- Claude decides the easy 확인-list recommendations (CHAR-CLAUDE-001, PC only).
--
-- One row per (character, image, references sent, model): what Claude answered, with the
-- token usage the monthly spend is summed from. Transport errors are never stored, so they
-- are retried later. A pair whose cascade ended "leave for the user" has its rows here, which
-- is what keeps it from being asked again until the references it was judged against change.
CREATE TABLE character_claude_opinions (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 asset_hash TEXT NOT NULL,
 reference_key TEXT NOT NULL,
 model TEXT NOT NULL,
 verdict TEXT NOT NULL CHECK(verdict IN ('yes','no','unsure','refused')),
 confidence REAL,
 reason TEXT,
 input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 PRIMARY KEY(target_id, asset_hash, reference_key, model)
) WITHOUT ROWID;
CREATE INDEX character_claude_opinions_by_time ON character_claude_opinions(created_at);

-- Machine-independent settings of the automatic judgment: off until the user turns it on.
CREATE TABLE character_claude_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
 monthly_cap_usd REAL NOT NULL DEFAULT 10 CHECK(monthly_cap_usd >= 0 AND monthly_cap_usd <= 100000)
);
INSERT OR IGNORE INTO character_claude_settings (singleton) VALUES (1);
PRAGMA user_version = 131;
