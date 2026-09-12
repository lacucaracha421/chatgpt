-- Once learned references are explicit, ordinary manual decisions are membership
-- history only. Source changes should reconsider recognition only when the asset
-- is an anchor or an explicit learned reference.
DROP TRIGGER IF EXISTS character_autotag_reference_source;
CREATE TRIGGER character_autotag_reference_source
AFTER UPDATE OF status,content_hash,relative_path ON assets
WHEN OLD.status IS NOT NEW.status OR OLD.content_hash IS NOT NEW.content_hash OR OLD.relative_path IS NOT NEW.relative_path BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT DISTINCT t.series_classification_id FROM character_targets t
 WHERE t.series_classification_id IS NOT NULL
   AND (t.id IN (SELECT target_id FROM character_references WHERE asset_id=NEW.id)
     OR t.id IN (SELECT target_id FROM character_learned_references WHERE asset_id=NEW.id))
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

PRAGMA user_version = 56;