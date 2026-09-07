# Lakomics Mobile product direction

Status: current product direction with retained rollout history

Current-status clarification (2026-09-07): the initial full-library backfill, Galaxy Tab browser browsing milestone, and queued-work pause/wait/restart/resume acceptance are complete. `CLOUD-006` is `DONE` in the living backlog. Do not reseed or rerun the completed backfill without a separately approved recovery operation.

The checkpoint below records the browser prototype, not a completed native Android client. Current production-client scope follows [the approved consumption UX](mobile-consumption-ux.md) and [the living backlog](../roadmap/lakomics-backlog.md). Older rollout proposals below, including a later `display.webp` derivative, are not authorization to implement them; measure the current original/thumbnail path before considering another derivative.

## Current implementation checkpoint (2026-09-03)

- Phase 1 full-library cloud replication is complete and production-verified. The PC remains authoritative; VPS/R2 serve the read-oriented replica.
- The Galaxy Tab browser prototype now provides production cloud classification browsing, Recent, Home/Revisit, grouped creator rails, date/creator detail grids, image/video viewing, metadata, cursor pagination, and short-lived media-ticket access.
- Alpha 15.54 passed the Galaxy Tab S11 device gate in portrait/landscape use after the final Home/detail stabilization pass.
- The temporary device-gate preview host is not part of the production architecture; canonical web access is `https://lacucaracha421.github.io/chatgpt/`.
- Mobile feature polish is intentionally paused at this checkpoint. The next major Mobile milestones remain Phase 3 native Android shell and Phase 4 `DocumentsProvider`, not more browser-only Home features.
- The browser prototype still uses the extension runtime for authenticated Cloud API mediation, so the long-term direct/native client boundary described below remains future work.

This document defines the intended role, scope, UX, and implementation order for Lakomics Mobile. It is a durable product reference, not a second backlog. Concrete implementation work remains tracked in `docs/roadmap/lakomics-backlog.md`, especially the full-library cloud replication work under `CLOUD-006`.

## Product definition

Lakomics Mobile is a Galaxy Tab-first companion for **viewing and selecting** the Lakomics library.

Its primary purpose is not to reproduce every desktop management feature. The desktop app remains the main place for bulk import, classification editing, metadata maintenance, and heavy library management. Mobile should make the already-organized library pleasant to browse and easy to reuse elsewhere.

The target experience is:

> Browse the complete Lakomics library on the Galaxy Tab using the existing classification hierarchy, enjoy media in a viewer designed for consumption, and select Lakomics images/videos directly from Android file pickers when uploading to websites or other apps.

## V1 success criteria

Lakomics Mobile v1 is successful when all three are true:

1. **The complete PC Lakomics library is available on the Galaxy Tab without requiring the PC to be online.**
2. **The existing Lakomics classification hierarchy is the primary browsing structure and is fast enough for normal daily use.**
3. **Android file attachment flows can choose Lakomics as a document source, browse the same classification hierarchy, and select one or multiple images/videos for upload.**

These three criteria take priority over collections, showcase work, advanced editing, or phone support.

## Target device and layout

- Primary and initially exclusive target: **Galaxy Tab S11**.
- Both portrait and landscape are first-class layouts.
- Phone layouts are intentionally out of scope for v1.
- Landscape may keep a persistent classification sidebar.
- Portrait should use a drawer/sheet for the same hierarchy rather than flattening or replacing it.
- The product should not sacrifice the tablet experience merely to make a narrow phone layout work.

## Responsibility split

### Desktop Lakomics

Desktop remains the management workstation.

Primary responsibilities:
- bulk import and ingestion
- classification creation/rename/move
- classification assignment and reorganization
- metadata maintenance
- large-scale library operations
- cloud replication/backfill administration
- destructive recovery/diagnostics when necessary

### Lakomics Mobile

Mobile is primarily a consumption client.

V1 responsibilities:
- home/revisit experience
- classification-based browsing
- image viewing
- video playback
- optional metadata inspection
- Android file-picker selection
- deletion with library-wide semantics

V1 does **not** need classification/tag editing or bulk organization features.

### Browser extension relationship

The browser collector remains a separate runtime, but extension distribution and maintenance may live inside the same installed Lakomics Mobile APK as a convenience surface.

