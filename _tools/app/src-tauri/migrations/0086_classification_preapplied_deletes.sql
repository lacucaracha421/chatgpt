-- Classification authority 2E.1: durable record of pre-applied delete transitions.
--
-- # The problem this exists for
--
-- A `deleteClassification` change carries two parts: the Classification tombstone and the
-- aggregate reassignment (`assignmentTransition`) that moved every Asset naming the deleted
-- Classification. The replica must verify that transition before advancing the cursor over
-- it: the server's `affectsAssignments` counts the assignments naming the Classification
-- *when the server deleted it*, and a page claiming a different amount of work is either a
-- malformed response or a replica that cannot reproduce the authority's state.
--
-- The send half already applies the same transition to the assignment cache when the delete
-- command is *confirmed*, because the accepted result describes the authority's post-delete
-- lineage. So by the time the delete change is replayed, part of that work may be done, and
-- part of it may have become moot — a change the server ordered *earlier* but this replica has
-- not replayed yet can have moved a lineage back out of the deleted Classification.
--
-- A recomputed local count cannot verify the transition, because it cannot tell those two
-- cases apart. Consider a replica whose stale cache says `A -> C`. It deletes `C`; confirmation
-- pre-applies `A -> C`'s lineage to `C`'s parent. But the server's own history has another
-- device move `A` out of `C` at an earlier sequence this replica has not seen, so the server's
-- delete finds *no* lineage naming `C` and reports `affectsAssignments = 0`. Any local count
-- reads that as a disagreement and rejects valid history.
--
-- # What a row means
--
-- One row records, for one confirmed delete, the `affectsAssignments` the *authority itself*
-- reported in the accepted result — the count it used when it ran the transition — together
-- with the sequence it assigned the change. Replay for the matching change then requires:
--
--   * the change's own `affectsAssignments` to equal the recorded one, so a page cannot claim
--     a different amount of work than the authority's own durable statement about it; and
--   * `0 <= affectsAssignments - stillNaming <= preapplied_moved`, where `stillNaming` is the
--     lineages still naming the deleted Classification and `preapplied_moved` is how many the
--     pre-application itself moved.
--
-- That last bound is the whole verification, and both sides are real. The authority saw
-- `affectsAssignments` lineages; locally those are exactly the pre-applied ones that *survive*
-- (a change the authority ordered earlier may have superseded some) plus the ones still naming
-- `from`. The surviving count cannot exceed what was pre-applied, so `affects - stillNaming`
-- has to land in `[0, preapplied_moved]`. Both ends catch real corruption: too high means the
-- replica is missing the history that moved lineages away, too low means it is holding
-- lineages the authority's own delete never accounted for.
--
-- When *no* row matches, nothing can explain either a shortfall or a surplus, so exactly
-- `affectsAssignments` lineages must still be here.
--
-- # Identity
--
-- Keyed by `(operation_id, epoch)` and carrying the transition's own endpoints. The operation
-- id is minted once per logical intent and reused verbatim on every retry, and the epoch
-- scopes it to one authority identity, so a row cannot be matched by a different delete or a
-- re-activated authority. `from`/`to` are re-checked against the incoming transition as well,
-- so a row that somehow described a different Classification is refused rather than trusted.
--
-- `change_sequence` is what orders the row against the change log. It is present only for a
-- delete the authority reported as *changed*: an accepted no-op has no change to replay, so
-- there is nothing to account for later.
--
-- # Why the count is not derived from the tombstone
--
-- The count is the authority's accepted result, not something this PC inferred from local
-- state and not something read back from the tombstone — the replay writes the tombstone in
-- the same iteration, so trusting it would make the verification unfalsifiable.
--
-- # Lifecycle
--
-- A row is retired when its change is replayed, and cleared whenever the assignment caches
-- are replaced wholesale (a baseline install). Both are the points at which the transition
-- can no longer need to be accounted for: after a replay the change is behind the cursor, and
-- a baseline supersedes the cache the pre-application moved. Rows are never consulted on the
-- ordinary path, so an absent row means "no pre-application", which is the correct reading
-- for every delete this PC did not itself confirm.

CREATE TABLE classification_authority_preapplied_deletes (
 operation_id TEXT NOT NULL,
 epoch INTEGER NOT NULL CHECK(epoch >= 1),
 change_sequence INTEGER NOT NULL CHECK(change_sequence >= 1),
 from_classification_id TEXT NOT NULL,
 to_classification_id TEXT,
 affects_assignments INTEGER NOT NULL CHECK(affects_assignments >= 0),
 preapplied_moved INTEGER NOT NULL CHECK(preapplied_moved >= 0),
 created_at TEXT NOT NULL,
 PRIMARY KEY (operation_id, epoch)
);

CREATE INDEX classification_authority_preapplied_delete_covers
 ON classification_authority_preapplied_deletes(epoch, from_classification_id, change_sequence);

PRAGMA user_version = 86;
