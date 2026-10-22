# Mobile premium layout mockups (MOBILE-DESIGN-001, 2026-09-25)

## Decisions (user, 2026-09-25)

The user reviewed these mockups and chose the following. They are implemented in Android 0.8.12 (49).

1. Top bar brand: **B**, the logo mark plus a larger tab name.
2. Library root first screen: **A**. Three columns; the covers flex so exactly three whole rows fill the screen; an end line reads "아래에 분류 N개 더"; scrolling snaps by row. The fit is computed at runtime from the real scroller height, not from the 1232 px assumed here.
3. Viewer actions: **A**. Each action shows its icon plus a short label; 분류 uses the folder icon, 앨범 the stacked-squares icon, and 휴지통 sits apart behind a divider.
4. Catalog 필터 chip: saved 회피 태그 alone are the default, so the chip stays neutral. It turns the PC grey with a count only when something differs from that default.
5. 설정 stays on Home only.
6. Bottom navigation: **60 px** (not 64).
7. Unanswered questions take the mockup defaults: `확인 N` appears on the Library bar only, and endless grids end in a fade above the navigation.

These are the design mockups the decisions above were made from. Where the decisions differ, the decisions win; the rest of this README describes the mockups as they were shown.

- Open `index.html` in a browser. It is one file with inline CSS and a little inline script. It uses no network, and fonts load from the app's bundled font files by relative path. Use the **실제 크기 (1:1)** button for true pixel size and **주석 표시** to hide the yellow notes.
- `current-*.png`: screenshots of today's app in its demo mode (`npm run mobile:dev`, `?demo`). The one exception is `current-library-root.png`, a replica with 10 folders and a waiting 후보 확인 row, because the demo has only 3 root folders and cannot show the peeking row. `current-bars.png` is also a replica.
- `proposed-*.png`: renders of each proposed screen or strip from `index.html`.
- Renders use headless Google Chrome at DPR 1. Art is the demo's placeholder art, and all names and counts are fictional. Yellow numbered notes are annotations, not UI.

## Viewport assumption

The frames are **800 × 1232 CSS px**. That is the 800 × 1280 portrait fixture size used before (`android/README.md`), minus an **assumed 48 px** Android navigation inset. The app hides the status bar (`MainActivity.hideStatusBar`) and pads the WebView by the system-bar insets. The real inset on the Tab S11 (gesture bar vs. 3-button bar) is not measured. "Ends cleanly" depends on the exact height, so `window.innerHeight` should be read once on the tablet before implementation.

## What each screen proposes

1. **Shared top bar on every tab** (`proposed-bars-a/b.png`, today: `current-bars.png`). Home's 56 px bar (logo, title, actions) becomes the bar of Library, Collections, Catalog and Notes.
   - Actions move up from the content: Library's 휴지통, Catalog's "N일 전 갱신" and 새 작품 가져오기, Notes' 동기화됨 and sync.
   - Search becomes a magnifier icon on the tabs that can search (Library, Collections, Catalog, Notes). Tapping it turns the bar into the input.
   - 설정 sits at the far right on every tab.
   - Inside a folder, the back arrow takes the logo's place, and the separate header row (뒤로 · 경로 · 제목 · ⋮) merges into the bar. That gives the gallery about 90 px more.
2. **Library root** (`current-library-root.png` → `proposed-library-a/b.png`):
   - 최근 연 폴더 is removed.
   - The always-open search field becomes the bar icon.
   - The 캐릭터 후보 / 유사 이미지 entries leave the list and become one small `확인 N` button in the bar, shown only when something waits.
   - The 분류/앨범 switch and the section label take the PC look (tint selection, small square plus hairline label).
   - The first screen ends on a whole row. There are two ways to do this; see the choices below.
3. **Quiet filters** (`proposed-filters.png`, `proposed-catalog.png`, `proposed-collections.png`):
   - The saved 회피 태그/categories count as the default, so the 필터 chip stays neutral with them and shows a small "기본".
   - The chip turns to the PC's grey "filter on" face with a count only when the filter differs from that default. A quiet `기본으로` action appears next to it.
   - Chips get the PC control face.
   - In Collections, 정렬 and 내 별점 move onto the `전체 N` line, which saves one row.
