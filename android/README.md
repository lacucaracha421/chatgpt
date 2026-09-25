# Lakomics Android client

Current source version: **0.8.16 (53)** (built, not installed; 0.8.10 was installed and tested end to end by the user), declared in [AndroidManifest.xml](AndroidManifest.xml). The version history below starts at 0.7.9; 0.8.1–0.8.9 are recorded in the commit log. 0.7.x replaces the PC-style Library drawer and Collections toolbar with mobile drill-down browsing; see the 0.7 section below.

## Current functionality and remaining gates

- Independent authenticated Home, Library and read-only Collections; Continue was removed in favor of Recent and classification/date/creator discovery.
- Shared Manga Catalog search, detail, editions and bookmark filtering. The reader shows one page in portrait and Japanese two-page spreads after the cover in landscape, with hidden-by-default overlay controls, horizontal navigation, 1x–5x zoom and bounded pan, device-local position, nearby-page prefetch and one expired-manifest refresh.
- Shared 1 GiB native media cache and cache-clear controls; Asset videos request autoplay and looping while preserving a paused retry state.
- Read-only DocumentsProvider and integrated CloudMediaProvider, plus device-only temporary image saves. Provider implementation does not guarantee every receiving app's picker compatibility.
- Remaining gates include the recorded 0.4.3 device install/reader checks, recipient Picker/SAF multi-select/restart compatibility and real media timing. Catalog bookmark mutations, server refresh authority, System Share quick-save and extension update management remain separate backlog work.

Collections and Catalog deployment evidence is recorded in the version history and backlog. An APK build alone does not publish their data or establish device acceptance.

This independent APK bundles the React client from `_tools/app/mobile-client`. It requires no desktop/browser extension runtime. The old `_tools/lakomics-cloudmedia-poc` and its installed Android Photo Picker configuration are separate and unchanged. Package: `com.lakomics.mobile`; document authority: `com.lakomics.mobile.documents`.

## 0.8.16 — Notes list tidy-up, built, not installed (2026-09-25)

User feedback on 0.8.15: 휴지통 and 복구키 보기 moved off the Notes list into a ⋯ button at the right end of the Notes top bar (next to 동기화), which opens a small sheet with "휴지통 N" and "복구키 보기". 보관함 stays a quiet link at the end of the list, shown only when something is archived.

## 0.8.15 — Notes v2 on the tablet, built, not installed (2026-09-25)

Parity with the PC Notes v2 ([design](../docs/research/notes-v2-design-20260924.md), including its Android deviations section; ADR-0035 amendments).

- **Notes:** checklists (add, check, long-press drag on the handle, collapsible 완료 group), eight note colours, labels with filter chips, 보관함, search (secret notes by title only), rendered Markdown with tappable task boxes and the Markdown help, text ↔ checklist conversion. Notes from a newer app stay listed read-only; unreadable rows are counted instead of failing the list or sync.
- **Sync:** unknown fields survive saves, a pull meeting a local edit merges three-way against the stored base, a save queued before a pull is rebased, and only a real collision keeps both copies (사본).
- **암호 메모:** fingerprint or a per-device PIN (never synced), escalating lockout, re-lock after 5 idle minutes / leaving the note / background, masked values with 보기 (10 s) and a sensitive 복사 cleared after 30 s, PIN reset with the recovery key.
- **Keyboard:** the editor keeps the line being typed above the keyboard.
- **Checks:** `NotesModelTest` runs the shared PC fixtures (30 merge vectors, 7 payload examples, 8 undecodable payloads, the v2 AES-GCM envelope) plus PIN/draft checks. Not verified on a device: BiometricPrompt, the keyboard lift, clipboard clearing, PBKDF2 unlock time, and a real round trip with the PC through the server.

## 0.8.11 — 폴더 보내기: a folder as one zip, built, not installed (2026-09-25)

- 보내기/받기 gains **폴더 보내기** beside 파일 보내기. The system folder picker
  (`ACTION_OPEN_DOCUMENT_TREE`, no storage permission, no persisted tree grant) hands over a
  tree; a worker walks it with `DocumentsContract` child queries and writes
  `<folder>.zip` into `cache/exchange-zips/` (`ExchangeZip`): entries `<folder>/<relative
  path>` with UTF-8 names and `/`, a directory entry for every folder (empty ones survive),
  file times from `COLUMN_LAST_MODIFIED`, duplicate names numbered, deflate level 0 for
  already-compressed media and level 1 otherwise.