- X/general web collection continues to be handled by the browser extension.
- Mobile library browsing must never require the extension or Titanium to be installed or running.
- The Lakomics Mobile APK may include an Extension Manager for version checks, signed-package download/update, opening Titanium, and install/recovery guidance.
- This shared APK packaging does not merge runtimes: Mobile talks directly to the Cloud API, while the browser extension keeps its own browser lifecycle.
- Do not assume an external APK can call Chromium's internal Load Unpacked API or silently install an extension. User confirmation may still be required.
- Preferred production distribution experiment: a fixed-ID, consistently signed CRX. Adopt it only after install/update identity and reboot persistence are verified on the Galaxy Tab + Titanium. Keep unpacked SAF loading as a development/fallback path until that gate passes.

Target relationship:

```text
Desktop Lakomics ---------+
                         |
Lakomics Cloud API -------+---- Lakomics Mobile library
                         +---- Browser collector extension

Lakomics Mobile APK
  +-- Mobile library (direct Cloud API)
  +-- Android integration
  +-- Extension Manager -> signed CRX / Titanium handoff
```

## Cloud library direction

The long-term mobile library is the **replicated canonical Lakomics library**, not the Cloud Capture inbox.

Cloud Capture is transport/history for remote collection. Once an item belongs to the Lakomics library, mobile browsing should use replicated asset/library records and classification relationships.

### Required cloud state

Mobile must eventually be able to read, without the PC:

- stable asset identity
- media type / MIME type
- classification identity
- source/provenance metadata that Lakomics already preserves
- stored timestamps
- dimensions/duration where applicable
- media object location or signed access route
- thumbnail/preview variants
- deletion/tombstone state

### Media storage

Full-library media should be available from cloud object storage such as R2.

PC uptime must not be part of the normal mobile viewing path.

An online connection is acceptable for v1. Offline library caching is not required. If the server cannot be reached, Mobile may show a clear connection failure instead of maintaining a full offline replica.

## Classification model

The current classification hierarchy remains the main navigation model.

For normal assets, treat classification as effectively single-valued unless the desktop model changes. Albums are a separate concept and may provide N:N membership independently.

Do not flatten the hierarchy into a generic recent-photo picker. The organization itself is part of the product value.

Example:

```text
게임
└─ 명조
   ├─ 카멜리아
   ├─ 장리
   └─ ...
```

## Home experience

Because the first priority is viewing rather than management, Mobile should have a real home screen instead of opening directly into a settings or administration view.

Initial home modules should favor consumption:

- **Continue / 이어보기**: resume the last browsing/viewer context.
- **Revisit / 다시보기**: surface previously viewed or older library items using the existing Lakomics revisit concept.
- **Recent saves**: recently added library media.
- **Recent classifications**: quickly reopen classifications visited recently.
- **Random discovery**: lightweight rediscovery of older media if it can be implemented without making the home screen noisy.

Collections/showcase content may appear later, but it is not a v1 dependency.

## Library browsing UX

### Landscape

Preferred baseline:

```text
┌────────────────┬──────────────────────────────┐
│ classification │ selected path / asset count  │
│ tree           │                              │
│                │  ■ ■ ■ ■ ■                   │
│                │  ■ ■ ■ ■ ■                   │
│                │  ■ ■ ■ ■ ■                   │
└────────────────┴──────────────────────────────┘
```

### Portrait

Preferred baseline:

```text
[☰] 게임 > 명조 > 카멜리아       482

■ ■ ■ ■
■ ■ ■ ■
■ ■ ■ ■
```

The classification tree should open as a drawer/sheet and preserve the same selection/expanded state.

### Grid requirements

- smooth scrolling with 10,000+ total-library scale in mind
- pagination/virtualization rather than loading the whole library DOM
- dedicated thumbnail/preview media rather than decoding full-resolution originals for grid cells
- stable scroll position when returning from the viewer
- clear loading/error state without flashing the entire view away unnecessarily

## Media viewer

The viewer should prioritize the media itself.

Default presentation:
- minimal chrome
- swipe/navigation between assets
- pinch/zoom or equivalent image inspection
- normal video playback controls
- current position within the active result set

Metadata should be available on demand rather than permanently occupying media space.

Useful inspectable metadata includes:
- classification path
- source author/handle where available
- source URL
- saved/imported date
- dimensions/duration
- media/file type

## Android file-picker integration

A native Android layer is justified primarily by file-provider integration.

Lakomics should implement an Android `DocumentsProvider`-style source so applications and websites that invoke the Android document/file picker can browse Lakomics directly.

Desired flow:

