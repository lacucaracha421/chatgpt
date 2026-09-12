ALTER TABLE collections ADD COLUMN publisher TEXT;
ALTER TABLE collections ADD COLUMN platforms TEXT;

PRAGMA user_version = 23;
