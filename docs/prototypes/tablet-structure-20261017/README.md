# Tablet structure proposals (2026-10-17)

Status: proposal (design mockup and spec). App source is unchanged. B and F need the user's decision before any build.

The user asked for mockups of the tablet structure proposals from the code survey, in priority order: A long-press action sheet, C one-tap recent destinations, B folder drawer, D stronger selection, E swipe down to close the viewer, F Back as visit history. They bring the PC's right-click menu, sidebar and multi-select to touch on the tablet with existing parts.

## Files

| File | What it is |
| --- | --- |
| `index.html` | One page: A, C, B, D, E, F, the three foundations with the action matrix, decisions and unverified points. Portrait 800 × 1280 tablet frames scaled to the cell; 크게 widens one. |
| `tablet-structure.css` | **Proposed** CSS. Each block names the app file it would join. |
| `tablet-structure.js` | Frame markup (app class names) with stand-in data, and the scripted interactions (C tap, B drawer, D range drag, E swipe). |
| `page.css` | Mockup only: document, light-theme stand-in, fake tablet chrome around the proposal (status bar, bottom nav, viewer), stand-in pictures, gesture annotations. |
| `app-css/` | Copies of the app's real CSS in the repository layout so relative imports work: `mobile-client/{mobile,library,home,folderCounts,moreSheet,recentFolders,ClassificationBatchSheet}.css`, `src/assets/{recentFolders,SelectionBar}.css`, `src/styles/{tokens,fonts,controls,surface-motion}.css`, `src/styles/fonts/PretendardVariable.woff2` (+ OFL). Copied 2026-10-17; refresh from `_tools/app` before reuse. |

The app ships one dark theme. The light theme on this page is the planned 종이 palette from `docs/prototypes/design-foundation-20260928/part4.html`, set in `page.css` only. The page follows `prefers-color-scheme`, and `data-theme="dark"|"light"` on `<html>` overrides it (자동 / 어둡게 / 밝게 switch, saved per viewer).

## A. Long-press action sheet

- Long-press (450 ms, 10 px slop; see Foundations) on a folder card, album card, Collection cover or spine, artist, or recent chip opens the existing bottom sheet (`BottomSheet` + `MoreSheet` rows, `.tablet-more .workspace-index-link`).
- The first row is the target: 48 px thumb (cover, folder glyph in its colour, or two overlapping thumbs for a selection), the name (body, 600) and one meta line (kind · count · path). It replaces the text title (`BottomSheet` gains a heading node).
- Then the same items, order and wording as the PC context menu for that target, minus PC-only items. Destructive items sit last under a hairline in danger red. 닫기 stays.
- Items per target are in the matrix below. A folder-shelf card adds the PC shelf order group (앞으로, 뒤로, 맨 앞으로, 맨 뒤로, `shelfOrder.ts`). Character group cards open no sheet (their actions are PC-only).
- Images keep long-press = selection mode. The selection bar gains ⋯ (before ✕), which opens the image sheet: 출처 복사, 앨범에 추가, [이 앨범에서 빼기], [이 컬렉션에서 빼기, 대표 이미지로 지정], 정보 열기 (one selected), 휴지통으로.
- During the hold the target shows the existing press face only (no scaling); at 450 ms a short haptic and the sheet rises (140 ms). Tapping an item closes the sheet and runs it (rename etc. open the existing input sheets). Swipe down, outside tap, 닫기 and Back close it.

