CREATE TABLE assets_v4 (
    id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'gif', 'video')),
    title TEXT,
    original_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    thumbnail_relative_path TEXT UNIQUE,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    source_url TEXT,
    collected_at TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'normal'
        CHECK (status IN ('normal', 'review', 'trash')),
    trashed_at TEXT,
    perceptual_hash BLOB,
    perceptual_hash_error TEXT,
    CHECK (media_kind = 'video' OR thumbnail_relative_path IS NOT NULL)
);

INSERT INTO assets_v4 (
    id, content_hash, media_kind, title, original_name, relative_path,
    thumbnail_relative_path, byte_size, width, height, source_url, collected_at,
    favorite, status, trashed_at, perceptual_hash, perceptual_hash_error
)
SELECT
    id, content_hash, media_kind, title, original_name, relative_path,
    thumbnail_relative_path, byte_size, width, height, source_url, collected_at,
    favorite, status, trashed_at, perceptual_hash, perceptual_hash_error
FROM assets;

DROP TABLE assets;
ALTER TABLE assets_v4 RENAME TO assets;

CREATE INDEX assets_by_collected_at
ON assets(status, collected_at DESC, id DESC);

CREATE INDEX assets_by_trash_age
ON assets(status, trashed_at, id);

CREATE TABLE video_assets (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    container TEXT NOT NULL,
    video_codec TEXT NOT NULL,
    audio_codec TEXT,
    preparation_state TEXT NOT NULL
        CHECK (preparation_state IN ('pending', 'processing', 'ready', 'failed')),
    preparation_error TEXT,
    playback_kind TEXT CHECK (playback_kind IN ('original', 'proxy')),
    poster_relative_path TEXT,
    scrub_relative_dir TEXT,
    scrub_frame_count INTEGER NOT NULL DEFAULT 0 CHECK (scrub_frame_count >= 0),
    proxy_relative_path TEXT,
    preparation_version INTEGER NOT NULL DEFAULT 1 CHECK (preparation_version > 0),
    CHECK (
        (preparation_state IN ('pending', 'processing') AND preparation_error IS NULL)
        OR (preparation_state = 'failed' AND preparation_error IS NOT NULL)
        OR (preparation_state = 'ready' AND preparation_error IS NULL
            AND playback_kind IS NOT NULL AND poster_relative_path IS NOT NULL
            AND scrub_relative_dir IS NOT NULL)
    )
);

CREATE INDEX video_assets_by_preparation
ON video_assets(preparation_state, asset_id);

PRAGMA user_version = 4;
