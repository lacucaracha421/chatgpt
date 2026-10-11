# Tablet top bar — one layout rule (proposal, revision 2, 2026-10-11)

Status: accepted by the user 2026-10-11 (all four decisions: yes; mockup-only counts removed). Implementation in progress. Open `index.html` (loads the app's real `fonts.css`, `tokens.css`, `controls.css`). Every proposed frame prints its rendered cell sizes under it ("측정"), so the widths below can be checked in the page.

User request (2026-10-11): the tablet top-bar buttons are arranged differently on every screen; make them consistent. The Find sheet itself is out of scope (it already matches the PC after the shared input/chip change); only where the search button sits is part of this rule.

## Revision 2 — keep tablet sizes

User feedback on revision 1: "PC에 맞춰서 작게 표시하는 건 태블릿에선 불편하다" — the 에셋 폴더 segment shrank from full width to content width (cells about 60–80 px), and the seven-slot bottom bar narrowed every tab. Benchmark the user accepts: today's Collections segment cell (게임 / 만화 / 영화 / AV), measured at about **93 × 44 px** in portrait (0.9.66 capture; about 152 px in landscape).

- Segments no longer shrink to content width. A section-bar segment takes all the width its tools leave, and a cell never drops below 96 px.
- To keep that possible, the tablet section bar holds at most four tools: shortcuts | 보기 · +. PC's separate 정렬 · 내 별점 · 보기 become three groups inside one tablet 보기 sheet (a portrait-width difference allowed by DESIGN.md §12; the PC 에셋 보기 already contains 정렬).
- The bottom bar keeps its five tabs at today's size. App-wide 찾기 and 더보기 go to the end of every top bar (revision 1's option 2), not into the bottom bar.

Measured cell widths at 674 px portrait (height 44 px for segments, 56 px for bottom-bar plates):

| Place | Today | Proposal |
| --- | --- | --- |
| Collections segment | 93 | 112 |
| Release calendar segment | 75–84 | 141 |
| 에셋 모든 자산 / folder segment | 206 | 189 |
| 메모 segment | 155 | 131 |
| 에셋 root, catalog segment | full width | full width |
| Collections segment, landscape 1078 | about 152 | 159 |
| Bottom bar | 128 | 128 (revision 1 option 1 would be 88) |

## Rule (recommended)

Top bar, left to right, the same on every screen and in both orientations:

1. Logo on a tab's first screen, ← on deeper screens.
2. `parent ›` (meta size, one line, tappable, 44 px) + title (22) + count (13). When the screen shows its title large in the body (work detail, catalog detail), the bar shows the location only.
3. At most one item action, detail screens only (e.g. the 쇼케이스 toggle on a work).
4. 🔍 찾기, on every screen. Where the screen has its own search, the Find sheet opens with the first row "이 화면에서 ‘…’" selected and the keyboard's search key runs it, so screen search keeps today's tap count (🔍 → type → search); app-wide results follow below (the PC Find contract).
5. ⋯, on every screen and always right-most: this screen's menu (folder/album management, 새로고침 with its last time, 지금 동기화, 품번 보내기, performer management, 책등 받기), followed by today's 더보기 groups (확인할 것 · 이동). It carries the 확인할 것 corner count. On Home it is today's 더보기.

