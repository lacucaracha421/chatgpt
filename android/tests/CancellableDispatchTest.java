package com.lakomics.mobile;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class CancellableDispatchTest {
    private static final class Signal implements CancellableDispatch.Cancellation {
        private boolean canceled;
        private Runnable listener;
        Runnable afterRegistration;
        public synchronized boolean isCanceled() { return canceled; }
        public void setListener(Runnable value) {
            Runnable hook;
            synchronized (this) {
                listener = value;
                if (canceled && value != null) value.run();
                hook = value == null ? null : afterRegistration;
                afterRegistration = null;
            }
            if (hook != null) hook.run();
        }
        synchronized void cancel() {
            canceled = true;
            if (listener != null) listener.run();
        }
    }

    private static final class Pool extends ThreadPoolExecutor {
        Runnable beforeExecute;
        Runnable afterExecute;
        Pool() { super(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(1)); }
        @Override public void execute(Runnable task) {
            if (beforeExecute != null) { Runnable hook = beforeExecute; beforeExecute = null; hook.run(); }
            super.execute(task);
            if (afterExecute != null) { Runnable hook = afterExecute; afterExecute = null; hook.run(); }
        }
    }

    public static void main(String[] args) throws Exception {
        int failed = 0;
        for (String timing : new String[]{"before-submit", "after-registration", "during-execute", "after-enqueue"}) {
            try { canceledQueue(timing); }
            catch (AssertionError e) { failed++; System.out.println(timing + ": " + e.getMessage()); }
        }
        rejection(false);
        rejection(true);
        workerOwnsCleanup(false);
        workerOwnsCleanup(true);
        if (failed != 0) throw new AssertionError(failed + " cancellation gates failed");
        System.out.println("CancellableDispatchTest passed");
    }

    private static void canceledQueue(String timing) throws Exception {
        Pool pool = new Pool();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            pool.execute(() -> { entered.countDown(); await(release); });
            check(entered.await(3, TimeUnit.SECONDS), "worker did not start");
            Signal signal = new Signal();
            AtomicInteger cleanups = new AtomicInteger(), bodies = new AtomicInteger();
            CancellableDispatch task = new CancellableDispatch(signal, bodies::incrementAndGet, status -> {
                check("canceled".equals(status), "wrong cleanup status"); cleanups.incrementAndGet();
            });
            if (timing.equals("before-submit")) signal.cancel();
            if (timing.equals("after-registration")) signal.afterRegistration = signal::cancel;
            if (timing.equals("during-execute")) pool.beforeExecute = signal::cancel;
            if (timing.equals("after-enqueue")) pool.afterExecute = signal::cancel;
            task.submit(pool, true);
            int occupied = pool.getQueue().size();
            int rejected = 0;
            try { pool.execute(() -> {}); } catch (RejectedExecutionException e) { rejected++; }
            System.out.println(timing + ": canceled queue slots=" + occupied + ", visible rejections=" + rejected + ", cleanups=" + cleanups.get());
            check(occupied == 0, "canceled task occupies queue");
            check(rejected == 0, "visible task rejected");
            signal.cancel();
            check(cleanups.get() == 1, "cleanup must finish exactly once");
            check(bodies.get() == 0, "canceled body ran");
        } finally {
            release.countDown(); pool.shutdownNow();
            check(pool.awaitTermination(3, TimeUnit.SECONDS), "worker did not stop");
        }
    }

    private static void rejection(boolean cancelDuringExecute) throws Exception {
        Pool pool = new Pool();
        pool.shutdown();
        Signal signal = new Signal();
        AtomicInteger cleanups = new AtomicInteger(), replies = new AtomicInteger();
        CancellableDispatch task = new CancellableDispatch(signal, () -> {
            throw new AssertionError("rejected task ran");
        }, status -> {
            check((cancelDuringExecute ? "canceled" : "rejected").equals(status), "rejection cleanup status");
            cleanups.incrementAndGet();
        });
        if (cancelDuringExecute) pool.beforeExecute = signal::cancel;
        try { task.submit(pool, true); }
        catch (RejectedExecutionException expected) { if (!signal.isCanceled()) replies.incrementAndGet(); }
        signal.cancel();
        check(cleanups.get() == 1, "rejection cleanup exactly once");
        check(replies.get() == (cancelDuringExecute ? 0 : 1), "no rejection reply to canceled caller");
    }

    private static void workerOwnsCleanup(boolean cancelWhileRunning) throws Exception {
        Pool pool = new Pool();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger activeRemoves = new AtomicInteger(), optionalRemoves = new AtomicInteger();
        AtomicInteger perfRemoves = new AtomicInteger(), perfFinishes = new AtomicInteger(), replies = new AtomicInteger();
        Signal signal = new Signal();
        Thread[] worker = new Thread[1];
        try {
            CancellableDispatch task = new CancellableDispatch(signal, () -> {
                worker[0] = Thread.currentThread();
                entered.countDown(); await(release);
                if (!signal.isCanceled()) replies.incrementAndGet();
            }, status -> {
                check(Thread.currentThread() == worker[0], "running worker must own cleanup");
                check(cancelWhileRunning ? "canceled".equals(status) : status == null, "running cleanup status");
                activeRemoves.incrementAndGet(); optionalRemoves.incrementAndGet();
                perfRemoves.incrementAndGet(); perfFinishes.incrementAndGet();
            });
            // Force execute to return after a worker has already taken ownership.
            pool.afterExecute = () -> {
                await(entered);
                if (cancelWhileRunning) signal.cancel();
            };
            task.submit(pool, true);
            check(perfFinishes.get() == 0, "submission/cancel cannot finish a running operation");
            release.countDown(); pool.shutdown();
            check(pool.awaitTermination(3, TimeUnit.SECONDS), "worker did not finish");
            signal.cancel();
            check(activeRemoves.get() == 1 && optionalRemoves.get() == 1, "maps cleaned exactly once");
            check(perfRemoves.get() == 1 && perfFinishes.get() == 1, "perf finished exactly once");
            check(replies.get() == (cancelWhileRunning ? 0 : 1), "no reply after running cancellation");
        } finally {
            release.countDown(); pool.shutdownNow();
            check(pool.awaitTermination(3, TimeUnit.SECONDS), "worker did not stop");
        }
    }

    private static void await(CountDownLatch latch) {
        try { if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("latch timed out"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
