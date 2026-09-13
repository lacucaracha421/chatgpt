CREATE TABLE mobile_catalog_visibility_state(
 endpoint TEXT PRIMARY KEY,
 digest TEXT NOT NULL,
 published_digest TEXT NOT NULL DEFAULT '',
 first_dirty INTEGER NOT NULL,
 last_dirty INTEGER NOT NULL,
 retry_after INTEGER NOT NULL DEFAULT 0
);
PRAGMA user_version = 75;
