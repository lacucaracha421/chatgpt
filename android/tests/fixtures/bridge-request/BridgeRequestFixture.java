package com.lakomics.mobile;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Boundary doubles around the production request admission and CancellableDispatch. */
public final class BridgeRequestFixture {
    static final class LibraryDocumentsProvider { static final Object CONNECTION_LOCK = new Object(); }
    final ThreadPoolExecutor workers = pool(), mediaWorkers = pool(), thumbnailWorkers = pool(), catalogCoverWorkers = pool(), thumbnailPrepare = pool();
    final ConcurrentHashMap<String, CancellationSignal> active = new ConcurrentHashMap<>(), nonEssential = new ConcurrentHashMap<>();
    final PerfLog.Pool perfPool = new PerfLog.Pool();
    final Vault vault = new Vault();
    final Web web = new Web();
    final MediaRepository media = new MediaRepository();
    boolean destroyed, stopped;
    final AtomicInteger replies = new AtomicInteger();
    static ThreadPoolExecutor pool() { return new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(48)); }
    static boolean optionalWork(String operation) { return "thumbnail".equals(operation); }
    void cancelOptional(String id, CancellationSignal signal) { signal.cancel(); nonEssential.remove(id, signal); }
    void runOnUiThread(Runnable task) { task.run(); }
    void reply(String id, boolean ok, Object data, String error) { replies.incrementAndGet(); }
    void reply(String id, boolean ok, Object data, String error, Object status, Object detail) { replies.incrementAndGet(); }
    String errorMessage(Exception e) { return "fixture"; }
    Object mediaBusy() { return "media_busy"; }
    void runDownload(String id, CancellationSignal signal, MediaRepository.PreparedThumbnail[] prepared) {
        signal.throwIfCanceled();
        check(prepared[0] != null, "download must receive its prepared ticket");
        replies.incrementAndGet();
    }
    // REQUEST_METHOD

    public static void run() throws Exception {
        lockScenario(false);
        lockScenario(true);
    }
    private static void lockScenario(boolean activityLock) throws Exception {
        BridgeRequestFixture bridge = new BridgeRequestFixture();
        Object lock = activityLock ? bridge : LibraryDocumentsProvider.CONNECTION_LOCK;
        CountDownLatch held = new CountDownLatch(1), release = new CountDownLatch(1);
        ExecutorService caller = Executors.newSingleThreadExecutor();
        Thread holder = new Thread(() -> { synchronized (lock) { held.countDown(); await(release); } });
        holder.start(); await(held);
        try {
            Future<Long> call = caller.submit(() -> {
                long start = System.nanoTime();
                bridge.request("0", "thumbnail", "{\"assetId\":\"0\"}");
                return System.nanoTime() - start;
            });
            long elapsed = call.get(100, TimeUnit.MILLISECONDS);
            check(elapsed < TimeUnit.MILLISECONDS.toNanos(50), "request must return promptly while another thread holds the lock");
            if (!activityLock) {
                await(bridge.media.entered);
                for (int i = 1; i < 12; i++) bridge.request("" + i, "thumbnail", "{\"assetId\":\"" + i + "\"}");
                bridge.active.get("1").cancel();
                check(!bridge.active.containsKey("1"), "queued canceled request must release its active entry");
            }
            release.countDown(); holder.join(3000);
            bridge.thumbnailPrepare.shutdown(); check(bridge.thumbnailPrepare.awaitTermination(3, TimeUnit.SECONDS), "preparation hung");
            bridge.thumbnailWorkers.shutdown(); check(bridge.thumbnailWorkers.awaitTermination(3, TimeUnit.SECONDS), "download hung");
            List<String> expected = new ArrayList<>();
            for (int i = 0; i < (activityLock ? 1 : 12); i++) if (i != 1) expected.add("" + i);
            check(bridge.media.order.equals(expected), "ticket order changed or canceled tile was prepared");
            check(bridge.media.closed.get() == expected.size(), "every prepared ticket must close exactly once");
            check(bridge.replies.get() == expected.size(), "unexpected replies");
            check(bridge.active.isEmpty() && bridge.nonEssential.isEmpty(), "request maps leaked");
            check(bridge.vault.epochs.get() == 0, "media admission must not acquire the vault monitor");
            System.out.printf("request(thumbnail), %s held: %.3f ms%n", activityLock ? "activity monitor" : "CONNECTION_LOCK", elapsed / 1_000_000.0);
        } finally {
            release.countDown(); holder.join(3000); caller.shutdownNow();
            for (ThreadPoolExecutor pool : new ThreadPoolExecutor[]{bridge.workers, bridge.mediaWorkers, bridge.thumbnailWorkers, bridge.catalogCoverWorkers, bridge.thumbnailPrepare}) {
                pool.shutdownNow(); check(pool.awaitTermination(3, TimeUnit.SECONDS), "fixture worker did not stop");
            }
            check(caller.awaitTermination(3, TimeUnit.SECONDS), "caller did not stop");
        }
    }
    static final class CancellationSignal implements CancellableDispatch.Cancellation {
        private volatile boolean canceled;
        private Runnable listener;
        public boolean isCanceled() { return canceled; }
        public void setListener(Runnable value) { setOnCancelListener(value); }
        void setOnCancelListener(Runnable value) { synchronized (this) { listener = value; } if (canceled && value != null) value.run(); }
        void cancel() { Runnable value; synchronized (this) { canceled = true; value = listener; } if (value != null) value.run(); }
        void throwIfCanceled() { if (canceled) throw new CancellationException(); }
    }
    static final class MediaRepository {
        final CountDownLatch entered = new CountDownLatch(1);
        final List<String> order = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger closed = new AtomicInteger();
        PreparedThumbnail prepareThumbnail(String id, String revision, CancellationSignal signal) {
            signal.throwIfCanceled(); entered.countDown();
            synchronized (LibraryDocumentsProvider.CONNECTION_LOCK) { signal.throwIfCanceled(); order.add(id); return new PreparedThumbnail(); }
        }
        final class PreparedThumbnail { void close() { closed.incrementAndGet(); } }
    }
    static final class PerfLog {
        static boolean enabled() { return false; }
        static void javascript(String payload) { throw new AssertionError("disabled logging ran"); }
        static final class Op { String status; void finish(String payload) {} }
        static final class Pool { Op submit(String operation, int queued) { return null; } void remove(Op op) {} }
    }
    static final class StartupPerf {
        static Request submit(String operation, String payload, ThreadPoolExecutor executor, String lane) { return null; }
        static final class Request { void finish(String status) {} }
    }
    static final class Vault {
        final AtomicInteger epochs = new AtomicInteger();
        synchronized long epoch() { epochs.incrementAndGet(); return 0; }
        void lock(String reason) {} void setVisible(boolean visible) {} Object inspect() { return null; }
        Object state() throws JSONException { return null; }
    }
    static final class View { static final int IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS = 0, IMPORTANT_FOR_AUTOFILL_AUTO = 1; }
    static final class Web { void setImportantForAutofill(int value) {} }
    static final class JSONException extends Exception { JSONException(Throwable cause) { super(cause); } }
    static final class JSONObject {
        final Map<?, ?> value;
        JSONObject(String payload) throws JSONException { try { value = (Map<?, ?>) Json.parse(payload); } catch (Exception e) { throw new JSONException(e); } }
        String getString(String key) { return (String) value.get(key); }
        String optString(String key) { return optString(key, ""); }
        String optString(String key, String fallback) { Object item = value.get(key); return item instanceof String ? (String) item : fallback; }
        boolean getBoolean(String key) throws JSONException { return Boolean.TRUE.equals(value.get(key)); }
    }
    static void await(CountDownLatch latch) {
        try { check(latch.await(3, TimeUnit.SECONDS), "latch timed out"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
    }
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