- The 2 GiB per-file cap is checked on the listed sizes before any content is read and on
  the zip's actual bytes while writing ("폴더가 너무 큼 (압축 파일 최대 2GB)"). Unreadable
  files or folders are skipped and counted in the row ("읽지 못한 항목 N개 제외"). The row
  shows "압축 중 N%" and can be cancelled.
- The zip is then sent as an ordinary transfer; retries reuse it. It is deleted after
  completion, cancel or a permanent failure (the row then offers no 재시도), and zips no
  saved send refers to are swept at start.
- Checks: `ExchangeZipTest` (segment/path sanitising, duplicates, walk with empty and
  unreadable entries, times, progress totals, both cap checks, cancel). Not verified on a
  device (DocumentsUI tree grants, provider timestamps, zipping speed).

## 0.8.10 — PC ↔ tablet file exchange (보내기/받기), built, not installed (2026-09-25)

Design: [docs/research/file-exchange-design-20260924.md](../docs/research/file-exchange-design-20260924.md)
(stages 3 and 4); the server contract is `server/lakomics-api/file_exchange.py`.

- **Entry:** a 보내기/받기 icon in the Home header with a count badge for new arrivals, and a
  toast such as "PC에서 파일 2개" with 보기. The screen lists received and sent files with
  per-row state (업로드 중 + %, 대기 중 (받으면 삭제됨), 전달됨, 만료됨, 실패 + 재시도,
  다운로드 폴더에 저장됨 — tap to open).
- **Device token:** the exchange refuses the shared Library token (403
  `exchangeDeviceTokenRequired`) and Library routes accept only the shared token, so the
  tablet keeps both. The screen asks for a device-only `client` token (server:
  `python3 api_auth.py provision --role client --label tablet`), registers the device with
  it (kind `android`, the system device name) and stores it encrypted per endpoint.
  Disconnect removes it.
- **Receive (Android 10+ only):** automatic while the app is open. Download into
  `cache/exchange/<id>.part` with `Range` resume and a 30 s no-progress timeout, verify
  length and SHA-256, publish to `Download/Lakomics/` through MediaStore (`IS_PENDING`,
  deleted on failure, final name read back), then ack. A 7-day received ledger turns a
  lost ack into a re-ack instead of a second copy.
- **Send:** in-app through the system document picker (multi-select, no permission) or
  from any app's share sheet (`ExchangeShareActivity`, `SEND`/`SEND_MULTIPLE */*`), which
  stays open with progress until the files are on the server. SHA-256 pre-pass, then a
  fixed-length streamed presigned PUT and `complete`; the transfer id is persisted so a
  retry stays idempotent. Transient failures retry at 2/10/30/60 s while the app is open.
- **Arrival signal:** the Library pass reads `/v1/sync/status` with the device token when
  one is stored (falling back to the Library token if it is refused), because the server
  reports `exchange.revision` only to device credentials. No extra request in steady
  state; while the screen is open it refreshes inbox/outbox every 5 s (the server has no
  `?wait=` long-poll). Nothing polls, retries or starts while the app is paused.
- **Checks:** `ExchangeTransferTest` (sanitiser golden cases, Range bookkeeping, idle
  timeout, digest verification, ledger) and exchange cases in `NetworkPolicyTest` run in
  `build.py`. Not verified on a device or against a deployed server.

## 0.7.9 — The media cache no longer rescans itself on every write (2026-09-24)

The user noticed the viewer took long to swap a thumbnail for the original. Device timing
showed the ticket (~0.2 s) and the download (~0.1–0.2 s) were fast, but storing the file
took ~1.6 s: every cache write listed and sorted the whole cache directory about five
times, and after the Library warm-up the cache held ~8,500 files (uncached thumbnails
waited 3–4 s the same way). The cache now builds its size totals with one scan, keeps
them current on each write and removal, rescans hourly for the age limit (and exactly
when Settings shows the cache), and evicts least-recently-used files only when a write
would exceed the limit. Measured on the tablet: first view of an uncached original fell
from ~2.0–2.4 s to ~0.5–1.4 s; prefetched neighbours show in ~40 ms.

## 0.7.8 — Catalog and Notes follow the mobile layout (2026-09-23)

