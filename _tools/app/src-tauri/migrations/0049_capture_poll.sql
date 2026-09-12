CREATE TABLE cloud_capture_poll_cursor (
    endpoint TEXT PRIMARY KEY,
    after_id TEXT NOT NULL
);
CREATE TABLE cloud_capture_retry (
    endpoint TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    retry_after INTEGER NOT NULL,
    PRIMARY KEY(endpoint, capture_id)
);

CREATE TABLE cloud_capture_reviews (
    endpoint TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    review_id TEXT NOT NULL REFERENCES similarity_reviews(id),
    PRIMARY KEY(endpoint, capture_id)
);

PRAGMA user_version = 49;
