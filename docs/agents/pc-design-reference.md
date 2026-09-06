# Lakomics PC design reference

> Status: current PC visual/interaction reference.
> Baseline: Lab 06 content direction + Chrome 03b B left-centric shell + subsequent UX corrections, integrated into the real app by commit `2d7bac2`.
> `DESIGN.md` is the short constitution; this file holds implementation-level design contracts. Product/domain rules still come from `CONTEXT.md`, Accepted ADRs, and current code.

## 1. What this document replaces

This reference consolidates the former `approved-design-direction.md` and `approved-chrome-direction.md` decision logs. Those files now serve only as superseded pointers/historical breadcrumbs.

It also supersedes visual assumptions that depended on:

- a permanent horizontal toolbar;
- a fixed old sidebar/topbar placement;
- justified rows as the only normal Asset layout;
- a universal ban on contextual icon tooltips;
- completely flat game/manga collection objects.

Do not restart the 1–6 reference comparison or Chrome A/B/C vote unless the user explicitly asks to reopen the design direction.

## 2. Product character

Typography approved after user trial on 2026-09-06: SUIT for Korean UI, Barlow for Latin UI and creator names, and Rajdhani Medium for date headings, caption times and sidebar counts. Preserve Barlow digits within creator names and the existing Japanese fallback. Numeric roles use tabular figures; caption times use the small-text size rather than extra-small. Bundle font files and OFL notices locally for offline use. Implementation: `app/src/styles/fonts.css` and the `--font-ui` / `--font-numeric` tokens.

Lakomics is a **media-first personal archive**, not a dashboard, launcher, streaming service, or room simulator.

The screen should feel:

- calm enough for long sessions;
- dense enough to browse thousands of assets;
- personal because collected artwork dominates the color field;
- deliberate rather than generic because navigation, selection, physicality, and empty states follow consistent rules.

The visual system is dark-neutral, square/rectilinear, low-radius, line-icon heavy, and border-led rather than card-led.

## 3. Chrome 03b shell

```text
┌──────┬──────────────────────┬──────────────────────────────────┐
│ area │ contextual index     │ thin title/window region         │
│ rail │                      ├──────────────────────────────────┤
│      │ current-area nav     │ current location / transient     │
│      │ folders / albums     │ state, then media content        │
│      │ types / source       │                                  │
│      │                      │                                  │
│      ├──────────────────────┤                                  │
│      │ contextual controls  │                                  │
└──────┴──────────────────────┴──────────────────────────────────┘
```

### Area rail

- Primary areas are Assets, Collections, and Manga. Trash and management live quietly at the bottom.
- The rail is narrow and visually weaker than the contextual index.
- Selection uses the ivory single-selection language; unrelated icons remain neutral.
- Switching areas preserves the owning screen state where the current code supports it rather than resetting state for visual neatness.

### Contextual index

- **Assets**: broad scopes, Classification tree, Album tree, current folder counts and user appearance.
- **Collections**: Library/Showcase and game/manga/movie type navigation, plus controls that genuinely belong to the collection browser.
- **Manga**: local/online/catalog context and controls owned by the corresponding browser.
- Do not merge a user Classification named “만화”, Collection type `manga`, local Manga Root, and Online Catalog into one product concept.

### Main content header

- Keep the native window controls in one thin, stable place.
- Show current location and only meaningful transient state; do not repeat brand subtitles, “내 라이브러리”, or explanatory prose on every screen.
- Do not recreate the old full toolbar above the content merely because individual controls used to live there.
- Selection-only commands remain in selection/context surfaces, not inserted into the persistent header.

## 4. View settings

The floating View Settings pattern is primarily the Asset browser contract. Other areas may place their smaller context controls directly in the index when that is clearer.

For Assets:

- default closed;
- trigger stays at the lower end of the contextual index;
- panel opens to the **right of the index**, above the content;
- it is non-modal and internally scrollable when viewport height is limited;
- opening/closing alone must not resize/reflow the gallery, reset scroll, collapse trees, clear selection, or refetch data;
- actual setting changes apply immediately and remain owned by the existing state/preference layer;
- closing is never “cancel settings”.

Current Asset settings include the supported subset of sort, media/aspect filters, layout, preview size, metadata visibility, privacy mode, and direct/current-classification-only state. Keep view-conditional availability truthful.

Do not show a dead View Settings trigger on a screen whose controls have intentionally moved into the index.

### Panel dismissal and focus

