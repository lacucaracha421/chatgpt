CREATE TABLE IF NOT EXISTS character_member_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 ongoing_mode TEXT NOT NULL DEFAULT 'until' CHECK(ongoing_mode IN ('until','on','off')),
 arrival_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 cap_usd REAL NOT NULL DEFAULT 45 CHECK(cap_usd>=0),
 plan_id TEXT,
 state TEXT NOT NULL DEFAULT 'idle'
);
INSERT OR IGNORE INTO character_member_control(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS character_member_items (
 id INTEGER PRIMARY KEY,
 mode TEXT NOT NULL CHECK(mode IN ('backlog','ongoing')),
 asset_id TEXT NOT NULL UNIQUE,
 sample_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS character_member_requests (
 item_id INTEGER NOT NULL REFERENCES character_member_items(id),
 model TEXT NOT NULL,
 reserved_usd REAL NOT NULL,
 actual_usd REAL,
 usage_json TEXT,
 answer_json TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(item_id,model)
);
CREATE TABLE IF NOT EXISTS character_member_recommendations (
 asset_id TEXT NOT NULL,
 asset_hash TEXT NOT NULL,
 target_id TEXT NOT NULL REFERENCES character_targets(id) ON DELETE CASCADE,
 target_revision INTEGER NOT NULL,
 evidence_json TEXT NOT NULL,
 PRIMARY KEY(asset_id,target_id)
);
CREATE VIEW IF NOT EXISTS character_member_pending AS
 SELECT r.*,t.series_classification_id AS series_id
 FROM character_member_recommendations r
 JOIN assets a ON a.id=r.asset_id AND a.content_hash=r.asset_hash
 JOIN character_targets t ON t.id=r.target_id AND t.revision=r.target_revision
 WHERE a.status='normal' AND a.media_kind='image' AND t.enabled=1 AND t.role='character'
 AND NOT EXISTS(SELECT 1 FROM character_decisions d WHERE d.target_id=r.target_id AND d.source_asset_id=r.asset_id)
 AND EXISTS(WITH RECURSIVE scope(id) AS (SELECT t.series_classification_id UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
 SELECT 1 FROM asset_classifications ac JOIN scope s ON s.id=ac.classification_id WHERE ac.asset_id=r.asset_id);
PRAGMA user_version=135;
