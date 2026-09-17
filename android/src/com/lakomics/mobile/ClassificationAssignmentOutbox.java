package com.lakomics.mobile;

import java.util.List;
import java.util.Map;

/**
 * Membership-only Android writer for Classification authority.
 *
 * One command only. The server's Classification route also accepts structural commands,
 * but those require the publisher role and the authority cannot yet enforce every
 * structural invariant itself, so Android's writer constructs `setAssetClassification`
 * and nothing else: there is no caller-supplied command name, no caller-supplied payload
 * and no structural path to reach. The class is the whole of Android's Classification
 * write surface.
 *
 * The writer differs from {@link AlbumMembershipOutbox} in exactly one behaviour, and it
 * is the one the domain requires: an assignment is a desired-state scalar, so an
 * *unaccepted* `revisionConflict` may be rebased onto the revision the authority actually
 * holds. Nothing else is auto-rebased — an authority, contract or malformed-response
 * failure keeps its intent and stays pending or blocked rather than guessing.
 *
 * It sends the bytes stored in the outbox row, never a re-encoded body: a payload that
 * changed representation between attempts could turn one logical operation into two.
 */
final class ClassificationAssignmentOutbox {
    /** The only Classification route this client may write to. */
    static final String COMMAND_PATH = "/v1/classifications/authority/commands";
    /** The one command this writer constructs. */
    static final String COMMAND_TYPE = "setAssetClassification";
    static final String CODE_PROTOCOL_INTEGRITY = "classificationCommandOutcomeUnknown";
    static final String CODE_TRANSPORT = "transport";

    /** The authority's code for an unaccepted compare-and-set failure, which may rebase. */
    static final String CODE_REVISION_CONFLICT = "revisionConflict";

    interface Transport {
        String put(String path, String payload) throws Exception;
    }

    static final class HttpFailure extends Exception {
        final int status;
        final String body;
        HttpFailure(int status, String body) {
            super("HTTP " + status);
            this.status = status;
            this.body = body;
        }
    }

    static final class Failure extends Exception {
        final String code;
        final boolean retryable;
        Failure(String code, boolean retryable) { super(code); this.code = code; this.retryable = retryable; }
        Failure(String code, boolean retryable, Throwable cause) { super(code, cause); this.code = code; this.retryable = retryable; }
    }

    static final class Flush {
        int sent;
        /** Accepted commands the authority already held the desired state for. */
        int noOp;
        /** Intents rebased onto the authority's current revision. Not a conflict. */
        int rebased;
        int pending;
        int blocked;
        boolean stopped;
    }

    private final Transport transport;
    private final LibraryReplicaStore store;
    private final ClassificationReplica.Clock clock;

    ClassificationAssignmentOutbox(Transport transport, LibraryReplicaStore store,
                                   ClassificationReplica.Clock clock) {
        this.transport = transport;
        this.store = store;
        this.clock = clock;
    }

