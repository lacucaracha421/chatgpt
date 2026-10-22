# Movie bookcase spines (2026-10-22)

Status: proposal (design mockup with three options). App source is unchanged.

User request (2026-10-22): "컬렉션-영화에서 책등쪽 디자인도 해줄래?" Collections › 영화 has 격자 and 선반 only. 책장 (the spine bookcase) exists for games, AV and manga (`hasBookcase` in `collections/CollectionList.tsx`), and a saved `bookcase` layout for movies falls back to 선반 (`CollectionList.test.tsx`). TMDB supplies posters and backdrops but no spine images, so every movie spine has to be generated from data the work already has.

## Files

| File | What it is |
| --- | --- |
| `index.html` | A, B and C, each at the PC's 960×640 window (1:1, one film pulled out), the tablet portrait screen (800×1280 CSS px at 48%, 연대 grouping, one pulled out) and a 1700×920 window (at 81%, 크게). Under each one is a strip of true-size spines (보통) with their states. D shows the 보기 menu, E the pull-out and states, F the comparison and recommendation. The buttons above each option change the spine size and grouping of its first two frames. Click a spine to pull it out, click it again to "open" (written in the caption), and click empty shelf to put it back. `index.html#only=opt-B` shows one section, for screenshots. |
| `movie-spines.css` | **Proposed** spine print CSS for the three options. It extends `case/CollectionCase.css`. |
| `shelf.js` | Mockup behaviour, stand-in data (the 14 films in the library plus 27 examples, 41 in all) and packing, which follows `spineShelfLayout.packSpineShelf` and `spineScaleForView`. |
| `page.css` | Mockup frame, stand-in CSS posters and a simplified pull-out box. In the app the pulled-out object is `SpineShelf`'s `PulledOut` with the real `CollectionCase`. |

The page loads the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `shared-surfaces.css`, `controls.css`, `CaseMaterials.css`, `CollectionCase.css` and `SpineShelf.css`, so the plank, row rhythm, hover lift, spine title type and section labels are the app's own. Posters are CSS stand-ins. No images and no network.

Checked by rendering in headless Edge (static screenshots of every section, a 2x zoom of B, and a scripted click that put one case back and pulled another out). No native app or tablet check was done.

## The three options

All three use the same shelf (`SpineShelf`): packing, 1px seams, plank, windowing, the pick and pull-out motion, keyboard, 책등 크기 and grouping. They differ only in what stands on the shelf.

### A. 킵 케이스 (keep case)

- The existing film case (`CasePlatform` `film`), stood spine-out at Blu-ray size (172 × 12 mm). Only the top and bottom lips show blue plastic. There is no logo and no BD mark.
- Generated insert: a white head with the release year (first-air year for a TV series), a black band with the title, and the studio (`productionCompany`, else the director, else empty) at the foot.
- The quietest option and the smallest change. A row of 41 identical black bands is monotonous, though, and the poster shows only after a pull-out. The keep case also suggests that the film is owned on disc.

### B. 포스터 책등 (poster spine). Recommended

- A thick poster board (14 mm) instead of a plastic case. The board's front is the poster, and its height follows the poster's aspect ratio (front width 125 mm: 2:3 is 187.5 mm, a Japanese B2 poster is 177 mm). A row therefore rises and falls slightly, as game cases of different platforms do.
- Generated spine: the top 41% is an art window, a vertical slice of the chosen poster cut at its focus (default: the centre). This is the same idea as the manga 책장's cover slices. Below it is a black band with the title and the year at the foot.
- With no poster, or while the poster is still decoding, the art window is a neutral face at the final size and the title band is already in place. The art fades in over 140 ms, and nothing moves.

### C. 번호 전집 (numbered set)

- Every film is one uniform DVD-size spine (190 × 14 mm) in a clear case. The spine colour is the poster's dominant colour, held to a dark, calm band so white print always reads. The head carries a collection number (the order of adding, from 1), then the title, then the director at the foot.
- It makes the most attractive colour run. It adds a new concept, though: numbers that must survive deletion and reordering. It also needs a colour extracted and stored per poster, and the art is still hidden until a pull-out.

## Recommendation: B

Movies have no spine art, but they always have a poster. B turns the poster into the spine, so the shelf reads as pictures, as the game (LaunchBox spines), AV (jacket spines) and manga (cover slices) shelves already do. With A or C, 41 films read as text bands, and you have to pull one out to recognise it. B needs no new data or provider call. It keeps DESIGN §8's "video is a poster archive" by not inventing a disc package. Its pull-out is the same motion as games and AV. Its one risk is a slice that lands on empty background. The centre default covers most posters, and a later 책등 위치 control (drag the slice across the poster in the work menu, like the manga cover focus) fixes the rest.

