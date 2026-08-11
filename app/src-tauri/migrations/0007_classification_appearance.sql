ALTER TABLE classification_entries ADD COLUMN icon_key TEXT;
ALTER TABLE classification_entries ADD COLUMN color_key TEXT;

PRAGMA user_version = 7;
