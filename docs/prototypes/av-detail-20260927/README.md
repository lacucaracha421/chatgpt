# AV Collection detail mockups (2026-09-27)

Throwaway PC design mockups answering the user's request (2026-09-27): make the AV package rotatable like the game/manga collectibles, fill the sparse AV detail view, and add performer images. They build on the metadata from migration 0104 (product code, title_ja, release date, maker, label, series, genres, performers/director with Korean and Japanese names, Wikidata and FANZA ids) and the portrait sources in `docs/research/av-sources-20260926.md`.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window at 1:1; ids are `a`, `a2`, `b`, `viewer`, `performer`, `portrait`, `portrait-commons`; add `&ann=0` to hide the yellow notes. All covers, portraits and backgrounds are generated placeholders (colour fields and simple silhouettes); names and titles are fictional. The cases are CSS 3D and can really be rotated on the page: drag (yaw 360°, pitch ±20°), release to snap to the nearest of front / spine / back, ←/→ and Home on the focused case, or the 앞면 · 책등 · 뒷면 buttons. The portrait crop frame in screen 4 can be dragged and the previews follow. Screenshots were taken with headless Chrome (static poses only).

| Screen | File | What it shows |
| --- | --- | --- |
| 1A | `s-a.png` | **Exhibit** (recommended). Hero: rotatable DVD keepcase (front ≈ 0.703 × height, spine ≈ 5 % of the wrap, one jacket image split into back/spine/front, clear-sleeve sheen, plastic rim) resting at a slight angle so the spine reads, with 앞면/책등/뒷면 stops. Identity: product code (copy) + source/date, Japanese title, release date and runtime, maker/label/series as filter links with library counts, genre chips, personal strip (my rating + memo). Atmosphere is a soft wash of two colours sampled from the front cover, not a blurred cover. Below: 출연 strip (round portraits, Korean name, Japanese name, library work count, "작은 사진" when only the DMM image exists; director with an initial monogram). The index holds back, code, title, rating, 쇼케이스, 관리 and in-page jump links. |
| 1A lower | `s-a2.png` | 같은 배우의 다른 작품 (mini cases, performer chips when there are 2+ performers, +N tile, 배우 페이지 link); 같은 시리즈 (order numbers, "이 작품", announced next release) and 같은 레이블 (recent first, 모두 보기) side by side; collapsed 자세한 정보 (original title, digital cid, source and date, cover surfaces, storage scope). |
| 1B | `s-b.png` | **Dossier**. Left fixed column over a blurred front-cover backdrop: case, stops, rating, 쇼케이스, memo. Right: code, title, a 2-row fact grid (director included), genres, performers as 3:4 portrait cards, and one tabbed shelf (배우A · 배우B · 시리즈 · 레이블). Nearly everything fits one screen. |
| 2 | `s-viewer.png` | Appreciation dialog (extends today's 표지 감상): large free-rotating case, stops 앞면 · 책등 · 뒷면 · **펼침** (flat full jacket), 원본 보기, keyboard hints. |
| 3 | `s-performer.png` | Performer page (컬렉션 › AV › 배우): large portrait with its source line and 대표 이미지 바꾸기, Korean name, Japanese name + reading, aliases, library stats (works, release span, average of my ratings), FANZA/Wikidata ids small; works grid (전체/단독/공동 출연, sort), 자주 함께 나온 배우, labels, per-performer memo. The index keeps the current work's cast (switch performers directly), the director, 배우 전체 and 사진 없는 배우. |
| 4 | `s-portrait.png` | Portrait picker, cover-crop source: sources on the left with a 3-step quality bar (표지에서 자르기 / 위키미디어 공용 / DMM 사진 / 사진 없이), the performer's front covers (solo works first), a draggable 3:4 crop frame with zoom and reset, and live previews (detail avatar sizes, performer page, Home "오늘의 AV 배우" card). |
| 4 Commons | `s-portrait-commons.png` | Same dialog with the Commons photo: file name, author, licence and Wikidata id shown and stored for attribution; only the Wikidata id is sent. |

## Recommendation

**1A (Exhibit).**

- It follows the existing game detail grammar (hero + package in front + concise identity), so AV feels like part of Collections instead of a separate template; 1B would be the only split-column detail.
- It honours the current rule "never fabricate a blurred cover background" while still giving each work its own colour atmosphere. 1B needs an AV-only exception to that rule.
- Shelves stay visible side by side (same performer, series, label) and reconnect the user's own library, which is where the richer data pays off; 1B's tabs show only one relation at a time.
- Cost: 1A scrolls (about 1.5 screens), while 1B fits one screen.

Interaction for both: the detail case rests at a slight angle, rotates by drag and snaps to front/spine/back; the dialog adds 펼침 and free rotation. In the app, shelf/grid mini cases would be cached static snapshots (one live case per screen), consistent with the collectible renderer budget in `docs/agents/works-viewer-design.md`.

## Decisions for the user

1. Direction: 1A (recommended) or 1B? If 1B: allow the blurred front-cover background for AV only (rule change)?
2. Portrait default order: user-chosen crop/photo → Commons photo → DMM small photo → initials (as mocked)? Or skip DMM (125×125 is blurry at 84 px) and show initials until the user picks? Should an automatic pick be marked "임시" until confirmed?
3. Cover-crop suggestions: list solo works first (as mocked); later, an automatic face-centred initial frame is possible but not mocked.
4. Shelves to show: 같은 배우 · 같은 시리즈 · 같은 레이블 (as mocked)? Also 같은 메이커 or 같은 감독? Hide a shelf when it has no other works (proposed).
5. Commons photos: store author/licence and show them small on the performer page (as mocked) — acceptable?
6. Performer page extras: 자주 함께 나온 배우, label chips, per-performer memo — keep all, or trim?
7. Case type: one DVD keepcase shape for all AV (as mocked), or a Blu-ray height variant when the source says Blu-ray?

## Decision (user, 2026-09-27)
Direction **1A (전시형)** chosen for the AV detail. Sub-decisions (user accepted the recommendations): portrait order user-picked → Wikimedia Commons (with author/license shown on the performer page) → initials (the 125 px DMM photo is not used); shelves 같은 배우 · 같은 시리즈 · 같은 레이블, hidden when empty; one DVD case shape for now (Blu-ray later if needed).
