package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Classification authority receive on Android: baseline adoption and ordered change replay.
 *
 * This is the Android counterpart of the PC's `classification_reconciliation`, and it
 * keeps the same two invariants so the two replicas converge on the same state:
 *
 * 1. **Nothing local changes until a baseline is complete.** Every page of one frozen
 *    snapshot is accumulated outside the replica and only installed once the final
 *    assignment page reports `complete`, so a failed or interrupted walk leaves the
 *    previous replica exactly as it was.
 * 2. **A change page and its cursor commit together.** Contiguity is checked against the
 *    stored cursor inside the same transaction that writes the page, so the cursor can
 *    never advance over a change that was not applied.
 *
 * Android is already a replica, so this engine never compares a baseline against local
 * canonical state the way the main PC must at first adoption, and it has no outgoing
 * Classification intent to protect or replay: there is no Classification outbox in this
 * phase. That is the one structural difference from {@link AlbumAuthoritySync}, whose
 * store replays queued membership intents inside the same transactions.
 *
 * Classification differs from Album in three ways that the reader and the store must both
 * respect: assignment is single-valued per Asset, a delete arrives as one change carrying
 * both a tombstone and the assignment transition it performed, and the immutable
 * `originals` role rides on every baseline page because no command can produce it.
 *
 * Every failure is a coded {@link ClassificationReplica.Failure}, because the server's own
 * states share status codes: `cursorExpired`, `cursorAhead` and `baselineChanged` are all
 * 409 and all recover by adopting a fresh baseline, while `authorityInactive` and
 * `authorityContractUnsupported` must never be answered by writing anything.
 */
final class ClassificationAuthoritySync {
    /**
     * Attempts at one frozen baseline walk before deferring to the poll loop.
     *
     * Any Classification command advances the domain cursor, so a concurrent change
     * invalidates a frozen snapshot mid-walk. Retrying here converges once the domain is
     * briefly quiet; the foreground poll is the retry of last resort, so this stays bounded
     * rather than spinning.
     */
    static final int BASELINE_ATTEMPTS = 3;

    private final ClassificationReplica.Transport transport;
    private final ClassificationReplica.State state;
    private final ClassificationReplica.Clock clock;
    private final java.util.function.BooleanSupplier skipUnchanged;

    ClassificationAuthoritySync(ClassificationReplica.Transport transport,
                                ClassificationReplica.State state,
                                ClassificationReplica.Clock clock) {
        this(transport, state, clock, () -> false);
    }

    /** Only the coordinated foreground poll may omit an unchanged feed. Explicit
     * reconciliation still reads and validates it, even when status matches locally. */
    ClassificationAuthoritySync(ClassificationReplica.Transport transport,
            ClassificationReplica.State state, ClassificationReplica.Clock clock,
            java.util.function.BooleanSupplier skipUnchanged) {
        this.skipUnchanged = skipUnchanged;
        this.transport = transport;
        this.state = state;
        this.clock = clock;
    }

    /** Outcome of one reconciliation pass, for the status surface and the schedule. */
    static final class Result {
        /** True when an authority for this scope is stored in the replica. */
        boolean adopted;
        /** True when this pass installed a baseline (first adoption or re-adoption). */
        boolean adoptedBaseline;
        /** True when this pass replaced the replica because its identity changed. */
        boolean readopted;
        int appliedChanges;
        Long serverCursor;
        Long localCursor;
        String code;
        boolean retryable;
        String libraryId;
        long epoch;