```text
Website or app
  → Attach file
  → Android file picker
  → Lakomics
  → classification hierarchy
  → image/video grid
  → select one or multiple items
  → attach
```

Requirements:
- preserve the Lakomics classification hierarchy
- support multiple selection where the requesting picker allows it
- support images and videos
- expose correct MIME types and basic document metadata
- stream/download the selected cloud object through a `content://` URI without first requiring the user to save it manually into Downloads
- keep picker browsing independent from the browser extension

Do **not** make cloud-photo aggregation into Android's generic recent-photo feed a product goal. That would weaken the classification-first experience and is not required for v1.

## Deletion semantics

Mobile may expose deletion even though most editing remains desktop-only.

User-facing meaning:

> Deleting an asset from Mobile removes it from the Lakomics library everywhere.

The implementation should still protect against accidental irreversible loss:

1. mark the canonical asset deleted/tombstoned
2. hide it from all normal clients promptly
3. propagate deletion to the desktop library
4. retain a recovery window / quarantine where practical
5. purge cloud objects only after the deletion policy allows it

Do not make a transient sync failure capable of silently destroying the only remaining copy.

## Authentication

A full multi-user account system is unnecessary for the initial personal-use client.

V1 may use one-time device registration:
- server/API endpoint
- device token
- token stored using Android secure storage / Keystore-backed facilities
- reconnect/revoke flow can be added from desktop settings later

If device pairing is improved later, QR-based enrollment is a natural extension but is not a v1 requirement.

## Image representation and WebP direction

Long-term, Lakomics should be able to generate efficient WebP representations for the library.

Do not begin by destructively replacing every original file.

Preferred migration model:

```text
asset
├─ original            # retained initially
├─ display.webp        # viewer-friendly representation
└─ thumb.webp          # grid/file-picker thumbnail
```

Benefits:
- fast mobile grids
- lower bandwidth
- predictable viewer decoding
- easier later migration of legacy assets

Recommended order:
1. generate thumbnails/previews for mobile/cloud use
2. automatically generate WebP variants for new imports
3. backfill existing assets in resumable batches
4. verify quality/compatibility
5. only then consider an explicit policy for removing or replacing originals

The file picker may eventually prefer a compatible efficient representation while retaining access to the original where needed.

## Technical client direction

Recommended direction, not yet a hard architecture lock:

- React + TypeScript for the main Mobile UI
- reuse/replace the current `mobile/` prototype incrementally rather than rewriting the experience twice
- Android application shell around the web UI
- a small Kotlin/native layer for Android-specific capabilities such as `DocumentsProvider`, secure token storage, lifecycle/back behavior, and sharing/file streams
- Capacitor is a reasonable wrapper candidate; Tauri Mobile can be revisited if its native/file integration becomes preferable

The Android shell should stay thin. Product UI and cloud contracts should not be duplicated in a separate native UI unless there is a demonstrated need.

## Relationship to the existing mobile prototype

The current `mobile/index.html` and extension-injected `mobile-bridge.js` / `mobile-assets.js` are useful prototypes and should inform the migration.

They are not the desired final dependency structure.

Current prototype behavior demonstrates:
- tablet-oriented responsive layout
- classification tree interaction
- live classification injection
- Cloud Capture asset rendering
- image/video viewer paths

Migration goal:
- Mobile calls the Cloud Library API directly
- the extension no longer has to inject classification/assets into the Mobile runtime
- Cloud Capture-specific views are replaced by full-library queries after `CLOUD-006` is correct

## Collections and showcase

Collections (games/manga/anime/movies) and richer showcase behavior are explicitly later work.

They should not block v1.

When added, their mobile purpose should stay consumption-oriented: revisit favorites, browse covers/artwork, resume previously viewed works, and surface meaningful personal library history rather than recreating desktop management screens.

## Implementation phases

### Phase 0 — freeze product scope and audit the prototype

- Treat this document as the Mobile product boundary.
- Audit `mobile/index.html`, `mobile-bridge.js`, and `mobile-assets.js`.
- Identify prototype UI that can be retained and demo-only code that should be removed.
- Define the direct Cloud API boundary before adding more extension-to-page bridge behavior.

Exit condition:
- clear retained/replaced component list
- no new mobile work depends on extending the temporary extension injection architecture

### Phase 1 — full-library cloud foundation

