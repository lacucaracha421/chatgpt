package com.lakomics.mobile;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;

/**
 * File exchange (보내기/받기) byte transport and its local rules, free of the Android runtime.
 *
 * Unlike {@link MediaTransfer}, a transfer here may be a 2 GiB file on a slow link, so there
 * is no total deadline: a transfer fails only when no byte moves for {@link #IDLE_MILLIS}.
 * Downloads resume with `Range` into a `.part` file; uploads stream a presigned PUT of a known
 * length. Integrity is the sender-declared SHA-256, checked before anything is saved.
 */
final class ExchangeTransfer {
    static final long MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024;
    static final long IDLE_MILLIS = 30_000;
    static final long LEDGER_MILLIS = 7L * 24 * 3600 * 1000;
    static final int MAX_NAME_BYTES = 255;
    private static final long[] RETRY_MILLIS = {2_000, 10_000, 30_000, 60_000};

    interface Progress { void bytes(long done, long total); }
    interface Cancel { boolean cancelled(); }

    /** A non-2xx storage response. 403/400 usually mean an expired presigned URL. */
    static final class StorageStatus extends IOException {
        final int status;
        StorageStatus(int status) { super("Storage HTTP " + status); this.status = status; }
    }
    /** The received bytes do not match the declared digest or length; the part file is gone. */
    static final class Corrupt extends IOException { Corrupt(String m) { super(m); } }
    static final class Cancelled extends IOException { Cancelled() { super("Cancelled"); } }

    private ExchangeTransfer() {}

    static boolean uuid(String value) {
        return value != null && value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    /**
     * Whether a URI handed to the exported share target may be read.
     *
     * Only `content:` URIs, and never one served by this app itself: the upload reads with
     * Lakomics' own identity, so another app could otherwise make it export Library files it
     * cannot read (a confused deputy). `ownerPackage` is the provider's package when the
     * platform resolves one, else null.
     */
    static boolean shareable(String scheme, String authority, String ownPackage, String ownerPackage) {
        if (!"content".equals(scheme) || authority == null || authority.isEmpty()) return false;
        String host = authority.contains("@") ? authority.substring(authority.lastIndexOf('@') + 1) : authority;
        if (host.equals(ownPackage) || host.startsWith(ownPackage + ".")) return false;
        return ownerPackage == null || !ownerPackage.equals(ownPackage);
    }

    static long retryDelay(int attempt) {
        return RETRY_MILLIS[Math.max(0, Math.min(attempt, RETRY_MILLIS.length - 1))];
    }

    // --- names ---------------------------------------------------------------

    private static boolean invisible(int c) {
        return c < 0x20 || (c >= 0x7F && c <= 0x9F) || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)
                || c == 0x200E || c == 0x200F || c == 0x061C;
    }

    /**
     * The leaf name this device saves under. The server already sanitises; this repeats the
     * portable rules (NFC, no control or bidi characters, basename only) and adds what shared
     * storage refuses: FAT-reserved characters, trailing dots/spaces and a leading dot, which
     * would hide the file. MediaStore resolves collisions itself.
     */
    static String fileName(String raw) {
        String text = Normalizer.normalize(raw == null ? "" : raw, Normalizer.Form.NFC);
        StringBuilder visible = new StringBuilder();
        text.codePoints().filter(c -> !invisible(c)).forEach(visible::appendCodePoint);
        String name = visible.toString();
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        name = name.substring(slash + 1).trim();
        name = name.replaceAll("[\"*:<>?|]", "_");
        name = name.replaceAll("[. ]+$", "");
        if (name.startsWith(".")) name = "_" + name.substring(1);
        if (name.isEmpty()) name = "file";
        if (name.getBytes(StandardCharsets.UTF_8).length > MAX_NAME_BYTES) {
            int dot = name.lastIndexOf('.');
            String extension = dot > 0 ? name.substring(dot) : "";
            if (extension.getBytes(StandardCharsets.UTF_8).length > 33) extension = "";
            String stem = extension.isEmpty() ? name : name.substring(0, dot);
            name = truncate(stem, MAX_NAME_BYTES - extension.getBytes(StandardCharsets.UTF_8).length).trim() + extension;
        }
        return name;
    }

    private static String truncate(String text, int limit) {
        StringBuilder out = new StringBuilder();
        int used = 0;
        for (int i = 0; i < text.length(); ) {
            int c = text.codePointAt(i);
            int size = new String(Character.toChars(c)).getBytes(StandardCharsets.UTF_8).length;
            if (used + size > limit) break;
            out.appendCodePoint(c); used += size; i += Character.charCount(c);
        }
        return out.toString();
    }

    // --- resume bookkeeping ----------------------------------------------------

