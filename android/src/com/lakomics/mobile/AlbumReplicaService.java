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
 * resume, then backs off from five seconds to one minute while unchanged. Local work
 * and detected changes reset the delay. Polling stops as soon as the app is paused.
 * No wake lock is taken and no WorkManager job is scheduled: metadata convergence is not worth keeping the
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
    /** The status read made with the device exchange token, with its own ETag cache. */
    private final CloudClient exchangeStatus;
    private volatile String refusedStatusToken="";
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
    private final ThreadLocal<SyncStatusPass> statusPass=new ThreadLocal<>();
    private String previousStatus;
    private boolean passChanged;
    private long lastGenerationCheck;
    private volatile java.util.function.Consumer<String> generationListener;
    void setListGenerationListener(java.util.function.Consumer<String> listener){generationListener=listener;}
    /** Receives `lakomics-sync-signals` details ({live, signals}) for the WebView. */
    private volatile java.util.function.Consumer<JSONObject> signalsListener;
    void setSignalsListener(java.util.function.Consumer<JSONObject> listener){signalsListener=listener;}
    private final ScheduledExecutorService watchThread = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "lakomics-status-watch");
        thread.setDaemon(true);
        return thread;
    });
    private final java.util.concurrent.ExecutorService watchCancel = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "lakomics-status-cancel");
        thread.setDaemon(true);
        return thread;
    });
    /**
     * The foreground status long-poll (PERF-ALL-001 T1): wakes a pass on a Library change,
     * forwards the exchange revision, and reports the signals the WebView checks. Started and
     * stopped with {@link #schedule}, so it never runs while the app is paused.
     */
    private final StatusWatcher watcher = new StatusWatcher(this::watchStatus,
            (delay, task) -> watchThread.schedule(task, delay, TimeUnit.MILLISECONDS),
            SystemClock::elapsedRealtime, new StatusWatcher.Listener() {
                @Override public void library() { schedule.wake(); }
                @Override public void status(String body) {
                    ExchangeService exchange = ExchangeService.get(context);
                    exchange.observeStatus(body);
                    exchange.setStatusLive(watcher.exchangeLive());
                }
                @Override public void live(boolean live) {
                    schedule.setLive(live);
                    ExchangeService.get(context).setStatusLive(live && watcher.exchangeLive());
                }
                @Override public void signals(boolean live, String body) {
                    JSONObject detail = signalsDetail(live, body);
                    java.util.function.Consumer<JSONObject> listener = signalsListener;
                    if (detail != null && listener != null) listener.accept(detail);
                }
            });
    private void localWork(){
        // A user write may finish entering the outbox just after onPause. Deliver that
        // intent once even when the repeating foreground schedule is disarmed.
        worker.execute(()->{schedule.wake();request(true);});
    }
    private void wrote(String path){SyncStatusPass pass=statusPass.get();if(pass!=null){pass.wrote(path);passChanged=true;}}
    private boolean canSkipUnchangedFeed(String domain) {
        SyncStatusPass pass=statusPass.get();
        return pass!=null && pass.canSkipUnchangedFeed(domain);
    }
    private String readForPass(String path)throws Exception{
        SyncStatusPass pass=statusPass.get();
        return pass==null?client.conditionalApi(path,null).toString():pass.get(path);
    }

    private LibraryReplicaStore store;
    private AlbumAuthoritySync sync;
    private AlbumMembershipOutbox outbox;
    private AlbumSyncPass cycle;
    private ClassificationAuthoritySync classification;
    private ClassificationAssignmentOutbox classificationWriter;
    private ClassificationSyncPass classificationCycle;
    /** Library Trash writer (trash/restore only); flushed at the head of the Asset read lane. */
    private AssetLifecycleOutbox lifecycleWriter;
    private volatile String lifecycleCode = "";
    private long lastAttempt;
    private volatile boolean syncing;
    private volatile String code = "";
    private volatile String error = "";
    private volatile AlbumAuthoritySync.Result last;
    private volatile ClassificationAuthoritySync.Result lastClassification;
    private volatile String classificationCode = "";

    private AlbumReplicaService(Context context) {
        this.context = context.getApplicationContext();
        this.settings = new SecureSettings(this.context);
        this.client = new CloudClient(settings);
        this.exchangeStatus = new CloudClient(settings);
    }

    /** The one repeating task, cancelled by {@link #schedule} so no timer outlives a pause. */
    private java.util.concurrent.ScheduledFuture<?> afterInterval(Runnable task, long interval) {
        return worker.scheduleWithFixedDelay(task, interval, interval, TimeUnit.MILLISECONDS);
    }

    /** Begin foreground polling, reconciling immediately. Idempotent. */
    void start() {
        java.util.function.Consumer<String> listener=generationListener;
        if(listener!=null&&assetListGeneration!=null&&!assetListGeneration.isEmpty())listener.accept(assetListGeneration);
        schedule.start();
        synchronized (network) {
            resumed = true;
            if (online) watcher.start();
        }
    }

    /** Stop polling. The replica, its cursor and its rows stay durable across this. */
    void stop() {
        schedule.stop();
        synchronized (network) {
            resumed = false;
            watcher.stop();
        }
    }

    /** Guards {@link #resumed} and {@link #online}. Never taken while holding the schedule's gate (order: this, then watcher, then schedule). */
    private final Object network = new Object();
    private boolean resumed, online = true;

    /**
     * The default network changed (foreground only; see {@link DeviceSignals}).
     *
     * Offline, the pass and the status long-poll are suspended instead of failing and backing
     * off. Back online they run at once. `restored` means a validated network appeared that
     * was not the last one seen validated (reconnect or a switch, e.g. Wi-Fi to another
     * network): the held long-poll may sit on a dead socket, so it is reopened, and queued
     * outbox intents are delivered by an immediate pass.
     */
    void networkChanged(boolean isOnline, boolean restored) {
        boolean armedNow = schedule.setOnline(isOnline);
        synchronized (network) {
            online = isOnline;
            if (!isOnline) { watcher.stop(); return; }
            if (!resumed) return;
            if (restored) watcher.stop();
            watcher.start();
        }
        // Coming back online already armed with an immediate pass; a switch between two
        // live networks still owes one for anything queued while the old link was dying.
        if (restored && !armedNow) schedule.wake();
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
        // Forget what the removed connection reported; while resumed it probes (and, with no
        // connection, stays dormant) so a later configure is watched again.
        watcher.reset();
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
            previousStatus=null;lastGenerationCheck=0;assetListGeneration="";client.clearConditional();exchangeStatus.clearConditional();refusedStatusToken="";
            code = "";
            error = "";
            last = null;
            lastClassification = null;
            classificationCode = "";
            if (store != null) {
                // Each domain is cleared explicitly and atomically. Clearing means nothing
                // from the replaced connection is left behind; the stored scope is the second,
                // independent protection for anything a race leaves in place.
                store.clear();
                store.clearClassifications();
                store.clearAssets();
            }
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
        watcher.reset();
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
                statusPass.remove();
                synchronized (gate) {
                    syncing = false;
                }
                // Start any immediate pass this schedule still owes — a resume or a
                // replacement connection whose request was refused by single-flight. Doing
                // it here is what makes that reconciliation happen as soon as the slot frees
                // instead of at the next interval.
                schedule.passFinished(passChanged);
            }
        });
        return true;
    }

    // -----------------------------------------------------------------------
    // Pass
    // -----------------------------------------------------------------------

    private void pass() {
        passChanged=false;
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
            statusPass.set(new SyncStatusPass(path->{
                String value=path.equals("/v1/sync/status")?readStatus(connection):client.conditionalApiFor(connection,path,null).toString();
                if(path.equals("/v1/sync/status")){
                    boolean current;
                    synchronized(gate){current=startedUnder==attempt;if(current){
                        String library=SyncStatusPass.libraryStatus(value);
                        if(!library.equals(previousStatus))passChanged=true;
                        previousStatus=library;
                    }}
                    // File exchange arrivals ride on this read instead of a poll of their own.
                    if(current)ExchangeService.get(context).observeStatus(value);
                }
                return value;
            }));

        } catch (Exception unreadable) {
            record(startedUnder, null, AlbumReplica.CODE_TRANSPORT, "연결 정보를 읽을 수 없습니다.");
            return;
        }
        try {
            // Both authority domains are attempted through one orchestrator whose lane
            // boundaries are independent, so an Album delivery failure can no longer skip
            // Classification for the cycle. The lane that fails reports its own code; the
            // healthy lane still converges.
            // Asset reads and list generation remain independent of either write lane.
            try {
                AssetReplica asset;
                AssetLifecycleOutbox lifecycle;
                synchronized(gate){engine();asset=store.assetReplica(new Transport(), () -> canSkipUnchangedFeed("assets"));lifecycle=lifecycleWriter;}
                // Library Trash intents are delivered before the lifecycle catch-up, so an
                // accepted trash/restore arrives in the same pass's receive. A delivery
                // failure keeps its rows and never skips the read.
                try{lifecycle.flush(scope);lifecycleCode="";}
                catch(AssetLifecycleOutbox.Failure failure){lifecycleCode=failure.code;}
                catch(RuntimeException failure){lifecycleCode=AlbumReplica.CODE_STORE_UNAVAILABLE;}
                if(asset.sync(scope))passChanged=true;
            }catch(Exception unavailable){/* A failed read lane retries next foreground pass. */}
            AuthorityPass.Outcome outcome = AuthorityPass.run(
                    () -> albumLane(scope),
                    () -> classificationLane(scope));
            if (outcome.album != null) {
                publishAlbum(startedUnder, outcome.album.result, outcome.album.code);
            }
            if (outcome.classification != null) {
                publishClassification(startedUnder, outcome.classification.result,
                        outcome.classification.code);
            }
        } catch (Exception unavailable) {
            // The orchestrator already contains each lane's own failure; reaching here means
            // the pass could not be set up at all.
            record(startedUnder, null, AlbumReplica.CODE_STORE_UNAVAILABLE,
                    "라이브러리 복제본을 열 수 없습니다.");
        }
        // This signal also covers legacy Classification snapshots, Character publication,
        // and Asset row metadata that does not advance an authority cursor. Keep its
        // minute fallback independent of receive-lane failures and run after local writes.
        refreshListGeneration(startedUnder);
    }

    /**
     * The status document, read with this device's exchange token when it has one.
     *
     * The server reports `exchange.revision` only to a device credential, never to the shared
     * Library token, while the domain list is the same for every client. Reading the one
     * status document with the device token therefore adds the exchange signal without an
     * extra request. A refused device token falls back to the Library token, so a revoked or
     * mistyped exchange token can never stall Library sync.
     */
    private String readStatus(JSONObject connection) throws Exception {
        JSONObject device=null;
        try{device=ExchangeService.get(context).statusConnection(connection);}catch(Exception unreadable){/* Library token below. */}
        String key=device==null?"":ThumbnailCache.key(device.optString("endpoint")+"\n"+device.optString("token"));
        if(device!=null&&!key.equals(refusedStatusToken)){
            // Its own conditional cache: sharing the Library one would clear both scopes'
            // ETags on every switch between the two tokens.
            try{return exchangeStatus.conditionalApiFor(device,"/v1/sync/status",null).toString();}
            catch(CloudClient.HttpFailure refused){
                if(refused.status!=401&&refused.status!=403)throw refused;
                // Not tried again until the stored device token changes.
                refusedStatusToken=key;
            }
        }
        return client.conditionalApiFor(connection,"/v1/sync/status",null).toString();
    }

    /**
     * One long-poll read for {@link #watcher}, with the credential {@link #readStatus} uses: the
     * device exchange token when stored and not refused (so `exchange.revision` rides along),
     * else the Library token. Null when no connection is configured.
     */
    private StatusWatcher.Reply watchStatus(String etag,int wait,StatusWatcher.Cancel cancel) throws Exception {
        JSONObject connection=settings.read();
        if(!connection.has("token"))return null;
        android.os.CancellationSignal signal=new android.os.CancellationSignal();
        // A pause cancels from the main thread; closing the held socket there could count as
        // network work on the main thread, so the disconnect runs on its own thread.
        cancel.onCancel(()->watchCancel.execute(signal::cancel));
        JSONObject device=null;
        try{device=ExchangeService.get(context).statusConnection(connection);}catch(Exception unreadable){/* Library token below. */}
        String key=device==null?"":ThumbnailCache.key(device.optString("endpoint")+"\n"+device.optString("token"));
        if(device!=null&&!key.equals(refusedStatusToken)){
            try{return client.longPollStatus(device,etag,wait,signal);}
            catch(CloudClient.HttpFailure refused){
                if(refused.status!=401&&refused.status!=403)throw refused;
                refusedStatusToken=key;
            }
        }
        return client.longPollStatus(connection,etag,wait,signal);
    }

    /** The `lakomics-sync-signals` detail: `{live, signals}`; signals is null when not live. */
    private static JSONObject signalsDetail(boolean live,String body) {
        try {
            JSONObject signals=live&&body!=null?new JSONObject(body).optJSONObject("signals"):null;
            return new JSONObject().put("live",signals!=null).put("signals",signals==null?JSONObject.NULL:signals);
        } catch(Exception unreadable) { return null; }
    }

    /** The current signals state, for a page that loaded after the last report. */
    JSONObject syncSignals() {
        JSONObject detail=signalsDetail(true,watcher.announcedBody());
        if(detail==null)throw new IllegalStateException("Sync signals unavailable");
        return detail;
    }

    private void refreshListGeneration(int startedUnder) {
        String generation=assetListGeneration;
        long now=SystemClock.elapsedRealtime();
        // While the status long-poll is live its `signals.listGeneration` is current (a move
        // wakes this pass), so the minute read of `/v1/library/list-generation` is not needed.
        String watched=watcher.listGeneration();
        if(watched!=null) {
            generation=watched;
            synchronized(gate){if(startedUnder==attempt)lastGenerationCheck=now;}
        } else if(passChanged || lastGenerationCheck==0 || now-lastGenerationCheck>=60_000) {
            try {
                generation=CloudClient.listGeneration(client,null,null);
                synchronized(gate){if(startedUnder==attempt)lastGenerationCheck=now;}
            } catch(Exception unavailable) { /* Retry without blocking successful replicas. */ }
        }
        synchronized(gate) {
            boolean generationChanged=generation!=null&&!generation.equals(assetListGeneration);
            if(startedUnder==attempt && (passChanged || generationChanged)) {
                passChanged=true;assetListGeneration=generation;
                java.util.function.Consumer<String> listener=generationListener;
                if(generationChanged && listener!=null)listener.accept(generation);
                LibraryDocumentsProvider.invalidateMetadata(context);
                PickerLibrary.get(context).refresh(true);
            }
        }
    }

    /**
     * The Album lane: deliver queued membership intents, then catch up.
     *
     * A lane body returns a report rather than throwing for "no receive happened", because
     * an unclean queue is a legitimate outcome of this lane, not a failure of it. Only a real
     * delivery failure leaves through {@link AlbumMembershipOutbox.Failure}.
     */
    private AuthorityPass.AlbumReport albumLane(String scope)
            throws AlbumMembershipOutbox.Failure {
        AlbumSyncPass pass;
        synchronized (gate) {
            engine();
            pass = cycle;
        }
        AlbumSyncPass.Result completed = pass.run(scope);
        if(completed.receive!=null&&(completed.receive.appliedChanges>0||completed.receive.adoptedBaseline))passChanged=true;
        if (completed.flush.sent > 0 || completed.flush.noOp > 0) {
            // External picker collections are a published snapshot, so refresh them after
            // the server accepts a membership change. The refresh is async and retains the
            // previous snapshot if the network disappears again.
            PickerLibrary.get(context).refresh(true);
        }
        if (completed.receive == null) {
            // The queue is not clean, so no receive happened. The blocked code is the state
            // the user has to act on; a healthy queue with no receive reports no code.
            return new AuthorityPass.AlbumReport(null, firstBlockedCode(scope));
        }
        return new AuthorityPass.AlbumReport(completed.receive, completed.receive.code);
    }

    /** The Classification lane: flush assignment intents, then receive or adopt. */
    private AuthorityPass.ClassificationReport classificationLane(String scope)
            throws ClassificationAssignmentOutbox.Failure {
        ClassificationSyncPass pass;
        synchronized (gate) {
            engine();
            pass = classificationCycle;
        }
        if (pass == null) return null;
        ClassificationSyncPass.Result completed = pass.run(scope);
        if(completed.receive!=null&&(completed.receive.appliedChanges>0||completed.receive.adoptedBaseline))passChanged=true;
        // A durable blocked conflict outranks the receive code, because it is the state the
        // user has to act on: the receive may then report a perfectly healthy domain that
        // says nothing about the intent still waiting for a decision.
        String blocked = firstClassificationBlockedCode(scope);
        return new AuthorityPass.ClassificationReport(completed.receive,
                blocked != null ? blocked
                        : completed.receive == null ? null : completed.receive.code);
    }

    /**
     * Publish what the Album lane learned, unless the connection changed while it ran.
     *
     * A pass can be inside a network round trip when the account is replaced, and its answer
     * then describes the account that is no longer configured. Refusing to publish it is what
     * makes "the status describes the configured connection" true, not just "the rows belong
     * to the configured connection".
     *
     * The result is assigned unconditionally so a pass that produced no receive result clears
     * the previous one, which is the reporting this surface already had. Classification
     * deliberately does the opposite (see {@link #publishClassification}), and the asymmetry
     * is pre-existing rather than an oversight.
     */
    private void publishAlbum(int startedUnder, AlbumAuthoritySync.Result result,
                              String failureCode) {
        synchronized (gate) {
            if (startedUnder != attempt) return;
            last = result;
            code = failureCode == null ? "" : failureCode;
            error = failureCode == null ? "" : message(failureCode);
        }
    }

    /**
     * Publish what the Classification lane learned, unless the connection changed.
     *
     * An explicit failure code outranks the receive's own code, so a durable conflict or a
     * write failure is never masked by a healthy receive result. The lane reports its own
     * code, so a healthy Classification pass still publishes over a failed Album pass.
     */
    private void publishClassification(int startedUnder, ClassificationAuthoritySync.Result result,
                                       String failureCode) {
        synchronized (gate) {
            if (startedUnder != attempt) return;
            if (result != null) lastClassification = result;
            classificationCode = failureCode == null ? "" : failureCode;
        }
    }

    /**
     * Record the pass-level failure when neither lane could even be set up.
     *
     * Only used before a lane reports, so it cannot mask a lane's own result.
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

    /** The coded state of the oldest blocked Classification assignment intent, or null. */
    private String firstClassificationBlockedCode(String scope) {
        synchronized (gate) {
            if (store == null) return null;
            return AuthorityPass.classificationBlockedCode(store.classificationOutbox(scope));
        }
    }

    /**
     * The Classification read transport.
     *
     * GET only, by construction: this class exposes no write operation, so no Classification
     * mutation can be issued through the read replica even by accident.
     */
    private final class ClassificationTransport implements ClassificationReplica.Transport {
        @Override
        public String get(String path) throws Exception {
            try {
                return readForPass(path);
            } catch (CloudClient.HttpFailure failure) {
                throw new ClassificationReplica.HttpFailure(failure.status, failure.detail);
            }
        }
    }

    /**
     * The Classification assignment write transport.
     *
     * PUT to one route only. The path is not a parameter of any caller-visible operation:
     * {@link ClassificationAssignmentOutbox#COMMAND_PATH} is what the writer passes, and
     * `NetworkPolicy` independently refuses every other Classification write method and path,
     * so the narrow surface is enforced twice rather than assumed.
     */
    private final class WriteTransport implements ClassificationAssignmentOutbox.Transport {
        @Override
        public String put(String path, String payload) throws Exception {
            try {
                // The payload is frozen in the durable outbox. Parsing it only adapts it to
                // the existing authenticated client; no field is regenerated or rebased.
                String reply=client.api(path, "PUT", new JSONObject(payload), null).toString();
                wrote(path);return reply;
            } catch (CloudClient.HttpFailure failure) {
                throw new ClassificationAssignmentOutbox.HttpFailure(failure.status,
                        failure.detail);
            }
        }
    }

    /** The Library Trash write transport: PUT to the lifecycle command route only. */
    private final class LifecycleTransport implements AssetLifecycleOutbox.Transport {
        @Override
        public String put(String path, String payload) throws Exception {
            try {
                // The payload is frozen in the durable outbox; it is only adapted here.
                String reply=client.api(path, "PUT", new JSONObject(payload), null).toString();
                wrote(path);return reply;
            } catch (CloudClient.HttpFailure failure) {
                throw new AssetLifecycleOutbox.HttpFailure(failure.status, failure.detail);
            }
        }
    }

    /** One authenticated GET over the existing native transport policy. */
    private final class Transport implements AlbumReplica.Transport, AlbumMembershipOutbox.Transport {
        @Override
        public String get(String path) throws Exception {
            try {
                return readForPass(path);
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
                String reply=client.api(path, "PUT", new JSONObject(payload), null).toString();
                wrote(path);return reply;
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
            // The Classification read replica is reported separately, because it is a
            // different domain with its own adoption row and cursor. These keys are additive:
            // nothing above changes meaning.
            ClassificationReplica.Adopted classifications = null;
            Map<String, Object> classificationCounters = null;
            synchronized (gate) {
                if (store != null) classificationCounters = store.classificationStatus(scope);
                if (classification != null) classifications = classification.adopted(scope);
            }
            value.put("classificationAdopted", classifications != null);
            value.put("classificationLibraryId",
                    classifications == null ? JSONObject.NULL : classifications.libraryId);
            value.put("classificationEpoch",
                    classifications == null ? JSONObject.NULL : classifications.epoch);
            value.put("classificationCursor",
                    classifications == null ? JSONObject.NULL : classifications.cursor);
            value.put("classificationCode", classificationCode);
            value.put("classificationError", classificationMessage(classificationCode));
            value.put("classificationCount", counter(classificationCounters, "classificationCount"));
            value.put("classificationTombstoneCount",
                    counter(classificationCounters, "classificationTombstoneCount"));
            value.put("assignmentCount", counter(classificationCounters, "assignmentCount"));
            value.put("assignmentTombstoneCount",
                    counter(classificationCounters, "assignmentTombstoneCount"));
            value.put("classificationOutboxPendingCount",
                    counter(classificationCounters, "classificationOutboxPendingCount"));
            value.put("classificationOutboxBlockedCount",
                    counter(classificationCounters, "classificationOutboxBlockedCount"));
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
    private volatile String assetListGeneration="";

    private AlbumAuthoritySync engine() {
        if (sync == null) {
            store = new LibraryReplicaStore(AndroidReplicaDb.open(context));
            Transport transport = new Transport();
            AlbumReplica.Clock clock = () -> Instant.now().toString();
            sync = new AlbumAuthoritySync(transport, store, clock, () -> canSkipUnchangedFeed("albums"));
            outbox = new AlbumMembershipOutbox(transport, store, clock);
            cycle = new AlbumSyncPass(outbox, sync);
            // The Classification domain shares this store and transport but keeps its own
            // authority row, cursor and lifecycle. Its write surface is the one assignment
            // command: the same transport is reused, and the writer constructs the command
            // so no caller-supplied payload can reach the authority.
            ClassificationTransport classificationTransport = new ClassificationTransport();
            classification = new ClassificationAuthoritySync(classificationTransport, store,
                    () -> Instant.now().toString(), () -> canSkipUnchangedFeed("classifications"));
            classificationWriter = new ClassificationAssignmentOutbox(new WriteTransport(), store,
                    () -> Instant.now().toString());
            classificationCycle = new ClassificationSyncPass(classificationWriter, classification);
            lifecycleWriter = store.assetLifecycle(new LifecycleTransport());
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
            if (edit.changed) localWork();
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
            localWork();
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
    // Single-Asset Classification editor (v5)
    // -----------------------------------------------------------------------

    /**
     * One Asset's Classification assignment plus the live hierarchy the editor renders.
     *
     * Read-only. The hierarchy is the adopted live replica, so a tombstoned Classification
     * cannot be offered as a destination, and the value is the *visible* assignment —
     * composed from the confirmed lineage plus this Asset's queued intents — so a pending
     * choice is what the dialog shows.
     */
    JSONObject classificationAssignmentState(String assetId) {
        if (assetId == null || !assetId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Asset id");
        }
        synchronized (gate) {
            String scope = scopeOrNull();
            JSONObject value = new JSONObject();
            JSONArray rows = new JSONArray();
            try {
                if (scope.isEmpty()) return value.put("adopted", false).put("classifications", rows);
                engine();
                ClassificationReplica.Adopted authority = store.classificationAdopted(scope);
                if (authority == null) {
                    return value.put("adopted", false).put("classifications", rows);
                }
                LibraryReplicaStore.AssignmentState assignment =
                        store.classificationAssignment(scope, assetId);
                Map<String, ClassificationReplica.Node> nodes = store.classificationNodes(scope, true);
                List<ClassificationReplica.Node> ordered = new ArrayList<>(nodes.values());
                ordered.sort(Comparator.comparing((ClassificationReplica.Node node) -> node.name)
                        .thenComparing(node -> node.id));
                for (ClassificationReplica.Node node : ordered) {
                    rows.put(new JSONObject()
                            .put("id", node.id)
                            .put("kind", node.kind)
                            .put("name", node.name)
                            .put("parentId", node.parentId == null ? JSONObject.NULL : node.parentId)
                            .put("iconKey", node.iconKey == null ? JSONObject.NULL : node.iconKey)
                            .put("colorKey", node.colorKey == null ? JSONObject.NULL : node.colorKey));
                }
                String conflict = assignment == null || assignment.conflictCode == null
                        ? null : assignment.conflictCode;
                return value.put("adopted", true)
                        .put("assetId", assetId)
                        .put("classificationId", assignment == null || assignment.classificationId == null
                                ? JSONObject.NULL : assignment.classificationId)
                        .put("pending", assignment != null && assignment.pending)
                        .put("blocked", assignment != null && assignment.blocked)
                        .put("conflictCode", conflict == null ? JSONObject.NULL : conflict)
                        .put("conflictMessage", conflict == null ? "" : classificationMessage(conflict))
                        .put("libraryId", authority.libraryId)
                        .put("epoch", authority.epoch)
                        .put("classifications", rows);
            } catch (Exception unrepresentable) {
                throw new IllegalStateException("Classification assignment state unavailable");
            }
        }
    }

    /**
     * Set one Asset's Classification, or clear it with a null id.
     *
     * The enqueue is durable before this returns, so a WebView that sees success can rely on
     * the intent surviving process death. The requested Classification is validated against
     * the adopted live replica — a tombstoned id is gone rather than empty — and the protected
     * `originals` role is deliberately allowed: the authority protects it from
     * rename/move/delete only, and assignment to it is an ordinary operation.
     */
    JSONObject setClassificationAssignment(String assetId, String classificationId) {
        if (assetId == null || !assetId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Asset id");
        }
        if (classificationId != null && !classificationId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("Invalid Classification id");
        }
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) throw new IllegalStateException("Not configured");
            engine();
            LibraryReplicaStore.AssignmentEdit edit = store.queueClassificationAssignment(scope,
                    assetId, classificationId, UUID.randomUUID().toString(),
                    Instant.now().toString());
            JSONObject value = classificationAssignmentState(assetId);
            if (edit.changed) localWork();
            return value;
        }
    }

    // -----------------------------------------------------------------------
    // Library Trash (mobile): trash / restore intents
    // -----------------------------------------------------------------------

    /**
     * Queued Library Trash intents for the web client's overlay.
     *
     * `available` is false until the lifecycle replica is adopted, which is what gives an
     * intent its authority identity; the web hides the trash action until then. Each item
     * says what the user asked for and where it is: `pending`/`sending` (이동 대기 / 복원
     * 대기), `blocked` (a conflict to show) or `dropped` (영구 삭제됨).
     */
    JSONObject assetLifecycleState() {
        synchronized (gate) {
            try {
                JSONObject value = new JSONObject().put("code", lifecycleCode);
                JSONArray items = new JSONArray();
                String scope = scopeOrNull();
                if (scope.isEmpty()) return value.put("available", false).put("items", items);
                engine();
                AssetReplica.Header adopted = store.assetHeader(scope);
                value.put("available", adopted != null);
                for (AssetLifecycleOutbox.Row row : lifecycleWriter.rows()) {
                    items.put(new JSONObject()
                            .put("assetId", row.assetId)
                            .put("command", AssetLifecycleOutbox.TRASH.equals(row.commandType) ? "trash" : "restore")
                            .put("state", row.state)
                            .put("conflictCode", row.conflictCode == null ? JSONObject.NULL : row.conflictCode)
                            .put("createdAt", row.createdAt));
                }
                return value.put("items", items);
            } catch (Exception unavailable) {
                throw new IllegalStateException("Library Trash state unavailable");
            }
        }
    }

    /**
     * Move one Asset to the Library Trash or restore it; `command` is `trash` or `restore`.
     *
     * The intent is durable before this returns. Undo is the inverse command: a still-pending
     * intent is cancelled locally, otherwise the inverse is queued behind it. The native
     * layer owns every protocol field; the web supplies only the Asset, the command and the
     * lifecycle revision it saw (0 when unknown).
     */
    JSONObject setAssetLifecycle(String assetId, String command, long seenRevision) {
        String commandType = "trash".equals(command) ? AssetLifecycleOutbox.TRASH
                : "restore".equals(command) ? AssetLifecycleOutbox.RESTORE : null;
        if (commandType == null) throw new IllegalArgumentException("Invalid lifecycle command");
        if (seenRevision < 0) throw new IllegalArgumentException("Invalid revision");
        synchronized (gate) {
            String scope = scopeOrNull();
            if (scope.isEmpty()) throw new IllegalStateException("Not configured");
            engine();
            AssetLifecycleOutbox.Edit edit = lifecycleWriter.queue(scope, assetId, commandType,
                    seenRevision, UUID.randomUUID().toString(), Instant.now().toString());
            JSONObject value = assetLifecycleState();
            try {
                value.put("cancelled", edit.cancelled).put("tombstoned", edit.tombstoned);
            } catch (Exception unrepresentable) {
                throw new IllegalStateException("Library Trash state unavailable");
            }
            if (edit.row != null) localWork();
            return value;
        }
    }

    /** Acknowledge a blocked or dropped outcome for one Asset. */
    JSONObject dismissAssetLifecycle(String assetId) {
        synchronized (gate) {
            if (scopeOrNull().isEmpty()) throw new IllegalStateException("Not configured");
            engine();
            lifecycleWriter.dismiss(assetId);
            return assetLifecycleState();
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

    /**
     * Sanitized Korean text for the Classification domain's own states.
     *
     * Separate from {@link #message} because the domains differ: a Classification contract
     * failure is not an Album one, and reporting a domain's state under the other domain's
     * wording would tell the user to act on the wrong problem.
     */
    private static String classificationMessage(String code) {
        if (code.isEmpty() || ClassificationReplica.CODE_INACTIVE.equals(code)) return "";
        switch (code) {
            case ClassificationReplica.CODE_UNAUTHORIZED:
                return "서버 인증에 실패했습니다. 연결 설정을 확인해 주세요.";
            case ClassificationReplica.CODE_CONTRACT_UNSUPPORTED:
                return "서버가 지원하지 않는 분류 동기화 버전입니다. 앱 업데이트가 필요합니다.";
            case ClassificationReplica.CODE_STORE_UNAVAILABLE:
                return "라이브러리 복제본을 열 수 없습니다.";
            case ClassificationReplica.CODE_LIBRARY_MISMATCH:
            case "epochMismatch":
                return "분류 권위가 변경되어 저장 대기 중인 변경을 자동 적용할 수 없습니다.";
            case "classificationNotFound":
            case "classificationWriteConflict":
                return "분류 변경을 적용할 수 없습니다. 분류가 삭제되었는지 확인해 주세요.";
            case ClassificationAssignmentOutbox.CODE_PROTOCOL_INTEGRITY:
                return "서버의 분류 변경 응답을 확인할 수 없습니다. 변경은 저장 대기 상태로 유지됩니다.";
            default:
                return "분류 동기화를 완료하지 못했습니다. 잠시 후 다시 시도합니다.";
        }
    }
}
