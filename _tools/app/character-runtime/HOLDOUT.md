# Frozen character evaluation

`character_holdout.py` exports explicit human decisions and replays stored machine
evidence. It needs Python 3.10+ and the standard library. It does not run model
inference, enqueue jobs, alter decisions, download media, or change thresholds.

## Freeze once

Run from the repository root. Choose an absolute database path and an existing
output directory outside that database's directory. Every output name must be new.
Choose the cutoff before tuning a candidate policy or inspecting its holdout.

```bash
python3 -B _tools/app/character-runtime/character_holdout.py freeze \
  --database /absolute/path/to/library.sqlite \
  --output /absolute/path/outside-library/character-holdout.json \
  --cutoff "2026-09-14T12:00:00+09:00"
```

The date above is an example, not a claim that historical tuning used that cutoff.
Windows can use `python` and quoted Windows paths with the same arguments.
`--series-id ID` restricts labeled targets to one series while retaining competing
characters in each stored evidence bundle. `--near-distance` defaults to 30 and
`--minimum-quality` to 50 for the stored 256-bit PDQ fingerprints.

SQLite uses `mode=ro`, `query_only=ON`, and one read transaction. Do not use
`immutable=1` on a live WAL database: that could miss committed WAL content.
The export includes IDs, character names, hashes, decisions, and distances. Treat
it as private library metadata. It includes no image bytes or source file paths.

## Evaluate without reopening the library

```bash
python3 -B _tools/app/character-runtime/character_holdout.py evaluate \
  --dataset /absolute/path/outside-library/character-holdout.json \
  --partition calibration \
  --output /absolute/path/outside-library/calibration.json

python3 -B _tools/app/character-runtime/character_holdout.py evaluate \
  --dataset /absolute/path/outside-library/character-holdout.json \
  --partition holdout \
  --output /absolute/path/outside-library/holdout.json
```

The default `--policy frozen` reuses the recorded policy. `--policy current` reads
the native support/distance constants in this checkout. Both report the exact
policy and source hashes. A changed extraction/recommendation baseline is refused.
Omit `--output` to print a report. Failed validation exits with status 2.

Reports include automatic and recommendation TP/FP/FN/TN, precision, recall, F1,
per-target/per-series summaries, supported-target macro means, and slices by
person count, reference count, and runtime identity. Empty denominators yield
`null`. Acceptance fractions and false positives per 1,000 refer to **labeled
pairs**, not all incoming images. Whole-library coverage is explicitly unknown.

The JSON envelope has a SHA256 digest over canonical dataset content. This detects
accidental edits; it is not an authenticity signature. Keep the original frozen
file when comparing reports. Outputs are created exclusively and never overwrite
an earlier dataset or report.

## Dataset and interpretation rules

- Use the latest explicit manual accepted/rejected decision. A later clear or an
  automatic-only decision is not ground truth. No negative labels are inferred
  from another character's membership in a multi-person image.
- Match the current asset hash and source generation. Select evidence strictly
  before the first manual feedback for that pair. Later reanalysis cannot replace it.
- Retain the full stored competitor bundle, including targets without a manual label.
  Replay same-crop support, the sixth distance, overlapping-person competition,
  self-reference protection, and decisions already present at prediction time.
- Group exact hashes and transitive PDQ neighbors. Exclude groups overlapping a
  reference, crossing the cutoff, or containing contradictory labels for a target.
  Collapse duplicate pairs. Report missing usable PDQ data instead of asserting
  complete near-duplicate isolation.
- Read prediction payloads only for selected evidence IDs. The grouping operation
  is bounded to 12,000 relevant hashes; larger exports must use a narrower scope.

`evidence_identity.rows_without_baseline_fingerprint` exposes legacy/unverified
baseline metadata. An explicitly incompatible baseline is rejected. Missing PDQ
or baseline identity requires additional checking before claiming independent accuracy.
These selected historical pairs cannot establish overall library precision/coverage.
For detector, crop, or model changes, build a separate image-inference runner using
these frozen labels and hash identities. This tool replays distances already stored.
Future changes to native arbitration must update `holdout_rules.py` and its parity
cases; recording source hashes does not automatically translate new Rust logic.

## Fixture verification

```bash
python3 -B -m unittest discover -s _tools/app/character-runtime -p 'test_character_holdout*.py' -v
```

## Chronological feature replay

`replay_dataset.py` / `replay_eval.py` are offline, standard-library + NumPy tools.
Run in `character-runtime/` with the existing runtime Python and `-B`. Output names
must be new, in an existing directory outside the library. No inference or writes
back to the library occur; input/code digests and interpretation limits are reported.

```bash
python -B replay_dataset.py export --database /library/library.sqlite \
  --output /research/replay/dataset.json
python -B replay_eval.py evaluate --dataset /research/replay/dataset.json \
  --space b36 --features /library/.cache/characters/B36_64_HEX_NAMESPACE \
  --scorers rule6 knn3 contrast prior --feedback-lag 1 \
  --output /research/replay/b36.json
python -B replay_eval.py evaluate --dataset /research/replay/dataset.json \
  --space s36 \
  --features /library/.cache/characters/s36-augmentation-v1/S36_64_HEX_NAMESPACE \
  --extra-s36 /research/s36_extra.pkl \
  --box-features /library/.cache/characters/B36_64_HEX_NAMESPACE \
  --feedback-lag 1 --stream --output /research/replay/s36.json
python -B -m unittest test_replay_eval -v
```

