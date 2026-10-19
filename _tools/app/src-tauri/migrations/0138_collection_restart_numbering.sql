ALTER TABLE collection_volume_ranges ADD COLUMN restart_numbering INTEGER NOT NULL DEFAULT 0 CHECK(restart_numbering IN (0,1));
DROP INDEX collection_volume_sources_by_provider_item;
CREATE UNIQUE INDEX collection_volume_sources_by_provider_item
ON collection_volume_sources(provider, provider_item_id) WHERE provider <> 'kakao';
CREATE UNIQUE INDEX IF NOT EXISTS collection_kakao_sources_by_work_item
ON collection_volume_sources(provider_item_id, collection_id) WHERE provider = 'kakao';
PRAGMA user_version = 138;
