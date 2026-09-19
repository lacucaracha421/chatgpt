package com.lakomics.mobile;

/**
 * Bounds for the one-way text copy the Viewer's information panel requests.
 *
 * The bridge operation exists only so an explicit user copy can reach the platform
 * clipboard; it is not a general clipboard API. Keeping the rule here rather than
 * inline in the bridge means the bounds are testable without an Android runtime, and
 * the bridge keeps only the platform call itself.
 *
 * The policy deliberately has no read side and no knowledge of media: the WebView
 * never asks for clipboard contents, and no signed URL or credential is copied.
 */
final class ClipboardPolicy {
    /** A copied label/value or the short metadata summary; far below any clipboard limit. */
    static final int MAX_LENGTH = 8192;

    private ClipboardPolicy() {}

    /** The exact text to place on the clipboard, or a failure when the request is out of bounds. */
    static String text(String value) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Invalid copy text");
        if (value.length() > MAX_LENGTH) throw new IllegalArgumentException("Invalid copy text");
        return value;
    }

    /** The clip label shown by the system clipboard UI. */
    static String label() {
        return "Lakomics";
    }
}
