# Cloud Capture / Cloud Sync Reference

> Status: current repository architecture/reference, source/documentation reconciliation 2026-09-09 against `0c61206`; no new live deployment verification. Task status lives in `docs/roadmap/lakomics-backlog.md`; code changes do not by themselves prove deployment.

Lakomics keeps the local library authoritative. Cloud features are optional transport/replication paths; they do not make the VPS or R2 the canonical library.

## Two independent directions

### A. Local library → cloud replication

- A successful local commit may enqueue work in `cloud_sync_queue`.
- The desktop uploads media/metadata through the cloud client and VPS-managed signed URLs.
- R2 credentials never belong on the desktop.
- Cloud failure must not roll back an already successful local library mutation.

### B. VPS Capture inbox → local ingestion

- The browser extension creates a Capture request on the VPS.
- The VPS fetches the original X media and stores it in R2 under a capture-specific inbox object key.
- The desktop polls pending captures and downloads them through the VPS-issued download path.
- The downloaded staging file is imported through the canonical `Library::ingest_media` path.
- The remote capture is acknowledged only after the local result is safe to acknowledge.

Inbound state (`cloud_capture_imports`) and outbound state (`cloud_sync_queue`) are intentionally separate. Do not merge their status machines or queues.

## Current VPS Capture contract

Capture creation accepts:

- `source_url`
- `media_url`
- `classification_id`
- `published_at`
- `media_type` (`image`, `video`, or `animated_gif`)
- `source` (`x`, `arca`, `dcinside`, or generic `web`)

The server exposes pending-list, per-capture download, acknowledge/imported, and extension confirmation routes. Known sources retain host validation; generic HTTPS capture additionally rejects private/special-use resolution and verifies the connected peer against the validated address set. Remote fetches keep bounded sizes/timeouts, no redirect following, streamed temporary files, and R2 cleanup on failed upload. Animated GIFs remain `image/gif` bytes and are identified explicitly through the inbound PC path rather than flattened or normalized to video.

Current server limits are 50 MiB for images and 512 MiB by default for videos (video limit is environment-configurable).

## Server-owned media thumbnails (deployed update 2026-09-23)

When Asset authority is active, a new Capture is promoted directly to a committed
server Asset. This path is distinct from the legacy PC-mediated inbox described
below. `image_thumbnails.py` registers a durable job in the same transaction as a
new image/GIF/video Asset with `import_source='capture'`; startup upgrades the
INSERT trigger but never scans old Assets or requeues terminal jobs.
A single lock-protected background worker downloads the original from R2, verifies
its size/digest, and invokes `image_thumbnail_encode.py` in a separate process.
Deployed 2026-09-23: after a Capture transaction commits a newly
promoted Asset, the API signals the existing worker's local event. Failed transactions
and duplicate promotions do not signal it. The five-second poll remains: with multiple
API processes, only the
process holding the worker lock can react to its own event; other processes' jobs
are discovered by polling. No startup scan, backfill or cross-process notifier is added.

- Deployment prerequisites: the application's nullable `width`, `height` and
  `duration_ms` migration must run before worker installation; Pillow is required
  for all kinds (`server/lakomics-api/requirements-image-thumbnails.txt`). Video
  additionally needs FFmpeg/FFprobe, defaulting to `/usr/bin/ffmpeg` and
  `/usr/bin/ffprobe`, with optional absolute `LAKOMICS_FFMPEG` / `LAKOMICS_FFPROBE`
  overrides. Installation/deployment requires separate operational authorization.
- JPEG, PNG and static WebP produce a maximum-512-pixel WebP thumbnail, preserving
  aspect ratio, EXIF orientation and transparency, without upscaling. GIF uses
  Pillow's first frame without traversing the animation; its total duration stays
  unknown. Animated PNG/WebP and unsupported formats remain rejected.
  Deployed 2026-09-23: JPEG checks the original pixel budget
  before requesting decoder-assisted downsampling toward twice the final edge.
  Strict truncation rejection, all EXIF pixel transforms and original display
  dimensions are retained. Final Lanczos sizing uses original dimensions and the
  orientation-adjusted fractional decoder box, avoiding odd-size padding drift.
  PNG, WebP, GIF and video decoding are unchanged. The synthetic-only benchmark
  `server/lakomics-api/tests/jpeg_thumbnail_benchmark.py` compares full decode and
  draft in fresh subprocesses; its pixel metrics are not perceptual acceptance.
