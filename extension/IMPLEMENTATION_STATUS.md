# Lakomics X Collector implementation status

Current extension version: **2.0.0-alpha.15.38** (`2.0.0.1538`)

This document describes the current implementation rather than serving as a complete patch-note archive. Older patch notes remain in the repository where available.

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
- If the collector is unreachable, the extension can fall back to the tablet/browser Download flow.
- Captures stay pending until the PC inbound importer downloads them using a signed URL and acknowledges import.
- Capture Inbox is Remote → PC and is separate from the app's outbound `cloud_sync_queue`.

## Lakomics Mobile prototype bridge

Implemented across the alpha.15.34–15.37 work.

- The extension recognizes the Lakomics GitHub Pages mobile prototype at `https://lacucaracha421.github.io/chatgpt/`.
- `mobile-bridge.js` replaces the prototype classification tree with live Lakomics classification data when available.
- Selected classification, expanded tree nodes, and tree scroll position persist locally on the mobile page.
- Classification refresh is available from the mobile prototype UI.
- `mobile-assets.js` connects the mobile asset grid to real Cloud Capture records.
- Cloud captures are filtered by the selected classification subtree.
- Images use live X thumbnails and can open their original media in the viewer.
- Video captures can request a playback ticket and open in the mobile viewer.
- Capture loading uses a short-lived cache and bounded grid rendering to avoid loading the entire remote set into the DOM at once.
- The mobile page still contains demo-only areas; the classification tree and Cloud Capture asset view are the live-data portions currently implemented.
- alpha.15.37 hardens the mobile bridge by validating the parent/page origin before accepting bridge traffic.

## Current mobile limitations

- The mobile prototype is a responsive web view, not a full native Android Lakomics application.
- Full PC library replication is not yet implemented in the mobile UI.
- Collection/showcase/home sections still contain prototype/demo data where no live bridge has been implemented.
- Current live asset rendering is centered on Cloud Capture data rather than the complete local Lakomics asset database.

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
