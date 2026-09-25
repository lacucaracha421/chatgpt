package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;

public final class ExchangeTransferTest {
    private static int checks;
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static void name(String raw, String expected) {
        String actual = ExchangeTransfer.fileName(raw);
        checks++;
        if (!actual.equals(expected)) throw new AssertionError("fileName(" + raw + ") = " + actual + ", expected " + expected);
    }
    private static <T extends Exception> T rejects(Class<T> type, Checked action) throws Exception {
        try { action.run(); } catch (Exception e) { if (type.isInstance(e)) { checks++; return type.cast(e); } throw e; }
        throw new AssertionError("Expected " + type.getSimpleName());
    }
    private static String repeat(String s, int n) { StringBuilder b = new StringBuilder(); for (int i = 0; i < n; i++) b.append(s); return b.toString(); }

    public static void main(String[] args) throws Exception {
        // Filename golden cases (receiver side; the server already applied the portable rules).
        name("photo.jpg", "photo.jpg");
        name("日本語 파일.png", "日本語 파일.png");
        name("../../etc/passwd", "passwd");
        name("C:\\Users\\me\\report.pdf", "report.pdf");
        name("a\u202Egpj.exe", "agpj.exe");
        name("x\u2066y\u2069\u200E.txt", "xy.txt");
        name("line\nbreak\t.txt", "linebreak.txt");
        name("what?.txt", "what_.txt");
        name("a<b>:c|d*\"e.txt", "a_b__c_d__e.txt");
        name(".hidden", "_hidden");
        name("trailing. . ", "trailing");
        name("", "file"); name(".", "file"); name("..", "file"); name("   ", "file"); name(null, "file"); name("dir/", "file");
        name("e\u0301.txt", "\u00e9.txt");
        String longAscii = ExchangeTransfer.fileName(repeat("a", 300) + ".pdf");
        check(longAscii.equals(repeat("a", 251) + ".pdf"));
        String longKorean = ExchangeTransfer.fileName(repeat("한", 100) + ".txt");
        check(longKorean.equals(repeat("한", 83) + ".txt") && longKorean.getBytes(StandardCharsets.UTF_8).length <= 255);
        String noExtension = ExchangeTransfer.fileName(repeat("b", 400));
        check(noExtension.length() == 255);
        String hugeExtension = ExchangeTransfer.fileName("x." + repeat("e", 300));
        check(hugeExtension.getBytes(StandardCharsets.UTF_8).length <= 255);

        check(ExchangeTransfer.uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        for (String bad : new String[]{null, "", "0F8FAD5B-D9CB-469F-A165-70867728950E", "0f8fad5b-d9cb-469f-a165-70867728950", "../0f8fad5b-d9cb-469f-a165-70867728950e"})
            check(!ExchangeTransfer.uuid(bad));

        // The share target never reads this app's own providers, whatever the authority spelling.
        String own = "com.lakomics.mobile";
        check(ExchangeTransfer.shareable("content", "com.android.providers.media.documents", own, "com.android.providers.media.module"));
        check(ExchangeTransfer.shareable("content", "media", own, null));
        for (String authority : new String[]{"com.lakomics.mobile", "com.lakomics.mobile.documents", "com.lakomics.mobile.cloud", "0@com.lakomics.mobile.documents", "", null})
            check(!ExchangeTransfer.shareable("content", authority, own, null));
        check(!ExchangeTransfer.shareable("content", "renamed.provider", own, own));
        check(!ExchangeTransfer.shareable("file", "anything", own, null));
        check(ExchangeTransfer.shareable("content", "com.lakomics.mobilex.files", own, "com.lakomics.mobilex"));

        // Retry backoff: 2 s, 10 s, 30 s, then every 60 s.
        check(ExchangeTransfer.retryDelay(0) == 2_000 && ExchangeTransfer.retryDelay(1) == 10_000
                && ExchangeTransfer.retryDelay(2) == 30_000 && ExchangeTransfer.retryDelay(3) == 60_000 && ExchangeTransfer.retryDelay(9) == 60_000);

        // Range resume bookkeeping.
        check(ExchangeTransfer.rangeHeader(0) == null);
        check("bytes=10-".equals(ExchangeTransfer.rangeHeader(10)));
        check(ExchangeTransfer.resumeOffset(200, null, 10, 100) == 0);
        check(ExchangeTransfer.resumeOffset(200, null, 0, 100) == 0);
        check(ExchangeTransfer.resumeOffset(206, " bytes 10-99/100 ", 10, 100) == 10);
        rejects(IOException.class, () -> ExchangeTransfer.resumeOffset(206, "bytes 0-99/100", 10, 100));
        rejects(IOException.class, () -> ExchangeTransfer.resumeOffset(206, "bytes 10-100/101", 10, 100));
        rejects(IOException.class, () -> ExchangeTransfer.resumeOffset(206, null, 10, 100));
        rejects(IOException.class, () -> ExchangeTransfer.resumeOffset(206, "bytes 0-99/100", 0, 100));
        check(rejects(ExchangeTransfer.StorageStatus.class, () -> ExchangeTransfer.resumeOffset(403, null, 10, 100)).status == 403);

        // Idle timeout: progress resets it; only 30 s without bytes expires, and it stays expired.
        AtomicLong now = new AtomicLong(1_000);
        ExchangeTransfer.Idle idle = new ExchangeTransfer.Idle(now::get, ExchangeTransfer.IDLE_MILLIS);
        now.set(1_000 + 29_999); check(!idle.check());
        idle.touch();
        now.addAndGet(29_999); check(!idle.check());
        now.addAndGet(1); check(idle.check() && idle.expired());
        idle.touch(); check(idle.expired());

        // Presigned URLs must be HTTPS; nothing is written for a refused URL.
        File dir = new File(System.getProperty("java.io.tmpdir"), "exchange-test-" + System.nanoTime());
        check(dir.mkdirs());
        try {
            File part = new File(dir, "a.part");
            rejects(IOException.class, () -> ExchangeTransfer.download("http://example.invalid/x", part, 3, "00", null, null));
            check(!part.exists());
            rejects(IOException.class, () -> ExchangeTransfer.upload("https://user@example.invalid/x", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[1]), 1, null, null));

            // Digest pre-pass and verification of a finished part file.
            ExchangeTransfer.Digest digest = ExchangeTransfer.digest(new ByteArrayInputStream("abc".getBytes(StandardCharsets.UTF_8)), null, null);
            check(digest.size == 3 && digest.sha256.equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
            rejects(ExchangeTransfer.Cancelled.class, () -> ExchangeTransfer.digest(new ByteArrayInputStream(new byte[10]), null, () -> true));
            try (FileOutputStream out = new FileOutputStream(part)) { out.write("abc".getBytes(StandardCharsets.UTF_8)); }
            ExchangeTransfer.verify(part, 3, digest.sha256); check(part.exists());
            // A complete part file verifies without any network (a crash after download, before save).
            ExchangeTransfer.download("https://example.invalid/never-contacted", part, 3, digest.sha256, null, null); check(part.exists());
            // Short: kept for a Range resume.
            rejects(EOFException.class, () -> ExchangeTransfer.verify(part, 4, digest.sha256)); check(part.exists());
            // Same length, different bytes: deleted so the next attempt starts clean.
            rejects(ExchangeTransfer.Corrupt.class, () -> ExchangeTransfer.verify(part, 3, repeat("0", 64))); check(!part.exists());
            // Longer than declared: deleted.
            try (FileOutputStream out = new FileOutputStream(part)) { out.write(new byte[5]); }
            rejects(EOFException.class, () -> ExchangeTransfer.verify(part, 3, digest.sha256)); check(!part.exists());
        } finally {
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) f.delete();
            dir.delete();
        }

        // Received ledger: round trip, ack, 7-day pruning and damaged input.
        long t = 1_700_000_000_000L;
        ExchangeTransfer.Ledger ledger = new ExchangeTransfer.Ledger();
        String a = "0f8fad5b-d9cb-469f-a165-70867728950e", b = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        ledger.put(new ExchangeTransfer.Ledger.Entry(a, t, "content://media/external/downloads/1", "a\tb.txt", 10, "PC\n1", false));
        ledger.put(new ExchangeTransfer.Ledger.Entry(b, t + 1000, "content://media/external/downloads/2", "c.txt", 20, "PC", false));
        ExchangeTransfer.Ledger copy = ExchangeTransfer.Ledger.decode(ledger.encode());
        check(copy.contains(a) && copy.contains(b) && !copy.contains("x"));
        check(copy.get(a).name.equals("a b.txt") && copy.get(a).from.equals("PC 1") && copy.get(a).size == 10 && !copy.get(a).acked);
        check(copy.newestFirst().get(0).id.equals(b));
        copy.acked(a);
        check(ExchangeTransfer.Ledger.decode(copy.encode()).get(a).acked);
        check(!copy.prune(t + ExchangeTransfer.LEDGER_MILLIS));
        check(copy.prune(t + ExchangeTransfer.LEDGER_MILLIS + 1) && !copy.contains(a) && copy.contains(b));
        ExchangeTransfer.Ledger damaged = ExchangeTransfer.Ledger.decode("garbage\n" + a + "\tnot-a-number\tu\tn\t1\tf\t0\n../x\t1\tu\tn\t1\tf\t0\n" + b + "\t5\tu\tn\t1\tf\t1");
        check(!damaged.contains(a) && damaged.contains(b) && damaged.get(b).acked);
        check(ExchangeTransfer.Ledger.decode(null).newestFirst().isEmpty() && ExchangeTransfer.Ledger.decode("").newestFirst().isEmpty());

        System.out.println("ExchangeTransfer: " + checks + " checks passed");
    }
}
