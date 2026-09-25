package com.lakomics.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.*;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 폴더 보내기: one picked folder becomes `<folder>.zip`, sent as an ordinary transfer.
 *
 * The walk is independent of Android: {@link Tree} is the only seam, backed on the device by
 * `DocumentsContract` child queries. Entries are `<folder>/<relative/path>` with UTF-8 names,
 * every directory gets its own entry (so empty folders survive), and file times come from the
 * provider. Already-compressed media is deflated at level 0 (just framed, fast); everything else
 * at level 1. The zip may never exceed the exchange's per-file cap.
 */
final class ExchangeZip {
    static final int MAX_DEPTH = 64;
    static final int MAX_ENTRIES = 100_000;
    private static final Set<String> COMPRESSED = new HashSet<>(Arrays.asList(
            "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "jxl", "mp4", "m4v", "mov", "mkv", "webm", "avi",
            "mp3", "m4a", "aac", "ogg", "opus", "flac", "zip", "7z", "rar", "gz", "xz", "bz2", "zst", "apk", "pdf", "epub", "cbz"));

    interface Tree {
        /** The children of `dir` (null for the root). May throw for an unreadable folder. */
        List<Node> children(Node dir) throws IOException;
        InputStream open(Node file) throws IOException;
    }
    static final class Node {
        final String id, name; final boolean dir; final long size, modified;
        Node(String id, String name, boolean dir, long size, long modified) { this.id = id; this.name = name; this.dir = dir; this.size = size; this.modified = modified; }
    }
    /** The zip would exceed the per-file cap. */
    static final class TooLarge extends IOException { TooLarge() { super("Folder too large"); } }
    static final class Result {
        final int files, skipped; final long bytes;
        Result(int files, int skipped, long bytes) { this.files = files; this.skipped = skipped; this.bytes = bytes; }
    }

    private ExchangeZip() {}

