# Lakomics Android client

Current source version: **0.6.2 (18)**, declared in [AndroidManifest.xml](AndroidManifest.xml). Release APK built with the existing installation certificate. The supporting server API update is deployed. Galaxy Tab installation is deferred because the device is unavailable.

## Current functionality and remaining gates

- Independent authenticated Home, Library and read-only Collections; Continue was removed in favor of Recent and classification/date/creator discovery.
- Shared Manga Catalog search, detail, editions and bookmark filtering. The reader shows one page in portrait and Japanese two-page spreads after the cover in landscape, with hidden-by-default overlay controls, horizontal navigation, 1x–5x zoom and bounded pan, device-local position, nearby-page prefetch and one expired-manifest refresh.
- Shared 1 GiB native media cache and cache-clear controls; Asset videos request autoplay and looping while preserving a paused retry state.
- Read-only DocumentsProvider and integrated CloudMediaProvider, plus device-only temporary image saves. Provider implementation does not guarantee every receiving app's picker compatibility.
- Remaining gates include the recorded 0.4.3 device install/reader checks, recipient Picker/SAF multi-select/restart compatibility and real media timing. Catalog bookmark mutations, server refresh authority, System Share quick-save and extension update management remain separate backlog work.

Collections and Catalog deployment evidence is recorded in the version history and backlog. An APK build alone does not publish their data or establish device acceptance.

This independent APK bundles the React client from `_tools/app/mobile-client`. It requires no desktop/browser extension runtime. The old `_tools/lakomics-cloudmedia-poc` and its installed Android Photo Picker configuration are separate and unchanged. Package: `com.lakomics.mobile`; document authority: `com.lakomics.mobile.documents`.

## Build

Requirements: existing JDK 17 (`JAVA_HOME`), Android SDK platform 35 and build-tools 35.0.0, Python 3 for the release builder (or PowerShell for the older debug builder), and frontend dependencies already installed in `_tools/app`. No Gradle/Kotlin/Capacitor dependencies are added.

Release packaging on Linux or Windows: run `npm run mobile:build` in `_tools/app`, then from the repository root:

```sh
python android/build.py --sdk-root <SDK-path> --java-home <JDK-17-path>
```

The builder uses `d8 --release`, validates `android:debuggable=false`, verifies bundled asset bytes and portable ZIP paths, aligns the APK and verifies its v2/v3 signatures. It requires the existing ignored `android/build/debug.keystore` and never creates or replaces a signing key. This is a release configuration signed with the existing personal-install development certificate, not a new store-distribution identity.

From the repository root, build the mobile TypeScript/Vite entry into `android/assets`, then package it:

```powershell
npm --prefix _tools/app run mobile:build
.\android\build.ps1 -SdkRoot C:\LakomicsCloudMediaPoC\sdk
```

Use `-CompileOnly` for native compilation and offline network-policy, document-tree, disk-cache, media-transfer and Picker snapshot checks without requiring frontend assets. Every external command's actual failure exit code is preserved. Full build packages assets and DEX, aligns the APK, signs it, verifies the signature, and prints SHA-256. Output: `android/build/lakomics-mobile-debug.apk`. `assets/` and `build/` are ignored. The debug signing key is generated once at `android/build/debug.keystore` and retained by subsequent builds; preserve that local key for in-place APK updates. Do not commit it. This is a personal debug-signed distribution, not a Play Store/release signing workflow; timestamps and first-time key generation mean builds are not byte-identical.

No device installation, provider selection, or production service/data changes are part of this build. Install/update only on an explicitly authorized device. Initial connection is entered on-device: cloud API origin plus bearer token. Endpoint must be HTTPS; optional private HTTP must be explicitly enabled and uses canonical numeric IPv4 in loopback/RFC1918/Tailscale 100.64/10 only. Public HTTP, DNS names over HTTP, credentials in the URL, path/query/fragment endpoints, and redirect-based authentication are rejected. Android cleartext support is declared for this explicit option; all authenticated HTTP requests still pass native validation. IPv6 private HTTP is intentionally unsupported.

## First use and preview

1. Install `build/lakomics-mobile-debug.apk` on the intended Android device when authorized. This package coexists with the prior CloudMediaProvider PoC; it does not replace that package or change Android Photo Picker settings.
2. Open Lakomics → 라이브러리 연결. Enter the same Cloud API origin and device token configured for your library. Enable the private HTTP option only if using an HTTP Tailscale/internal numeric IP. Tailscale must be connected when that route requires it. Connection is checked before it replaces a previously working configuration.
3. Home shows canonical Recent, with separate Revisit and 처리 대기 access. Library opens the actual classification hierarchy. Original viewing uses existing cloud media tickets; the PC need not be running to read already replicated media. Pending Captures remain outside the canonical library.
4. In a compatible app's **file/document picker**, choose Lakomics from the locations drawer. Browse All assets or classifications, then select one or multiple files as permitted by the receiving app. For Android Photo Picker, the APK includes its own CloudMediaProvider. Availability depends on OS eligibility, provider selection and the recipient; use the integrated Picker guidance below. The separate PoC is a historical experiment, not a required browsing dependency.

For browser layout review, run `npm --prefix _tools/app run mobile:dev`, then open `http://127.0.0.1:1448/?demo`. The labelled sample illustrations are development fixtures, excluded from production APK output. Without `?demo`, a browser shows the connection welcome screen; authenticated browsing belongs to the Android bridge, not browser token storage. `npm --prefix _tools/app run mobile:test` runs the focused client checks. The existing `mobile/` site and `extension/` source remain unchanged.

