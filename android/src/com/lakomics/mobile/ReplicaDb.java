package com.lakomics.mobile;

import java.util.List;

/**
 * The durable storage seam under the Library replica store.
 *
 * It is deliberately *semantic* rather than a SQL executor. The alternative — passing
 * SQL strings through — would put the schema, the parameter binding and the
 * transaction semantics on the Android side of the seam, and then the only way to test
 * what the store decides would be to re-implement SQLite in the check harness. Keeping
 * the operations typed means every decision (which rows are written, which become
 * tombstones, when the cursor moves, what one transaction contains) stays in
 * {@link LibraryReplicaStore} and is exercised for real, while the Android adapter stays
 * a mechanical translation with nothing to get wrong.
 *
 * Transactions are explicit so atomicity is a property the caller observes, not an
 * assumption: {@link #begin} / {@link #commit} / {@link #rollback} bracket the writes,
 * and an implementation must discard everything since {@link #begin} on rollback.
 */
interface ReplicaDb {
    /** The stored authority row, or null when this installation has not adopted one. */
    StoredAuthority authority();

    /** Album rows, including tombstones unless `liveOnly`. */
    List<AlbumReplica.Album> albums(boolean liveOnly);

    /** Relation rows, including tombstones unless `liveOnly`. */
    List<AlbumReplica.Member> members(boolean liveOnly);

    /** One relation row, including a tombstone, or null when never observed. */
    AlbumReplica.Member member(String albumId, String assetId);

    /** Durable Album command intents in FIFO order. */
    List<OutboxRow> outbox();

    /** Insert or replace the singleton authority row. */
    void writeAuthority(StoredAuthority authority);

    /** Insert or replace one Album row, live or tombstoned. */
    void writeAlbum(AlbumReplica.Album album, String now);

    /** Insert or replace one relation row, live or tombstoned. */
    void writeMember(AlbumReplica.Member member, String now);

    /**
     * Mark an Album's live relations non-live without inventing a revision.
     *
     * Deleting an Album removes its memberships, but each relation's revision must
     * survive: a later re-add has to be able to present the revision it observed, and
     * the delete change row carries only the Album tombstone, so bumping a relation here
     * would create revision state no replay of that row could reproduce.
     */
    void retireLiveMembers(String albumId, String now);

    /** Remove every Album row. Used only by a wholesale baseline replace or a reset. */
    void clearAlbums();

    /** Remove every relation row. Used only by a wholesale baseline replace or a reset. */
    void clearMembers();

    /** Insert one immutable outgoing intent. */
    void writeOutbox(OutboxRow row);

    /** Retire one accepted intent. */
    void deleteOutbox(long seq);

    /** Preserve one rejected intent as a durable conflict. */
    void blockOutbox(long seq, String code, String detail);

    /** Remove every outgoing intent on an explicit connection reset. */
    void clearOutbox();

    void clearAuthority();

    void setCursor(long cursor, String now);

    void setReconciledAt(String now);

    // -----------------------------------------------------------------------
    // Classification read replica
    // -----------------------------------------------------------------------

    /**
     * The stored Classification authority row, or null when this installation has not
     * adopted that domain.
     *
     * A separate singleton from the Album row so either domain can be adopted alone.
     */
    StoredAuthority classificationAuthority();

    /** Classification rows, including tombstones unless `liveOnly`. */
    List<ClassificationReplica.Node> classifications(boolean liveOnly);

    /** Assignment lineage rows, including authoritative unassigned ones. */
    List<ClassificationReplica.Assignment> assignments();

    /** The stored `originals` binding, or null when none was adopted. */
    String classificationRole(String role);

    void writeClassificationAuthority(StoredAuthority authority);

    /** Insert or replace one Classification row, live or tombstoned. */
    void writeClassification(ClassificationReplica.Node node, String now);

    /** Insert or replace one Asset's assignment lineage row. */
    void writeAssignment(ClassificationReplica.Assignment assignment, String now);

    /**
     * Remove one Asset's assignment lineage row.
     *
     * This is how "the authority holds no row for this Asset" is represented, which is a
     * different state from an authoritative *unassigned* row at a real revision. A
     * revision-0 projection therefore clears the row instead of storing a row that claims
     * a revision the authority never reported.
     */
    void clearAssignment(String assetId);

    /**
     * Move every assignment naming `from` to `to`, incrementing each revision by one.
     *
     * Removing rows instead would destroy the revision a later command must present, and
     * inventing a different increment would disagree with the server's own transition.
     */
    void applyAssignmentTransition(String from, String to, String now);

