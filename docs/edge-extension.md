# Lakomics X Collector

This document describes the current bundled browser extension in `extension/`. It is Chromium-extension based; browser-specific extension APIs can vary. The current workflow is used from Chromium-compatible desktop browsers and Titanium Browser on Android.

## Current save paths

The extension has three relevant destinations:

1. **VPS Capture Collector** — when Collector is enabled and the media type is supported, the extension sends an image/video capture request to the configured Lakomics Capture API. The VPS fetches the original media and stores the pending capture for later PC import.
2. **Direct Lakomics PC ingestion** — the extension can send to the local service (`127.0.0.1:32145`) or configured Tailscale HTTPS endpoint, either in PC-only mode or as the eligible PC leg of automatic routing.
3. **Browser download fallback** — used when the selected server path cannot complete, and also available as a legacy/manual download mode.

Current Collector-supported media types are `image`, `video`, and `animated_gif` (the latter two are normalized to video for the Capture API).

`saveMedia()` in `extension/src/background.js` owns routing. The current mode policy is:

- `auto` (default): Cloud first for Collector-supported media, then eligible direct PC ingestion, then browser download after fallback-eligible failures. Unsupported Cloud media starts with the PC path. A local-only classification source cannot be used for direct PC ingestion.
- `pc`: direct PC only; no implicit Cloud or browser-download fallback.
- `cloud`: Cloud, with browser download on failure; no direct-PC attempt.
- `download`: browser download only, intentionally bypassing server ingestion.

Source-level edge case (not runtime-tested in this documentation repair): `tryAppDirect()` returns `null` for a local-only classification, and the current automatic/PC-only caller can return that value before reaching a download fallback. The mode list states routing policy, not a guarantee that every failure reaches Download. This repair leaves that application behavior unchanged.

`EXT-001` / `EXT-002` are recorded as completed in the backlog. Do not reimplement an older PC-first policy from a historical guide or stale source comment; inspect the current routing conditions and tests.

## Classification and radial state

- The extension keeps the app classification tree/layout and pinned classifications when the PC endpoint is reachable.
- A persisted app snapshot can be used immediately when the PC/Tailscale endpoint is temporarily unavailable.
- If no usable app classification source exists, the extension has a local fallback classification tree.
- The radial UI uses the current two-ring layout and pinned entries.
- Saved-media markers use stored/retrieved X-media state so already collected media can be marked on ordinary X pages as well as gallery-style views.

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
