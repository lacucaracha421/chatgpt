package com.lakomics.mobile;

import android.content.Context;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Foreground Album replica synchronization for the Android app.
 *
 * This is not a background service. It runs while the app is in the foreground, on
 * resume and then about every five seconds — the same convergence target the PC's
 * authority loops use — and stops as soon as the app is paused. No wake lock is taken
 * and no WorkManager job is scheduled: metadata convergence is not worth keeping the
 * device awake for, and the next foreground resume reconciles anyway.
 *
 * Foreground state lives in {@link ForegroundSchedule}, not here, so the transitions
 * that decide whether reconciliation is armed are checked without an Android runtime.
 *
 * Single-flight is not an optimization here. Two concurrent passes could both walk a
 * frozen baseline and install it, or one could advance the cursor while the other holds
 * a stale reading of it, so overlapping runs are refused rather than merged.
 *
 * This class is also the Android-facing Album status surface: it reports the adopted
 * authority and the replica's diagnostic state and exposes no mutation path at all.
 */
final class AlbumReplicaService {
    /** Foreground convergence target, matching the PC authority sync loops. */
    static final long INTERVAL_MILLIS = ForegroundSchedule.INTERVAL_MILLIS;

    private static AlbumReplicaService instance;

    static synchronized AlbumReplicaService get(Context context) {
        if (instance == null) instance = new AlbumReplicaService(context);
        return instance;
    }

