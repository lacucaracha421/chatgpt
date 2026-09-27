-- Endpoint-scoped content revisions, retry schedule and atomic wishlist receive cursor.
-- JSON keeps this small checkpoint independent of the published domain schemas.
CREATE TABLE home_publication_state (
 endpoint TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('upcoming','avPick','artists')),
 state_json TEXT NOT NULL,
 PRIMARY KEY(endpoint, kind)
) WITHOUT ROWID;
PRAGMA user_version = 109;