**Retained initial-rollout design, not a current execution checklist.** The initial backfill has been completed. The original choices and Phase 1A–1E sequence remain below to preserve their rationale and acceptance design; they do not instruct an agent to repeat preflight, seed the queue, or run another full backfill. Current remaining acceptance/status work is in `CLOUD-006` / `CLOUD-UI-001` in the backlog.

This corresponds primarily to `CLOUD-006` and related cloud/performance backlog work.

Confirmed rollout choices:
- The PC library remains authoritative; the VPS database and R2 objects are a rebuildable read-oriented replica.
- Run the initial full-library backfill at maximum practical throughput overnight while keeping concurrency bounded.
- Expose each asset to Mobile immediately after that asset's required objects and metadata are committed; do not wait for the whole backfill.
- Replicate `original + thumbnail` during the initial pass. Generate `display.webp` later as non-blocking background work.
- Do not replicate the complete PC SQLite database. Publish only the asset, classification, provenance, media, and sync state required by Mobile.
- Do not enable destructive cloud deletion during the initial backfill rollout.

#### Phase 1A — read-only preflight

Before enqueuing work, calculate and show:
- normal asset count and total original bytes
- counts by image / GIF / video
- existing and missing thumbnail counts
- missing originals
- local DB size versus file-size mismatches
- stored SHA-256 versus actual-file mismatches where verification is required
- unclassified asset count

Preflight must not mutate the library. Valid assets may proceed even when a small number of assets require repair; report those assets separately instead of blocking the full backfill.

#### Phase 1B — cloud asset model and upload contract

Extend the existing cloud asset storage rather than creating a second unrelated library.

Store:
- stable PC asset ID
- media kind, MIME type, original name, byte size, dimensions, and duration where applicable
- collected/source timestamps and existing provenance fields needed by Mobile
- current sync revision and ready/uploading/deleted state
- classification relationships
- object variants for `original`, `thumbnail`, and later `display`
- per-variant object key, MIME type, byte size, SHA-256, and ready timestamp

Keep object keys path-independent and stable:

```text
images/{asset_id}/original
images/{asset_id}/thumb.webp
videos/{asset_id}/original
videos/{asset_id}/thumb.webp
```

Use a two-step, idempotent server contract:

1. `prepare`: receive asset/revision/variant metadata, inspect already-present objects, and return signed PUT details only for missing variants.
2. upload: the desktop PUTs directly to R2 using server-issued signed URLs; R2 credentials never leave the VPS.
3. `commit`: the server verifies required objects, then atomically upserts asset metadata and classification relationships and marks the asset ready.

A Mobile list query must return only committed ready assets. A retry after upload but before commit must detect and reuse already-uploaded objects instead of transferring them again.

#### Phase 1C — resumable desktop backfill worker

Build on the existing outbound `cloud_sync_queue`; keep it separate from inbound Cloud Capture state.

Backfill behavior:
- publish the classification snapshot before processing assets
- enqueue every normal asset using its stable asset ID and latest revision
- process recently collected assets first so the partial Mobile library is useful quickly
- upload existing Lakomics WebP thumbnails when valid
- generate missing thumbnails through the normal local thumbnail path
- use prepared video poster thumbnails for videos
- validate the original against stored size/type/hash before upload
- use bounded concurrent transfers, starting at four and adjusting only from measured behavior
- keep Windows awake only while an active overnight backfill is running
- continue while the app is minimized; release the keep-awake request when paused or complete

Queue/retry behavior:
- recover interrupted `processing` rows to `pending` on reopen
- retry timeouts, connection failures, HTTP 429, and HTTP 5xx with bounded exponential backoff
- fail permanent authentication, validation, unsupported-media, and changed-source errors explicitly
- isolate failures so one asset never blocks later assets
- allow pause-after-current-item, resume, and failed-only retry
- coalesce newer revisions so stale metadata is not published after a later local change

Suggested retry delays: 5 seconds, 15 seconds, 1 minute, 5 minutes, then 15 minutes.

#### Phase 1D — progressive cloud read API

Provide at least:
- library replication/status summary
- classification tree
- cursor-paginated ready assets, filterable by classification
- asset detail
- short-lived signed media tickets for thumbnail/original variants

Use a stable cursor such as `(collected_at, asset_id)` so new commits during backfill do not cause duplicates or gaps in an existing traversal. Do not expose R2 credentials or permanent public object URLs.

The Mobile prototype may begin reading this API as soon as the first committed batch exists. Cloud Capture inbox rows remain transport history and must not masquerade as the replicated library.

