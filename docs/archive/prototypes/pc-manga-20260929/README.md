# PC 망가 redesign mockups (2026-09-29)

Throwaway mockups drawn from the user's screenshots of the current 망가 area (2026-09-29 17:25). They carry over the PC 에셋 decisions (`../pc-assets-20260929/`): controls in the toolbar, overlay detail panel, immersive viewer. Open `index.html`; `index.html?frame=a|b|c|d` renders one 1440 × 900 screen. Imagery is generated colour blocks.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `a.png` | Catalog grid: 카탈로그 · 북마크 · 로컬 as the shared segmented control (counts), language and sort as quiet toolbar menus, refresh time; sidebar becomes an index (frequent tags, artists); cards with a fixed cover ratio, page count as a scrim badge, calendar-style corner bookmark, reading-progress line, title 2 lines + artist 1 line; skeleton cards while loading; no bottom pager (load more at the end). |
| B | `b.png` | Detail as the overlay side panel (same as the asset inspector): cover, title, artist · type · pages, language, 읽기 + bookmark icon, first-pages strip, face-only tag chips grouped, extra info. No modal, no 닫기 button (Esc / outside / X). |
| C | `c.png` | Reader, immersive like the asset viewer B: top bar (position 12 / 76, title, artist · source, 두 쪽 / grid / bookmark / settings / close), edge-wide page areas, bottom page scrubber + thumbnail strip, bars fade when idle; loading pages are page-shaped placeholders. |
| D | `d.png` | Local: sidebar lists local folders with counts; a one-line notice for vanished folders opens the decided review list (select, back up first, delete); cards as in A; refresh updates the toolbar time instead of a success toast. |

## Decisions added 2026-09-30 (user)

The screens were redrawn on a private design canvas (not kept in the repository) with three tablet screens, and accepted as drawn:

- **No resume.** A work always opens at the first page: no reading-progress line on cards, no "N쪽까지 읽음", and the primary action is 읽기 (never 이어 읽기). This replaces the progress line in A and D above.
- **PC detail panel (B)** also lists 판본 (editions: cover, pages, language; the open one outlined), as the tablet already does.
- **Sidebar index (A):** pinned tags/artists carry a solid pin mark.
- **Tablet 카탈로그 (portrait):** top bar with 검색 · 중복 판본 검토 · 필터; below it 카탈로그 · 북마크 as the shared segmented control with 언어 and 정렬 as quiet menus on the right; 4-column cards by the same rules as the PC (fixed ratio, page badge, corner bookmark). No 로컬 on the tablet.
- **Tablet detail:** a bottom sheet over the grid (cover, title, 읽기 + bookmark, first pages, grouped tags, 판본) instead of the full-screen page.
- **Tablet reader:** one page, top bar (back, title, `12 / 76 · artist`, page list, bookmark, settings), bottom scrubber with a thumbnail strip; bars fade when idle.
- From this round on, mockups are plain HTML under `docs/prototypes/` that load the app's real `tokens.css` / `controls.css`, published as an ordinary page for the user to open and comment on; the design canvas and its separate design-system copy are no longer used.

Problems in the current screens these address: blank covers without placeholders, the 2+1 source box and sidebar dropdowns with mixed selection marks, uneven local card heights and the leading "·" when the artist is missing, black round bookmark, bottom 이전/다음 결과 pager, detail modal with an empty large preview, bordered + filled tag chips and a redundant 닫기, reader showing a blank grey page and "K-Hentai 1/76", success toast "새로 변경된 망가가 없습니다".
