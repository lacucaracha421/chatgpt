-- Permanent suggestion dismissal; deleting a row restores the tag's eligibility.
CREATE TABLE character_suggestion_ignored_tags (
 tag TEXT PRIMARY KEY NOT NULL,
 ignored_at TEXT NOT NULL
) WITHOUT ROWID;
PRAGMA user_version = 106;
