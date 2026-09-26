# Lakomics PC design reference

> Status: current PC visual/interaction reference.
> Baseline: Lab 06 content direction + Chrome 03b B left-centric shell, integrated by commit `2d7bac2`, then refined by PC-UI-001 and PC-DECLUTTER-001.
> `DESIGN.md` is the short constitution; this file holds implementation-level design contracts. Product terms come from `CONTEXT.md`; feature behavior lives in its subsystem reference (Works: `lakomics-works-handoff-v2.md` and `works-viewer-design.md`; characters: `docs/research/character-classification-quiet-workflow-design-20260911.md`). Verification history lives in `docs/roadmap/lakomics-completed.md`.
> Colors are named by their `_tools/app/src/styles/tokens.css` custom properties; read values there rather than copying hex literals.

## 1. Scope and superseded records

This reference replaces the former `approved-design-direction.md` and `approved-chrome-direction.md` decision logs (now pointers only) and the visual assumptions of a permanent horizontal toolbar, a fixed old sidebar/topbar, justified rows as the only Asset layout, and flat game/manga collection objects.

Do not restart the 1–6 reference comparison or the Chrome A/B/C vote unless the user explicitly reopens the design direction.

## 2. Product character

Lakomics is a **media-first personal archive**, not a dashboard, launcher, streaming service, or room simulator. The screen should feel calm enough for long sessions, dense enough to browse thousands of assets, personal because collected artwork dominates the color field, and deliberate because navigation, selection, physicality, and empty states follow consistent rules.

The visual system is dark-neutral, square/rectilinear, low-radius, line-icon heavy, and border-led rather than card-led.

Typography (user-approved 2026-09-06): SUIT for Korean UI, Barlow for Latin UI and creator names, Rajdhani Medium for date headings, caption times and sidebar counts. Keep Barlow digits inside creator names and the Japanese fallback. Numeric roles use tabular figures; caption times use the small-text size. Fonts and OFL notices are bundled for offline use (`styles/fonts.css`, `--font-ui`, `--font-numeric`).

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

- Areas: 에셋, 컬렉션, 망가, 메모, 전송 (plus 비밀 when the private vault is available). The tail holds `찾기` (the command/search palette, `Ctrl+K` / `Ctrl+F`) and `더보기`, a panel listing pending queues (유사 검토, 미분류, 전송 when they have items) and destinations (다시보기, 통계, 휴지통, 설정). The `더보기` badge counts only pending similarity review; 전송 shows its own received-file count.
- Work, sync and error status live in the titlebar status center beside the window controls, not as rail buttons.
- The rail is narrow and visually weaker than the contextual index; its current area uses the parent-context tint (§7).
- Switching areas preserves the owning screen state where the code supports it rather than resetting for visual neatness.

### Contextual index

- **Assets**: broad scopes, Classification tree, Album tree, folder counts and user appearance.
- **Collections** (sidebar since 2026-09-26, replacing the earlier header tabs): the new-collection menu, then a vertical `작품 유형` list (게임/만화/영화/AV) followed by the `신간 N` and `발매 캘린더` rows, all as selected-slab links (§7); a row is current while its view is open. Below them, for the library grid only, `정렬 · 필터` holds 정렬 and 내 별점 (slider, 미평가, 초기화). There is no Library/Showcase mode: the Showcase is the collapsible `쇼케이스` row above `전체 N` in the content, and its `전체 보기` drills into the paged exhibition with a back button. The header holds only the title (plus back in the 신간, 발매 캘린더 and Showcase drill-downs). An open work replaces type navigation with its title, concise metadata, personal/external rating, management/provider menu and manga edition selector at the top of the index; long descriptions and artwork stay in the body. The detail owns state and callbacks through the shared chrome portal.
- **Manga**: local/online/catalog context and controls owned by the corresponding browser.
- Do not merge a user Classification named “만화”, Collection type `manga`, local Manga Root, and Online Catalog into one concept (`CONTEXT.md`).

### Main content header

