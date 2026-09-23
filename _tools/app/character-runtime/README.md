# Character runtime — frozen inference and native scan

`worker.py` is the independent Batch 1 parity worker. The product uses the separate
`scan_worker.py` protocol only through the Rust native owner; renderers never receive
filesystem/model paths. Verification commands in this document use fixtures or explicitly
configured runtime inputs and must not be pointed at the production library without
separate user authorization. Workers read native-supplied images/models and write JSON
lines to stdout.
It never imports the experiment, downloads models, accesses SQLite, or changes
classification membership. Product scope enforcement belongs to the Rust
native owner: the selected classification's recursive subtree, with a separate
character relation. Do not expose this path-based protocol to the renderer or HTTP.

## Standalone learned classifier

[CLASSIFIER.md](CLASSIFIER.md) documents the opt-in S36 plus per-character learned
head CLI. It supports local extraction, grouped training/calibration, held-out
replay and image-to-JSON predictions. It is **shadow-only**, is not imported by the
native scan worker, and does not publish or change production classifications.

## Conditional native augmentation (opt-in)

The incremental queue can now retain every native acceptance and add a character
when a recall-calibrated S36 learned head supports a detected person, even with
zero B36 reference votes, with no overlapping strong-native or ready-head rival. Manual accepted/rejected/cleared decisions and reference-self guards still
win. Full manual scans remain native-only.

This path is **off by default**. In **Settings → General → Character omission
augmentation** (`캐릭터 누락 보완`), use the on/off toggle; there is no model picker.
When no explicit model path is saved, the runtime resolves
`<configured models>/augmentation/model_feat.onnx` and keeps augmentation disabled.
Provisioning that file does not enable classification. Disabling retains the path
for later use. The UI reports model availability separately from learned-head
readiness, validates the worker before enabling, and never starts a full historical
sweep. Validation failure leaves settings intact.

Settings persist in the existing machine-local `character-runtime.json`:
`augmentation_model` retains the absolute model path and `augmentation_disabled`
stores the off switch. Legacy files with a model path and no off switch keep their
previous behavior. `LAKOMICS_CHARACTER_AUGMENTATION_MODEL` still overrides these
fields; the UI explains this and locks changes while that override is present.
The path must point to the pinned S36 ONNX weights (SHA256
`484ad463f569ab95308cf47e91ba358b01c40bc53289b90b950b94fcde7f2628`).
Keep S36 in its `augmentation` subdirectory: do not replace the B36
`<configured models>/model_feat.onnx`. The app does not download or install weights;
local provisioning is separate from activation. Settings and activation change
only through an explicit user action. Re-running native runtime setup resets this opt-in.
An empty environment override disables it; a missing, corrupt, or incompatible
optional model leaves native classification working.

Heads are built locally from current manual labels and seed references, not from
experimental CV fold artifacts or previous automatic acceptances. Unknown
memberships and cleared decisions never become negatives; supporting references
without manual labels supply no training truth. Each source group gets one vote;
PDQ whole/cropped near-duplicate groups remain in one deterministic 60/20/20
train/calibration/held-out split, and reference groups are training-only. A head
requires separate calibration groups with at least one positive and two negatives.
Threshold candidates are 0.5 and unique calibration bag-max logistic scores at
least 0.5. Eligible thresholds recover at least one positive, have positive
`TP - 2*FP` utility, and allow at most `max(1, floor(negative_count / 10))` errors.
Selection maximizes `(TP - 2*FP, -FP, threshold, TP, FP)`. There is no additional
B36-support or zero-error incremental-gain gate. Logistic scores are not calibrated
identity probabilities. This recall tradeoff permits occasional false positives;
calibration is not a guarantee of production accuracy, especially for unlabelled
companions. The standalone classifier's strict calibration is unchanged.

Cold preparation never runs inside an image classification job. Until a matching
head is ready, the native result alone is published. The existing queue consumer
prepares the latest requested scope only when no native jobs or historical refresh
remain. Each idle turn captures or extracts at most one source; arriving work
gets priority before the next turn. Both automation pause and history pause block
preparation, and manual requests retain priority on the shared worker. There is
no second worker or additional CPU concurrency. A worker restart defers rebuilding
the head to idle time again. Optional preparation failure drops that request;
a later eligible query may request preparation again. The snapshot includes at
most eight targets, 128 selected labelled sources, and 256
total sources including references (at most 512 MiB of source snapshots).
Oversized rosters or references without a
usable current PDQ fingerprint fall back to native. Models stay in the worker;
restart rebuilds them from cached features when idle. Warm-up does not automatically requeue
already completed images; the existing explicit historical-refresh action remains
the way to reconsider them. No new background history sweep is introduced.

