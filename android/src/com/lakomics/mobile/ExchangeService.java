package com.lakomics.mobile;

import android.content.*;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * File exchange (보내기/받기) for this device: registration, the inbox/outbox view, automatic
 * receive into `Download/Lakomics/` and sending picked or shared files.
 *
 * Everything is foreground-only. Arrivals are noticed through the `exchange.revision` field
 * of the `/v1/sync/status` read the Library pass already makes ({@link #observeStatus}) and of
 * the foreground status long-poll; the open 보내기/받기 screen adds a 5 s inbox/outbox refresh
 * only while that long-poll is not live ({@link #setStatusLive}). A revision is a change hint,
 * not evidence that outstanding work succeeded: a failed arrival read and an unsent
 * acknowledgement each retry on their own deadline (5/15/60 s, capped at 60 s) while the app is
 * in the foreground, whether or not the screen is open. Nothing is polled, retried or started
 * while the activity is paused; a transfer already moving is allowed to finish.
 *
 * Receiving is crash-consistent: the hidden Downloads entry is journaled in the ledger before a
 * byte is written, the receipt is durable before the acknowledgement, and a publication a crash
 * interrupted is finished or cleaned on the next start ({@link #recoverPublications}).
 *
 * The exchange refuses the shared Library token, so this device keeps a second, device-only
 * token ({@link SecureSettings#exchangeToken}) and a client-generated device id.
 */
final class ExchangeService {
    interface Listener { void event(String name, JSONObject detail); }

    /** A failure whose message is already fit to show. */
    static final class UserError extends Exception { UserError(String message) { super(message); } }

    static final String EVENT = "lakomics-exchange";
    static final String ARRIVED = "lakomics-exchange-arrived";
    private static final String DOWNLOAD_FOLDER = Environment.DIRECTORY_DOWNLOADS + "/Lakomics/";
    private static final long VISIBLE_POLL_MILLIS = 5_000;
    private static final int MAX_BATCH = 100;
    private static final int AUTO_RETRIES = 4;

    private static ExchangeService instance;
    static synchronized ExchangeService get(Context context) {
        if (instance == null) instance = new ExchangeService(context.getApplicationContext());
        return instance;
    }

    /** One transfer as this device sees it. */
    private static final class Row {
        String id, batchId, name, peerId, peer = "", state, code = "", sha, hint, uri, created;
        /** 폴더 보내기: the temporary zip this send uploads, deleted once the send is settled. */
        String zip;
        int skipped;
        long size = -1, bytes;
        boolean incoming, persistable, freshId;
        volatile boolean cancelled;
        int attempts;
    }

    private final Context context;
    private final SecureSettings settings;
    private final CloudClient client;
    private final SharedPreferences preferences;
    private final ConditionalRead conditional = new ConditionalRead();
    private final ScheduledExecutorService net = executor("lakomics-exchange");
    private final ScheduledExecutorService emitter = executor("lakomics-exchange-events");
    private final ExecutorService downloads = executor("lakomics-exchange-receive");
    private final ExecutorService uploads = executor("lakomics-exchange-send");
    private final ExecutorService zips = executor("lakomics-exchange-zip");
    private final CopyOnWriteArraySet<Listener> listeners = new CopyOnWriteArraySet<>();

    private final LinkedHashMap<String, Row> incoming = new LinkedHashMap<>();
    private final LinkedHashMap<String, Row> outgoing = new LinkedHashMap<>();
    private final Set<String> announced = new HashSet<>();
    private final Set<String> queued = new HashSet<>();
    private final Set<String> deferred = new HashSet<>();
    private JSONArray outbox = new JSONArray();
    private JSONArray devices = new JSONArray();
    private ExchangeTransfer.Ledger ledger;
    /** Written synchronously: the ledger is what prevents a second copy after a crash. */
    private final ExchangeTransfer.Journal journal;
    private final ExchangeTransfer.Destination destination = new Downloads();
    private String code = "";
    private String registeredKey = "";
    private final ExchangeRefreshState refreshState = new ExchangeRefreshState();
    private int unseen;
    /** Resumed Lakomics activities (the main app and the share sheet). */
    private int resumed;
    private boolean foreground, visible, refreshing, refreshAgain, refreshDevices, emitScheduled, statusLive;
    private long lastEmit;
    private ScheduledFuture<?> poll, refreshRetry, ackRetry;
    /** Advances on every reset so work started for a replaced connection records nothing. */
    private int epoch;

    private static ScheduledExecutorService executor(String name) {
        return Executors.newSingleThreadScheduledExecutor(task -> { Thread t = new Thread(task, name); t.setDaemon(true); return t; });
    }

    private ExchangeService(Context context) {
        this.context = context;
        settings = new SecureSettings(context);
        client = new CloudClient(settings);
        preferences = context.getSharedPreferences("exchange", 0);
        journal = encoded -> preferences.edit().putString("ledger", encoded).commit();
        ledger = ExchangeTransfer.Ledger.decode(preferences.getString("ledger", null));
        if (ledger.prune(System.currentTimeMillis())) saveLedger();
        restoreSends();
        sweepZips();
        // Before any new receive: the downloads worker runs one task at a time.
        try { downloads.execute(this::recoverPublications); } catch (RejectedExecutionException ignored) {}
    }

    static boolean receiveSupported() { return Build.VERSION.SDK_INT >= 29; }

    // --- identity and connection --------------------------------------------------

    String deviceId() {
        synchronized (preferences) {
            String id = preferences.getString("deviceId", null);
            if (!ExchangeTransfer.uuid(id)) {
                id = UUID.randomUUID().toString();
                preferences.edit().putString("deviceId", id).commit();
            }
            return id;
        }
    }

    private String deviceName() {
        String name = null;
        try { name = android.provider.Settings.Global.getString(context.getContentResolver(), "device_name"); } catch (RuntimeException ignored) {}
        if (name == null || name.trim().isEmpty()) name = Build.MODEL;
        return name == null || name.trim().isEmpty() ? "Android" : name.trim();
    }

    /** The device-token connection for the configured endpoint, or null without one. */
    JSONObject connection() throws Exception {
        JSONObject library = settings.read();
        return library.has("token") ? statusConnection(library) : null;
    }

    /** Same endpoint as `library`, device token instead of the shared one; null if none is stored. */
    JSONObject statusConnection(JSONObject library) throws Exception {
        String endpoint = library.optString("endpoint", "");
        if (endpoint.isEmpty()) return null;
        String token = settings.exchangeToken(endpoint);
        return token.isEmpty() ? null : new JSONObject().put("endpoint", endpoint).put("token", token);
    }

    private JSONObject call(JSONObject connection, String path, String method, JSONObject body) throws Exception {
        ConditionalRead.Reply reply = client.exchange(connection, deviceId(), path, method, body, null, null);
        return new JSONObject(reply.body);
    }

    private JSONObject read(JSONObject connection, String path) throws Exception {
        String scope = ThumbnailCache.key(connection.getString("endpoint") + "\n" + connection.getString("token") + "\n" + deviceId());
        return new JSONObject(conditional.get(scope, path, etag -> client.exchange(connection, deviceId(), path, "GET", null, null, etag)));
    }

    /** Every inbox page, oldest first: the server pages 100 at a time and returns {@code nextCursor} until the last one. */
    private JSONArray readInbox(JSONObject connection) throws Exception {
        JSONArray all = new JSONArray();
        String path = "/v1/exchange/inbox";
        for (int page = 0; page < 20; page++) {
            JSONObject body = read(connection, path);
            JSONArray items = body.getJSONArray("items");
            for (int i = 0; i < items.length(); i++) all.put(items.get(i));
            String next = body.isNull("nextCursor") ? "" : body.optString("nextCursor", "");
            if (next.isEmpty()) break;
            path = "/v1/exchange/inbox?after=" + java.net.URLEncoder.encode(next, "UTF-8");
        }
        return all;
    }

    private void register(JSONObject connection) throws Exception {
        String key = ThumbnailCache.key(connection.getString("endpoint") + "\n" + connection.getString("token") + "\n" + deviceId());
        synchronized (this) { if (key.equals(registeredKey)) return; }
        call(connection, "/v1/exchange/devices/" + deviceId(), "PUT", new JSONObject().put("name", deviceName()).put("kind", "android"));
        synchronized (this) { registeredKey = key; }
    }

    /**
     * Store (or, when empty, remove) this device's exchange token. A token is kept only after
     * the server accepted it for registration, so a shared or mistyped token never replaces a
     * working one.
     */
    JSONObject setToken(String token) throws Exception {
        JSONObject library = settings.read();
        if (!library.has("token")) throw new IllegalStateException("Not configured");
        String endpoint = library.getString("endpoint");
        if (token.isEmpty()) {
            settings.writeExchangeToken(endpoint, "");
            reset();
            return snapshot();
        }
        SecureSettings.validateToken(token);
        JSONObject candidate = new JSONObject().put("endpoint", endpoint).put("token", token);
        synchronized (this) { registeredKey = ""; }
        register(candidate);
        settings.writeExchangeToken(endpoint, token);
        synchronized (this) { code = ""; }
        requestRefresh(true);
        return snapshot();
    }

    /** A connection change: forget everything learned from the previous server or token. */
    void reset() {
        synchronized (this) {
            epoch++;
            stopRefreshRetry();
            stopAckRetry();
            for (Row row : incoming.values()) row.cancelled = true;
            for (Row row : outgoing.values()) row.cancelled = true;
            for (Row row : outgoing.values()) discard(row);
            incoming.clear(); outgoing.clear(); queued.clear(); deferred.clear(); announced.clear();
            outbox = new JSONArray(); devices = new JSONArray();
            registeredKey = ""; code = ""; refreshState.reset(); unseen = 0;
            conditional.clear();
            preferences.edit().remove("sends").commit();
        }
        changed();
    }

    // --- foreground -------------------------------------------------------------------

    void addListener(Listener listener) { listeners.add(listener); }
    void removeListener(Listener listener) { listeners.remove(listener); }

    /** Each Lakomics activity reports resume (true) and pause (false). */
    void setForeground(boolean value) {
        List<String> retry;
        synchronized (this) {
            resumed = Math.max(0, resumed + (value ? 1 : -1));
            foreground = resumed > 0;
            if (!foreground) { stopPoll(); stopRefreshRetry(); stopAckRetry(); return; }
            if (visible) startPoll();
            scheduleRefreshRetry();
            retry = new ArrayList<>(deferred);
            deferred.clear();
        }
        // Acknowledgements owed from before a pause or a restart.
        requestAcks();
        for (String id : retry) resume(id);
    }

    /** The 보내기/받기 screen opened or closed. Open: clear the badge and refresh every 5 s. */
    void setVisible(boolean value) {
        synchronized (this) {
            visible = value;
            if (value) { unseen = 0; if (foreground) startPoll(); }
            // A pending inbox retry keeps its own deadline when the screen closes.
            else stopPoll();
        }
        if (value) requestRefresh(true);
        changed();
    }

    /**
     * The status long-poll is live and carries this device's `exchange.revision`: every
     * inbox/outbox change then arrives through {@link #observeStatus} within about a second, so
     * the open screen's 5 s refresh stops. Losing it restores the refresh.
     */
    void setStatusLive(boolean value) {
        synchronized (this) {
            if (statusLive == value) return;
            statusLive = value;
            if (value) stopPoll();
            else if (foreground && visible) startPoll();
        }
    }

    private void startPoll() {
        if (poll != null || statusLive) return;
        poll = net.scheduleWithFixedDelay(() -> {
            synchronized (this) { if (!foreground || !visible) return; }
            refresh(false);
        }, VISIBLE_POLL_MILLIS, VISIBLE_POLL_MILLIS, TimeUnit.MILLISECONDS);
    }

    private void stopPoll() { if (poll != null) { poll.cancel(false); poll = null; } }

    /** Called with the service monitor held; only one foreground inbox retry can be queued. */
    private void scheduleRefreshRetry() {
        long delay = refreshState.retryDelay(foreground);
        if (delay < 0 || refreshRetry != null) return;
        refreshRetry = net.schedule(() -> {
            synchronized (this) {
                refreshRetry = null;
                if (refreshState.retryDelay(foreground) < 0 || refreshing) return;
                refreshDevices = true;
            }
            refresh(false);
        }, delay, TimeUnit.MILLISECONDS);
    }

    private void stopRefreshRetry() {
        if (refreshRetry != null) { refreshRetry.cancel(false); refreshRetry = null; }
    }

    /** The Library pass read `/v1/sync/status`; a moved exchange revision means something changed. */
    void observeStatus(String status) {
        long next;
        try {
            JSONObject exchange = new JSONObject(status).optJSONObject("exchange");
            if (exchange == null) return;
            next = exchange.getLong("revision");
        } catch (JSONException ignored) { return; }
        synchronized (this) {
            if (!foreground || (refreshing && next == refreshState.revision())) return;
            if (!refreshState.observe(next)) return;
            stopRefreshRetry();
        }
        requestRefresh(true);
    }

    // --- refresh ------------------------------------------------------------------------

    void requestRefresh(boolean withDevices) {
        synchronized (this) {
            if (!foreground) return;
            if (withDevices) refreshDevices = true;
            if (refreshing) { refreshAgain = true; return; }
            refreshing = true;
        }
        try { net.execute(() -> refresh(true)); }
        catch (RejectedExecutionException ignored) { synchronized (this) { refreshing = false; } }
    }

    /** Refresh on the calling thread (a bridge request) and return the new snapshot. */
    JSONObject refreshNow() throws Exception {
        synchronized (this) { refreshDevices = true; }
        JSONObject connection = connection();
        if (connection == null) return snapshot();
        pass(connection, true);
        return snapshot();
    }

    private void refresh(boolean owned) {
        try {
            synchronized (this) { if (!foreground) return; }
            JSONObject connection = connection();
            if (connection == null) { synchronized (this) { code = "tokenMissing"; } changed(); }
            else pass(connection, false);
        } catch (Exception e) {
            synchronized (this) { code = failureCode(e); if ("exchangeDeviceUnknown".equals(code)) registeredKey = ""; }
            changed();
        } finally {
            if (owned) {
                boolean again;
                synchronized (this) { again = refreshAgain && foreground; refreshAgain = false; refreshing = again; }
                if (again) try { net.execute(() -> refresh(true)); } catch (RejectedExecutionException ignored) { synchronized (this) { refreshing = false; } }
            }
        }
    }

    private void pass(JSONObject connection, boolean rethrow) throws Exception {
        int started;
        long startedRevision;
        synchronized (this) {
            if (!foreground) return;
            started = epoch; startedRevision = refreshState.revision();
        }
        try {
            register(connection);
            boolean withDevices;
            synchronized (this) { withDevices = refreshDevices || devices.length() == 0; refreshDevices = false; }
            JSONArray nextDevices = withDevices ? read(connection, "/v1/exchange/devices").getJSONArray("devices") : null;
            JSONArray inbox = readInbox(connection);
            JSONArray nextOutbox = read(connection, "/v1/exchange/outbox").getJSONArray("items");
            synchronized (this) {
                if (started != epoch) return;
                if (nextDevices != null) devices = nextDevices;
                outbox = nextOutbox;
                code = "";
                // Local send rows the server now reports are retired in favour of its state.
                for (int i = 0; i < nextOutbox.length(); i++) {
                    Row local = outgoing.get(nextOutbox.getJSONObject(i).getString("transferId"));
                    if (local != null && Arrays.asList("ready", "delivered", "cancelled").contains(local.state)) outgoing.remove(local.id);
                }
            }
            applyInbox(inbox, started);
            synchronized (this) {
                if (started == epoch) {
                    refreshState.succeeded(startedRevision);
                    if (!refreshState.pending()) stopRefreshRetry();
                }
            }
        } catch (Exception e) {
            synchronized (this) {
                if (started == epoch) {
                    code = failureCode(e);
                    if ("exchangeDeviceUnknown".equals(code)) registeredKey = "";
                    refreshState.failed(startedRevision);
                    scheduleRefreshRetry();
                }
            }
            changed();
            if (rethrow) throw e;
            return;
        }
        changed();
    }

    private void applyInbox(JSONArray items, int started) throws JSONException {
        int fresh = 0;
        String fromName = "", fromKind = "";
        List<Row> receive = new ArrayList<>();
        boolean ackDue = false;
        synchronized (this) {
            if (started != epoch) return;
            Set<String> present = new HashSet<>();
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.getJSONObject(i);
                String id = item.getString("transferId");
                if (!ExchangeTransfer.uuid(id)) continue;
                present.add(id);
                Row row = incoming.get(id);
                if (row == null) {
                    row = new Row();
                    row.id = id; row.incoming = true; row.state = "waiting";
                    row.batchId = item.optString("batchId", id);
                    row.name = item.optString("fileName", "file");
                    row.size = item.optLong("sizeBytes", 0);
                    row.sha = item.optString("sha256", "");
                    row.hint = item.isNull("contentTypeHint") ? null : item.optString("contentTypeHint", null);
                    row.peerId = item.optString("fromDevice", "");
                    row.peer = item.isNull("fromName") ? "" : item.optString("fromName", "");
                    row.created = item.optString("createdAt", "");
                    if (ledger.saved(id)) row.state = "saved";
                    incoming.put(id, row);
                }
                // Saved before: never save twice, only repeat the lost ack.
                if (ledger.saved(id)) { ledger.withSha(id, row.sha); ackDue = true; continue; }
                if (announced.add(id)) { fresh++; fromName = row.peer; fromKind = kindOf(row.peerId); }
                if ("waiting".equals(row.state) && receiveSupported() && foreground) receive.add(row);
            }
            for (Iterator<Row> it = incoming.values().iterator(); it.hasNext(); ) {
                Row row = it.next();
                if (present.contains(row.id)) continue;
                if ("waiting".equals(row.state) || "saved".equals(row.state)) it.remove();
                else if ("failed".equals(row.state)) { row.state = "expired"; row.code = "transferGone"; }
            }
            if (fresh > 0 && !visible) unseen += fresh;
            // Respects a running ack backoff; an idle queue is flushed at once.
            if (ackDue) scheduleAckRetry();
        }
        for (Row row : receive) enqueueReceive(row);
        if (fresh > 0) {
            try { emit(ARRIVED, new JSONObject().put("count", fresh).put("fromName", fromName).put("fromKind", fromKind)); }
            catch (JSONException ignored) {}
        }
    }

    private String kindOf(String deviceId) {
        for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device != null && deviceId.equals(device.optString("deviceId"))) return device.optString("kind", "");
        }
        return "";
    }

    private String nameOf(String deviceId) {
        for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device != null && deviceId.equals(device.optString("deviceId"))) return device.optString("name", "");
        }
        return "";
    }

    // --- receive ------------------------------------------------------------------------

    private void enqueueReceive(Row row) {
        synchronized (this) { if (!queued.add(row.id)) return; }
        try { downloads.execute(() -> { try { receive(row); } finally { synchronized (this) { queued.remove(row.id); } } }); }
        catch (RejectedExecutionException e) { synchronized (this) { queued.remove(row.id); } }
    }

    private void receive(Row row) {
        int started;
        synchronized (this) {
            started = epoch;
            // Nothing new starts while the app is in the background; resume picks it up.
            if (!foreground) { deferred.add(row.id); return; }
        }
        if (row.cancelled) return;
        File part = new File(new File(context.getCacheDir(), "exchange"), row.id + ".part");
        try {
            JSONObject connection = connection();
            if (connection == null) return;
            ExchangeTransfer.Ledger.Entry journaled = ledger.get(row.id);
            if (journaled != null && !journaled.publishing) { requestAcks(); return; }
            if (journaled != null) {
                // An interrupted publication: finish that same destination, or clean it and receive again.
                if (!receiveSupported()) throw new UserError("unsupported");
                update(row, "saving", "");
                if (ledger.recover(journal, destination, journaled) != null) { saved(row, part, started); return; }
            }
            update(row, "downloading", "");
            part.getParentFile().mkdirs();
            // The part file and the Downloads copy both need room. 0 means "unknown", not "full".
            long missing = row.size - (part.exists() ? part.length() : 0);
            long cacheFree = part.getParentFile().getUsableSpace(), sharedFree = Environment.getExternalStorageDirectory().getUsableSpace();
            if ((cacheFree > 0 && cacheFree < missing + 64L * 1024 * 1024) || (sharedFree > 0 && sharedFree < row.size + 16L * 1024 * 1024))
                throw new UserError("noSpace");
            for (int attempt = 0; ; attempt++) {
                JSONObject ticket = call(connection, "/v1/exchange/transfers/" + row.id + "/ticket", "POST", new JSONObject());
                long size = ticket.getLong("sizeBytes");
                String sha = ticket.getString("sha256");
                row.size = size; row.sha = sha;
                try {
                    ExchangeTransfer.download(ticket.getString("url"), part, size, sha, (done, total) -> { row.bytes = done; changed(); }, () -> row.cancelled);
                    break;
                } catch (ExchangeTransfer.StorageStatus expired) {
                    // An expired or refused presigned URL: one fresh ticket, then report.
                    if (attempt > 0 || !(expired.status == 400 || expired.status == 403)) throw expired;
                }
            }
            // Declined, withdrawn or reset while downloading: nothing reaches Downloads.
            synchronized (this) {
                if (row.cancelled || started != epoch) { part.delete(); return; }
                row.state = "saving"; row.code = "";
            }
            changed();
            if (!receiveSupported()) throw new UserError("unsupported");
            // Whatever happens meanwhile, a published copy is always recorded (journal first,
            // receipt before the ack), so a later sighting acks instead of saving a second copy.
            ledger.publish(journal, destination, row.id, part, ExchangeTransfer.fileName(row.name), row.hint,
                    row.size, row.sha, row.peer, System.currentTimeMillis());
            rememberReceived(row);
            saved(row, part, started);
        } catch (Exception e) {
            if (row.cancelled) { part.delete(); return; }
            String reason = failureCode(e);
            if ("transferGone".equals(reason) || "transferUnknown".equals(reason)) {
                part.delete();
                row.state = "cancelled".equals(goneState(e)) ? "cancelled" : "expired";
                row.code = reason;
                changed();
                return;
            }
            fail(row, reason, () -> enqueueReceive(row));
        }
    }

    /** The receipt is durable: the row leaves the inbox list and its acknowledgement is owed. */
    private void saved(Row row, File part, int started) {
        boolean current;
        synchronized (this) { current = started == epoch; incoming.remove(row.id); }
        part.delete();
        changed();
        if (current) requestAcks();
    }

    /**
     * Start-up: finish or clean each publication a crash interrupted, then remove hidden
     * Downloads entries of ours that no journal refers to (a crash between creating one and
     * journaling it). Runs on the downloads worker, so no publication is in progress.
     */
    private void recoverPublications() {
        if (!receiveSupported()) return;
        boolean recovered = false;
        for (ExchangeTransfer.Ledger.Entry entry : ledger.publishing()) {
            try { recovered |= ledger.recover(journal, destination, entry) != null; }
            catch (Exception kept) { /* The journal stays; the transfer's next sighting tries again. */ }
        }
        Set<Long> journaled = new HashSet<>();
        for (ExchangeTransfer.Ledger.Entry entry : ledger.publishing()) {
            try { journaled.add(ContentUris.parseId(Uri.parse(entry.uri))); }
            catch (RuntimeException unknown) { return; /* Never guess which entry is ours. */ }
        }
        sweepPending(journaled);
        if (recovered) { changed(); requestAcks(); }
    }

    private void sweepPending(Set<Long> keep) {
        ContentResolver resolver = context.getContentResolver();
        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String selection = MediaStore.MediaColumns.IS_PENDING + "=1 AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=? AND "
                + MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=?";
        List<Uri> orphans = new ArrayList<>();
        try (Cursor cursor = queryIncludingPending(collection, new String[]{MediaStore.MediaColumns._ID}, selection,
                new String[]{DOWNLOAD_FOLDER, context.getPackageName()})) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                long id = cursor.getLong(0);
                if (!keep.contains(id)) orphans.add(ContentUris.withAppendedId(collection, id));
            }
        } catch (RuntimeException unreadable) { return; }
        for (Uri orphan : orphans) try { resolver.delete(orphan, null, null); } catch (RuntimeException ignored) {}
    }

    /** A MediaStore query that also sees this app's hidden (pending) entries. */
    @SuppressWarnings("deprecation")
    private Cursor queryIncludingPending(Uri uri, String[] columns, String selection, String[] args) {
        ContentResolver resolver = context.getContentResolver();
        if (Build.VERSION.SDK_INT >= 30) {
            android.os.Bundle query = new android.os.Bundle();
            query.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE);
            if (selection != null) {
                query.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
                query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
            }
            return resolver.query(uri, columns, query, null);
        }
        return resolver.query(MediaStore.setIncludePending(uri), columns, selection, args, null);
    }

    // --- acknowledgements -----------------------------------------------------------

    /** Send every owed acknowledgement now (foreground only); failures retry on their own deadline. */
    private void requestAcks() {
        synchronized (this) {
            if (!foreground) return;
            stopAckRetry();
        }
        try { net.execute(this::flushAcks); } catch (RejectedExecutionException ignored) {}
    }

    /** Called with the service monitor held; only one acknowledgement round can be queued. */
    private void scheduleAckRetry() {
        long delay = refreshState.ackDelay(foreground, !ledger.unacked().isEmpty());
        if (delay < 0 || ackRetry != null) return;
        try {
            ackRetry = net.schedule(() -> { synchronized (this) { ackRetry = null; } flushAcks(); }, delay, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {}
    }

    private void stopAckRetry() {
        if (ackRetry != null) { ackRetry.cancel(false); ackRetry = null; }
    }

    /**
     * Tell each sender's server row that its file is saved; the server then deletes its object.
     * Only durable receipts are acknowledged, and they persist across restarts with their digest.
     */
    private void flushAcks() {
        int started;
        synchronized (this) { if (!foreground) return; started = epoch; }
        List<ExchangeTransfer.Ledger.Entry> owed = ledger.unacked();
        boolean failed = false;
        if (!owed.isEmpty()) {
            JSONObject connection;
            try { connection = connection(); } catch (Exception unreadable) { connection = null; failed = true; }
            // Without this device's token nothing can be acknowledged; saving one refreshes.
            if (connection == null && !failed) return;
            if (connection != null) for (ExchangeTransfer.Ledger.Entry entry : owed) {
                synchronized (this) { if (!foreground || started != epoch) return; }
                try {
                    call(connection, "/v1/exchange/transfers/" + entry.id + "/ack", "POST", new JSONObject().put("sha256", entry.sha256));
                    settleAck(entry.id);
                } catch (Exception e) {
                    String reason = failureCode(e);
                    // Already delivered, expired or withdrawn (or refused for good): nothing is left to acknowledge.
                    if (Arrays.asList("transferGone", "transferUnknown", "digestMismatch").contains(reason)) settleAck(entry.id);
                    else failed = true;
                }
            }
        }
        synchronized (this) {
            if (started != epoch) return;
            if (failed) refreshState.ackFailed(); else refreshState.acksSettled();
            scheduleAckRetry();
        }
        if (!owed.isEmpty()) changed();
    }

    private void settleAck(String id) {
        ledger.acked(id);
        saveLedger();
        synchronized (this) { incoming.remove(id); }
    }

    /** MediaStore `Download/Lakomics/`: hidden (IS_PENDING=1) while written, then revealed. */
    private final class Downloads implements ExchangeTransfer.Destination {
        private ContentResolver resolver() { return context.getContentResolver(); }

        public String create(String name, String hint) throws IOException {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime(name, hint));
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, DOWNLOAD_FOLDER);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri target;
            try { target = resolver().insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values); }
            catch (RuntimeException e) { throw new IOException("No download storage", e); }
            if (target == null) throw new IOException("No download storage");
            return target.toString();
        }

        public void write(String uri, File part) throws IOException {
            try (InputStream in = new FileInputStream(part); OutputStream out = resolver().openOutputStream(Uri.parse(uri), "w")) {
                if (out == null) throw new IOException("No download output");
                byte[] buffer = new byte[65536];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
        }

        public void reveal(String uri) throws IOException {
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            if (resolver().update(Uri.parse(uri), ready, null, null) != 1) throw new IOException("Cannot publish download");
        }

        public int state(String uri) throws IOException {
            try (Cursor cursor = queryIncludingPending(Uri.parse(uri), new String[]{MediaStore.MediaColumns.IS_PENDING}, null, null)) {
                if (cursor == null) throw new IOException("Downloads unreadable");
                if (!cursor.moveToFirst()) return GONE;
                return cursor.getInt(0) == 0 ? PUBLISHED : PENDING;
            } catch (RuntimeException e) {
                throw new IOException("Downloads unreadable", e);
            }
        }

        public boolean holds(String uri, long size, String sha256) throws IOException {
            try (InputStream in = resolver().openInputStream(Uri.parse(uri))) {
                if (in == null) return false;
                ExchangeTransfer.Digest digest = ExchangeTransfer.digest(in, null, null);
                return digest.size == size && digest.sha256.equals(sha256);
            } catch (FileNotFoundException | SecurityException gone) {
                return false;
            }
        }

        public void delete(String uri) {
            try { resolver().delete(Uri.parse(uri), null, null); } catch (RuntimeException ignored) {}
        }

        public String name(String uri, String fallback) {
            try (Cursor cursor = queryIncludingPending(Uri.parse(uri), new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null)) {
                if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) return cursor.getString(0);
            } catch (RuntimeException ignored) {}
            return fallback;
        }
    }

    static String mime(String name, String hint) {
        int dot = name.lastIndexOf('.');
        String extension = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String type = extension.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (type != null) return type;
        if (hint != null && hint.matches("[A-Za-z0-9!#$&^_.+-]{1,63}/[A-Za-z0-9!#$&^_.+-]{1,63}")) return hint.toLowerCase(Locale.ROOT);
        return "application/octet-stream";
    }

    /** The saved file for 열기, or a message when it is gone. */
    Uri savedUri(String id) throws UserError {
        ExchangeTransfer.Ledger.Entry entry;
        synchronized (this) { entry = ledger.get(id); }
        if (entry == null || entry.publishing || entry.uri.isEmpty()) throw new UserError("저장된 파일을 찾을 수 없습니다.");
        Uri uri = Uri.parse(entry.uri);
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{MediaStore.MediaColumns._ID}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new UserError("파일이 다운로드 폴더에 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.");
        } catch (RuntimeException e) {
            throw new UserError("파일이 다운로드 폴더에 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.");
        }
        return uri;
    }

    // --- send ----------------------------------------------------------------------------

    /** Queue files for `toDevice`. Returns the batch, whose rows then report through events. */
    JSONObject send(List<Uri> uris, String toDevice, boolean persistable) throws Exception {
        if (uris.isEmpty()) throw new UserError("보낼 파일이 없습니다.");
        if (uris.size() > MAX_BATCH) throw new UserError("한 번에 최대 " + MAX_BATCH + "개까지 보낼 수 있습니다.");
        if (!ExchangeTransfer.uuid(toDevice)) throw new UserError("받는 기기를 선택해 주세요.");
        if (connection() == null) throw new UserError("이 기기 전용 토큰이 필요합니다. Lakomics의 보내기/받기 화면에서 입력해 주세요.");
        String batch = UUID.randomUUID().toString();
        List<Row> rows = new ArrayList<>();
        ContentResolver resolver = context.getContentResolver();
        for (Uri uri : uris) {
            Row row = new Row();
            row.id = UUID.randomUUID().toString(); row.batchId = batch; row.uri = uri.toString(); row.peerId = toDevice;
            row.state = "preparing"; row.created = iso(System.currentTimeMillis());
            row.name = "file"; row.size = -1;
            try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    if (!cursor.isNull(0)) row.name = cursor.getString(0);
                    if (!cursor.isNull(1)) row.size = cursor.getLong(1);
                }
            } catch (RuntimeException ignored) { /* The pre-pass reads the real length. */ }
            try { row.hint = resolver.getType(uri); } catch (RuntimeException ignored) {}
            if (persistable) {
                try { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); row.persistable = true; }
                catch (RuntimeException ignored) { /* Readable for this session only. */ }
            }
            rows.add(row);
        }
        JSONArray ids = new JSONArray();
        synchronized (this) {
            for (Row row : rows) { row.peer = nameOf(toDevice); outgoing.put(row.id, row); ids.put(row.id); }
            saveSends();
        }
        changed();
        for (Row row : rows) enqueueUpload(row);
        return new JSONObject().put("batchId", batch).put("transferIds", ids);
    }

    private void enqueueUpload(Row row) {
        try { uploads.execute(() -> upload(row)); }
        catch (RejectedExecutionException e) { fail(row, "network", null); }
    }

    private void upload(Row row) {
        if (row.cancelled) return;
        ContentResolver resolver = context.getContentResolver();
        Uri uri = Uri.parse(row.uri);
        try {
            JSONObject connection = connection();
            if (connection == null) throw new UserError("tokenMissing");
            update(row, "preparing", "");
            ExchangeTransfer.Digest digest;
            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) throw new FileNotFoundException();
                digest = ExchangeTransfer.digest(in, (done, total) -> { row.bytes = done; changed(); }, () -> row.cancelled);
            } catch (SecurityException | FileNotFoundException unreadable) {
                throw new UserError("sourceUnavailable");
            } catch (IOException tooLarge) {
                if ("File too large".equals(tooLarge.getMessage())) throw new UserError("fileTooLarge");
                throw tooLarge;
            }
            synchronized (this) {
                // Different bytes under the same id would be refused as a reused transfer id.
                if (row.freshId || (row.sha != null && !row.sha.equals(digest.sha256))) renew(row);
                row.sha = digest.sha256; row.size = digest.size;
                saveSends();
            }
            // While the source is still readable: the timeline keeps showing it after the send.
            thumbnailOf(row.id, row.uri, row.name);
            JSONObject body = new JSONObject().put("transferId", row.id).put("batchId", row.batchId).put("toDevice", row.peerId)
                    .put("fileName", row.name).put("sizeBytes", row.size).put("sha256", row.sha);
            if (row.hint != null && row.hint.matches("[A-Za-z0-9!#$&^_.+-]{1,63}/[A-Za-z0-9!#$&^_.+-]{1,63}")) body.put("contentTypeHint", row.hint);
            JSONObject created = call(connection, "/v1/exchange/transfers", "POST", body);
            JSONObject upload = created.optJSONObject("upload");
            if (upload != null) {
                update(row, "uploading", "");
                row.bytes = 0;
                Map<String, String> headers = new HashMap<>();
                JSONObject required = upload.optJSONObject("requiredHeaders");
                if (required != null) for (Iterator<String> it = required.keys(); it.hasNext(); ) { String k = it.next(); headers.put(k, required.getString(k)); }
                try (InputStream in = resolver.openInputStream(uri)) {
                    if (in == null) throw new UserError("sourceUnavailable");
                    ExchangeTransfer.upload(upload.getString("url"), headers, in, row.size, (done, total) -> { row.bytes = done; changed(); }, () -> row.cancelled);
                } catch (SecurityException | FileNotFoundException unreadable) {
                    throw new UserError("sourceUnavailable");
                }
            } else if (!"uploading".equals(created.optString("state"))) {
                finishSend(row, created.optString("state"));
                return;
            }
            update(row, "completing", "");
            JSONObject done = call(connection, "/v1/exchange/transfers/" + row.id + "/complete", "POST", new JSONObject());
            finishSend(row, done.optString("state", "ready"));
            requestRefresh(false);
        } catch (Exception e) {
            if (row.cancelled) return;
            String reason = failureCode(e);
            if (Arrays.asList("sizeMismatch", "transferGone", "transferIdReused", "uploadMissing").contains(reason)) row.freshId = true;
            fail(row, reason, () -> enqueueUpload(row));
        }
    }

    private void renew(Row row) {
        outgoing.remove(row.id);
        row.id = UUID.randomUUID().toString();
        row.freshId = false;
        outgoing.put(row.id, row);
    }

    private void finishSend(Row row, String state) {
        synchronized (this) {
            row.state = state.isEmpty() ? "ready" : state; row.code = ""; row.attempts = 0;
            saveSends();
        }
        release(row);
        discard(row);
        changed();
    }

    private void release(Row row) {
        if (!row.persistable) return;
        try { context.getContentResolver().releasePersistableUriPermission(Uri.parse(row.uri), Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        catch (RuntimeException ignored) {}
        row.persistable = false;
    }

    // --- retry, cancel ------------------------------------------------------------------

    private static final List<String> AUTOMATIC = Arrays.asList("network", "server", "storageUnavailable", "transferNotReady");

    /** Record a failure; transient ones retry at 2/10/30/60 s while the app stays open (sends four times). */
    private void fail(Row row, String reason, Runnable again) {
        boolean scheduled = false;
        synchronized (this) {
            row.state = "failed"; row.code = reason;
            // A receive keeps retrying (every 60 s at most) while the app is open: the inbox
            // revision it arrived with is already handled, so nothing else would bring it back.
            if (again != null && AUTOMATIC.contains(reason) && (row.incoming || row.attempts < AUTO_RETRIES)) {
                long delay = ExchangeTransfer.retryDelay(row.attempts++);
                int started = epoch;
                scheduled = true;
                net.schedule(() -> {
                    synchronized (this) {
                        if (started != epoch || row.cancelled || !"failed".equals(row.state)) return;
                        if (!foreground) { deferred.add(row.id); return; }
                    }
                    again.run();
                }, delay, TimeUnit.MILLISECONDS);
            }
            if (!row.incoming) saveSends();
        }
        // No automatic retry left: stop holding the picked file's persisted read grant.
        if (!scheduled && !row.incoming) { release(row); discard(row); }
        changed();
    }

    private void resume(String id) {
        Row row;
        synchronized (this) { row = incoming.containsKey(id) ? incoming.get(id) : outgoing.get(id); }
        if (row == null || row.cancelled) return;
        if (row.incoming) enqueueReceive(row); else enqueueUpload(row);
    }

    /** 재시도 on a failed row: a fresh round of automatic retries. */
    void retry(String id) throws UserError {
        Row row;
        synchronized (this) { row = incoming.containsKey(id) ? incoming.get(id) : outgoing.get(id); }
        if (row == null) throw new UserError("다시 시도할 항목을 찾을 수 없습니다.");
        if ("sourceUnavailable".equals(row.code)) throw new UserError("원본 파일을 읽을 수 없습니다. 파일을 다시 선택해 주세요.");
        if (!retryable(row)) throw new UserError("압축 파일이 이미 정리되었습니다. 폴더를 다시 보내 주세요.");
        row.attempts = 0; row.cancelled = false;
        if (row.incoming) { row.state = "waiting"; enqueueReceive(row); }
        else { row.state = "preparing"; enqueueUpload(row); }
        changed();
    }

    /** Withdraw a send or decline an arrival; the server deletes the object. Local rows just go. */
    void cancel(String id) throws Exception {
        Row row;
        synchronized (this) { row = incoming.containsKey(id) ? incoming.get(id) : outgoing.get(id); }
        if (!ExchangeTransfer.uuid(id)) throw new UserError("취소할 항목을 찾을 수 없습니다.");
        if (row != null) row.cancelled = true;
        JSONObject connection = connection();
        if (connection != null) {
            // A row the server never created answers 404, which is the same outcome.
            try { call(connection, "/v1/exchange/transfers/" + id, "DELETE", null); }
            catch (CloudClient.HttpFailure failure) { if (failure.status != 404) throw failure; }
        }
        synchronized (this) {
            if (row != null) {
                if (row.incoming) incoming.remove(id);
                else { outgoing.remove(id); release(row); discard(row); saveSends(); }
            }
        }
        if (row != null && row.incoming) new File(new File(context.getCacheDir(), "exchange"), id + ".part").delete();
        requestRefresh(false);
        changed();
    }

    // --- persistence ---------------------------------------------------------------------

    private boolean saveLedger() { return ledger.save(journal); }

    /** Unfinished sends survive a restart with their transfer id, so a retry stays idempotent. */
    private void saveSends() {
        JSONArray list = new JSONArray();
        try {
            for (Row row : outgoing.values()) {
                // A zip still being written is never resumable: it is swept on the next start.
                if (Arrays.asList("ready", "delivered", "cancelled", "zipping").contains(row.state)) continue;
                list.put(new JSONObject().put("id", row.id).put("batchId", row.batchId).put("uri", row.uri).put("name", row.name)
                        .put("size", row.size).put("sha", row.sha == null ? "" : row.sha).put("toDevice", row.peerId).put("peer", row.peer)
                        .put("hint", row.hint == null ? "" : row.hint).put("persistable", row.persistable).put("created", row.created)
                        .put("freshId", row.freshId).put("code", row.code).put("zip", row.zip == null ? "" : row.zip).put("skipped", row.skipped));
            }
        } catch (JSONException ignored) { return; }
        preferences.edit().putString("sends", list.toString()).apply();
    }

    private void restoreSends() {
        try {
            JSONArray list = new JSONArray(preferences.getString("sends", "[]"));
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.getJSONObject(i);
                Row row = new Row();
                row.id = o.getString("id"); row.batchId = o.getString("batchId"); row.uri = o.getString("uri"); row.name = o.getString("name");
                row.size = o.getLong("size"); row.sha = o.optString("sha", ""); if (row.sha.isEmpty()) row.sha = null;
                row.peerId = o.getString("toDevice"); row.peer = o.optString("peer", ""); row.hint = o.optString("hint", ""); if (row.hint.isEmpty()) row.hint = null;
                row.persistable = o.optBoolean("persistable"); row.created = o.optString("created", ""); row.freshId = o.optBoolean("freshId");
                row.zip = o.optString("zip", ""); if (row.zip.isEmpty()) row.zip = null; row.skipped = o.optInt("skipped");
                // Unfinished sends older than the server's 7-day history are dropped with their grant.
                if (System.currentTimeMillis() - parseIso(row.created) > ExchangeTransfer.LEDGER_MILLIS) { release(row); discard(row); continue; }
                row.state = "failed";
                String previous = o.optString("code", "");
                row.code = previous.isEmpty() || AUTOMATIC.contains(previous) ? "interrupted" : previous;
                if (ExchangeTransfer.uuid(row.id) && ExchangeTransfer.uuid(row.peerId)) outgoing.put(row.id, row);
            }
            saveSends();
        } catch (JSONException ignored) { preferences.edit().remove("sends").apply(); }
    }

    /** Millis of a stored `created` stamp; 0 (oldest) when unreadable. */
    private static long parseIso(String value) {
        try {
            java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            return format.parse(value).getTime();
        } catch (Exception unreadable) { return 0; }
    }

    // --- events ----------------------------------------------------------------------------

    private void update(Row row, String state, String reason) {
        synchronized (this) { row.state = state; row.code = reason; }
        changed();
    }

    private void emit(String name, JSONObject detail) { for (Listener listener : listeners) listener.event(name, detail); }

    /** Coalesced snapshot events: at most one every 250 ms, so progress never floods the WebView. */
    private void changed() {
        long wait;
        synchronized (this) {
            if (emitScheduled) return;
            emitScheduled = true;
            wait = Math.max(0, lastEmit + 250 - System.currentTimeMillis());
        }
        try {
            emitter.schedule(() -> {
                synchronized (this) { emitScheduled = false; lastEmit = System.currentTimeMillis(); }
                try { emit(EVENT, snapshot()); } catch (Exception ignored) {}
            }, wait, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) { synchronized (this) { emitScheduled = false; } }
    }

    private static String iso(long millis) {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    private static JSONObject rowView(Row row) throws JSONException {
        return new JSONObject().put("transferId", row.id).put("batchId", row.batchId).put("fileName", row.name)
                .put("sizeBytes", row.size).put("bytes", row.bytes).put("peer", row.peer).put("state", row.state)
                .put("code", row.code).put("createdAt", row.created == null ? "" : row.created)
                .put("skipped", row.skipped).put("retryable", row.incoming || retryable(row))
                .put("peerId", row.peerId == null ? "" : row.peerId);
    }

    /** A folder send can only be retried from its zip; once that is gone, the folder must be picked again. */
    private static boolean retryable(Row row) { return row.zip == null || new File(row.zip).isFile(); }

    // --- folder sends ----------------------------------------------------------------------

    private File zipDir() { return new File(context.getCacheDir(), "exchange-zips"); }

    private void discard(Row row) { if (row.zip != null) new File(row.zip).delete(); }

    /** Zips no persisted send refers to: an interrupted zipping step or a crash before cleanup. */
    private void sweepZips() {
        Set<String> live = new HashSet<>();
        for (Row row : outgoing.values()) if (row.zip != null) live.add(new File(row.zip).getAbsolutePath());
        File[] files = zipDir().listFiles();
        if (files != null) for (File file : files) if (!live.contains(file.getAbsolutePath())) file.delete();
    }

    /** `DocumentsContract` children of a picked tree, read with the picker's transient grant. */
    private final class DocumentTree implements ExchangeZip.Tree {
        private final Uri tree;
        private final String rootId;
        DocumentTree(Uri tree) { this.tree = tree; rootId = android.provider.DocumentsContract.getTreeDocumentId(tree); }
        public List<ExchangeZip.Node> children(ExchangeZip.Node dir) throws IOException {
            Uri uri = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir == null ? rootId : dir.id);
            String[] columns = {android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID, android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE, android.provider.DocumentsContract.Document.COLUMN_SIZE,
                    android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED};
            List<ExchangeZip.Node> list = new ArrayList<>();
            try (Cursor cursor = context.getContentResolver().query(uri, columns, null, null, null)) {
                if (cursor == null) throw new IOException("Folder unreadable");
                while (cursor.moveToNext()) {
                    String id = cursor.getString(0);
                    if (id == null) continue;
                    String name = cursor.isNull(1) ? id : cursor.getString(1);
                    boolean folder = android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2));
                    list.add(new ExchangeZip.Node(id, name, folder, cursor.isNull(3) ? -1 : cursor.getLong(3), cursor.isNull(4) ? 0 : cursor.getLong(4)));
                }
            } catch (SecurityException | IllegalArgumentException denied) {
                throw new IOException("Folder unreadable");
            }
            return list;
        }
        public InputStream open(ExchangeZip.Node file) throws IOException {
            try { return context.getContentResolver().openInputStream(android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, file.id)); }
            catch (SecurityException | IllegalArgumentException denied) { throw new FileNotFoundException(); }
        }
        String name() {
            Uri root = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
            try (Cursor cursor = context.getContentResolver().query(root, new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
            } catch (RuntimeException ignored) {}
            return "폴더";
        }
    }

    /**
     * 폴더 보내기: zip the picked tree into app cache, then send the zip as one transfer.
     * Zipping runs on its own worker and can be cancelled; retries reuse the finished zip.
     */
    JSONObject sendFolder(Uri tree, String toDevice) throws Exception {
        if (!ExchangeTransfer.uuid(toDevice)) throw new UserError("받는 기기를 선택해 주세요.");
        if (connection() == null) throw new UserError("이 기기 전용 토큰이 필요합니다. Lakomics의 보내기/받기 화면에서 입력해 주세요.");
        DocumentTree source;
        try { source = new DocumentTree(tree); } catch (RuntimeException invalid) { throw new UserError("이 폴더는 보낼 수 없습니다."); }
        String folder = source.name();
        Row row = new Row();
        row.id = UUID.randomUUID().toString(); row.batchId = row.id; row.peerId = toDevice; row.created = iso(System.currentTimeMillis());
        row.name = ExchangeZip.zipName(folder); row.hint = "application/zip"; row.state = "zipping"; row.size = 0;
        zipDir().mkdirs();
        File file = new File(zipDir(), UUID.randomUUID() + ".zip");
        row.zip = file.getAbsolutePath(); row.uri = Uri.fromFile(file).toString();
        synchronized (this) { row.peer = nameOf(toDevice); outgoing.put(row.id, row); }
        changed();
        zips.execute(() -> zip(row, source, folder, file));
        return new JSONObject().put("batchId", row.batchId).put("transferIds", new JSONArray().put(row.id));
    }

    private void zip(Row row, DocumentTree source, String folder, File file) {
        try {
            long free = file.getParentFile().getUsableSpace();
            if (free > 0 && free < 64L * 1024 * 1024) throw new UserError("noSpace");
            ExchangeZip.Result result;
            try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file), 1 << 16)) {
                result = ExchangeZip.write(source, folder, out, ExchangeTransfer.MAX_FILE_BYTES,
                        (done, total) -> { row.bytes = done; row.size = total; changed(); }, () -> row.cancelled);
            }
            synchronized (this) {
                if (row.cancelled) { file.delete(); return; }
                row.skipped = result.skipped; row.size = file.length(); row.bytes = 0; row.state = "preparing";
                saveSends();
            }
            changed();
            enqueueUpload(row);
        } catch (Exception e) {
            file.delete();
            if (row.cancelled) return;
            String reason = e instanceof ExchangeZip.TooLarge ? "folderTooLarge"
                    : e instanceof UserError ? e.getMessage()
                    : "Folder unreadable".equals(e.getMessage()) ? "folderUnreadable"
                    : String.valueOf(e.getMessage()).contains("ENOSPC") ? "noSpace" : "zipFailed";
            synchronized (this) { row.state = "failed"; row.code = reason; }
            changed();
        }
    }

    /** Everything the 보내기/받기 screen and the share sheet show. */
    JSONObject snapshot() throws Exception {
        JSONObject library = settings.read();
        boolean configured = library.has("token");
        boolean token = configured && statusConnection(library) != null;
        synchronized (this) {
            JSONArray others = new JSONArray();
            for (int i = 0; i < devices.length(); i++) {
                JSONObject device = devices.getJSONObject(i);
                if (!device.optBoolean("self") && !deviceId().equals(device.optString("deviceId")))
                    others.put(new JSONObject().put("deviceId", device.getString("deviceId")).put("name", device.optString("name"))
                            .put("kind", device.optString("kind")).put("lastSeenAt", device.optString("lastSeenAt")));
            }
            JSONArray in = new JSONArray();
            for (Row row : incoming.values()) if (!ledger.saved(row.id)) in.put(rowView(row));
            JSONObject meta = receivedMeta();
            for (ExchangeTransfer.Ledger.Entry entry : ledger.newestFirst()) {
                JSONArray known = meta.optJSONArray(entry.id);
                in.put(new JSONObject().put("transferId", entry.id).put("fileName", entry.name).put("sizeBytes", entry.size)
                        .put("bytes", entry.size).put("peer", entry.from).put("state", "saved").put("code", "")
                        .put("createdAt", iso(entry.savedAt)).put("savedAt", iso(entry.savedAt))
                        .put("batchId", known == null ? entry.id : known.optString(0, entry.id))
                        .put("peerId", known == null ? "" : known.optString(1, "")));
            }
            JSONArray out = new JSONArray();
            Set<String> listed = new HashSet<>();
            List<Row> local = new ArrayList<>(outgoing.values());
            Collections.reverse(local);
            for (Row row : local) { out.put(rowView(row)); listed.add(row.id); }
            for (int i = 0; i < outbox.length(); i++) {
                JSONObject item = outbox.getJSONObject(i);
                String id = item.getString("transferId");
                if (listed.contains(id)) continue;
                String state = item.optString("state");
                // A server row still "uploading" with no local upload was interrupted (another
                // process or a closed share sheet); it expires on the server within 2 h.
                if ("uploading".equals(state)) state = "stalled";
                out.put(new JSONObject().put("transferId", id).put("batchId", item.optString("batchId")).put("fileName", item.optString("fileName"))
                        .put("sizeBytes", item.optLong("sizeBytes")).put("bytes", item.optLong("sizeBytes"))
                        .put("peer", item.isNull("toName") ? "" : item.optString("toName")).put("state", state)
                        .put("code", item.isNull("failure") ? "" : item.optString("failure")).put("createdAt", item.optString("createdAt"))
                        .put("peerId", item.optString("toDevice", "")));
            }
            return new JSONObject().put("configured", configured).put("tokenConfigured", token)
                    .put("receiveSupported", receiveSupported()).put("deviceId", deviceId()).put("deviceName", deviceName())
                    .put("code", configured ? (token ? code : "tokenMissing") : "notConfigured")
                    .put("devices", others).put("incoming", in).put("outgoing", out).put("unseen", unseen);
        }
    }

    // --- timeline extras: batch and sender of saved files, local thumbnails ------------------

    /** transferId → [batchId, fromDevice] of saved files; the ledger itself keeps neither. */
    private JSONObject receivedMeta;

    private synchronized JSONObject receivedMeta() {
        if (receivedMeta == null) {
            try { receivedMeta = new JSONObject(preferences.getString("received-meta", "{}")); }
            catch (JSONException damaged) { receivedMeta = new JSONObject(); }
        }
        return receivedMeta;
    }

    /** Best effort: without it a saved file only loses its batch grouping. */
    private synchronized void rememberReceived(Row row) {
        try {
            JSONObject meta = receivedMeta();
            meta.put(row.id, new JSONArray().put(row.batchId == null ? row.id : row.batchId).put(row.peerId == null ? "" : row.peerId));
            List<String> stale = new ArrayList<>();
            for (Iterator<String> it = meta.keys(); it.hasNext(); ) { String id = it.next(); if (!ledger.contains(id)) stale.add(id); }
            for (String id : stale) meta.remove(id);
            preferences.edit().putString("received-meta", meta.toString()).apply();
        } catch (JSONException ignored) {}
    }

    private static final java.util.regex.Pattern IMAGE_NAME =
            java.util.regex.Pattern.compile("(?i).+\\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$");
    private static final int THUMB_EDGE = 256, THUMB_FILES = 400;

    /** A small JPEG of a sent or saved image as a data URL; "" when there is none. Never touches the server. */
    JSONObject thumbnail(String id) throws Exception {
        if (!ExchangeTransfer.uuid(id)) return new JSONObject().put("url", "");
        String uri = null, name = null;
        synchronized (this) {
            Row row = outgoing.get(id);
            if (row != null && row.zip == null) { uri = row.uri; name = row.name; }
            ExchangeTransfer.Ledger.Entry entry = ledger.get(id);
            if (uri == null && entry != null && !entry.publishing) { uri = entry.uri; name = entry.name; }
        }
        return new JSONObject().put("url", thumbnailOf(id, uri, name));
    }

    private String thumbnailOf(String id, String uri, String name) {
        File dir = new File(context.getCacheDir(), "exchange-thumbs");
        File file = new File(dir, id + ".jpg");
        byte[] bytes = null;
        if (file.isFile()) {
            try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                bytes = out.toByteArray();
            } catch (IOException ignored) {}
        }
        if (bytes == null && uri != null && !uri.isEmpty() && name != null && IMAGE_NAME.matcher(name).matches()) {
            Bitmap bitmap = decodeThumbnail(Uri.parse(uri));
            if (bitmap != null) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out);
                bitmap.recycle();
                bytes = out.toByteArray();
                if (dir.isDirectory() || dir.mkdirs()) {
                    try (OutputStream stream = new FileOutputStream(file)) { stream.write(bytes); } catch (IOException ignored) {}
                    File[] cached = dir.listFiles();
                    if (cached != null && cached.length > THUMB_FILES) {
                        Arrays.sort(cached, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
                        for (int i = 0; i < cached.length - THUMB_FILES; i++) cached[i].delete();
                    }
                }
            }
        }
        return bytes == null ? "" : "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private Bitmap decodeThumbnail(Uri uri) {
        ContentResolver resolver = context.getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            try { return resolver.loadThumbnail(uri, new android.util.Size(THUMB_EDGE, THUMB_EDGE), null); }
            catch (IOException | RuntimeException fallback) { /* decode it ourselves below */ }
        }
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = resolver.openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (options.inSampleSize * 2) >= THUMB_EDGE) options.inSampleSize *= 2;
            try (InputStream in = resolver.openInputStream(uri)) { return BitmapFactory.decodeStream(in, null, options); }
        } catch (IOException | RuntimeException unreadable) {
            return null;
        }
    }

    // --- failures ----------------------------------------------------------------------------

    private static JSONObject detail(CloudClient.HttpFailure failure) {
        JSONObject body = failure.detailObject();
        if (body == null) return null;
        JSONObject detail = body.optJSONObject("detail");
        return detail != null ? detail : body;
    }

    private static String goneState(Exception e) {
        if (!(e instanceof CloudClient.HttpFailure)) return "";
        JSONObject detail = detail((CloudClient.HttpFailure) e);
        return detail == null ? "" : detail.optString("state", "");
    }

    /** A stable code the web layer turns into Korean text. */
    static String failureCode(Exception e) {
        if (e instanceof UserError) return e.getMessage();
        if (e instanceof CloudClient.HttpFailure) {
            CloudClient.HttpFailure failure = (CloudClient.HttpFailure) e;
            JSONObject detail = detail(failure);
            String code = detail == null ? "" : detail.optString("code", "");
            if (!code.isEmpty()) return code;
            if (failure.status == 401) return "tokenInvalid";
            if (failure.status == 403) return "tokenForbidden";
            if (failure.status == 404) return "unavailable";
            return failure.status >= 500 ? "server" : "request";
        }
        if (e instanceof ExchangeTransfer.Corrupt) return "digest";
        if (e instanceof ExchangeTransfer.Cancelled) return "cancelled";
        if (e instanceof IOException && String.valueOf(e.getMessage()).contains("ENOSPC")) return "noSpace";
        if (e instanceof IOException) return "network";
        if (e instanceof IllegalStateException) return "notConfigured";
        return "failed";
    }
}
