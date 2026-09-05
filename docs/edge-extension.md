# Lakomics Browser Collector

This document describes the current bundled browser extension in `extension/`. It is Chromium-extension based; browser-specific extension APIs can vary. The current workflow is used from Chromium-compatible desktop browsers and Titanium Browser on Android.

## Current save paths

The extension has three relevant destinations:

1. **VPS Capture Collector** — when Collector is enabled and the media type is supported, the extension sends an image/video capture request to the configured Lakomics Capture API. The VPS fetches the original media and stores the pending capture for later PC import.
2. **Direct Lakomics PC ingestion** — the extension can send to the local service (`127.0.0.1:32145`) or configured Tailscale HTTPS endpoint, either in PC-only mode or as the eligible PC leg of automatic routing.
3. **Browser download fallback** — used when the selected server path cannot complete, and also available as a legacy/manual download mode.

Current Collector-supported media types are `image`, `video`, and `animated_gif` (the latter two are normalized to video for the Capture API).

### Common HTTPS site support

The shared collector runs on ordinary HTTPS pages without per-site configuration. X keeps its dedicated collector/translation scripts, and the Lakomics Mobile page is excluded from the common script to avoid duplicate handlers. Browser-controlled pages and sites where the browser denies extension access cannot run this collector.

The common detector recognizes `img` originals/lazy attributes and `srcset`, progressive `video`/`audio` sources, and media/attachment links. It preserves the page URL and uses the same classification donut, frequency ordering and save preferences. It does not extract streams, canvas pixels, CSS background images or site-specific players without an exposed direct media URL.

Generic images and videos use `source: web` and the authenticated PC ingestion API; the media type permits extensionless image endpoints. The downloader accepts public HTTPS hosts without a CDN allowlist, checks the exact resolved addresses passed to the connection, disallows private/special-use IPs, retains bounded size/time limits and disables redirects. Media transport uses direct DNS-validated connections, without a proxy resolving destinations on its behalf. Generic requests send only the page origin as Referer; page metadata is still retained in the library. Browser login cookies are not transferred to the PC.

Audio/attachments, Cloud-only mode, and eligible PC failures use the existing browser download plus `<filename>.lakomics.json` classification metadata. Login-dependent originals and unusual site protocols can still need dedicated support. Installing/reloading this extension may require accepting broader HTTPS site access once; users can restrict site access through their browser.

### Arca Live and DCInside

The bundled extension also runs the same drag/long-press classification donut on `arca.live`, `gall.dcinside.com`, and `m.dcinside.com`. It detects images (including lazy/original URL attributes), direct video/audio URLs, and downloadable attachment links. HLS/DASH manifests and blob streaming URLs are excluded. X translation and automatic likes remain X-only.

- Forum images and direct videos use the authenticated PC ingestion path in `auto`/`pc` mode. The PC accepts only the site's known media hosts, carries the page URL as Referer, retains download size/time limits, and does not follow redirects. Source URL and classification are stored with the ingested asset.
- Arca's `ac-o.arca.live` original CDN is accepted alongside the legacy `ac*.namu.la` media hosts. Signed query fields are preserved; repeated `type=orig` parameters are normalized by the extension. PC address rejection and remote download failure have distinct fallback messages rather than being reported as app disconnection.
- Forum media does not enter the X-only VPS Capture API. In `auto`, eligible PC failures fall back to browser download; `cloud` uses browser download for forums. `pc` remains PC-only.
- Audio and other attachments use browser downloads in `auto`, `cloud`, or `download`; `pc` reports that a different save mode is needed because the PC ingestion library does not support these file kinds.
- Browser downloads preserve the classification folder path and a companion `<filename>.lakomics.json` with classification IDs, source URL and media URL. This is tagged local download metadata, not proof of import into the PC/Cloud library. It also avoids overwriting a downloaded JSON attachment.
- X quote cards use their own post, timestamp and media ordinal. Missing quote identity must not fall back to the outer tweet. Automatic likes must not target the outer tweet when a quote was saved.

Local fixture tests cover these flows; actual site/session restrictions can still affect downloads. Arca denied the development environment's direct page request (403). The Arca original URL attributes were cross-checked against the [gallery-dl extractor](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/arcalive.py); this is not a live browser acceptance result.

`saveMedia()` in `extension/src/background.js` owns routing. The current mode policy is:

- `auto` (default): Cloud first for Collector-supported media, then eligible direct PC ingestion, then browser download after fallback-eligible failures. Unsupported Cloud media starts with the PC path. A local-only classification source cannot be used for direct PC ingestion.
- `pc`: direct PC only; no implicit Cloud or browser-download fallback.
- `cloud`: Cloud, with browser download on failure; no direct-PC attempt.
- `download`: browser download only, intentionally bypassing server ingestion.

Local-only classifications return an explicit unavailable-PC result: automatic routing can continue to download, while PC-only mode reports the classification limitation.

`EXT-001` / `EXT-002` are recorded as completed in the backlog. Do not reimplement an older PC-first policy from a historical guide or stale source comment; inspect the current routing conditions and tests.

## Classification and radial state

- The extension keeps the app classification tree/layout and pinned classifications when the PC endpoint is reachable.
- A persisted app snapshot can be used immediately when the PC/Tailscale endpoint is temporarily unavailable.
- If no usable app classification source exists, the extension has a local fallback classification tree.
- The radial UI uses the current two-ring layout and pinned entries.
- Saved-media markers use stored/retrieved X-media state so already collected media can be marked on ordinary X pages as well as gallery-style views.

Secondary ordering uses `floor(log2(count + 1))` frequency buckets, with the existing asset count as a lower bound. Equal buckets preserve manual order; higher buckets move toward the visible arc's center and earlier pages. Hidden/pinned entries are excluded from the visible ranking. Explicit cross-parent radial placements remain intact. Successful saves increment persisted usage serially so simultaneous saves do not lose increments; local fallback classifications also apply this presentation state. An active gesture retains its initial layout until the next opening.

Do not infer media storage location from classification names. Classification IDs are the identity carried through the ingestion/capture request.

## Connection settings

The extension stores separate credentials/settings for:

- the direct Lakomics PC endpoint and its connection key;
- the VPS Collector endpoint and Collector token;
- extension preferences and radial/classification state.

Credentials belong in browser/app credential storage and must never be committed to the repository.

The default preference is `saveMode: "auto"`. Legacy `download` mode intentionally bypasses normal Lakomics ingestion and uses local browser downloads.

## Capture timeouts and fallback

Current request limits are intentionally different by media type:

- image Capture request: 45 seconds;
- video Capture request: 5 minutes;
- direct-PC ingestion: 120 seconds.

After a Collector timeout/offline response, the extension performs a confirmation lookup for the same source/media/classification before fallback. `CLOUD-003` is recorded as obsolete/incident-only, not a scheduled async redesign. Reopen it only for a reproducible real failure; preserve bounded timeout and confirmation behavior.

## Cloud inbound and Mobile library

The desktop inbound consumer carries valid `classification_id` values through ingestion and uses typed results to refresh assets, membership/review counts, and video preparation. The backlog records `CLOUD-001`, `CLOUD-002`, and `VERIFY-001` as completed; durable status UX remains under `CLOUD-UI-001`. See [Cloud Capture](agents/cloud-capture.md).

The mobile browser prototype reads the committed Cloud Library replica through worker-mediated `/v1/library/classifications`, `/v1/library/assets`, Revisit, and media-ticket APIs. It no longer uses pending Capture Inbox records as its library. Full-library replication/backfill has been performed; do not reseed it for verification. The separate queued-work pause/restart/resume gate remains under `CLOUD-006`.

The extension-mediated browser client is a behavioral reference, not the native Android production architecture. See [Mobile direction](agents/mobile.md), [approved consumption UX](agents/mobile-consumption-ux.md), and the [current backlog](roadmap/lakomics-backlog.md) for the remaining native work.

## Development install notes

For an unpacked development build, load the repository `extension/` directory in a compatible browser's extension-development UI. The direct PC service expects the bundled extension identity used by the repository build; if a browser repackages the extension under a different ID, direct-PC authorization may not work.

On Android, extension installation and API support depend on the browser. Do not describe the extension as Microsoft Edge-only.

## Troubleshooting principles

- If classifications are stale, refresh the app/remote classification source before editing the local fallback tree.
- If direct PC ingestion is unavailable, verify the PC service/Tailscale endpoint and connection key independently from Collector settings.
- If Collector capture is unavailable, test the Collector endpoint/token independently from the direct PC endpoint.
- A browser-download fallback means the server path did not complete; it is not proof that the Lakomics library imported the media.
- Never expose connection or Collector tokens in logs, screenshots, or committed files.