    void writeClassificationRole(String role, String classificationId);

    /** Remove every Classification row. Used only by a baseline replace or a domain clear. */
    void clearClassifications();

    /** Remove every assignment lineage row. */
    void clearAssignments();

    void clearClassificationRole();

    void clearClassificationAuthority();

    void setClassificationCursor(long cursor, String now);

    void setClassificationReconciledAt(String now);

    /**
     * Durable Classification assignment intents in FIFO order.
     *
     * One table for the whole queue rather than a per-Asset read: the flush must deliver
     * strictly oldest-first, and the optimistic projection filters this same order by
     * Asset, so a second read shape could only disagree with the first.
     */
    List<ClassificationAssignment> classificationOutbox();

    /** Insert one frozen outgoing assignment intent. */
    void writeClassificationOutbox(ClassificationAssignment row);

    /** Retire one accepted intent. */
    void deleteClassificationOutbox(long seq);

    /** Preserve one rejected intent as a durable conflict. */
    void blockClassificationOutbox(long seq, String code, String detail);

    /**
     * Rewrite one intent's expectation onto the authority's current assignment revision.
     *
     * The stored payload moves with the column, because the payload is what is sent and the
     * column is what the projection predicts from; the operation id is deliberately not
     * touched, so the retry remains the same logical intent.
     */
    void rebaseClassificationOutbox(long seq, long expectedRevision, String payload);

    /** Remove every Classification assignment intent. Domain reset only. */
    void clearClassificationOutbox();

    void begin();

    void commit();

    void rollback();

    void close();

    /** One durable outgoing Album command. Payload bytes never change across retries. */
    final class OutboxRow {
        final long seq;
        final String operationId;
        final String commandType;
        final String albumId;
        final String assetId;
        final String libraryId;
        final long epoch;
        final long contractVersion;
        final boolean desiredState;
        final long expectedRevision;
        final String payload;
        final String state;
        final String conflictCode;
        final String conflictDetail;
        final String createdAt;

        OutboxRow(long seq, String operationId, String commandType, String albumId,
                  String assetId, String libraryId, long epoch, long contractVersion,
                  boolean desiredState, long expectedRevision, String payload, String state,
                  String conflictCode, String conflictDetail, String createdAt) {
            this.seq = seq;
            this.operationId = operationId;
            this.commandType = commandType;
            this.albumId = albumId;
            this.assetId = assetId;
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.desiredState = desiredState;
            this.expectedRevision = expectedRevision;
            this.payload = payload;
            this.state = state;
            this.conflictCode = conflictCode;
            this.conflictDetail = conflictDetail;
            this.createdAt = createdAt;
        }

        boolean blocked() { return "blocked".equals(state); }
    }

    /**
     * One durable outgoing Classification assignment intent. Payload bytes never change
     * across retries.
     *
     * `classificationId` is nullable and separate from the payload on purpose: `null` is
     * the canonical *unassigned* desired state, a real value the user chose, so it cannot
     * be represented by the column's absence.
     */
    final class ClassificationAssignment {
        final long seq;
        final String operationId;
        final String commandType;
        final String assetId;
        final String classificationId;
        final String libraryId;
        final long epoch;
        final long contractVersion;
        final long expectedRevision;
        final String payload;
        final String state;
        final String conflictCode;
        final String conflictDetail;
        final String createdAt;

        ClassificationAssignment(long seq, String operationId, String commandType, String assetId,
                                 String classificationId, String libraryId, long epoch,
                                 long contractVersion, long expectedRevision, String payload,
                                 String state, String conflictCode, String conflictDetail,
                                 String createdAt) {
            this.seq = seq;
            this.operationId = operationId;
            this.commandType = commandType;
            this.assetId = assetId;
            this.classificationId = classificationId;
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.expectedRevision = expectedRevision;
            this.payload = payload;
            this.state = state;
            this.conflictCode = conflictCode;
            this.conflictDetail = conflictDetail;
            this.createdAt = createdAt;
        }

        boolean blocked() { return "blocked".equals(state); }
    }

    /** The stored authority identity, matching the protocol's camelCase shape. */
    final class StoredAuthority {
        final String scope;
        final String libraryId;
        final long epoch;
        final long contractVersion;
        final long cursor;
        final String adoptedAt;
        final String reconciledAt;

        StoredAuthority(String scope, String libraryId, long epoch, long contractVersion,
                        long cursor, String adoptedAt, String reconciledAt) {
            this.scope = scope;
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.cursor = cursor;
            this.adoptedAt = adoptedAt;
            this.reconciledAt = reconciledAt;
        }
    }
}
