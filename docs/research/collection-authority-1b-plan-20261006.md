# Collections authority slice 1B — implementation plan

Status: batches 1-6 code complete 2026-10-06 (dry run and 1C pending approval); accepted with the §4 split (user chose "temporarily fence the rarer PC-only operations"). Builds on the [design](collection-authority-design-20260924.md) (§7 revised slices, §8 decisions) and the [1B survey](collection-authority-1b-survey-20261004.md) (write inventory at `d207ebf4`). Nothing here activates the authority; activation is slice 1C and needs its own approval.

## 1. What 1B delivers

- Every PC write to shared Collection data goes through a local replica + durable outbox when the authority is active, and keeps today's behaviour while it is inactive.
- Server commands, change feed and the personal-edit shim cover the fields the tablet and PC use today.
- The tablet gains create, rename, basic info and record editing, shown only when the server reports an active epoch.
- **User-visible result before 1C: none.** The work is dormant until activation; that is intended (a partial cutover is unsafe, design §7).

## 2. Delta since the survey (`d207ebf4` → `ce8a7c58`+)

Re-check these before batch 2/4 because they add or change write paths:
- `9d55123e` MangaDex refresh replaces stale provider fields — the server-side provider merge must match the new "replace stale" rule, not only "fill blank".
- `53846561` connect a hand-made game to IGDB — a new bind path on an existing work (`bindProvider` + `applyProviderSnapshot`).
- `adbdcb8c` StashDB default performer photo — AV portrait selection (AV batch).
- Migrations `0119`–`0121` do not touch Collection tables (manga index pins, auto-tag publication, likes album).

## 3. Batches

Each batch: worker implementation (Codex Sol, medium → high on failure), controller review, targeted tests, commit. Server changes are additive and inactive; each server deploy needs approval. No batch enables a second writer.

