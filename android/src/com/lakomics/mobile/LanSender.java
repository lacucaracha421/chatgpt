package com.lakomics.mobile;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;
import javax.net.ssl.*;

/**
 * Direct (TRANSFER-001) sender: one file to one peer over the LAN, then Tailscale, with the
 * same transfer id the server path would use. The caller falls back to the server whenever
 * {@link #send} answers {@link Kind#FALLBACK}.
 *
 * Every request is its own mutually pinned TLS 1.3 connection (the receiver serves one request
 * per connection): the peer certificate must hash to exactly the pin the server published for
 * the target device, and our own certificate is presented as the client certificate. The HTTP
 * framing is written here, byte for byte what {@link LanProtocol#read} accepts. Free of the
 * Android runtime so the decisions and the wire format run in the JVM checks.
 */
final class LanSender {
    static final long LAN_CONNECT_MILLIS = 1_500, TAILSCALE_CONNECT_MILLIS = 3_000, PROBE_MILLIS = 3_000, REQUEST_MILLIS = 5_000,
            ROUTE_MILLIS = 600_000, UNREACHABLE_MILLIS = 60_000, IDLE_MILLIS = 15_000;
    static final int MAX_ADDRESSES = 4, MAX_MEMO = 64;

    static final class Address {
        final String kind, ip;
        Address(String kind, String ip) { this.kind = kind; this.ip = ip; }
        boolean same(Address other) { return other != null && kind.equals(other.kind) && ip.equals(other.ip); }
    }

    /** What the server published for the target device. */
    static final class Peer {
        final String deviceId, certSha256;
        final int port;
        final List<Address> addresses;
        Peer(String deviceId, String certSha256, int port, List<Address> addresses) {
            this.deviceId = deviceId; this.certSha256 = certSha256; this.port = port;
            this.addresses = Collections.unmodifiableList(new ArrayList<>(addresses));
        }
        String key() { return deviceId + "|" + certSha256 + "|" + port; }
    }

    static final class Job {
        final String id, batch, from, name, sha, hint;
        final long size;
        Job(String id, String batch, String from, String name, long size, String sha, String hint) {
            this.id = id; this.batch = batch; this.from = from; this.name = name; this.size = size; this.sha = sha; this.hint = hint;
        }
        Map<String, Object> prepareBody() {
            Map<String, Object> body = LanProtocol.object("transferId", id, "batchId", batch, "fromDevice", from,
                    "fileName", name, "sizeBytes", size, "sha256", sha);
            if (hint != null) body.put("contentTypeHint", hint);
            return body;
        }
    }

    /** A failure on our own side (the picked file): never a reason to try the server. */
    static final class Local extends IOException {
        final String code;
        Local(String code) { super(code); this.code = code; }
    }

    static final class PinMismatch extends SSLException { PinMismatch() { super("LAN certificate does not match the pin"); } }

    interface Source { InputStream open() throws IOException; }
    interface Route { void chosen(String kind); }
    interface Connector {
        /** A connected, handshaken socket whose peer certificate hashes to `pin`. */
        Socket open(String pin, Address address, int port, int connectMillis, int handshakeMillis) throws IOException;
    }

    enum Kind { SAVED, FALLBACK, PEER_CANCELLED, CANCELLED }
    enum Step { RESUME, FALLBACK, STOP }

    static final class Outcome {
        final Kind kind;
        final String route, reason;
        /** The cached peer data may be stale (pin or identity refused): re-read the device list. */
        final boolean refresh;
        Outcome(Kind kind, String route, String reason, boolean refresh) { this.kind = kind; this.route = route; this.reason = reason; this.refresh = refresh; }
    }

    // --- policy (pure) -----------------------------------------------------------

    static long connectMillis(Address address) { return "lan".equals(address.kind) ? LAN_CONNECT_MILLIS : TAILSCALE_CONNECT_MILLIS; }

    /** The receiver verifies and publishes after the last byte, so the answer takes time proportional to the file. */
    static long replyMillis(long size) { return 30_000 + Math.max(0, size) / 4096; }