Catalog and Notes drop the PC-style sidebar header and draw their own title bars, like
Library and Collections. Catalog: the title shows the work count and how long ago the
catalog was last published ("N분 전 갱신") beside the fetch-new-works action; search submits
on Enter; language/sort/bookmark/filter are chips with sheets, and the "show blocked"
switch moved into the filter sheet; the grid scrolls continuously instead of paging and
pulls to refresh; the detail is a full screen with a blurred cover backdrop, a large Read
(or "continue at page N") action, edition cards and tag chips. Notes: pinned and recent
note cards, a small trash link that opens its own screen, a floating new-note button and a
full-screen editor with pin/trash icons and read-only restore for trashed notes. The
sticky chip row keeps a short fading gap under the title bar in Catalog and Collections.
Data behavior (bookmarks, publication checks, filters, reader, notes sync) is unchanged.

## 0.7.7 — Background thumbnails yield to visible ones, installed (2026-09-23)

The user noticed slower first image loading after 0.7.5. The warm-up and prefetch could
occupy all ten thumbnail slots with ~2.4 s uncached downloads, so a newly visible tile
waited behind them. Background work (prefetch and Library warm-up) now has its own limit
of three slots and starts only when no visible tile is waiting; visible tiles keep ten.
The warm-up also starts five seconds after launch or return so the first screen loads
first, and its retry/repeat timers can restart it again. The full warm-up therefore
takes longer (estimated two to three times). APK SHA-256
`ac76ccee09ca0b67785c8685f32f0e6d41c15aa8c46eb3178fcf94c0f684e7ca`, installed in place with
verified version, cold start, no app devtools socket and an empty crash log. Mobile
suite 415/415. The first-load improvement has not been measured on the device.

## 0.7.5–0.7.6 — Library thumbnail warm-up, installed (2026-09-23)

- **Warm-up:** while the app is visible and the connection is not cellular or
  data-saving, the web layer walks every Library asset 100 at a time and asks native
  for each thumbnail through the lowest-priority queue (visible tiles always first).
  Progress is kept per endpoint and resumes after restart; a finished pass repeats
  after a day for new assets. Settings → media cache has a `썸네일 미리 받기` switch
  and live progress. Clearing the media cache resets progress.
- **Native:** the media cache age limit is one year instead of seven days (the 1 GiB
  least-recently-used bound is unchanged), and successful storage downloads leave the
  connection to the platform pool instead of disconnecting.
- **Measured (temporary WebView debugging, disabled again in the installed builds):**
  about 200 thumbnails per minute, so a full ~9k library warms in roughly 45 minutes
  of app time. Uncached thumbnails still take about 2.4 s each with eight in flight;
  connection reuse did not change that, so storage response latency, not handshakes,
  dominates.
- 0.7.6 (33) is 0.7.5 rebuilt with the updated npm lockfile (React 19.3, Vite 8.3).
  APK SHA-256 `b9f6b940b8ebb3c7ffae9ac0288861d18964dfc7045f1c24e1bba05d6b3cc88d`,
  existing signer, installed in place with verified version, hash, cold start, no
  app devtools socket and an empty crash log. Mobile suite 415/415; native checks
  include the updated cache-age test.

## 0.7.4 — Faster uncached thumbnails, installed (2026-09-23)

Measured on Galaxy Tab S11 through temporary WebView remote debugging (disabled again
in the shipped 0.7.4 build; the device shows no devtools socket for the app). Cached
thumbnails were already fast (4–30 ms each, a screen in 0.2–0.5 s). An uncached
thumbnail spent about 1.5–2 s in the native `thumbnail` operation (ticket plus R2
download) while the ticket API itself took about 0.07–0.1 s, and the web layer ran only
four at once, so an uncached screen of 20–27 tiles took 13–17 s. The suspected double
fetch did not occur.

- Visible thumbnails now run ten at a time and native transfers eight; a low-priority
  prefetch warms about two screens below the rendered rows through the native cache
  without decoding, yielding to visible tiles. Scrolling on drops queued prefetches but
  lets started downloads finish.
- One steady scroll pass afterwards: the first uncached screen filled in 1.8 s and the
  following screens in 0.17–0.25 s. This is a single run, not a repeated benchmark.
- APK SHA-256 `a3c11ff8c228d4e34b9b5d95e59c095abe5bd6ce6e8f20655a48c5fbf5a794c8`,
  existing signer, installed in place with verified version, hash, cold start and an
  empty crash log. Mobile suite 411/412 with the known intermittent `Catalog.test.tsx`.

## 0.7 — Browse-first Library and Collections, installed (2026-09-23)

