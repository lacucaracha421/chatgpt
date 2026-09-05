# Lakomics X Collector implementation status

Current extension version: read `version` / `version_name` in `manifest.json`; release names below are historical landmarks, not the current package version.

This document retains implementation detail and version landmarks. [The X Collector reference](../docs/edge-extension.md) owns current routing and Cloud Library behavior; the living backlog owns pending work.

## Current architecture

- Chrome Manifest V3 extension for `x.com` / `twitter.com`.
- PC and mobile radial tagging share the same classification model while keeping different save interactions.
- PC save flow keeps direct drag/drop behavior.
- Mobile save flow selects a radial target first and commits only when the center Save button is tapped.
- Local PC Lakomics ingestion uses `127.0.0.1:32145`.
- Tablet/mobile endpoints and Tailscale-hosted endpoints are supported separately.
- Browser fallback downloads remain available when a remote/collector path cannot be used.

## X Translate

- X Translate is integrated directly into the extension and enabled by default.
- Provider/API key/model settings are managed from the floating translation panel on X.
- Supported request hosts include OpenRouter, Ollama Cloud, Gemini, and Vercel AI Gateway.
- Translation credentials are stored in extension-local storage and cross-origin requests are proxied through the background worker.
- OpenRouter translation now requests strict structured JSON where supported.
- alpha.15.38 adds format-error detection and recovery retry behavior for malformed, truncated, or otherwise unparsable OpenRouter translation responses.

## Save and classification behavior

- Persisted Lakomics classification snapshots are scoped to the active API endpoint.
- Legacy classification snapshots migrate to the active endpoint once.
- Offline folder fallback preserves the full classification path, for example `명조/카멜리아`.
- Browser fallback saves are serialized to avoid duplicate-save races.
- JSON sidecars follow the final browser-resolved media filename when `uniquify` changes the image filename.
- Android absolute filesystem paths are rejected explicitly because `chrome.downloads` accepts paths relative to the browser Download directory.
- Lakomics API timeout handling covers both the initial request and response-body parsing.

## For You image gallery

- X Home `For You` photo posts can be collected into an in-session gallery.
- Gallery auto-harvest scrolls the feed, collects new images, and returns to the starting position.
- Gallery items reuse the normal Lakomics mobile long-press / PC drag-save flow.
- Initial render is paged: 36 cards first, then 24 more near the bottom.
- New captures are inserted incrementally instead of rebuilding the entire gallery DOM.
- Auto-harvest defers live card creation so X timeline collection keeps priority.
- Like-count metadata is parsed from X controls and stored per post.
- Gallery filters support all, 1K+, 5K+, and 10K+ likes without discarding the underlying session data.

## VPS Capture Inbox

Introduced around alpha.15.30.

- An optional VPS collector can receive X images and resolved MP4 video through `/v1/captures`.
- The VPS downloads supported X media and stores originals in R2.
- X animated GIF media follows the resolved MP4 path.
- Collector URL and API token remain extension-local; the token is not exposed by normal settings reads.
- Fallback follows the selected save mode in the X Collector reference, including eligible direct PC ingestion after Cloud failure in automatic mode.
- Captures stay pending until the PC inbound importer downloads them using a signed URL and acknowledges import.
- Capture Inbox is Remote → PC and is separate from the app's outbound `cloud_sync_queue`.

## Lakomics Mobile prototype bridge

Current browsing uses the committed Cloud Library replica, not Capture Inbox rows. Worker-mediated classification/assets/Revisit/media-ticket APIs support the browser client's Home, Recent, discovery, detail grids, and image/video viewing. See [current behavior](../docs/edge-extension.md#cloud-inbound-and-mobile-library).

## Current mobile limitations

The extension-mediated browser client is not the native Android shell or DocumentsProvider. Full initial replication/backfill is complete; the independent CLOUD-006 queued-work pause acceptance gate remains open. The approved native consumption UX and current task statuses live in the Mobile references and backlog, not in the historical release notes below.

## Version landmarks

### alpha.15.1
- Integrated X Translate into the extension.
- Simplified settings and retained the mobile center-button confirmation flow.

### alpha.15.4
- Hardened fallback downloads, sidecars, classification snapshots, offline paths, and API timeout handling.

### alpha.15.5
- Added the For You image gallery and auto-harvest flow.

### alpha.15.7
- Added incremental/paged gallery rendering.

### alpha.15.8
- Added like-count display and gallery filtering.

### alpha.15.30
- Added the optional VPS Capture Inbox / R2 path.

### alpha.15.34–15.37
- Added the live mobile classification bridge, live Cloud Capture asset rendering, and origin validation hardening.

### alpha.15.38
- Hardened OpenRouter translation JSON handling with structured output and recovery retries.