Replace namespace placeholders with actual hashes. Repeat feature arguments in
first-wins precedence order. Namespace compatibility is a caller assertion. The
optional S36 pickle is `hash -> ndarray/None`; its model identity and alignment to
B36 boxes cannot be independently verified. SQLite uses `mode=ro`, `query_only=ON`,
one read transaction, never `immutable=1`. If WAL sidecars prevent read-only access,
use a separately captured consistent external snapshot with `--library-root` set
to the original library; document capture provenance, never silently omit a WAL.

- Latest manual state per target/hash supplies truth; clears invalidate it.
  Automatic-only pairs are **unreviewed automatic**, never negatives. Historical
  manual revisions feed galleries only when available. Equal-time labels never
  train each other; lag 1 releases feedback on the next UTC day (lag 0 is strictly
  earlier timestamps). Learned references must predate the query.
- Current untimestamped anchors/region choices are an **initial-seed assumption**,
  not proven historical availability. Known target creation times gate galleries.
  The unchanged `reference_regions` resolver runs through an AST adapter with a
  NumPy metric; ambiguous/stale/fallback references abstain. Witnesses are fixed
  at decision time. See report limitations for missing historical state.
- Rust `image_fingerprint.rs` confirms whole-image PDQ occupies bytes 0..32 of
  the 64-byte blob. The old holdout reader only accepts 32-byte blobs and misses
  this format. Replay uses transitive Hamming <=31/post groups, including uncached
  bridges, to exclude query relatives before gallery resolution; missing PDQ is
  reported. No PDQ quality filter is imposed.
- Snapshot scope follows `character_scope.rs`: one folder, nearest registered
  ancestor with authoritative opt-out, otherwise eligible descendant series;
  originals and inherited folder/per-asset exclusions apply. Historical folder
  changes and native job/publication fences are not reconstructed.
- `rule6` measures the sixth-distance/support component, with a two-vote flag,
  not full native arbitration. `contrast` uses the pooled enabled same-series
  competitor gallery and same-crop margins. Empty positive galleries abstain
  (ranked last in AUC); missing/fallback query features are skipped and counted.
- **Walk-forward** thresholds use earlier frozen scores and the feedback lag;
  cold starts abstain. Report observed FPR beside recall: drift can exceed 2%.
  **Oracle** thresholds use all evaluation labels and are optimistic. Inspect
  the `prior` canary and macro AUC (>=5 positives and >=5 negatives per target)
  before interpreting pooled AUC as visual discrimination.
- `--stream` freezes the final walk-forward threshold: counts are **unlabeled
  volume, not precision**, limited by feature availability. Automatic-only pairs
  remain unlabeled; explicit reference pairs are withheld.

Previous B36 0.610 / S36 0.731 AUC used all-target contrast; same-series values
were 0.448 / 0.568. Prior 0.132 / 0.380 recall was anjo-excluded **oracle** recall.
Those scripts also retained query relatives, guessed multi-person seed witnesses,
and excluded reference-self truth pairs. These are different evaluation contracts.

### S36 preparation and replay controls

S36 cache identity uses the vector-producing encoder AST, pinned model SHA256,
and baseline extraction identity/library versions. Comments or unrelated helpers
do not expire vectors; vector-affecting edits do. The change creates a new
namespace once and does not assert compatibility with old S36 caches.

Replay and future S36 consumers share `s36_scoring.py` (NumPy only): normalize
float32 vectors to unit L2 length, then use `0.5 * (1 - cosine)`. Per query crop,
knn3 is the mean of the nearest `min(3, gallery size)` positive distances. Contrast
is that positive mean minus the smaller of the manual-rejection knn3 mean and
the same-series competitor knn3 mean. Empty negative pools contribute 1.0;
empty positive pools abstain. Each score is minimized over query crops only after
computing its per-crop value. Existing replay arithmetic and rule6 are unchanged.

- `--witness references` fixes both accepted and rejected witnesses to the crop
  nearest any current resolved reference view at the historical event time.
  Later references/manual labels cannot choose the witness. Query relatives and
  stale/ambiguous references remain excluded. Multi-person feedback without a
  usable reference abstains; a single detected person is unambiguous. Default
  `gallery` retains historical witness behavior.
- `--gallery-cap N` retains the latest N manual accepted and N manual rejected
  states per target, after query-relative exclusion. Missing witnesses consume a
  slot; references stay separate and uncapped. Latest rejections/clears still
  suppress reference votes, and the prior canary still counts all manual states.
  Default is unlimited; zero disables manual feature-gallery additions.
- `--rates 0.01 0.02 0.05` controls both oracle and walk-forward target FP rates,
  including stream estimates. Those values remain the defaults. Rates must be
  finite in `[0, 1)` and are recorded with witness/cap settings in the report.

Use `s36_library_cache.py --dry-run` first to inspect extraction counts and CPU
planning assumptions (see [README.md](README.md#s36-primary-model-preparation-stage-2a-code-only)).
It consumes the export or a hash/media-kind list, reuses B36 boxes read-only, and
writes only S36 cache entries on an explicitly approved real run. Real extraction
requires the printed `--expect-namespace`; no library extraction is authorized
by these code or fixture changes. The old `locate()` research helper now lives in
`replay_dataset.py` and verifies canonical content hashes for both tools.