0.7.0 (27) through 0.7.3 (30) were built with the existing signer (certificate
SHA-256 `8e7bd2ce…f4f7`) and installed in place on Galaxy Tab S11 without uninstall
or data reset; each install verified version, installed-APK hash, cold start
`Status: ok`, a live process and an empty crash log. 0.7.3 APK SHA-256:
`4e2d47aa41434fe1bb2801f0e65d799d0be309ab449238ebb35e0232b51abbb6`.

- **Library:** the drawer tree, fold tools and landscape side index are gone. The
  root shows 분류/앨범 segments, folder·character search, text-only recent folders,
  모든 자산 and cover cards; folders and albums open as ordinary drill-down screens
  with breadcrumbs, child strips, filter chips (length disabled for images), a `⋮`
  density sheet and pull to refresh. Android Back: sheet → filters → parent → root →
  finish. A folder named like a published character inside its series is hidden in
  favour of the character entry (the publication carries no link). Settings appear
  only on Home. Gallery tiles drop per-tile captions.
- **Collections:** own title bar, 게임/만화/영화/AV segments (AV waits for the PC and
  requests nothing), debounced search, a collapsed Showcase shelf, sort/rating chips
  with sheets, continuous scrolling and pull to refresh. The detail shows facts,
  edition chips, volume release dates and open work information. The cover viewer
  opens manga as the PC paperback and games as the PC case (`drawGameCase` gains an
  optional angle and raster ceiling; PC defaults unchanged), turnable within limits
  that keep the printed front in view, with pinch zoom and a flat mode.
- Checks: mobile suite 411 tests, with two known intermittent `Catalog.test.tsx`
  cases (unchanged code; they also failed in the pre-change baseline); PC collection
  renderer tests 46/46; TypeScript/Vite build. Browser fixtures were rendered in
  portrait and landscape. The user then tried 0.7.3 on the tablet and reported it
  working normally (2026-09-23); touch feel, pinch, native Back and 3D performance
  are user-observed, not measured.

## 0.6.10 — Media-ticket optimization, installed (2026-09-23)

Current source, built APK and Galaxy Tab S11 installation are **0.6.10 (26)**.
The native scheduling change is independent of the server optimizations, which were
subsequently deployed on 2026-09-23.

- Packages the existing `MediaRepository` / `TicketBatcher` optimization changes
  described below; no native implementation or build-script changes were made
  during release preparation. Settings and its version assertion now say 0.6.10.
- From `_tools/app/`, the version-targeted check passed (1 test, 7 intentionally
  skipped), followed by the mobile TypeScript/Vite build:

  ```sh
  npm run mobile:test -- mobile-client/Settings.test.tsx -t 'reports the declared Android source version rather than a stale literal'
  npm run mobile:build
  ```

- From the repository root, the existing builder completed with the existing
  JDK 17, SDK 35 and unchanged ignored `android/build/debug.keystore`:

  ```sh
  python3 android/build.py --sdk-root /home/laku/.local/lakomics-android-tools/android-sdk --java-home /home/laku/.local/lakomics-android-tools/jdk17
  ```

  All builder JVM checks passed, including the previously verified 605 assertions
  across TicketBatcher, MediaTransfer, ThumbnailCache and NetworkPolicy. Native
  compilation passed; existing Java 8 bootstrap-classpath/deprecated-API warnings
  remain. The Windows builder was not run.
- APK: `android/build/lakomics-mobile-0.6.10-release.apk`, **1,254,820 bytes**.
  SHA-256: `32c4f8516a4f2655ccbf2d39b90879046905c09b95242d4640b0fa4df5fea3e2`.
- Packaged manifest verified: `com.lakomics.mobile`, version 0.6.10 (26), min SDK 26,
  target/compile SDK 35 and `debuggable=false`. ZIP alignment and v2/v3 signatures
  passed; all 12 bundled assets byte-match `android/assets`, with portable ZIP paths.
- The single signer matches the existing 0.6.9 APK. Certificate SHA-256:
  `8e7bd2ce6cfc8b19c9d9aa9e86050a41f8a7d2a51d318d3f3f65eb57e2e5f4f7`.
  This remains the existing personal-install development certificate, not a new
  store-distribution signing identity.
- Authorized `adb install -r` on Galaxy Tab S11 (`SM-X730`,
  `100.118.150.55:39093`) succeeded. Version is 0.6.10 (26), first installation
  remains `2026-09-08 17:56:50`, and the installed base APK hash matches the artifact.
  Cold activity launch returned `Status: ok` (369 ms activity launch, not media
  latency); the process remained running and the sampled AndroidRuntime error log
  was empty. No uninstall, app-data reset, cache clear or provider-setting change
  occurred. Media rendering/performance and Picker/SAF acceptance were not measured.
