package com.lakomics.mobile;

import java.util.Map;
import java.util.concurrent.Future;

/**
 * Foreground long-poll of `/v1/sync/status?wait=50&signals=1` (PERF-ALL-001 T1).
 *
 * One request is held by the server until something this device can see changes, or for up
 * to {@link #WAIT_SECONDS}. A change answers at once, so the Library pass, the exchange screen
 * and the WebView status checks react in about a second instead of on their own timers, and
 * those timers can relax while the watcher is live.
 *
 * It runs only between {@link #start} and {@link #stop} (activity resume and pause): nothing
 * is requested while stopped, and stopping disconnects the held request. It is an
 * optimization over the domain contracts (ADR-0037), never a replacement for them:
 *
 * - a server without the `Lakomics-Status-Wait` header (older deployment) leaves the watcher
 *   dormant, so every existing poll keeps its current timing; it probes again after
 *   {@link #DORMANT_MILLIS} or on the next resume;
 * - failures back off through {@link #ERROR_DELAYS} and report not-live, which restores the
 *   regular timers;
 * - a held request the server answered at once with 304 (its waiter cap) backs off the same
 *   way instead of re-issuing in a loop.
 *
 * Deliberately free of Android classes so the state machine is checked on the plain JVM.
 */
final class StatusWatcher {
    static final int WAIT_SECONDS = 50;
    static final String WAIT_HEADER = "Lakomics-Status-Wait";
    /** A held request answered 304 faster than this was not held: the hot-loop guard. */
    static final long HOT_LOOP_MILLIS = 5_000;
    /** Requests never start closer together than this, whatever the server answers. */
    static final long MIN_SPACING_MILLIS = 1_000;
    static final long[] ERROR_DELAYS = {5_000, 15_000, 60_000};
    static final long DORMANT_MILLIS = 30 * 60_000;

    /** One status response. `capable` is whether the long-poll header was present. */
    static final class Reply {
        final int status;
        final String etag, body;
        final boolean capable;
        Reply(int status, String etag, boolean capable, String body) {
            this.status = status; this.etag = etag; this.capable = capable; this.body = body;
        }
    }

    /** One status read; `waitSeconds` 0 answers at once. Returns null when nothing is configured. */
    interface Transport { Reply get(String etag, int waitSeconds, Cancel cancel) throws Exception; }
    interface Scheduler { Future<?> after(long delayMillis, Runnable task); }
    interface Clock { long now(); }

    interface Listener {
        /** The Library part of the document or its list generation moved: run a pass now. */
        void library();
        /** Every new document, for the exchange revision it may carry. */
        void status(String body);
        /** Whether the watcher is live, for the timers that relax while it is. */
        void live(boolean live);
        /** The WebView-facing state: live with the signals document, or not live (`body` null). */
        void signals(boolean live, String body);
    }

    /** Disconnects a held request; platform-free stand-in for a cancellation signal. */
    static final class Cancel {
        private Runnable action;
        private boolean cancelled;
        void onCancel(Runnable value) {
            synchronized (this) { if (!cancelled) { action = value; return; } }
            value.run();
        }
        void cancel() {
            Runnable run;
            synchronized (this) { if (cancelled) return; cancelled = true; run = action; action = null; }
            if (run != null) run.run();
        }
    }

    private final Transport transport;
    private final Scheduler scheduler;
    private final Clock clock;
    private final Listener listener;
    /** Serializes listener calls with stop/reset so a stale reply cannot report after them. */
    private final Object notify = new Object();

    private boolean foreground, live, announced, exchange, baselineOnly, first;
    private long generation;
    private int failures;
    private Future<?> pending;
    private Cancel inFlight;
    private String etag, body, library, listGeneration, signals;

    StatusWatcher(Transport transport, Scheduler scheduler, Clock clock, Listener listener) {
        this.transport = transport; this.scheduler = scheduler; this.clock = clock; this.listener = listener;
    }

    /** An activity resumed. Idempotent. The first request answers at once to learn liveness. */
    void start() {
        synchronized (this) {
            if (foreground) return;
            foreground = true;
            first = true;
            arm(0);
        }
    }

    /** The activity paused: disconnect the held request; nothing runs until {@link #start}. */
    void stop() {
        synchronized (notify) {
            boolean wasLive;
            synchronized (this) {
                if (!foreground) return;
                foreground = false;
                wasLive = halt();
            }
            if (wasLive) listener.live(false);
        }
    }

