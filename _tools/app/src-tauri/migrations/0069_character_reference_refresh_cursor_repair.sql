-- Forward repair for development libraries that recorded an early v68 schema.
-- db.rs conditionally adds the cursor column in this same migration transaction.
-- Preserve existing admission numbers and never enqueue or reclassify images.
CREATE TABLE IF NOT EXISTS character_autotag_admissions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL UNIQUE REFERENCES character_autotag_jobs(asset_id) ON DELETE CASCADE
);
INSERT INTO character_autotag_admissions(asset_id)
SELECT job.asset_id FROM character_autotag_jobs job
WHERE NOT EXISTS (
    SELECT 1 FROM character_autotag_admissions admission WHERE admission.asset_id=job.asset_id
)
ORDER BY job.asset_id;

CREATE TRIGGER IF NOT EXISTS character_autotag_admission_insert
AFTER INSERT ON character_autotag_jobs
BEGIN
    INSERT INTO character_autotag_admissions(asset_id) VALUES(NEW.asset_id);
END;

PRAGMA user_version = 69;
