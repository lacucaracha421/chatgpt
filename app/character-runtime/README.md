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
& TEST_kisaki/_experiment/.venv/Scripts/python.exe -B -m unittest discover -s app/character-runtime -p 'test_*.py' -v
& TEST_kisaki/_experiment/.venv/Scripts/python.exe -B app/character-runtime/verify.py --output .acceptance/character-batch1/report.json
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
uses the shared nearest-registered-series resolver: broad/unrelated roots do not enqueue
character work, nested registered series own their descendants, and explicit reference
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

Test from `app/src-tauri` with an explicitly supplied existing Python environment:

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
runs quietly for the nearest registered series scope and uses the current explicit
reference set. Character management keeps visible correction/recovery actions without
turning unresolved history into a required review queue.

Reference growth affects newly enqueued images immediately. Historical reconsideration
starts only from the explicit `과거 미분류 이미지 갱신` action, runs below fresh work,
and is durable across restarts. Its pause flag is separate from the normal automatic
worker, so pausing historical maintenance does not block new-image classification.

Recommendation approvals carry scan, target and runtime fingerprints. Native code
rechecks actual reference/query bytes and scope before a single transaction stores
human decisions; multiple character approvals roll back together. Explicit manual
assignment remains separate. Automatic finalization may assign an eligible root-scoped
asset to its uniquely resolved registered series, while unrelated classifications and
other character memberships remain preserved. Decision history, automatic evidence,
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
approval requires support from **six distinct references**, a unique character candidate,
and no whole fallback (`AUTOMATIC_REFERENCE_SUPPORT = 6`). Characters with only the
five anchors can still be recommended but cannot satisfy automatic approval until
additional explicit supporting references exist. The UI displays the actual reference
count. Worker preparation accepts 5–25 images.

Manual scan buttons now apply the same automatic policy when the selected series has
automatic classification enabled. They compare all ready characters in that series
before applying, so a single selected-character scan cannot bypass ambiguity checks.

### First-analysis timing (opt-in)

Set `LAKOMICS_CHARACTER_PROFILE=1` before launching the normal Tauri development
command to write cumulative JSON `characterProfile` records to the development
terminal. The default remains quiet. Windows PowerShell uses
`$env:LAKOMICS_CHARACTER_PROFILE='1'`; Linux uses
`LAKOMICS_CHARACTER_PROFILE=1 npm run tauri -- dev` from `app/`.
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
