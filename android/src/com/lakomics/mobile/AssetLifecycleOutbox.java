package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.Lock;

/**
 * Android's Library Trash writer: `trashAsset` / `restoreAsset` intents for one Asset at a
 * time (mobile Library Trash design §2, ADR-0038).
 *
 * Modelled on {@link ClassificationAssignmentOutbox}, with the rules the lifecycle domain
 * needs:
 *
 * * **Two commands only.** Tombstone (emptying the trash) is publisher-only on the server
 *   and has no constructor here, so the phone cannot empty the trash by construction.
 * * **One UUID operation per intent, frozen payload bytes.** The stored payload is what is
 *   sent; a rebase rewrites the expectation and the payload together and never the
 *   operation id, because the rejected command was never receipted.
 * * **Cancel before send.** Undo of a still-pending intent deletes it locally. Once a row
 *   is `sending` it may already have been accepted, so undo queues the inverse command
 *   instead of guessing.
 * * **revisionConflict** carries the authority's current state:
 *   current == desired → done; `tombstoned` → dropped ("영구 삭제됨"); current == the state
 *   the user saw → rebase once; anything else → blocked for the user to see.
 * * **Per-Asset order.** Rows are delivered oldest first; a blocked or dropped row holds
 *   only later rows of the *same* Asset, so one conflict cannot jam every other Asset.
 *
 * Network is always outside the store lock; every storage access is inside it.
 */
final class AssetLifecycleOutbox {
    static final String COMMAND_PATH = "/v1/assets/authority/commands";
    static final String TRASH = "trashAsset";
    static final String RESTORE = "restoreAsset";
    static final String NORMAL = "normal";
    static final String TRASHED = "trash";
    static final String TOMBSTONED = "tombstoned";
    static final long CONTRACT_VERSION = 1;

    static final String PENDING = "pending";
    /** Handed to the transport: it may have been accepted, so it can no longer be cancelled. */
    static final String SENDING = "sending";
    static final String BLOCKED = "blocked";
    /** The Asset was tombstoned (emptied on a PC); the intent can never apply. */
    static final String DROPPED = "dropped";

    static final String CODE_REVISION_CONFLICT = "revisionConflict";
    static final String CODE_TOMBSTONED = "assetTombstoned";
    static final String CODE_PROTOCOL_INTEGRITY = "assetLifecycleOutcomeUnknown";
    static final String CODE_TRANSPORT = "transport";
    static final String CODE_UNAUTHORIZED = "unauthorized";
    static final String CODE_LIBRARY_MISMATCH = "authorityLibraryMismatch";
    static final String CODE_EPOCH_MISMATCH = "epochMismatch";

    interface Transport {
        String put(String path, String payload) throws Exception;
    }

    /** Durable storage for the outbox, beside the lifecycle replica it composes from. */
    interface Storage extends AssetReplica.Storage {
        /** Every row, FIFO by `seq`. */
        List<Row> lifecycleOutbox();

        void insertLifecycle(Row row);

        /** Replace the row with the same `seq`. */
        void replaceLifecycle(Row row);

        void deleteLifecycle(long seq);

        void clearLifecycle();
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

    static final class Row {
        final long seq;
        final String operationId;
        final String commandType;
        final String assetId;
        final String libraryId;
        final long epoch;
        final long contractVersion;
        /** The lifecycle the user saw when composing this intent (`normal` or `trash`). */
        final String sourceLifecycle;
        final long expectedRevision;
        final String payload;
        final String state;
        /** A row is rebased at most once; a second conflict blocks it. */
        final boolean rebased;
        final String conflictCode;
        final String conflictDetail;
        final String createdAt;

        Row(long seq, String operationId, String commandType, String assetId, String libraryId,
            long epoch, long contractVersion, String sourceLifecycle, long expectedRevision,
            String payload, String state, boolean rebased, String conflictCode,
            String conflictDetail, String createdAt) {
            this.seq = seq;
            this.operationId = operationId;
            this.commandType = commandType;
            this.assetId = assetId;
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
            this.sourceLifecycle = sourceLifecycle;
            this.expectedRevision = expectedRevision;
            this.payload = payload;
            this.state = state;
            this.rebased = rebased;
            this.conflictCode = conflictCode;
            this.conflictDetail = conflictDetail;
            this.createdAt = createdAt;
        }

        Row withState(String nextState, String code, String detail) {
            return new Row(seq, operationId, commandType, assetId, libraryId, epoch, contractVersion,
                    sourceLifecycle, expectedRevision, payload, nextState, rebased, code, detail,
                    createdAt);
        }

