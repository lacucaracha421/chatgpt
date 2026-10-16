# Game and AV spine shelf (2026-10-17)

Status: proposal (design mockup and spec). App source is unchanged.

User request (2026-10-17): "게임, 만화, AV에 쓰이는 격자 배치 형태에서의 모델링 있지? 그건 없애고, 만화의 책장 보기 형태처럼 볼 수 있게 하고 싶어. 책등만 보이는 거지. 이건 게임, AV에만 기능 넣고, 이름 없이 그냥 책장에 꽂힌 것처럼 책등만 좌르륵."

User decision (2026-10-17, relayed by the controller): keep a flat front-cover grid as the alternative view for games and AV. It shows the covers laid flat, with no 3D models. The 3D case grid goes away.

## Files

| File | What it is |
| --- | --- |
| `index.html` | PC. A: game shelf (412 works, device groups, live). B: AV shelf. C: flat grid with the 보기 menu open. D: states at true size. E: the three spine sizes. F: decisions. `#pick` in the URL opens it with one case pulled out. |
| `tablet.html` | Tablet at 1:1 CSS px. A: portrait game shelf (tap to pick the nearest case). B: 보기 bottom sheet. C: AV shelf and the flat grid. D: landscape. |
| `spine-shelf.css` | **Proposed** component CSS. It becomes `_tools/app/src/collections/SpineShelf.css`. |
| `shelf.js` | Mockup behaviour: packing, windowing, pick/put-down, open and keyboard, as specified below. Stand-in data. |
| `page.css` | Mockup frame and stand-in artwork only. |

The pages load the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `shared-surfaces.css`, `controls.css`, `chrome.css`, `CollectionBrowser.css`, `CaseMaterials.css` and `CollectionCase.css`. The Switch, Switch 2, PS5 and PC (Steam) spine templates are the app's real `.tpl` rules. The PS4 head is a stand-in in `page.css`, because another agent is adding the real `.ps4` rules now. The LaunchBox spine images, AV jacket spines and covers are stand-in CSS art.

Checked by rendering both pages in headless Edge (static screenshots, plus a DOM check that the pulled-out cover ends at full width). No native or device check was done.

## Decision summary

| Type | 보기 → 배치 today | Proposed |
| --- | --- | --- |
| 게임 | 격자 (cached 3D SteelBook render, `GameCase` → `PhysicalCover kind="game"`) · 선반 (turned 3D `LightCase` on planks) | **책장** (spines, default) · **격자** (flat front covers) |
| AV | same as games | **책장** (default) · **격자** |
| 만화 | 격자 · 선반 · 책장 | unchanged |
| 영화 | 격자 (flat posters) · 선반 | unchanged |

- **책장** is new for game and AV. It is a bookcase of spine-out cases on the manga 책장 plank. There is no title under a spine and no hover tooltip (see Names below).
- **격자** for game and AV becomes the plain front-cover image. Each cover keeps its own aspect ratio, bottom-aligned, with the existing name and meta lines under it. `GameCase` / `PhysicalCover kind="game"` is no longer used in lists.
- **선반** (3D `LightCase`) is no longer offered for game and AV. The 3D case stays on the work screen. See open question 1.
- Stored settings `lakomics.collections.view.{game,av}.v1`: `layout: "shelf"` reads as `"bookcase"`, and `"grid"` stays `"grid"`, now flat. The default becomes `"bookcase"`. Add `spineSize: "small" | "normal" | "large"`, default `"normal"`. The tablet's `viewOf()` storage gets the same mapping.

## Geometry

Cases are drawn at **real package proportions**: millimetres × one scale (`--spine-scale`, px per mm). Put the table in a new `collections/case/caseDimensions.ts` (`CASE_MM: Record<CasePlatform, { height; spine; width }>`). It is shared by the shelf and the flat grid.

| `CasePlatform` | Case | Height | Spine | Front width |
| --- | --- | --- | --- | --- |
| `pc`, `other` | DVD keep case | 190 | 14 | 135 |
| `av` | DVD keep case (BD vs DVD is not in the data) | 190 | 14 | 135 |
| `ps5`, `ps4` | PlayStation case | 172 | 13 | 135 |
| `sw`, `sw2` | Switch case | 170 | 11 | 105 |

These are approximate retail sizes. Check them with a ruler before freezing them. The visible result is that PC and AV DVD cases stand tallest, PS and Switch stand about 10% lower, and Switch cases are the thinnest. In real packages, PS and Switch are almost the same height. The difference the eye notices is thickness and front width.

| Size (`spineSize`) | PC scale | Tablet scale | DVD case at PC scale (h × spine) |
| --- | --- | --- | --- |
| 작게 | 0.9 | 1.0 | 171 × 13 |
| 보통 (default) | 1.1 | 1.25 | 209 × 15 |
| 크게 | 1.35 | 1.5 | 257 × 19 |

Widths and heights are rounded to whole px per platform, so spines never blur.

