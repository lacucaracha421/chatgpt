CREATE TABLE character_reference_exclusions (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(target_id, asset_id)
);
CREATE TRIGGER character_reference_excluded AFTER INSERT ON character_reference_exclusions BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets WHERE id=NEW.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
PRAGMA user_version = 52;
