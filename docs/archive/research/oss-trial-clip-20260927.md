# OSS trial: Korean natural-language image search (CLIP/SigLIP, 2026-09-27)

Scripts/results: `~/.cache/lakomics-oss/clip/` (machine-local). 1,494 library images, 26 Korean queries + English versions, 5 image seeds, precision@10 judged from contact sheets.

| Model (licence) | Inference/img (2 thr) | Text query | precision@10 KO / EN / image→image |
|---|---|---|---|
| SigLIP2-base-patch16-256 (Apache-2.0, 768-d) | 0.37 s | 109 ms | 0.25 / **0.53** / **0.64** |
| clip-ViT-B-32-multilingual + clip-ViT-B-32 (Apache/MIT, 512-d) | 0.085 s | 27 ms | 0.27 / 0.37 / 0.52 |

Excluded: jina-clip-v2, MetaCLIP 2, NLLB-SigLIP (CC BY-NC); anime-tuned EVA02 CLIP (embeddings collapse; English tags only); so400m not finished (re-run later on an idle machine).

Works: mecha, monochrome manga pages, maids, swimsuits, animal ears, hugging, groups (EN 7–10). Fails: crying face, blue twin tails, cherry blossoms, silver hair + glasses, rainy night city. Korean is about half the English precision (proper nouns, "maid outfit" KO 1 vs EN 10). Same-character search should stay with CCIP.

sqlite-vec vs NumPy: ~10× slower (9k × 768: 12.9–15.5 ms vs 1.2 ms), still interactive; int8 cuts storage 4×.

**Recommendation:** SigLIP2-base with a Korean→English query translation step (next experiment; an external translator needs consent); run in the Python character runtime via ONNX, embed on ingest (~1 h backfill), vectors in the library DB; tablet search server-side with int8 vectors (~7 MB/9k) and the text tower on the VPS (~1.5 GB RAM). Compare with PixAI tag search (`oss-trial-pixai-20260926.md`) before choosing.
