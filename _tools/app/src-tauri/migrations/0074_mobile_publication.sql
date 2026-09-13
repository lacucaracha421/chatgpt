-- Durable generations: publication acknowledges only the generation it started with.
CREATE TABLE mobile_publication_state (
 kind TEXT PRIMARY KEY CHECK(kind IN ('collections','characters')),
 generation INTEGER NOT NULL DEFAULT 1,
 published_generation INTEGER NOT NULL DEFAULT 0,
 first_dirty INTEGER NOT NULL DEFAULT 0,
 last_dirty INTEGER NOT NULL DEFAULT 0,
 retry_after INTEGER NOT NULL DEFAULT 0,
 endpoint TEXT NOT NULL DEFAULT '',
 navigation_order TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO mobile_publication_state(kind) VALUES('collections'),('characters');
CREATE TRIGGER mobile_collections_insert AFTER INSERT ON collections BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collections_update AFTER UPDATE ON collections BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collections_delete AFTER DELETE ON collections BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_volumes_insert AFTER INSERT ON collection_volumes BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_volumes_update AFTER UPDATE ON collection_volumes BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_volumes_delete AFTER DELETE ON collection_volumes BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_work_artworks_insert AFTER INSERT ON collection_work_artworks BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_work_artworks_update AFTER UPDATE ON collection_work_artworks BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_work_artworks_delete AFTER DELETE ON collection_work_artworks BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_external_bindings_insert AFTER INSERT ON collection_external_bindings BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_external_bindings_update AFTER UPDATE ON collection_external_bindings BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_external_bindings_delete AFTER DELETE ON collection_external_bindings BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_classification_entries_insert AFTER INSERT ON classification_entries BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_classification_entries_update AFTER UPDATE ON classification_entries BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_classification_entries_delete AFTER DELETE ON classification_entries BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_series_insert AFTER INSERT ON character_series BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_series_update AFTER UPDATE ON character_series BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_series_delete AFTER DELETE ON character_series BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_groups_insert AFTER INSERT ON character_groups BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_groups_update AFTER UPDATE ON character_groups BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_groups_delete AFTER DELETE ON character_groups BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_group_members_insert AFTER INSERT ON character_group_members BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_group_members_update AFTER UPDATE ON character_group_members BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_group_members_delete AFTER DELETE ON character_group_members BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_targets_insert AFTER INSERT ON character_targets BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_targets_update AFTER UPDATE ON character_targets BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_targets_delete AFTER DELETE ON character_targets BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_decisions_insert AFTER INSERT ON character_decisions BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_decisions_update AFTER UPDATE ON character_decisions BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_decisions_delete AFTER DELETE ON character_decisions BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_references_insert AFTER INSERT ON character_references BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_references_update AFTER UPDATE ON character_references BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_references_delete AFTER DELETE ON character_references BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_folder_exclusions_insert AFTER INSERT ON character_folder_exclusions BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_folder_exclusions_update AFTER UPDATE ON character_folder_exclusions BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_character_folder_exclusions_delete AFTER DELETE ON character_folder_exclusions BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_asset_classifications_insert AFTER INSERT ON asset_classifications BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_asset_classifications_update AFTER UPDATE ON asset_classifications BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_asset_classifications_delete AFTER DELETE ON asset_classifications BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_asset_visibility AFTER UPDATE OF status,collected_at ON assets BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
CREATE TRIGGER mobile_asset_delete AFTER DELETE ON assets BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='characters';
END;
PRAGMA user_version = 74;
