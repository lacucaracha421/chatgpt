# PC 망가 redesign mockups (2026-09-29)

Throwaway mockups drawn from the user's screenshots of the current 망가 area (2026-09-29 17:25). They carry over the PC 에셋 decisions (`../pc-assets-20260929/`): controls in the toolbar, overlay detail panel, immersive viewer. Open `index.html`; `index.html?frame=a|b|c|d` renders one 1440 × 900 screen. Imagery is generated colour blocks.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `a.png` | Catalog grid: 카탈로그 · 북마크 · 로컬 as the shared segmented control (counts), language and sort as quiet toolbar menus, refresh time; sidebar becomes an index (frequent tags, artists); cards with a fixed cover ratio, page count as a scrim badge, calendar-style corner bookmark, reading-progress line, title 2 lines + artist 1 line; skeleton cards while loading; no bottom pager (load more at the end). |
| B | `b.png` | Detail as the overlay side panel (same as the asset inspector): cover, title, artist · type · pages, language, 읽기 + bookmark icon, first-pages strip, face-only tag chips grouped, extra info. No modal, no 닫기 button (Esc / outside / X). |
| C | `c.png` | Reader, immersive like the asset viewer B: top bar (position 12 / 76, title, artist · source, 두 쪽 / grid / bookmark / settings / close), edge-wide page areas, bottom page scrubber + thumbnail strip, bars fade when idle; loading pages are page-shaped placeholders. |
| D | `d.png` | Local: sidebar lists local folders with counts; a one-line notice for vanished folders opens the decided review list (select, back up first, delete); cards as in A; refresh updates the toolbar time instead of a success toast. |

Problems in the current screens these address: blank covers without placeholders, the 2+1 source box and sidebar dropdowns with mixed selection marks, uneven local card heights and the leading "·" when the artist is missing, black round bookmark, bottom 이전/다음 결과 pager, detail modal with an empty large preview, bordered + filled tag chips and a redundant 닫기, reader showing a blank grey page and "K-Hentai 1/76", success toast "새로 변경된 망가가 없습니다".
