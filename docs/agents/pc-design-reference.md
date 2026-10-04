# Lakomics PC design reference

> Status: current PC visual/interaction reference. The Android tablet shares the `DESIGN.md` §12 Foundation; PC is canonical and tablet differences are limited to touch, portrait layout and gestures.
> Baseline: Lab 06 content direction + Chrome 03b B left-centric shell, integrated by commit `2d7bac2`, then refined by PC-UI-001 and PC-DECLUTTER-001.
> `DESIGN.md` is the short constitution; this file holds implementation-level design contracts. Product terms come from `CONTEXT.md`; feature behavior lives in its subsystem reference (Works: `lakomics-works-handoff-v2.md` and `works-viewer-design.md`; characters: `docs/research/character-classification-quiet-workflow-design-20260911.md`). Verification history lives in `docs/roadmap/lakomics-completed.md`.
> Colors are named by their `_tools/app/src/styles/tokens.css` custom properties; read values there rather than copying hex literals.

## 1. Scope and superseded records

This reference replaces the former `approved-design-direction.md` and `approved-chrome-direction.md` decision logs (now pointers only) and the visual assumptions of a permanent horizontal toolbar, a fixed old sidebar/topbar, justified rows as the only Asset layout, and flat game/manga collection objects.

Do not restart the 1–6 reference comparison or the Chrome A/B/C vote unless the user explicitly reopens the design direction.

## 2. Product character

Lakomics is a **media-first personal archive**, not a dashboard, launcher, streaming service, or room simulator. The screen should feel calm enough for long sessions, dense enough to browse thousands of assets, personal because collected artwork dominates the color field, and deliberate because navigation, selection, physicality, and empty states follow consistent rules.

The visual system is dark-neutral, square/rectilinear, low-radius, line-icon heavy, and border-led rather than card-led.

Typography (user-approved 2026-09-28, replaces the 2026-09-06 SUIT + Barlow pairing): Pretendard for Korean and Latin UI, creator names and all numbers (Rajdhani retired 2026-09-29); numbers use tabular figures, large standalone ones the `number` role in `DESIGN.md` section 12. Keep the Japanese fallback. Numeric roles use tabular figures; dates and information-panel times use the meta size. Fonts and OFL notices are bundled for offline use (`styles/fonts.css`, `--font-ui`, `--font-numeric`).

## 3. Chrome 03b shell

```text
┌──────┬──────────────────────┬──────────────────────────────────┐
│ area │ contextual index     │ thin title/window region         │
│ rail │                      ├──────────────────────────────────┤
│      │ current-area nav     │ current location / transient     │
│      │ folders / albums     │ state, then media content        │
│      │ types / source       │                                  │
│      ├──────────────────────┤                                  │
│      │ contextual controls  │                                  │
└──────┴──────────────────────┴──────────────────────────────────┘
```

### Area rail

- Areas start with 홈, 에셋, 컬렉션, 망가, 메모, 전송 (plus 비밀 when the private vault is available). The tail holds `찾기` (the command/search palette, `Ctrl+Q`; it replaced `Ctrl+K` / `Ctrl+F` on 2026-10-05) and `더보기`, a panel listing pending queues (유사 검토, 미분류, 전송 when they have items) and destinations (작가, 다시보기, 통계, 휴지통, 설정). The `더보기` badge counts only pending similarity review; 전송 shows its own received-file count. The area order and the `작가` entry follow `layout/WorkspaceNavigation.tsx` and `layout/navigationEntries.tsx`.
- More opens beside its rail button, bottom-aligned, without a header or close button; outside click or Escape dismisses it.
- Work, sync and error status live in the titlebar status center beside the window controls, not as rail buttons.
- The rail is narrow and visually weaker than the contextual index; its current area uses the parent-context tint (§7).
- Switching areas preserves the owning screen state where the code supports it rather than resetting for visual neatness.

### Contextual index

- **Assets**: broad scopes, Classification tree, Album tree, folder counts and user appearance.
- **Collections** (2026-10-02): no sidebar index; the list uses the full content width. Types (게임/만화/영화/AV) use the shared section bar, with sort/view at its right. A second shortcut row carries 쇼케이스, 신간 and 발매 캘린더 and opens the existing PC views. There is no Library/Showcase mode. An open work owns its title, personal state, management actions and edition controls in the work screen.
- **Manga**: local/online/catalog context and controls owned by the corresponding browser. Hide the sidebar from its header and restore it from the top bar, remembering the choice per area; hiding it must leave catalog search reachable.
- Do not merge a user Classification named “만화”, Collection type `manga`, local Manga Root, and Online Catalog into one concept (`CONTEXT.md`).