- The initial server SSH check awaited Tailscale authentication. After the user
  authenticated, the server rollout completed with 371 isolated tests and live
  read/ticket/download/authentication checks. API/proxy recovery and backup evidence
  are recorded in `docs/agents/cloud-capture.md`. No further device interaction was
  needed for the server rollout. Command output is in the task transcript.

## Media ticket scheduling — shipped in 0.6.10 (2026-09-23)

The implementation checks below preceded the release build and installation above.

- Asset tickets share in-flight requests by account/cache generation, asset and
  variant. Canceled queued consumers are removed before dispatch; one consumer's
  cancellation cannot cancel another consumer's shared HTTP request.
- Cacheable browser images take the existing per-file fill lock before requesting
  a ticket, so overlapping callers recheck the completed disk cache first. Completed
  or failed tickets are not retained; a transfer retry gets a fresh ticket.
- The 12 ms batching window, 50-item batches, single ticket worker and four-download
  limit remain. Pending ticket entries and consumers are bounded to 128. Connection
  replacement/cache clear invalidates pending tickets and cancels shared HTTP.
- JVM checks passed: TicketBatcher 192, MediaTransfer 22, ThumbnailCache 19 and
  NetworkPolicy 372 assertions. All native Java sources compiled against SDK 35;
  existing Java 8 bootstrap/deprecated-API warnings remain. Both platform builders
  register the new test, but the Windows builder was not executed.
- No live media-performance measurement was performed. Catalog/Collection-specific
  artwork ticket paths remain separate from Asset batch scheduling.

## 0.6.9 — Subtle tab fade and collapsible character strip (2026-09-23)

- Active tab content fades from opacity 0.88 to 1 over 100 ms, without sliding,
  delaying navigation or remounting retained panels. Header/navigation stay unchanged.
  Home/Library use distinct animation names on their shared element so the effect
  follows committed tab changes, not background metadata updates. Reduced motion
  disables the effect.
- Portrait child folders use one horizontally scrollable row. The collapse toggle
  sits beside the series filters; folding preserves the asset gallery and horizontal
  position. Only nearby folder covers enter the media queue, and loaded previews
  survive pauses. The landscape overview and bounded grid pages remain unchanged.
- The prior character/filter/exclusion checks passed 51 tests; App/Settings passed
  40 tests for this release. Mobile TypeScript/Vite and native release-builder checks
  passed. The Java bootstrap-classpath/deprecated-API warnings remain non-fatal.
  Browser fixtures checked strip layout, folding/scroll retention and landscape;
  a shipped-CSS fixture verified 100 ms opacity keyframes, repeated tab transitions,
  no metadata-triggered restart, stationary chrome and reduced-motion suppression.
- APK: `android/build/lakomics-mobile-0.6.9-release.apk`, 1,250,724 bytes, SHA-256
  `7f089834b18275d64a07d0e135ac321eaa7e470c43296b9ada687031e52a1c2b`.
  Version 0.6.9 (25), SDK35, alignment, v2/v3 signatures, the previous signer and
  all 12 bundled asset byte matches were verified.
- Authorized `adb install -r` on Galaxy Tab S11 (`SM-X730`,
  `100.118.150.55:39093`) succeeded, preserving first installation at
  `2026-09-08 17:56:50`. Installed base APK SHA-256 matches the artifact above.
  Cold activity launch returned `Status: ok` (425 ms activity launch, not fade timing).
  The user then confirmed checking the update; device interaction stopped at that point.
  No uninstall, app-data reset, cache clear, provider-setting change or server deployment
  was performed. Browser motion checks do not establish frame-level Android performance.

## 0.6.8 — Tab-return retention, installed and portrait-checked (2026-09-23)

- Home keeps loaded covers through pauses; Gallery ignores hidden-width measurements
  and suppresses paused pagination/scroll recording. Returning to retained Home/Library
  preserves its committed scope, cancels superseded navigation, and retains fresh-read
  fallback for servers without list-generation support. A delayed filter capability
  response no longer restarts initial navigation.
- Collections reuses successful list/detail requests and keeps disclosure/volume state.
  Collections and Catalog reuse unchanged mounted artwork while preserving changed-source,
  cancellation and failure recovery. Publication checks and manual refresh remain active.
