ALTER TABLE character_targets ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE character_targets ADD COLUMN thumbnail_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
CREATE TABLE character_series (
 classification_id TEXT PRIMARY KEY REFERENCES classification_entries(id) ON DELETE CASCADE,
 hero_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
 auto_classify INTEGER NOT NULL DEFAULT 1 CHECK(auto_classify IN (0,1))
);
INSERT INTO character_series(classification_id) SELECT DISTINCT series_classification_id FROM character_targets WHERE series_classification_id IS NOT NULL;
ALTER TABLE character_decisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','automatic'));
PRAGMA user_version = 48;
