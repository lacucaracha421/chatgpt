# Android Photo Picker / CloudMediaProvider PoC — 2026-09-06

Status: **device-validated research record**, not yet an adopted production architecture or backlog replacement.

This document records the Galaxy Tab S11 experiments performed on 2026-09-06, the exact technical conclusions that were proven, the current PoC location, known limitations, and the related product idea for temporary/one-use media capture.

Do not treat this file as authorization to deploy, change the production server, rerun the full cloud backfill, or replace the current Mobile roadmap. Pending implementation work must still be represented in `docs/roadmap/lakomics-backlog.md` after an explicit product decision.

## Follow-up: reboot persistence fixed on the test S11

A subsequent authorized reboot reproduced the fallback to Google Photos. The device's `mediaprovider` DeviceConfig allowlist originally contained only `com.google.android.apps.photos.cloudpicker`.

Adding the Lakomics **authority** did not fix it. AOSP `ConfigStore` / `CloudProviderUtils` and the device logs established that the allowlist matches **package names** (with a compatibility conversion for the existing Google Photos authority). Adding `com.lakomics.cloudpoc` made both providers appear in the normal, non-bypass available-provider list.

Applied configuration (existing Google Photos entry preserved):

```bat
adb shell device_config put mediaprovider allowed_cloud_providers com.google.android.apps.photos.cloudpicker,com.lakomics.cloudpoc
adb shell content call --user 0 --uri content://media/ --method set_cloud_provider --extra cloud_provider:s:com.lakomics.cloudpoc.provider
```

After a full subsequent reboot, without reapplying either command:

- `sys.boot_completed` returned `1`.
- `allowed_cloud_providers` retained both entries above.
- `get_cloud_provider_result` returned `com.lakomics.cloudpoc.provider`.

**PASS: one full reboot retained the custom provider on this S11 after the allowlist correction.** This supersedes the earlier unverified reboot result below. It does not establish survival across future remote DeviceConfig changes, OS updates, or all devices. No global DeviceConfig synchronization was disabled, no root was used, and no media data was changed. Real Lakomics media integration is still pending; the APK remains the test provider.

To restore the original allowlist if explicitly requested:

```bat
adb shell device_config put mediaprovider allowed_cloud_providers com.google.android.apps.photos.cloudpicker
```

Source reference: https://android.googlesource.com/platform/packages/providers/MediaProvider/+/refs/heads/main/src/com/android/providers/media/ConfigStore.java

## Follow-up: real album connection — 2026-09-07

The user selected these existing canonical albums, by ID after read-only lookup:

- `2993f081-e0a8-4d81-947a-2ce9317040bf`: 업로드용, 8 images and 1 video.
- `42f1158d-4b2a-4285-9398-d7f7ce0f9e63`: 임시, displayed as 임시 보관함. Currently empty. The user explicitly chose **no automatic deletion**.

The installed personal-device PoC (version code 9) now uses `CloudAlbumProvider.java`, `AlbumManifest.xml`, `build-albums.ps1`, and `provision-albums.py` in the existing `_tools/lakomics-cloudmedia-poc/app` folder. The earlier generated-image provider source is retained. This is an initial connection, **not live album synchronization**: album membership is a read-only snapshot provisioned from the configured PC SQLite database. Refreshing membership currently requires rerunning the provisioning script and reopening the picker. Existing server APIs replicate classifications, not album membership; automatic album updates still need a separately designed integration. No server deployment, backfill, or canonical-library write was performed.

Media itself comes directly from the existing cloud server using fresh per-asset media tickets. The existing Tailscale API endpoint is used (the tablet route was verified through tun0); object downloads use HTTPS. Connection credentials are provisioned over ADB stdin directly into app-private storage, never embedded in APK/source or written to shared storage. The APK is a personal debug PoC, not a production release. Metadata queries use the provisioned snapshot, thumbnails use the thumbnail variant, and selected originals are fetched on demand. Per-request cancellation and network/size bounds exist. Cache eviction and production-grade concurrent downloading remain future work.

