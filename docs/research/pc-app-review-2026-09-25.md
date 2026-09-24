# PC app code review — 2026-09-25

> Status: read-only review of the desktop app (`_tools/app/src-tauri/src`, `_tools/app/src`) at `6625235`
> by eight Claude Opus 5.5 subagents, one per area, coordinated by the controller session.
> Nothing was built, run or reproduced; every finding comes from reading the code. The ten
> high findings were re-read and confirmed by the controller; medium and low findings are the
> reviewers' own and are **unverified** unless marked. Follow-up work is tracked as
> `PC-REVIEW-001` in `docs/roadmap/lakomics-backlog.md`.

## Summary

| Area | High | Medium | Low |
| --- | --- | --- | --- |
| 1. Storage, backup, trash, Private Vault | 1 | 3 | 4 |
| 2. Ingestion, query, media | 1 | 3 | 8 |
| 3. Cloud sync and authority | 4 | 4 | 5 |
| 4. Character recognition | 1 | 4 | 9 |
| 5. Online catalog, Collections, providers | 1 | 3 | 4 |
| 6. App boundary (commands, media protocol, extension API, workload) | 0 | 6 | 5 |
| 7. React main surfaces | 1 | 4 | 9 |
| 8. React shell, settings, remaining | 1 | 4 | 5 |
| **Total** | **10** | **31** | **49** |

State of the Linux production library at review time (read-only check): Album, Classification,
Asset lifecycle and bookmark outboxes were empty and there were no open similarity reviews, so
none of the blocking defects below was active.

## Confirmed high findings (controller-verified), in suggested fix order

1. **Asset re-baseline deletes local Assets** — `library/asset_authority.rs` (~575): when the Asset
   domain re-baselines (e.g. after a server DB restore), every local Asset row known to the old
   authority state but absent from the new baseline is hard-deleted, cascading Album, Collection
   and character data and orphaning files; the upload queue still says synced, so nothing
   re-uploads. Avoid server DB rollbacks until fixed.
2. **Asset lifecycle queue stops forever on a conflict** — `library/asset_authority.rs` (`flush_assets`):
   a head `conflict` row stops all later trash/restore/purge sends; nothing resolves it.
3. **Album queue stops forever** — `cloud/client.rs` / `library/album_authority.rs`: adding a not-yet-uploaded
   Asset to an Album gets `invalidAlbumMembership`, treated as a structural conflict that blocks the
   queue and Album receive. Classification treats the same case as retryable.
4. **Classification queue stops forever** — ingest queues an assignment that retries until the Asset
   uploads; if the Asset is trashed/purged first or its upload fails permanently, the head row never
   succeeds and blocks send and receive.
   (1–4: errors are dropped in `workload.rs`, and blocked/stopped counts have no UI.)
5. **One unappliable mobile character exclusion blocks all later ones** — `library/character_exclusions.rs`
   (309–347): the page transaction rolls back and the cursor never advances; `cloud/auto_publication.rs`
   returns early, skipping the rest of the character sync.
6. **Private Vault backup-index session can delete objects** — `private_vault/encrypted_runtime.rs`
   (`install_encrypted_session`), `encrypted_files.rs`, `encrypted_store.rs` (`save_index`,
   `remove_orphans`): a session opened from `index.prev.bin` blocks purge but still saves the index
   on trash/title/import, making the older index current; the next unlock's orphan cleanup deletes
   objects only the lost generation referenced and the `index.bin.tmp-*` copy. Trigger is rare
   (crash/USB removal mid-save, or a damaged `index.bin`); loss is the last save's changes.
7. **Private Vault recovery key lost on navigation** — `external-vault/VaultSettings.tsx` keeps the
   one-time key in component state; `settings/SettingsView.tsx` exits on Esc (and rail/palette/Ctrl+1/2)
   regardless of the vault's busy state.
8. **Similarity review list fails as a whole** — `library/similarity.rs` (~142–165): one open review whose
   existing Asset is no longer `normal` makes the whole list error and its decisions fail.
9. **IGDB screenshot as hero always fails** — `library/work_artwork.rs` upsert keeps the existing `kind`
   on conflict, then requires the requested kind; `igdb_flow.rs` screenshot loop collides with the hero row.
10. **Viewer stops opening after trashing an "open existing" asset** — `assets/AssetBrowser.tsx`
    (`trashViewerAsset`) clears the viewer without `onRequestedAssetHandled`, so the viewer stays bound
    to the trashed requested asset until restart.

Other controller-verified items: the restore guard has no Asset authority probe
(`library/restore_guard.rs`, found independently by reviewers 1 and 6); the native
`useAssetAuthoritySync` fires three refresh events on every window focus.

## Full reviewer reports

The reports below are reproduced as written (English), with scratchpad paths removed.

---

<!-- source: opus-1-rust-storage.md -->

## Rust storage & safety review (HEAD 6625235, read-only)

Scope: `_tools/app/src-tauri/src/library/` {db, backup, trash, legacy_package_migration, legacy_migration, book_migration, credential, error, mod, models}.rs and `private_vault/`; migrations were read for context. Everything was checked by reading the code. No code was run.

Counts: critical 0, high 1, medium 3, low 4.

---

### H1 (high, confirmed by reading): a vault session opened from `index.prev.bin` can still write, and the next unlock then deletes the newest encrypted originals

Files: `private_vault/encrypted_runtime.rs:1539-1561` (install), `:823-858` (set title), `:1118-1134` (import saves), `private_vault/encrypted_files.rs:74-111` (trash/restore), `private_vault/encrypted_store.rs:365-429` (`load_index_with_fallback`, `save_index`), `:437-455` (`remove_orphans`), `:529-545` (`remove_temp_files`).

What is wrong: in a `from_backup_index` session, only permanent deletion and sidecar-cleanup object removal are blocked. Other writes are still allowed: trash/restore, title edits, and import. Each of them calls `persist_encrypted_index` → `save_index`. `save_index` renames the damaged or newer `index.bin` to `index.prev.bin` and then installs the session's older, backup-derived index as `index.bin`. On the next unlock `index.bin` decrypts, so `from_backup_index=false` and `remove_orphans` runs. It deletes every object that only the lost newer generation referenced, as long as the object is older than 10 minutes. It also deletes the `index.bin.tmp-*` file, which may be the only complete copy of that newer index. The code comment says "a backup index ... never drives deletion", and this path breaks that promise.

Concrete scenario:
1. The newest generation is lost from `index.bin`. This happens after a crash or USB yank in `save_index` between `rename(index.bin → index.prev.bin)` (the before_commit step) and `rename(tmp → index.bin)`. Then `index.bin` is missing and the newest index exists only as `index.bin.tmp-<id>`. Bit rot in `index.bin` on a USB drive has the same effect.
2. The next unlock falls back to `index.prev.bin`. Items imported in the last batch are missing from it (up to `max(25, items/20)` files).
3. The user renames an item or trashes/restores one. The backup-derived index becomes `index.bin`.
4. At the next unlock, `remove_orphans` deletes those items' encrypted original, thumbnail and poster objects, plus the temp index. ADR-0039 treats the vault as the managed home of these files ("Files are managed only inside Lakomics"), so users may already have deleted the plaintext sources. The result is permanent loss of originals.

Fix direction:
- (a) Make a `from_backup_index` session read-only for index saves, or keep it "sticky": persist a marker, or keep the session in backup mode until the user explicitly accepts, and skip orphan GC while the marker exists.
- (b) Reorder `save_index` so that `index.bin` never disappears. Copy or hard-link `index.bin` to `index.prev.bin`, then atomically rename the temp file over `index.bin`. `std::fs::rename` replaces the target on both OSes.
- (c) At unlock, try any complete `index.bin.tmp-*` whose `revision` is higher than both generations before falling back.
- (d) Never have orphan GC remove `index.bin.tmp-*` while it decrypts to a higher revision.

### M1 (medium, confirmed by reading): restore guard has no probe for the Asset authority domain

Files: `restore_guard.rs:53-66` (PROBES: bookmarks, albums, classifications), `backup.rs:178-190`, `:196-205`, `migrations/0088_asset_authority.sql`, `0093_trash_purge_pending.sql`.

What is wrong: the module promises "Every domain whose locally adopted state a whole-database swap would corrupt". The Asset domain holds `asset_authority` (the adoption marker plus the cursor), `asset_authority_state`, `asset_lifecycle_outbox` and `asset_purge_pending`, and none of these is probed. The asset lane (`authority_pass.rs:160`, `asset_authority.rs:597`) adopts independently of the other three domains.

Scenario: a library has adopted Asset authority but has not yet adopted albums, classifications or bookmarks. For example, the asset lane ran but the other lanes failed or are disabled. The user restores a daily backup, or `restore_cloud_metadata_snapshot` runs. The swap then:
- discards queued lifecycle intents (trash/restore/tombstone) that the server has not accepted;
- discards `asset_purge_pending` rows. An accepted purge's recorded file paths are lost, so those files are orphaned forever, and a queued tombstone vanishes while the Asset stays trashed locally;
- rolls the cursor back.

Fix direction: add an `assets` probe: `EXISTS(SELECT 1 FROM asset_authority WHERE singleton=1)`, guarded by a table-exists check for pre-v88 databases.

### M2 (medium, plausible): cross-runtime vault orphan GC can delete objects of an import still running in another runtime

Files: `encrypted_runtime.rs:1118` (`SAVE_EVERY.max(existing.len() / 20)`), `:1549-1550`, `encrypted_store.rs:47-50` (`ORPHAN_SAFETY_WINDOW` = 10 min).

What is wrong: the safety window assumes that an import saves its index within 10 minutes of writing an object. But the save interval grows with vault size. With 10,000 items it saves every 500 files, which for videos easily takes more than 10 minutes. Each `Library::open` creates a fresh `EncryptedVaultRuntime` (`mod.rs:366`), and an import "runs to completion ... only a lock, a removed vault or app exit stops it".

Scenario:
1. A library switch (or a second window) happens during a long import. Runtime B auto-unlocks with the remembered key, and its `install_encrypted_session` calls `remove_orphans`. That deletes runtime A's unsaved objects that are older than 10 minutes.
2. Runtime A then saves an index that references the deleted objects. Those items are broken and cannot be read or exported. The report said they were imported, so the user may delete the sources.
3. Runtimes A and B also each save their own whole in-memory index, so the last writer wins: B's trash/title/purge edits or A's imports are silently lost, and a lost import then becomes orphan GC input.

Fix direction: save the index on a time bound (for example every 1-2 minutes) as well as on count, and keep that bound well under the window. Better, add a vault-level cross-process lock file or lease so only one runtime writes or GCs at a time. Alternatively, re-read and merge the on-disk index revision before saving.

### M3 (medium, plausible): legacy package migration can map an item onto an Asset that is pending purge

Files: `legacy_package_migration.rs:710-718`, `:774-785`, `trash.rs:616-620`.

What is wrong: an existing Asset with the same `content_hash` is reused. If its status is `trash`, the code calls `restore_asset`. For an Asset in `asset_purge_pending` (emptied from the trash and waiting for the server tombstone), `update_trash_status_in_transaction` changes 0 rows and returns `Ok`. The migration then reports `ExactTargetReused`, merges metadata and classifications, and writes `legacy_package_asset_mappings` onto an Asset that `retire_local_row` will delete when the tombstone is accepted.

Scenario: the user empties the trash (the Asset is server-known, so the purge is pending) and then runs the legacy import that contains the same image. The import reports success, but the image disappears after the next sync. A re-run reports `AlreadyMapped`, then fails on "a mapped target asset is missing".