- Keep the native window controls and status center in one thin, stable place.
- Show current location and only meaningful transient state; do not repeat brand subtitles, “내 라이브러리”, or explanatory prose on every screen.
- Do not recreate the old full toolbar above the content.
- Selection-only commands stay in selection/context surfaces. Exception (CHAR-UI-002~006, 2026-09-09): the series/character review screen may expose selection accessories (count, clear, exclude, review entry) as `titleAccessory`; this is not a license to spread selection commands to other headers.
- One-time setup and rare management actions live in the owning `… 더보기` menu or panel (e.g. `폴더 더보기`, `시리즈 더보기`, `캐릭터 더보기`), not as persistent header buttons. Frequent actions may keep a labeled button (e.g. `캐릭터 만들기`).
- Do not add persistent refresh buttons: background updates refresh the view automatically; error retry and a context-menu refresh remain for recovery.

## 4. View settings

The floating View Settings panel is primarily the Asset browser contract; other areas may place smaller controls directly in the index.

- Default closed; the trigger stays at the lower end of the contextual index; the panel opens to the **right of the index**, above the content.
- Non-modal and internally scrollable when height is limited.
- Opening/closing must not resize the gallery, reset scroll, collapse trees, clear selection, or refetch data.
- Setting changes apply immediately and stay owned by the existing state/preference layer; closing is never “cancel”.
- Asset settings cover the supported subset of sort, media/aspect filters, layout, preview size, metadata visibility, privacy mode, and direct/current-classification-only state. Keep view-conditional availability truthful. Screens without View Settings hide the trigger; do not show a dead one.

### Panel dismissal and focus

- Same trigger, explicit close, or outside interaction closes the panel.
- `Esc` closes the innermost menu/popover first, then the panel; one key press never cascades into clearing a selection or closing a viewer behind it.
- Nested portal menus/selects count as panel-owned interaction.
- Closing returns focus to a sensible opener.
- Narrow windows clamp panel position and size instead of hiding Classification or shrinking the gallery.

## 5. Search

Search is not the dominant daily action, so it has no persistent input.

- The rail `찾기` palette (`Ctrl+K`; `Ctrl+F` also works from a field) jumps to names (folders, albums, characters) and runs commands. On a view with a text-search contract it names that scope and applies the typed text to it.
- An applied query stays visible as a query badge in the view header with a direct `검색 해제` (the palette offers it too). Dismissing the palette never clears an applied query.
- Online Catalog keeps its own search surface with suggestions/autocomplete and language/scope semantics.
- Assets have no general text-search query contract. Do not fake one or add a new index/search engine for symmetry.

## 6. Asset browser

### Layout

Default PC Asset layout is **date-grouped masonry/waterfall**; justified rows remain an explicit alternative view.

- Preserve intrinsic aspect ratio.
- Group by `collectedAt` local date using the same timestamp/timezone as sort and caption time.
- The date heading carries the date (§8); each caption shows artist/creator on the left and `HH:mm` on the right. Do not repeat the date per image.
- Sparse date groups (user-approved 2026-09-06) share a horizontal row, each using only the columns it needs, with heading and rule within the group's width. Whole groups wrap when columns run out, placing the next row below the tallest preceding group; larger groups keep full-width masonry.
- Missing data stays honest: an unknown creator leaves the caption's left side empty while the time and its accessible description remain; never synthesize current values.

### Asset selection

Asset selection is intentionally quieter than navigation selection.

- Keep the small top-left square marker and apply `--asset-selection-tint` (teal, user-approved 2026-09-06) to the image area only.
- No strong outer outline around the tile; do not recolor or reflow the caption because the asset is selected.
- Keyboard focus stays independently visible.
- Multi-selection actions use the existing selection bar/context flow without shifting the rail, index or header.

## 7. Selection and control states

### Navigation selection (N4)

