package com.lakomics.mobile;

import java.util.List;
import java.util.Map;

/** Membership-only Android writer for Album authority 2C-3. */
final class AlbumMembershipOutbox {
    static final String COMMAND_PATH = "/v1/albums/commands";
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
        for (ReplicaDb.OutboxRow row : rows) {
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
                    continue;
                }
                if (isBlockingConflict(code)) {
                    store.blockMembership(scope, row.seq, code, rejected.body);
                    report.pending--;
                    report.blocked++;
                    report.stopped = true;
                    return report;
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
        }
        return report;
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
            Map<String, Object> root = object(Json.parse(body));
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
