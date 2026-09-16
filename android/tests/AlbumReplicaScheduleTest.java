package com.lakomics.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Delayed;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground scheduling checks for Album replication.
 *
 * The defects these cover were *transition* defects, not replication ones: a connection
 * change disarmed the loop and nothing re-armed it, and once it did re-arm, a task left
 * over from the cancelled arm could still run because "is polling armed" was true again
 * for the newer arm. So these checks drive the state machine directly — foregrounded,
 * armed, immediate pass, repeating pass, disarmed, re-armed — instead of trying to
 * simulate an Android activity lifecycle, which is why {@link ForegroundSchedule} exists
 * as a seam at all.
 *
 * The timer records the tasks it was given and fires them on demand. Firing an *old* task
 * after a re-arm is exactly how the stale-generation defect is reproduced, so the
 * recording timer is not a convenience here: it is the only way to reach that state.
 */
public final class AlbumReplicaScheduleTest {
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

    /** Records the armed repeating tasks so a check can fire any generation by hand. */
    private static final class Recorder implements ForegroundSchedule.Timer {
        final List<Runnable> tasks = new ArrayList<>();
        final List<Long> intervals = new ArrayList<>();
        int cancelled;

        @Override
        public ScheduledFuture<?> schedule(Runnable task, long intervalMillis) {
            tasks.add(task);
            intervals.add(intervalMillis);
            return new Handle(this);
        }

        void fire(int index) { tasks.get(index).run(); }

        int pending() { return tasks.size() - cancelled; }
    }

    /** A future that reports cancellation back to the recorder. */
    private static final class Handle implements ScheduledFuture<Object> {
        private final Recorder recorder;

        Handle(Recorder recorder) { this.recorder = recorder; }

        @Override public boolean cancel(boolean mayInterruptIfRunning) {
            recorder.cancelled++;
            return true;
        }

        @Override public boolean isCancelled() { return false; }
        @Override public boolean isDone() { return false; }
        @Override public Object get() { throw new UnsupportedOperationException(); }
        @Override public Object get(long timeout, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }
        @Override public long getDelay(TimeUnit unit) { return 0; }
        @Override public int compareTo(Delayed other) { return 0; }
    }

    private static final class Fixture {
        final Recorder timer = new Recorder();
        final List<String> events = new ArrayList<>();
        int immediate;
        int repeating;
        /** When true, an immediate request reports that single-flight refused it. */
        boolean immediateRefused;
        final ForegroundSchedule schedule;

        Fixture() {
            schedule = new ForegroundSchedule(timer, this::immediatePass, this::repeatingPass);
        }


        boolean immediatePass() {
            events.add("immediate");
            if (immediateRefused) return false;
            immediate++;
            return true;
        }

        void repeatingPass() {
            events.add("repeating");
            repeating++;
        }

        void invalidate() { events.add("invalidate"); }
    }

    public static void main(String[] args) {
        startsPollingAndReconcilesImmediately();
        repeatedResumeDoesNotDuplicateWork();
        pauseStopsPollingWithoutTouchingTheReplica();
        staleTimerFromAReplacedArmNeverRuns();
        staleTimerAfterStopNeverRuns();
        restartAfterLeavesExactlyOneArmedTimer();
        restartAfterInvalidatesBeforeTheImmediatePass();
        refusedImmediatePassIsRunWhenTheCurrentPassFinishes();
        aRestartCannotInterleaveBetweenTheCheckAndTheCallback();
        owedPassIsDroppedWhenPollingStops();
        connectionReplacementFromTheBackgroundDoesNotStartPolling();
        disconnectThenReconnectResumesPolling();

        System.out.println("AlbumReplicaScheduleTest passed: " + checks
                + " checks (generations, start, pause, connection replacement, pending reconcile)");
    }

    private static void startsPollingAndReconcilesImmediately() {
        Fixture fixture = new Fixture();
        equal(0, fixture.timer.pending(), "A new activity has nothing scheduled");
        fixture.schedule.start();
        equal(1, fixture.immediate, "Resuming reconciles immediately");
        equal(1, fixture.timer.pending(), "Resuming schedules one repeating pass");
        equal(ForegroundSchedule.INTERVAL_MILLIS, fixture.timer.intervals.get(0),
                "The repeating pass uses the foreground convergence target");
    }

