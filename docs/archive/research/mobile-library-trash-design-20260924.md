# Mobile Library Trash — design (MOBILE-PARITY-001 slice 4, activates MOBILE-003)

Status: design accepted 2026-09-24 with the §5 decisions below.

## 1. Current state

- **PC trash only changes state.**
  - `trash_assets` / `restore_assets` flip `assets.status` and `trashed_at` and move no files (`src-tauri/src/library/trash.rs:47-70`, `:388-405`).
  - Server-owned Assets also queue an `asset_lifecycle_outbox` intent (`trash.rs:398`, `asset_authority.rs:204-242`).
  - Retention is the per-PC `trash_retention_days` setting (default 30, ADR-0011). `purge_expired_trash` runs at app start (`App.tsx:418`).
  - Purging a server-known Asset queues `tombstoned` and deletes the local row (`trash.rs:238-309`).
- **Existing gap:** that purge never deletes the local files; physical deletion was left to a server GC that ADR-0038 §7 defers. Emptying the trash therefore leaves orphan files on every PC.
- **Server** (ADR-0038, live since 2026-09-19):
  - Lifecycle states are `normal`/`trash`/`tombstoned` with a per-Asset `entity_revision`.
  - Commands `trashAsset`/`restoreAsset`/`tombstoneAsset` carry an operation-id receipt and an expected revision (CAS); conflicts return the current state (`asset_authority.py:491-576`).
  - **Blocker:** the command route is publisher-only (`asset_authority.py:1147-1153`, enforced by `test_a_client_token_cannot_drive_lifecycle_commands`).
  - Reads return `normal` Assets only, and media tickets refuse trashed ones. The list generation includes the assets cursor, so mobile views refresh on lifecycle changes.
- **PC adoption:** a server-side trash is adopted with `trashed_at = COALESCE(trashed_at, now)` (`asset_authority.rs:96-202`). Sync runs every 5 s and on focus. PC intents rebase on `revisionConflict`, so the PC's latest intent wins.
- **Android:** it already keeps a read-only lifecycle replica with revisions (`AssetReplica.java`, `ReplicaSchema.java:89-90`). The write-outbox template is `ClassificationAssignmentOutbox.java`, and the server-side client-role pattern is `classification_authority.py:1538-1560`.

## 2. Contract

No new protocol; ADR-0038 already covers tombstones, revisions, receipts and a PC-only purge. Three extensions:

1. **Role split on the command route:** authenticate first; the client role may send `trashAsset` and `restoreAsset`; `tombstoneAsset` stays publisher-only. Emptying stays PC-only by construction.
2. **Trash read route:** `GET /v1/library/trash?cursor&limit` for the client role.
   - Lists committed `trash` Assets, newest first by lifecycle `updated_at`, with `entityRevision` and thumbnail metadata.
   - Media tickets gain a `lifecycle=trash` scope (thumbnail plus original for preview), never for tombstoned Assets.
3. **Asset link rule (required cross-domain fix):**
   - Accept classification-assignment and album-membership changes for `normal` and `trash` Assets (ADR-0038 §4 says links survive trash).
   - Refuse tombstoned Assets with a new definitive `assetTombstoned`, which the PC and Android drop instead of retrying.
   - Today a trashed Asset would jam the PC classification queue (`cloud/client.rs:2829-2836`) and Android album sync (`LibraryReplicaStore.java:447`).

**Phone outbox:** `AssetLifecycleOutbox.java`, modelled on the classification outbox.
- One UUID operation per intent; frozen payload bytes.
- On `revisionConflict`:
  - current state equals the desired one → done;
  - `tombstoned` → drop and show "영구 삭제됨";
  - source state still matches what the user saw → rebase once;
  - otherwise block and show the conflict.
- Undo before sending cancels locally.

**Conflicts:**
- Phone trash vs PC classification: separate revisions, so no conflict once extension 3 is in.
- PC restore vs phone trash: first accepted wins; the other side rebases.
- **PC queued purge vs phone restore:** the PC must *drop* (not rebase) a tombstone intent whose conflict shows the Asset is `normal`, and restore or re-materialize the local row. The purge becomes two-phase ("purge pending" until the tombstone is accepted).

**Visibility:**
- Until the server accepts, the phone hides the Asset locally and shows "이동 대기" in its trash.
- After acceptance, the server hides it for everyone.
- Each PC starts its grace clock when it adopts the trash.

**Recovery:**
- Restore works any time before a tombstone.
- After a tombstone, server rows and R2 objects remain (no GC), so an operator can recover.

**Two PCs:**
- The shortest retention purges for both.
- The other PC adopts the tombstone and deletes its row, leaving files (the existing gap).
- The old Windows build handles lifecycle changes but needs the purge fix.

## 3. Mobile UX

- **Viewer:** a "휴지통으로" icon with no confirmation, because the action is reversible. The viewer advances to the next Asset and shows a "휴지통으로 이동함 · 실행 취소" snackbar for ~6 s.
- **Multi-select:** a later follow-up shared with multi-select move.
- **Trash browser** (Library settings or header):
  - count and total size;
  - thumbnail grid with the trash date;
  - restore (single and select-all);
  - "복원 대기" and conflict states;
  - no empty button, with the hint "비우기는 PC에서".

## 4. Rollout and tests

- **Order,** each separately authorized:
  1. Server (role split, trash route, trash tickets, link rule) — additive only.
  2. PC build (two-phase purge, keep a restore over a queued tombstone, drop `assetTombstoned`, refresh the trash count after remote changes).
  3. APK (new `ReplicaSchema` version for the outbox table).
- **Risks:**
  - a tombstone rebase deleting a restored Asset;
  - head-of-line blocking in the classification/album queues;
  - lost responses (covered by receipts);
  - Collection covers must clear on a remote trash (CONTEXT.md:68).
- **Tests:**
  - Server: role matrix; trash route never exposes tombstoned Assets; trash tickets; link rule.
  - Rust: adoption-time `trashed_at`; tombstone conflict against a restore dropped; purge-pending crash safety; retention from adoption.
  - Android JVM: outbox rebase/drop/block, cancel-before-send, frozen payload.
  - Mobile: undo, pending overlay, restore.
  - Device: trash with the PC off, then the PC adopts; restore on each side; response loss.

## 5. User decisions (2026-09-24)

1. Single-item trash from the viewer plus undo now; multi-select later together with multi-select move.
2. Phone-trashed Assets follow the PC retention schedule (30 days by default, counted from the PC's adoption).
3. **Emptying the trash must also delete the local files** once the server has accepted the tombstone, fixing the orphan-file gap. This is real file deletion: do it only after the tombstone is accepted, never for Assets that are not tombstoned, and record it in ADR-0011/ADR-0038 as a clarification.