Fix direction: have `ensure_migration_asset_normal` check `asset_purge_pending` (or check the restore's changed-row count) and return an error, or ingest a fresh copy. Severity is capped because legacy migration is normally a one-time operation.

### L1 (low, confirmed): pre-restore and pre-migration snapshots are never rotated

`backup.rs:223-225` and `db.rs:151-153`. Each restore, and each migration run on open, adds a full copy of `library.sqlite` to `backups/`. Only `daily-*` backups are rotated (`backup.rs:366-383`). With a large catalog database, repeated restores or upgrades fill the disk without limit. Fix: keep the newest N of each kind, or show them in the UI with a delete action.

### L2 (low, confirmed): every backup listing opens each backup read-write and runs `quick_check` on it

`backup.rs:291-306`, `:569-590`. Calls such as `list_backups`, `ensure_daily_backup` (twice: listing plus rotation) and `restore_backup` open every backup with `Connection::open`, which is read-write and create-capable, and run `PRAGMA quick_check`. They do this while holding `backup_lock`, and `ensure_daily_backup` also holds `database_lock` during the snapshot. On a library with large backups this is slow startup I/O, and it can create `-wal`/`-shm` sidecar files in `backups/`. Fix: parse file names for listing, and verify only the selected backup at restore time (read-only flags).

### L3 (low, plausible): Windows `CredReadW` with an empty blob is UB

`credential.rs:258-263`: `slice::from_raw_parts(CredentialBlob, CredentialBlobSize)` is undefined behavior when a generic credential has an empty blob (`CredentialBlob` may be NULL). This can happen with a `Lakomics/...` target created by another tool or `cmdkey`. In debug builds Rust's precondition check aborts the process. Fix: when `CredentialBlobSize == 0` (or the pointer is null), return `Some(Vec::new())` or `None` without calling `from_raw_parts`. Minor: the vault master key copies in `write()` (`value.to_vec()`) and in `read()` are never zeroized.

### L4 (low, plausible): the authority-path purge deletes a local-only row without a `status='trash'` guard

`trash.rs:429-431`: after deleting the files, the code runs `DELETE FROM assets WHERE id=?` without the `AND status='trash'` guard used by the legacy path (`trash.rs:474`). `trash_lock` serializes user restore. But writers that don't hold `trash_lock` can run between the partition transaction and the final delete: the sync `local_projection` (`asset_authority.rs:118`), `similarity.rs:383`, and `classification.rs` status updates. If one of them changes the row, its files are already gone and the row is still deleted. The damage is limited, since the user had already asked to purge. Fix: add `AND status='trash'`, and do the partition, file delete and row delete under one consistent check.

---

### Checked and found sound (no finding)

- **Vault crypto (`crypto.rs`):**
  - Per-object HKDF key with a fresh 32-byte salt.
  - Nonce = chunk index plus final flag, which is unique per derived key.
  - AAD binds vault id, object id, header, index and final flag, so truncation, extension, reordering and cross-object or cross-purpose swaps all fail.
  - PBKDF2 iteration count bounded above and below.
  - Wrap AAD binds the kind and vault id.
  - `ObjectReader` authenticates the last chunk before trusting the length.
  - Keys are zeroized.
  - One known trade-off: rollback to `index.prev.bin` is not authenticated as "latest". The design accepts this.
- **Vault export:** the destination is canonicalized and must not be under the vault root. File names are sanitized, including Windows reserved names. Writes go through a temp file, then a `create_new` reservation, then a rename.
- **Trash file deletion:** `unshared_paths` refuses top-level paths and paths shared with another Asset, video derivative or manga thumbnail. The Linux primitive (`linux_fs::delete_managed`) uses `O_NOFOLLOW` plus quarantine with an identity check. The Windows primitive uses `FILE_FLAG_OPEN_REPARSE_POINT` plus a final-path containment check.
- **Two-phase purge:** accepted-row deletion re-checks that the Asset is tombstoned and has no local row.
- **Restore swap:** intent file, then pre-restore snapshot, then migrating the temp copy, then the rename pair, with rollback. An interrupted restore blocks `Library::open`. Lock order (backup → catalog_file write → database) matched the other paths I sampled.
- **Migrations:** they run in one transaction with `foreign_key_check` before commit, and a pre-migration snapshot is taken first.
- **Media resolution (`open_library_media`, `open_manga_media`):** canonicalize plus a `starts_with` root check.

### Coverage

- **Deep:** trash.rs; backup.rs; private_vault/crypto.rs; private_vault/encrypted_store.rs; private_vault/encrypted_files.rs (trash, purge, export); the private_vault/encrypted_runtime.rs parts covering session install, unlock/create, title, import loop, import_one and sidecar cleanup; restore_guard.rs (context); asset_authority.rs purge/retire (context); linux_fs::delete_managed (context).
- **Skimmed:** db.rs (open/initialize/migrate/prepare_snapshot_for_restore, not the tests); mod.rs (open, connection, media resolution); legacy_package_migration.rs (execute path only); credential.rs (Windows backend plus the linux.rs outline); error.rs (message formats); migrations 0088/0090/0093/0094.
- **Not reached:** legacy_migration.rs and book_migration.rs beyond a grep for file writes (neither deletes or moves source files); models.rs; private_vault/{discovery, index, scan, android_fixture}.rs beyond a grep; encrypted_runtime.rs import_sidecar and the legacy-index reader in detail; per-migration SQL correctness for 0001-0087.

---

<!-- source: opus-2-rust-ingest-media.md -->

## Opus-2 review: Rust ingestion / query / media (HEAD 6625235)

Read-only review. No commands beyond reading/grep were run; nothing was compiled or executed.
"Confirmed" = established by reading the code paths end to end. "Plausible" = depends on
runtime/library behaviour (SQLite, ffmpeg, image crate) not exercised here.

### Verdicts on the inherited leads

| Lead | Verdict |
|---|---|
| video_media.rs:507-547 leftover `video-media/<id>` after DB failure | CONFIRMED, low severity (finding L1) |
| video_media.rs:809,866-898 Windows 1 GiB job limit also on proxy transcode | CONFIRMED in code: `run_tool` -> `run_similarity_tool` -> `SimilarityProcessJob` for every ffmpeg/ffprobe call incl. `create_proxy`/scrub. Impact plausible only for very large (8K / heavy-thread HEVC) sources; folded into M2 |
| ingestion.rs:1057-1060 Windows `rename_no_replace` = `fs::rename` | CONFIRMED, low (L3): only used for unique-UUID quarantine names and the restore-after-mismatch path |
| ingestion.rs:288-298 empty thumbnail quarantined to `.<uuid>.orphan`, never deleted | CONFIRMED, trivial (L4): zero-byte file, deliberately preserved; no cleanup exists anywhere (`grep orphan`) |

### Findings (most severe first)

#### H1. An open incoming similarity review whose *existing* asset leaves `normal` breaks the whole review list and strands the candidate
- Severity: high. Confidence: confirmed by reading (purge sub-point plausible).
- Where: `similarity.rs:142-165` (`review_asset(&row.existing_asset_id, "normal")?` inside the page `collect`), `similarity.rs:337,412,433` (`verify_asset_status(existing, "normal")`), `trash.rs:607-629` (trash never touches `similarity_reviews`), migrations `0090_historical_similarity.sql:29-39` (stale triggers only for `review_kind='historical'`).
- What: incoming (`review_kind='incoming'`) reviews are never invalidated when their existing asset is trashed. `list_similarity_reviews` then returns `AssetNotFound` for any page containing that row, and every decision on it returns `SimilarityReviewConflict`.
- Scenario: (a) two captures C1, C2 both near-duplicates of X -> two open reviews on X; user picks "replace existing" on C1 -> X trashed -> review C2 now fails: since pages are ordered oldest-first, the review screen shows an error instead of any reviews, and C2 stays in `status='review'` forever (invisible, and re-capturing the same bytes just returns `ReviewPending`). (b) Same from trashing X in the grid, or X being trashed by cloud authority reconciliation from another device.
- Additionally (plausible): `similarity_reviews.existing_asset_id ... ON DELETE SET NULL` combined with the CHECK `status='open' ... existing_asset_id IS NOT NULL` means purging X from trash should fail the DELETE with a CHECK violation while such a review is open.
- Fix direction: extend the stale trigger (or trash/purge code) to incoming reviews - e.g. on existing leaving `normal`, mark the review stale and return the candidate to `normal` (or re-queue it for review); make the list skip/omit rows whose assets are not in the expected state instead of failing the page.

#### M1. Manga catalog recovery: candidate pool is the 2,000 oldest works with a matching page count; artist search is dead code; full catalog scans under the global DB lock on every manga scan
- Severity: medium. Confidence: logic confirmed by reading; cost plausible (catalog size not measured).
- Where: `manga.rs:750-775` (pool), `manga.rs:776-812` (artist branch), `manga.rs:461-541` (`preview_catalog_recovery` holds `library.connection()` for the whole ranking loop), `manga.rs:161-172` + `manga.rs:132` (called from every `scan` while unresolved links exist); indexes: `catalog_preparation.rs:220-222` (no index on `FileCount`).
- What: `page_count > 0` is always true for scanned series (empty folders are skipped, `manga.rs:291-294`), so the artist-based query never runs. The page-count query is `WHERE Expunged=0 AND FileCount BETWEEN ... ORDER BY Id LIMIT 2000`: in a large catalog a common page count (e.g. 20-30) matches far more than 2,000 works, so the pool is simply the lowest IDs and the real work (usually a newer ID) is excluded; only the "ID digits" path can still find it. Each Fallback item also triggers an unindexed scan of `catalog.Works` plus a 2,000-placeholder `Tags` lookup, all while holding `database_lock`, which blocks every other DB call in the app.
- Scenario: user with a few hundred unmatched series opens recovery (or just runs a manga scan while legacy links are unresolved): the app's DB access stalls for the duration, and most Fallback items show no candidates even though artist + title would identify them.
- Fix direction: query by artist tokens first (the `IdxTagsLookup(Namespace,Value)` index exists; avoid `lower(t.Value)` which defeats it), use page count only as a scoring signal; compute the preview on a separate read-only connection (or drop the lock between items); don't run the full preview inside `scan`.

#### M2. Video preparation: 30-minute hard deadline for full-file ffmpeg passes, held under `video_lock`
- Severity: medium. Confidence: plausible (timing not measured).
- Where: `video_media.rs:565-580` (`run_tool` deadline 30 min, no progress-based extension), `video_media.rs:157-196` (scrub frames decode the entire file, no seeking), `video_media.rs:198-222` (full proxy transcode), `video_media.rs:238-241,406-409` (`video_lock` held for the whole preparation), `video_media.rs:866-898` (Windows 1 GiB per-process job limit on all of these).
- What: any non-direct-playback video (HEVC/ProRes MOV, etc.) needs a full decode for scrub frames and a full decode+encode for the proxy. For long high-resolution sources a software pipeline can exceed 30 minutes per step; the process is killed, the asset is marked `failed`, and "retry" repeats the identical failure. While this runs, `video_lock` blocks `prepare_upload_video` (cloud upload of that/other videos) and similarity frame extraction.
- Scenario: a 60-90 min 4K HEVC phone recording on Linux (`libx264`) or a weaker Windows PC: preparation fails every time; the video never gets a poster or playback proxy. On Windows, an 8K source (or high thread-count HEVC decode) can also hit the 1 GiB commit limit and fail the same way.
- Fix direction: scale the deadline with `duration_ms` (or use an inactivity/progress timeout via `-progress`), seek-based scrub extraction (`-ss` per frame or `select`/`-skip_frame nokey`), a faster encoder preset for proxies, and a larger or preparation-specific memory limit than the similarity profile.

#### M3. `thumbnail_recompress` tool writes EXIF-unrotated thumbnails
- Severity: medium (silent bulk corruption of derived data; originals safe). Confidence: confirmed by reading.
- Where: `thumbnail_maintenance.rs:268-277` (`reader.decode()` then `encode_thumbnail_webp`), versus ingestion `ingestion.rs:792-798` (`apply_orientation`).
- What: the recompression path decodes the original without applying the EXIF orientation, unlike ingestion. `image` 0.25 `decode()` does not auto-orient.
- Scenario: `thumbnail_recompress --apply --all` on a library with legacy lossless thumbnails of phone JPEGs (Orientation 6/8): every such thumbnail is replaced by a sideways one; nothing detects or repairs it later (the new thumbnail is lossy so it is never selected again).
- Fix direction: reuse `decode_staging_image`-style decoding (`into_decoder` + `orientation()` + `apply_orientation`).

#### L1. `prepare_video`: an installed final directory survives a failed DB commit and blocks every retry (lead 1)
- Severity: low. Confidence: confirmed by reading.
- Where: `video_media.rs:514-546`, `video_media.rs:256-258`, `video_media.rs:274-292`, `video_media.rs:294-341`.
- What: after `install_prepared_directory` renames into `video-media/<id>`, a failure in the following transaction returns an error; `mark_video_failed` sets `failed`. `retry_video_preparation` sets `pending`, but `prepare_video` then hits `final_directory.exists()` and fails forever. Startup recovery only handles `processing`/`ready`, not `failed`.
- Scenario: SQLITE_BUSY/IO error (5 s busy timeout) at that point -> the video can never be prepared again without manual deletion.
- Fix direction: on DB failure remove the just-installed directory, or have `prepare_video` call `remove_video_derivatives` when a stale directory exists for a `pending` row.

#### L2. Revisit: trashing any asset shown today breaks bundle and color reshuffles for the rest of the day
- Severity: low. Confidence: confirmed by reading.
- Where: `revisit.rs:69-73` (`save_daily_slate` requires every asset of every bundle to be `normal`), used by `reshuffle_revisit_bundle` (159-186), `append_color_bundle` (673-682), `reshuffle_color_bundle` (684-695); `get_or_create_revisit_slate` returns the stored slate unchanged.
- Scenario: user opens Revisit, trashes one image in bundle A, then presses shuffle on bundle B -> `AssetNotFound`; the color bundle can no longer be appended. Only "reshuffle all" recovers.
- Fix direction: drop non-`normal` ids from the loaded slate before re-saving (or filter in `load_daily_slate`) instead of rejecting.

#### L3. Windows `rename_no_replace` silently replaces (lead 3)
- Severity: low. Confidence: confirmed by reading.
- Where: `ingestion.rs:1057-1060`; used by `claim_path` (1046), `restore_unverified_file` (1054), thumbnail recovery (293).
- What: `std::fs::rename` on Windows uses `MOVEFILE_REPLACE_EXISTING`. Quarantine targets are fresh UUID names, so the realistic exposure is only `restore_unverified_file`, where an external writer that recreated the original path in the window would be overwritten - the exact race this code is written to defend against.
- Fix direction: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` (fails with ERROR_ALREADY_EXISTS).

#### L4. Recovered empty thumbnails accumulate as `.<uuid>.orphan` (lead 4)
- Severity: low (zero-byte files). Confidence: confirmed by reading.
- Where: `ingestion.rs:288-298`. Nothing ever removes `*.orphan`.
- Fix direction: delete the quarantined file after the identity/length re-check succeeds, or sweep `*.orphan` in maintenance.

#### L5. Manga covers: non-atomic write can leave a permanent empty/partial cover; AVIF pages never produce covers
- Severity: low. Confidence: confirmed by reading (16-bit PNG encoder failure plausible, based on the image-webp encoder supporting 8-bit only).
- Where: `manga.rs:410-428` (`File::create(target)` before encoding), `manga.rs:334-346` (only regenerates when `!thumb_path.exists()`), `manga.rs:319-324` (`unchanged` also only checks existence), `Cargo.toml:30` (no `avif` feature while `list_page_files` accepts `.avif`).
- Scenario: a series whose pages are all 16-bit PNG (WebP encode fails after the file is created) or a scan killed mid-write leaves a 0-byte/truncated `<id>.webp`; it is never regenerated and the cover stays broken. All-AVIF series never get a cover and are re-decoded and re-written to the DB on every scan.
- Fix direction: write to a temp file and rename; treat a zero-length cover as missing; convert to 8-bit before encoding; skip AVIF for thumbnails explicitly.

#### L6. Direct playback decision ignores pixel format/profile
- Severity: low. Confidence: plausible (WebView codec support).
- Where: `video_media.rs:955-963` (`direct_playback`), `parse_probe` (975-1026) does not record `pix_fmt`/profile.
- Scenario: an MP4 with H.264 High 10 or 4:2:2/4:4:4 is classified `original`; WebView2/WebKitGTK cannot decode it, so playback is black/fails and no proxy is ever made.
- Fix direction: require `pix_fmt` `yuv420p`/`yuvj420p` (8-bit) for `original`; otherwise transcode.

#### L7. Scrub frames fail permanently when the video stream is shorter than the container duration
- Severity: low. Confidence: plausible.
- Where: `video_media.rs:486-503` (every `NNN.webp` required), `scrub_timestamps_ms` uses `format.duration` (`parse_probe` 1011-1019).
- Scenario: MP4 where audio runs past the last video frame (common in edited clips): the `fps` filter stops at the end of the video stream, fewer than `count` frames are written, preparation fails every time.
- Fix direction: use the video stream duration, or accept and record the number of frames actually produced.

### Checked and found no reportable defect
- `notes.rs` (AES-GCM seal/open with per-note AAD and random nonces, revision/conflict handling, sync push/merge races): no issues found.
- `album.rs` (sibling-name unique index, cycle check, cascade + intents): no issues.
- `metadata_import.rs` (single-component filename, canonical parent check, symlink escape, size/item caps): no issues.
- `statistics.rs`, `query.rs` (scoped SQL rewrite, cursors, count query), `similarity_scan.rs`, `video_similarity/` (scan, review, verification handles), `revisit_color.rs`: no defects with a concrete failure scenario. Note: `query.rs` `anchor_bound` compares a local calendar date against UTC `collected_at`, but `aroundDate` is always `null` in the current frontend (`AssetBrowser.tsx`), so it is latent only.
- `ingestion.rs` core path (staging, hash, reuse of an identical unregistered original, `persist_noclobber`, PendingFiles rollback, materialization identity checks): no data-loss path found.

### Coverage
- Deep: `ingestion.rs` (non-test), `video_media.rs` (non-test), `similarity.rs` (non-test), `similarity_scan.rs`, `manga.rs` (non-test), `revisit.rs` (non-test), `notes.rs` (non-test), `album.rs`, `metadata_import.rs`, `thumbnail_maintenance.rs`, `video_similarity/scan.rs`, `video_similarity/review.rs`; relevant migrations (0003, 0008, 0027, 0045, 0090) and `mod.rs` media/manga serving.
- Skimmed: `query.rs` (non-test), `statistics.rs`, `revisit_color.rs`, `video_similarity/fingerprint.rs`, `trash.rs` (only the trash status update), `db.rs::open_database`.
- Not reached: `*_tests.rs` and in-file test modules (only for intent), `image_fingerprint.rs` internals, `video_similarity/models.rs`, `drag_out.rs`, `remote_media.rs`, `work_artwork.rs`, `backup.rs`, `trash.rs` purge internals (so the purge-CHECK part of H1 is not traced end to end), frontend callers apart from the `aroundDate` check.

---

<!-- source: opus-3-rust-cloud-sync.md -->

## Rust cloud sync / authority review (opus-3)

HEAD 6625235 (main). Read-only review; no files in the repository were modified, nothing was built or run.
Paths are relative to `_tools/app/src-tauri/src/` unless noted. Server files were read only to confirm contract behaviour.

Counts: high 4, medium 4, low 5; 2 of the 4 inherited leads rejected as practical defects.

---

### High

#### H1. Adding a not-yet-replicated Asset to an Album blocks the Album domain permanently
- Severity: high. Confidence: confirmed by reading (PC code + server code + server test).
- Where: `library/album.rs:239-257` (enqueue on every membership add, no ownership check) -> `library/album_authority.rs:385` `enqueue_album_membership_intent`; server `server/lakomics-api/album_authority.py:1043` -> `asset_authority.require_linkable(adding=True)` fails `422 invalidAlbumMembership` when the Asset is not committed; PC `cloud/client.rs:2999` maps `invalidAlbumMembership` to `AlbumRejection::Structural` -> `library/album_authority.rs:560-566` `block_entry`.
- What is wrong: a new local Asset exists on the server only after the replication lane commits it (seconds to minutes; longer for videos, a backlog, or lightweight mode). The authority pass is woken right away by `note_local_work`, so a membership intent for a fresh import is sent before that commit. The server rejects it with a coded structural error, and the PC blocks the row. Blocked rows are never cleared (no resolution command exists), and `authority_pass.rs:246` skips Album receive whenever the flush reports `stopped`.
- Failure scenario: the user imports a batch and immediately selects it and runs "add to album". Every later Album edit on this PC stays queued forever, remote Album changes stop arriving, and nothing is shown to the user (see M3).
- Classification already handles the same cross-domain ordering state as retryable (`invalidClassificationAssignment`, `cloud/client.rs:3097-3104`). ADR-0037 lists `invalidAlbumMembership` as structural, but it did not anticipate this case.
- Fix direction: treat `invalidAlbumMembership` for an Asset that is still local-only or queued for replication as retryable (or defer enqueueing membership intents until the Asset has `asset_authority_state`), and keep the structural block only for Assets the server should already know.

#### H2. A Classification assignment for an Asset that never replicates wedges Classification send and receive forever
- Severity: high. Confidence: confirmed by reading.
- Where: `library/ingestion.rs:574-580` (the assignment intent is queued at ingest for every local Asset); `library/classification.rs:383, 492`; `cloud/client.rs:3097-3104, 1344-1347` (`invalidClassificationAssignment` -> `Retryable` -> `Err(ClassificationCommandOutcomeUnknown)`); `library/classification_authority.rs:848` (the `?` aborts the flush at the head row); `library/authority_pass.rs:265-286` (receive runs only after a successful, unstopped flush); `library/classification_reconciliation.rs:151` (receive also requires a clean outbox).
- What is wrong: the "retry until Asset replication catches up" assumption fails when replication never catches up:
  - The backfill claim requires `asset.status='normal'` (`cloud/backfill.rs:900-915`), so an Asset trashed before it replicates is never committed.
  - `purge_candidates` removes only `cloud_sync_queue` and `asset_lifecycle_outbox` rows (`library/trash.rs:411-416`). It leaves the `classification_authority_outbox` row for a purged local-only Asset.
  - Permanent replication failures (`CloudSourceChanged`, a missing source, a thumbnail that is never ready) leave the Asset uncommitted.
- Failure scenario: the user ingests an image into a folder, notices it is wrong, and trashes or empties it within the upload window. The head assignment is retried on every pass, forever. No later Classification intent is sent and no remote Classification change is applied on this PC, silently.
- Fix direction: when an Asset is trashed or purged before it has server state, drop or rewrite its queued assignment intents in the same transaction. Or skip or park a head assignment whose Asset has no chance of committing (no pending `cloud_sync_queue` row) so it cannot block the queue behind it.

#### H3. Asset lifecycle outbox: any `conflict` row blocks every later trash/restore/purge, with no way to resolve it
- Severity: high. Confidence: mechanism confirmed by reading. The trigger needs a second writer (another PC on the same library), or any coded rejection.
- Where: `library/asset_authority.rs:688-694` (head row `status='conflict'` -> `stopped`, return); set at `:766-772` (revision conflict whose current lifecycle is `tombstoned`) and `:777-783` (any `AssetAuthorityRejected` code: `assetNotFound`, `authorityLibraryMismatch`, `operationConflict`, `lifecycleTransitionRefused`, uncoded 404/409/422). No production code deletes or updates `conflict` rows (grep for `asset_lifecycle_outbox` outside tests: only `trash.rs:415`, which deletes non-tombstone rows of purged Assets).
- What is wrong: `local_projection` (`:96-116`) prefers the newest outbox `desired` over confirmed state, so a conflicted intent also keeps the local row in the rejected state indefinitely.
- Failure scenario: PC-A empties the trash and the server tombstones X (r3). PC-B has not polled yet (idle backoff is up to 60 s) and restores X (expected r2). The server returns `revisionConflict` with lifecycle `tombstoned`. PC-B applies it, but the local status stays `normal` because the outbox desire wins. The row is marked `conflict`, and from then on no trash, restore or purge from PC-B reaches the server. `AssetSyncResult.stopped` is discarded (`authority_pass.rs:211`), so nothing is visible.
- Fix direction: a conflict against a tombstone is terminal. Drop the intent and retire the local row (the `resolve_tombstone_conflict` pattern). For other coded rejections, park the row per Asset instead of blocking the global FIFO (lifecycle commands for different Assets are independent), and surface the count.

#### H4. Re-baselining the Asset domain hard-deletes local Asset rows the new baseline does not list
- Severity: high. Confidence: mechanism confirmed. The scenario is plausible: it is the recovery path ADR-0038 §9 prescribes.
- Where: `library/asset_authority.rs:575-583` inside `install_asset_baseline`, reached from `need_baseline` (epoch/library/contract change) and from `cursorExpired | cursorAhead | baselineChanged` (`:478-488`).
- What is wrong: every id in `asset_authority_state` that is missing from the new baseline gets `DELETE FROM assets WHERE id=?`. PC-created Assets have `asset_authority_state` rows too, once their replication commit arrives through the change feed. The delete cascades to `asset_albums`, collection volumes, `video_assets`, character rows and the other FK-cascaded tables. It bypasses `retire_local_row` / `asset_purge_pending`, so files are orphaned rather than deleted under the ADR-0038 §7a guards. The queue rows for those Assets are `synced`, so nothing ever re-uploads them.
- Failure scenario: the server is restored from a backup taken before some recent PC imports (the documented rollback, "restore the server authority backup + rebuild client replicas"). The PC sees `cursorAhead` or a new epoch and installs the baseline. Every Asset the server lost disappears from the PC library together with its organisation, although the PC holds the only original. This is data loss driven by server state.
- Fix direction: never delete a local row whose bytes originated on this PC (`server_created=0`). Drop its authority state and re-queue replication instead. For server-created rows, retire them through `retire_local_row` so file handling and crash recovery apply. Consider requiring an explicit confirmation when a re-baseline would remove more than N local Assets.

---

### Medium

#### M1. An epoch change with any queued Asset lifecycle intent wedges the Asset lane permanently
- Confidence: confirmed by reading. `library/asset_authority.rs:574`: `install_asset_baseline` returns `invalid()` if any outbox row has another library, epoch or contract. The baseline must be installed before `flush_assets` runs (`:476-509`), and no code rebases or drops old-epoch lifecycle rows (Album and Classification at least block and continue, e.g. `album_authority.rs:529-540`).
- Scenario: the server re-activates the Asset domain (new epoch) while the PC has a queued trash (offline, or a conflict row from H3). Every Asset pass then fails before baseline, flush, purge-file deletion and materialization, forever and silently.
- Fix: before installing, rewrite old-epoch rows against the new baseline (expected revision = new projection revision) or park them; do not make them a precondition for receiving.

#### M2. The materialization retry loop re-downloads the full original on every pass forever
- Confidence: mechanism confirmed; the trigger is plausible.
- Where: `library/asset_authority.rs:795-829` (candidates = `materialization='pending'`, with no attempt count, backoff or `last_error` filter); the download happens before the identity check in `materialize_asset` (`:866-879`); `library/ingestion.rs:167-170` returns `InvalidCloudResponse` when a local Asset with the same `content_hash` has a different id (`find_asset_by_hash` includes trashed rows, `ingestion.rs:480-489`).
- Scenario: the PC holds a local-only (never committed, e.g. trashed) Asset with bytes H. The same image is saved from mobile and the server promotes it to canonical Asset S. On every pass (5-60 s) the PC downloads S's original (up to 512 MB), fails the identity check, records `identityOrIntegrityConflict`, and repeats. Up to 25 such Assets are retried per pass.
- Fix: mark identity conflicts as `materialization='conflict'` (the column already allows it) or back off by attempt count. Check `find_asset_by_hash` before requesting a media ticket.

#### M3. Wedged or blocked sync states are invisible: authority pass errors and stopped lanes are never recorded (inherited lead 3, confirmed)
- `workload.rs:419`: `run_authority_pass().unwrap_or_default()` swallows `authority_client` failures (locked keyring, config). `:442`: `run_asset_lane(..).unwrap_or(false)` swallows Asset errors.
- `AssetSyncResult.stopped` / `materialization_failures` are dropped (`authority_pass.rs:211`).
- `album_sync_status` / `classification_sync_status` (with `blockedCount`) exist only in `src/library/client.ts:244-247` and `types.ts`. No component renders them.
- `record_cloud_metadata_activity*` is called only from `cloud/captures.rs` (JS-timer-driven capture poll), so a locked keyring shows up only if that lane runs. Contract, identity or conflict failures of the authority pass never show up.
- Effect: H1-H3 and M1 are silent. The user has no signal that Album, Classification or lifecycle sync stopped.
- Fix: record a per-domain authority outcome (reason code, blocked count) in `cloud_activity` or a sibling row, and surface it next to the replication status.

#### M4. "동기화 상태 복구" (reconcile) races a running replication cycle and causes duplicate uploads
- Confidence: confirmed by reading. `cloud/backfill.rs:168-181` resets `preparing/uploading/committing` rows to `pending` without taking `replication_lock`. The Settings button (`src/settings/CloudBackfillSettings.tsx:143-147`) is not disabled while the native 2-second replication lane is uploading.
- Scenario: the user clicks it during an upload. Another worker in the same cycle re-claims the reset row and uploads the same original concurrently (large videos double the bandwidth). The first worker's `mark_cloud_sync_synced` can mark the row synced while the second is mid-upload. The second worker's commit or failure then hits `InvalidCloudSyncQueueItem`, which aborts that worker for the cycle. The server calls are idempotent, so there is no data loss.
- Fix: take `replication_lock` in `reconcile_cloud_backfill` (and only reset in-flight rows when no cycle holds it).

---

### Low

#### L1. The bookmark lane makes extra unconditional status reads (inherited lead 1, confirmed)
`authority_pass.rs:292-301`: after the conditional read, `flush_catalog_bookmark_outbox_with` -> `resolve_authority` (`bookmark_outbox.rs:165`) does an unconditional `GET /v1/mobile-catalog/status`. After a send, `reconcile_catalog_bookmarks_with` (`bookmark_reconciliation.rs:245`) does another. This only happens while intents are pending. If they cannot be delivered (`bookmarkWrite` false, contract mismatch), one extra unconditional GET repeats on every pass indefinitely. Fix: pass the already-read `MobileCatalogAuthority` into the flush.

#### L2. A failed commit-payload read leaves a replication row stuck in flight until restart
`cloud/backfill.rs:776-778` and `:817-819`: a `backfill_commit_payload` error returns without `backfill_failure`. The row stays `uploading` or `committing`, counts as an active worker, and blocks newer revisions of that Asset (the claim's `busy` check) until reopen or reconcile. The trigger is rare (the Asset row vanishes during upload). Fix: route the error through `backfill_failure`.

#### L3. The capture poll has no native single-flight
`commands.rs:2728-2743`. `SettingsView.tsx:649` ("sync now") and `useCloudCaptureSync` can run `sync_next_cloud_capture` concurrently. Both can download the same capture. A `ReviewPending` outcome can create two similarity reviews, with `cloud_capture_reviews` pointing at the second. The second ACK can be counted as a failure. Fix: a `try_lock` single-flight inside `sync_next_cloud_capture`.

#### L4. The bookmark receive does not compare-and-set its cursor
`library/bookmark_reconciliation.rs:429-470`: `apply_page` writes `cursor=next_after` without checking that the stored cursor still equals the page's `after`. An explicit `reconcile_catalog_bookmarks` running beside the coordinated pass can apply an older page after a newer one. That transiently rewinds the cursor and re-applies older rows. The next pass converges it. Other domains guard this (`classification_reconciliation.rs:703+`).

#### L5. The idle backoff can be overwritten by a racing Asset lane (inherited lead 2)
- Mechanism confirmed: in `workload.rs:412-449`, `FinishPass` drops after the Asset thread is spawned. `changed_elsewhere` during `running=true` followed by `finished(false)` would set idle to 1.
- Practically unreachable: `run_asset_lane` returns true only after network I/O (catch-up, flush or materialization), which takes far longer than the microseconds between the spawn and the drop.
- Impact if hit: one 15 s wait instead of 5 s. Listed for completeness; no fix needed beyond finishing before the spawn.

### Rejected / informational
- **Inherited lead 4 (commit 5431792):** no defect.
  - `count()` omits `processing`, but `processing` is written only by `claim_next_asset_upload` via `sync_next_cloud_asset`, which has no production caller (only tests). `Library::open` requeues any leftover (`library/mod.rs:368`).
  - The only reader of `cloud_activity` is `cloud_backfill_progress` (`read_activity` has no other caller), so the hide is consistent across the UI.
  - The stored row is not cleared, only hidden, so a new pending item briefly re-shows the old error until the next pass (about 2 s). Cosmetic.
- **Token leaks:** none found.
  - Errors are typed enums without request data, and `eprintln!` sites print `LibraryError` or ids only.
  - `conditional_scope` stores only a SHA-256 prefix of the token.
  - ureq 3 default agents do not forward `Authorization` on redirect, and the coded agents set `max_redirects(0)`.
- **ETag cache (`cloud/client.rs:893-929, 2655-2733`):** correct. A 304 without a cached body is an error, not an empty document; entries are scoped by base URL and token digest. `skip_unchanged` is disabled for a domain the same pass wrote to, and the shared status is read lazily after the Album flush.

---

### Coverage

**Deep (read the production code in full):**
- `workload.rs`, `library/authority_pass.rs`
- `library/asset_authority.rs` (the whole production part), `library/bookmark_outbox.rs`
- `library/album_authority.rs`, `library/collection_personal_edits.rs` (production part)
- `cloud/backfill.rs`, `cloud/queue.rs`, `cloud/sync.rs`, `cloud/activity.rs`, `cloud/failure.rs`
- `cloud/captures.rs`, `cloud/metadata_backup.rs`, `cloud/auto_publication.rs`, `cloud/albums.rs`
- `cloud/client.rs`: status / conditional-GET / ETag cache, album, classification and asset command mapping, collections, personal edits, error mappers, constructor
- Relevant server contract: `server/lakomics-api/asset_authority.py` (commands, baseline, changes), `album_authority.py` (membership), `require_linkable`

**Partially read:**
- `library/album_reconciliation.rs` (dispatch, baseline fetch and install guards; not the change-apply body)
- `library/classification_reconciliation.rs` (dispatch, page guard, clean-receive guards; not the transition and deferred-assignment internals)
- `library/classification_authority.rs` (flush, confirm, enqueue)
- `library/classification.rs` (delete and assignment mutation paths)
- `library/bookmark_reconciliation.rs` (receive, baseline, apply)
- `library/similarity_review_sync.rs` (receive and apply of mobile decisions; not the feed builder)
- `cloud/collections.rs` (publish and handshake; not artwork assembly)
- `library/trash.rs` (purge path only)
- `library/ingestion.rs` (materialization identity path only)

**Skimmed:**
- `library/character_review_sync.rs` (header and structure only)
- `library/catalog_checkpoint.rs` (crawl checkpoint, not cloud authority)
- `library/cloud_preflight.rs` (read-only)
- `cloud/thumbnail_refresh.rs` (maintenance CLI)

**Not reached:**
- `cloud/characters.rs`, `cloud/similarity_review.rs`, `cloud/collection_cache.rs`, `cloud/models.rs`, `cloud/catalog.rs`, `cloud/publication.rs`
- `library/character_exclusions.rs`, `library/character_review_feed.rs`, `library/restore_guard.rs`, `library/credential_broker.rs` (beyond `credential()`)
- The Album and Classification change-apply internals
- All `*_tests.rs` files (not read for intent beyond names)

**Not verified:**
- No test, build or runtime was executed.
- Scenarios H1-H4 and M1-M2 come from reading the code, not from reproduction.
- Whether a second PC actually shares this library's authority (the H3 trigger) was not confirmed.

---

<!-- source: opus-4-rust-characters.md -->

## Rust character recognition review (opus-4)

HEAD 6625235 (main). Read-only review; nothing was built or run. Scope: `_tools/app/src-tauri/src/library/characters.rs`, `character_*.rs` (except `character_review_sync.rs` and `*_tests.rs`), and `commands/characters.rs`.

Counts: high 1, medium 4, low 9.

---

### Findings (most severe first)

#### H1. One mobile exclusion that can never apply blocks every later exclusion permanently
- Severity: high. Confidence: confirmed by reading (PC side). I did not check whether the server rejects these claims up front.
- Where: `character_exclusions.rs:309-347` (`apply_character_exclusion_page`) together with `characters.rs:1022-1058` (`write_inbound_character_rejection`). The receive call is `cloud/auto_publication.rs:68`, which uses `?`.
- What is wrong: any validation error aborts the whole page transaction and leaves `received_cursor` where it was. The same entry comes back on every pass, so the pass fails at the same place each time. The cases that fail this way are permanent, not transient:
  - `InboundTargetNotFound`: the asset is no longer `normal`.
  - `NotFound`: the character was deleted.
  - `InboundAssetChanged`: the bytes differ.
  - `InboundProtectedReference`: the asset is now a reference image.
  
  No code path skips an entry or records it as skipped. The newer review-sync channel does have `skipped:` receipts.
- Failure scenario: on mobile, the user excludes image X from character A while the PC is off or offline. Before the PC pulls the log, the user converts A to a folder on the PC (`character_conversion.rs:128` deletes the target), trashes X, or adds X as a learned reference of A. From then on every exclusion poll (once a minute) fails with `CharacterExclusionTargetMissing`, `...AssetChanged` or `...ProtectedReference`. Every mobile exclusion made later is never applied on the PC, silently and forever. Because `run_due_character_exclusions(...)?` returns early, the review receive, the snapshot and the feed are also skipped on each due tick.
- Fix direction: treat these permanent, typed validation failures as consumed. Write a receipt with a `skipped:<reason>` outcome and advance the cursor, as `character_review_sync` does. Keep the fail-closed behaviour only for transient errors (DB or IO). Optionally report the skipped entry to the server or the UI.

#### M1. Reference-refresh items can stay `processing` forever, which stops idle S36 and augmentation work until restart
- Severity: medium. Confidence: confirmed by reading.
- Where:
  - `character_autotag.rs:326-347`: the `ManualScanEnrollment` branch rewrites `cause` on a pending job and keeps the same generation.
  - `character_autotag.rs:350-360`: the `ON CONFLICT` path bumps the generation and changes the cause on any input change.
  - `character_reference_refresh.rs:602-611` (`complete_reference_refresh_item`) and `:668-671` (`fail_...`) both return early when `job.cause != "reconsideration"`, and only match `generation = job.generation`.
  - The only cleanup is `recover_character_autotag` (`character_autotag.rs:507`), which runs only when the engine starts.
- Failure scenarios:
  - (a) A history refresh for character A is running, so its items are `processing` and their jobs are pending `reconsideration`. The user then runs a manual scan for character B in the same series. `queue_analyzed_character_assets` calls `enqueue(ManualScanEnrollment)`, which changes those pending jobs to `cause='manual_scan'`. When the jobs complete, the refresh items are never closed.
  - (b) During the refresh the user moves or reclassifies an image. `enqueue(Classification)` bumps the generation. The item keeps the old generation and never matches again.
  
  In both cases `character_reference_refreshes.state` stays `running`. The status panel keeps showing an unfinished history refresh. `augmentation_idle_allowed` (`character_incremental.rs:897-906`) returns false for as long as the refresh is running, so S36 shadow scoring, S36 automatic publication, S36 catch-up, backfill and augmentation training all stop until the app restarts or the runtime config changes.
- Fix direction: when `enqueue` replaces a pending or processing reconsideration job, also move that asset's `processing` refresh items to `superseded` and finish the refresh if nothing remains. Alternatively, have `advance_character_reference_refresh` sweep `processing` items whose job generation or cause no longer matches.

#### M2. S36 rollback ("clear automatic") fails whenever one S36-accepted image is in the trash
- Severity: medium. Confidence: confirmed by reading. This also confirms previous lead L3 and raises its severity.
- Where: `character_shadow.rs:368-413` (`clear_s36_automatic`) calls `record_character_decisions(Cleared)`. At `characters.rs:938-944`, the `Cleared` branch runs `query_row(... WHERE id=?1 AND status='normal')` with `?`, so an asset that is not normal returns the raw `QueryReturnedNoRows`, surfaced as `character_storage_failed`. The rollback query at `character_shadow.rs:371-379` does not filter `assets.status`.
- Failure scenario: S36 automatically accepted 300 images in a series and the user trashed one of them. "Clear S36 automatic" then clears the chunks before that image. The chunk containing it rolls back entirely (up to 200 pairs), and the command errors out. Later chunks and targets are never processed. Every retry fails at the same image, so the rollback can never finish. The ShadowReview undo (`ShadowReview.tsx:194`) hits the same raw error if the image was trashed after judging.
- Fix direction: in `write_character_decisions`, return a typed `Error::Stale` or `Invalid` for a missing or non-normal asset under `Cleared`. Have `clear_s36_automatic` either filter to `status='normal'` or skip non-normal assets.

#### M3. Autotag evidence and prediction rows are never pruned
- Severity: medium. Confidence: confirmed by reading. There is no `DELETE FROM character_autotag_evidence` or `DELETE FROM character_autotag_predictions` anywhere in `src/` or `migrations/`.
- Where: `character_autotag.rs:747-768` (`publish_character_autotag`) inserts one evidence row plus N prediction rows (with full `result_json`) on every job completion. Reference-refresh items (`character_reference_refresh.rs:190-215`) are also only ever marked `superseded`, never deleted.
- Failure scenario: each history refresh re-analyses every unresolved image in a series (`cause='reconsideration'`). New ingestion, reclassification, retries and manual-scan enrollment do the same for each affected image. With about 12k images and several characters per series, each refresh cycle adds (images × characters) `result_json` rows of several KB each. These include `referenceDistances`, `queryBoxes` and a copy of up to 20 `learnedReferences`. The catalog DB grows with no bound. The review SQL's `NOT EXISTS(newer_e ...)` subqueries, `latest_evidence`, and the per-row `json_extract` in `REVIEW_RECOMMENDED_DURABLE_SQL` get slower as history accumulates.
- Fix direction: when a job publishes generation G, delete evidence and predictions for that asset older than the current `source_generation`/generation. Keep only rows still referenced by `character_decisions.reference_snapshot` scan ids, or snapshot the needed evidence into the decision, which is already done. Prune superseded or completed refresh items of old `request_revision`s.

#### M4. S36 automatic acceptance is published without checking that the character's references are unchanged
- Severity: medium (the result is a wrong tag). Confidence: confirmed by reading; the window is narrow.
- Where: `character_shadow.rs:320-365` (`score_character_shadow`) and `:419-520` (`publish_s36`). The snapshot, including references, decisions and the rejection count, is taken before a worker call that can last up to 120 s. `publish_s36` then re-reads the current targets and inserts `accepted/automatic` rows stamped with the current `target.fingerprint` and current references. It never compares them against what was scored. `Pending` carries no fingerprint or reference-set identity, unlike the B36 path, which compares `Context::hash` in `publish_character_autotag`.
- Failure scenario: in a series switched to S36, the user notices that a wrong reference image makes S36 over-accept and removes it (or changes region bindings) while an image is being scored. The score computed with the bad reference still becomes an automatic acceptance. Its decision snapshot claims the new reference set as its basis.
- Fix direction: carry the fingerprint and `reference_set_hash` of each target (and the rejection count) from `snapshot()` into `publish_s36`. Skip publication for any target whose value changed.

#### L1. Error branch that cannot update the job leaves it `processing` and the UI "active" (previous lead L5)
- Severity: low. Confidence: confirmed by reading.
- Where: `character_incremental.rs:361-372`. If `self.connection()?` or the `execute` fails there (for example `SQLITE_BUSY` under a concurrent long write), the closure returns `Err` before resetting `e.active*`.
- Effect: the job keeps `state='processing'` with its claim until `recover_character_autotag` runs, which happens only on engine restart. The asset is not re-analyzed during the session. `fresh_remaining` counts it forever. `active_work` shows a stale series or character until the next job starts. In addition, `engine.error` (`:393-397`) is only cleared in `start_character_incremental`, so a single transient error keeps `persistent_error` in the status indefinitely even after later jobs succeed.
- Fix direction: reset the `active` fields in a guard or `finally`-style block. Retry the fence update, or leave recovery to a periodic sweep of stale claims. Clear `engine.error` after a successful attempt.

#### L2. `compare_delta` timeout leaves the late reply for the fallback `prepare` (previous lead L4)
- Severity: low. Confidence: confirmed by reading, for the timeout path only.
- Where: `character_incremental.rs:549-563` and `character_worker.rs:721-741`. Only `receive()` timing out (120 s) leaves an unread event behind. Worker-reported errors are consumed.
- Effect: the fallback `prepare` reads the late delta `result` and fails with "기준 이미지 준비 실패". The pool drops the worker on error (`character_worker.rs:623-626`), so no stale event leaks into the next job. The job is retried, costing up to about 240 s per attempt. On a machine where delta regularly takes more than 120 s, the job fails 3 times and is marked `failed`.
- Fix direction: on a delta timeout, return the error (the worker is reset) instead of falling back on the same worker.

#### L3. `ScanState.previous` keeps every target's last manual scan in memory (previous lead L1)
- Severity: low. Confidence: confirmed; the growth is bounded.
- Where: `character_scan.rs:124-130`. There is one entry per target that was ever manually scanned in the session, each holding the full result map of that series with evidence. Automatic mode is unreachable from the command (`commands/characters.rs:441-443`). References are capped at 25, so evidence per row stays small, a few KB.
- Effect: memory is roughly (targets manually scanned) × (series size) × (a few KB). For dozens of targets over a 12k library this can reach hundreds of MB. It is never released while the app runs, including after a library switch, since `stop_character_scan` only cancels. In addition, `character_recommended_page` (`character_review.rs:306-331`) and `review_pending_in` (`:486-521`) clone and JSON-encode the whole in-memory map on every page or badge request.
- Fix direction: evict `previous` on library switch and apply an LRU or age cap. Filter to `recommended` rows before cloning.

#### L4. `character_scan_results` re-hashes all reference files and every evidence row on each page (previous lead L2)
- Severity: low. Confidence: confirmed by reading.
- Where: `character_scan.rs:245-290`. The cost is real: up to 25 reference files plus 200 page rows fully SHA-256'd per call. However, the current frontend never invokes `character_scan_results`: `src/characters/api.ts` has no caller; only `runs`/`start`/`cancel` are wired. The recommended review page (`character_review.rs:292-440`) has the same pattern, re-hashing all references plus up to limit+1 candidates per page, and that one is reachable. It is bounded at 81 files per page and documented as intentional.
- Fix direction: reuse `Source`-style stamp checks (size, mtime, inode) instead of a full re-hash for display paging. Keep the full hash for the decision path (`checked_character_evidence`).

#### L5. Clearing a decision on an asset that is not normal returns a raw DB error (previous lead L3)
- Severity: low on its own; see M2 for the impact that matters. Confidence: confirmed.
- Where: `characters.rs:938-944`. The result is `Error::Db(QueryReturnedNoRows)` mapped to `character_storage_failed`, instead of a typed stale or not-found error. `Cleared` also skips all series and target scope validation, unlike accept and reject.

#### L6. Augmentation additions are always dropped when any S36-owned character shares the image's context
- Severity: low. Confidence: confirmed by reading.
- Where: `character_incremental.rs:1135-1141` and `:1172-1181`. `additions()` is given `selectable`, which excludes S36-owned targets. The worker response's `gates` roster is built from all predictions (`compare_character_augmentation` sends the full bundle). `character_augmentation.rs:184-187` requires `gates.keys() == roster`, so it returns `None` for every target.
- Effect: for an image whose context spans a switched S36 series and a B36 series (a parent-folder image), recall augmentation is silently disabled for the B36 characters as well. There is no wrong tagging, only lost recall.
- Fix direction: validate the gates against the full prediction roster, then filter the result to `selectable`.

#### L7. S36 snapshot scans the whole `assets` table for every scored image, and has a hard 20k cap
- Severity: low. Confidence: confirmed by reading.
- Where: `character_shadow.rs:113-140`. `SELECT content_hash,perceptual_hash,source_url FROM assets` runs with no status filter, trashed and deleted rows included, for every live S36 scoring. When distinct hashes exceed 20000, `snapshot()` returns `Invalid("... exceeds budget")`. Every S36 scoring then fails silently (logged to stderr only), so S36 publication stops for the library.
- Fix direction: filter to `status='normal'` and cache the image map per idle session. Make hitting the cap visible.

#### L8. Backfill `scored_at` is the backfill start time, not the actual scoring time
- Severity: low. Confidence: confirmed by reading.
- Where: `character_shadow_backfill.rs:111-118` and `:291`. All candidates get `native_at = at` from the start, and `record_origin(..., at, "backfill")` uses it as `scored_at`. `character_shadow_review.rs:328-343` and `:452-460` use `decision.created_at > scored_at` to count reviews that happened after scoring.
- Effect: during a long backfill, manual decisions made before an image was actually scored are counted as "reviewed after scoring". This inflates `reviewed` and `wrong` in S36 readiness (`hold`/`keep`/`ready` thresholds). Separately, the string comparison of RFC 3339 values can misorder within the same second across `Z`, `+00:00` and differing fraction lengths. Both sides currently use `to_rfc3339()`, so the risk is small.

#### L9. Minor inefficiencies on hot paths (grouped; each confirmed by reading)
- `read_character_target` (`characters.rs:1127-1256`) calls `open_library_media` for every reference, up to 25 file opens. It runs for every target in `list_character_targets`, `character_review_pending_map` and `character_autotag_targets`, and backfill preparation calls it per asset × per target (`character_shadow_backfill.rs:104-118`, about 12k × T × 25 opens, run synchronously in the start command).
- `asset_set_fingerprint` (`characters.rs:1259-1285`) prepares a statement per asset.
- `s36_catch_up` (`character_incremental.rs:835-895`) re-reads `s36_policy.json` and 500 job rows on every 500 ms idle tick. Once all 500 are checked it keeps re-querying without doing work.

---

### Previous leads: verdicts
| Lead | Verdict |
| --- | --- |
| scan.rs:124-130 `previous` map | Confirmed, but bounded and manual-only → L3 (low) |
| scan.rs:269-288 re-hash on page | Confirmed in code, but that command has no frontend caller → L4 (low). The reachable review page does the same, bounded |
| characters.rs:940-945 Cleared on trashed asset | Confirmed. Real impact is the S36 rollback being blocked → M2 (medium) |
| incremental.rs:549-563 delta timeout | Confirmed for the timeout path only. The pool resets the worker, so the cost is a wasted retry → L2 (low) |
| incremental.rs:363-367 error-branch connection failure | Confirmed. The job stays `processing` until engine restart, with stale UI state → L1 (low) |

### Checked and not a defect (selected)
- B36 automatic acceptance does not override user decisions. `native_selection` excludes pairs with any latest decision. `finalize` runs after the `decision_sequence` fence in the same transaction, and the claim and `Context::hash` are rechecked in `publish_character_autotag`.
- `enqueue` on a processing job correctly fences the in-flight worker (`claim_id` is nulled, so the late fence update matches nothing).
- Manual-scan decisions (`checked_character_evidence`) re-verify every reference, learned reference and candidate byte hash before recording.
- `move_character_to_series` and `convert_character_to_folder` are token-fenced. Superseding relocated jobs is documented as intentional.
- Review-feed publication digest, cursor handling and skipped-cursor truncation are consistent.
- The ShadowReview offset paging is compensated by the frontend's offset (queue plus skipped count).

### Coverage
- **Deep:** characters.rs, character_scan.rs, character_review.rs, character_incremental.rs, character_autotag.rs, character_shadow.rs, character_shadow_backfill.rs, character_shadow_review.rs, character_review_feed.rs, character_reference_refresh.rs, character_reference_candidates.rs, character_training.rs (snapshot build), character_workflow.rs, character_exclusions.rs, character_series_move.rs, character_augmentation.rs (`native_selection`/`additions`), character_sources.rs, character_comparisons.rs, character_scope.rs, character_conversion.rs (preview and delete path).
- **Skimmed:** character_worker.rs (pool `with`, `start`, `send`/`receive`, `compare_delta`; not `RuntimeConfig`/setup), character_hub.rs (candidate predicates and gallery SQL; not `browse_character_assets` internals), character_groups.rs, commands/characters.rs (scan, incremental, S36 commands and error mapping), character_training.rs tail (`roster_value`/`manual_sequence`).
- **Not reached:** character_folders.rs, character_reference_regions.rs (`selections_match` was only used, not read), character_reference_curation.rs, character_reference_refresh_bench.rs, the rest of character_hub.rs (`browse_character_assets`, sidebar counts), the rest of character_worker.rs (runtime setup/config), and commands/characters.rs lines 520-1043.

---

<!-- source: opus-5-rust-catalog.md -->

## Rust review: online catalog, Collections, metadata providers

Reviewer: Opus 5.5 (read-only; no cargo/npm run; nothing in the repo modified). HEAD 6625235.
Schema checked against migrations 0014 (collection_work_artworks), 0015 (collection_volumes), 0016 (collection_volume_sources).

Counts: critical 0, high 1, medium 3, low 4.

---

### H1. Importing an IGDB game with a screenshot as the hero image always fails, and so does replacing the hero with a screenshot later (HIGH, confirmed by reading)

- Files: `library/igdb_flow.rs:57-61, 187-192, 275-296` (apply), `igdb_flow.rs:614-637` (`apply_artwork_decision` in the replace path), `library/work_artwork.rs:267-318` (`insert_work_artwork_in_transaction`), schema `migrations/0014_collection_work_artworks.sql` (`UNIQUE(collection_id, provider, provider_image_id)`).
- What is wrong: `insert_work_artwork_in_transaction` upserts on `(collection_id, provider, provider_image_id)`. Its `DO UPDATE` does **not** change `kind`. It then calls `select_work_artwork_kind_in_transaction(kind)`, which requires a row with that exact `kind`, and returns `InvalidWorkArtwork` when there isn't one.
  - **Import (`apply_new`):** every screenshot is downloaded and saved as a `screenshot` row. The UI offers hero candidates from `artworks + screenshots` (`IgdbImportDialog.tsx:188`), and the backend accepts them (`validated_selection`, lines 471-481). When the hero is screenshot X, the hero row is inserted first with `kind='hero'`. The screenshot loop then upserts the same `(igdb, X)` key, so the row keeps `kind='hero'` while `relative_path` is overwritten and `selected` is reset to 0. The Screenshot selection check then fails, and the transaction rolls back.
  - **Replace (`replace_fetched_igdb_game_artwork`):** in a collection imported with screenshots, choosing screenshot X as the new hero hits the existing `kind='screenshot'` row. The Hero check fails the same way.
- Failure scenario: the user imports a game that has no IGDB "artworks" (common for smaller titles) and picks a screenshot as the hero, or picks one when artworks exist too. The import aborts with "Work 표지 이미지가 올바르지 않습니다" (the Work cover image is invalid). All downloads are wasted, and the prepared files are removed by `Drop`. Any later attempt to use a screenshot as the hero also fails.
- Why tests miss it: `hero_uses_screenshot_candidates_when_no_artworks_exist` (line 1042) passes `&[]` for the screenshot bytes, so the conflicting insert never happens.
- Fix direction:
  - At import, skip the screenshot row whose `image_id` equals the chosen hero, or make hero and screenshot rows distinct (for example, prefix the hero `provider_image_id`).
  - For replace, either allow the upsert to change `kind` for provider-owned rows, or insert the hero under a distinct key.
  - Add a test that passes non-empty screenshot bytes with a screenshot hero.

### M1. Aladin/Kakao refresh can get permanently stuck when a provider item is renumbered to a lower volume (MEDIUM; code path confirmed, trigger plausible). This is lead 3: **confirmed**.

- Files: `library/aladin_flow.rs:452-535` (`reconcile_source`), `aladin_flow.rs:537-551` (`map_source_write_error`), schema `migrations/0016_aladin_volume_sources.sql` (PK `(collection_id, volume_number, provider)` plus a **global** `UNIQUE(provider, provider_item_id)`).
- What is wrong: items are reconciled in ascending volume order. Each one upserts by `(collection_id, volume_number, provider)` and rewrites `provider_item_id`. Suppose item X is stored at volume N and the provider now parses it as volume M < N; for example, a title correction changes "… 31" to "… 30". Volume M is processed first and writes X into row M while row N still holds X. That hits the unique index, producing a `ConstraintViolation` that is mapped to `DuplicateAladinProviderItem` and rolls back the whole refresh. Every later refresh sees the same data and fails the same way.
- Failure scenario: automatic Kakao updates (`collection_updates.rs:212-244`) classify this as an error with no stop reason. They defer the Work by 24h and retry it forever, so new-volume and release-date events for that series stop. A manual refresh shows "이 도서 검색 서비스 상품은 이미 다른 Work에 연결되어 있습니다" ("already linked to another Work"), which is misleading. The UI offers no way to recover.
- Fix direction: inside the transaction, before the upserts, clear or move rows in this collection and provider whose `provider_item_id` appears in the incoming set under a different volume. Alternatively, delete this collection's source rows for the incoming item IDs first. Only a conflict with another *collection* should be reported as a duplicate.

### M2. `cleanup_unreferenced_work_artwork` can delete the files of an import that is still in progress (MEDIUM, plausible race)

- Files: `library/work_artwork.rs:76-148` (prepare writes the files before the DB row exists), `work_artwork.rs:546-582, 612-693` (cleanup). It is called after every TMDB apply/refresh/replace (`tmdb_flow.rs:368,421,473`), after IGDB replace (`igdb_flow.rs:508`), and from `delete_collection` (`collection.rs:243`).
- What is wrong: `prepare_work_artwork` writes `work-artwork/<cid>/<id>.*` and the thumbnail *without* the database lock. The row is inserted and committed later; for IGDB that comes after preparing every screenshot, and for TMDB after preparing every season poster. Cleanup reads the referenced paths under the lock, releases it, and then deletes every file in `work-artwork/*/` that it did not see. Commands run on `spawn_blocking` threads concurrently. When flow B prepares files while flow A's cleanup runs, B's new files are deleted and B then commits rows that point at missing files.
- Failure scenario: the user deletes a Collection, or finishes a TMDB refresh, while an IGDB/TMDB import or a local volume-cover import (`collection_volume.rs:207-235`, during viewer open) is still preparing. The committed Work shows broken covers, heroes or screenshots (`MediaNotFound`) permanently. The row exists, so nothing re-downloads it.
- Fix direction: serialize cleanup against preparation (a shared artwork lock held from prepare to commit), or have cleanup skip files newer than a grace period.

### M3. One orphan file that cannot be deleted stops the library from opening, and makes a successful Collection delete report an error (MEDIUM, plausible; Windows-weighted)

- Files: `library/mod.rs:369` (`library.cleanup_unreferenced_work_artwork()?` in `Library::open`), `work_artwork.rs:678-684` (the first `remove_file` error aborts), `collection.rs:235-244`.
- What is wrong: cleanup returns the first `remove_file` or `read_dir` error, and `Library::open` propagates it.
- Failure scenarios:
  - On Windows, an orphan file in `work-artwork/` may be locked by another process opened without share-delete: antivirus, the MEGA sync client (the Linux production library lives under a MEGA folder), or an image viewer. The same happens if the file is read-only. The app then cannot open the library at all.
  - `delete_collection` commits the DELETE and then returns the cleanup error. The UI reports a failure even though the Collection is gone.
- Fix direction: make cleanup best-effort. Skip and count per-file failures instead of returning early, and never fail `open` or `delete` on it.

### L1. IGDB import downloads every screenshot original with no count limit, and one failure aborts the import. Lead 1: **confirmed**, but LOW.

- Files: `igdb_flow.rs:57-61`; the query `igdb.rs:429` has no limit on the nested `screenshots` field.
- Each download is capped at 32 MiB (`MAX_WORK_ARTWORK_BYTES`) with a 20s timeout, but the number of downloads is unbounded. They run sequentially, all bytes are kept in memory, and then each one is decoded and thumbnailed.
- Failure scenario: a game with dozens of 4K screenshots takes minutes and can hold hundreds of MB in RAM. A single screenshot that returns 404, times out or exceeds 32 MiB fails the whole import, even when the user picked a cover and hero that are fine. The hero screenshot is also downloaded twice.
- Fix direction: cap the screenshot count (for example 10–20), download `t_1080p` instead of `t_original` for the gallery, and treat per-screenshot failures as skips.

### L2. TMDB season posters are downloaded and re-saved on every refresh. Lead 2: **partly rejected**.

- Files: `tmdb_flow.rs:64-86, 380-422, 504-546`.
- **Rejected:** the claim that the whole apply or refresh fails when total season poster bytes exceed 32 MiB. Posters are fetched at `w342` (`tmdb.rs:114-118`), about 30–80 KB each, and seasons are capped at 200 (`tmdb.rs:88`), so the total cannot realistically reach 32 MiB.
- **Confirmed:** every manual refresh re-downloads all season posters, writes new files and thumbnails, deletes the old rows and leaves the old files to cleanup. This costs time and disk churn, and it widens the M2 race window. Refresh is manual only, so this is low.
- Fix direction: reuse the existing season artwork when `poster_path` is unchanged; key the row by `season:<id>:<poster_path>`.

### L3. TMDB import/refresh of a TV series fails outright when all season-episode JSON together exceeds 4 MiB (LOW, plausible)

- File: `tmdb.rs:94-111`. `cached_bytes` sums every season response and fails with `TmdbInvalidResponse` above `MAX_JSON_BYTES` (4 MiB).
- Failure scenario: long-running shows with thousands of episodes (daily dramas, long anime listed as many seasons, each episode carrying crew and guest_stars) cannot be imported or refreshed. The only message is a generic invalid-response error. This is fail-closed by design, but the budget may be too small for real TV data. I could not confirm real response sizes (no network access).
- Fix direction: request slimmer season data or strip crew/guest_stars before the budget check; raise the budget.

### L4. `retry_transient` retries errors that will never succeed (LOW, confirmed by reading)

- File: `catalog_source.rs:47-71`. Only `CatalogTransportRejected(<500)` and `CatalogJapaneseTransportRequired` stop early.
- `OnlineCatalogWorkNotFound` (404 from `source_transport_error`/`get_with_language`) and `CloudCredentialNotConfigured` are retried 3 times with 0.75s and 1.5s backoff. The code comment itself says retrying a closed gallery is pointless.
- Impact: extra VPS requests and about 2.25s of added latency per missing gallery. It is bounded, not a storm.
- Fix direction: return immediately for `OnlineCatalogWorkNotFound` and credential errors.

---

### Checked and not a defect

- **API keys in logs or errors:** TMDB, IGDB, Aladin, MangaDex and the VPS client all map `ureq` errors to enum variants with no strings. `provider_requests::Failure` stores only categories and status codes. The only `eprintln!` in scope (`work_artwork.rs:123`) logs sizes and timings.
- **SSRF / URL handling:**
  - IGDB `image_id`, TMDB `file_path`, and MangaDex UUID plus file name are validated before being put into fixed origins. `https_only` is set and redirects are off (except the Aladin agent, which has fixed https URLs).
  - Online catalog thumbnails are limited to `https` `*.ehgt.org`.
  - The VPS path accepts only numeric IDs.
  - The `catalog-transport` remote webview has no capability (`capabilities/default.json` covers only `main`), and navigation is pinned to its origin.
- **User-field overwrite:** IGDB, TMDB and MangaDex refreshes only fill blank fields, or fields still equal to the previous provider snapshot. Aladin refresh writes only source rows and inserts volumes with `DO NOTHING`. `update_collection` protects personal fields through `personal_base`.
- **`collection_updates` loop:** failures are deferred per Work for 24h. Provider-wide errors back off (5s → 600s, rate limit up to 900s, and at least any Retry-After). The batch is bounded to 8 items or 15s.

### Coverage

- **Read in depth:** `igdb_flow.rs`, `igdb.rs` (client parts), `tmdb_flow.rs`, `tmdb.rs` (fetch/download parts), `aladin_flow.rs`, `aladin.rs` (parse/search), `mangadex_flow.rs`, `mangadex.rs` (URL/fetch parts), `work_artwork.rs`, `collection_updates.rs`, `collection_volume.rs` (non-test), `external_binding.rs`, `provider_requests.rs`, `catalog_transport.rs`, `catalog_source.rs`, `release_watch.rs` (runner and pending changes).
- **Skimmed:** `online_catalog.rs` (search SQL, thumbnail, file replacement), `catalog_update.rs` (update loop, page commit), `collection.rs` (update/delete/cover), `collection_source.rs` (source root resolution, info cover, cover listing).
- **Not reached:** `catalog_counts.rs`, `catalog_group_api.rs`, `catalog_group_identity.rs`, `catalog_group_query.rs`, `catalog_groups.rs`, `catalog_lineage.rs`, `catalog_preparation.rs`, `catalog_provider.rs`, `catalog_query.rs`, `catalog_review.rs`, `catalog_revision.rs`, `catalog_visibility.rs`, `collection_tracking.rs`, the rest of `collection_source.rs` (artwork import/thumbnail cache), and `kakao_books.rs` (outside the listed scope but used by Kakao refresh).
- **Not verified:** nothing was executed, and real provider payload sizes could not be checked (no network).

---

<!-- source: opus-6-rust-boundary.md -->

## Rust app-boundary review (opus-6), HEAD 6625235

Read-only review. No cargo/npm/app runs. All line numbers are for HEAD 6625235.
Leftover library files I took: asset_metadata.rs, av_artwork.rs, dev_guard.rs, drag_out.rs, external_vault.rs, favorite.rs, folder_appearance.rs, image_fingerprint.rs, kakao_books.rs, linux_fs.rs, lock.rs, machine_settings.rs, mobile_catalog.rs, remote_gallery.rs, remote_media.rs, remote_progress.rs, restore_guard.rs, source_group.rs.
(src/catalog_source.rs, src/catalog_transport.rs and src/cloud/ sit at the crate root, outside the listed scope. I did not review them.)

### Verdict on the previous reviewer's leads

| Lead | Verdict |
|---|---|
| open_library holds the AppState write lock across Library::open and stop_video_similarity_scan; the protocol handler takes the read lock on the UI thread | **CONFIRMED** (finding M1) |
| workload_cancel_scans / workload_quit are sync commands on the main thread and wait up to 2 s | **CONFIRMED** (finding M3). The quit case matters less. |
| Many sync commands do SQLite writes on the main thread | **CONFIRMED, and worse than stated** (finding M2): `Library::connection()` takes a per-library `database_lock` Mutex, and `trash_lock` stays held for a whole purge. |

### Findings (most severe first)

No critical or high findings. The media protocol, the extension API auth/CORS/SSRF and the path validation all held up (see "Checked and not defects" below).

#### M1. Opening a library freezes the UI thread and blocks every command and media request until Library::open finishes
- Severity: medium. Confidence: confirmed by reading.
- Where: commands.rs:489-518 (`open_library_in_state`), lib.rs:132 (`state.current_library()` in the `lakomics://` handler, which runs before `spawn_blocking`), commands.rs:3264-3273 (`current_required`), library/mod.rs:303-371 (`Library::open`).
- What is wrong: the `RwLock` write guard is taken first. It is then held across `open_library_at`, which runs `Library::open`. That call does a lot of work: the lease, `initialize_database` (migrations), `backfill_legacy_collection_kinds`, `normalize_showcase_orders`, `cleanup_stale_asset_drags`, `cleanup_resolving_similarity_reviews`, `requeue_*`, `recover_*` and `cleanup_unreferenced_work_artwork`. After that it still calls `previous.stop_video_similarity_scan()`, which busy-waits up to 2 s (library/video_similarity/scan.rs:62-83). All of these callers take the read lock and block meanwhile:
  - the `lakomics://` URI handler, which runs on the UI thread on WebView2 (Windows) and WebKitGTK (Linux);
  - every sync `#[tauri::command]`, which runs on the main thread;
  - every async command's `current_required(state)` prelude, which blocks a tokio worker;
  - the 8 extension-API workers and the workload timer thread.
- Failure scenario 1: the user switches libraries while the gallery is visible. Pending thumbnail requests hit the protocol handler, and the window stops painting or responding for the whole open. That means seconds on a large library, and much longer after an app upgrade that ships a migration.
- Failure scenario 2, at startup: the frontend issues sync commands such as `get_trash_policy` or `list_collections` alongside `open_library`. The main thread then waits for the migration.
- Suggested fix: build the new `Library` (and its `summary`) with no AppState lock held. Take the write lock only to compare and swap the `Option<Library>`. Stop and lock the previous runtime after releasing the lock. Keep the "same root" check before and after the build, so a racing double open is still handled.

#### M2. Sync commands do SQLite writes and lock waits on the main (UI) thread. The global `database_lock` and `trash_lock` turn background work into UI freezes
- Severity: medium. Confidence: confirmed by reading. How long a freeze lasts depends on the workload.
- Where:
  - commands.rs:576-624 (classification CRUD);
  - 786 (`set_revisit_preference`);
  - 892-935 (`update_asset_metadata`, `trash_assets`, `restore_asset(s)`, `list_trash`);
  - 949-995 (trash policy, favorites);
  - 1005-1078 (album CRUD, `patch_asset_albums`, `list_collections`);
  - 1579-1720 (ownership, collection CRUD, `set_asset_classification`);
  - 1755 (`retry_video_preparation`);
  - 2180 (`set_online_catalog_bookmark`);
  - 2829 (`save_remote_reading_progress`);
  - commands/video_similarity.rs:35-72 (`get/latest/cancel/resume_video_similarity_scan`).
  Lock sources: library/mod.rs:446-455 (`connection()` locks `database_lock` for the life of the connection) and library/trash.rs:52-75, 167-186, 188-197 (`trash_lock`).
- What is wrong: Tauri runs non-`async` commands on the main thread. Every `Library` method takes the process-wide `database_lock` Mutex, and on top of that SQLite's 5 s `busy_timeout` applies (db.rs:71). Background lanes contend for the same Mutex:
  - authority pass and asset lane;
  - cloud backfill every 2 s;
  - mobile publications every 10 s;
  - similarity and character scans;
  - extension ingest;
  - `prepare_pending_videos`.
  Whenever one of them holds it, a click that invokes a sync command blocks the UI thread. `empty_trash` and `purge_expired_trash` are worse: they are async, but they hold `trash_lock` across the whole purge, including the file deletions in `delete_accepted_purge_files_locked`.
- Failure scenario: the user runs "Empty trash" on a large trash, or the startup `purge_expired_trash` is removing many video files. If they then trash another item, restore one, or open the trash view (`list_trash`), the main thread waits on `trash_lock` until the purge ends. The window shows "Not responding" (Windows) or greys out (GNOME).
- Suggested fix: convert these commands to `async` + `spawn_blocking`, as most read commands already are. At minimum convert everything that touches `trash_lock` or does multi-row writes. Separately, consider not holding `trash_lock` across filesystem deletion.

#### M3. `workload_cancel_scans` blocks the UI thread for up to 2 s; so do quit and window destroy
- Severity: medium (cancel), low (quit/destroy). Confidence: confirmed by reading.
- Where: workload.rs:169-185, lib.rs:113-126, library/video_similarity/scan.rs:62-83.
- What is wrong: these are sync commands and a window-event handler, all on the main thread. They call `stop_video_similarity_scan`, which polls every 20 ms for up to 2 s until the scan thread clears `active`. A scan item in the middle of ffmpeg frame extraction will not clear it quickly.
- Failure scenario: the user presses "cancel scans" from the workload UI during a video similarity scan. The window freezes for up to 2 s on every press.
- Suggested fix: make `workload_cancel_scans` async and run the stop in `spawn_blocking`, or add a non-waiting "signal cancel" variant for the UI path. Keep the waiting variant for restore and library switch, off the UI thread.

#### M4. Sync credential commands can freeze the UI for up to 10 s per call on Linux
- Severity: medium (Linux only). Confidence: code path confirmed; how often it happens depends on the Secret Service daemon.
- Where: commands.rs:1134-1150 (IGDB), 1223-1236 (TMDB), 1320-1336 (Aladin), 1394-1410 (Kakao), plus the `get_*_connection` helpers that read credential status. Timeout source: library/credential/linux.rs:10, 34-44.
- What is wrong: these are non-async commands, so they run on the GTK main thread. On Linux each one does a D-Bus Secret Service connect with DH key exchange plus `ensure_unlocked`, all inside `async_io::block_on`, bounded only by a 10 s timeout. The cloud-token commands were already moved to `spawn_blocking` (commands.rs:2378-2394). These four provider families were not.
- Failure scenario: gnome-keyring or KWallet is slow to activate, hung, or missing its D-Bus activation file. Opening a settings or metadata dialog that queries IGDB, TMDB, Aladin and Kakao status freezes the whole window for up to 10 s per call. With four calls that is up to 40 s.
- Suggested fix: make them `async` + `spawn_blocking`, like `set_cloud_api_token`.

#### M5. The restore guard does not probe the Asset lifecycle authority domain (ADR-0038)
- Severity: medium. Confidence: confirmed that the probe is missing. Real-world impact is lower if another domain is always adopted first.
- Where: library/restore_guard.rs:10-23 (`PROBES` covers only catalog-bookmarks, albums and classifications). Used by library/backup.rs:179-189. Schema: migrations/0088_asset_authority.sql (`asset_authority`, `asset_authority_state`, `asset_lifecycle_outbox`).
- What is wrong: the module's own contract (restore_guard.rs header) says every server-authority domain must add a Probe. The Asset authority domain landed later and never added one. `restore_metadata_backup` therefore only refuses because of other domains.
- Failure scenario: a library has adopted Asset authority but not bookmarks, albums or classifications (for example a fresh replica, or a domain reset). The user restores an older metadata backup. The swap then:
  - discards the `asset_lifecycle_outbox` (pending trash, restore and tombstone intents the server has not accepted);
  - rolls back `asset_authority_state`, `server_created` and the cursor.
  Accepted user trash or delete decisions are lost or resurrected. ADR-0037 decision 6 names exactly this failure.
- Suggested fix: add an `asset_authority` singleton probe (plus a test next to the others). Coordinate with the backup/authority reviewer.

#### M6. On Windows, a leftover drag-out staging file can make the library impossible to open
- Severity: medium (Windows). Confidence: the error propagation is confirmed by reading; the trigger is plausible.
- Where: library/mod.rs:363 (`library.cleanup_stale_asset_drags()?` inside `Library::open`), library/drag_out.rs:73-97, commands.rs:1789-1837 (Windows drag cleanup ignores errors).
- What is wrong: on Windows, drag-out hard-links originals into `<library>/.drag-out/<uuid>/`. Cleanup after the drag is best effort. If it fails, for example because the drop target still holds the file open without FILE_SHARE_DELETE, the directory stays. On the next start, `cleanup_stale_asset_drags` returns the `remove_dir_all`/`remove_file` error through `?`, and `Library::open` fails with `AssetDragFailed`.
- Failure scenario: the user drags an image into an app that keeps it open (an image editor, a chat client uploading in the background), then restarts Lakomics while that app is still running. The library fails to open. The error says "asset drag failed", which suggests no connection to the drag.
- Suggested fix: make stale-drag cleanup best effort in `Library::open` (log and continue). A leftover staging directory is not a reason to refuse the library.

#### L1. On Windows, drag-out hard-links the library original, so an edit through the dragged file modifies the managed asset
- Severity: low. Confidence: plausible.
- Where: library/drag_out.rs:163-172 (`link_or_copy`). The Linux branch deliberately copies ("Do not alias originals"); Windows hard-links.
- Failure scenario: the user drops an image into an app that opens the dropped path in place instead of copying it, then saves over it. The library original's bytes change under an unchanged `content_hash` and thumbnail, which breaks duplicate detection and authority sha256 checks.
- Suggested fix: copy on Windows too (or use CopyFile2 with a copy-on-write hint), or document the accepted risk.

#### L2. A corrupt or unparseable `library-machine.json` stops the app from starting
- Severity: low (needs external corruption, but the result is a hard failure). Confidence: confirmed by reading.
- Where: workload.rs:245 (`machine_settings::workload(&path)?` in `setup`), lib.rs:452 (`.expect("error while running tauri application")`), library/machine_settings.rs:50-60.
- Failure scenario: the file is truncated by a disk problem, edited by hand, or written by a newer build with an incompatible `workload` shape. Setup returns Err, `run()` panics, and the app never shows a window. There is no in-app recovery, and `set_*` deliberately refuses to overwrite a bad file.
- Suggested fix: in `setup`, fall back to `Settings::default()` and surface an error event instead of failing setup.

#### L3. Remote page and thumbnail cache writes race on one shared `.partial` path
- Severity: low. Confidence: plausible (the race is confirmed by reading; whether it happens depends on request timing).
- Where: library/remote_media.rs:115-129 (`load_remote_page_with`), 159-174 (`load_catalog_thumbnail`). Both routes are exempt from the media permit (media_protocol.rs:37-43), so concurrency is unbounded.
- What is wrong: concurrent misses for the same page write the same `<page>.bin.partial` and rename it. `/remote-manga-thumbnail/<id>` maps to page 1, the same file as `/remote-manga-page/kHentai/<id>/1`, so opening a reader commonly fires both at once. One writer can rename the partial file while the other is still truncating or writing it. The cache then keeps a truncated image, which passes the magic-byte check forever, or the second rename fails and the request returns 502.
- Suggested fix: use a unique temp name (uuid) per write. On rename failure, fall back to serving the fetched bytes.

#### L4. The extension token file is created with default permissions
- Severity: low. Confidence: confirmed by reading.
- Where: extension_api.rs:951-975 (`load_or_create_token`: `OpenOptions::create_new` with no mode).
- Failure scenario: on a multi-user Linux machine with the usual 0755 `~/.config` and 0644 files, another local account can read `extension-token.txt`. It can then call `127.0.0.1:32145` (loopback is shared) to list classifications or ingest arbitrary public URLs into this user's library. There is also a smaller issue: a crash between `create_new` and `write_all` leaves an empty file. Every later start then marks the API `BindFailed` until the user deletes the file by hand.
- Suggested fix: on Unix, create the file with mode 0600. Treat an empty or invalid token file as "regenerate" (write a temp file, then rename).

#### L5. Web-video ingest has a 300 s global timeout but a 2 GiB size limit
- Severity: low. Confidence: confirmed by reading.
- Where: extension_api/public_media.rs:27-35 (`timeout_global(300s)`), extension_api.rs:33 (`MAX_REMOTE_VIDEO_BYTES` = 2 GiB), used for all ingest downloads.
- Failure scenario: a "web" or dcinside video over roughly 1.5 GB on a 40 Mbit/s link always fails with `download_failed` after downloading for 5 minutes. It also ties up one of the 8 API workers for that whole time.
- Suggested fix: use a connect timeout plus a per-read (idle) timeout instead of a global one, or scale the limit with the size cap.

### Checked and not defects (for the record)
- **media_protocol.rs traversal:**
  - `parse_path` requires the UUID segment and exact segment counts. File names go through `percent_decode` and then `is_single_file_name`; `\`, `/`, `.` and `..` are rejected.
  - Main-library routes resolve paths only from DB rows through `open_library_media`, which canonicalizes and then checks `starts_with(canonical_root)` (library/mod.rs:733-760).
  - Video originals are excluded from `/asset/`.
  - Vault routes are UUID-only, `no-store`, and return 423 while locked.
  - IGDB/TMDB/MangaDex previews are validated identities fetched https-only with no redirects.
  - Range parsing handles suffix, open-ended and out-of-range requests correctly, and playback is capped at 8 MiB per response.
- **collectible_cors.rs:** exact app-origin allowlist (the dev origins apply only in debug builds). Applied to image responses on 5 prefixes only, with no credentials header.
- **extension_api.rs auth, CORS and exposure:**
  - Binds 127.0.0.1 only.
  - The Bearer token plus `X-Lakomics-Extension-Id` are required, and a supplied Origin must equal the extension origin. DNS rebinding cannot supply the token.
  - Internal playback needs a per-process random ticket, compared in constant time.
  - The body is capped at 32 KiB, and a fixed 8-worker pool with a bounded queue guards against floods.
- **SSRF:**
  - Non-web sources are host-allowlisted (with anchored suffix checks).
  - The web source uses `PublicMediaResolver`, which rejects private, loopback, link-local and CGNAT addresses and IPv6 outside global unicast at connect time. Redirects and proxies are disabled.
  - The kHentai manifest URLs are pinned to `*.siam-cdn.net`.
- **Library lease (lock.rs):** flock/share_mode(0) makes a second open of the same root (for example a different spelling of the path) fail cleanly with `LibraryInUse` instead of producing two runtimes.
- **av_artwork.rs:** prepared artwork uses a UUID path, so the drop-cleanup of an uncommitted `PreparedWorkArtwork` cannot delete a shared or existing file.
- **external_vault.rs:** the vault root may not overlap the library root in either direction.
- **linux_fs.rs:** deletion is symlink-safe (openat2 with RESOLVE_BENEATH|NO_SYMLINKS|NO_XDEV, then renameat2 NOREPLACE).
- **remote_media `clear_remote_cache`:** checks for symlinks and uses canonical equality before `remove_dir_all`.
- **Deadlock check:** `open_library_in_state` holds the write lock while stopping scans. The character incremental stop only sets flags and never joins a thread that needs AppState, so there is no deadlock, only the freeze in M1.

### Coverage
- **Deep:**
  - lib.rs, media_protocol.rs (non-test part), collectible_cors.rs, extension_api.rs (non-test part), extension_api/public_media.rs, workload.rs;
  - commands.rs: AppState, open_library, trash/favorite/classification/album/collection sync commands, drag, manga root, remote gallery/progress, book/legacy migration, encrypted vault commands, credential commands;
  - commands/video_similarity.rs, commands/av.rs, commands/linux_drag.rs;
  - library/drag_out.rs, remote_media.rs, remote_gallery.rs, remote_progress.rs, machine_settings.rs, restore_guard.rs, lock.rs, external_vault.rs, av_artwork.rs, favorite.rs.
- **Skimmed:**
  - commands.rs, lines roughly 1087-1720 and 1900-2730 (provider search/apply wrappers, cloud and catalog wrappers; mostly `async` + `spawn_blocking`);
  - library/dev_guard.rs, linux_fs.rs (first 140 lines), mobile_catalog.rs, asset_metadata.rs, source_group.rs, kakao_books.rs (pattern grep only);
  - bin/thumbnail_recompress.rs, perf_probe.rs, cloud_thumbnail_refresh.rs (arg handling only);
  - tauri.conf.json (CSP; `devtools` feature enabled in release, noted as intentional), capabilities/default.json.
- **Not reached:**
  - commands.rs test module (3275-3695);
  - bin/legacy_lakomics_migrate.rs, legacy_package_migrate.rs;
  - library/folder_appearance.rs, image_fingerprint.rs (non-test logic);
  - media_protocol.rs and extension_api.rs test modules (used only for intent).

---

<!-- source: opus-7-react-main.md -->

## React main surfaces review: assets, collections, characters, classification, similarity, revisit

Git HEAD 6625235 (main). Read-only review: no files changed, nothing run. All paths are relative to `_tools/app/`.

Counts: critical 0, high 1, medium 4, low 9.

---

### HIGH

#### H1. Trashing an asset in the viewer after "open existing" leaves `requestedAsset` stuck, and the viewer never opens again
- Confidence: confirmed by reading.
- Where: `src/assets/AssetBrowser.tsx:311-324` (trashViewerAsset), `:404` (AssetViewer `items`), `:166-170`; `src/app/App.tsx:634-639` (openExisting sets `requestedAsset`); `src/assets/AssetViewer.tsx:16-17,62` (a missing `activeId` renders nothing).
- What is wrong: `requestedAsset` is cleared only by the viewer's `onClose` (`onRequestedAssetHandled`). `AssetViewer` is given `items = [requestedAsset]` whenever `requestedAsset` is not in the loaded page. `trashViewerAsset` moves to a neighbour id (`items[index+1] ?? items[index-1]`; with index -1 that is `items[0]`, an unrelated asset) and calls `refresh()`. It never calls `onRequestedAssetHandled`. After the refresh the trashed `requestedAsset` is no longer in `items`, so the viewer receives `[requestedAsset]`. It gets an `activeId` that is not in that list and returns `null`. The viewer disappears without `onClose`, so `requestedAsset` stays set indefinitely.
- Failure scenario: The user drops a duplicate file, and "기존 자산 열기" opens the existing asset in the viewer. They press Delete (or the trash button), and the viewer silently vanishes. From then on, double-clicking or pressing Enter on any gallery tile does nothing, because the viewer's list is still `[trashed requestedAsset]`. This lasts until another duplicate is opened or the app restarts. Side effect: if the user later enters a character series folder, `SeriesBrowser` (`src/characters/SeriesBrowser.tsx:214`) consumes the stale `requestedAsset` and opens a viewer on the trashed asset.
- Related effect of the same stale object: the `F` favourite toggle in this viewer uses `!asset.favorite` from the never-refreshed `requestedAsset`. A second press re-sends the same value, so the user cannot un-favourite.
- Fix direction: in `trashViewerAsset`, call `onRequestedAssetHandled()` when the trashed id equals `requestedAsset?.id`, and pick the next asset from the list the viewer actually shows. Better still, have `AssetViewer` call `onClose` when `activeId` is set but missing from `items`. Refresh or replace `requestedAsset` after mutations.

### MEDIUM

#### M1. The character or series gallery keeps selecting assets that a background reload removed, so batch actions hit invisible assets
- Confidence: confirmed by reading.
- Where: `src/characters/SeriesBrowser.tsx:171-179` (a same-scope reload replaces `page` but never reconciles `selection`), `:134-135`, `:338` (trash), `:365-368` ("이 캐릭터에서 제외"), `:415-424` (지정), `:398-401`. Compare `src/assets/AssetBrowser.tsx:159-161`, which does call `reconcileSelection`.
- What is wrong: `load()` is re-run on `galleryRefreshVersion`, which is driven by `refreshVersion + hub.revision`; `useCharacterAutomation` bumps the revision when background classification completes. The page is swapped, but `selection.ids` keeps ids that are no longer on the page. `selectedIds = [...selection.ids]` feeds every batch action, and the "N장 선택" label counts them.
- Failure scenario: In a series' "미분류" view the user selects 10 images. Background S36 or automatic classification assigns 3 of them to character B, and the page reloads without them. The bar still says "10장 선택" but only 7 tiles are highlighted. The user ticks character A and clicks "지정". All 10 are accepted for A, including the 3 already confirmed as B. "휴지통으로 이동" from the context menu would likewise trash the 3 hidden images.
- Fix direction: after every page replacement, `setSelection(old => reconcileSelection(old, ids))`. Alternatively, derive `selectedIds` as `ids.filter(id => selection.ids.has(id))`, as AssetBrowser does.

#### M2. Unsaved character-editor changes are silently discarded by an outside click or Escape
- Confidence: confirmed by reading.
- Where: `src/characters/SeriesBrowser.tsx:306-313` (`onOpenChange`: `else if (!picking && !busy) setEditor(null)`); `src/shared/ui/AnchoredPanel.tsx` (non-modal Radix dialog: `onInteractOutside` dismisses unless the click is inside the panel, `onEscapeKeyDown` closes). Also `:321` ("추천으로 보강" calls `setEditor(null)`).
- What is wrong: the panel computes `editorDirty` and shows "저장하지 않은 변경", yet any dismissal drops the draft with no prompt.
- Failure scenario: The user opens a character's panel and picks 8 new references through the picker, which returns to the panel. They adjust crops in ReferenceRegionChoices and rename the character. Then they click a gallery tile or press Escape. The panel closes and all reference, crop and name changes are lost. Reopening shows the saved state.
- Fix direction: when `editorDirty` is true, block dismissal (preventDefault in `onInteractOutside` and Escape) or ask for confirmation. Keep the draft across close and reopen for the same target.

#### M3. A "다시보기" bundle becomes permanently unopenable once any asset in it is trashed
- Confidence: confirmed by reading (frontend and backend contract).
- Where: `src/revisit/RevisitedBundleView.tsx:32-35` (`Promise.all(assetIds.map(getAsset))`); `src-tauri/src/library/similarity.rs:197-200` (`get_asset` only loads `status = 'normal'`); `src-tauri/src/library/revisit.rs:117-133` (the stored daily slate returns bundle asset ids without a status filter); `src/assets/AssetBrowser.tsx:325-337` (openBundle re-reads the stored slate).
- Failure scenario: The user opens today's "작가 다시보기" bundle, trashes one image elsewhere (or after viewing it), and later reopens the bundle. One `getAsset` rejects, so the whole view shows "묶음 자산을 불러오지 못했습니다". "다시 시도" fails the same way for the rest of the day.
- Fix direction: use `Promise.allSettled` in the view and drop the missing ids, or filter non-normal assets in `load_daily_slate` or `get_or_create_revisit_slate`.

#### M4. After cancelling or finishing a reference or cover pick while a page load is in flight, gallery pagination silently stops
- Confidence: confirmed by reading (timing-dependent).
- Where: `src/characters/SeriesBrowser.tsx:143-170` (`load`: `if (after && pending.current) return`; `finally` resets `pending` only when the token matches), `:172-173` (the returnGallery restore path returns without loading), `:145-147` (the picker cache path returns before touching `pending`), `:240`, `:249` (`++generation.current`).
- What is wrong: a next-page request starts with `pending.current = true`. `finishPick` or `beginPick` bumps `generation`, so that request's `finally` skips `pending.current = false`. The restore path and the cached-picker path both return without running a first load, which is the only other thing that clears `pending`. Every later `load(nextCursor)` is then ignored.
- Failure scenario: In a character folder with 1,000 images, the user opens "레퍼런스 추가", scrolls (a next page starts loading), and presses "취소" or "완료" straight away. Back in the character gallery, scrolling past the first loaded pages never loads more. The user sees a truncated gallery with no error until an unrelated refresh.
- Fix direction: reset `pending.current = false` whenever `generation` is bumped (in `beginPick`, `finishPick`, the restore path and the cache path), or use a per-request token for pagination.

### LOW

#### L1. CollectionOverlay async handlers write the previous collection's data after navigating to another collection
- Confidence: plausible (needs navigation during a network call).
- Where: `src/collections/CollectionOverlay.tsx:398-467` (refresh, refreshKakao, refreshIgdb, refreshTmdb), `:704-729` (onApplied handlers); `src/app/App.tsx:858` (the overlay has no `key`, so it is reused across `collectionId` changes).
- Scenario: On movie A the user clicks "TMDB 새로고침" and, while it runs, opens a related collection B through `onOpenCollection` (MovieCollectionDetail). When A's request finishes, `setTmdbConnection(A's connection)` renders A's film or series details on B's page, and `tmdbRefreshing` stays true on B. The manga paths (`setVolumes`) behave the same way. Later actions use the current `collectionId`, so the problem is limited to wrong display.
- Fix: `key={view.collectionId}` on the overlay, or guard each handler with a collectionId or generation check.

#### L2. CollectionOverlay's initial volume listing can overwrite volumes that the MangaDex sync already refreshed
- Confidence: plausible.
- Where: `src/collections/CollectionOverlay.tsx:156-184` against `:197-231`. Both effects `setVolumes` independently. If the initial `listCollectionVolumes` (with import progress) resolves after the sync effect's `refreshed` list, the view shows the pre-sync covers until the next refresh.
- Fix: sequence the two, or use one generation counter for volume writes.

#### L3. The SeriesBrowser viewer's trash has no undo and can keep showing the trashed asset
- Confidence: confirmed by reading.
- Where: `src/characters/SeriesBrowser.tsx:510` (`onTrash={a => void action(() => gateway.trashAssets([a.id]))}`).
- Scenario: The user presses Delete in the character-gallery viewer. The item is trashed with no undo, unlike AssetBrowser and the SeriesBrowser context menu, which set `undo`. If the viewer was opened on a reference (`externalAsset`), it keeps displaying the trashed image because `externalAsset` is prepended to the viewer items.
- Fix: reuse the `setUndo` path and advance or close the viewer explicitly.

#### L4. The AssetBrowser toast shows "실행 취소" (restore trash) on unrelated error messages
- Confidence: confirmed by reading.
- Where: `src/assets/AssetBrowser.tsx:260-267, 277-285, 325-337, 377` (`toggleFavorite`, `setCover`, `openBundle`, `onRetryVideo` call `setMessage` without `setUndoAssetIds(null)`), and `:386`.
- Scenario: The user trashes 20 images, and the toast with undo appears. They quickly hit a favourite failure, which replaces the message with "즐겨찾기를 변경하지 못했습니다." while the "실행 취소" button remains. Clicking it restores the 20 trashed images unexpectedly.
- Fix: clear `undoAssetIds` in every non-trash `setMessage` path, or bind the undo to a message id.

#### L5. Duplicate collection when the post-create refresh fails
- Confidence: plausible (needs `onChanged` or `listCollections` to fail).
- Where: `src/collections/CollectionBrowser.tsx:134-141` together with `src/collections/CollectionEditDialog.tsx:96-106`; `src/collections/MangaDexImportDialog.tsx:57-69`.
- Scenario: The collection is created, then `await onChanged()` throws. The dialog shows "저장하지 못했습니다" or "MangaDex 정보를 적용하지 못했습니다" and re-enables the submit button. The user retries and a second collection is created.
- Fix: once the create call succeeds, close the dialog and report refresh failures separately.

#### L6. Provider search results can come from an older query
- Confidence: plausible.
- Where: `src/collections/IgdbImportDialog.tsx:99-118, 231`; `src/collections/MangaDexImportDialog.tsx:29-46, 81`; `src/collections/KakaoConnectDialog.tsx:37-55, 85`. Enter bypasses the disabled button and there is no request generation (TmdbMovieDialog does have one).
- Scenario: The user types "Zelda" and presses Enter, then types "Mario" and presses Enter. The slower Zelda response lands last, so Zelda results are listed under the "Mario" query and the user may import the wrong work. In Kakao, a search during an apply also resets `busy` and re-enables buttons mid-apply.
- Fix: guard `search()` with `busy` and a generation ref.

#### L7. After a stale similarity decision is rejected, the same stale pair stays on screen
- Confidence: confirmed by reading (the backend returns SimilarityReviewConflict).
- Where: `src/similarity/SimilarityReviewBrowser.tsx:84-88` (the inbound reload is dropped while `pending`, with no deferred reload), `:114-127` (on error, no reload).
- Scenario: A phone resolves the pair while the PC shows it, but the 10 s inbound poll has not fired yet or the event arrived during `pending`. The PC user clicks "기존 이미지 유지", gets "선택을 저장하지 못했습니다. 다시 시도해 주세요.", and every retry fails the same way until they leave the screen.
- Fix: reload on a conflict error, and queue one reload if an inbound event arrives while `pending`.

#### L8. useCharacterAutomation can multiply its polling chains
- Confidence: plausible.
- Where: `src/characters/useCharacterAutomation.ts:91-95, 129-133`. The hidden-profile branch schedules a new 60 s timer without clearing the existing `timer`, and `onVisible` can call `poll()` while a timer is pending. Each hide or show cycle while `profile.hidden` is still true can leave an extra timer chain (they only merge when two land during the same in-flight poll), adding redundant `character_incremental_status` IPC.
- Fix: `clearTimeout(timer)` before every reschedule, including the hidden branch.

#### L9. Refreshing a deeply scrolled gallery costs about n/500 sequential IPC calls on every refresh event
- Confidence: plausible (performance).
- Where: `src/assets/AssetBrowser.tsx:108-137`. When about 12k assets are loaded, each ingest, favourite, trash or membership refresh runs 24 serial `refresh_assets` calls (JSON `IN` lists) plus a full re-sort before the page updates. `firstLoading` stays true the whole time, which also defers the coalesced next refresh.
- Fix: refresh only the rows near the viewport, or run the batches concurrently in bounded parallel. Measure first.

(Informational, not counted: in `src/classification/ClassificationSidebar.tsx:386-401`, Delete pressed inside the nested appearance or series-move dialogs bubbles through the React portal to `handleSidebarKeyDown`. Their state is not in the guard, so the folder-delete confirmation opens over them. It still requires confirmation.)

---

### Coverage

Deep (read fully, with backend contract checks where noted):
- `assets/AssetBrowser.tsx`, `AssetGallery.tsx`, `AssetViewer.tsx`, `AssetInspector.tsx`, `selection.ts`, `SelectionBar.tsx`, `libraryContextItems.ts`, `mediaUrl.ts`, `masonryLayout.ts`. Checked against Rust `refresh_assets` and the sort orders in `library/query.rs`.
- `collections/CollectionBrowser.tsx`, `CollectionOverlay.tsx`, `CollectionEditDialog.tsx`, `TmdbMovieDialog.tsx`, `MangaDexImportDialog.tsx`, `KakaoConnectDialog.tsx`, `ReleaseInbox.tsx`, `CollectionOwnershipPanel.tsx`, `AvEditPanel.tsx`, `physical/VirtualCoverGrid.tsx`.
- `characters/SeriesBrowser.tsx`, `ShadowReview.tsx`, `shadowReviewApi.ts`, `useCharacterAutomation.ts`, `CharacterGroups.tsx`, `CharacterRegistry.tsx` (body), `ReferenceCandidateDialog.tsx`, `CharacterSeriesMove.tsx`, `CharacterConversion.tsx`, `ReferenceRegionChoices.tsx` (hook and top part).
- `similarity/SimilarityReviewBrowser.tsx`, `useSimilarityReviewInbound.ts`, `useSimilarityIndex.ts`, `video/VideoSimilarityPanel.tsx`, `video/client.ts`. Checked against `decide_similarity_review` and the video review ordering.
- `revisit/TodayView.tsx`, `CreatorBrowse.tsx`, `DateBrowse.tsx`, `RevisitedBundleView.tsx`. Checked against `revisit.rs` slate loading and `get_asset`.
- `library/client.ts` (listener subscription), `catalogStreams.ts`.

Skimmed (grep for risky patterns only):
- `classification/ClassificationSidebar.tsx` (delete, move and rename flows, keyboard, counts effect), `ClassificationAppearanceDialog.tsx`, `IgdbImportDialog.tsx` (first 140 lines and Enter handling), `justifiedRows.ts`, `AssetGalleryScrollbar.tsx` (listener cleanup only), `shared/ui/ContextMenu.tsx`, `shared/ui/AnchoredPanel.tsx`, `app/workloadProfile.ts`, the Tauri opener capability (`opener:default`; sourceUrl and creatorUrl go through `openUrl`, so there is no unsafe-scheme exposure beyond the plugin's default scope).
- XSS sweep: no `dangerouslySetInnerHTML` or `innerHTML` in scope; media URLs are `encodeURIComponent`-escaped.

Not reached:
- `collections/GameCollectionDetail.tsx`, `MovieCollectionDetail.tsx`, `AvCollectionDetail.tsx`, `AvArtworkDialog.tsx`, `WorkArtworkGallery.tsx`, `CollectionVolumeGrid.tsx`, `MangaCoverViewer.tsx`, `CollectionCoverGrid.tsx`, `SeriesSeasons.tsx`, `FilmDetails.tsx`, `physical/*` render runtime (PaperbackEngine, collectibleRuntime, RenderCache), `collectionLibrary.ts`.
- `characters/S36Publication.tsx`, `FolderCharacterRegistration.tsx`, `CharacterFolderContent.tsx`, `api.ts`, `hubApi.ts`, the lower half of `ReferenceRegionChoices.tsx`.
- `assets/CalendarView.tsx`, `AssetToolbar.tsx`, `GalleryDisplaySettings.tsx`; `revisit/RevisitBundleCard.tsx`, `RevisitBrowser.tsx`; `library/types.ts`, `LibraryContext.tsx`.
- Nothing was executed; all findings come from reading. Timing-dependent items (M4, L1, L2, L6, L8, L9) have not been reproduced.

---

<!-- source: opus-8-react-shell.md -->

## React shell and remaining features: review (HEAD 6625235)

Scope: `_tools/app/src/` excluding collections/, characters/, library/, assets/, classification/, similarity/, revisit/.
Method: read-only source reading plus `git show/blame`; no tests or builds were run. Rust was read only to check the frontend/backend contract.

Counts: critical 0 · high 1 · medium 4 · low 5

---

### HIGH

#### H1. The vault recovery key can be lost for good: leaving Settings during or after "새 보관함 만들기" discards the key that is shown only once
- Confidence: confirmed by reading.
- Files: `external-vault/VaultSettings.tsx:20,54-56,83-91` (recovery key kept only in component state); `settings/SettingsView.tsx:233-239` (window Escape → `onExit`), `:135` (`pending` does not include vault busy/recovery state), `:1066-1070`.
- What is wrong: `createEncryptedVault` returns the recovery key, which lives only in the `VaultSettings` React state (`recoveryKey`). The UI says "지금 한 번만 표시됩니다". Nothing keeps Settings open while the key is on screen or while creation is in flight:
  - SettingsView's global `keydown` Escape handler calls `onExit()` whenever `pending` is false, and `pending` does not cover the vault.
  - The rail, the 찾기 palette, Ctrl+1/Ctrl+2 (App.tsx:521-528) and the Settings section buttons also unmount the section.
  - If the component unmounts while `createEncryptedVault` is still running (KDF), `run()` finishes, but `setRecoveryKey` goes to an unmounted component, so the key is never shown at all.
- Failure scenario: Settings › 데이터 관리 › 새 보관함 만들기 → enter password → 만들기. While it is still "만드는 중…", or while the recovery-key step is showing, the user presses Esc (for example to dismiss the 찾기 palette or a status panel, or out of habit) or clicks another rail item. Result: Settings closes, the vault exists, and its recovery key was never seen or is gone. Because "이 PC에서 기억" is on by default, the vault still opens on this PC. A forgotten password later means permanent loss of the vault contents.
- Fix direction: keep the pending recovery key outside the section component (an app-level store, like `vaultImportJob`) or block navigation and Escape until "복구키를 안전한 곳에 보관했습니다" is confirmed. At minimum, include vault create/recovery state in SettingsView's `pending`. Fixing M2 (the global Escape) removes the most likely trigger.

---

### MEDIUM

#### M1. The desktop app reloads the sidebar, galleries and trash on every window focus, and that clobbers the Trash retention input
- Confidence: confirmed by reading (native path).
- Files: `app/useAssetAuthoritySync.ts:11-22` (native branch, from 05b18b6); consumers `app/App.tsx:303-331`, `safety/TrashBrowser.tsx:39-80`.
- What is wrong: in the native app (`nativeWorkload()`), the hook adds `window.addEventListener("focus", changed)`, and `changed` dispatches all three UI-refresh events (classification, album, asset lifecycle) without any data change. Since cf2075b, the native pass already runs on window focus (`workload.rs:329-341`) and emits `library://*-changed` only when something changed, so this focus relay adds no information. Each alt-tab back into the app therefore runs `listClassifications`, `listAlbums` and `listTrash`, bumps `assetRefresh` three times (one coalesced gallery reload plus the CharacterFolderContent refresh) and, when Trash is open, runs `TrashBrowser.load()`. `load()` does `setPolicy(null)` and then overwrites `retentionDays` with the stored value.
- Failure scenario: open 휴지통, type a new retention period (for example 90), switch to another window to check something, and come back. The typed value is replaced by the saved value. Also, every focus re-queries the open gallery, which goes against the goal of the polling-reduction commit.
- Fix direction: drop the `focus` listener in the native branch; the native pass already wakes on focus and emits real change events. Separately, TrashBrowser's lifecycle refresh should not reset a policy input the user is editing.

#### M2. SettingsView's global Escape listener ignores handled events, open overlays and text fields
- Confidence: confirmed by reading.
- File: `settings/SettingsView.tsx:233-239`.
- What is wrong: `window.addEventListener("keydown", …)` calls `onExit()` on any Escape while `!pending`. It does not check `event.defaultPrevented`, `event.isComposing`, the editing target, or `modalDialogOpen()`. Radix Dialog/Popover Escape handlers run on `document` in the capture phase and only `preventDefault()`, so the window listener still fires. The same is true for the 찾기 palette (`CommandPalette.tsx` `onEscapeKeyDown`), the 상태 panel and AnchoredPanel (`stopPropagation` on the Radix custom event does not stop the native keydown).
- Failure scenarios:
  - (a) In Settings, press Ctrl+K and then Esc to dismiss the palette: the palette closes and Settings also exits to the previous view.
  - (b) Typing a TMDB/IGDB/Kakao key or server address and pressing Esc (for example to cancel Korean IME composition): Settings closes and the typed value is lost.
  - (c) Esc during vault creation or while the recovery key is shown: see H1.
- Fix direction: route Settings exit through `useBackHandler` (the shared BackNavigation already skips `defaultPrevented` and editable targets), or add the same guards here.

#### M3. Manga reader settings silently revert: App overwrites them from its stale in-memory preferences
- Confidence: confirmed by reading.
- Files: `manga/PageViewer.tsx:46-78` (writes `manga*` keys with `saveUiPreferences({...loadUiPreferences(), …})`); `app/App.tsx:172,464-466` (App keeps a full `UiPreferences` copy loaded once at mount and saves the whole object on every preferences change).
- What is wrong: two writers share one localStorage key. App's state still holds the `mangaReadingDirection`, `mangaPageMode`, `mangaCoverSingle`, `mangaViewerMargin` and `mangaViewerGap` values from app start, so the next App save writes them back.
- Failure scenario: open a manga, switch to 오른쪽에서 왼쪽 / 양면 / 여백 넓게, and close. Then expand a folder, drag the sidebar, change gallery layout or toggle privacy mode (any `updatePreferences`). The stored reader settings revert, and the next manga opens with the old direction/mode. The same applies to the online catalog reader, which uses `PageViewer`.
- Fix direction: keep one owner. Either route PageViewer's changes through App's `updatePreferences` (via context or props), or make App's save merge only the keys it owns into the stored object.

#### M4. Private Vault gallery: filter switches race, so trash items can show under 전체 (or live items under 휴지통)
- Confidence: confirmed by reading (no request token); impact bounded by the backend.
- File: `external-vault/ExternalVaultBrowser.tsx:108-126` (`loadFirst`), `:147-157` (live refresh during import), `:159-164`.
- What is wrong: `loadFirst` has no request id or generation check. Both filter changes and the 2 s live refresh during an import call it, and whichever response arrives last wins, even when it belongs to the previous filter.
- Failure scenario: during an import, or with a slow USB, click 휴지통 and then quickly 전체 (or the reverse). The late response for the old filter replaces the list, so non-trashed items appear in 휴지통 with 복원/영구 삭제 actions, or trashed items appear in 전체. Choosing "영구 삭제" there shows "0개를 영구 삭제했습니다" and removes the items from the view. The backend only purges items that are actually trashed (`encrypted_files.rs:115-160`), so no data is lost, but the view is wrong until the next reload.
- Fix direction: guard `loadFirst` and `loadNext` with a generation counter, as `TrashBrowser.load` already does.

---

### LOW

#### L1. Ctrl+N from Notes (and other non-asset views) also opens a hidden "new folder" editor in the sidebar
- Confidence: confirmed by reading.
- Files: `app/App.tsx:509-532`; `notes/NotesView.tsx` root `onKeyDown` (Ctrl+N → new note); `classification/ClassificationSidebar.tsx:296-298`.
- What is wrong: the App shortcut does not check `event.defaultPrevented` or `modalDialogOpen()`, and its "navigate to assets first" list leaves out `notes`, `private_vault`, `statistics` and `revisit`. In those views it still bumps `createClassificationRequest`, which opens an inline create editor inside the `hidden` asset sidebar.
- Failure scenario: in 메모, with focus on a list item (not a text field), press Ctrl+N. A new note is created, and a stray "new folder" inline editor is left open. The user finds it on the next visit to 에셋. Ctrl+1/2 also navigate underneath an open modal dialog such as the asset viewer.
- Fix direction: skip when `event.defaultPrevented || modalDialogOpen()`, and only act (or navigate first) when the asset area is visible.

#### L2. Failed import results auto-dismiss 8 s after the 상태 panel opens, taking the retry with them
- Confidence: confirmed by reading; partly by design.
- Files: `ingestion/WorkTray.tsx:16,45-57`; `layout/StatusCenter.tsx:142-152`; `app/App.tsx:626-632` (dismiss also drops `nativeDragAssetsRef` and metadata import retry context).
- What is wrong: since cc620e7 the tray lives inside the status panel. Each row starts an 8 s dismiss timer when shown, whatever its status, including `failed` and completed-with-failures. Only pointer or focus inside the row pauses it.
- Failure scenario: 50 files are imported and 3 fail, so the indicator shows "문제 1". The user opens 상태 and reads the failure list while the pointer stays on the trigger, or switches to the file manager to find the files. The row disappears, the problem count drops, and "실패 파일 다시 시도" is gone.
- Fix direction: auto-dismiss only clean successes; failures stay until dismissed explicitly.

#### L3. Toast pause/resume is global, so a toast removed under the pointer can leave other toasts' timers paused
- Confidence: plausible (DOM removal does not fire `pointerleave`).
- Files: `shared/ui/Toast.tsx:20-35`, `shared/ui/useAutoDismiss.ts`.
- What is wrong: any toast broadcasts `TOAST_PAUSE_EVENT`/`TOAST_RESUME_EVENT` to every `useAutoDismiss` instance. If a toast is dismissed via its X or action button while hovered or focused, no resume is sent.
- Failure scenario: an App-level message and a vault undo toast ("휴지통으로 옮겼습니다 · 실행 취소") are both up. The user clicks the vault toast's X. The App message's timer stays paused and never auto-dismisses.
- Fix direction: scope pause/resume to the owning toast (pass handlers down) or send resume on unmount.

#### L4. Unhandled promise rejections in a few shell actions
- Confidence: confirmed by reading; the effect is a silent failure or console noise, not a broken UI.
- Where:
  - `layout/WindowControls.tsx:7-13`: `try { void window.minimize() }` cannot catch an async rejection.
  - `app/App.tsx:430-432`: `void refreshSidebar()` has no catch, so on failure the sidebar stays empty with no message.
  - `app/App.tsx:618`: `videoPreparation.retryFailed()` rejects if `retry` throws, and the row stays stale.
  - `notes/useNotesCloseGuard.ts:14-32`: `listen`/`onCloseRequested` `.then` has no catch.
- Fix direction: add `.catch` with a user message where the user can act on it.

#### L5. `workloadProfile.start()` never retries after a failed first load
- Confidence: confirmed by reading.
- File: `app/workloadProfile.ts:13-24`.
- What is wrong: `started = true` is set before `listen`/`invoke`. On failure, `ready` stays false with an error, and every later `useWorkloadProfile` mount skips `start()`. The lightweight-mode toggle, the palette's 가벼운 모드 action and Settings controls stay disabled for the whole session. This is also the only place `restricted` comes from: its initial value is `true` in native, so every `restricted`-gated hook (video preparation, daily backup, trash purge, release watch, online catalog update) stays in restricted mode.
- Failure scenario: a transient IPC failure at startup (for example the `workload_profile` command erroring while the library opens) leaves the app in restricted mode until restart. Background preparation and backups never run.
- Fix direction: reset `started` on failure and retry (on the next hook mount or with a short backoff).

---

### Checked, no defect found
- Credentials in Settings: inputs use `type="password"` and are cleared after save. Nothing is written to localStorage, logs or URLs; the backend trims keys (`credential.rs`). The only localStorage use is UI preferences and the last metadata import folder path.
- Markdown renderer: React elements only, and links are limited to http(s) via `safeHttpUrl`, with navigation prevented inside the WebView. No `dangerouslySetInnerHTML` in scope.
- Privacy mode: honored by PageViewer, the overview grid, preload and the vault gallery; the FAULT game closes when privacy turns on, and its host checks `event.source` and origin.
- Private Vault: the backend locks the vault on hide-to-tray and quit (`workload.rs:181,227`), and the frontend mirrors it. File drops and the palette's "파일 가져오기" are disabled in the vault view, so vault files cannot be imported into the public library by accident. Import and export jobs survive leaving the view, with single-poller guards.
- The native authority relays (`nativeAuthorityEvents.ts`, album, classification and bookmark hooks) clean up listeners correctly, including a `listen` promise that resolves after unmount.
- The CommandPalette handles IME (`isComposing`/229), restores focus to the opener or a fallback, and Ctrl+K/F skip while a modal dialog is open. StatusCenter and MorePanel close via BackNavigation and Esc.
- Cloud progress (`useCloudSyncStatus`, `useCloudBackfill`) filters events by gateway and root and removes its listeners.

### Coverage
- Deep: `app/` (App.tsx and all hooks, WorkloadControls, workloadProfile, nativeAuthorityEvents), `layout/` (StatusCenter, CommandPalette, MorePanel, WorkspaceNavigation, navigationEntries, WorkspaceChrome, WindowControls, modalDialog), `shared/navigation/BackNavigation`, `shared/ui/{Dialog,AnchoredPanel,Toast,useAutoDismiss}`, `shared/markdown/MarkdownView` (+ URL validation in markdown.ts), `settings/SettingsView.tsx` (logic and the cloud/catalog/data/advanced sections), `settings/{CloudBackfillSettings,ExtensionPairingQr}`, `external-vault/` (browser, settings, availability, import/export jobs), `notes/`, `privacy/`, `preferences/`, `manga/{MangaViewer,PageViewer}`, `ingestion/{useFileDrop,WorkTray}`, `video/useVideoPreparation`, `safety/TrashBrowser` (first 150 lines), `games/FaultGame` and `fault/host.ts`.
- Skimmed (effects and listeners only): `manga/OnlineCatalogBrowser`, `manga/MangaBrowser`, `video/VideoPlayer`, `video/VideoTileMedia`, `statistics/StatisticsPanel`, `settings/{CatalogVisibilitySettings,CharacterAugmentationSettings}`, `useMobilePublications` (backend is a local no-op write, so not a polling concern).
- Not reached: `manga/{CatalogReviewDialog,CatalogEditionsDialog,OnlineCatalogDetailDialog,OnlineCatalogCard,CatalogThumbnail}`, `settings/{CharacterAutomationSettings,MobileCatalogPublishSettings,LightweightModeSettings}`, `shared/ui/{Menu,ContextMenu,qrCode,StableImage}`, `ingestion/metadataImport.ts`, `drag-out/`, `layout/{AppShell,ChromeSearch,SearchSurface,ViewToolbar,PublicationStatus,WindowResizeHandles}`, SettingsView JSX lines 800-960 and 1130-1376.
