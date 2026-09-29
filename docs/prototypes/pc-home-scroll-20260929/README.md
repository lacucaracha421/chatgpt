# PC Home, scrolling below the first screen (2026-09-29)

Throwaway mockups for the request "keep the sidebar scrolling; let the centre and the AV column scroll down too and add content". The first screen is Home D (`../pc-home-minimal-20260929/`); below it come 이어 보기, 이어지는 시리즈 and an AV extension (즐겨찾는 배우, AV 신작). Open `index.html` and scroll inside each frame; `index.html?frame=e|f|g&y=700` renders one 1440 × 900 screen scrolled by `y`. Imagery is generated colour blocks.

| Screen | Files | What it shows |
| --- | --- | --- |
| E (recommended) | `e.png`, `e-scrolled.png` | Centre and right column share one scroll; the 300px right column continues with favourite performers and AV releases. |
| F | `f.png`, `f-scrolled.png` | Same first screen; below it, full-width bands (six continue covers, four series, AV band with faces + two-column release list). |
| G (comparison) | `g.png`, `g-scrolled.png` | E's content with the centre and right columns scrolling independently. |

Data notes (read-only survey, 2026-09-29): page progress is stored only for online-catalog galleries (`remote_reading_progress`); the local manga reader and video player keep no position, so 이어 보기 needs new progress storage. 이어지는 시리즈 can reuse `koreanReleases` (`src/collections/releaseCaption.ts`), limited to works with release watch and a Kakao schedule. Favourite performers and AV release feeds do not exist yet (no favourite column, no FANZA/StashDB filmography feed).
