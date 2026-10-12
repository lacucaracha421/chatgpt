package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Membership-only Android writer for Album authority 2C-3. */
final class AlbumMembershipOutbox {
    static final String COMMAND_PATH = "/v1/albums/commands";
    /** Consecutive intents travel together here; per-command results come back in order. */
    static final String BATCH_PATH = "/v1/albums/commands/batch";
    /** The server accepts at most this many commands per batch request. */
    static final int BATCH_LIMIT = 100;
    static final String CODE_PROTOCOL_INTEGRITY = "albumCommandOutcomeUnknown";
    static final String CODE_TRANSPORT = "transport";
    /** Definitive refusal for an Asset emptied from the trash: dropped, never retried. */
    static final String CODE_ASSET_TOMBSTONED = "assetTombstoned";

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
        int noOp;
        int pending;
        int blocked;
        /** Intents dropped because their Asset is tombstoned. */
        int dropped;
        boolean stopped;
    }

    private final Transport transport;
    private final LibraryReplicaStore store;
    private final AlbumReplica.Clock clock;
    /** Set once the server answered the batch route as missing; later flushes use the single route. */
    private boolean batchUnsupported;

    AlbumMembershipOutbox(Transport transport, LibraryReplicaStore store, AlbumReplica.Clock clock) {
        this.transport = transport;
        this.store = store;
        this.clock = clock;
    }

    Flush flush(String scope) throws Failure {
        Flush report = new Flush();
        AlbumReplica.Adopted authority = store.adopted(scope);
        if (authority == null) return report;
        List<ReplicaDb.OutboxRow> rows = store.outbox(scope);
        for (ReplicaDb.OutboxRow row : rows) {
            if (row.blocked()) report.blocked++;
            else report.pending++;
        }
        int index = 0;
        while (index < rows.size()) {
            ReplicaDb.OutboxRow row = rows.get(index);
            if (row.blocked()) { report.stopped = true; return report; }
            PayloadIdentity identity = payloadIdentity(row.payload);
            if (!row.libraryId.equals(identity.libraryId)
                    || row.epoch != identity.epoch
                    || row.contractVersion != identity.contractVersion) {
                throw new Failure(CODE_PROTOCOL_INTEGRITY, true);
            }
            if (!authority.libraryId.equals(row.libraryId)) {
                store.blockMembership(scope, row.seq, AlbumReplica.CODE_LIBRARY_MISMATCH, null);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return report;
            }
            if (row.epoch != authority.epoch) {
                store.blockMembership(scope, row.seq, "epochMismatch", null);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return report;
            }
            if (row.contractVersion != authority.contractVersion) {
                store.blockMembership(scope, row.seq, AlbumReplica.CODE_CONTRACT_UNSUPPORTED, null);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return report;
            }
            if (!batchUnsupported) {
                List<ReplicaDb.OutboxRow> group = batchGroup(rows, index, authority);
                if (group.size() > 1) {
                    int handled = sendBatch(scope, group, authority, report);
                    if (handled < 0) return report;
                    if (handled > 0) { index += handled; continue; }
                    // handled == 0: an older server without the batch route; send this row alone.
                }
            }
            if (!sendOne(scope, row, authority, report)) return report;
            index++;
        }
        return report;
    }

    /**
     * The consecutive sendable rows starting at {@code from} that one batch request may carry.
     *
     * At most one row per Album relation: a relation's later intents predict their
     * expectation from the earlier one, so they must not travel in the same request where a
     * refused earlier row could leave a later one accepted on the server.
     */
    private static List<ReplicaDb.OutboxRow> batchGroup(List<ReplicaDb.OutboxRow> rows, int from,
                                                        AlbumReplica.Adopted authority) {
        List<ReplicaDb.OutboxRow> group = new ArrayList<>();
        Set<String> relations = new HashSet<>();
        for (int i = from; i < rows.size() && group.size() < BATCH_LIMIT; i++) {
            ReplicaDb.OutboxRow row = rows.get(i);
            if (row.blocked() || !authority.libraryId.equals(row.libraryId)
                    || row.epoch != authority.epoch
                    || row.contractVersion != authority.contractVersion) break;
            try {
                PayloadIdentity identity = payloadIdentity(row.payload);
                if (!row.libraryId.equals(identity.libraryId) || row.epoch != identity.epoch
                        || row.contractVersion != identity.contractVersion) break;
            } catch (Failure malformed) {
                break;
            }
            if (!relations.add(row.albumId + ":" + row.assetId)) break;
            group.add(row);
        }
        return group;
    }

    /**
     * Send one row on the single-command route.
     *
     * @return false when the flush must stop (the row blocked); true to continue
     */
    private boolean sendOne(String scope, ReplicaDb.OutboxRow row, AlbumReplica.Adopted authority,
                            Flush report) throws Failure {
        final String body;
        try {
            body = transport.put(COMMAND_PATH, row.payload);
        } catch (HttpFailure rejected) {
            String code = detailCode(rejected.body);
            if (CODE_ASSET_TOMBSTONED.equals(code)) {
                // Definitive: the Asset was emptied from the trash. Drop instead of
                // blocking, so a tombstone never holds the Album queue.
                store.dropTombstonedMembership(scope, row.seq, clock.now());
                report.pending--;
                report.dropped++;
                return true;
            }
            if (isBlockingConflict(code)) {
                store.blockMembership(scope, row.seq, code, rejected.body);
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return false;
            }
            if (rejected.status == 401 || rejected.status == 403) {
                throw new Failure(AlbumReplica.CODE_UNAUTHORIZED, false, rejected);
            }
            throw new Failure(code == null ? CODE_TRANSPORT : code,
                    code == null || retryableRejection(code), rejected);
        } catch (Exception unavailable) {
            throw new Failure(CODE_TRANSPORT, true, unavailable);
        }
        Accepted accepted = parseAccepted(body, row, authority);
        store.confirmMembership(scope, row.seq, accepted.member, clock.now());
        report.pending--;
        if (accepted.changed) report.sent++; else report.noOp++;
        return true;
    }

    /**
     * Send consecutive rows in one batch request and apply each row's own outcome with the
     * single route's rules: confirm an accepted row, drop a tombstoned one, block on a
     * conflict, retry later on anything else.
     *
     * @return the number of rows handled; 0 when the server has no batch route and the rows
     *         must be sent one by one; -1 when the flush must stop (a row blocked)
     */
    private int sendBatch(String scope, List<ReplicaDb.OutboxRow> group,
                          AlbumReplica.Adopted authority, Flush report) throws Failure {
        String batchId = UUID.randomUUID().toString();
        String payload = batchPayload(group, authority, batchId);
        final String body;
        try {
            body = transport.put(BATCH_PATH, payload);
        } catch (HttpFailure rejected) {
            String code = detailCode(rejected.body);
            if (((rejected.status == 404 || rejected.status == 405 || rejected.status == 501) && code == null)
                    || "invalidAlbumBatch".equals(code) || "unsupportedBatchCommand".equals(code)) {
                // An older server has no batch route (FastAPI answers 404/405 with a plain
                // string detail). The single route carries the same commands.
                batchUnsupported = true;
                return 0;
            }
            if (rejected.status == 401 || rejected.status == 403) {
                throw new Failure(AlbumReplica.CODE_UNAUTHORIZED, false, rejected);
            }
            throw new Failure(code == null ? CODE_TRANSPORT : code,
                    code == null || retryableRejection(code), rejected);
        } catch (Exception unavailable) {
            throw new Failure(CODE_TRANSPORT, true, unavailable);
        }
        List<Object> results;
        Map<String, Object> envelope;
        try {
            envelope = object(Json.parse(body));
            if (!authority.libraryId.equals(string(envelope, "libraryId"))
                    || authority.epoch != number(envelope, "epoch")
                    || authority.contractVersion != number(envelope, "contractVersion")
                    || !batchId.equals(string(envelope, "batchId"))) {
                throw integrity();
            }
            results = list(envelope, "results");
            if (results.size() != group.size()) throw integrity();
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
        for (int i = 0; i < group.size(); i++) {
            ReplicaDb.OutboxRow row = group.get(i);
            Map<String, Object> item;
            String status;
            try {
                item = object(results.get(i));
                if (!row.operationId.equals(string(item, "operationId"))) throw integrity();
                status = string(item, "status");
            } catch (Failure failure) {
                throw failure;
            } catch (RuntimeException malformed) {
                throw integrity();
            }
            if ("applied".equals(status) || "noop".equals(status)) {
                Accepted accepted = parseAcceptedItem(item, envelope, row, authority);
                store.confirmMembership(scope, row.seq, accepted.member, clock.now());
                report.pending--;
                if (accepted.changed) report.sent++; else report.noOp++;
                continue;
            }
            if (!"conflict".equals(status) && !"rejected".equals(status)) throw integrity();
            Map<String, Object> error;
            String code;
            try {
                error = object(item.get("error"));
                code = string(error, "code");
            } catch (RuntimeException malformed) {
                throw integrity();
            }
            if (CODE_ASSET_TOMBSTONED.equals(code)) {
                store.dropTombstonedMembership(scope, row.seq, clock.now());
                report.pending--;
                report.dropped++;
                continue;
            }
            if (isBlockingConflict(code)) {
                store.blockMembership(scope, row.seq, code, singleRouteBody(error));
                report.pending--;
                report.blocked++;
                report.stopped = true;
                return -1;
            }
            // Any other refusal is the failure the single route would report. Rows after it
            // were not confirmed here and replay through their server-side receipts.
            throw new Failure(code, retryableRejection(code));
        }
        return group.size();
    }

    /** The batch request body: the rows' frozen commands under one shared envelope. */
    private static String batchPayload(List<ReplicaDb.OutboxRow> group,
                                       AlbumReplica.Adopted authority, String batchId) throws Failure {
        List<Object> commands = new ArrayList<>();
        for (ReplicaDb.OutboxRow row : group) {
            try {
                Map<String, Object> command = new LinkedHashMap<>(object(Json.parse(row.payload)));
                command.remove("libraryId");
                command.remove("epoch");
                command.remove("contractVersion");
                commands.add(command);
            } catch (RuntimeException malformed) {
                throw integrity();
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("libraryId", authority.libraryId);
        body.put("epoch", authority.epoch);
        body.put("contractVersion", authority.contractVersion);
        body.put("batchId", batchId);
        body.put("commands", commands);
        return Json.write(body);
    }

    /**
     * A batch item's error rendered as the single route's rejection body, so a blocked row
     * keeps exactly the conflict detail the explicit resolution flow already reads.
     */
    private static String singleRouteBody(Map<String, Object> error) {
        Map<String, Object> detail = new LinkedHashMap<>(error);
        detail.remove("status");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("detail", detail);
        return Json.write(body);
    }

    private static boolean isBlockingConflict(String code) {
        return "revisionConflict".equals(code)
                || "albumNotFound".equals(code)
                || "invalidAlbumMembership".equals(code);
    }

    /** Unknown future codes stay retryable; only codes this build understands as
     * permanent caller/contract failures are marked non-retryable. */
    private static boolean retryableRejection(String code) {
        if (AlbumReplica.CODE_LIBRARY_MISMATCH.equals(code) || AlbumReplica.CODE_INACTIVE.equals(code)) {
            return true;
        }
        switch (code) {
            case "authorityAmbiguous":
            case "authorityContractUnsupported":
            case "unsupportedAlbumCommand":
            case "operationConflict":
            case "invalidAlbumCommand":
            case "invalidAlbumRevision":
            case "emptyAlbumName":
            case "albumNameTooLong":
            case "invalidAlbumAppearance":
            case "invalidAlbumBaseline":
                return false;
            default:
                return true;
        }
    }

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

    private static final class PayloadIdentity {
        final String libraryId;
        final long epoch;
        final long contractVersion;
        PayloadIdentity(String libraryId, long epoch, long contractVersion) {
            this.libraryId = libraryId;
            this.epoch = epoch;
            this.contractVersion = contractVersion;
        }
    }

    private static PayloadIdentity payloadIdentity(String payload) throws Failure {
        try {
            Map<String, Object> root = object(Json.parse(payload));
            return new PayloadIdentity(string(root, "libraryId"), number(root, "epoch"),
                    number(root, "contractVersion"));
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    private static final class Accepted {
        final boolean changed;
        final AlbumReplica.Member member;
        Accepted(boolean changed, AlbumReplica.Member member) {
            this.changed = changed;
            this.member = member;
        }
    }

    private static Accepted parseAccepted(String body, ReplicaDb.OutboxRow row,
                                          AlbumReplica.Adopted authority) throws Failure {
        try {
            return parseAccepted(object(Json.parse(body)), row, authority);
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    /**
     * A batch item read as the single route's acceptance body: the item carries the per-command
     * fields and the batch envelope carries the identity, so the same checks apply unchanged.
     */
    private static Accepted parseAcceptedItem(Map<String, Object> item, Map<String, Object> envelope,
                                              ReplicaDb.OutboxRow row,
                                              AlbumReplica.Adopted authority) throws Failure {
        try {
            Map<String, Object> root = new LinkedHashMap<>(item);
            root.put("libraryId", envelope.get("libraryId"));
            root.put("epoch", envelope.get("epoch"));
            root.put("contractVersion", envelope.get("contractVersion"));
            root.put("commandType", LibraryReplicaStore.MEMBERSHIP_COMMAND);
            return parseAccepted(root, row, authority);
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException malformed) {
            throw integrity();
        }
    }

    private static Accepted parseAccepted(Map<String, Object> root, ReplicaDb.OutboxRow row,
                                          AlbumReplica.Adopted authority) throws Failure {
        try {
            if (!authority.libraryId.equals(string(root, "libraryId"))
                    || authority.epoch != number(root, "epoch")
                    || authority.contractVersion != number(root, "contractVersion")
                    || !LibraryReplicaStore.MEMBERSHIP_COMMAND.equals(string(root, "commandType"))
                    || !row.operationId.equals(string(root, "operationId"))) {
                throw integrity();
            }
            boolean changed = bool(root, "changed");
            long cursor = number(root, "authorityCursor");
            if (cursor < 0 || !root.containsKey("album") || root.get("album") != null) throw integrity();
            Object sequence = root.get("changeSequence");
            if (changed) {
                if (!(sequence instanceof Long) || ((Long) sequence) != cursor || cursor < 1) throw integrity();
            } else if (sequence != null) {
                throw integrity();
            }
            Map<String, Object> membership = object(root.get("membership"));
            String albumId = string(membership, "albumId");
            String assetId = string(membership, "assetId");
            boolean desired = bool(membership, "desiredState");
            long revision = number(membership, "entityRevision");
            if (!row.albumId.equals(albumId) || !row.assetId.equals(assetId)
                    || row.desiredState != desired || revision < 0) throw integrity();
            return new Accepted(changed,
                    new AlbumReplica.Member(albumId, assetId, desired, revision));
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
