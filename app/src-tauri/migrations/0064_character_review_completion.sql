CREATE TABLE character_review_completions (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    source_generation INTEGER NOT NULL,
    completed_at TEXT NOT NULL
);

PRAGMA user_version = 64;
