# PC 컬렉션 detail — decoration directions (2026-09-30)

Mockups for the user's request to make the Collections detail screen more decorated than screen B of `../pc-collections-20260929/`. Open `index.html` in a browser; it loads the app's real `tokens.css` and `controls.css` by relative path (only the screen layout and the base button rule are local). `index.html#pk` / `#co` starts on another example work. Imagery is generated colour blocks; overviews are example copy. For a self-contained copy (review page): `python3 ../inline-mockup.py index.html out.html --fragment`.

Common to all three directions:

- **Work colour** — a colour taken from the cover tints the detail ground (7 % into `--color-bg`); app chrome and the ivory accent stay neutral.
- **내 기록** — a small label block: 들인 날, 상태, 별점, 기기, 메모. 들인 날 (`createdAt`), 별점 (`myScore`) and the note exist; 상태 and 기기 would be new stored fields.

| Direction | What it shows | New needs |
| --- | --- | --- |
| 가 · 라벨 | Artwork band cut clean (no dark wash), cover standing across its lower edge, title and overview set like an exhibition label, 내 기록 on the right, one facts strip, artwork shelf. | Cover colour extraction; two record fields. |
| 나 · 진열장 | Left half is a stage in the work colour with the case standing on it; the case turns by drag (←/→ 15°, Home front). Right: title, facts, 내 기록, overview, artwork shelf. | As 가, plus spine/back faces for the game case (today only the front is rendered). |
| 다 · 포스터 | Artwork fills the upper half; small thumbnails switch the backdrop (no auto-advance); 40 px title; overview · facts · 내 기록 in one row. | As 가, plus a type-scale exception for the detail title (today 20/24). |
| 책장 (manga piece) | Replaces the volume cover grid with one row of owned volumes; released-but-missing is an ivory dashed slot, upcoming a faint dashed slot with its date. No spine artwork exists and the app does not fabricate spine printing (see `physical/paperbackShaders.ts`), so three honest modes are compared with a switch: **표지 띠** (a vertical strip of the real volume cover; the picked volume opens to its full cover in place), **색 띠** (cover colour and number only) and **글자 책등** (uniform vertical title lettering, the first idea). Keeps the C2 ownership strip. `#slice` / `#plain` / `#text` start on a mode. | 표지 띠 needs only the volume covers (a volume without a cover falls back to 색 띠); the other two need a colour per volume; horizontal paging for very long series. |

Notes from the 2026-09-30 review rounds:

- **Nothing is cropped; sizes follow the cover.** Every cover, book and case is sized from the cover's own width/height ratio (`--ratio`): a fixed height with the width derived, so a Switch case (0.62), a PS5 case (0.79) and manga of different trim sizes each keep their proportions. The 3D case derives its spine and edge offsets from the same variables.
- **Books, not strips.** A volume at rest shows a rounded, lit spine cut from its real cover (no fabricated printing: only light and shadow are added); the picked volume shows only its cover, facing front and lifted a little (user, 2026-09-30: no spine on the picked book; the turned 3D book read as odd), and its number slides in under the cover below the shelf board; a double-click opens the cover large. The shelf has a recessed back and a board with a front edge.
- **Where the spine is cut.** Default = the main figure's head: the app's person detector on the whole cover, then again on the top quarter of that person's box unless the figure fills the cover width (a close-up is already centred). Falls back to the box centre, then the middle. On 124 covers of five series: 73 head, 42 close-up, 9 box centre, none without a person; about 0.35 s per cover on the CPU. The rule is sketched in `cover_focus.py` beside this file (it imports the character runtime's `runtime.py`); a per-volume manual override is recommended when it is built.
- Real covers are injected only into the private review page (`window.LAKOMICS_REAL_COVERS`); the repository file keeps generated colour blocks.

**No 개요 on game and manga detail (user, 2026-09-30):** the library has no Korean game overviews (10 of 388 entries have one, all English) and manga overviews are mostly not Korean (3 of 147); films keep theirs (14 of 14 Korean).

**Superseded for games and AV (user, 2026-09-30):** the separate detail page is merged into the viewer — see `../pc-collection-viewer-20260930/`. The three directions below the shelf are kept as the record of what was tried; the manga shelf remains accepted.

Status: the manga shelf (표지 띠, cut at the head, books, picked = cover only with its number under it and no owned/missing wording, double-click = large cover) is **accepted by the user (2026-09-30)**. The game detail direction (가 · 나 · 다) still awaits the user's pick.
