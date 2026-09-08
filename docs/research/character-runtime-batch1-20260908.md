# Character runtime Batch 1 — 2026-09-08

Status: **Batch 1 worker reproducibility gate passed**; no native integration or migration.

## Accepted scope

The user selected a separate character relation, preserving the existing single
direct classification and folder behavior. Series analysis uses the explicitly
selected classification's recursive subtree. These decisions are recorded in
[the workflow plan](character-classification-workflow-plan-20260907.md).

Batch 1 proves the inference boundary before Registry/SQLite changes. Implementation:
[runtime contract and commands](../../app/character-runtime/README.md).
Python/ONNX is the current worker candidate because it preserves the measured
Pillow/NumPy preprocessing. This does not establish final sidecar packaging or
Windows/Linux native acceptance.

## Verification contract

- CPUExecutionProvider; four intra-op threads, one inter-op thread.
- Fixed detector and CCIP feature/metric hashes are verified before loading.
- Both query and refs use detector crops; whole-image fallback only when no valid
  crop remains. No whole-image OR branch or threshold tuning.
- Same query crop, two distinct reference images out of exactly five.
- Query plus reference groups only: metric output at most 48×48 float32 values.
  This is a distance-matrix bound, not a whole-process memory bound.
- Cold worker: no experiment imports, inference caches, SQLite or network access.
- Hina 128 and test_3 98 evaluation images, plus five refs per dataset.
- Compare every consensus distance at absolute tolerance 1e-6 and every pass flag.
- Input/ref/report and runtime source hashes are captured; original inputs must
  remain unchanged. A missing query file between valid queries must be isolated.
- The original labels are preserved. test_3's user-confirmed target relabeling is
  a separately stated interpretation, not an edit to the source report.

## Reference provenance

Hina has exactly five reference images. test_3 has six, but its existing
`verification-generic-check.json` records these selected five:

1. `0393_Piplup_2053430226450010489.webp`
2. `HHCzQiwakAAs3b7.webp`
3. `HLQtCcxb0AAi6Mb.webp`
4. `HN8nDbqbgAASN97.jfif`
5. `HNR_EuHagAAUCHL.jfif`

That report and the original `verification-fixed-report.json` have identical
consensus distances (maximum difference 0) and pass flags for all 98 images.
`kaduki123_2056326502472655133.webp` is not silently included. Current input hashes
are recorded in the execution artifact; the original report has no historical
per-file input hash inventory, so historical byte identity is not asserted.

## Corrections found during implementation

The initial vectorized comparison let NumPy round the public threshold to
float32. The float32 value `0.2132311910390854` is above the public threshold
`0.21323118981474148`, yet NumPy's weak scalar comparison accepted it. The
experiment first converts metric values to Python float. The worker now widens
per-reference values to float64 before threshold comparisons, matching that
behavior without changing the threshold. The targeted regression test failed
before the correction and passed after it.

The first verifier counted labels with a forward-slash path prefix, which was
incorrect for Windows paths. Counts now come from the fixture's explicit labels,
and both slash styles are tested. Counts must also match the original report.

The first full cold run was not accepted as final evidence because source files
changed during it; its real exit code was 1. The final run uses separate output
`.acceptance/character-batch1/final-report.json` after all runtime/test corrections.

## Final measured evidence

Final command (from repository root):

```powershell
& TEST_kisaki/_experiment/.venv/Scripts/python.exe -B app/character-runtime/verify.py --output .acceptance/character-batch1/final-report.json
```

Real verifier exit code **0**, worker exit code **0**, elapsed **389.50 seconds**.
Windows / Python 3.12.14 / NumPy 2.5.3 / Pillow 12.3.0 / ONNX Runtime 1.29.0.
The source hashes were checked again after completion and still matched.

| Dataset | Evaluation images | TP / FP / FN (original labels) | Max absolute distance delta | Pass mismatches | Whole fallback queries | Seconds |
|---|---:|---|---:|---:|---:|---:|
| Hina | 128 | 18 / 4 / 1 | 4.0978193283081055e-7 | 0 | 14 | 209.88 |
| test_3 | 98 | 10 / 1 / 2 | 4.76837158203125e-7 | 0 | 0 | 178.21 |

test_3's `HAzQJW1aMAAD_IQ.webp` passed with distance `0.16668002307415009`.
Applying the already documented user confirmation changes its interpretation to
**11 TP / 0 FP / 2 FN**. The original report/labels were not edited.

All **226 evaluation-image pass flags matched**. Both datasets' input/report
hash checks passed, the injected missing image failed in isolation, later images
still completed, and an invalid reference request was rejected. Observed metric
stacks were at most 13/15 vectors for Hina/test_3; the focused maximum-size test
exercised the 48-vector bound. These are fixture timings, not full-library estimates.

Local detailed artifact: `.acceptance/character-batch1/final-report.json`
(ignored; includes all input hashes, references, crop evidence and per-image results).
SHA-256: `4420b1e93c5b7d922b49f6f076115b00630a14eda49f5620abc4730236c4da55`.

## Remaining gates

- Focused unittest suite: 11 passed, real exit code 0.
- Final cold run: passed with the final unchanged worker/runtime sources.
- Code review is inline, not an independent agent review.
- No active library writes, migrations, model downloads, dependency installs,
  commits, pushes or deployment were performed for this batch.
- Native scope resolution, persistent cache, cancellation, Registry/decision
  persistence, resource limits, Tauri sidecar installation and Linux operation
  remain subsequent gates. Path-based worker requests must stay private to the
  native owner; the renderer/HTTP must not select arbitrary filesystem paths.

Next implementation batch is the isolated Registry/refs schema and lifecycle
work. Active-library migration remains a separate authorization boundary.
