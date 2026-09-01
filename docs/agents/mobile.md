# Lakomics Mobile product direction

Status: current product direction

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

### X Collector extension

The extension stays a separate product surface.

- X collection continues to be handled by the browser extension.
- Mobile Lakomics must not require the extension to be installed in order to browse the library.
- The extension and Mobile may share the same Cloud API and replicated library data, but neither should depend directly on the other's runtime.
- A deeper combined workflow can be reconsidered later.

Target relationship:

```text
                    ┌─ Desktop Lakomics
                    │
Lakomics Cloud API ─┼─ Lakomics Mobile
                    │
                    └─ X Collector
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

This corresponds primarily to `CLOUD-006` and related cloud/performance backlog work.

Implement:
- complete asset metadata replication
- classification relationships
- resumable/idempotent initial backfill
- incremental metadata/classification sync
- R2/object availability for the full library
- paginated classification asset queries
- media access/ticket contract
- thumbnail/display variant generation path
- device-token authentication
- tombstone/deletion model

Exit condition:
- with the PC off, a client can query real classifications and browse the complete replicated asset set from cloud services

### Phase 2 — Mobile viewing client

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
- Extension relationship: **separate runtime, shared services where useful**.
- Long-term media optimization: **WebP variants and later controlled migration**.
