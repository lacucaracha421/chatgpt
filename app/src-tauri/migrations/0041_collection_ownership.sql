CREATE TABLE collection_volume_ownership (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    volume_number INTEGER NOT NULL CHECK(volume_number > 0),
    edition_index INTEGER NOT NULL CHECK(edition_index BETWEEN 0 AND 3),
    physical INTEGER NOT NULL DEFAULT 0 CHECK(physical IN (0, 1)),
    digital INTEGER NOT NULL DEFAULT 0 CHECK(digital IN (0, 1)),
    PRIMARY KEY(collection_id, volume_number, edition_index)
);
PRAGMA user_version = 41;
