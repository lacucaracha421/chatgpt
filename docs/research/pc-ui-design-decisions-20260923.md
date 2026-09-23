# PC UI design decisions pending — 2026-09-23

Status: open decisions, not approved design. Execution is tracked in `PC-UI-001` in [the backlog](../roadmap/lakomics-backlog.md); this document holds the choices that need the user before implementation. Once decided, record the rule in `DESIGN.md` or `docs/agents/pc-design-reference.md` and update this file.

Source: a review of the design documents against real-app screenshots on the Linux host (1920×1080, app zoom 110%) covering the Asset gallery, character series view, Film/TV Collection library and detail, Manga online catalog, Revisit, Memo, Settings and the viewer. Screenshots were deleted after review; findings below are observations, not measurements.

## A. Consistency decisions (PC-UI-001 items)

Each lists options and a recommendation. Recommendations are proposals only.

### A1. Two close buttons in work detail (PC-UI-001 #7)

The detail-close `X` sits directly beside the window-close `X` in the title bar.

- **Option 1 (recommended):** replace the detail-close `X` with a back/chevron control at the left of the detail title, matching in-tab back navigation.
- Option 2: keep `X` but separate it with a visible divider and more spacing.
- Option 3: rely on `Esc` and mouse back only; remove the detail-close button.

### A2. Two ivory selections in the Collection index (PC-UI-001 #8)

`라이브러리/쇼케이스` and `작품 유형` both use the full ivory selection block at once.

Resolved by the B1 direction (2026-09-23): the most specific level keeps the slab, the parent level uses the tint.

- **Option 1 (recommended):** keep ivory for the primary level only; the second level uses the neutral selected surface with an ivory marker or text accent.
- Option 2: keep both, but reduce ivory to a marker-only treatment everywhere (see B1).

### A3. Date format rule (PC-UI-001 #9)

Observed: `25.9.19`, `1997`, `09.7.3~24.7.6` (Film list), `2025-09-19` (detail), `2026.09.23` (gallery headings).

- **Option 1 (recommended):** `YYYY.MM.DD` everywhere for full dates, `YYYY` when only the year is known, `YYYY.MM.DD–YYYY.MM.DD` for ranges. Machine-facing values (paths, IDs, timestamps in diagnostics) keep ISO.
- Option 2: compact lists (`’25.9.19`), full format only in detail.

### A4. Missing creator captions (PC-UI-001 #11)

Most gallery captions read `작가 미상`.

- **Option 1 (recommended):** leave the creator slot empty and keep only the time; honest, and removes repeated noise.
- Option 2: keep the text but use a dimmer muted tone.
- Option 3: keep as is.

### A5. Smaller open items

- Character count in the series overview counts characters inside groups while cards show groups (`캐릭터 5` with 3 cards). Decide: count characters (label as characters) or count visible cards.
- Mixed-language TMDB genres (`Action & Adventure · 애니메이션`): request Korean genre names from the provider, map known English genres locally, or accept provider text.
- Title/location naming: index selection `전체` vs title `저장소`; the timestamp beside the Manga title needs a label or removal.
- Loading covers in the Manga catalog show an empty dark box: add a neutral loading placeholder consistent with the Collection case silhouettes.
- TV detail backdrop crops to its top edge: choose a default focal position (center or upper third) for wide backdrops.

## B. Visual direction proposals

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
