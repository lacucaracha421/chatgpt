package com.lakomics.mobile;

import java.util.List;

/**
 * One foreground pass across both authority domains, with independent failure boundaries.
 *
 * # Why this is separate from {@link AlbumReplicaService}
 *
 * Album and Classification are different authorities: separate adoption rows, separate
 * cursors, separate outboxes, separate server state. They share only a transport and a
 * store. Running them inside one `try` block made them share a *failure boundary* too — an
 * exception while delivering an Album membership mutation skipped the Classification pass
 * for that whole cycle, even though nothing about Classification was broken and its own
 * prerequisites were intact. The reverse is just as wrong: a Classification failure must
 * not suppress Album convergence or change the Album result.
 *
 * The ordering requirement is real but weaker than the boundary: within a domain the queue
 * is flushed before the receive, and Album is attempted before Classification. What is *not*
 * required is that Classification be skipped when Album fails. So each lane is entered
 * through its own body, every failure a lane can raise is contained by that lane, and
 * neither lane can observe the other's exception.
 *
 * This class is Android-free on purpose: it is the orchestration that decides those
 * boundaries, and the defect it fixes is a boundary defect, so it is checked on the plain
 * JVM rather than through an activity — the same reasoning as {@link ForegroundSchedule}.
 * It owns no thread, timer or lock; the caller decides when a pass runs.
 *
 * # What is deliberately not caught
 *
 * A lane failure is contained, but the pass never *flattens* every throwable. {@link Error}
 * is not a {@link RuntimeException} and propagates untouched, and the containment is a
 * `catch` that never calls {@link Thread#interrupted()} or otherwise clears the interrupt
 * flag — so a thread being torn down still observes its own cancellation. Wrapping a lane
 * failure into a code must not convert cancellation into "the merge failed, retry later".
 */
final class AuthorityPass {

    /**
     * What the Album lane reported: its own result, or the code that stands in for it.
     *
     * A lane that did not receive reports a **code with no result** — the queue was not
     * clean, so no receive happened and no receive result exists. Keeping the two fields
     * separate is what lets the status surface distinguish "nothing was received" from
     * "a pass completed and reported state".
     */
    static final class AlbumReport {
        final AlbumAuthoritySync.Result result;
        final String code;

        AlbumReport(AlbumAuthoritySync.Result result, String code) {
            this.result = result;
            this.code = code;
        }
    }

    /** What the Classification lane reported, with the same result-versus-code split. */
    static final class ClassificationReport {
        final ClassificationAuthoritySync.Result result;
        final String code;

        ClassificationReport(ClassificationAuthoritySync.Result result, String code) {
            this.result = result;
            this.code = code;
        }
    }

    /**
     * Both lanes' reports. A lane that threw reports its coded failure; a lane that ran
     * normally reports whatever it decided. One lane's report is never derived from the
     * other lane's outcome.
     */
    static final class Outcome {
        /** True once the Album lane was attempted, whether or not its body threw. */
        boolean albumRan;
        AlbumReport album;

        /** True once the Classification lane was attempted, whether or not its body threw. */
        boolean classificationRan;
        ClassificationReport classification;
    }

    /** The Album lane body. Declares exactly what that lane fails with. */
    interface AlbumLane {
        AlbumReport run() throws AlbumMembershipOutbox.Failure;
    }

    /** The Classification lane body. Declares exactly what that lane fails with. */
    interface ClassificationLane {
        ClassificationReport run() throws ClassificationAssignmentOutbox.Failure;
    }

    private AuthorityPass() {}

    /**
     * Attempt both lanes, containing each lane's failure within that lane.
     *
     * The lanes run **serially**, Album first, matching the pass order the status surface
     * documents. The guarantee here is exactly `an Album failure does not suppress or skip the
     * Classification lane` — it is a *failure* boundary, not a scheduling one. A slow or blocked
     * Album write still delays Classification for that cycle, because Classification is attempted
     * only after Album returns; parallelizing the two lanes is deliberately not attempted here.
     *
     * Before this, both lanes shared one outer `try`, so an ordinary recoverable Album delivery
     * failure meant Classification did not run at all that cycle even though nothing about
     * Classification was broken.
     */
    static Outcome run(AlbumLane album, ClassificationLane classification) {
        Outcome outcome = new Outcome();

        outcome.albumRan = true;
        try {
            outcome.album = album.run();
        } catch (AlbumMembershipOutbox.Failure failure) {
            outcome.album = new AlbumReport(null, failure.code);
        } catch (RuntimeException unavailable) {
            // A replica store that cannot be opened is reported once per pass. It never
            // falls back to another database and never touches user media. This mapping is
            // the one the single-lane pass already used; only the boundary moved.
            outcome.album = new AlbumReport(null, AlbumReplica.CODE_STORE_UNAVAILABLE);
        }

        outcome.classificationRan = true;
        try {
            outcome.classification = classification.run();
        } catch (ClassificationAssignmentOutbox.Failure failure) {
            outcome.classification = new ClassificationReport(null, failure.code);
        } catch (RuntimeException unavailable) {
            outcome.classification = new ClassificationReport(null,
                    ClassificationReplica.CODE_STORE_UNAVAILABLE);
        }

        return outcome;
    }

    /** First blocked code in an Album queue, or null when nothing is blocked. */
    static String albumBlockedCode(List<ReplicaDb.OutboxRow> rows) {
        for (ReplicaDb.OutboxRow row : rows) {
            if (row.blocked()) {
                return row.conflictCode == null ? "albumWriteConflict" : row.conflictCode;
            }
        }
        return null;
    }

    /** First blocked code in a Classification queue, or null when nothing is blocked. */
    static String classificationBlockedCode(List<ReplicaDb.ClassificationAssignment> rows) {
        for (ReplicaDb.ClassificationAssignment row : rows) {
            if (row.blocked()) {
                return row.conflictCode == null ? "classificationWriteConflict"
                        : row.conflictCode;
            }
        }
        return null;
    }
}