| Target | PC menu (source) | Tablet sheet |
| --- | --- | --- |
| Folder | 분류함으로 쓰기, 고정, 하위 폴더 만들기, 이름 변경, 아이콘 및 색상, 폴더 이동, 삭제 (`ClassificationSidebar.tsx`) | 고정 (new: needs a server write path), 하위 폴더 만들기, 이름 바꾸기, 아이콘 및 색상 (new for folders on the tablet). Not: 분류함으로 쓰기, 폴더 이동, 삭제 (PC-only) |
| Folder-shelf card | 앞으로, 뒤로, 맨 앞으로, 맨 뒤로 | Folder items + the same order group |
| Character group | 그룹 열기, 그룹 편집, 위로/아래로 이동 | No sheet (PC-only) |
| Album | 하위 앨범 만들기, 이름 변경, 아이콘 및 색상, 앨범 이동, 삭제 | 하위 앨범 만들기, 이름 바꾸기, 아이콘 및 색상, 삭제. 앨범 이동: not on the tablet today (decide) |
| Collection work | 편집, 쇼케이스에 추가/빼기, 삭제 (`CollectionBrowser.tsx`) | Same; the delete reads 휴지통으로 (restorable for 30 days, DESIGN §12 Words) |
| Artist | 고정, 이름 바꾸기, 다른 작가와 합치기, 숨기기 (`ArtistHub.tsx`) | 고정, 이름 바꾸기, 숨기기. Merge stays PC-only |
| Recent chip | 최근에서 빼기 (`RecentFolderChips.tsx`) | Same |
| Images (selection ⋯) | `libraryContextItems.ts` + `AssetBrowser.tsx` list | As above; 선택한 영상 비교 stays PC-only (decide) |

## C. One-tap recent destinations

- A 최근 row (section label + the shared `RecentFolderChip` in `.recent-row`) sits at the top of the 분류 batch sheet (`ClassificationBatchSheet`), the album batch sheet (`AlbumBatchSheet`) and the viewer's 분류 editor (`ClassificationAssignmentEditor`, above the search field).
- Chips are destinations the user recently put images into: folders for 분류, albums for 앨범. Groups are not classification targets. A destination that already holds every selected image is `aria-disabled` (40% opacity).
- One tap applies at once (no 적용). Done in place: the chip's icon becomes a check, its text turns `--color-success`, its face tints toward success and fades over 1.4 s; one meta status line under the row repeats the existing result text (`12/12개 분류 변경 · 하우징`). The sheet closes itself 0.9 s later; the selection stays. No success toast. On any failure the sheet stays open with the existing one-line error and 다시 시도.
- The tree, search and 적용 below are unchanged for destinations not in the row.

## B. Folder drawer — reverses the earlier "tablet: chips only" decision; needs the user's OK