- Focused implementation checks passed 186 tests across 11 files; the version-specific
  Settings suite passed 8 tests. Mobile TypeScript/Vite and the existing native release
  builder's policy, cache, crypto and replica checks passed. Java compilation emitted
  bootstrap-classpath and deprecated-API warnings, but completed successfully.
- APK: `android/build/lakomics-mobile-0.6.8-release.apk`, 1,250,724 bytes, SHA-256
  `c08cb16a9562378c705c78dd9efb38426f61f8ba91e7dabca206dbec7de4b742`.
  Version 0.6.8 (24), SDK35, ZIP alignment, v2/v3 signatures, the existing 0.6.7 signer,
  and all 12 bundled asset byte matches were verified.
- The initial wireless address refused connection. After the user supplied port 39093,
  ADB connected to Galaxy Tab S11 (`SM-X730`, `100.118.150.55:39093`). Authorized
  `adb install -r` succeeded; package inspection confirmed 0.6.8 (24), retaining the
  first installation at `2026-09-08 17:56:50`. The installed base APK SHA-256 matches
  the artifact above. Cold activity launch returned `Status: ok` (414 ms activity launch,
  not tab/network/render latency).
- Portrait checks at 1600x2560 used native taps/swipes and screenshots. Library returned
  to its selected character scope and the same scrolled asset rows. Home, Collections
  and Catalog had byte-identical screenshots before/after settled tab round trips;
  an additional scrolled Collections round trip also matched. These checks establish
  sampled state/render retention, not absence of every transient frame or measured
  speedup. The app remained running; the sampled process-specific AndroidRuntime/
  Chromium error log was empty. UI Automator exposed only the WebView container, so
  internal DOM/request counts were not measured on device.
- No uninstall, app-data reset, cache clear, provider-setting change, server deployment
  or explicit library mutation was performed. The app was left on Library. Landscape,
  detailed Collection disclosure/volume interactions and frame-level latency remain
  outside this device check; their fixture coverage is not native acceptance.

## 0.6.7 — Manual character exclusion, live verified (2026-09-20)

Adds a named character-exclusion confirmation to the Asset viewer when opened from a
character gallery. Folder assignment, files, albums and other character memberships
remain separate. The action stays hidden until an upgraded PC publishes the required
identity, acknowledgement cursor and protected-reference metadata. Automatic inference
remains PC-owned; see [the contract](../docs/agents/mobile-character-contract.md).

- APK: `android/build/lakomics-mobile-0.6.7-release.apk`, 1,250,724 bytes, SHA-256
  `e1271af8f1d468897060bd71a20294ab49d82766ace39af5df96d7ccf2a90ec1`.
  Version 0.6.7 (23), SDK35, existing-certificate v2/v3 signatures and ZIP alignment
  were verified. All 12 packaged asset files match the frontend output; bundled JS
  contains the exclusion route, capability guard and current version.
- The build worker reported the focused Settings suite (8 tests), mobile TypeScript/Vite
  and native release packaging successful. The controller independently checked the
  resulting artifact, signer, version, alignment and bundled asset bytes. Earlier
  81-test feature evidence remains valid for the unchanged feature source.
- Authorized in-place update on Galaxy Tab S11 (`SM-X730`, `100.118.150.55:44603`)
  succeeded. Package reports 0.6.7 (23), retaining first installation at
  `2026-09-08 17:56:50`. Cold launch returned `Status: ok` (290 ms activity launch,
  not network/render latency); a subsequent screenshot showed the portrait media viewer.
  No uninstall, account reset, cache clear or provider-setting change was performed.
- Server `app.py`, `mobile_characters.py` and `character_exclusions.py` were deployed
  after baseline hash checks and an online SQLite backup (`quick_check=ok`). Source/DB
  rollback copies are at `/home/linuxuser/lakomics-character-067-ri8brlhv/rollback/`.
  Health, authenticated index and unauthorized write/log access checks passed; service
  finished active/running with `NRestarts=0`. Assets remained 9,006 and the previous
  character revision was unchanged at deployment, before feature activation.
- The first PC release build hit the 240-second limit. A user-authorized 15-minute
  retry completed in 128 seconds. The resulting `target/release/lakomics` SHA-256 is
  `41d77f144ec0cabe7c0c31448d666b7c0409a4823c575230799b5724583278f1`.
  After a checked local SQLite backup, finite native WebDriver sessions opened the
  configured library, migrated schema 88 to 89 and used the existing Settings action
  to publish 90 views. The live index then advertised `manualExclusion:true`.
