-- Character folder entry should not scan every prediction in a series just to
-- answer whether one target has a pending recommendation.
CREATE INDEX character_autotag_predictions_target_scope
ON character_autotag_predictions(series_id, target_id, evidence_id);

PRAGMA user_version = 62;
