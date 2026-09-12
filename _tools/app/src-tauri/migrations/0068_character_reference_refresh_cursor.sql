ALTER TABLE character_reference_refreshes
ADD COLUMN discovery_complete INTEGER NOT NULL DEFAULT 0
CHECK(discovery_complete IN (0,1));

-- Stable admission order survives deletion and VACUUM; SQLite's implicit rowid
-- on the jobs table cannot provide that guarantee.
CREATE TABLE character_autotag_admissions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL UNIQUE REFERENCES character_autotag_jobs(asset_id) ON DELETE CASCADE
);
INSERT INTO character_autotag_admissions(asset_id)
SELECT asset_id FROM character_autotag_jobs ORDER BY asset_id;
CREATE TRIGGER character_autotag_admission_insert AFTER INSERT ON character_autotag_jobs
BEGIN
    INSERT INTO character_autotag_admissions(asset_id) VALUES(NEW.asset_id);
END;

ALTER TABLE character_reference_refreshes
ADD COLUMN through_job_sequence INTEGER NOT NULL DEFAULT 0
CHECK(through_job_sequence >= 0);

-- Older requests created their complete item set eagerly. Mark those rows as
-- already discovered so an upgrade cannot insert the same items a second time.
UPDATE character_reference_refreshes SET discovery_complete=1;

PRAGMA user_version = 68;