        Row rebasedOnto(long revision) {
            return new Row(seq, operationId, commandType, assetId, libraryId, epoch, contractVersion,
                    sourceLifecycle, revision,
                    payload(libraryId, epoch, contractVersion, operationId, commandType, assetId,
                            revision), PENDING, true, null, null, createdAt);
        }

        boolean active() {
            return PENDING.equals(state) || SENDING.equals(state);
        }

        String target() {
            return targetOf(commandType);
        }
    }

    /** The result of one local edit. */
    static final class Edit {
        /** A pending inverse was cancelled before it was sent. */
        final boolean cancelled;
        /** Nothing was queued because the Asset is already tombstoned. */
        final boolean tombstoned;
        final Row row;

        Edit(boolean cancelled, boolean tombstoned, Row row) {
            this.cancelled = cancelled;
            this.tombstoned = tombstoned;
            this.row = row;
        }
    }

    static final class Flush {
        int sent;
        int noOp;
        int rebased;
        int dropped;
        int blocked;
        int pending;
    }

    private final Transport transport;
    private final Storage storage;
    private final Lock lock;

    AssetLifecycleOutbox(Transport transport, Storage storage, Lock lock) {
        this.transport = transport;
        this.storage = storage;
        this.lock = lock;
    }

    static String targetOf(String commandType) {
        if (TRASH.equals(commandType)) return TRASHED;
        if (RESTORE.equals(commandType)) return NORMAL;
        throw new IllegalArgumentException("Unsupported lifecycle command");
    }

    // -----------------------------------------------------------------------
    // Local edits
    // -----------------------------------------------------------------------