- Opened only by a ☰ top-bar button (Heroicons `Bars3BottomLeft`) on asset screens: after ← in folders, in place of the brand mark on the asset root. No edge swipe: Android gesture Back owns both screen edges.
- Shell: the existing left full-height editor panel (`.ui-dialog:has(.classification-index)`, width `min(390px, 100vw - 36px)`, slide `--surface-x: -100%`). Back, ✕ and the scrim close it.
- Order as the PC sidebar: 빠른 보기 (모든 자산, 미분류, 작가; 48 rows, 20 px icons, count only on the current row) → 고정 (the PC's bordered pin chips, 36 high with a 44 hit area) → 최근 (the chip row, horizontal scroll) → 폴더 tree → 앨범 tree.
- Tree rows use the tablet `.tree-row` idiom at body size: 48 rows, 44 px expanders, 16 px per depth. The current place uses the PC slab: `--color-sidebar-selection`, dark mark at the right end, `--selection-echo`. Branches reveal by grid rows (`--motion-medium`).
- FOLDER-NAV-001 rules: only the current path is open on open; ▸ expands and folds its siblings (and their subtrees); collapsing folds descendants. Tapping a name opens that place and closes the drawer; the next open shows that place's path only.

## D. Selection

- 전체 선택 (ghost, small) right after the count in the shared `SelectionBar`. It selects the whole current list, including pages not yet loaded (server count); batch actions keep running in chunks of 100. While everything is selected it is `aria-pressed` and reads like a selected tab (text, 600).
- Range drag: after the 450 ms hold that enters selection mode, keep the finger down and drag; the run in reading order from the first tile to the tile under the finger is selected (Google Photos). Starting on a selected tile removes instead. The run is recomputed from the selection before the drag, so dragging back shrinks it.
- Auto-scroll: within 96 px of the list's top or bottom edge the list scrolls, faster deeper into the zone (up to ~14 px per frame), and the range follows.

## E. Swipe down to close the viewer

- Only when the image is not zoomed and the gesture starts below the top bar (not in the top 56 px), and the movement is mostly vertical (dy > 1.2 × |dx|). Zoomed images keep panning; swipe up near the strip and horizontal paging are unchanged.
- The image follows the finger (x and y), scales down to at most 0.7 (1 − dy/1400), the backdrop fades (1 − dy/500, not below 0.2) showing the list behind, and the top bar and strip fade out (120 ms).
- Release past 120 px or with a fast flick: the existing close zoom (about 320 ms, `--ease-sheet`) runs from the image's current box into the tile of the asset shown. Otherwise it returns with `--ease-spring` (no overshoot) in about 300 ms. Reduced motion: close or return at once.

## F. Back as visit history — needs the user's decision

- Today Back (Android Back and the top-bar ←) goes to the parent folder (`App.tsx`, folder Back handler). That equals "where you came from" when drilling down; it differs after a jump (최근 chip, 찾기, drawer, pin, Home shortcut).
- Proposed: Back returns to the previous place in this tab's visit history with its scroll position; the parent stays reachable from the top-bar breadcrumb. Matches the PC's mouse Back. History stays inside the tab; tab switches are not recorded (DESIGN §9). With no history: parent folder, then Home, as today. Open selection, sheets, drawer and viewer still close first.
- Options: (1) Android Back and ← both follow history (recommended); (2) Android Back = history, ← = parent (Android "Up"); (3) keep today.

## Foundations

- **One action list.** A shared module (`src/shared/`) defines per-target items: id, label, icon, group, destructive, PC-only. The PC `ContextMenu` and the tablet sheet render the same list; the tablet drops PC-only items. Wording is fixed once: 이름 바꾸기 (PC folder and album menus say 이름 변경 today), 휴지통으로 for restorable Collection deletes.
- **One long-press hook.** 450 ms, 10 px slop (today's gallery values), haptic on fire, cancelled by scroll, suppresses the following click, blocks the system menu. Replaces the 450 ms (gallery) and 500 ms (catalog pin) timers. The PC shelf drag hold (250 ms, mouse) is separate.
- **One destination model.** Folder, character group and album as one shape (kind, id, name, icon, colour, path). It feeds recent chips (places visited), sheet chips (places filled, by kind), the drawer, Back history (place + scroll) and 찾기. Deleted places drop out; renames follow by id.

## Decisions for the user

1. B: reverse "tablet: chips only" and add the drawer? ☰ on the left (proposed) or among the right-side buttons.
2. F: option (1), (2) or (3).
3. C: sheet closes itself 0.9 s after a one-tap apply and keeps the selection (proposed), or stays open, or also clears the selection.
4. D: 전체 선택 covers the whole list (proposed) or only loaded tiles.
5. Wording: 이름 바꾸기 everywhere; Collection delete reads 휴지통으로.
6. New tablet capabilities: folder 고정 (server write path) and folder 아이콘 및 색상; keep 앨범 이동 and 선택한 영상 비교 PC-only.
7. Timings: long-press 450 ms everywhere; swipe-close at 120 px.

## Unverified

- Checked as headless-Edge renders and mouse-driven interactions only. Touch feel (450 ms, 120 px, auto-scroll speed) needs the device.
- The tablet's Android navigation mode (gesture vs buttons) was not checked; the edge-swipe conflict assumes gesture navigation.
- That the tablet has no write path for folder pins is read from the clients (the PC publishes `pinnedClassificationIds`); the server was not checked.
- Whether the tablet has an image Collection view needing 이 컬렉션에서 빼기 / 대표 이미지로 지정 was not checked.