| Part | Value |
| --- | --- |
| Side gutter | `--space-6` (24) on PC. Tablet: `--mobile-gutter` (24, 16 on narrow phones). |
| Gap between cases | 1px seam (a line, not spacing): cases touch like on a real shelf. |
| Case rim (top/bottom plastic around the insert) | `2.5px × scale` |
| Room above a row | `--space-4` (16), for hover lift and the pulled-out cover |
| Plank | 6px, identical paint to `.manga-bookcase-board::after` plus the `::before` contact shadow. Extract both into one shared `.shelf-plank` class used by the manga bookcase and this shelf. |
| Plank to the next row | `--space-6` (24) |
| Row height | `16 + tallest case in that row + 6 + 24`. A Nintendo row is lower than a DVD row. |
| Group label (기기 / 발매 연도 묶기) | Existing `SectionLabel` with a count, 40px band |

**Packing.** Pack each group left to right in list order. Start a new row when the next spine would cross the right gutter. Rows are left-aligned and the plank always spans the full width, so the last row of a group ends ragged, as a real shelf does. Rows are computed in JS from the item list, the platform widths and the container width, with no per-spine DOM measurement. Recompute on resize (once per animation frame) and on a size change. Neither one animates.

## Names: no title, no tooltip

- Nothing is printed under or over the spines. A spine shows what the package shows: the LaunchBox spine image, else the platform template (head, vertical title, developer or the Nintendo mark), else a bare spine with the vertical title (`other`, and AV without spine art). AV uses the jacket spine artwork the user already picks (`getCoverSet().spineId`): maker mark, title and product code.
- **No hover tooltip.** DESIGN.md §9 forbids hover and focus tooltips, including `title` balloons, so a "quiet" tooltip is not allowed either. The front cover shown when a case is pulled out names the work visually. The accessible name stays `aria-label="<title> · <credit>"` on each spine button.

## Interaction

The rules follow the manga 책장 and the current 선반: the first action picks, and a second action opens.

**PC**

| Input | Result |
| --- | --- |
| Hover | The case rises 4px (`translateY`, 90 ms `--ease-standard`). Turned off while the list scrolls (a `data-scrolling` flag held 150 ms after the last scroll event). |
| Press | Rises 2px and darkens slightly (`brightness(.92)`). |
| Click a spine | **Pick**: the case is pulled out and turned to its front cover (360 ms `--ease-sheet`, the accepted shelf pick/put-down motion). The cover appears where the spine stood, scaled in X from the spine's width to the cover width. It is centred on the spine, clamped to the row, lifted 6px, with `--shadow-floating`. The spine's slot stays empty, so neighbours do not move and rows never reflow. One pick at a time across the whole list. |
| Click the picked cover, double-click a spine, Enter on the picked case | **Open** the work: `onOpenWork(id, order)`, the existing work screen and its existing transition. The shelf stays painted until the work screen is ready. Back returns to the same scroll position, with the same case pulled out and focused (`navigationMemory` `focusId`). |
| Click empty shelf space, Esc | Put down (`useShelfPutDown`, then the reverse of the pick motion). |
| Right-click a spine | The existing collection menu (편집 / 쇼케이스 / 삭제). |

**Keyboard.** The shelf is one tab stop with a roving `tabindex` on the spine buttons. ←/→ moves one case and crosses rows and groups. ↑/↓ moves to the case in the adjacent row whose centre is nearest. Home/End moves to the row's first or last case. Arrow moves also pick, as in `CollectionList`. Enter picks, or opens when the case is already picked. Space picks or puts down. Esc puts down, closing only that layer. Focus is the blue `--color-focus` ring drawn around the whole lifted case. It is not a coloured edge stripe. Picked state is `aria-pressed="true"`.

**Tablet**

- Spines (14–18px at 보통) are thinner than 44px. A tap **anywhere in a row's band** therefore picks the case whose centre is nearest the tap. This is the manga 책장's `touchTargets` rule. A tap on the pulled-out cover (105–200px wide) opens the work.
- Movement over 8px or a scroll during the touch cancels the tap. Vertical swipes always scroll. A tap outside rows (between planks, on the header) puts the case down.
- Press feedback on the picked cover: the face darkens to `--color-surface-pressed` while pressed (§12). There is no hover.
- 보기 is the existing bottom sheet: 배치 [책장 | 격자], then 책등 크기 [작게 | 보통 | 크게] (책장) or 한 줄에 (격자), then 정렬.
- Portrait (800 CSS px) holds about 47 cases per row at 보통. Landscape (1280) holds about 77. No layout differs beyond the width.

## States

| State | Look |
| --- | --- |
| Rest | Plastic (`CASE_PLASTIC`) with the printed insert. The spine light gradient is the same as `.cs-spine::after`. |
| Shelf data pending (owned platform / spine artwork not read yet) | Plastic only, at the platform's final size, so nothing moves later. The template or image then appears in one step. |
| Spine image arriving after the row is shown | It fades in over its plastic (140 ms opacity). It never pops in from nothing and never flashes a blank. |
| Picked | Empty slot plus the pulled-out front cover. |
| Privacy mode | Spine and cover are `case-mask` (`--color-surface`). Heights stay. |
| Missing spine art | Platform template. For `other` and AV, a bare case with the vertical title. |
| Empty list / no result | Unchanged (`EmptyState`). |

