-- Collections publication carries PC records, cover focus and performer data from 0117 on;
-- their writes mark the publication changed exactly like the 0074 triggers. Additive only.
CREATE TRIGGER mobile_collection_pc_records_insert AFTER INSERT ON collection_pc_records BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_pc_records_update AFTER UPDATE ON collection_pc_records BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_pc_records_delete AFTER DELETE ON collection_pc_records BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_volume_cover_focus_insert AFTER INSERT ON collection_volume_cover_focus BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_volume_cover_focus_update AFTER UPDATE ON collection_volume_cover_focus BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_volume_cover_focus_delete AFTER DELETE ON collection_volume_cover_focus BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_people_insert AFTER INSERT ON collection_people BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_people_update AFTER UPDATE ON collection_people BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_people_delete AFTER DELETE ON collection_people BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_person_profiles_insert AFTER INSERT ON collection_person_profiles BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_person_profiles_update AFTER UPDATE ON collection_person_profiles BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_person_profiles_delete AFTER DELETE ON collection_person_profiles BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_person_portraits_insert AFTER INSERT ON collection_person_portraits BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_person_portraits_update AFTER UPDATE ON collection_person_portraits BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_collection_person_portraits_delete AFTER DELETE ON collection_person_portraits BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_av_favorite_performers_insert AFTER INSERT ON av_favorite_performers BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_av_favorite_performers_update AFTER UPDATE ON av_favorite_performers BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
CREATE TRIGGER mobile_av_favorite_performers_delete AFTER DELETE ON av_favorite_performers BEGIN
 UPDATE mobile_publication_state SET generation=generation+1,
 first_dirty=CASE WHEN generation=published_generation THEN unixepoch() ELSE first_dirty END,
 last_dirty=unixepoch() WHERE kind='collections';
END;
PRAGMA user_version = 117;
