CREATE TABLE character_learned_references (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 asset_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(target_id, asset_id),
 UNIQUE(target_id, asset_hash)
);

-- Preserve the currently effective learned examples exactly once during upgrade.
-- Later manual accepts/rejects no longer mutate this table implicitly.
WITH RECURSIVE scope(target_id,id) AS (
 SELECT id,series_classification_id FROM character_targets WHERE series_classification_id IS NOT NULL
 UNION ALL
 SELECT scope.target_id,c.id FROM classification_entries c JOIN scope ON c.parent_id=scope.id
), raw AS (
 SELECT r.target_id,a.id asset_id,a.content_hash asset_hash,d.created_at,d.sequence,
        ROW_NUMBER() OVER (PARTITION BY r.target_id,a.content_hash ORDER BY d.sequence DESC) hash_rank
 FROM character_relations r
 JOIN character_decisions d ON d.sequence=r.sequence
 JOIN assets a ON a.id=r.asset_id
 WHERE d.origin='manual' AND a.status='normal' AND a.media_kind='image'
   AND d.asset_hash=a.content_hash
   AND NOT EXISTS(SELECT 1 FROM character_reference_exclusions x
     WHERE x.target_id=r.target_id AND x.asset_id=a.id)
   AND json_valid(d.reference_snapshot)
   AND json_array_length(d.reference_snapshot,'$.prediction.queryBoxes')=1
   AND json_extract(d.reference_snapshot,'$.prediction.wholeFallback')=0
   AND NOT EXISTS(SELECT 1 FROM character_relations other
     WHERE other.asset_id=a.id AND other.target_id<>r.target_id)
   AND NOT EXISTS(SELECT 1 FROM character_references base
     WHERE base.target_id=r.target_id AND base.asset_hash=a.content_hash)
   AND EXISTS(SELECT 1 FROM asset_classifications ac JOIN scope s
     ON s.target_id=r.target_id AND s.id=ac.classification_id WHERE ac.asset_id=a.id)
), distinct_examples AS (
 SELECT target_id,asset_id,asset_hash,created_at,sequence,
        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY sequence DESC) target_rank
 FROM raw WHERE hash_rank=1
)
INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at)
SELECT target_id,asset_id,asset_hash,created_at FROM distinct_examples WHERE target_rank<=20;

-- The old exclusion table is retained as a tombstone/history store only.
DROP TRIGGER IF EXISTS character_reference_excluded;

DROP TRIGGER IF EXISTS character_autotag_reference_source;
CREATE TRIGGER character_autotag_reference_source
AFTER UPDATE OF status,content_hash,relative_path ON assets
WHEN OLD.status IS NOT NEW.status OR OLD.content_hash IS NOT NEW.content_hash OR OLD.relative_path IS NOT NEW.relative_path BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT DISTINCT t.series_classification_id FROM character_targets t
 WHERE t.series_classification_id IS NOT NULL
   AND (t.id IN (SELECT target_id FROM character_references WHERE asset_id=NEW.id)
     OR t.id IN (SELECT target_id FROM character_learned_references WHERE asset_id=NEW.id)
     OR t.id IN (SELECT target_id FROM character_decisions WHERE source_asset_id=NEW.id AND origin='manual'))
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

CREATE TRIGGER character_learned_reference_insert AFTER INSERT ON character_learned_references BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets
 WHERE id=NEW.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_learned_reference_delete AFTER DELETE ON character_learned_references BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets
 WHERE id=OLD.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_learned_reference_update AFTER UPDATE OF asset_hash ON character_learned_references BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT series_classification_id FROM character_targets
 WHERE id=NEW.target_id AND series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;

PRAGMA user_version = 55;