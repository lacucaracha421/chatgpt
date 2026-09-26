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
}