S36 uses B36's boxes without a second detector, two CPU threads, and an independent
atomic feature-cache namespace. Once ready, query extraction is skipped unless an
enabled, ready, not-already-accepted target exists. Missing query PDQ is computed
from the captured immutable source outside the database lock, in memory only;
stored low-quality PDQ is still rejected. Training/reference sources still require
stored usable PDQ. Exact and near-duplicate training/calibration exposures are
withheld. Native code accepts only `recall-tp-minus-2fp-v1` policy responses and
validates their calibration counts, error budget, utility and threshold. Before publication,
native code rechecks the training snapshot, source-file identities, query,
references, scope and manual decisions. Optional failure or stale training drops
only additions; source/scope changes invalidating native evidence still cancel the
whole transaction. Added judgments retain model/snapshot/gate/region provenance
under `prediction.augmentation`; files and saved folders are not moved.

Code and fixture checks do not constitute Windows/Tauri-window acceptance or a
production-quality measurement. Historical recall-calibration gains belong to
their recorded experimental inputs, not automatically to a newly built live head.

## Frozen contract

`baseline.json` pins the models, hashes, threshold, preprocessing and crop policy.
Both references and queries use cropped features; only no-valid-crop cases use
the whole image. Every query crop must match at least two distinct reference
images, using the best crop per reference. There is no whole-image OR branch.
Exactly five distinct content hashes are required; similarity-based duplicate
rejection is not part of this baseline. GIF decoding uses frame zero, as in the
experiment; this does not adopt animated-media scanning for the product.

The metric graph runs on one query plus five reference groups, at most 48
vectors and a 48x48 float32 output (9,216 bytes). This bounds the distance matrix,
not the decoder/model's total process memory. Image dimension/resource limits,
cache lifecycle and cancellation are handled by the Batch 3 wrapper below.
Interpreter packaging and Linux/WebView acceptance remain later gates.

## Batch 1 plan and gate

1. Preserve the original experiment and reports. Pin the test_3 reference names
   recorded by `verification-generic-check.json`; compare its score rows with the
   original fixed report before using it as provenance.
2. Extract the frozen inference algorithm into `runtime.py`; keep model sessions
   alive across JSON-lines requests in `worker.py`.
3. Test preprocessing against the original implementation, same-crop/distinct-ref
   consensus, threshold boundaries, fallback, hash rejection and bounded metric parity.
4. `verify.py` cold-runs Hina and test_3 through the subprocess worker, compares
   every consensus distance/pass with saved reports at absolute tolerance 1e-6,
   records input/reference/model/source hashes, checks source immutability and
   confirms a missing query file does not prevent later results. Failure exits nonzero.
5. Write the measured result to the research evidence document. Do not move to
   Registry/migration until this gate has been reported.

Run from `C:\chatgpt` with the already installed environment:

```powershell
& TEST_kisaki/_experiment/.venv/Scripts/python.exe -B -m unittest discover -s _tools/app/character-runtime -p 'test_*.py' -v
& TEST_kisaki/_experiment/.venv/Scripts/python.exe -B _tools/app/character-runtime/verify.py --output .acceptance/character-batch1/report.json
```

The verification output is local evidence, not durable user state. `verify.py`
may read experiment caches only for a separate bounded-metric parity check;
worker inference is cold and has no cache reader. No active-library paths are
included in the dataset requests. Existing report labels remain unchanged.

## Batch 3 native scan

`feature_cache.py` stores disposable `.npz` image features under
`.cache/characters/<extraction fingerprint>/`. Extraction identity includes the
detector/feature-model hashes, preprocessing/crop policy, extraction code AST,
Python, NumPy, ONNX Runtime and Pillow versions. Matching thresholds, comparison
code, learned examples, the worker protocol and cache implementation do not invalidate
features. Runtime/result identity remains separate and tracks all worker/comparison
sources, so changed decisions are recomputed while image features remain reusable.

