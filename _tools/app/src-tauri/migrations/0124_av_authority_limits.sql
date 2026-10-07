-- Align editable AV text with the authority contract. The migration runner disables
-- foreign keys outside its transaction, and checks every reference before commit.
-- Create/copy/drop/rename avoids retargeting child foreign keys or firing old triggers.
-- Retain the old product-code storage bound so existing local values are not lost;
-- new saves enforce the server's 64-character limit before entering the transaction.
CREATE TABLE collection_av_details_new (
    collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
    product_code TEXT CHECK(product_code IS NULL OR length(product_code) <= 120),
    label TEXT CHECK(label IS NULL OR length(label) <= 500),
    series TEXT CHECK(series IS NULL OR length(series) <= 500),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    title_ja TEXT,
    release_date TEXT,
    maker TEXT,
    genres_json TEXT
);
INSERT INTO collection_av_details_new SELECT * FROM collection_av_details;
DROP TABLE collection_av_details;
ALTER TABLE collection_av_details_new RENAME TO collection_av_details;

CREATE TABLE collection_people_new (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    name_ja TEXT,
    wikidata_id TEXT,
    fanza_actress_id TEXT,
    memo TEXT CHECK(memo IS NULL OR length(memo) <= 2000)
);
INSERT INTO collection_people_new SELECT * FROM collection_people;
DROP TABLE collection_people;
ALTER TABLE collection_people_new RENAME TO collection_people;
CREATE INDEX collection_people_by_name ON collection_people(display_name);
CREATE INDEX collection_people_ja ON collection_people(name_ja);
CREATE INDEX collection_people_wikidata ON collection_people(wikidata_id);
CREATE INDEX collection_people_fanza ON collection_people(fanza_actress_id);
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

CREATE TABLE collection_person_relations_new (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES collection_people(id),
    role TEXT NOT NULL CHECK(role IN ('performer', 'director')),
    sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
    credit_name TEXT CHECK(credit_name IS NULL OR length(credit_name) <= 500),
    PRIMARY KEY(collection_id, person_id, role),
    UNIQUE(collection_id, role, sort_order)
);
INSERT INTO collection_person_relations_new SELECT * FROM collection_person_relations;
DROP TABLE collection_person_relations;
ALTER TABLE collection_person_relations_new RENAME TO collection_person_relations;
CREATE INDEX collection_person_relations_by_person ON collection_person_relations(person_id, collection_id);
PRAGMA user_version = 124;