## Historical implementation and acceptance checkpoints

The following dated/versioned sections preserve results and limitations at the time
of each rollout. Their earlier “not added”, “not installed”, “pending deployment”
and “current APK” statements do not override the current summary above or the living
backlog. Keep recorded hashes and test counts tied to their original artifacts.

### Initial preview scope and remaining acceptance (historical)

2026-09-07 startup fix, version 0.1.1 (2): Windows aapt2 `-A` packaged nested asset entries with backslashes, so Android could load index.html but not its JS/CSS. Build now inserts assets using forward-slash ZIP names and runs `tests/VerifyApkAssets.ps1` before signing. The checker fails on the original APK and passes all 12 bundled files on the fixed APK. The existing Galaxy Tab installation was updated in place via ADB; native UI hierarchy confirmed the connection settings screen is rendered. This supersedes the earlier no-install status only for installation/startup; authenticated media and SAF acceptance are still separate.

Implemented: Home/Library, classification search/hierarchy and user icon/color appearance, justified rows with three densities, virtualized continuous scrolling in 40-item cursor batches with one-page metadata prefetch and a four-view session cache, in-session Library context restoration, secondary lifecycle refresh without discarding the current gallery, original image/video viewing, image pinch/pan, retry without discarding useful thumbnails, bounded adjacent-image preload, separate pending Capture viewer, secure direct auth and read-only DocumentsProvider.

This first APK is a **read-only native preview**, not completed MOBILE-001/002/004 device acceptance. The optional signed-CRX Extension Manager and Android Share → quick-save/temporary-storage workflow remain pending; no capture-upload endpoint, temporary deletion policy, Collections, catalog or destructive library operations were added. Pending-list API is oldest-first and bounded to 40 entries; the UI displays 40+ rather than claiming a complete total and refresh removes entries no longer pending. It cannot infer desktop duplicate outcomes or map pending IDs to canonical IDs before the server exposes that relationship. Pending entries open original media on demand; they have no separate thumbnail API. Existing server asset dimensions are null. Metadata now commits immediately; visible/overscan tiles use a shared four-worker cancellable thumbnail queue, and decoded intrinsic ratios reflow the rows while retaining the visible anchor. Unavailable previews keep neutral placeholders. Cold/warm production timing must be measured on device.

Device gate still required: secure connection/reconnect; real images and videos; pinch/rotation/back/foreground; portrait/landscape performance; thumbnail-to-original timing; file picker thumbnails, multi-select and recipient reads; cancel/disconnect during downloads; large-video behavior. The native provider intentionally rejects originals above 256 MiB. Browser fixture checks and static/native compilation do not establish these device outcomes.

## 0.1.2 browsing improvement (2026-09-07)

- Metadata commits without awaiting media. Cached views reopen immediately; manual refresh fetches a fresh first batch and resets scrolling. Foregrounding refreshes secondary sections without throwing away a long browsing session.
- Scrolling within one viewport of the end appends the next cursor batch. Only one metadata batch is prefetched, rows remain virtualized, duplicate IDs are removed, and failure retains the existing gallery with an explicit retry. The gallery retains its cursor sequence beyond the first 100 items.
- Server Revisit now rotates all eligible creators in groups of three by UTC day (09:00 Korea time), replacing the fixed top-12 pool. Same-day requests are stable; adjacent days do not overlap when there are at least six eligible creators and the candidate set is unchanged. No schema or history writes. The APK displays all three groups. Deployed 2026-09-07: only `_revisit_creator_groups` was replaced in the inspected production source; authenticated API matched the expected three creators and repeated identically on the same day. A read-only live-data query confirmed zero overlap for the following day (two-day selection took 68 ms). Service active/running with NRestarts=0; public-facing tailnet HTTPS health returned 200. Production SHA-256: `7ba716cf2d422e121d935608bd2bdc0fc8155c1061fe9716698ed3c4d85e14fd`; rollback source: `/home/linuxuser/lakomics-api/app.py.pre-revisit-20260906T234635Z`.
- Verified: 29 frontend tests; mobile TypeScript/Vite build; 69 Mobile API tests against temporary SQLite; 57 native policy checks; all 12 APK asset paths; APK v2/v3 signatures. Browser fixture confirmed automatic 40 → 80 → 120 traversal, thumbnail-derived geometry and no console errors. Native performance remains unverified; production Revisit verification is recorded above.

## 0.1.4 compact Home and on-device thumbnails (2026-09-07)

Home starts directly at Recent; the introduction and Continue section are removed. The status bar remains hidden as in 0.1.3. Original viewing and in-session tab/viewer return still work.

The gallery caches thumbnail bytes in the app-private `thumbnail-media` cache directory, up to 1 GiB (shown as 1 GB in settings), with a 16 MiB per-file cap and eviction after seven days without use or oldest-access-first capacity eviction. There is no preallocation. Keys include the authenticated connection scope; changing/disconnecting the connection clears this cache. Downloads use temporary files, and generation checks reject stale commits/URLs after clearing. The app's settings show bytes/count/limit and offer an explicit thumbnail-cache clear action. Gallery downloads pause while settings are open so clearing remains visibly empty until browsing resumes. This cache is independent of DocumentsProvider's existing file cache; original images and videos retain their current download path. An offline full-library browser is not claimed.