    private static void repeatedResumeDoesNotDuplicateWork() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.start();
        fixture.schedule.start();
        equal(1, fixture.immediate, "A repeated resume does not queue extra passes");
        equal(1, fixture.timer.pending(), "A repeated resume does not schedule a second timer");
    }

    private static void pauseStopsPollingWithoutTouchingTheReplica() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.stop();
        equal(0, fixture.timer.pending(), "Pausing cancels the repeating pass");
        fixture.timer.fire(0);
        equal(0, fixture.repeating, "A pending tick after a pause does nothing");
        fixture.schedule.stop();
        equal(0, fixture.timer.pending(), "Pausing twice stays disarmed");
    }

    /**
     * The stale-generation defect.
     *
     * `start()` arms one generation and `restartAfter()` cancels it and arms the next. A
     * task already dequeued from the cancelled arm must not run merely because a *newer*
     * arm is currently armed — which is exactly what a shared `armed` boolean cannot see,
     * since that flag is true again by the time the old task fires.
     */
    private static void staleTimerFromAReplacedArmNeverRuns() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(2, fixture.timer.tasks.size(), "The replacement connection armed its own timer");
        equal(1, fixture.timer.cancelled, "and cancelled the replaced connection's timer");

        int before = fixture.repeating;
        fixture.timer.fire(0);
        equal(before, fixture.repeating,
                "A task from the replaced arm does not run after the re-arm");

        // The current generation still runs, so the check above is not passing because
        // ticking is broken outright.
        fixture.timer.fire(1);
        equal(before + 1, fixture.repeating, "The current arm's task still runs");

        // Firing the stale task again stays inert, and after a further re-arm the old
        // generations are still inert while only the newest one runs.
        fixture.timer.fire(0);
        equal(before + 1, fixture.repeating, "The stale task stays inert on a second firing");

        fixture.schedule.restartAfter(fixture::invalidate);
        fixture.timer.fire(0);
        fixture.timer.fire(1);
        equal(before + 1, fixture.repeating, "Two-arm-old tasks are inert after a further re-arm");
        fixture.timer.fire(2);
        equal(before + 2, fixture.repeating, "and only the newest arm's task runs");
    }

    /** A stop does not advance the generation, so the armed flag is what refuses this. */
    private static void staleTimerAfterStopNeverRuns() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.stop();
        fixture.timer.fire(0);
        equal(0, fixture.repeating, "A task from a stopped schedule does nothing");
    }

    private static void restartAfterLeavesExactlyOneArmedTimer() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(1, fixture.timer.pending(), "A replacement connection leaves one armed timer");
        // Repeating the replacement does not accumulate timers.
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(1, fixture.timer.pending(), "and repeated replacements keep exactly one");
        equal(3, fixture.timer.tasks.size(), "each replacement arms exactly one timer");
    }

    /**
     * The ordering requirement.
     *
     * Arming runs the immediate pass synchronously, so the invalidation must happen first.
     * Otherwise the new connection's reconciliation would be invalidated by the clear that
     * followed it, and since it had started, nothing would be recorded as owed.
     */
    private static void restartAfterInvalidatesBeforeTheImmediatePass() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.events.clear();
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(List.of("invalidate", "immediate"), fixture.events,
                "Invalidation runs before the replacement connection's immediate pass");
        equal(2, fixture.immediate, "The replacement connection reconciles against the new account");
    }

    /**
     * A refused immediate pass is owed, not dropped.
     *
     * While a pass is in flight single-flight refuses the request. Recording it as still
     * owed is what makes the replacement connection reconcile as soon as the slot frees,
     * rather than waiting for the next interval.
     */
    private static void refusedImmediatePassIsRunWhenTheCurrentPassFinishes() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        equal(1, fixture.immediate, "The first pass starts");

        // A pass is in flight, so the replacement connection's immediate request is refused.
        fixture.immediateRefused = true;
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(1, fixture.immediate, "A refused immediate pass does not start concurrently");

        // The in-flight pass finishes and the slot frees; the owed pass must start then.
        fixture.immediateRefused = false;
        fixture.schedule.passFinished();
        equal(2, fixture.immediate, "The owed pass runs as soon as the slot frees");
        // Nothing stays owed, so a later completion does not double-request.
        fixture.schedule.passFinished();
        equal(2, fixture.immediate, "The owed pass is requested once");
    }

    /**
     * The generation boundary must be atomic, not merely narrow.
     *
     * Validating the generation and then releasing the lock before running the callback
     * leaves a window where a restart happens *after* the check and *before* the callback —
     * the old arm's pass then runs against the new connection. Holding the lock across the
     * callback closes it: a restart either completes before the tick or waits for it.
     *
     * The check observes that directly. While the repeating callback is suspended inside a
     * tick, a second thread attempts a replacement connection; under the correct contract
     * that attempt is blocked on the schedule's monitor, so its invalidation cannot have run
     * yet. The bounded wait only gives the second thread time to *reach* the monitor — the
     * assertion is about ordering, not about timing.
     */
    private static void aRestartCannotInterleaveBetweenTheCheckAndTheCallback() {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean invalidated = new AtomicBoolean();
        AtomicBoolean overlapping = new AtomicBoolean();
        Recorder timer = new Recorder();
        ForegroundSchedule schedule = new ForegroundSchedule(timer, () -> true, () -> {
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("callback not released");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        });
        schedule.start();

        Thread ticking = new Thread(() -> timer.fire(0), "album-schedule-tick");
        ticking.setDaemon(true);
        ticking.start();
        try {
            check(await(entered), "The repeating callback started");
            Thread restarting = new Thread(() -> {
                schedule.restartAfter(() -> invalidated.set(true));
                if (entered.getCount() == 0 && release.getCount() > 0) overlapping.set(true);
            }, "album-schedule-restart");
            restarting.setDaemon(true);
            restarting.start();
            // The restarting thread now blocks on the monitor the tick holds.
            restarting.join(1500);
            check(!invalidated.get(),
                    "A replacement connection cannot invalidate while a tick is between its check and its callback");
            release.countDown();
            restarting.join(5000);
            check(invalidated.get(), "The replacement connection completes once the tick finishes");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted");
        } finally {
            release.countDown();
            try {
                ticking.join(5000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** Bounded wait, reported as a boolean so the check reads as an assertion. */
    private static boolean await(CountDownLatch latch) {
        try {
            return latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static void owedPassIsDroppedWhenPollingStops() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.immediateRefused = true;
        fixture.schedule.restartAfter(fixture::invalidate);
        fixture.schedule.stop();
        fixture.immediateRefused = false;
        fixture.schedule.passFinished();
        equal(1, fixture.immediate, "A stopped schedule owes nothing, even with a pass outstanding");
    }

    private static void connectionReplacementFromTheBackgroundDoesNotStartPolling() {
        Fixture fixture = new Fixture();
        // Never resumed: configuring from the background must not begin polling.
        fixture.schedule.restartAfter(fixture::invalidate);
        equal(0, fixture.immediate, "A replacement connection from the background does not reconcile");
        equal(0, fixture.timer.pending(), "and schedules nothing");
        // A later resume still arms normally, so the background case is not "stuck off".
        fixture.schedule.start();
        equal(1, fixture.immediate, "and a later resume reconciles");
        equal(1, fixture.timer.pending(), "and arms its timer");
    }

    /**
     * Disconnect, then reconnect.
     *
     * A disconnect clears the replica and must not leave polling running against a
     * configuration that no longer exists. It is a stop, not a replacement: the schedule is
     * re-armed only when the activity is next foregrounded with a usable connection.
     */
    private static void disconnectThenReconnectResumesPolling() {
        Fixture fixture = new Fixture();
        fixture.schedule.start();
        fixture.schedule.stop();
        equal(0, fixture.timer.pending(), "Disconnecting leaves no timer running");
        int afterDisconnect = fixture.immediate;
        fixture.schedule.stop();
        equal(afterDisconnect, fixture.immediate, "A repeated disconnect requests nothing");
        fixture.timer.fire(0);
        equal(0, fixture.repeating, "No pass runs while disconnected");

        fixture.schedule.start();
        equal(2, fixture.immediate, "A later resume reconciles against the current configuration");
        fixture.timer.fire(fixture.timer.tasks.size() - 1);
        equal(1, fixture.repeating, "and the loop runs again from there");
    }
}
