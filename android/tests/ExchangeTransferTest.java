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

        // Current lines carry the digest (so an ack can be retried after a restart) and the
        // publication journal flag; both round-trip.
        ExchangeTransfer.Ledger current = new ExchangeTransfer.Ledger();
        String sha = repeat("ab", 32);
        current.put(new ExchangeTransfer.Ledger.Entry(a, t, "content://d/1", "a.txt", 3, "PC", false, sha, false));
        current.put(new ExchangeTransfer.Ledger.Entry(b, t, "content://d/2", "b.txt", 3, "PC", false, sha, true));
        ExchangeTransfer.Ledger reread = ExchangeTransfer.Ledger.decode(current.encode());
        check(reread.get(a).sha256.equals(sha) && !reread.get(a).publishing && reread.get(b).publishing);
        check(reread.saved(a) && !reread.saved(b) && reread.newestFirst().size() == 1 && reread.publishing().size() == 1);
        check(reread.unacked().size() == 1 && reread.unacked().get(0).id.equals(a));
        // Pruning drops old receipts but never an unrecovered publication.
        check(reread.prune(t + ExchangeTransfer.LEDGER_MILLIS + 1) && !reread.contains(a) && reread.contains(b));
        // A seven-field line from an earlier version gets its digest from the inbox sighting.
        ExchangeTransfer.Ledger legacy = ExchangeTransfer.Ledger.decode(a + "\t5\tu\tn\t1\tf\t0");
        check(legacy.saved(a) && legacy.unacked().isEmpty());
        legacy.withSha(a, sha);
        check(legacy.unacked().size() == 1);

        publication();
        System.out.println("ExchangeTransfer: " + checks + " checks passed");
    }

    /** A simulated process death: not caught by the code under test. */
    private static final class Crash extends Error { Crash() { super("crash"); } }

    /** The durable copy is whatever the last successful write left; a restart decodes it. */
    private static final class FakeJournal implements ExchangeTransfer.Journal {
        String durable;
        int writes, failAt = -1, crashAt = -1;
        public boolean write(String encoded) {
            writes++;
            if (writes == crashAt) throw new Crash();
            if (writes == failAt) return false;
            durable = encoded;
            return true;
        }
    }

    /** MediaStore Downloads: entries by URI, hidden while pending. */
    private static final class FakeDownloads implements ExchangeTransfer.Destination {
        final java.util.Map<String, byte[]> bytes = new java.util.LinkedHashMap<>();
        final java.util.Set<String> pending = new java.util.HashSet<>();
        int created;
        String crashIn = "";
        public String create(String name, String hint) {
            String uri = "content://downloads/" + (++created);
            bytes.put(uri, new byte[0]); pending.add(uri);
            if (crashIn.equals("create")) throw new Crash();
            return uri;
        }
        public void write(String uri, File part) throws IOException {
            byte[] all = java.nio.file.Files.readAllBytes(part.toPath());
            if (crashIn.equals("write")) { bytes.put(uri, java.util.Arrays.copyOf(all, all.length / 2)); throw new Crash(); }
            bytes.put(uri, all);
        }
        public void reveal(String uri) {
            pending.remove(uri);
            if (crashIn.equals("reveal")) throw new Crash();
        }
        public int state(String uri) { return !bytes.containsKey(uri) ? GONE : pending.contains(uri) ? PENDING : PUBLISHED; }
        public boolean holds(String uri, long size, String sha256) throws IOException {
            byte[] data = bytes.get(uri);
            if (data == null) return false;
            ExchangeTransfer.Digest digest = ExchangeTransfer.digest(new ByteArrayInputStream(data), null, null);
            return digest.size == size && digest.sha256.equals(sha256);
        }
        public void delete(String uri) { bytes.remove(uri); pending.remove(uri); }
        public String name(String uri, String fallback) { return fallback; }
        long visible() { return bytes.keySet().stream().filter(u -> !pending.contains(u)).count(); }
    }

    private static void publication() throws Exception {
        String id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        byte[] content = "received bytes".getBytes(StandardCharsets.UTF_8);
        String sha = ExchangeTransfer.digest(new ByteArrayInputStream(content), null, null).sha256;
        File dir = new File(System.getProperty("java.io.tmpdir"), "exchange-publish-" + System.nanoTime());
        check(dir.mkdirs());
        File part = new File(dir, id + ".part");
        try {
            java.nio.file.Files.write(part.toPath(), content);

            // Healthy publication: one visible file, a durable receipt, an ack owed.
            FakeJournal journal = new FakeJournal();
            FakeDownloads downloads = new FakeDownloads();
            ExchangeTransfer.Ledger ledger = new ExchangeTransfer.Ledger();
            ExchangeTransfer.Ledger.Entry saved = ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1);
            check(!saved.publishing && downloads.visible() == 1 && downloads.pending.isEmpty());
            ExchangeTransfer.Ledger restarted = ExchangeTransfer.Ledger.decode(journal.durable);
            // Ack retry after a restart: the digest comes back from the journal, and a sighting of
            // the same transfer is a receipt (ack only), never a second publication.
            check(restarted.saved(id) && restarted.unacked().size() == 1 && restarted.unacked().get(0).sha256.equals(sha));

            // Crash between publication and receipt: the destination was journaled first, so the
            // restart finishes that same entry instead of receiving (and publishing) again.
            journal = new FakeJournal(); downloads = new FakeDownloads(); ledger = new ExchangeTransfer.Ledger();
            journal.crashAt = 2;
            try { ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1); throw new AssertionError("no crash"); }
            catch (Crash expected) { checks++; }
            check(downloads.visible() == 1 && downloads.created == 1);
            restarted = ExchangeTransfer.Ledger.decode(journal.durable);
            check(restarted.publishing().size() == 1 && !restarted.saved(id) && restarted.unacked().isEmpty());
            journal.crashAt = -1;
            saved = restarted.recover(journal, downloads, restarted.publishing().get(0));
            check(saved != null && restarted.saved(id) && downloads.created == 1 && downloads.visible() == 1);
            check(ExchangeTransfer.Ledger.decode(journal.durable).unacked().size() == 1);

            // Crash after the bytes but before the entry was revealed: complete bytes are revealed.
            journal = new FakeJournal(); downloads = new FakeDownloads(); ledger = new ExchangeTransfer.Ledger();
            downloads.crashIn = "reveal";
            try { ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1); throw new AssertionError("no crash"); }
            catch (Crash expected) { checks++; }
            downloads.crashIn = "";
            downloads.pending.addAll(downloads.bytes.keySet()); // the reveal never reached the store
            restarted = ExchangeTransfer.Ledger.decode(journal.durable);
            check(restarted.recover(journal, downloads, restarted.publishing().get(0)) != null && downloads.visible() == 1 && downloads.created == 1);

            // Killed mid-write: the half-written hidden entry is removed, nothing is left
            // untracked, and the transfer is received again (recover returns null).
            journal = new FakeJournal(); downloads = new FakeDownloads(); ledger = new ExchangeTransfer.Ledger();
            downloads.crashIn = "write";
            try { ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1); throw new AssertionError("no crash"); }
            catch (Crash expected) { checks++; }
            downloads.crashIn = "";
            restarted = ExchangeTransfer.Ledger.decode(journal.durable);
            check(restarted.recover(journal, downloads, restarted.publishing().get(0)) == null);
            check(downloads.bytes.isEmpty() && !restarted.contains(id) && !ExchangeTransfer.Ledger.decode(journal.durable).contains(id));
            // The retry then publishes exactly one copy.
            restarted.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 2);
            check(downloads.visible() == 1 && downloads.bytes.size() == 1);

            // The receipt cannot be persisted: publish throws and no ack is owed. The journal
            // still names the (now visible) destination, so a later attempt finishes it.
            journal = new FakeJournal(); downloads = new FakeDownloads(); ledger = new ExchangeTransfer.Ledger();
            journal.failAt = 2;
            try { ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1); throw new AssertionError("no failure"); }
            catch (IOException expected) { checks++; }
            check(ledger.unacked().isEmpty() && !ledger.saved(id) && ledger.publishing().size() == 1);
            check(ExchangeTransfer.Ledger.decode(journal.durable).unacked().isEmpty());
            check(ledger.recover(journal, downloads, ledger.publishing().get(0)) != null);
            check(ledger.unacked().size() == 1 && downloads.created == 1 && downloads.visible() == 1);

            // The journal itself cannot be written: nothing is published, nothing is left hidden.
            journal = new FakeJournal(); downloads = new FakeDownloads(); ledger = new ExchangeTransfer.Ledger();
            journal.failAt = 1;
            try { ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1); throw new AssertionError("no failure"); }
            catch (IOException expected) { checks++; }
            check(downloads.bytes.isEmpty() && !ledger.contains(id) && ledger.unacked().isEmpty());

            // Recovery that cannot write its journal keeps the entry for a later attempt.
            journal = new FakeJournal(); downloads = new FakeDownloads(); ledger = new ExchangeTransfer.Ledger();
            journal.crashAt = 2;
            try { ledger.publish(journal, downloads, id, part, "a.txt", null, content.length, sha, "PC", 1); } catch (Crash expected) { checks++; }
            journal.crashAt = -1;
            restarted = ExchangeTransfer.Ledger.decode(journal.durable);
            journal.failAt = journal.writes + 1;
            ExchangeTransfer.Ledger restartedFinal = restarted;
            ExchangeTransfer.Ledger.Entry entry = restarted.publishing().get(0);
            FakeJournal failing = journal; FakeDownloads store = downloads;
            rejects(IOException.class, () -> restartedFinal.recover(failing, store, entry));
            check(restarted.publishing().size() == 1 && restarted.unacked().isEmpty());
        } finally {
            part.delete();
            dir.delete();
        }
    }
}