| # | Batch | Contents | Size / risk | Server deploy |
|---|---|---|---|---|
| 1 | Dormant PC replica | Migration for sync identity, cursors, entity revisions, outbox, artwork materialization queue; `library/collection_authority.rs` apply from baseline/changes; writer guard test that fails on any Collection-table write outside apply/outbox/legacy-inactive paths (starts with an allowlist of today's writers, shrinks per batch). | L / high | no |
| 2 | Core commands end to end | Server: `status`/`ownedPlatform`/records in `updateWork`, v3 shim for tracking and records, `selectArtwork` updates per-artwork `selected` atomically, client-role auth on the Collection command/upload routes (part of `SEC-TOKEN-001`). PC: CRUD, records, score/memo, showcase order, membership, cover asset through the outbox. Tablet: generalized connection/library-scoped command outbox (create→edit ordering, conflicts), create/rename/basic info/record forms gated on active epoch; `NetworkPolicy` allowlist for authority reads + commands. | L / high | yes |
| 3 | Artwork and volumes | `addArtwork`/`selectArtwork` incl. spine/back, local source imports on detail open, volume materialization on viewing, volume ranges; fence LaunchBox fetch and cover-focus recomputation (§4). | L / high | yes |
| 4 | Providers, tracking, workers | MangaDex/Kakao/Aladin apply+refresh with server merge parity (incl. `9d55123e`), fence TMDB/IGDB apply/refresh/artwork replacement and IGDB connect (§4), ownership count replacement + explicit-zero tracking, release subscriptions and read acknowledgements, refresh workers submitting fenced commands, inbound replay lanes routed or fenced after activation. | L / high | yes |
| 5 | AV | AV works stay readable from the feed; fence AV detail/people/portrait editing and StashDB refresh (§4); AV inbox/candidates stay local. | M / high | yes |
| 6 | Fences and verification | Migration/startup normalization and cascade exemptions (asset retirement/purge, similarity replacement), type change hidden under authority, full guard with an inactive/active fixture matrix, staging verify against a production dry run. | M / high | dry run needs deploy approval |

Then **1C** (separate approval): final drain, digest-bound epoch, legacy PUT fence, PC collections lane off.

## 4. Decision (user 2026-10-06): what may be temporarily unavailable after activation

Design §8.1 allows fencing operations without authority commands. Proposed split (keeps everything used daily, fences rarer PC-only operations with a clear message until a later slice):

- **Keep working after 1C:** create/rename/delete (to trash), basic info, records (status, owned platform, score, memo), showcase and order, membership, cover choice among existing artwork, local source artwork import on opening, volume viewing and ranges, ownership counts, release subscriptions and acknowledgements, MangaDex/Kakao refresh and new-volume detection.
- **Temporarily fenced (message: "서버 이전 후 다음 단계에서 다시 지원"):** TMDB/IGDB apply/refresh/artwork replacement and IGDB connect, LaunchBox spine fetch, AV detail/people/portrait editing and StashDB refresh, book import and legacy package migration, cover-focus recomputation.

Fencing the second list shrinks batches 3–5 by roughly half and brings 1C forward; those operations return with slice 2 (server provider jobs) and an AV follow-up.

## 5. Approvals and checkpoints

- Server deploys for batches 2–5 (additive, inactive) and the production dry run: separate approval each time.
- Tablet APK installs: per build as usual.
- 1C activation: separate approval after the dry run reports no loss.
- Rollback before 1C: discard staging; nothing to undo on the PC because the replica is dormant.

## 6. Progress (2026-10-06)

Committed on `main`: batch 1 `a54ea974`, 2a `544e3ace`, 2b `16b8d491`, 2c `1bf9ef40`, 3 `9d6c14e5`, 4 `ca2da8b0`, 5 `53f2142f`, 6 (code) — see the commit after `db50cba9`. Batch 6 routed the similarity replace-existing membership/cover rewrite through the outbox, skips the legacy startup normalizers (legacy kind backfill, showcase order) while active, and leaves no `batch N` entries in the writer guard. Server changes from 2a/3/4 are **not deployed**. Remaining before 1C: deploy the server (approval), run the PC "컬렉션 서버 이전 점검" verify-only dry run against production, then the separately approved activation.

### Production dry run (2026-10-06 ~22:20 KST)

`verdict: lossless` against production after two server deploys (`b28d25dd`, then `c80351cd`): works 346 matched (0 missing/unknown/type mismatch), 0 payload diffs, 0 people diffs, artworks 2,995 with 0 missing originals and 0 unconfirmed blobs, bindings 470, all drain barriers ok. Fixes found on the way: Steam identifier bindings (`237e6437`), slot-derived artwork flags in the exporter (`5a665353`) and in the verify diff (`c80351cd`), and user-approved data cleanup (Chainsaw Man part 1 unlinked from MangaDex, part 2 shows from volume 12; English Digimon Story duplicate removed; backup `backups/pre-collection-dups-20261006-215400`). Offline harness: `collection_baseline_export` + `server/lakomics-api/tools/collection_baseline_dry_run.py`. Next: 1C activation, separately approved.

## 7. 1C activation runbook and rollback

Activation and recovery require separate operator approval. Pause Collection writes,
drain pending edits, and keep the PC legacy publication lane held during the cutover.
Before activation, take an online SQLite backup of `<server-dir>/data/lakomics.sqlite3`
with Python's backup API (includes committed WAL data); use a new backup filename:

```python
import sqlite3
from pathlib import Path

source = Path("<server-dir>/data/lakomics.sqlite3")
backup = Path("<backup-dir>/pre-collections-1c.sqlite3")
assert not backup.exists()
with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as src:
    with sqlite3.connect(backup) as dst:
        src.backup(dst)
        assert dst.execute("PRAGMA quick_check").fetchall() == [("ok",)]
```

Using publisher authentication, `PUT /v1/collections/authority/staging` with the
final PC export, then `POST /v1/collections/authority/staging/verify` with that
same complete export body. Require `verdict: lossless` and unchanged drain barriers.
Record the staging response's `stagedDigest`; activate with
`POST /v1/collections/authority/activate` and
`{"libraryId": "<library-id>", "expectedStagedDigest": "<stagedDigest>"}`.
If verification or digest/drain checks fail, stop and repeat the final drain/export.
After activation, verify that server status advertises `collections`, the PC adopts
the baseline, and legacy publication stays quiet before reopening writes.

- **Before activation:** `DELETE /v1/collections/authority/staging`; the PC replica
  remains dormant and the live authority has not changed.
- **After activation:** pause all writes and client sync, stop the server, and
  restore the verified server DB backup with its WAL/SHM handled as part of the
  stopped SQLite restore. Check `PRAGMA quick_check` before restarting the server.
  With the PC stopped, back up its configured library's `library.sqlite` and retain
  pending intent evidence, then clear the Collections replica state in a transaction:
  `collection_authority_sync WHERE singleton=1` is **both** the durable activation
  marker (even `adopted=0`) and adoption marker (`adopted=1`); its `cursor` is the
  change-feed cursor and `snapshot_cursor`, `baseline_section`, `baseline_after`,
  and `baseline_count` track baseline progress. Also clear rows in
  `collection_authority_revisions`, `collection_authority_outbox`,
  `collection_authority_materialization`, and `collection_authority_trash` after
  archiving undelivered intents. Reconcile the separate legacy cursor in
  `mobile_collection_personal_edit_sync` (`endpoint` row, `received_cursor`) and
  its `mobile_collection_personal_edit_poll` endpoint row with the restored server.
  Keep PC sync/publication held until recovery is validated: clearing the marker
  re-enables legacy paths. Never republish a PC snapshot as rollback; the restored
  server DB is the recovery source.

### 1C activation (2026-10-06 22:46 KST)

Activated on production: staged digest `39168b2f…7e8177`, verify `lossless`, epoch 1 (works 346, bindings 470, artworks 2,995, volumes 2,585, volumeSources 207, ownership 117, people 4). Server DB backup before activation: `/home/linuxuser/lakomics-1c-20261006/pre-collections-1c.sqlite3` (quick_check ok); the temporary publisher token was revoked. The PC dev build (`59461c1c`) adopted the baseline within a minute (marker adopted, outbox empty, legacy collections publication consumed and quiet, no cloud errors). Tablet 0.9.31 installed; a Collection created and a score edited on the tablet reached the PC replica (cursor 2).
