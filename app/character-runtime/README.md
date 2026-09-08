# Character runtime — frozen inference and native scan

`worker.py` is the independent Batch 1 parity worker. Batch 3 connects the separate
`scan_worker.py` protocol to native start/status/cancel/results commands. Neither
protocol has been enabled against the active production library. Workers read
native-supplied images/models and write JSON lines to stdout.
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

`feature_cache.py` wraps the unchanged inference with disposable `.npz` features
under the selected library's `.cache/characters/<runtime fingerprint>/`. The key
contains actual source SHA-256, baseline/model hashes, worker/cache/inference source
hashes, Python, NumPy, ONNX Runtime and Pillow versions. Refs changes reuse features;
comparisons are recomputed. Reads verify source content even on hits. Corrupt entries
are recomputed; writes use atomic replacement and startup removes interrupted
`.part` files. Old namespaces are disposable and currently have no automatic eviction.

Only normal `image` assets in the explicit target's recursive subtree are scanned;
its five reference IDs are excluded. A start captures the asset inventory. New
arrivals need another start, which reuses prior extraction. One worker runs per
Library. Native state holds the latest scan per target, including pending, unmatched,
recommended, error and stale rows, with pages of at most 200. Restarting discards
these recomputable rows; feature files and durable human decisions remain separate.

The runtime does not download models or install Python. The Character Review
screen provides an explicit native picker for an existing Python executable and
model folder. It probes the real worker and validates the frozen model baseline
before atomically saving `character-runtime.json` in the app configuration directory.
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

The private scan protocol emits `ready`, accepts one `prepare` with five path/hash
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

## Review and durable judgments

Assets exposes Character Review through its toolbar and folder context menu.
Choose a recursive series scope, create characters, and select five existing image
references. Series analysis runs ready targets sequentially. Latest per-target
results support recommended, unmatched, multiple, confirmed, pending and error
filters. Review reuses the existing masonry gallery and selection gestures.

Recommendation approvals carry scan, target and runtime fingerprints. Native code
rechecks actual reference/query bytes and scope before a single transaction stores
human decisions; multiple character approvals roll back together. Explicit manual
assignment remains separate. Folder membership is never written by this workflow.
Decision history and confirmed relations survive restart/metadata recovery; raw
predictions are disposable and need a cache-backed scan again after restart.

For analysis-bound decisions, `reference_snapshot` stores an object containing
`scanId`, `runtimeFingerprint`, `prediction` and `references`; manual decisions keep
the reference array. The legacy field name `baseline_fingerprint` stores the full
runtime fingerprint for analysis-bound decisions, including the frozen baseline.
No additional schema beyond migration 44 was introduced by the review UI.
