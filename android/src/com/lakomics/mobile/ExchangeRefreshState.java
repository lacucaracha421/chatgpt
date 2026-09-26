package com.lakomics.mobile;

/**
 * Exchange revision and retry state, guarded by the owning service's monitor.
 *
 * A status revision is a change hint, not evidence that outstanding work succeeded: a failed
 * inbox refresh and an unsent acknowledgement each keep their own foreground retry deadline
 * (5/15/60 s, capped), independent of the 보내기/받기 screen and of further status reads.
 */
final class ExchangeRefreshState {
    private long observed = -1, handled = -1;
    private int failures, ackFailures;

    boolean observe(long next) {
        if (next != observed) { observed = next; failures = 0; }
        // Repeated status reads must not bypass the failure backoff.
        return pending() && failures == 0;
    }

    long revision() { return observed; }
    boolean pending() { return observed != handled; }

    void succeeded(long startedRevision) {
        // A newer arrival during the read still needs its own refresh.
        if (startedRevision == observed) { handled = startedRevision; failures = 0; }
    }

    void failed(long startedRevision) {
        if (startedRevision == observed && pending()) failures = Math.min(3, failures + 1);
    }

    /** Delay before the next inbox refresh attempt, or -1 when none is owed (or in the background). */
    long retryDelay(boolean foreground) {
        if (!foreground || !pending() || failures == 0) return -1;
        return backoff(failures);
    }

    /** An acknowledgement round left work unsent; the next round waits longer. */
    void ackFailed() { ackFailures = Math.min(3, ackFailures + 1); }

    /** Every outstanding acknowledgement was settled. */
    void acksSettled() { ackFailures = 0; }

    /** Delay before the next acknowledgement round, or -1 when none is owed (or in the background). */
    long ackDelay(boolean foreground, boolean outstanding) {
        if (!foreground || !outstanding) return -1;
        return ackFailures == 0 ? 0 : backoff(ackFailures);
    }

    private static long backoff(int failures) { return failures == 1 ? 5_000 : failures == 2 ? 15_000 : 60_000; }

    void reset() { observed = handled = -1; failures = 0; ackFailures = 0; }
}