        Map<String, Object> toJson() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("adopted", adopted);
            value.put("adoptedBaseline", adoptedBaseline);
            value.put("readopted", readopted);
            value.put("appliedChanges", appliedChanges);
            value.put("serverCursor", serverCursor);
            value.put("localCursor", localCursor);
            value.put("libraryId", libraryId);
            value.put("epoch", adopted ? epoch : null);
            value.put("code", code);
            value.put("retryable", retryable);
            return value;
        }
    }

    /**
     * The adopted Classification authority for this connection scope, or null.
     *
     * Read without any network access, so a consumer can ask "is this Android installation
     * a Classification replica yet" while offline.
     */
    ClassificationReplica.Adopted adopted(String scope) {
        return state.classificationAdopted(scope);
    }

    /** Diagnostic counts for `scope`, scoped for the same reason the reads are. */
    Map<String, Object> status(String scope) {
        return state.classificationStatus(scope);
    }

    /**
     * Live Classifications for `scope`, keyed by id. Never exposes tombstones as folders.
     *
     * The scope is a required argument rather than an implicit field on the engine, so a
     * replaced connection's rows cannot be read under the new one by forgetting a check.
     */
    Map<String, ClassificationReplica.Node> liveClassifications(String scope) {
        return state.classificationNodes(scope, true);
    }

    /** Assignment lineage state for `scope`, including authoritative unassigned rows. */
    Map<String, ClassificationReplica.Assignment> assignments(String scope) {
        return state.classificationAssignments(scope);
    }

    /** The adopted `originals` binding for `scope`, or null when unadopted. */
    String originals(String scope) {
        return state.classificationRole(scope);
    }

    /**
     * Discard this connection's Classification replica.
     *
     * Called only on an explicit connection change, and only for this domain's rows:
     * Album and Bookmark state for other scopes is a different question.
     */
    void reset() {
        state.clearClassifications();
    }

    /**
     * One reconcile pass: discover, adopt or catch up, then report.
     *
     * `scope` is the opaque connection identity the replica is stored under. It is compared
     * before anything is written, so rows written under another account can never be served
     * as this one's state.
     */
    Result reconcile(String scope) {
        Result result = new Result();
        ClassificationReplica.Adopted local = state.classificationAdopted(scope);
        result.adopted = local != null;
        if (local != null) {
            result.libraryId = local.libraryId;
            result.epoch = local.epoch;
            result.localCursor = local.cursor;
        }
        try {
            ClassificationReplica.Status status = discover();
            ClassificationReplica.Domain remote = status.domain();
            if (remote == null) {
                // No active `classifications` authority: the domain is still PC-owned, so
                // nothing is adopted and no existing replica is touched. The legacy mobile
                // Classification read path is unaffected and remains in charge.
                return result;
            }
            if (remote.contractVersion != ClassificationReplica.CONTRACT_VERSION) {
                // Fails closed: a contract this build does not implement must not be
                // approximated, and the stored replica is left alone.
                result.code = ClassificationReplica.CODE_CONTRACT_UNSUPPORTED;
                return result;
            }
            result.serverCursor = remote.cursor;
            result.libraryId = remote.libraryId;
            result.epoch = remote.epoch;
            if (local == null) {
                return adopt(scope, remote, result, false);
            }
            if (!local.libraryId.equals(remote.libraryId) || local.epoch != remote.epoch) {
                // A different library or epoch is a different authority, so the stored
                // cursor and rows describe something else. Re-adoption is the only correct
                // response; there is no incremental path across identities.
                return adopt(scope, remote, result, true);
            }
            if (local.contractVersion != remote.contractVersion) {
                return adopt(scope, remote, result, true);
            }
            if (local.cursor == remote.cursor && skipUnchanged.getAsBoolean()) return result;
            try {
                applyChanges(scope, local, result);
                return result;
            } catch (ClassificationReplica.Failure failure) {
                result.code = failure.code;
                result.retryable = failure.retryable;
                if (!recoverable(failure)) {
                    result.appliedChanges = 0;
                    ClassificationReplica.Adopted current = state.classificationAdopted(scope);
                    result.localCursor = current == null ? null : current.cursor;
                    return result;
                }
                // Expiry means retained history no longer covers this cursor, and a cursor
                // ahead of the server means the identity is skewed. Both recover the same
                // way — a fresh complete baseline replaces only this domain's replica.
                Result recovered = adopt(scope, remote, result, true);
                recovered.code = failure.code;
                return recovered;
            }
        } catch (ClassificationReplica.Failure failure) {
            result.code = failure.code;
            result.retryable = failure.retryable;
            return result;
        }
    }

    private static boolean recoverable(ClassificationReplica.Failure failure) {
        return ClassificationReplica.CODE_CURSOR_EXPIRED.equals(failure.code)
                || ClassificationReplica.CODE_CURSOR_AHEAD.equals(failure.code)
                || ClassificationReplica.CODE_BASELINE_CHANGED.equals(failure.code);
    }

    /** Read and validate the aggregate domain status. */
    private ClassificationReplica.Status discover() throws ClassificationReplica.Failure {
        Object document = get(ClassificationReplica.statusPath(), true);
        return ClassificationReplica.parseStatus(document);
    }

    /**
     * Walk every page of one frozen baseline, then install it in one transaction.
     *
     * `replace` distinguishes a first adoption from re-adoption after an identity change.
     * Neither path compares against existing local Classification state: on Android that
     * state *is* a replica, so a difference is convergence rather than data loss.
     */
    private Result adopt(String scope, ClassificationReplica.Domain remote, Result result,
                         boolean replace) throws ClassificationReplica.Failure {
        ClassificationReplica.Adopted previous = state.classificationAdopted(scope);
        int attempt = 0;
        while (true) {
            attempt++;
            try {
                Baseline baseline = fetch(remote);
                String now = clock.now();
                ClassificationReplica.Adopted authority = new ClassificationReplica.Adopted(scope,
                        remote.libraryId, remote.epoch, remote.contractVersion, baseline.cursor,
                        now, now);
                state.installBaseline(authority, baseline.classifications, baseline.assignments,
                        baseline.roles, now);
                result.adopted = true;
                result.adoptedBaseline = true;
                result.readopted = replace && previous != null;
                result.localCursor = baseline.cursor;
                // The adopted cursor is the snapshot's, not the `/status` reading from
                // before the walk: only the former describes the state just installed.
                result.serverCursor = baseline.cursor;
                result.libraryId = remote.libraryId;
                result.epoch = remote.epoch;
                result.code = null;
                return result;
            } catch (ClassificationReplica.Failure failure) {
                if (ClassificationReplica.CODE_BASELINE_CHANGED.equals(failure.code)
                        && attempt < BASELINE_ATTEMPTS) {
                    continue;
                }
                throw failure;
            }
        }
    }

    /** The complete Classification state a baseline describes, accumulated outside the replica. */
    private static final class Baseline {
        final List<ClassificationReplica.Node> classifications = new ArrayList<>();
        final List<ClassificationReplica.Assignment> assignments = new ArrayList<>();
        List<ClassificationReplica.Role> roles = new ArrayList<>();
        long cursor;
    }

    /**
     * Fetch every page of one frozen snapshot.
     *
     * A mutation between pages returns `baselineChanged`, and pages that report different
     * snapshot cursors cannot describe one materialized state, so both are rejected rather
     * than combined. Nothing has been written at this point, which is what makes "a failure
     * leaves the old replica untouched" true by construction.
     */
    private Baseline fetch(ClassificationReplica.Domain remote) throws ClassificationReplica.Failure {
        Baseline baseline = new Baseline();
        Long snapshot = null;
        String section = ClassificationReplica.SECTION_CLASSIFICATIONS;
        String after = null;
        List<ClassificationReplica.Role> roles = null;
        for (int page = 0; page < ClassificationReplica.MAX_PAGES; page++) {
            String path = ClassificationReplica.baselinePath(remote.libraryId, remote.epoch,
                    snapshot, snapshot == null ? null : section, after);
            ClassificationReplica.Page decoded = ClassificationReplica.parseBaselinePage(
                    get(path, false), remote.libraryId, remote.epoch, section);
            if (snapshot == null) {
                snapshot = decoded.snapshotCursor;
            } else if (decoded.snapshotCursor != snapshot.longValue()) {
                throw new ClassificationReplica.Failure(ClassificationReplica.CODE_BASELINE_CHANGED,
                        true);
            }
            // The role set is immutable authority state that no command can produce, so it
            // has no change row to be learned from and rides on every page. A page that
            // disagreed would mean the walk combined two different role states.
            if (roles == null) {
                roles = decoded.roles;
            } else if (!sameRoles(roles, decoded.roles)) {
                throw ClassificationReplica.malformed();
            }
            if (ClassificationReplica.SECTION_CLASSIFICATIONS.equals(decoded.section)) {
                if (baseline.classifications.size() + decoded.classifications.size()
                        > ClassificationReplica.MAX_CLASSIFICATIONS) {
                    throw ClassificationReplica.malformed();
                }
                baseline.classifications.addAll(decoded.classifications);
            } else {
                if (baseline.assignments.size() + decoded.assignments.size()
                        > ClassificationReplica.MAX_ASSIGNMENTS) {
                    throw ClassificationReplica.malformed();
                }
                baseline.assignments.addAll(decoded.assignments);
            }
            if (decoded.hasMore) {
                after = decoded.nextAfter;
                continue;
            }
            if (ClassificationReplica.SECTION_CLASSIFICATIONS.equals(section)) {
                section = ClassificationReplica.SECTION_ASSIGNMENTS;
                after = null;
                continue;
            }
            // The parser is what refuses a final assignment page that is not marked
            // complete, so no page subset can ever be mistaken for a whole baseline.
            baseline.roles = roles;
            baseline.cursor = decoded.snapshotCursor;
            return baseline;
        }
        throw ClassificationReplica.malformed();
    }

    private static boolean sameRoles(List<ClassificationReplica.Role> left,
                                     List<ClassificationReplica.Role> right) {
        if (left.size() != right.size()) return false;
        for (int i = 0; i < left.size(); i++) {
            if (!left.get(i).role.equals(right.get(i).role)
                    || !left.get(i).classificationId.equals(right.get(i).classificationId)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Apply the ordered change log until it is exhausted.
     *
     * Progress is measured against the cursor a page was *requested* from. Comparing a
     * freshly assigned cursor against itself can never fail, which would report every
     * honest `hasMore` as a protocol error and permanently cap catch-up at one page.
     */
    private void applyChanges(String scope, ClassificationReplica.Adopted local, Result result)
            throws ClassificationReplica.Failure {
        long cursor = local.cursor;
        for (int page = 0; page < ClassificationReplica.MAX_PAGES; page++) {
            long requested = cursor;
            ClassificationReplica.Changes changes = ClassificationReplica.parseChanges(
                    get(ClassificationReplica.changesPath(local.libraryId, local.epoch, requested),
                            false),
                    local.libraryId, local.epoch, requested);
            if (!changes.items.isEmpty()) {
                // Contiguity is checked by the store inside the same transaction that writes
                // the rows and the cursor, so the two cannot diverge.
                state.applyClassificationChanges(scope, requested, changes.items, clock.now());
                result.appliedChanges += changes.items.size();
                cursor = changes.nextAfter;
            }
            result.localCursor = cursor;
            if (!changes.hasMore) {
                if (changes.items.isEmpty()) state.touchClassification(scope, clock.now());
                return;
            }
            // A page claiming more work must have advanced past the cursor it was requested
            // from. The parser proves `hasMore` agrees with the advertised server cursor, but
            // that alone is not progress: a page with no rows and an unchanged cursor can
            // satisfy it, and answering it would request the same page forever.
            if (changes.nextAfter <= requested) throw ClassificationReplica.malformed();
        }
        // An unbounded walk is refused rather than continued: the poll loop retries.
        throw new ClassificationReplica.Failure(ClassificationReplica.CODE_CURSOR_EXPIRED, true);
    }

    /** One authenticated read, mapping rejected responses to their coded state. */
    private Object get(String path, boolean syncStatus) throws ClassificationReplica.Failure {
        String body;
        try {
            body = transport.get(path);
        } catch (ClassificationReplica.HttpFailure failure) {
            throw ClassificationReplica.mapFailure(failure.status, failure.body, syncStatus);
        } catch (Exception transportFailure) {
            throw new ClassificationReplica.Failure(ClassificationReplica.CODE_TRANSPORT, true);
        }
        try {
            return Json.parse(body);
        } catch (RuntimeException invalid) {
            throw ClassificationReplica.malformed();
        }
    }
}
