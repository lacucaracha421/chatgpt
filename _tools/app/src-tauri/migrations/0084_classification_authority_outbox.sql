-- Classification authority 2B.1: PC durable command outbox.
--
-- This is the send half. 2B taught the PC to *receive* the server's Classification
-- authority; it deliberately shipped no queue, because the local mutation rewiring
-- that would give a queue work to do belongs to this batch. Migration 0083 documents
-- that an empty `classification_authority_sync` table means Classification authority
-- was never adopted, and that convention is unchanged: with no adopted authority
-- every local Classification mutation still writes `classification_entries` /
-- `asset_classifications` directly and the legacy publication lane remains in charge.
--
-- # One row is one logical intent
--
-- `operation_id` is minted when the local mutation commits and is reused verbatim on
-- every retry, so the server's `(library_id, epoch, operation_id)` receipt resolves a
-- lost response instead of recording a second logical write. `payload` is the exact
-- command body, serialized once at enqueue time: re-serializing at send time could let
-- a representation change between attempts turn one intent into two, and storing the
-- bytes is what makes "the same operation id with different content" impossible to
-- introduce by accident.
--
-- Rows are *never* coalesced. Classification commands are ordered and dependent —
-- `create X -> rename X -> move X -> assign Asset -> X` must reach the server in that
-- order, and a later command's `expectedRevision` only exists because its predecessors
-- are ahead of it — so the queue is strict FIFO and one accepted mutation appends one
-- row. This is the same reason Album's queue is strict FIFO and unlike the bookmark
-- outbox, which keeps one intent per entity because the newest desired state is the
-- whole meaning of a toggle.
--
-- # One assignment command per Asset
--
-- `setAssetClassification` is keyed by the Asset and its desired value is a single
-- Classification or NULL. A multi-Asset UI request therefore produces one row per
-- changed Asset; `asset_id` is stored so the queue can be read without decoding every
-- payload, and it is NULL for structural commands that have no Asset subject.
--
-- # state
--
-- `pending` is a retryable intent. `blocked` is one the authority rejected on
-- structural grounds: it keeps its payload, its operation id and the optimistic local
-- effect, and it stops FIFO delivery, because a later command may depend on it.
-- Automatic rebasing applies to exactly one case — an assignment `revisionConflict`,
-- which rewrites only the pending payload's `expectedRevision` — and never to a
-- structural edit, where choosing a winner is a user decision.

CREATE TABLE classification_authority_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_id TEXT NOT NULL UNIQUE,
 command_type TEXT NOT NULL CHECK(command_type IN (
   'createClassification',
   'renameClassification',
   'moveClassification',
   'updateClassificationAppearance',
   'deleteClassification',
   'setAssetClassification'
 )),
 classification_id TEXT,
 asset_id TEXT,
 epoch INTEGER NOT NULL CHECK(epoch >= 1),
 payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','blocked')),
 conflict_code TEXT,
 conflict_detail TEXT,
 created_at TEXT NOT NULL,
 -- A structural command names the Classification it targets; an assignment command
 -- names the Asset it targets. Requiring the right subject per command keeps a row
 -- from describing a command whose own key is missing, which would make the send
 -- half unable to validate a response against the stored intent.
 CHECK (
   (command_type = 'setAssetClassification' AND asset_id IS NOT NULL)
   OR (command_type <> 'setAssetClassification' AND classification_id IS NOT NULL)
 )
);

-- Deterministic send order: strictly oldest first. `seq` is unique by construction, so
-- no tiebreaker is needed, and the index makes "the oldest pending row" a lookup
-- rather than a scan as the queue grows.
CREATE INDEX classification_authority_outbox_order ON classification_authority_outbox(seq);
CREATE INDEX classification_authority_outbox_pending
 ON classification_authority_outbox(state, seq);

PRAGMA user_version = 84;