4. **Asset viewer icons** (`current-viewer.png` → `proposed-viewer-a/b.png`):
   - Today 분류 uses a tag icon and 앨범 a folder icon, but the Library shows 분류 as folders. The proposal switches them: 분류 = folder, 앨범 = two stacked squares.
   - 휴지통 moves behind a divider and gets a muted red icon.
   - There are two ways to name the icons; see the choices below.
5. **PC-like buttons and taller navigation** (`proposed-buttons.png`, `proposed-nav.png`):
   - Buttons use the PC `ui-button` recipe. Secondary buttons get a control face, a 1 px border and a faint top light. The ivory accent is kept for the one main action. Quiet buttons show muted text and light up when pressed.
   - The visible button height goes from 44 to 40 px, while the touch area stays 44 px.
   - The white "selected" chip is replaced by the grey filter face.
   - The bottom navigation goes from 56 to 64 px, with 23 px icons and 11 px labels. The 8 px lift from 0.8.2 stays.
6. **New tiles on scroll** (`proposed-tiles.png`, with a live demo in `index.html`):
   - Each tile's place appears at its final size first.
   - The tile then rises 10 px while fading in over 320 ms, with 45 ms between tiles in a row. The picture fades in over 260 ms once it is decoded.
   - Only rows added by a page load animate; rows re-drawn while scrolling back up do not.
   - With reduced motion, tiles appear at once.
   - It is CSS only, so there is no extra React render per tile.

Also shown: the Notes bar only (`proposed-notes.png`). The Notes content waits for Notes v2. Home content is out of scope; only its bar is shown for consistency.

## A/B choices for the user

| # | Choice | A | B | Suggested |
| --- | --- | --- | --- | --- |
| 1 | Top bar brand | Logo + `LAKOMICS` + divider + tab name (today's Home bar, extended) | Logo mark only + larger tab name | A: continuity with Home |
| 2 | Library root, first screen | 3 columns; the covers flex slightly (4:3 to square) so exactly three whole rows fill the screen; an end line "아래에 분류 N개 더"; scrolling snaps by row | 4 smaller columns; up to 12 top-level folders fit on one screen; the last tile becomes "+N 더 보기" when there are more | Depends on how many top-level folders there are (see question 1) |
| 3 | Viewer action names | Icon + short label, always visible (분류 · 앨범 · 정보 · 휴지통) | Icon only + a card naming each icon on first use (and from 정보) | A: clearest, and the bar has room at 800 px |

## Questions for the user

1. How many top-level folders does the real Library root have? With up to 9, A shows them all; with 10–12, B does.
2. The brief says the "Showcase" filter button is always white. The button that behaves like that in code is the **Catalog** 필터 chip: saved 회피 태그 count as active filters. Collections' 쇼케이스 has no filter button. Is the Catalog chip the one you meant?
3. Is it right to treat the saved 회피 태그 as the "default" (neutral chip)?
4. Should `확인 N` (character candidates and similar-image review) appear only on the Library bar, or on every tab's bar as the one status indicator carried over from the PC declutter?
5. Should 설정 be on every tab's bar (proposed) or stay on Home only?
6. For endless grids (Collections, Catalog, a folder's gallery), a partial last row is unavoidable at a fixed cover shape. The mockups soften it with a 40 px fade above the navigation. Is that acceptable, or should those screens also snap to whole rows?
7. Is the 64 px bottom navigation the right step, or should it be 60 px?

## Implementation notes (for later, after approval)

- Top bar: extend `App.tsx`'s Home header into a shared bar. Each tab supplies its title and actions via the existing `HeaderTools` portal. The Library/Collections/Catalog/Notes title rows (`library-root-header`, `collection-top`, `catalog-top`, `notes-top`) fold into it. Notes should change only minimally, since Notes v2 follows.
- Layout jump on append: `Gallery.tsx` justifies rows over the whole list, so the last partial row can re-flow when the next page arrives. Keep the trailing partial row unjustified (or held back) while `has_more` is set, so appends only add rows below.
- Filter default: compare against the saved preferences in `catalogPreferences.ts` rather than counting them.

## Evidence and gaps

- Rendered all PNGs with headless Google Chrome 153 through the DevTools protocol, at 800 px width and DPR 1, and inspected each one. Overlapping notes were moved.
- Today's screens come from the demo transport. They are not the live library or the tablet.
- Not checked: the real Tab S11 viewport height, touch feel, DPR 2 rendering, the animation's smoothness on the device, and landscape. None of this is app or device evidence.
