# Korean natural-language image search: GPU bake-off (2026-10-04)

The trial ran on the main PC (RTX 5070 Ti) outside the repo. Scripts, vectors, captions and judgments are machine-local in `C:\laku\nlsearch-trial` (`README.md`, `REPORT.md`, `results/final-score.txt`, `pool/judgments.json`). The library was read through a SQLite snapshot only. The decisions taken from it are in the backlog under `NL-SEARCH-001`.

## Setup
- **Corpus:** 9,103 normal images and GIFs. Videos were out of scope.
- **Queries:** 32 Korean queries in 8 groups: appearance, scene, expression, action, image type, mood, proper nouns, and others.
- **Metric:** precision@10. Judging was blind and pooled: the union of every method's top 10 was shuffled, and each tile was judged 0/1. In total 1,997 tiles were judged by one judge (Claude), strictly. For example, light blonde was wrong for "silver hair", and no tie was wrong for "suit and tie". With 32 queries, differences below about ±0.03 are noise.
- **Translation baselines:** "ref" rows use hand-written translations and tags as an upper bound. "auto" rows use Qwen3-VL-8B (NF4) translation, which was poor: 은발 became "blonde", and 3 of 32 outputs were not valid JSON.

## Results (P@10)

| Method | P@10 | Notes |
|---|---|---|
| Name dictionary + SigLIP2 (opus-mt) + Qwen-emb-8B + caption BM25, RRF | **0.73** | P@1 0.81 |
| Name dictionary + SigLIP2 (opus-mt) + Qwen-emb-8B, RRF | 0.72 | chosen "precise" mode |
| Name dictionary + SigLIP2 (opus-mt) | **0.68** | chosen v1; CPU query side |
| Name dictionary + Qwen-emb-2B, RRF with SigLIP2 (opus-mt) | 0.66–0.70 | 14 tiles unjudged |
| SigLIP2 so400m, hand translation (upper bound) | 0.64 | |
| Tags with hand-picked Danbooru tags (upper bound) | 0.63 | proper nouns 0.90 |
| SigLIP2, opus-mt-ko-en translation | 0.62 | |
| SigLIP2, Qwen3-VL-8B translation | 0.58 | |
| Qwen3-VL-Embedding-8B, Korean query directly | 0.58 | |
| Qwen3-VL-Embedding-2B, Korean query directly | 0.54 | |
| Korean captions (Qwen3-VL-8B), BM25 bigrams | 0.50 | |
| Korean captions embedded with Qwen-emb-2B | 0.47 | hub images recur |
| Tags with Qwen3-VL-8B tag translation | 0.41 | |
| SigLIP2, Korean query directly | 0.37 | |

## Findings
- **Existing library data solved proper nouns.**
  - `character_targets.display_name` already maps 80 Korean names to tagger tags, for example 레제 → `reze_(chainsaw_man)` and 엘렌 → `ellen_joe`. Routing those queries to auto-tag scores gave 0.90 on proper nouns, with no translation model involved.
  - A series folder name next to a character name ("체인소맨 레제", "젠레스 존 제로 엘렌") must be absorbed into the name route. Treating it as an extra description word dropped those queries to 0.4 and 0.2.
- **The small dedicated translator beat a large VLM.** `Helsinki-NLP/opus-mt-ko-en` (Apache-2.0, about 300 MB) runs in 0.27 s per query on CPU. It translated better than Qwen3-VL-8B NF4. Its errors were "메카" → "Mecca" and series names, which the dictionary covers.
- **Captions add little to search.** They added +0.01 overall, though they helped mood, image type and meme queries. The captions are still good: they read in-image text ('APT.', 退勤) and do not refuse adult images. Keep them for later uses.

## Cost (main PC)
- **Image indexing on GPU:**
  - SigLIP2: 12.5 min for the whole library.
  - Qwen-emb-8B (NF4): 0.28 s per image.
  - Qwen3-VL-8B captions (NF4): 1.38 s per image at batch 16. Batch 1 was 13.7 s per image because bitsandbytes NF4 is slow at batch 1.
- **Query side, v1:** load about 10 s, about 0.6 s per query, RSS 4.1 GB, CPU only.
- **Query side, precise mode:** load about 30 s, GPU 4.8 GiB, about 0.07 s per query.

## Licences
SigLIP2, Qwen3-VL and Qwen3-VL-Embedding are Apache-2.0, and opus-mt-ko-en is Apache-2.0. Not used: JoyCaption (Llama licence, English only) and `opus-mt-tc-big-ko-en` (CC-BY-4.0; broken output in this transformers version).