- Same trigger, explicit close, or outside interaction closes the panel.
- `Esc` closes the innermost open menu/popover first, then the settings panel. One key press must not cascade into clearing an Asset selection or closing a viewer behind it.
- Nested portal menus/selects count as panel-owned interaction; opening one must not dismiss the parent panel.
- Closing returns focus to a sensible opener when possible.
- Narrow windows clamp panel position and size rather than hiding Classification or shrinking the gallery just to make room.

## 5. Search

Search is deliberately **icon-first**, because it is not the dominant daily action.

- Collections, local Manga, and Online Catalog use a magnifier entry in the contextual index.
- Opening search shows an input surface with the actual search scope.
- Closing the input draft is different from clearing an already-applied query.
- Applied search must remain visible as state and provide a direct clear action.
- Reopening lets the user edit the current query.
- Online Catalog retains its existing suggestions/autocomplete and language/scope semantics; only the entry surface changes.
- Assets currently have no general text-search query contract. Do not fake one or silently add a new index/search engine to satisfy symmetry.
- `Ctrl+F` may open the supported current-area search when it does not conflict with text input/viewer behavior.

## 6. Asset browser

### Layout

Default PC Asset layout is **date-grouped masonry/waterfall**. Justified rows remain an explicit alternative view, not a rejected feature.

- Preserve intrinsic aspect ratio.
- Group by `collectedAt` local date using the same timestamp/timezone as sort and caption time.
- The date heading carries the date; each asset caption uses artist/creator on the left and `HH:mm` on the right.
- Approved on 2026-09-06 after user trial: sparse date groups share a horizontal row, each using only the columns its assets need. Keep each date heading and rule within its group's width. Wrap whole groups when remaining columns are insufficient, placing the next row below the tallest preceding group. Larger groups retain full-width masonry; narrow viewports naturally stack groups. Preserve chronological order, intrinsic image ratios, and artist/time captions.
- Do not repeat the date per image.
- Missing creator/time data stays honest; do not synthesize current values.

### Asset selection

Asset selection is intentionally quieter than navigation selection.

- Keep the small top-left square marker.
- Apply a neutral gray wash to the image area only.
- Do not add a strong outer selection outline around the whole tile.
- Do not recolor or reflow the artist/time caption merely because the asset is selected.
- Keyboard focus remains independently visible.
- Multi-selection actions use the existing selection bar/context flow; do not shift the rail/index/header when selection count changes.

### Metadata visibility

Metadata is normally visible by default. The control should describe the action/state truthfully; do not invert the stored `metadataVisible` meaning when changing wording.

The current UX may phrase the toggle as “정보 숨기기” when metadata is visible. Preserve stored preference compatibility.

## 7. Selection colors and control states

### Primary/current single selection

Use the approved pale ivory surface (`#DDD8CA` reference) plus a small inner square marker for current navigation or other single-state controls where a strong current-location signal is useful.

Do not spread ivory across every active control.

### Multi-select filters

Use neutral gray, marker-free selection treatment. Current dark reference roles are approximately:

- selected surface `#383838`;
- selected text `#E7E7E7`;
- selected border `#808080`;
- hover surface `#444444`;
- hover border `#A0A0A0`.

Treat these as semantic token inputs rather than repeated raw colors. Multi-select filters stay gray even when only one value happens to be active.

## 8. Floating surfaces and icon hints

- Menus, context menus, anchored panels, and search surfaces use thin borders, small radii, shallow contrast, and only the shadow needed to read as floating.
- Dialogs are reserved for modal confirmation or genuinely blocking flows.
- Explicit icon-only PC shell controls may use short non-interactive tooltips when the icon is ambiguous.
- Tooltips supplement, never replace, `aria-label` and keyboard-accessible naming.
- Do not attach a tooltip to every labeled button or every decorative icon.
- Focus, selected, disabled, open, destructive, and hover states must remain distinguishable without color alone.

The old “no icon tooltips anywhere” rule is superseded for the PC shell by ADR-0034.

## 9. Collection / Works presentation

### Game browser object

A game is represented by a **closed, seam-side case**, inspired by a closed steelbook/package but not claiming a real edition.

- front artwork remains dominant;
- seam/opening edge and restrained top/bottom shell geometry make the object read as closed;
- no invented platform stripe, console logo, illustrated spine, or fake back cover;
- loading/fallback should preserve the same case silhouette rather than flashing a flat poster first;
- physical depth stays subtle enough for dense browsing.

The case renderer may use unified 2D projection/high-DPR sampling to avoid jagged top edges. The approved reference found the defect at 154×231 CSS px and DPR 1.125; improvement was visually confirmed at DPR 1.25. Do not claim universal anti-aliasing success without real runtime evidence.