- MP4/MOV and WebM/Matroska produce one static poster frame through bounded tools.
  Header-based demuxer selection also works on extensionless temporary files;
  network protocols and playlists are excluded, and MOV external data references
  are explicitly disabled. These restrictions are not a general filesystem sandbox.
  Canonical Asset kind is retained, including GIF-kind captures stored as MP4.
- Bounds: 50 MiB image/GIF input, 128 MiB video input (below the Capture limit),
  24 million source pixels, 384 MiB address space and 10-second soft/15-second
  hard CPU limit per encoder/tool process, 20-second outer encode timeout, and
  2 MiB thumbnail output. Resource limits are per process, not a whole-tree RAM
  reservation. One worker encodes at a time; tool decoding/filtering/encoding uses
  one thread and inherits lowered priority. The parent cleans up the whole process
  group on timeout or supervisor exit. Unsupported platforms fail closed; this
  worker requires POSIX limits and process groups.
- Transfers use a dedicated bounded-timeout R2 client and a 60-second streaming
  download budget checked between reads. One socket read can extend that budget
  by its read timeout. Jobs retry transient failures at most three times with
  backoff; terminal failures remain inspectable in `image_thumbnail_jobs`.
  Missing decoder tools are terminal `encodeToolUnavailable`; the next eligible
  job can proceed. Provisioning tools later does not retry old terminal jobs.
- Existing image keys stay `derived/image-thumbnails/v1/{sha256}.webp`; future
  still-image encodes use `derived/image-thumbnails/v2/{sha256}.webp` for the JPEG
  decoder change deployed on 2026-09-23. Both image recipes remain eligible
  for ticket HEAD caching. No existing key is replaced and no requeue or backfill
  is performed. GIF keeps `derived/media-thumbnails/v1/gif/{sha256}.webp`.
  The later-video recipe uses
  `derived/media-thumbnails/v2/video/{sha256}.webp`: accurate seek at 10% duration,
  clamped to 0.5–3 seconds and capped at half-duration for short clips. Unknown
  duration uses 0.5 seconds; only a successful decode with no frame retries at zero.
  Decode failures/timeouts do not retry at zero. This reduces opening-black posters
  without brightness analysis; existing poster keys are not automatically replaced.
  Video recipe v2 was deployed in the authorized 0.6.6 rollout on 2026-09-20. Originals are
  never overwritten. Publication rechecks visibility, digest, source fields and
  missing-thumbnail state, then atomically sets `thumbnail_key` and missing source
  dimensions/duration from a strictly validated, maximum-4-KiB sidecar. Dimensions
  are rotation-corrected source dimensions, never tile dimensions; video duration
  is nonnegative signed-i64 milliseconds or null. Existing metadata wins; a partial
  dimension is filled only if its known counterpart agrees with the decoder.
  Ordinary Library/Album reads expose the fields and mobile list generation advances.
  Canonical lifecycle/entity revisions are unchanged. The new Character read source
  overlays live dimensions/duration while preserving published membership/order and
  other display fields; this read change was deployed and live-checked in the same rollout.
- Existing missing thumbnails require a separately authorized, explicitly scoped
  `enqueue(db, asset_id)` operation. No public repair endpoint or automatic full
  backfill is added. Restart recovery uses persisted job leases.

The earlier image-thumbnail-only deployment and authorized recent-image repair are
recorded in `MOBILE-UX-001`. The user-authorized 2026-09-20 rollout installed Ubuntu
FFmpeg/FFprobe 8.0.1 and deployed the GIF/video/metadata extension, including the
nullable dimension migration. All 216 targeted tests passed in an isolated stage
on the deployment host, including real video decoding. Live HTTPS reads, metadata
fields, existing thumbnail delivery and authentication were checked; both API and
proxy finished active/running. At that rollout checkpoint no historical jobs were
queued or metadata backfilled. The user subsequently confirmed new thumbnail rendering;
four missing video posters were repaired separately. The later authorized metadata-only
repair filled 8,956 visible committed Assets (including 421 video durations): 8,647
exact PC-snapshot matches and 309 sequential bounded original extractions. Final missing
dimension/video-duration counts were zero; other Asset columns were unchanged and
SQLite quick-check passed. Existing thumbnails were preserved. Checked backups and
manifests remain under `/home/linuxuser/lakomics-metadata-repair-20260920-kchr7f54/`.
No API source deployment or APK installation occurred during that metadata repair.
Rollback sources and the checked pre-deployment SQLite backup are retained under
`/home/linuxuser/lakomics-media-release-20260920-uazynrio/rollback`.