Device evidence:

- All 9 original and thumbnail variants passed authenticated cloud ticket availability checks.
- Photo Picker Collections displayed 업로드용.
- Its image-only view displayed exactly 8 images.
- Selecting an image and confirming fetched a 476,347-byte cloud original on the tablet.
- Video metadata was provisioned, but video selection/playback was not separately device-tested.
- Empty albums with a null cover crashed this device's album cursor wrapper; empty albums are omitted until populated and reprovisioned. No placeholder media was injected.

### Sticky allowlist correction

The earlier ordinary `device_config put` survived reboot but was subsequently overwritten by remote configuration during the album experiment. The S11 supports a targeted sticky override:

```bat
adb shell device_config override mediaprovider allowed_cloud_providers com.google.android.apps.photos.cloudpicker,com.lakomics.cloudpoc
```

`list_local_overrides` confirmed this exact single override, and the active provider was verified as Lakomics afterward. Global DeviceConfig sync was not disabled. A reboot after this final sticky override has not yet been tested. The earlier claim of durable registration based solely on `put` is superseded by this finding.

To remove only this override, if explicitly requested:

```bat
adb shell device_config clear_override mediaprovider allowed_cloud_providers
```

## Automatic album refresh implementation — awaiting deployment

After the user requested automatic updates, local implementation added:

- PC `cloud/albums.rs`: consistent read-only album/membership snapshot, excluding non-normal assets, published in the existing 15-second foreground / 60-second background metadata poll. No full backfill is triggered.
- Authenticated server `PUT /v1/library/album-snapshot`: stores the PC-owned album metadata in one new `album_replica` table, rejects stale and invalid snapshots.
- Authenticated `GET /v1/library/album-media?album_id=...`: returns only requested albums and committed cloud media with thumbnail metadata; ETag changes include both membership changes and newly ready media. Removal does not delete original assets or cloud objects.
- Android `AlbumSync.java` (APK version code 10, installed): refreshes metadata during Photo Picker collection-info queries, at most once per 10 seconds, atomically caches successful responses, and retains previous data on network/API failures. Selected IDs and display aliases remain those in the private connection configuration. Empty albums remain omitted from Photo Picker until populated.

Validation: 69 existing mobile API tests and 3 new album API tests passed; the Rust membership/removal/trash test and existing metadata-cycle failure-isolation test passed; APK compilation/signing/install passed. On the current undeployed server, the new endpoint is unavailable and Android logged that it retained the previous snapshot. The selected two albums were reprovisioned with 10 unique media items after the user added one to 임시.

**Not live yet:** server deployment and running the updated PC application are required. No server mutation/deployment was performed. Read-only SSH inspection confirmed the deployed server file matches the local HEAD baseline (SHA-256 `609fa6aa92af308d447e96a5d68dd21ff8fa96783e8ac76e8d739d1b6fcaa226`). Production scope is the additive album table and two authenticated routes; no media backfill or deletion is needed. End-to-end automatic refresh still needs native acceptance after deployment.

## Automatic refresh deployment / native acceptance — 2026-09-07

The user explicitly approved the server deployment and updated PC runtime. The deployed `app.py` SHA-256 is `7de8fb75a98c4e25be297214d799529844bc77270fb45b296ef5c0df87473ed8`; it matched the transferred local file. Backups: `/home/linuxuser/lakomics-api/app.py.pre-albums-20260907` and `/home/linuxuser/lakomics-api/backups/pre-albums-20260907.sqlite3` (SQLite quick_check: ok). `lakomics-api.service` restarted successfully, active with NRestarts=0.

The existing `npm run tauri -- dev` runtime had already rebuilt and launched the new executable; no direct debug EXE launch or redundant PC restart was needed. At `2026-09-06T15:21:41Z` it automatically published the album snapshot (HTTP 200). No manual snapshot publish or USB reprovisioning was used for this acceptance.

Opening the tablet Photo Picker then logged `Album metadata refreshed: 12`. Read-only comparison of Android's fetched cache against the current canonical library established exact membership parity:

- 업로드용: PC 10 / Android 10.
- 임시 보관함: PC 2 / Android 2.
- Android response contained exactly the two configured album IDs.
- Revision: `36c5000a2cdac64d9eb9e70dd2f450b56ca77d5ac0b88b2c56d99f5e46a3d356`.

This supersedes the earlier pending-deployment/manual-refresh limitation. The PC publishes while its application and cloud sync are enabled (15-second foreground / 60-second background polling); Android refreshes on Photo Picker collection-info requests, including reopening the picker, throttled to at most once per 10 seconds. An already-open grid is not promised to live-update without reopening. The last successful snapshot remains available if the server cannot be reached. Device acceptance covered naturally added real items; removal/trash and failure isolation were checked with isolated tests rather than modifying production memberships for testing. No TTL deletion, full backfill, or original-media deletion was performed.

## Why this investigation happened

The target workflow is not an in-app Lakomics community. It is the normal Android attachment flow used by sites such as DCInside:

```text
Website/app post editor
  -> attach image
  -> Android Photo Picker
  -> find Lakomics media
  -> select image(s)
  -> upload to the website/app
```

The key requirement is that the user must be able to find media through Lakomics organization rather than scrolling through roughly 8,000 images as one flat date-sorted feed.
## Device and environment used

Observed device:

- Galaxy Tab S11, model `SM-X730`
- Android API level reported by `ro.build.version.sdk`: `36`
- Samsung One UI build property reported by `ro.build.version.oneui`: `80500`
- ADB serial used during the test: `R5KL8009PET`

Portable tooling created for the experiment:

- ADB/platform tools: `C:\chatgpt\_tools\lakomics-cloudmedia-poc\platform-tools`
- PoC source/build directory: `C:\chatgpt\_tools\lakomics-cloudmedia-poc\app`
- temporary Android SDK used for compilation: `C:\LakomicsCloudMediaPoC\sdk`

The PoC is intentionally outside normal production source paths. It is test material, not a shipped Android client.

## Initial Photo Picker finding

The Android UI shown by DCInside was the modern Android **Photo Picker**, not the ordinary Storage Access Framework document picker.

That distinction matters:

- `DocumentsProvider` is appropriate when the caller opens the generic Android file/document picker.
- the Photo Picker does not automatically expose arbitrary `DocumentsProvider` apps as first-class photo sources.
- the Photo Picker has a separate cloud media integration based on `CloudMediaProvider`.
## Official-path limitation versus personal-device experiment

Android's public CloudMediaProvider program is not generally open to arbitrary third-party apps. The official eligibility path is currently OEM nomination / platform eligibility.

However, the device's MediaProvider exposes a shell-only provider selection path. On this Galaxy Tab S11, invoking `set_cloud_provider` from ADB caused MediaProvider to call the provider-selection path with `ignoreAllowList=true`.

This distinction is important:

```text
Normal user-facing Settings eligibility  -> restricted / allowlisted
ADB shell force selection                -> allowlist bypass observed on this device
```

Therefore the validated result is suitable for a **personal-use, developer-enabled Lakomics installation**. It is not evidence that an arbitrary Play Store build could appear as a selectable Cloud Media Provider for every user.

Official Android references consulted during the investigation:

- `https://developer.android.com/guide/topics/providers/cloud-media-provider`
- `https://developer.android.com/training/data-storage/shared/photo-picker`

## Baseline provider-selection test

Before installing the Lakomics PoC, the active cloud provider was `null`.

The device configuration exposed Google Photos as the allowed cloud provider:

```text
com.google.android.apps.photos.cloudpicker
```

Google Photos was installed but disabled for user 0. While disabled, MediaProvider reported no available CloudMediaProvider and force-selection failed.
After temporarily enabling Google Photos, the same force-selection request succeeded:

```text
set_cloud_provider_result=true
get_cloud_provider_result=com.google.android.apps.photos.cloudpicker
```

The corresponding log included:

```text
setCloudProviderInternal() auth=com.google.android.apps.photos.cloudpicker, ignoreAllowList=true
All (ignoring allowlist) Available CloudMediaProvider-s: [...]
Completed request to set cloud provider to com.google.android.apps.photos.cloudpicker
```

This proved that the shell path itself works on the S11 before investing in a custom provider.

## Custom Lakomics CloudMediaProvider PoC

A minimal Android package was then created and installed:

```text
package:   com.lakomics.cloudpoc
authority: com.lakomics.cloudpoc.provider
label:     Lakomics Cloud PoC
```

Main source files:

- `C:\chatgpt\_tools\lakomics-cloudmedia-poc\app\AndroidManifest.xml`
- `C:\chatgpt\_tools\lakomics-cloudmedia-poc\app\src\com\lakomics\cloudpoc\LakomicsCloudProvider.java`
- `C:\chatgpt\_tools\lakomics-cloudmedia-poc\app\src\com\lakomics\cloudpoc\MainActivity.java`
The provider subclassed `android.provider.CloudMediaProvider` and implemented the required media collection, media query, deleted-media query, preview-open, and full-media-open methods.

The manifest registered the provider for:

```text
android.content.action.CLOUD_MEDIA_PROVIDER
```

ADB force-selection of the custom authority succeeded even though it was not the configured allowlisted Google Photos authority:

```text
set_cloud_provider_result=true
get_cloud_provider_result=com.lakomics.cloudpoc.provider
```

The critical MediaProvider log was:

```text
setCloudProviderInternal() auth=com.lakomics.cloudpoc.provider, ignoreAllowList=true
All (ignoring allowlist)Available CloudMediaProvider-s:
  [Google Photos, Lakomics Cloud PoC]
Completed request to set cloud provider to com.lakomics.cloudpoc.provider
```

This is the strongest evidence that the custom provider itself can be accepted on this device through the shell force-selection path.

## Remote-media display result

The first PoC returned one generated PNG that did not exist in the user's ordinary local media library. The image visibly contained:

```text
LAKOMICS
CLOUD MEDIA POC
remote image supplied by provider
```
The Android Photo Picker successfully merged that remote item into the normal `사진` grid beside local device media.

Provider synchronization logs showed the custom provider as a REMOTE media source and reported one synced row. This validated the full path from custom provider metadata -> Photo Picker database -> thumbnail/open path -> visible remote image.

The observed conceptual flow is therefore:

```text
Lakomics Android provider
  -> CloudMediaProvider metadata sync
  -> Android Photo Picker
  -> local + Lakomics merged grid
  -> selected cloud item
  -> provider supplies preview/original file descriptor
  -> calling website/app receives read access through Android
```

A production implementation can replace the generated test PNG with Lakomics thumbnail/original data fetched from the existing cloud-library/media-ticket APIs.

## Album / collection experiment

The next question was whether the user could avoid browsing thousands of items by using Lakomics organization.

The PoC was extended to return three synthetic albums through `onQueryAlbums()`:

```text
업로드 후보
게임 - 블루 아카이브
작가 - TEST
```

The labels were only test data. One intermediate source revision contained a typo in the game label; do not reuse PoC strings as production UX copy.

The S11 Photo Picker `컬렉션` tab visibly displayed the Lakomics-supplied albums together with Android/system collections such as Favorites, Camera, Screenshots, and app/device collections.
This proves that Lakomics classifications/manual albums can be projected into the Photo Picker as browseable collection cards.

## Album filtering bug found during the PoC

The first album implementation correctly received:

```text
android.provider.extra.ALBUM_ID=album-upload
```

and returned only the row that belonged to that album. However, the Photo Picker still showed the album as empty and logged:

```text
Unspecified honored args. Expected: [android.provider.extra.ALBUM_ID]. Found: []
Returning 0 album media items for album album-upload
```

The provider had put `ContentResolver.EXTRA_HONORED_ARGS` into cursor extras as a `String[]`. On this Android 16 / S11 implementation, the Photo Picker's validation path read the field with `Bundle.getStringArrayList()`.