### Manga

Manga uses thin book physicality and volume-centered shelf grammar. A shelf is a baseline/contact cue, not wood furniture or a rendered room.

### Film/video

Normal film/video library tiles are flat posters. Physical-media cases are a separate intentional future mode, not a default cross-type effect.

### Detail hero

For game/film-style details with a backdrop:

- use the chosen original backdrop/hero as the wide background;
- overlap the foreground cover/package over it;
- use a broad lower fade only on the background layer to transition into body content;
- do not blur/darken the whole artwork merely to manufacture contrast;
- preserve user/provider artwork roles instead of deriving every role from one image.

When no background exists, collapse the empty hero space and use a compact cover + title/info arrangement. Do not fabricate a large blurred cover background.

`docs/agents/works-viewer-design.md` owns the deeper type-specific browsing/detail grammar and future Video Works direction.

## 10. Status, progress, and empty space

- Do not permanently fill the bottom bar with asset count or generic “drag files here” instructions just because space exists.
- Show real ingestion/progress/error state when it matters.
- Empty states explain the next useful action concisely; they are not marketing pages.
- Avoid repeated area names, subtitles, and counts when the same context is already evident from the rail/index/content.

## 11. Responsive and desktop constraints

Lakomics is Windows-first, but the window may be narrow or use non-integer DPR.

- test practical narrow sizes such as ~800×640 in addition to the normal desktop viewport;
- avoid horizontal overflow from title/window controls;
- clamp floating panels to the viewport and allow internal scroll;
- do not hide the entire navigation model as the first response to a narrow window;
- account for DPR 1.125/1.25 in thin lines and collectible rendering;
- preserve keyboard tree navigation, resize semantics, drag/drop targets, and native window controls.

## 12. Implementation ownership

Keep state with the feature that owns it; the shell should mostly relocate controls and presentation.

| Responsibility | Current entry points |
| --- | --- |
| Shell / area rail / contextual index | `app/src/layout/WorkspaceChrome.tsx`, `WorkspaceNavigation.tsx`, `ViewToolbar.tsx`, `WindowControls.tsx` |
| Search surfaces | `app/src/layout/ChromeSearch.tsx`, `SearchSurface.tsx`, owning browser query state |
| Anchored settings / floating UI | `app/src/shared/ui/AnchoredPanel.tsx`, `Menu.tsx`, `ContextMenu.tsx`, `TooltipLayer.tsx` |
| Classification / Albums | `app/src/classification/ClassificationSidebar.tsx` |
| Asset controls / gallery / selection | `app/src/assets/AssetToolbar.tsx`, `AssetBrowser.tsx`, `AssetGallery.tsx`, `SelectionBar.tsx` |
| Collection browser / details | `app/src/collections/CollectionBrowser.tsx`, `CollectionCard.tsx`, type detail components |
| Manga local / online catalog | `app/src/manga/MangaBrowser.tsx`, `OnlineCatalogBrowser.tsx` |
| Tokens and layout CSS | `app/src/styles/tokens.css`, `global.css`, `chrome.css` |

Do not paste comparison HTML into React, duplicate feature state in the shell, or create a second settings/search persistence model.

## 13. Current implementation checkpoint

Commit `2d7bac2` introduced the actual desktop archive UI/navigation chrome. Subsequent same-day UX corrections refined duplicated labels, shell hints, selection treatment, catalog controls, icon geometry, and search placement.

Evidence recorded during the redesign included:

- TypeScript success and focused React/Vitest coverage for shell, App, Asset toolbar, file ingestion, Manga/Online Catalog and shared menu behavior;
- isolated Edge/Chromium fixture rendering at normal and narrow desktop sizes;
- View Settings panel staying inside the viewport and preserving gallery width during open/close;
- real Collection fixture search reducing visible results while the input surface closed.

This is not native production-library acceptance. Browser fixtures do not prove Tauri file dialog, OS window, real media protocol, active-library performance, or every DPR/GPU path.

## 14. Review checklist

Before accepting a PC UI change, ask:

- Does media still dominate the first glance?
- Did the change add a second route to an existing command without a real UX reason?
- Does selection remain distinct from focus?
- Does opening a temporary surface leave content layout and scroll stable?
- Does the screen still work with long Korean/Japanese names and narrow windows?
- Did a flat Asset or poster accidentally inherit collectible shadow/3D?
- Did a prototype number, fake label, or provider-specific assumption become product logic?
- Are domain boundaries from `CONTEXT.md` still intact?

If a change cannot answer these cleanly, fix hierarchy/state clarity before adding decoration.