    static String rangeHeader(long have) { return have > 0 ? "bytes=" + have + "-" : null; }

    /**
     * Where the response body starts in the file: `have` for a matching 206, 0 for a full 200.
     * Anything else (a range for different bytes, a different total) is refused so a part file
     * can never be stitched from two objects.
     */
    static long resumeOffset(int status, String contentRange, long have, long total) throws IOException {
        if (status == 200) return 0;
        if (status != 206 || have <= 0) throw new StorageStatus(status);
        String expected = "bytes " + have + "-" + (total - 1) + "/" + total;
        if (contentRange == null || !contentRange.trim().equals(expected)) throw new IOException("Unexpected range");
        return have;
    }

    // --- idle watchdog -----------------------------------------------------------

    /** Progress clock: a transfer is idle once nothing moved for {@link #IDLE_MILLIS}. */
    static final class Idle {
        private final LongSupplier clock;
        private final long limit;
        private volatile long last;
        private volatile boolean expired;
        Idle(LongSupplier clock, long limit) { this.clock = clock; this.limit = limit; last = clock.getAsLong(); }
        void touch() { last = clock.getAsLong(); }
        boolean check() { if (clock.getAsLong() - last >= limit) expired = true; return expired; }
        boolean expired() { return expired; }
    }

    private static final ScheduledExecutorService WATCH = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "lakomics-exchange-watch");
        thread.setDaemon(true);
        return thread;
    });

    /** Disconnects `connection` when idle or cancelled; blocking reads and writes then fail. */
    private static ScheduledFuture<?> watch(HttpURLConnection connection, Idle idle, Cancel cancel) {
        return WATCH.scheduleWithFixedDelay(() -> {
            if (idle.check() || (cancel != null && cancel.cancelled())) connection.disconnect();
        }, 1, 1, TimeUnit.SECONDS);
    }

    private static IOException failure(IOException e, Idle idle, Cancel cancel) {
        if (cancel != null && cancel.cancelled()) return new Cancelled();
        if (idle.expired()) return new SocketTimeoutException("No bytes for " + IDLE_MILLIS / 1000 + " s");
        return e;
    }

    private static HttpURLConnection open(String url) throws IOException {
        URI u;
        try { u = new URI(url); } catch (Exception e) { throw new IOException("Invalid transfer URL"); }
        if (!"https".equals(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null) throw new IOException("Invalid transfer URL");
        HttpURLConnection c = (HttpURLConnection) u.toURL().openConnection();
        c.setConnectTimeout(12_000);
        c.setReadTimeout((int) IDLE_MILLIS);
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        return c;
    }

    // --- transfers ---------------------------------------------------------------

    /** SHA-256 and exact length of a stream (the sender's pre-pass). */
    static final class Digest { final String sha256; final long size; Digest(String s, long n) { sha256 = s; size = n; } }

    static Digest digest(InputStream in, Progress progress, Cancel cancel) throws IOException {
        MessageDigest hash = sha();
        byte[] buffer = new byte[65536];
        long size = 0;
        int n;
        while ((n = in.read(buffer)) != -1) {
            if (cancel != null && cancel.cancelled()) throw new Cancelled();
            hash.update(buffer, 0, n);
            size += n;
            if (size > MAX_FILE_BYTES) throw new IOException("File too large");
            if (progress != null) progress.bytes(size, -1);
        }
        return new Digest(hex(hash.digest()), size);
    }

    /**
     * Stream exactly `size` bytes to a presigned PUT. A source that yields a different count
     * (the file changed after hashing) fails instead of uploading different bytes.
     */
    static void upload(String url, Map<String, String> headers, InputStream in, long size, Progress progress, Cancel cancel) throws IOException {
        HttpURLConnection c = open(url);
        Idle idle = new Idle(System::currentTimeMillis, IDLE_MILLIS);
        ScheduledFuture<?> watch = watch(c, idle, cancel);
        try {
            c.setRequestMethod("PUT");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(size);
            for (Map.Entry<String, String> header : headers.entrySet()) c.setRequestProperty(header.getKey(), header.getValue());
            byte[] buffer = new byte[65536];
            long sent = 0;
            try (OutputStream out = c.getOutputStream()) {
                int n;
                while ((n = in.read(buffer)) != -1) {
                    if (cancel != null && cancel.cancelled()) throw new Cancelled();
                    if (n > size - sent) throw new IOException("Source grew after hashing");
                    out.write(buffer, 0, n);
                    sent += n;
                    idle.touch();
                    if (progress != null) progress.bytes(sent, size);
                }
                if (sent != size) throw new IOException("Source shrank after hashing");
            }
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) throw new StorageStatus(status);
        } catch (IOException e) {
            throw failure(e, idle, cancel);
        } finally {
            watch.cancel(false);
            c.disconnect();
        }
    }

    /**
     * Download into `part`, resuming from its current length, then verify length and digest.
     * A digest or length mismatch deletes the part file, so the next attempt starts clean.
     */
    static void download(String url, File part, long total, String sha256, Progress progress, Cancel cancel) throws IOException {
        long have = part.exists() ? part.length() : 0;
        if (have > total) { part.delete(); have = 0; }
        if (have < total || total == 0 && !part.exists()) {
            HttpURLConnection c = open(url);
            Idle idle = new Idle(System::currentTimeMillis, IDLE_MILLIS);
            ScheduledFuture<?> watch = watch(c, idle, cancel);
            try {
                c.setRequestProperty("Accept-Encoding", "identity");
                String range = rangeHeader(have);
                if (range != null) c.setRequestProperty("Range", range);
                int status = c.getResponseCode();
                if (status == 416) { part.delete(); throw new StorageStatus(status); }
                long start = resumeOffset(status, c.getHeaderField("Content-Range"), have, total);
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, start > 0)) {
                    byte[] buffer = new byte[65536];
                    long done = start;
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        if (cancel != null && cancel.cancelled()) throw new Cancelled();
                        if (n > total - done) { out.flush(); part.delete(); throw new Corrupt("Longer than declared"); }
                        out.write(buffer, 0, n);
                        done += n;
                        idle.touch();
                        if (progress != null) progress.bytes(done, total);
                    }
                }
            } catch (IOException e) {
                throw e instanceof Corrupt ? e : failure(e, idle, cancel);
            } finally {
                watch.cancel(false);
                c.disconnect();
            }
        }
        verify(part, total, sha256);
    }

    static void verify(File part, long total, String sha256) throws IOException {
        if (part.length() != total) {
            if (part.length() > total) part.delete();
            throw new EOFException("Incomplete transfer");
        }
        String actual;
        try (InputStream in = new FileInputStream(part)) { actual = digest(in, null, null).sha256; }
        if (!actual.equals(sha256)) { part.delete(); throw new Corrupt("Digest mismatch"); }
    }

    static MessageDigest sha() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }

    // --- received ledger ------------------------------------------------------------

    /**
     * Transfers this device already saved, kept for {@link #LEDGER_MILLIS}. A lost ack
     * response leaves the transfer in the inbox; the ledger turns the next sighting into an
     * ack instead of a second copy in Downloads. It also backs the "saved" rows and 열기.
     */
    static final class Ledger {
        static final class Entry {
            final String id, uri, name, from; final long savedAt, size; final boolean acked;
            Entry(String id, long savedAt, String uri, String name, long size, String from, boolean acked) {
                this.id = id; this.savedAt = savedAt; this.uri = uri; this.name = name; this.size = size; this.from = from; this.acked = acked;
            }
        }
        private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();

        private static String clean(String value) { return value == null ? "" : value.replaceAll("[\\t\\r\\n]", " "); }

        static Ledger decode(String stored) {
            Ledger ledger = new Ledger();
            if (stored == null) return ledger;
            for (String line : stored.split("\n")) {
                String[] f = line.split("\t", -1);
                if (f.length != 7 || !uuid(f[0])) continue;
                try {
                    ledger.entries.put(f[0], new Entry(f[0], Long.parseLong(f[1]), f[2], f[3], Long.parseLong(f[4]), f[5], "1".equals(f[6])));
                } catch (NumberFormatException ignored) { /* A damaged line is dropped, never guessed. */ }
            }
            return ledger;
        }

        String encode() {
            StringBuilder out = new StringBuilder();
            for (Entry e : entries.values()) {
                if (out.length() > 0) out.append('\n');
                out.append(e.id).append('\t').append(e.savedAt).append('\t').append(clean(e.uri)).append('\t').append(clean(e.name))
                        .append('\t').append(e.size).append('\t').append(clean(e.from)).append('\t').append(e.acked ? '1' : '0');
            }
            return out.toString();
        }

        void put(Entry entry) { entries.remove(entry.id); entries.put(entry.id, entry); }
        Entry get(String id) { return entries.get(id); }
        boolean contains(String id) { return entries.containsKey(id); }
        void acked(String id) {
            Entry e = entries.get(id);
            if (e != null && !e.acked) entries.put(id, new Entry(e.id, e.savedAt, e.uri, e.name, e.size, e.from, true));
        }
        /** Drops entries older than the window. Returns whether anything was removed. */
        boolean prune(long now) { return entries.values().removeIf(e -> now - e.savedAt > LEDGER_MILLIS || e.savedAt > now + 86_400_000L); }
        List<Entry> newestFirst() { List<Entry> list = new ArrayList<>(entries.values()); Collections.reverse(list); return list; }
    }
}
