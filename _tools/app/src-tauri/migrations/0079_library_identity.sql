-- Stable, opaque library identity. Generated exactly once, never derived from
-- path, machine, credentials, private-vault identity or catalog revision.
ALTER TABLE library_settings ADD COLUMN library_id TEXT;

UPDATE library_settings
SET library_id = lower(hex(randomblob(16)))
WHERE singleton = 1 AND library_id IS NULL;

PRAGMA user_version = 79;
