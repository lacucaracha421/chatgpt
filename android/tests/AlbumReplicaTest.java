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
 * Album replica checks: the domain rules, the durable store and the sync engine.
 *
 * Everything here runs the shipped code against a real engine, rather than re-testing a
 * paraphrase of it:
 *
 * * **The engine talks to a real HTTP server.** The fixture serves the exact
 *   `/v1/sync/status`, `/v1/albums/baseline` and `/v1/albums/changes` documents the
 *   server module produces, so paging, section ordering and every coded failure are
 *   exercised through the real request path.
 * * **The store runs against a real SQLite engine.** {@link SqliteDb} implements the
 *   production {@link ReplicaDb} seam over the `sqlite3` CLI and executes the shipped
 *   {@link ReplicaSchema} statements, so the durability checks reopen a real file and
 *   the store's own transaction boundaries are what is being observed.
 * * **Nothing depends on the Android `org.json` stub.** The engine and parser use the
 *   platform-independent {@link Json} reader, which is what lets this run in a plain
 *   JVM; a check below fails loudly if an Android class is reached instead.
 */
public final class AlbumReplicaTest {
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

    private static String codeOf(AlbumAuthoritySync.Result result) {
        return result.code == null ? "" : result.code;
    }

    /** A fixed clock, so stored timestamps are asserted rather than incidental. */
    private static final AlbumReplica.Clock CLOCK = () -> "2026-09-16T00:00:00Z";

    private static final String LIBRARY = "0123456789abcdef0123456789abcdef";
    private static final String OTHER_LIBRARY = "fedcba9876543210fedcba9876543210";

    /**
     * The one place this check serializes JSON.
     *
     * The engine and store only *read* JSON, so the reader in {@link Json} stays the only
     * parser in the shipped code. The harness still needs to write a request, and keeping
     * that here rather than adding a writer to the client means the client carries no
     * serialization path that nothing on a device calls.
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
    // Local HTTP fixture
    // -----------------------------------------------------------------------

    /** A real HTTP server serving recorded domain documents. */
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
                Thread thread = new Thread(task, "album-fixture");
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