#### Phase 1E — operations and staged rollout

Desktop Settings should show:
- local total count/bytes
- ready, pending, processing, failed, and remaining counts
- uploaded bytes, current throughput, and estimated remaining time
- last success/failure
- start, pause, resume, retry-failed, and reconcile actions

Roll out in this order:
1. one real image with original and thumbnail
2. one real video with poster thumbnail
3. a mixed batch of roughly 20 assets
4. one real classification containing roughly 100–500 assets
5. forced app exit and network interruption/recovery tests
6. PC-off Galaxy Tab browse/open/play verification
7. full overnight backfill
8. count/size reconciliation and representative hash/size spot checks
9. one new asset and one classification change through incremental sync

Do not add cross-asset object deduplication to the first rollout. Stable per-asset object keys keep deletion and recovery understandable, and the local library already handles exact-duplicate ingestion.

Exit condition:
- with the PC off, a client can query real classifications and browse every successfully replicated asset from cloud services while the backfill is still progressing
- after completion, local/server counts reconcile, representative image/video objects validate, interrupted work resumes without duplicate rows or unnecessary re-upload, and new local assets continue through incremental sync

### Phase 2 — Mobile viewing client

**Scope note:** the browser prototype already has live Cloud Library browsing and Home/Revisit via the extension worker. The list below preserves the client direction; direct/native transport and the approved native consumption UX remain future work rather than reasons to rebuild completed browser features.

Replace demo/bridge-dependent data with direct cloud-library data.

Implement:
- home
- Continue / Revisit
- recent saves
- recent classifications
- responsive classification browser
- virtualized/paginated asset grid
- image viewer
- video viewer
- metadata sheet
- viewer/list position restoration

Exit condition:
- v1 success criteria 1 and 2 are met on Galaxy Tab S11 in both portrait and landscape

### Phase 3 — Android application shell

Package the Mobile UI as a real Android application.

Implement:
- app lifecycle/back handling
- secure token storage
- external URL handling
- sharing/file stream primitives
- stable APK installation/update workflow for personal use
- integrated Extension Manager utility for checking/distributing the Lakomics browser extension without making Mobile depend on the extension runtime
- fixed-ID signed-CRX install/update experiment with Titanium, gated by real Galaxy Tab reboot-persistence verification
- unpacked SAF loading retained as a development/fallback path until the signed-CRX gate passes

Exit condition:
- Mobile is usable as a standalone installed app with no browser extension runtime dependency

### Phase 4 — Android DocumentsProvider

Implement the Lakomics document source.

Test at minimum:
- browser `<input type="file">` flows
- websites that allow multiple attachments
- image attachments
- video attachments
- a representative messaging/community app if it uses the standard Android picker

Exit condition:
- v1 success criterion 3 is met

### Phase 5 — global deletion

Implement Mobile deletion using the canonical tombstone/recovery policy.

Exit condition:
- deletion initiated on Mobile disappears across normal clients and safely propagates through PC/cloud storage without bypassing recovery safeguards

### Phase 6 — consumption enhancements

Candidates:
- richer Revisit
- random rediscovery
- favorites
- slideshow
- collection/showcase consumption views
- better source/author navigation

These are post-v1 unless they are nearly free while building earlier phases.

### Phase 7 — WebP library migration

Implement resumable media representation migration after the cloud/mobile correctness path is stable.

Exit condition:
- new assets generate efficient variants automatically
- existing assets can be backfilled safely
- any original-file removal policy is explicit, reversible where practical, and separately approved

## Explicit non-goals for v1

- phone-first or universal small-screen design
- full desktop feature parity
- classification/tag editing on Mobile
- offline full-library replica
- merging Lakomics media into Android's generic recent photo feed
- making the X Collector extension part of the Mobile runtime
- requiring Collections/Showcase before the core asset library is useful
- destructive original-to-WebP conversion before migration quality is proven

## Decision summary

