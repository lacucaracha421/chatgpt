# Lakomics X Collector

This document describes the current bundled browser extension in `extension/`. It is Chromium-extension based; browser-specific extension APIs can vary. The current workflow is used from Chromium-compatible desktop browsers and Titanium Browser on Android.

## Current save paths

The extension has three relevant destinations:

1. **VPS Capture Collector** — when Collector is enabled and the media type is supported, the extension sends an image/video capture request to the configured Lakomics Capture API. The VPS fetches the original media and stores the pending capture for later PC import.
2. **Direct Lakomics PC ingestion** — when Collector is not enabled, the extension can send directly to the local Lakomics extension service (`127.0.0.1:32145`) or the configured Tailscale HTTPS endpoint.
3. **Browser download fallback** — used when the selected server path cannot complete, and also available as a legacy/manual download mode.

Current Collector-supported media types are `image`, `video`, and `animated_gif` (the latter two are normalized to video for the Capture API).

Important current behavior: **when Collector is enabled, it is tried before direct PC ingestion**. A Collector failure falls back to browser download rather than retrying the direct-PC path. The planned save-policy cleanup is tracked as `EXT-001` / `EXT-002` in `docs/roadmap/lakomics-backlog.md`.

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

After a Collector timeout/offline response, the extension performs a confirmation lookup for the same source/media/classification before deciding that the capture failed. Long remote video fetches can still race this confirmation path; the future asynchronous reservation/job design is tracked as `CLOUD-003`.

## Current Cloud inbound gap

The VPS Capture path exists, but the desktop side is not yet fully integrated as a polished user-facing feature on current `main`.

Known near-term work is tracked under `CLOUD-001`, `CLOUD-002`, and `CLOUD-UI-001` in the living backlog. In particular, the selected `classification_id` is accepted by Capture creation but is not yet carried through the current pending-response → desktop ingestion path, and successful inbound imports do not yet drive the same immediate UI refresh path as normal local ingestion.

See `docs/agents/cloud-capture.md` for the current architecture and exact known gaps.

## Development install notes

For an unpacked development build, load the repository `extension/` directory in a compatible browser's extension-development UI. The direct PC service expects the bundled extension identity used by the repository build; if a browser repackages the extension under a different ID, direct-PC authorization may not work.

On Android, extension installation and API support depend on the browser. Do not describe the extension as Microsoft Edge-only.

## Troubleshooting principles

- If classifications are stale, refresh the app/remote classification source before editing the local fallback tree.
- If direct PC ingestion is unavailable, verify the PC service/Tailscale endpoint and connection key independently from Collector settings.
- If Collector capture is unavailable, test the Collector endpoint/token independently from the direct PC endpoint.
- A browser-download fallback means the server path did not complete; it is not proof that the Lakomics library imported the media.
- Never expose connection or Collector tokens in logs, screenshots, or committed files.
