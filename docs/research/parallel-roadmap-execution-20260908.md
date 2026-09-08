# Three-lane roadmap execution — 2026-09-08

Status: historical execution coordination record. The authorization and source state
below belong to the original 2026-09-08 task, not a new instruction to execute it.
As of the 2026-09-09 documentation reconciliation (`0c61206`), later Catalog Reader
and deployment work supersedes this record's original Reader exclusion and rollout
status. Consult the [living backlog](../roadmap/lakomics-backlog.md) and
[Android README](../../android/README.md) for current scope and acceptance.
This document coordinates execution; `docs/roadmap/lakomics-backlog.md` remains the
product backlog. No plan checkbox alone establishes implemented behavior.

## Scope and source state

Canonical checkout: `C:\chatgpt`, `main`, initial HEAD
`aabf7b0b3f857fe10ed3359de38757d9558b50f1`. Existing character runtime/Registry/review
changes, schema 44 and test datasets are pre-existing work and must be retained.
The existing tracked character patch was recorded in the ignored
`.acceptance/parallel-roadmap/preexisting-character.patch` before new implementation.

User authorization: plan all three in parallel, then implement while the user is
away. It does not authorize Git writes, deployment, production data changes,
dependency installation, broad backfills or catalog replacement. The dev session
started earlier was stopped before new code changes so its watcher cannot apply
the next migrations to the active library. Final native acceptance must use an
isolated library/profile or separately authorized operational run.

## Independent delivery lanes

| Lane | Execution plan | First complete product slice |
| --- | --- | --- |
| MOBILE-006 | [Mobile catalog](mobile-catalog-execution-plan-20260908.md) | Versioned PC-authoritative read replica; mobile list/search/detail/bookmark filter while PC is off |
| SIMILARITY-003 | [Video similarity](video-similarity-execution-plan-20260908.md) | Explicit bounded video analysis, reusable fingerprints and human pair review |
| LONG-001 → LONG-002B | [AV and covers](av-covers-execution-plan-20260908.md) | Local AV Collections, people/roles, real cover surfaces and focused cover interaction |

Reader/offline downloads, cross-device bookmark mutations, server catalog crawling,
automatic video duplicate deletion, new external AV providers, Private Vault and
standalone Shelf/Display mode are separate product work.

## Shared-file ownership

- Root integrator owns `app/src-tauri/src/library/mod.rs`, `library/db.rs`,
  `commands.rs`, `lib.rs`, `cloud/mod.rs`, shared error variants and command
  registration. Feature owners report exact requested interfaces before integration.
- Reserve `0045_video_similarity.sql` for the video lane and
  `0046_collection_av.sql` for the AV lane. Recheck the current latest migration
  before registration; no agent independently increments the global schema.
- AV owns Collection-specific changes in `library/models.rs`, `app/src/library/types.ts`
  and the existing Collection gateway along with Collection presentation and Cloud
  Collection export compatibility. Mobile and video use feature-owned DTOs.
- Mobile owns its server modules/router integration, `app/mobile-client` and its
  catalog export/publish module. It must not alter Collection API semantics.
- Video owns its analysis/review modules, `app/src/similarity` additions and a narrow
  transaction helper in `library/trash.rs`; existing image review remains intact.
- UI entry/Settings changes that overlap are integrated by root after both feature
  contracts are available. No global formatting or broad unrelated cleanup.

## Cross-lane design checks

1. At planning start `library/db.rs` declared schema 44 and initialization automatically
   snapshotted/migrated on open. Integration now targets schema 46; all development migration
   and recovery acceptance used TEMP libraries.
2. Existing metadata restore upgrades its TEMP copy before swapping
   (`library/backup.rs`, `restore_snapshot_locked`). New tables and preserved human
   decisions need old-snapshot and round-trip recovery tests.
3. Existing catalog server endpoints are transport proxies. They cannot stand in
   for PC query/group/visibility semantics. Projection export and shared fixture
   parity are required; production publication remains gated separately.
