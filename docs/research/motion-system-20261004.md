# Motion system — proposal, 2026-10-04

Status: proposal for the user's decision. Source: a read-only inventory of every abrupt appear/disappear site on desktop (`src/`) and tablet (`mobile-client/`), 2026-10-04. User direction: nothing should pop in from nothing; motion on every visit; quality "you can feel Apple's craftsmanship"; speed-critical places stay instant.

## 1. Principles

1. **Continuity.** Things come from where they live and return there: menus and popovers grow from their trigger, sheets from their edge, docks from their side, the viewer from its tile (already done), a folder's content from the folder you opened. Nothing appears from the middle of nowhere.
2. **Physics, not timelines.** Position and scale move on a spring (fast start, soft settle, no visible overshoot for UI chrome); opacity runs on a short ease-out and finishes before the movement settles, so content is readable early.
3. **Enter is longer than exit.** Exits take about 70 % of the entrance, use the same path backwards with less distance, and never block input: the element stops receiving pointer events the moment it starts leaving.
4. **Interruptible.** Every toggle can reverse mid-flight from its current state (transitions or WAAPI from computed values, never restarted keyframes). Rapid clicks never queue animations.
5. **Small distances.** Rises 4–8 px, scale .96–.98; only sheets, docks and full-screen layers travel their own size.
6. **Ready first, then move (no-flash).** Old content stays until new content is ready; the new content then eases in. Never fade a view out to a blank frame and back.
7. **One vocabulary.** Every duration and curve comes from tokens; no raw `ms` or `ease` in components.
8. **Reduced motion means calmer, not broken.** Movement is replaced by a 120 ms opacity change; nothing jumps.
9. **Stagger sparingly.** Only a first batch of tiles, at most 8 visible items, 20 ms apart.

## 2. Tokens (replace the current 90/120/140/160/180/200/220 ms mix)

| Token | Value | Use |
| --- | --- | --- |
| `--motion-micro` | 120 ms | hover reveals, badges, counts, selection-adjacent hints, opacity of small things |
| `--motion-small` | 180 ms | menus, context menus, popovers, tooltips, toasts, chips, banners |
| `--motion-medium` | 240 ms | dialogs, panels, docks, sidebar column, in-area view and segment swaps, tree expand |
| `--motion-large` | 340 ms | viewers, sheets, full-screen layers, the tab/area entrance |
| `--ease-out` | cubic-bezier(.2, 0, 0, 1) | opacity and colour |
| `--spring-snappy` | `linear()` spring, ≈ response .3 s, damping 1 | menus, popovers, toasts, chips |
| `--spring-gentle` | `linear()` spring, ≈ response .45 s, damping .9 | panels, sheets, views, viewers |

Exit = the same curve at ~0.7× duration. JS reads the same values from one module (`src/shared/motion/curves.ts`), which also owns the reduced-motion check; `useViewerMotion` and `mobile-client/motion.ts` import from it instead of redefining curves.

## 3. Shared primitives to build once

1. **Radix exit animations** for `Dialog`, `Menu`, `ContextMenu`, `AnchoredPanel`/popovers via `data-state=closed` (the pattern `mobile-client/FindSheet` already uses), plus a fading scrim both ways. Covers ~90 call sites at once.
2. **`Reveal`** — generalise `HomePresence` (height 0fr↔1fr + opacity) into one component for late blocks, banners, selection bars, fold/disclosure contents and "show more" rows.
3. **Toast** — enter from the bottom edge (8 px rise, `--spring-snappy`), exit with fade + 4 px drop; remaining toasts slide into place (FLIP).
4. **View swap** — move the tablet's level/segment motion (`useLevelMotion`, `useSegmentMotion`) into `src/shared/motion` and use it on desktop for folder→folder, view, segment and settings-section changes (forward/back direction aware), behind the same ready gate as `AreaSwitch`.
5. **List FLIP** — reuse `galleryMotion` for removals/inserts in small lists (notes, transfers, pins, toast stack); not for the virtualised gallery's paging.

## 4. Where it applies (from the inventory)

**Phase 1 — primitives, biggest effect:** dialog/menu/context menu/popover close + scrim (both clients); toasts (both); selection bar (both); command palette open/close (results stay instant); desktop sidebar index column (slide with the content swap); token cleanup (~55 raw literals, ~25 `ease`/`ease-out`).

**Phase 2 — desktop in-area navigation:** folder and view changes in 에셋 (direction-aware view swap), Collections type filter / showcase / calendar swaps, Manga local↔online, Settings sections, Notes board↔editor; folder/album tree expand/collapse; folder shelf arriving late (reserve, then `Reveal`); info docks (animate the grid column, not only the tiles); work backdrop crossfade; Home revisit images fade in on decode; series inline inspector; "new items" banner.

**Phase 3 — tablet:** full-screen layers (Settings, Trash, Exchange, Artists, Search, Calendar, Similarity, Vault) push in from the right and pop back; fold contents; Overlay close (and no re-rise when uncovered); swipe-review fly-off with the next card rising from behind; bottom-nav active state; low-res→full image crossfade in the viewer.

**Keep instant (speed or safety):** privacy masks; typing results (palette, search suggestions); scrubbing; next/previous in viewers and page turns; drag ghosts and drop targets; selection rings during multi-select; thumbnail-size slider.

## 4b. Release-build feedback (2026-10-04 evening)

- The user: direction is right, but the motion "creaks" (dropped frames). Measured in the preview at DPR 1.5 (`scratchpad/jank.mjs`: CDP `Performance.getMetrics` + rAF gaps over 0.8 s): tab switches with the sidebar change show 6–9 frames > 25 ms, worst 100–142 ms, 22–63 layouts and 250–320 ms of script during the entrance; folder change 2 long frames; menus 0. Causes: the index column animates `grid-template-columns`/width (layout every frame, the gallery re-lays out), and the entrance runs while the incoming view is still doing its mount work.
- Fix direction: compositor-only motion (transform/opacity; sidebar slides with transform and commits its width once), start the entrance after the incoming view's heavy work settles, promote animating layers (`will-change` only during the animation).
- Folder move: the user dropped the top-down wave; use the direction-aware variant from §3.4 (forward from the right, back from the left), still covering the old content so there is no dip.

## 4c. Decisions after the release builds (2026-10-04 night)

- PC tab (area) switch: the browser View Transitions API (`document.startViewTransition`, `view-transition-name` `index` + `main`, 150 ms cross-fade) after the readiness/image gate; the user liked it best. Fallback without the API: frozen outgoing view + 150 ms cross-fade.
- Tablet bottom-tab switch: instant (no motion), still gated on readiness.
- In-tab motion stays custom: directional folder move over a snapshot, series shelf swaps once, overlays/toasts/sheets per §3. Shared-element morphs (folder cover → title) are possible with View Transitions later; not adopted yet.

## 5. Acceptance

- One motion module and token set; components contain no raw durations/curves (extend the design-foundation CSS ratchet to durations and easings).
- Every surface in §4 phases 1–3 has an entrance and an exit; rapid toggling reverses smoothly (manual check + unit tests on the shared primitives with reduced motion on/off).
- Native check on Windows release (WebView2) and the tablet: no blank frames, no double animations, no input lag.