Reads still verify source bytes and cached content/shape/finiteness. Corrupt entries
are recomputed; writes are atomic. Machine-local `cache-compatibility.json` beside
the models can map an extraction identity to explicitly verified legacy namespaces.
Only exact 64-character hashes are accepted, at most eight namespaces; unknown caches
are never inferred compatible. Legacy entries are read through the same validation
without copying or rewriting them. Old namespaces have no automatic eviction.

The legacy manual scan path remains target/series scoped. The native automatic owner
uses the shared scope resolver: a registered series owns its ordinary descendants;
when no registered ancestor exists, ready characters in eligible descendant series
are compared together. Unrelated folders and Originals do not enqueue character work,
and explicit reference
assets are excluded from authorizing themselves. One worker runs per Library. Native state holds the latest scan per target, including pending, unmatched,
recommended, error and stale rows, with pages of at most 200. Restarting discards
these recomputable rows; feature files and durable human decisions remain separate.

The runtime does not download models or install Python. Persistent runtime/system
failure exposes the quiet `분석 환경 설정` recovery action, which provides a native
picker for an existing Python executable and model folder. It probes the real worker
and validates the frozen model baseline before atomically saving
`character-runtime.json` in the app configuration directory. Cancelling either picker
leaves the previous error/settings state intact.
A failed probe leaves previous settings intact. Settings are machine-specific,
outside library metadata recovery. Alternatively, explicit host overrides are:

```powershell
$env:LAKOMICS_CHARACTER_PYTHON = 'D:/configured-runtime/python.exe'
$env:LAKOMICS_CHARACTER_MODELS = 'D:/configured-models'
```

The executable must provide the dependencies used by the frozen runtime. Model
hashes are checked at every worker startup. Script resources are declared in Tauri
configuration; development uses the source directory. Renderer IPC takes IDs and
fingerprints, never executable/model/image paths. No HTTP scan endpoint is added.

The private scan protocol emits `ready`, accepts one `prepare` with 5–25 path/hash
entries, then one `query` at a time. The native owner must keep stdin open; EOF is
ownership loss and terminates the worker even during inference. Rust kills/reaps
on cancellation, protocol failure, timeout or normal completion; stdout messages
are bounded to 256 KiB and each response has a 120-second deadline. Images over
256 MiB or 50 million pixels are rejected rather than changing preprocessing.

Test from `_tools/app/src-tauri` with an explicitly supplied existing Python environment:

```powershell
$env:LAKOMICS_CHARACTER_TEST_PYTHON = 'C:/chatgpt/TEST_kisaki/_experiment/.venv/Scripts/python.exe'
cargo test --lib library::character -- --include-ignored --nocapture
```

The opt-in Rust tests use TEMP copies and the existing experiment models. They do
not open the active library. This proves the Rust-to-subprocess path, not WebView
IPC, bundled-interpreter installation or large-library performance acceptance.

## Quiet automation, correction, and durable judgments

Routine collection does not expose a Character Review inbox, per-character pending
badges, scheduler counts, cache state, or target-by-target progress. Automatic work
runs quietly for the nearest registered series, or eligible descendant series of an
ordinary parent folder, and uses the current explicit reference set. Character management keeps visible correction/recovery actions without
turning unresolved history into a required review queue.

Reference growth affects newly enqueued images immediately. Historical reconsideration
starts only from the explicit `과거 미분류 이미지 갱신` action, runs below fresh work,
and is durable across restarts. Its pause flag is separate from the normal automatic
worker, so pausing historical maintenance does not block new-image classification.

Recommendation approvals carry scan, target and runtime fingerprints. Native code
rechecks actual reference/query bytes and scope before a single transaction stores
human decisions; multiple character approvals roll back together. Explicit manual
assignment remains separate. Automatic finalization adds character memberships but
never changes the saved ordinary classification or the source file. Cross-series
competitors participate in the same arbitration; existing manual decisions remain
authoritative. Decision history, automatic evidence,
predictions, and confirmed relations are durable; the machine-local feature cache remains
disposable and can be rebuilt after restart.