    private static AlbumReplica.Transport transport(Fixture fixture) {
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
                    throw new AlbumReplica.HttpFailure(status, body);
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
    // SQLite harness driven through the production storage seam
    // -----------------------------------------------------------------------

    /**
     * The production {@link ReplicaDb} seam over a real SQLite engine.
     *
     * The Android database API is a compile-time stub outside Android, so the alternative
     * was to keep SQL on the Android side of the seam — which would have left the store's
     * rules untestable. Instead the seam is semantic, and this adapter gives it a real
     * engine, real files and real transactions, using Python's bundled `sqlite3` module.
     *
     * Python 3 is already a build prerequisite for this client, and the module is part of
     * its standard library, so this adds no dependency and works on every supported host.
     * Values are bound as parameters — never escaped into SQL text — so the store's own
     * statements are what is executed, unchanged.
     */
    private static final class SqliteDb implements ReplicaDb {
        /** One SQL request and its reply, exchanged as a line of JSON. */
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

        /** The interpreter to drive the engine with. */
        private static String python() {
            String configured = System.getenv("PYTHON");
            return configured == null || configured.isEmpty() ? "python3" : configured;
        }

        /** Send one request and return its reply rows, failing loudly on any error. */
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

        /** Column names in the order {@link ReplicaSchema}'s SELECTs list them. */
        private static long asLong(Object value) {
            return value == null ? 0 : ((Number) value).longValue();
        }

        @Override
        public StoredAuthority authority() {
            List<List<Object>> rows = select(ReplicaSchema.READ_AUTHORITY);
            if (rows.isEmpty()) return null;
            List<Object> row = rows.get(0);
            return new StoredAuthority((String) row.get(0), (String) row.get(1),
                    asLong(row.get(2)), asLong(row.get(3)), asLong(row.get(4)),
                    (String) row.get(5), (String) row.get(6));
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
            List<OutboxRow> result = new ArrayList<>();
            for (List<Object> row : select(ReplicaSchema.READ_OUTBOX)) {
                result.add(new OutboxRow(asLong(row.get(0)), (String) row.get(1),
                        (String) row.get(2), (String) row.get(3), (String) row.get(4),
                        (String) row.get(5), asLong(row.get(6)), asLong(row.get(7)),
                        asLong(row.get(8)) != 0, asLong(row.get(9)), (String) row.get(10),
                        (String) row.get(11), (String) row.get(12), (String) row.get(13),
                        (String) row.get(14)));
            }
            return result;
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
            exec(ReplicaSchema.WRITE_OUTBOX, row.seq, row.operationId, row.commandType,
                    row.albumId, row.assetId, row.libraryId, row.epoch, row.contractVersion,
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

        /**
         * One real SQL transaction.
         *
         * The store's boundary is what is under test, so nothing is batched here:
         * BEGIN/COMMIT/ROLLBACK reach the engine as the store calls them, and a rollback
         * genuinely discards the statements in between.
         */
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
                // Falls through to the hard stop below.
            } finally {
                try {
                    process.waitFor();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                if (process.isAlive()) process.destroy();
                // The database file is deliberately left in place: reopening it is how the
                // durability checks prove state survives a process restart, and the
                // surrounding temporary directory is removed when the run ends.
            }
        }

        long countAlbums(boolean liveOnly) { return albums(liveOnly).size(); }

        long countMembers(boolean liveOnly) { return members(liveOnly).size(); }

        long countAuthority() { return authority() == null ? 0 : 1; }
    }

    // -----------------------------------------------------------------------
    // In-memory storage seam
    // -----------------------------------------------------------------------

    /**
     * A pure-Java {@link ReplicaDb}, so the engine's rules can be exercised on any
     * platform.
     *
     * It is not a stand-in for the durability claims: those run against a real SQLite
     * engine below. This exists so the protocol behaviour — baseline adoption, ordered
     * replay, coded recovery — does not depend on an external binary being installed,
     * and it implements the seam's transaction contract for real (a rollback restores
     * the state as it was at `begin`), so an engine-level atomicity assertion made
     * against it still means something.
     */
    private static final class MemoryDb implements ReplicaDb {
        private StoredAuthority authority;
        private final Map<String, AlbumReplica.Album> albums = new LinkedHashMap<>();
        private final Map<String, AlbumReplica.Member> members = new LinkedHashMap<>();
        private final Map<Long, OutboxRow> outbox = new LinkedHashMap<>();
        private Map<String, AlbumReplica.Album> albumSnapshot;
        private Map<String, AlbumReplica.Member> memberSnapshot;
        private Map<Long, OutboxRow> outboxSnapshot;
        private StoredAuthority authoritySnapshot;
        private boolean open;
        /**
         * Lets a check fail one specific write, so atomicity is observed instead of
         * assumed. A page that is one transaction must leave nothing behind when any part
         * of it fails, including the cursor advance itself.
         */
        String failOn;

        @Override
        public StoredAuthority authority() { return authority; }

        @Override
        public List<AlbumReplica.Album> albums(boolean liveOnly) {
            List<AlbumReplica.Album> rows = new ArrayList<>();
            for (AlbumReplica.Album album : albums.values()) {
                if (!liveOnly || !album.deleted) rows.add(album);
            }
            rows.sort(Comparator.comparing(album -> album.id));
            return rows;
        }

        @Override
        public List<AlbumReplica.Member> members(boolean liveOnly) {
            List<AlbumReplica.Member> rows = new ArrayList<>();
            for (AlbumReplica.Member member : members.values()) {
                if (!liveOnly || member.desiredState) rows.add(member);
            }
            rows.sort(Comparator.comparing((AlbumReplica.Member member) -> member.albumId)
                    .thenComparing(member -> member.assetId));
            return rows;
        }

        @Override
        public AlbumReplica.Member member(String albumId, String assetId) {
            return members.get(albumId + ":" + assetId);
        }

        @Override
        public List<OutboxRow> outbox() {
            List<OutboxRow> rows = new ArrayList<>(outbox.values());
            rows.sort(Comparator.comparingLong(row -> row.seq));
            return rows;
        }

        @Override
        public void writeAuthority(StoredAuthority value) { authority = value; }

        @Override
        public void writeAlbum(AlbumReplica.Album album, String now) { albums.put(album.id, album); }

        @Override
        public void writeMember(AlbumReplica.Member member, String now) {
            if ("writeMember".equals(failOn)) throw new IllegalStateException("Injected write failure");
            members.put(member.albumId + ":" + member.assetId, member);
        }

        @Override
        public void retireLiveMembers(String albumId, String now) {
            List<String> retired = new ArrayList<>();
            for (Map.Entry<String, AlbumReplica.Member> entry : members.entrySet()) {
                if (entry.getValue().albumId.equals(albumId) && entry.getValue().desiredState) {
                    retired.add(entry.getKey());
                }
            }
            for (String key : retired) {
                AlbumReplica.Member member = members.get(key);
                members.put(key, new AlbumReplica.Member(member.albumId, member.assetId, false,
                        member.entityRevision));
            }
        }

        @Override
        public void clearAlbums() { albums.clear(); }

        @Override
        public void clearMembers() { members.clear(); }

        @Override
        public void writeOutbox(OutboxRow row) {
            if ("writeOutbox".equals(failOn)) throw new IllegalStateException("Injected outbox failure");
            outbox.put(row.seq, row);
        }

        @Override
        public void deleteOutbox(long seq) { outbox.remove(seq); }

        @Override
        public void blockOutbox(long seq, String code, String detail) {
            OutboxRow row = outbox.get(seq);
            if (row == null) return;
            outbox.put(seq, new OutboxRow(row.seq, row.operationId, row.commandType,
                    row.albumId, row.assetId, row.libraryId, row.epoch, row.contractVersion,
                    row.desiredState, row.expectedRevision, row.payload, "blocked", code, detail,
                    row.createdAt));
        }

        @Override
        public void clearOutbox() { outbox.clear(); }

        @Override
        public void clearAuthority() { authority = null; }

        @Override
        public void setCursor(long cursor, String now) {
            if ("setCursor".equals(failOn)) throw new IllegalStateException("Injected cursor failure");
            if (authority == null) throw new IllegalStateException("No authority to advance");
            authority = new StoredAuthority(authority.scope, authority.libraryId, authority.epoch,
                    authority.contractVersion, cursor, authority.adoptedAt, now);
        }

        @Override
        public void setReconciledAt(String now) {
            if (authority == null) return;
            authority = new StoredAuthority(authority.scope, authority.libraryId, authority.epoch,
                    authority.contractVersion, authority.cursor, authority.adoptedAt, now);
        }

        @Override
        public void begin() {
            authoritySnapshot = authority;
            albumSnapshot = new LinkedHashMap<>(albums);
            memberSnapshot = new LinkedHashMap<>(members);
            outboxSnapshot = new LinkedHashMap<>(outbox);
            open = true;
        }

        @Override
        public void commit() {
            if (!open) throw new IllegalStateException("Commit without a transaction");
            open = false;
        }

        @Override
        public void rollback() {
            if (!open) throw new IllegalStateException("Rollback without a transaction");
            authority = authoritySnapshot;
            albums.clear();
            albums.putAll(albumSnapshot);
            members.clear();
            members.putAll(memberSnapshot);
            outbox.clear();
            outbox.putAll(outboxSnapshot);
            open = false;
        }

        @Override
        public void close() { }

        long countAlbums(boolean liveOnly) { return albums(liveOnly).size(); }

        long countMembers(boolean liveOnly) { return members(liveOnly).size(); }

        long countAuthority() { return authority == null ? 0 : 1; }
    }

    // -----------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------

    private static String status(String domainLibrary, long epoch, long contract, long cursor) {
        return "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"" + domainLibrary + "\","
                + "\"domains\":[{\"domain\":\"albums\",\"libraryId\":\"" + domainLibrary + "\","
                + "\"epoch\":" + epoch + ",\"contractVersion\":" + contract
                + ",\"cursor\":" + cursor + "}]}";
    }

    private static String inactive() {
        return "{\"protocolVersion\":1,\"active\":false,\"libraryId\":null,\"domains\":[]}";
    }

    private static String albumPage(long snapshot, String section, String items,
                                    String nextAfter, boolean hasMore, boolean complete) {
        return "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"snapshotCursor\":" + snapshot + ",\"section\":\"" + section + "\","
                + "\"items\":[" + items + "],"
                + "\"nextAfter\":" + (nextAfter == null ? "null" : "\"" + nextAfter + "\"") + ","
                + "\"hasMore\":" + hasMore + ",\"complete\":" + complete + "}";
    }

    private static String albumsPage(long snapshot, String items, String nextAfter, boolean hasMore) {
        return albumPage(snapshot, "albums", items, nextAfter, hasMore, false);
    }

    private static String membersPage(long snapshot, String items, String nextAfter, boolean hasMore) {
        return albumPage(snapshot, "memberships", items, nextAfter, hasMore, !hasMore);
    }

    /** A baseline Album row. The baseline never lists a deleted Album, so it has no flag. */
    private static String album(String id, String name, String parent, String icon, String color,
                                long revision) {
        return album(id, name, parent, icon, color, revision, false);
    }

    /**
     * An Album projection as the *change log* carries it.
     *
     * A change row carries the complete resulting projection, tombstone included, because
     * a replica applies it instead of reading the Album back after every change.
     */
    private static String album(String id, String name, String parent, String icon, String color,
                                long revision, boolean deleted) {
        return "{\"id\":\"" + id + "\",\"name\":\"" + name + "\","
                + "\"parentId\":" + (parent == null ? "null" : "\"" + parent + "\"") + ","
                + "\"iconKey\":" + (icon == null ? "null" : "\"" + icon + "\"") + ","
                + "\"colorKey\":" + (color == null ? "null" : "\"" + color + "\"") + ","
                + "\"deleted\":" + deleted + ","
                + "\"entityRevision\":" + revision + "}";
    }

    private static String member(String albumId, String assetId, boolean desired, long revision) {
        return "{\"albumId\":\"" + albumId + "\",\"assetId\":\"" + assetId + "\","
                + "\"desiredState\":" + desired + ",\"entityRevision\":" + revision + "}";
    }

    private static String albumChange(long sequence, String commandType, String albumJson) {
        return "{\"sequence\":" + sequence + ",\"authorityCursor\":" + sequence + ","
                + "\"commandType\":\"" + commandType + "\","
                + "\"operationId\":\"00000000-0000-0000-0000-0000000000" + seq2(sequence) + "\","
                + "\"changedAt\":\"2026-09-16T00:00:00Z\",\"album\":" + albumJson + "}";
    }

    private static String memberChange(long sequence, String commandType, String memberJson) {
        return "{\"sequence\":" + sequence + ",\"authorityCursor\":" + sequence + ","
                + "\"commandType\":\"" + commandType + "\","
                + "\"operationId\":\"00000000-0000-0000-0000-0000000000" + seq2(sequence) + "\","
                + "\"changedAt\":\"2026-09-16T00:00:00Z\",\"membership\":" + memberJson + "}";
    }

    private static String seq2(long sequence) {
        String value = Long.toString(sequence);
        return value.length() >= 2 ? value : "0" + value;
    }

    private static String changes(long cursor, String items, long nextAfter, boolean hasMore) {
        return "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"cursor\":" + cursor + ",\"items\":[" + items + "],"
                + "\"nextAfter\":" + nextAfter + ",\"hasMore\":" + hasMore + "}";
    }

    /**
     * A two-Album, three-relation frozen baseline, including a membership tombstone.
     *
     * The tombstone is the point: a client that learned only live relations would compose
     * revision 0 for a relation someone already removed, and would then present a false
     * conflict against a revision legitimately reached before it existed.
     */
    private static final String BASELINE_ALBUMS = album("root", "Root", null, "folder", "blue", 1)
            + "," + album("child", "Child", "root", "star", "green", 1);
    private static final String BASELINE_MEMBERS = member("root", "asset_1", true, 1)
            + "," + member("root", "asset_2", false, 3)
            + "," + member("child", "asset_1", true, 1);

    /** The reference baseline, installed as the adoption path installs one. */
    private static void installReferenceBaseline(LibraryReplicaStore store, String scope) {
        installBaselineAt(store, scope, 7);
    }

    /** The same baseline adopted at a chosen cursor. */
    private static void installBaselineAt(LibraryReplicaStore store, String scope, long cursor) {
        List<AlbumReplica.Album> albums = Arrays.asList(
                new AlbumReplica.Album("root", "Root", null, "folder", "blue", false, 1),
                new AlbumReplica.Album("child", "Child", "root", "star", "green", false, 1));
        List<AlbumReplica.Member> members = Arrays.asList(
                new AlbumReplica.Member("root", "asset_1", true, 1),
                new AlbumReplica.Member("root", "asset_2", false, 3),
                new AlbumReplica.Member("child", "asset_1", true, 1));
        store.installBaseline(new AlbumReplica.Adopted(scope, LIBRARY, 1, 1, cursor,
                "2026-09-16T00:00:00Z", "2026-09-16T00:00:00Z"), albums, members, CLOCK.now());
    }

    /**
     * Whether a baseline target describes the Album section.
     *
     * The *first* baseline request deliberately carries no `section`, because it is what
     * establishes the frozen snapshot; the server answers it with the Album section. A
     * fixture that only matched `section=albums` would answer the first page with whatever
     * its fall-through case is, which is exactly the paging behaviour under test.
     */
    private static boolean albumsPageTarget(String target) {
        return target.contains("/v1/albums/baseline")
                && (!target.contains("section=") || target.contains("section=albums"));
    }

    private static boolean membersPageTarget(String target) {
        return target.contains("/v1/albums/baseline") && target.contains("section=memberships");
    }

    /** Restate a page document under another authority identity and epoch. */
    private static String reidentify(String document, String libraryId, long epoch) {
        return document.replace("\"libraryId\":\"" + LIBRARY + "\"",
                        "\"libraryId\":\"" + libraryId + "\"")
                .replace("\"epoch\":1,", "\"epoch\":" + epoch + ",");
    }

    private static String query(String target, String name) {
        for (String pair : target.substring(target.indexOf('?') + 1).split("&")) {
            int equals = pair.indexOf('=');
            if (equals > 0 && pair.substring(0, equals).equals(name)) {
                return pair.substring(equals + 1);
            }
        }
        throw new IllegalArgumentException("Missing query parameter " + name);
    }

    // -----------------------------------------------------------------------
    // Cases
    // -----------------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("album-replica");
        try {
            inactiveAuthorityLeavesAndroidUnadopted(directory);
            completeBaselineInstallsAtomically(directory);
            incompleteBaselineNeverReplacesTheReplica(directory);
            baselineChangedLeavesTheReplicaIntact(directory);
            multiPageBaselineAdoption(directory);
            incrementalChangesRetainLiveAndTombstonedRevisions(directory);
            multiPageCatchUpBeyondOnePage(directory);
            sequenceGapsAndRepeatsAreRejectedAtomically(directory);
            storageSeamRollbackIsReal(directory);
            pageAndCursorCommitTogether(directory);
            processRestartPreservesIdentityCursorAndRows(directory);
            cursorExpiryAdoptsAFreshBaseline(directory);
            identityAndEpochChangeReAdopts(directory);
            unsupportedContractFailsClosed(directory);
            accountChangeCannotExposeTheOldReplica(directory);
            wrongScopeReadsNothingAndKeepsTheRowsDurable(directory);
            staleBaselineInstalledUnderAnOldScopeStaysInvisible(directory);
            changePageContinuationIsPinned(directory);
            successfulChangePageCannotExceedTheAuthorityCursor(directory);
            malformedResponsesAreRejected(directory);
            optimisticMembershipQueueIsAtomicAndSkipsNoOps(directory);
            baselineReplacementReplaysPendingMembershipIntent(directory);
            confirmationPreservesLaterOptimisticStateAndBlocksConflict(directory);
            membershipOutboxSurvivesProcessRestart(directory);
            membershipOutboxFlushesFifoAndConfirms(directory);
            lostCommandResponseRetriesIdenticalPayload(directory);
            membershipConflictBlocksDurablyAndStopsFifo(directory);
            useServerResolutionRestoresAuthorityThenReplaysLaterFifo(directory);
            useServerResolutionNeverSendsTheCanceledIntent(directory);
            retryResolutionCreatesFreshOperationFromAuthorityRevision(directory);
            retryResolutionIsAtomicAndDurable(directory);
            replacementAuthorityResolutionUsesReplacementIdentity(directory);
            malformedConflictResolutionNeverDestroysIntent(directory);
            malformedAcceptedMembershipOutcomeStaysPending(directory);
            blockedOutboxDefersReceive(directory);
            cleanOutboxFlushesBeforeReceive(directory);
            authorityMismatchStillReAdoptsBeforeRetry(directory);
            futureReplicaVersionFailsClosedInsteadOfDeletingOutbox();
            v2OutboxSchemaHasAConservativeV3Upgrade();
            invalidAssetIdentityCannotEnterTheOutbox();
            unknownCommandRejectionRemainsRetryableAndPending();
        } finally {
            deleteTree(directory);
        }
        System.out.println("AlbumReplicaTest passed: " + checks + " checks"
                + " (baseline adoption, ordered replay, cursor recovery, durability, isolation)");
    }

    private static void optimisticMembershipQueueIsAtomicAndSkipsNoOps(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        LibraryReplicaStore.MembershipEdit add = store.queueMembership(
                "scope-a", "root", "asset_2", true,
                "10000000-0000-0000-0000-000000000001", CLOCK.now());
        check(add.changed, "A real membership toggle is queued");
        equal(3L, add.expectedRevision, "The tombstone revision is the first expectation");
        equal(true, store.memberships("scope-a", false).get("root:asset_2").desiredState,
                "The optimistic desired state is visible immediately");
        List<ReplicaDb.OutboxRow> first = store.outbox("scope-a");
        equal(1, first.size(), "One real toggle creates one durable intent");
        check(first.get(0).payload.contains("\"expectedRevision\":3"),
                "The frozen payload carries the revision observed at enqueue time");

        LibraryReplicaStore.MembershipEdit noop = store.queueMembership(
                "scope-a", "root", "asset_2", true,
                "10000000-0000-0000-0000-000000000002", CLOCK.now());
        check(!noop.changed, "Selecting the already optimistic state is a no-op");
        equal(1, store.outbox("scope-a").size(), "A no-op never adds another intent");

        LibraryReplicaStore.MembershipEdit remove = store.queueMembership(
                "scope-a", "root", "asset_2", false,
                "10000000-0000-0000-0000-000000000003", CLOCK.now());
        equal(4L, remove.expectedRevision,
                "A later real toggle predicts the revision produced by the queued predecessor");
        equal(false, store.memberships("scope-a", false).get("root:asset_2").desiredState,
                "The latest optimistic state wins locally");
        equal(2, store.outbox("scope-a").size(), "Both real state transitions stay FIFO");
        store.close();
    }

    private static void baselineReplacementReplaysPendingMembershipIntent(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "20000000-0000-0000-0000-000000000001", CLOCK.now());
        List<AlbumReplica.Album> albums = Arrays.asList(
                new AlbumReplica.Album("root", "Root", null, "folder", "blue", false, 4));
        List<AlbumReplica.Member> members = Arrays.asList(
                new AlbumReplica.Member("root", "asset_2", false, 8));
        store.installBaseline(new AlbumReplica.Adopted("scope-a", LIBRARY, 1, 1, 20,
                CLOCK.now(), CLOCK.now()), albums, members, CLOCK.now());
        AlbumReplica.Member visible = store.memberships("scope-a", false).get("root:asset_2");
        equal(true, visible.desiredState,
                "A fresh server baseline is followed by replay of the unsent local intent");
        equal(8L, visible.entityRevision,
                "Replay preserves the newly confirmed server revision rather than inventing one");
        equal(1, store.outbox("scope-a").size(), "Baseline recovery never discards the outbox");
        store.close();
    }

