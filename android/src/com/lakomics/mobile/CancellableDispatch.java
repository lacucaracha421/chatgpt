package com.lakomics.mobile;

import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.function.Consumer;
import java.util.concurrent.atomic.AtomicBoolean;

/** Queue removal and completion shared by bridge dispatch and platform-free tests. */
final class CancellableDispatch implements Runnable {
    interface Cancellation {
        boolean isCanceled();
        void setListener(Runnable listener);
    }

    interface Preparation { void run() throws Exception; }

    private final Cancellation cancellation;
    private final Runnable body;
    private final Consumer<String> cleanup;
    private final AtomicBoolean finished = new AtomicBoolean();

    CancellableDispatch(Cancellation cancellation, Runnable body, Consumer<String> cleanup) {
        this.cancellation = cancellation;
        this.body = body;
        this.cleanup = cleanup;
    }

    @Override public void run() {
        try { body.run(); }
        finally { finish(cancellation.isCanceled() ? "canceled" : null); }
    }

    private void finish(String status) {
        if (finished.compareAndSet(false, true)) cleanup.accept(status);
    }

    void submit(ThreadPoolExecutor executor, boolean removeOnCancel) {
        if (cancellation.isCanceled()) { finish("canceled"); return; }
        if (removeOnCancel) cancellation.setListener(() -> {
            if (executor.remove(this)) finish("canceled");
        });
        // Registration may synchronously report cancellation before this task is queued.
        if (cancellation.isCanceled()) { finish("canceled"); return; }
        try {
            executor.execute(this);
            // Cancellation can also land between the check above and execute's enqueue.
            // Successful removal owns cleanup; otherwise the worker owns it in finally.
            if (removeOnCancel && cancellation.isCanceled() && executor.remove(this)) finish("canceled");
        }
        catch (RejectedExecutionException e) {
            if (removeOnCancel) cancellation.setListener(null);
            boolean canceled = cancellation.isCanceled();
            finish(canceled ? "canceled" : "rejected");
            if (!canceled) throw e;
        }
    }

    /** Prepare in FIFO order before taking a download slot; cancellation follows the current queue. */
    void submitPrepared(ThreadPoolExecutor preparing, ThreadPoolExecutor executor,
                        Preparation preparation, Consumer<Exception> failure) {
        AtomicBoolean handedOff = new AtomicBoolean();
        CancellableDispatch admission = new CancellableDispatch(cancellation, () -> {
            try { preparation.run(); }
            catch (Exception e) {
                try { if (!cancellation.isCanceled()) failure.accept(e); }
                finally { finish(cancellation.isCanceled() ? "canceled" : null); }
                return;
            }
            // From here the download dispatch owns cleanup, including cancellation/rejection
            // during submit. The preparation stage must not close a running worker's ticket.
            handedOff.set(true);
            try { submit(executor, true); }
            catch (RejectedExecutionException e) { if (!cancellation.isCanceled()) failure.accept(e); }
        }, status -> { if (!handedOff.get()) finish(status); });
        admission.submit(preparing, true);
    }
}