## Shared behaviour

| Topic | Rule |
| --- | --- |
| 보기 → 배치 | Movies get 격자 · 선반 · **책장**. The default stays 선반. The choice is saved per type as today (`lakomics.collections.view.movie.v1`). |
| 책등 크기 | Four steps, 작게 · 보통 · 크게 · 아주 크게, with the AV scale table (`SPINE_SCALE_AV`, PC 1 / 1.3 / 1.8 / 3.15 px/mm, tablet 1.15 / 1.5 / 2.05 / 2.8) and `AV_SPINE_SIZES`. A movie library is small (14 today), so the shelf is one or two rows and bigger spines keep titles and art readable. `spineScaleForView` still shrinks a size that would cut the pulled-out object off; 아주 크게 is about 2.0 at 960×640. |
| 묶기 | 안 묶음 (default) · **연대** (`2020년대`…) · **감독** (one group per director with two or more films, then `그 밖의 감독`). Per-year groups, as games have, would give movies a run of one-film groups. Labels are the existing `SectionLabel` with a count. Grouping by franchise (에반게리온, 마크로스) would need the TMDB `belongs_to_collection` name stored on the work, so it is left for a later step. |
| 정렬 | Unchanged: 개봉일 · 추가일 · 제목, 최신순/오래된순. Groups split the sorted list. |
| Pick and open | Identical to games and AV. The first click pulls the object out of its slot: 1.28× its spine height, 12 px off the plank, turning from edge-on to its front (520 ms `--ease-sheet`, the turn 60 ms late). The slot stays empty. A drag turns it, and a click opens the work screen with the existing hero move. Esc, empty shelf or another pick puts it back (440 ms). The spine shows again before the object leaves, so no slot flashes empty. On the tablet, a tap anywhere in a row picks the nearest spine. |
| States | Loading: A and C show plastic only, B shows its neutral art window; everything is at its final size. Privacy: spine and front are `case-mask`. Hover lifts 4 px. Focus is the full blue ring, not an edge stripe. No names under spines and no tooltips. The first load rises row by row; changes keep the old shelf until the new first screen is ready. |

## Implementation notes (option B; A and C differ only in the spine print)

| File | Change |
| --- | --- |
| `src/collections/CollectionList.tsx` | `hasBookcase`: add `movie`. Add the movie grouping (`decade`, `director`) to `shelfGroups`. Grouping today is game-only, and `CollectionViewSettings.grouping` gains the two values or a per-type mapping. |
| `src/collections/CollectionList.test.tsx` | The "책장 … but not movies" expectation becomes valid for movies. Add one grouping case. |
| `src/collections/CollectionBrowser.tsx` | `spineBookcase` includes `movie`. Pass the movie groups. Show `AV_SPINE_SIZES` for movies in `ViewOptionsMenu`. |
| `src/collections/case/caseDimensions.ts` | `spineScale`: movies use `SPINE_SCALE_AV`. B: a `film` size whose height comes from the poster ratio (`workCaseSize(platform, ratio)`), because `CASE_MM` is per platform. A: `film` becomes 172 × 12 × 135. C: unchanged DVD. |
| `src/collections/spineShelfLayout.ts` | `PackedWork` gains an optional size override (`{ height, spine, width }` in mm) so a work's own poster ratio sets its height and pull-out width. The packing stays pure arithmetic. |
| `src/collections/SpineShelf.tsx` | `SpineWork` gains the generated-print data (`year`, `poster` URL and `focus`, or `studio` for A, `number`/`ink` for C), passed to `CaseSpine` through `CaseData`. Spines that need the poster use the existing `useSpine` hook, with the poster thumbnail as the source. |
| `src/collections/case/CollectionCase.tsx` | `CaseSpine`: a `film` branch that draws the generated print (B: art window + band + foot; A/C: add `film` to `SPINE_TEMPLATES` with a head/year element). B's pull-out: a `board` variant of `CollectionCase` (no hinge, lid or tray; front, edge and plain back) or a small `PosterBoard` model using the same `--from` pose. The front keeps the poster's own ratio, as the film case already does. |
| `src/collections/case/CollectionCase.css` | The rules in `movie-spines.css`. |
| `mobile-client/Collections.tsx` (tablet) | `layout === "bookcase"` for movies renders `SpineShelf` with `touchTargets` and the tablet scale, as for AV. Check that the tablet summary carries the poster artwork id for the spine ticket; it should, because the grid shows posters. |
| Later (optional) | Work menu → 책등 위치 (slice focus), stored like the manga cover focus. Franchise grouping (store the TMDB collection name). |

Tests, only where a realistic regression could slip through: the movie layout mapping, the decade and director grouping, and the per-work size in packing. No CSS or text pins.