- Right side: icons only, at most three, fixed order. Every top bar therefore ends with [🔍][⋯]; Home's bar is unchanged. No text buttons and no status words in the bar. Busy = the existing bar progress line; failure = one-line toast with 다시 시도; last refresh/sync time = a line inside ⋯.
- Section bar: segment (fills the remaining width, cells ≥ 96 px × 44) → shortcuts (쇼케이스, 발매 캘린더 / 신간, 관심; icon + count) → thin divider → 보기 (count of changed groups) → + where the screen creates items. 메모 keeps the PC 메모 order + · 보기. Screens without tools (에셋 root, catalog) keep a full-width segment. The catalog's 언어 · 인기 · 필터 row is unchanged. The section bar keeps its accepted scroll-away + pull-down shade behaviour.
- 보기 sheet contents: Collections = 정렬 (with 묶기 for games) · 내 별점 slider · 격자/선반 + per-row count (the PC menus' contents); Assets = 정렬 · 비율 · 길이 · 타일 크기 (PC 에셋 보기).
- Portrait: section-bar tools are icon (+ count). Landscape: icon + short label, same buttons in the same order; 정렬 · 내 별점 are not split out in landscape so the buttons stay put when the tablet rotates.
- 44 px targets, 24 px top-bar icons, 20 px section-bar icons, 24 px gutter.

Trade-off: 찾기 and 더보기 sit at the top-right corner rather than within thumb reach at the bottom, and on screens with their own menu the 더보기 rows sit below that menu in one sheet. In return no tab, segment cell or selection plate gets smaller, and the same two icons are in the same place on every screen.

## Considered and not recommended

- Revision 1 option 1 — 찾기 · 더보기 at the end of the bottom bar (seven slots): every tab cell drops from 128 to 88 px (−31%), below the 93 px benchmark.
- Six-slot bottom bar (only 더보기 at the bottom, about 104 px): still narrows the tabs and splits 찾기 from 더보기, unlike the PC rail pair.
- Section-bar runner-up — full-width segment with a second, right-aligned tool row (정렬 · 내 별점 · 보기 kept separate like the PC): matches the PC button by button, but adds a row of about 48 px above every list and leaves a nearly empty row on screens with one tool.
- Revision 1 content-width segment with tools beside it: rejected by the user (cells about 60–80 px).

## Open decisions

1. 찾기 · 더보기 at the end of every top bar, with the bottom bar unchanged (recommended: yes).
2. Tablet section-bar tools reduced to shortcuts | 보기 · +, with 정렬 · 내 별점 inside 보기 (recommended: yes; runner-up is the second tool row).
3. Drop status words (동기화됨, 갱신 12:57) from the bar on both clients (recommended: yes; PC 메모 follows in the same round).
4. 메모: replace the always-visible body search field with 🔍 (Find opening on "메모에서"), and the floating 메모 쓰기 button with the section-bar + (recommended: yes, matching PC 메모's + · 보기).

## Implementation outline (later round)

- `mobile-client/TopBar.tsx`: replace free-form `actions` with named slots (`itemAction`, `find`, `menu`); every screen passes the same 찾기 and ⋯; crumbs always inline; remove `.top-bar__queue`, `.notes-save-state`, `.catalog-refresh-age` styles from `mobile.css` (also fixes the off-role 11/12/14 px sizes).
- `FindSheet.tsx` / `findData.tsx`: add the "이 화면에서" first row on the tablet (today it is PC palette only) and preselect it when the opening screen registers a search; the keyboard's search key runs it.
- `MoreSheet.tsx`: accept screen menu entries above the existing 확인할 것 · 이동 groups; ⋯ carries the 확인할 것 count everywhere. Remove the per-screen `FindButton`/`MoreButton` placements (`appHeader`, `Notes.tsx`, `Settings.tsx`, `Collections.tsx` AV) in favour of the TopBar slots. Bottom navigation (`App.tsx`) is unchanged.
- Section bar via `useSectionShade` `trailing`: segment cells flex to fill with a 96 px minimum (`.ui-segmented` in `mobile.css`); `Collections.tsx` (`viewTools` → shortcuts | 보기 · +, 정렬 · 내 별점 moved into the 보기 sheet), `App.tsx` asset toolbar (FilterChips/sort/options → one 보기 sheet), `Notes.tsx` (+ · 보기), `ReleaseCalendar.tsx` (관심 as a shortcut, full-width segment).
- Screen ⋯ entries: asset folder/album management, `Catalog.tsx` (새로고침 + time), `Notes.tsx` (지금 동기화 + time), Collections AV (품번 보내기), game 책등 받기.
- PC follow-up in the same round only for decisions 3/4 (`notes/NotesView.tsx` status text, notes search placement).
