-- Pause only user-requested historical reference refresh work.
-- Normal automatic character classification must remain available.
ALTER TABLE character_autotag_control
ADD COLUMN reference_refresh_paused INTEGER NOT NULL DEFAULT 0
    CHECK(reference_refresh_paused IN (0,1));

-- The old global pause no longer has a renderer control. Clear it during the
-- upgrade so normal automatic classification cannot remain invisibly paused.
UPDATE character_autotag_control SET paused = 0 WHERE singleton = 1;

PRAGMA user_version = 67;
