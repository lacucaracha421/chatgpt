package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Delayed;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * PERF-ALL-001 T1: the foreground status long-poll, on the plain JVM.
 *
 * The scheduler records every armed task and the checks run them by hand, and the fake
 * server advances a fake clock by however long it "held" the request, so an hour of
 * foreground idling is simulated deterministically.
 */
public final class StatusWatcherTest {
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

    private static final class Task {
        final long delay;
        final Runnable run;
        boolean cancelled;
        Task(long delay, Runnable run) { this.delay = delay; this.run = run; }
    }

    /** Server state, recorded requests and listener events. */
    private static final class Fixture implements StatusWatcher.Transport, StatusWatcher.Scheduler, StatusWatcher.Listener {
        final List<Task> tasks = new ArrayList<>();
        final List<String> requests = new ArrayList<>();
        final List<String> events = new ArrayList<>();
        final List<StatusWatcher.Cancel> cancels = new ArrayList<>();
        long now;
        int cursor = 1, notes = 1, exchange = 1;
        String generation = "g1";
        boolean capable = true, configured = true, fail, overCap;
        /** How long an unchanged held request is held; 0 answers at once. */
        long hold = 50_000;
        final StatusWatcher watcher = new StatusWatcher(this, this, () -> now, this);

        String document() {
            return "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"lib\",\"domains\":[{\"domain\":\"albums\",\"cursor\":" + cursor + "}],"
                    + "\"exchange\":{\"revision\":" + exchange + "},"
                    + "\"signals\":{\"listGeneration\":\"" + generation + "\",\"notes\":" + notes + ",\"collections\":{\"revision\":\"r1\"}}}";
        }

        @Override public StatusWatcher.Reply get(String etag, int wait, StatusWatcher.Cancel cancel) throws Exception {
            requests.add("wait=" + wait + (etag == null ? "" : " etag"));
            cancels.add(cancel);
            if (!configured) return null;
            if (fail) { now += 100; throw new java.io.IOException("offline"); }
            String body = document();
            String tag = Integer.toHexString(body.hashCode());
            if (!tag.equals(etag)) { now += 100; return new StatusWatcher.Reply(200, tag, capable, body); }
            if (wait > 0 && !overCap) now += hold; else now += 100;
            return new StatusWatcher.Reply(304, tag, capable, null);
        }

        @Override public Future<?> after(long delay, Runnable run) {
            Task task = new Task(delay, run);
            tasks.add(task);
            return new Handle(task);
        }

        @Override public void library() { events.add("library"); }
        @Override public void status(String body) { events.add("status"); }
        @Override public void live(boolean live) { events.add("live=" + live); }
        @Override public void signals(boolean live, String body) {
            events.add("signals=" + live);
            check(live == (body != null), "A live signals report carries the document; a retraction does not");
        }

        /** Runs the newest armed task, advancing the clock by its delay. */
        long step() {
            Task task = tasks.get(tasks.size() - 1);
            check(!task.cancelled, "The newest task is armed");
            now += task.delay;
            task.run.run();
            return task.delay;
        }

        long lastDelay() { return tasks.get(tasks.size() - 1).delay; }
        void clear() { requests.clear(); events.clear(); }
    }

    private static final class Handle implements ScheduledFuture<Object> {
        private final Task task;
        Handle(Task task) { this.task = task; }
        @Override public boolean cancel(boolean interrupt) { task.cancelled = true; return true; }
        @Override public boolean isCancelled() { return task.cancelled; }
        @Override public boolean isDone() { return false; }
        @Override public Object get() { throw new UnsupportedOperationException(); }
        @Override public Object get(long timeout, TimeUnit unit) { throw new UnsupportedOperationException(); }
        @Override public long getDelay(TimeUnit unit) { return 0; }
        @Override public int compareTo(Delayed other) { return 0; }
    }

    public static void main(String[] args) {
        libraryStatusIgnoresAdditiveBlocks();
        foregroundOnly();
        changesAreRoutedByPart();
        olderServerStaysDormant();
        errorsBackOffAndProbeQuickly();
        hotLoopGuard();
        resetForgetsTheConnection();
        idleForegroundHour();
        scheduleRelaxesOnlyWhileLive();
        System.out.println("StatusWatcherTest passed: " + checks
                + " checks (trap fix, foreground-only, routing, dormant, backoff, hot loop, hour budget)");
    }