4. Image similarity review owns `review` candidates and may remove candidate files.
   Normal video pair review needs separate state and transaction semantics. A
   recommendation itself cannot change folders, trash state or original bytes.
5. Current server/mobile Collection contracts accept three types. AV is initially
   local-only; its presence must not break publication of existing Collections.
6. Disposable frames/features are not durable user state. Pair decisions, AV
   metadata/people/artwork ownership and PC bookmark/visibility authority must
   survive recovery independently of caches.

## Execution and verification sequence

- [x] Review all three plans against inspected code and resolve shared-file contracts.
- [x] Implement feature-owned AV, video-similarity and mobile-catalog modules while keeping production data untouched.
- [x] Integrate command registration, schema 45 then 46, recovery hooks and shared UI entry points.
- [x] Run feature-targeted Rust, Python, React and Android boundary checks.
- [x] Run the complete desktop frontend and Rust regression suites after fixing invalidated fixtures.
- [x] Build the desktop frontend and Tauri application through the real `tauri build` path.
- [x] Launch the bundled application from an isolated WebView2 profile and verify that it renders from `tauri.localhost`, without the Vite dev server.
- [x] Record final evidence and remaining operational/product-validation gates.

The integrated implementation slice is complete. This does not authorize production migration,
server deployment/publication, Git commit/push, a broad backfill, or mutation of
`C:\New_lakomics_assets`.

## Integration evidence — final 2026-09-08 pass

Evidence is under ignored `.acceptance/parallel-roadmap/`. Database and media fixtures are
isolated. The final Tauri startup check used a fresh WebView2 profile.

| Check | Final result | Evidence |
| --- | --- | --- |
| SQL migrations 0 through 46 | exit 0; foreign-key check empty | initial migration-chain acceptance |
| Rust catalog parity/read-only exporter | exit 0; 2 focused tests plus shared query fixture/parity cases | `cargo-mobile-final.log` |
| Historical migrations | prior DB migration suite 28 passed; corrected real v36 and v40 fixtures also pass through current schema | `native-db.log`, `migration-catalog-v36-final.log`, `migration-tracking-v40.log` |
| Metadata backup/restore | 14 passed | `native-backup-final.log` |
| AV artwork/restore | 4 passed including daily-backup restore of metadata, people order and all three cover roles | `native-av-rerun.log` |
| Native video-similarity unit policy | 11 passed; the explicit native FFmpeg test remains ignored in the default filter and was run separately | `video-unit-rerun.log` |
| Native FFmpeg re-encode/resolution verification | 1 passed; synthetic variant matched 12/12 requested slots and reversed timeline was rejected | `video-native-final.log` |
| FFmpeg timeout/cancellation lifecycle | 1 passed | `video-tool-lifecycle-final.log` |
| Mobile-catalog Python replica/API | 13 passed | `mobile-server-final.log` |
| Mobile React client | 10 files / 53 passed | `mobile-ui-final.log` |
| Mobile TypeScript/Vite production build | exit 0 | `mobile-build-final.log` |
| Android native compile/policies | compile passed; NetworkPolicy 80, DocumentTree 19, ThumbnailCache 18, MediaTransfer 22, TemporaryImage 23 plus PickerSnapshot | `android-native-final3.log` |
| Full desktop frontend | 109 files / 893 passed / 0 failed | `frontend-full-final3.log` |
| Desktop frontend production build | exit 0 | `desktop-build-final3.log` |
| Full Rust library | 769 passed / 0 failed / 18 explicitly ignored | `rust-full-final2.log` |
| Tauri bundled debug build | exit 0 through `npm run tauri -- build --debug --no-bundle` | `tauri-debug-build-final2.log` |
| Bundled application startup | responding process, real window handle/title `Lakomics`, WebView title `Lakomics`, URL `http://tauri.localhost/`, dev server false | `desktop-bundled-launch-final.json` |