- Primary use: **viewing/consumption**.
- Target: **Galaxy Tab S11, portrait + landscape**.
- Long-term library scope: **all Lakomics assets**, not only Cloud Capture.
- PC availability: **not required for normal Mobile use** after cloud replication.
- Offline support: **not required for v1**.
- Primary navigation: **existing classification hierarchy**.
- Editing: **view/select only**, except global delete.
- Asset classification: **single classification in current model; albums separate**.
- File picker: **Lakomics as a classification-preserving Android document source**.
- Multi-select: **required**.
- Media types: **images and videos**.
- Metadata: **available on demand, media remains visually primary**.
- Home: **yes, consumption-oriented with Continue/Revisit**.
- Collections/Showcase: **later**.
- Authentication: **one-time device registration/token**.
- Extension relationship: **separate runtime, shared services where useful; distribution/maintenance may live in the same Mobile APK through an independent Extension Manager**.
- Long-term media optimization: **WebP variants and later controlled migration**.

## Native APK implementation plan — 2026-09-07

User delegated design and implementation overnight. This section owns the current implementation plan; the living backlog remains the only product task tracker. Existing edits above are preserved. Start HEAD: b83e8ccbcf20017b06c064d6f10c73dc45aab10a.

Goal: build an installable independent Galaxy Tab consumption APK, with direct authenticated cloud browsing and a read-only Android document source. Preserve the browser prototype and CloudMediaProvider PoC.

Architecture decision for this first build: reuse installed React/TypeScript/Vite and bundled fonts from app; isolate the new entry at app/mobile-client and native source at android. A small platform Java WebView shell uses the available Android SDK/JDK without adding Capacitor/Gradle/Kotlin dependencies. Java serves the proposed small native-layer responsibility; it does not introduce a second product UI. Capacitor adds a plugin/dependency chain and Tauri Mobile adds a separate Rust/mobile toolchain; neither is needed for this bounded platform shell.

Design: dark neutral surfaces, ivory rectangular active states, small square markers, SUIT/Barlow/Rajdhani fonts, 44px touch actions, minimal separators. Portrait Home/Library bottom navigation; landscape contextual classification index. Recent dominates Home; Continue and Revisit remain secondary. Settings and connection live in one modal surface. Full-aspect justified rows, three row-height densities, contained progressive image/video viewer with pinch-only image pan and explicit adjacent actions. Pending Captures remain a separate labelled preview section and never count as Assets. No copied NieR artwork or HUD.

Bridge contract: window.LakomicsNative.request(id, operation, JSON.stringify(payload)); cancel(id). Native dispatches CustomEvent('lakomics-native', {detail:{id,ok,data,error}}). Operations: status -> {configured,endpoint}; configure {endpoint,token,allowPrivateHttp} -> status; disconnect -> status; api {path,method?,body?} -> server JSON; openExternal {url}. Native emits lakomics-resume and lakomics-back; frontend calls finish operation only when no overlay/back context remains. API paths are native allowlisted for read-only library/classification/revisit, media-ticket POST, pending list/download; no ingest/delete/writeback routes. Credentials are encrypted under Android Keystore, excluded from backup, never returned to JS or logged. Plain HTTP requires explicit connection-screen opt-in and numeric private-network address. No redirects carrying Authorization. WebView loads bundled content only from https://app.lakomics.local/; external pages cannot use the bridge.

- [x] Native foundation: android/AndroidManifest.xml, native Activity, secure settings, bounded authenticated HTTP client, read-only DocumentsProvider, build.ps1, README. Build takes -SdkRoot; outputs ignored debug APK and retains its debug key for update identity. No device install or production changes in this task.
- [x] Mobile client: app/mobile-client entry, bridge client, typed server contracts, page/state controller, gallery geometry, shared controls, navigation/settings/viewer. Vite config and separate TypeScript/test configuration reuse installed packages. Keep secrets out of localStorage. Demo data is accessible only in development browser and clearly labelled.
- [x] Loading correctness: cancel or ignore superseded requests; preserve old grid until replacement page commits; restore viewer/grid and density; refresh on native/browser foreground without blanking. Metadata-only pagination remains bounded; mounted rows are virtualized. Server currently returns null dimensions; resolve thumbnail dimensions before committing page geometry, with a stable neutral fallback on failure and bounded thumbnail concurrency.
- [x] Media: memory-only expiring/deduplicated tickets; thumbnail remains through original decode/failure; only immediately adjacent image originals preload; videos never preload as neighbours. Pending previews use download tickets, remain separate, and disappear on refreshed pending-list absence after desktop processing. No fabricated identity mapping or desktop duplicate decisions.
- [x] Verification and review: targeted geometry/request-state/media tests, separate TypeScript check, mobile Vite bundle, native compile/signature verification, browser portrait/landscape interaction and screenshot checks, independent scoped code review. Record native/device acceptance separately as unverified if no authorized isolated runtime is available. Never install onto sleeping user's tablet or change its existing provider configuration.

