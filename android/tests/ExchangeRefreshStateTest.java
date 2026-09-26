package com.lakomics.mobile;

public final class ExchangeRefreshStateTest {
    public static void main(String[] args) {
        ExchangeRefreshState state = new ExchangeRefreshState();
        check(state.observe(7), "arrival must refresh");
        // No successful inbox refresh occurred. A subsequent status is still actionable.
        boolean retry = state.observe(7);
        System.out.println("Exchange: same-revision recovery opportunities=" + (retry ? 1 : 0));
        check(retry, "failed inbox read must not consume the arrival revision");

        // A failed fetch keeps the arrival pending but duplicate status must respect backoff.
        // The retry owes nothing to the screen or to a further status read: with the screen
        // closed and a healthy long-poll repeating the same revision, the refresh still retries
        // on its own deadline (review finding: one failure used to stall delivery).
        long[] delays = {5_000, 15_000, 60_000, 60_000};
        for (long delay : delays) {
            state.failed(7);
            check(state.pending(), "failure must keep revision pending");
            check(!state.observe(7), "duplicate status must not bypass backoff");
            check(state.retryDelay(true) == delay, "screen-closed refresh failure must retry on its own");
            check(state.retryDelay(false) == -1, "no background retry");
        }
        state.succeeded(7);
        check(!state.pending(), "successful inbox refresh handles revision");
        check(!state.observe(7), "handled revision must not refetch");
        check(state.retryDelay(true) == -1, "success must stop retries");
        state.failed(7);
        check(!state.pending(), "late concurrent failure must not undo successful refresh");

        check(state.observe(8), "next arrival must refresh");
        long started = state.revision();
        check(state.observe(9), "arrival during fetch must refresh again");
        state.succeeded(started);
        state.failed(started);
        check(state.pending() && state.observe(9), "old read cannot acknowledge or delay newer arrival");
        state.failed(9);
        check(state.retryDelay(true) == 5_000, "new revision restarts backoff");

        // Acknowledgements: their own deadline. The revision that carried the arrival is
        // already handled, so no status read would ever bring the ack back.
        state.succeeded(9);
        check(!state.pending() && state.retryDelay(true) == -1, "refresh handled");
        check(state.ackDelay(true, true) == 0, "an outstanding ack is sent at once");
        check(state.ackDelay(true, false) == -1, "nothing outstanding, nothing scheduled");
        long[] ackDelays = {5_000, 15_000, 60_000, 60_000};
        for (long delay : ackDelays) {
            state.ackFailed();
            check(state.ackDelay(true, true) == delay, "failed ack must retry with bounded backoff");
            check(state.ackDelay(false, true) == -1, "no background ack");
        }
        state.acksSettled();
        check(state.ackDelay(true, true) == 0, "settled acks restart the backoff");

        state.ackFailed();
        state.reset();
        check(!state.pending(), "reset clears pending arrival");
        check(state.retryDelay(true) == -1, "reset clears retries");
        check(state.ackDelay(true, true) == 0, "reset clears ack backoff");
        check(state.observe(0), "replacement server can start at a lower revision");
        state.succeeded(0);
        check(!state.observe(0), "replacement revision can be handled");
        System.out.println("ExchangeRefreshStateTest passed: refresh and ack retry delays=5/15/60/60 s, screen-independent; background retries=0");
    }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
