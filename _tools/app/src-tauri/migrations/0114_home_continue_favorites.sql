-- PC Home resume state and performer favorites. These tables are local-library state;
-- they are not part of the mobile/cloud authority publications.
CREATE TABLE manga_reading_progress (
 series_id TEXT PRIMARY KEY NOT NULL REFERENCES manga_series(id) ON DELETE CASCADE,
 last_page INTEGER NOT NULL CHECK(last_page >= 1),
 page_count INTEGER NOT NULL CHECK(page_count >= 1),
 updated_at TEXT NOT NULL,
 CHECK(last_page <= page_count)
);
CREATE INDEX manga_reading_progress_by_updated
ON manga_reading_progress(updated_at DESC, series_id);

CREATE TABLE video_playback_progress (
 asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
 duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
 updated_at TEXT NOT NULL
);
CREATE INDEX video_playback_progress_by_updated
ON video_playback_progress(updated_at DESC, asset_id);

CREATE TABLE av_favorite_performers (
 person_id TEXT PRIMARY KEY NOT NULL REFERENCES collection_people(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL
);

PRAGMA user_version = 114;
