package com.lakomics.mobile;

/**
 * One Classification domain pass: flush local assignment intents, then receive.
 *
 * # Why the receive is not deferred while an intent is pending
 *
 * {@link AlbumSyncPass} defers its receive whenever the queue is not clean, because Album
 * membership is *materialized*: the visible `desired_state` is a stored column, so a
 * received page would overwrite the user's unsent choice with it.
 *
 * Classification assignment is not materialized. `classification_assignment_state` holds
 * only server-confirmed lineage, and the visible value is composed on read by replaying this
 * Asset's queued intents over it. A received page therefore cannot hide a pending choice, so
 * there is nothing to protect by deferring — and deferring would actively break recovery:
 * an identity change makes the writer block its unsendable rows, and only the reader can
 * adopt the authority that resolves the mismatch. Deferring would leave the domain stalled
 * with the rows that need that recovery still sitting in the queue.
 *
 * Order still matters. Flushing first means an intent composed against the confirmed
 * revision is delivered before the catch-up that would otherwise advance past it.
 */
final class ClassificationSyncPass {
    static final class Result {
        final ClassificationAssignmentOutbox.Flush flush;
        final ClassificationAuthoritySync.Result receive;

        Result(ClassificationAssignmentOutbox.Flush flush,
               ClassificationAuthoritySync.Result receive) {
            this.flush = flush;
            this.receive = receive;
        }
    }

    private final ClassificationAssignmentOutbox writer;
    private final ClassificationAuthoritySync reader;

    ClassificationSyncPass(ClassificationAssignmentOutbox writer,
                           ClassificationAuthoritySync reader) {
        this.writer = writer;
        this.reader = reader;
    }

    Result run(String scope) throws ClassificationAssignmentOutbox.Failure {
        ClassificationAssignmentOutbox.Flush flush = writer.flush(scope);
        return new Result(flush, reader.reconcile(scope));
    }
}