- The user, not the agent, submitted the exclusion of Asset
  `1d8d1f34-b84c-421b-865e-733d1a3230b8` from LaLa target
  `77d88ce4-a2b4-4b8e-9752-54cc1741b5fa`. While the PC was closed, the server recorded
  one operation and LaLa's list changed from 22 to 21 without that Asset.
- A subsequent native PC publication consumed sequence 1 and stored `rejected` with
  `origin=manual`. Server `applied_cursor=last_sequence=1`; the pending overlay is
  empty and the acknowledged projection still excludes the Asset. Canonical manga
  assignment and its revision are unchanged; local file path and SHA-256 bytes match
  the pre-rollout snapshot, and server original/thumbnail metadata is unchanged.
  The finite PC verification sessions were closed. No extra exclusion, Git commit or
  push was performed. Windows native acceptance remains unverified.

## 0.6.6 — Asset filters and hourly Catalog refresh (2026-09-20)

Library, Album and Character galleries gain media, aspect and video-duration filters.
Images include GIF; square follows PC's inclusive 0.8–1.25 band. Duration buckets are
under 30 s, 30–60 s, 1–5 min and >=5 min. Query identity, pagination, failed changes,
nested Back and Character technical-metadata refresh retain their scoped guards.

- APK: `android/build/lakomics-mobile-0.6.6-release.apk`, 1,250,724 bytes, SHA-256
  `05bc479deba0d6debc7492ddbfb2f0f665bc5dbea8ca1a4a6d8841b69a0359ef`.
- Existing SDK35/JDK17 release builder completed. Controller verified version/badging,
  ZIP alignment, all 12 bundled asset bytes and existing-certificate v2/v3 signatures.
  The version-specific Settings check passed 8 tests; mobile TypeScript/Vite build passed.
  Earlier feature/source tests remain applicable; the full mobile suite's isolated-pass
  Catalog Reader timing failure is documented in `MOBILE-UX-001`, not hidden by this build.
- Authorized in-place install on Galaxy Tab S11 (`SM-X730`) succeeded. Package reports
  0.6.6 (22), retaining first installation at `2026-09-08 17:56:50`. Cold launch returned
  `Status: ok` (329 ms activity launch, not network/render latency). A subsequent native
  portrait screenshot showed the gallery and active image/landscape filter summary.
  No uninstall, account reset, media-cache clear or provider-setting change was performed.
- Seven server modules were deployed with guarded source hashes and a checked online DB
  backup at `/home/linuxuser/lakomics-mobile-066-release-20260920-0q0724jr/rollback/`.
  Live checks covered all nine filter cases, continuation/no-overlap, mismatched-filter
  rejection, two pre-deployment cursors and Character live technical metadata. Korean
  and Japanese hourly schedules were armed roughly one hour ahead; no refresh was forced.
  Existing Assets, authority state, Character publication and Catalog pointer were unchanged;
  API and proxy finished active/running with `NRestarts=0`.

Video poster v2 is deployed for future eligible jobs; existing poster keys stay intact.
A fresh production video and the first scheduled provider refresh were not triggered or
waited for as acceptance checks. Album/Character touch flows, exhaustive duration filtering
on-device and landscape acceptance remain separate from the observed portrait rendering.

## 0.6.5 — sidebar and Catalog icon cleanup (2026-09-20)

Catalog settings now uses a funnel icon, distinct from the global settings sliders. The decorative folder icon beside the Album heading and the expand-all folder action are removed. Individual folder expansion, collapse-all and current-path expansion remain available.

APK: `android/build/lakomics-mobile-0.6.5-release.apk`, SHA-256 `eddedb3266781d6dfed7ad46fd3774dccae9e1d099732124207e7e68b357d03e`. The focused App/Albums/Catalog suite passed 71 tests; Settings passed 8 tests after the version bump. Mobile TypeScript/Vite, native release packaging and its regression checks, alignment and existing-signer v2/v3 verification passed. Galaxy Tab S11 (`SM-X730`) accepted an in-place update; package inspection confirmed 0.6.5 (21), preserving the original installation date. Cold startup returned `Status: ok` with the process running. No data reset, server deployment or Git write occurred. These checks confirm build/install/startup, not visual or touch acceptance of the revised controls.

## 0.6.4 — portrait controls and delivery (2026-09-20)

