package com.lakomics.mobile;

/** Exchange revision and retry state, guarded by the owning service's monitor. */
final class ExchangeRefreshState {
    private long observed = -1, handled = -1;
    private int failures;

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

    long retryDelay(boolean foreground, boolean visible, boolean statusLive) {
        if (!foreground || !visible || !statusLive || !pending() || failures == 0) return -1;
        return failures == 1 ? 5_000 : failures == 2 ? 15_000 : 60_000;
    }

    void reset() { observed = handled = -1; failures = 0; }
}
