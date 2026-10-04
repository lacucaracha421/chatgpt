# Natural-language search runtime

Machine-local components for Korean natural-language image search, located at `_tools/app/nl-search-runtime/` in the Lakomics repository. The GPU index job writes an inbox export; the desktop imports it into a disposable library cache and ranks queries in Rust. This directory contains runtime code and fixture tests, not research artefacts or model weights.

| File | Runs on | Needs |
|---|---|---|
| `nl_index.py` | main PC, GPU, nightly or manual | torch (CUDA), transformers, bitsandbytes, Pillow; models SigLIP2 so400m-384 and Qwen3-VL-Embedding-8B |
| `nl_query_worker.py` | main PC, CPU (optional GPU for Qwen) | torch, transformers, sentencepiece; models opus-mt-ko-en and SigLIP2 (text tower only) |
| `nl_rank_reference.py` | anywhere | numpy only. This is the ranking spec for the Rust port. |

The shared code lives in `runtime_support.py`. Models load offline from `HF_HOME`. The desktop sets it from machine-local configuration. Standalone jobs use `HF_HOME`, or the usual `~/.cache/huggingface` default. GPU dependency versions are recorded in `requirements-gpu.txt` (CUDA 13.0 wheels); installing models and dependencies is a separate manual setup step.

## Desktop configuration

The app reads `nl-search-runtime.json` beside `character-runtime.json` in its app configuration directory:

```json
{"python":"<absolute Python executable>","runtime":"<absolute path to _tools/app/nl-search-runtime>","hfHome":"<offline Hugging Face cache>","precise":false}
```

Environment overrides are `LAKOMICS_NL_SEARCH_PYTHON`, `LAKOMICS_NL_SEARCH_RUNTIME`, and `LAKOMICS_NL_SEARCH_HF_HOME`. The app never creates this configuration file. With no runtime override, debug builds use the repository directory; release builds resolve `nl-search-runtime` under the Tauri resource directory, following the character runtime precedent. Release bundling is not configured in this backend phase, so releases require an explicit runtime path until those resources are added.

Search is available only on the active main performance profile, with a configured runtime and at least one cached SigLIP vector. Precise mode is opt-in; missing Qwen vectors or failed Qwen startup fall back to CPU SigLIP. The worker starts on prewarm or a cosine search, stops after 30 idle minutes, and is killed on app exit. Tags-only and mixed-fallback queries do not start it.

## Index job

```
python nl_index.py --library <configured library root> --state <machine-local state dir> --inbox <auto-tag inbox dir> [--models siglip,qwen8b] [--limit N] [--seed-from-trial <trial>/out]
```

- The library DB is opened read-only, and the corpus is `status='normal' AND media_kind IN ('image','gif')`.
- Vectors are stored in `<state>/vectors.sqlite`, keyed by `(content_hash, model_id, preprocess)`. A moved or re-imported file is not recomputed. A different model or preprocessing tag is recomputed.
- Preprocessing `pack1024-q90` (EXIF transpose, RGB, GIF first frame, long side ≤ 1024, JPEG q90 round trip) matches the research trial.
- Work is resumable per batch. Unreadable files are skipped and logged, and the job keeps GPU allocation under 12 GiB.
- Full run on 2026-10-04: seeded from the trial, 9,103 assets, 0 computed, export 117.6 MB. Seed check cosine was ≥ 0.99999 for SigLIP and ≥ 0.999 for Qwen (NF4).

### Inbox file `nl-search-latest.sqlite`

The file is written atomically (temp file plus `os.replace`). It is rewritten only when `content_digest` changes.

```
meta(key TEXT PRIMARY KEY, value TEXT)
  format=lakomics-nl-search  version=1  preprocess=pack1024-q90
  siglip_model  siglip_dim=1152  qwen_model  qwen_dim=4096
  asset_count  created_at (UTC ISO)  content_digest (sha256; excludes created_at)
siglip(asset_id TEXT PRIMARY KEY, vector BLOB NOT NULL)   -- float16 little-endian, L2-normalised
qwen8b(asset_id TEXT PRIMARY KEY, vector BLOB NOT NULL)   -- same; absent when not requested
```