For analysis-bound decisions, `reference_snapshot` stores an object containing
`scanId`, `runtimeFingerprint`, `prediction` and `references`; manual decisions keep
the reference array. The legacy field name `baseline_fingerprint` stores the full
runtime fingerprint for analysis-bound decisions, including the frozen baseline.
Later character workflow migrations persist automatic queue evidence, explicit supporting references,
series exclusions, manual-only characters, groups, and protected classification roles.

## Explicit supporting references

The five manually selected anchors remain required. A user may explicitly add up to
20 additional distinct-content images already assigned to that character. Ordinary
manual accept/reject/clear decisions never mutate this set. Supporting references must
remain normal still images in the character's series scope; invalid references stay
visible for recovery and suspend automatic arbitration for that series until fixed.
These are retrieval examples, not model weight training. References actually used for
a query are recorded and their current content/scope is revalidated before publication.

`learned_compare.py` compares those examples through the unchanged five-reference
metric in bounded groups, discards padding votes, then computes same-crop distinct-image
consensus over the combined pool. Recommendation remains two matches. Automatic
approval requires same-crop support from **six distinct references**, with the sixth-smallest
reference distance at or below **0.16**, resolved same-person competition, and no whole
fallback (`AUTOMATIC_REFERENCE_SUPPORT = 6`). Two automatic-strength candidates for
an overlapping person always remain unresolved. A recommendation-only competitor
(two or more votes) stops blocking only when its second-smallest distance is at least
**0.05 greater** than the winner's sixth-smallest distance, on every overlapping crop.
Missing, failed, fallback, or malformed competing evidence cannot authorize this
relaxation. Different people are still classified independently; manual decisions
and self-reference exclusions remain authoritative. These distances are not
probabilities, and the margin is a conservative policy choice, not a calibrated
accuracy guarantee. The offline evaluator records this as policy version 2 and
retains version 1 replay for frozen datasets. No historical work is automatically
requeued by this policy change.

Characters with only the five anchors can still be
recommended but cannot satisfy automatic approval until additional explicit supporting
references exist. The recommendation threshold remains unchanged. The UI displays the
actual reference count. Worker preparation accepts 5–25 images.

Manual scan buttons now apply the same automatic policy when the selected series has
automatic classification enabled. They compare all ready characters in that series
before applying, so a single selected-character scan cannot bypass ambiguity checks.

### Common-person reference regions

The product resolves reference regions before comparing queries. Existing manual
regions take precedence; single-person detections need no confirmation. For an
unselected multi-person image, a common person can be inferred from a matching
triangle containing an existing manual/single-person anchor and two other source
images. Subsequent synchronous rounds require agreement from two selected source
images. Each image contributes at most one vote, ties abstain, and query images
never help choose reference regions. Without an anchor, no identity is guessed.

Inferred choices are transient (`state: automatic`, `automaticIndex`), not saved
manual selections. Evidence retains the original `referenceSelections` alongside
the resolved `referenceRegions` and `referenceStatuses`. Stale manual bindings and
images with no detected person supply no votes. Metric calls remain bounded to
48 vectors, and prepared views are reused across queries. Incremental comparison
falls back to full-set preparation when an old or added reference could change
common-person inference; stable explicit/single/no-region views retain delta reuse.

Character settings inspect references quietly. A manual chooser is offered only
when fewer than six usable references remain and an unresolved region can help;
it opens on request and stops once reinspection reaches six. Optional correction
remains available. Six usable references are not a classification guarantee:
query support, the stricter automatic distance gate, and competitor arbitration
still apply. This change does not start historical reanalysis.

### First-analysis timing (opt-in)

Set `LAKOMICS_CHARACTER_PROFILE=1` before launching the normal Tauri development
command to write cumulative JSON `characterProfile` records to the development
terminal. The default remains quiet. Windows PowerShell uses
`$env:LAKOMICS_CHARACTER_PROFILE='1'`; Linux uses
`LAKOMICS_CHARACTER_PROFILE=1 npm run tauri -- dev` from `_tools/app/`.
Do not start a production-library scan without the user's approval.

Counters separate file hashing, image decode, detector inference, feature inference,
metric inference, total comparison and total cache extraction. Total counters contain
substage time; do not sum totals and their substages. Compare per-operation deltas,
cache hits and extraction counts, not cumulative time alone. Native manual scans also
report `native_input_verification_ms` for source preparation. No file paths, asset
names or image content are included in timing records.