    private static void confirmationPreservesLaterOptimisticStateAndBlocksConflict(Path directory)
            throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "30000000-0000-0000-0000-000000000001", CLOCK.now());
        store.queueMembership("scope-a", "root", "asset_2", false,
                "30000000-0000-0000-0000-000000000002", CLOCK.now());
        ReplicaDb.OutboxRow first = store.outbox("scope-a").get(0);
        store.confirmMembership("scope-a", first.seq,
                new AlbumReplica.Member("root", "asset_2", true, 4), CLOCK.now());
        equal(1, store.outbox("scope-a").size(), "Only the accepted intent is retired");
        AlbumReplica.Member visible = store.memberships("scope-a", false).get("root:asset_2");
        equal(false, visible.desiredState,
                "Confirmation cannot overwrite a later optimistic toggle for the same relation");
        equal(4L, visible.entityRevision, "The confirmed server revision still advances");

        ReplicaDb.OutboxRow second = store.outbox("scope-a").get(0);
        store.blockMembership("scope-a", second.seq, "revisionConflict", "{\"authorityCursor\":9}");
        ReplicaDb.OutboxRow blocked = store.outbox("scope-a").get(0);
        equal("blocked", blocked.state, "A semantic conflict is durable rather than deleted");
        equal("revisionConflict", blocked.conflictCode, "The coded conflict stays observable");
        Map<String,Object> counters = store.status("scope-a");
        equal(0L, counters.get("outboxPendingCount"), "Blocked intent is not counted pending");
        equal(1L, counters.get("outboxBlockedCount"), "Blocked intent is exposed diagnostically");
        store.close();
    }

    private static void membershipOutboxSurvivesProcessRestart(Path directory) throws Exception {
        Path file = directory.resolve("membership-outbox.sqlite");
        SqliteDb first = new SqliteDb(file);
        LibraryReplicaStore store = new LibraryReplicaStore(first);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "40000000-0000-0000-0000-000000000001", CLOCK.now());
        store.close();

        SqliteDb reopened = new SqliteDb(file);
        LibraryReplicaStore restored = new LibraryReplicaStore(reopened);
        equal(1, restored.outbox("scope-a").size(), "A process restart keeps the pending intent");
        equal(true, restored.memberships("scope-a", false).get("root:asset_2").desiredState,
                "A process restart keeps the optimistic presentation too");
        restored.close();
    }

    private static String acceptedMembership(ReplicaDb.OutboxRow row, boolean changed,
                                             long revision, long cursor, boolean desired) {
        return "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                + "\"commandType\":\"setAlbumMembership\",\"operationId\":\""
                + row.operationId + "\",\"changed\":" + changed
                + ",\"changeSequence\":" + (changed ? Long.toString(cursor) : "null")
                + ",\"authorityCursor\":" + cursor + ",\"album\":null,\"membership\":"
                + member(row.albumId, row.assetId, desired, revision)
                + ",\"updatedAt\":\"2026-09-16T00:00:01Z\"}";
    }

    private static void membershipOutboxFlushesFifoAndConfirms(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "50000000-0000-0000-0000-000000000001", CLOCK.now());
        store.queueMembership("scope-a", "root", "asset_2", false,
                "50000000-0000-0000-0000-000000000002", CLOCK.now());
        List<String> payloads = new ArrayList<>();
        AlbumMembershipOutbox engine = new AlbumMembershipOutbox((path, payload) -> {
            payloads.add(payload);
            ReplicaDb.OutboxRow row = store.outbox("scope-a").get(0);
            long revision = row.expectedRevision + 1;
            return acceptedMembership(row, true, revision, 8 + payloads.size(), row.desiredState);
        }, store, CLOCK);
        AlbumMembershipOutbox.Flush result = engine.flush("scope-a");
        equal(2, result.sent, "Two real transitions are delivered in FIFO order");
        equal(0, store.outbox("scope-a").size(), "Accepted intents leave the queue");
        equal(false, store.memberships("scope-a", false).get("root:asset_2").desiredState,
                "The final local state matches the final accepted intent");
        equal(5L, store.memberships("scope-a", false).get("root:asset_2").entityRevision,
                "Each accepted transition advances the confirmed revision");
        check(payloads.get(0).contains("\"expectedRevision\":3"),
                "The first payload uses the confirmed tombstone revision");
        check(payloads.get(1).contains("\"expectedRevision\":4"),
                "The second payload uses the predicted predecessor revision");
        store.close();
    }

    private static void lostCommandResponseRetriesIdenticalPayload(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "60000000-0000-0000-0000-000000000001", CLOCK.now());
        List<String> payloads = new ArrayList<>();
        final boolean[] lost = {false};
        AlbumMembershipOutbox engine = new AlbumMembershipOutbox((path, payload) -> {
            payloads.add(payload);
            if (!lost[0]) { lost[0] = true; throw new java.io.IOException("lost response"); }
            return acceptedMembership(store.outbox("scope-a").get(0), true, 4, 8, true);
        }, store, CLOCK);
        try {
            engine.flush("scope-a");
            throw new AssertionError("A lost response must surface as retryable");
        } catch (AlbumMembershipOutbox.Failure failure) {
            check(failure.retryable, "A lost response is retryable");
        }
        equal(1, store.outbox("scope-a").size(), "A lost response keeps the intent pending");
        engine.flush("scope-a");
        equal(payloads.get(0), payloads.get(1),
                "Retry uses byte-identical stored payload and operation id");
        equal(0, store.outbox("scope-a").size(), "The receipted retry retires the intent");
        store.close();
    }

    private static void membershipConflictBlocksDurablyAndStopsFifo(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "70000000-0000-0000-0000-000000000001", CLOCK.now());
        store.queueMembership("scope-a", "child", "asset_1", false,
                "70000000-0000-0000-0000-000000000002", CLOCK.now());
        final int[] calls = {0};
        AlbumMembershipOutbox engine = new AlbumMembershipOutbox((path, payload) -> {
            calls[0]++;
            throw new AlbumMembershipOutbox.HttpFailure(409,
                    "{\"detail\":{\"code\":\"revisionConflict\",\"authorityCursor\":9}}" );
        }, store, CLOCK);
        AlbumMembershipOutbox.Flush result = engine.flush("scope-a");
        equal(1, calls[0], "Delivery stops at the first unresolved membership intent");
        equal(1, result.blocked, "The rejected intent becomes blocked");
        equal(1, result.pending, "Later FIFO work remains pending and unsent");
        List<ReplicaDb.OutboxRow> rows = store.outbox("scope-a");
        equal("blocked", rows.get(0).state, "The conflict survives as queue state");
        equal("revisionConflict", rows.get(0).conflictCode, "The server code is retained");
        equal("pending", rows.get(1).state, "A later relation is not sent around the conflict");
        store.close();
    }

    private static String membershipConflict(String albumId, String assetId,
                                             boolean desiredState, long revision) {
        return "{\"detail\":{\"code\":\"revisionConflict\",\"authorityCursor\":9,\"current\":"
                + member(albumId, assetId, desiredState, revision) + "}}";
    }

    private static void useServerResolutionRestoresAuthorityThenReplaysLaterFifo(Path directory)
            throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
        "71000000-0000-0000-0000-000000000001", CLOCK.now());
        store.queueMembership("scope-a", "root", "asset_2", false,
        "71000000-0000-0000-0000-000000000002", CLOCK.now());
        store.queueMembership("scope-a", "root", "asset_2", true,
        "71000000-0000-0000-0000-000000000003", CLOCK.now());
        List<ReplicaDb.OutboxRow> before = store.outbox("scope-a");
        String secondPayload = before.get(1).payload;
        String thirdPayload = before.get(2).payload;
        store.blockMembership("scope-a", before.get(0).seq, "revisionConflict",
        membershipConflict("root", "asset_2", false, 8));

        store.useServerMembership("scope-a", "root", "asset_2", CLOCK.now());

        List<ReplicaDb.OutboxRow> after = store.outbox("scope-a");
        equal(2, after.size(), "Using server state retires only the blocked intent");
        equal("71000000-0000-0000-0000-000000000002", after.get(0).operationId,
        "The next FIFO intent becomes the queue head");
        equal(secondPayload, after.get(0).payload,
        "A later immutable payload is never silently rebased");
        equal(thirdPayload, after.get(1).payload,
        "Every later immutable payload is retained byte-for-byte");
        AlbumReplica.Member visible = store.memberships("scope-a", false).get("root:asset_2");
        equal(8L, visible.entityRevision,
        "Resolution first restores the authoritative revision from the conflict");
        equal(true, visible.desiredState,
        "Then later pending intents are replayed in FIFO order onto the authoritative base");
        store.close();
    }

    private static void useServerResolutionNeverSendsTheCanceledIntent(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "72000000-0000-0000-0000-000000000001", CLOCK.now());
        store.queueMembership("scope-a", "child", "asset_1", false,
                "72000000-0000-0000-0000-000000000002", CLOCK.now());
        ReplicaDb.OutboxRow blocked = store.outbox("scope-a").get(0);
        store.blockMembership("scope-a", blocked.seq, "revisionConflict",
                membershipConflict("root", "asset_2", false, 8));
        store.useServerMembership("scope-a", "root", "asset_2", CLOCK.now());
        List<String> payloads = new ArrayList<>();
        AlbumMembershipOutbox writer = new AlbumMembershipOutbox((path, payload) -> {
            payloads.add(payload);
            ReplicaDb.OutboxRow row = store.outbox("scope-a").get(0);
            return acceptedMembership(row, true, row.expectedRevision + 1, 10, row.desiredState);
        }, store, CLOCK);
        AlbumMembershipOutbox.Flush flush = writer.flush("scope-a");
        equal(1, payloads.size(), "Resolving the blocker lets the next FIFO intent proceed");
        check(!payloads.get(0).contains(blocked.operationId),
                "Using server state never sends the canceled operation");
        check(payloads.get(0).contains("72000000-0000-0000-0000-000000000002"),
                "Only the later FIFO operation reaches the command endpoint");
        equal(1, flush.sent, "The later FIFO intent is delivered after explicit resolution");
        equal(0, flush.pending, "The queue drains after the later intent is accepted");
        equal(0, flush.blocked, "The resolved conflict no longer blocks delivery");
        equal(false, store.memberships("scope-a", false).get("root:asset_2").desiredState,
                "The canceled relation converges to server state without an extra command");
        store.close();
    }

    private static void retryResolutionCreatesFreshOperationFromAuthorityRevision(Path directory)
    throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
        "73000000-0000-0000-0000-000000000001", CLOCK.now());
        store.queueMembership("scope-a", "child", "asset_1", false,
        "73000000-0000-0000-0000-000000000002", CLOCK.now());
        ReplicaDb.OutboxRow original = store.outbox("scope-a").get(0);
        long originalSeq = original.seq;
        String originalPayload = original.payload;
        store.blockMembership("scope-a", original.seq, "revisionConflict",
        membershipConflict("root", "asset_2", false, 12));

        LibraryReplicaStore.MembershipEdit retried = store.retryBlockedMembership(
        "scope-a", "root", "asset_2",
        "73000000-0000-0000-0000-000000000099", CLOCK.now());

        check(retried.changed, "Explicit retry creates a fresh pending operation");
        equal(12L, retried.expectedRevision,
        "The fresh operation composes from the authoritative conflict revision");
        List<ReplicaDb.OutboxRow> rows = store.outbox("scope-a");
        equal(2, rows.size(), "Retry replaces the blocker without dropping later FIFO work");
        ReplicaDb.OutboxRow fresh = rows.get(0);
        equal(originalSeq, fresh.seq, "The fresh retry occupies the blocked intent's FIFO position");
        equal("73000000-0000-0000-0000-000000000099", fresh.operationId,
        "Retry uses a new operation id");
        check(!fresh.payload.equals(originalPayload), "Retry never mutates or reuses the rejected payload");
        check(fresh.payload.contains("\"expectedRevision\":12"),
        "The fresh payload freezes the current authoritative revision");
        equal("73000000-0000-0000-0000-000000000002", rows.get(1).operationId,
        "Unrelated later work stays behind the fresh retry");
        store.close();
    }

    private static void retryResolutionIsAtomicAndDurable(Path directory) throws Exception {
        Path file = directory.resolve("membership-resolution.sqlite");
        SqliteDb db = new SqliteDb(file);
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
        "74000000-0000-0000-0000-000000000001", CLOCK.now());
        ReplicaDb.OutboxRow original = store.outbox("scope-a").get(0);
        store.blockMembership("scope-a", original.seq, "revisionConflict",
        membershipConflict("root", "asset_2", false, 14));
        store.retryBlockedMembership("scope-a", "root", "asset_2",
        "74000000-0000-0000-0000-000000000099", CLOCK.now());
        store.close();

        SqliteDb reopenedDb = new SqliteDb(file);
        LibraryReplicaStore reopened = new LibraryReplicaStore(reopenedDb);
        List<ReplicaDb.OutboxRow> durable = reopened.outbox("scope-a");
        equal(1, durable.size(), "A restart sees exactly one resolved retry intent");
        equal("pending", durable.get(0).state, "The fresh retry survives restart as pending");
        equal("74000000-0000-0000-0000-000000000099", durable.get(0).operationId,
        "The rejected operation id cannot reappear after a successful resolution commit");
        equal(14L, reopened.memberships("scope-a", false).get("root:asset_2").entityRevision,
        "The authoritative base revision commits with the fresh intent");
        reopened.close();

        MemoryDb failingDb = new MemoryDb();
        LibraryReplicaStore failing = new LibraryReplicaStore(failingDb);
        installReferenceBaseline(failing, "scope-a");
        failing.queueMembership("scope-a", "root", "asset_2", true,
        "74000000-0000-0000-0000-000000000010", CLOCK.now());
        ReplicaDb.OutboxRow blocker = failing.outbox("scope-a").get(0);
        failing.blockMembership("scope-a", blocker.seq, "revisionConflict",
        membershipConflict("root", "asset_2", false, 15));
        failingDb.failOn = "writeOutbox";
        try {
            failing.retryBlockedMembership("scope-a", "root", "asset_2",
            "74000000-0000-0000-0000-000000000011", CLOCK.now());
            throw new AssertionError("An interrupted resolution must roll back atomically");
        } catch (IllegalStateException expected) {
            check(true, "Injected resolution failure is observed");
        }
        List<ReplicaDb.OutboxRow> rolledBack = failing.outbox("scope-a");
        equal(1, rolledBack.size(), "Rollback preserves the original blocker");
        equal("blocked", rolledBack.get(0).state, "Rollback cannot turn the blocker pending");
        equal(blocker.operationId, rolledBack.get(0).operationId,
        "Rollback preserves the original immutable operation");
        failing.close();
    }

    private static void replacementAuthorityResolutionUsesReplacementIdentity(Path directory)
    throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
        "75000000-0000-0000-0000-000000000001", CLOCK.now());
        List<AlbumReplica.Album> albums = Arrays.asList(
        new AlbumReplica.Album("root", "Root", null, "folder", "blue", false, 1));
        List<AlbumReplica.Member> members = Arrays.asList(
        new AlbumReplica.Member("root", "asset_2", false, 21));
        store.installBaseline(new AlbumReplica.Adopted("scope-a", OTHER_LIBRARY, 2, 1, 30,
        CLOCK.now(), CLOCK.now()), albums, members, CLOCK.now());
        equal("blocked", store.outbox("scope-a").get(0).state,
        "Replacement authority blocks the stale identity before projection");

        store.retryBlockedMembership("scope-a", "root", "asset_2",
        "75000000-0000-0000-0000-000000000099", CLOCK.now());

        ReplicaDb.OutboxRow fresh = store.outbox("scope-a").get(0);
        equal(OTHER_LIBRARY, fresh.libraryId, "Retry binds to the replacement library identity");
        equal(2L, fresh.epoch, "Retry binds to the replacement epoch");
        equal(1L, fresh.contractVersion, "Retry binds to the replacement contract");
        equal(21L, fresh.expectedRevision,
        "Retry composes from the replacement authority's confirmed membership revision");
        check(fresh.payload.contains("\"libraryId\":\"" + OTHER_LIBRARY + "\"")
        && fresh.payload.contains("\"epoch\":2")
        && fresh.payload.contains("\"expectedRevision\":21"),
        "The frozen retry payload contains only replacement-authority identity and revision");
        store.close();
    }

    private static void malformedConflictResolutionNeverDestroysIntent(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
        "76000000-0000-0000-0000-000000000001", CLOCK.now());
        ReplicaDb.OutboxRow original = store.outbox("scope-a").get(0);
        store.blockMembership("scope-a", original.seq, "revisionConflict",
        "{\"detail\":{\"code\":\"revisionConflict\",\"current\":{\"albumId\":\"other\"}}}");
        try {
            store.useServerMembership("scope-a", "root", "asset_2", CLOCK.now());
            throw new AssertionError("Malformed conflict state must not be resolved by guessing");
        } catch (IllegalStateException expected) {
            check(true, "Malformed conflict state refuses server-state resolution");
        }
        try {
            store.retryBlockedMembership("scope-a", "root", "asset_2",
            "76000000-0000-0000-0000-000000000099", CLOCK.now());
            throw new AssertionError("Malformed conflict state must not create a fresh command");
        } catch (IllegalStateException expected) {
            check(true, "Malformed conflict state refuses retry composition");
        }
        List<ReplicaDb.OutboxRow> rows = store.outbox("scope-a");
        equal(1, rows.size(), "Malformed conflict data never deletes durable intent");
        equal("blocked", rows.get(0).state, "Malformed conflict data leaves the blocker intact");
        equal(original.operationId, rows.get(0).operationId,
        "Malformed conflict data cannot replace the immutable operation id");
        store.close();
    }


