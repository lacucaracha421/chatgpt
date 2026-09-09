CREATE INDEX character_autotag_failed ON character_autotag_jobs(asset_id) WHERE state='failed';
CREATE TABLE character_autotag_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
 completed INTEGER NOT NULL DEFAULT 0,
 confirmed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO character_autotag_control(singleton) VALUES(1);
CREATE TABLE character_autotag_reconsideration (
 series_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL DEFAULT 1,
 after_asset TEXT
);
CREATE INDEX character_decisions_source_pair ON character_decisions(source_asset_id,target_id,sequence DESC);
CREATE TRIGGER character_autotag_target_insert AFTER INSERT ON character_targets BEGIN
 INSERT INTO character_autotag_reconsideration(series_id) SELECT NEW.series_classification_id WHERE NEW.series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_autotag_target_update AFTER UPDATE OF revision,enabled,series_classification_id ON character_targets BEGIN
 INSERT INTO character_autotag_reconsideration(series_id) SELECT NEW.series_classification_id WHERE NEW.series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
 INSERT INTO character_autotag_reconsideration(series_id) SELECT OLD.series_classification_id WHERE OLD.series_classification_id IS NOT NULL
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_autotag_series_insert AFTER INSERT ON character_series BEGIN
 INSERT INTO character_autotag_reconsideration(series_id) VALUES(NEW.classification_id)
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_autotag_series_update AFTER UPDATE OF auto_classify ON character_series WHEN OLD.auto_classify<>NEW.auto_classify BEGIN
 INSERT INTO character_autotag_reconsideration(series_id) VALUES(NEW.classification_id)
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_autotag_manual_decision AFTER INSERT ON character_decisions WHEN NEW.origin='manual' BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT DISTINCT t.series_classification_id FROM character_targets t WHERE t.series_classification_id IS NOT NULL
 AND (t.id=NEW.target_id OR EXISTS(SELECT 1 FROM character_decisions d WHERE d.source_asset_id=NEW.source_asset_id AND d.target_id=t.id))
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_autotag_hierarchy AFTER UPDATE OF parent_id ON classification_entries WHEN OLD.parent_id IS NOT NEW.parent_id BEGIN
 INSERT INTO character_autotag_reconsideration(series_id) SELECT classification_id FROM character_series WHERE 1
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
CREATE TRIGGER character_autotag_reference_source AFTER UPDATE OF status,content_hash,relative_path ON assets
WHEN OLD.status IS NOT NEW.status OR OLD.content_hash IS NOT NEW.content_hash OR OLD.relative_path IS NOT NEW.relative_path BEGIN
 INSERT INTO character_autotag_reconsideration(series_id)
 SELECT DISTINCT t.series_classification_id FROM character_targets t WHERE t.series_classification_id IS NOT NULL
 AND (t.id IN (SELECT target_id FROM character_references WHERE asset_id=NEW.id)
 OR t.id IN (SELECT target_id FROM character_decisions WHERE source_asset_id=NEW.id AND origin='manual'))
 ON CONFLICT(series_id) DO UPDATE SET revision=revision+1,after_asset=NULL;
END;
PRAGMA user_version = 51;