- **Slab — most specific current location.** Background `--color-sidebar-selection` / `--color-accent`, text `--color-on-accent`, radius 0, box shadow `--selection-echo` (`--selection-echo-surface` on the standalone Settings surface). Applies to classification rows, quick views, pins, index links (Collection types, 신간, 발매 캘린더, 더보기 lists), update-provider destinations and Settings sections. Slab hover stays ivory (`--color-accent-hover`).
- **Selected-row mark.** A selected index/list row is the ivory slab with its own small dark square (`--selection-mark-size`, `currentColor`) at the right end. Never add a separate small ivory square cursor to the left of or outside the row; it duplicates that mark (user, 2026-09-26). `--selection-cursor-offset` has no consumer; `--selection-cursor-size` survives only as the section-label mark size. Classification tree rows keep their folder icon and inner treatment.
- **Echo.** A hard 1px `--color-selection-echo` line offset 3px right/down; the double shadow masks the interior with the panel background so only the right/bottom outline shows. Blurred or decorative selection shadows remain banned.
- **Tint — parent context (N4 parent-tint rule).** When a parent level and a more specific child are both current, only the most specific keeps the slab; the parent uses `--color-selection-context` with `--color-selection-context-text`, hover `--color-selection-context-hover`, and no echo or mark. Current users: the area rail, Notes scopes and the ledger segments. Never show two slabs for different levels of the same hierarchy.
- **Cards.** A selected card (e.g. a Notes card) keeps its layout and uses a 1px `--color-accent` outline with the echo instead of a slab fill.
- **Index section labels.** `.workspace-section-label` and index `.chrome-settings-group > legend` show a small square (`--color-section-mark`) before the text and a 1px fading hairline (`--section-label-rule`) filling the width, keeping the existing font size/color.

Keyboard `:focus-visible` outlines (`--color-focus`) stay separate and visible on slab, tint and card selections.

### Multi-select filters

Neutral gray, marker-free: `--color-filter-selected` surface, `--color-filter-text`, `--color-filter-border`, hover `--color-filter-hover` / `--color-filter-hover-border`. Multi-select filters stay gray even when only one value is active; never use the ivory slab for them.

### Toggles and checkbox labels

- An unchecked box must be visible on dark surfaces: 1px `--color-border-strong` on `--color-bg`. Checked fills `--color-accent` with a `--color-on-accent` check; focus uses the `--color-focus` ring; disabled dims.
- A checkbox/toggle label names the setting (`자동 갱신`, `가벼운 모드`) or, when the row heading already names it, the current state (`켜짐` / `꺼짐`). Never use action wording (`켜기`) on a checkbox; the box already shows state.
- Action wording (`가벼운 모드 켜기` / `끄기`) belongs to one-shot commands in menus or the palette and must follow the current state.
- A label may read inverted when that is natural (`정보 숨기기` checked = metadata hidden), but the stored preference keeps its meaning (`metadataVisible`); metadata is visible by default.

## 8. Dates

User-facing dates go through `shared/displayDate.ts` (`displayDate`, `displayDateRange`):

- a full date in the viewer's current local calendar year shows `MM.DD`; any other year shows `YYYY.MM.DD` (relative to the viewer's clock, so the display changes at New Year);
- year-only values show `YYYY`; month-only values always keep the year, `YYYY.MM`;
- timestamps use the viewer-local date; calendar strings keep their own precision;
- ranges join both ends with `–`, each formatted independently; equal ends collapse to one value;
- invalid input passes through unchanged.

This covers Collection cards/info/details, TV seasons/episodes and Asset date headings. Stored values, grouping/sorting, caption times (`HH:mm`), Revisit date headings and machine-facing values (paths, IDs, diagnostic timestamps) are unchanged.

## 9. Floating surfaces and icon hints

- Menus, context menus, anchored panels and search surfaces use thin borders, small radii, shallow contrast and only `--shadow-floating`; dialogs (`--shadow-dialog`) are reserved for modal confirmation or genuinely blocking flows.
- No tooltips on hover or keyboard focus, including shared tooltip overlays and native `title` bubbles (user, 2026-09-12; supersedes the tooltip allowance in ADR-0034, whose other decisions still apply).
- Keep `aria-label` and keyboard-accessible naming; supplementary text may use `aria-description`. Keep real headings and dialog titles.
- Focus, selected, disabled, open, destructive and hover states must remain distinguishable without color alone.

