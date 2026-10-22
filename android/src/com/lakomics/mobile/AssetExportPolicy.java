package com.lakomics.mobile;

import java.util.Locale;

/**
 * Where an explicitly saved Library original lands on this device and what it is called.
 * Platform-free so the host checks cover it; `AssetExport` applies it through MediaStore.
 */
final class AssetExportPolicy {
    enum Kind {IMAGE, VIDEO, FILE}
    static final String UNKNOWN = "application/octet-stream";
    private AssetExportPolicy() {}

    /** Server Asset ids (asset_authority.ASSET_ID_PATTERN); nothing else may name a file or a document. */
    static boolean assetId(String id) {
        return id != null && id.matches("[A-Za-z0-9_-]{1,128}");
    }

    /** The Asset's own content type, lower-cased and without parameters; anything malformed is a plain file. */
    static String mime(String hint) {
        if (hint == null) return UNKNOWN;
        String value = hint.trim().toLowerCase(Locale.ROOT);
        int parameters = value.indexOf(';');
        if (parameters >= 0) value = value.substring(0, parameters).trim();
        return value.matches("[a-z]+/[a-z0-9][a-z0-9.+-]{0,63}") ? value : UNKNOWN;
    }

    /** SVG is markup, not a gallery image, so it goes to Downloads with the other files. */
    static Kind kind(String mime) {
        if (mime.startsWith("image/") && !mime.equals("image/svg+xml")) return Kind.IMAGE;
        if (mime.startsWith("video/")) return Kind.VIDEO;
        return Kind.FILE;
    }

    static String folder(Kind kind) {
        switch (kind) {
            case IMAGE: return "Pictures/Lakomics/";
            case VIDEO: return "Movies/Lakomics/";
            default: return "Download/Lakomics/";
        }
    }

    /** The JavaScript result names the folder by this word, never by a device path. */
    static String folderName(Kind kind) {
        switch (kind) {
            case IMAGE: return "pictures";
            case VIDEO: return "movies";
            default: return "downloads";
        }
    }

    static String extension(String mime) {
        switch (mime) {
            case "image/jpeg": return ".jpg";
            case "image/png": return ".png";
            case "image/webp": return ".webp";
            case "image/gif": return ".gif";
            case "image/avif": return ".avif";
            case "image/heic": case "image/heif": return ".heic";
            case "image/bmp": return ".bmp";
            case "video/mp4": return ".mp4";
            case "video/webm": return ".webm";
            case "video/quicktime": return ".mov";
            case "video/x-matroska": return ".mkv";
            default: return "";
        }
    }

    /** MediaStore adds " (1)" itself when the same original is saved twice. */
    static String displayName(String assetId, String mime) {
        if (!assetId(assetId)) throw new IllegalArgumentException("Invalid asset id");
        return "Lakomics-" + assetId + extension(mime);
    }
}
