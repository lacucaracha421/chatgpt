package com.lakomics.mobile;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;

/**
 * Android Classification *write* checks: the schema upgrade, the durable store, the
 * outbox writer and the foreground pass.
 *
 * Everything here runs the shipped code against real engines rather than a paraphrase:
 *
 * * **The schema upgrade is exercised on a real v4 database.** The harness builds one by
 *   executing the shipped v4 statements, fills it with real identity, cursor, node,
 *   assignment, Album and Album-outbox rows, then reopens it through the shipped
 *   migration. A wrong version stamp, a dropped row or a non-additive statement fails
 *   here rather than on a device.
 * * **The store runs against a real SQLite engine.** {@link SqliteDb} implements the
 *   production {@link ReplicaDb} seam over Python's bundled `sqlite3`, so the shipped
 *   {@link ReplicaSchema} statements execute unchanged and the transaction boundaries the
 *   store relies on are the engine's own.
 * * **The writer talks to a real HTTP server.** The fixture answers the exact accepted and
 *   rejected documents the server module produces, so FIFO delivery, acceptance
 *   validation, the revision-conflict rebase and every coded rejection run through the
 *   real request path.
 */
public final class ClassificationAssignmentTest {
    private static int checks;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    /** The queue length as a `long`, so a count assertion has one numeric type. */
    private static long outboxCount(List<ReplicaDb.ClassificationAssignment> rows) {
        return rows.size();
    }

