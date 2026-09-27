-- Raw machine evidence is separate from user-edited display tags. Completion coverage
-- is essential: an absent sparse score is low only after that source tagged the asset.
-- Historical learned rows have no reliable writer provenance: even an automatic
-- latest decision may belong to a reference subsequently picked in settings.
-- Protect all existing/unspecified rows. Only an explicitly automatic writer may
-- opt into veto removal; current reference editors and confirmations are user picks.
ALTER TABLE character_learned_references ADD COLUMN provenance TEXT NOT NULL
 DEFAULT 'user' CHECK(provenance IN ('user','automatic'));

CREATE TABLE asset_tagger_coverage (
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('pixai','canary')),
 PRIMARY KEY(asset_id,source)
) WITHOUT ROWID;
CREATE TABLE tagger_character_vocabulary (
 source TEXT NOT NULL CHECK(source IN ('pixai','canary')),
 tag TEXT NOT NULL,
 PRIMARY KEY(source,tag)
) WITHOUT ROWID;
CREATE TABLE asset_tagger_character_scores (
 asset_id TEXT NOT NULL,
 source TEXT NOT NULL,
 tag TEXT NOT NULL,
 score REAL NOT NULL CHECK(score>=0 AND score<=1),
 PRIMARY KEY(asset_id,source,tag),
 FOREIGN KEY(asset_id,source) REFERENCES asset_tagger_coverage(asset_id,source) ON DELETE CASCADE,
 FOREIGN KEY(source,tag) REFERENCES tagger_character_vocabulary(source,tag) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX tagger_scores_by_tag ON asset_tagger_character_scores(tag,source,score,asset_id);
CREATE TABLE character_target_tagger_tags (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 tag TEXT NOT NULL,
 PRIMARY KEY(target_id,tag)
) WITHOUT ROWID;
CREATE TABLE character_tagger_candidates (
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 asset_hash TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('veto','recommendation')),
 pixai_score REAL NOT NULL,
 canary_score REAL NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(target_id,asset_id)
) WITHOUT ROWID;
CREATE INDEX character_tagger_candidates_asset ON character_tagger_candidates(asset_id);
-- Only an explicit human judgment consumes a candidate. Automatic reruns/imports do not.
CREATE TRIGGER character_tagger_manual_decision AFTER INSERT ON character_decisions
WHEN NEW.origin='manual' BEGIN
 DELETE FROM character_tagger_candidates WHERE target_id=NEW.target_id AND asset_id=NEW.source_asset_id;
END;
CREATE TRIGGER mobile_tagger_candidate_insert AFTER INSERT ON character_tagger_candidates BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_tagger_candidate_delete AFTER DELETE ON character_tagger_candidates BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_tagger_candidate_update AFTER UPDATE ON character_tagger_candidates BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE VIEW character_tagger_pending AS
 SELECT q.*,t.series_classification_id AS series_id FROM character_tagger_candidates q
 JOIN assets a ON a.id=q.asset_id AND a.content_hash=q.asset_hash AND a.status='normal' AND a.media_kind='image'
 JOIN character_targets t ON t.id=q.target_id
 WHERE t.series_classification_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.target_id=q.target_id AND r.asset_id=q.asset_id)
 AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.target_id=q.target_id AND r.asset_id=q.asset_id)
 AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions x WHERE x.series_id=t.series_classification_id AND x.asset_id=q.asset_id)
 AND NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_excluded_folders f ON f.id=ac.classification_id WHERE ac.asset_id=q.asset_id)
 AND COALESCE((SELECT d.decision FROM character_decisions d WHERE d.target_id=q.target_id AND d.source_asset_id=q.asset_id ORDER BY sequence DESC LIMIT 1),'') NOT IN ('accepted','rejected');
PRAGMA user_version = 105;