Instrumentation leaves the frozen inference implementation, CPU settings, feature
cache identity and source-integrity checks intact. Cold/warm synthetic measurements
validate the instrumentation and cache reuse; they do not establish real-library
throughput or justify a CPU/GPU configuration change.


## Frozen offline evaluation

See [HOLDOUT.md](HOLDOUT.md) for the standard-library-only exporter and evaluator.
It freezes explicit manual labels and pre-feedback evidence, screens duplicate and
reference leakage, and reports automatic/recommendation metrics without inference.

## S36 primary-model preparation (stage 2a, code only)

The primary native classifier remains B36. `baseline.json` and manual region
bindings are unchanged. S36 `feature_id` now hashes only the encoder's contract,
image validation, session setup, detector crop selection and extraction AST,
plus pinned S36 weights and the baseline extraction identity (including Python,
NumPy, Pillow and ONNX Runtime versions). Comments, cache I/O and unrelated
functions no longer expire vectors. This is a one-time namespace change from the
old whole-file identity; no old cache is migrated, copied or declared compatible.
S36 writes use unique same-directory `.part` files and atomic replacement.
Startup cleanup preserves live POSIX writers; legacy/unidentified partials have
24 hours of grace (also used on Windows, where no process signal is sent).

`s36_scoring.py` is the NumPy-only shared CCIP cosine/knn3/contrast implementation,
with per-crop scores and the native same-person overlap test. Replay calls that
implementation with already normalized float32 vectors, preserving its numerical
results. Raw-vector callers normalize through the default scoring entry point.
No primary-model activation or native publication integration is included here.

`s36_library_cache.py` prepares only
`.cache/characters/s36-augmentation-v1/<feature_id>/<hash>.npz`. It accepts a
read-only replay export, or `--hashes` with a JSON list of objects containing
`content_hash` and `media_kind`. It verifies canonical source bytes, reads existing
B36 boxes without constructing a cache writer, and otherwise runs the current
B36 detector policy through the encoder/runtime helpers. It skips non-images and
whole-image fallbacks, uses at most two ONNX intra-op threads (one inter-op), and
resumes from validated S36 entries. It never opens a library database.

**Dry-run first. A real run needs explicit user approval because it writes the
library `.cache`.** Use the installed runtime Python with `-B`; supply actual
paths and the dry-run's exact `feature_id` for an approved write:

```text
python -B s36_library_cache.py --dataset /research/replay.json --library /fixture/library --models /existing/models --cpu-minutes 5 --stop /research/STOP --limit 10 --dry-run
python -B s36_library_cache.py --dataset /research/replay.json --library /fixture/library --models /existing/models --cpu-minutes 5 --stop /research/STOP --limit 10 --expect-namespace <feature_id>
```

Dry-run prints JSON counts and an explicitly assumed CPU planning range without
loading ONNX sessions, creating directories or cleaning partials. Detection may
later discover additional fallbacks. The CLI disables ORT telemetry before import
to prevent telemetry files or uploads. `--limit` bounds uncached image attempts;
validated hits do not consume it. STOP and CPU time are checked between blocking
operations; one in-flight decode/hash/model call can exceed the budget, after
which no further extraction or publication occurs. The CPU budget is per run,
including all process threads; resume gets a new budget, with no ledger writes.
Full-library extraction, calibration, in-app shadow and publication are later,
separately authorized stages.

## S36 full-library features and calibration (stages 2b–2c, 2026-09-23)

The approved full-library extraction wrote 8,282 new entries (126 already cached;
436 non-images and 117 whole-image fallbacks skipped) into namespace
`e4be203d…ba9f`. Chronological replay of that namespace chose knn3 (AUC 0.80).
`s36_policy.json` pins the resulting shadow policy: automatic membership at knn3
≤ 0.1304 (walk-forward target 2%) only after at least 100 earlier manual
rejections, and recommendations up to 0.1490 (target 5%). From 2026-09-10 this
replays at 39.5% recall / 0.81% FPR automatic and 48.5% / 1.89% recommended. The
first replay day is excluded by the rejection guard: with 25 rejections its
threshold admitted 16–17 false positives for one character. The file is not read
by the native runtime and `baseline.json` is unchanged; in-app shadow scoring
(2d) and publication (3) remain separately authorized stages.
