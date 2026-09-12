-- Folder browsing starts from a classification's members, not all assets.
CREATE INDEX asset_classifications_by_classification
ON asset_classifications(classification_id, asset_id);

PRAGMA user_version = 70;