## Ticket HEAD metadata cache (deployed 2026-09-23)

Library thumbnail and Collection artwork tickets reuse successful R2 HEAD metadata
for at most 30 seconds in a process-local, thread-safe 512-entry LRU cache. Eligibility
is limited to exact content-addressed Collection keys (`work-artwork/mobile/{sha256}`)
and the image-v1/v2, GIF-v1 and video-v2 derived thumbnail recipes above. Ordinary Asset
originals, `library/{id}/thumbnail`, inbox, legacy artwork and backup keys still HEAD
on every request: a database digest does not make those overwriteable keys immutable.

Each request still checks authentication and current publication/Asset visibility,
including tombstones, before consulting the cache. The account-scoped R2 endpoint,
bucket, key and current metadata identity must match. Lookup and invalidation share
an opaque hash of boto's `meta.endpoint_url`, so distinct clients for the same endpoint
invalidate together without retaining URLs or credentials in the cache. Clients without
a usable endpoint bypass caching. Collection size/type validation still runs on hits.
Only content type and length are cached, never signed URLs or authorization. Ticket response and
presign contracts and the maximum-eight batch HEAD concurrency are unchanged.

Upload preparation/confirmation and unconfirmed snapshot checks always use fresh
HEADs and invalidate local ticket metadata. PUT signing and successful derived
thumbnail writes also invalidate it. Misses, storage errors and manifest mismatches
are not retained; an observed missing Collection object still removes its publication
receipt. Hits do not extend the TTL. Out-of-band storage deletion/overwrite and writes
in another API process can remain unseen until TTL expiry; the cache is not shared
across processes, and it does not change already issued signed URL lifetimes.
The 2026-09-23 deployment inspection found one Uvicorn API process, with no explicit
multi-worker configuration. This is an observed deployment state, not a topology guarantee.

Local verification used an ignored `.venv` with Python 3.14.4, FastAPI 0.141.1,
Pydantic 2.13.5, HTTPX 0.28.1, boto3 1.43.100 and the pinned Pillow 12.3.0.
Ticket/Collection/Capture/API/JPEG regressions passed 172 tests; cache/worker/full
encoder regressions passed another 199 tests. Fixtures use temporary databases and
fake storage, not production data. The existing HTTPX TestClient deprecation warning
remains; no dependency declarations or deployed packages were changed. Synthetic
benchmarks also ran with Pillow 12.3.0/libjpeg-turbo 3.1.4.1; neither those measurements
nor local API tests establish production latency, deployment or real-image visual quality.

## Media optimization rollout — 2026-09-23

After explicit authorization and Tailscale SSH authentication, the six candidate
modules (`app.py`, `r2.py`, `mobile_collections.py`, `image_thumbnails.py`,
`image_thumbnail_encode.py`, new `head_cache.py`) were deployed with baseline and
candidate hash guards. Unrelated maintenance scripts were excluded after runtime
reference checks and left unchanged. No dependencies or service units were changed.

- Production Python 3.14.4/Pillow 12.3.0 and its existing API dependencies passed all
  371 targeted tests in an isolated stage, with zero skips. The stage had no
  production environment file or database. Candidate/test hashes were rechecked
  before reusing this evidence for the final attempt.
- The initial API stop also stopped the existing proxy through its `Requires`
  dependency. HTTPS returned 502 and candidate sources were rolled back. The proxy
  was restored; the final procedure waits for API readiness, starts the proxy,
  then checks HTTPS on both deployment and rollback. A stopped proxy's exit-143
  state is accepted only with PID zero and an empty cgroup. No database was restored.
- Final API and proxy states were active/running with `NRestarts=0`. Direct, local
  proxy and HTTPS health passed. Authenticated Library/capability reads, single/batch
  Asset tickets and Collection tickets passed; existing thumbnails downloaded and
  decoded, with the Collection SHA-256 matching its manifest. Unauthenticated reads
  and ticket requests returned 401. All six deployed hashes match the candidates.
