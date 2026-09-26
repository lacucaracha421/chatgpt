# OSS trial: sqlite-vec and CCIP clustering (2026-09-26)

Read-only experiment for `OSS-SCAN-20260926`. Scripts, logs and JSON: `~/.cache/lakomics-oss/results/` (machine-local). Nothing in the repo or app dependencies changed; the library was read via a SQLite backup copy (deleted).

## Data
- Vectors: S36 CCIP crop features from `.cache/characters/s36-augmentation-v1/…/*.npz` — 8,548 images, 19,592 crops × 768.
- Labels: latest accepted manual `character_decisions` or `character_references`, single-crop or region-matched only — 551 confirmed crops (59 characters), 2,296 auto, 2,149 ambiguous, 14,596 unlabeled.
- Today's kNN: Python NumPy brute force over small per-character galleries (`s36_scoring.knn`, distance `0.5*(1-cos)`, mean of 3 nearest).

## sqlite-vec 0.1.9 — later, not now
| Query | sqlite-vec ms | NumPy ms |
|---|---|---|
| k=3/10/50 over all 19,592 crops | 25.9–26.7 | 2.1–2.2 |
| k=3, 60-vector gallery via metadata filter | 15.8 | 0.017 |
| k=3, `partition key` (~65 per partition) | 0.99 | — |

Exact results (neighbour sets identical except one boundary tie). 60.9 MB DB, 2.0 s insert. The Rust crate compiles the C source in and registers via `sqlite3_auto_extension`; built and ran on Linux with rusqlite 0.40.2 / SQLite 3.53.2. Windows (MSVC) not verified. Worth adopting only when Rust needs kNN without the Python worker (similar-characters panel, cloud/mobile queries).

## Character discovery — Chinese Whispers wins; imgutils as reference only
imgutils 0.19.0 pins `numpy<2` and `ccip_clustering` crashes on NumPy 2.5; its defaults are tuned for another CCIP model (DBSCAN chains the whole library into one cluster; OPTICS is pure but leaves 81 % noise, minutes of CPU, O(N²) memory).

Chinese Whispers (reimplemented; no GPL code) over a symmetric top-10 graph at τ = 0.1304 (the S36 automatic threshold), full library, ~10 s:
- purity 0.977, B³ F 0.78, 55/59 known characters recovered as pure clusters;
- 27 pure clusters of known characters that are mostly unlabeled (509 crops) → "add to this character" suggestions;
- 83 tight multi-post clusters with no confirmed/auto crop → new-character candidates (46 inside an existing series). Candidate quality is unmeasured (background people, mascots, multi-form characters may appear).

Recommendation (`CHAR-AUTO-003`): ~60 lines of NumPy in `character-runtime` as a shadow-only "candidate groups" report; then a review screen to name/dismiss groups, measuring acceptance on ~20 groups first. Relates to `CHAR-AUTO-008` (multi-form splits).
