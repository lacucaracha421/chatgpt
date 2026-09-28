-- PC-only artist style review. Feature vectors remain in the disposable cache.
ALTER TABLE artists ADD COLUMN reposter INTEGER NOT NULL DEFAULT 0 CHECK(reposter IN (0, 1));
CREATE TABLE artist_style_dismissals (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY(asset_id, artist_id)
);
PRAGMA user_version = 110;