- The successful attempt preserved the full logical database fingerprint. Asset
  count remained 9,099, thumbnail jobs 128 completed (none queued/running), Collections
  342 and catalog publications 64. Production and backup SQLite `quick_check` passed.
  No historical thumbnail regeneration, requeue, backfill or forced capture occurred.
- Rollback sources and evidence remain under
  `/home/linuxuser/lakomics-media-0610-pkkwe8o0/`; the fresh pre-final-attempt backup is
  `rollback/lakomics-attempt3.sqlite3` (SHA-256
  `87ea5307fa6e47fc4867cae20eda52ae0026c1ac3d1f8f1e9a66614c9bb329d1`).
  Local task artifacts are in ignored `android/build/media-0610-deploy/`.
- Android 0.6.10 (26) was already installed with matching APK hash and verified startup;
  see `android/README.md`. No further device interaction occurred during this rollout.
  New JPEG-v2 generation and worker wake have isolated-test coverage, not a new
  mutating production Capture acceptance check. Real-gallery latency/visual quality
  remain unmeasured; one-off smoke timings are not a performance benchmark.

## Current desktop inbound behavior

The desktop Cloud Capture consumer:

- requires Cloud sync to be enabled and an API base URL to be configured;
- reads the Cloud API token through the platform credential interface: Windows Credential Manager or Linux Secret Service;
- downloads into `assets/.staging/remote-capture-<uuid>.<ext>`;
- uses `BrowserExtension` as the ingestion source and reuses normal hashing, duplicate handling, thumbnails, and similarity review;
- records local import state before remote ACK so a later run can retry ACK without re-downloading;
- treats `Added` and `ExactDuplicate` as locally committed results that may be acknowledged;
- leaves `ReviewPending` unacknowledged;
- keeps outbound replication behavior untouched.

The frontend runs an inbound poll on startup, every 15 seconds while the app is visible and focused, every 60 seconds while hidden or unfocused, and immediately when the app becomes visible or focused again.

## Current inbound behavior

The repository implementation now includes the core `CLOUD-001` / `CLOUD-002` path:

- A poll drains pending captures sequentially with a 25-attempt cap and per-capture failure isolation.
- Capture pending payloads carry `classification_id`; the desktop applies it only when that classification exists locally, otherwise the import safely remains unclassified.
- Settings exposes Cloud enablement, API base URL, platform secure-store-backed API token management, connection testing, and a manual sync action.
- The frontend consumes typed inbound summaries: new assets refresh the current asset/sidebar state, classification-changing exact duplicates refresh membership counts, review-pending work refreshes the review count, and newly added videos trigger normal video preparation.
- ACK-only retries and unchanged exact duplicates do not force an unnecessary asset reload.
- Outbound replication remains independent in `cloud_sync_queue`.

The backlog records the `CLOUD-001` / `CLOUD-002` rollout and `VERIFY-001` real-image/video verification as completed. These are retained results, not pending rollout tasks.

`CLOUD-UI-001` remains `VERIFY` for its recorded acceptance limits. `CLOUD-006`, including queued-work pause/wait/restart/resume acceptance, is recorded `DONE` in the living backlog. The full-library backfill itself is complete and must not be rerun by default. `CLOUD-003` is obsolete/incident-only unless a real reproducible failure warrants reopening it.

## Batch-drain semantics

`CLOUD-001` returns a typed summary rather than a single successful capture ID:

- `attempted`: valid pending captures actually processed in this invocation;
- `acknowledged`: captures whose final ACK succeeded this invocation, including Added, ExactDuplicate, and ACK-only retries for already-local imports;
- `failed`: attempts that did not complete, including ACK failure;
- `review_pending`: similarity-review results intentionally left pending.
- `added`: new Assets created during this invocation;
- `video_added`: newly added video Assets that should enter normal preparation;
- `classification_changed`: exact duplicates whose classification membership changed.

Malformed pending records are skipped and do not count toward `attempted`; the batch cap applies to attempted records.

## Idempotency rules

Preserve these invariants when changing either side:

- An already locally imported Capture must be able to retry ACK without downloading again.
- Exact duplicates do not create another Asset and may be acknowledged.
- ReviewPending must not be acknowledged as imported.
- One broken Capture must not block later pending items in a batch.
- ACK failure after local import must not cause a duplicate Asset on retry.
- Inbound changes must not mutate outbound `cloud_sync_queue` semantics.

