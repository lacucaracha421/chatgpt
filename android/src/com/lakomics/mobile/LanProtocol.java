package com.lakomics.mobile;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;

/** Bounded, unambiguous HTTP/JSON framing for the direct exchange protocol. No Android runtime. */
final class LanProtocol {
    static final int PORT = 53318, LIMIT = 16 * 1024;
    static final String ROOT = "/api/lakomics/lan/v1";

    static final class Failure extends IOException {
        final int status;
        final Map<String, Object> body;
        Failure(int status, String error) { this(status, error, null); }
        Failure(int status, String error, Long offset) {
            super(error); this.status = status;
            body = object("error", error);
            if (offset != null) body.put("offset", offset);
        }
    }

    static Map<String, Object> object(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }

    static final class Request {
        final String method, route, transferId;
        final long length, offset;
        Request(String method, String route, String id, long length, long offset) {
            this.method = method; this.route = route; transferId = id; this.length = length; this.offset = offset;
        }
    }

    /** Reads only headers; the caller streams an upload directly from the same input. */
    static Request read(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int end = 0;
        while (end != 4) {
            int b = in.read();
            if (b < 0) throw new EOFException("Incomplete headers");
            if (bytes.size() == LIMIT) throw new Failure(431, "invalidRequest");
            if (b > 126 || b < 32 && b != 13 && b != 10 && b != 9) throw invalid();
            bytes.write(b);
            end = (end == 0 || end == 2) && b == 13 ? end + 1
                    : (end == 1 || end == 3) && b == 10 ? end + 1 : b == 13 ? 1 : 0;
        }
        String[] lines = bytes.toString("US-ASCII").split("\r\n", -1);
        String[] first = lines[0].split(" ", -1);
        if (first.length != 3 || !first[2].equals("HTTP/1.1")) throw invalid();
        String method = first[0], target = first[1];
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length - 2; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0 || !lines[i].substring(0, colon).matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) throw invalid();
            String key = lines[i].substring(0, colon).toLowerCase(Locale.ROOT);
            String value = lines[i].substring(colon + 1).trim();
            if (value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || headers.put(key, value) != null) throw invalid();
        }
        if (!headers.containsKey("host") || headers.get("host").isEmpty()
                || headers.containsKey("transfer-encoding") || headers.containsKey("expect")) throw invalid();
        String rawLength = headers.get("content-length");
        if (rawLength == null && (method.equals("PUT") || method.equals("POST"))) throw new Failure(411, "invalidRequest");
        long length = rawLength == null ? 0 : number(rawLength);
        if (method.equals("GET") && target.equals(ROOT + "/info") && length == 0)
            return new Request(method, "info", null, 0, 0);
        if (method.equals("POST") && (target.equals(ROOT + "/prepare-upload") || target.equals(ROOT + "/cancel"))) {
            if (length > LIMIT) throw new Failure(413, "invalidRequest");
            return new Request(method, target.endsWith("/cancel") ? "cancel" : "prepare-upload", null, length, 0);
        }
        if (method.equals("PUT") && target.startsWith(ROOT + "/upload?")) {
            Map<String, String> query = new HashMap<>();
            for (String pair : target.substring((ROOT + "/upload?").length()).split("&", -1)) {
                String[] fields = pair.split("=", -1);
                if (fields.length != 2 || query.put(fields[0], fields[1]) != null) throw invalid();
            }
            if (query.size() != 2 || !ExchangeTransfer.uuid(query.get("transferId"))) throw invalid();
            return new Request(method, "upload", query.get("transferId"), length, number(query.get("offset")));
        }
        throw invalid();
    }

    static long number(String raw) throws Failure {
        if (raw == null || !raw.matches("0|[1-9][0-9]{0,18}")) throw invalid();
        try { return Long.parseLong(raw); } catch (NumberFormatException e) { throw invalid(); }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> json(InputStream in, long length) throws IOException {
        if (length < 0 || length > LIMIT) throw new Failure(413, "invalidRequest");
        byte[] bytes = new byte[(int) length];
        int at = 0;
        while (at < bytes.length) {
            int n = in.read(bytes, at, bytes.length - at);
            if (n < 0) throw new EOFException("Incomplete JSON");
            at += n;
        }
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            Object value = Json.parse(text, LIMIT, 16);
            if (!(value instanceof Map)) throw invalid();
            return (Map<String, Object>) value;
        } catch (IllegalArgumentException | CharacterCodingException e) { throw invalid(); }
    }

    static String id(Map<String, Object> body) throws Failure {
        Object id = body.get("transferId");
        if (!(id instanceof String) || !ExchangeTransfer.uuid((String) id)) throw invalid();
        return (String) id;
    }

    static final class Prepare {
        final String id, batch, from, name, sha, hint;
        final long size;
        final Map<String, Object> body;
        Prepare(Map<String, Object> body, String peer) throws Failure {
            this.body = body;
            id = id(body); batch = string(body, "batchId"); from = string(body, "fromDevice");
            name = string(body, "fileName"); sha = string(body, "sha256");
            Object rawSize = body.get("sizeBytes"), rawHint = body.get("contentTypeHint");
            if (!ExchangeTransfer.uuid(batch) || !ExchangeTransfer.uuid(from) || !sha.matches("[0-9a-f]{64}")
                    || name.trim().isEmpty() || name.getBytes(StandardCharsets.UTF_8).length > 255
                    || !(rawSize instanceof Long) || (Long) rawSize < 0
                    || rawHint != null && (!(rawHint instanceof String) || ((String) rawHint).length() > 255)) throw invalid();
            if (!from.equals(peer)) throw new Failure(403, "deviceMismatch");
            size = (Long) rawSize; hint = (String) rawHint;
            if (size > ExchangeTransfer.MAX_FILE_BYTES) throw new Failure(413, "fileTooLarge");
        }
        boolean same(Prepare other) {
            return id.equals(other.id) && batch.equals(other.batch) && from.equals(other.from) && name.equals(other.name)
                    && sha.equals(other.sha) && size == other.size && Objects.equals(hint, other.hint);
        }
    }

    private static String string(Map<String, Object> body, String key) throws Failure {
        Object value = body.get(key);
        if (!(value instanceof String)) throw invalid();
        return (String) value;
    }

    static void offset(long requested, long have, long size, long length) throws Failure {
        if (requested != have) throw new Failure(409, "offsetMismatch", have);
        if (have < 0 || have > size || length != size - have) throw invalid();
    }

    static boolean pin(String expected, byte[] der) {
        return expected != null && expected.matches("[0-9a-f]{64}") && der != null
                && java.security.MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                    ExchangeTransfer.hex(ExchangeTransfer.sha().digest(der)).getBytes(StandardCharsets.US_ASCII));
    }

    /** Literal IPv4 only: RFC1918 LAN or CGNAT Tailscale, never loopback or public IPs. */
    static String addressKind(String ip) {
        if (ip == null) return null;
        String[] fields = ip.split("\\.", -1);
        if (fields.length != 4) return null;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!fields[i].matches("0|[1-9][0-9]{0,2}")) return null;
            n[i] = Integer.parseInt(fields[i]); if (n[i] > 255) return null;
        }
        if (n[0] == 10 || n[0] == 172 && n[1] >= 16 && n[1] <= 31 || n[0] == 192 && n[1] == 168) return "lan";
        return n[0] == 100 && n[1] >= 64 && n[1] <= 127 ? "tailscale" : null;
    }

    static Failure invalid() { return new Failure(422, "invalidRequest"); }
}
