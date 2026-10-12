ALTER TABLE character_claude_opinions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE character_claude_opinions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 132;
