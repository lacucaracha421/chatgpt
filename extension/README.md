# Lakomics X Collector

Unified desktop/mobile X media collector for Lakomics.

The extension collects X images and video into Lakomics, provides radial classification on PC and mobile, includes an integrated X translation layer, and bridges live Lakomics data into the mobile prototype.

The current version is defined in `manifest.json`. Current save routing and Cloud Library behavior are maintained in [the X Collector reference](../docs/edge-extension.md); `IMPLEMENTATION_STATUS.md` records supporting details and historical version landmarks.

## Core behavior

- Chrome Manifest V3 extension for `x.com` and `twitter.com`.
- PC keeps direct radial drag/drop saving.
- Mobile selects a radial destination first and saves only when the center Save button is tapped.
- Local PC ingestion uses `127.0.0.1:32145`.
- Tablet/mobile and Tailscale-hosted endpoints are supported separately.
- Browser Download fallback remains available when a remote path is unavailable.
- Saved-state markers and classification snapshots are scoped to the active Lakomics endpoint.

## X Translate

X Translate is built directly into the extension.

- Supported providers include OpenRouter, Ollama Cloud, Gemini, and Vercel AI Gateway.
- Provider/API key/model settings are managed from the floating translation panel on X.
- Credentials stay in extension-local storage and cross-origin requests are proxied through the background worker.
- alpha.15.38 requests structured JSON from OpenRouter where supported and adds recovery retries for malformed, truncated, or unparsable translation responses.

## For You image gallery

- Collects photo posts seen in X Home `For You` into an in-session gallery.
- `Auto harvest` scrolls the feed, gathers new images, then returns to the original position.
- Gallery items reuse the normal Lakomics mobile long-press / PC drag-save flow.
- Rendering is incremental: 36 cards initially, then 24 more near the bottom.
- Like-count filters support all, 1K+, 5K+, and 10K+ without discarding the session data.

## VPS Capture Inbox

Introduced in alpha.15.30.

- Optional VPS collection endpoint receives X images and resolved MP4 video through `/v1/captures`.
- The VPS downloads supported X media and stores originals in R2.
- Animated GIF media follows the resolved MP4 path.
- Collector URL and API token remain extension-local.
- In automatic mode, a failed Collector attempt can fall back to eligible direct PC ingestion before browser Download; the selected mode controls which paths are allowed.
- Captures remain pending until the PC inbound importer retrieves them through a signed URL and acknowledges import.
- Capture Inbox is Remote → PC and is separate from the app's outbound `cloud_sync_queue`.

## Lakomics Mobile prototype bridge

The extension authenticates Cloud Library requests through its background worker for the browser prototype hosted on GitHub Pages. Classifications, committed replica assets, Recent/Home/Revisit, and image/video media tickets are live; Capture Inbox rows are not the mobile library source.

Full-library replication has been implemented and the initial backfill completed. The browser prototype remains a reference for the future native Android client, not a completed native client or DocumentsProvider. See [current behavior and limitations](../docs/edge-extension.md#cloud-inbound-and-mobile-library) and the living backlog for remaining gates.

## Version landmarks

### alpha.15.1
- Integrated X Translate into the extension.
- Simplified settings while retaining the mobile center-button save flow.

### alpha.15.4
- Hardened fallback downloads, JSON sidecars, classification snapshots, offline paths, and API timeout handling.

### alpha.15.5
- Added the For You image gallery and auto-harvest flow.

### alpha.15.7
- Added incremental and paged gallery rendering.

### alpha.15.8
- Added like-count display and gallery filtering.

### alpha.15.30
- Added the optional VPS Capture Inbox / R2 path.

### alpha.15.34–15.37
- Added the live mobile classification bridge, Cloud Capture asset rendering, and bridge-origin hardening.

### alpha.15.38
- Hardened OpenRouter translation JSON handling with structured output and recovery retries.