### Main content header

- Keep the native window controls and status center in one thin, stable place. No square mark precedes any screen title (2026-10-02); index section and selection marks keep their separate roles.
- Show current location and only meaningful transient state; do not repeat brand subtitles, “내 라이브러리”, or explanatory prose on every screen.
- Do not recreate the old full toolbar above the content.
- Selection-only commands stay in selection/context surfaces. Exception (CHAR-UI-002~006, 2026-09-09): the series/character review screen may expose selection accessories (count, clear, exclude, review entry) as `titleAccessory`; this is not a license to spread selection commands to other headers.
- One-time setup and rare management actions live in the owning `… 더보기` menu or panel (e.g. `폴더 더보기`, `시리즈 더보기`, `캐릭터 더보기`), not as persistent header buttons. Frequent actions may keep a labeled button (e.g. `캐릭터 만들기`).
- Do not add persistent refresh buttons: background updates refresh the view automatically; error retry and a context-menu refresh remain for recovery.
- **Section bar (user, 2026-10-01):** the shared bar sits at the start of the list and scrolls away on both PC and tablet. Once off screen, the top-bar title reads `<area> · <section> ⌄`. On PC, resting the pointer on the top bar for 150 ms drops the bar below it; it closes 300 ms after the pointer leaves both the top bar and the section bar. Clicking the title toggles it. Sort/view controls remain at the bar's right. Merging the section bar into the top bar as one row was considered and declined; scroll-direction auto-hide remains rejected.
- **Tablet shade (user, 2026-10-01):** pull down the top bar or tap its title to reveal the section bar; picking a section or scrolling the list closes it. The pull-down shade is retained without bounce. An optional second row in the same segmented track carries shortcuts, not selected tabs: Collections uses 쇼케이스 with a work count, game/movie 발매 캘린더 with a new-event count, manga 신간 with an unread count, and AV 쇼케이스 only. Both rows travel together in the shade. PC uses the same second shortcut row (2026-10-02), opening existing views instead of tablet overlays. References: `docs/prototypes/section-bar-20261001/README.md` and `docs/prototypes/collection-shortcuts-20261001/README.md`.

## 4. View settings

The Asset toolbar holds the title, search and 보기. Sort and tile size are inside 보기, alongside the supported layout/filter/privacy controls; no retired tile-caption option should return.

- The menu is anchored to its toolbar button, non-modal and internally scrollable when height is limited.
- Opening/closing the menu preserves gallery geometry, scroll, selection and loaded data. Setting changes apply immediately through the existing preference owner; closing is never cancel.
- The information panel is a separate dock: `I` toggles it beside the grid, which moves aside with the accepted 200 ms spatial motion. Do not apply the former overlay-only rule to this dock.

### Panel dismissal and focus

- Same trigger, explicit close, or outside interaction closes the panel.
- `Esc` closes the innermost menu/popover first, then the panel; one key press never cascades into clearing a selection or closing a viewer behind it.
- Nested portal menus/selects count as panel-owned interaction.
- Closing returns focus to a sensible opener.
- Narrow windows clamp panel position and size instead of hiding Classification or shrinking the gallery.

## 5. Search

Search is not the dominant daily action, so it has no persistent input.

- The rail 찾기 palette (`Ctrl+Q`, also from a text field) searches names across works, artists, note titles, folders, screens and commands using data already on the device. Scope chips narrow results. The current screen's own search is the first row where supported; an empty query shows 확인할 것 and five recent items. The tablet shares the cross-name Find contract (`628b6da3`).
- An applied query stays visible as a query badge in the view header with a direct `검색 해제` (the palette offers it too). Dismissing the palette never clears an applied query.
- Online Catalog keeps its own search surface with suggestions/autocomplete and language/scope semantics.
- Assets have no general text-search query contract. Do not fake one or add a new index/search engine for symmetry.

## 6. Asset browser

### Layout

Default PC Asset layout is **date-grouped masonry/waterfall**; justified rows remain an explicit alternative view.

