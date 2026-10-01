-- Manga index preferences travel with the library. Identity keeps catalog namespaces.
CREATE TABLE manga_index_pins (
 kind TEXT NOT NULL CHECK(kind IN ('tag', 'artist')),
 namespace TEXT NOT NULL,
 value TEXT NOT NULL CHECK(length(trim(value)) > 0),
 label TEXT NOT NULL CHECK(length(trim(label)) > 0),
 created_at TEXT NOT NULL,
 PRIMARY KEY(kind, namespace, value),
 CHECK((kind = 'artist' AND namespace = 'artist') OR
       (kind = 'tag' AND length(trim(namespace)) > 0 AND namespace <> 'artist'))
) WITHOUT ROWID;
PRAGMA user_version = 118;