    private final Context context;
    private final SecureSettings settings;
    private final CloudClient client;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "lakomics-album-replica");
        thread.setDaemon(true);
        return thread;
    });
    /** Guards one pass at a time, including the read of "when did the last one start". */
    private final Object gate = new Object();
    /** Whether reconciliation is armed, and how it is disarmed. */
    private final ForegroundSchedule schedule = new ForegroundSchedule(this::afterInterval,
            () -> request(true), () -> request(false));
    /**
     * Invalidates an in-flight pass.
     *
     * A connection change cannot wait for the network round trip a pass may be inside, so
     * the pass is not cancelled: it is made *irrelevant*. It captures this value before it
     * does any work and refuses to record what it learned if it moved, which is what stops
     * a pass that started under the old account from reporting state under the new one.
     */
    private int attempt;

    private LibraryReplicaStore store;
    private AlbumAuthoritySync sync;
    private AlbumMembershipOutbox outbox;
    private AlbumSyncPass cycle;
    private long lastAttempt;
    private volatile boolean syncing;
    private volatile String code = "";
    private volatile String error = "";
    private volatile AlbumAuthoritySync.Result last;

    private AlbumReplicaService(Context context) {
        this.context = context.getApplicationContext();
        this.settings = new SecureSettings(this.context);
        this.client = new CloudClient(settings);
    }

    /** The one repeating task, cancelled by {@link #schedule} so no timer outlives a pause. */
    private java.util.concurrent.ScheduledFuture<?> afterInterval(Runnable task, long interval) {
        return worker.scheduleWithFixedDelay(task, interval, interval, TimeUnit.MILLISECONDS);
    }

    /** Begin foreground polling, reconciling immediately. Idempotent. */
    void start() {
        schedule.start();
    }

    /** Stop polling. The replica, its cursor and its rows stay durable across this. */
    void stop() {
        schedule.stop();
    }

    /**
     * Discard this connection's replica. Called under the connection lock on change.
     *
     * Rows are cleared here rather than merely hidden, because the two protections answer
     * different questions: clearing means nothing from the replaced account is left to
     * leak, and the stored connection scope means a row a race left behind still cannot be
     * read under the new account.
     */
    void reset() {
        // The schedule is disarmed here and re-armed only by a subsequent `start()`, so a
        // disconnect cannot leave polling running against a configuration that no longer
        // exists. Clearing the replica is a different question from whether to poll.
        schedule.stop();
        clearReplica();
    }

    /**
     * Drop this connection's replica and invalidate any pass describing it.
     *
     * Separate from {@link #reset()} because "the replica must go" and "polling must stop"
     * are independent: a replacement connection needs both the old rows gone and the loop
     * still running.
     */
    private void clearReplica() {
        synchronized (gate) {
            // Invalidate any pass still in flight: it may be waiting on a response for the
            // account that was just replaced, and its answer must not become this one's.
            attempt++;
            lastAttempt = 0;
            code = "";
            error = "";
            last = null;
            if (store != null) store.clear();
        }
    }

    /**
     * A *replacement* connection on the same activity: invalidate the old connection's
     * state, clear its replica, and keep reconciliation running against the new one.
     *
     * This is the counterpart of {@link #reset()} for `configure`. Configuring does not
     * pause the activity, so relying on the next `onResume` to re-arm the loop left Album
     * reconciliation stopped until the user backgrounded and resumed the app — the replica
     * simply stopped converging while the app stayed in the foreground.
     *
     * The invalidation is handed to {@link ForegroundSchedule#restartAfter}, which runs it
     * *before* the new arm. Arming first would let the new connection's immediate pass be
     * invalidated by the clear that followed it, and because that pass had started, no
     * pending reconciliation would be recorded — the replacement connection would then wait
     * for the next interval instead of reconciling now.
     *
     * This deliberately does not compose `reset()` with a restart. The schedule treats
     * `stop()` as "the activity left the foreground", so resetting first would clear the
     * foregrounded state and the restart could never re-arm. Clearing the replica and
     * restarting the schedule are separate questions, and
     * {@link ForegroundSchedule#restartAfter} keeps them in the right order.
     */
    void replaceConnection() {
        schedule.restartAfter(this::clearReplica);
    }

    /**
     * Queue one pass, at most one at a time.
     *
     * Returns whether a pass was actually started, which is what lets an immediate request
     * that single-flight refused be recorded as still owed rather than silently dropped.
     *
     * `immediate` is used by resume and by a replacement connection, where waiting a full
     * interval would leave the replica stale exactly when the user is looking at it.
     * Scheduled passes keep the interval, so a slow network cannot make the client poll
     * faster than it can converge.
     */
    private boolean request(boolean immediate) {
        synchronized (gate) {
            if (syncing) return false;
            long now = SystemClock.elapsedRealtime();
            if (!immediate && lastAttempt != 0 && now - lastAttempt < INTERVAL_MILLIS) return false;
            lastAttempt = now;
            syncing = true;
        }
        worker.execute(() -> {
            try {
                pass();
            } finally {
                synchronized (gate) {
                    syncing = false;
                }
                // Start any immediate pass this schedule still owes — a resume or a
                // replacement connection whose request was refused by single-flight. Doing
                // it here is what makes that reconciliation happen as soon as the slot frees
                // instead of at the next interval.
                schedule.passFinished();
            }
        });
        return true;
    }

    // -----------------------------------------------------------------------
    // Pass
    // -----------------------------------------------------------------------

    private void pass() {
        int startedUnder;
        synchronized (gate) {
            startedUnder = attempt;
        }
        String scope;
        try {
            JSONObject connection = settings.read();
            if (!connection.has("token")) {
                // Not configured: nothing to reconcile and nothing to report as broken.
                record(startedUnder, null, null, null);
                return;
            }
            scope = scope(connection);
        } catch (Exception unreadable) {
            record(startedUnder, null, AlbumReplica.CODE_TRANSPORT, "연결 정보를 읽을 수 없습니다.");
            return;
        }
        try {
            AlbumSyncPass pass;
            synchronized (gate) {
                engine();
                pass = cycle;
            }
            AlbumSyncPass.Result completed = pass.run(scope);
            if (completed.flush.sent > 0 || completed.flush.noOp > 0) {
                // External picker collections are a published snapshot, so refresh them
                // after the server accepts a membership change. The refresh is async and
                // retains the previous snapshot if the network disappears again.
                PickerLibrary.get(context).refresh(true);
            }
            if (completed.receive == null) {
                String blocked = firstBlockedCode(scope);
                record(startedUnder, null, blocked, blocked == null ? null : message(blocked));
                return;
            }
            AlbumAuthoritySync.Result result = completed.receive;
            record(startedUnder, result, result.code,
                    result.code == null ? null : message(result.code));
        } catch (AlbumMembershipOutbox.Failure failure) {
            record(startedUnder, null, failure.code, message(failure.code));
        } catch (Exception unavailable) {
            // A replica store that cannot be opened is reported once per pass. It never
            // falls back to another database, and never touches user media.
            record(startedUnder, null, AlbumReplica.CODE_STORE_UNAVAILABLE,
                    "라이브러리 복제본을 열 수 없습니다.");
        }
    }

    /**
     * Publish what the pass learned, unless the connection changed while it ran.
     *
     * A pass can be inside a network round trip when the account is replaced, and its
     * answer then describes the account that is no longer configured. Refusing to publish
     * it is what makes "the status describes the configured connection" true, not just
     * "the rows belong to the configured connection".
     */
    private void record(int startedUnder, AlbumAuthoritySync.Result result, String failureCode,
                        String failureMessage) {
        synchronized (gate) {
            if (startedUnder != attempt) return;
            last = result;
            code = failureCode == null ? "" : failureCode;
            error = failureMessage == null ? "" : failureMessage;
        }
    }

    /** One authenticated GET over the existing native transport policy. */
    private final class Transport implements AlbumReplica.Transport, AlbumMembershipOutbox.Transport {
        @Override
        public String get(String path) throws Exception {
            try {
                return client.api(path, "GET", null, null).toString();
            } catch (CloudClient.HttpFailure failure) {
                // The rejected body is what carries the coded reason, so it is passed
                // through rather than replaced by the status.
                throw new AlbumReplica.HttpFailure(failure.status, failure.detail);
            }
        }

        @Override
        public String put(String path, String payload) throws Exception {
            try {
                // The payload is frozen in the durable outbox. Parsing only adapts it to
                // the existing authenticated client; no field is regenerated or rebased.
                return client.api(path, "PUT", new JSONObject(payload), null).toString();
            } catch (CloudClient.HttpFailure failure) {
                throw new AlbumMembershipOutbox.HttpFailure(failure.status, failure.detail);
            }
        }
    }

    /**
     * The opaque connection identity the replica is stored under.
     *
     * Derived from the endpoint and token exactly as the existing native media cache
     * scopes its entries, so one convention answers "which account does this row belong
     * to". It is a hash: neither value is stored in the replica database.
     */
    private static String scope(JSONObject connection) throws Exception {
        return ThumbnailCache.key(
                connection.getString("endpoint") + "\n" + connection.getString("token"));
    }

    // -----------------------------------------------------------------------
    // Status surface (Scope G)
    // -----------------------------------------------------------------------

    /**
     * Replica status for the native bridge.
     *
     * Read-only, and free of credentials, object keys and URLs: a diagnostic and
     * adoption surface, not a control surface. Membership commands and explicit conflict
     * resolution live on separate bridge operations. The stored identity is read back from
     * the replica rather than reported from the last pass, so a restarted process reports
     * what it actually holds.
     */
    JSONObject status() {
        try {
            JSONObject value = new JSONObject();
            value.put("syncing", syncing);
            value.put("intervalMillis", INTERVAL_MILLIS);
            value.put("code", code);
            value.put("error", error);
            AlbumReplica.Adopted authority = null;
            Map<String, Object> counters = null;
            // One scope for both answers, so the counters describe exactly the connection the
            // identity does. A replaced connection reads as unadopted with zero counts, and
            // those rows stay in the database for whichever scope owns them.
            String scope = scopeOrNull();
            synchronized (gate) {
                if (store != null) counters = store.status(scope);
                if (sync != null) authority = sync.adopted(scope);
            }
            value.put("adopted", authority != null);
            value.put("libraryId", authority == null ? JSONObject.NULL : authority.libraryId);
            value.put("epoch", authority == null ? JSONObject.NULL : authority.epoch);
            value.put("contractVersion",
                    authority == null ? JSONObject.NULL : authority.contractVersion);
            value.put("cursor", authority == null ? JSONObject.NULL : authority.cursor);
            value.put("adoptedAt", authority == null || authority.adoptedAt == null
                    ? JSONObject.NULL : authority.adoptedAt);
            value.put("lastReconciledAt", authority == null || authority.reconciledAt == null
                    ? JSONObject.NULL : authority.reconciledAt);
            value.put("albumCount", counter(counters, "albumCount"));
            value.put("albumTombstoneCount", counter(counters, "albumTombstoneCount"));
            value.put("membershipCount", counter(counters, "membershipCount"));
            value.put("membershipTombstoneCount", counter(counters, "membershipTombstoneCount"));
            value.put("outboxPendingCount", counter(counters, "outboxPendingCount"));
            value.put("outboxBlockedCount", counter(counters, "outboxBlockedCount"));
            AlbumAuthoritySync.Result result = last;
            value.put("appliedChanges", result == null ? 0 : result.appliedChanges);
            value.put("serverCursor", result == null || result.serverCursor == null
                    ? JSONObject.NULL : result.serverCursor);
            return value;
        } catch (Exception unrepresentable) {
            throw new IllegalStateException("Album replica status unavailable");
        }
    }

    private static Object counter(Map<String, Object> counters, String key) {
        if (counters == null) return 0;
        Object value = counters.get(key);
        return value == null ? 0 : value;
    }

    /**
     * The one store/engine pair for this process, opened on first use.
     *
     * Reading is why this is lazy rather than created in the constructor: the durable
     * replica must answer a read *before* any reconciliation pass has run — a restarted
     * process serves status and Album collections from the database it already holds, and
     * it must not need a network pass to do it. Caller holds {@link #gate}.
     */
    private AlbumAuthoritySync engine() {
        if (sync == null) {
            store = new LibraryReplicaStore(AndroidReplicaDb.open(context));
            Transport transport = new Transport();
            AlbumReplica.Clock clock = () -> Instant.now().toString();
            sync = new AlbumAuthoritySync(transport, store, clock);
            outbox = new AlbumMembershipOutbox(transport, store, clock);
            cycle = new AlbumSyncPass(outbox, sync);
        }
        return sync;
    }

    /**
     * The adopted Album authority identity for the configured connection, or null.
     *
     * The authority read route is addressed by `libraryId` and `epoch`, so a consumer
     * must present the identity it actually adopted rather than a remembered one. Both
     * the projection request and its cache key are derived from this single reading.
     */
    AlbumReplica.Adopted adopted() {
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) return null;
            try {
                engine();
                return sync.adopted(scope);
            } catch (RuntimeException unavailable) {
                return null;
            }
        }
    }

    /**
     * The bounded Album listing for the WebView navigation section.
     *
     * Read-only hierarchy and identity only: no membership and no media metadata, because
     * Album contents are served by the authority projection rather than shipped as a
     * client-side list. Empty when the connection has adopted nothing, so the section is
     * simply absent instead of being an empty folder tree.
     */
    JSONArray albumList() {
        try {
            JSONArray list = new JSONArray();
            Map<String, AlbumReplica.Album> live = liveAlbums();
            List<AlbumReplica.Album> rows = new ArrayList<>(live.values());
            rows.sort(Comparator.comparing((AlbumReplica.Album album) -> album.name)
                    .thenComparing(album -> album.id));
            for (AlbumReplica.Album album : rows) {
                list.put(new JSONObject()
                        .put("id", album.id)
                        .put("name", album.name)
                        .put("parentId", album.parentId == null ? JSONObject.NULL : album.parentId)
                        .put("iconKey", album.iconKey == null ? JSONObject.NULL : album.iconKey)
                        .put("colorKey", album.colorKey == null ? JSONObject.NULL : album.colorKey));
            }
            return list;
        } catch (Exception unrepresentable) {
            throw new IllegalStateException("Album listing unavailable");
        }
    }

    /** Live Album rows for the configured connection; empty when nothing is adopted. */
    Map<String, AlbumReplica.Album> liveAlbums() {
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) return Collections.emptyMap();
            try {
                engine();
                return store.albums(scope, true);
            } catch (RuntimeException unavailable) {
                return Collections.emptyMap();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Membership editor and conflict resolution (2C-3 / 2C-4)
    // -----------------------------------------------------------------------

    JSONObject membershipState(String assetId) {
        if (assetId == null || !assetId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Asset id");
        }
        synchronized (gate) {
            String scope = scopeOrNull();
            JSONObject value = new JSONObject();
            JSONArray rows = new JSONArray();
            try {
                if (scope.isEmpty()) return value.put("adopted", false).put("albums", rows);
                engine();
                AlbumReplica.Adopted authority = store.adopted(scope);
                if (authority == null) return value.put("adopted", false).put("albums", rows);
                Map<String, AlbumReplica.Album> albums = store.albums(scope, true);
                Map<String, AlbumReplica.Member> members = store.memberships(scope, false);
                List<ReplicaDb.OutboxRow> queued = store.outbox(scope);
                List<AlbumReplica.Album> ordered = new ArrayList<>(albums.values());
                ordered.sort(Comparator.comparing((AlbumReplica.Album album) -> album.name)
                        .thenComparing(album -> album.id));
                for (AlbumReplica.Album album : ordered) {
                    AlbumReplica.Member member = members.get(album.id + ":" + assetId);
                    boolean pending = false, blocked = false;
                    String conflict = null;
                    for (ReplicaDb.OutboxRow row : queued) {
                        if (!row.albumId.equals(album.id) || !row.assetId.equals(assetId)) continue;
                        if (row.blocked()) { blocked = true; if (conflict == null) conflict = row.conflictCode; }
                        else pending = true;
                    }
                    rows.put(new JSONObject()
                            .put("id", album.id)
                            .put("name", album.name)
                            .put("parentId", album.parentId == null ? JSONObject.NULL : album.parentId)
                            .put("desiredState", member != null && member.desiredState)
                            .put("pending", pending)
                            .put("blocked", blocked)
                            .put("conflictCode", conflict == null ? JSONObject.NULL : conflict));
                }
                return value.put("adopted", true)
                        .put("libraryId", authority.libraryId)
                        .put("epoch", authority.epoch)
                        .put("albums", rows);
            } catch (Exception unrepresentable) {
                throw new IllegalStateException("Album membership state unavailable");
            }
        }
    }

    JSONObject setMembership(String assetId, String albumId, boolean desiredState) {
        if (albumId == null || !albumId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Album id");
        }
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) throw new IllegalStateException("Not configured");
            engine();
            LibraryReplicaStore.MembershipEdit edit = store.queueMembership(scope, albumId, assetId,
                    desiredState, UUID.randomUUID().toString(), Instant.now().toString());
            JSONObject value = membershipState(assetId);
            if (edit.changed) request(true);
            return value;
        }
    }

    /** Resolve one durable membership conflict only after an explicit user choice. */
    JSONObject resolveMembership(String assetId, String albumId, String action) {
        if (assetId == null || !assetId.matches("[A-Za-z0-9_-]{1,128}")
                || albumId == null || !albumId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Album membership identity");
        }
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) throw new IllegalStateException("Not configured");
            engine();
            String now = Instant.now().toString();
            if ("useServerState".equals(action)) {
                store.useServerMembership(scope, albumId, assetId, now);
            } else if ("applyAgain".equals(action)) {
                store.retryBlockedMembership(scope, albumId, assetId,
                        UUID.randomUUID().toString(), now);
            } else {
                throw new IllegalArgumentException("Invalid Album conflict action");
            }
            JSONObject value = membershipState(assetId);
            request(true);
            return value;
        }
    }

    private String firstBlockedCode(String scope) {
        synchronized (gate) {
            if (store == null) return null;
            for (ReplicaDb.OutboxRow row : store.outbox(scope)) {
                if (row.blocked()) return row.conflictCode == null ? "albumWriteConflict" : row.conflictCode;
            }
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Additive Album collections (2C-2)
    // -----------------------------------------------------------------------

    /**
     * Visible Albums and live memberships for the configured connection.
     *
     * Additive by construction: unconfigured, unadopted, or replaced-connection scopes
     * all return the empty projection, and the caller's existing Classification
     * collections are then published exactly as before. Nothing here can hide a
     * Classification or Character, and no Album state is invented for a scope that does
     * not own it — the same scope rule the status surface uses. A store that cannot be
     * opened yields the empty projection rather than failing the caller's refresh.
     */
    AlbumCollections collections() {
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) return AlbumCollections.empty();
            try {
                engine();
                return AlbumCollections.build(store.albums(scope, true), store.memberships(scope, true));
            } catch (RuntimeException unavailable) {
                return AlbumCollections.empty();
            }
        }
    }

    private String scopeOrNull() {
        try {
            JSONObject connection = settings.read();
            if (!connection.has("token")) return "";
            return scope(connection);
        } catch (Exception unreadable) {
            return "";
        }
    }

    /**
     * Sanitized Korean text for the states a user could act on.
     *
     * Coded states stay distinct because they are not the same problem: an inactive
     * authority is a normal pre-cutover state and says nothing, an unsupported contract
     * needs an app update, and an authorization failure needs the connection checked.
     * No server payload, URL or credential is ever included.
     */
    private static String message(String code) {
        if (code.isEmpty() || AlbumReplica.CODE_INACTIVE.equals(code)) return "";
        switch (code) {
            case AlbumReplica.CODE_UNAUTHORIZED:
                return "서버 인증에 실패했습니다. 연결 설정을 확인해 주세요.";
            case AlbumReplica.CODE_CONTRACT_UNSUPPORTED:
                return "서버가 지원하지 않는 앨범 동기화 버전입니다. 앱 업데이트가 필요합니다.";
            case AlbumReplica.CODE_SYNC_STATUS_UNAVAILABLE:
                return "서버가 동기화 상태를 제공하지 않습니다.";
            case AlbumReplica.CODE_STORE_UNAVAILABLE:
                return "라이브러리 복제본을 열 수 없습니다.";
            case AlbumReplica.CODE_BASELINE_TOO_LARGE:
                return "앨범 기준선이 허용 크기를 초과했습니다.";
            case "revisionConflict":
            case "albumWriteConflict":
                return "앨범 변경이 다른 기기의 변경과 충돌했습니다.";
            case "epochMismatch":
            case AlbumReplica.CODE_LIBRARY_MISMATCH:
                return "앨범 권위가 변경되어 저장 대기 중인 변경을 자동 적용할 수 없습니다.";
            case AlbumMembershipOutbox.CODE_PROTOCOL_INTEGRITY:
                return "서버의 앨범 변경 응답을 확인할 수 없습니다. 변경은 저장 대기 상태로 유지됩니다.";
            default:
                return "앨범 동기화를 완료하지 못했습니다. 잠시 후 다시 시도합니다.";
        }
    }
}
