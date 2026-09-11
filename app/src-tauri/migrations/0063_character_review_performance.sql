-- Targeted lookup for the default character review tab. The partial index keeps
-- sparse recommended-review discovery off the full historical prediction set.
CREATE INDEX character_autotag_predictions_recommended
ON character_autotag_predictions(series_id,target_id,target_fingerprint,evidence_id)
WHERE json_extract(result_json,'$.state')='recommended';

PRAGMA user_version = 63;
