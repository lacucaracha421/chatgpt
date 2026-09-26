# OSS trial: PixAI tagger (2026-09-26)

Read-only trial for `OSS-SCAN-20260926`. Scripts/results: `~/.cache/lakomics-oss/pixai/` (machine-local). v0.9 ran on a stratified 1,000-image sample; v1.0 was only timed on 4 images.

## Models (Apache-2.0)
- **v0.9** (`deepghs/pixai-tagger-v0.9-onnx`): EVA02-L 448 px, 9,741 general + 3,720 character tags, 1024-d embedding, 1.27 GB. CPU 2 threads: 4.7 s/image (≈ 11 h for the library), 2.4 GB RAM. Needs originals (thumbnails are 360 px).
- **v1.0** (`noaione/pixai-tagger-v1.0-onnx`, unofficial ONNX): 30,877 tags incl. 4,917 style (= artist), copyright, rating, current Danbooru names; ≈ 30 s/image at 4 threads, ~7.5 GB RAM — not practical on this PC without a GPU.

## Results (v0.9)
- **Tag search:** mean 57 tags/image at ≥ 0.3; top-15 general tags ~90–95 % correct on 40 viewed images (clothing, hair, objects strong); character tags at ≥ 0.85 on 37 % of images, mostly correct, weak on post-Jan-2025 games; a few confident false characters. 6,330 distinct general tags used.
- **NAI prompt from image:** tags split into the NAI tag board sections (캐릭터 / 장면 / 품질·제외; 작가 needs v1.0); 98.3 % general and 99.3 % character tags exist in the NAI app's Danbooru dictionary — misses are Danbooru renames (`*_footwear`→`*_shoes`, `*_headwear`→`*_hat`), fixable with a small alias map.
- **Folder suggestions:** the PC library has only 3 images with no folder (the "~1,200 미분류" figure came from mockup sample data, not the library). As hints for filing: leaf folder top-1 54 % / top-3 74 %; top-level top-3 92 %; showing only confident suggestions (≥ 0.5) covers 22 % of images at 90 % top-1. Confusions: 리버스 sub-folders, 니케 ↔ 오리지널, catch-all top-level folders.

## Recommendation
Adopt **v0.9 for tag search** (and optional folder hints / "copy as NAI prompt"), hold v1.0 until a GPU or smaller input is measured. Run as a job in the existing Python character sidecar (onnxruntime already a dependency); store `asset_tags(asset_id, tag, category, score, model_version)` with scores ≥ 0.2; tag new captures incrementally and backfill history as a pausable low-priority job (~11 h CPU); publish tags to the server for a tablet `/v1/library/search?tags=` route (+ NetworkPolicy allowlist).
