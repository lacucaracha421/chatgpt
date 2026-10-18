CREATE TABLE IF NOT EXISTS character_member_excluded_folders (
 classification_id TEXT PRIMARY KEY REFERENCES classification_entries(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS character_member_exclusion_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 seeded INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO character_member_exclusion_state(singleton) VALUES(1);
PRAGMA user_version=136;
