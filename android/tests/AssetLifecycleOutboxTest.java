package com.lakomics.mobile;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Library Trash writer checks on the plain JVM: queue, cancel-before-send, frozen payload,
 * the revisionConflict rules (done / dropped / rebase once / block), per-Asset holding and
 * the v6 -> v7 schema upgrade on a real SQLite database.
 */
public final class AssetLifecycleOutboxTest {
    static final String LIB = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    static final String NOW = "2026-09-24T00:00:00Z";
    static int checks = 0;

    static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    static void equal(Object expected, Object actual, String message) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError(message + " (expected " + expected + ", got " + actual + ")");
        }
        checks++;
    }

    /** In-memory storage honouring the seam's contract. */
    static final class Db implements AssetLifecycleOutbox.Storage {
        AssetReplica.Snapshot snapshot;
        String scope;
        final TreeMap<Long, AssetLifecycleOutbox.Row> rows = new TreeMap<>();

        public AssetReplica.Snapshot readAssets(String s) { return s.equals(scope) ? snapshot : null; }
        public void replaceAssets(String s, AssetReplica.Snapshot p) { scope = s; snapshot = p; }
        public void clearAssets() { snapshot = null; scope = null; }
        public List<AssetLifecycleOutbox.Row> lifecycleOutbox() { return new ArrayList<>(rows.values()); }
        public void insertLifecycle(AssetLifecycleOutbox.Row row) { rows.put(row.seq, row); }
        public void replaceLifecycle(AssetLifecycleOutbox.Row row) {
            if (!rows.containsKey(row.seq)) throw new IllegalStateException("No row " + row.seq);
            rows.put(row.seq, row);
        }
        public void deleteLifecycle(long seq) { rows.remove(seq); }
        public void clearLifecycle() { rows.clear(); }

        void replica(String... entries) {
            Map<String, Map<String, Object>> map = new TreeMap<>();
            for (int i = 0; i < entries.length; i += 3) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("assetId", entries[i]);
                p.put("lifecycle", entries[i + 1]);
                p.put("entityRevision", Long.parseLong(entries[i + 2]));
                map.put(entries[i], AssetReplica.projection(p));
            }
            replaceAssets("account", new AssetReplica.Snapshot(LIB, 1, 10, map));
        }

        AssetLifecycleOutbox.Row only() {
            check(rows.size() == 1, "exactly one row expected, got " + rows.size());
            return rows.firstEntry().getValue();
        }
    }

    /** Scripted server: each PUT pops the next response, recording what was sent. */
    static final class Server implements AssetLifecycleOutbox.Transport {
        final Deque<Object> script = new ArrayDeque<>();
        final List<String> sent = new ArrayList<>();

        public String put(String path, String payload) throws Exception {
            if (!AssetLifecycleOutbox.COMMAND_PATH.equals(path)) throw new AssertionError("path " + path);
            sent.add(payload);
            Object next = script.removeFirst();
            if (next instanceof Exception) throw (Exception) next;
            return (String) next;
        }

        void accept(String command, String asset, String lifecycle, long revision, String operation) {
            script.add("{\"libraryId\":\"" + LIB + "\",\"epoch\":1,\"contractVersion\":1,\"commandType\":\""
                    + command + "\",\"operationId\":\"" + operation + "\",\"changed\":true,\"changeSequence\":5,"
                    + "\"authorityCursor\":5,\"asset\":{\"assetId\":\"" + asset + "\",\"lifecycle\":\"" + lifecycle
                    + "\",\"entityRevision\":" + revision + ",\"sha256\":null,\"sizeBytes\":1},\"updatedAt\":\"" + NOW + "\"}");
        }

        void noOp(String command, String operation) {
            script.add("{\"libraryId\":\"" + LIB + "\",\"epoch\":1,\"contractVersion\":1,\"commandType\":\""
                    + command + "\",\"operationId\":\"" + operation + "\",\"changed\":false,\"changeSequence\":null,"
                    + "\"authorityCursor\":5,\"asset\":null,\"updatedAt\":\"" + NOW + "\"}");
        }

        void conflict(String asset, String lifecycle, long current) {
            script.add(new AssetLifecycleOutbox.HttpFailure(409, "{\"detail\":{\"code\":\"revisionConflict\","
                    + "\"assetId\":\"" + asset + "\",\"expectedEntityRevision\":1,\"currentEntityRevision\":"
                    + current + ",\"lifecycle\":\"" + lifecycle + "\"}}"));
        }

        void reject(int status, String code) {
            script.add(new AssetLifecycleOutbox.HttpFailure(status,
                    code == null ? "Unauthorized" : "{\"detail\":{\"code\":\"" + code + "\"}}"));
        }
    }

    static int operation = 0;

    static String op() {
        return String.format("00000000-0000-4000-8000-%012d", ++operation);
    }

    static AssetLifecycleOutbox writer(Db db, Server server) {
        return new AssetLifecycleOutbox(server, db, new ReentrantLock());
    }

    public static void main(String[] args) throws Exception {
        queueAndDeliver();
        undoBeforeAndAfterSend();
        conflictRules();
        rebaseOnceThenBlock();
        perAssetHoldAndFailures();
        integrityAndGuards();
        schemaUpgradesInPlace();
        System.out.println("AssetLifecycleOutboxTest: " + checks + " checks passed");
    }

    static void queueAndDeliver() throws Exception {
        Db db = new Db();
        Server server = new Server();
        AssetLifecycleOutbox outbox = writer(db, server);
        try {
            outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
            throw new AssertionError("queued without an adopted lifecycle replica");
        } catch (IllegalStateException expected) { checks++; }
        equal(0, outbox.flush("account").sent, "flush waits for adoption");

        db.replica("asset-a", "normal", "3");
        String operation = op();
        AssetLifecycleOutbox.Edit edit = outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, operation, NOW);
        AssetLifecycleOutbox.Row row = db.only();
        equal(3L, row.expectedRevision, "the replica revision is the expectation");
        equal("normal", row.sourceLifecycle, "the user saw a normal Asset");
        equal(AssetLifecycleOutbox.PENDING, row.state, "a new intent is pending");
        check(edit.row != null && !edit.cancelled, "an intent was queued");
        equal("{\"libraryId\":\"" + LIB + "\",\"epoch\":1,\"contractVersion\":1,\"operationId\":\"" + operation
                + "\",\"commandType\":\"trashAsset\",\"assetId\":\"asset-a\",\"expectedEntityRevision\":3}",
                row.payload, "the payload is the exact server command envelope");
        // Queuing the same command again is idempotent.
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
        equal(1, db.rows.size(), "a repeated trash is not queued twice");

        server.accept("trashAsset", "asset-a", "trash", 4, operation);
        AssetLifecycleOutbox.Flush flush = outbox.flush("account");
        equal(1, flush.sent, "accepted");
        equal(0, db.rows.size(), "an accepted intent is retired");
        equal(row.payload, server.sent.get(0), "the frozen bytes are what was sent");

        // The seen revision wins when the replica lags behind the trash list.
        db.replica("asset-b", "trash", "2");
        outbox.queue("account", "asset-b", AssetLifecycleOutbox.RESTORE, 6, op(), NOW);
        equal(6L, db.only().expectedRevision, "the newer seen revision is used");
        equal("trash", db.only().sourceLifecycle, "a restore starts from trash");
        server.noOp("restoreAsset", db.only().operationId);
        equal(1, outbox.flush("account").noOp, "an accepted no-op retires the intent");
        equal(0, db.rows.size(), "no-op retired");

        // A tombstoned replica row is never queued.
        db.replica("asset-c", "tombstoned", "9");
        AssetLifecycleOutbox.Edit gone = outbox.queue("account", "asset-c", AssetLifecycleOutbox.RESTORE, 0, op(), NOW);
        check(gone.tombstoned && gone.row == null, "tombstoned Assets cannot be restored");
        equal(0, db.rows.size(), "nothing queued for a tombstone");
    }

    static void undoBeforeAndAfterSend() throws Exception {
        Db db = new Db();
        Server server = new Server();
        AssetLifecycleOutbox outbox = writer(db, server);
        db.replica("asset-a", "normal", "1");
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
        AssetLifecycleOutbox.Edit undo = outbox.queue("account", "asset-a", AssetLifecycleOutbox.RESTORE, 0, op(), NOW);
        check(undo.cancelled, "undo before send cancels locally");
        equal(0, db.rows.size(), "nothing is left to send");
        equal(0, server.sent.size(), "and nothing was sent");

        // A transport failure leaves the row `sending`: it may have been accepted.
        String trash = op();
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, trash, NOW);
        server.script.add(new java.io.IOException("connection reset"));
        try {
            outbox.flush("account");
            throw new AssertionError("transport failure swallowed");
        } catch (AssetLifecycleOutbox.Failure failure) {
            equal(AssetLifecycleOutbox.CODE_TRANSPORT, failure.code, "transport failure is coded");
            check(failure.retryable, "and retryable");
        }
        equal(AssetLifecycleOutbox.SENDING, db.only().state, "the row may have been accepted");
        String restore = op();
        AssetLifecycleOutbox.Edit after = outbox.queue("account", "asset-a", AssetLifecycleOutbox.RESTORE, 0, restore, NOW);
        check(!after.cancelled && after.row != null, "undo after send queues the inverse");
        equal("trash", after.row.sourceLifecycle, "the inverse starts from the predecessor's target");
        equal(2L, after.row.expectedRevision, "and expects the predecessor's revision + 1");
        // Resend of the same operation (receipt answers it), then the restore.
        server.accept("trashAsset", "asset-a", "trash", 2, trash);
        server.accept("restoreAsset", "asset-a", "normal", 3, restore);
        AssetLifecycleOutbox.Flush flush = outbox.flush("account");
        equal(2, flush.sent, "both delivered in order");
        check(server.sent.get(1).contains(trash) && server.sent.get(2).contains(restore), "FIFO per Asset");
        equal(0, db.rows.size(), "both retired");
    }

    static void conflictRules() throws Exception {
        Db db = new Db();
        Server server = new Server();
        AssetLifecycleOutbox outbox = writer(db, server);
        db.replica("asset-a", "normal", "1", "asset-b", "normal", "1", "asset-c", "normal", "1");
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
        server.conflict("asset-a", "trash", 5);        // current == desired
        equal(1, outbox.flush("account").noOp, "already trashed elsewhere: done");
        equal(0, db.rows.size(), "and retired");

        outbox.queue("account", "asset-b", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
        server.conflict("asset-b", "tombstoned", 7);
        equal(1, outbox.flush("account").dropped, "a tombstone drops the intent");
        equal(AssetLifecycleOutbox.DROPPED, db.only().state, "kept for 영구 삭제됨");
        equal(AssetLifecycleOutbox.CODE_TOMBSTONED, db.only().conflictCode, "coded assetTombstoned");
        outbox.dismiss("asset-b");
        equal(0, db.rows.size(), "acknowledged drop is forgotten");

        // A restore of a tombstoned Asset is refused by transition, and is also a drop.
        db.replica("asset-c", "trash", "2");
        outbox.queue("account", "asset-c", AssetLifecycleOutbox.RESTORE, 0, op(), NOW);
        server.script.add(new AssetLifecycleOutbox.HttpFailure(409,
                "{\"detail\":{\"code\":\"lifecycleTransitionRefused\",\"assetId\":\"asset-c\",\"lifecycle\":\"tombstoned\",\"requested\":\"normal\"}}"));
        equal(1, outbox.flush("account").dropped, "restore of a tombstone drops");
    }

    static void rebaseOnceThenBlock() throws Exception {
        Db db = new Db();
        Server server = new Server();
        AssetLifecycleOutbox outbox = writer(db, server);
        db.replica("asset-a", "normal", "1");
        String operation = op();
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, operation, NOW);
        // The PC trashed and restored it meanwhile: still normal, at revision 3.
        server.conflict("asset-a", "normal", 3);
        server.accept("trashAsset", "asset-a", "trash", 4, operation);
        AssetLifecycleOutbox.Flush flush = outbox.flush("account");
        equal(1, flush.rebased, "source still matches: rebased once");
        equal(1, flush.sent, "and delivered in the same pass");
        check(server.sent.get(1).contains("\"expectedEntityRevision\":3") && server.sent.get(1).contains(operation),
                "the retry keeps the operation id and moves only the expectation");

        String second = op();
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, second, NOW);
        server.conflict("asset-a", "normal", 6);
        server.conflict("asset-a", "normal", 8);
        flush = outbox.flush("account");
        equal(1, flush.rebased, "one rebase");
        equal(1, flush.blocked, "a second conflict blocks");
        AssetLifecycleOutbox.Row blocked = db.only();
        equal(AssetLifecycleOutbox.BLOCKED, blocked.state, "blocked for the user");
        equal(AssetLifecycleOutbox.CODE_REVISION_CONFLICT, blocked.conflictCode, "as a conflict");

        // A current state that is neither desired nor what the user saw also blocks.
        db.rows.clear();
        db.replica("asset-b", "trash", "2");
        outbox.queue("account", "asset-b", AssetLifecycleOutbox.RESTORE, 2, op(), NOW);
        db.replica("asset-b", "trash", "2");
        // Simulate a source mismatch: the user saw trash, the authority reports trash is
        // not current and normal is not desired... use a trash row expecting `normal` source.
        AssetLifecycleOutbox.Row row = db.only();
        db.rows.put(row.seq, new AssetLifecycleOutbox.Row(row.seq, row.operationId, row.commandType, row.assetId,
                row.libraryId, row.epoch, row.contractVersion, "normal", row.expectedRevision, row.payload,
                row.state, false, null, null, row.createdAt));
        server.conflict("asset-b", "trash", 4);
        equal(1, outbox.flush("account").blocked, "an unexpected current state blocks");
        // A new intent for the same Asset supersedes the conflict.
        outbox.queue("account", "asset-b", AssetLifecycleOutbox.RESTORE, 4, op(), NOW);
        equal(AssetLifecycleOutbox.PENDING, db.only().state, "choosing again replaces the conflict");
        equal(4L, db.only().expectedRevision, "at the revision the user now sees");
    }

    static void perAssetHoldAndFailures() throws Exception {
        Db db = new Db();
        Server server = new Server();
        AssetLifecycleOutbox outbox = writer(db, server);
        db.replica("asset-a", "normal", "1", "asset-b", "normal", "1");
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
        String b = op();
        outbox.queue("account", "asset-b", AssetLifecycleOutbox.TRASH, 0, b, NOW);
        server.reject(404, "assetNotFound");
        server.accept("trashAsset", "asset-b", "trash", 2, b);
        AssetLifecycleOutbox.Flush flush = outbox.flush("account");
        equal(1, flush.blocked, "asset-a blocks");
        equal(1, flush.sent, "asset-b is not held behind another Asset's conflict");

        // An old server (publisher-only route) answers 401: the row stays cancellable.
        db.rows.clear();
        outbox.queue("account", "asset-b", AssetLifecycleOutbox.RESTORE, 2, op(), NOW);
        server.reject(401, null);
        try {
            outbox.flush("account");
            throw new AssertionError("401 swallowed");
        } catch (AssetLifecycleOutbox.Failure failure) {
            equal(AssetLifecycleOutbox.CODE_UNAUTHORIZED, failure.code, "coded unauthorized");
        }
        equal(AssetLifecycleOutbox.PENDING, db.only().state, "a refused send is still pending");
        check(outbox.queue("account", "asset-b", AssetLifecycleOutbox.TRASH, 0, op(), NOW).cancelled,
                "and can still be cancelled");

        // An inactive domain is retryable and keeps the intent.
        outbox.queue("account", "asset-b", AssetLifecycleOutbox.RESTORE, 2, op(), NOW);
        server.reject(409, "authorityInactive");
        try {
            outbox.flush("account");
            throw new AssertionError("inactive swallowed");
        } catch (AssetLifecycleOutbox.Failure failure) {
            check(failure.retryable && "authorityInactive".equals(failure.code), "inactive is retryable");
        }
        equal(1, db.rows.size(), "the intent is kept");

        // Another library's row is blocked, never sent.
        db.rows.clear();
        db.insertLifecycle(new AssetLifecycleOutbox.Row(1, op(), AssetLifecycleOutbox.TRASH, "asset-a",
                "ffffffffffffffffffffffffffffffff", 1, 1, "normal", 1,
                AssetLifecycleOutbox.payload("ffffffffffffffffffffffffffffffff", 1, 1, "x", "trashAsset", "asset-a", 1),
                AssetLifecycleOutbox.PENDING, false, null, null, NOW));
        int before = server.sent.size();
        equal(1, outbox.flush("account").blocked, "a library mismatch blocks");
        equal(before, server.sent.size(), "and sends nothing");
    }

    static void integrityAndGuards() throws Exception {
        Db db = new Db();
        Server server = new Server();
        AssetLifecycleOutbox outbox = writer(db, server);
        db.replica("asset-a", "normal", "1");
        String operation = op();
        outbox.queue("account", "asset-a", AssetLifecycleOutbox.TRASH, 0, operation, NOW);
        // An echo that skips a revision does not describe this command.
        server.accept("trashAsset", "asset-a", "trash", 9, operation);
        try {
            outbox.flush("account");
            throw new AssertionError("mismatched echo accepted");
        } catch (AssetLifecycleOutbox.Failure failure) {
            equal(AssetLifecycleOutbox.CODE_PROTOCOL_INTEGRITY, failure.code, "integrity failure");
        }
        equal(1, db.rows.size(), "the intent is not retired on a bad echo");
        // A tampered payload is never sent.
        AssetLifecycleOutbox.Row row = db.only();
        db.rows.put(row.seq, new AssetLifecycleOutbox.Row(row.seq, row.operationId, row.commandType, row.assetId,
                row.libraryId, row.epoch, row.contractVersion, row.sourceLifecycle, row.expectedRevision,
                row.payload.replace("trashAsset", "tombstoneAsset"), row.state, false, null, null, row.createdAt));
        int before = server.sent.size();
        try {
            outbox.flush("account");
            throw new AssertionError("tampered payload sent");
        } catch (AssetLifecycleOutbox.Failure failure) {
            equal(before, server.sent.size(), "nothing sent");
        }
        for (String bad : new String[]{"tombstoneAsset", "purge", ""}) {
            try {
                outbox.queue("account", "asset-a", bad, 0, op(), NOW);
                throw new AssertionError("constructed " + bad);
            } catch (IllegalArgumentException expected) { checks++; }
        }
        try {
            outbox.queue("account", "../x", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
            throw new AssertionError("bad asset id");
        } catch (IllegalArgumentException expected) { checks++; }
        // Another connection scope sees no adopted replica.
        try {
            outbox.queue("other", "asset-a", AssetLifecycleOutbox.TRASH, 0, op(), NOW);
            throw new AssertionError("other scope queued");
        } catch (IllegalStateException expected) { checks++; }
    }

    /** v6 device database -> v7 through the shipped migration, on a real SQLite engine. */
    static void schemaUpgradesInPlace() throws Exception {
        equal(7, ReplicaSchema.VERSION, "v7 adds the Asset lifecycle outbox");
        check(ReplicaSchema.canUpgradeFrom(6), "v6 upgrades in place");
        equal(0, ReplicaSchema.upgradeStatements(6).length, "additive DDL only");
        Path file = Files.createTempFile("lifecycle-v6", ".sqlite");
        try {
            StringBuilder v6 = new StringBuilder();
            for (String statement : ReplicaSchema.DDL) {
                if (statement.contains("asset_lifecycle_outbox")) continue;
                v6.append(statement).append(";\n");
            }
            v6.append("INSERT INTO asset_authority VALUES(1,'account','").append(LIB).append("',1,4);\n");
            v6.append("INSERT INTO asset_state VALUES('asset-a','trash',2,'{}');\n");
            v6.append("PRAGMA user_version=6;\n");
            sqlite(file, v6.toString());
            List<String> executed = new ArrayList<>();
            int[] version = {6};
            ReplicaSchema.migrate(new ReplicaSchema.Statements() {
                public int version() { return 6; }
                public void execute(String statement) { executed.add(statement); }
                public void setVersion(int v) { version[0] = v; }
            });
            equal(7, version[0], "stamped v7");
            StringBuilder upgrade = new StringBuilder("BEGIN;\n");
            for (String statement : executed) upgrade.append(statement).append(";\n");
            upgrade.append("PRAGMA user_version=").append(version[0]).append(";\nCOMMIT;\n");
            sqlite(file, upgrade.toString());
            String out = sqlite(file, "SELECT count(*) FROM asset_state; SELECT cursor FROM asset_authority;"
                    + " SELECT count(*) FROM asset_lifecycle_outbox; PRAGMA user_version;");
            equal("1\n4\n0\n7", out.trim(), "existing replica rows survive; the outbox starts empty");
            // The shipped write statement fits the table.
            String insert = ReplicaSchema.WRITE_LIFECYCLE_OUTBOX.replace("VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    "VALUES(1,'op','trashAsset','asset-a','" + LIB + "',1,1,'normal',2,'{}','pending',0,NULL,NULL,'" + NOW + "')");
            sqlite(file, insert + "; " + ReplicaSchema.WRITE_LIFECYCLE_OUTBOX.replace("VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    "VALUES(1,'op','trashAsset','asset-a','" + LIB + "',1,1,'normal',3,'{}','sending',1,NULL,NULL,'" + NOW + "')") + ";");
            equal("1|3|sending|1", sqlite(file, "SELECT count(*),max(expected_revision),max(state),max(rebased) FROM asset_lifecycle_outbox;").trim(),
                    "replace-by-seq keeps one row");
            try {
                sqlite(file, "INSERT INTO asset_lifecycle_outbox VALUES(2,'op2','tombstoneAsset','a','" + LIB
                        + "',1,1,'normal',1,'{}','pending',0,NULL,NULL,'" + NOW + "');");
                throw new AssertionError("tombstone row accepted by the schema");
            } catch (IllegalStateException expected) { checks++; }
        } finally {
            Files.deleteIfExists(file);
        }
    }

    /** Run SQL through the system `sqlite3` module (Python), returning `|`-joined rows. */
    static String sqlite(Path file, String sql) throws Exception {
        String python = System.getenv().getOrDefault("PYTHON", "python3");
        String driver = "import sqlite3,sys\n"
                + "db=sqlite3.connect(sys.argv[1],isolation_level=None)\n"
                + "out=[]\n"
                + "for s in [x for x in sys.stdin.read().split(';\\n') if x.strip()]:\n"
                + "  for part in [p for p in s.split('; ') if p.strip()]:\n"
                + "    for row in db.execute(part).fetchall(): out.append('|'.join('' if v is None else str(v) for v in row))\n"
                + "print('\\n'.join(out))\n";
        Process process = new ProcessBuilder(python, "-c", driver, file.toString()).redirectErrorStream(true).start();
        process.getOutputStream().write(sql.getBytes(StandardCharsets.UTF_8));
        process.getOutputStream().close();
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) output.append(line).append('\n');
        }
        if (process.waitFor() != 0) throw new IllegalStateException("sqlite failed: " + output);
        return output.toString();
    }
}
