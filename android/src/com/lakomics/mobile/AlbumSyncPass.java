package com.lakomics.mobile;

/** Flush local Album membership intents before receiving remote Album changes. */
final class AlbumSyncPass {
    static final class Result {
        final AlbumMembershipOutbox.Flush flush;
        final AlbumAuthoritySync.Result receive;
        Result(AlbumMembershipOutbox.Flush flush, AlbumAuthoritySync.Result receive) {
            this.flush = flush;
            this.receive = receive;
        }
    }

    private final AlbumMembershipOutbox writer;
    private final AlbumAuthoritySync reader;

    AlbumSyncPass(AlbumMembershipOutbox writer, AlbumAuthoritySync reader) {
        this.writer = writer;
        this.reader = reader;
    }

    Result run(String scope) throws AlbumMembershipOutbox.Failure {
        final AlbumMembershipOutbox.Flush flush;
        try {
            flush = writer.flush(scope);
        } catch (AlbumMembershipOutbox.Failure failure) {
            // A stale library/epoch cannot be repaired by retrying the same command: the
            // client first has to discover and adopt the authority that now owns this
            // scope. The durable outbox survives that baseline replacement and is replayed
            // optimistically by the store. We still surface the original write failure; on
            // the next pass the row's old epoch is detected locally and blocked rather than
            // silently rebased across revision lineages.
            if (AlbumReplica.CODE_LIBRARY_MISMATCH.equals(failure.code)) {
                reader.reconcile(scope);
            }
            throw failure;
        }
        if (flush.pending > 0 || flush.blocked > 0) return new Result(flush, null);
        return new Result(flush, reader.reconcile(scope));
    }
}
