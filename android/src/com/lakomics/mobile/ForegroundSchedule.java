package com.lakomics.mobile;

import java.util.concurrent.ScheduledFuture;

/**
 * The foreground scheduling state machine for Album replication.
 *
 * It exists so the transitions that decide whether the repeating pass is armed can be
 * checked without an Android runtime. The defect it fixes was purely a transition
 * defect: a connection change disarmed the loop and nothing re-armed it, because
 * `configure` replaces the connection without ever pausing the activity.
 *
 * The state here is deliberately small — whether the activity is foregrounded, which arm
 * generation is current, whether an immediate pass is still owed, and the handle that
 * cancels the repeating pass. Everything else stays in the service: whether a pass may do
 * work, which connection it describes, and what it records.
 *
 * # Arm generations are real
 *
 * A repeating task belongs to the arm that scheduled it. Tracking only "is polling armed"
 * is not enough, because a restart disarms and re-arms in one step: a task left over from
 * the cancelled arm would then see `armed == true` again — for a *newer* arm — and run a
 * pass that no longer belongs to it. Each task therefore carries its generation, and
 * {@link #tick} compares it under the same lock that arms and disarms. Holding the lock
 * across the check *and* the callback is what makes the boundary real rather than a
 * narrowed race window: a tick either runs wholly before a restart, or wholly after it
 * and is refused.
 *
 * # Locking
 *
 * Every transition holds {@link #gate}, and callbacks run while it is held, so a caller
 * must not hold its own monitor when calling in here or the lock order would invert. The
 * established order is `ForegroundSchedule.gate -> caller monitor`, which every entry
 * point below follows.
 */
final class ForegroundSchedule {
    /** Foreground convergence target, matching the PC authority sync loops. */
    static final long INTERVAL_MILLIS = 5_000;

    /** The repeating timer, supplied by the Android service. */
    interface Timer {
        ScheduledFuture<?> schedule(Runnable task, long intervalMillis);
    }

    /**
     * An immediate pass, reporting whether it actually started.
     *
     * `false` means another pass was already running. The return value is what keeps a
     * reconciliation requested by a resume or a replacement connection from being lost to
     * single-flight: it is recorded as owed and started when the slot frees.
     */
    interface Immediate {
        boolean run();
    }

    private final Timer timer;
    private final Immediate immediate;
    /**
     * A repeating pass. Deliberately not reportable: one that could not start is simply
     * served by the next interval, so there is nothing to record.
     */
    private final Runnable repeating;
    private final Object gate = new Object();

    private boolean foreground;
    private boolean armed;
    /** Increments on every arm, so each armed timer is distinguishable. */
    private long generation;
    /** Set when an immediate pass was requested but could not start yet. */
    private boolean owed;
    private ScheduledFuture<?> handle;
    private int idle;
    private static final long[] DELAYS = {5_000,15_000,30_000,60_000};

    /** Local work returns to the convergence target and cannot be lost to single-flight. */
    void wake() {
        synchronized(gate) {
            idle=0;
            if(!armed)return;
            rearmTimer();
            owed=!immediate.run();
        }
    }

    void passFinished(boolean changed) {
        synchronized(gate) {
            if(armed) {
                idle=changed?0:Math.min(idle+1,DELAYS.length-1);
                rearmTimer();
            }
            passFinished();
        }
    }

    private void rearmTimer() {
        if(handle!=null)handle.cancel(false);
        long arm=++generation;
        handle=timer.schedule(()->tick(arm),DELAYS[idle]);
    }

    ForegroundSchedule(Timer timer, Immediate immediate, Runnable repeating) {
        this.timer = timer;
        this.immediate = immediate;
        this.repeating = repeating;
    }

    /**
     * The activity became foreground: allow polling, reconcile now, then repeat.
     *
     * Idempotent, so a second resume while still polling neither queues an extra pass nor
     * schedules a second timer.
     */
    void start() {
        synchronized (gate) {
            foreground = true;
            arm();
        }
    }

    /** The activity left the foreground. The replica stays durable; only polling stops. */
    void stop() {
        synchronized (gate) {
            foreground = false;
            disarm();
        }
    }

    /**
     * Re-arm for a *replacement* connection, running `invalidate` first.
     *
     * The invalidation must precede the new arm, because arming invokes the immediate pass
     * synchronously and that pass is the reconciliation for the new connection. Arming
     * first would queue a pass that `invalidate` then invalidates — and since that pass did
     * start, nothing would be recorded as owed, so the replacement connection would wait
     * for the next interval instead of reconciling now.
     *
     * Disarming first also gives the new connection a fresh interval instead of inheriting
     * the replaced connection's timing. When the activity is *not* foregrounded nothing is
     * armed, so a connection change cannot start polling from the background.
     */
    void restartAfter(Runnable invalidate) {
        synchronized (gate) {
            disarm();
            invalidate.run();
            arm();
        }
    }

    /**
     * A pass finished: start the immediate pass this schedule still owes, if any.
     *
     * This is what turns "single-flight refused the immediate request" into "the
     * replacement connection reconciles as soon as single-flight permits" rather than
     * "at the next interval".
     */
    void passFinished() {
        synchronized (gate) {
            boolean wanted = owed;
            owed = false;
            // Only while still armed: a stopped schedule owes nothing.
            if (wanted && armed) owed = !immediate.run();
        }
    }

    /** Arm the repeating pass once. Caller holds {@link #gate}. */
    private void arm() {
        if (!foreground || armed) return;
        armed = true;
        idle=0;
        rearmTimer();
        owed = !immediate.run();
    }

    /**
     * One repeating interval elapsed for the arm identified by `arm`.
     *
     * Two things are checked, and both are needed. `armed` covers a stop, which does not
     * advance the generation. `arm != generation` covers a re-arm, where `armed` becomes
     * true again while the generation has moved on — the case a single boolean cannot see.
     */
    private void tick(long arm) {
        synchronized (gate) {
            if (!armed || arm != generation) return;
            repeating.run();
        }
    }

    /** Cancel the repeating pass. Caller holds {@link #gate}. Idempotent. */
    private void disarm() {
        armed = false;
        // A stopped or superseded schedule owes no pass.
        owed = false;
        ScheduledFuture<?> current = handle;
        handle = null;
        if (current != null) current.cancel(false);
    }
}
