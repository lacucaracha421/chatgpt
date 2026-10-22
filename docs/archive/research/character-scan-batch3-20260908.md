# Character scan Batch 3 — implementation and verification

Goal: connect the frozen Python inference to a native, explicitly requested
recursive-subtree scan with reusable features, progress, cancellation and evidence.

## Contract and implementation sequence

- Keep `runtime.py`, `baseline.json` and the Batch 1 worker protocol unchanged.
- Add `feature_cache.py` and `scan_worker.py`: atomic disposable feature files keyed
  by actual SHA-256 and a baseline/source/dependency fingerprint. Prepare five refs
  once, then evaluate one query per request. Reject oversized/changed inputs;
  corrupt cache entries are recomputed. No download or dependency installation.
- Add `library/character_scan.rs` and `character_worker.rs`: one scan per Library,
  owned subprocess, bounded messages, deadlines and cancellation that kills/reaps
  the child. Only the native owner resolves media paths. Renderer commands accept
  IDs, never Python/model/source paths. Runtime configuration comes from host env
  `LAKOMICS_CHARACTER_PYTHON` and `LAKOMICS_CHARACTER_MODELS`; scripts are bundled
  resources (source tree in development). Missing configuration fails explicitly.
- Store features under library `.cache/characters`; no schema migration. Retain
  the latest scan's paginated results in memory; restarting recomputes comparisons
  from cached features. Human decisions remain durable in library.sqlite.
- Snapshot normal still-image IDs in the selected target's recursive subtree;
  omit its reference IDs. New arrivals belong to the next scan. Recheck target/ref
  identity and each result's current scope/content before exposing recommendations.
  Negative matches and per-image errors remain distinct from unprocessed assets.
- Add start/status/cancel/results native commands, without frontend changes.
- Test scope, cancellation, child exit/protocol errors, stale results, cache reuse,
  corruption and content/config invalidation. Run a real cold/warm subprocess scan
  over TEMP copies of experiment fixtures and compare distances with saved results.

No active-library launch/migration, Git write, model download, deployment or UI work
is part of this batch. Packaging a Python interpreter and Linux/native WebView
acceptance remain explicit later gates. Implementation proceeds inline under the
approved batch design. Status: implemented; isolated gates passed on 2026-09-08.

## Final evidence

Checkout `C:\chatgpt`, branch `main`, unchanged HEAD
`aabf7b0b3f857fe10ed3359de38757d9558b50f1`; Batch 1/2 work remains uncommitted.
Review was inline, covering the new Python files, native scan/child ownership,
command registration, Library state and script resource declarations. No independent
review or real WebView invocation was performed.

| Check | Result | Local log |
| --- | --- | --- |
| Python unittest discovery `test_*.py` | 18 passed, exit 0 | `.acceptance/character-batch3/python-final.log` |
| `cargo test --lib library::character -- --include-ignored --nocapture` | 15 passed, 0 ignored, exit 0 | `.acceptance/character-batch3/rust-final.log` |
| SHA-256 comparison against Batch 1 final report | runtime.py, worker.py, baseline.json unchanged | comparison in task output |
| `git diff --check` | exit 0 | tracked working changes |

The Rust suite includes the 11 Registry/migration/recovery tests from Batch 2,
one direct stale-query test, a fake-child lifecycle test, a fake scan integration
test and a real ONNX native scan test. The opt-in tests received the existing
experiment Python path through `LAKOMICS_CHARACTER_TEST_PYTHON` in the test process.
Existing compiler warnings remain; no dependency install was performed.

Actual ONNX run: TEMP copies of five Hina refs and two Hina query images, plus
one deliberately corrupt image. The two original-ref query distances matched the
saved experimental report within absolute tolerance `1e-6`. This is a focused
integration gate; the full 226-query Batch 1 corpus was not rerun.

| Phase | Query inventory | Extra inference | Feature cache hits | Errors |
| --- | ---: | ---: | ---: | ---: |
| Cold | 1 | 6 | 0 | 0 |
| Same scan again | 1 | 0 | 6 | 0 |
| New valid image + corrupt image | 3 | 1 | 6 | 1 |
| Ref replacement | 3 | 0 | 7 | 1 |

Counts include the five prepared reference features. The corrupt asset sorts
between valid queries, so success of the later query verifies failure isolation.
Other gates cover cancellation, duplicate-start rejection, stale target edits,
query folder moves, reference bytes changed without a metadata update, malformed/
oversized responses, child exit, blocked stdin, deadlines, parent pipe loss,
cache corruption, changed content/configuration, atomic publication and partial
file cleanup. Final worker/cache runtime fingerprint:
`47c8ffbde11233181164b3c998aaee3637fc18f13dabeb104318c1a4c363da53`.

## Operational limits and Batch 4 boundary

- No new migration was required; v44 from Batch 2 remains the latest source schema.
  No active library write, app restart, commit, push or deployment occurred.
- Python/model paths are explicit host configuration. Scripts have resource
  declarations, but release bundling and interpreter distribution are unverified.
- One latest scan is held in memory. Starting another replaces those result rows;
  restart recomputes comparisons from feature cache. Multi-target conflict review
  and retained per-target result sets belong to the review UI integration.
- Result reads revalidate target/ref content and current query scope/content.
  The Batch 2 manual decision API is unchanged. Batch 4 must bind recommendation
  approval to a current scan/evidence token and revalidate at the mutation boundary;
  reading validated results alone is not an approval transaction.
- Cache is disposable and excluded from metadata recovery. After recovery without
  cache, scan can recompute. Old runtime namespaces currently require deliberate
  maintenance; no eviction policy or 8,000-image performance claim is made.
- UI, full series acceptance and WebView IPC remain unverified. This batch proves
  the real Rust-to-Python inference path with isolated copies, not active-library
  product acceptance. Frozen threshold, same-crop consensus and 18% crop are unchanged.
