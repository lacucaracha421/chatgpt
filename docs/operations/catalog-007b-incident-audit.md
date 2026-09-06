# CATALOG-007B accidental production opening audit

Audit date: 2026-09-05. All times below are **UTC** (KST = UTC + 9 hours).
Repository: `C:\chatgpt`; HEAD `5206961d44c3531228814bc96ee42c28880e3c16`,
branch `codex/overnight-backlog-20260905`. This is incident evidence, not a rollout
or a second backlog. Status remains in [CATALOG-007B](../roadmap/lakomics-backlog.md#catalog-007b--reviewed-heuristic-duplicate-groups).

## Verdict and limits

**Disposition updated 2026-09-06: user accepted CATALOG-007B as DONE after hands-on
testing and explicitly waived the remaining audit gate.** The findings below
remain historical evidence; the missing baseline has not been reconstructed.
No recovery is indicated by the verified local differences.
All existing library database rows carrying user intent are preserved. The six
logged uploads are fully identified as **six newly imported cloud captures**, not
six old pending local assets. Their originals, relationships, receipts and upload
states are consistent. Schema 37 and derived grouping/count changes are expected.

The exact provider-database delta cannot be established from the retained backup:
it contains only library.sqlite. Current kdata.db has an incident-time modification
and a Korean update-attempt record. Revision, crawl time and progress evidence
strongly support a start/status-only update, but no trustworthy pre-incident
kdata.db or complete CrawlState snapshot was found in the recorded backup set or
local acceptance artifacts. Its exact prior checkpoint/status values and all source
rows therefore cannot be compared. This is an evidence gap, not a finding of source
corruption. It prevented DONE under the original exact-source/startup audit gate;
the user waived that gate on 2026-09-06.

No restore, repair, migration, app launch, production query, sync, service operation,
Git write or deployment was performed by this audit. Do not replace the current DB:
that would discard six acknowledged captures and their upload receipts.

## Baseline and read-only method

Exact authoritative metadata comparison:

- Production: `C:\New_lakomics_assets\library.sqlite`.
- Pre-migration snapshot explicitly recorded in 007B:
  `C:\New_lakomics_assets\backups\pre-migration-20260905-092612-v36-165ef5b1-02d2-4488-af18-1f856a71d5aa.sqlite`.
- Provider inspected separately: `C:\New_lakomics_assets\catalogs\kdata.db`.

The selected backup was created at 09:26:12.730527 and completed/modified at
09:26:13.035834, immediately before the 36→37 migration. The previous migration
backup is the 06:28:35 v34 snapshot; the day's daily backup is 00:14:41. Neither is
substituted for the exact v36 baseline. The v36 snapshot precedes Library::open's
post-migration maintenance, but follows lock/directory initialization and the
journal-mode setup in db::initialize_database. It is a metadata snapshot, not a
filesystem or catalog backup.

At 09:53:46 raw filesystem copies were taken into
`C:\chatgpt\.acceptance\catalog-007b-incident-audit`. Source size, mtime, birthtime,
file identity and SHA-256 were checked before/after copying. All SQL, schema and
integrity work used only disposable copies with `mode=ro&immutable=1`. The migration
SQL was evaluated only in an in-memory SQLite database to compare expected schema.

| File | Bytes | File identity (st_ino) | SHA-256 |
|---|---:|---:|---|
| current library | 61591552 | 1970324837311201 | `12769a5182afff6060ad9274d9f110f90222f2b0bafec2d7c5bb7d97827cf57b` |
| before library | 61571072 | 3377699721133566 | `b39c4ce3a097a3ac4c4708e0cf92ffe10f2d494921b7812bffc79094fb070a48` |
| current catalog | 153190400 | 20829148276924664 | `117bf7011e6405bb4614d803f6c2fda7cd3f810522bd5c44b60df55cb2a1a720` |

Both library WALs were **0 bytes**; their SHMs were 32,768 bytes, with identical
SHA-256 `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`.
No kdata.db WAL/SHM/journal existed. The empty library WALs contain no committed
frames requiring replay. Main DB copies are independently consistent. SHM is not
a backup payload. Production sidecars were created at 09:27:37; backup sidecars at
09:28:57, both after termination; SHM mtimes are 09:38:34. These are consistent with
the earlier read inspection, not this audit. Old `kdata.db.importing-*` sidecars
belong to another basename and predate the incident (August 22).

The final filesystem fence at **10:04:31 UTC** confirmed identical size, mtime,
file identity and SHA-256 for all seven copied source files (including retained
backup sidecars). Re-enumeration of the entire library found zero added, removed
or metadata-changed files during this audit. Access times were not used as evidence.

## Complete library database comparison

Every column was compared, including timestamps, blobs, favorites, ratings, personal
metadata, ordering, trash state and configuration. Tables with primary keys were
compared by those keys; keyless data used full-row multisets. No timestamp exception
was used to hide differences. The 40→42 table union has 32 unchanged existing
tables, eight changed existing tables, and two new empty tables. **No deleted rows
in any table; no modified pre-existing user-domain row.**

| Table | Before | After | Added | Deleted | Changed |
|---|---:|---:|---:|---:|---:|
| `albums` | 1 | 1 | 0 | 0 | 0 |
| `asset_activity` | 569 | 569 | 0 | 0 | 0 |
| `asset_albums` | 15 | 15 | 0 | 0 | 0 |
| `asset_classifications` | 8017 | 8023 | 6 | 0 | 0 |
| `assets` | 8220 | 8226 | 6 | 0 | 0 |
| `classification_entries` | 57 | 57 | 0 | 0 | 0 |
| `cloud_backfill_control` | 1 | 1 | 0 | 0 | 0 |
| `cloud_backfill_scope` | 0 | 0 | 0 | 0 | 0 |
| `cloud_capture_imports` | 228 | 234 | 6 | 0 | 0 |
| `cloud_sync_queue` | 8210 | 8216 | 6 | 0 | 0 |
| `collection_assets` | 0 | 0 | 0 | 0 | 0 |
| `collection_external_bindings` | 438 | 438 | 0 | 0 | 0 |
| `collection_volume_sources` | 5 | 5 | 0 | 0 | 0 |
| `collection_volumes` | 309 | 309 | 0 | 0 | 0 |
| `collection_work_artworks` | 402 | 402 | 0 | 0 | 0 |
| `collections` | 546 | 546 | 0 | 0 | 0 |
| `legacy_package_asset_mappings` | 7417 | 7417 | 0 | 0 | 0 |
| `library_settings` | 1 | 1 | 0 | 0 | 0 |
| `manga_catalog_recovery_links` | 219 | 219 | 0 | 0 | 0 |
| `manga_series` | 24 | 24 | 0 | 0 | 0 |
| `online_catalog_blocked_tags` | 10 | 10 | 0 | 0 | 0 |
| `online_catalog_bookmarks` | 251 | 251 | 0 | 0 | 0 |
| `online_catalog_group_diagnostics` | 3 | 3 | 0 | 0 | 0 |
| `online_catalog_group_handles` | 131213 | 131213 | 0 | 0 | 0 |
| `online_catalog_group_members` | 131213 | 131213 | 0 | 0 | 0 |
| `online_catalog_group_preferences` | 0 | 0 | 0 | 0 | 0 |
| `online_catalog_group_state` | 1 | 1 | 0 | 0 | 1 |
| `online_catalog_hidden_categories` | 1 | 1 | 0 | 0 | 0 |
| `online_catalog_prepared_counts` | 6 | 6 | 0 | 0 | 6 |
| `online_catalog_review_candidates` | 0 | 0 | 0 | 0 | 0 |
| `online_catalog_review_decisions` | 0 | 0 | 0 | 0 | 0 |
| `online_catalog_settings` | 1 | 1 | 0 | 0 | 1 |
| `release_watch_events` | 0 | 0 | 0 | 0 | 0 |
| `release_watch_subscriptions` | 0 | 0 | 0 | 0 | 0 |
| `remote_reading_progress` | 35 | 35 | 0 | 0 | 0 |
| `revisit_bundle_assets` | 613 | 613 | 0 | 0 | 0 |
| `revisit_bundles` | 32 | 32 | 0 | 0 | 0 |
| `revisit_preferences` | 0 | 0 | 0 | 0 | 0 |
| `revisit_slates` | 4 | 4 | 0 | 0 | 0 |
| `similarity_reviews` | 15 | 15 | 0 | 0 | 0 |
| `sqlite_sequence` | 1 | 1 | 0 | 0 | 0 |
| `video_assets` | 376 | 379 | 3 | 0 | 0 |

Classification/folder definitions, albums, Collections/Works, volumes, sources,
external bindings, membership/order, artwork choices, legacy mappings, Revisit,
similarity decisions, visibility settings and library/cloud user configuration
all match. Nineteen trash assets retain every field; none was expired at incident
time under the unchanged 30-day retention setting. One review-state asset remains.
Activity (569 rows), bookmarks (251) and reading progress (35) match exactly.

Changes classified:

- **Authoritative additions:** six assets and six asset-classification relationships;
  three video records include authoritative media descriptors plus derived playback
  preparation. These are retained user captures, not disposable caches.
- **Operational additions:** six capture receipts and six revision-1 asset-upsert
  queue rows, all acknowledged/synced with zero retries and no errors.
- **Derived:** group state generation 2→3; its revision prefix changes from
  `strong-lineage-v1` to `strong-lineage-v1+review-v1`, retaining provider revision
  `f6161d96-1e92-4fa8-8598-36b327a50e1b`; built_at becomes 09:26:20.916687.
  Six prepared-count rows change only source_revision, generation and integrity_hash.
- **Operational timestamp:** online_catalog_settings changes only last_attempt_at,
  from 06:28:43.975176 to 09:26:21.369293. No user setting changes.

## Schema, grouping and integrity

`user_version` is 36→37. The full sqlite_schema comparison (tables, indexes,
autoindexes, triggers and views) equals the old schema plus exactly
`0037_catalog_review.sql`: two WITHOUT ROWID tables with ordered anchor-pair PKs;
the authoritative decision CHECK allows confirm/falsePositive/split. There are
no unexpected objects, altered old definitions or removed objects. Candidate and
manual decision tables are both empty, including rejection/split state.

All 131,213 member rows and 131,213 durable handle rows are identical. There are
110,493 lineage groups. Every handle anchor resolves; member/provider IDs match;
every group uses the oldest sequence handle among its members. There are 20,720
historical alias handles whose UUID differs from their current group, identically
before/after: this is expected alias resolution, not an orphan. An initial audit
predicate incorrectly treated alias equality as an invariant; it was replaced by
the actual oldest-handle rule after reading catalog_group_identity.rs.
Manual representative preferences are empty before/after; no saved choice was lost.
Group diagnostics (three rows) also match. All current Works IDs and membership
IDs have exact set parity, with no missing source/member records.

Full `PRAGMA integrity_check` returned `ok` for the before library, current library
and current catalog; `foreign_key_check` returned zero rows for all three. These
cover stored uniqueness/index integrity as well as declared relationships. Manual
cross-table checks cover the deliberately non-FK catalog anchors. Schema constraints
match the migration; with zero decisions there are no invalid decision references.

All six prepared-count checksums match their code-defined SHA-256 context. Independent
read-only SQL against the copies also recomputed each distinct visible group count
(no application preparation or rebuild was called):

| Language | Normal visibility | Reveal blocked |
|---|---:|---:|
| All | 100,981 | 106,870 |
| Korean | 100,981 | 106,870 |
| Japanese | 948 | 998 |

These equal both pre-incident and current stored scalar values.

## The six uploads: inbound capture followed by outbound replication

Each asset, classification relation, capture receipt and queue row was absent in
the v36 backup. Capture created_at is preserved as asset.collected_at and predates
the incident. All use browser_extension import provenance. The startup capture
poll imported them; ingestion enqueued normal incremental upserts. The supervisor
processes eligible pending assets even while the full-backfill control is idle.
This was not a restarted full-library seed. The four older pending queue rows are
for trash assets, are ineligible, and remain identical.

| Asset ID | Capture ID | Kind / bytes | Captured UTC | Imported UTC | Synced UTC |
|---|---|---|---|---|---|
| `dc116095-5c64-4bc6-b083-bbdb0660519e` | `103e77a3-525d-4205-93db-f3f767592589` | image / 244,554 | 2026-09-05T07:27:05.292Z | 2026-09-05T09:26:33.181914400+00:00 | 2026-09-05T09:26:45.122820100+00:00 |
| `5afb9e04-a065-47b4-be01-8f5cee441212` | `d1ec5a14-c581-4f8a-b3e0-33d66ba82dd8` | video / 1,778,403 | 2026-09-05T07:33:19.546Z | 2026-09-05T09:26:34.537531100+00:00 | 2026-09-05T09:26:45.930434200+00:00 |
| `0e692cd7-f783-4c93-b1b7-07340a8a2e84` | `d78e774f-9eb3-472c-84d5-ac7c37ecf3da` | video / 3,633,100 | 2026-09-05T07:35:10.092Z | 2026-09-05T09:26:36.031399200+00:00 | 2026-09-05T09:26:45.289577100+00:00 |
| `1cfe75f5-3b54-4c78-ba11-1d6356f4e619` | `3ca7f657-a2de-40b6-b7a1-a9ef9a75e106` | video / 14,295,076 | 2026-09-05T07:43:39.063Z | 2026-09-05T09:26:38.233453700+00:00 | 2026-09-05T09:26:45.904211100+00:00 |
| `6d2584e2-dbe7-4d15-9f55-141ec2d19ee4` | `9385aa14-8648-4a46-a585-57b11b99b81f` | image / 64,515 | 2026-09-05T07:59:32.096Z | 2026-09-05T09:26:39.298614700+00:00 | 2026-09-05T09:26:43.837151700+00:00 |
| `5932e17e-e5b3-4b01-a35f-f653a0924b09` | `9fc695a5-4be1-4264-ab65-baa54e9274b7` | image / 61,350 | 2026-09-05T07:59:34.380Z | 2026-09-05T09:26:40.621813700+00:00 | 2026-09-05T09:26:43.879024600+00:00 |

Each original exists at `assets/<first-two-hash-characters>/<sha256>.jpg` or `.mp4`;
all six targeted file SHA-256 values match assets.content_hash and sizes match.
Exact paths/hashes/classification IDs/queue IDs are retained in validation.json.
Three images have normal thumbnails/PDQ fingerprints. Three videos have ready
original playback, three posters and 34 scrub frames (8/10/16), with no missing or
empty derivative. No old asset metadata was replaced.

The log contains the same six asset IDs, six committed messages, and summary
`committed=6 retry_scheduled=0 permanent_failures=0`. The receipt path records local
import before remote acknowledgement, and marks acknowledged only after successful
acknowledgement response. Retry uses capture_id to avoid re-ingestion; content hash
handles exact duplicates. Replication prepare/commit uses durable asset identity,
with the existing already_committed path for safe retries. No replay was performed
as a test. Originals and receipts are durable state; only thumbnails/scrub files are
rebuildable. Preserving these results is safer than restoring a snapshot that lacks
them after remote acknowledgement. Remote media bytes were not independently
re-downloaded or checked; log/receipt evidence is not a fresh VPS/R2 audit.

## Automatic startup/background checklist

This checklist follows current Library::open, Tauri setup, App.tsx and their called
hooks. “No net change” does not claim a function never executed or made a same-value
SQL write. Off-machine settings/source roots were not traversed.

| Operation and current code | Eligibility and incident evidence | Classification / conclusion |
|---|---|---|
| lock.rs acquire; mod.rs create directories | Existing .lakomics.lock is empty and predates incident; opens with create, no truncate. Startup reached library UI. | File lease/directory setup; no content mutation found. |
| db.rs initialize/migrate; backup.rs snapshot | Exact v36 snapshot then schema37; full schema diff matches. Journal mode set before snapshot. | Expected additive migration and backup, not an authorized rollout. |
| book_migration.rs backfill_legacy_collection_kinds | 338 source-path/null-kind candidates before/after; all 546 collection rows match. External source-root parsing can read, but only library collection rows can be updated here. | Could run; no net legacy-kind change. |
| collection.rs normalize_showcase_orders | Synchronous SQL runs on open; all ordering/rating/personal fields match. | Same-value normalization only. |
| drag_out.rs cleanup_stale_asset_drags | .drag-out exists, empty, directory mtime September 4 06:29:13. | No incident-time staging deletion indicated; disposable drag data only. |
| similarity.rs cleanup_resolving_similarity_reviews | Zero resolving/keep_existing candidates; 15 review rows identical. | No recovery work eligible. |
| video_media.rs requeue_interrupted_video_preparation | All 376 old videos ready; their derivatives are complete and files have no incident changes. | No old video reset found. |
| cloud/queue.rs interrupted sync requeue | Zero processing/preparing/uploading/committing rows before/after. | No recovery transition eligible. |
| cloud/backfill.rs suspend running control | Control idle before/after with unchanged September 4 timestamp; scope empty. | No pause/reseed/reconcile occurred in observed state. |
| work_artwork.rs unreferenced cleanup | 402 metadata rows and all originals/thumbnails exist; all artwork directories/files predate incident. Cleanup removes files, does not remove parent directories. | No removal indicated; no authoritative artwork lost. No pre-incident manifest for already-unreferenced files. |
| work_artwork.rs thumbnail backfill | Worker eligible because artwork exists; all 402 thumbnails predate incident. | No generated thumbnail change observed. |
| catalog_preparation.rs / catalog_groups.rs | Prefix invalidation triggers generation2→3; all members/handles same; counts refreshed. Nonlegacy canonical attachment is read-only. | Fully explained derived change; grouping does not write Works/Tags. |
| useOnlineCatalogUpdate / catalog_update.rs / catalog_checkpoint.rs | Korean attempt09:26:21; current progress/completion06:28:46. Japanese state absent; initial Japanese update is explicitly gated. | Korean start/status write evidenced; exact pre-source delta unavailable (below). |
| App.tsx ensureDailyBackup | Existing daily-20260905-001441 snapshot makes ensure_daily_backup return before create/rotation. No new daily file. | No daily backup or rotation indicated; only pre-migration backup is new. |
| App.tsx purgeExpiredTrash / trash.rs | 19 trash rows, zero expired under retention30; all existing media exists. | No eligible purge or deletion. |
| useSimilarityIndex | Zero eligible normal image/gif assets with both hash/error absent before opening. Old assets unchanged. New images have ingestion fingerprints. | No old index mutation. |
| useVideoPreparation | New three videos become ready; 37 new derivative files correlate with their IDs. | Rebuildable video preparation of new captures. |
| useReleaseWatchCheck / release_watch.rs | Zero subscriptions/events; all collection rows unchanged. | No due work. |
| useCloudCaptureSync / cloud/captures.rs | Six newly acknowledged receipts; six assets and classifications. Poll also invokes classification and saved-X-media snapshot publication. | Inbound durable additions explained; two remote snapshot attempts possible, no local mutation from publication. No success log or retained remote baseline to prove publication outcome. |
| useCloudBackfillSupervisor / cloud/backfill.rs | Six eligible new normal assets committed; control idle, old four trash-pending rows untouched. | Incremental replication explained; no full backfill. |
| Tauri extension_api.rs start and worker pool | Creates/loads token outside library; handles authenticated requests rather than initiating imports. Six imports accounted by capture receipts; no extra rows/changed old rows. | No extra local ingress effect evidenced; request log is not exhaustive. OS token/profile state is outside this library snapshot. |
| media_protocol / catalog thumbnails | Ten new remote catalog thumbnails in cache during incident; other old media/artwork files unchanged. | Reproducible view cache. UI preference persistence is in browser profile, not library database; not compared here. |
| explicit review discovery/decisions, metadata import, manga scan, Revisit generation, restore | Not dispatched by the traced startup hooks; their domain tables have no unexplained deltas. Review opens list-only and generation/decisions require explicit calls. | No evidence of execution; candidates/decisions remain zero. |

The cloud-capture poll also publishes classification and saved-X-media read snapshots
after processing captures. This side effect was missed by the earlier narrow audit.
Absence of an error log alone does not establish remote publication success. This
report does not certify off-machine state or silently introduce a new deployment gate.

## Provider/source database

The current catalog has Works=131,213, Tags=1,801,048, Segments=42, CrawlState=8.
Its mtime is **09:26:50.722176**, inside the incident. Current source SHA-256 appears
above; no pre-incident provider hash is available. File identity persists from its
August22 creation, but this alone cannot rule out an in-place change.

Current facts:

- contentRevision = `f6161d96-1e92-4fa8-8598-36b327a50e1b`, exactly the suffix stored
  in the pre-incident library's generation2 source_revision and prepared counts.
- Max Works.CrawledAt = **06:28:46**. Zero Works rows have an incident-time crawl.
- Korean checkpoint: watermark=4,170,436; pending_max=4,170,436; cursor=null;
  initial_complete=true. Current Korean status last_attempt_at=09:26:21.382800;
  last_progress_at and last_completed_at=06:28:46; last_added=0; last_error=null.
- No Japanese checkpoint or status rows. No evidence of Japanese progression.
- suggestions.json mtime06:28:47; tag-ko.json and importing sidecars predate incident.

Code attribution: catalog_checkpoint::start saves checkpoint/status (resets
last_added/error, stamps attempt) before fetching. commit_stream_page publishes
Works/Tags, checkpoint and progress in one transaction; source-content differences
also change revision in that same transaction. read_work_content covers canonical
fields/tags but excludes RawJson and CrawledAt. A real page commit, even with zero
new works, stamps last_progress_at. The old progress and crawl times therefore
support interruption before any page commit; the unchanged revision supports no
canonical content publication. Group preparation uses the read-only attachment
and does not initialize an already nonlegacy revision.

**Inference:** the observed file modification is consistent with Korean start/status
metadata only. **Not established:** exact changed CrawlState rows/old values,
byte-for-byte Works/Tags/Segments equality, or directly measured pre/post Korean and
Japanese checkpoint equality. There is no catalog-source backup in the selected
metadata snapshot. This audit cannot convert those inferences into an exact row
diff. Do not claim “kdata.db unchanged” or “all checkpoints proved unchanged.”

## Filesystem and timeline

All 8,220 pre-incident asset originals still exist at the same recorded paths,
with matching sizes and no incident-time mtimes. All 8,226 current originals exist.
All 379 ready videos have complete poster/scrub/proxy requirements. All 402 artwork
originals and 402 expected thumbnails exist. No broad media rehash was performed.

Inventory file counts: assets8,232 (8,226 originals plus six old staging files),
thumbnails7,848, video-media11,255, work-artwork402, work-artwork-thumbnails402,
collection-thumbnails326, cache866, catalogs5, backups29 (including two sidecars),
plus root DB/sidecars and lock. The six staging remnants predate the incident
(August22, September1/4); they were not cleaned up.

Of 63 files created/modified since launch, 59 fall inside the incident: six new
originals, three image thumbnails, 37 video derivatives, ten catalog thumbnail
cache files, current library.sqlite, kdata.db and the pre-migration snapshot.
Four later files are the production/backup WAL/SHM sidecars noted above. Every
surviving incident-window file is categorized. No current unexpected file was found.

There is no complete pre-incident filesystem manifest. Referenced-media existence,
sizes and directory mtimes show no loss/rename in those paths; they do not prove
that every formerly unreferenced temporary file was retained. The capture/video
code intentionally creates/removes/renames temporary staging outputs. Exact
transient filenames cannot be reconstructed from the surviving files alone.

| UTC | Evidence |
|---|---|
| 09:24:55.020778 | native.log created; includes build and app launch, not an exact app-open timestamp. |
| 09:26:12.730527–13.035834 | Exact automatic v36 pre-migration snapshot created/completed. |
| After snapshot, by09:26:20.916687 | Schema37 active and group generation3 built. |
| 09:26:21.369293 / .382800 | Library Korean attempt timestamp / provider Korean attempt timestamp. |
| 09:26:32.378–40.622 | Six inbound originals/image thumbs; six imported receipts. |
| 09:26:41.175–45.089 | New video posters/scrub outputs. |
| 09:26:43.837–45.930 | Six successful replication queue timestamps; native log agrees. |
| 09:26:45.940449 | Current library main-file mtime. |
| 09:26:50.722176 | kdata.db mtime; timestamps inside SQLite are not exact flush/commit times. |
| 09:26:50.715–54.878 | Ten catalog-thumbnail cache creations. |
| By09:26:57.452760 | native.log final mtime; terminal records process exit0xffffffff. Upper bound, not a timestamped kill event. |
| 09:27:37–09:38:34 | Later sidecar creation/SHM mtimes from earlier inspection period. |
| 09:53:46–10:04:31 | This audit's snapshot and final unchanged-file fence. |

## Acceptance disposition and next evidence

The recorded isolated Tauri acceptance remains applicable: this audit made no
implementation changes. Existing backlog evidence covers restart persistence,
confirm/split, false positives and stale review tokens (7→6→7 with stale rejection).
Retained isolated/token native logs show the development launches. This audit did
not rerun native UI or independently reproduce those earlier interactions; a fresh
runtime check would require a separately isolated nonproduction library.

At the time of the audit, PARTIAL was retained because exact source delta/checkpoint
comparison was unavailable. The user waived this blocker on 2026-09-06; no further
baseline search is required for completion. The original evidence option was to
locate an independently retained, demonstrably
pre-09:26:12 catalog copy or full source/checkpoint snapshot and compare disposable
copies. No substitute snapshot should be guessed, generated by a new update, or
restored over production. If that evidence does not exist, record the limitation
and seek an explicit disposition; no further local query can reconstruct overwritten
prior values. No recovery should be performed on the evidence currently found.

Full-catalog discovery/review latency measurement, reversal of a false-positive
rejection and cross-provider grouping remain non-blocking future enhancements.
They are not the reason for PARTIAL.

Only this report and the authoritative 007B backlog entry were edited as tracked
project documentation. Ignored audit scripts, immutable copies, inventories,
row/schema diffs, validation output and the no-write fence remain under `.acceptance/`
for local review. Existing implementation/Phosphor/count-gate changes and unrelated
untracked files were preserved; no commit or push was made.
