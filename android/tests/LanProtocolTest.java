package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class LanProtocolTest {
    private static int checks;
    private static final String ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    private static final String OTHER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    private static final String SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static void rejects(int status, String code, Checked action) throws Exception {
        try { action.run(); }
        catch (LanProtocol.Failure failure) { check(failure.status == status && code.equals(failure.body.get("error"))); return; }
        throw new AssertionError("Expected " + status + " " + code);
    }
    private static InputStream input(String text) { return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)); }
    private static LanProtocol.Request request(String method, String target, String headers) throws Exception {
        return LanProtocol.read(input(method + " " + LanProtocol.ROOT + target + " HTTP/1.1\r\nHost: tablet\r\n" + headers + "\r\n"));
    }
    private static Map<String, Object> json(String text) throws Exception { return LanProtocol.json(input(text), text.getBytes(StandardCharsets.UTF_8).length); }
    private static Map<String, Object> prepare() {
        return LanProtocol.object("transferId", ID, "batchId", ID, "fromDevice", OTHER,
                "fileName", "photo.jpg", "sizeBytes", 3L, "sha256", SHA);
    }
    private static LanProtocol.Prepare prepare(String key, Object value) throws Exception {
        Map<String, Object> body = prepare(); body.put(key, value); return new LanProtocol.Prepare(body, OTHER);
    }
    public static void main(String[] args) throws Exception {
        check(request("GET", "/info", "").route.equals("info"));
        check(request("POST", "/prepare-upload", "Content-Length: 2\r\n").length == 2);
        check(request("POST", "/cancel", "content-length: 2\r\n").route.equals("cancel"));
        LanProtocol.Request upload = request("PUT", "/upload?offset=2&transferId=" + ID, "Content-Length: 1\r\n");
        check(upload.transferId.equals(ID) && upload.offset == 2 && upload.length == 1);
        // Framing consumes no body bytes, including a pipelined/buffered upload.
        InputStream framed = input("POST " + LanProtocol.ROOT + "/cancel HTTP/1.1\r\nHost: t\r\nContent-Length: 2\r\n\r\n{}");
        check(LanProtocol.read(framed).length == 2 && framed.read() == '{');
        for (String method : new String[]{"POST", "PUT"}) rejects(411, "invalidRequest", () -> request(method, "/upload?transferId=" + ID + "&offset=0", ""));
        for (String headers : new String[]{"Transfer-Encoding: chunked\r\nContent-Length: 3\r\n", "Transfer-Encoding: identity\r\nContent-Length: 3\r\n",
                "Content-Length: 3\r\ncontent-length: 3\r\n", "Content-Length: -1\r\n", "Content-Length: +1\r\n", "Content-Length: 01\r\n",
                "Content-Length: 9223372036854775808\r\n", "Content-Length : 3\r\n", " Content-Length: 3\r\n", "Content-Length: 3\r\nExpect: 100-continue\r\n",
                "Content-Length: 3\r\nX-Test: x\nInjected: y\r\n"})
            rejects(422, "invalidRequest", () -> request("POST", "/cancel", headers));
        rejects(422, "invalidRequest", () -> LanProtocol.read(input("GET " + LanProtocol.ROOT + "/info HTTP/1.0\r\nHost: t\r\n\r\n")));
        rejects(422, "invalidRequest", () -> LanProtocol.read(input("GET " + LanProtocol.ROOT + "/info HTTP/1.1\r\n\r\n")));
        for (String target : new String[]{"/../info", "/info?x=1", "/info/", "/%69nfo"}) rejects(422, "invalidRequest", () -> request("GET", target, ""));
        rejects(422, "invalidRequest", () -> request("GET", "/info", "Content-Length: 1\r\n"));
        for (String query : new String[]{"transferId=" + ID, "transferId=" + ID + "&offset=0&offset=0", "transferId=" + ID + "&offset=0&x=1",
                "transferId=../x&offset=0", "transferId=" + ID + "&offset=-1", "transferId=" + ID + "&offset=%30", "transferId=" + ID + "&offset=01"})
            rejects(422, "invalidRequest", () -> request("PUT", "/upload?" + query, "Content-Length: 0\r\n"));
        String prefix = "GET " + LanProtocol.ROOT + "/info HTTP/1.1\r\nHost: t\r\nX: ";
        String atLimit = prefix + "a".repeat(LanProtocol.LIMIT - prefix.length() - 4) + "\r\n\r\n";
        check(LanProtocol.read(input(atLimit)).route.equals("info"));
        rejects(431, "invalidRequest", () -> LanProtocol.read(input(atLimit.replace("X: ", "X: a"))));
        check(request("POST", "/cancel", "Content-Length: 16384\r\n").length == 16384);
        rejects(413, "invalidRequest", () -> request("POST", "/cancel", "Content-Length: 16385\r\n"));
        check(json("{\"transferId\":\"" + ID + "\"}").get("transferId").equals(ID));
        for (String text : new String[]{"[]", "null", "{}{}", "{\"x\":1,\"x\":2}", "{\"x\":", "{\"x\":NaN}", "{\"x\":01}", "[".repeat(18) + "0" + "]".repeat(18)})
            rejects(422, "invalidRequest", () -> json(text));
        check(json(" ".repeat(16382) + "{}").isEmpty());
        rejects(413, "invalidRequest", () -> json(" ".repeat(16383) + "{}"));
        // Size is bytes, not UTF-16 characters; malformed UTF-8 cannot become a different filename.
        rejects(413, "invalidRequest", () -> json("{\"x\":\"" + "한".repeat(6000) + "\"}"));
        rejects(422, "invalidRequest", () -> LanProtocol.json(new ByteArrayInputStream(new byte[]{'{','"','x','"',':','"',(byte) 0xff,'"','}'}), 9));
        try { LanProtocol.json(input("{"), 2); throw new AssertionError("Expected EOF"); } catch (EOFException expected) { checks++; }
        LanProtocol.Prepare prepared = new LanProtocol.Prepare(json(Json.write(prepare())), OTHER);
        check(prepared.size == 3 && prepared.same(new LanProtocol.Prepare(prepare(), OTHER)));
        rejects(403, "deviceMismatch", () -> new LanProtocol.Prepare(prepare(), ID));
        rejects(422, "invalidRequest", () -> prepare("transferId", "../x"));
        rejects(422, "invalidRequest", () -> prepare("batchId", "bad"));
        rejects(422, "invalidRequest", () -> prepare("sha256", SHA.toUpperCase(Locale.ROOT)));
        rejects(422, "invalidRequest", () -> prepare("sizeBytes", -1L));
        rejects(422, "invalidRequest", () -> prepare("sizeBytes", 3.0));
        rejects(422, "invalidRequest", () -> prepare("sizeBytes", "3"));
        rejects(422, "invalidRequest", () -> prepare("fileName", " "));
        rejects(422, "invalidRequest", () -> prepare("fileName", "한".repeat(86)));
        rejects(422, "invalidRequest", () -> prepare("contentTypeHint", 1L));
        check(prepare("sizeBytes", 0L).size == 0);
        check(prepare("sizeBytes", ExchangeTransfer.MAX_FILE_BYTES).size == ExchangeTransfer.MAX_FILE_BYTES);
        rejects(413, "fileTooLarge", () -> prepare("sizeBytes", ExchangeTransfer.MAX_FILE_BYTES + 1));
        check(!prepared.same(prepare("sha256", "0".repeat(64))));
        LanProtocol.offset(0, 0, 3, 3); LanProtocol.offset(2, 2, 3, 1); LanProtocol.offset(3, 3, 3, 0); checks += 3;
        rejects(409, "offsetMismatch", () -> LanProtocol.offset(1, 2, 3, 2));
        try { LanProtocol.offset(0, 2, 3, 1); } catch (LanProtocol.Failure mismatch) { check(Long.valueOf(2).equals(mismatch.body.get("offset"))); }
        rejects(422, "invalidRequest", () -> LanProtocol.offset(2, 2, 3, 2));
        rejects(422, "invalidRequest", () -> LanProtocol.offset(4, 4, 3, 0));
        byte[] der = "abc".getBytes(StandardCharsets.US_ASCII);
        check(LanProtocol.pin(SHA, der));
        check(!LanProtocol.pin(SHA.toUpperCase(Locale.ROOT), der));
        check(!LanProtocol.pin("0".repeat(64), der) && !LanProtocol.pin(null, der) && !LanProtocol.pin(SHA, null));
        for (String ip : new String[]{"10.0.0.1", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.1"}) check("lan".equals(LanProtocol.addressKind(ip)));
        for (String ip : new String[]{"100.64.0.0", "100.127.255.255"}) check("tailscale".equals(LanProtocol.addressKind(ip)));
        for (String ip : new String[]{null, "", "8.8.8.8", "127.0.0.1", "169.254.0.1", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0",
                "192.168.1.256", "010.0.0.1", "10.1", "10.0.0.1.", "::1", "::ffff:10.0.0.1", "example.com"}) check(LanProtocol.addressKind(ip) == null);
        System.out.println("LanProtocol: " + checks + " checks passed");
    }
}