    /**
     * Send pending Classification assignment intents, oldest first, stopping at the first
     * unresolved one.
     *
     * Stopping is the point: assignment intents for one Asset are ordered, and each
     * successor's expectation only exists because its predecessor is ahead of it, so
     * sending around an unresolved row could present a revision the queue ahead of it owns.
     */
    Flush flush(String scope) throws Failure {
        Flush report = new Flush();
        ClassificationReplica.Adopted authority = store.classificationAdopted(scope);
        if (authority == null) return report;
        List<ReplicaDb.ClassificationAssignment> rows = store.classificationOutbox(scope);
        for (ReplicaDb.ClassificationAssignment row : rows) {
            if (row.blocked()) report.blocked++;
            else report.pending++;
        }
        for (ReplicaDb.ClassificationAssignment row : rows) {
            if (row.blocked()) { report.stopped = true; return report; }
            // The frozen payload and the row's own columns must agree. A row whose stored
            // bytes describe another authority identity is not a command this build may
            // send, and re-encoding it would send something the user never queued.
            PayloadIdentity identity = payloadIdentity(row.payload);
            if (!row.libraryId.equals(identity.libraryId)
                    || row.epoch != identity.epoch
                    || row.contractVersion != identity.contractVersion
                    || !COMMAND_TYPE.equals(identity.commandType)
                    || !row.operationId.equals(identity.operationId)
                    || !row.assetId.equals(identity.assetId)
                    || !java.util.Objects.equals(row.classificationId, identity.classificationId)
                    || row.expectedRevision != identity.expectedRevision) {
                throw integrity();
            }
            if (!authority.libraryId.equals(row.libraryId)) {
                store.blockClassificationAssignment(scope, row.seq,
                        ClassificationReplica.CODE_LIBRARY_MISMATCH, null);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return report;
            }
            if (row.epoch != authority.epoch) {
                store.blockClassificationAssignment(scope, row.seq, "epochMismatch", null);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return report;
            }
            if (row.contractVersion != authority.contractVersion) {
                store.blockClassificationAssignment(scope, row.seq,
                        ClassificationReplica.CODE_CONTRACT_UNSUPPORTED, null);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return report;
            }
            final String body;
            try {
                body = transport.put(COMMAND_PATH, row.payload);
            } catch (HttpFailure rejected) {
                String code = detailCode(rejected.body);
                if (CODE_REVISION_CONFLICT.equals(code)) {
                    // The rejected command was never accepted or receipted, and an
                    // assignment's whole meaning is its desired value, so presenting the
                    // same logical intent against the authority's current revision is
                    // legal. The row keeps its operation id and payload identity; only the
                    // expectation moves, and the pass stops so the retry is the next step.
                    long current = conflictRevision(rejected.body, row);
                    store.rebaseClassificationAssignment(scope, row.seq, current, clock.now());
                    report.rebased++;
                    report.stopped = true;
                    return report;
                }
                if (isBlockingRejection(code)) {
                    store.blockClassificationAssignment(scope, row.seq, code, rejected.body);
                    report.pending--;
                    report.blocked++;
                    report.stopped = true;
                    return report;
                }
                if (rejected.status == 401 || rejected.status == 403) {
                    throw new Failure(ClassificationReplica.CODE_UNAUTHORIZED, false, rejected);
                }
                // An uncoded or unknown rejection is retryable rather than blocked:
                // `invalidClassificationAssignment` in particular is a transient
                // cross-domain ordering state — Asset replication has not reached the
                // server yet — that resolves itself, so refusing the user's intent
                // permanently would be wrong.
                throw new Failure(code == null ? CODE_TRANSPORT : code, true, rejected);
            } catch (Exception unavailable) {
                throw new Failure(CODE_TRANSPORT, true, unavailable);
            }
            Accepted accepted = parseAccepted(body, row, authority);
            store.confirmClassificationAssignment(scope, row.seq, accepted.assignment,
                    clock.now());
            report.pending--;
            if (accepted.changed) report.sent++; else report.noOp++;
        }
        return report;
    }

    /**
     * Coded rejections that must durably block the intent rather than be retried.
     *
     * Every code here is the authority refusing the *content* of a command the user can act
     * on, so the intent is preserved for a decision. Everything else — including codes this
     * build does not recognize — stays pending with the identical operation id and payload.
     */
    private static boolean isBlockingRejection(String code) {
        if (code == null) return false;
        switch (code) {
            case "classificationNotFound":
                return true;
            default:
                return false;
        }
    }

    /** The `detail.code` of a rejected response, or null when it names none. */
    private static String detailCode(String body) {
        try {
            Map<String, Object> root = object(Json.parse(body));
            Map<String, Object> detail = object(root.get("detail"));
            Object code = detail.get("code");
            return code instanceof String ? (String) code : null;
        } catch (RuntimeException malformed) {
            return null;
        }
    }

