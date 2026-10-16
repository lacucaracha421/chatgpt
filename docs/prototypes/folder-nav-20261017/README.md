# Folder navigation without search (2026-10-17)

Status: proposal (design mockup and spec). App source is unchanged.

User request (2026-10-17): "사이드바에 하위폴더들이 많으면 찾기 힘들잖아. 검색기능을 쓰지 않고 편하게 쓰는 방법은 없을까?" The user picked three ideas and noted that the asset top bar has free room: one open path in the folder tree, recent folders in the top bar, and following the current location.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Today's sidebar, A: live PC asset view (1376×800), B: narrow window (860×560) with the 최근 폴더 menu open, C: tablet, D: decisions, E: unverified points. |
| `folder-nav.css` | **Proposed** CSS: recent-folder chips and menu (`assets/recentFolders.css`, shared by PC and tablet) and the tree's context tint (`ClassificationSidebar.css`). |
| `folder-nav.js` | Mockup behaviour with stand-in data; the rules below are the spec. |
| `page.css` | Mockup frame and stand-in pictures only. |

The page loads the app's real `tokens.css` (with fonts), `shared-base/surfaces/toolbars/states/hover.css`, `controls.css`, `chrome.css` and `ClassificationSidebar.css`; tree rows, pins, quick views, the top bar and menus use the app's class names. Checked as static headless-Edge renders plus a scripted click run (state only; headless Edge does not advance transitions). No native check.

## 1. One open path (accordion)

- Expanding a folder (chevron, ArrowRight) collapses its open siblings and everything under them. Collapsing a folder also collapses its descendants.
- **Escape hatch:** Ctrl+click on the chevron expands without collapsing siblings. Keyboard `*` expands all siblings (WAI-ARIA tree convention). No setting.
- Opening a folder row (click, Enter) leaves exactly its path open: its ancestors, plus the folder itself when it has subfolders. Ctrl-opened branches close too.
- The clicked row must not move under the pointer: compensate `scrollTop` every frame while the reveals animate (`overflow-anchor: none` on `.workspace-index__scroll`). If the branches folding **above** the row are taller than the current `scrollTop`, fold only the branches below now and the ones above when the pointer leaves the index.
- When the open folder's row is folded away (모든 폴더 접기, a chevron), its nearest visible ancestor gets the parent-context tint (`--color-selection-context`, text `--color-selection-context-text`), as DESIGN N4 prescribes. Only one slab remains.
- Pins get no special tree treatment. Opening a pin follows the location (section 3).
- ⋯ menu: keep 모든 폴더 접기 and remove 현재 위치만 펼치기, because following now does that.
- Albums tree: same accordion rule.

## 2. Recent folders in the asset top bar

- Placement: after the title in `view-toolbar--context`, with a 1px divider. The order is a 최근 폴더 icon button (ClockIcon, quiet, square), then up to 5 chips, then 검색 / 보기.
- Chip: the shared quiet button (`Button variant="quiet"`, 28 / tablet 36 with a 44 hit area), the folder's icon in its folder colour and the name. Max 11rem with an ellipsis. The open folder's chip reads like a selected tab: text colour and weight 600, with no face and no underline. A group row uses the people glyph.
- Same leaf names among the listed folders: prefix the parent name in `--color-faint` (`엘든 링 › 풍경`). No hover tooltips (DESIGN §9). The full path is in `aria-description` and in the menu.
- **What counts:** a classification folder (or character group row) the user opened and stayed in for 3 s or more, opened an image in, or moved/added images into. It excludes folders passed through while drilling down, automatic classification and ingest, pinned folders, 전체/미분류, albums and anything in 비밀. A character or 기타 inside a group counts as its group row.
- **Order:** a new folder enters at the front, and existing chips keep their place when clicked, so nothing moves under the pointer. When the list is full (8 kept), the least recently used entry leaves. The bar shows the first 5.
- Motion: an entering chip fades in (`--motion-small`), the others slide 200 ms (FLIP), and a leaving chip fades out in 120 ms. Reduced motion swaps at once.
- **Overflow:** show as many of the first 5 chips as fit, dropping from the end. The number hidden appears as a corner count (`ui-badge--corner`) on the icon button. When none fit, only the button remains, and with an empty list the button hides.
- Menu (shared `Menu`, NieR corners): section label 최근 폴더, then all entries in bar order, each with the icon, the name and a faint right-aligned path (truncated at the start). The open folder uses the app's selected menu row. Then a separator and 최근 목록 비우기. A chip's context menu has 최근에서 빼기.
- Storage: per device and per library, next to the expanded-folder state. Deleted folders drop out and renamed folders follow by id. Privacy mode leaves chips as they are, because names already show in the sidebar.

## 3. Follow the current location

- When the current folder changes from outside the tree (recent chip or menu, pin, folder shelf, 찾기 palette, back/forward, breadcrumbs), set the expanded ids to its path (section 1), then bring its row into view in the same motion. First measure the final layout in one synchronous pass with the reveal transitions off (nothing paints in between), then restore and animate the fold. If the row will already be visible, do not scroll. Otherwise scroll so the row sits about 35% down the index, over 320 ms with ease-out, at the same time as the fold. Reduced motion jumps.
- This replaces the current reveal effect in `ClassificationSidebar.tsx` (which only adds ancestors and `scrollIntoView({block: "nearest"})`).
- 전체 does not change the tree.

## Tablet

There is no tree on the tablet, so sections 1 and 3 do not apply. It uses the same chip component, horizontally scrolling:
- the asset root shows a 최근 row between 모든 이미지 and 분류;
- inside a folder, the row sits in the pull-down shade under the 미분류/전체 control. Unverified: whether every asset folder level has that shade today.

## Open points

- The 3 s dwell is a guess; tune it on the device.
- Native feel of the anchored fold must be checked in the real window.
