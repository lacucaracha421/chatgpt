# Lakomics Works viewer / presentation direction

> Status: current media-specific presentation reference.
> Global PC shell, controls, Asset layout, surfaces, and selection rules live in `docs/agents/pc-design-reference.md` and `DESIGN.md`.
> This document defines how game, manga, video, and Showcase differ **inside** that shared system. It is not a backlog.

## 1. Shared rule

Collections represent works the user cares about; they should not all look like the same generic poster card.

Visual priority:

1. artwork / cover / poster / hero
2. work identity and current context
3. personal state such as rating, memo, Showcase, linked local state
4. useful external metadata
5. provider/debug/maintenance controls

External APIs shape useful structure; they do not justify dumping every field into a property table.

Personal state outranks external score/provider state. Provider refresh must preserve explicit user edits and presentation choices.

Presentation intensity is **Library < Detail < Showcase**. Ordinary browsing stays dense; detail can add restrained collectibility; Showcase can breathe more without becoming a second renderer.

## 2. Manga — volume shelf

Manga is volume-centric. The pleasure is seeing covers together, understanding sequence/release state, and opening a cover for appreciation.

- Use cover-first rows/shelves with a subtle shared support/contact cue.
- Front cover remains roughly 90–95% of the perceived object.
- Approved Paperback FINAL supplies the closed paper-cover/page-block model. Thin physical depth is intentional; heavy wood, room furniture and spine-only browsing are not.
- Library/volume rows show cached static renders of that model. Only the current appreciation book is live 3D; no per-tile WebGL contexts.
- Preserve source aspect ratio rather than cropping every volume into one cabinet shape.

### Manga detail

The volume shelf is the primary content, not a generic metadata hero.

- volume number/order is stable and first-class;
- routine release state belongs below/around the cover rather than over artwork when possible;
- hide edition UI when only one edition exists;
- use meaningful edition names when available;
- clicking a volume primarily opens cover appreciation with previous/next volume navigation;
- the large cover and the same-edition thumbnail strip occupy separate layout rows; preserve the cover aspect and leave the strip unobscured;
- retain the gentle cursor tilt, respect reduced motion, and offer an original-image fallback/view;
- the selected volume lifts slightly; compact work information stays secondary to the shelf; large lists use row virtualization without losing order, keyboard focus or scroll restoration;
- ISBN, publisher, provider identity and other deep edition data stay secondary.

MangaDex may supply work identity/general metadata and cover candidates. Korean release providers such as Kakao book search supply local commercial-edition/release information. The shelf design must survive provider replacement.

## 3. Game — closed package exhibit

Games are work-centric. The core composition is **hero/main artwork + closed collectible package + concise identity + artwork/screenshots**.

### Browser

- Use the seam-side closed neutral case defined in `pc-design-reference.md`.
- The front cover remains immediately recognizable at normal grid size.
- No platform branding, fake spine title, fake illustrated back, giant tilt, or continuous pointer tracking.
- Loading/fallback preserves the same case object silhouette instead of flashing a flat poster.

### Detail

- Hero/backdrop establishes atmosphere and remains visually important.
- Foreground package overlaps the hero and stays crisp above the broad lower fade.
- Compose title, release/genres/platforms and primary developer/publisher into concise identity lines.
- Personal rating should be easier to find than external score/provider diagnostics.
- Artwork/screenshots adapt to 1, 2, 3, or many items without leaving a dead lower half.
- Management/provider actions move toward quiet contextual/overflow surfaces.

Useful future IGDB enrichment is structural rather than exhaustive: release chronology, franchise/related works, additional artwork, or other relations that improve the screen. Do not add fields merely because the API exposes them.

## 4. Video — poster archive

Normal video browsing is a flat poster archive. Do not inherit game-case or manga-book treatment for visual consistency.

Current implementation is movie/film-oriented; future product direction includes both Film and Series without forcing an immediate persistence rename.

- Film: one work with poster/backdrop, runtime, release history, cast/staff and related works.
- Series: seasons and episodes, season posters, compact episode list and aggregate staff/cast.
- Animation/live-action is an attribute or presentation nuance, not the main structural split.
- Anime films use Film structure; TV anime uses Series structure.

### Shared video identity

