ALTER TABLE collections ADD COLUMN original_title TEXT;
ALTER TABLE collections ADD COLUMN runtime_minutes INTEGER
    CHECK (runtime_minutes IS NULL OR runtime_minutes > 0);

PRAGMA user_version = 24;