## Security boundary

- Do not store R2 credentials in the extension, desktop app configuration, or repository.
- Browser/desktop clients authenticate only to the Lakomics API endpoints they need.
- Signed/download mediation remains server-owned.
- Validate remote media hosts and content/size limits server-side; do not trust browser-provided media metadata alone.
- Never include API or Collector tokens in committed docs, logs, fixtures, or screenshots.

## VPS HTTPS endpoint

Android/Titanium에서 Cloud Capture에 접근할 때는 Tailscale Serve HTTPS 경로를 사용한다. 운영 주소는 `https://laku-tokyo.tail0aa1a3.ts.net:8443`이며, health check는 `https://laku-tokyo.tail0aa1a3.ts.net:8443/health`다.

현재 운영 라우팅은 다음과 같다.

- Tailscale Serve `:8443` -> `http://127.0.0.1:32147`
- `lakomics-local-proxy.service` (`socat`) -> `http://100.76.119.29:32146`
- `lakomics-api.service`는 기존처럼 Tailscale IP `100.76.119.29:32146`에서 uvicorn을 제공한다.
- 기존 raw endpoint `http://100.76.119.29:32146`도 하위 호환을 위해 유지한다.

이 HTTPS 경로는 Titanium에서 raw Tailscale-IP HTTP 접근 문제가 있었기 때문에 추가되었다. Android Tailscale 앱의 split tunneling에서 Titanium을 제외하면 `100.x` 접근이 실패하거나 `*.ts.net` MagicDNS가 `ERR_NAME_NOT_RESOLVED`가 될 수 있으므로 Titanium은 Tailscale 제외 앱에 두지 않는다. `8443` 경로는 tailnet-only이며 외부 공개 엔드포인트가 아니다.

운영 서비스 이름:

- `lakomics-api.service`
- `lakomics-local-proxy.service`

## Current implementation order

Use the living backlog's active item statuses and dependencies rather than a second execution sequence here. CLOUD-006's pause/wait/restart/resume gate is recorded complete; follow the remaining CLOUD-UI-001 verification scope in the backlog. Do not repeat the completed inbound rollout, E2E verification, or full backfill merely because an older procedure mentions them. Production writes and deployments require separate explicit authorization.


## Historical Settings reorganization checkpoint (2026-09-06)

The following describes that implementation session, including its migration incident. It is not a current migration instruction or an assertion that the current library remains at v37; current schemas and the backlog govern follow-up work.

- Settings navigation occupies the existing contextual sidebar. General, Cloud, Catalog, Connections, Data management, and About own their respective controls.
- v38 preserves the old cloud enablement for inbound capture, independently controls outbound replication, and maps an old paused choice to outbound disabled. Restart no longer silently introduces pause. Existing internal control values remain compatible, but normal UI has no Pause/Resume actions.
- v39 adds independent metadata publish timestamps/errors to the replication activity row so successful media uploads cannot hide a failed mobile metadata publish (or vice versa).
- New asset claims check replication enablement atomically. Capture consumption checks enablement before each next item. Already active transfers can finish; pending data is retained.
- The application supervisor owns the sole progress timer and publishes progress during long worker cycles. Settings subscribes, with one initial read; it does not own a periodic timer.
- Last successful capture/media cycle survives later errors. Diagnostic messages persisted by the activity boundary are fixed public strings, excluding transport payloads and credentials.
- Backup lists load only in Data management, on a blocking worker thread. Existing snapshot verification and restore validation remain intact.
- This implementation does not close device/native acceptance by itself. During editing an already-running development watcher unexpectedly migrated the active library to v38; it was stopped. A verified pre-migration v37 backup exists. v39 must not be applied to the active library without authorization.

## Android album metadata replica

The existing metadata poll also publishes album definitions and normal-asset memberships through `/v1/library/album-snapshot`. This is metadata-only and never queues media backfill. The Android provider reads the selected album IDs from `/v1/library/album-media`; only cloud-committed items with thumbnail metadata appear. Album membership removal affects the returned view, not original media retention. The selected temporary album has no TTL or automatic deletion. Deployed and verified on the S11 on 2026-09-07; exact selected-album membership matched the PC. Deployment/native evidence is recorded in `../research/android-cloud-media-provider-poc-20260906.md`.