- Preserve intrinsic aspect ratio. Tiles show images only, with no filename/creator/time captions on hover or at rest. Metadata remains in the information panel and accessible descriptions.
- Group by `collectedAt` in local time, consistent with sorting. Date headings are small muted text without rules, with counts on hover; the scrubber bubble shows the date. Sparse date groups retain their compact wrapping layout.
- Video duration is the only routine media badge (`▶ 0:42`), hidden on very small tiles. Hover reveals the heart; the likes view keeps it visible.
- Sidebar counts show for selected/hovered entries and folder-group controls on hover. Show the folder shelf only at a folder's top level, never stacked above date headings.
- The docked information panel pushes the grid aside; visible tiles glide into place while scroll and selection remain stable. Reduced motion swaps immediately.
- PC lists use `shared/ui/scrubber/` for Assets, Collections grids/shelves, local Manga and online catalog/bookmarks. It grows on use, shows a date/position bubble and hides after release; PC Asset labels use loaded tiles, not a full month TOC.

See the [accepted calm-grid reference](../prototypes/assets-calm-20261002/README.md); the later removal of select circles (`f901c437`) supersedes that part of the mockup.

### Asset selection

Asset selection is intentionally quieter than navigation selection.

- Use the shared selected-image treatment with a check only on selected tiles. No select circle appears, including on hover.
- Keep tile geometry stable when selection changes; do not add a caption or decorative outer frame.
- Heart state is membership in the designated 마음에 들어요 album, which cannot be deleted. The role is stored, not inferred from an arbitrary same-named album. A tile heart acts only on that tile, independent of multi-selection.
- Keyboard focus stays independently visible.
- Multi-selection actions use the existing selection bar/context flow without shifting the rail, index or header.

## 7. Selection and control states

### Navigation selection (N4)

- **Slab — most specific current location.** Background `--color-sidebar-selection` / `--color-accent`, text `--color-on-accent`, radius 0, box shadow `--selection-echo` (`--selection-echo-surface` on the standalone Settings surface). Applies to classification rows, quick views, pins, index links (Collection types, 신간, 발매 캘린더, 더보기 lists), update-provider destinations and Settings sections. Slab hover stays ivory (`--color-accent-hover`).
- **Selected-row mark.** A selected index/list row is the ivory slab with its own small dark square (`--selection-mark-size`, `currentColor`) at the right end. Never add a separate small ivory square cursor to the left of or outside the row; it duplicates that mark (user, 2026-09-26). `--selection-cursor-offset` has no consumer; `--selection-cursor-size` survives only as the section-label mark size. Classification tree rows keep their folder icon and inner treatment.
- **Echo.** A hard 1px `--color-selection-echo` line offset 3px right/down; the double shadow masks the interior with the panel background so only the right/bottom outline shows. Blurred or decorative selection shadows remain banned.
- **Tint — parent context (N4 parent-tint rule).** When a parent level and a more specific child are both current, only the most specific keeps the slab; the parent uses `--color-selection-context` with `--color-selection-context-text`, hover `--color-selection-context-hover`, and no echo or mark. Current users: the area rail, Notes scopes and the ledger segments. Never show two slabs for different levels of the same hierarchy.
- **Cards.** A selected card (e.g. a Notes card) keeps its layout and uses only a 1px `--color-accent` outline, without the 3px echo or a slab fill.
- **Index section labels.** `.workspace-section-label` and index `.chrome-settings-group > legend` use the §12 faint `meta` role and show a small square (`--color-section-mark`) before the text and a 1px fading hairline (`--section-label-rule`) filling the width.

Keyboard `:focus-visible` outlines (`--color-focus`) stay separate and visible on slab, tint and card selections.

### Multi-select filters

Neutral gray, marker-free: selected filter chips use the `--color-filter-selected` face and weight 600 with no border; unselected text is muted. Use `--color-filter-text`, `--color-filter-border`, hover `--color-filter-hover` / `--color-filter-hover-border` for the remaining states. Multi-select filters stay gray even when only one value is active; never use the ivory slab for them.

### Toggles and checkbox labels

- An unchecked box must be visible on dark surfaces: the §12 1.5px `--color-border-strong` border on `--color-bg`, radius 2. Checked uses an accent border with an inner solid accent square; focus uses the `--color-focus` ring; disabled dims.
- A checkbox/toggle label names the setting (`자동 갱신`, `절약 모드`) or, when the row heading already names it, the current state (`켜짐` / `꺼짐`). Never use action wording (`켜기`) on a checkbox; the box already shows state.
- Action wording (`절약 모드 켜기` / `끄기`) belongs to one-shot commands in menus or the palette and must follow the current state.
- A toggle label and its stored preference must keep the same meaning. Asset tiles remain image-only regardless of older caption/metadata preferences; information stays in the panel.

## 8. Dates

User-facing dates go through `shared/displayDate.ts` (`displayDate`, `displayDateRange`):