    /** The tablet trap: only Library fields may mark a pass changed. */
    private static void libraryStatusIgnoresAdditiveBlocks() {
        String base = "{\"protocolVersion\":1,\"active\":true,\"libraryId\":\"lib\",\"domains\":[{\"domain\":\"albums\",\"cursor\":4}]";
        String plain = SyncStatusPass.libraryStatus(base + "}");
        equal(plain, SyncStatusPass.libraryStatus(base + ",\"signals\":{\"notes\":9,\"listGeneration\":\"x\"}}"),
                "A signals block is not a Library change");
        equal(plain, SyncStatusPass.libraryStatus(base + ",\"signals\":{\"notes\":10}}"), "A moved signal is not a Library change");
        equal(plain, SyncStatusPass.libraryStatus(base + ",\"publisherLogs\":{\"captures\":{\"pending\":3}}}"),
                "A publisherLogs block is not a Library change");
        equal(plain, SyncStatusPass.libraryStatus(base + ",\"exchange\":{\"revision\":2},\"signals\":{},\"publisherLogs\":{}}"),
                "All three additive blocks together are ignored");
        check(!plain.equals(SyncStatusPass.libraryStatus(base.replace("\"cursor\":4", "\"cursor\":5") + ",\"signals\":{}}")),
                "A moved domain cursor is still a change");
    }

    private static void foregroundOnly() {
        Fixture f = new Fixture();
        equal(0, f.tasks.size(), "Nothing is armed before an activity resumes");
        f.watcher.start();
        f.watcher.start();
        equal(1, f.tasks.size(), "A repeated resume arms once");
        f.step();
        equal(List.of("wait=0"), f.requests, "The first request after a resume answers at once");
        equal(List.of("status", "live=true", "signals=true"), f.events, "The first document goes live and reports signals");
        f.step();
        equal("wait=50 etag", f.requests.get(1), "The next request is held with the document's ETag");

        Task armed = f.tasks.get(f.tasks.size() - 1);
        f.watcher.stop();
        check(armed.cancelled, "Pausing cancels the armed request");
        f.clear();
        armed.run.run();
        equal(0, f.requests.size(), "A task left over from before the pause sends nothing");
        equal(0, f.watcher.listGeneration() == null ? 0 : 1, "A stopped watcher is not live");

        // A pause while a request is held disconnects it and discards its answer.
        Fixture g = new Fixture();
        final StatusWatcher[] held = new StatusWatcher[1];
        final boolean[] disconnected = {false};
        held[0] = new StatusWatcher((etag, wait, cancel) -> {
            cancel.onCancel(() -> disconnected[0] = true);
            held[0].stop();
            throw new java.io.IOException("socket closed");
        }, g, () -> g.now, g);
        held[0].start();
        int before = g.tasks.size();
        g.step();
        check(disconnected[0], "onPause disconnects the held request");
        equal(before, g.tasks.size(), "A request cancelled by a pause arms nothing");
        equal(List.of(), g.events, "and reports nothing");
    }

    private static void changesAreRoutedByPart() {
        Fixture f = new Fixture();
        f.watcher.start();
        f.step();
        f.clear();
        f.notes++;
        f.step();
        equal(List.of("status", "signals=true"), f.events, "A note save moves signals, not the Library");
        f.clear();
        f.exchange++;
        f.step();
        equal(List.of("status"), f.events, "An exchange arrival reaches observeStatus only");
        f.clear();
        f.cursor++;
        f.step();
        equal(List.of("status", "library"), f.events, "A moved domain cursor wakes the Library pass");
        f.clear();
        f.generation = "g2";
        f.step();
        equal(List.of("status", "library", "signals=true"), f.events, "A moved list generation wakes the pass and reports signals");
        equal("g2", f.watcher.listGeneration(), "The pass reads the list generation from the watcher");
        check(f.watcher.exchangeLive(), "The device-token document carries the exchange revision");
        f.clear();
        f.step();
        equal(List.of(), f.events, "An unchanged 304 reports nothing");

        // Changes during a pause: the resume pass reconciles, so the first reply only records.
        f.watcher.stop();
        f.cursor++;
        f.notes++;
        f.clear();
        f.watcher.start();
        f.step();
        equal(List.of("status", "live=true", "signals=true"), f.events, "The first reply after a resume does not wake a second pass");
        f.clear();
        f.cursor++;
        f.step();
        equal(List.of("status", "library"), f.events, "Later changes wake it again");
    }

    private static void olderServerStaysDormant() {
        Fixture f = new Fixture();
        f.capable = false;
        f.watcher.start();
        f.step();
        equal(List.of(), f.events, "A server without Lakomics-Status-Wait never goes live");
        equal(null, f.watcher.listGeneration(), "The pass keeps reading /list-generation itself");
        check(!f.watcher.exchangeLive(), "The exchange screen keeps its refresh");
        equal(StatusWatcher.DORMANT_MILLIS, f.lastDelay(), "Dormant: probe again after 30 min, not in a loop");
        f.clear();
        f.capable = true;
        f.step();
        equal(List.of("wait=0"), f.requests, "The probe after an upgrade answers at once");
        equal(List.of("status", "live=true", "signals=true"), f.events, "An upgraded server goes live");

        Fixture unconfigured = new Fixture();
        unconfigured.configured = false;
        unconfigured.watcher.start();
        unconfigured.step();
        equal(StatusWatcher.DORMANT_MILLIS, unconfigured.lastDelay(), "No connection: dormant, not a retry loop");
    }