    /**
     * LAN addresses first, then Tailscale, at most {@link #MAX_ADDRESSES}; only literal private/CGNAT IPv4 on the contract
     * port. The route that worked recently goes first. A malformed pin yields no candidates at all.
     */
    static List<Address> candidates(Peer peer, Address remembered) {
        List<Address> lan = new ArrayList<>(), tailscale = new ArrayList<>();
        if (peer.certSha256 == null || !peer.certSha256.matches("[0-9a-f]{64}")) return lan;
        for (Address address : peer.addresses) {
            if (address == null || address.ip == null || address.kind == null || !address.kind.equals(LanProtocol.addressKind(address.ip))
                    || !NetworkPolicy.lanPeer(address.ip, peer.port)) continue;
            List<Address> target = "lan".equals(address.kind) ? lan : tailscale;
            boolean duplicate = false;
            for (Address known : target) duplicate |= known.same(address);
            if (!duplicate) target.add(address);
        }
        List<Address> result = new ArrayList<>(lan);
        result.addAll(tailscale);
        if (result.size() > MAX_ADDRESSES) result = new ArrayList<>(result.subList(0, MAX_ADDRESSES));
        for (int i = 1; i < result.size() && remembered != null; i++) {
            if (result.get(i).same(remembered)) { result.add(0, result.remove(i)); break; }
        }
        return result;
    }

    static String describe(Exception failure) {
        if (failure instanceof LanProtocol.Failure) {
            LanProtocol.Failure refused = (LanProtocol.Failure) failure;
            return refused.status + " " + refused.body.get("error");
        }
        return failure.getClass().getSimpleName();
    }

    /**
     * What to do after a failed request. `midTransfer` is true once the upload PUT started.
     * `resumes` counts direct resumes already used (network loss, offset mismatch) and `digestRetries`
     * the digest mismatches already retried: one of each, then the server takes over.
     */
    static Step decide(Exception failure, boolean midTransfer, int resumes, int digestRetries) {
        // A local cancel or an unreadable picked file ends the send; the server must not take it over.
        if (failure instanceof ExchangeTransfer.Cancelled || failure instanceof Local) return Step.STOP;
        if (failure instanceof LanProtocol.Failure) {
            LanProtocol.Failure refused = (LanProtocol.Failure) failure;
            Object code = refused.body.get("error");
            if (refused.status == 410 || "cancelled".equals(code)) return Step.STOP;
            if (refused.status == 409 && "offsetMismatch".equals(code)) return midTransfer && resumes < 1 ? Step.RESUME : Step.FALLBACK;
            if (refused.status == 422 && "digestMismatch".equals(code)) return midTransfer && digestRetries < 1 ? Step.RESUME : Step.FALLBACK;
            // busy, notReceiving, any 5xx, deviceMismatch, invalidRequest, fileTooLarge, anything unknown.
            return Step.FALLBACK;
        }
        if (failure instanceof IOException) return midTransfer && resumes < 1 ? Step.RESUME : Step.FALLBACK;
        return Step.FALLBACK;
    }

    /** Why a reachable, recognised peer cannot take this file right now (null: go ahead). */
    static String refusal(Map<String, Object> info, Peer peer, long size) {
        Object protocol = info.get("protocol"), limit = info.get("maxFileBytes");
        if (!(protocol instanceof Long) || (Long) protocol != 1L) return "protocol";
        if (!peer.deviceId.equals(info.get("deviceId"))) return "device";
        if (!Boolean.TRUE.equals(info.get("receiving"))) return "notReceiving";
        if (!(limit instanceof Long) || size > (Long) limit) return "fileTooLarge";
        return null;
    }

    /** Short-lived route knowledge shared by the files of a batch. */
    static final class Memo {
        private static final class Win { final Address address; final long until; Win(Address address, long until) { this.address = address; this.until = until; } }
        private final LongSupplier clock;
        private final Map<String, Win> wins = new LinkedHashMap<String, Win>() {
            protected boolean removeEldestEntry(Map.Entry<String, Win> eldest) { return size() > MAX_MEMO; }
        };
        private final Map<String, Long> down = new LinkedHashMap<String, Long>() {
            protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) { return size() > MAX_MEMO; }
        };
        Memo(LongSupplier clock) { this.clock = clock; }

