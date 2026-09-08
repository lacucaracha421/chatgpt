CREATE TABLE collection_av_details (
    collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
    product_code TEXT CHECK(product_code IS NULL OR length(product_code) <= 120),
    label TEXT CHECK(label IS NULL OR length(label) <= 240),
    series TEXT CHECK(series IS NULL OR length(series) <= 240),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE TABLE collection_people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX collection_people_by_name ON collection_people(display_name);
CREATE TABLE collection_person_relations (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES collection_people(id),
    role TEXT NOT NULL CHECK(role IN ('performer', 'director')),
    sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
    credit_name TEXT CHECK(credit_name IS NULL OR length(credit_name) <= 120),
    PRIMARY KEY(collection_id, person_id, role),
    UNIQUE(collection_id, role, sort_order)
);
CREATE INDEX collection_person_relations_by_person ON collection_person_relations(person_id, collection_id);
PRAGMA user_version = 46;