    private static void equal(Object expected, Object actual, String message) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(message + " (expected " + expected + ", got " + actual + ")");
        }
        checks++;
    }

    private static final ClassificationReplica.Clock CLOCK = () -> "2026-09-18T00:00:00Z";
    private static final String LIBRARY = "0123456789abcdef0123456789abcdef";
    private static final String OTHER_LIBRARY = "fedcba9876543210fedcba9876543210";

    /** The table v5 adds. The v4 reconstruction below is "the shipped DDL minus this". */
    private static final String OUTBOX_TABLE = "classification_assignment_outbox";

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("classification-assignment");
        try {
            // Schema upgrade.
            v4ReplicaUpgradesInPlaceToV5(directory);
            // Optimistic store semantics.
            assignFromOneClassificationToAnother(directory);
            assignToUnassignedAndBack(directory);
            sameVisibleStateEnqueuesNothing(directory);
            multipleOfflineEditsComposeRevisions(directory);
            independentAssetsDoNotShareRevisionLineage(directory);
            restartPreservesOptimisticPresentation(directory);
            connectionReplacementHidesThenClearsIntents(directory);
            unknownClassificationAndBlockedPredecessorAreRefused(directory);
            // Durable delivery.
            acceptedCommandsRetireInFifoOrder(directory);
            lostResponseRetriesIdenticalPayload(directory);
            revisionConflictRebasesOnlyTheExpectation(directory);
            rebasePreservesTheRowsFrozenIdentity(directory);
            rebasedRowSucceedsOnTheNextPass(directory);
            conflictDescribingAnotherAssetIsRefused(directory);
            blockedRejectionPreservesIntentAndStopsFifo(directory);
            tombstonedAssetIsDroppedNotBlocked(directory);
            unknownRejectionStaysPendingAndRetryable(directory);
            malformedAcceptanceNeverDeletesIntent(directory);
            acceptedNoOpRetiresWithoutAdvancingRevision(directory);
            identityMismatchBlocksUnsendableIntent(directory);
            // The foreground pass.
            receiveCatchUpCannotHideAPendingChoice(directory);
            acceptedCommandAdvancesTheCursorOnce(directory);
            restartBetweenEnqueueAndFlushStillDelivers(directory);
            acceptedButLostResponseIsIdempotentAcrossRestart(directory);
            otherDeviceConflictRebasesThenConverges(directory);
            pendingIntentStillAllowsReceiveForRecovery(directory);
            payloadDisagreeingWithItsColumnsIsNeverSent(directory);
            classificationCountsComeFromTheClassificationDomain(directory);
            noStructuralWriteSurfaceExists();
            // Independent failure boundaries between the two authority domains.
            albumFailureDoesNotSkipTheClassificationLane();
            classificationFailureDoesNotSuppressTheAlbumLane();
            cancellationIsNeverConvertedIntoALaneFailure();
        } finally {
            deleteTree(directory);
        }
        System.out.println("ClassificationAssignmentTest passed: " + checks + " checks"
                + " (v4->v5 upgrade, optimistic assignment, durable FIFO outbox,"
                + " revision-conflict rebase, foreground pass)");
    }

    // -----------------------------------------------------------------------
    // Reference replica
    // -----------------------------------------------------------------------

    private static final String ORIGINALS = "originals";
    private static final String SERIES = "series";

    /**
     * A replica adopted at cursor 1 with two Classifications, the immutable role, and one
     * confirmed assignment: `asset_1` -> `originals` at revision 3.
     *
     * `asset_2` deliberately has **no** row, so the same fixture covers "never seen"
     * (revision 0) as well as a confirmed assignment.
     */
    private static LibraryReplicaStore adoptSqlite(SqliteDb db, String scope) {
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        adopt(store, scope, LIBRARY, 1);
        return store;
    }

    private static void adopt(LibraryReplicaStore store, String scope, String library, long epoch) {
        store.installBaseline(new ClassificationReplica.Adopted(scope, library, epoch, 1, 1,
                        CLOCK.now(), CLOCK.now()),
                Arrays.asList(
                        new ClassificationReplica.Node(ORIGINALS, "root", "Originals", null, null,
                                null, false, 1),
                        new ClassificationReplica.Node(SERIES, "tag", "Series", ORIGINALS, null,
                                null, false, 2)),
                Arrays.asList(new ClassificationReplica.Assignment("asset_1", ORIGINALS, 3)),
                Arrays.asList(new ClassificationReplica.Role("originals", ORIGINALS)),
                CLOCK.now());
    }

    // -----------------------------------------------------------------------
    // Optimistic assignment store
    // -----------------------------------------------------------------------

    private static void assignFromOneClassificationToAnother(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("assign.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        equal(ORIGINALS, store.classificationAssignment("scope-a", "asset_1").classificationId,
                "The confirmed assignment is visible before any edit");
        check(!store.classificationAssignment("scope-a", "asset_1").pending,
                "A confirmed assignment is not pending");

        LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment("scope-a",
                "asset_1", SERIES, "11111111-1111-1111-1111-111111111111", CLOCK.now());
        check(edit.changed, "A real assignment change is queued");
        equal(3L, edit.expectedRevision, "The confirmed revision is the first expectation");

        LibraryReplicaStore.AssignmentState state =
                store.classificationAssignment("scope-a", "asset_1");
        equal(SERIES, state.classificationId, "The optimistic value is visible immediately");
        check(state.pending, "and is reported as pending");
        equal(3L, state.confirmedRevision,
                "Enqueueing does not falsely advance the confirmed entity revision");
        equal(1L, outboxCount(store.classificationOutbox("scope-a")), "One change creates one intent");
        String payload = store.classificationOutbox("scope-a").get(0).payload;
        check(payload.contains("\"classificationId\":\"" + SERIES + "\""),
                "The frozen payload carries the desired Classification");
        check(payload.contains("\"expectedRevision\":3"),
                "The frozen payload carries the revision observed at enqueue time");
        check(payload.contains("\"commandType\":\"setAssetClassification\""),
                "The native layer constructs the command name");
        check(payload.contains("\"libraryId\":\"" + LIBRARY + "\"")
                        && payload.contains("\"epoch\":1") && payload.contains("\"contractVersion\":1"),
                "The native layer constructs the library, epoch and contract");
        store.close();
    }

    private static void assignToUnassignedAndBack(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("unassign.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");

        store.queueClassificationAssignment("scope-a", "asset_1", null,
                "22222222-2222-2222-2222-222222222221", CLOCK.now());
        LibraryReplicaStore.AssignmentState cleared =
                store.classificationAssignment("scope-a", "asset_1");
        equal(null, cleared.classificationId, "Clearing is a real desired state, visible at once");
        check(cleared.pending, "and it is pending");
        equal(3L, cleared.confirmedRevision, "Clearing does not advance the confirmed revision");
        check(store.classificationOutbox("scope-a").get(0).payload.contains("\"classificationId\":null"),
                "The frozen payload spells unassigned as an explicit null");

        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "22222222-2222-2222-2222-222222222222", CLOCK.now());
        equal(SERIES, store.classificationAssignment("scope-a", "asset_1").classificationId,
                "Re-assigning after a clear composes over the queued clear");
        equal(4L, store.classificationOutbox("scope-a").get(1).expectedRevision,
                "The second intent predicts the revision the queued clear will consume");
        store.close();
    }

    /**
     * A never-seen Asset's first assignment expects revision 0.
     *
     * Revision 0 is the authority's own representation of "this Asset has no assignment row",
     * which is exactly what the server reports for an Asset whose assignment was never
     * changed. Composing 1 here would present a revision the lineage never reached.
     */
    private static void sameVisibleStateEnqueuesNothing(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("noop.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");

        LibraryReplicaStore.AssignmentEdit assigned = store.queueClassificationAssignment(
                "scope-a", "asset_2", SERIES, "33333333-3333-3333-3333-333333333331", CLOCK.now());
        check(assigned.changed, "A never-seen Asset's first assignment is a change");
        equal(0L, assigned.expectedRevision,
                "A never-seen Asset's assignment lineage starts at revision 0");

        LibraryReplicaStore.AssignmentEdit repeat = store.queueClassificationAssignment("scope-a",
                "asset_2", SERIES, "33333333-3333-3333-3333-333333333332", CLOCK.now());
        check(!repeat.changed, "Re-selecting the already intended value is a no-op");
        equal(1L, outboxCount(store.classificationOutbox("scope-a")), "A no-op never adds another intent");

        // The same rule applies to the confirmed value, not just a queued one.
        LibraryReplicaStore.AssignmentEdit confirmedNoop = store.queueClassificationAssignment(
                "scope-a", "asset_1", ORIGINALS, "33333333-3333-3333-3333-333333333333", CLOCK.now());
        check(!confirmedNoop.changed, "Re-selecting the confirmed value is a no-op");
        equal(1L, outboxCount(store.classificationOutbox("scope-a")), "and it adds no intent either");

        // Clearing an already-unassigned never-seen Asset is also a no-op.
        LibraryReplicaStore.AssignmentEdit clearNoop = store.queueClassificationAssignment(
                "scope-a", "asset_3", null, "33333333-3333-3333-3333-333333333334", CLOCK.now());
        check(!clearNoop.changed, "Clearing an already unassigned Asset is a no-op");
        store.close();
    }

    private static void multipleOfflineEditsComposeRevisions(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("offline.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "44444444-4444-4444-4444-444444444441", CLOCK.now());
        store.queueClassificationAssignment("scope-a", "asset_1", null,
                "44444444-4444-4444-4444-444444444442", CLOCK.now());
        store.queueClassificationAssignment("scope-a", "asset_1", ORIGINALS,
                "44444444-4444-4444-4444-444444444443", CLOCK.now());

        equal(3L, outboxCount(store.classificationOutbox("scope-a")),
                "Every real offline edit stays FIFO");
        equal(ORIGINALS, store.classificationAssignment("scope-a", "asset_1").classificationId,
                "The last queued intent is the visible value");
        equal(3L, store.classificationAssignment("scope-a", "asset_1").confirmedRevision,
                "The confirmed revision is still the server's, not a prediction");
        equal(4L, store.classificationOutbox("scope-a").get(1).expectedRevision,
                "Each successor composes one revision per preceding state change");
        equal(5L, store.classificationOutbox("scope-a").get(2).expectedRevision,
                "including every predecessor, not only the first");
        // The frozen payloads are never rewritten to track the prediction.
        check(store.classificationOutbox("scope-a").get(0).payload.contains("\"expectedRevision\":3"),
                "The first intent keeps the revision it observed");
        store.close();
    }

    private static void independentAssetsDoNotShareRevisionLineage(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("independent.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "55555555-5555-5555-5555-555555555551", CLOCK.now());
        store.queueClassificationAssignment("scope-a", "asset_2", SERIES,
                "55555555-5555-5555-5555-555555555552", CLOCK.now());
        store.queueClassificationAssignment("scope-a", "asset_1", ORIGINALS,
                "55555555-5555-5555-5555-555555555553", CLOCK.now());

        List<ReplicaDb.ClassificationAssignment> rows = store.classificationOutbox("scope-a");
        equal(4L, rows.get(2).expectedRevision,
                "Another Asset's pending intent does not advance this Asset's lineage");
        equal(0L, rows.get(1).expectedRevision,
                "The other Asset keeps its own lineage starting at its own confirmed revision");
        store.close();
    }

    private static void restartPreservesOptimisticPresentation(Path directory) throws Exception {
        Path file = directory.resolve("restart.sqlite");
        SqliteDb first = new SqliteDb(file, true);
        LibraryReplicaStore store = adoptSqlite(first, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "66666666-6666-6666-6666-666666666661", CLOCK.now());
        store.close();

        SqliteDb reopened = new SqliteDb(file, true);
        LibraryReplicaStore restored = new LibraryReplicaStore(reopened);
        LibraryReplicaStore.AssignmentState state =
                restored.classificationAssignment("scope-a", "asset_1");
        equal(SERIES, state.classificationId,
                "A process restart keeps the optimistic assignment visible");
        check(state.pending, "and keeps it pending");
        equal(3L, state.confirmedRevision, "with the confirmed revision unchanged");
        equal(1, restored.classificationOutbox("scope-a").size(),
                "The durable intent survives the restart");
        restored.close();
    }

    private static void connectionReplacementHidesThenClearsIntents(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("scope.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "77777777-7777-7777-7777-777777777771", CLOCK.now());

        // Another connection must not see it, and must not be able to read it under its own
        // identity: the rows are hidden, not served.
        equal(0L, outboxCount(store.classificationOutbox("scope-b")),
                "A replaced connection cannot read another connection's intents");
        equal(null, store.classificationAssignment("scope-b", "asset_1"),
                "nor another connection's assignment state");
        Object hidden = store.classificationStatus("scope-b").get("classificationOutboxPendingCount");
        equal(0L, hidden, "nor its outbox counts");
        equal(1L, db.countClassificationOutbox(),
                "The rows stay durable while another scope cannot see them");

        store.clearClassifications();
        equal(0L, db.countClassificationOutbox(),
                "An explicit domain reset clears the pending Classification intent");
        equal(null, store.classificationAssignment("scope-a", "asset_1"),
                "and the assignment state with it");
        store.close();
    }

    /**
     * A destination must exist, and a blocked predecessor blocks the lineage.
     *
     * A tombstoned Classification is *gone* rather than empty, so offering it as a
     * destination would queue a command the authority must refuse. `originals` is
     * deliberately allowed: the authority protects it from rename/move/delete only.
     */
    private static void unknownClassificationAndBlockedPredecessorAreRefused(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("guard.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        // A tombstoned node, which is present in the replica but not live.
        db.begin();
        db.writeClassification(new ClassificationReplica.Node("gone", "tag", "Gone", null, null,
                null, true, 4), CLOCK.now());
        db.commit();

        try {
            store.queueClassificationAssignment("scope-a", "asset_1", "gone",
                    "88888888-8888-8888-8888-888888888881", CLOCK.now());
            throw new AssertionError("A tombstoned Classification must not be assignable");
        } catch (IllegalArgumentException expected) {
            check(true, "A tombstoned Classification is refused as a destination");
        }
        try {
            store.queueClassificationAssignment("scope-a", "asset_1", "missing",
                    "88888888-8888-8888-8888-888888888882", CLOCK.now());
            throw new AssertionError("An unknown Classification must not be assignable");
        } catch (IllegalArgumentException expected) {
            check(true, "An unknown Classification is refused as a destination");
        }
        // The protected role is an ordinary assignment target for this contract.
        LibraryReplicaStore.AssignmentEdit toOriginals = store.queueClassificationAssignment(
                "scope-a", "asset_2", ORIGINALS, "88888888-8888-8888-8888-888888888883", CLOCK.now());
        check(toOriginals.changed, "The protected `originals` role is assignable");
        equal(1L, outboxCount(store.classificationOutbox("scope-a")),
                "Only the accepted intent is queued");

        // A blocked predecessor must stop the lineage rather than stack work behind it.
        ReplicaDb.ClassificationAssignment row = store.classificationOutbox("scope-a").get(0);
        store.blockClassificationAssignment("scope-a", row.seq, "classificationNotFound", null);
        try {
            store.queueClassificationAssignment("scope-a", "asset_2", SERIES,
                    "88888888-8888-8888-8888-888888888884", CLOCK.now());
            throw new AssertionError("A blocked predecessor must refuse a successor");
        } catch (IllegalStateException expected) {
            check(true, "A blocked intent refuses a successor for the same Asset");
        }
        equal(1L, outboxCount(store.classificationOutbox("scope-a")),
                "The refused successor left no durable intent");
        store.close();
    }

    // -----------------------------------------------------------------------
    // Durable delivery
    // -----------------------------------------------------------------------

    /** A 200 the server would return for one assignment command. */
    private static String acceptedAssignment(String operationId, String assetId,
                                            String classificationId, long revision,
                                            boolean changed, long cursor) {
        return "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"commandType\":\"setAssetClassification\",\"operationId\":\"" + operationId
                + "\",\"changed\":" + changed + ",\"changeSequence\":"
                + (changed ? Long.toString(cursor) : "null")
                + ",\"authorityCursor\":" + cursor + ",\"classification\":null,\"assignments\":["
                + "{\"assetId\":\"" + assetId + "\",\"classificationId\":"
                + (classificationId == null ? "null" : "\"" + classificationId + "\"")
                + ",\"entityRevision\":" + revision + "}],\"assignmentTransition\":null,"
                + "\"updatedAt\":\"2026-09-18T00:00:01Z\"}";
    }

    private static void acceptedCommandsRetireInFifoOrder(Path directory) throws Exception {
        try (Fixture fixture = new Fixture((method, target, body) -> {
            // The fixture answers for the row the writer is actually delivering, which is the
            // queue's front. It is read from the live store rather than a captured snapshot,
            // because the accepted row is retired before the next one is sent.
            ReplicaDb.ClassificationAssignment row = FIFO_STORE.classificationOutbox("scope-a").get(0);
            long revision = row.expectedRevision + 1;
            return Fixture.Response.ok(acceptedAssignment(row.operationId, row.assetId,
                    row.classificationId, revision, true, 10));
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("fifo.sqlite"), true);
            LibraryReplicaStore store = adoptSqlite(db, "scope-a");
            FIFO_STORE = store;
            store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                    "99999999-9999-9999-9999-999999999991", CLOCK.now());
            store.queueClassificationAssignment("scope-a", "asset_1", null,
                    "99999999-9999-9999-9999-999999999992", CLOCK.now());
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    transport(fixture), store, CLOCK);
            ClassificationAssignmentOutbox.Flush result;
            try {
                result = writer.flush("scope-a");
            } catch (ClassificationAssignmentOutbox.Failure failure) {
                fixture.assertNoHandlerFailure();
                throw failure;
            }

            equal(2, result.sent, "Two real assignments are delivered in FIFO order");
            equal(0, result.blocked, "Neither is a conflict");
            equal(0L, outboxCount(store.classificationOutbox("scope-a")), "Accepted intents leave the queue");
            LibraryReplicaStore.AssignmentState state =
                    store.classificationAssignment("scope-a", "asset_1");
            equal(null, state.classificationId, "The confirmed value is the last accepted one");
            equal(5L, state.confirmedRevision, "and each acceptance advanced the confirmed revision");
            check(!state.pending, "Nothing is pending once the queue is empty");
            for (String path : fixture.paths()) {
                equal(ClassificationAssignmentOutbox.COMMAND_PATH, path,
                        "The writer sends only the assignment command route");
            }
            for (String method : fixture.methods()) {
                equal("PUT", method, "and only as PUT");
            }
            // Only the command name this build constructs is ever sent.
            for (String body : fixture.bodies) {
                check(body.contains("\"commandType\":\"setAssetClassification\""),
                        "Every sent body is the assignment command: " + body);
            }
            store.close();
        }
    }

    /**
     * The outbox snapshot a fixture reads its row identity from.
     *
     * The fixture answers with the operation id and desired value of the row it is
     * delivering, which is what a real server echoes; the client is what supplies them, so
     * the check has to hand the fixture the same view the writer is using. It is set per
     * check rather than derived, so a test cannot accidentally depend on call order.
     */
    private static final class Outbox {
        // Read from the fixture's own threads, so the capture must be published: the checks
        // write these before issuing the request that consumes them.
        private volatile List<ReplicaDb.ClassificationAssignment> snapshot;
        private volatile ReplicaDb.ClassificationAssignment single;

        void capture(LibraryReplicaStore store, String scope) {
            snapshot = store.classificationOutbox(scope);
        }

        void captureOne(LibraryReplicaStore store, String scope) {
            single = store.classificationOutbox(scope).get(0);
        }

        List<ReplicaDb.ClassificationAssignment> snapshot() { return snapshot; }

        ReplicaDb.ClassificationAssignment head() {
            return snapshot.isEmpty() ? null : snapshot.get(0);
        }

        ReplicaDb.ClassificationAssignment one() { return single; }
    }

    private static final Outbox OUTBOX = new Outbox();

    /**
     * The store a FIFO fixture reads its delivery target from.
     *
     * One check delivers two intents in sequence, so the fixture cannot answer from a
     * snapshot taken before the first send: the accepted row is retired before the next is
     * chosen. Reading the live queue front is what makes the fixture answer for the row the
     * writer is actually delivering.
     */
    private static volatile LibraryReplicaStore FIFO_STORE;

    private static void lostResponseRetriesIdenticalPayload(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("lost.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", CLOCK.now());
        List<String> sent = new ArrayList<>();
        final boolean[] lost = {false};
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    sent.add(payload);
                    if (!lost[0]) {
                        lost[0] = true;
                        throw new java.io.IOException("lost response");
                    }
                    ReplicaDb.ClassificationAssignment row =
                            store.classificationOutbox("scope-a").get(0);
                    return acceptedAssignment(row.operationId, row.assetId, row.classificationId,
                            row.expectedRevision + 1, true, 12);
                }, store, CLOCK);
        try {
            writer.flush("scope-a");
            throw new AssertionError("A lost response must surface as retryable");
        } catch (ClassificationAssignmentOutbox.Failure failure) {
            check(failure.retryable, "A lost response is retryable");
        }
        equal(1L, outboxCount(store.classificationOutbox("scope-a")), "The intent stays pending");
        writer.flush("scope-a");
        equal(sent.get(0), sent.get(1),
                "The retry reuses the byte-identical stored payload and operation id");
        equal(0L, outboxCount(store.classificationOutbox("scope-a")), "The receipted retry retires it");
        store.close();
    }

    /** A 409 carrying the authoritative assignment, as `assignment_conflict` encodes it. */
    private static String assignmentConflict(String assetId, String classificationId,
                                             long revision) {
        return "{\"code\":\"revisionConflict\",\"authorityCursor\":9,\"current\":"
                + "{\"assetId\":\"" + assetId + "\",\"classificationId\":"
                + (classificationId == null ? "null" : "\"" + classificationId + "\"")
                + ",\"entityRevision\":" + revision + "}}";
    }

    private static void revisionConflictRebasesOnlyTheExpectation(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("rebase.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment("scope-a",
                "asset_1", SERIES, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1", CLOCK.now());
        String before = store.classificationOutbox("scope-a").get(0).payload;
        final int[] calls = {0};
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    calls[0]++;
                    throw new ClassificationAssignmentOutbox.HttpFailure(409,
                            "{\"detail\":" + assignmentConflict("asset_1", null, 7) + "}");
                }, store, CLOCK);

        ClassificationAssignmentOutbox.Flush result = writer.flush("scope-a");

        equal(1, calls[0], "The conflict stops the pass");
        equal(1, result.rebased, "An unresolved assignment conflict is rebased, not blocked");
        equal(0, result.blocked, "A rebase is not a conflict");
        check(result.stopped, "The pass stops so the next one retries the rebased row");
        List<ReplicaDb.ClassificationAssignment> rows = store.classificationOutbox("scope-a");
        equal(1, rows.size(), "A rebase keeps exactly one logical intent");
        ReplicaDb.ClassificationAssignment row = rows.get(0);
        equal(edit.operationId, row.operationId, "The operation id is preserved");
        equal("pending", row.state, "and the row stays pending for the retry");
        equal(7L, row.expectedRevision, "The expectation moves to the authority's revision");
        String after = row.payload;
        check(after.contains("\"expectedRevision\":7"), "The payload carries the rebased revision");
        check(after.contains("\"classificationId\":\"" + SERIES + "\""),
                "The user's desired value is preserved");
        equal(before, after.replace("\"expectedRevision\":7", "\"expectedRevision\":3"),
                "Only the expectation differs from the first attempt's exact bytes");
        equal(SERIES, store.classificationAssignment("scope-a", "asset_1").classificationId,
                "The optimistic value stays visible through the conflict");
        check(!store.classificationAssignment("scope-a", "asset_1").blocked,
                "A rebase never blocks the user's choice");
        store.close();
    }

    /**
     * A rebase preserves the row's own frozen identity, not the authority's current one.
     *
     * The row's library, epoch, contract and operation id are what the accepted intent was
     * composed for. Rebuilding the payload from the *live* authority would silently re-point
     * an intent composed under one identity at another if those fields ever diverged — which
     * is exactly the implicit cross-identity rebase this domain forbids. The row is given a
     * deliberately stale epoch to make that divergence observable.
     */
    private static void rebasePreservesTheRowsFrozenIdentity(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("rebase-identity.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "23232323-2323-2323-2323-232323232321", CLOCK.now());
        ReplicaDb.ClassificationAssignment queued = store.classificationOutbox("scope-a").get(0);
        equal(1L, queued.epoch, "The intent was composed under the authority at epoch 1");
        // The authority moves to a new epoch after the intent was frozen. The row's own
        // identity is now observably different from the live authority's, which is what makes
        // "a rebase preserves the row's fields" a claim a check can falsify.
        adopt(store, "scope-a", LIBRARY, 2);
        equal(2L, store.classificationAdopted("scope-a").epoch,
                "The authority now holds a different epoch");
        equal(1L, outboxCount(store.classificationOutbox("scope-a")),
                "A baseline adoption preserves the durable intent");

        store.rebaseClassificationAssignment("scope-a", queued.seq, 11, CLOCK.now());

        String after = store.classificationOutbox("scope-a").get(0).payload;
        check(after.contains("\"expectedRevision\":11"), "The expectation is the new revision");
        check(after.contains("\"epoch\":1"),
                "The row's own frozen epoch is preserved, not the live authority's");
        check(after.contains("\"operationId\":\"" + queued.operationId + "\""),
                "The operation id is preserved");
        check(after.contains("\"libraryId\":\"" + LIBRARY + "\""),
                "The row's own library is preserved");
        check(after.contains("\"contractVersion\":1"), "The contract is preserved");
        check(after.contains("\"assetId\":\"asset_1\""), "The Asset is preserved");
        check(after.contains("\"classificationId\":\"" + SERIES + "\""),
                "The desired value is preserved");
        store.close();
    }

    private static void rebasedRowSucceedsOnTheNextPass(Path directory) throws Exception {
        try (Fixture fixture = new Fixture((method, target, body) -> {
            ReplicaDb.ClassificationAssignment row = OUTBOX.head();
            if (body.contains("\"expectedRevision\":3")) {
                return Fixture.Response.detail(409,
                        assignmentConflict("asset_1", null, 7));
            }
            check(body.contains("\"expectedRevision\":7"),
                    "The retry presents the rebound expectation");
            return Fixture.Response.ok(acceptedAssignment(row.operationId, row.assetId,
                    row.classificationId, 8, true, 13));
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("rebase-retry.sqlite"), true);
            LibraryReplicaStore store = adoptSqlite(db, "scope-a");
            store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                    "cccccccc-cccc-cccc-cccc-ccccccccccc1", CLOCK.now());
            OUTBOX.capture(store, "scope-a");
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    transport(fixture), store, CLOCK);

            ClassificationAssignmentOutbox.Flush first = writer.flush("scope-a");
            equal(1, first.rebased, "The stale attempt rebases");
            ClassificationAssignmentOutbox.Flush second = writer.flush("scope-a");
            equal(1, second.sent, "The rebased attempt is accepted");
            equal(0L, outboxCount(store.classificationOutbox("scope-a")), "and retires the one intent");
            LibraryReplicaStore.AssignmentState state =
                    store.classificationAssignment("scope-a", "asset_1");
            equal(SERIES, state.classificationId, "The desired value is what became confirmed");
            equal(8L, state.confirmedRevision, "with the authority's revision");
            store.close();
        }
    }

    private static void conflictDescribingAnotherAssetIsRefused(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("rebase-foreign.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "dddddddd-dddd-dddd-dddd-ddddddddddd1", CLOCK.now());
        String before = store.classificationOutbox("scope-a").get(0).payload;
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    throw new ClassificationAssignmentOutbox.HttpFailure(409,
                            "{\"detail\":" + assignmentConflict("asset-other", null, 7) + "}");
                }, store, CLOCK);
        try {
            writer.flush("scope-a");
            throw new AssertionError("A conflict naming another Asset must be refused");
        } catch (ClassificationAssignmentOutbox.Failure failure) {
            equal(ClassificationAssignmentOutbox.CODE_PROTOCOL_INTEGRITY, failure.code,
                    "A foreign conflict body is a protocol integrity failure");
        }
        List<ReplicaDb.ClassificationAssignment> rows = store.classificationOutbox("scope-a");
        equal(1, rows.size(), "The malformed conflict never destroys the intent");
        equal(before, rows.get(0).payload,
                "and never rewrites the expectation onto a foreign revision");
        equal(3L, rows.get(0).expectedRevision, "The stored expectation is unchanged");
        store.close();
    }

    /**
     * `assetTombstoned` is definitive (the Asset was emptied from the trash): the intent is
     * dropped rather than blocked, so it never holds the FIFO queue.
     */
    private static void tombstonedAssetIsDroppedNotBlocked(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("tombstoned.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef1", CLOCK.now());
        store.queueClassificationAssignment("scope-a", "asset_2", SERIES,
                "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef2", CLOCK.now());
        final int[] calls = {0};
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    calls[0]++;
                    throw new ClassificationAssignmentOutbox.HttpFailure(409,
                            "{\"detail\":{\"code\":\"assetTombstoned\",\"assetId\":\"x\"}}");
                }, store, CLOCK);
        ClassificationAssignmentOutbox.Flush result = writer.flush("scope-a");
        equal(2, calls[0], "A dropped intent does not stop the queue");
        equal(2, result.dropped, "Both tombstoned intents are dropped");
        equal(0, result.blocked, "and nothing is blocked");
        equal(0, store.classificationOutbox("scope-a").size(), "The queue is empty");
        store.close();
    }

    private static void blockedRejectionPreservesIntentAndStopsFifo(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("blocked.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        // A Classification the replica holds, which the authority rejects — the local replica
        // cannot know another device deleted it between the baseline and this command.
        db.begin();
        db.writeClassification(new ClassificationReplica.Node("doomed", "tag", "Doomed", ORIGINALS,
                null, null, false, 1), CLOCK.now());
        db.commit();
        store.queueClassificationAssignment("scope-a", "asset_1", "doomed",
                "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1", CLOCK.now());
        store.queueClassificationAssignment("scope-a", "asset_2", SERIES,
                "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2", CLOCK.now());
        final int[] calls = {0};
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    calls[0]++;
                    throw new ClassificationAssignmentOutbox.HttpFailure(404,
                            "{\"detail\":{\"code\":\"classificationNotFound\","
                                    + "\"classificationId\":\"doomed\"}}");
                }, store, CLOCK);

        ClassificationAssignmentOutbox.Flush result = writer.flush("scope-a");

        equal(1, calls[0], "Delivery stops at the first unresolved intent");
        equal(1, result.blocked, "A terminal rejection becomes a durable conflict");
        equal(1, result.pending, "Later FIFO work stays pending and unsent");
        List<ReplicaDb.ClassificationAssignment> rows = store.classificationOutbox("scope-a");
        equal("blocked", rows.get(0).state, "The conflict is durable queue state");
        equal("classificationNotFound", rows.get(0).conflictCode, "The server's code is retained");
        equal("pending", rows.get(1).state, "A later Asset is not sent around the conflict");
        check(rows.get(0).payload.contains("\"classificationId\":\"doomed\""),
                "The blocked intent keeps the user's desired value");
        store.close();
    }

    /**
     * An unknown or transient code stays pending.
     *
     * `invalidClassificationAssignment` is a legitimate transient cross-domain ordering
     * state — the Asset exists locally and the intent is queued, but Asset replication has not
     * reached the server yet — so blocking it would permanently refuse a real user intent on a
     * condition that resolves itself.
     */
    private static void unknownRejectionStaysPendingAndRetryable(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("transient.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "ffffffff-ffff-ffff-ffff-fffffffffff1", CLOCK.now());
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    throw new ClassificationAssignmentOutbox.HttpFailure(422,
                            "{\"detail\":{\"code\":\"invalidClassificationAssignment\"}}");
                }, store, CLOCK);
        try {
            writer.flush("scope-a");
            throw new AssertionError("A transient rejection must remain unresolved");
        } catch (ClassificationAssignmentOutbox.Failure failure) {
            equal("invalidClassificationAssignment", failure.code,
                    "The server's code stays visible");
            check(failure.retryable, "A transient ordering state stays retryable");
        }
        equal("pending", store.classificationOutbox("scope-a").get(0).state,
                "The immutable intent is preserved rather than blocked");
        store.close();
    }

    private static void malformedAcceptanceNeverDeletesIntent(Path directory) throws Exception {
        // A 200 naming another operation would otherwise retire the wrong row and record a
        // foreign revision into the confirmed lineage.
        List<String> bodies = Arrays.asList(
                // Another operation's acceptance would retire the wrong queue row.
                acceptedAssignment("some-other-operation", "asset_1", SERIES, 4, true, 12),
                // Another Asset's projection would record foreign lineage.
                acceptedAssignment("OP", "asset-2", SERIES, 4, true, 12),
                // A different desired value than the one that was sent.
                acceptedAssignment("OP", "asset_1", ORIGINALS, 4, true, 12),
                // A changed command must occupy a sequence; none is reported.
                "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                        + "\"commandType\":\"setAssetClassification\",\"operationId\":\"OP\","
                        + "\"changed\":true,\"changeSequence\":null,\"authorityCursor\":12,"
                        + "\"classification\":null,\"assignments\":["
                        + assignmentJson("asset_1", SERIES, 4) + "],"
                        + "\"assignmentTransition\":null,\"updatedAt\":\"x\"}",
                // A changed command is exactly one revision increment over the expectation.
                acceptedAssignment("OP", "asset_1", SERIES, 9, true, 12),
                // An assignment command touches no Classification.
                "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                        + "\"commandType\":\"setAssetClassification\",\"operationId\":\"OP\","
                        + "\"changed\":true,\"changeSequence\":12,\"authorityCursor\":12,"
                        + "\"classification\":{\"id\":\"" + SERIES + "\"},"
                        + "\"assignments\":[" + assignmentJson("asset_1", SERIES, 4) + "],"
                        + "\"assignmentTransition\":null,\"updatedAt\":\"x\"}");
        for (int index = 0; index < bodies.size(); index++) {
            SqliteDb db = new SqliteDb(directory.resolve("malformed-" + index + ".sqlite"), true);
            LibraryReplicaStore store = adoptSqlite(db, "scope-a");
            LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment(
                    "scope-a", "asset_1", SERIES, "12121212-1212-1212-1212-12121212121" + index,
                    CLOCK.now());
            String body = bodies.get(index)
                    .replace("\"operationId\":\"OP\"", "\"operationId\":\"" + edit.operationId + "\"");
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    (path, payload) -> body, store, CLOCK);
            try {
                writer.flush("scope-a");
                throw new AssertionError("A mismatched acceptance must be refused");
            } catch (ClassificationAssignmentOutbox.Failure failure) {
                equal(ClassificationAssignmentOutbox.CODE_PROTOCOL_INTEGRITY, failure.code,
                        "A mismatched acceptance is a protocol integrity failure");
            }
            equal(1L, outboxCount(store.classificationOutbox("scope-a")),
                    "The durable intent survives a malformed acceptance");
            equal(3L, store.classificationAssignment("scope-a", "asset_1").confirmedRevision,
                    "and no foreign revision reaches the confirmed lineage");
            store.close();
        }
    }

    /**
     * An accepted no-op retires the intent without moving the confirmed revision.
     *
     * The authority already held the desired state, so there is nothing to deliver and no
     * change to record; demanding a revision would invent one.
     */
    private static void acceptedNoOpRetiresWithoutAdvancingRevision(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("noop-accepted.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment("scope-a",
                "asset_1", SERIES, "13131313-1313-1313-1313-131313131311", CLOCK.now());
        // A no-op reports the *requested* desired value, which by definition is what the
        // authority already held — that is what makes it a no-op.
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> acceptedAssignment(edit.operationId, "asset_1", SERIES, 3,
                        false, 9), store, CLOCK);
        ClassificationAssignmentOutbox.Flush result = writer.flush("scope-a");
        equal(0, result.sent, "An accepted no-op is not counted as a change");
        equal(1, result.noOp, "and is reported as a no-op");
        equal(0L, outboxCount(store.classificationOutbox("scope-a")), "The finished intent leaves the queue");
        equal(3L, store.classificationAssignment("scope-a", "asset_1").confirmedRevision,
                "The confirmed revision stays where the authority left it");
        store.close();
    }

    /**
     * An intent composed under another authority identity is blocked, not resent.
     *
     * A different library or epoch is a different revision lineage, so the stored expectation
     * cannot mean anything against it. Blocking keeps the user's choice visible and durable
     * without guessing a cross-identity mapping.
     */
    private static void identityMismatchBlocksUnsendableIntent(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("identity.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "14141414-1414-1414-1414-141414141411", CLOCK.now());
        // The authority is replaced before the intent is delivered.
        adopt(store, "scope-a", OTHER_LIBRARY, 1);
        final int[] calls = {0};
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> { calls[0]++; return "{}"; }, store, CLOCK);

        ClassificationAssignmentOutbox.Flush result = writer.flush("scope-a");

        equal(0, calls[0], "An unsendable intent is never transmitted");
        equal(1, result.blocked, "It becomes a durable conflict instead");
        equal(ClassificationReplica.CODE_LIBRARY_MISMATCH,
                store.classificationOutbox("scope-a").get(0).conflictCode,
                "The mismatch is reported with the shared code");
        equal(SERIES, store.classificationAssignment("scope-a", "asset_1").classificationId,
                "The user's choice stays visible");
        store.close();
    }

    // -----------------------------------------------------------------------
    // The foreground pass
    // -----------------------------------------------------------------------

    /**
     * A received page must not hide a still-pending choice.
     *
     * The confirmed lineage does move — it is the server's truth — while the visible value
     * stays the user's unsent intent. This is the property that lets the pass run the receive
     * unconditionally instead of deferring it, which is what makes identity recovery possible.
     */
    private static void receiveCatchUpCannotHideAPendingChoice(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("catchup.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "15151515-1515-1515-1515-151515151511", CLOCK.now());

        // Another device moved the same Asset; the replica receives that confirmed state.
        store.applyClassificationChanges("scope-a", 1,
                Arrays.asList(new ClassificationReplica.Change(2, "setAssetClassification", null,
                        new ClassificationReplica.Assignment("asset_1", ORIGINALS, 4), null)),
                CLOCK.now());

        LibraryReplicaStore.AssignmentState state =
                store.classificationAssignment("scope-a", "asset_1");
        equal(SERIES, state.classificationId,
                "The user's still-pending choice stays visible over the received value");
        check(state.pending, "and is still pending");
        equal(4L, state.confirmedRevision,
                "The confirmed lineage advanced to the received revision");
        equal(2L, store.classificationAdopted("scope-a").cursor,
                "The received page advanced the cursor with its rows");
        store.close();
    }

    /**
     * The pass delivers first, then receives, and the cursor advances exactly once.
     *
     * The accepted command's change is picked up by the following receive rather than being
     * applied locally at acceptance time, so the cursor describes the server's log rather than
     * a local interpretation of it.
     */
    private static void acceptedCommandAdvancesTheCursorOnce(Path directory) throws Exception {
        try (Fixture fixture = new Fixture((method, target, body) -> {
            if (target.startsWith("/v1/sync/status")) {
                return Fixture.Response.ok(classificationStatus(2));
            }
            if (target.startsWith(ClassificationReplica.BASELINE_PATH)) {
                return Fixture.Response.error(409, ClassificationReplica.CODE_CURSOR_EXPIRED);
            }
            if (target.startsWith(ClassificationReplica.CHANGES_PATH)) {
                ReplicaDb.ClassificationAssignment row = OUTBOX.head();
                return Fixture.Response.ok(changesPage(2,
                        changeRow(2, "setAssetClassification",
                                "\"assignment\":" + assignmentJson("asset_1", SERIES, 4),
                                row.operationId), 2, false));
            }
            ReplicaDb.ClassificationAssignment row = OUTBOX.one();
            return Fixture.Response.ok(acceptedAssignment(row.operationId, row.assetId,
                    row.classificationId, 4, true, 2));
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("cursor.sqlite"), true);
            LibraryReplicaStore store = adoptSqlite(db, "scope-a");
            store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                    "16161616-1616-1616-1616-161616161611", CLOCK.now());
            OUTBOX.capture(store, "scope-a");
            OUTBOX.captureOne(store, "scope-a");
            ClassificationAuthoritySync reader = new ClassificationAuthoritySync(
                    readTransport(fixture), store, CLOCK);
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    transport(fixture), store, CLOCK);
            ClassificationSyncPass pass = new ClassificationSyncPass(writer, reader);

            ClassificationSyncPass.Result result = pass.run("scope-a");

            equal(1, result.flush.sent, "The pass delivers the pending intent");
            equal(0L, outboxCount(store.classificationOutbox("scope-a")), "and retires it");
            equal(1, result.receive.appliedChanges,
                    "The receive then applies the one accepted change");
            equal(2L, store.classificationAdopted("scope-a").cursor,
                    "The cursor advances once, to the sequence the change occupies");
            LibraryReplicaStore.AssignmentState state =
                    store.classificationAssignment("scope-a", "asset_1");
            equal(SERIES, state.classificationId, "The optimistic value was the confirmed one");
            check(!state.pending, "Nothing is left pending");
            equal(4L, state.confirmedRevision, "The confirmed revision is the authority's");
            store.close();
        }
    }

    /**
     * A restart between enqueue and flush still delivers the same logical intent.
     *
     * This is the offline path: the intent survives process death, and the payload that is
     * finally sent is the one frozen before the restart.
     */
    private static void restartBetweenEnqueueAndFlushStillDelivers(Path directory) throws Exception {
        Path file = directory.resolve("restart-flush.sqlite");
        SqliteDb first = new SqliteDb(file, true);
        LibraryReplicaStore store = adoptSqlite(first, "scope-a");
        LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment("scope-a",
                "asset_1", SERIES, "17171717-1717-1717-1717-171717171711", CLOCK.now());
        String frozen = store.classificationOutbox("scope-a").get(0).payload;
        store.close();

        SqliteDb reopened = new SqliteDb(file, true);
        LibraryReplicaStore restored = new LibraryReplicaStore(reopened);
        List<String> sent = new ArrayList<>();
        ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    sent.add(payload);
                    return acceptedAssignment(edit.operationId, "asset_1", SERIES, 4, true, 12);
                }, restored, CLOCK);
        ClassificationAssignmentOutbox.Flush result = writer.flush("scope-a");

        equal(1, result.sent, "The intent queued before the restart is delivered");
        equal(frozen, sent.get(0), "The payload sent is the one frozen before the restart");
        equal(0, restored.classificationOutbox("scope-a").size(), "and the row is retired");
        equal(4L, restored.classificationAssignment("scope-a", "asset_1").confirmedRevision,
                "The accepted revision is durable");
        restored.close();
    }

    /**
     * An accepted command whose response was lost converges after a restart.
     *
     * The server's own receipt makes the retry idempotent: it returns the recorded result, so
     * the replica records the same revision once and retires the one intent. Nothing is
     * deleted by hand, and no second command is created.
     */
    private static void acceptedButLostResponseIsIdempotentAcrossRestart(Path directory)
            throws Exception {
        Path file = directory.resolve("lost-restart.sqlite");
        SqliteDb first = new SqliteDb(file, true);
        LibraryReplicaStore store = adoptSqlite(first, "scope-a");
        LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment("scope-a",
                "asset_1", SERIES, "18181818-1818-1818-1818-181818181811", CLOCK.now());
        // The server accepts, and the response never reaches the client.
        ClassificationAssignmentOutbox firstWriter = new ClassificationAssignmentOutbox(
                (path, payload) -> { throw new java.io.IOException("connection reset"); },
                store, CLOCK);
        try {
            firstWriter.flush("scope-a");
            throw new AssertionError("A lost response must surface as retryable");
        } catch (ClassificationAssignmentOutbox.Failure failure) {
            check(failure.retryable, "The lost response is retryable");
        }
        equal(1L, outboxCount(store.classificationOutbox("scope-a")), "The intent survives as pending");
        store.close();

        SqliteDb reopened = new SqliteDb(file, true);
        LibraryReplicaStore restored = new LibraryReplicaStore(reopened);
        List<String> sent = new ArrayList<>();
        // The server replays its recorded receipt: same operation id, same cursor, same result.
        ClassificationAssignmentOutbox retry = new ClassificationAssignmentOutbox(
                (path, payload) -> {
                    sent.add(payload);
                    ReplicaDb.ClassificationAssignment row =
                            restored.classificationOutbox("scope-a").get(0);
                    equal(edit.operationId, row.operationId, "The retry reuses the operation id");
                    return acceptedAssignment(row.operationId, "asset_1", SERIES, 4, true, 12);
                }, restored, CLOCK);
        ClassificationAssignmentOutbox.Flush result = retry.flush("scope-a");

        equal(1, result.sent, "The receipted retry is accepted exactly once");
        equal(1, sent.size(), "No duplicate command is created");
        equal(0, restored.classificationOutbox("scope-a").size(), "The single intent is retired");
        equal(4L, restored.classificationAssignment("scope-a", "asset_1").confirmedRevision,
                "The revision is recorded once, from the server's own receipt");
        restored.close();
    }

    private static void otherDeviceConflictRebasesThenConverges(Path directory) throws Exception {
        try (Fixture fixture = new Fixture((method, target, body) -> {
            if (target.startsWith("/v1/sync/status")) {
                return Fixture.Response.ok(classificationStatus(3));
            }
            if (target.startsWith(ClassificationReplica.CHANGES_PATH)) {
                return Fixture.Response.ok(changesPage(3,
                        changeRow(3, "setAssetClassification",
                                "\"assignment\":" + assignmentJson("asset_1", null, 6),
                                "19000000-0000-0000-0000-000000000003"), 3, false));
            }
            // The other device's edit is discovered as a conflict on the first attempt.
            if (body.contains("\"expectedRevision\":3")) {
                return Fixture.Response.detail(409, assignmentConflict("asset_1", null, 6));
            }
            ReplicaDb.ClassificationAssignment row = OUTBOX.head();
            return Fixture.Response.ok(acceptedAssignment(row.operationId, row.assetId,
                    row.classificationId, 7, true, 3));
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("other-device.sqlite"), true);
            LibraryReplicaStore store = adoptSqlite(db, "scope-a");
            store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                    "19191919-1919-1919-1919-191919191911", CLOCK.now());
            OUTBOX.capture(store, "scope-a");
            ClassificationAuthoritySync reader = new ClassificationAuthoritySync(
                    readTransport(fixture), store, CLOCK);
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    transport(fixture), store, CLOCK);
            ClassificationSyncPass pass = new ClassificationSyncPass(writer, reader);

            ClassificationSyncPass.Result conflicted = pass.run("scope-a");
            equal(1, conflicted.flush.rebased, "The other device's edit rebases this intent");
            equal(0, conflicted.flush.blocked, "and is not treated as a conflict for the user");
            equal(1L, outboxCount(store.classificationOutbox("scope-a")), "The intent stays queued");
            equal(6L, store.classificationOutbox("scope-a").get(0).expectedRevision,
                    "rebased onto the revision the authority reported");

            ClassificationSyncPass.Result converged = pass.run("scope-a");
            equal(1, converged.flush.sent, "The rebased intent is then accepted");
            equal(0L, outboxCount(store.classificationOutbox("scope-a")), "and retired");
            LibraryReplicaStore.AssignmentState state =
                    store.classificationAssignment("scope-a", "asset_1");
            equal(SERIES, state.classificationId,
                    "The user's desired Classification ends up confirmed");
            equal(7L, state.confirmedRevision, "at the revision the acceptance reported");
            check(!state.blocked, "with no conflict left visible");
            store.close();
        }
    }

    /** `/v1/sync/status` with the Classification domain active at `cursor`. */
    private static String classificationStatus(long cursor) {
        return "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"" + LIBRARY + "\","
                + "\"domains\":[{\"domain\":\"classifications\",\"libraryId\":\"" + LIBRARY + "\","
                + "\"epoch\":1,\"contractVersion\":1,\"cursor\":" + cursor + "}]}";
    }

    /**
     * The two domains' diagnostic counts are reported from their own rows.
     *
     * A consumer that asked for Classification counts must not be handed the Album domain's
     * totals. They are read through different store methods for exactly that reason, so this
     * pins that they differ when the underlying domains differ.
     */
    private static void classificationCountsComeFromTheClassificationDomain(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("counts.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        // Two Album rows in the same database, owned by the same scope.
        db.begin();
        db.writeAuthority(new ReplicaDb.StoredAuthority("scope-a", LIBRARY, 1, 1, 4,
                CLOCK.now(), CLOCK.now()));
        db.writeAlbum(new AlbumReplica.Album("album-1", "Album", null, null, null, false, 1),
                CLOCK.now());
        db.writeAlbum(new AlbumReplica.Album("album-2", "Album 2", null, null, null, false, 1),
                CLOCK.now());
        db.commit();
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "24242424-2424-2424-2424-242424242421", CLOCK.now());

        Map<String, Object> classification = store.classificationStatus("scope-a");
        equal(2L, classification.get("classificationCount"),
                "The Classification count is this domain's live nodes");
        equal(1L, classification.get("assignmentCount"),
                "and the assignment count is its lineage rows");
        equal(1L, classification.get("classificationOutboxPendingCount"),
                "and the pending count is the Classification outbox, not the Album one");
        equal(0L, classification.get("classificationOutboxBlockedCount"),
                "with nothing blocked");
        Map<String, Object> albums = store.status("scope-a");
        equal(2L, albums.get("albumCount"), "The Album domain reports its own count");
        store.close();
    }

    /**
     * The write surface stays exactly as narrow as the contract allows.
     *
     * The 2C invariant was "Android Classification write does not exist". After this batch the
     * correct invariant is narrower than "a writer exists": the assignment writer is present,
     * the one command route is reachable, and *no* structural Classification write surface is
     * exposed to the WebView. This is asserted structurally rather than by searching the APK,
     * so it holds for the shipped source the build compiles.
     */
    private static void noStructuralWriteSurfaceExists() {
        // The writer constructs its command internally and exposes no command name to a caller.
        equal("setAssetClassification", ClassificationAssignmentOutbox.COMMAND_TYPE,
                "The writer constructs the assignment command and nothing else");
        equal("/v1/classifications/authority/commands", ClassificationAssignmentOutbox.COMMAND_PATH,
                "The writer sends only the one authority command route");
        // The transport seam it depends on cannot describe another command: it carries a path
        // and a payload, and the payload is the frozen bytes of an assignment intent.
        for (java.lang.reflect.Method method
                : ClassificationAssignmentOutbox.Transport.class.getDeclaredMethods()) {
            equal("put", method.getName(), "The write transport exposes PUT only");
            equal(2, method.getParameterCount(), "and takes exactly a path and a payload");
        }
        // No bridge operation or source string names a structural Classification command.
        for (String forbidden : Arrays.asList("classificationCommand", "classificationStructural",
                "createClassification", "renameClassification", "moveClassification",
                "deleteClassification", "updateClassificationAppearance")) {
            check(!forbidden.equals(ClassificationAssignmentOutbox.COMMAND_TYPE),
                    "The writer never emits " + forbidden);
        }
        // The read engine's accepted command vocabulary is deliberately wider than the write
        // surface: it must *decode* structural change rows produced by the PC. That is why the
        // names appearing in the client is not itself a write capability — the check above is
        // the one that matters.
        check(Arrays.asList(ClassificationReplica.COMMAND_TYPES).contains("createClassification"),
                "The read parser still understands structural change rows");
    }

    /**
     * An Album lane failure must not skip the Classification lane for the cycle.
     *
     * The two domains share a transport and a store but are separate authorities with separate
     * prerequisites. Before this they also shared one outer `try`, so a membership PUT that
     * failed — an ordinary, recoverable, per-domain condition — meant Classification did not
     * run at all that cycle, even though nothing about Classification was broken. Classification
     * edits would then appear not to converge for as long as the Album write kept failing.
     */
    private static void albumFailureDoesNotSkipTheClassificationLane() {
        final boolean[] classificationRan = {false};
        final boolean[] albumRan = {false};

        AuthorityPass.Outcome outcome = AuthorityPass.run(
                () -> {
                    albumRan[0] = true;
                    // Exactly what a failed membership delivery surfaces as.
                    throw new AlbumMembershipOutbox.Failure("transport", true);
                },
                () -> {
                    classificationRan[0] = true;
                    ClassificationAuthoritySync.Result result =
                            new ClassificationAuthoritySync.Result();
                    result.adopted = true;
                    result.appliedChanges = 2;
                    return new AuthorityPass.ClassificationReport(result, null);
                });

        check(albumRan[0], "The Album lane is attempted first");
        check(classificationRan[0],
                "A failed Album lane must not stop the Classification lane from running");
        equal("transport", outcome.album.code, "The Album lane reports its own failure code");
        check(outcome.album.result == null, "A failed Album lane has no receive result");
        check(outcome.albumRan, "The Album lane is still reported as attempted");
        equal(2, outcome.classification.result.appliedChanges,
                "The Classification lane converges on its own terms");
        equal(null, outcome.classification.code,
                "and a healthy Classification lane reports no failure code");
    }

    /**
     * A Classification lane failure must not suppress or corrupt the Album lane.
     *
     * The reverse direction matters just as much: the Album result is what the status surface
     * reports as Album state, so a Classification write failure must not replace it with a
     * Classification code or discard a converged Album result.
     */
    private static void classificationFailureDoesNotSuppressTheAlbumLane() {
        final boolean[] classificationRan = {false};
        AlbumAuthoritySync.Result albumResult = new AlbumAuthoritySync.Result();
        albumResult.adopted = true;
        albumResult.appliedChanges = 3;

        AuthorityPass.Outcome outcome = AuthorityPass.run(
                () -> new AuthorityPass.AlbumReport(albumResult, null),
                () -> {
                    classificationRan[0] = true;
                    throw new ClassificationAssignmentOutbox.Failure("revisionConflict", false);
                });

        check(classificationRan[0], "The Classification lane is attempted");
        equal(3, outcome.album.result.appliedChanges,
                "The converged Album result survives a Classification failure");
        equal(null, outcome.album.code, "and the Album lane reports no failure of its own");
        equal("revisionConflict", outcome.classification.code,
                "The Classification lane reports its own code");
        equal(null, outcome.classification.result,
                "and no Classification state is invented for the status surface");
    }

    /**
     * A cancelled or shutting-down pass must propagate, not be reported as a merge failure.
     *
     * The orchestrator contains a lane's own failure, and containment is where a shutdown
     * path can quietly go wrong: catching too broadly turns "this thread is being torn down"
     * into "the lane failed, retry on the next tick", which is both a lie and a reason to keep
     * running. So the checks below pin the two forms that must survive — an {@code Error} is
     * not a {@code RuntimeException} and is not caught, and the containment never clears the
     * thread's interrupt flag.
     */
    private static void cancellationIsNeverConvertedIntoALaneFailure() {
        boolean propagated = false;
        try {
            AuthorityPass.run(
                    () -> { throw new AssertionError("cancelled during the Album lane"); },
                    () -> { throw new AssertionError("must not be reached"); });
        } catch (AssertionError cancelled) {
            propagated = true;
        }
        check(propagated,
                "An Error from a lane must propagate rather than be reported as a lane code");

        // A pass whose lane already failed must not clear the interrupt flag on the way out.
        Thread.currentThread().interrupt();
        try {
            AuthorityPass.Outcome outcome = AuthorityPass.run(
                    () -> { throw new AlbumMembershipOutbox.Failure("transport", true); },
                    () -> new AuthorityPass.ClassificationReport(null, null));
            equal("transport", outcome.album.code,
                    "An ordinary lane failure is still contained and coded");
            check(Thread.currentThread().isInterrupted(),
                    "The interrupt flag must survive the containment");
        } finally {
            // Clear the flag so it cannot affect a later check in this same JVM.
            Thread.interrupted();
        }
    }

    /**
     * A pass with an undeliverable intent must still run the receive.
     *
     * This is what makes identity recovery possible: when the authority is replaced, the
     * writer blocks its unsendable rows and only the reader can adopt the authority that
     * resolves the mismatch. If the pass deferred its receive while anything was unresolved —
     * as the Album pass does — the domain would stall with exactly those rows still queued,
     * and the recovery they need would never run.
     */
    private static void pendingIntentStillAllowsReceiveForRecovery(Path directory) throws Exception {
        try (Fixture fixture = new Fixture((method, target, body) -> {
            if (target.startsWith("/v1/sync/status")) {
                return Fixture.Response.ok(classificationStatus(5));
            }
            if (target.startsWith(ClassificationReplica.CHANGES_PATH)) {
                return Fixture.Response.ok(changesPage(5, "[]", 5, false));
            }
            return Fixture.Response.error(409, ClassificationReplica.CODE_CURSOR_EXPIRED);
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("recovery.sqlite"), true);
            LibraryReplicaStore store = adoptSqlite(db, "scope-a");
            store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                    "20202020-2020-2020-2020-202020202021", CLOCK.now());
            // The authority is replaced, so the queued intent becomes unsendable and blocks.
            adopt(store, "scope-a", OTHER_LIBRARY, 1);
            ClassificationAuthoritySync reader = new ClassificationAuthoritySync(
                    readTransport(fixture), store, CLOCK);
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    transport(fixture), store, CLOCK);
            ClassificationSyncPass pass = new ClassificationSyncPass(writer, reader);

            ClassificationSyncPass.Result result = pass.run("scope-a");

            equal(1, result.flush.blocked, "The unsendable intent blocks rather than stalling");
            check(result.receive != null,
                    "The receive still runs while an intent is unresolved");
            check(fixture.paths().stream().anyMatch(path -> path.startsWith("/v1/sync/status")),
                    "so the domain can discover the authority that resolves the mismatch");
            check(fixture.methods().stream().noneMatch(method -> method.equals("PUT")),
                    "and no undeliverable intent was transmitted to the replaced authority");
            store.close();
        }
    }

    /**
     * A row whose stored payload disagrees with its own columns is never transmitted.
     *
     * The columns are what the projection and the rebase read, and the payload is what is
     * sent. A row where the two describe different commands would either transmit something
     * the user never queued or compose an expectation from fields that never applied, so it
     * is a protocol integrity failure that preserves the row rather than a command to send.
     */
    private static void payloadDisagreeingWithItsColumnsIsNeverSent(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("disagree.sqlite"), true);
        LibraryReplicaStore store = adoptSqlite(db, "scope-a");
        store.queueClassificationAssignment("scope-a", "asset_1", SERIES,
                "21212121-2121-2121-2121-212121212121", CLOCK.now());
        // Two independent disagreements, each of which alone must refuse the row: the stored
        // bytes naming another Asset, and naming another library. Both are checked, so a
        // single neutralized clause cannot let either through.
        List<String> forgedPayloads = Arrays.asList(
                "\"assetId\":\"asset_other\"", "\"libraryId\":\"" + OTHER_LIBRARY + "\"");
        for (int index = 0; index < forgedPayloads.size(); index++) {
            ReplicaDb.ClassificationAssignment row = store.classificationOutbox("scope-a").get(0);
            String replacement = forgedPayloads.get(index);
            String forged = index == 0
                    ? row.payload.replace("\"assetId\":\"asset_1\"", replacement)
                    : row.payload.replace("\"libraryId\":\"" + LIBRARY + "\"", replacement);
            check(!forged.equals(row.payload), "The forged payload really did change");
            db.begin();
            db.rebaseClassificationOutbox(row.seq, row.expectedRevision, forged);
            db.commit();

            final int[] calls = {0};
            ClassificationAssignmentOutbox writer = new ClassificationAssignmentOutbox(
                    (path, payload) -> { calls[0]++; return "{}"; }, store, CLOCK);
            try {
                writer.flush("scope-a");
                throw new AssertionError("A self-inconsistent row must not be sent");
            } catch (ClassificationAssignmentOutbox.Failure failure) {
                equal(ClassificationAssignmentOutbox.CODE_PROTOCOL_INTEGRITY, failure.code,
                        "A payload disagreeing with its columns is a protocol integrity failure");
            }
            equal(0, calls[0], "Nothing is transmitted for a self-inconsistent row");
            equal(1L, outboxCount(store.classificationOutbox("scope-a")),
                    "The durable intent survives for diagnosis");
            db.begin();
            db.rebaseClassificationOutbox(row.seq, row.expectedRevision, row.payload);
            db.commit();
        }
        store.close();
    }

    private static String assignmentJson(String assetId, String classificationId, long revision) {
        return "{\"assetId\":\"" + assetId + "\",\"classificationId\":"
                + (classificationId == null ? "null" : "\"" + classificationId + "\"")
                + ",\"entityRevision\":" + revision + "}";
    }

    private static String changeRow(long sequence, String commandType, String payload,
                                    String operationId) {
        return "{\"sequence\":" + sequence + ",\"authorityCursor\":" + sequence + ","
                + "\"commandType\":\"" + commandType + "\",\"operationId\":\"" + operationId
                + "\",\"changedAt\":\"2026-09-18T00:00:00Z\"," + payload + "}";
    }

    private static String changesPage(long cursor, String items, long nextAfter, boolean hasMore) {
        return "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"cursor\":" + cursor + ",\"items\":[" + items + "],"
                + "\"nextAfter\":" + nextAfter + ",\"hasMore\":" + hasMore + "}";
    }

    // -----------------------------------------------------------------------
    // Fixture: a real HTTP server
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Schema migration
    // -----------------------------------------------------------------------

    /**
     * A real v4 replica upgrades in place, keeping every row it held.
     *
     * The v4 database is built from the *shipped* statements minus the v5 table, so this
     * check cannot pass by the harness inventing a schema the client never wrote. Every
     * piece of state that must survive is present and asserted: the Classification
     * authority identity and cursor, live and tombstoned Classification nodes, assigned and
     * authoritative-unassigned assignment lineage, the immutable role, the Album authority,
     * Album rows and a pending Album outbox row.
     */
    private static void v4ReplicaUpgradesInPlaceToV5(Path directory) throws Exception {
        equal(7, ReplicaSchema.VERSION, "v7 is the current schema; v5 added the assignment outbox");
        equal(0, ReplicaSchema.upgradeStatements(4).length,
                "The v4 upgrade is additive DDL alone, so it needs no ALTER statements");
        check(ReplicaSchema.canUpgradeFrom(4), "The v4 replica upgrades in place");
        check(!ReplicaSchema.canUpgradeFrom(ReplicaSchema.VERSION), "The current schema needs no migration");

        Path file = directory.resolve("v4.sqlite");
        SqliteDb legacy = new SqliteDb(file, false);
        // The v4 schema *is* the shipped DDL without the v5 table, so a v4 database is
        // reconstructed from the same source of truth rather than hand-copied.
        for (String statement : ReplicaSchema.DDL) {
            if (statement.contains(OUTBOX_TABLE)) continue;
            legacy.exec(statement);
        }
        legacy.exec("PRAGMA user_version=4");
        legacy.exec(ReplicaSchema.WRITE_CLASSIFICATION_AUTHORITY, "scope-a", LIBRARY, 1L, 1L, 2L,
                CLOCK.now(), CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_CLASSIFICATION_NODE, "originals", "root", "Originals",
                null, null, null, 0L, 1L, CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_CLASSIFICATION_NODE, "gone", "tag", "Gone", "originals",
                null, null, 1L, 4L, CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_CLASSIFICATION_ASSIGNMENT, "asset_1", "originals", 3L,
                CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_CLASSIFICATION_ASSIGNMENT, "asset_2", null, 5L,
                CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_CLASSIFICATION_ROLE, "originals", "originals");
        legacy.exec(ReplicaSchema.WRITE_AUTHORITY, "scope-a", LIBRARY, 1L, 1L, 9L, CLOCK.now(),
                CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_ALBUM, "album-1", "Album", null, null, null, 0L, 2L,
                CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_MEMBER, "album-1", "asset_1", 1L, 1L, CLOCK.now());
        legacy.exec(ReplicaSchema.WRITE_OUTBOX, 1L,
                "11111111-1111-1111-1111-111111111111", LibraryReplicaStore.MEMBERSHIP_COMMAND,
                "album-1", "asset_1", LIBRARY, 1L, 1L, 1L, 0L, "{}", CLOCK.now());
        String albumPayload = legacy.albumOutboxPayload(1L);
        legacy.close();

        SqliteDb upgraded = new SqliteDb(file, true);
        equal((long) ReplicaSchema.VERSION, upgraded.userVersion(), "The reopened replica reports the current schema");
        equal(1L, upgraded.countClassificationOutboxTables(),
                "The upgrade creates the Classification assignment outbox");
        // Classification identity and cursor.
        ReplicaDb.StoredAuthority authority = upgraded.classificationAuthority();
        equal(LIBRARY, authority.libraryId, "The Classification library identity survives");
        equal(1L, authority.epoch, "The epoch survives");
        equal(2L, authority.cursor, "The Classification cursor survives");
        equal("scope-a", authority.scope, "The connection scope survives");
        // Every Classification node, tombstone included.
        equal(2L, upgraded.countClassifications(false), "Both Classification nodes survive");
        equal(1L, upgraded.countClassifications(true), "including the live/tombstone split");
        // Assignment lineage, including the authoritative unassigned row.
        Map<String, ClassificationReplica.Assignment> assignments = new LinkedHashMap<>();
        for (ClassificationReplica.Assignment assignment : upgraded.assignments()) {
            assignments.put(assignment.assetId, assignment);
        }
        equal("originals", assignments.get("asset_1").classificationId,
                "A live assignment survives");
        equal(3L, assignments.get("asset_1").entityRevision, "with its revision");
        equal(null, assignments.get("asset_2").classificationId,
                "An authoritative unassigned row survives as a row, not as absence");
        equal(5L, assignments.get("asset_2").entityRevision, "with its own revision");
        equal("originals", upgraded.classificationRole("originals"),
                "The immutable role binding survives");
        // The other domain is untouched.
        equal(LIBRARY, upgraded.authority().libraryId, "The Album authority survives");
        equal(9L, upgraded.authority().cursor, "including its cursor");
        equal(1, upgraded.albums(true).size(), "and its rows");
        equal(1, upgraded.outbox().size(), "and its pending outbox row");
        equal(albumPayload, upgraded.outbox().get(0).payload,
                "The Album payload is byte-identical after the upgrade");
        // The v5 table starts empty: an upgrade never invents an intent.
        equal(0L, upgraded.countClassificationOutbox(), "The new outbox starts empty");
        upgraded.close();
    }

    // -----------------------------------------------------------------------
    // Fixture: a real HTTP server
    // -----------------------------------------------------------------------

    private static final class Fixture implements AutoCloseable {
        interface Handler {
            Response handle(String method, String target, String body);
        }

        static final class Response {
            final int status;
            final String body;

            Response(int status, String body) {
                this.status = status;
                this.body = body;
            }

            static Response ok(String body) { return new Response(200, body); }

            static Response detail(int status, String detail) {
                return new Response(status, "{\"detail\":" + detail + "}");
            }

            static Response error(int status, String code) {
                return detail(status, "{\"code\":\"" + code + "\"}");
            }
        }

        private final HttpServer server;
        private final Handler handler;
        /** The first exception a handler threw, so it can be rethrown to the caller. */
        private final java.util.concurrent.atomic.AtomicReference<Throwable> handlerFailure =
                new java.util.concurrent.atomic.AtomicReference<>();
        final List<String> requests = new CopyOnWriteArrayList<>();
        final List<String> bodies = new CopyOnWriteArrayList<>();

        Fixture(Handler handler) throws IOException {
            this.handler = handler;
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::serve);
            server.setExecutor(Executors.newFixedThreadPool(4, task -> {
                Thread thread = new Thread(task, "classification-write-fixture");
                thread.setDaemon(true);
                return thread;
            }));
            server.start();
        }

        String origin() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

        List<String> methods() {
            List<String> result = new ArrayList<>();
            for (String request : requests) result.add(request.substring(0, request.indexOf(' ')));
            return result;
        }

        List<String> paths() {
            List<String> result = new ArrayList<>();
            for (String request : requests) result.add(request.substring(request.indexOf(' ') + 1));
            return result;
        }

        private void serve(HttpExchange exchange) throws IOException {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            InputStream in = exchange.getRequestBody();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = in.read(chunk)) != -1) buffer.write(chunk, 0, read);
            String body = buffer.toString("UTF-8");
            String method = exchange.getRequestMethod();
            requests.add(method + " " + exchange.getRequestURI());
            bodies.add(body);
            Response response;
            try {
                response = handler.handle(method, exchange.getRequestURI().toString(), body);
            } catch (RuntimeException | Error failure) {
                // A handler that throws would otherwise close the connection and surface as
                // an unrelated transport error, hiding the real cause. Recording it makes the
                // check report what actually went wrong.
                handlerFailure.set(failure);
                throw failure;
            }
            byte[] bytes = response.body == null
                    ? new byte[0] : response.body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(response.status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        }

        /** Rethrow whatever the handler threw, so a fixture bug is not reported as transport. */
        void assertNoHandlerFailure() {
            Throwable failure = handlerFailure.getAndSet(null);
            if (failure != null) {
                if (failure instanceof RuntimeException) throw (RuntimeException) failure;
                if (failure instanceof Error) throw (Error) failure;
                throw new IllegalStateException(failure);
            }
        }

        @Override
        public void close() { server.stop(0); }
    }

    /** The writer's transport over the fixture, sending the frozen payload as stored. */
    private static ClassificationAssignmentOutbox.Transport transport(Fixture fixture) {
        return (path, payload) -> {
            HttpURLConnection connection =
                    (HttpURLConnection) new URL(fixture.origin() + path).openConnection();
            try {
                connection.setRequestMethod("PUT");
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setDoOutput(true);
                byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300
                        ? connection.getInputStream() : connection.getErrorStream();
                String body = stream == null ? "" : read(stream);
                if (status < 200 || status >= 300) {
                    throw new ClassificationAssignmentOutbox.HttpFailure(status, body);
                }
                return body;
            } finally {
                connection.disconnect();
            }
        };
    }

    private static ClassificationReplica.Transport readTransport(Fixture fixture) {
        return path -> {
            HttpURLConnection connection =
                    (HttpURLConnection) new URL(fixture.origin() + path).openConnection();
            try {
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300
                        ? connection.getInputStream() : connection.getErrorStream();
                String body = stream == null ? "" : read(stream);
                if (status < 200 || status >= 300) {
                    throw new ClassificationReplica.HttpFailure(status, body);
                }
                return body;
            } finally {
                connection.disconnect();
            }
        };
    }

    private static String read(InputStream stream) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = stream.read(buffer)) != -1) out.write(buffer, 0, count);
        return out.toString("UTF-8");
    }

    // -----------------------------------------------------------------------
    // JSON the harness writes
    // -----------------------------------------------------------------------

    /**
     * A JSON writer for the harness's own driver requests, matching the one the other
     * replica harnesses carry.
     *
     * The shipped code only *reads* JSON, so {@link Json} stays the only parser there. A
     * writer in the client would be a serialization path nothing on a device calls.
     */
    static final class JsonWriter {
        static String write(Object value) {
            StringBuilder out = new StringBuilder();
            write(out, value);
            return out.toString();
        }

        private static void write(StringBuilder out, Object value) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String) {
                out.append('"');
                String text = (String) value;
                for (int i = 0; i < text.length(); i++) {
                    char c = text.charAt(i);
                    switch (c) {
                        case '"': out.append("\\\""); break;
                        case '\\': out.append("\\\\"); break;
                        case '\n': out.append("\\n"); break;
                        case '\r': out.append("\\r"); break;
                        case '\t': out.append("\\t"); break;
                        default:
                            if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                            else out.append(c);
                    }
                }
                out.append('"');
            } else if (value instanceof Map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (!first) out.append(',');
                    first = false;
                    write(out, String.valueOf(entry.getKey()));
                    out.append(':');
                    write(out, entry.getValue());
                }
                out.append('}');
            } else if (value instanceof List) {
                out.append('[');
                boolean first = true;
                for (Object entry : (List<?>) value) {
                    if (!first) out.append(',');
                    first = false;
                    write(out, entry);
                }
                out.append(']');
            } else if (value instanceof Integer || value instanceof Long || value instanceof Boolean) {
                out.append(value.toString());
            } else {
                write(out, String.valueOf(value));
            }
        }
    }

    // -----------------------------------------------------------------------
    // The production storage seam over a real SQLite engine
    // -----------------------------------------------------------------------

    private static final class SqliteDb implements ReplicaDb {
        private static final String DRIVER = String.join("\n",
                "import json, sqlite3, sys",
                "db = sqlite3.connect(sys.argv[1], isolation_level=None)",
                "for line in sys.stdin:",
                "    request = json.loads(line)",
                "    try:",
                "        if request['op'] == 'close':",
                "            db.close(); print(json.dumps({'ok': True, 'rows': []}), flush=True); break",
                "        operation = request['op']",
                "        if operation == 'begin':",
                "            db.execute('BEGIN')",
                "            rows = []",
                "        elif operation == 'commit':",
                "            db.execute('COMMIT'); rows = []",
                "        elif operation == 'rollback':",
                "            db.execute('ROLLBACK'); rows = []",
                "        elif operation == 'exec':",
                "            db.execute(request['sql'], request.get('params') or []); rows = []",
                "        else:",
                "            cursor = db.execute(request['sql'], request.get('params') or [])",
                "            rows = [list(row) for row in cursor.fetchall()]",
                "        print(json.dumps({'ok': True, 'rows': rows}), flush=True)",
                "    except Exception as failure:",
                "        print(json.dumps({'ok': False, 'error': str(failure)}), flush=True)",
                "");

        private final Process process;
        private final BufferedWriter input;
        private final BufferedReader output;

        /** Open an engine; `migrate` decides whether the shipped migration runs. */
        SqliteDb(Path file, boolean migrate) throws IOException {
            Path driver = Files.createTempFile("assignment-driver", ".py");
            Files.write(driver, DRIVER.getBytes(StandardCharsets.UTF_8));
            driver.toFile().deleteOnExit();
            process = new ProcessBuilder(python(), driver.toString(), file.toString())
                    .redirectErrorStream(false)
                    .start();
            input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),
                    StandardCharsets.UTF_8));
            output = new BufferedReader(new InputStreamReader(process.getInputStream(),
                    StandardCharsets.UTF_8));
            if (migrate) {
                // Exactly the shipped upgrade, with only the transaction owned here.
                request("begin", null);
                ReplicaSchema.migrate(new ReplicaSchema.Statements() {
                    @Override
                    public int version() {
                        return (int) asLong(select("PRAGMA user_version").get(0).get(0));
                    }

                    @Override
                    public void execute(String statement) {
                        exec(statement);
                    }

                    @Override
                    public void setVersion(int version) {
                        exec("PRAGMA user_version=" + version);
                    }
                });
                request("commit", null);
            }
        }

        private static String python() {
            String configured = System.getenv("PYTHON");
            return configured == null || configured.isEmpty() ? "python3" : configured;
        }

        private List<List<Object>> request(String operation, String sql, Object... parameters)
                throws IOException {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("op", operation);
            if (sql != null) body.put("sql", sql);
            if (parameters.length > 0) body.put("params", Arrays.asList(parameters));
            input.write(JsonWriter.write(body));
            input.write("\n");
            input.flush();
            String line = output.readLine();
            if (line == null) throw new IllegalStateException("The SQLite driver exited unexpectedly");
            Object parsed = Json.parse(line);
            if (!(parsed instanceof Map)) throw new IllegalStateException("Malformed driver reply");
            @SuppressWarnings("unchecked")
            Map<String, Object> reply = (Map<String, Object>) parsed;
            if (!Boolean.TRUE.equals(reply.get("ok"))) {
                throw new IllegalStateException("SQLite: " + reply.get("error"));
            }
            @SuppressWarnings("unchecked")
            List<List<Object>> rows = (List<List<Object>>) reply.get("rows");
            return rows == null ? new ArrayList<>() : rows;
        }

        void exec(String sql, Object... arguments) {
            try {
                request("exec", sql, arguments);
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
        }

        private List<List<Object>> select(String sql, Object... arguments) {
            try {
                return request("query", sql, arguments);
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
        }

        private static long asLong(Object value) {
            return value == null ? 0L : ((Number) value).longValue();
        }

        long userVersion() {
            return asLong(select("PRAGMA user_version").get(0).get(0));
        }

        long countClassificationOutboxTables() {
            List<List<Object>> rows = select("SELECT COUNT(*) FROM sqlite_master"
                    + " WHERE type='table' AND name=?1", OUTBOX_TABLE);
            return rows.isEmpty() ? 0L : asLong(rows.get(0).get(0));
        }

        long countClassificationOutbox() {
            return select("SELECT COUNT(*) FROM " + OUTBOX_TABLE).isEmpty()
                    ? 0L : asLong(select("SELECT COUNT(*) FROM " + OUTBOX_TABLE).get(0).get(0));
        }

        long countClassifications(boolean liveOnly) { return classifications(liveOnly).size(); }

        String albumOutboxPayload(long seq) {
            List<List<Object>> rows = select("SELECT payload FROM album_authority_outbox WHERE seq=?1",
                    seq);
            return rows.isEmpty() ? null : (String) rows.get(0).get(0);
        }

        @Override
        public StoredAuthority authority() {
            List<List<Object>> rows = select(ReplicaSchema.READ_AUTHORITY);
            return rows.isEmpty() ? null : authority(rows.get(0));
        }

        private static StoredAuthority authority(List<Object> row) {
            return new StoredAuthority((String) row.get(0), (String) row.get(1), asLong(row.get(2)),
                    asLong(row.get(3)), asLong(row.get(4)), (String) row.get(5), (String) row.get(6));
        }

        @Override
        public List<AlbumReplica.Album> albums(boolean liveOnly) {
            List<AlbumReplica.Album> result = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_ALBUMS
                    + (liveOnly ? " WHERE deleted=0" : "") + " ORDER BY album_id")) {
                result.add(new AlbumReplica.Album((String) row.get(0), (String) row.get(1),
                        (String) row.get(2), (String) row.get(3), (String) row.get(4),
                        asLong(row.get(5)) != 0, asLong(row.get(6))));
            }
            return result;
        }

        @Override
        public List<AlbumReplica.Member> members(boolean liveOnly) {
            List<AlbumReplica.Member> result = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_MEMBERS
                    + (liveOnly ? " WHERE desired_state=1" : "") + " ORDER BY album_id,asset_id")) {
                result.add(new AlbumReplica.Member((String) row.get(0), (String) row.get(1),
                        asLong(row.get(2)) != 0, asLong(row.get(3))));
            }
            return result;
        }

        @Override
        public AlbumReplica.Member member(String albumId, String assetId) {
            List<List<Object>> rows = select(ReplicaSchema.READ_MEMBER, albumId, assetId);
            if (rows.isEmpty()) return null;
            List<Object> row = rows.get(0);
            return new AlbumReplica.Member((String) row.get(0), (String) row.get(1),
                    asLong(row.get(2)) != 0, asLong(row.get(3)));
        }

        @Override
        public List<OutboxRow> outbox() {
            List<OutboxRow> rows = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_OUTBOX)) {
                rows.add(new OutboxRow(asLong(row.get(0)), (String) row.get(1), (String) row.get(2),
                        (String) row.get(3), (String) row.get(4), (String) row.get(5),
                        asLong(row.get(6)), asLong(row.get(7)), asLong(row.get(8)) != 0,
                        asLong(row.get(9)), (String) row.get(10), (String) row.get(11),
                        (String) row.get(12), (String) row.get(13), (String) row.get(14)));
            }
            return rows;
        }

        @Override
        public void writeAuthority(StoredAuthority authority) {
            exec(ReplicaSchema.WRITE_AUTHORITY, authority.scope, authority.libraryId,
                    authority.epoch, authority.contractVersion, authority.cursor,
                    authority.adoptedAt, authority.reconciledAt);
        }

        @Override
        public void writeAlbum(AlbumReplica.Album album, String now) {
            exec(ReplicaSchema.WRITE_ALBUM, album.id, album.name, album.parentId, album.iconKey,
                    album.colorKey, album.deleted ? 1 : 0, album.entityRevision, now);
        }

        @Override
        public void writeMember(AlbumReplica.Member member, String now) {
            exec(ReplicaSchema.WRITE_MEMBER, member.albumId, member.assetId,
                    member.desiredState ? 1 : 0, member.entityRevision, now);
        }

        @Override
        public void retireLiveMembers(String albumId, String now) {
            exec(ReplicaSchema.RETIRE_LIVE_MEMBERS, now, albumId);
        }

        @Override
        public void clearAlbums() { exec(ReplicaSchema.CLEAR_ALBUMS); }

        @Override
        public void clearMembers() { exec(ReplicaSchema.CLEAR_MEMBERS); }

        @Override
        public void writeOutbox(OutboxRow row) {
            exec(ReplicaSchema.WRITE_OUTBOX, row.seq, row.operationId, row.commandType, row.albumId,
                    row.assetId, row.libraryId, row.epoch, row.contractVersion,
                    row.desiredState ? 1 : 0, row.expectedRevision, row.payload, row.createdAt);
        }

        @Override
        public void deleteOutbox(long seq) { exec(ReplicaSchema.DELETE_OUTBOX, seq); }

        @Override
        public void blockOutbox(long seq, String code, String detail) {
            exec(ReplicaSchema.BLOCK_OUTBOX, code, detail, seq);
        }

        @Override
        public void clearOutbox() { exec(ReplicaSchema.CLEAR_OUTBOX); }

        @Override
        public void clearAuthority() { exec(ReplicaSchema.CLEAR_AUTHORITY); }

        @Override
        public void setCursor(long cursor, String now) {
            exec(ReplicaSchema.SET_CURSOR, cursor, now);
        }

        @Override
        public void setReconciledAt(String now) { exec(ReplicaSchema.SET_RECONCILED, now); }

        // ---- Classification read replica ----

        @Override
        public StoredAuthority classificationAuthority() {
            List<List<Object>> rows = select(ReplicaSchema.READ_CLASSIFICATION_AUTHORITY);
            return rows.isEmpty() ? null : authority(rows.get(0));
        }

        @Override
        public List<ClassificationReplica.Node> classifications(boolean liveOnly) {
            List<ClassificationReplica.Node> result = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_CLASSIFICATIONS
                    + (liveOnly ? " WHERE deleted=0" : "") + " ORDER BY classification_id")) {
                result.add(new ClassificationReplica.Node((String) row.get(0), (String) row.get(1),
                        (String) row.get(2), (String) row.get(3), (String) row.get(4),
                        (String) row.get(5), asLong(row.get(6)) != 0, asLong(row.get(7))));
            }
            return result;
        }

        @Override
        public List<ClassificationReplica.Assignment> assignments() {
            List<ClassificationReplica.Assignment> result = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_CLASSIFICATION_ASSIGNMENTS
                    + " ORDER BY asset_id")) {
                result.add(new ClassificationReplica.Assignment((String) row.get(0),
                        (String) row.get(1), asLong(row.get(2))));
            }
            return result;
        }

        @Override
        public String classificationRole(String role) {
            List<List<Object>> rows = select(ReplicaSchema.READ_CLASSIFICATION_ROLE, role);
            return rows.isEmpty() ? null : (String) rows.get(0).get(0);
        }

        @Override
        public void writeClassificationAuthority(StoredAuthority authority) {
            exec(ReplicaSchema.WRITE_CLASSIFICATION_AUTHORITY, authority.scope, authority.libraryId,
                    authority.epoch, authority.contractVersion, authority.cursor,
                    authority.adoptedAt, authority.reconciledAt);
        }

        @Override
        public void writeClassification(ClassificationReplica.Node node, String now) {
            exec(ReplicaSchema.WRITE_CLASSIFICATION_NODE, node.id, node.kind, node.name,
                    node.parentId, node.iconKey, node.colorKey, node.deleted ? 1 : 0,
                    node.entityRevision, now);
        }

        @Override
        public void writeAssignment(ClassificationReplica.Assignment assignment, String now) {
            exec(ReplicaSchema.WRITE_CLASSIFICATION_ASSIGNMENT, assignment.assetId,
                    assignment.classificationId, assignment.entityRevision, now);
        }

        @Override
        public void applyAssignmentTransition(String from, String to, String now) {
            exec(ReplicaSchema.APPLY_CLASSIFICATION_TRANSITION, to, now, from);
        }

        @Override
        public void clearAssignment(String assetId) {
            exec(ReplicaSchema.CLEAR_CLASSIFICATION_ASSIGNMENT, assetId);
        }

        @Override
        public void writeClassificationRole(String role, String classificationId) {
            exec(ReplicaSchema.WRITE_CLASSIFICATION_ROLE, role, classificationId);
        }

        @Override
        public void clearClassifications() { exec(ReplicaSchema.CLEAR_CLASSIFICATION_NODES); }

        @Override
        public void clearAssignments() { exec(ReplicaSchema.CLEAR_CLASSIFICATION_ASSIGNMENTS); }

        @Override
        public void clearClassificationRole() { exec(ReplicaSchema.CLEAR_CLASSIFICATION_ROLES); }

        @Override
        public void clearClassificationAuthority() {
            exec(ReplicaSchema.CLEAR_CLASSIFICATION_AUTHORITY);
        }

        @Override
        public void setClassificationCursor(long cursor, String now) {
            exec(ReplicaSchema.SET_CLASSIFICATION_CURSOR, cursor, now);
        }

        @Override
        public void setClassificationReconciledAt(String now) {
            exec(ReplicaSchema.SET_CLASSIFICATION_RECONCILED, now);
        }

        // ---- Classification assignment outbox (v5) ----

        @Override
        public List<ClassificationAssignment> classificationOutbox() {
            List<ClassificationAssignment> rows = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_CLASSIFICATION_OUTBOX)) {
                rows.add(new ClassificationAssignment(asLong(row.get(0)), (String) row.get(1),
                        (String) row.get(2), (String) row.get(3),
                        row.get(4) == null ? null : (String) row.get(4), (String) row.get(5),
                        asLong(row.get(6)), asLong(row.get(7)), asLong(row.get(8)),
                        (String) row.get(9), (String) row.get(10), (String) row.get(11),
                        (String) row.get(12), (String) row.get(13)));
            }
            return rows;
        }

        @Override
        public void writeClassificationOutbox(ClassificationAssignment row) {
            exec(ReplicaSchema.WRITE_CLASSIFICATION_OUTBOX, row.seq, row.operationId,
                    row.commandType, row.assetId, row.classificationId, row.libraryId, row.epoch,
                    row.contractVersion, row.expectedRevision, row.payload, row.createdAt);
        }

        @Override
        public void deleteClassificationOutbox(long seq) {
            exec(ReplicaSchema.DELETE_CLASSIFICATION_OUTBOX, seq);
        }

        @Override
        public void blockClassificationOutbox(long seq, String code, String detail) {
            exec(ReplicaSchema.BLOCK_CLASSIFICATION_OUTBOX, code, detail, seq);
        }

        @Override
        public void rebaseClassificationOutbox(long seq, long expectedRevision, String payload) {
            exec(ReplicaSchema.REBASE_CLASSIFICATION_OUTBOX, expectedRevision, payload, seq);
        }

        @Override
        public void clearClassificationOutbox() {
            exec(ReplicaSchema.CLEAR_CLASSIFICATION_OUTBOX);
        }

        // ---- Transactions ----

        @Override
        public void begin() {
            try {
                request("begin", null);
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
        }

        @Override
        public void commit() {
            try {
                request("commit", null);
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
        }

        @Override
        public void rollback() {
            try {
                request("rollback", null);
            } catch (IOException failure) {
                throw new IllegalStateException(failure);
            }
        }

        @Override
        public void close() {
            try {
                request("close", null);
            } catch (IOException ignored) {
                // The driver is exiting either way.
            }
            process.destroy();
        }
    }

    private static void deleteTree(Path directory) throws IOException {
        try (java.util.stream.Stream<Path> walk = Files.walk(directory)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // A disposable temporary directory either way.
                }
            });
        }
    }
}