    private static void errorsBackOffAndProbeQuickly() {
        Fixture f = new Fixture();
        f.watcher.start();
        f.step();
        f.clear();
        f.fail = true;
        List<Long> delays = new ArrayList<>();
        for (int i = 0; i < 4; i++) { f.step(); delays.add(f.lastDelay()); }
        equal(List.of(5_000L, 15_000L, 60_000L, 60_000L), delays, "Failures back off to a minute");
        equal(List.of("live=false", "signals=false"), f.events, "The first failure reports not live once");
        equal("wait=0 etag", f.requests.get(1), "Retries probe at once instead of holding");
        f.clear();
        f.fail = false;
        f.step();
        equal(List.of("live=true", "signals=true"), f.events, "Recovery goes live on an unchanged 304");
        equal(1_000L - 100L, f.lastDelay(), "Requests keep a one-second minimum spacing");
    }

    private static void hotLoopGuard() {
        Fixture f = new Fixture();
        f.watcher.start();
        f.step();
        f.clear();
        f.overCap = true;
        List<Long> delays = new ArrayList<>();
        for (int i = 0; i < 4; i++) { f.step(); delays.add(f.lastDelay()); }
        equal(List.of(5_000L, 15_000L, 60_000L, 60_000L), delays, "An instant 304 to a held request backs off");
        for (String request : f.requests) equal("wait=50 etag", request, "A hot loop keeps asking to be held, not alternating probes");
        equal(List.of("live=false", "signals=false"), f.events, "Not live while the server will not hold");
        f.overCap = false;
        f.clear();
        f.step();
        equal(List.of("live=true", "signals=true"), f.events, "A held 304 restores liveness");
    }

    private static void resetForgetsTheConnection() {
        Fixture f = new Fixture();
        f.watcher.start();
        f.step();
        f.clear();
        f.watcher.reset();
        equal(List.of("live=false", "signals=false"), f.events, "A replaced connection retracts what the old one reported");
        f.clear();
        f.step();
        equal(List.of("wait=0"), f.requests, "The new connection starts without the old ETag");

        Fixture paused = new Fixture();
        paused.watcher.reset();
        equal(0, paused.tasks.size(), "A reset while paused arms nothing");
    }

    /** Foreground idle hour: one held request per 50 s, no list-generation read. */
    private static void idleForegroundHour() {
        Fixture f = new Fixture();
        f.watcher.start();
        long end = f.now + 60 * 60_000L;
        int generationReads = 0;
        while (f.now < end) {
            f.step();
            if (f.watcher.listGeneration() == null) generationReads++;
        }
        System.out.println("[perf] tablet status watcher idle hour: sync/status=" + f.requests.size()
                + " list-generation=" + generationReads);
        check(f.requests.size() <= 75, "About 72 held requests per idle hour, got " + f.requests.size());
        equal(0, generationReads, "list-generation reads per idle hour while live");
    }

    /** The repeating pass relaxes to 5 min only while the watcher is live. */
    private static void scheduleRelaxesOnlyWhileLive() {
        List<Long> intervals = new ArrayList<>();
        List<Boolean> cancelled = new ArrayList<>();
        ForegroundSchedule.Timer timer = (task, interval) -> {
            intervals.add(interval);
            int index = cancelled.size();
            cancelled.add(false);
            return new ScheduledFuture<Object>() {
                @Override public boolean cancel(boolean interrupt) { cancelled.set(index, true); return true; }
                @Override public boolean isCancelled() { return cancelled.get(index); }
                @Override public boolean isDone() { return false; }
                @Override public Object get() { throw new UnsupportedOperationException(); }
                @Override public Object get(long timeout, TimeUnit unit) { throw new UnsupportedOperationException(); }
                @Override public long getDelay(TimeUnit unit) { return 0; }
                @Override public int compareTo(Delayed other) { return 0; }
            };
        };
        ForegroundSchedule schedule = new ForegroundSchedule(timer, () -> true, () -> {});
        schedule.start();
        schedule.setLive(true);
        for (int i = 0; i < 5; i++) schedule.passFinished(false);
        equal(List.of(5_000L, 15_000L, 30_000L, 60_000L, 300_000L, 300_000L), intervals, "Live: unchanged passes relax to five minutes");
        schedule.setLive(false);
        equal(60_000L, intervals.get(intervals.size() - 1), "Losing the watcher returns to one minute at once");
        long open = cancelled.stream().filter(value -> !value).count();
        equal(1L, open, "Exactly one timer stays armed");
        schedule.passFinished(false);
        equal(60_000L, intervals.get(intervals.size() - 1), "Not live: the ladder stops at one minute");
        schedule.setLive(true);
        schedule.passFinished(true);
        equal(5_000L, intervals.get(intervals.size() - 1), "A change still returns to five seconds");
    }
}