Bridge adds `thumbnail {assetId}`, `cacheStatus`, and `clearCache`; thumbnail replies use private bundled-origin URLs after a native cache hit/download. No bearer token or signed URL is persisted in the thumbnail cache. Native fetch reuses the existing HTTPS/no-redirect/size/cancellation policy. No server deployment is needed.

Verified: 30 frontend tests, TypeScript/Vite build, 38 network + 19 document-tree + 14 thumbnail-cache native checks, APK asset paths and v2/v3 signatures. Cache checks cover retained bytes across cache reconstruction, no repeat download on hits, capacity/age eviction, interrupted writes, connection-key separation, traversal rejection, and clear-during-download invalidation. Installed version 0.1.4 (5) on the Galaxy Tab; native screenshot confirmed the compact gallery and 139 cached thumbnails (2.9 MB). The actual clear button reduced usage to 0.0 MB / 1 GB and 0 items. Cache warm-load latency across an actual device process restart was not measured.

## Native boundary

`window.LakomicsNative.request(id, operation, JSON.stringify(payload))` and `cancel(id)` return through `CustomEvent('lakomics-native', {detail:{id,ok,data,error}})`.

- `status` and `configure {endpoint,token,allowPrivateHttp}` return `{configured,endpoint}`. Configure first checks candidate credentials using read-only `/v1/library/classifications`; only a valid response replaces encrypted settings. Failed checks preserve the previous connection and provider caches.
- `disconnect` clears the encrypted connection and provider caches/grants and returns status.
- `api {path,method?,body?}` accepts only GET library classifications/assets/revisit/date/creator-assets, GET pending-capture list/download, and POST asset media-ticket/batched media-tickets. POSTs issue read tickets only. No ingest, delete, registration, classification write, metadata backup, or replication endpoint is exposed.
- `openExternal {url}` accepts HTTP(S) browser intents only. `finish` closes the activity.
- Native emits `lakomics-back` and `lakomics-resume`; the frontend resolves overlay/list back navigation before calling `finish`. The activity handles orientation/screen-size/keyboard changes without recreating the WebView, preserving React state during rotation. Process death still restarts the client normally.

Credentials are AES-GCM encrypted using an Android Keystore key in private preferences. Android backup is disabled. Tokens are not returned, logged, or embedded in source/APK. The connection form necessarily supplies the token to native once; the UI must not persist it in browser storage. Pending capture `object_key` fields are recursively removed from JSON responses. Signed media URLs remain ephemeral capabilities in frontend memory. WebView content is served only from bundled `https://app.lakomics.local/`; external navigation, frames, remote scripts, file/content access, cookies and WebView debugging are disabled. Media subrequests use HTTPS and receive no native bearer header. TLS errors are cancelled.

Bridge work is bounded to four workers and 48 queued requests; request bodies are limited to 64 KiB, JSON responses to 4 MiB, connect/read timeouts are 12/20 seconds, and byte-copy loops have a 90-second deadline plus at most one read timeout. Cancelling disconnects the active native connection. User-facing Korean errors distinguish authentication, timeout, connection, TLS and unsupported operations without including raw exception messages, tokens or URLs. Connection changes cancel other bridge requests and clear provider metadata/media. Existing consumers may already hold bytes/file descriptors granted before disconnection; those cannot be recalled.

## DocumentsProvider

The Android system **document picker** displays Lakomics after connection. This is a read-only DocumentsProvider, distinct from Android's Photo Picker and the CloudMediaProvider PoC. It supports standard multi-attachment document flows when the receiving app uses them; it does not force unsupported apps to use SAF.

Root contains All assets and the actual classification hierarchy. Classification directories retain child classifications and directly assigned assets. Each listing requests at most 100 assets; a `More assets` directory encodes the continuation cursor, so the full library is traversable without one enormous cursor. These continuation directories are navigation-only, block tree-root selection, and cannot pass ancestry checks as grant roots; ordinary single/multiple file picking still grants the selected stable asset documents. Asset document IDs are stable `asset:{server_asset_id}` across directories/pages. Names use stable asset ID plus MIME-derived extension because the current API supplies no original filename. Metadata is cached privately (8 MiB cap); reopening an old asset can recover type/size with a read ticket when list metadata has been evicted. Classification membership/tree checks use available server classification data and cached membership, so a persisted classification-tree grant may require revisiting its listing after cache eviction.

Original/thumbnail downloads now use the shared MediaRepository described below. Network transfers no longer hold the classification/connection metadata lock. Metadata callbacks still serialize separately; the platform child-list query callback has no CancellationSignal. Native/device acceptance remains required for picker refresh, thumbnails, multi-select, cancellation, recipient reads, rotation/backgrounding and video sizes.

## 0.2.0 — unified Picker, media cache and discovery Home (2026-09-07)

This section supersedes the cache/separate-Picker behavior recorded in the earlier checkpoints. Package remains `com.lakomics.mobile`; the existing document authority is joined by API33+ `com.lakomics.mobile.cloud`. The old PoC source, installed package and selected device provider are untouched.

