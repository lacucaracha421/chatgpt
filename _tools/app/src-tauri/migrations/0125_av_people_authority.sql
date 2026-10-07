-- Person CAS state and immutable portrait bytes are local authority transport data.
CREATE TABLE collection_authority_people_cache (
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, person_id TEXT NOT NULL,
 revision INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,person_id)
);
CREATE TABLE collection_authority_portrait_blobs (
 sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL
);
-- Capture PC choices before receiving server projections. Queuing and the checkpoint
-- share a transaction, so interrupted reconciliation never duplicates an intent.
CREATE TABLE collection_authority_people_reconcile (
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, person_id TEXT NOT NULL,
 local_payload TEXT NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(library_id,epoch,person_id)
);
PRAGMA user_version = 125;
