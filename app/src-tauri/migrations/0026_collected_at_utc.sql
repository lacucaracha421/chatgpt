UPDATE assets
SET collected_at = strftime('%Y-%m-%dT%H:%M:%fZ', collected_at)
WHERE strftime('%Y-%m-%dT%H:%M:%fZ', collected_at) IS NOT NULL;

PRAGMA user_version = 26;