    /**
     * Queue one trash or restore intent, or cancel a still-pending inverse (undo).
     *
     * `seenRevision` is the lifecycle revision the caller observed (the trash list carries
     * it); the replica's own revision is preferred when it is newer. A wrong guess is not
     * fatal: the first revision conflict whose current state still matches what the user
     * saw rebases once.
     */
    Edit queue(String scope, String assetId, String commandType, long seenRevision,
               String operationId, String now) {
        if (assetId == null || !assetId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Asset id");
        }
        targetOf(commandType);
        if (operationId == null || !operationId.matches(
                "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            throw new IllegalArgumentException("Invalid operation id");
        }
        lock.lock();
        try {
            AssetReplica.Snapshot authority = storage.readAssets(scope);
            if (authority == null) throw new IllegalStateException("Asset lifecycle authority is not adopted");
            List<Row> rows = storage.lifecycleOutbox();
            long nextSeq = 1;
            Row last = null;
            for (Row row : rows) {
                nextSeq = Math.max(nextSeq, row.seq + 1);
                if (!row.assetId.equals(assetId)) continue;
                // A new intent supersedes a settled conflict or drop for the same Asset:
                // the user has seen it and is choosing again.
                if (!row.active()) storage.deleteLifecycle(row.seq);
                else last = row;
            }
            String source;
            long expected;
            if (last != null) {
                if (last.commandType.equals(commandType)) return new Edit(false, false, last);
                if (PENDING.equals(last.state)) {
                    // Undo before send: the inverse was never delivered, so it simply goes.
                    storage.deleteLifecycle(last.seq);
                    return new Edit(true, false, null);
                }
                // The inverse may already be accepted: follow it with this command.
                source = last.target();
                expected = last.expectedRevision + 1;
            } else {
                Map<String, Object> projection = authority.rows.get(assetId);
                if (projection != null && TOMBSTONED.equals(projection.get("lifecycle"))) {
                    return new Edit(false, true, null);
                }
                source = TRASH.equals(commandType) ? NORMAL : TRASHED;
                long replica = projection == null ? 0 : (Long) projection.get("entityRevision");
                expected = Math.max(1, Math.max(replica, seenRevision));
            }
            Row row = new Row(nextSeq, operationId, commandType, assetId, authority.library,
                    authority.epoch, CONTRACT_VERSION, source, expected,
                    payload(authority.library, authority.epoch, CONTRACT_VERSION, operationId,
                            commandType, assetId, expected),
                    PENDING, false, null, null, now);
            storage.insertLifecycle(row);
            return new Edit(false, false, row);
        } finally {
            lock.unlock();
        }
    }

    /** Forget a settled (blocked or dropped) outcome the user has acknowledged. */
    void dismiss(String assetId) {
        lock.lock();
        try {
            for (Row row : storage.lifecycleOutbox()) {
                if (row.assetId.equals(assetId) && !row.active()) storage.deleteLifecycle(row.seq);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Every row, FIFO. */
    List<Row> rows() {
        lock.lock();
        try {
            return new ArrayList<>(storage.lifecycleOutbox());
        } finally {
            lock.unlock();
        }
    }

    // -----------------------------------------------------------------------
    // Delivery
    // -----------------------------------------------------------------------

    /**
     * Deliver pending intents oldest first.
     *
     * Returns without doing anything while the lifecycle replica is not adopted for this
     * scope: the rows keep their identity and wait. A transport failure throws and leaves
     * the row `sending` (it may have been accepted; the same operation id is resent and the
     * server receipt answers it).
     */
    Flush flush(String scope) throws Failure {
        Flush report = new Flush();
        // Only the authority identity is needed here, so every pass avoids a full row read.
        AssetReplica.Header authority;
        lock.lock();
        try {
            authority = storage.readAssetHeader(scope);
        } finally {
            lock.unlock();
        }
        if (authority == null) return report;
        for (int guard = 0; guard < 1000; guard++) {
            Row next = null;
            lock.lock();
            try {
                Set<String> held = new HashSet<>();
                for (Row row : storage.lifecycleOutbox()) {
                    if (!row.active()) { held.add(row.assetId); continue; }
                    if (held.contains(row.assetId)) continue;
                    next = row;
                    break;
                }
                if (next == null) break;
                if (!authority.library.equals(next.libraryId)) {
                    storage.replaceLifecycle(next.withState(BLOCKED, CODE_LIBRARY_MISMATCH, null));
                    report.blocked++;
                    continue;
                }
                if (authority.epoch != next.epoch || next.contractVersion != CONTRACT_VERSION) {
                    storage.replaceLifecycle(next.withState(BLOCKED, CODE_EPOCH_MISMATCH, null));
                    report.blocked++;
                    continue;
                }
                requireFrozenPayload(next);
                if (PENDING.equals(next.state)) {
                    next = next.withState(SENDING, null, null);
                    storage.replaceLifecycle(next);
                }
            } finally {
                lock.unlock();
            }
            final String body;
            try {
                body = transport.put(COMMAND_PATH, next.payload);
            } catch (HttpFailure rejected) {
                if (!rejected(next, rejected, report)) {
                    report.pending = pendingCount();
                    if (rejected.status == 401 || rejected.status == 403) {
                        throw new Failure(CODE_UNAUTHORIZED, true, rejected);
                    }
                    String code = detailCode(rejected.body);
                    throw new Failure(code == null ? CODE_TRANSPORT : code, true, rejected);
                }
                continue;
            } catch (Exception unavailable) {
                report.pending = pendingCount();
                throw new Failure(CODE_TRANSPORT, true, unavailable);
            }
            boolean changed = parseAccepted(body, next, authority);
            lock.lock();
            try {
                storage.deleteLifecycle(next.seq);
            } finally {
                lock.unlock();
            }
            if (changed) report.sent++; else report.noOp++;
        }
        report.pending = pendingCount();
        return report;
    }

    private int pendingCount() {
        lock.lock();
        try {
            int count = 0;
            for (Row row : storage.lifecycleOutbox()) if (row.active()) count++;
            return count;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Apply a coded rejection. Returns true when the row was settled (done, rebased,
     * dropped or blocked) and the pass may continue; false when it stays deliverable and the
     * pass must stop with a retryable failure.
     */
    private boolean rejected(Row row, HttpFailure rejected, Flush report) throws Failure {
        String code = detailCode(rejected.body);
        Map<String, Object> detail = detail(rejected.body);
        lock.lock();
        try {
            if (CODE_REVISION_CONFLICT.equals(code)) {
                String current = conflictLifecycle(detail, row);
                long revision = conflictRevision(detail);
                if (row.target().equals(current)) {
                    // Already in the desired state (another device, or a lost response):
                    // the intent is satisfied.
                    storage.deleteLifecycle(row.seq);
                    report.noOp++;
                } else if (TOMBSTONED.equals(current)) {
                    storage.replaceLifecycle(row.withState(DROPPED, CODE_TOMBSTONED, null));
                    report.dropped++;
                } else if (row.sourceLifecycle.equals(current) && !row.rebased) {
                    storage.replaceLifecycle(row.rebasedOnto(revision));
                    report.rebased++;
                } else {
                    storage.replaceLifecycle(row.withState(BLOCKED, CODE_REVISION_CONFLICT,
                            rejected.body));
                    report.blocked++;
                }
                return true;
            }
            if (CODE_TOMBSTONED.equals(code) || ("lifecycleTransitionRefused".equals(code)
                    && TOMBSTONED.equals(detail == null ? null : detail.get("lifecycle")))) {
                storage.replaceLifecycle(row.withState(DROPPED, CODE_TOMBSTONED, null));
                report.dropped++;
                return true;
            }
            if (isBlocking(code)) {
                storage.replaceLifecycle(row.withState(BLOCKED, code, rejected.body));
                report.blocked++;
                return true;
            }
            // Not accepted (the server answered), so the row may be cancelled again.
            storage.replaceLifecycle(row.withState(PENDING, null, null));
            return false;
        } finally {
            lock.unlock();
        }
    }

    /** Coded refusals of this command's content that retrying cannot change. */
    private static boolean isBlocking(String code) {
        if (code == null) return false;
        switch (code) {
            case "assetNotFound":
            case "lifecycleTransitionRefused":
            case "operationConflict":
            case "invalidAssetCommand":
            case "authorityContractUnsupported":
            case CODE_LIBRARY_MISMATCH:
                return true;
            default:
                return false;
        }
    }

    private static String conflictLifecycle(Map<String, Object> detail, Row row) throws Failure {
        if (detail == null || !row.assetId.equals(detail.get("assetId"))) throw integrity();
        Object lifecycle = detail.get("lifecycle");
        if (!NORMAL.equals(lifecycle) && !TRASHED.equals(lifecycle) && !TOMBSTONED.equals(lifecycle)) {
            throw integrity();
        }
        return (String) lifecycle;
    }

    private static long conflictRevision(Map<String, Object> detail) throws Failure {
        Object revision = detail.get("currentEntityRevision");
        if (!(revision instanceof Long) || (Long) revision < 1) throw integrity();
        return (Long) revision;
    }

    /** The stored payload must describe exactly the row's own identity. */
    private static void requireFrozenPayload(Row row) throws Failure {
        String expected = payload(row.libraryId, row.epoch, row.contractVersion, row.operationId,
                row.commandType, row.assetId, row.expectedRevision);
        if (!expected.equals(row.payload)) throw integrity();
    }

    /**
     * Prove a 200 accepted *this* intent before the row is retired.
     *
     * A changed command must return the Asset in the target state at exactly the next
     * revision; an accepted no-op returns no Asset.
     */
    private static boolean parseAccepted(String body, Row row, AssetReplica.Header authority)
            throws Failure {
        try {
            Map<String, Object> root = AssetReplica.object(Json.parse(body));
            if (!authority.library.equals(root.get("libraryId"))
                    || !Long.valueOf(authority.epoch).equals(root.get("epoch"))
                    || !Long.valueOf(CONTRACT_VERSION).equals(root.get("contractVersion"))
                    || !row.commandType.equals(root.get("commandType"))
                    || !row.operationId.equals(root.get("operationId"))) {
                throw integrity();
            }
            Object changed = root.get("changed");
            if (!(changed instanceof Boolean)) throw integrity();
            if (!(Boolean) changed) {
                if (root.get("asset") != null) throw integrity();
                return false;
            }
            Map<String, Object> asset = AssetReplica.projection(root.get("asset"));
            if (!row.assetId.equals(asset.get("assetId"))
                    || !row.target().equals(asset.get("lifecycle"))
                    || !Long.valueOf(row.expectedRevision + 1).equals(asset.get("entityRevision"))) {
                throw integrity();
            }
            return true;
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    private static Map<String, Object> detail(String body) {
        try {
            Map<String, Object> root = AssetReplica.object(Json.parse(body));
            return AssetReplica.object(root.get("detail"));
        } catch (RuntimeException malformed) {
            return null;
        }
    }

    private static String detailCode(String body) {
        Map<String, Object> detail = detail(body);
        Object code = detail == null ? null : detail.get("code");
        return code instanceof String ? (String) code : null;
    }

    private static Failure integrity() { return new Failure(CODE_PROTOCOL_INTEGRITY, true); }

    /** The exact command body. Deterministic, so a frozen payload can be re-derived and compared. */
    static String payload(String libraryId, long epoch, long contractVersion, String operationId,
                          String commandType, String assetId, long expectedRevision) {
        return "{\"libraryId\":" + quote(libraryId)
                + ",\"epoch\":" + epoch
                + ",\"contractVersion\":" + contractVersion
                + ",\"operationId\":" + quote(operationId)
                + ",\"commandType\":" + quote(commandType)
                + ",\"assetId\":" + quote(assetId)
                + ",\"expectedEntityRevision\":" + expectedRevision + "}";
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