        synchronized Address winner(String key) {
            Win win = wins.get(key);
            if (win == null) return null;
            if (clock.getAsLong() >= win.until) { wins.remove(key); return null; }
            return win.address;
        }
        synchronized void win(String key, Address address) { wins.put(key, new Win(address, clock.getAsLong() + ROUTE_MILLIS)); down.remove(key); }
        synchronized void forgetWinner(String key) { wins.remove(key); }
        synchronized void unreachable(String key) { wins.remove(key); down.put(key, clock.getAsLong() + UNREACHABLE_MILLIS); }
        synchronized boolean isUnreachable(String key) {
            Long until = down.get(key);
            if (until == null) return false;
            if (clock.getAsLong() >= until) { down.remove(key); return false; }
            return true;
        }
    }

    // --- wire --------------------------------------------------------------------

    static final class Reply {
        final int status;
        final Map<String, Object> body;
        Reply(int status, Map<String, Object> body) { this.status = status; this.body = body; }
    }

    static byte[] head(String method, String target, String host, long length, boolean hasBody) {
        StringBuilder text = new StringBuilder(method).append(' ').append(target).append(" HTTP/1.1\r\nHost: ").append(host)
                .append("\r\nAccept: application/json\r\n");
        if (hasBody) text.append("Content-Type: ").append(method.equals("PUT") ? "application/octet-stream" : "application/json")
                .append("\r\nContent-Length: ").append(length).append("\r\n");
        return text.append("Connection: close\r\n\r\n").toString().getBytes(StandardCharsets.US_ASCII);
    }

    /** The receiver always answers with a JSON object and an explicit Content-Length. */
    @SuppressWarnings("unchecked")
    static Reply readReply(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int end = 0;
        while (end != 4) {
            int b = in.read();
            if (b < 0) throw new EOFException("Incomplete reply");
            if (bytes.size() >= LanProtocol.LIMIT || b > 126 || b < 32 && b != 13 && b != 10 && b != 9) throw new IOException("Invalid reply");
            bytes.write(b);
            end = (end == 0 || end == 2) && b == 13 ? end + 1
                    : (end == 1 || end == 3) && b == 10 ? end + 1 : b == 13 ? 1 : 0;
        }
        String[] lines = bytes.toString("US-ASCII").split("\r\n", -1);
        String[] first = lines[0].split(" ", 3);
        if (first.length < 2 || !first[0].equals("HTTP/1.1") || !first[1].matches("[1-5][0-9]{2}")) throw new IOException("Invalid reply");
        long length = -1;
        for (int i = 1; i < lines.length - 2; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0) throw new IOException("Invalid reply");
            String key = lines[i].substring(0, colon).toLowerCase(Locale.ROOT), value = lines[i].substring(colon + 1).trim();
            if (key.equals("transfer-encoding")) throw new IOException("Invalid reply");
            if (key.equals("content-length")) {
                if (length >= 0 || !value.matches("0|[1-9][0-9]{0,8}")) throw new IOException("Invalid reply");
                length = Long.parseLong(value);
            }
        }
        if (length < 0 || length > LanProtocol.LIMIT) throw new IOException("Invalid reply");
        byte[] body = new byte[(int) length];
        for (int at = 0; at < body.length; ) {
            int n = in.read(body, at, body.length - at);
            if (n < 0) throw new EOFException("Incomplete reply");
            at += n;
        }
        Map<String, Object> value = new LinkedHashMap<>();
        if (body.length > 0) {
            try {
                Object parsed = Json.parse(new String(body, StandardCharsets.UTF_8), LanProtocol.LIMIT, 16);
                if (!(parsed instanceof Map)) throw new IOException("Invalid reply");
                value = (Map<String, Object>) parsed;
            } catch (IllegalArgumentException invalid) { throw new IOException("Invalid reply"); }
        }
        return new Reply(Integer.parseInt(first[1]), value);
    }

    static Map<String, Object> ok(Reply reply) throws LanProtocol.Failure {
        if (reply.status == 200) return reply.body;
        Object code = reply.body.get("error"), offset = reply.body.get("offset");
        throw new LanProtocol.Failure(reply.status, code instanceof String ? (String) code : "unknown", offset instanceof Long ? (Long) offset : null);
    }

    // --- transport ---------------------------------------------------------------

    /** TLS 1.3 only, our certificate as the client certificate, the target's certificate pinned exactly. */
    static class Tls implements Connector {
        private final KeyManager[] keys;
        private final Map<String, SSLSocketFactory> factories = new LinkedHashMap<String, SSLSocketFactory>() {
            protected boolean removeEldestEntry(Map.Entry<String, SSLSocketFactory> eldest) { return size() > 16; }
        };
        Tls(KeyManager keys) { this.keys = new KeyManager[]{keys}; }

        private synchronized SSLSocketFactory factory(final String pin) throws IOException {
            SSLSocketFactory known = factories.get(pin);
            if (known != null) return known;
            try {
                SSLContext tls = SSLContext.getInstance("TLSv1.3");
                tls.init(keys, new TrustManager[]{new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Server only"); }
                    public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                        // Only the device the server named: no chain, hostname or date is trusted.
                        if (chain == null || chain.length == 0 || !LanProtocol.pin(pin, chain[0].getEncoded())) throw new CertificateException("LAN pin mismatch");
                    }
                }}, null);
                factories.put(pin, tls.getSocketFactory());
                return factories.get(pin);
            } catch (GeneralSecurityException unavailable) {
                throw new SSLException("TLS 1.3 unavailable", unavailable);
            }
        }

        /** Where to connect; a seam so the JVM checks can reach a loopback receiver. */
        InetSocketAddress target(Address address, int port) throws IOException { return new InetSocketAddress(InetAddress.getByName(address.ip), port); }

        public Socket open(String pin, Address address, int port, int connectMillis, int handshakeMillis) throws IOException {
            SSLSocketFactory factory = factory(pin);
            SSLSocket socket = null;
            try {
                socket = (SSLSocket) factory.createSocket();
                if (!Arrays.asList(socket.getSupportedProtocols()).contains("TLSv1.3")) throw new SSLException("TLS 1.3 unavailable");
                socket.setEnabledProtocols(new String[]{"TLSv1.3"});
                socket.setTcpNoDelay(true);
                socket.connect(target(address, port), connectMillis);
                socket.setSoTimeout(handshakeMillis);
                socket.startHandshake();
                // The trust manager already refused anything else; check the negotiated session once more.
                if (!"TLSv1.3".equals(socket.getSession().getProtocol())) throw new SSLException("TLS 1.3 required");
                java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
                if (chain.length == 0 || !LanProtocol.pin(pin, chain[0].getEncoded())) throw new PinMismatch();
                return socket;
            } catch (IOException | GeneralSecurityException | RuntimeException failure) {
                if (socket != null) try { socket.close(); } catch (IOException ignored) {}
                if (failure instanceof IOException) throw (IOException) failure;
                throw new SSLException("LAN connection failed", failure);
            }
        }
    }

    private static final ScheduledExecutorService WATCH = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "lakomics-lan-watch");
        thread.setDaemon(true);
        return thread;
    });

    /** Closes the socket when no byte moved for {@link #IDLE_MILLIS} (blocking writes have no timeout) or on cancel. */
    private static final class Guard implements Runnable {
        private final Socket socket;
        private final ExchangeTransfer.Cancel cancel;
        private volatile long last = System.nanoTime();
        private volatile boolean idleCheck = true, stopped;
        Guard(Socket socket, ExchangeTransfer.Cancel cancel) { this.socket = socket; this.cancel = cancel; }
        void touch() { last = System.nanoTime(); }
        void waitingForReply() { idleCheck = false; }
        public void run() {
            if (cancel.cancelled() || idleCheck && System.nanoTime() - last >= IDLE_MILLIS * 1_000_000L) {
                stopped = true;
                try { socket.close(); } catch (IOException ignored) {}
            }
        }
    }

    private final Connector connector;
    private final Memo memo;

    LanSender(Connector connector, Memo memo) { this.connector = connector; this.memo = memo; }

    private Socket open(Peer peer, Address address, int handshakeMillis) throws IOException {
        // The policy is enforced again right before connecting, whatever produced the address.
        if (!NetworkPolicy.lanPeer(address.ip, peer.port) || !address.kind.equals(LanProtocol.addressKind(address.ip))) throw new IOException("Not a LAN peer");
        return connector.open(peer.certSha256, address, peer.port, (int) connectMillis(address), handshakeMillis);
    }

    /** One short request on its own connection; `budget` bounds the TLS handshake and the answer. */
    private Map<String, Object> exchange(Peer peer, Address address, String method, String route, Map<String, Object> json, long budget) throws IOException {
        long started = System.nanoTime();
        Socket socket = open(peer, address, (int) budget);
        try {
            byte[] body = json == null ? null : Json.write(json).getBytes(StandardCharsets.UTF_8);
            OutputStream out = socket.getOutputStream();
            out.write(head(method, LanProtocol.ROOT + "/" + route, address.ip + ":" + peer.port, body == null ? 0 : body.length, body != null));
            if (body != null) out.write(body);
            out.flush();
            socket.setSoTimeout((int) Math.max(500, budget - (System.nanoTime() - started) / 1_000_000L));
            return ok(readReply(socket.getInputStream()));
        } finally { try { socket.close(); } catch (IOException ignored) {} }
    }

    /**
     * Send one file. Never throws for network trouble: the answer says whether the direct send
     * finished, was ended by the receiver or by the user, or the server should take over with
     * the same transfer id. Only a problem with the local file is thrown.
     */
    Outcome send(Peer peer, Job job, Source source, ExchangeTransfer.Progress progress, ExchangeTransfer.Cancel cancel, Route route) throws Local {
        String key = peer.key();
        if (memo.isUnreachable(key)) return new Outcome(Kind.FALLBACK, null, "unreachable", false);
        Address remembered = memo.winner(key);
        List<Address> order = candidates(peer, remembered);
        if (order.isEmpty()) return new Outcome(Kind.FALLBACK, null, "noAddress", false);
        boolean sslFailure = false;
        Address chosen = null;
        Map<String, Object> prepared = null;
        for (Address address : order) {
            if (cancel.cancelled()) return new Outcome(Kind.CANCELLED, null, "cancelled", false);
            try {
                if (!address.same(remembered)) {
                    String refusal = refusal(exchange(peer, address, "GET", "info", null, PROBE_MILLIS), peer, job.size);
                    if (refusal != null) return new Outcome(Kind.FALLBACK, null, refusal, false);
                }
                prepared = exchange(peer, address, "POST", "prepare-upload", job.prepareBody(), REQUEST_MILLIS);
                chosen = address;
                break;
            } catch (LanProtocol.Failure refused) {
                // Reachable but not taking it: the route itself is fine.
                memo.win(key, address);
                return end(refused, decide(refused, false, 0, 0), null);
            } catch (IOException unreachable) {
                sslFailure |= unreachable instanceof SSLException;
                if (address.same(remembered)) memo.forgetWinner(key);
            }
        }
        if (chosen == null) {
            memo.unreachable(key);
            return new Outcome(Kind.FALLBACK, null, "unreachable", sslFailure);
        }
        memo.win(key, chosen);
        route.chosen(chosen.kind);
        int resumes = 0, digests = 0;
        while (true) {
            if ("saved".equals(prepared.get("state"))) return new Outcome(Kind.SAVED, chosen.kind, "saved", false);
            Object offset = prepared.get("offset");
            if (!"upload".equals(prepared.get("state")) || !(offset instanceof Long) || (Long) offset < 0 || (Long) offset > job.size)
                return new Outcome(Kind.FALLBACK, chosen.kind, "invalidReply", false);
            Exception failure;
            try {
                Map<String, Object> done = upload(peer, chosen, job, (Long) offset, source, progress, cancel);
                if ("saved".equals(done.get("state"))) return new Outcome(Kind.SAVED, chosen.kind, "saved", false);
                failure = new IOException("Unexpected upload reply");
            } catch (Local local) {
                throw local;
            } catch (Exception broken) { failure = broken; }
            // The user's cancel always wins; nothing after it may reach the server.
            if (cancel.cancelled()) return new Outcome(Kind.CANCELLED, chosen.kind, "cancelled", false);
            Step step = decide(failure, true, resumes, digests);
            if (step != Step.RESUME) return end(failure, step, chosen.kind);
            if (failure instanceof LanProtocol.Failure && "digestMismatch".equals(((LanProtocol.Failure) failure).body.get("error"))) digests++;
            else resumes++;
            try { prepared = exchange(peer, chosen, "POST", "prepare-upload", job.prepareBody(), REQUEST_MILLIS); }
            catch (Exception again) {
                if (cancel.cancelled()) return new Outcome(Kind.CANCELLED, chosen.kind, "cancelled", false);
                return end(again, decide(again, false, resumes, digests), chosen.kind);
            }
        }
    }

    private static Outcome end(Exception failure, Step step, String route) throws Local {
        if (failure instanceof Local) throw (Local) failure;
        if (step == Step.STOP) {
            boolean local = failure instanceof ExchangeTransfer.Cancelled;
            return new Outcome(local ? Kind.CANCELLED : Kind.PEER_CANCELLED, route, describe(failure), false);
        }
        boolean refresh = failure instanceof SSLException
                || failure instanceof LanProtocol.Failure && ((LanProtocol.Failure) failure).status == 403;
        return new Outcome(Kind.FALLBACK, route, describe(failure), refresh);
    }

    /** Best effort: tell the receiver to drop its part. Failures change nothing. */
    void cancel(Peer peer, String transferId) {
        for (Address address : candidates(peer, memo.winner(peer.key()))) {
            try { exchange(peer, address, "POST", "cancel", LanProtocol.object("transferId", transferId), PROBE_MILLIS); return; }
            catch (LanProtocol.Failure answered) { return; }
            catch (IOException unreachable) { /* next address */ }
        }
    }

    /** PUT bytes [offset, size). A source that yields another count fails locally instead of sending different bytes. */
    private Map<String, Object> upload(Peer peer, Address address, Job job, long offset, Source source,
                                       ExchangeTransfer.Progress progress, ExchangeTransfer.Cancel cancel) throws IOException {
        long length = job.size - offset;
        Socket socket = open(peer, address, (int) PROBE_MILLIS);
        Guard guard = new Guard(socket, cancel);
        ScheduledFuture<?> watch = WATCH.scheduleWithFixedDelay(guard, 250, 250, TimeUnit.MILLISECONDS);
        try {
            socket.setSoTimeout((int) IDLE_MILLIS);
            IOException writeFailure = null;
            try {
                OutputStream out = socket.getOutputStream();
                out.write(head("PUT", LanProtocol.ROOT + "/upload?transferId=" + job.id + "&offset=" + offset,
                        address.ip + ":" + peer.port, length, true));
                InputStream in = openSource(source, offset);
                try {
                    byte[] buffer = new byte[65536];
                    long left = length;
                    progress.bytes(offset, job.size);
                    while (true) {
                        if (cancel.cancelled()) throw new ExchangeTransfer.Cancelled();
                        int n;
                        try { n = in.read(buffer); } catch (IOException unreadable) { throw new Local("sourceUnavailable"); }
                        if (n < 0) break;
                        if (n > left) throw new Local("sizeMismatch");
                        out.write(buffer, 0, n);
                        left -= n;
                        guard.touch();
                        progress.bytes(job.size - left, job.size);
                    }
                    if (left != 0) throw new Local("sizeMismatch");
                } finally { try { in.close(); } catch (IOException ignored) {} }
                out.flush();
            } catch (Local | ExchangeTransfer.Cancelled stop) {
                throw stop;
            } catch (IOException failure) { writeFailure = failure; }
            if (writeFailure != null) {
                if (cancel.cancelled()) throw new ExchangeTransfer.Cancelled();
                if (guard.stopped) throw writeFailure;
                // A receiver that refused early (cancelled, offset, digest) may have answered before it reset.
                Reply late = null;
                try { socket.setSoTimeout(1_500); late = readReply(socket.getInputStream()); } catch (IOException ignored) {}
                if (late != null) ok(late);
                throw writeFailure;
            }
            guard.waitingForReply();
            socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, replyMillis(job.size)));
            try { return ok(readReply(socket.getInputStream())); }
            catch (IOException failure) {
                if (cancel.cancelled()) throw new ExchangeTransfer.Cancelled();
                throw failure;
            }
        } finally {
            watch.cancel(false);
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private static InputStream openSource(Source source, long offset) throws IOException {
        InputStream in;
        try { in = source.open(); } catch (IOException | SecurityException unreadable) { throw new Local("sourceUnavailable"); }
        if (in == null) throw new Local("sourceUnavailable");
        try {
            for (long left = offset; left > 0; ) {
                long n = in.skip(left);
                if (n <= 0) { if (in.read() < 0) throw new Local("sizeMismatch"); n = 1; }
                left -= n;
            }
        } catch (Local shorter) {
            try { in.close(); } catch (IOException ignored) {}
            throw shorter;
        } catch (IOException unreadable) {
            try { in.close(); } catch (IOException ignored) {}
            throw new Local("sourceUnavailable");
        }
        return in;
    }
}
