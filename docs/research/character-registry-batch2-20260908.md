# Character Registry Batch 2 — 2026-09-08

Status: implemented; isolated Rust gates passed on 2026-09-08. Native IPC and
production migration have not been exercised.

## Contract

- Existing single direct Classification membership and media paths remain unchanged.
- A target owns an explicit recursive-subtree classification scope and an optional
  descriptive classification link. Deleting either folder does not reparent a target.
- v44 adds targets, ordered reference slots, append-only human decisions and a
  derived accepted-relation view. There is no prediction cache or Cloud outbox change.
- Zero through five refs can be saved; five distinct normal image assets within
  the subtree with available original files are needed for readiness. This is
  metadata/file readiness, not proof that model inference will succeed.
- Trash keeps ref links. Hard deletion sets the link to NULL and retains the slot/hash.
  Decisions retain original asset ID/hash and ref evidence even after hard deletion.
- Refs and target edits use an expected revision. Decisions use a recomputed
  fingerprint plus current asset/scope checks; repeated identical decisions are no-ops.
- Approved relations survive ref replacement and ordinary folder moves. They do
  not become extra classification memberships. Targets are disabled, not hard-deleted.
- Restore upgrades and checks a temporary snapshot before replacing the live DB;
  old backups remain intact and the existing pre-restore snapshot is retained.

## Implementation plan

1. Add `0044_characters.sql` and `library/characters.rs` with typed Registry,
   reference and decision APIs. Keep inference configuration in Batch 1.
2. Register native commands in `commands/characters.rs`; frontend UI/client work
   remains Batch 4. No user-facing character editing is enabled by this batch.
3. Upgrade restored snapshots before swap and run FK validation before migration
   commit. Exercise successful and failing migrations using fresh v43 fixtures.
4. Test two targets, recursive scope, five refs/replacement/stale updates,
   trash/restore/hard-delete/missing files, multiple accepted relations, idempotence,
   all-or-nothing batches, restart, old/new snapshot restore and failure preservation.
5. Run focused Rust tests first; broaden to migration/backup tests because those
   shared paths change. Record actual exits and any pre-existing failures.

## Operational boundary

The starting schema is v43. No relevant Tauri/Vite watcher was observed before
editing. No active library migration is authorized: do not launch/restart the
updated app against the saved production profile. All verification uses TEMP
fixtures; committing, pushing and production migration remain separately authorized.

## Verification evidence

Checkout: `C:\chatgpt`, branch `main`, task-start/current HEAD
`aabf7b0b3f857fe10ed3359de38757d9558b50f1`. Changes are uncommitted.
Commands ran from `app/src-tauri`; all database fixtures use temporary directories.

| Command | Final result | Evidence |
| --- | --- | --- |
| `cargo test --lib library::characters::tests -- --nocapture` | 11 passed, exit 0 | `.acceptance/character-batch2/characters.log` |
| `cargo test --lib library::db::tests -- --nocapture` | 27 passed, exit 0 | `.acceptance/character-batch2/migrations-final.log` |
| `cargo test --lib library::backup::tests -- --nocapture` | 14 passed, exit 0 | `.acceptance/character-batch2/backup.log` |
| `git diff --check` | exit 0 | tracked working changes |

The first character compile failed on LockedConnection coercion and sha2 0.11
digest formatting; both were corrected before the passing run. The first shared
migration run had 23 passes and 4 failures (exit 101). Its v34/v35 fixtures left
v41 tables behind while lowering user_version, and its minimal v31/v32 fixtures
lacked asset_activity required by v42. Those fixture patterns were present in
HEAD. The four tests now build their actual historical schemas from migrations;
production migration SQL was not weakened to accommodate the fixtures.

Coverage includes recursive-scope refs, stale edits, atomic decision batches,
multiple character relations without folder changes, ref replacement, trash and
restore, SQL hard deletion, missing originals, restart, v43-to-v44 upgrade,
pre-migration snapshots, old/new metadata snapshot restore, and rollback when
schema or FK validation fails. A failed migration leaves user_version and
pre-existing data intact. The backup suite also covers swap/rollback failures and
database lock coordination. Existing compiler warnings were left unchanged.

Inline review covered the new migration, native command registration, Registry
module/tests, migration transaction and snapshot replacement paths. It was not
an independent review. Existing Batch 1 worker, experiment inputs, media files,
classification mutation code and Cloud queue behavior were not modified.

## Remaining gates and next batch

- No frontend UI or real Tauri IPC acceptance was performed. Rust test compilation
  checks the command types/registration, not invocation through a running app.
- SQL hard-delete tests establish FK behavior; actual filesystem purge acceptance
  remains a native lifecycle gate. Ref readiness checks metadata and accessible
  originals, not decoding or the original file's actual digest.
- Batch 1 recognition baseline remains frozen and its inference was not rerun.
- Batch 3 adds scoped scan/worker orchestration, content/model/config cache keys,
  cancellation/progress and stale-result checks before recommendation review.
  Human decisions remain independent of recomputable model output.
- Starting the updated app on an older library triggers v44 migration. No updated
  app launch, active production migration, commit or push was performed here.
