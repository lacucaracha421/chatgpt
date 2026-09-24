package com.lakomics.mobile;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.*;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** PC ADR-0039 format. No Android API, persistence, or media cache. */
final class VaultCrypto {
    static final int CHUNK = 65536, HEADER = 38, TAG = 16;
    static final int MAX_INDEX = 256 * 1024 * 1024;
    static final String INDEX_ID = "00000000000000000000000000000000";
    static class Invalid extends Exception {
        Invalid() { super("비밀 보관함 데이터가 손상됐습니다"); }
        Invalid(String message) { super(message); }
    }
    static final class Unsupported extends Invalid {
        Unsupported() { super("지원하지 않는 비밀 보관함 형식입니다"); }
    }
    interface Source extends Closeable {
        long size() throws IOException;
        byte[] read(long offset, int length) throws IOException;
    }
    static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    static void wipe(byte[] b) { if (b != null) Arrays.fill(b, (byte) 0); }
    static byte[] hex(String s, int bytes) throws Invalid {
        if (s == null || s.length() != bytes * 2 || !s.matches("[0-9a-fA-F]+")) throw new Invalid();
        byte[] out = new byte[bytes];
        for (int i = 0; i < bytes; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
    static byte[] objectId(String s) throws Invalid {
        if (s == null || !s.matches("[0-9a-f]{32}")) throw new Invalid();
        return hex(s, 16);
    }
    static byte[] recovery(String text) throws Invalid {
        return hex(text.replaceAll("[ \\-\\t\\r\\n]", ""), 32);
    }
    @SuppressWarnings("unchecked")
    static Map<String,Object> map(Object o) throws Invalid {
        if (!(o instanceof Map)) throw new Invalid();
        return (Map<String,Object>) o;
    }
    static String string(Map<String,Object> m, String key) throws Invalid {
        Object v = m.get(key); if (!(v instanceof String)) throw new Invalid(); return (String) v;
    }
    static String optional(Map<String,Object> m, String key) throws Invalid {
        return m.get(key) == null ? null : string(m, key);
    }
    static long number(Map<String,Object> m, String key) throws Invalid {
        Object v = m.get(key); if (!(v instanceof Long) || (Long) v < 0) throw new Invalid(); return (Long) v;
    }
    static Map<String,Object> json(byte[] bytes, int max) throws Invalid {
        try {
            String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            return map(Json.parse(text, max, 128));
        } catch (Exception e) { throw new Invalid(); }
    }
    static byte[] concat(byte[]... parts) {
        int length = 0; for (byte[] b : parts) length += b.length;
        ByteBuffer out = ByteBuffer.allocate(length); for (byte[] b : parts) out.put(b); return out.array();
    }
    static byte[] hmac(byte[] key, byte[] input) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256")); return mac.doFinal(input);
    }
    // Use UTF-8 bytes exactly like ring, including non-ASCII passwords. PBEKeySpec
    // provider password encodings have differed; HMAC also handles this identically on JVM.
    static byte[] password(String password, int iterations, byte[] salt) throws GeneralSecurityException {
        byte[] bytes = utf8(password), u = null, out = null;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(bytes.length == 0 ? new byte[1] : bytes, "HmacSHA256"));
            u = mac.doFinal(concat(salt, new byte[]{0,0,0,1})); out = u.clone();
            for (int i = 1; i < iterations; i++) {
                byte[] next = mac.doFinal(u); wipe(u); u = next;
                for (int j = 0; j < out.length; j++) out[j] ^= u[j];
            }
            return out;
        } finally { wipe(bytes); wipe(u); }
    }
    static byte[] decrypt(byte[] key, byte[] nonce, byte[] aad, byte[] ct) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key,"AES"), new GCMParameterSpec(128,nonce));
        cipher.updateAAD(aad); return cipher.doFinal(ct);
    }
    static final class Header {
        final UUID uuid;
        final byte[] uuidBytes;
        final Map<String,Object> fields, kdf;
        final int iterations;
        Header(byte[] json) throws Invalid {
            fields = json(json, 1024 * 1024); kdf = map(fields.get("kdf"));
            if (number(fields,"formatVersion") != 1 || !string(kdf,"name").equals("pbkdf2-hmac-sha256")) throw new Unsupported();
            long count = number(kdf,"iterations");
            if (count < 600000 || count > 20000000) throw new Invalid();
            iterations = (int) count; hex(string(kdf,"salt"),16);
            try {
                String id = string(fields,"vaultId");
                // UUID parsers on older Java accept shortened groups. Never accept those.
                String raw = id.replaceFirst("^urn:uuid:", "");
                if (raw.startsWith("{") && raw.endsWith("}")) raw = raw.substring(1,raw.length()-1);
                if (raw.matches("[0-9a-fA-F]{32}")) raw = raw.replaceFirst("(.{8})(.{4})(.{4})(.{4})(.{12})", "$1-$2-$3-$4-$5");
                if (!raw.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) throw new Invalid();
                uuid = UUID.fromString(raw);
                uuidBytes = ByteBuffer.allocate(16).putLong(uuid.getMostSignificantBits()).putLong(uuid.getLeastSignificantBits()).array();
            } catch (IllegalArgumentException e) { throw new Invalid(); }
        }
        byte[] unlock(String secret, boolean byRecovery) throws Invalid {
            byte[] key = null;
            try {
                key = byRecovery ? recovery(secret) : password(secret,iterations,hex(string(kdf,"salt"),16));
                String kind = byRecovery ? "recovery" : "password";
                Map<String,Object> wrap = map(fields.get(kind+"Wrap"));
                return decrypt(key,hex(string(wrap,"nonce"),12),utf8("lakomics-vault/wrap/v1/"+uuid+"/"+kind),hex(string(wrap,"ciphertext"),48));
            } catch (GeneralSecurityException e) { throw new Invalid("비밀번호 또는 복구 키가 맞지 않습니다"); }
            finally { wipe(key); }
        }
    }
    static final class Item {
        final String id, object, title, kind, thumbnail, poster, mime;
        final long width, height; // 0 when the index has no dimension
        final boolean trashed;
        Item(Map<String,Object> m) throws Invalid {
            id = string(m,"id"); object = string(m,"objectId"); objectId(object);
            kind = string(m,"kind"); if (!kind.equals("image") && !kind.equals("video")) throw new Invalid();
            String filename = string(m,"originalFileName");
            string(m,"originalRelativePath"); string(m,"importedAt"); number(m,"byteSize");
            for (String field : new String[]{"width","height"})
                if (m.get(field) != null && number(m,field) > 0xffffffffL) throw new Invalid();
            width = m.get("width") == null ? 0 : number(m,"width"); height = m.get("height") == null ? 0 : number(m,"height");
            optional(m,"contentSha256"); optional(m,"thumbnailSha256");
            String customTitle = optional(m,"title"); title = customTitle == null ? filename : customTitle;
            thumbnail = optional(m,"thumbnailObjectId"); poster = optional(m,"posterObjectId");
            if (thumbnail != null) objectId(thumbnail); if (poster != null) objectId(poster);
            trashed = optional(m,"trashedAt") != null;
            // v1 has no MIME field: PC derives it from the authenticated index filename.
            mime = mime(filename);
        }
    }
    static List<Item> index(byte[] bytes) throws Invalid {
        Map<String,Object> root = json(bytes, MAX_INDEX);
        if (number(root,"formatVersion") != 1) throw new Unsupported();
        number(root,"revision");
        if (!(root.get("items") instanceof List)) throw new Invalid();
        List<Item> items = new ArrayList<>(); Set<String> ids = new HashSet<>();
        for (Object v : (List<?>) root.get("items")) {
            Item item = new Item(map(v)); if (!ids.add(item.id)) throw new Invalid(); items.add(item);
        }
        return items;
    }
    static String mime(String filename) {
        int dot = filename.lastIndexOf('.');
        if (dot <= 0) return "application/octet-stream";
        String ext = filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "jpg": case "jpeg": case "jfif": return "image/jpeg";
            case "png": return "image/png"; case "webp": return "image/webp"; case "gif": return "image/gif";
            case "avif": return "image/avif";
            case "mp4": case "m4v": return "video/mp4"; case "webm": return "video/webm";
            case "mov": return "video/quicktime";
            default: return "application/octet-stream";
        }
    }
    static String thumbnailMime(byte[] head) {
        if (head.length >= 3 && (head[0]&255)==255 && (head[1]&255)==216 && (head[2]&255)==255) return "image/jpeg";
        if (head.length >= 8 && Arrays.equals(Arrays.copyOf(head,8),new byte[]{(byte)137,80,78,71,13,10,26,10})) return "image/png";
        return "image/webp";
    }
    static final class Reader implements Closeable {
        private final Source source;
        private byte[] key;
        private final byte[] aad;
        final long length, chunks, lastSize;
        Reader(Source source, byte[] master, Header vault, String id, int purpose) throws Exception {
            this(source, master, vault, id, purpose, true);
        }
        Reader(Source source, byte[] master, Header vault, String id, int purpose, boolean authenticate) throws Exception {
            this.source = source;
            try {
                byte[] object = objectId(id);
                long size = source.size(); if (size < HEADER+TAG) throw new Invalid();
                byte[] header = source.read(0,HEADER);
                if (header.length != HEADER || header[0]!=76 || header[1]!=75 || header[2]!=86 || header[3]!=79 || header[5]!=purpose) throw new Invalid();
                if (header[4]!=1) throw new Unsupported();
                long body = size-HEADER;
                chunks = (body-1)/(CHUNK+TAG)+1; lastSize = body-(chunks-1)*(CHUNK+TAG);
                if (lastSize < TAG || chunks > 0x100000000L) throw new Invalid();
                length = body-chunks*TAG;
                byte[] prk;
                synchronized(master) { prk = hmac(Arrays.copyOfRange(header,6,HEADER),master); }
                try { key = hmac(prk,concat(utf8("lakomics-vault/object-key/v1"),new byte[]{(byte)purpose},vault.uuidBytes,object,new byte[]{1})); }
                finally { wipe(prk); }
                aad = concat(utf8("lakomics-vault/chunk/v1"),vault.uuidBytes,object,header);
                if (authenticate) authenticateEnd();
            } catch (Exception e) { try { close(); } catch (IOException closeError) { e.addSuppressed(closeError); } throw e; }
        }
        void authenticateEnd() throws Exception { wipe(chunk(chunks-1)); }
        /** Authenticated plaintext of one chunk; nothing of a chunk is returned before its tag verifies. */
        byte[] chunk(long index) throws Exception {
            if (key == null || index < 0 || index >= chunks) throw new Invalid();
            byte last = (byte)(index+1 == chunks ? 1 : 0);
            byte[] counter = ByteBuffer.allocate(4).putInt((int)index).array();
            byte[] nonce = new byte[12]; System.arraycopy(counter,0,nonce,7,4); nonce[11]=last;
            byte[] ct = source.read(HEADER+index*(CHUNK+TAG),(int)(last==1 ? lastSize : CHUNK+TAG));
            try { synchronized(this) { if(key==null)throw new Invalid(); return decrypt(key,nonce,concat(aad,counter,new byte[]{last}),ct); } }
            catch (GeneralSecurityException e) { throw new Invalid(); }
            finally { wipe(ct); }
        }
        // Caller bounds allocation. Streaming routes request at most one chunk per read.
        byte[] range(long offset, int count) throws Exception {
            if (key == null || offset < 0 || count < 0) throw new Invalid();
            int size = (int)Math.min(count,Math.max(0,length-offset));
            byte[] out = new byte[size]; int at = 0;
            try {
                while (at < size) {
                    long position = offset+at; byte[] part = chunk(position/CHUNK);
                    try {
                        int start = (int)(position%CHUNK), n = Math.min(size-at,part.length-start);
                        System.arraycopy(part,start,out,at,n); at+=n;
                    } finally { wipe(part); }
                }
                return out;
            } catch (Exception e) { wipe(out); throw e; }
        }
        synchronized void revoke() { wipe(key); key=null; }
        @Override public void close() throws IOException { revoke(); source.close(); }
    }
    /** Status and headers of one media response. `start`/`count` are the plaintext bytes it carries. */
    static final class Plan {
        final int status; final String reason; final long start, count, length;
        final Map<String,String> headers;
        Plan(int status, String reason, long start, long count, long length, Map<String,String> headers) {
            this.status = status; this.reason = reason; this.start = start; this.count = count; this.length = length; this.headers = headers;
        }
    }
    static Map<String,String> baseHeaders() {
        Map<String,String> h = new LinkedHashMap<>();
        h.put("Cache-Control","no-store"); h.put("X-Content-Type-Options","nosniff"); h.put("Accept-Ranges","bytes");
        return h;
    }
    /** A Range header becomes 206 with an exact Content-Range; no header becomes 200 with the full length. */
    static Plan plan(String rangeHeader, long length) {
        Map<String,String> h = baseHeaders();
        long[] span;
        try { span = range(rangeHeader,length); }
        catch (Invalid e) { h.put("Content-Range","bytes */"+length); return new Plan(416,"Range Not Satisfiable",0,0,length,h); }
        h.put("Content-Length",Long.toString(span[1]));
        if (rangeHeader == null) return new Plan(200,"OK",span[0],span[1],length,h);
        h.put("Content-Range","bytes "+span[0]+"-"+(span[0]+span[1]-1)+"/"+length);
        return new Plan(206,"Partial Content",span[0],span[1],length,h);
    }
    /**
     * The plaintext body of one intercepted media response.
     *
     * Android WebView applies the request's Range itself: its stream reader parses the Range
     * header and calls skip(first byte) on the returned InputStream before reading. Offsets here
     * are therefore object offsets from byte 0; skip() only moves the position (no decryption),
     * and reads never return bytes outside [start, start+count) declared in Content-Range. If a
     * WebView reads without skipping, the first read starts at `start` all the same.
     *
     * Streaming keeps the format's authentication: the final chunk (final flag in nonce and AAD)
     * is verified when the object is opened, so the length is authentic before any header is sent,
     * and every chunk is verified before any of its bytes are copied out. One verified chunk is
     * kept in memory for consecutive small reads and wiped on the next chunk, revoke or close.
     */
    static class Body extends InputStream {
        final Reader reader;
        private final Object cacheLock = new Object();
        private long position, start, end, cachedIndex = -1;
        private byte[] cached;
        private volatile boolean revoked;
        Body(Reader reader) { this.reader = reader; end = reader.length; }
        void limit(long first, long count) { start = first; end = first+count; }
        boolean revoked() { return revoked; }
        /** Session hook, called before reading and again after I/O. Never called with the cache lock held. */
        protected void check() throws IOException { if (revoked) throw new IOException("Vault stream closed"); }
        /** Failure hook for decryption or source errors; returns the exception to throw. */
        protected IOException failed(Exception e) { return new IOException("Vault read failed"); }
        @Override public long skip(long n) throws IOException {
            check();
            if (n <= 0) return 0;
            if (position >= end) return 0;
            long moved = Math.min(n, end-position); position += moved; return moved;
        }
        @Override public int read() throws IOException {
            byte[] one = new byte[1];
            try { int n = read(one,0,1); return n < 0 ? -1 : one[0]&255; } finally { wipe(one); }
        }
        @Override public int read(byte[] target, int offset, int count) throws IOException {
            if (offset < 0 || count < 0 || count > target.length-offset) throw new IndexOutOfBoundsException();
            check();
            if (count == 0) return 0;
            if (position < start) position = start;
            if (position >= end) return -1;
            long index = position/CHUNK;
            synchronized (cacheLock) {
                if (revoked) throw new IOException("Vault stream closed");
                if (cachedIndex == index && cached != null) return copy(target,offset,count);
            }
            byte[] next;
            try { next = reader.chunk(index); }
            catch (Exception e) { if (revoked) throw new IOException("Vault stream closed"); throw failed(e); }
            try { check(); } catch (IOException e) { wipe(next); throw e; }
            synchronized (cacheLock) {
                if (revoked) { wipe(next); throw new IOException("Vault stream closed"); }
                wipe(cached); cached = next; cachedIndex = index;
                return copy(target,offset,count);
            }
        }
        private int copy(byte[] target, int offset, int count) {
            int at = (int)(position%CHUNK);
            int n = (int)Math.min(Math.min(count, cached.length-at), end-position);
            System.arraycopy(cached,at,target,offset,n); position += n; return n;
        }
        /** Safe from another thread: no I/O and no session lock inside. */
        void revoke() {
            revoked = true; reader.revoke();
            synchronized (cacheLock) { wipe(cached); cached = null; cachedIndex = -1; }
        }
        @Override public void close() throws IOException { revoke(); reader.close(); }
    }
    /** Exact route grammar: no encoding, traversal, query, fragments or upper-case IDs. */
    static String route(String path, String session) throws Invalid {
        if (session == null || !session.matches("[0-9a-f]{32}") || path == null || !path.matches("/vault/[0-9a-f]{32}/[0-9a-f]{32}")) throw new Invalid();
        if (!path.substring(7,39).equals(session)) throw new Invalid();
        String id = path.substring(40); objectId(id); return id;
    }
    static long[] range(String value, long size) throws Invalid {
        if (value == null) return new long[]{0,size};
        if (size == 0 || !value.matches("bytes=(?:[0-9]+-[0-9]*|-[0-9]+)")) throw new Invalid();
        try {
            String[] parts = value.substring(6).split("-",-1);
            if (parts[0].isEmpty()) {
                long suffix = Long.parseLong(parts[1]); if (suffix == 0) throw new Invalid();
                long count = Math.min(suffix,size); return new long[]{size-count,count};
            }
            long start = Long.parseLong(parts[0]);
            long end = parts[1].isEmpty() ? size-1 : Math.min(Long.parseLong(parts[1]),size-1);
            if (start >= size || end < start) throw new Invalid();
            return new long[]{start,end-start+1};
        } catch (NumberFormatException e) { throw new Invalid(); }
    }
}