- a full date in the viewer's current local calendar year shows `M.D`; any other year shows `YYYY.M.D` (relative to the viewer's clock, so the display changes at New Year, with no zero padding);
- year-only values show `YYYY`; month-only values always keep the year, `YYYY.M` (with no zero padding);
- timestamps use the viewer-local date; calendar strings keep their own precision;
- ranges join both ends with `–`, each formatted independently; equal ends collapse to one value;
- invalid input passes through unchanged.

This covers Collection cards/info/details, TV seasons/episodes and Asset date headings. Same-day releases use `오늘` as defined in `DESIGN.md` §12. Stored values, grouping/sorting, information-panel times (`HH:mm`), Revisit date headings and machine-facing values (paths, IDs, diagnostic timestamps) are unchanged.

## 9. Floating surfaces and icon hints

- Menus, context menus, anchored panels and search surfaces use the §12 square radius-0 surface with NieR corner brackets, thin borders and only `--shadow-floating`; dialogs (`--shadow-dialog`) are reserved for modal confirmation or genuinely blocking flows.
- No tooltips on hover or keyboard focus, including shared tooltip overlays and native `title` bubbles (user, 2026-09-12; supersedes the tooltip allowance in ADR-0034, whose other decisions still apply).
- 자동 태그 chip details open in a small popover on click or keyboard activation; they never appear on hover, and the same text may remain in `aria-description`.
- Keep `aria-label` and keyboard-accessible naming; supplementary text may use `aria-description`. Keep real headings and dialog titles.
- Focus, selected, disabled, open, destructive and hover states must remain distinguishable without color alone.
- **Tablet bottom overlay (user, 2026-10-01):** Collections shortcuts open a surface rising from the bottom, leaving about 36px at the top of the screen visible and dimmed. Swipe down, tap outside, ✕ or Back closes it; the underlying list keeps its position. A work opened from the overlay stacks above it and returns to it on Back. The former fold rows above the list are removed.

## 10. Collection / Works presentation

`works-viewer-design.md` owns the type-specific browsing/detail grammar and renderer budgets; `lakomics-works-handoff-v2.md` owns Works product behavior (ownership counts, release notifications, providers).

### Game

A game is a **closed, seam-side case**, inspired by a closed steelbook/package but not claiming a real edition.

- Front artwork dominates; the seam/opening edge and restrained top/bottom shell geometry make it read as closed.
- No invented platform stripe, console logo, illustrated spine or fake back cover.
- Loading/fallback keeps the case silhouette rather than flashing a flat poster.
- Physical depth stays subtle enough for dense browsing. Thin edges must hold at non-integer DPR (the original jagged-edge defect was at DPR 1.125); do not claim universal anti-aliasing success without runtime evidence.

### Manga

Manga uses the approved **Paperback FINAL** model: separate thin covers, a recessed page block and satin print. The Collections 선반 work case has a matte paper spine printed with the work title (user, 2026-10-01); the earlier unprinted spine/back treatment is not its list contract. The supplied final artifact is the visual baseline (depth `.12`, right binding, live pose `.13/.34/.005`, static paper-side angle `.40`); these are local appreciation-renderer parameters, not the shelf case depth rule decided below or a claim about a real edition. A shelf is a contact cue, not furniture.

- **Manga layouts (user, 2026-10-01, PC and tablet):** 보기 has 격자 (grid), 선반 (one paperback book case per work, like game/film shelf cases, with the title printed on a matte paper spine), and 책장 (per-work volume-spine rows, layout value `bookcase`). Default: 선반. The volume-spine rows belong to 책장, not 선반.
- **Shelf case proportion (user, 2026-10-01):** depth follows the face height at about 8%, rather than a fixed 22px. Keep spine marks (including PS5/Switch heads) and spine text in real package proportions as cases shrink on the tablet.
- Library and volume lists show cached static renders; only the appreciation view has one live book with on-demand cursor tilt. Its footer owns same-edition thumbnails, position and original-image mode and never overlays the large cover.
- While a render is pending the cover shows a neutral placeholder in the final shape and fades in, never the flat source; the flat image is only the failure fallback.
- Showcase keeps manual membership/order per media type. Cover-only pages use 3×3 for up to 9 works, 4×4 from 10, and pagination beyond 16, packed around the objects rather than spread across the viewport.

### Film/video

Normal film/video library tiles are flat posters. Physical-media cases are a separate future mode, not a default cross-type effect.

### Detail hero

