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

The frontend currently runs the inbound poll once on startup and then approximately every five minutes.

## Current-main gaps

These are implementation facts on current `main`, not the intended final behavior.

1. **One-success-per-poll throughput** — the current consumer returns after the first successful pending capture. `CLOUD-001` replaces this with a bounded sequential batch drain (target cap: 25 attempted captures per invocation) while preserving failure isolation and idempotency.
2. **Classification is dropped inbound** — Capture creation stores `classification_id`, but the current pending response does not include it and desktop ingestion currently passes `classification_id: None`. `CLOUD-002` carries it end-to-end.
3. **Cloud configuration is not fully surfaced in normal app UX** — enablement, API URL, token setup/status, and manual/status visibility need a proper app path.
4. **Successful inbound imports do not yet use the same immediate frontend refresh path as normal ingestion** — assets/counts/review state can require later refresh/reload, and new video preparation is not triggered through the normal UI ingestion outcome path.
5. **Long video capture can outlive the request window** — a client timeout can race the server finishing its remote fetch. `CLOUD-003` tracks an optional reservation/job/background-fetch design if this remains a real-world problem.

## Batch-drain target semantics

`CLOUD-001` is intended to return a typed summary rather than a single successful capture ID:

- `attempted`: valid pending captures actually processed in this invocation;
- `acknowledged`: captures whose final ACK succeeded this invocation, including Added, ExactDuplicate, and ACK-only retries for already-local imports;
- `failed`: attempts that did not complete, including ACK failure;
- `review_pending`: similarity-review results intentionally left pending.

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

1. `CLOUD-001` batch drain.
2. `CLOUD-002` desktop app integration, classification propagation, and immediate UI refresh.
3. `VERIFY-001` real X → VPS/R2 → PC end-to-end verification for image and video.
4. `CLOUD-UI-001` minimal status/error/manual-sync surface.
5. `CLOUD-003` long-video async redesign only if real use still requires it.
