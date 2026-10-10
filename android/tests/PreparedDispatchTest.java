package com.lakomics.mobile;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Both queues use the bridge's real dispatch; no Android runtime or media storage. */
public final class PreparedDispatchTest {
    private static final class Signal implements CancellableDispatch.Cancellation {
        private boolean canceled;
        private Runnable listener;
        public synchronized boolean isCanceled() { return canceled; }
        public void setListener(Runnable value) {
            synchronized (this) { listener = value; }
            if (isCanceled() && value != null) value.run();
        }
        void cancel() {
            Runnable value;
            synchronized (this) { canceled = true; value = listener; }
            if (value != null) value.run();
        }
    }
    private static ThreadPoolExecutor pool() {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(48));
    }
    public static void main(String[] args) throws Exception {
        fifoAndDownloadCancellation();
        cancellationDuringPreparation();
        queuedPreparationCancellation();
        failure(false, false);
        failure(true, false);
        failure(false, true);
        System.out.println("PreparedDispatchTest: 6 scenarios passed");
    }
    private static void fifoAndDownloadCancellation() throws Exception {
        ThreadPoolExecutor preparing = pool(), downloads = pool();
        CountDownLatch held = new CountDownLatch(1), release = new CountDownLatch(1);
        CountDownLatch prepared = new CountDownLatch(3), finished = new CountDownLatch(3);
        List<Integer> order = Collections.synchronizedList(new ArrayList<>());
        List<Integer> ran = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger[] cleanups = {new AtomicInteger(), new AtomicInteger(), new AtomicInteger()};
        Signal[] signals = {new Signal(), new Signal(), new Signal()};
        try {
            downloads.execute(() -> { held.countDown(); await(release); });
            await(held);
            for (int i = 0; i < 3; i++) {
                final int index = i;
                new CancellableDispatch(signals[i], () -> ran.add(index), status -> {
                    check(index != 1 || "canceled".equals(status), "download cancellation status");
                    cleanups[index].incrementAndGet(); finished.countDown();
                }).submitPrepared(preparing, downloads, () -> {
                    order.add(index); prepared.countDown();
                }, e -> { throw new AssertionError(e); });
            }
            await(prepared);
            preparing.shutdown(); check(preparing.awaitTermination(3, TimeUnit.SECONDS), "handoff did not finish");
            check(order.equals(Arrays.asList(0, 1, 2)), "preparation must preserve FIFO despite occupied download slots");
            signals[1].cancel(); check(cleanups[1].get() == 1, "queued download must release its prepared ticket");
            release.countDown(); await(finished);
            check(ran.equals(Arrays.asList(0, 2)), "canceled download ran or order changed");
            for (int i = 0; i < 3; i++) { signals[i].cancel(); check(cleanups[i].get() == 1, "duplicate cleanup"); }
        } finally { release.countDown(); stop(preparing, downloads); }
    }
    private static void cancellationDuringPreparation() throws Exception {
        ThreadPoolExecutor preparing = pool(), downloads = pool();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
        Signal signal = new Signal(); AtomicInteger cleanups = new AtomicInteger(), resources = new AtomicInteger();
        try {
            new CancellableDispatch(signal, () -> { throw new AssertionError("canceled download ran"); }, status -> {
                check("canceled".equals(status), "preparation cancellation status");
                check(resources.decrementAndGet() == 0, "prepared resource must be released");
                cleanups.incrementAndGet(); finished.countDown();
            }).submitPrepared(preparing, downloads, () -> {
                entered.countDown(); await(release); resources.incrementAndGet();
            }, e -> { throw new AssertionError(e); });
            await(entered); signal.cancel();
            check(cleanups.get() == 0, "running preparation owns cleanup until its resource exists");
            release.countDown(); await(finished); signal.cancel();
            check(cleanups.get() == 1, "preparation cleanup exactly once");
        } finally { release.countDown(); stop(preparing, downloads); }
    }
    private static void queuedPreparationCancellation() throws Exception {
        ThreadPoolExecutor preparing = pool(), downloads = pool();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Signal signal = new Signal(); AtomicInteger cleanups = new AtomicInteger();
        try {
            preparing.execute(() -> { entered.countDown(); await(release); }); await(entered);
            new CancellableDispatch(signal, () -> { throw new AssertionError("download ran"); }, status -> {
                check("canceled".equals(status), "queued preparation cancellation status"); cleanups.incrementAndGet();
            }).submitPrepared(preparing, downloads, () -> { throw new AssertionError("canceled preparation ran"); }, e -> { throw new AssertionError(e); });
            signal.cancel(); signal.cancel();
            check(preparing.getQueue().isEmpty() && cleanups.get() == 1, "queued preparation must be removed and cleaned once");
        } finally { release.countDown(); stop(preparing, downloads); }
    }
    private static void failure(boolean rejectDownload, boolean prepareFailure) throws Exception {
        ThreadPoolExecutor preparing = pool(), downloads = pool();
        Signal signal = new Signal(); AtomicInteger cleanups = new AtomicInteger(), failures = new AtomicInteger();
        CountDownLatch finished = new CountDownLatch(1);
        if (rejectDownload) downloads.shutdown();
        else if (!prepareFailure) preparing.shutdown();
        try {
            CancellableDispatch dispatch = new CancellableDispatch(signal, () -> { throw new AssertionError("failed download ran"); }, status -> {
                check(prepareFailure ? status == null : "rejected".equals(status), "terminal status");
                cleanups.incrementAndGet(); finished.countDown();
            });
            try {
                dispatch.submitPrepared(preparing, downloads, () -> {
                    if (prepareFailure) throw new Exception("fixture preparation failure");
                }, e -> failures.incrementAndGet());
            } catch (RejectedExecutionException expected) { failures.incrementAndGet(); }
            await(finished); stop(preparing, downloads); signal.cancel();
            check(cleanups.get() == 1 && failures.get() == 1, "failure must report and clean exactly once");
        } finally { stop(preparing, downloads); }
    }
    private static void stop(ThreadPoolExecutor... pools) throws Exception {
        for (ThreadPoolExecutor pool : pools) pool.shutdown();
        for (ThreadPoolExecutor pool : pools) {
            if (!pool.awaitTermination(3, TimeUnit.SECONDS)) {
                pool.shutdownNow();
                throw new AssertionError("worker did not stop");
            }
        }
    }
    private static void await(CountDownLatch latch) {
        try { check(latch.await(3, TimeUnit.SECONDS), "latch timed out"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
