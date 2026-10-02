# Library thumbnail upload v1

This additive contract accepts the current PC's fixed-key, size=1 / sha=null
replication commits during rollout. It does not enable migration or block old
clients by default. All routes use the existing upload-client authentication.
Final keys are server-owned: `derived/library-thumbnails/v1/<sha256>.webp`.
No API issues PUT URLs for that namespace.

## Prepare

First prepare the asset through `/v1/replication/prepare` if it does not exist.
`POST /v1/replication/thumbnails/prepare`:

```json
{
  "asset_id": "00000000-0000-4000-8000-000000000001",
  "operation_id": "unique-persistent-operation-id",
  "sha256": "<64 lowercase hex characters: thumbnail bytes, not original>",
  "size_bytes": 30000,
  "content_type": "image/webp",
  "expected_thumbnail_write_epoch": 0
}
```

`expected_thumbnail_write_epoch` is optional; when supplied it must match the
current value returned by replication prepare. Size must be 1..2097152 bytes.
Operation IDs are global, 1..128 characters. Persist one per attempted upload.
A repeated operation with the identical prepare body returns the same session;
a different body returns HTTP 409 `thumbnailOperationConflict`. A new operation
reserves a new write epoch, superseding older uncommitted sessions for that asset.

Response:

```json
{
  "asset_id": "...",
  "upload_id": "<server UUID>",
  "upload_object_key": "uploads/library-thumbnails/<server UUID>",
  "upload_url": "<temporary presigned PUT URL>",
  "required_headers": {"Content-Type": "image/webp", "Content-Length": "30000"},
  "thumbnail_key": "derived/library-thumbnails/v1/<sha256>.webp",
  "thumbnail_write_epoch": 1,
  "expires_at": 1790000900,
  "upload_expires_at": 1790000600,
  "committed": false
}
```

Times are Unix seconds. Session lifetime is 900 seconds; PUT lifetime is at most
600 seconds from the original prepare, never extended by retry. A committed
prepare retry has `committed: true`, `upload_url: null`, and `result` containing
the original publish result. Expired uncommitted sessions return HTTP 410;
create a new operation. Upload the exact buffer used for the hash and size.

## Commit

Standalone: `POST /v1/replication/thumbnails/commit`:

```json
{"asset_id": "...", "upload_id": "..."}
```

The standalone route requires an already committed asset. For an initial full
replication use the existing `/v1/replication/commit` with its original metadata,
`expected_revision` and `commit_id`, plus:

```json
{"thumbnail_mode": "upload", "thumbnail_upload_id": "..."}
```

Omit the legacy `thumbnail` variant in upload mode. The server reads the bounded
temporary object, validates actual length, SHA-256, Content-Type and a complete static WebP
decode in the existing resource-limited encoder subprocess, writes that verified buffer to the final key (or verifies/reuses the
existing object), and reads/verifies the final object. Only then does one short
transaction publish the key, receipt, digest, revision and epoch, and complete
the session. The replication metadata and thumbnail publish commit atomically.
No storage I/O runs while the database write transaction is held.

Standalone success (also returned as `thumbnail_result` by replication commit):

```json
{
  "ok": true,
  "asset_id": "...",
  "upload_id": "...",
  "thumbnail_key": "derived/library-thumbnails/v1/<sha256>.webp",
  "thumbnail_sha256": "<sha256>",
  "thumbnail_revision": "t1.<sha256>",
  "thumbnail_write_epoch": 2
}
```

Commit retry returns the persisted result without reading the temporary object.
A session is bound to one asset and one commit context (standalone, or the full
replication body). Reusing it with different commit metadata is HTTP 409.
A concurrent prepare, metadata/original change or lifecycle change rejects the
publish with HTTP 409 `thumbnailConcurrentChange`; prepare a new operation.
Bad object bytes/type/length are HTTP 422; missing objects are HTTP 409; transient
storage failures are HTTP 503. Final digest collision/corruption is rejected,
never overwritten. Failed publishes never grant a trusted receipt.

For metadata/relationship re-commits use `"thumbnail_mode": "retain"`, omitting
both thumbnail fields. It requires a committed asset and reads the current
thumbnail inside the transaction. Omitted mode means `legacy`, requiring the
old `thumbnail` variant. Legacy commits and `/v1/assets` upserts cannot replace
an immutable thumbnail. Replication prepare/commit return the actual stored key
for committed assets, not a reconstructed legacy thumbnail key. A missing
thumbnail entry is omitted from `object_keys` (never JSON null), preserving the
installed PC's string-map response decoder.

## Revision and receipt rules

The effective revision is null without a key, otherwise the stored revision or
`sha256(key.encode('utf-8')).hexdigest()[:16]`. Migration freezes that value before
moving the key. Equal thumbnail bytes preserve it; new/different bytes use
`t1.<thumbnail sha256>`. If the previous digest is unknown, publish reads and
hashes the old object once. An unreadable old object fails closed.

The receipt shortcut requires a key-bound receipt, matching thumbnail digest and
`thumbnail_verified=1`, set only by verified publication/migration. Lazy HEAD
fills never confer this provenance. Ordinary cold tickets need no HEAD; explicit
`fresh_head=true` recovery requests still do. Receipt/digest/epoch-only changes
and moves preserving the effective revision do not change list generation.
Existing projections with revisions keep them; projections previously without
revisions remain unchanged until the tablet cache adoption rollout.

Temporary objects are deleted after commit, best effort. The migration tool's
separate `--reclaim-temp --limit N` mode reclaims session keys after their upload
URL and session expiry plus a one-hour grace. Repeated bounded sweeps also catch
late PUTs; no final or legacy object is ever deleted.