- Home: 12 recent items, six visited-classification shortcuts, four daily rotating classification covers (different top-level branches first), and date/creator Revisit image groups. Covers request at most four metadata pages with concurrency two; Recent paints independently. No introduction/Continue section. Library retains its virtualized continuous listing. Gallery thumbnails pause while viewer/settings overlays are open.
- MediaRepository: app, DocumentsProvider and CloudMediaProvider share one private 1 GiB media-byte budget, including reservations for active downloads. Existing thumbnail keys are retained. Original images up to 32 MiB are cached for viewing; videos and larger/unsupported image formats use ephemeral signed URLs directly in WebView. Selected originals are cached up to 512 MiB per file; thumbnails up to 16 MiB. Oldest-access and seven-day idle eviction apply. Retired document-media downloads are cleared on shared-repository initialization. This media budget does not include the metadata index or Android's own WebView/system caches.
- Same-file opens share a transfer lock; four file transfers run independently. Account-scoped keys and generation checks reject stale cache commits after connection changes/clearing. Completed files are seekable read-only descriptors. Content-Length and ticket size are verified; empty, oversized and truncated data never publish. Transient failures get at most one fresh-ticket retry. API/control workers are separate from downloads. The bridge still cancels after 45 seconds; provider opens instead have a bounded per-response 180-second transfer deadline, plus network read timeout.
- Viewer cancellation reaches native. One known-small neighboring image may preload; videos never preload as neighbors. Video retry renews the signed URL and restores playback position. No measured speedup is claimed without device timing.
- CloudMediaProvider is API33-guarded and protected by the official `com.android.providers.media.permission.MANAGE_CLOUD_MEDIA_PROVIDERS` permission. Existing classifications/cursor APIs form a private metadata snapshot; no new server endpoint or deployment is needed. Flat albums retain breadcrumb names, direct classification membership, nonempty covers and counts. Stable IDs/collection ID, row generations, deletion tombstones, MIME/size filters and pagination support system synchronization.
- Snapshot refresh uses a separate worker, at most once per 15 minutes automatically while used, or explicitly from Settings. Only a complete traversal replaces the last successful snapshot. Failures preserve it; connection changes cancel/reset it. Limits: 200,000 assets, 2,000 pages, ten minutes and 96 MiB serialized metadata. This is not an offline original library or a scheduled background service.
- Settings exposes combined cache clear/usage, Picker refresh/readiness, eligible/selected state when available, and normal Photo Picker settings. The old PoC's private credentials/manual album IDs are not imported automatically. The main app reuses its own existing connection.

### Device transition — prepared, not executed

