package com.lakomics.mobile;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.*;

/**
 * Direct sender: the pure decisions (candidate order, fallback table, route memo, wire framing) and, over real
 * TLS 1.3 with mutual pinning on loopback, the whole protocol against a scripted receiver.
 */
public final class LanSenderTest {
    private static int checks;
    private static final String ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    private static final String BATCH = "11111111-1111-4111-8111-111111111111";
    private static final String FROM = "22222222-2222-4222-8222-222222222222";
    private static final String PEER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    private static final String PIN = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static void check(boolean value, String what) { checks++; if (!value) throw new AssertionError("check " + checks + ": " + what); }
    private static LanSender.Address addr(String kind, String ip) { return new LanSender.Address(kind, ip); }
    private static InputStream input(String text) { return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)); }
    private static LanProtocol.Failure refused(int status, String code) { return new LanProtocol.Failure(status, code); }
    private static void rejects(Checked action) throws Exception {
        try { action.run(); } catch (IOException expected) { checks++; return; }
        throw new AssertionError("Expected IOException at check " + checks);
    }

    public static void main(String[] args) throws Exception {
        policy();
        memo();
        wire();
        tls();
        System.out.println("LanSender: " + checks + " checks passed");
    }

    // --- pure policy ---------------------------------------------------------------

    private static String ips(List<LanSender.Address> list) {
        StringBuilder text = new StringBuilder();
        for (LanSender.Address a : list) text.append(text.length() == 0 ? "" : ",").append(a.kind.charAt(0)).append(':').append(a.ip);
        return text.toString();
    }

    private static void policy() throws Exception {
        List<LanSender.Address> given = Arrays.asList(addr("tailscale", "100.64.0.5"), addr("lan", "192.168.0.9"), addr("lan", "192.168.0.9"),
                addr("lan", "8.8.8.8"), addr("lan", "100.64.0.6"), addr("tailscale", "10.0.0.1"), addr("lan", "127.0.0.1"), null,
                addr("lan", "10.0.0.2"), addr("lan", "::1"), addr("lan", null));
        LanSender.Peer peer = new LanSender.Peer(PEER, PIN, 53318, given);
        // LAN before Tailscale, duplicates, wrong labels and non-private addresses dropped.
        check(ips(LanSender.candidates(peer, null)).equals("l:192.168.0.9,l:10.0.0.2,t:100.64.0.5"));
        // The recently working route goes first; an unknown one changes nothing.
        check(ips(LanSender.candidates(peer, addr("tailscale", "100.64.0.5"))).equals("t:100.64.0.5,l:192.168.0.9,l:10.0.0.2"));
        check(ips(LanSender.candidates(peer, addr("lan", "10.0.0.2"))).equals("l:10.0.0.2,l:192.168.0.9,t:100.64.0.5"));
        check(ips(LanSender.candidates(peer, addr("lan", "172.16.0.1"))).equals("l:192.168.0.9,l:10.0.0.2,t:100.64.0.5"));
        // Only the contract port, only a well-formed pin, at most four addresses.
        check(LanSender.candidates(new LanSender.Peer(PEER, PIN, 53319, given), null).isEmpty());
        check(LanSender.candidates(new LanSender.Peer(PEER, PIN, 0, given), null).isEmpty());
        check(LanSender.candidates(new LanSender.Peer(PEER, PIN.toUpperCase(Locale.ROOT), 53318, given), null).isEmpty());
        check(LanSender.candidates(new LanSender.Peer(PEER, null, 53318, given), null).isEmpty());
        check(LanSender.candidates(new LanSender.Peer(PEER, PIN, 53318, new ArrayList<LanSender.Address>()), null).isEmpty());
        List<LanSender.Address> many = new ArrayList<>();
        for (int i = 1; i <= 6; i++) many.add(addr("lan", "10.0.0." + i));
        many.add(addr("tailscale", "100.64.0.1"));
        check(ips(LanSender.candidates(new LanSender.Peer(PEER, PIN, 53318, many), null)).equals("l:10.0.0.1,l:10.0.0.2,l:10.0.0.3,l:10.0.0.4"));

        // Connect timeouts and the time allowed for the receiver to verify and publish.
        check(LanSender.connectMillis(addr("lan", "10.0.0.1")) == 1_500 && LanSender.connectMillis(addr("tailscale", "100.64.0.1")) == 3_000);
        check(LanSender.PROBE_MILLIS == 3_000 && LanSender.IDLE_MILLIS == 15_000 && LanSender.ROUTE_MILLIS == 600_000 && LanSender.UNREACHABLE_MILLIS == 60_000);
        check(LanSender.replyMillis(0) == 30_000 && LanSender.replyMillis(ExchangeTransfer.MAX_FILE_BYTES) > LanSender.replyMillis(1L << 20));

        // The fallback decision table.
        IOException lost = new SocketTimeoutException("timeout");
        for (boolean mid : new boolean[]{false, true}) for (int resumes = 0; resumes < 2; resumes++) {
            check(LanSender.decide(new ExchangeTransfer.Cancelled(), mid, resumes, 0) == LanSender.Step.STOP);
            check(LanSender.decide(new LanSender.Local("sourceUnavailable"), mid, resumes, 0) == LanSender.Step.STOP);
            check(LanSender.decide(refused(410, "cancelled"), mid, resumes, 0) == LanSender.Step.STOP);
            for (int[] other : new int[][]{{409}, {503}, {500}, {502}, {403}, {422}, {413}, {411}, {404}, {431}, {429}}) {
                String code = other[0] == 409 ? "busy" : other[0] == 503 ? "notReceiving" : other[0] == 403 ? "deviceMismatch"
                        : other[0] == 413 ? "fileTooLarge" : other[0] == 422 ? "invalidRequest" : "x";
                check(LanSender.decide(refused(other[0], code), mid, resumes, 0) == LanSender.Step.FALLBACK, other[0] + " " + code);
            }
            check(LanSender.decide(new LanSender.PinMismatch(), mid, 1, 1) == LanSender.Step.FALLBACK);
            check(LanSender.decide(new IllegalStateException("bug"), mid, resumes, 0) == LanSender.Step.FALLBACK);
        }
        // Network trouble: before the upload the next candidate or the server; during it one resume, then the server.
        check(LanSender.decide(lost, false, 0, 0) == LanSender.Step.FALLBACK);
        check(LanSender.decide(lost, true, 0, 0) == LanSender.Step.RESUME);
        check(LanSender.decide(lost, true, 1, 0) == LanSender.Step.FALLBACK);
        check(LanSender.decide(lost, true, 0, 1) == LanSender.Step.RESUME);
        check(LanSender.decide(new SSLHandshakeException("pin"), true, 0, 0) == LanSender.Step.RESUME);
        check(LanSender.decide(new EOFException(), true, 1, 0) == LanSender.Step.FALLBACK);
        LanProtocol.Failure offset = new LanProtocol.Failure(409, "offsetMismatch", 5L);
        check(LanSender.decide(offset, true, 0, 0) == LanSender.Step.RESUME && LanSender.decide(offset, true, 1, 0) == LanSender.Step.FALLBACK);
        check(LanSender.decide(offset, false, 0, 0) == LanSender.Step.FALLBACK);
        LanProtocol.Failure digest = refused(422, "digestMismatch");
        check(LanSender.decide(digest, true, 0, 0) == LanSender.Step.RESUME && LanSender.decide(digest, true, 0, 1) == LanSender.Step.FALLBACK);
        check(LanSender.decide(digest, true, 1, 0) == LanSender.Step.RESUME && LanSender.decide(digest, false, 0, 0) == LanSender.Step.FALLBACK);

        // Receiver self-description.
        Map<String, Object> info = LanProtocol.object("protocol", 1L, "deviceId", PEER, "name", "PC", "kind", "windows", "receiving", true, "maxFileBytes", 100L);
        check(LanSender.refusal(info, peer, 100) == null && LanSender.refusal(info, peer, 0) == null);
        check("fileTooLarge".equals(LanSender.refusal(info, peer, 101)));
        info.put("receiving", false);
        check("notReceiving".equals(LanSender.refusal(info, peer, 1)));
        info.put("receiving", true); info.put("deviceId", FROM);
        check("device".equals(LanSender.refusal(info, peer, 1)));
        info.put("deviceId", PEER); info.put("protocol", 2L);
        check("protocol".equals(LanSender.refusal(info, peer, 1)));
        info.put("protocol", 1L); info.remove("maxFileBytes");
        check("fileTooLarge".equals(LanSender.refusal(info, peer, 1)));

        // NetworkPolicy.lanPeer is the gate in front of every connection.
        check(NetworkPolicy.lanPeer("192.168.0.2", 53318) && NetworkPolicy.lanPeer("10.1.2.3", 53318) && NetworkPolicy.lanPeer("172.20.0.1", 53318)
                && NetworkPolicy.lanPeer("100.100.1.2", 53318));
        for (String bad : new String[]{"127.0.0.1", "8.8.8.8", "169.254.1.1", "172.32.0.1", "100.128.0.1", "0.0.0.0", "::1", "example.com", "", "10.0.0"})
            check(!NetworkPolicy.lanPeer(bad, 53318));
        check(!NetworkPolicy.lanPeer(null, 53318) && !NetworkPolicy.lanPeer("192.168.0.2", 53319) && !NetworkPolicy.lanPeer("192.168.0.2", 0));
    }

    private static void memo() {
        long[] clock = {5_000};
        LanSender.Memo memo = new LanSender.Memo(() -> clock[0]);
        check(memo.winner("a") == null && !memo.isUnreachable("a"));
        LanSender.Address route = addr("tailscale", "100.64.0.2");
        memo.win("a", route);
        check(memo.winner("a") == route);
        clock[0] += LanSender.ROUTE_MILLIS - 1;
        check(memo.winner("a") == route);
        clock[0] += 1;
        check(memo.winner("a") == null);
        // Unreachable for exactly 60 s, and it drops a remembered route.
        memo.win("a", route); memo.unreachable("a");
        check(memo.winner("a") == null && memo.isUnreachable("a") && !memo.isUnreachable("b"));
        clock[0] += LanSender.UNREACHABLE_MILLIS - 1;
        check(memo.isUnreachable("a"));
        clock[0] += 1;
        check(!memo.isUnreachable("a"));
        // A route that worked clears the unreachable mark; forgetting drops only the route.
        memo.unreachable("a"); memo.win("a", route);
        check(!memo.isUnreachable("a") && memo.winner("a") == route);
        memo.forgetWinner("a");
        check(memo.winner("a") == null);
        // Bounded.
        for (int i = 0; i < 500; i++) { memo.win("k" + i, route); memo.unreachable("u" + i); }
        check(memo.winner("k0") == null && memo.winner("k499") == route && !memo.isUnreachable("u0") && memo.isUnreachable("u499"));
    }

    // --- wire framing ----------------------------------------------------------------

    private static String http(int status, String body) {
        return "HTTP/1.1 " + status + " X\r\nContent-Type: application/json\r\nContent-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\nConnection: close\r\n\r\n" + body;
    }

    private static void wire() throws Exception {
        String host = "192.168.0.2:53318";
        LanProtocol.Request info = LanProtocol.read(new ByteArrayInputStream(LanSender.head("GET", LanProtocol.ROOT + "/info", host, 0, false)));
        check(info.route.equals("info") && info.length == 0);
        LanProtocol.Request prepare = LanProtocol.read(new ByteArrayInputStream(LanSender.head("POST", LanProtocol.ROOT + "/prepare-upload", host, 123, true)));
        check(prepare.route.equals("prepare-upload") && prepare.length == 123);
        LanProtocol.Request cancel = LanProtocol.read(new ByteArrayInputStream(LanSender.head("POST", LanProtocol.ROOT + "/cancel", host, 5, true)));
        check(cancel.route.equals("cancel") && cancel.length == 5);
        LanProtocol.Request upload = LanProtocol.read(new ByteArrayInputStream(
                LanSender.head("PUT", LanProtocol.ROOT + "/upload?transferId=" + ID + "&offset=70000", host, 130000, true)));
        check(upload.route.equals("upload") && upload.transferId.equals(ID) && upload.offset == 70000 && upload.length == 130000);
        LanProtocol.Request empty = LanProtocol.read(new ByteArrayInputStream(
                LanSender.head("PUT", LanProtocol.ROOT + "/upload?transferId=" + ID + "&offset=0", host, 0, true)));
        check(empty.length == 0);
        // The prepare body is exactly what the receiver validates.
        LanSender.Job job = new LanSender.Job(ID, BATCH, FROM, "photo.jpg", 3, PIN, "image/jpeg");
        LanProtocol.Prepare accepted = new LanProtocol.Prepare(LanProtocol.json(input(Json.write(job.prepareBody())), Json.write(job.prepareBody()).getBytes(StandardCharsets.UTF_8).length), FROM);
        check(accepted.id.equals(ID) && accepted.size == 3 && "image/jpeg".equals(accepted.hint) && accepted.sha.equals(PIN));
        check(!new LanSender.Job(ID, BATCH, FROM, "photo.jpg", 3, PIN, null).prepareBody().containsKey("contentTypeHint"));

        // Replies.
        LanSender.Reply ok = LanSender.readReply(input(http(200, "{\"state\":\"upload\",\"offset\":5}")));
        check(ok.status == 200 && "upload".equals(ok.body.get("state")) && Long.valueOf(5).equals(ok.body.get("offset")));
        check(LanSender.ok(ok) == ok.body);
        try { LanSender.ok(LanSender.readReply(input(http(409, "{\"error\":\"offsetMismatch\",\"offset\":5}")))); check(false); }
        catch (LanProtocol.Failure failure) { check(failure.status == 409 && "offsetMismatch".equals(failure.body.get("error")) && Long.valueOf(5).equals(failure.body.get("offset"))); }
        try { LanSender.ok(LanSender.readReply(input("HTTP/1.1 503 Error\r\nContent-Length: 0\r\n\r\n"))); check(false); }
        catch (LanProtocol.Failure failure) { check(failure.status == 503 && "unknown".equals(failure.body.get("error"))); }
        for (String bad : new String[]{"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}", "HTTP/1.1 99 X\r\nContent-Length: 2\r\n\r\n{}",
                "HTTP/1.1 200 OK\r\n\r\n{}", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "HTTP/1.1 200 OK\r\nContent-Length: 16385\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n{}", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]",
                "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nnull", "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 2",
                "HTTP/1.1 200 OK\r\nBad header\r\nContent-Length: 2\r\n\r\n{}"})
            rejects(() -> LanSender.readReply(input(bad)));
    }

    // --- TLS 1.3 with mutual pinning against a scripted receiver -----------------------

    private static Path keystore(Path dir, String name) throws Exception {
        Path file = dir.resolve(name + ".p12");
        String keytool = Paths.get(System.getProperty("java.home"), "bin", Files.exists(Paths.get(System.getProperty("java.home"), "bin", "keytool.exe")) ? "keytool.exe" : "keytool").toString();
        Process process = new ProcessBuilder(keytool, "-genkeypair", "-alias", "k", "-keyalg", "EC", "-keysize", "256", "-sigalg", "SHA256withECDSA",
                "-dname", "CN=" + name, "-validity", "3650", "-storetype", "PKCS12", "-keystore", file.toString(), "-storepass", "changeit", "-keypass", "changeit")
                .redirectErrorStream(true).start();
        byte[] output = process.getInputStream().readAllBytes();
        if (process.waitFor() != 0) throw new IOException("keytool failed: " + new String(output));
        return file;
    }

    private static KeyStore load(Path file) throws Exception {
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(file)) { store.load(in, "changeit".toCharArray()); }
        return store;
    }

    private static KeyManager keys(KeyStore store) throws Exception {
        KeyManagerFactory factory = KeyManagerFactory.getInstance("SunX509");
        factory.init(store, "changeit".toCharArray());
        return factory.getKeyManagers()[0];
    }

    private static String pinOf(KeyStore store) throws Exception {
        return ExchangeTransfer.hex(ExchangeTransfer.sha().digest(store.getCertificate("k").getEncoded()));
    }

    /** A receiver that follows the contract and can be told to misbehave. One connection at a time. */
    private static final class Receiver implements Closeable {
        final SSLServerSocket server;
        volatile String clientPin;
        final AtomicInteger infos = new AtomicInteger(), prepares = new AtomicInteger(), uploads = new AtomicInteger(), cancels = new AtomicInteger();
        final List<Long> offsets = Collections.synchronizedList(new ArrayList<>());
        final Deque<Integer> drops = new ArrayDeque<>();
        final ByteArrayOutputStream part = new ByteArrayOutputStream();
        volatile byte[] stored;
        volatile boolean receiving = true, alreadySaved, cancelled;
        volatile String prepareFail, uploadFail;
        volatile int corrupt;
        volatile String sha;
        volatile long size;

        Receiver(KeyManager keys, String clientPin, String protocol) throws Exception {
            this.clientPin = clientPin;
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(new KeyManager[]{keys}, new TrustManager[]{new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException { throw new CertificateException("client only"); }
                public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
                    if (!LanProtocol.pin(Receiver.this.clientPin, chain[0].getEncoded())) throw new CertificateException("unknown peer");
                }
            }}, null);
            server = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket(0, 8, InetAddress.getLoopbackAddress());
            server.setNeedClientAuth(true);
            server.setEnabledProtocols(new String[]{protocol});
            Thread thread = new Thread(() -> {
                while (!server.isClosed()) {
                    try { serve((SSLSocket) server.accept()); } catch (IOException closed) { /* shutting down */ }
                }
            }, "fake-lan-receiver");
            thread.setDaemon(true);
            thread.start();
        }

        int port() { return server.getLocalPort(); }

        void reset() {
            infos.set(0); prepares.set(0); uploads.set(0); cancels.set(0); offsets.clear(); drops.clear(); part.reset(); stored = null;
            receiving = true; alreadySaved = false; cancelled = false; prepareFail = null; uploadFail = null; corrupt = 0; sha = null; size = 0;
        }

        private void reply(OutputStream out, int status, Map<String, Object> value) throws IOException {
            byte[] body = Json.write(value).getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Error") + "\r\nContent-Type: application/json\r\nContent-Length: " + body.length
                    + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(body);
            out.flush();
        }

        private void fail(OutputStream out, String script) throws IOException {
            String[] parts = script.split(":");
            reply(out, Integer.parseInt(parts[0]), LanProtocol.object("error", parts[1]));
        }

        private void serve(SSLSocket socket) {
            try (SSLSocket connection = socket) {
                connection.setSoTimeout(10_000);
                connection.startHandshake();
                // Like the real receiver: recheck after the handshake, which a resumed TLS session skips.
                if (!LanProtocol.pin(clientPin, connection.getSession().getPeerCertificates()[0].getEncoded())) return;
                InputStream in = new BufferedInputStream(connection.getInputStream());
                OutputStream out = connection.getOutputStream();
                LanProtocol.Request request = LanProtocol.read(in);
                switch (request.route) {
                    case "info":
                        infos.incrementAndGet();
                        reply(out, 200, LanProtocol.object("protocol", 1L, "deviceId", PEER, "name", "PC", "kind", "windows", "receiving", receiving,
                                "maxFileBytes", ExchangeTransfer.MAX_FILE_BYTES));
                        break;
                    case "prepare-upload": {
                        prepares.incrementAndGet();
                        Map<String, Object> body = LanProtocol.json(in, request.length);
                        LanProtocol.Prepare prepare = new LanProtocol.Prepare(body, FROM);
                        if (cancelled) { reply(out, 410, LanProtocol.object("error", "cancelled")); break; }
                        if (prepareFail != null) { fail(out, prepareFail); break; }
                        if (alreadySaved) { reply(out, 200, LanProtocol.object("state", "saved")); break; }
                        sha = prepare.sha; size = prepare.size;
                        reply(out, 200, LanProtocol.object("state", "upload", "offset", (long) part.size()));
                        break;
                    }
                    case "cancel":
                        cancels.incrementAndGet();
                        LanProtocol.id(LanProtocol.json(in, request.length));
                        cancelled = true;
                        reply(out, 200, LanProtocol.object("state", "cancelled"));
                        break;
                    case "upload": {
                        uploads.incrementAndGet();
                        offsets.add(request.offset);
                        long have = part.size();
                        if (request.offset != have) { reply(out, 409, LanProtocol.object("error", "offsetMismatch", "offset", have)); break; }
                        byte[] body = new byte[(int) request.length];
                        Integer drop = drops.peek();
                        boolean dropNow = drop != null && drop < have + body.length;
                        int stop = dropNow ? (int) Math.max(0, drop - have) : body.length;
                        for (int at = 0; at < stop; ) { int n = in.read(body, at, stop - at); if (n < 0) throw new EOFException(); at += n; }
                        if (dropNow) { part.write(body, 0, stop); drops.poll(); break; }
                        String scripted = uploadFail;
                        if (scripted != null) {
                            uploadFail = null;
                            if (scripted.endsWith("offsetMismatch")) reply(out, 409, LanProtocol.object("error", "offsetMismatch", "offset", have));
                            else fail(out, scripted);
                            break;
                        }
                        part.write(body);
                        String actual = ExchangeTransfer.hex(ExchangeTransfer.sha().digest(part.toByteArray()));
                        if (corrupt > 0 || !actual.equals(sha)) {
                            if (corrupt > 0) corrupt--;
                            part.reset();
                            reply(out, 422, LanProtocol.object("error", "digestMismatch"));
                            break;
                        }
                        stored = part.toByteArray();
                        part.reset();
                        reply(out, 200, LanProtocol.object("state", "saved"));
                        break;
                    }
                    default: throw new IOException("route");
                }
            } catch (Exception ignored) { /* a dropped or refused connection */ }
        }

        public void close() throws IOException { server.close(); }
    }

    private static final class Harness extends LanSender.Tls {
        final int port;
        final Set<String> dead = new HashSet<>();
        final List<String> attempts = Collections.synchronizedList(new ArrayList<>());
        Harness(KeyManager keys, int port) { super(keys); this.port = port; }
        InetSocketAddress target(LanSender.Address address, int ignoredPort) throws IOException {
            attempts.add(address.ip);
            if (dead.contains(address.ip)) throw new ConnectException("down " + address.ip);
            return new InetSocketAddress(InetAddress.getLoopbackAddress(), port);
        }
    }

    private static byte[] bytes(int length) {
        byte[] data = new byte[length];
        new Random(42).nextBytes(data);
        return data;
    }

    private static void tls() throws Exception {
        Path dir = Files.createTempDirectory("lan-sender-test");
        try {
            KeyStore receiverStore = load(keystore(dir, "receiver")), senderStore = load(keystore(dir, "sender")), strangerStore = load(keystore(dir, "stranger"));
            KeyManager senderKeys = keys(senderStore);
            String receiverPin = pinOf(receiverStore), senderPin = pinOf(senderStore);
            try (Receiver receiver = new Receiver(keys(receiverStore), senderPin, "TLSv1.3")) {
                transfers(receiver, senderKeys, receiverPin, pinOf(strangerStore), senderPin);
            }
            // A receiver that offers only TLS 1.2 is refused: the sender never talks below TLS 1.3.
            try (Receiver old = new Receiver(keys(receiverStore), senderPin, "TLSv1.2")) {
                Harness harness = new Harness(senderKeys, old.port());
                LanSender sender = new LanSender(harness, new LanSender.Memo(System::currentTimeMillis));
                LanSender.Outcome outcome = sender.send(peer(receiverPin), job(bytes(10)), () -> new ByteArrayInputStream(bytes(10)), (d, t) -> {}, () -> false, k -> {});
                check(outcome.kind == LanSender.Kind.FALLBACK && "unreachable".equals(outcome.reason) && outcome.refresh);
                check(old.infos.get() == 0 && old.prepares.get() == 0);
            }
        } finally {
            try (java.util.stream.Stream<Path> files = Files.walk(dir)) { files.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
        }
    }

    private static LanSender.Peer peer(String pin) {
        return new LanSender.Peer(PEER, pin, 53318, Arrays.asList(addr("lan", "192.168.1.20"), addr("tailscale", "100.100.1.2")));
    }

    private static LanSender.Job job(byte[] data) {
        return new LanSender.Job(ID, BATCH, FROM, "photo.jpg", data.length, ExchangeTransfer.hex(ExchangeTransfer.sha().digest(data)), "image/jpeg");
    }

    private static void transfers(Receiver r, KeyManager senderKeys, String receiverPin, String strangerPin, String senderPin) throws Exception {
        byte[] data = bytes(200_000);
        LanSender.Job job = job(data);
        LanSender.Source source = () -> new ByteArrayInputStream(data);
        long[] clock = {1_000};
        LanSender.Memo memo = new LanSender.Memo(() -> clock[0]);
        Harness harness = new Harness(senderKeys, r.port());
        LanSender sender = new LanSender(harness, memo);
        LanSender.Peer peer = peer(receiverPin);
        List<String> routes = new ArrayList<>();
        long[] last = {-1};
        LanSender.Route route = routes::add;
        ExchangeTransfer.Progress progress = (done, total) -> { last[0] = done; check(total == data.length); };
        boolean[] cancel = {false};
        ExchangeTransfer.Cancel cancelled = () -> cancel[0];

        // 1. First contact: connect, /info, prepare, upload, saved. LAN first.
        LanSender.Outcome outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && "lan".equals(outcome.route) && routes.equals(Arrays.asList("lan")));
        check(Arrays.equals(r.stored, data) && last[0] == data.length);
        check(r.infos.get() == 1 && r.prepares.get() == 1 && r.uploads.get() == 1 && r.offsets.equals(Arrays.asList(0L)));
        check(harness.attempts.get(0).equals("192.168.1.20") && harness.attempts.size() == 3);

        // 2. A remembered route skips /info.
        r.reset(); routes.clear(); harness.attempts.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && r.infos.get() == 0 && r.prepares.get() == 1 && Arrays.equals(r.stored, data));

        // 3. LAN down: Tailscale wins, and then goes first for ten minutes.
        r.reset(); routes.clear(); harness.attempts.clear();
        LanSender.Memo fresh = new LanSender.Memo(() -> clock[0]);
        sender = new LanSender(harness, fresh);
        harness.dead.add("192.168.1.20");
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && "tailscale".equals(outcome.route) && routes.equals(Arrays.asList("tailscale")));
        check(harness.attempts.get(0).equals("192.168.1.20") && harness.attempts.get(1).equals("100.100.1.2"));
        r.reset(); harness.attempts.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && harness.attempts.get(0).equals("100.100.1.2") && !harness.attempts.contains("192.168.1.20") && r.infos.get() == 0);
        clock[0] += LanSender.ROUTE_MILLIS;
        r.reset(); harness.attempts.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && harness.attempts.get(0).equals("192.168.1.20") && r.infos.get() == 1);

        // 4. Everything down: fall back, remember for 60 s so the rest of a batch goes straight to the server.
        sender = new LanSender(harness, new LanSender.Memo(() -> clock[0]));
        harness.dead.add("100.100.1.2"); r.reset(); harness.attempts.clear(); routes.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && "unreachable".equals(outcome.reason) && !outcome.refresh && routes.isEmpty());
        check(harness.attempts.equals(Arrays.asList("192.168.1.20", "100.100.1.2")));
        harness.attempts.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && harness.attempts.isEmpty());
        clock[0] += LanSender.UNREACHABLE_MILLIS - 1;
        sender.send(peer, job, source, progress, cancelled, route);
        check(harness.attempts.isEmpty());
        clock[0] += 1;
        harness.dead.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && !harness.attempts.isEmpty());

        // 5. The wrong pin (a different certificate) never gets a request and asks for a peer refresh.
        sender = new LanSender(harness, new LanSender.Memo(() -> clock[0]));
        r.reset(); harness.attempts.clear();
        outcome = sender.send(peer(strangerPin), job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && outcome.refresh && r.infos.get() == 0 && r.prepares.get() == 0 && r.uploads.get() == 0);
        // The receiver not knowing us (our certificate unpinned there) ends in a fallback too, with no request served.
        r.clientPin = strangerPin;
        sender = new LanSender(harness, new LanSender.Memo(() -> clock[0]));
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && r.infos.get() == 0 && r.prepares.get() == 0);
        r.clientPin = senderPin;

        // 6. Reachable but not receiving: server path, but the route is not marked unreachable.
        sender = new LanSender(harness, new LanSender.Memo(() -> clock[0]));
        r.reset(); r.receiving = false; harness.attempts.clear(); routes.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && "notReceiving".equals(outcome.reason) && r.prepares.get() == 0 && routes.isEmpty());
        r.receiving = true;
        check(sender.send(peer, job, source, progress, cancelled, route).kind == LanSender.Kind.SAVED);

        // 7. Refusals at prepare: busy, notReceiving, server errors, deviceMismatch. Always the server, never an upload.
        for (String script : new String[]{"409:busy", "503:notReceiving", "500:internal", "502:x", "403:deviceMismatch", "422:invalidRequest", "413:fileTooLarge"}) {
            r.reset(); r.prepareFail = script;
            outcome = sender.send(peer, job, source, progress, cancelled, route);
            check(outcome.kind == LanSender.Kind.FALLBACK && r.uploads.get() == 0 && r.prepares.get() == 1, script);
            check(outcome.refresh == script.startsWith("403"), script);
        }

        // 8. The receiver's user cancelled: the row ends cancelled, no fallback.
        r.reset(); r.prepareFail = "410:cancelled";
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.PEER_CANCELLED && r.uploads.get() == 0);
        r.reset(); r.cancelled = true;
        check(sender.send(peer, job, source, progress, cancelled, route).kind == LanSender.Kind.PEER_CANCELLED);

        // 9. The receiver already has it.
        r.reset(); r.alreadySaved = true; routes.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && r.uploads.get() == 0 && routes.size() == 1);

        // 10. Mid-upload loss: one direct resume from the receiver's offset, then saved.
        r.reset(); r.drops.add(70_000); routes.clear();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && r.uploads.get() == 2 && r.prepares.get() == 2 && Arrays.equals(r.stored, data));
        check(r.offsets.get(0) == 0 && r.offsets.get(1) == 70_000 && routes.size() == 1);
        // A second loss goes to the server.
        r.reset(); r.drops.add(70_000); r.drops.add(150_000);
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && r.uploads.get() == 2 && r.stored == null);

        // 11. Digest mismatch: restart once from zero; a second one goes to the server.
        r.reset(); r.corrupt = 1;
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && r.uploads.get() == 2 && r.offsets.get(1) == 0 && Arrays.equals(r.stored, data));
        r.reset(); r.corrupt = 2;
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && r.uploads.get() == 2 && r.stored == null);

        // 12. Offset mismatch resumes once from the receiver's answer.
        r.reset(); r.uploadFail = "409:offsetMismatch";
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.SAVED && r.uploads.get() == 2 && Arrays.equals(r.stored, data));

        // 13. The receiver cancels while the file is arriving.
        r.reset(); r.uploadFail = "410:cancelled";
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.PEER_CANCELLED && r.uploads.get() == 1 && r.prepares.get() == 1);
        // A server error on the upload ends direct sending.
        r.reset(); r.uploadFail = "503:notReceiving";
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.FALLBACK && r.uploads.get() == 1);

        // 14. The user's cancel mid-upload: nothing is resumed or sent to the server.
        r.reset(); cancel[0] = false;
        ExchangeTransfer.Progress cancelling = (done, total) -> { if (done > 64_000) cancel[0] = true; };
        outcome = sender.send(peer, job, source, cancelling, cancelled, route);
        Thread.sleep(300);
        check(outcome.kind == LanSender.Kind.CANCELLED && r.prepares.get() == 1 && r.uploads.get() == 1 && r.stored == null);
        // Cancelled before it starts: no connection at all.
        harness.attempts.clear(); r.reset();
        outcome = sender.send(peer, job, source, progress, cancelled, route);
        check(outcome.kind == LanSender.Kind.CANCELLED && harness.attempts.isEmpty());
        cancel[0] = false;

        // 15. Problems with the local file are thrown, never turned into a fallback.
        for (Object[] broken : new Object[][]{
                {(LanSender.Source) () -> { throw new FileNotFoundException(); }, "sourceUnavailable"},
                {(LanSender.Source) () -> { throw new SecurityException(); }, "sourceUnavailable"},
                {(LanSender.Source) () -> null, "sourceUnavailable"},
                {(LanSender.Source) () -> new InputStream() {
                    int n; public int read() throws IOException { throw new IOException("gone"); }
                    public int read(byte[] b, int o, int l) throws IOException { if (n++ > 0) throw new IOException("gone"); Arrays.fill(b, o, o + 100, (byte) 1); return 100; } }, "sourceUnavailable"},
                {(LanSender.Source) () -> new ByteArrayInputStream(Arrays.copyOf(data, data.length - 1)), "sizeMismatch"},
                {(LanSender.Source) () -> new ByteArrayInputStream(Arrays.copyOf(data, data.length + 1)), "sizeMismatch"}}) {
            r.reset();
            try { sender.send(peer, job, (LanSender.Source) broken[0], progress, cancelled, route); check(false, "expected Local"); }
            catch (LanSender.Local local) { check(local.code.equals(broken[1]), local.code); }
            check(r.stored == null);
        }
        Thread.sleep(300);

        // 16. Telling the receiver to drop the transfer; it then refuses the id.
        r.reset();
        sender.cancel(peer, ID);
        check(r.cancels.get() == 1 && r.cancelled);
        check(sender.send(peer, job, source, progress, cancelled, route).kind == LanSender.Kind.PEER_CANCELLED);
        // An unreachable receiver is not an error.
        harness.dead.add("192.168.1.20"); harness.dead.add("100.100.1.2"); r.reset();
        sender.cancel(peer, ID);
        check(r.cancels.get() == 0);
    }
}
