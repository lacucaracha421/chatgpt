# Character workflow completion — Batch 4/5

Implement the approved review workflow inline. Preserve the frozen baseline,
single direct folder membership, active-library boundary and existing WIP.

1. Retain the latest scan per target and add a current review page combining
   predictions and durable human decisions. Filters: all, recommended, unmatched,
   multiple candidates, confirmed, and errors/pending. Existing folders stay intact.
2. Bind recommendation mutations to scan ID, target revision/fingerprint and runtime
   fingerprint. Recheck actual ref/query hashes and scope inside the database lock;
   reject stale batches atomically. Preserve inference evidence with decisions.
3. Add an Assets entry to a shared fullscreen Dialog. Reuse AssetGallery, Select,
   Button, selection gestures and media URLs. Provide Registry edit/disable, five-ref
   picker, sequential series scans, cancellation, filters and batch decisions.
4. Verify backend stale/multi-target/recovery behavior, frontend interaction tests,
   TypeScript, and an isolated browser fixture. Runtime/model setup must be explicit
   and observable. No production launch, migration, commit, push or deployment.

Status: implemented; isolated automated gates passed on 2026-09-08. Native
WebView/device, visual browser inspection and production acceptance remain unverified.

## Delivered workflow

- Assets toolbar and classification context menu open Character Review. Shared
  fullscreen Dialog, existing masonry gallery and selection behavior are reused.
- Create/edit/disable characters, optionally link an existing folder, select or
  replace five reference assets from the recursive series subtree. Existing folder
  membership is preserved. Missing/deleted refs require replacement before scanning.
- Explicit runtime setup uses native file/folder pickers. A real worker/model
  probe must pass before settings are atomically saved. Python/models are existing
  user-managed dependencies; no automatic download or install was added.
- Scan a selected target or all ready targets sequentially; show progress, cache
  hits, inference count and per-image errors; cancel the owned worker. Keep latest
  results per target so multiple-character review survives the next target's scan.
- Filter recommended, unmatched, multiple candidates, confirmed, pending and errors;
  inspect original/crop evidence; approve/reject individually or by selection;
  approve all candidates atomically; explicitly assign another character manually.
- Read and clear durable judgment history. Reference/query content, scope and
  target/runtime/scan identity are revalidated at approval; stale approval never
  silently falls back to manual assignment.

## Design changes and persistence

No migration beyond v44 is needed for this batch. `character_relations` derives
current accepted membership from the latest human decision. Multiple character
decisions commit in one transaction, capped at 200 unique target/asset pairs.
Reapplying the same latest decision is idempotent.

`reference_snapshot` keeps the manual reference array, or an analysis evidence
object containing scan ID, runtime fingerprint, prediction and references. The
existing `baseline_fingerprint` field holds the complete runtime fingerprint for
analysis-bound decisions. This avoids adding a second durable prediction database.
Registry, refs and human decisions survive restart and recovery; ephemeral raw
predictions are reconstructed by another scan using disposable cached features.

Runtime settings reside in the app configuration directory, not metadata snapshots.
A migrated PC needs its own Python/model selection. Recovery upgrades the TEMP
snapshot before swapping the DB, and character decision history survives actual
TEMP source-file deletion. No operating library was opened or migrated.

## Verification evidence

All paths below are ignored local evidence under `C:\chatgpt`.

| Gate | Result | Evidence |
| --- | --- | --- |
| `npx tsc --noEmit` | exit 0 | `.acceptance/character-final/typescript.log`; captured `TSC_EXIT=0` |
| Character UI interaction tests | 5 passed, exit 0 | `.acceptance/character-final/frontend-focused.log` |
| Existing AssetBrowser regression tests | 155 passed in 3 files | `.acceptance/character-final/frontend.log` |
| `cargo test --lib library::character -- --include-ignored --nocapture` | 17 passed, 0 ignored, exit 0 | `.acceptance/character-final/backend.log` |
| Python/runtime baseline | unchanged from previously passing Batch 1/3 gates | Batch 1/3 records; no inference-source edits in Batch 4 |
| `git diff --check` | exit 0 | task output; only existing line-ending notices |

The initial combined frontend run had one failure in the new stale-error test:
refresh cleared the error immediately. Removing that clear fixed the problem;
the focused five-test suite then passed. The three existing AssetBrowser suites
had passed and their code was not changed afterward. An additional Rust test edit
initially used `unwrap` on a Vec; the corrected final run above passed.

The final native suite verifies real worker setup/persistence and failed-probe
preservation in TEMP; per-target scan retention; scope, cancellation and child
failure limits; actual reference/query bytes changed after preview; atomic multi-
target rollback; recovery and durable history after actual TEMP source deletion.
Actual ONNX cold/warm/incremental/ref-replacement counts were respectively
`6/0`, `0/6`, `1/6`, `0/7` (extractions/cache hits), with a deliberately corrupt
query isolated in the last two phases. Original-ref distances matched the saved
experiment within `1e-6`. Frozen inference/baseline files were not modified.

## Unverified acceptance and handoff

- CUA browser initialization failed with `failed to write kernel assets` / Windows
  error 3. A standalone local Chrome headless capture was rejected by automatic
  approval review as `blocked by policy`, with no more specific reason supplied.
  No browser screenshot or visual acceptance is claimed. A local isolated Vite
  fixture started successfully but is not evidence of a rendered page.
- Native commands compile and the real Rust-to-Python path passes, but no actual
  WebView IPC or native picker interaction was exercised. No production app was
  restarted. Full series precision/recall, user review time, 20+ real approvals,
  8,000-image performance, installer distribution and Linux remain unmeasured.
- Previously passing migration/backup and Python gates are recorded in Batches
  1–3. This batch does not claim a full Cloud/Capture/Android/Collection regression
  run or an independent reviewer.
- Implementation is uncommitted in the existing checkout. No Git write, deployment,
  dependency installation or write to `C:\New_lakomics_assets` occurred.

After separately authorized native/production acceptance, the entry flow is:
Assets → Character Review → choose series → create character → choose five refs →
configure existing runtime → analyze → review/approve. Operational acceptance is
still required before calling this deployed or fully validated on the real library.