Installing this APK updates the main app and its DocumentsProvider. Android controls Photo Picker eligibility and one selected cloud provider per profile; declaring a provider alone does not make a personal debug APK generally eligible. See the [official integration guide](https://developer.android.com/guide/topics/providers/cloud-media-provider).

On the reconnected authorized tablet, first record its current selected cloud provider and `mediaprovider/allowed_cloud_providers` override. The existing device research in `docs/research/android-cloud-media-provider-poc-20260906.md` documents the shell-only mechanism already used for the PoC. A transition would preserve every existing entry, add `com.lakomics.mobile`, and select `com.lakomics.mobile.cloud`; do not reset global DeviceConfig synchronization or remove unrelated entries. Restore the recorded prior values if acceptance fails. This task did not perform any of those device changes. The app opens normal Photo Picker settings and gives a manual-menu hint on unsupported firmware.

After reconnection: install in place, refresh albums, verify nested classification membership in Collections and DocumentsUI, select multiple images and a video into a receiving app without publishing, verify readable bytes/MIME/seekability and cancellation, then check warm reuse after process restart, cache clearing and disconnect/account-change isolation. Measure cold/warm gallery and video first-frame times. Retain the old PoC until those pass. Eligibility, actual recipient attachment, large-library memory and real transfer timings remain unverified while disconnected.

Local verification: TypeScript/Vite exit 0; SDK35 Java compilation; 38 network + 19 ancestry + 18 disk-cache + 22 media-transfer checks and PickerSnapshot tests; all 12 packaged asset paths and APK v2/v3 signatures. APK version 0.2.0 (6), SHA-256 `908233AFA68A86BBD246A3040F2FC53448C3ACB81F0445F402F12B9A3FF94C89`. Browser fixtures covered landscape, 800x1280 portrait and 390x844 phone layout, navigation/viewer/settings and cache-clear feedback; the narrow document width stayed 390px and browser warning/error logs were empty. These are local/browser outcomes, not native attachment acceptance. No deployment, production data write, device mutation or Git write occurred in this task.




## 0.3.0 — read-only Collections (2026-09-07)

Adds a Collections destination with game cases, manga volumes/editions, movie posters, manual Showcase browsing, title search and cover appreciation. It reads a PC-published Collection replica; WorkArtwork stays separate from Assets. Artwork uses the existing account-scoped 1 GiB cache. Visible requests are bounded and original artwork is requested only when opened. List pages contain at most 48 works; volume shelves render 96 covers per increment. Snapshot changes offer a fresh first page, and older servers show an explicit unavailable state.

Server installation must include both `server/lakomics-api/app.py` and the new `mobile_collections.py` (plus current existing runtime modules). The module creates additive replica tables on startup. No production installation has occurred. The PC Settings control **모바일 컬렉션 업데이트** uploads existing committed artwork and then atomically publishes metadata; it does not perform provider downloads or lazy volume imports. The APK alone cannot populate Collections. Production deployment and initial publication require separate authorization.

Build: `build/lakomics-mobile-debug.apk`, version 0.3.0 (7), SHA-256 `BDB41E7E89D7BAE901CF1E12EC1E73A70147AFDA1D93821D35D25971F15FA58F`. Mobile tests 45 passed; TypeScript/Vite and Android build exit 0; 45 network, 19 ancestry, 18 cache, 22 transfer and PickerSnapshot checks passed; APK assets and v2/v3 signatures verified. Browser fixture checks covered list/detail/volume navigation at tablet landscape and narrow portrait sizes with no browser warnings/errors. Device installation, native PC publication, real-media/cache timing and end-to-end cloud acceptance are still unverified. Manga Catalog, bookmark edits and DB-update jobs are subsequent milestones, not part of this APK.


## 0.3.1 — shared PC application icon

The launcher now reuses `app/src-tauri/icons/icon.png` byte-for-byte at `res/drawable/ic_launcher.png`; the temporary equal-height solid-bar vector was removed. Icon source SHA-256: `41AAC91306566C6A8ACA4D081A1E53B4F308FA8EA8DEE5BCDBB18173759B262C`. APK version 0.3.1 (8), SHA-256 `58A7954B74390B377ADA3DD1607EB5B4299E8FC7DAD23BBF98B50878F1A46B93`. Android build, native policy/cache/transfer checks, packaged assets and v2/v3 signatures passed. Launcher appearance on an installed Galaxy Tab remains unverified.

The authorized Collection API deployment and first publication are now complete: 340 collections (181 game, 147 manga, 12 movie). Production pagination/detail and representative original/thumbnail hashes passed. Install the current 0.3.1 APK for the Collections destination and shared PC icon; this build has not been installed/validated on the Galaxy Tab in this task.


Collection source-cover repair is a PC publisher change compatible with installed APK 0.3.1. It includes cover/volume files already present in the library's Collection source folders, in addition to managed WorkArtwork. It preserves explicit selections and existing volume IDs, generates bounded previews in TEMP, and does not re-copy or register the source files into the local Asset Library. Refresh Collections after the corrected publication; no APK reinstall is required for this repair.

Source-cover correction is published: all 340 works now have covers, including the 261 omitted previously; 2,332 volume covers are linked. The Galaxy Tab showed populated game covers and the recovered Prison School volume shelf on existing APK 0.3.1. No reinstall is needed. See the current operational checkpoint in docs/agents/mobile.md.

## 0.3.3 device-only temporary images

Extension 2.0.0.1558 adds a root-list **임시 저장** action. `TemporaryImageActivity` accepts its package-targeted browsable intent, downloads a direct public HTTPS image without cloud/auth settings, and creates a local photo under `Pictures/Lakomics/임시보관/`. MediaStore pending publication keeps incomplete files out of pickers. Completion returns to the browser; failure stays visible with a close action. The source URL and filename are not persisted in the library, and no server API is used. Android 10+ is required for this action; the Galaxy Tab target satisfies that OS boundary. No auto-cleanup, gallery manager or cloud-promotion feature is included.

Build 0.3.3 (10), APK SHA-256 `5CD79B33C9EDF3ED38C1ED039099DECD2933D413256A3876A7AC8D12224A43F5`: mobile TypeScript/Vite, native compilation, 23 temporary-image policy cases, existing native checks, asset paths and APK signatures passed. Extension tests cover validated URL handoff and exclusion from permanent saving; a browser fixture verified the separate colored row after the six root classifications. Installed on Galaxy Tab S11 on 2026-09-07 with Titanium extension 2.0.0.1558. A real long-press/release and temporary-save tap wrote the public WebP completely to MediaStore; **컬렉션 → 이 기기에서 → 임시보관** was visible and a recipient app read the selected 30,320-byte image successfully. Cookie-protected images were not tested.


## 0.4.1 — Mobile Catalog reader and latency pass (2026-09-08)

The Manga Catalog now has an actual read path: detail opens an authenticated ordered page manifest, and the Android client renders a vertical continuous reader with device-local reading position, current-page chrome, bounded nearby-page prefetch and one automatic manifest renewal when expiring page URLs fail. Catalog covers and reader pages share the existing account-scoped 1 GiB / seven-day native media cache; cache identities include the publication revision. Native URL policy accepts only validated `ehgt.org` covers and `siam-cdn.net` reader pages.

Catalog browsing also gains session LRU caches for list/detail/edition/reader metadata, next-page prefetch, ready counts in the search response, successful HTTP connection reuse, and a server-side v2 user projection. The v2 projection precomputes visibility/language/bookmark state plus the first 80 Latest items per language while retaining legacy v1 projection fallback and same-revision in-place upgrade. Dynamic grouped search materializes matching candidates once. On the production-sized read-only snapshot used for measurement, the old default first page was about 6.6–7.5 s server-side; the prepared v2 Latest page was about 0.5–0.8 ms, while representative artist search fell from about 2.2 s to about 0.7 s. Projection preparation measured about 18.8 s and occurs at publication time, not on ordinary reads. These are server-side measurements, not Galaxy Tab end-to-end timings.

Verification on the integrated checkout: 56 mobile frontend tests, production TypeScript/Vite build, Android compile plus NetworkPolicy 97 / DocumentTree 19 / ThumbnailCache 19 / MediaTransfer 22 / TemporaryImage 23 checks, and 16 server catalog/replica tests passed. A bounded real-source VPS canary parsed a 26-page gallery and fetched a real `siam-cdn.net` WebP page; a real `ehgt.org` cover also returned 200 WebP. Final APK: `android/build/lakomics-mobile-reader-0.4.1-debug.apk`, version 0.4.1 (12), SHA-256 `14ff0bd18ae051b0e7e3805add1b1f6d755719840783e7d4de92947608e2ec4d`, signed with the existing debug update identity. Production reader/v2 server deployment, same-revision v2 republish and Galaxy Tab reader/timing acceptance remain separate operational gates.


## 0.4.2 — single-page Catalog reader (2026-09-08)

The Manga Catalog reader now shows exactly one page at a time instead of a vertical webtoon-style strip. Horizontal swipe, explicit previous/next controls and desktop arrow keys change one page at a time. Device-local reading position, nearby ±2 page prefetch, the shared 1 GiB / seven-day native cache, publication-scoped cache identity and one automatic expired-manifest refresh are retained. Enabling the Catalog bookmark scope also forces the sort back to Latest; leaving bookmark scope keeps Latest selected.

The production v2 Catalog server/projection from 0.4.1 is already deployed and does not need another server update for this client-only presentation change. The integrated mobile suite passes 58 tests; production TypeScript/Vite build passes, and Catalog coverage includes single-page navigation, reading-position persistence, bounded prefetch, one-shot manifest refresh and bookmark→Latest behavior. Final APK: `android/build/lakomics-mobile-reader-0.4.2-debug.apk`, version 0.4.2 (13), SHA-256 `1b23197dfa26793a5e894a0aaca8789e4397bd3ce50189354ed8d542356e837b`, signed with the existing debug update identity. Galaxy Tab interaction acceptance remains pending install.

## 0.4.3 — page-fit reader zoom and looping video defaults (2026-09-08)

The Manga Catalog reader now uses the full fullscreen surface for the current page; top/bottom bars are overlays rather than reserved layout rows. Reader chrome starts hidden and is shown only by a short tap. Page changes by swipe, keyboard or navigation controls do not force the bars visible. The reader supports 1x–5x pinch zoom, bounded drag while zoomed, and a screen-fit reset action; page swipes remain enabled only at 1x. Device-local reading position, nearby-page prefetch, automatic expired-manifest refresh and shared 1 GiB/seven-day page cache are unchanged.

The normal Asset video viewer now requests autoplay and loop by default. Android WebView no longer requires a media playback gesture, which allows the asynchronously resolved signed media URL to begin playback automatically. Audio is not forced muted. A paused video remains paused across retry while initial opens and actively playing retries autoplay.

Verification: 60 mobile frontend tests and the production mobile TypeScript/Vite build passed. Android source compilation plus NetworkPolicy 97, DocumentTree 19, ThumbnailCache 19, MediaTransfer 22, TemporaryImage 23 and PickerSnapshot checks passed. Final APK: `android/build/lakomics-mobile-reader-0.4.3-debug.apk`, version 0.4.3 (14), SHA-256 `6117829f696105d2c89fe9e69cb5507d627f1e034015047fe82bc3a779d2b31f`, signed with the existing debug update identity; APK Signature Scheme v2/v3 verification passed.

## 0.5.0 — Server catalog refresh and S11 browsing (2026-09-13)

APK: `android/build/lakomics-mobile-0.5.0-debug.apk` (1,164,708 bytes), SHA-256
`a52635cdbd36c3ef4530e3dda6344806a92d0a8a3aeb615a0db11fe562aa1680`.
Package `com.lakomics.mobile`, versionCode 15, versionName 0.5.0. The signer
SHA-256 `8e7bd2ce6cfc8b19c9d9aa9e86050a41f8a7d2a51d318d3f3f65eb57e2e5f4f7`
matches the prior 0.4.3 APK. Install in place; no uninstall/data reset is needed.

Includes the server catalog refresh request/progress UI, Collection rating/sort
filters, and landscape character hierarchy/cards with retained portrait layout.
The server API was deployed with backup and authenticated HTTPS checks; character
content still needs its first PC publication. Catalog already has its baseline.
No production refresh job was submitted during deployment.

Linux SDK35/JDK17 compile, NetworkPolicy 110 / DocumentTree 19 / ThumbnailCache 19 /
MediaTransfer 22 / TemporaryImage 23 checks and PickerSnapshot tests passed.
Mobile TypeScript/Vite build, all 12 bundled asset byte comparisons/paths, APK
alignment and v2/v3 signatures passed. The Linux packaging used the same native
compile/DEX/resource/ZIP/alignment/signing steps as build.ps1 with Linux SDK tools
and an isolated temporary output directory; the existing keystore was retained.
No Galaxy Tab installation or native device interaction was performed.


## 0.6.0 — Portrait layout, automatic publication and encrypted Notes (2026-09-13)

APK: `android/build/lakomics-mobile-0.6.0-release.apk` (1,176,996 bytes), SHA-256
`409e333927164eea69e4ba6e1af12c99dc2955f9661761705e7bd9fbdf9e3130`.
VersionCode 16; release DEX, explicit non-debuggable manifest, WebView debugging off.
The v2/v3 signer matches 0.5.0; the existing development certificate is retained
for installation updates. This is not a separately provisioned store-signing key.

- Logo opens the contextual sidebar. Home no longer shows visited folders. PC
  classification order and character/group hierarchy are published to the Library tree.
  Portrait Collection controls are compact; Catalog count/refresh are in the header.
  Landscape navigation is centered and connection status lives in Settings.
- Manga/game descriptions are hidden in the mobile presentation. Metadata appears
  in portrait content and landscape sidebars. TV season posters, episode rows,
  production/runtime/rating/genre metadata use committed PC metadata. Hero artwork
  progressively replaces its thumbnail with the original image.
- Landscape Catalog reading uses cover alone, then right-to-left 2–3/4–5 spreads
  with no gutter. Aspect ratio and current page survive rotation. Asset swipes
  work for images and video surfaces; video controls and pinch remain separate.
  The Library viewer can append more assets as it approaches the loaded end.
- PC migration 74 retains dirty Collection/character generations across restart;
  the updated desktop publishes after 30 seconds quiet or five minutes of continuous
  changes, retries failures, and publishes folder order. Mobile checks revisions
  on entry/resume and every minute while browsing, keeping readers undisturbed.
  The updated desktop native build must run for this publisher; an APK alone does
  not update the PC executable.
- Notes use the PC recovery key (entered once), AES-GCM envelopes, Android Keystore
  protection, encrypted local SQLite drafts, 500 ms autosave and two-way revision
  sync. Offline edits remain pending; concurrent edits are preserved as copies.
  Notes support creation/editing, search, pin, trash and restore. Other mobile
  Collection/character editing remains excluded.
- Native asset ticket requests are batched, Collection artwork caches follow content
  digests, Catalog media caches retain unchanged source URLs across publications,
  and offscreen Catalog covers wait until near the viewport.

Verification: mobile suite 79/79 passed, followed by final App 9/9 and Catalog/Viewer
23/23 checks including four added regressions. Mobile TypeScript/Vite and desktop
TypeScript passed. Rust automatic-publication durability, character projections
(2), Collection snapshots (9), committed TV extraction (1) and Notes encryption
interop (1) passed; the existing opt-in Collection canary stayed ignored. Server
Collection/character/Notes tests passed 27/27. JDK17/SDK35 native compilation,
NetworkPolicy 119, DocumentTree 19, ThumbnailCache 19, MediaTransfer 22,
TemporaryImage 23, NotesCrypto 4 and PickerSnapshot checks passed. APK asset byte
comparison, portable paths, alignment, manifest and signatures passed.

Browser fixtures at 800×1280 and 1280×800 verified portrait/landscape metadata,
compact controls, season episodes, original hero loading, Notes save/navigation,
centered bottom buttons, correct ratio/RTL/gutter/rotation, and asset swipes in
both directions. These are browser fixtures, not native device or real-network
performance evidence. Android Keystore/SQLite offline conflict acceptance, native
video gestures, actual cache timing and Windows native execution remain unverified.

Server rollout replaced only `mobile_collections.py` and `mobile_characters.py`.
Backup: `/home/linuxuser/lakomics-api/backups/mobile-0.6.0-20260913`.
Installed SHA-256 values match local source:
- Collections: `1fb9de4c4af1caed14a0d86409f6155b6dcf07b91fad1121c0eface01923a85f`
- Characters: `f5f542d4c1b0fd617910626c986040e02b23008cc3b0b8ade78e8a8f5abac054`

API and local proxy services are active/running with NRestarts=0. Tailnet HTTPS
health, both revision status endpoints, Collection list, character index and
Catalog status returned 200 with authentication; both new status endpoints reject
missing authentication with 401. Character and Collection publications were ready.
No refresh ingestion, full backfill, device installation or Git mutation was run.


## 0.6.1 — Compact headers and Catalog cover fix (2026-09-13)

Release APK: `android/build/lakomics-mobile-0.6.1-release.apk` (1,176,996 bytes).
SHA-256: `083efd937446e26f2f3f9d5bb8fd840e74c672e5db92761b1cb31f3f71c7f331`.
VersionCode 17, existing update certificate, non-debuggable release configuration.

- Catalog detail cover now provides the positioning/overflow boundary for its
  absolute image wrapper. It stays inside the 180×270 detail cover in the checked
  landscape viewport, and the Read action opens the actual page reader.
- Landscape Library title/path/count/density/refresh share the 64px app header;
  the duplicate content heading and character-location rows are removed. Portrait
  Library retains inline controls. The sidebar search is removed and an All folder
  opens every Library asset with the existing recent-first listing.
- Collection type/title and refresh move to the fixed app header in both orientations.
- Grid cards in Home, Library and character views omit missing-author fallback text;
  actual creator names/handles and the right-aligned date remain visible.

Verification: focused App/Catalog/CharacterBrowser/Collections 37 tests, responsive
header/All folder 2 tests, and Home/Gallery 9 tests passed. Mobile TypeScript/Vite,
Java native compile and existing policy/cache/crypto checks, portable asset bytes,
APK manifest/version, alignment and v2/v3 signatures passed. Browser fixtures at
1280×800 and 800×1280 verified compact headers, correct detail-cover bounds, real
reader entry, portrait Collection layout and no horizontal overflow. Device/native
acceptance remains pending. No server/API changes or deployment were needed.
The temporary mobile preview server was stopped; the PC development server was
left running.


## 0.6.2 — Reader stability, visibility sync and Library polish (2026-09-13)

Release APK: `android/build/lakomics-mobile-0.6.2-release.apk`.
SHA-256: `0ce58f2dca859ea42881dc86fec62c41403e73e14e5ec432e6ced7779edd76d6`.
Release DEX, non-debuggable manifest, bundled asset verification and v2/v3 signature verification passed; the existing installation certificate is retained.

- Catalog orientation follows the actual reader stage: portrait is single page; landscape uses Japanese spreads, with a right-side cover and blank left leaf. Decoded image dimensions determine page widths and `contain` preserves aspect ratio. Fractional flex growth no longer underfills single pages.
- Nearby reader pages remain mounted under the same parent. Navigation commits only after all target pages decode; an evicted page must become ready again. Existing images survive address refresh and delayed loads. Catalog and Collection covers remain visible while their tab is paused.
- PC hidden categories and blocked tags now publish automatically as a settings-only request. The existing 10-second PC tick uses a 30-second quiet period, a 5-minute maximum dirty age and 60-second failure retry. Migration 75 persists pending digests per endpoint. One initial Catalog publication is still required, and PC cloud sync must be enabled/running. Bookmarks, grouping and edition preferences retain their existing publication behavior.
- Catalog defaults to Today popular. Movie cards show production company plus year or first/last season date; the fixed header shows the total after filters, including results beyond the current page.
- Library folders start collapsed, including newly synchronized folders. Header icons collapse all, expand all or expand the current path. Video badges use a small play icon. Asset info panels have clearer grouping; adjacent image originals preload next-first with a bounded six-entry prepared cache.

Verification: 90 mobile tests passed, then the final Catalog suite passed 17 tests including the added landscape regression (91 unique mobile tests). Two Rust auto-publication tests passed, including restart durability/debounce of visibility settings. All 24 Catalog/Collections API tests passed, including authenticated settings-only publication, preservation of other user state, idempotence and filtered pagination counts. Mobile TypeScript/build and native APK policy/cache/crypto checks passed. Browser demo checks at 800×1280 and 1280×800 confirmed original reader proportions, right-to-left touching pages, collapsed Library roots, movie captions/count and the Asset info panel. Device-level WebView flicker, actual network speed, APK installation and Windows native execution remain unverified.

The two API modules were deployed with source backups at `/home/linuxuser/lakomics-api/backups/mobile-0.6.2-20260913`. Installed source hashes matched:

- `mobile_catalog.py`: `857c4aa50e74da525e226e9d0de8f9d99f649c7661e76ec96388cf1a0a95f158`
- `mobile_collections.py`: `6655babc268c84159f384f86bc29c23f096018a3a17bc17171c6bbd4024d4d25`

Both API/proxy services were active with zero restarts. Authenticated HTTPS reads returned ready Catalog status and Movie Collections with `totalCount=12` while requesting only one item. No full catalog replacement, backfill or ingestion was run for verification. The PC dev process remains running with the rebuilt native source.


### PC automatic publication follow-up (2026-09-13)

Live investigation found automatic replication enabled, with Character generation 13 versus acknowledged generation 3, while the preceding Collection artwork pass was still running. The old scheduler awaited Collection completion before starting Characters or Catalog visibility, and kept the frontend tick occupied for the entire batch.

The native dispatcher now returns after starting independent Collection, Character and visibility workers. Each kind has its own in-flight guard, retains durable debounce/retry state, and can run again on the next tick without waiting for another kind. A regression blocks the Collection worker while two Character ticks finish, rejects a duplicate Collection worker and verifies later reuse. All three scoped auto-publication tests passed. The running Linux dev process rebuilt/restarted; without invoking manual publication, Character generation and published generation both reached 14 and the server logged a successful Character replica PUT while Collection generation 98 remained pending against published generation 62. No user settings or library rows were edited manually. This is a PC-native fix; the delivered 0.6.2 APK and server source require no additional update. Windows native runtime remains unverified.


### Collection publication performance follow-up (2026-09-13)

Collection publication now checks immutable storage receipts in batches of up to 256 manifests. Confirmed files skip local rereading and per-file preparation; new/mismatched files retain the bounded four-worker upload and exact HEAD confirmation. The server validates receipt size/type, rejects duplicate/oversized batches, and invalidates a receipt when a media-ticket request discovers a missing object. Older servers returning 404 fall back to per-file preparation. Metadata remains a complete revision-checked snapshot; this is not per-collection delta serialization.

PC image descriptors are cached in memory (up to 20,000 entries), keyed by canonical path plus file identity, size, modification time and change time (Unix device/inode/ctime; Windows file ID/ChangeTime). Replacements invalidate the descriptor, and uploaded bytes still receive a fresh hash check. Derived source thumbnails reuse process-owned temporary storage with a 256 MiB rotation threshold; in-flight snapshots retain their directory lease. Restarting the PC clears these caches, so its first snapshot still reads files and generates source thumbnails. Source path confinement and the library read-only snapshot boundary remain intact.

Verification: 12 scoped Collection Rust tests passed, one explicitly authorized publication test remained ignored; 16 Collection API tests passed. Coverage includes same-size/same-mtime replacement, missing/oversized files, receipt reuse without file access or per-file HTTP, old-server fallback, four-transfer barrier, stale publication, and missing-media receipt invalidation. Windows native execution and actual mobile timing remain unverified. No APK update is required.

API module deployed with backup `/home/linuxuser/lakomics-api/backups/collection-fast-20260913/mobile_collections.py`; installed SHA-256 `c3c93577b43770dd0755a0d163d5732f7262c3ebae40070d65efb7535c5fdc28` matched local source. API/proxy services were active with zero restarts; authenticated batch-check and collection-list reads passed. The Linux PC dev process rebuilt automatically.
