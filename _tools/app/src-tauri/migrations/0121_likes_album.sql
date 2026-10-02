ALTER TABLE library_settings ADD COLUMN likes_album_id TEXT;

-- Read-only fallback supports existing libraries until normal album use adopts the id.
CREATE VIEW asset_likes AS
SELECT asset_id FROM asset_albums
WHERE album_id = COALESCE(
    (SELECT likes_album_id FROM library_settings WHERE singleton = 1),
    (SELECT MIN(id) FROM albums WHERE name = '마음에 들어요' COLLATE BINARY HAVING COUNT(*) = 1)
);
PRAGMA user_version = 121;
