-- Manual decisions are inspected in Rust and only invalidate a series when the
-- effective learned-reference set changes. The previous trigger restarted a
-- whole-series reconsideration for every manual accept/reject/clear.
DROP TRIGGER IF EXISTS character_autotag_manual_decision;

-- A target update inside the same series previously bumped the same
-- reconsideration row twice (NEW and OLD). Keep one invalidation for same-series
-- changes and additionally invalidate the old series only when a target moves.
DROP TRIGGER IF EXISTS character_autotag_target_update;
CREATE TRIGGER character_autotag_target_update
AFTER UPDATE OF revision,enabled,series_classification_id ON character_targets BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT NEW.series_classification_id WHERE NEW.series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT OLD.series_classification_id
 WHERE OLD.series_classification_id IS NOT NULL
   AND OLD.series_classification_id IS NOT NEW.series_classification_id
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

PRAGMA user_version = 54;
