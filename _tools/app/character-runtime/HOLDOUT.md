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