## Rollout and migration

`LAKOMICS_BLOCK_LEGACY_THUMBNAIL_UPLOADS=1` refuses legacy thumbnail presigns with
HTTP 409 `thumbnailUpgradeRequired`. Default is off. Before migration enable it
in the running server and the operator environment, update/stop every legacy
writer, wait out all old PUT URLs and confirm in-flight transfers ended. The
tool also requires `--legacy-writes-drained` as an operator attestation. The
switch alone cannot establish that an already started PUT has finished.

Take and verify an online DB backup before applying. From `server/lakomics-api`,
with R2 environment already loaded and DATABASE set to the exact control DB:

```sh
.venv/bin/python migrate_library_thumbnails.py --database "$DATABASE"
.venv/bin/python migrate_library_thumbnails.py --database "$DATABASE" --verify-read 25
.venv/bin/python migrate_library_thumbnails.py --database "$DATABASE" --apply --legacy-writes-drained --batch-size 25 --max-r2-ops-per-second 5 --limit 25 --run-id thumb-pilot
.venv/bin/python migrate_library_thumbnails.py --database "$DATABASE" --report --run-id thumb-pilot
.venv/bin/python migrate_library_thumbnails.py --database "$DATABASE" --apply --legacy-writes-drained --batch-size 25 --max-r2-ops-per-second 5 --run-id thumb-full
.venv/bin/python migrate_library_thumbnails.py --database "$DATABASE" --rollback --run-id thumb-pilot --max-r2-ops-per-second 5
```

Dry-run/report open SQLite read-only and never write objects. Verify-read performs
only the requested bounded GETs. Apply freezes a keyset manifest per run (limit
caps that manifest), journals each stage and resumes with the same run ID. One
worker, at most 25 rows per DB batch, bounded retries/timeouts and a per-run lease
protect the single-vCPU service. SIGTERM finishes the current safe stage.
Rollback verifies the old object's journaled bytes and reverses only rows still
at that run's exact result/epoch and unchanged lifecycle/metadata identity.
No old-object deletion is implemented. Foreground ticket latency must be
observed by the operator; this offline tool does not send network probes to the
API. See JSONL summary for local storage, stage and SQLite timings.

## Schema and projection scope

`assets` gains nullable `thumbnail_sha256` and `thumbnail_revision`, plus
`thumbnail_write_epoch INTEGER NOT NULL DEFAULT 0` and
`thumbnail_verified INTEGER NOT NULL DEFAULT 0`. The last column records server
verification provenance; a client cannot set it. `thumbnail_upload_sessions`
retains operation identity, immutable manifest, CAS snapshot, expiry, commit
context and the original result. `thumbnail_revision_fallbacks` is an immutable
key-to-legacy-token dictionary used only by SQLite generation triggers: SQLite
has no portable SHA-256 function, and triggers must work on every writer's
connection without installing a connection-local function. The shared Python
revision helper remains the projection contract. Apply creates
`thumbnail_migration_runs` and `thumbnail_migration_journal`; dry-run/report do not.

Changed revision readers: the shared mobile asset mapper (via the existing
`app.thumbnail_revision` export), and both Character list sorts' live overlay
when the frozen payload already contains a revision. This covers the existing
revision-bearing Album authority, review, revisit/home and trash projections.
The ordinary library/classification list, legacy album/Picker projection and
Album fallback keep their previous response shapes. `/v1/assets` explicitly
omits the new internal columns so its old `SELECT *` shape does not accidentally
introduce a revision. Character published order also returns `listGeneration`.
No tablet/native cache-adoption code changes are included.

Future server encodes also reserve the write epoch before downloading, verify
and publish the encoded byte digest through the shared helper, and atomically
store the receipt/revision with the existing job completion. Existing recipe
keys are not rewritten or requeued. The decoder verification mode uses the
already-deployed Pillow dependency in the isolated encoder, including memory,
pixel and wall-clock bounds; a missing verifier fails closed.

## Operational bounds and verification

One worker is supported (`--workers 1`). Apply limits each storage artifact to
2 MiB, each asset operation to 60 seconds plus bounded in-flight socket/decode
completion, and a run to four hours by default (`--max-seconds`). The storage
client uses the existing worker's connection/read timeouts with SDK retries
disabled, so every storage attempt is counted and paced by this tool. Each call
has at most three tool-level attempts. Journal CAS transactions contain one asset (no more than the
requested batch size), with all storage work outside the transaction. The
initial manifest is frozen atomically with no storage I/O; later walks use IDs,
never OFFSET. A run resumes only its frozen targets; a new run discovers later
assets and earlier conflicts.

Transactions exceeding 250 ms halve the storage rate, down to 0.25 operations
per second; three slow transactions or three SQLite busy errors stop further
assets. If SQLite stays busy even for error journaling, the process exits and
the previous durable state remains resumable. JSONL reports stage p50/p95,
operation counts, declared download/upload bytes, retries, progress and DB
integrity. The GET counters include destination-existence probes; COPY/HEAD
remain zero. Foreground API latency needs external operator observation because
the migration tool neither imports the app nor probes API sockets. Stop with
SIGTERM if foreground latency exceeds the pilot's accepted baseline.

Local socket-free coverage lives in `tests/test_library_thumbnail_uploads.py`;
HTTP wire/projection/cold batch checks live in
`tests/test_library_thumbnail_http.py`. The latter and the full suite must run
where FastAPI TestClient is supported:

```sh
.venv/bin/python -m unittest discover -s tests -t .
```

No deployment, production migration, live R2 verification, tablet cache hit
measurement or old-object deletion is performed by implementing this contract.
