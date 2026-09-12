CREATE TABLE collection_external_bindings (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
    provider_data_json TEXT,
    last_synced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, provider)
);

CREATE INDEX collection_external_bindings_by_identity
ON collection_external_bindings(provider, external_id);

INSERT INTO collection_external_bindings (
    collection_id, provider, external_id, provider_data_json,
    last_synced_at, created_at, updated_at
)
SELECT
    id,
    lower(trim(external_source)),
    trim(external_id),
    external_metadata_json,
    external_synced_at,
    created_at,
    updated_at
FROM collections
WHERE external_source IS NOT NULL
  AND external_id IS NOT NULL
  AND length(trim(external_source)) > 0
  AND length(trim(external_id)) > 0;

PRAGMA user_version = 13;