The 18 ignored Rust tests are existing explicit manual/performance/real-model or production-style
gates. The native video FFmpeg test and process-lifecycle test relevant to this execution were
manually selected with `--ignored` and both passed.

## Closure fixes found by the final pass

- The AV backup/restore test's earlier `Stale` result did not reproduce after the concurrent edit
  state had settled. Temporary revision diagnostics showed both precheck and transaction revisions
  matching; the diagnostics were removed and the final AV restore test passed.
- Empty/missing FFmpeg frame output is now `insufficient_evidence`, while an oversized output remains
  `output_limit`. The native 12-second fixture now supplies 24 source frames at 2 fps so the final
  requested midpoint at 11.5 seconds is real evidence instead of an out-of-range frame.
- The existing App preference fixture now includes the already-persisted
  `pinnedClassificationIds` and `classificationOrderIds` fields.
- Full frontend discovery had been traversing ignored historical copies under `app/.tmp`; Vitest now
  excludes `**/.tmp/**`. Three stale UI assertions were updated to current collapsed/async UI
  behavior and the full 893-test suite is green.
- Two old migration tests simulated historical schemas by dropping a table or lowering only
  `PRAGMA user_version` on a latest-schema DB. They now construct actual v36/v40 databases from the
  migration files before testing upgrade to the current schema.
- The Cloud Capture 25-attempt fixture passed in isolation but its five-second local test-server wait
  could expire under the complete Rust suite's CPU load. Its test-only receive allowance is now 15
  seconds; the complete Rust suite passes.
- A plain all-bin `cargo build` initially hit Windows page-file exhaustion (`os error 1455`). The first
  Tauri build then hit disk exhaustion (`os error 112`) with only about 1.38 GiB free. Only generated
  Rust `target/debug/incremental` cache was removed, freeing roughly 11 GiB; the real Tauri build was
  then rerun with `CARGO_BUILD_JOBS=1` and passed.
- Android `build.ps1 -CompileOnly` emits harmless javac warning/note text that the remote PowerShell
  wrapper treated as terminating `NativeCommandError`. The same compile-only script logic was run
  from a temporary copy with `ErrorActionPreference=Continue`; every external exit code check stayed
  intact and all native checks passed. The temporary script was deleted.

## Final implementation state

### MOBILE-006 implementation slice

PC export/publication code, immutable Python replica/publication, search/detail/edition/bookmark-filter
reads, PC settings entry, mobile UI and Android read allowlist are connected. Python, Rust parity,
mobile UI/build and Android native boundary checks pass. Production deployment/publication and a
real PC-off Galaxy Tab catalog session remain operational acceptance, not code-completion gates here.

### SIMILARITY-003 implementation slice

Bounded explicit-video analysis, persistent scan state, cancel/resume/recovery guard, source-byte
verification, durable fingerprint/review records, transaction-safe keep/trash decisions and the
existing review surface's video pane are connected. Unit policy, actual local FFmpeg re-encode,
reversed-timeline rejection and child timeout/cancellation checks pass. A representative real-video
positive/hard-negative corpus is still required before claiming generalized detection accuracy,
trim/subclip support or a production threshold guarantee.

### LONG-001 / LONG-002B implementation slice

AV Collections, typed people/roles, front/spine/back ownership, backup recovery, Mobile Collections
exclusion, AV edit/detail UI and focused complete-cover snap/original view are connected. The bundled
desktop app builds and opens. Native file-picker use and subjective focused-cover visual acceptance
with real user media remain product acceptance, and external AV-provider import was never part of
this manual-first slice.

## Operational boundary after completion

No operation in this final pass wrote to `C:\New_lakomics_assets`. No server deployment, production
catalog publication, production backfill, Git commit or push was performed. The final bundled-app
startup used a fresh WebView2 profile and was terminated after verification. Applying schema 45/46
to the normal production library and exercising live publication/device flows remain explicit
operational decisions.