Scope boundaries: no Git writes, production deployment/data writes, full backfill, automatic deletion, CloudMediaProvider replacement, or silent CRX installation. Extension Manager is optional and remains deferred until signed-CRX distribution contract exists. DocumentsProvider and normal Photo Picker integration are distinct. Critical unresolved credential/data safety failures stop affected work; routine build/implementation failures are repaired locally.

### Build and review checkpoint

2026-09-07: `npm --prefix app run mobile:test` passed 25 client tests; `npm --prefix app run mobile:build` completed its TypeScript check and production bundle with exit 0. `android/build.ps1 -SdkRoot C:\LakomicsCloudMediaPoC\sdk` passed 38 network-policy and 19 document-tree checks, compiled/packaged the app and verified v2/v3 signatures, exit 0. Artifact: `android/build/lakomics-mobile-debug.apk`, 1,119,652 bytes, SHA-256 `211750C636B9FEEA2006FE1E046EA88750496EE07DB2C3FA391F1931AC62A720`. APK metadata identifies `com.lakomics.mobile` version 0.1.0 (1), min SDK 26 / target 35, one Internet permission and the document provider. Production JS excludes the development fixture module; bundled fonts include OFL notices.

Independent native and frontend reviews found and then accepted fixes for page-tree grant boundaries, cancel-before-lock connection changes, WebView rotation retention, Continue provenance, retained-gallery request races, pinch pan bounds, shared classification expansion, and Library/native-back context restoration. Browser fixture checks covered 800x1280 portrait, 1280x800 landscape and 800x600 short height: classification navigation/drawer state, density persistence, cursor next page, image viewer/next/resize, no horizontal document overflow, and no new warning/error logs after a fresh final-code reload. These are browser/fixture outcomes, not real media or Android acceptance.

The APK is an installable read-only preview. Device installation/authentication, real cloud image/video consumption, SAF recipients/grants, multi-select/cancellation and cold/warm timing remain unverified. Android Share quick-save, temporary capture storage and optional signed-CRX management remain pending. No production deployment/data writes, device changes, Git mutations or modifications to the prior browser site/extension/PoC were performed. Use `android/README.md` for build and first-use instructions. MOBILE-001/002/004 remain PARTIAL in the living backlog.

### 2026-09-07 unified APK 0.2.0 checkpoint

User delegated integration of the prior Pick role, faster/reliable media access and a richer classification-based Home while disconnecting the Galaxy Tab. This supersedes the first-build exclusion of integrated CloudMediaProvider; device configuration and production/Git writes were not performed.

The main APK now contains `com.lakomics.mobile.documents` and API33+ `com.lakomics.mobile.cloud`. Breadcrumb classifications become flat Photo Picker albums backed by a complete background metadata replica, stable IDs/generations and deletion tombstones. Queries use the last completed replica; interrupted refreshes do not publish a partial library. Existing read APIs suffice. The old PoC package, private manual albums and selected device provider remain untouched; eligibility/selection transition needs the tablet and native acceptance.

One 1 GiB media cache serves thumbnails, viewed image originals up to 32 MiB, and selected files up to 512 MiB. Video viewing streams signed URLs directly. Transfers run outside the document metadata lock, deduplicate per file, verify complete lengths, reject stale commits and retry transient failures once with a fresh ticket. Control and file workers are separated. Viewer originals cancel on exit, speculative preload is limited to one known-small image, and video retry preserves position.

Home retains the compact Recent start without Continue, then adds visited classifications, daily covers across top-level classifications, and image-led date/creator Revisit groups. Cover metadata requests are bounded independently of first paint. Settings exposes combined cache clear/usage and integrated Picker readiness/refresh/system settings.

Verification: 40 frontend tests; TypeScript/Vite; SDK35 compilation; 38 network, 19 ancestry, 18 cache and 22 transfer checks plus PickerSnapshot tests; APK asset/signature verification all passed. Browser fixtures were checked in landscape, portrait and narrow phone widths. Independent read-only native review identified a provider permission mismatch and truncated-download retry mismatch; both were corrected before final build. APK: `android/build/lakomics-mobile-debug.apk` v0.2.0 (6), SHA-256 `908233AFA68A86BBD246A3040F2FC53448C3ACB81F0445F402F12B9A3FF94C89`.

