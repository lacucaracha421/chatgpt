package com.lakomics.mobile;

import android.util.Log;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.cert.*;
import java.security.interfaces.ECPublicKey;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** Foreground-only, mutually pinned TLS 1.3 receiver. One request per connection. */
final class LanReceiver implements Closeable {
    interface Sink {
        String peer(String fingerprint);
        Map<String, Object> info() throws Exception;
        Map<String, Object> prepare(LanProtocol.Prepare request) throws Exception;
        Map<String, Object> upload(String peer, LanProtocol.Request request, InputStream in) throws Exception;
        void cancel(String peer, String id) throws Exception;
    }

    private final Sink sink;
    private final SSLServerSocket server;
    private final Set<SSLSocket> sockets = new HashSet<>();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS,
            new SynchronousQueue<>(), task -> daemon(task, "lakomics-lan-receive"), new ThreadPoolExecutor.AbortPolicy());
    private volatile boolean closed;

    LanReceiver(LanIdentity identity, Sink sink) throws Exception {
        this.sink = sink;
        SSLContext tls = SSLContext.getInstance("TLSv1.3");
        tls.init(new KeyManager[]{identity}, new TrustManager[]{new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Client only"); }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain == null || chain.length == 0 || !(chain[0].getPublicKey() instanceof ECPublicKey)
                        || ((ECPublicKey) chain[0].getPublicKey()).getParams().getCurve().getField().getFieldSize() != 256
                        || sink.peer(fingerprint(chain[0])) == null) throw new CertificateException("Unknown LAN peer");
                // TLS verifies CertificateVerify with this pinned key. Hostnames and dates are irrelevant.
            }
        }}, null);
        server = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket();
        try {
            if (!Arrays.asList(server.getSupportedProtocols()).contains("TLSv1.3")) throw new SSLException("TLS 1.3 unavailable");
            server.setEnabledProtocols(new String[]{"TLSv1.3"}); server.setNeedClientAuth(true);
            server.setReuseAddress(true); server.bind(new InetSocketAddress("0.0.0.0", LanProtocol.PORT), 2);
        } catch (Exception failure) { server.close(); workers.shutdownNow(); throw failure; }
        daemon(this::accept, "lakomics-lan-listen").start();
    }

    private static Thread daemon(Runnable task, String name) { Thread thread = new Thread(task, name); thread.setDaemon(true); return thread; }
    private static String fingerprint(X509Certificate cert) throws CertificateEncodingException {
        return ExchangeTransfer.hex(ExchangeTransfer.sha().digest(cert.getEncoded()));
    }

    private void accept() {
        while (!closed) {
            SSLSocket socket = null;
            try {
                socket = (SSLSocket) server.accept(); socket.setSoTimeout(30_000);
                socket.setEnabledProtocols(new String[]{"TLSv1.3"}); socket.setNeedClientAuth(true);
                synchronized (sockets) { if (closed) { socket.close(); return; } sockets.add(socket); }
                final SSLSocket accepted = socket;
                workers.execute(() -> serve(accepted));
            } catch (IOException | RejectedExecutionException e) {
                if (socket != null) { synchronized (sockets) { sockets.remove(socket); } try { socket.close(); } catch (IOException ignored) {} }
                if (!closed && !(e instanceof RejectedExecutionException)) Log.w("LakomicsExchange", "LAN accept failed", e);
            }
        }
    }

    private void serve(SSLSocket socket) {
        try (SSLSocket connection = socket) {
            connection.startHandshake();
            String pin = fingerprint((X509Certificate) connection.getSession().getPeerCertificates()[0]);
            InputStream in = new BufferedInputStream(connection.getInputStream(), 65536);
            OutputStream out = connection.getOutputStream();
            try {
                LanProtocol.Request request = LanProtocol.read(in);
                // Recheck the live cache after the handshake too (including resumed sessions).
                String peer = sink.peer(pin);
                if (peer == null) throw new LanProtocol.Failure(403, "deviceMismatch");
                Map<String, Object> body;
                if (request.route.equals("info")) body = sink.info();
                else if (request.route.equals("prepare-upload")) body = sink.prepare(new LanProtocol.Prepare(LanProtocol.json(in, request.length), peer));
                else if (request.route.equals("upload")) body = sink.upload(peer, request, in);
                else { sink.cancel(peer, LanProtocol.id(LanProtocol.json(in, request.length))); body = LanProtocol.object("state", "cancelled"); }
                reply(out, 200, body);
            } catch (LanProtocol.Failure failure) { reply(out, failure.status, failure.body); drain(connection, in); }
            catch (ExchangeTransfer.Cancelled cancelled) { reply(out, 410, LanProtocol.object("error", "cancelled")); drain(connection, in); }
            catch (ExchangeTransfer.Corrupt corrupt) { reply(out, 422, LanProtocol.object("error", "digestMismatch")); }
            catch (Exception failure) { reply(out, 503, LanProtocol.object("error", "notReceiving")); }
        } catch (Exception ignored) { /* Interrupted sockets keep their part for a prepare/resume. */ }
        finally { synchronized (sockets) { sockets.remove(socket); } }
    }

    /** Let a sender that was refused mid-upload read the answer instead of a reset: discard a bounded tail briefly. */
    private static void drain(SSLSocket socket, InputStream in) {
        try {
            socket.setSoTimeout(1_000);
            byte[] buffer = new byte[8192];
            for (long left = 1L << 20; left > 0; ) { int n = in.read(buffer); if (n < 0) return; left -= n; }
        } catch (IOException ignored) {}
    }

    private static void reply(OutputStream out, int status, Map<String, Object> value) throws IOException {
        byte[] body = Json.write(value).getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Error")
                + "\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body); out.flush();
    }

    public void close() {
        closed = true;
        try { server.close(); } catch (IOException ignored) {}
        synchronized (sockets) { for (SSLSocket socket : sockets) try { socket.close(); } catch (IOException ignored) {} }
        workers.shutdownNow();
    }
}
