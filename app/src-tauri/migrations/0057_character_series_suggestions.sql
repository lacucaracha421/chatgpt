-- Remember explicit "keep here" choices for semi-automatic series suggestions.
-- The key includes the suggested series so a different future series may still surface.
CREATE TABLE character_series_suggestion_dismissals (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    series_classification_id TEXT NOT NULL REFERENCES classification_entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(asset_id, series_classification_id)
);
CREATE INDEX character_series_suggestion_dismissals_series
ON character_series_suggestion_dismissals(series_classification_id, asset_id);

PRAGMA user_version = 57;
