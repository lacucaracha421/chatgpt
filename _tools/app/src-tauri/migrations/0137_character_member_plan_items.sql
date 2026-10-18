ALTER TABLE character_member_items ADD COLUMN plan_id TEXT;
-- Backlog items belong to the plan that is current when this migration runs, so a running plan keeps going.
UPDATE character_member_items SET plan_id=(SELECT plan_id FROM character_member_control WHERE singleton=1) WHERE mode='backlog';
-- Small-series answers below the automatic bar used to be dropped; they are recommended now.
-- The flag lets the app turn the already stored answers into recommendations exactly once.
ALTER TABLE character_member_control ADD COLUMN recommendations_backfilled INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=137;