Changing the cursor-extra representation to an `ArrayList<String>` fixed the problem.

After the fix, the log became:

```text
onQueryMedia incoming=Bundle[{android.provider.extra.ALBUM_ID=album-upload, ...}]
cursor extras=... HONORED_ARGS=[android.provider.extra.ALBUM_ID]
Paged sync successful ... Total Rows: 1
Returning 1 album media items for album album-upload
```

The `업로드 후보` album then visibly contained exactly one Lakomics test image. This is a real device-validation result, not only an API-level assumption.
## What the Android album model can and cannot represent

CloudMediaProvider albums are not a general recursive filesystem. The practical model validated here is:

```text
provider media set
+ flat album list
+ album-id-filtered media queries
```

Therefore a Lakomics hierarchy such as:

```text
게임 / 블루 아카이브 / 키사키
```

should not be assumed to become a literal nested Android folder tree.

Reasonable projection strategies include:

- expose leaf classifications with path-aware display names, e.g. `게임 · 블루 아카이브 · 키사키`;
- expose frequently reused manual albums as first-class Photo Picker albums;
- expose special operational albums such as `업로드 후보`, `최근 저장`, or `임시 보관함`;
- expose creator/series views only when they are useful enough to justify the number of album cards.

A media item can conceptually be returned for more than one album query, allowing multiple browsing views over the same underlying Lakomics asset. That many-to-many mapping is a design direction; this exact overlapping-membership case was not separately device-tested during this PoC.
## Important persistence / default-provider caveat

One active CloudMediaProvider exists per Android profile.

The ADB force-selection path worked, but it should not yet be treated as a durable one-time installation setting. During the experiment, force-stopping/reinitializing MediaProvider caused the platform to initialize the normal eligible/default provider path again and Google Photos became the cloud provider.

Therefore production planning must assume one of the following until reboot persistence is explicitly tested:

- the custom Lakomics provider may need to be reasserted after reboot or MediaProvider reinitialization;
- a small developer/bootstrap command may be needed on the personal device;
- future Android/One UI updates may change this shell behavior.

Do not claim that installing the APK once permanently registers Lakomics in the user-facing `클라우드 미디어 설정` page. That was **not** proven.

Also note that Google Photos was temporarily enabled during the baseline test because it had originally been disabled. If the user wants the previous device state restored, provider selection and Google Photos enabled state should be deliberately restored after testing.

## Reproduction commands used conceptually

Portable ADB path used in this session:

```text
C:\chatgpt\_tools\lakomics-cloudmedia-poc\platform-tools\adb.exe
```

Read the active cloud provider:

```bat
adb shell content call --user 0 --uri content://media/ --method get_cloud_provider
```
Force-select the Lakomics test provider:

```bat
adb shell content call --user 0 --uri content://media/ --method set_cloud_provider --extra cloud_provider:s:com.lakomics.cloudpoc.provider
```

Launch an image-only Photo Picker session:

```bat
adb shell am start -a android.provider.action.PICK_IMAGES -t image/*
```

The current PoC package can be reinstalled with the debug APK produced under:

```text
C:\chatgpt\_tools\lakomics-cloudmedia-poc\app\build\
```

Exact APK filename/version changed during iterative testing; inspect the build directory rather than assuming an older filename is current.

## Production Lakomics integration direction

The PoC should not be copied verbatim into production. Its generated files should be replaced with a thin Android provider layer over the existing cloud library.

Recommended provider responsibilities:

- keep a lightweight local cache of cloud-library media metadata and album/classification metadata;
- implement `onGetMediaCollectionInfo()` using a stable Lakomics collection/revision identity;
- implement `onQueryAlbums()` from the chosen Photo Picker album projection;
- implement `onQueryMedia()` for both full-library and `ALBUM_ID`-filtered requests;
- implement `onOpenPreview()` using thumbnail-sized cloud media, not full originals;
- implement `onOpenMedia()` by fetching/streaming the selected original through a short-lived Lakomics media ticket;
- return correct MIME type, size, dimensions, orientation, timestamps, and generation values;
- enforce the CloudMediaProvider permission boundary before exposing cloud data.
Existing Lakomics cloud work already provides useful building blocks for this direction:

- full-library cloud replication is complete;
- `/v1/library/classifications` exposes replicated organization;
- `/v1/library/assets` exposes ready cloud-library assets;
- per-asset media-ticket access already exists for media delivery;
- the PC remains authoritative and the VPS/R2 remain a read-oriented replica.

The CloudMediaProvider should consume this read-oriented cloud-library model. It should **not** use pending Cloud Capture inbox rows as if they were the canonical library.

## Recommended product split for normal reusable media

The main Photo Picker problem is not technical capacity but discoverability. Dumping all ~8,000 cloud images into the `사진` tab is technically possible but poor as the only navigation strategy.

The recommended product surface is:

```text
Lakomics normal library
  -> reusable/manual upload albums
  -> selected classification-derived albums
  -> Photo Picker `컬렉션`
```

Examples:

```text
업로드 후보
자주 씀
최근 저장
게임 · 블루 아카이브
게임 · 명조
작가 · <name>
```

The Android `사진` tab may still contain the exported Lakomics media merged by date, but the user-facing retrieval strategy should rely primarily on `컬렉션`.

A useful future decision is whether the provider should expose the entire Lakomics library or only an Android-upload subset plus special albums. The PoC proves both full-media sync and album-filtered browsing are technically possible; it does not choose this product policy.
## Related product requirement: one-use / temporary images

A separate requirement emerged during the same discussion: many images are only needed once for a post and should not become permanent curated Lakomics assets.

This is especially important because the redesigned Lakomics browser collector now runs on most ordinary sites, so the user's old mental model of "just download this image locally" is increasingly replaced by Lakomics capture behavior.

The proposed feature is a dedicated **temporary / ephemeral inbox**, not another ordinary classification.

Target flow:

```text
Web image
  -> extension donut: `임시 저장`
  -> dedicated temporary-capture API
  -> server-side ephemeral object storage
  -> `임시 보관함` in Lakomics / Android Photo Picker
  -> use once in a post
  -> automatic TTL deletion after N days
```

This is a product proposal, not a validated implementation.

## Where temporary media should live

Recommended ownership is primarily the server/backend, with the browser extension acting only as the capture trigger.

Do **not** route temporary media through the normal canonical ingestion path unless a later design deliberately chooses that trade-off.

Reasons to keep it separate:

- no classification should be required;
- no permanent PC-library asset needs to be created;
- no full library replication lifecycle should be triggered;
- no long-term tag/search/duplicate bookkeeping is required for one-use media;
- expiry/deletion semantics are fundamentally different from canonical asset deletion.
A reasonable server-side model would be a dedicated table/namespace such as:

```text
ephemeral_assets
  id
  mime_type
  created_at
  expires_at
  source_url
  object_key
  size_bytes
  optional preview metadata
```

with object keys under a separate namespace such as `ephemeral/...`.

A periodic cleanup job can remove rows/objects whose `expires_at` is in the past. Hourly cleanup is sufficient for this use case; exact cadence is a later implementation choice.

The ephemeral state machine should remain separate from both:

- `cloud_capture_imports` — inbound capture-to-canonical-library transport state;
- `cloud_sync_queue` — canonical local-library-to-cloud replication state.

Temporary media should not silently enter either queue.

A useful escape hatch is an explicit `영구 보관` / `Promote to library` action that copies or ingests the temporary object through the normal canonical Lakomics ingestion path before expiry.

## Temporary media in Android Photo Picker

If CloudMediaProvider becomes the chosen personal-device integration, the ephemeral inbox maps naturally to one special album:

```text
임시 보관함
```

That gives the desired low-friction posting flow:

```text
browser extension `임시 저장`
  -> server ephemeral object
  -> Photo Picker `컬렉션`
  -> `임시 보관함`
  -> select for DCInside/other site
  -> TTL cleanup later
```
## Extension redesign / donut integration note

