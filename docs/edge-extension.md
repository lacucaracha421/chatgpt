# Lakomics Browser Collector

This document describes the current bundled browser extension in `extension/`. It is Chromium-extension based; browser-specific extension APIs can vary. The current workflow is used from Chromium-compatible desktop browsers and Titanium Browser on Android.

## Collector menu

Settings → 수집 메뉴 selects the existing donut (`radial`, default) or the fixed list window (`list`). Existing tabs apply preference changes to the next gesture. The list opens after the usual image drag or touch long press and stays open after release. Its header shows only the current breadcrumb and action icons. Clicking a folder opens its children; clicking a leaf selects that one classification. There is no multi-selection. The list follows canonical parent-child relationships at every depth (including third, fourth, fifth and deeper levels), using radial placement only to order siblings. Pinned shortcuts remain at the top. Each entered folder darkens the panel and alternating rows slightly, capped after six steps for readability; the breadcrumb and back button retain the navigation path.

Drag a row left past the threshold and release to save directly to that classification, including a top-level folder. The row slides aside to reveal the save action. A short or cancelled drag does not save. Drag right to return to the previous folder. The header save icon submits the current classification; Ctrl+Enter saves a focused row. Each action uses the existing single-classification ingestion API. Hidden secondary tags and pinned placement are respected. Secondary donut entries are sorted by descending save count, preserving their existing order for ties; the order stays fixed while the menu is open. The list UI is isolated in a shadow root and never receives connection credentials.

### List order editing

With **수집 메뉴 → 목록 창** selected, **분류 배치** embeds the same list window used for collection. Tap to browse folders; hold a row for 400 ms to lift it, drag vertically to the insertion marker, then release to save the order of that folder's visible siblings. Dragging before the hold scrolls the list, and a lifted row near either edge scrolls automatically. Pointer cancellation or Escape cancels the move; Alt+ArrowUp/ArrowDown offers keyboard reordering. A failed save restores the preceding order and reports the failure. This editor never submits media.

Manual order is stored as classification IDs in the existing extension preferences (`listOrder`), included in portable settings backup, and applied when opening the next collection window. Reopening settings retains it; newly added classifications appear after ordered items and removed/hidden items are omitted. Folder membership and donut placement remain unchanged. The depth tint and save-check scale removal also apply to the shared window.

Targeted checks: `node --test extension/tests/list-collector.test.mjs extension/tests/list-order-dom.test.mjs extension/tests/background.test.mjs`. DOM interaction checks reuse the existing `app/node_modules/jsdom` workspace dependency. Browser fixture checks cover the actual options markup, folder navigation, keyboard reorder, reopening persistence and failure rollback. Long-press, pre-hold scroll and cancellation are covered by DOM pointer tests; real Galaxy Tab touch acceptance remains required.

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

### Device-only temporary image save (2.0.0.1558)

2026-09-07 user acceptance after `6524c4c`: extension 15.59 was activated on the
Galaxy Tab and Arca downloads became faster. The URL optimization is accepted on
that observed result; numerical throughput and source-file equivalence were not measured.

Version 2.0.0.1559 adopts the narrow ArcaRefresher JPEG URL-selection optimization (see `extension/THIRD_PARTY_NOTICES.txt`). Only on `https://arca.live/` pages and recognized Arca media hosts, an IMG with a JPEG URL and an explicit positive numeric width up to 1280 keeps its selected URL instead of forcing `type=orig`. Explicit original requests remain original; larger/unknown widths and other formats retain the existing behavior. No CDN host substitution, proxy or cache extraction is added. Shared candidate selection applies to both permanent and temporary saves. Targeted URL/controller checks passed; real Arca throughput and file-equivalence measurements remain pending.

The root list ends with a separate green **임시 저장** row after the classification rows. It is an action rather than a classification, cannot be reordered, and never calls the permanent save/Cloud Capture path. For a selected direct HTTPS image, the actual tap synchronously opens a package-targeted Android intent (`lakomics://temporary`) handled by Lakomics APK 0.3.3+. The settings preview shows this fixed action disabled. Videos and missing/unsupported image URLs are disabled.

The Android receiver downloads the image directly without app credentials, browser cookies or Cloud APIs, validates a decodable supported image, then writes `Pictures/Lakomics/임시보관/` through MediaStore.Images. Pending media is made public only after a complete copy; failed/cancelled writes are removed. Bounds: HTTPS public hosts, at most three revalidated redirects, 32 MiB, bounded transfer/read timeouts. No broad photo/storage permission is needed on Android 10+. Login-protected images may fail; no server-upload fallback or additional sharing feature is added.

Galaxy Tab S11 acceptance passed on 2026-09-07 with APK 0.3.3 (10) and Titanium extension 2.0.0.1558: long-press a public HTTPS WebP, release, tap **임시 저장**, and return to the browser after a complete 30,320-byte MediaStore write. The menu retains its image intent after the opening pointer is released. The system Photo Picker exposes the album under **컬렉션 → 이 기기에서 → 임시보관**; selecting its image returned a readable picker URI with all 30,320 bytes to the recipient test app. Protected-site images were not part of this check. See [Android shared-media storage](https://developer.android.com/training/data-storage/shared/media) and [browser intent restrictions](https://developer.chrome.com/docs/android/intents).

Subsequent real attachment Picker inspection showed an empty **이 기기에서** view
despite three completed local images. Samsung Gallery **앨범 → 모두 보기** did show
**임시보관 (3)**. The earlier test-recipient success is limited to that launch path;
recipient/filter/provider compatibility remains open under MOBILE-002. The separate
save-progress Activity is current behavior; a background-only replacement is not implemented.