Actual provider eligibility, receiving-app attachment, process-restart warm reuse, large-library memory and real latency remain unverified without the device. This task made no server changes/deployment, old PoC edits, installation/provider switch, production data write or Git mutation. Current behavior and the prepared transition procedure are in `android/README.md`. Earlier task WIP is preserved.


### 2026-09-07 Collections deployment and icon checkpoint

Explicit user approval authorized deployment of the Collection API and first Collection publication. The deployed `app.py` and new `mobile_collections.py` matched local SHA-256 (`9b67615b0775c7dd9910c7231465de02adf1830f1beac884607732a601fd2493`, `39ea3a6783dbb8c5b00adeedfd2e3d278f0eb239def874d8b536366f0fc2763f`). Backup: `/home/linuxuser/lakomics-api/backups/collections-20260907T050947Z` contains prior application code and an online SQLite backup with `quick_check=ok`. Restart succeeded; health and authenticated unpublished-list response passed, missing auth returned 401, service active/running with NRestarts=0.

The publisher has an explicit ignored operational entry point that opens `library.sqlite` READ_ONLY, without Library startup migrations/background work. Real-source extraction exposed an overbroad data-version rejection: the existing read transaction already fixes the metadata view, so unrelated concurrent PC writes no longer cancel it; image bytes are still hash-checked before PUT. Actual signed upload exposed duplicate Content-Type headers from ureq's append semantics; the publisher now sends the signed header exactly once. Artwork PUTs are bounded to four workers and complete before the metadata commit. A targeted fixture verified that no fifth transfer or metadata publication occurs before pending artwork completes.

Android launcher now copies the existing PC icon PNG byte-for-byte. See `android/README.md` for APK 0.3.1 (8) and hash. Deployment alone does not prove Galaxy Tab rendering, cache behavior or recipient-app attachment.

First publication completed: 340 collections (181 game, 147 manga, 12 movie), 695 WorkArtwork records, 1,384 verified blobs. Revision `235cc17a8a6f637e7908461644b0ed6a9efe7b452bbe89e60bb2682d139a2615`. The last run uploaded 1,288 files and reused previously completed immutable objects. Full list pagination had 340 distinct IDs; representative type-specific details and both thumbnail/original signed downloads matched SHA-256. Service remained active/running with NRestarts=0. Galaxy Tab acceptance is still pending; this proves server publication/media availability, not the installed APK experience.


### Source-folder cover omission repair

The first Collection publication covered managed WorkArtwork only, omitting 261 works whose source images were already inside the active library's configured Collection source root. The publisher now also reads those existing source files using the PC preview selection and volume/edition filename rules. It fills absent cover references and volume slots in the outgoing replica without importing rows or modifying the local library. Existing selected artwork and volume IDs/metadata remain authoritative. Derived 360px WebP previews stage in a temporary directory owned by the snapshot and are deleted after the attempt; originals and thumbnails remain bounded, hash checked and deduplicated. Source paths never enter the API payload, and resolved files outside the configured library are rejected. Seven focused publisher fixtures pass, including source-only covers, editions, stable outgoing IDs, retained volume IDs, thumbnail bounds, no source DB writes and out-of-library rejection.

Source-cover repair completed (2026-09-07): publication revision `3b640e2627ad526d7b3a8764bca87adc6cc4f04796a9373881d5c3910a196898`; 340 works, 2,803 artwork records, 5,588 unique blobs (4,204 uploaded in this repair), 2,332 volume/edition covers. Full comparison with the preceding replica confirmed 261 recovered primary covers, all 79 existing selected covers retained, and every existing volume ID/number/edition/label/release field retained. Every current work and volume has a thumbnail reference. Type pagination had 181 game, 147 manga and 12 movie records with no duplicate IDs; representative original and thumbnail downloads passed SHA-256 checks. Service active/running, NRestarts=0. Galaxy Tab SM-X730 running installed APK 0.3.1 was woken and refreshed: the game grid loaded covers and a previously missing manga (Prison School) displayed its primary cover and ordered 28-volume shelf. No APK rebuild/install was needed. The operation opened the source DB READ_ONLY and wrote previews only to TEMP. Prior replica backup: `/home/linuxuser/lakomics-api/backups/collections-before-source-20260907T053812Z.json`. An interrupted preparation attempt left its TEMP preview directory; manual cleanup was blocked by automatic approval policy, and no workaround deletion was attempted. The successful attempt retained normal TempDir lifecycle cleanup.