For details with a backdrop: use the chosen original backdrop as the wide background, overlap the foreground cover/package, fade only the background layer broadly into the body, and never blur/darken the whole artwork to manufacture contrast. Preserve user/provider artwork roles. Without a background, ordinary game/film detail collapses to compact cover + title/info. The accepted manga/AV work stage is an explicit exception (2026-10-02): a faint blurred current-volume cover or AV jacket sits behind the crisp object. A back chevron left of the detail title exits the detail (Escape/back behave the same).

### Work-stage interaction (2026-10-02)

Wheel on PC and pinch on tablet zoom the object from 0.6× to 2.5×; retain drag-to-turn and reset through 정면으로. Tablet one-finger vertical drag scrolls the page without fling. Empty stage clicks close an open case. Native/device feel remains an acceptance item, not something this design contract proves.

## 11. Status, progress, and empty space

- Do not fill the bottom bar with asset counts or generic “drag files here” text just because space exists.
- Show real ingestion/progress/error state when it matters (status center).
- Empty state: use a faint 32px icon and one line; add a button only when there is a real next step.
- Avoid repeating area names, subtitles and counts already evident from the rail/index/content.

### Home, memo and ledger

The accepted 2026-10-02 contracts live in [DESIGN.md §3 and §12](../../DESIGN.md): attention-first Home with 1년 전 오늘 below 오늘 할 것; 메모 글 / 할 일 with one editing surface, section operations and no Markdown rendering; and the budget/subscriptions/wishlist/manual-spending ledger. Use the shared `notes/memo/` editor and `notes/ledger/` presentation rather than reviving the removed checklist editor or a separate Markdown read view. Tablet differences are its quick-add field, long press and sheets.

## 12. Responsive and desktop constraints

Lakomics supports Windows and Linux; windows may be narrow or use non-integer DPR.

- Check practical narrow sizes such as ~800×640 besides the normal desktop viewport.
- Avoid horizontal overflow from title/window controls; clamp floating panels and allow internal scroll.
- Do not hide the whole navigation model as the first response to a narrow window.
- Account for DPR 1.125/1.25 in thin lines and collectible rendering.
- Preserve keyboard tree navigation, resize semantics, drag/drop targets and native window controls.

## 13. Implementation ownership

Keep state with the feature that owns it; the shell relocates controls and presentation.

| Responsibility | Current entry points (`_tools/app/src/`) |
| --- | --- |
| Shell / area rail / contextual index | `layout/WorkspaceChrome.tsx`, `WorkspaceNavigation.tsx`, `MorePanel.tsx`, `navigationEntries.tsx`, `ViewToolbar.tsx`, `WindowControls.tsx` |
| Status center | `layout/StatusCenter.tsx` |
| Search | `layout/CommandPalette.tsx`, `ChromeSearch.tsx`, `SearchSurface.tsx` (Online Catalog), owning browser query state |
| Anchored settings / floating UI | `shared/ui/AnchoredPanel.tsx`, `Menu.tsx`, `ContextMenu.tsx` |
| Shared list scrubber | `shared/ui/scrubber/` (tablet wrappers import the same implementation) |
| Memo / ledger | `notes/memo/`, `notes/ledger/` |
| Date display | `shared/displayDate.ts` |
| Classification / Albums | `classification/ClassificationSidebar.tsx` |
| Asset controls / gallery / selection | `assets/AssetToolbar.tsx`, `AssetBrowser.tsx`, `AssetGallery.tsx`, `GalleryDisplaySettings.tsx`, `SelectionBar.tsx` |
| Collection browser / details | `collections/CollectionBrowser.tsx`, `CollectionCard.tsx`, `physical/`, type detail components |
| Manga local / online catalog | `manga/MangaBrowser.tsx`, `OnlineCatalogBrowser.tsx` |
| Tokens and layout CSS | `styles/tokens.css`, `global.css`, `chrome.css`, `styles/controls.css` |

Do not paste comparison HTML into React, duplicate feature state in the shell, or create a second settings/search persistence model.

## 14. Review checklist

Before accepting a PC UI change, ask:

- Does media still dominate the first glance?
- Did the change add a second route to an existing command without a real UX reason?
- Does selection remain distinct from focus, and is only the most specific level a slab?
- Do menus preserve geometry/scroll, and does the docked information panel preserve scroll/selection while the grid moves aside?
- Does the screen still work with long Korean/Japanese names and narrow windows?
- Did a flat Asset or poster accidentally inherit collectible shadow/3D?
- Are colors token names from `tokens.css` rather than new literals?
- Did a prototype number, fake label, or provider-specific assumption become product logic?
- Are domain boundaries from `CONTEXT.md` still intact?

If a change cannot answer these cleanly, fix hierarchy/state clarity before adding decoration.