- selected original backdrop/hero behind;
- poster in front;
- localized/original title as needed;
- year/range, format/status, genres and personal rating;
- broad lower fade on the backdrop layer only.

If no backdrop exists, collapse the hero rather than fabricating a blurred poster background.

### Film

Prefer the sequence: identity → overview → key cast/staff → artwork → release history → related works → personal state/linked Lakomics data.

### Series

Prefer the sequence: identity → season poster grid → selected season + compact episode list → key cast/staff → artwork → related works → personal state.

Episode stills may exist as a richer optional view; they should not force every series detail into a giant streaming-service grid.

TMDB expansion should add only data needed by an approved presentation: TV search/detail, season/episode identity, season imagery, useful credits/relations, and release history. Provider state remains secondary to the user's library state.

## 5. Showcase

Showcase is a manually curated exhibition, not an automatic favorites filter or ranking page.

- membership and order remain user-controlled;
- game, manga and film are separate exhibition scopes; type-aware presentation remains intact;
- selected works, not synthetic ranking or recommendations, fill a cover-only wall: up to 9 uses 3×3, 10–16 uses 4×4, more than 16 continues on pages;
- pack the wall by the available book/poster height rather than distributing narrow objects across the whole window; titles may appear on hover/focus;
- use the same primitives as normal Library/Detail with slightly more space and appreciation;
- stronger book/package lift or larger artwork is allowed, but no simulated room, cabinet renderer, or continuous animation;
- clicking a Showcase item opens the normal Collection detail model.

## 6. Related works and provider structure

Relationship data is most valuable when it reconnects to the user's own library.

Prefer compact rails/groups for:

- prequel / sequel;
- same franchise / series;
- adaptation / source relation;
- same creator/studio/developer where genuinely useful.

Show local Lakomics Collections first when a provider relation can be resolved locally; external-only relations are clearly secondary. Do not build a graph visualization just because the data forms a graph.

## 7. Information density

Use three layers:

- **Always visible**: 5–8 identity facts at most.
- **Structural**: shelves, seasons, artwork strips, release timelines, related-work rails.
- **Deep/on demand**: full credits, ISBNs, provider IDs/snapshots, every release/platform row.

The second layer is the preferred destination for richer provider data.

## 8. Shared presentation primitives

Reusable concepts may include:

- type-aware `WorkTile`;
- lightweight physical cover/package primitive;
- responsive artwork strip;
- compact metadata line;
- related works rail;
- `collectionType -> presentation preset` mapping.

Names and exact component boundaries are implementation choices, not a requirement to create abstraction before a second real use case exists.

Ordinary grids remain static image surfaces. The approved Paperback FINAL allows one shared, on-demand WebGL2 renderer to bake nearby book thumbnails and display one live appreciation book. It does not authorize a WebGL canvas per tile, continuous animation, or unbounded full-resolution decoding.

Current implementation is in `app/src/collections/physical/`: a common 7,888-triangle model, serialized/cancellable snapshot queue, reference-counted bounded raster cache, and one live-book owner. Static images have an estimated decoded budget of 24 MiB / 64 entries; GPU cover textures have an estimated 12 MiB / 4-entry budget. These are managed-resource estimates, not total browser RAM/VRAM measurements. Live input is capped at 30fps, DPR 1.5 and 1.4 million pixels; idle drawing stops. The cache is memory-only and recreated after restart.

Game optimization reuses the existing `drawGameCase.ts` projection unchanged, snapshots through a shared 2D surface, and releases offscreen tile subscriptions. It is not a game-case redesign. Movie detail remains unchanged.

## 9. Non-goals

Do not turn Works into:

- a game launcher with install/play/achievement chrome;
- a streaming-service clone;
- a realistic bookshelf/room scene;
- a provider database viewer;
- one universal detail template forced across incompatible media;
- a reason to merge Asset, Collection, WorkArtwork, Volume, Edition, or ExternalBinding ownership.

## 10. Backlog boundary

This file describes stable intent only. Outstanding implementation work belongs in `docs/roadmap/lakomics-backlog.md`, especially LONG-002A, WORKS-001, LONG-002B, and LONG-004.

The retired `docs/roadmap/works-collection-visual-redesign-plan.md` is historical planning context and must not compete with the living backlog or this reference.
