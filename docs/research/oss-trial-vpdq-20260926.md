# OSS trial: vPDQ similar-video matching (2026-09-26)

Read-only experiment for `OSS-SCAN-20260926` / `SIMILARITY-003`. Scripts, logs and `results.json`: `~/.cache/lakomics-oss/vpdq/` (machine-local). No repo or dependency changes; library read in place.

## Setup
Scratch Rust hasher on `pdqhash =0.1.1` (the app's version), ffmpeg frames ≤ 512 px, full + 5 %-crop PDQ per frame with quality. v2: 4 fps, black-border trimming. Match: quality ≥ 50, frame match at Hamming ≤ 31, score = share of query frames matched, both directions; "min4" = min over full/crop combinations; dedupe consecutive frames ≤ 16. Corpus: 447 library videos (314 min) + 14 sources × 5 synthetic variants (360p CRF 34, middle-60 % trim, 90 % crop, letterbox, combo).

## Cost
- Hashing 6.3 s wall per video-minute per process (decode-bound; ≤ 720p 3.3, ≤ 1080p 9.7, > 1080p 34 s/min). Whole library 837 s with 3 processes.
- Storage 69 B/frame (37 without crop hash) ≈ 13 KB per video, 5.7 MB total.
- All-pairs (517 videos, one thread): min4 17.2 s, full 5.4–7.6 s; quadratic in frames → a prefilter (band index / BK-tree, `PERF-SIMILARITY`) at ~5k+ videos.

## Recall (14 synthetic sources; both ≥ 0.8 / either ≥ 0.8 / current app v1)
| Variant | v2 min4 | v2 full | app v1 |
|---|---|---|---|
| re-encode | 14/14 | 14/14 | 13 |
| trim | 0/9 | 0/8 | 0 |
| 90 % crop | 11/11 | 0/0 | 10 |
| letterbox | 14/14 | 14/14 | 13 |
| combo | 0/9 | 0/8 | 0 |

Trims need the either-direction (subclip) rule; with dense target decoding trim recall is 14/14. Border trimming is essential (letterbox 0/14 without). False positives: 0 against unrelated videos at every threshold down to 0.5. Real library: 8 pairs both ≥ 0.8, 14 either ≥ 0.8 (app v1 finds 7), including a 108-minute video that contains three shorter ones — not visually confirmed.

## Recommendation: later, as an extension of the current video similarity (not a replacement)
The current fixed 12-slot check already covers re-encode/resize/letterbox/crop cheaply; vPDQ adds trim/subclip detection. Adopt when subclip duplicates matter: 2 fps with border trimming, full + crop hashes, quality ≥ 50, dedupe ≤ 16, match when either direction ≥ 0.8 (label "subclip" when the other is below). Integration: sequential decode in `library/video_media.rs`, a per-asset sequence table keyed by source hash and profile, the existing `video_similarity/scan.rs` job (opt-in, low priority), brute-force matching until ~5k videos, and a "subclip" evidence type with time range in Similarity Review. Risks: decode cost on 4K, crops beyond 5 %, dark/static videos, sampling phase, Windows unmeasured.
