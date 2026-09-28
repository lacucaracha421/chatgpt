# 닮은 작가 추천 mockups (2026-09-28)

Throwaway PC design mockups for ARTIST-SUGGEST-001: suggest a library artist for 작가 미상 images from art style (Kaloscope 2.0 features). Suggestions only; nothing is assigned automatically.

The rule shown is the one validated on 2026-09-28 (read-only, `~/.cache/lakomics-oss/kaloscope/scripts/evaluate2.py`): suggest when the best neighbour's similarity is ≥ 0.55 and it leads the second artist by ≥ 0.05. Walk-forward precision about 85 % (near-duplicates by source post and the app's PDQ rule excluded); the user reviewed 40 random suggestions: 34 correct, 0 wrong, 6 unsure (5 were reposter accounts of official art). Current library: 363 of 5,396 작가 미상 images get a suggestion, 175 artists.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window at 1:1; ids are `a`, `b`, `c`, `d`. Imagery is generated colour blocks; artist handles are fictional.

| Screen | File | What it shows |
| --- | --- | --- |
| A (recommended) | `s-a.png` | Artist index: 작가 미상 carries a "추천 363" badge; the page gets a 추천 있음 filter chip. A "닮은 작가 추천" section on top lists suggested artists (most suggestions first, five at a time): artist avatar, name, library count, four of their images; the suggested 작가 미상 images with similarity, all checked by default; actions 선택한 이미지 지정 (count), 이 작가 아님 (dismiss this suggestion; never suggested again), 퍼온 계정으로 표시 (see D). The usual 작가 미상 grid follows. |
| B (alternative) | `s-b.png` | No grouping: each grid image gets a "닮은 작가 · name 0.63" strip; 추천 있음 filters to suggested images; a selection bar offers "name로 지정" when the selected images share one suggestion. Lighter, but harder to compare one artist's suggestions. |
| C | `s-c.png` | Image inspector on a 작가 미상 image: a suggestion box under the 작가 row with the artist, similarity, their three most similar images, 지정 / 아님, and the runner-up ("다음 후보"). No box when there is no suggestion. |
| D | `s-d.png` | Artist edit panel: "퍼온 계정 — 작가가 아님" (accounts that repost official art or screenshots). On: the account is no longer a suggestion target, and the artist list moves it under 정리 › 퍼온 계정 with a 퍼온 계정 pill. Images already attributed stay. |

Implementation notes for later (not decided): store the 2048-d Kaloscope feature per image (import the existing 8,899-image run; new images after the nightly tagging job), rank artists by best non-duplicate neighbour, remember dismissals and the reposter flag in the library, migration needed.
