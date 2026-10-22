-- Library-local derived bookstore images; never part of Collection authority.
CREATE TABLE manga_spine_scans (
    isbn13 TEXT PRIMARY KEY NOT NULL CHECK(length(isbn13) = 13 AND isbn13 NOT GLOB '*[^0-9]*'),
    status TEXT NOT NULL CHECK(status IN ('real', 'missing', 'not_found', 'error')),
    side INTEGER NOT NULL DEFAULT 0 CHECK(side IN (0, 1)),
    back INTEGER NOT NULL DEFAULT 0 CHECK(back IN (0, 1)),
    checked_at INTEGER NOT NULL
);
PRAGMA user_version = 139;
