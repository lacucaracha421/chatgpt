# PC UI design decisions pending — 2026-09-23

Status: open decisions, not approved design. Execution is tracked in `PC-UI-001` in [the backlog](../roadmap/lakomics-backlog.md); this document holds the choices that need the user before implementation. Once decided, record the rule in `DESIGN.md` or `docs/agents/pc-design-reference.md` and update this file.

Source: a review of the design documents against real-app screenshots on the Linux host (1920×1080, app zoom 110%) covering the Asset gallery, character series view, Film/TV Collection library and detail, Manga online catalog, Revisit, Memo, Settings and the viewer. Screenshots were deleted after review; findings below are observations, not measurements.

## A. Consistency decisions — decided 2026-09-23

The user decided these items on 2026-09-23; implementation follows in `PC-UI-001`.

- **A1 Work detail close:** replace the detail-close `X` beside the window controls with a back chevron at the left of the detail title (same behavior as closing the detail).
- **A2 Collection index selection:** resolved by B1 (most specific level keeps the slab, parent level uses the tint).
- **A3 Dates:** dates in the current calendar year omit the year (`MM.DD`); other years use `YYYY.MM.DD`; year-only values show `YYYY`; ranges join two values with `–`, each following the same rule. The rule is relative to the viewer's current year, so 2027 dates will drop the year during 2027. Machine-facing values (paths, IDs, diagnostic timestamps) are unchanged.
- **A4 Missing creator:** hide the `작가 미상` caption text; keep the time.
- **A5 decisions:**
  - Series overview count reads `그룹 N · 캐릭터 M` (M counts all characters, including those in groups).
  - Genres: TMDB is already requested in `ko-KR`, but its Korean translation lacks the eight TV-only genres (`Action & Adventure`, `Sci-Fi & Fantasy`, `War & Politics`, `Kids`, `News`, `Reality`, `Soap`, `Talk`). Map these to Korean at display time so stored works also change.
  - Asset index title: use `전체` instead of `저장소` when the whole library is selected.
  - The timestamp beside the Manga title is the catalog database update time: prefix it with a small database/refresh icon with an accessible label.
  - Manga catalog covers show a neutral loading placeholder while loading.
  - The TV detail "cropped backdrop" observation was a scrolled screenshot, not a defect; dropped.

## B. Visual direction proposals (B2–B5 deferred by the user on 2026-09-23)

From an overall aesthetic review: the foundation is sound (media-first gallery, consistent shell, strong Film detail hero, good SUIT/Barlow pairing), but polish and identity lag behind. These are larger proposals; each needs a user decision and ideally a side-by-side CSS study in the real app before adoption.

### B1. Selection treatment — implemented 2026-09-23, native visual acceptance pending

The full-width ivory slab was chosen deliberately for a NieR:Automata feel, but several slabs per screen compete with media. The user compared six variants in [the ivory selection study](../prototypes/ivory-selection/index.html) (current, D, N1–N4) and chose **N4 · D + NieR details**:

- Only the most specific current location keeps the full ivory slab; parent/context selections (area rail, `라이브러리`/`쇼케이스` level) use a ~16% ivory tint with ivory text.
- The slab gains NieR details: a 1px ivory "echo" outline offset 3px down-right, a small ivory square cursor just outside its left edge, and square corners.
- Section labels become `■ label ────` (small square + fading hairline).
- The neutral dark surfaces stay unchanged; the warm "paper" panels (N2/N3) were rejected because the user mainly uses dark mode.

Implemented N4 in the desktop selection rules and documented the NieR-motif exception in `DESIGN.md`. The rail, Collection mode, and Notes scopes use context tint; current-location rows retain the slab with echo and a cursor where the existing gutter and markers permit it. Update-provider inbox links remain slabs because they replace the type selection as the current destination. Native visual acceptance against real media screens remains pending.

### B2. One control family

Selects, the 10-cell rating filter, segmented buttons (`전체 / 미평가`), the bordered `미분류` button and settings checkboxes look like separate default HTML controls. Proposal: one small control set (select, segmented, toggle, rating) with shared height, radius, border and selected state.

### B3. One tile grammar across areas

The gallery is borderless and minimal, Film tiles carry three caption lines, and the Manga catalog uses bordered cards with a button footer. Proposal: converge Manga catalog and Collection tiles toward the gallery grammar — no card boxes, one or two caption lines, secondary actions on hover/selection or context menu.

### B4. Use of width

Fixed poster sizes leave large empty areas in the Film library, the detail layout leaves the right third empty, and the title bar is mostly empty. Proposal: responsive poster columns that fill the width, and a detail layout with a defined content measure and a secondary column (cast, seasons, related works — overlaps `WORKS-001`).

### B5. Accent palette

Ivory (`--color-accent`: navigation selection and checked toggles), teal (Asset selection tint) and blue (`--color-focus` ring) follow separate rules. Proposal: define one accent family and document the role of each color in `tokens.css`, keeping the user-approved Asset selection tint unless explicitly revisited.

## Documentation follow-up

Independently of these decisions: move feature/domain rules (character series moves, manga ownership counts, release notifications, statistics telemetry) and verification logs out of `docs/agents/pc-design-reference.md`, and reference token names instead of raw color values.