    /** A replaced or removed connection: forget what the old one reported; re-arm if resumed. */
    void reset() {
        synchronized (notify) {
            boolean wasLive, wasAnnounced;
            synchronized (this) {
                wasLive = halt();
                wasAnnounced = announced;
                announced = false; exchange = false; failures = 0;
                etag = body = library = listGeneration = signals = null;
                if (foreground) { first = true; arm(0); }
            }
            if (wasLive) listener.live(false);
            if (wasAnnounced) listener.signals(false, null);
        }
    }

    /** The list generation the live watcher last saw, or null when the caller must read it. */
    synchronized String listGeneration() { return live ? listGeneration : null; }

    /** Whether the live watcher's document carries this device's exchange revision. */
    synchronized boolean exchangeLive() { return live && exchange; }

    /** The WebView-facing document: the last signals body while announced live, else null. */
    synchronized String announcedBody() { return announced ? body : null; }

    /** Cancel the timer and the held request. Caller holds this monitor. Returns whether it was live. */
    private boolean halt() {
        generation++;
        if (pending != null) pending.cancel(false);
        pending = null;
        Cancel held = inFlight;
        inFlight = null;
        if (held != null) held.cancel();
        boolean wasLive = live;
        live = false;
        // The first reply after a resume records a baseline: the resume pass already reconciles.
        first = true; baselineOnly = true;
        return wasLive;
    }

    /** Caller holds this monitor. */
    private void arm(long delay) {
        long armed = ++generation;
        pending = scheduler.after(Math.max(0, delay), () -> run(armed));
    }

    private void run(long armed) {
        Cancel cancel = new Cancel();
        String sent;
        int wait;
        synchronized (this) {
            if (!foreground || armed != generation) return;
            pending = null;
            inFlight = cancel;
            sent = etag;
            wait = first || sent == null ? 0 : WAIT_SECONDS;
        }
        long started = clock.now();
        Reply reply = null;
        Exception failure = null;
        try { reply = transport.get(sent, wait, cancel); } catch (Exception e) { failure = e; }
        long elapsed = clock.now() - started;
        synchronized (notify) {
            boolean wasLive, becameLive = false, moved = false, signalsMoved = false, retract = false;
            String document = null;
            synchronized (this) {
                if (!foreground || armed != generation) return;
                inFlight = null;
                wasLive = live;
                boolean hotLoop = failure == null && reply != null && reply.status == 304 && wait > 0 && elapsed < HOT_LOOP_MILLIS;
                if (failure != null || hotLoop) {
                    live = false;
                    retract = announced; announced = false;
                    // After a failure, a quick probe restores liveness; a hot loop keeps holding
                    // (and backing off) so it cannot alternate with quick successes.
                    if (failure != null) first = true;
                    arm(ERROR_DELAYS[Math.min(failures++, ERROR_DELAYS.length - 1)]);
                } else if (reply == null || !reply.capable) {
                    // Not configured, or a server without the long-poll: today's timers stay.
                    live = false;
                    retract = announced; announced = false;
                    failures = 0;
                    arm(DORMANT_MILLIS);
                } else {
                    failures = 0;
                    first = false;
                    if (reply.status != 304) {
                        document = reply.body;
                        Object parsed;
                        try { parsed = Json.parse(document); } catch (RuntimeException unreadable) { parsed = null; }
                        Map<?, ?> map = parsed instanceof Map ? (Map<?, ?>) parsed : null;
                        Object block = map == null ? null : map.get("signals");
                        Object generationValue = block instanceof Map ? ((Map<?, ?>) block).get("listGeneration") : null;
                        String nextLibrary = SyncStatusPass.libraryStatus(document);
                        String nextGeneration = generationValue instanceof String ? (String) generationValue : null;
                        String nextSignals = String.valueOf(block);
                        moved = !baselineOnly && library != null
                                && (!library.equals(nextLibrary) || !java.util.Objects.equals(listGeneration, nextGeneration));
                        signalsMoved = !nextSignals.equals(signals);
                        library = nextLibrary; listGeneration = nextGeneration; signals = nextSignals;
                        exchange = map != null && map.get("exchange") instanceof Map;
                        etag = reply.etag;
                        body = document;
                    }
                    baselineOnly = false;
                    live = true;
                    becameLive = !wasLive;
                    boolean announce = body != null && (!announced || signalsMoved);
                    announced = announced || announce;
                    signalsMoved = announce;
                    arm(Math.max(0, MIN_SPACING_MILLIS - elapsed));
                }
            }
            if (document != null) listener.status(document);
            if (moved) listener.library();
            if (becameLive) listener.live(true);
            else if (wasLive && !live) listener.live(false);
            if (signalsMoved) listener.signals(true, document != null ? document : announcedBody());
            if (retract) listener.signals(false, null);
        }
    }
}