private static void malformedAcceptedMembershipOutcomeStaysPending(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "80000000-0000-0000-0000-000000000001", CLOCK.now());
        AlbumMembershipOutbox engine = new AlbumMembershipOutbox((path, payload) -> {
            ReplicaDb.OutboxRow row = store.outbox("scope-a").get(0);
            return acceptedMembership(row, true, 4, 8, true)
                    .replace(row.operationId, "80000000-0000-0000-0000-000000000099");
        }, store, CLOCK);
        try {
            engine.flush("scope-a");
            throw new AssertionError("A mismatched acceptance must not retire the intent");
        } catch (AlbumMembershipOutbox.Failure failure) {
            equal(AlbumMembershipOutbox.CODE_PROTOCOL_INTEGRITY, failure.code,
                    "A mismatched echo is a protocol-integrity failure");
        }
        equal(1, store.outbox("scope-a").size(), "Malformed 200 leaves the intent pending");
        equal("pending", store.outbox("scope-a").get(0).state,
                "Malformed 200 is never converted into a semantic conflict");
        store.close();
    }

    private static void blockedOutboxDefersReceive(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "90000000-0000-0000-0000-000000000001", CLOCK.now());
        store.blockMembership("scope-a", store.outbox("scope-a").get(0).seq,
                "revisionConflict", "{}");
        try (Fixture fixture = new Fixture(target -> Fixture.Response.ok(status(LIBRARY, 1, 1, 7)))) {
            AlbumMembershipOutbox writer = new AlbumMembershipOutbox((path, payload) -> {
                throw new AssertionError("A blocked queue must not call the command endpoint");
            }, store, CLOCK);
            AlbumAuthoritySync reader = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumSyncPass.Result result = new AlbumSyncPass(writer, reader).run("scope-a");
            equal(1, result.flush.blocked, "The cycle reports the durable blocker");
            equal(null, result.receive, "Receive is deferred while any outbox row is blocked");
            equal(0, fixture.paths().size(), "No read request is sent around a blocked intent");
        }
        store.close();
    }

    private static void cleanOutboxFlushesBeforeReceive(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "91000000-0000-0000-0000-000000000001", CLOCK.now());
        final boolean[] commandAccepted = {false};
        try (Fixture fixture = new Fixture(target -> {
            check(commandAccepted[0], "Receive starts only after the pending command is accepted");
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 7));
            if (target.startsWith("/v1/albums/changes")) return Fixture.Response.ok(changes(7, "", 7, false));
            return Fixture.Response.error(500, "unexpected");
        })) {
            AlbumMembershipOutbox writer = new AlbumMembershipOutbox((path, payload) -> {
                commandAccepted[0] = true;
                ReplicaDb.OutboxRow row = store.outbox("scope-a").get(0);
                return acceptedMembership(row, false, 4, 7, true);
            }, store, CLOCK);
            AlbumAuthoritySync reader = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumSyncPass.Result result = new AlbumSyncPass(writer, reader).run("scope-a");
            equal(1, result.flush.noOp, "An accepted no-op still clears the durable intent");
            check(result.receive != null, "A clean queue proceeds to the receive half");
            equal(2, fixture.paths().size(), "A clean cycle reaches status then the empty changes page");
        }
        store.close();
    }

    private static void authorityMismatchStillReAdoptsBeforeRetry(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "92000000-0000-0000-0000-000000000001", CLOCK.now());
        final int[] writes = {0};
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(OTHER_LIBRARY, 1, 1, 0));
            if (albumsPageTarget(target)) return Fixture.Response.ok(reidentify(
                    albumsPage(0, album("root", "Root", null, "folder", "blue", 1), null, false), OTHER_LIBRARY, 1));
            if (membersPageTarget(target)) return Fixture.Response.ok(reidentify(
                    membersPage(0, member("root", "asset_2", false, 1), null, false), OTHER_LIBRARY, 1));
            return Fixture.Response.error(500, "unexpected");
        })) {
            AlbumMembershipOutbox writer = new AlbumMembershipOutbox((path, payload) -> {
                writes[0]++;
                throw new AlbumMembershipOutbox.HttpFailure(409,
                        "{\"detail\":{\"code\":\"authorityLibraryMismatch\"}}");
            }, store, CLOCK);
            AlbumAuthoritySync reader = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            try {
                new AlbumSyncPass(writer, reader).run("scope-a");
                throw new AssertionError("The original write still reports its mismatch");
            } catch (AlbumMembershipOutbox.Failure failure) {
                equal("authorityLibraryMismatch", failure.code,
                        "The write failure stays visible after receive recovery");
            }
            equal(OTHER_LIBRARY, store.adopted("scope-a").libraryId,
                    "A write identity mismatch still lets receive adopt the replacement library");
            equal(1, store.outbox("scope-a").size(),
                    "Re-adoption preserves the unsent local intent");
            equal("blocked", store.outbox("scope-a").get(0).state,
                    "Replacement authority blocks the old-library intent during baseline install");
            equal(false, store.memberships("scope-a", false).get("root:asset_2").desiredState,
                    "Old-library optimistic state is never projected into the replacement library");
            equal(1, writes[0], "Only the original stale-library write reached the network");
            AlbumMembershipOutbox.Flush next = writer.flush("scope-a");
            equal(1, next.blocked, "The old-library intent remains a durable blocker next pass");
            equal(1, writes[0], "A blocked replacement intent never reaches the network again");
        }
        store.close();
    }

    private static void futureReplicaVersionFailsClosedInsteadOfDeletingOutbox() {
        check(ReplicaSchema.canUpgradeFrom(0), "A fresh replica can initialize schema v2");
        check(ReplicaSchema.canUpgradeFrom(1), "The read-only v1 replica upgrades in place");
        check(!ReplicaSchema.canUpgradeFrom(ReplicaSchema.VERSION), "Current schema needs no migration");
        try {
            ReplicaSchema.requireReadableVersion(ReplicaSchema.VERSION + 1);
            throw new AssertionError("A future replica version must fail closed");
        } catch (IllegalStateException expected) {
            check(true, "Future schema is preserved instead of deleted by an older client");
        }
    }

    private static void invalidAssetIdentityCannotEnterTheOutbox() {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try {
            store.queueMembership("scope-a", "root", "../asset", true,
                    "93000000-0000-0000-0000-000000000001", CLOCK.now());
            throw new AssertionError("An invalid Asset id must be rejected before persistence");
        } catch (IllegalArgumentException expected) {
            check(true, "Invalid Asset identity is rejected at the durable store boundary");
        }
        equal(0, store.outbox("scope-a").size(), "Rejected identity leaves no durable intent");
        store.close();
    }

    private static void unknownCommandRejectionRemainsRetryableAndPending() {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        store.queueMembership("scope-a", "root", "asset_2", true,
                "94000000-0000-0000-0000-000000000001", CLOCK.now());
        AlbumMembershipOutbox writer = new AlbumMembershipOutbox((path, payload) -> {
            throw new AlbumMembershipOutbox.HttpFailure(422,
                    "{\"detail\":{\"code\":\"futureMembershipRule\"}}");
        }, store, CLOCK);
        try {
            writer.flush("scope-a");
            throw new AssertionError("An unknown coded rejection must remain unresolved");
        } catch (AlbumMembershipOutbox.Failure failure) {
            equal("futureMembershipRule", failure.code, "Unknown server code remains visible");
            check(failure.retryable, "Unknown future rejection is retryable rather than blocked");
        }
        equal("pending", store.outbox("scope-a").get(0).state,
                "Unknown rejection preserves the immutable pending intent");
        store.close();
    }

    private static void v2OutboxSchemaHasAConservativeV3Upgrade() {
        equal(3, ReplicaSchema.VERSION, "Identity-bound Android outbox is schema v3");
        String[] upgrade = ReplicaSchema.upgradeStatements(2);
        equal(2, upgrade.length, "The intermediate v2 outbox needs two identity columns");
        check(upgrade[0].contains("library_id") && upgrade[0].contains("DEFAULT ''"),
                "Unknown v2 library identity is preserved as a non-sendable sentinel");
        check(upgrade[1].contains("contract_version") && upgrade[1].contains("DEFAULT 0"),
                "Unknown v2 contract identity is preserved as a non-sendable sentinel");
        equal(0, ReplicaSchema.upgradeStatements(1).length,
                "Read-only v1 creates the final schema directly rather than altering a missing outbox");
    }

    private static void inactiveAuthorityLeavesAndroidUnadopted(Path directory) throws Exception {
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(inactive());
            return Fixture.Response.error(409, AlbumReplica.CODE_INACTIVE);
        })) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            check(!result.adopted, "An inactive server leaves Android unadopted");
            check(result.code == null, "An inactive domain is a normal state, not an error");
            equal(null, store.adopted("scope-a"), "No authority row is written while inactive");
            equal(0L, db.countAuthority(), "The adoption marker row is absent");
            equal(1, fixture.paths().size(), "Only the status endpoint is called while inactive");
            store.close();
        }
    }

    private static void completeBaselineInstallsAtomically(Path directory) throws Exception {
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 7));
            if (albumsPageTarget(target)) return Fixture.Response.ok(albumsPage(7, BASELINE_ALBUMS, null, false));
            if (membersPageTarget(target)) return Fixture.Response.ok(membersPage(7, BASELINE_MEMBERS, null, false));
            return Fixture.Response.error(404, "notFound");
        })) {
            SqliteDb db = new SqliteDb(directory.resolve("baseline.sqlite"));
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            check(result.adopted && result.adoptedBaseline, "A complete baseline is adopted");
            equal(7L, result.localCursor, "The adopted cursor is the snapshot's, not the status reading");
            AlbumReplica.Adopted authority = store.adopted("scope-a");
            equal(LIBRARY, authority.libraryId, "Adopted library identity");
            equal(1L, authority.epoch, "Adopted epoch");
            equal(7L, authority.cursor, "Stored cursor");
            equal("2026-09-16T00:00:00Z", authority.reconciledAt, "Successful reconciliation is recorded");
            equal(2L, db.countAlbums(true), "Live Albums");
            equal(3L, db.countMembers(false), "Membership rows, tombstones included");
            equal(2L, db.countMembers(true), "Live memberships exclude the tombstone");
            AlbumReplica.Member tombstone = store.memberships("scope-a", false).get("root:asset_2");
            check(tombstone != null && !tombstone.desiredState && tombstone.entityRevision == 3,
                    "A baseline membership tombstone keeps its authoritative revision");
            equal(1L, db.countAuthority(), "One authority row");
            store.close();
        }
    }

    private static void incompleteBaselineNeverReplacesTheReplica(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 9));
            if (albumsPageTarget(target)) return Fixture.Response.ok(albumsPage(9, BASELINE_ALBUMS, null, false));
            // The membership page carries rows but never reports completeness, so no
            // subset of it can be mistaken for a whole baseline.
            if (membersPageTarget(target)) {
                return Fixture.Response.ok(membersPage(9, BASELINE_MEMBERS, null, false)
                        .replace("\"complete\":true", "\"complete\":false"));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            check(!result.adopted, "An incomplete baseline is not adopted");
            equal(AlbumReplica.CODE_MALFORMED, codeOf(result), "An incomplete baseline is malformed");
            equal(0L, db.countAlbums(false), "No Album row is written");
            equal(0L, db.countAuthority(), "No authority is recorded");
        }

        // Re-adoption replaces state, so the same rule must hold there: a failed walk
        // leaves the previous replica exactly as it was.
        installReferenceBaseline(store, "scope-a");
        long albums = db.countAlbums(true);
        long cursor = store.adopted("scope-a").cursor;
        try (Fixture fixture = new Fixture(target -> {
            // A new epoch forces the re-adoption path, and the membership page then
            // describes a different snapshot, so the two pages cannot be combined.
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 2, 1, 40));
            if (albumsPageTarget(target)) return Fixture.Response.ok(albumsPage(40, album("other", "Other", null, null, null, 1), null, false));
            if (membersPageTarget(target)) return Fixture.Response.ok(membersPage(41, "", null, false));
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            check(!result.adoptedBaseline, "Pages of two different snapshots are never adopted");
            equal(albums, db.countAlbums(true), "A rejected walk leaves the previous Albums in place");
            equal(cursor, store.adopted("scope-a").cursor, "A rejected walk leaves the cursor in place");
            check(store.albums("scope-a", true).get("other") == null, "No row from the rejected walk is written");
        }
        store.close();
    }

    private static void baselineChangedLeavesTheReplicaIntact(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        long albums = db.countAlbums(true);
        long cursor = store.adopted("scope-a").cursor;
        // The server keeps reporting a mutation between pages, so every attempt fails the
        // same way and the replica is never replaced. Expiry is what routes this pass
        // through the baseline walk, where `baselineChanged` is met.
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 12));
            if (target.startsWith("/v1/albums/changes")) return Fixture.Response.error(409, AlbumReplica.CODE_CURSOR_EXPIRED);
            return Fixture.Response.error(409, AlbumReplica.CODE_BASELINE_CHANGED);
        })) {
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(AlbumReplica.CODE_BASELINE_CHANGED, codeOf(result), "baselineChanged is reported");
            check(result.retryable, "baselineChanged retries later");
            equal(albums, db.countAlbums(true), "baselineChanged leaves the old replica intact");
            equal(cursor, store.adopted("scope-a").cursor, "baselineChanged leaves the cursor intact");
            long attempts = fixture.paths().stream().filter(p -> p.contains("baseline")).count();
            equal((long) AlbumAuthoritySync.BASELINE_ATTEMPTS, attempts, "Baseline attempts are bounded");
        }
        store.close();
    }

    private static void multiPageBaselineAdoption(Path directory) throws Exception {
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 20));
            if (albumsPageTarget(target) && target.contains("after=child")) {
                return Fixture.Response.ok(albumsPage(20, album("zeta", "Zeta", null, null, "red", 1), null, false));
            }
            if (albumsPageTarget(target)) {
                return Fixture.Response.ok(albumsPage(20, BASELINE_ALBUMS, "child", true));
            }
            if (membersPageTarget(target) && target.contains("after=")) {
                return Fixture.Response.ok(membersPage(20, member("child", "asset_2", false, 4), null, false));
            }
            if (membersPageTarget(target)) {
                return Fixture.Response.ok(membersPage(20, member("root", "asset_1", true, 1), "root:asset_1", true));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            check(result.adoptedBaseline, "A multi-page baseline is adopted");
            equal(3L, db.countAlbums(true), "Albums from both Album pages");
            equal(2L, db.countMembers(false), "Relations from both membership pages");
            equal(20L, store.adopted("scope-a").cursor, "The frozen snapshot cursor is adopted once");
            List<String> targets = fixture.paths();
            int lastAlbum = -1;
            int firstMembership = -1;
            for (int i = 0; i < targets.size(); i++) {
                if (targets.get(i).contains("section=albums")) lastAlbum = i;
                if (targets.get(i).contains("section=memberships") && firstMembership < 0) firstMembership = i;
            }
            check(lastAlbum < firstMembership, "Album pages are walked before membership pages");
            // The first page is what establishes the frozen snapshot and carries no
            // cursor; every page after it must name that same snapshot, or the walk could
            // silently combine two different materialized states.
            List<String> baselines = new ArrayList<>();
            for (String target : targets) {
                if (target.contains("/v1/albums/baseline")) baselines.add(target);
            }
            equal(4, baselines.size(), "Two Album pages and two membership pages are requested");
            check(!baselines.get(0).contains("snapshot="),
                    "The first baseline page establishes the snapshot");
            for (int i = 1; i < baselines.size(); i++) {
                check(baselines.get(i).contains("snapshot=20"),
                        "Baseline page " + i + " carries the frozen snapshot cursor");
            }
            store.close();
        }
    }

    private static void incrementalChangesRetainLiveAndTombstonedRevisions(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 12));
            if (target.startsWith("/v1/albums/changes")) {
                String items = albumChange(8, "renameAlbum", album("root", "Renamed", null, "folder", "blue", 2))
                        + "," + albumChange(9, "createAlbum", album("solo", "Solo", null, "star", null, 1))
                        + "," + memberChange(10, "setAlbumMembership", member("root", "asset_1", false, 2))
                        + "," + memberChange(11, "setAlbumMembership", member("solo", "asset_9", true, 1))
                        + "," + albumChange(12, "deleteAlbum", album("child", "Child", null, "star", "green", 2, true));
                return Fixture.Response.ok(changes(12, items, 12, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(5, result.appliedChanges, "Every ordered change is applied (code=" + codeOf(result) + ")");
            equal(12L, store.adopted("scope-a").cursor, "The page's cursor is committed");
            AlbumReplica.Album renamed = store.albums("scope-a", false).get("root");
            equal("Renamed", renamed.name, "A live Album projection upserts state");
            equal(2L, renamed.entityRevision, "and its revision");
            AlbumReplica.Album deleted = store.albums("scope-a", false).get("child");
            check(deleted != null && deleted.deleted && deleted.entityRevision == 2,
                    "A deleted Album retains its tombstone revision");
            equal(2L, db.countAlbums(true), "A deleted Album leaves the visible Albums");
            AlbumReplica.Member removed = store.memberships("scope-a", false).get("root:asset_1");
            check(removed != null && !removed.desiredState && removed.entityRevision == 2,
                    "A membership removal is a tombstone with its own revision");
            AlbumReplica.Member added = store.memberships("scope-a", false).get("solo:asset_9");
            check(added != null && added.desiredState && added.entityRevision == 1,
                    "A membership add is applied exactly as sent");
            // Live relations now: solo:asset_9 only. The deleted Album's relation was
            // retired rather than deleted, so its revision stays readable for a later re-add.
            equal(1L, db.countMembers(true), "A deleted Album loses its live relations");
            AlbumReplica.Member retired = store.memberships("scope-a", false).get("child:asset_1");
            check(retired != null && !retired.desiredState && retired.entityRevision == 1,
                    "A deleted Album's relations keep their revisions");
            store.close();
        }
    }

    private static void multiPageCatchUpBeyondOnePage(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        // 250 changes over three pages. An honest `hasMore` must not be read as a protocol
        // error, which is exactly what comparing a freshly assigned cursor against itself
        // would do.
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 257));
            if (target.startsWith("/v1/albums/changes")) {
                long after = Long.parseLong(query(target, "after"));
                long current = after;
                StringBuilder items = new StringBuilder();
                while (current < 257 && current < after + AlbumReplica.CHANGE_PAGE) {
                    current++;
                    if (items.length() > 0) items.append(',');
                    items.append(albumChange(current, "renameAlbum",
                            album("root", "N" + current, null, "folder", "blue", current)));
                }
                return Fixture.Response.ok(changes(257, items.toString(), current, current < 257));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
            AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
            equal(250, result.appliedChanges, "Catch-up continues beyond one page");
            equal(257L, store.adopted("scope-a").cursor, "The local cursor reaches the server cursor");
            equal("N257", store.albums("scope-a", false).get("root").name, "The final change is applied");
            long pages = fixture.paths().stream().filter(p -> p.contains("changes")).count();
            equal(3L, pages, "Three change pages are requested");
            store.close();
        }
    }

    private static void sequenceGapsAndRepeatsAreRejectedAtomically(Path directory) throws Exception {
        for (String label : new String[]{"gap", "repeat"}) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installReferenceBaseline(store, "scope-a");
            long cursor = store.adopted("scope-a").cursor;
            String name = store.albums("scope-a", false).get("root").name;
            try (Fixture fixture = new Fixture(target -> {
                if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 12));
                if (target.startsWith("/v1/albums/changes")) {
                    // The first row is skipped, or the first row repeats one already applied.
                    long first = "gap".equals(label) ? 9 : 7;
                    String items = albumChange(first, "renameAlbum",
                            album("root", "Injected", null, "folder", "blue", 2))
                            + "," + albumChange(first + 1, "renameAlbum",
                            album("root", "Injected2", null, "folder", "blue", 3));
                    // Internally consistent, so the *store's* contiguity check is what
                    // refuses it rather than the parser's continuation rule.
                    return Fixture.Response.ok(changes(first, items, first + 1, false));
                }
                return Fixture.Response.error(404, "notFound");
            })) {
                AlbumAuthoritySync engine = new AlbumAuthoritySync(transport(fixture), store, CLOCK);
                AlbumAuthoritySync.Result result = engine.reconcile("scope-a");
                equal(AlbumReplica.CODE_MALFORMED, codeOf(result), "A sequence " + label + " is rejected");
                equal(name, store.albums("scope-a", false).get("root").name,
                        "A sequence " + label + " leaves Album state untouched");
                equal(cursor, store.adopted("scope-a").cursor,
                        "A sequence " + label + " leaves the cursor untouched");
            }
            store.close();
        }
    }

    /**
     * The storage seam must make rollback real, or every atomicity check above is vacuous.
     *
     * This asserts the harness itself: a rolled-back batch leaves nothing, and a committed
     * one leaves everything. Without it, a green run would not distinguish a correct store
     * from an adapter that silently ignores transactions.
     */
    private static void storageSeamRollbackIsReal(Path directory) throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("seam.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        store.installBaseline(new AlbumReplica.Adopted("scope-a", LIBRARY, 1, 1, 1,
                "2026-09-16T00:00:00Z", "2026-09-16T00:00:00Z"), Arrays.asList(),
                Arrays.asList(), CLOCK.now());
        long before = store.adopted("scope-a").cursor;
        // A rolled-back transaction must leave both the row and the cursor untouched.
        db.begin();
        db.writeAlbum(new AlbumReplica.Album("rolled", "Rolled", null, null, null, false, 1),
                CLOCK.now());
        db.setCursor(before + 5, CLOCK.now());
        db.rollback();
        check(store.albums("scope-a", false).get("rolled") == null, "A rolled-back row is discarded");
        equal(before, store.adopted("scope-a").cursor, "A rolled-back cursor advance is discarded");
        db.begin();
        db.writeAlbum(new AlbumReplica.Album("kept", "Kept", null, null, null, false, 1),
                CLOCK.now());
        db.setCursor(before + 5, CLOCK.now());
        db.commit();
        check(store.albums("scope-a", false).get("kept") != null, "A committed row is retained");
        equal(before + 5, store.adopted("scope-a").cursor, "A committed cursor advance is retained");
        store.close();
    }

    private static void pageAndCursorCommitTogether(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        List<AlbumReplica.Change> broken = new ArrayList<>();
        broken.add(new AlbumReplica.Change(9, "renameAlbum",
                new AlbumReplica.Album("root", "Skipped", null, "folder", "blue", false, 2), null));
        boolean rejected = false;
        try {
            store.applyChanges("scope-a", 7, broken, CLOCK.now());
        } catch (AlbumReplica.Failure failure) {
            rejected = AlbumReplica.CODE_MALFORMED.equals(failure.code);
        }
        check(rejected, "A non-contiguous page is refused by the store");
        equal(7L, store.adopted("scope-a").cursor, "The cursor does not advance over an unapplied change");
        equal("Root", store.albums("scope-a", false).get("root").name, "The unapplied change wrote nothing");

        List<AlbumReplica.Change> page = new ArrayList<>();
        page.add(new AlbumReplica.Change(8, "renameAlbum",
                new AlbumReplica.Album("root", "Committed", null, "folder", "blue", false, 2), null));
        store.applyChanges("scope-a", 7, page, CLOCK.now());
        equal(8L, store.adopted("scope-a").cursor, "A contiguous page advances the cursor");
        equal("Committed", store.albums("scope-a", false).get("root").name, "and commits its rows");

        // A failure inside the page must leave neither the rows nor the cursor behind.
        // Failing the cursor write specifically is what distinguishes one transaction from
        // a commit followed by a separate advance: in the latter the rows would already be
        // durable while the cursor still described the old state.
        List<AlbumReplica.Change> later = new ArrayList<>();
        later.add(new AlbumReplica.Change(9, "renameAlbum",
                new AlbumReplica.Album("root", "Half applied", null, "folder", "blue", false, 3), null));
        ((MemoryDb) db).failOn = "setCursor";
        boolean failed = false;
        try {
            store.applyChanges("scope-a", 8, later, CLOCK.now());
        } catch (RuntimeException expected) {
            failed = true;
        }
        check(failed, "A failure while applying a page is reported");
        equal("Committed", store.albums("scope-a", false).get("root").name,
                "A failed page leaves the previous rows in place");
        equal(8L, store.adopted("scope-a").cursor, "A failed page does not advance the cursor");
        ((MemoryDb) db).failOn = null;
        store.close();
    }

    private static void processRestartPreservesIdentityCursorAndRows(Path directory) throws Exception {
        Path file = directory.resolve("restart.sqlite");
        SqliteDb db = new SqliteDb(file);
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 8));
            if (target.startsWith("/v1/albums/changes")) {
                return Fixture.Response.ok(changes(8, albumChange(8, "renameAlbum",
                        album("root", "After restart", null, "folder", "blue", 2)), 8, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
        }
        long cursor = store.adopted("scope-a").cursor;
        long albums = db.countAlbums(true);
        long members = db.countMembers(true);
        store.close();

        // A new process opens the same file. The baseline must not be re-downloaded: the
        // stored identity and cursor are what let it catch up instead.
        SqliteDb reopened = new SqliteDb(file);
        LibraryReplicaStore store2 = new LibraryReplicaStore(reopened);
        AlbumReplica.Adopted authority = store2.adopted("scope-a");
        equal(LIBRARY, authority.libraryId, "Identity survives a reopen");
        equal(1L, authority.epoch, "Epoch survives a reopen");
        equal(cursor, authority.cursor, "Cursor survives a reopen");
        equal(albums, reopened.countAlbums(true), "Albums survive a reopen");
        equal(members, reopened.countMembers(true), "Memberships survive a reopen");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 9));
            if (target.startsWith("/v1/albums/changes")) {
                // The log continues at the sequence after the one already applied.
                return Fixture.Response.ok(changes(9, albumChange(9, "renameAlbum",
                        album("root", "After restart 2", null, "folder", "blue", 3)), 9, false));
            }
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store2, CLOCK).reconcile("scope-a");
            check(!result.adoptedBaseline, "A restart catches up incrementally, not by re-adopting");
            equal(1, result.appliedChanges, "The change after restart is applied");
            equal(9L, store2.adopted("scope-a").cursor, "and the cursor advances");
            check(fixture.paths().stream().noneMatch(p -> p.contains("baseline")),
                    "No baseline is requested after a restart");
        }
        store2.close();
    }

    private static void cursorExpiryAdoptsAFreshBaseline(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 30));
            if (target.startsWith("/v1/albums/changes")) return Fixture.Response.error(409, AlbumReplica.CODE_CURSOR_EXPIRED);
            if (albumsPageTarget(target)) return Fixture.Response.ok(albumsPage(30, album("fresh", "Fresh", null, "folder", "red", 1), null, false));
            if (membersPageTarget(target)) return Fixture.Response.ok(membersPage(30, "", null, false));
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
            check(result.adoptedBaseline, "A fresh baseline is adopted after expiry");
            equal(AlbumReplica.CODE_CURSOR_EXPIRED, codeOf(result), "The expiry reason is still reported");
            equal(30L, store.adopted("scope-a").cursor, "The new snapshot cursor is adopted");
            equal(1L, db.countAlbums(true), "The replica is replaced");
            equal("Fresh", store.albums("scope-a", true).get("fresh").name, "and holds the new baseline");
            check(store.albums("scope-a", true).get("root") == null, "The superseded Album is gone");
        }

        // `cursorAhead` is a distinct coded state with the same recovery.
        SqliteDb aheadDb = new SqliteDb(directory.resolve("ahead.sqlite"));
        LibraryReplicaStore ahead = new LibraryReplicaStore(aheadDb);
        installReferenceBaseline(ahead, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 5));
            if (target.startsWith("/v1/albums/changes")) return Fixture.Response.error(409, AlbumReplica.CODE_CURSOR_AHEAD);
            if (albumsPageTarget(target)) return Fixture.Response.ok(albumsPage(5, album("skewed", "Skewed", null, null, null, 1), null, false));
            if (membersPageTarget(target)) return Fixture.Response.ok(membersPage(5, "", null, false));
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), ahead, CLOCK).reconcile("scope-a");
            equal(AlbumReplica.CODE_CURSOR_AHEAD, codeOf(result), "cursorAhead stays distinct from expiry");
            check(result.adoptedBaseline, "cursorAhead also recovers with a fresh baseline");
            equal(5L, ahead.adopted("scope-a").cursor, "The skewed cursor is replaced");
        }
        store.close();
        ahead.close();
    }

    private static void identityAndEpochChangeReAdopts(Path directory) throws Exception {
        for (String label : new String[]{"library", "epoch"}) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installReferenceBaseline(store, "scope-a");
            String otherLibrary = "ffffffffffffffffffffffffffffffff";
            String identity = "library".equals(label) ? otherLibrary : LIBRARY;
            long epoch = "epoch".equals(label) ? 2 : 1;
            try (Fixture fixture = new Fixture(target -> {
                if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(identity, epoch, 1, 8));
                if (albumsPageTarget(target)) {
                    return Fixture.Response.ok(reidentify(
                            albumsPage(8, album("new", "New", null, null, null, 1), null, false),
                            identity, epoch));
                }
                if (membersPageTarget(target)) {
                    return Fixture.Response.ok(reidentify(membersPage(8, "", null, false), identity, epoch));
                }
                return Fixture.Response.error(409, AlbumReplica.CODE_LIBRARY_MISMATCH);
            })) {
                AlbumAuthoritySync.Result result =
                        new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
                check(result.readopted && result.adoptedBaseline,
                        "An " + label + " change re-adopts rather than resuming");
                equal(identity, store.adopted("scope-a").libraryId, "The new identity is stored");
                equal(epoch, store.adopted("scope-a").epoch, "The new epoch is stored");
                check(store.albums("scope-a", true).get("root") == null,
                        "The previous identity's Albums are not carried over");
                check(fixture.paths().stream().noneMatch(p -> p.contains("changes")),
                        "No incremental request is made across an identity change");
            }
            store.close();
        }
    }

    private static void unsupportedContractFailsClosed(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        long cursor = store.adopted("scope-a").cursor;
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 2, 60));
            return Fixture.Response.error(404, "notFound");
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
            equal(AlbumReplica.CODE_CONTRACT_UNSUPPORTED, codeOf(result), "An unsupported contract is reported");
            check(!result.retryable, "and is not silently downgraded to a transient failure");
            equal(cursor, store.adopted("scope-a").cursor, "The stored replica is untouched");
            equal(1, fixture.paths().size(), "No domain request is issued for an unsupported contract");
        }

        try (Fixture fixture = new Fixture(target -> Fixture.Response.ok(
                "{\"protocolVersion\":9,\"active\":true,\"libraryId\":\"" + LIBRARY + "\","
                        + "\"domains\":[{\"domain\":\"albums\",\"libraryId\":\"" + LIBRARY + "\","
                        + "\"epoch\":1,\"contractVersion\":1,\"cursor\":1}]}"))) {
            equal(AlbumReplica.CODE_CONTRACT_UNSUPPORTED,
                    codeOf(new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a")),
                    "An unknown aggregate protocol version fails closed");
        }
        store.close();
    }

    private static void accountChangeCannotExposeTheOldReplica(Path directory) throws Exception {
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        equal(2L, db.countAlbums(true), "The first account has a replica");
        equal(null, store.adopted("scope-b"), "Another connection scope cannot read the stored authority");
        equal(2L, ((Number) store.status("scope-a").get("albumCount")).longValue(),
                "Rows remain stored, not silently deleted");

        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(inactive());
            return Fixture.Response.error(409, AlbumReplica.CODE_INACTIVE);
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-b");
            check(!result.adopted, "A new account starts unadopted");
            equal(null, store.adopted("scope-b"), "and no authority is written for it");
        }
        // An explicit connection change clears the replica rather than leaving rows a later
        // scope could inherit.
        store.clear();
        equal(0L, db.countAlbums(false), "Reset removes Album rows");
        equal(0L, db.countMembers(false), "Reset removes membership rows");
        equal(0L, db.countAuthority(), "Reset removes the authority row");
        store.close();
    }

    /**
     * The changes page must describe exactly the rows it sent.
     *
     * The server derives `nextAfter` as the last row's sequence (or the requested cursor
     * for an empty page) and `hasMore` as `nextAfter < cursor`. These checks pin that a
     * page which disagrees is refused *before* it is committed, rather than being applied
     * as far as it happens to line up.
     */
    private static void changePageContinuationIsPinned(Path directory) throws Exception {
        String[][] cases = {
                // `nextAfter` does not continue from the requested cursor, so the page
                // describes rows that do not belong after this replica's cursor.
                {"nextAfter behind the request",
                        "{\"sequence\":8,\"authorityCursor\":8,\"commandType\":\"renameAlbum\","
                                + "\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":"
                                + album("root", "Regressed", null, null, null, 2) + "}",
                        "8", "6"},
                // `nextAfter` skips past the rows the page actually carried, which would
                // silently omit history.
                {"nextAfter beyond the last row",
                        "{\"sequence\":8,\"authorityCursor\":8,\"commandType\":\"renameAlbum\","
                                + "\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":"
                                + album("root", "Skipped", null, null, null, 2) + "}",
                        "10", "7"},
                // `hasMore` claims more work while the page already reached the advertised
                // authority cursor.
                {"hasMore contradicts the authority cursor",
                        "{\"sequence\":8,\"authorityCursor\":8,\"commandType\":\"renameAlbum\","
                                + "\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":"
                                + album("root", "Contradiction", null, null, null, 2) + "}",
                        "7", "7"},
        };
        for (String[] entry : cases) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installReferenceBaseline(store, "scope-a");
            long cursor = store.adopted("scope-a").cursor;
            String name = store.albums("scope-a", false).get("root").name;
            try (Fixture fixture = new Fixture(target -> {
                if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1,
                        Long.parseLong(entry[3])));
                return Fixture.Response.ok("{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,"
                        + "\"contractVersion\":1,\"cursor\":" + entry[3] + ","
                        + "\"items\":[" + entry[1] + "],"
                        + "\"nextAfter\":" + entry[2] + ","
                        + "\"hasMore\":" + (!entry[2].equals(entry[3])) + "}");
            })) {
                AlbumAuthoritySync.Result result =
                        new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
                equal(AlbumReplica.CODE_MALFORMED, codeOf(result), "Rejected: " + entry[0]);
                equal(name, store.albums("scope-a", false).get("root").name,
                        "Rejected page wrote nothing: " + entry[0]);
                equal(cursor, store.adopted("scope-a").cursor,
                        "Rejected page did not advance the cursor: " + entry[0]);
            }
            store.close();
        }

        // The honest continuation the server actually produces still commits.
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 8));
            return Fixture.Response.ok(changes(8, albumChange(8, "renameAlbum",
                    album("root", "Accepted", null, "folder", "blue", 2)), 8, false));
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
            equal(1, result.appliedChanges, "A page whose continuation matches its rows is applied");
            equal(8L, store.adopted("scope-a").cursor, "and advances the cursor");
            equal("Accepted", store.albums("scope-a", false).get("root").name, "and commits its rows");
        }
        store.close();
    }

    /**
     * A successful changes page cannot describe a cursor beyond the authority's own.
     *
     * The engine requests a page from the replica's own cursor, so the reported shape is a
     * replica at 12 against a server advertising 10. The server answers `after > cursor`
     * with 409 cursorAhead, so a 200 here is a document it cannot produce. The empty-page
     * case is the one that slipped through: with no rows `nextAfter` echoes the requested
     * cursor, so `hasMore == (nextAfter < cursor)` is satisfied by both sides being false
     * and the page looked honest.
     *
     * Every case below satisfies the continuation rule *and* the `hasMore` rule, both
     * derived exactly as the server derives them, so the cursor bound is the only rule that
     * can refuse the document.
     */
    private static void successfulChangePageCannotExceedTheAuthorityCursor(Path directory)
            throws Exception {
        // {replica cursor (the page is requested from it), advertised server cursor, last sequence}
        long[][] cases = {
                // The reported shape: nothing to apply, continuation echoing the request.
                {12, 10, 0},
                // One step past the authority rather than twelve.
                {11, 10, 0},
                // A page whose rows are themselves past the authority cursor.
                {12, 10, 12},
                // Rows inside the authority, but a continuation past it.
                {12, 10, 11},
                // The one shape only the continuation bound can refuse: the replica already
                // sits at the authority cursor, so the request is not beyond it, and the row
                // is contiguous from where the replica is — but the row's own sequence, and
                // therefore the advertised continuation, is one past the authority.
                {10, 10, 11},
        };
        for (long[] entry : cases) {
            long replica = entry[0];
            long serverCursor = entry[1];
            long sequence = entry[2];
            long nextAfter = sequence == 0 ? replica : sequence;
            String items = sequence == 0 ? "" : albumChange(sequence, "renameAlbum",
                    album("root", "Beyond", null, "folder", "blue", 2));
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installBaselineAt(store, "scope-a", replica);
            String name = store.albums("scope-a", false).get("root").name;
            String label = "replica=" + replica + " cursor=" + serverCursor;
            long advertised = serverCursor;
            try (Fixture fixture = new Fixture(target -> {
                // The status document must advertise the authority cursor this case is
                // about; serving the changes body here too would make every case fail in
                // discovery and pass for the wrong reason.
                if (target.startsWith("/v1/sync/status")) {
                    return Fixture.Response.ok(status(LIBRARY, 1, 1, advertised));
                }
                return Fixture.Response.ok(
                        "{\"libraryId\":\"" + LIBRARY + "\",\"epoch\":1,\"contractVersion\":1,"
                                + "\"cursor\":" + advertised + ","
                                + "\"items\":[" + items + "],"
                                + "\"nextAfter\":" + nextAfter + ","
                                + "\"hasMore\":" + (nextAfter < advertised) + "}");
            })) {
                AlbumAuthoritySync.Result result =
                        new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
                equal(AlbumReplica.CODE_MALFORMED, codeOf(result), "Rejected: " + label);
                equal(name, store.albums("scope-a", false).get("root").name,
                        "Rejected page wrote nothing: " + label);
                equal(replica, store.adopted("scope-a").cursor,
                        "Rejected page did not advance the cursor: " + label);
            }
            store.close();
        }

        // An empty page at the replica's own cursor is the honest "nothing to do" answer.
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installBaselineAt(store, "scope-a", 7);
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 7));
            return Fixture.Response.ok(changes(7, "", 7, false));
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a");
            equal(0, result.appliedChanges, "An empty page at the cursor is accepted");
            check(result.code == null, "and is not an error");
            equal(7L, store.adopted("scope-a").cursor, "and leaves the cursor alone");
        }
        store.close();

        // A replica behind a server that has more history still catches up normally, so the
        // bound does not refuse ordinary progress.
        MemoryDb ahead = new MemoryDb();
        LibraryReplicaStore store2 = new LibraryReplicaStore(ahead);
        installBaselineAt(store2, "scope-a", 7);
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 8));
            return Fixture.Response.ok(changes(8, albumChange(8, "renameAlbum",
                    album("root", "Inside", null, "folder", "blue", 2)), 8, false));
        })) {
            AlbumAuthoritySync.Result result =
                    new AlbumAuthoritySync(transport(fixture), store2, CLOCK).reconcile("scope-a");
            equal(1, result.appliedChanges, "A page inside the authority cursor is applied");
            equal(8L, store2.adopted("scope-a").cursor, "and the cursor advances");
        }
        store2.close();
    }

    /**
     * Scope H: a connection that does not own the stored authority reads nothing.
     *
     * The identity read already answered "not adopted" for another scope; these reads have
     * to agree with it. A caller that was told it has no replica must not then be handed
     * one, and that includes the diagnostic counters, which would otherwise leak the
     * previous connection's shape.
     *
     * The rows are hidden, not deleted: a mismatched read is not a reason to destroy durable
     * revision state, and only an explicit replacement clears it.
     */
    private static void wrongScopeReadsNothingAndKeepsTheRowsDurable(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("scope-h.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        // The reference baseline carries one Album tombstone and one membership tombstone,
        // so both lineages have retained state to potentially leak.
        installReferenceBaseline(store, "scope-a");
        store.applyChanges("scope-a", 7, Arrays.asList(
                new AlbumReplica.Change(8, "deleteAlbum",
                        new AlbumReplica.Album("child", "Child", null, "star", "green", true, 2),
                        null)), CLOCK.now());

        // The owning scope sees live rows and retained tombstone diagnostics.
        equal(1, store.albums("scope-a", true).size(), "The owning scope sees its live Albums");
        equal(1, store.memberships("scope-a", true).size(), "and its live memberships");
        equal(2, store.albums("scope-a", false).size(), "and the retained Album tombstone");
        Map<String, Object> owned = store.status("scope-a");
        equal(1L, ((Number) owned.get("albumCount")).longValue(), "Owned live Album count");
        equal(1L, ((Number) owned.get("albumTombstoneCount")).longValue(),
                "Owned Album tombstone count");
        // Deleting `child` retires its live relation, so two relations are retained
        // tombstones: `root:asset_2` from the baseline and `child:asset_1` from the delete.
        equal(1L, ((Number) owned.get("membershipCount")).longValue(), "Owned live membership count");
        equal(2L, ((Number) owned.get("membershipTombstoneCount")).longValue(),
                "Owned membership tombstone count");

        // A different connection scope reads nothing at all.
        equal(null, store.adopted("scope-b"), "Another scope is not adopted");
        equal(0, store.albums("scope-b", true).size(), "Another scope cannot read live Albums");
        equal(0, store.albums("scope-b", false).size(),
                "Another scope cannot read Album tombstones either");
        equal(0, store.memberships("scope-b", true).size(),
                "Another scope cannot read live memberships");
        equal(0, store.memberships("scope-b", false).size(),
                "Another scope cannot read membership tombstones either");
        Map<String, Object> foreign = store.status("scope-b");
        equal(0L, ((Number) foreign.get("albumCount")).longValue(),
                "Another scope receives zero Album counts");
        equal(0L, ((Number) foreign.get("albumTombstoneCount")).longValue(),
                "Another scope receives zero Album tombstone counts");
        equal(0L, ((Number) foreign.get("membershipCount")).longValue(),
                "Another scope receives zero membership counts");
        equal(0L, ((Number) foreign.get("membershipTombstoneCount")).longValue(),
                "Another scope receives zero membership tombstone counts");

        // The rows are still there: hiding is not deleting.
        equal(2L, db.countAlbums(false), "The hidden Albums remain durable");
        equal(3L, db.countMembers(false), "The hidden memberships remain durable");
        // An empty scope string behaves like any other mismatch rather than reading everything.
        equal(0, store.albums("", true).size(), "An unconfigured scope reads nothing");
        store.close();

        // Reopening the same file keeps the rows and the ownership unchanged.
        SqliteDb reopened = new SqliteDb(directory.resolve("scope-h.sqlite"));
        LibraryReplicaStore store2 = new LibraryReplicaStore(reopened);
        equal(1, store2.albums("scope-a", true).size(), "Ownership survives a reopen");
        equal(0, store2.albums("scope-b", true).size(), "and a mismatch still reads nothing");
        store2.close();
    }

    /**
     * A baseline walk that finishes after a replacement must not become readable.
     *
     * This is the replacement race: the old pass is invalidated for *publishing*, but it can
     * still write rows after the new connection cleared the replica. The scope check is the
     * second line of defence — the stale rows exist, and the new connection still reads
     * nothing until its own baseline lands.
     */
    private static void staleBaselineInstalledUnderAnOldScopeStaysInvisible(Path directory)
            throws Exception {
        SqliteDb db = new SqliteDb(directory.resolve("stale-scope.sqlite"));
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        equal(2, store.albums("scope-a", true).size(), "The first connection has a replica");

        // A replacement clears the replica for the new scope.
        store.clear();
        equal(0, store.albums("scope-a", true).size(), "The clear removes the old rows");
        equal(null, store.adopted("scope-b"), "and the new scope starts unadopted");

        // The old pass completes late and installs its baseline under the scope it captured.
        // Its result is discarded by the service, but its write is real.
        installReferenceBaseline(store, "scope-a");
        equal(2, store.albums("scope-a", true).size(), "The late write lands in the database");
        equal(2L, db.countAlbums(false), "and is durable there");

        // The replacement connection still reads nothing until its own baseline is adopted.
        equal(0, store.albums("scope-b", true).size(),
                "A stale baseline under the old scope is invisible to the new scope");
        equal(0, store.memberships("scope-b", true).size(),
                "including its memberships");
        equal(0L, ((Number) store.status("scope-b").get("albumCount")).longValue(),
                "and its counts");
        equal(null, store.adopted("scope-b"), "and the new scope is still unadopted");

        // Once the new connection adopts, only its own rows are visible.
        store.installBaseline(new AlbumReplica.Adopted("scope-b", LIBRARY, 1, 1, 4,
                        "2026-09-16T00:00:00Z", "2026-09-16T00:00:00Z"),
                Arrays.asList(new AlbumReplica.Album("other", "Other", null, null, null, false, 1)),
                Arrays.asList(), CLOCK.now());
        equal(0, store.albums("scope-a", true).size(),
                "The superseded scope now reads nothing");
        equal(1, store.albums("scope-b", true).size(), "and the new scope reads its own baseline");
        equal("Other", store.albums("scope-b", true).get("other").name, "which is the new state");
        store.close();
    }

    private static void malformedResponsesAreRejected(Path directory) throws Exception {
        String[][] cases = {
                {"truncated", "{\"libraryId\":\"" + LIBRARY + "\""},
                {"duplicate key", "{\"libraryId\":\"a\",\"libraryId\":\"b\"}"},
                {"trailing content", "{} extra"},
                {"non-JSON", "<html>nope</html>"},
        };
        for (String[] entry : cases) {
            try (Fixture fixture = new Fixture(target -> Fixture.Response.ok(entry[1]))) {
                MemoryDb db = new MemoryDb();
                LibraryReplicaStore store = new LibraryReplicaStore(db);
                equal(AlbumReplica.CODE_MALFORMED,
                        codeOf(new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a")),
                        "A " + entry[0] + " status body is rejected");
                store.close();
            }
        }

        // An envelope reporting one library while a domain names another cannot be read as
        // "nothing is active" by a client that only checked `active`.
        try (Fixture fixture = new Fixture(target -> Fixture.Response.ok(
                "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"" + LIBRARY + "\","
                        + "\"domains\":[{\"domain\":\"albums\","
                        + "\"libraryId\":\"ffffffffffffffffffffffffffffffff\","
                        + "\"epoch\":1,\"contractVersion\":1,\"cursor\":1}]}"))) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            equal(AlbumReplica.CODE_MALFORMED,
                    codeOf(new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a")),
                    "A domain naming another library is rejected");
            store.close();
        }

        // A change row carrying both deltas, a mismatched cursor, or an unknown command is
        // malformed rather than something to interpret.
        String[] badChanges = {
                "{\"sequence\":8,\"authorityCursor\":8,\"commandType\":\"renameAlbum\","
                        + "\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":"
                        + album("root", "Both", null, null, null, 2) + ",\"membership\":"
                        + member("root", "asset_1", true, 1) + "}",
                "{\"sequence\":8,\"authorityCursor\":7,\"commandType\":\"renameAlbum\","
                        + "\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":"
                        + album("root", "Skewed", null, null, null, 2) + "}",
                "{\"sequence\":8,\"authorityCursor\":8,\"commandType\":\"toggle\","
                        + "\"operationId\":\"x\",\"changedAt\":\"t\",\"album\":"
                        + album("root", "Unknown", null, null, null, 2) + "}",
        };
        for (String item : badChanges) {
            MemoryDb db = new MemoryDb();
            LibraryReplicaStore store = new LibraryReplicaStore(db);
            installReferenceBaseline(store, "scope-a");
            try (Fixture fixture = new Fixture(target -> {
                if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 12));
                return Fixture.Response.ok(changes(8, item, 8, false));
            })) {
                equal(AlbumReplica.CODE_MALFORMED,
                        codeOf(new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a")),
                        "A malformed change row is rejected");
                equal(7L, store.adopted("scope-a").cursor, "and writes nothing");
            }
            store.close();
        }

        // An empty page that claims more work without advancing is refused rather than
        // looped on. It satisfies the parser — an empty page legitimately echoes the cursor
        // it was asked from, and `hasMore` agrees with the advertised authority cursor — so
        // the engine's own progress guard is what has to refuse it. Without that guard this
        // page would be requested forever.
        MemoryDb db = new MemoryDb();
        LibraryReplicaStore store = new LibraryReplicaStore(db);
        installReferenceBaseline(store, "scope-a");
        try (Fixture fixture = new Fixture(target -> {
            if (target.startsWith("/v1/sync/status")) return Fixture.Response.ok(status(LIBRARY, 1, 1, 12));
            return Fixture.Response.ok(changes(12, "", 7, true));
        })) {
            equal(AlbumReplica.CODE_MALFORMED,
                    codeOf(new AlbumAuthoritySync(transport(fixture), store, CLOCK).reconcile("scope-a")),
                    "A page that does not advance is refused");
            equal(7L, store.adopted("scope-a").cursor, "and leaves the cursor where it was");
        }
        store.close();
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