## No flash, no pop-in

- **First load of the list only:** rows rise 8px and scale 0.98 → 1 (accepted first appearance B, 560 ms `--ease-spring`), staggered 24 ms **per row**, not per spine, with at most 18 steps. Revisits, filters, sorts, size changes and paging do not animate.
- **Type switch** uses the existing segment swap (slide 16px, 200 ms). **Sort, filter, grouping and 보기 changes** keep the current shelf on screen (inert, not dimmed) until the new first screen's rows and their visible spine images are ready, capped like the tablet's `SWAP_PREPARE_MS`. Then they swap in one step.
- Spine images use the two-slot swap already inside `CaseSpine` (the decoded image is the one shown, and `src` never changes on the visible `<img>`).
- Reduced motion turns off the pick turn, the hover lift transition and the row entrance. State changes are instant.

## Performance

- No 3D: no `perspective`, `preserve-3d` or canvas per item. A spine is one `<button>` plus one `<img>` or the template spans. Transforms appear only on hover, pick and the one pulled-out cover.
- **Windowing:** rows are absolutely placed from the precomputed packing. Only rows within half a viewport above and below are mounted (`SHELF_OVERSCAN_VIEWPORTS = .5`, exported from `CollectionList`), plus the picked and focused rows. 1,000 works at 보통 are about 12–15 rows per type.
- **Data:** games already read owned platform and spine artwork in one batched call (`readShelfInfo` → `listCollectionShelfCases`). AV today reads `avGateway.getCoverSet(id)` per work, which would be hundreds of IPC calls. Add a batched `listAvShelfArt(ids)` (front and spine artwork ids plus revision) and use it like `readShelfInfo`. Request spine images only for mounted rows, at thumbnail size (`workArtworkThumbnailUrl`), with `decoding="async"`. On the tablet, summaries already carry `spineArtworkId`. Batch the image tickets per mounted row.
- Measure entry and scroll with the existing `LAKOMICS_PERF` phases (`collections.ipc.*`) on the real library before and after, following `docs/agents/implementation.md` (Performance work).

## Components

| Piece | Action |
| --- | --- |
| `collections/SpineShelf.tsx` (new, shared PC + tablet) | Props: `items` (plain data: id, title, credit, `CasePlatform`, front and spine URLs or null, pending flags), `groups`, `scale`, `pickedId`, `onPick`, `onOpen`, `menu?`, `touchTargets?`, `restoredFocusId?`, `label`. It owns packing, windowing, keyboard and pick motion. It does not branch on the client. Clients pass the scale and `touchTargets`. |
| `CaseSpine` (`case/CollectionCase.tsx`) | Reuse as is (`decorative` for the shelf). It already handles template versus image and the two-slot swap. **Another agent is editing `case/**` right now**, so import only and do not restyle. |
| `CASE_PLASTIC`, `workCasePlatform`, `spineInsertClass` | Reuse. |
| `case/caseDimensions.ts` (new) | `CASE_MM` table above. |
| Plank | Extract `.manga-bookcase-board::before/::after` into a shared `.shelf-plank`. |
| `ViewOptionsMenu` | Add an optional `sizeControl` slot shown instead of `PerRowControl` when the layout is `bookcase`, using a full-width `SegmentedControl` 작게 / 보통 / 크게. |
| `CollectionBrowser.tsx` | Offer `[책장, 격자]` for game and AV. Render `SpineShelf` for `bookcase`. Point `useScrubberList` at `.spine` for the bookcase. Keep `useShelfPutDown`. Give each spine `data-collection-id` so focus restore works. |
| `CollectionCard.tsx` | For game and AV, use the flat `<img class="collection-cover-image">` path, with the cover's own aspect ratio and bottom alignment (`.cover-grid__frame` rule in `spine-shelf.css`). Stop using `lightCase`/`GameCase` in game/AV lists. |
| Tablet `mobile-client/Collections.tsx` `workList` | `layout === "bookcase"` and kind `game`/`av` → `<SpineShelf touchTargets scale={1.25 …}>`. Grid keeps `WorkCard`. Check that its `Artwork` is flat for game/AV, and drop any case render there. |

Tests (only where a realistic regression could slip through): packing (row breaks, per-row height, group labels), keyboard moves across rows, the stored-layout mapping, and the AV batch read. No CSS pins.

## Open questions

1. **선반 for game and AV.** This spec removes the 3D 선반 from game and AV, along with the 3D grid, leaving 책장 and 격자. Should 선반 stay as a third option? The game/AV **쇼케이스** also uses the 3D 선반 today: keep it, or show 쇼케이스 as a spine shelf or flat covers?
2. **One click or two.** The spec keeps the manga/선반 grammar: the first click pulls the case out to show its cover, and a second click (or a double-click or Enter) opens. The alternative is that one click opens the work directly and the pull-out happens on hover. That alternative is not recommended: it is busy while the pointer sweeps across a dense shelf, and it does not exist on the tablet.
