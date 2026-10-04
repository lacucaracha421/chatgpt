# 내용 검색 (natural-language search) mockups (2026-10-04)

Three placements of Korean natural-language search, drawn in the real 1280 × 800 app frame with the app's tokens and actual trial results for "눈 내리는 겨울" (general-rated images only). Each option showed the palette state and the result state.

The page holds library images, so it is not kept in the repository. It was published as a private artifact (https://claude.ai/artifact/2sJNkanbQ9oaTjLdeWAHBH), and its generator lives in the machine-local trial folder (`C:\laku\nlsearch-trial\mockups\build.py`).

| Option | Flow | Size |
|---|---|---|
| **A — palette preview (chosen)** | The 찾기 palette shows an "이미지 내용" group: one row "‘…’ 장면 찾기" and a strip of the top 7 thumbnails. Enter opens the result state. | medium |
| B — dedicated search screen | One palette row. Enter opens a 내용 검색 screen with an editable query field, the translated reading shown faintly, a scope switch (전체 에셋 / 현재 폴더), and the inspector's 비슷한 이미지 찾기 using the same screen. | large |
| C — filter on the current view | Palette 이 화면에서 → 장면으로 좁히기. The result is a "장면: …" filter chip in the current folder, sorted 관련도순, and combinable with other filters and auto tags. | small |

## Decision (user, 2026-10-04): option A
- **Preview strip timing:** the strip updates only after typing pauses for about 0.4 s and no Hangul composition is active. It never updates per keystroke. The previous strip stays until the next one is ready (DESIGN.md §12, no flash).
- **Result state:** Enter turns the 에셋 area into a "내용 검색" result state. The toolbar shows the "이미지 내용" badge, the query, "관련도순 · 상위 200장" and a 검색 해제 button, which returns to the previous view. Selection, the inspector and the viewer behave as in any asset grid.
- **Name queries:** queries that are only a character name (optionally with its series), such as "체인소맨 레제", use the same group and result state. They are answered from auto tags, without the model.
- **When unavailable:** on the laptop, or without an index or runtime, the group is not shown. The palette behaves as today.
