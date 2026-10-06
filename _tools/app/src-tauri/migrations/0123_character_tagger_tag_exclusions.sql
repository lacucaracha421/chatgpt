CREATE TABLE character_target_tagger_tag_exclusions (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 tag TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(target_id,tag)
) WITHOUT ROWID;
PRAGMA user_version = 123;