    /**
     * The authoritative assignment revision a `revisionConflict` reported.
     *
     * The projection must describe the *same* Asset this intent targets. A conflict body
     * naming another Asset does not belong to this command, and rebasing onto it would
     * replace a correct expectation with a foreign revision — so that is refused as a
     * protocol integrity failure, exactly as the PC's own rebase does.
     */
    private static long conflictRevision(String body, ReplicaDb.ClassificationAssignment row)
            throws Failure {
        try {
            Map<String, Object> root = object(Json.parse(body));
            Map<String, Object> detail = object(root.get("detail"));
            if (!CODE_REVISION_CONFLICT.equals(string(detail, "code"))) throw integrity();
            Map<String, Object> current = object(detail.get("current"));
            if (!row.assetId.equals(string(current, "assetId"))) throw integrity();
            long revision = number(current, "entityRevision");
            if (revision < 0) throw integrity();
            // The desired value is deliberately not compared with the row's: a rebase means
            // the authority's *current* value differs from the requested one, so requiring
            // them to match would refuse every real conflict.
            return revision;
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    private static final class PayloadIdentity {
        final String libraryId;
        final long epoch;
        final long contractVersion;
        final String commandType;
        final String operationId;
        final String assetId;
        final String classificationId;
        final long expectedRevision;

        PayloadIdentity(String libraryId, long epoch, long contractVersion, String commandType,
                        String operationId, String assetId, String classificationId,
                        long expectedRevision) {
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.commandType = commandType;
            this.operationId = operationId;
            this.assetId = assetId;
            this.classificationId = classificationId;
            this.expectedRevision = expectedRevision;
        }
    }

    private static PayloadIdentity payloadIdentity(String payload) throws Failure {
        try {
            Map<String, Object> root = object(Json.parse(payload));
            Object classification = root.get("classificationId");
            if (classification != null && !(classification instanceof String)) throw integrity();
            return new PayloadIdentity(string(root, "libraryId"), number(root, "epoch"),
                    number(root, "contractVersion"), string(root, "commandType"),
                    string(root, "operationId"), string(root, "assetId"),
                    (String) classification, number(root, "expectedRevision"));
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    private static final class Accepted {
        final boolean changed;
        final ClassificationReplica.Assignment assignment;
        Accepted(boolean changed, ClassificationReplica.Assignment assignment) {
            this.changed = changed;
            this.assignment = assignment;
        }
    }

    /**
     * Prove a 200 is an acceptance of *this* intent before the durable row is retired.
     *
     * The row is deleted by sequence and the returned revision becomes confirmed lineage, so
     * an echo naming another operation, Asset, epoch or contract would retire the wrong
     * intent and record state belonging to something else. Every identity field must agree
     * exactly, and the returned projection must be the one shape this command produces.
     */
    private static Accepted parseAccepted(String body, ReplicaDb.ClassificationAssignment row,
                                          ClassificationReplica.Adopted authority) throws Failure {
        try {
            Map<String, Object> root = object(Json.parse(body));
            if (!authority.libraryId.equals(string(root, "libraryId"))
                    || authority.epoch != number(root, "epoch")
                    || authority.contractVersion != number(root, "contractVersion")
                    || !COMMAND_TYPE.equals(string(root, "commandType"))
                    || !row.operationId.equals(string(root, "operationId"))) {
                throw integrity();
            }
            boolean changed = bool(root, "changed");
            long cursor = number(root, "authorityCursor");
            if (cursor < 0) throw integrity();
            // A changed command occupies exactly one sequence, and the server reports that
            // sequence as both `changeSequence` and `authorityCursor`; an accepted no-op
            // reports no sequence at all and leaves the cursor where it was.
            Object sequence = root.get("changeSequence");
            if (changed) {
                if (!(sequence instanceof Long) || ((Long) sequence) != cursor || cursor < 1) {
                    throw integrity();
                }
            } else if (sequence != null) {
                throw integrity();
            }
            // An assignment command touches no Classification and performs no transition:
            // it moves one Asset's own lineage only.
            if (root.containsKey("classification") && root.get("classification") != null) {
                throw integrity();
            }
            if (root.containsKey("assignmentTransition")
                    && root.get("assignmentTransition") != null) {
                throw integrity();
            }
            List<Object> assignments = list(root, "assignments");
            if (assignments.size() != 1) throw integrity();
            Map<String, Object> assignment = object(assignments.get(0));
            String assetId = string(assignment, "assetId");
            Object desired = assignment.get("classificationId");
            if (desired != null && !(desired instanceof String)) throw integrity();
            long revision = number(assignment, "entityRevision");
            if (revision < 0 || !row.assetId.equals(assetId)
                    || !java.util.Objects.equals(row.classificationId, desired)) {
                throw integrity();
            }
            // A changed assignment is a real state change, so the authority must have advanced
            // the lineage by exactly one from the expectation this command presented. Anything
            // else means the echo does not describe this command: a smaller revision would
            // regress the confirmed lineage, and a larger one would skip a state the replica
            // never saw and could not present again.
            //
            // A no-op carries no such rule. The authority accepts an already-matching desired
            // state *without* comparing revisions, so another device may have made the same
            // change first and the reported revision can legitimately be higher than this
            // command's expectation. Requiring equality would refuse a perfectly correct
            // acceptance and strand the intent.
            if (changed && revision != row.expectedRevision + 1) throw integrity();
            return new Accepted(changed, new ClassificationReplica.Assignment(assetId,
                    (String) desired, revision));
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    private static Failure integrity() { return new Failure(CODE_PROTOCOL_INTEGRITY, true); }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) throw new IllegalArgumentException("Expected object");
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Map<String, Object> value, String key) {
        Object item = value.get(key);
        if (!(item instanceof List)) throw new IllegalArgumentException("Expected list");
        return (List<Object>) item;
    }

    private static String string(Map<String, Object> value, String key) {
        Object item = value.get(key);
        if (!(item instanceof String)) throw new IllegalArgumentException("Expected string");
        return (String) item;
    }

    private static long number(Map<String, Object> value, String key) {
        Object item = value.get(key);
        if (!(item instanceof Long)) throw new IllegalArgumentException("Expected integer");
        return (Long) item;
    }

    private static boolean bool(Map<String, Object> value, String key) {
        Object item = value.get(key);
        if (!(item instanceof Boolean)) throw new IllegalArgumentException("Expected boolean");
        return (Boolean) item;
    }
}
