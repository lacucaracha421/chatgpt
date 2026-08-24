ALTER TABLE collections ADD COLUMN legacy_kind TEXT
    CHECK (legacy_kind IN ('game', 'manga', 'movie', 'gacha') OR legacy_kind IS NULL);

PRAGMA user_version = 21;