    /** One path segment: no separators, control or bidi characters, never `.`/`..`. */
    static String segment(String raw) {
        String text = Normalizer.normalize(raw == null ? "" : raw, Normalizer.Form.NFC);
        StringBuilder out = new StringBuilder();
        text.codePoints().forEach(c -> {
            if (c < 0x20 || (c >= 0x7F && c <= 0x9F) || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069) || c == 0x200E || c == 0x200F || c == 0x061C) return;
            out.appendCodePoint(c == '/' || c == '\\' ? '_' : c);
        });
        String name = out.toString().trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return "_";
        return name;
    }

    /** `parent` + `/` + the sanitised child, with a trailing `/` for a directory. */
    static String path(String parent, String child, boolean dir) {
        String joined = (parent == null || parent.isEmpty() ? "" : parent.endsWith("/") ? parent : parent + "/") + segment(child);
        return dir ? joined + "/" : joined;
    }

    /** A path not yet used in this zip: `a.txt`, `a (1).txt`, ... (zip names must be unique). */
    static String unique(Set<String> used, String path) {
        if (used.add(path)) return path;
        boolean dir = path.endsWith("/");
        String bare = dir ? path.substring(0, path.length() - 1) : path;
        int slash = bare.lastIndexOf('/'), dot = bare.lastIndexOf('.');
        boolean ext = !dir && dot > slash + 1;
        String stem = ext ? bare.substring(0, dot) : bare, suffix = ext ? bare.substring(dot) : "";
        for (int n = 1; ; n++) {
            String candidate = stem + " (" + n + ")" + suffix + (dir ? "/" : "");
            if (used.add(candidate)) return candidate;
        }
    }

    static boolean compressed(String name) {
        int dot = name.lastIndexOf('.');
        return dot >= 0 && COMPRESSED.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    /** The folder's zip file name. */
    static String zipName(String folder) { return ExchangeTransfer.fileName(segment(folder) + ".zip"); }

    /** Counts the zip's bytes and stops it at the cap, whatever the compression achieved. */
    static final class Capped extends FilterOutputStream {
        private final long cap; long written;
        Capped(OutputStream out, long cap) { super(out); this.cap = cap; }
        private void add(long n) throws IOException { written += n; if (written > cap) throw new TooLarge(); }
        @Override public void write(int b) throws IOException { add(1); out.write(b); }
        @Override public void write(byte[] b, int off, int len) throws IOException { add(len); out.write(b, off, len); }
    }

    private static final class Item { final Node node; final String path; Item(Node n, String p) { node = n; path = p; } }

    /**
     * Walk `tree` and write the zip to `out`. Unreadable folders and files are skipped and
     * counted; a file that fails part-way aborts the whole zip rather than leaving a truncated
     * entry. Progress reports source bytes read against the listed total.
     */
    static Result write(Tree tree, String folder, OutputStream out, long cap, ExchangeTransfer.Progress progress, ExchangeTransfer.Cancel cancel) throws IOException {
        String root = segment(folder) + "/";
        List<Item> items = new ArrayList<>();
        Set<String> used = new HashSet<>();
        used.add(root);
        items.add(new Item(null, root));
        int skipped = 0;
        long declared = 0;
        // Listing first gives a total for progress and refuses an oversized folder before any work.
        Deque<Item> pending = new ArrayDeque<>();
        pending.add(items.get(0));
        while (!pending.isEmpty()) {
            if (cancel != null && cancel.cancelled()) throw new ExchangeTransfer.Cancelled();
            Item dir = pending.poll();
            List<Node> children;
            try { children = tree.children(dir.node); }
            catch (IOException | RuntimeException unreadable) { if (dir.node == null) throw new IOException("Folder unreadable"); skipped++; continue; }
            children = new ArrayList<>(children);
            children.sort(Comparator.comparing((Node n) -> !n.dir).thenComparing(n -> segment(n.name)));
            int depth = dir.path.length() - dir.path.replace("/", "").length();
            for (Node child : children) {
                if (child.dir && depth >= MAX_DEPTH) { skipped++; continue; }
                Item item = new Item(child, unique(used, path(dir.path, child.name, child.dir)));
                items.add(item);
                if (items.size() > MAX_ENTRIES) throw new TooLarge();
                if (child.dir) pending.add(item);
                else if (child.size > 0) { declared += child.size; if (declared > cap) throw new TooLarge(); }
            }
        }
        items.sort(Comparator.comparing(item -> item.path));
        Capped capped = new Capped(out, cap);
        ZipOutputStream zip = new ZipOutputStream(capped, StandardCharsets.UTF_8);
        byte[] buffer = new byte[65536];
        long read = 0;
        int files = 0;
        for (Item item : items) {
            if (cancel != null && cancel.cancelled()) throw new ExchangeTransfer.Cancelled();
            ZipEntry entry = new ZipEntry(item.path);
            if (item.node != null && item.node.modified > 0) entry.setTime(item.node.modified);
            if (item.node == null || item.node.dir) { zip.putNextEntry(entry); zip.closeEntry(); continue; }
            InputStream in;
            try { in = tree.open(item.node); if (in == null) throw new FileNotFoundException(); }
            catch (IOException | RuntimeException unreadable) { skipped++; continue; }
            try (InputStream source = in) {
                zip.setLevel(compressed(item.path) ? Deflater.NO_COMPRESSION : Deflater.BEST_SPEED);
                zip.putNextEntry(entry);
                int n;
                while ((n = source.read(buffer)) != -1) {
                    if (cancel != null && cancel.cancelled()) throw new ExchangeTransfer.Cancelled();
                    zip.write(buffer, 0, n);
                    read += n;
                    if (progress != null) progress.bytes(read, declared);
                }
                zip.closeEntry();
                files++;
            }
        }
        zip.finish();
        zip.flush();
        return new Result(files, skipped, capped.written);
    }
}
