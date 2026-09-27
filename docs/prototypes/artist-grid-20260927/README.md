# Artist hub grid mockups (2026-09-27)

Throwaway PC design mockups for the 주요 작가 screen of the Artist hub (`ARTIST-001`, `_tools/app/src/artists/ArtistHub.tsx`). User request (2026-09-27): make the first "오늘" artist clearly larger, and replace the one-artist-per-row list with a grid whose cards put several of the artist's images inside one square, like the mobile app's asset folder tiles (`_tools/app/mobile-client/CoverGroup.tsx`, `home.css` `.home-cover-group`: `2fr 1fr` columns, two rows, first image spans both rows, 2px gap). The rail and the 작가 index are unchanged.

Open `index.html` directly (no network; fonts load from `_tools/app/src/styles/fonts/`). `index.html?frame=<id>` renders one 1440 × 900 window at 1:1; ids are `a`, `b`, `a-grid`, `b-grid`, `splits`. All imagery is generated SVG placeholders; artist names are invented.

| Screen | File | What it shows |
| --- | --- | --- |
| A | `s-a.png` | Hero A: 600 × 344 mosaic (1 large + 4 small, last cell "+124") with an info column: reason (251일 동안 안 봄 · 마지막으로 연 날), large name, handle, 모은 그림 / 처음 저장 / 최근 저장, 작가 페이지 열기 + 고정, × (오늘에서 빼기); the other two of today's picks as small rows under "오늘의 다른 작가" (click swaps them into the hero). Grid A below: 5 columns, square tiles with the mobile 1 + 2 split, caption name · handle · count, then "최근 30일 N장 · 저장 MM.DD". |
| B | `s-b.png` | Hero B: a full-width strip of 5 images at their original ratios, one caption line (avatar, name, handle, reason, count, dates, actions); today's three picks become small toggle buttons in the heading. Grid B below: 6 columns, 2 × 2 split, handle hidden. |
| A grid | `s-a-grid.png` | Grid A after scrolling past the hero (about 15 artists per screen). Hover replaces the count with 고정 (pin) and ⋯; ⋯ or right-click opens today's menu (고정 · 이름 바꾸기 · 다른 작가와 합치기 · 숨기기). Nothing is drawn over the images. |
| B grid | `s-b-grid.png` | Grid B after scrolling (about 18 artists per screen). |
| Splits | `s-splits.png` | Split rules by image count. A: 1 → whole, 2 → 2 : 1, 3+ → 1 large + 2 small. B: 1 → whole, 2 → halves, 3 → 1 large + 2 small, 4+ → 2 × 2. Cells are centre-cropped like the mobile `.home-cover`. |

## Recommendation

**Hero A + Grid A (5 columns, mobile 1 + 2 split).**

- Grid A's large cell is about 139 × 209 px at 1440 px, enough to recognise an artist's style; Grid B's 2 × 2 cells are about 85 px and read as colour swatches. The 1 + 2 split is also exactly the mobile folder tile, so PC and tablet look alike.
- Hero A is clearly the largest thing on the screen and uses the same mosaic language as the grid, with the reason and actions at eye level. Hero B respects original ratios but becomes a wide, short banner and pushes the grid further down; keep it as the fallback if the user prefers uncropped images.
- Hero and grid are independent; any combination can be built.

## Open questions for the user

1. Direction: A + A (recommended), B + B, or a mix (e.g. Hero B with Grid A)?
2. Grid density: 5 columns (bigger cells) or 6 (more artists per screen)? Should the column count follow window width, or be a 보기 설정 choice?
3. Which image is the large cell: the most recently saved (as mocked), or a cover the user picks on the artist page?
4. Hero: show the other two of today's picks under the hero (A) or as toggle buttons (B), or show only one artist?
5. Card caption: keep the handle next to the name (A) or drop it for a cleaner grid (B)?
6. Pin/hide: hover buttons in the caption plus the right-click menu (as mocked), or menu only?

## Decision (user, 2026-09-27)
**A + A**: large mosaic "오늘" artist (1 large + 4 small, info on the right, other picks small below) and a 5-column grid of square collage tiles split like the mobile CoverGroup (1 → whole, 2 → 2:1, 3+ → 1 large + 2 small). Sub-questions follow the README recommendations.
