# Cloud Capture / Cloud Sync Reference

> Status: current architecture/reference for `main` as of 2026-08-31. Planned fixes live in `docs/roadmap/lakomics-backlog.md`.

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
- `media_type` (`image` or `video`)

The server currently exposes pending-list, per-capture download, and acknowledge/imported routes. Image fetches are limited to X image hosts and video fetches to X video hosts; remote fetches use HTTPS allowlisting, size limits, streamed temporary files, and R2 cleanup on failed upload.

Current server limits are 50 MiB for images and 512 MiB by default for videos (video limit is environment-configurable).

## Current desktop inbound behavior

The desktop Cloud Capture consumer:

- requires Cloud sync to be enabled and an API base URL to be configured;
- reads the Cloud API token from Windows Credential Manager;
- downloads into `assets/.staging/remote-capture-<uuid>.<ext>`;
- uses `BrowserExtension` as the ingestion source and reuses normal hashing, duplicate handling, thumbnails, and similarity review;
- records local import state before remote ACK so a later run can retry ACK without re-downloading;
- treats `Added` and `ExactDuplicate` as locally committed results that may be acknowledged;
- leaves `ReviewPending` unacknowledged;
- keeps outbound replication behavior untouched.

The frontend runs an inbound poll on startup, every 15 seconds while the app is visible, every 60 seconds while hidden, and immediately when the app becomes visible or focused again.

## Current inbound behavior

The repository implementation now includes the core `CLOUD-001` / `CLOUD-002` path:

- A poll drains pending captures sequentially with a 25-attempt cap and per-capture failure isolation.
- Capture pending payloads carry `classification_id`; the desktop applies it only when that classification exists locally, otherwise the import safely remains unclassified.
- Settings exposes Cloud enablement, API base URL, Credential Manager-backed API token management, connection testing, and a manual sync action.
- The frontend consumes typed inbound summaries: new assets refresh the current asset/sidebar state, classification-changing exact duplicates refresh membership counts, review-pending work refreshes the review count, and newly added videos trigger normal video preparation.
- ACK-only retries and unchanged exact duplicates do not force an unnecessary asset reload.
- Outbound replication remains independent in `cloud_sync_queue`.

Remaining work is verification and richer status UX:

1. The pending-payload server change must be deployed to the production Japanese VPS before classification preservation can be verified there.
2. `VERIFY-001` must exercise real X image and video capture through VPS/R2 into the PC library and confirm immediate UI updates.
3. `CLOUD-UI-001` still tracks richer last-run/last-success/last-error/problem visibility beyond the basic Settings controls.
4. Long video capture can still outlive the request window; `CLOUD-003` remains optional if real-world use reproduces that race.

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

## Current implementation order

Use the living backlog for status. The intended near-term sequence is:

1. Complete `CLOUD-002` production rollout and end-to-end verification.
2. Run `VERIFY-001` for real image and video capture with classification preservation and immediate UI refresh.
3. Add `CLOUD-UI-001` richer status/error/problem visibility if needed after verification.
4. Consider `CLOUD-003` long-video async redesign only if real use still requires it.