The extension is currently being redesigned around a donut interaction model. The temporary-capture idea should be represented in that interaction architecture now, even if the backend is implemented later.

Recommended interaction contract:

```ts
type CaptureDestination =
  | { kind: "library" }
  | { kind: "temporary"; ttlDays: number };
```

The user-facing `임시 저장` action should be a first-class, low-friction donut action rather than a deep submenu item. The whole purpose is to replace casual one-off local downloads without forcing classification.

Recommended UX behavior:

- one gesture/click performs temporary capture immediately;
- no classification dialog is required;
- default TTL comes from settings rather than being chosen every time;
- a clock/hourglass-style icon is preferable to a trash icon because the semantic is "temporary retention", not immediate deletion;
- backend/API work can remain a separate implementation batch after the donut redesign is structurally ready for the destination type.

A likely default-retention setting can offer values such as 1 / 3 / 7 / 14 days, but the final default has not been chosen.

## Production safety / performance requirements

The PoC generated tiny local files and therefore did not exercise production network behavior. A real provider should additionally:

- use requested-size previews for `onOpenPreview()` rather than downloading full originals for grid thumbnails;
- handle cancellation and timeouts because Photo Picker queries are latency-sensitive;
- page metadata rather than loading thousands of records into memory at once;
- keep stable media IDs and sync generations so incremental sync does not churn the picker database;
- avoid exposing permanent R2 URLs or R2 credentials;
- use existing short-lived media-ticket mediation;
- avoid duplicate local+cloud entries when an item is also present in Android MediaStore, if this case becomes relevant;
- verify orientation and MIME metadata so previews render correctly.
## Validation matrix

| Question | Result on Galaxy Tab S11 |
| --- | --- |
| Does ADB shell force-selection of a cloud provider work? | **PASS** |
| Does the shell path ignore the normal allowlist? | **PASS, observed in MediaProvider logs** |
| Can a custom non-allowlisted Lakomics provider be selected? | **PASS** |
| Does a custom remote image appear in the standard Photo Picker? | **PASS** |
| Does the provider appear as a REMOTE source? | **PASS** |
| Can custom Lakomics albums appear in `컬렉션`? | **PASS** |
| Can selecting one custom album return only that album's media? | **PASS after honored-args representation fix** |
| Can a literal nested classification tree be represented as nested albums? | **Not established; CloudMediaProvider album model is flat** |
| Does custom provider selection survive reboot / MediaProvider reinitialization? | **Full reboot PASS after package allowlist correction; see follow-up above. Earlier force-selection alone reverted. Future updates are unverified.** |
| Can Lakomics appear as a normal user-selectable provider without ADB/OEM eligibility? | **No evidence; official path remains restricted** |
| Has the provider been wired to real Lakomics cloud assets yet? | **No; current PoC uses generated test PNGs** |
| Has ephemeral/one-use capture been implemented? | **No; design proposal only** |

## Current test-device state at the end of the experiment

At the end of the album validation session:

- `com.lakomics.cloudpoc` was installed on the S11;
- the custom Lakomics authority had been force-selected through ADB for the active test session;
- Google Photos had been temporarily enabled earlier to validate the baseline provider path;
- the Photo Picker had successfully displayed the custom album and one filtered test image.

Do not assume those state changes are desired permanently. Restore them explicitly when the test session is considered finished.

## Suggested cleanup / restore actions

Inspect current state first:

```bat
adb shell content call --user 0 --uri content://media/ --method get_cloud_provider
```

If the intended state is no cloud provider, use the platform's available unset/null path only after verifying the exact supported command on the current build. If restoring Google Photos, select `com.google.android.apps.photos.cloudpicker` deliberately.

If Google Photos should return to its pre-test disabled state, disable it only after restoring provider state so the picker is not left pointing at a disabled provider.

The PoC package can later be removed with:

```bat
adb uninstall com.lakomics.cloudpoc
```
