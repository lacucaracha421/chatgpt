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
 * Classification read-replica checks: the domain rules, the durable store and the engine.
 *
 * Everything here runs the shipped code against a real engine, rather than re-testing a
 * paraphrase of it:
 *
 * * **The engine talks to a real HTTP server.** The fixture serves the exact
 *   `/v1/sync/status`, `/v1/classifications/authority/baseline` and
 *   `.../changes` documents the server module produces, so paging, section ordering and
 *   every coded failure are exercised through the real request path.
 * * **The store runs against a real SQLite engine.** {@link SqliteDb} implements the
 *   production {@link ReplicaDb} seam over the `sqlite3` CLI and executes the shipped
 *   {@link ReplicaSchema} statements, so durability checks reopen a real file and the
 *   store's own transaction boundaries are what is being observed.
 * * **Nothing depends on the Android `org.json` stub.** The engine and parser use the
 *   platform-independent {@link Json} reader, which is what lets this run in a plain JVM.
 *
 * The domain checks below cover the properties that make this a *replica* rather than a
 * cache: ordered application, idempotent replay, restart/resume, reset/rebase, retention
 * recovery, tombstones, single-valued assignment convergence, and the unadopted boundary
 * that keeps the legacy mobile Classification read path in charge.
 */
public final class ClassificationReplicaTest {
    private static int checks;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static void equal(Object expected, Object actual, String message) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(message + " (expected " + expected + ", got " + actual + ")");
        }
        checks++;
    }

    private static final ClassificationReplica.Clock CLOCK = () -> "2026-09-17T00:00:00Z";
    private static final String LIBRARY = "0123456789abcdef0123456789abcdef";
    private static final String OTHER_LIBRARY = "fedcba9876543210fedcba9876543210";
    private static final String SECTION_CLASSIFICATIONS =
            ClassificationReplica.SECTION_CLASSIFICATIONS;
    private static final String SECTION_ASSIGNMENTS = ClassificationReplica.SECTION_ASSIGNMENTS;

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("classification-replica");
        try {
            // Baseline adoption and the unadopted boundary.
            inactiveAuthorityLeavesAndroidUnadopted(directory);
            completeBaselineInstallsAtomically(directory);
            incompleteBaselineNeverReplacesTheReplica(directory);
            baselineChangedLeavesTheReplicaIntact(directory);
            multiPageBaselineAdoption(directory);
            // Ordered replay, idempotence and convergence.
            incrementalChangesRetainLiveAndTombstonedRevisions(directory);
            replayedPageIsIdempotent(directory);
            multiPageCatchUpBeyondOnePage(directory);
            sequenceGapsAndRepeatsAreRejectedAtomically(directory);
            deletedClassificationRemovesTheVisibleFolder(directory);
            assignmentConvergesToTheFinalSingleValue(directory);
            deleteTransitionMovesAssignmentsAndVerifiesItsCount(directory);
            deleteTransitionCountMismatchIsRefused(directory);
            assignmentTombstoneIsRetainedNotAbsent(directory);
            // Durability, restart and resume.
            processRestartPreservesIdentityCursorAndRows(directory);
            interruptedSyncResumesFromTheStoredCursor(directory);
            pageAndCursorCommitTogether(directory);
            storageSeamRollbackIsReal(directory);
            // Reset, rebase and retention.
            cursorExpiryAdoptsAFreshBaseline(directory);
            identityAndEpochChangeReAdopts(directory);
            unsupportedContractFailsClosed(directory);
            accountChangeCannotExposeTheOldReplica(directory);
            wrongScopeReadsNothingAndKeepsTheRowsDurable(directory);
            // Boundaries that must not move.
            noMobileWriteIsEverEmitted(directory);
            classificationResetLeavesAlbumDomainIntact(directory);
            malformedResponsesAreRejected(directory);
        } finally {
            deleteTree(directory);
        }
        System.out.println("ClassificationReplicaTest passed: " + checks + " checks"
                + " (baseline adoption, ordered replay, restart/resume, reset/rebase,"
                + " tombstones, assignment convergence, unadopted boundary)");
    }

    // -----------------------------------------------------------------------
    // Fixture: a real HTTP server serving the server module's exact documents
    // -----------------------------------------------------------------------

    private static final class Fixture implements AutoCloseable {
        interface Handler {
            Response handle(String target);
        }

        static final class Response {
            final int status;
            final String body;

            Response(int status, String body) {
                this.status = status;
                this.body = body;
            }

            static Response ok(String body) { return new Response(200, body); }

            static Response error(int status, String code) {
                return new Response(status, "{\"detail\":{\"code\":\"" + code + "\"}}");
            }
        }

        private final HttpServer server;
        private final Handler handler;
        final List<String> requests = new CopyOnWriteArrayList<>();

        Fixture(Handler handler) throws IOException {
            this.handler = handler;
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::serve);
            server.setExecutor(Executors.newFixedThreadPool(4, task -> {
                Thread thread = new Thread(task, "classification-fixture");
                thread.setDaemon(true);
                return thread;
            }));
            server.start();
        }

        String origin() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

        List<String> paths() { return new ArrayList<>(requests); }

        private void serve(HttpExchange exchange) throws IOException {
            String target = exchange.getRequestURI().toString();
            requests.add(target);
            Response response = handler.handle(target);
            byte[] bytes = response.body == null
                    ? new byte[0] : response.body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(response.status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        }

        @Override
        public void close() { server.stop(0); }
    }

    private static ClassificationReplica.Transport transport(Fixture fixture) {
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

    /**
     * A JSON writer for the harness's own driver requests.
     *
     * The engine and store only *read* JSON, so the reader in {@link Json} stays the
     * only parser in the shipped code. The harness still needs to write a request, and
     * keeping that here rather than adding a writer to the client means the client
     * carries no serialization path that nothing on a device calls.
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
    // Wire documents, in the server module's exact shape
    // -----------------------------------------------------------------------

    /** `/v1/sync/status` with the Classification domain active at `cursor`. */
    private static String status(long cursor) { return statusAt(LIBRARY, 1, 1, cursor); }

    private static String statusAt(String library, long epoch, long contract, long cursor) {
        return "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"" + library + "\","
                + "\"domains\":[{\"domain\":\"classifications\",\"libraryId\":\"" + library + "\","
                + "\"epoch\":" + epoch + ",\"contractVersion\":" + contract + ","
                + "\"cursor\":" + cursor + "}]}";
    }

    private static String inactive() {
        return "{\"protocolVersion\":1,\"active\":false,\"libraryId\":null,\"domains\":[]}";
    }

    /** The immutable role set every baseline page carries. */
    private static String roles() {
        return "[{\"role\":\"originals\",\"classificationId\":\"originals\"}]";
    }

    private static boolean baselineTarget(String target) {
        return target.startsWith(ClassificationReplica.BASELINE_PATH);
    }

    private static boolean changesTarget(String target) {
        return target.startsWith(ClassificationReplica.CHANGES_PATH);
    }

    /**
     * Whether a baseline request is asking for `section`.
     *
     * The opening request carries no `section` at all — the server defines that as the first
     * section, and the client sends an explicit one only once a snapshot cursor is frozen.
     * So "the first section" is true both for an explicit `section=classifications` and for
     * the parameterless opening request.
     */
    private static boolean asksSection(String target, String section) {
        if (target.contains("section=" + section)) return true;
        return !target.contains("section=")
                && SECTION_CLASSIFICATIONS.equals(section);
    }

    private static String classificationItem(String id, String kind, String name, String parent,
                                             long revision) {
        return "{\"id\":\"" + id + "\",\"kind\":\"" + kind + "\",\"name\":\"" + name + "\","
                + "\"parentId\":" + (parent == null ? "null" : "\"" + parent + "\"") + ","
                + "\"iconKey\":null,\"colorKey\":null,\"deleted\":false,"
                + "\"entityRevision\":" + revision + "}";
    }

    private static String tombstoneItem(String id, String kind, String name, long revision) {
        return "{\"id\":\"" + id + "\",\"kind\":\"" + kind + "\",\"name\":\"" + name + "\","
                + "\"parentId\":null,\"iconKey\":null,\"colorKey\":null,\"deleted\":true,"
                + "\"entityRevision\":" + revision + "}";
    }

    private static String assignmentItem(String asset, String classification, long revision) {
        return "{\"assetId\":\"" + asset + "\",\"classificationId\":"
                + (classification == null ? "null" : "\"" + classification + "\"")
                + ",\"entityRevision\":" + revision + "}";
    }

    private static String page(long cursor, String section, String items, String nextAfter,
                               boolean hasMore, boolean complete) {
        return pageAt(1, cursor, section, items, nextAfter, hasMore, complete);
    }

    private static String pageAt(long epoch, long cursor, String section, String items,
                                 String nextAfter, boolean hasMore, boolean complete) {
        return pageFor(LIBRARY, epoch, cursor, section, items, nextAfter, hasMore, complete);
    }

    private static String pageFor(String library, long epoch, long cursor, String section,
                                  String items, String nextAfter, boolean hasMore,
                                  boolean complete) {
        return "{\"libraryId\":\"" + library + "\",\"epoch\":" + epoch
                + ",\"contractVersion\":1,"
                + "\"snapshotCursor\":" + cursor + ",\"section\":\"" + section + "\","
                + "\"roles\":" + roles() + ",\"items\":" + items + ","
                + "\"nextAfter\":" + (nextAfter == null ? "null" : "\"" + nextAfter + "\"") + ","
                + "\"hasMore\":" + hasMore + ",\"complete\":" + complete + "}";
    }

    /** A complete two-section baseline: one originals root, one child, one assignment. */
    private static List<String> completeBaseline(long cursor) {
        return Arrays.asList(
                page(cursor, SECTION_CLASSIFICATIONS,
                        "[" + classificationItem("originals", "root", "Originals", null, 1) + ","
                                + classificationItem("series", "tag", "Series", "originals", 2) + "]",
                        null, false, false),
                page(cursor, SECTION_ASSIGNMENTS,
                        "[" + assignmentItem("asset_1", "series", 1) + "]",
                        null, false, true));
    }

    private static String changesPage(long cursor, String items, long nextAfter, boolean hasMore) {
        return changesPageAt(1, cursor, items, nextAfter, hasMore);
    }

    private static String changesPageAt(long epoch, long cursor, String items, long nextAfter,
                                        boolean hasMore) {
        return "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":" + epoch
                + ",\"contractVersion\":1,"
                + "\"cursor\":" + cursor + ",\"items\":" + items + ","
                + "\"nextAfter\":" + nextAfter + ",\"hasMore\":" + hasMore + "}";
    }

    private static String changeRow(long sequence, String commandType, String payload) {
        return "{\"sequence\":" + sequence + ",\"authorityCursor\":" + sequence + ","
                + "\"commandType\":\"" + commandType + "\","
                + "\"operationId\":\"op-" + sequence + "\","
                + "\"changedAt\":\"2026-09-17T00:00:00Z\"," + payload + "}";
    }

    private static String classificationDelta(String value) {
        return "\"classification\":" + value;
    }

    private static String assignmentDelta(String value) {
        return "\"assignment\":" + value;
    }

    private static String deleteDelta(String value, String from, String to, long affected) {
        return "\"classification\":" + value + ",\"assignmentTransition\":{"
                + "\"fromClassificationId\":\"" + from + "\",\"toClassificationId\":"
                + (to == null ? "null" : "\"" + to + "\"")
                + ",\"affectsAssignments\":" + affected + "}";
    }

    // -----------------------------------------------------------------------
    // 1. The unadopted boundary
    // -----------------------------------------------------------------------

    /**
     * An inactive server leaves Android unadopted, and nothing is written.
     *
     * This is the boundary that keeps the shipped mobile Classification read path in
     * charge: while the domain is not server-authoritative there is no replica to read from
     * and no adoption row, so every existing consumer behaves exactly as before.
     */
    private static void inactiveAuthorityLeavesAndroidUnadopted(Path directory) throws Exception {
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(inactive());
            return Fixture.Response.error(409, ClassificationReplica.CODE_INACTIVE);
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("inactive.sqlite"));
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            check(!result.adopted, "An inactive server leaves Android unadopted");
            check(result.code == null, "An inactive domain is a normal state, not an error");
            equal(null, store.classificationAdopted("scope-a"),
                    "No Classification authority row is written while inactive");
            equal(0L, db.countClassificationAuthority(), "The adoption marker row is absent");
            equal(0L, db.countClassifications(false), "No Classification row is written");
            equal(1, fixture.paths().size(), "Only the status endpoint is called while inactive");
            store.close();
        }
    }

    // -----------------------------------------------------------------------
    // 2. Baseline adoption
    // -----------------------------------------------------------------------

    private static void completeBaselineInstallsAtomically(Path directory) throws Exception {
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(7));
            if (baselineTarget(target)) {
                List<String> pages = completeBaseline(7);
                return Fixture.Response.ok(
                        asksSection(target, SECTION_CLASSIFICATIONS) ? pages.get(0) : pages.get(1));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("baseline.sqlite"));
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            check(result.adopted && result.adoptedBaseline, "A complete baseline is adopted");
            equal(7L, result.localCursor,
                    "The adopted cursor is the snapshot's, not the status reading");

            ClassificationReplica.Adopted authority = store.classificationAdopted("scope-a");
            equal(LIBRARY, authority.libraryId, "Adopted library identity");
            equal(1L, authority.epoch, "Adopted epoch");
            equal(7L, authority.cursor, "Stored cursor");
            equal("2026-09-17T00:00:00Z", authority.reconciledAt,
                    "Successful reconciliation is recorded");
            equal(2L, db.countClassifications(true), "Live Classifications");
            equal(1L, db.countClassificationAuthority(), "One authority row");
            equal("originals", store.classificationRole("scope-a"),
                    "The immutable originals binding is installed with the baseline");
            equal(1L, db.countAssignments(), "One assignment lineage row");

            // The adopted projection is the authority's, so a consumer reads exactly it.
            Map<String, ClassificationReplica.Node> live = store.classificationNodes("scope-a", true);
            equal("Series", live.get("series").name, "Adopted Classification name");
            equal("originals", live.get("series").parentId, "Adopted hierarchy");
            equal(2L, live.get("series").entityRevision, "Adopted revision is retained");
            store.close();
        }
    }

    /**
     * An interrupted walk never replaces the replica.
     *
     * The final assignment page is the only place `complete` may appear, so a walk that
     * stops early leaves the previous state exactly as it was.
     */
    private static void incompleteBaselineNeverReplacesTheReplica(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("incomplete.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        long before = db.countClassifications(true);
        try (Fixture fixture = new Fixture(target -> {
            // A new epoch forces the re-adoption walk, which is the path whose
            // incompleteness must not be able to replace the existing replica.
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(statusAt(LIBRARY, 2, 1, 9));
            if (baselineTarget(target)) {
                if (asksSection(target, SECTION_CLASSIFICATIONS)) {
                    return Fixture.Response.ok(pageAt(2, 9, SECTION_CLASSIFICATIONS,
                            "[" + classificationItem("new", "root", "New", null, 1) + "]",
                            null, false, false));
                }
                // The assignment page carries rows but never reports completeness.
                return Fixture.Response.ok(pageAt(2, 9, SECTION_ASSIGNMENTS,
                        "[" + assignmentItem("asset_2", null, 1) + "]", null, false, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(ClassificationReplica.CODE_MALFORMED, result.code,
                    "An incomplete baseline is refused");
            equal(before, db.countClassifications(true),
                    "A refused walk leaves the previous replica in place");
            equal(1L, store.classificationAdopted("scope-a").epoch,
                    "and does not adopt the epoch it failed to walk");
            store.close();
        }
    }

    private static void baselineChangedLeavesTheReplicaIntact(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("baseline-changed.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        long before = db.countClassifications(true);
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(statusAt(LIBRARY, 2, 1, 3));
            // The second page reports a different frozen snapshot, so the two pages cannot
            // describe one materialized state.
            if (baselineTarget(target)) {
                return Fixture.Response.ok(asksSection(target, SECTION_CLASSIFICATIONS)
                        ? pageAt(2, 3, SECTION_CLASSIFICATIONS,
                                "[" + classificationItem("x", "root", "X", null, 1) + "]",
                                null, false, false)
                        : pageAt(2, 4, SECTION_ASSIGNMENTS, "[]", null, false, true));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            // The specific cause is reported: pages that froze different snapshots cannot
            // describe one materialized state, which is `baselineChanged` rather than a
            // generic malformed-shape complaint.
            equal(ClassificationReplica.CODE_BASELINE_CHANGED, result.code,
                    "Pages describing different snapshots are refused as a changed baseline");
            equal(before, db.countClassifications(true), "The previous replica survives");
            equal(1L, store.classificationAdopted("scope-a").epoch,
                    "and the epoch it failed to walk is not adopted");
            store.close();
        }
    }

    private static void multiPageBaselineAdoption(Path directory) throws Exception {
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(5));
            if (baselineTarget(target)) {
                if (asksSection(target, SECTION_CLASSIFICATIONS)) {
                    if (target.contains("after=alpha")) {
                        return Fixture.Response.ok(page(5, SECTION_CLASSIFICATIONS,
                                "[" + classificationItem("beta", "root", "Beta", null, 1) + "]",
                                null, false, false));
                    }
                    return Fixture.Response.ok(page(5, SECTION_CLASSIFICATIONS,
                            "[" + classificationItem("alpha", "root", "Alpha", null, 1) + "]",
                            "alpha", true, false));
                }
                if (target.contains("after=asset_1")) {
                    return Fixture.Response.ok(page(5, SECTION_ASSIGNMENTS,
                            "[" + assignmentItem("asset_2", "beta", 1) + "]",
                            null, false, true));
                }
                return Fixture.Response.ok(page(5, SECTION_ASSIGNMENTS,
                        "[" + assignmentItem("asset_1", "alpha", 1) + "]",
                        "asset_1", true, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("multipage.sqlite"));
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            check(result.adoptedBaseline, "A multi-page baseline is adopted");
            equal(2L, db.countClassifications(true), "Classifications from both pages");
            equal(2L, db.countAssignments(), "Assignments from both pages");
            equal(5L, store.classificationAdopted("scope-a").cursor, "The snapshot cursor is adopted");
            store.close();
        }
    }

    // -----------------------------------------------------------------------
    // 3. Ordered replay, idempotence, convergence
    // -----------------------------------------------------------------------

    private static void incrementalChangesRetainLiveAndTombstonedRevisions(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("changes.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(2,
                        "[" + changeRow(2, "renameClassification",
                                classificationDelta(classificationItem("series", "tag", "Renamed",
                                        "originals", 3))) + "]",
                        2, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(1, result.appliedChanges, "One change row applied");
            equal(2L, result.localCursor, "The cursor advanced to the page's continuation");
            equal("Renamed", store.classificationNodes("scope-a", true).get("series").name,
                    "The renamed value is visible");
            equal(3L, store.classificationNodes("scope-a", true).get("series").entityRevision,
                    "The live revision is retained");
            store.close();
        }
    }

    /**
     * Re-applying an already-consumed page is refused by contiguity, not applied twice.
     *
     * The cursor is the proof: a page whose rows do not continue from the stored cursor is
     * refused inside the transaction, so a replayed response cannot double-apply.
     */
    private static void replayedPageIsIdempotent(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("replay.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        String pageBody = changesPage(2,
                "[" + changeRow(2, "renameClassification",
                        classificationDelta(classificationItem("series", "tag", "Once",
                                "originals", 3))) + "]",
                2, false);
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) return Fixture.Response.ok(pageBody);
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            engine.reconcile("scope-a");
            equal("Once", store.classificationNodes("scope-a", true).get("series").name,
                    "The change applied once");
            equal(2L, store.classificationAdopted("scope-a").cursor, "Cursor advanced once");

            // The same response arrives again. The stored cursor is now 2, so the engine asks
            // from there and the already-consumed page is not re-applied: at-least-once
            // transport cannot become a duplicated logical mutation.
            ClassificationAuthoritySync.Result second = engine.reconcile("scope-a");
            equal(0, second.appliedChanges, "An already-consumed page is not re-applied");
            equal(2L, store.classificationAdopted("scope-a").cursor, "and the cursor stays put");
            equal("Once", store.classificationNodes("scope-a", true).get("series").name,
                    "A repeated response cannot double-apply");
            equal(3L, store.classificationNodes("scope-a", true).get("series").entityRevision,
                    "and cannot invent a second revision");
            String asked = fixture.paths().stream()
                    .filter(ClassificationReplicaTest::changesTarget).reduce((a, b) -> b).orElse("");
            check(asked.contains("after=2"), "The pass resumed from its own stored cursor");
            store.close();
        }
    }

    private static void multiPageCatchUpBeyondOnePage(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("catchup.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            // The authority cursor must agree with the pages: a page may not advertise a
            // continuation beyond the cursor the status reported.
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(105));
            if (changesTarget(target)) {
                // The reference baseline adopted cursor 1, so the first catch-up request is
                // `after=1` and asks for rows 2..101 (the server's maximum page size). The
                // second request continues from 101 and finishes the log.
                // `cursor` in the envelope is the *authority* cursor on every page; only
                // `nextAfter` walks. The server derives `hasMore` as `nextAfter < cursor`,
                // so a page whose envelope claimed 101 would be self-inconsistent.
                if (target.contains("after=101")) {
                    StringBuilder tail = new StringBuilder();
                    for (int i = 102; i <= 105; i++) {
                        if (i > 102) tail.append(',');
                        tail.append(changeRow(i, "renameClassification",
                                classificationDelta(classificationItem("series", "tag",
                                        "Name" + i, "originals", i + 1))));
                    }
                    return Fixture.Response.ok(changesPage(105, "[" + tail + "]", 105, false));
                }
                StringBuilder rows = new StringBuilder();
                for (int i = 2; i <= 101; i++) {
                    if (i > 2) rows.append(',');
                    rows.append(changeRow(i, "renameClassification",
                            classificationDelta(classificationItem("series", "tag",
                                    "Name" + i, "originals", i + 1))));
                }
                return Fixture.Response.ok(changesPage(105, "[" + rows + "]", 101, true));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(104, result.appliedChanges, "Catch-up spans more than one page");
            equal(105L, result.localCursor, "The final continuation is stored");
            equal("Name105", store.classificationNodes("scope-a", true).get("series").name,
                    "The last page's value is visible");
            store.close();
        }
    }

    private static void sequenceGapsAndRepeatsAreRejectedAtomically(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("gaps.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        long before = db.countClassifications(true);
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(3));
            if (changesTarget(target)) {
                // Sequence 3 arrives with 2 missing: the page is not contiguous.
                return Fixture.Response.ok(changesPage(3,
                        "[" + changeRow(3, "renameClassification",
                                classificationDelta(classificationItem("series", "tag", "Gap",
                                        "originals", 3))) + "]",
                        3, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(ClassificationReplica.CODE_MALFORMED, result.code, "A gap is refused");
            equal(before, db.countClassifications(true), "and writes nothing");
            equal(1L, store.classificationAdopted("scope-a").cursor, "and does not move the cursor");
            store.close();
        }
    }

    /**
     * A deleted Classification leaves no visible folder while its revision stays readable.
     *
     * The tombstone is revision state a later dependent command must present, so it is
     * retained rather than removed — the same rule the PC replica follows.
     */
    private static void deletedClassificationRemovesTheVisibleFolder(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("tombstone.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(2,
                        "[" + changeRow(2, "deleteClassification",
                                deleteDelta(tombstoneItem("series", "tag", "Series", 3),
                                        "series", null, 1)) + "]",
                        2, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            engine.reconcile("scope-a");
            Map<String, ClassificationReplica.Node> live =
                    store.classificationNodes("scope-a", true);
            check(!live.containsKey("series"), "A deleted Classification is not a visible folder");
            Map<String, ClassificationReplica.Node> all =
                    store.classificationNodes("scope-a", false);
            check(all.containsKey("series"), "but its tombstone row is retained");
            check(all.get("series").deleted, "and it is marked deleted");
            equal(3L, all.get("series").entityRevision, "carrying the tombstone's real revision");
            check(!live.containsKey("originals") == false, "The live root is untouched");
            store.close();
        }
    }

    /**
     * Assignment converges to its final single value, never to a set.
     *
     * Assignment is single-valued in the authority contract, so a replica that accumulated
     * relations would be able to publish an Asset in two folders — a state the contract
     * cannot represent and no command could deliver.
     */
    private static void assignmentConvergesToTheFinalSingleValue(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("assignment.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(4));
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(4,
                        "[" + changeRow(2, "setAssetClassification",
                                assignmentDelta(assignmentItem("asset_1", "originals", 2))) + ","
                        + changeRow(3, "setAssetClassification",
                                assignmentDelta(assignmentItem("asset_1", "series", 3))) + ","
                        + changeRow(4, "setAssetClassification",
                                assignmentDelta(assignmentItem("asset_1", null, 4))) + "]",
                        4, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            engine.reconcile("scope-a");
            Map<String, ClassificationReplica.Assignment> assignments =
                    store.classificationAssignments("scope-a");
            equal(1, assignments.size(), "One row per Asset, not one per relation");
            equal(null, assignments.get("asset_1").classificationId,
                    "The final desired state wins");
            equal(4L, assignments.get("asset_1").entityRevision,
                    "At the revision the server reported last");
            equal(1L, db.countAssignments(), "The lineage is a single row");
            store.close();
        }
    }

    /**
     * A delete's transition moves every affected assignment and verifies its own count.
     *
     * The count is the server's own `affectsAssignments`, so a replica whose retained
     * lineage disagrees is caught rather than silently converging to a different state.
     */
    private static void deleteTransitionMovesAssignmentsAndVerifiesItsCount(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("transition.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) {
                // The baseline has exactly one assignment naming `series`, so the server's
                // transition count must be 1.
                return Fixture.Response.ok(changesPage(2,
                        "[" + changeRow(2, "deleteClassification",
                                deleteDelta(tombstoneItem("series", "tag", "Series", 3),
                                        "series", "originals", 1)) + "]",
                        2, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            engine.reconcile("scope-a");
            ClassificationReplica.Assignment moved =
                    store.classificationAssignments("scope-a").get("asset_1");
            equal("originals", moved.classificationId,
                    "The affected Asset moved to the deleted node's parent");
            equal(2L, moved.entityRevision, "Its lineage advanced by exactly one");
            store.close();
        }
    }

    /**
     * A delete whose transition count disagrees with this replica is refused.
     *
     * `affectsAssignments` is the server's own count of the assignments that named the
     * deleted Classification, and the baseline carries every assignment row including
     * unassigned ones. So this replica holds the complete lineage, and a count that
     * disagrees is real divergence or protocol corruption — not a legitimate difference in
     * what has been materialized. Accepting it would silently converge to a different state
     * than the authority holds.
     */
    private static void deleteTransitionCountMismatchIsRefused(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("transition-mismatch.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) {
                // The baseline has exactly one assignment naming `series`, so a count of 5
                // cannot describe this replica's state.
                return Fixture.Response.ok(changesPage(2,
                        "[" + changeRow(2, "deleteClassification",
                                deleteDelta(tombstoneItem("series", "tag", "Series", 3),
                                        "series", "originals", 5)) + "]",
                        2, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(ClassificationReplica.CODE_MALFORMED, result.code,
                    "A transition count that disagrees is refused");
            equal(1L, store.classificationAdopted("scope-a").cursor,
                    "and the page writes nothing and does not advance the cursor");
            check(!store.classificationNodes("scope-a", true).get("series").deleted,
                    "and the Classification is not left half-deleted");
            equal("series", store.classificationAssignments("scope-a").get("asset_1")
                            .classificationId,
                    "and its assignments were not moved");
            store.close();
        }
    }

    private static void assignmentTombstoneIsRetainedNotAbsent(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("assignment-tombstone.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(2,
                        "[" + changeRow(2, "setAssetClassification",
                                assignmentDelta(assignmentItem("asset_1", null, 2))) + "]",
                        2, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            engine.reconcile("scope-a");
            Map<String, ClassificationReplica.Assignment> assignments =
                    store.classificationAssignments("scope-a");
            // An authoritative unassign is a retained row with a null value at a real
            // revision. Removing it would make a cleared Asset look like one the authority
            // never mentioned, so a later command would present revision 0 for a lineage
            // that had legitimately advanced.
            check(assignments.containsKey("asset_1"),
                    "An authoritative unassign keeps its lineage row");
            equal(null, assignments.get("asset_1").classificationId, "with a null value");
            equal(2L, assignments.get("asset_1").entityRevision, "at the real revision");
            store.close();
        }
    }

    // -----------------------------------------------------------------------
    // 4. Durability, restart, resume
    // -----------------------------------------------------------------------

    /**
     * A restart preserves identity, cursor and rows.
     *
     * The replica is a file, so a process restart must resume from exactly what it held
     * rather than re-walking the baseline or losing tombstones.
     */
    private static void processRestartPreservesIdentityCursorAndRows(Path directory)
            throws Exception {
        Path file = directory.resolve("restart.sqlite");
        {
            SqliteDb db = new SqliteDb(file);
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installReferenceBaseline(store, "scope-a");
            store.close();
        }
        // A second store over the same file is what a restarted process sees.
        SqliteDb db = new SqliteDb(file);
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        ClassificationReplica.Adopted authority = store.classificationAdopted("scope-a");
        equal(LIBRARY, authority.libraryId, "Identity survives a restart");
        equal(1L, authority.epoch, "Epoch survives a restart");
        equal(1L, authority.cursor, "Cursor survives a restart");
        equal(2L, db.countClassifications(true), "Classification rows survive a restart");
        equal(1L, db.countAssignments(), "Assignment rows survive a restart");
        equal("originals", store.classificationRole("scope-a"), "The role survives a restart");
        store.close();
    }

    /**
     * An interrupted sync resumes from the stored cursor rather than from zero.
     *
     * The engine asks for changes *after* its stored cursor, so a pass that failed midway
     * continues where it stopped instead of re-reading history it already applied.
     */
    private static void interruptedSyncResumesFromTheStoredCursor(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("resume.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        // First pass: the server fails, so the cursor must not move.
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(3));
            return Fixture.Response.error(503, "unavailable");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            check(result.code != null, "A failing server is reported");
            equal(1L, store.classificationAdopted("scope-a").cursor,
                    "A failed pass leaves the cursor where it was");
        }
        // Second pass: the request must be made *from* the stored cursor.
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(3));
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(3,
                        "[" + changeRow(2, "renameClassification",
                                classificationDelta(classificationItem("series", "tag", "Resumed",
                                        "originals", 3))) + ","
                        + changeRow(3, "renameClassification",
                                classificationDelta(classificationItem("series", "tag", "Done",
                                        "originals", 4))) + "]",
                        3, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(2, result.appliedChanges, "The resumed pass applies the remaining rows");
            equal(3L, store.classificationAdopted("scope-a").cursor, "and advances to the end");
            equal("Done", store.classificationNodes("scope-a", true).get("series").name,
                    "The final state converges");
            String asked = fixture.paths().stream().filter(ClassificationReplicaTest::changesTarget)
                    .findFirst().orElse("");
            check(asked.contains("after=1"),
                    "The catch-up was requested from the stored cursor, not from zero");
            store.close();
        }
    }

    private static void pageAndCursorCommitTogether(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("atomic.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        // Fail the cursor advance, so a page that is one transaction must leave nothing.
        db.failOn = "classification_authority SET cursor";
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(2,
                        "[" + changeRow(2, "renameClassification",
                                classificationDelta(classificationItem("series", "tag", "Partial",
                                        "originals", 3))) + "]",
                        2, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            boolean failed = false;
            try {
                engine.reconcile("scope-a");
            } catch (RuntimeException expected) {
                failed = true;
            }
            check(failed, "A failing cursor write fails the pass");
        } finally {
            db.failOn = null;
        }
        equal("Series", store.classificationNodes("scope-a", true).get("series").name,
                "The page's rows were rolled back with its cursor");
        equal(1L, store.classificationAdopted("scope-a").cursor,
                "and the cursor did not advance over rows it never wrote");
        store.close();
    }

    /** The storage seam's rollback must be a real engine rollback, not a bookkeeping one. */
    private static void storageSeamRollbackIsReal(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("rollback.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        db.begin();
        db.writeClassification(new ClassificationReplica.Node("temp", "root", "Temp", null, null,
                null, false, 1), CLOCK.now());
        db.rollback();
        equal(0L, db.countClassifications(false),
                "A rolled-back write leaves no row in the engine");
        store.close();
    }

    // -----------------------------------------------------------------------
    // 5. Reset, rebase and retention
    // -----------------------------------------------------------------------

    /**
     * An expired cursor recovers by adopting a fresh baseline under the same identity.
     *
     * Retention pruning is exactly what makes a stored cursor unusable, and the recovery is
     * a complete replacement of this domain's confirmed state rather than a partial merge.
     */
    private static void cursorExpiryAdoptsAFreshBaseline(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("expired.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(10));
            if (changesTarget(target)) {
                return Fixture.Response.error(409, ClassificationReplica.CODE_CURSOR_EXPIRED);
            }
            if (baselineTarget(target)) {
                if (asksSection(target, SECTION_CLASSIFICATIONS)) {
                    return Fixture.Response.ok(page(10, SECTION_CLASSIFICATIONS,
                            "[" + classificationItem("originals", "root", "Originals", null, 1)
                                    + ","
                                    + classificationItem("fresh", "root", "Fresh", null, 1) + "]",
                            null, false, false));
                }
                return Fixture.Response.ok(page(10, SECTION_ASSIGNMENTS,
                        "[" + assignmentItem("asset_9", "fresh", 1) + "]", null, false, true));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(ClassificationReplica.CODE_CURSOR_EXPIRED, result.code,
                    "The expiry is reported, not hidden");
            check(result.adoptedBaseline && result.readopted,
                    "Recovery is a fresh baseline replacing this domain's replica");
            equal(10L, store.classificationAdopted("scope-a").cursor, "The new snapshot cursor");
            Map<String, ClassificationReplica.Node> live =
                    store.classificationNodes("scope-a", true);
            check(live.containsKey("fresh"), "The fresh baseline's rows are installed");
            check(!live.containsKey("series"), "and the replaced replica's rows are gone");
            equal(1L, db.countAssignments(), "The assignment set was replaced, not merged");
            store.close();
        }
    }

    private static void identityAndEpochChangeReAdopts(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("epoch.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) {
                return Fixture.Response.ok(statusAt(OTHER_LIBRARY, 2, 1, 1));
            }
            if (baselineTarget(target)) {
                if (asksSection(target, SECTION_CLASSIFICATIONS)) {
                    return Fixture.Response.ok(pageFor(OTHER_LIBRARY, 2, 1,
                            SECTION_CLASSIFICATIONS,
                            "[" + classificationItem("originals", "root", "Originals", null, 1)
                                    + "]",
                            null, false, false));
                }
                return Fixture.Response.ok(pageFor(OTHER_LIBRARY, 2, 1, SECTION_ASSIGNMENTS, "[]",
                        null, false, true));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            check(result.readopted, "A new library/epoch re-adopts instead of catching up");
            equal(OTHER_LIBRARY, store.classificationAdopted("scope-a").libraryId,
                    "The stored identity is replaced");
            equal(2L, store.classificationAdopted("scope-a").epoch, "The stored epoch is replaced");
            equal(0L, db.countAssignments(), "The replaced library's assignments are gone");
            store.close();
        }
    }

    private static void unsupportedContractFailsClosed(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("contract.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(statusAt(LIBRARY, 1, 9, 1));
            return Fixture.Response.error(404, "notFound");
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(ClassificationReplica.CODE_CONTRACT_UNSUPPORTED, result.code,
                    "A contract this build cannot speak is refused, not approximated");
            equal(1L, store.classificationAdopted("scope-a").cursor,
                    "and the stored replica is left alone");
            equal(2L, db.countClassifications(true), "including its rows");
            store.close();
        }
    }

    /**
     * A replaced connection cannot read the previous account's replica.
     *
     * The stored scope is what makes that a stored fact rather than a hope that every
     * caller remembered to clear.
     */
    private static void accountChangeCannotExposeTheOldReplica(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("scope.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        equal(null, store.classificationAdopted("scope-b"),
                "Another connection sees no adoption");
        equal(0, store.classificationNodes("scope-b", true).size(),
                "and no Classification rows");
        equal(0, store.classificationAssignments("scope-b").size(),
                "and no assignment rows");
        equal(null, store.classificationRole("scope-b"), "and no role binding");
        Object count = store.classificationStatus("scope-b").get("classificationCount");
        equal(0L, count, "and reports zero counts rather than the other scope's totals");
        equal(2L, db.countClassifications(true),
                "The rows stay durable for whichever scope owns them");
        store.close();
    }

    private static void wrongScopeReadsNothingAndKeepsTheRowsDurable(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("wrong-scope.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        // Every read is scoped, so a mismatched caller cannot serve one connection's rows
        // under another's identity even though the file still holds them.
        equal(0, store.classificationNodes("other", false).size(),
                "A mismatched classification read returns nothing");
        equal(0, store.classificationAssignments("other").size(),
                "A mismatched assignment read returns nothing");
        equal(2L, db.countClassifications(false), "and nothing was deleted to achieve that");
        store.close();
    }

    // -----------------------------------------------------------------------
    // 6. Boundaries that must not move
    // -----------------------------------------------------------------------

    /**
     * The read replica can never emit a mobile Classification write.
     *
     * This is the phase boundary, enforced structurally: the transport the engine is given
     * exposes GET only, and a full reconcile — including every coded failure path — makes no
     * other request. Android Classification writes belong to a later phase, and no part of
     * this read path can issue one by accident.
     */
    private static void noMobileWriteIsEverEmitted(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("no-write.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        // A pass that adopts, one that catches up, and one that hits every coded failure.
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(1));
            if (baselineTarget(target)) {
                List<String> pages = completeBaseline(1);
                return Fixture.Response.ok(
                        asksSection(target, SECTION_CLASSIFICATIONS) ? pages.get(0) : pages.get(1));
            }
            if (changesTarget(target)) {
                return Fixture.Response.ok(changesPage(1, "[]", 1, false));
            }
            return Fixture.Response.error(409, ClassificationReplica.CODE_CURSOR_EXPIRED);
        })) {
            ClassificationAuthoritySync engine =
                    new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
            engine.reconcile("scope-a");
            engine.reconcile("scope-a");
            for (String path : fixture.paths()) {
                check(path.startsWith("/v1/sync/status")
                                || path.startsWith(ClassificationReplica.BASELINE_PATH)
                                || path.startsWith(ClassificationReplica.CHANGES_PATH),
                        "Only the three read routes are ever requested: " + path);
            }
            check(!fixture.paths().isEmpty(), "The pass did make requests");
        }
        // The engine holds no write seam at all, so there is no method that could send one.
        for (java.lang.reflect.Method method
                : ClassificationReplica.Transport.class.getDeclaredMethods()) {
            equal("get", method.getName(),
                    "The Classification transport exposes GET only");
        }
        // And no Classification outbox table exists to hold an outgoing command.
        equal(0L, db.countClassificationOutboxTables(),
                "The replica schema carries no Classification outbox");
        store.close();
    }

    /**
     * Clearing the Classification replica leaves every other domain intact.
     *
     * Domains have separate lifetimes: a Classification reset must not take Album, Bookmark
     * or user media state with it.
     */
    private static void classificationResetLeavesAlbumDomainIntact(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("reset.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        // An Album row and membership in the same database, owned by the same scope.
        db.begin();
        db.writeAuthority(new ReplicaDb.StoredAuthority("scope-a", LIBRARY, 1, 1, 4,
                CLOCK.now(), CLOCK.now()));
        db.writeAlbum(new AlbumReplica.Album("album-1", "Album", null, null, null, false, 1),
                CLOCK.now());
        db.writeMember(new AlbumReplica.Member("album-1", "asset_1", true, 1), CLOCK.now());
        db.commit();

        equal(1L, db.countClassificationAuthority(), "The Classification domain is adopted");
        equal(1L, db.countAuthority(), "The Album domain is adopted");

        store.clearClassifications();

        equal(0L, db.countClassificationAuthority(), "The Classification domain is cleared");
        equal(0L, db.countClassifications(false), "including its Classification rows");
        equal(0L, db.countAssignments(), "and its assignment lineage");
        // The other domain is untouched: same authority, same rows.
        equal(1L, db.countAuthority(), "The Album authority row survives a Classification reset");
        equal(1L, db.countAlbums(true), "The Album row survives");
        equal(1L, db.countMembers(true), "The membership row survives");
        store.close();
    }

    /**
     * Malformed responses are refused rather than interpreted.
     *
     * Each case is a document the contract does not define: a wrong section, a tombstone
     * where a live row belongs, a multi-valued delta, a role the build cannot interpret, and
     * a numeric field of the wrong type.
     */
    private static void malformedResponsesAreRejected(Path directory) throws Exception {
        List<String> badPages = new ArrayList<>();
        // A page whose declared section disagrees with its rows.
        badPages.add(page(1, SECTION_ASSIGNMENTS,
                "[" + classificationItem("x", "root", "X", null, 1) + "]", null, false, true));
        // A Classification page claiming completeness.
        badPages.add(page(1, SECTION_CLASSIFICATIONS,
                "[" + classificationItem("x", "root", "X", null, 1) + "]", null, false, true));
        // A baseline page carrying a tombstone, which only a change row may.
        badPages.add(page(1, SECTION_CLASSIFICATIONS, "[" + tombstoneItem("x", "root", "X", 1) + "]",
                null, false, false));
        // An unsupported role binding.
        badPages.add("{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"snapshotCursor\":1,\"section\":\"" + SECTION_CLASSIFICATIONS + "\","
                + "\"roles\":[{\"role\":\"other\",\"classificationId\":\"originals\"}],"
                + "\"items\":[],\"nextAfter\":null,\"hasMore\":false,\"complete\":false}");
        // A missing role set: the protected id would be uninterpretable.
        badPages.add("{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"snapshotCursor\":1,\"section\":\"" + SECTION_CLASSIFICATIONS + "\","
                + "\"items\":[],\"nextAfter\":null,\"hasMore\":false,\"complete\":false}");
        // A revision sent as a string rather than an integral number.
        badPages.add(page(1, SECTION_CLASSIFICATIONS,
                "[{\"id\":\"x\",\"kind\":\"root\",\"name\":\"X\",\"parentId\":null,"
                        + "\"iconKey\":null,\"colorKey\":null,\"deleted\":false,"
                        + "\"entityRevision\":\"1\"}]",
                null, false, false));

        for (String bad : badPages) {
            SqliteDb db = new SqliteDb(directory.resolve("malformed-" + badPages.indexOf(bad)
                    + ".sqlite"));
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            try (Fixture fixture = new Fixture(target -> {
                if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(1));
                if (baselineTarget(target)) return Fixture.Response.ok(bad);
                return Fixture.Response.error(404, "notFound");
            })) {
                ClassificationAuthoritySync engine =
                        new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
                ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
                equal(ClassificationReplica.CODE_MALFORMED, result.code,
                        "A malformed baseline is refused");
                equal(0L, db.countClassificationAuthority(), "and adopts nothing");
                store.close();
            }
        }

        // Change rows that the contract does not define.
        List<String> badChanges = new ArrayList<>();
        // Two deltas at once.
        badChanges.add(changesPage(2, "[" + changeRow(2, "renameClassification",
                classificationDelta(classificationItem("series", "tag", "N", "originals", 3))
                        + "," + assignmentDelta(assignmentItem("asset_1", "series", 2))) + "]",
                2, false));
        // A payload that disagrees with its own command type.
        badChanges.add(changesPage(2, "[" + changeRow(2, "setAssetClassification",
                classificationDelta(classificationItem("series", "tag", "N", "originals", 3))) + "]",
                2, false));
        // A delete whose transition names a different Classification than its tombstone.
        badChanges.add(changesPage(2, "[" + changeRow(2, "deleteClassification",
                deleteDelta(tombstoneItem("series", "tag", "S", 3), "other", null, 1)) + "]",
                2, false));
        // A live row where a tombstone belongs.
        badChanges.add(changesPage(2, "[" + changeRow(2, "deleteClassification",
                deleteDelta(classificationItem("series", "tag", "S", "originals", 3), "series",
                        null, 1)) + "]",
                2, false));
        // A tombstone that still names a parent. The server clears the parent inside the
        // same delete that sets the tombstone, so accepting one would let a malformed page
        // reinsert a deleted Classification into the hierarchy.
        badChanges.add(changesPage(2, "[" + changeRow(2, "deleteClassification",
                deleteDelta(
                        "{\"id\":\"series\",\"kind\":\"tag\",\"name\":\"S\","
                                + "\"parentId\":\"originals\",\"iconKey\":null,"
                                + "\"colorKey\":null,\"deleted\":true,\"entityRevision\":3}",
                        "series", null, 1)) + "]",
                2, false));
        // An unknown command type.
        badChanges.add(changesPage(2, "[" + changeRow(2, "explodeClassification",
                classificationDelta(classificationItem("series", "tag", "S", "originals", 3))) + "]",
                2, false));
        // A revision-0 assignment change, which is the "no row" representation.
        badChanges.add(changesPage(2, "[" + changeRow(2, "setAssetClassification",
                assignmentDelta(assignmentItem("asset_1", null, 0))) + "]",
                2, false));

        for (String bad : badChanges) {
            SqliteDb db = new SqliteDb(directory.resolve("badchange-"
                    + badChanges.indexOf(bad) + ".sqlite"));
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installReferenceBaseline(store, "scope-a");
            long before = db.countClassifications(false);
            try (Fixture fixture = new Fixture(target -> {
                if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(2));
                if (changesTarget(target)) return Fixture.Response.ok(bad);
                return Fixture.Response.error(404, "notFound");
            })) {
                ClassificationAuthoritySync engine =
                        new ClassificationAuthoritySync(transport(fixture), store, CLOCK);
                ClassificationAuthoritySync.Result result = engine.reconcile("scope-a");
                equal(ClassificationReplica.CODE_MALFORMED, result.code,
                        "A malformed change page is refused");
                equal(before, db.countClassifications(false), "and writes nothing");
                equal(1L, store.classificationAdopted("scope-a").cursor,
                        "and does not advance the cursor");
                store.close();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Reference state
    // -----------------------------------------------------------------------

    /** Adopt the standard two-Classification baseline at cursor 1 under `scope`. */
    private static void installReferenceBaseline(LibraryReplicaStore store, String scope) {
        ClassificationReplica.Adopted authority = new ClassificationReplica.Adopted(scope, LIBRARY,
                1, 1, 1, CLOCK.now(), CLOCK.now());
        store.installBaseline(authority,
                Arrays.asList(
                        new ClassificationReplica.Node("originals", "root", "Originals", null, null,
                                null, false, 1),
                        new ClassificationReplica.Node("series", "tag", "Series", "originals", null,
                                null, false, 2)),
                Arrays.asList(new ClassificationReplica.Assignment("asset_1", "series", 1)),
                Arrays.asList(new ClassificationReplica.Role("originals", "originals")),
                CLOCK.now());
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

    // -----------------------------------------------------------------------
    // The production storage seam over a real SQLite engine
    // -----------------------------------------------------------------------

    /**
     * The production {@link ReplicaDb} seam over a real SQLite engine.
     *
     * The Android database API is a compile-time stub outside Android, so the alternative
     * was to keep SQL on the Android side of the seam — which would have left the store's
     * rules untestable. Instead the seam is semantic, and this adapter gives it a real
     * engine, real files and real transactions, using Python's bundled `sqlite3` module.
     */
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
        /**
         * Lets a check fail one specific write, so atomicity is observed instead of
         * assumed. A page that is one transaction must leave nothing behind when any part
         * of it fails, including the cursor advance itself.
         */
        String failOn;

        SqliteDb(Path file) throws IOException {
            Path driver = Files.createTempFile("replica-driver", ".py");
            Files.write(driver, DRIVER.getBytes(StandardCharsets.UTF_8));
            driver.toFile().deleteOnExit();
            process = new ProcessBuilder(python(), driver.toString(), file.toString())
                    .redirectErrorStream(false)
                    .start();
            input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),
                    StandardCharsets.UTF_8));
            output = new BufferedReader(new InputStreamReader(process.getInputStream(),
                    StandardCharsets.UTF_8));
            for (String statement : ReplicaSchema.DDL) exec(statement);
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

        private void exec(String sql, Object... arguments) {
            if (failOn != null && sql.contains(failOn)) {
                throw new IllegalStateException("Injected storage failure");
            }
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
            return value == null ? 0 : ((Number) value).longValue();
        }

        long countClassifications(boolean liveOnly) { return classifications(liveOnly).size(); }

        long countAssignments() { return assignments().size(); }

        long countClassificationAuthority() {
            return classificationAuthority() == null ? 0 : 1;
        }

        /** Whether the schema carries any Classification outbox table at all. */
        long countClassificationOutboxTables() {
            List<List<Object>> rows = select("SELECT COUNT(*) FROM sqlite_master"
                    + " WHERE type='table' AND name LIKE '%classification%outbox%'");
            return rows.isEmpty() ? 0 : asLong(rows.get(0).get(0));
        }

        long countAlbums(boolean liveOnly) { return albums(liveOnly).size(); }

        long countMembers(boolean liveOnly) { return members(liveOnly).size(); }

        long countAuthority() { return authority() == null ? 0 : 1; }

        // ---- Album domain (unchanged, retained so the boundary checks can use it) ----

        @Override
        public StoredAuthority authority() {
            List<List<Object>> rows = select(ReplicaSchema.READ_AUTHORITY);
            if (rows.isEmpty()) return null;
            List<Object> row = rows.get(0);
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
        public List<OutboxRow> outbox() { return new ArrayList<>(); }

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
        public void writeOutbox(OutboxRow row) { /* No Classification or Album write in this harness. */ }

        @Override
        public void deleteOutbox(long seq) { /* unused */ }

        @Override
        public void blockOutbox(long seq, String code, String detail) { /* unused */ }

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
            if (rows.isEmpty()) return null;
            List<Object> row = rows.get(0);
            return new StoredAuthority((String) row.get(0), (String) row.get(1), asLong(row.get(2)),
                    asLong(row.get(3)), asLong(row.get(4)), (String) row.get(5), (String) row.get(6));
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
}
