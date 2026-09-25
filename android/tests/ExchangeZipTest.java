package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class ExchangeZipTest {
    private static int checks;
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }

    /** An in-memory folder tree; `null` content means "cannot be opened". */
    private static final class Fake implements ExchangeZip.Tree {
        final Map<String, List<ExchangeZip.Node>> children = new HashMap<>();
        final Map<String, byte[]> content = new HashMap<>();
        final Set<String> unreadableDirs = new HashSet<>();
        void dir(String parent, String id, String name) { children.computeIfAbsent(parent, k -> new ArrayList<>()).add(new ExchangeZip.Node(id, name, true, -1, 1_700_000_000_000L)); children.putIfAbsent(id, new ArrayList<>()); }
        void file(String parent, String id, String name, byte[] data) {
            children.computeIfAbsent(parent, k -> new ArrayList<>()).add(new ExchangeZip.Node(id, name, false, data == null ? 5 : data.length, 1_700_000_000_000L));
            content.put(id, data);
        }
        public List<ExchangeZip.Node> children(ExchangeZip.Node dir) throws IOException {
            String id = dir == null ? "root" : dir.id;
            if (unreadableDirs.contains(id)) throw new IOException("denied");
            return children.getOrDefault(id, Collections.emptyList());
        }
        public InputStream open(ExchangeZip.Node file) throws IOException {
            byte[] data = content.get(file.id);
            if (data == null) throw new FileNotFoundException();
            return new ByteArrayInputStream(data);
        }
    }

    private static Map<String, String> unzip(byte[] zip, Map<String, Long> times) throws IOException {
        Map<String, String> entries = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] b = new byte[4096]; int n;
                while ((n = in.read(b)) != -1) out.write(b, 0, n);
                entries.put(entry.getName(), out.toString("UTF-8"));
                if (times != null) times.put(entry.getName(), entry.getTime());
            }
        }
        return entries;
    }

    public static void main(String[] args) throws Exception {
        // Segments and relative paths.
        check(ExchangeZip.segment("사진").equals("사진"), "Unicode kept");
        check(ExchangeZip.segment("a/b\\c").equals("a_b_c"), "Separators replaced");
        check(ExchangeZip.segment("..").equals("_") && ExchangeZip.segment(".").equals("_") && ExchangeZip.segment("").equals("_") && ExchangeZip.segment(null).equals("_"), "No traversal segments");
        check(ExchangeZip.segment("x‮txt.exe\n").equals("xtxt.exe"), "Control and bidi removed");
        check(ExchangeZip.segment("é").equals("é"), "NFC");
        check(ExchangeZip.path("Trip/", "day 1", true).equals("Trip/day 1/"), "Directory path");
        check(ExchangeZip.path("Trip/day 1/", "../a.jpg", false).equals("Trip/day 1/.._a.jpg"), "A name cannot climb");
        check(ExchangeZip.path("", "a.txt", false).equals("a.txt"), "Root-level path");
        Set<String> used = new HashSet<>();
        check(ExchangeZip.unique(used, "F/a.txt").equals("F/a.txt"), "First name kept");
        check(ExchangeZip.unique(used, "F/a.txt").equals("F/a (1).txt"), "Duplicate numbered");
        check(ExchangeZip.unique(used, "F/a.txt").equals("F/a (2).txt"), "Second duplicate");
        check(ExchangeZip.unique(used, "F/d/").equals("F/d/") && ExchangeZip.unique(used, "F/d/").equals("F/d (1)/"), "Duplicate directory");
        check(ExchangeZip.unique(used, "F/.hidden").equals("F/.hidden") && ExchangeZip.unique(used, "F/.hidden").equals("F/.hidden (1)"), "Dotfile is not an extension");
        check(ExchangeZip.zipName("여행 사진").equals("여행 사진.zip") && ExchangeZip.zipName("..").equals("_.zip"), "Zip name");
        check(ExchangeZip.compressed("a.JPG") && ExchangeZip.compressed("b.mp4") && !ExchangeZip.compressed("c.txt") && !ExchangeZip.compressed("noext"), "Compressed media detection");

        // A walk: nested folders, an empty folder, a duplicate after sanitising, an unreadable
        // file and an unreadable folder (both skipped and counted), times kept.
        Fake tree = new Fake();
        tree.file("root", "f1", "readme.txt", "hello".getBytes(StandardCharsets.UTF_8));
        tree.dir("root", "d1", "사진");
        tree.file("d1", "f2", "a.jpg", "jpeg-bytes".getBytes(StandardCharsets.UTF_8));
        tree.file("d1", "f3", "a/jpg", "slash".getBytes(StandardCharsets.UTF_8));
        tree.file("d1", "f4", "a_jpg", "dup".getBytes(StandardCharsets.UTF_8));
        tree.dir("root", "d2", "empty");
        tree.file("root", "f5", "locked.bin", null);
        tree.dir("root", "d3", "private");
        tree.unreadableDirs.add("d3");
        ByteArrayOutputStream zip = new ByteArrayOutputStream();
        List<long[]> progress = new ArrayList<>();
        ExchangeZip.Result result = ExchangeZip.write(tree, "My Folder", zip, ExchangeTransfer.MAX_FILE_BYTES, (done, total) -> progress.add(new long[]{done, total}), null);
        Map<String, Long> times = new HashMap<>();
        Map<String, String> entries = unzip(zip.toByteArray(), times);
        check(result.files == 4 && result.skipped == 2, "Four files written, two entries skipped: " + result.files + "/" + result.skipped);
        check(result.bytes == zip.size(), "Counted bytes equal the zip size");
        check(entries.containsKey("My Folder/") && entries.containsKey("My Folder/empty/") && entries.containsKey("My Folder/사진/") && entries.containsKey("My Folder/private/"), "Directory entries, including empty ones: " + entries.keySet());
        check("hello".equals(entries.get("My Folder/readme.txt")), "File content");
        check("jpeg-bytes".equals(entries.get("My Folder/사진/a.jpg")), "Nested UTF-8 path");
        check(entries.containsKey("My Folder/사진/a_jpg") && entries.containsKey("My Folder/사진/a_jpg (1)"), "Sanitised duplicates both kept: " + entries.keySet());
        check(!entries.containsKey("My Folder/locked.bin"), "Unreadable file left out");
        for (String name : entries.keySet()) check(!name.contains("\\") && !name.contains("../") && !name.startsWith("/"), "Portable relative name " + name);
        long expectedTime = 1_700_000_000_000L;
        check(Math.abs(times.get("My Folder/readme.txt") - expectedTime) <= 2000, "Modification time kept");
        long[] last = progress.get(progress.size() - 1);
        check(last[0] == "hello".length() + "jpeg-bytes".length() + "slash".length() + "dup".length() && last[1] == last[0] + 5, "Progress counts source bytes against the listed total");

        // The cap: an oversized listing stops before any content is read; a zip whose own
        // framing crosses the cap is stopped while writing.
        Fake big = new Fake();
        big.file("root", "b1", "a.bin", new byte[600]);
        big.file("root", "b2", "b.bin", new byte[600]);
        try { ExchangeZip.write(big, "Big", new ByteArrayOutputStream(), 1000, null, null); throw new AssertionError("Declared size over the cap accepted"); }
        catch (ExchangeZip.TooLarge expected) { check(true, ""); }
        Fake tight = new Fake();
        tight.file("root", "t1", "a.jpg", new byte[900]);
        try { ExchangeZip.write(tight, "Tight", new ByteArrayOutputStream(), 950, null, null); throw new AssertionError("Zip framing over the cap accepted"); }
        catch (ExchangeZip.TooLarge expected) { check(true, ""); }

        // Cancellation and an unreadable root.
        try { ExchangeZip.write(tree, "X", new ByteArrayOutputStream(), ExchangeTransfer.MAX_FILE_BYTES, null, () -> true); throw new AssertionError("Cancel ignored"); }
        catch (ExchangeTransfer.Cancelled expected) { check(true, ""); }
        Fake denied = new Fake();
        denied.unreadableDirs.add("root");
        try { ExchangeZip.write(denied, "X", new ByteArrayOutputStream(), 1000, null, null); throw new AssertionError("Unreadable root accepted"); }
        catch (IOException expected) { check("Folder unreadable".equals(expected.getMessage()), "Unreadable root reported"); }

        // An empty folder is still a valid zip with its own directory entry.
        Map<String, String> empty = unzip(toBytes(new Fake(), "Empty"), null);
        check(empty.keySet().equals(Collections.singleton("Empty/")), "Empty folder zip");

        System.out.println("ExchangeZip: " + checks + " checks passed");
    }

    private static byte[] toBytes(Fake tree, String name) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ExchangeZip.write(tree, name, out, 1 << 20, null, null);
        return out.toByteArray();
    }
}