- Catalog has one top-bar settings entry with multi-category inclusion and exact `namespace:value` avoidance tags. Preferences are device-local and endpoint-scoped; they do not overwrite PC policy. Mobile search accepts space/underscore tag aliases while retaining advanced query grammar.
- Library starts at All with no Recent saved sidebar entry. Folder controls and Album appearance follow PC conventions. Global Settings collapses connection editing when configured while retaining security, cache and picker recovery. Collection cards reserve two title lines and one credit line; full text remains in details. Viewer removes its redundant information heading.
- Final server verification passed **71 tests** in an isolated stage using the existing production venv and live dependencies, without loading production configuration or data. Only `mobile_catalog.py`, `mobile_catalog_query.py` and `mobile_catalog_replica.py` were deployed. Source rollback copies and a consistent main-database backup (`quick_check=ok`) are retained at `/home/linuxuser/lakomics-catalog-release-20260920/rollback-064`. No catalog refresh, backfill, dimensions rollout or replacement of `app.py` was performed.
- Authenticated live HTTPS checks passed for capability version 1, legacy browsing and pre-deployment cursors/contexts, empty and multiple category selection, avoidance-filter requests, counts, pagination, detail and editions. A real artist search returned identical results with spaces and underscores. Unauthenticated access returned 401 and an excluded-category detail returned 404. Publication `ba0e4c2bc7558bee67db0b386a0cfc90108ea5437c39e83510124e76629a1795`, its policy revision and publication count remained unchanged. API and existing local proxy finished active/running with `NRestarts=0`. Representative filtered pages took about 2.0–2.2 seconds and a count about 1.0 second; these are bounded server-path observations, not a load benchmark.
- Artifact: `android/build/lakomics-mobile-0.6.4-release.apk`, 1,246,628 bytes, SHA-256 `79619ce24f82f6fceca652b96f9402a7720d507d3117ef617a0aeccc4fc53279`. Mobile TypeScript/Vite and native release packaging passed; APK alignment and v2/v3 signatures were verified with the existing signer.
- Galaxy Tab S11 (`SM-X730`) accepted `adb install -r`; package inspection confirmed 0.6.4 (20), retaining the original installation date without uninstall/data reset. `am start -W` returned `Status: ok` and the app process remained alive. The tablet was subsequently displaying another app, so portrait rendering, real touch interaction and authenticated device browsing are **not** accepted by this startup check. Those checks remain separate from the passing browser fixtures and live API canaries. No Git commit/push was performed.

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

Use `-CompileOnly` for native compilation and offline network-policy, document-tree, disk-cache, media-transfer and Picker snapshot checks without requiring frontend assets. The same step compiles and runs the Album and Classification replica/write checks (`AlbumReplicaTest`, `AlbumReplicaScheduleTest`, `ClassificationReplicaTest`, `ClassificationAssignmentTest`); their source set is derived from the tree as "replica sources importing neither the Android runtime nor `org.json`", so adding a new replica class does not require editing a hand-maintained list. Every external command's actual failure exit code is preserved. Full build packages assets and DEX, aligns the APK, signs it, verifies the signature, and prints SHA-256. Output: `android/build/lakomics-mobile-debug.apk`. `assets/` and `build/` are ignored. The debug signing key is generated once at `android/build/debug.keystore` and retained by subsequent builds; preserve that local key for in-place APK updates. Do not commit it. This is a personal debug-signed distribution, not a Play Store/release signing workflow; timestamps and first-time key generation mean builds are not byte-identical.

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
- `api {path,method?,body?}` accepts only GET library classifications/assets/revisit/date/creator-assets, GET pending-capture list/download, and POST asset media-ticket/batched media-tickets. POSTs issue read tickets only. No ingest, delete, registration, metadata backup, or replication endpoint is exposed. Classification *writes* are never reachable through `api`: they travel through the dedicated `classificationAssignmentSet` operation, which sends one internally-constructed `setAssetClassification` command and accepts no caller-supplied path or payload.
- `classificationAssignmentState {assetId}` returns one Asset's visible Classification assignment (`classificationId`, `pending`, `blocked`, `conflictCode`/`conflictMessage`) plus the complete live Classification hierarchy from the durable replica, so the picker opens and can queue an edit with no network at all. `classificationAssignmentSet {assetId,classificationId}` sets that assignment (`null` = unassigned) and returns the same state; the durable enqueue completes before it replies. Structural Classification commands (create/rename/move/appearance/delete), their activation route and the publisher credential are not exposed by any bridge operation.
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