## 10. Collection / Works presentation

`works-viewer-design.md` owns the type-specific browsing/detail grammar and renderer budgets; `lakomics-works-handoff-v2.md` owns Works product behavior (ownership counts, release notifications, providers).

### Game

A game is a **closed, seam-side case**, inspired by a closed steelbook/package but not claiming a real edition.

- Front artwork dominates; the seam/opening edge and restrained top/bottom shell geometry make it read as closed.
- No invented platform stripe, console logo, illustrated spine or fake back cover.
- Loading/fallback keeps the case silhouette rather than flashing a flat poster.
- Physical depth stays subtle enough for dense browsing. Thin edges must hold at non-integer DPR (the original jagged-edge defect was at DPR 1.125); do not claim universal anti-aliasing success without runtime evidence.

### Manga

Manga uses the approved **Paperback FINAL** model and volume-centered shelf grammar: separate thin covers, a recessed page block, satin print and unprinted spine/back. The supplied final artifact is the visual baseline (depth `.12`, right binding, live pose `.13/.34/.005`, static paper-side angle `.40`); these are local renderer parameters, not a claim about a real edition. A shelf is a contact cue, not furniture.

- Library and volume lists show cached static renders; only the appreciation view has one live book with on-demand cursor tilt. Its footer owns same-edition thumbnails, position and original-image mode and never overlays the large cover.
- While a render is pending the cover shows a neutral placeholder in the final shape and fades in, never the flat source; the flat image is only the failure fallback.
- Showcase keeps manual membership/order per media type. Cover-only pages use 3×3 for up to 9 works, 4×4 from 10, and pagination beyond 16, packed around the objects rather than spread across the viewport.

### Film/video

Normal film/video library tiles are flat posters. Physical-media cases are a separate future mode, not a default cross-type effect.

### Detail hero

For details with a backdrop: use the chosen original backdrop as the wide background, overlap the foreground cover/package, fade only the background layer broadly into the body, and never blur/darken the whole artwork to manufacture contrast. Preserve user/provider artwork roles. Without a background, collapse the hero into a compact cover + title/info arrangement; never fabricate a blurred cover background. A back chevron left of the detail title exits the detail (Escape/back behave the same).

## 11. Status, progress, and empty space

- Do not fill the bottom bar with asset counts or generic “drag files here” text just because space exists.
- Show real ingestion/progress/error state when it matters (status center).
- Empty states explain the next useful action concisely.
- Avoid repeating area names, subtitles and counts already evident from the rail/index/content.

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
| Date display | `shared/displayDate.ts` |
| Classification / Albums | `classification/ClassificationSidebar.tsx` |
| Asset controls / gallery / selection | `assets/AssetToolbar.tsx`, `AssetBrowser.tsx`, `AssetGallery.tsx`, `GalleryDisplaySettings.tsx`, `SelectionBar.tsx` |
| Collection browser / details | `collections/CollectionBrowser.tsx`, `CollectionCard.tsx`, `physical/`, type detail components |
| Manga local / online catalog | `manga/MangaBrowser.tsx`, `OnlineCatalogBrowser.tsx` |
| Tokens and layout CSS | `styles/tokens.css`, `global.css`, `chrome.css` |

Do not paste comparison HTML into React, duplicate feature state in the shell, or create a second settings/search persistence model.

## 14. Review checklist

Before accepting a PC UI change, ask:

- Does media still dominate the first glance?
- Did the change add a second route to an existing command without a real UX reason?
- Does selection remain distinct from focus, and is only the most specific level a slab?
- Does opening a temporary surface leave content layout and scroll stable?
- Does the screen still work with long Korean/Japanese names and narrow windows?
- Did a flat Asset or poster accidentally inherit collectible shadow/3D?
- Are colors token names from `tokens.css` rather than new literals?
- Did a prototype number, fake label, or provider-specific assumption become product logic?
- Are domain boundaries from `CONTEXT.md` still intact?

If a change cannot answer these cleanly, fix hierarchy/state clarity before adding decoration.
