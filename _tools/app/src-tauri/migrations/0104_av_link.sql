ALTER TABLE collection_av_details ADD COLUMN title_ja TEXT;
ALTER TABLE collection_av_details ADD COLUMN release_date TEXT;
ALTER TABLE collection_av_details ADD COLUMN maker TEXT;
ALTER TABLE collection_av_details ADD COLUMN genres_json TEXT;
ALTER TABLE collection_people ADD COLUMN name_ja TEXT;
ALTER TABLE collection_people ADD COLUMN wikidata_id TEXT;
ALTER TABLE collection_people ADD COLUMN fanza_actress_id TEXT;
CREATE INDEX collection_people_ja ON collection_people(name_ja);
CREATE INDEX collection_people_wikidata ON collection_people(wikidata_id);
CREATE INDEX collection_people_fanza ON collection_people(fanza_actress_id);

CREATE TABLE av_link_inbox (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    product_code TEXT NOT NULL,
    normalized_code TEXT,
    source_url TEXT,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','fetching','found','not_found','error','dismissed','applied')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    fetched_at TEXT,
    collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX av_link_inbox_due ON av_link_inbox(status,next_attempt_at);
CREATE TABLE av_link_candidates (
    inbox_id TEXT PRIMARY KEY REFERENCES av_link_inbox(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL,
    jacket_path TEXT NOT NULL,
    jacket_width INTEGER NOT NULL,
    jacket_height INTEGER NOT NULL,
    split_x1 INTEGER NOT NULL,
    split_x2 INTEGER NOT NULL,
    names_json TEXT NOT NULL
);
CREATE TABLE av_link_poll_cursor (
    endpoint TEXT PRIMARY KEY,
    after_sequence INTEGER NOT NULL DEFAULT 0,
    last_poll_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE av_link_name_cache (
    name_ja TEXT PRIMARY KEY,
    mapping_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
PRAGMA user_version = 104;