## Query worker protocol

`python nl_query_worker.py [--threads 2|3|4] [--with-qwen8b]`

- **Transport:** UTF-8, one JSON object per line. Messages are below 256 KiB. Diagnostics go to stderr only.
- **Ready line:** first line `{"type":"ready","load_seconds":…,"rss_bytes":…,"threads":…,"qwen8b":bool,…}`, or on failure `{"type":"startup_error","error":…}` and exit 1.
- **Request:** `{"id":"<str>","op":"embed","text":"<Korean query>"}`.
- **Response:** `{"id":…,"ok":true,"en":"<translation>","siglip":[1152 floats],"latency_seconds":…,"rss_bytes":…,"warm":bool}`. It adds `"qwen8b":[4096 floats]` with `--with-qwen8b`.
- **Errors:** `{"id":<str|null>,"ok":false,"error":"…"}`. The worker keeps serving.
- **Exit:** `{"op":"shutdown"}` or stdin EOF ends the process.
- **Measured on the main PC (5600X, 4 threads):**
  - Translation and SigLIP text: load about 10 s, warm query median 0.60 s, RSS 4.1 GB. The text tower is 708 M parameters in fp32. Shrinking it is a laptop follow-up.
  - `--with-qwen8b`: load about 26–30 s, GPU 4.8 GiB, about 0.07 s per query. Vectors match the trial exactly (cosine 1.0).

## Ranking reference

`Ranker.rank(query, response, top=200)`:

1. **Names:** whitespace tokens equal to a character name are name hits. Names are `character_targets.display_name`, split on `/`. Each hit maps to its tagger tags (`character_target_tagger_tags`).
2. **Series absorption:** a token equal to a hit character's series folder name (`classification_entries.name` via `series_classification_id`) is absorbed. So is every token between that series token and the name. For example, `젠레스 존 제로 엘렌` and `체인소맨 레제` stay name queries.
3. **Names only:** rank by the max auto-tag score over the hit tags (score > 0). Ties break by asset id. Route `tags`.
4. **Names plus other words:** keep assets whose max hit-tag score ≥ 0.35, then rank them by SigLIP cosine of the full query (route `mixed`). If that set is empty, fall back to rule 3 (route `mixed_fallback`). This route is not measured in the trial.
5. **No names:** rank all assets by SigLIP cosine (route `siglip`). Image vectors are stored as float16 and normalised again in float32 before the dot product.

The desktop exposes camelCase results: `mixed_fallback` becomes `mixedFallback`, and `siglip` becomes `cosine`. Its corpus includes only normal image/GIF assets with SigLIP vectors, for all routes. Limits default to 200 and clamp to 1–500. When precise mode and Qwen query/image vectors are available, cosine routes fuse the top 200 rankings from each model using reciprocal rank fusion with k=60; ties break by asset id. Otherwise results report `precise: false`.

**Check:** `python nl_rank_reference.py --inbox … --db … --check-trial .. --responses worker-responses.json`. With live CPU query vectors, 30 of the 32 trial queries reproduce the trial top-10 exactly. q26 and q29 hold the same ten images with near-tied neighbours swapped (fp32 CPU vs fp16 GPU query vectors).

## Tests

From this directory, `python -B -m unittest test_runtime` runs fixture tests without model loads or a production library:
- export schema, float16 round trip, unchanged skip and atomic publish;
- content-hash reuse and invalidation;
- invalid vectors;
- worker protocol;
- routing rules including series absorption;
- an optional real-snapshot equivalence check, skipped unless `LAKOMICS_NL_SEARCH_TRIAL` points at a trial root containing its runtime export/responses and library snapshot. No default test depends on a machine-specific trial or model-cache path.

The measured figures above are historical trial observations, not native desktop acceptance of this repository integration.
