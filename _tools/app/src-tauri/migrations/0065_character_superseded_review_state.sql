-- Superseding a job is terminal, but earlier enqueue calls moved only `state`,
-- leaving `review_state='unresolved'` on rows that no worker will ever claim.
-- Backfill those rows so state and review_state agree again.
UPDATE character_autotag_jobs
SET review_state='superseded'
WHERE state='superseded' AND review_state<>'superseded';

PRAGMA user_version = 65;
