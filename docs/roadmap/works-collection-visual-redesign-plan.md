# Lakomics Works / Collection visual redesign plan

> Status: current implementation plan for the next Works / Collection visual pass.
> Product/design intent lives in `docs/agents/works-viewer-design.md` and `docs/agents/lakomics-works-handoff-v2.md`.
> Concrete task status remains authoritative in `docs/roadmap/lakomics-backlog.md`, especially LONG-002 and LONG-004.
> This document should be retired or folded back into the stable design references after the redesign is implemented and verified.

## 1. Goal

Turn the current Collection area from a shared poster-card library into a type-aware Works experience where each medium has its own visual grammar while preserving Lakomics' dense desktop-tool character.

The target character is:

- **Manga** — a cover-first shelf / personal library centered on volumes.
- **Game** — a work-centered exhibit centered on hero art, package art, screenshots, and related metadata.
- **Video** — a poster-centered archive for film and series; series expand into seasons and episodes.
- **Showcase** — a more presentation-heavy layer built on the same primitives, not a separate design system.

The redesign must not turn Lakomics into a streaming service, game launcher, room-decoration UI, or generic SaaS gallery.

## 2. Current implementation baseline

The current PC UI already has useful foundations and should be evolved rather than discarded.

### Collection library

Current behavior:

- `CollectionBrowser` provides the shared shell, type tabs, Library/Showcase mode, search, sorting, rating filter, and add/import actions.
- `CollectionCard` is shared across game, manga, and movie.
- Cards currently use the same basic structure: cover object -> title -> creator/company credit.
- Type-specific classes exist, but the visual language is still mostly shared.

Current strength:

- Dense desktop layout.
- Covers dominate the available area.
- Toolbar hierarchy is compact and already fits the general Lakomics design language.

Current weakness:

- Game, manga, and video works read as variations of the same framed poster card.
- The medium is not visually obvious until the detail screen is opened.
- The body repeats some location context already visible in the toolbar, delaying the start of the artwork grid.

### Game detail

Current behavior:

- Large hero artwork.
- Physical package presentation with front/spine/shell/rim structure.
- Small metadata block in the hero.
- Artwork / screenshot gallery below.
- Provider and management actions are available.

Current strength:

- The basic Game Exhibit grammar already exists.
- Hero and package are visually distinct roles.
- Existing restrained package interaction is a useful foundation.

Current weakness:

- Hero height and information density can leave a large visual drop into sparse lower content.
- Metadata is still mostly field-by-field rather than composed into concise identity lines.
- Sparse screenshot sets leave too much unused space.
- Management controls remain too visible inside an appreciation-first surface.

### Manga detail

Current behavior:

- Volume covers are presented through `CollectionVolumeGrid`.
- Edition index is exposed as numbered drawer buttons.
- Each volume is an independent tile with cover, display label, and optional upcoming badge.

Current strength:

- Volume identity and ordering are already first-class.
- Multiple editions already have a persistence model.
- Release state can already be attached to individual volumes.

Current weakness:

- It still reads as a generic cover grid rather than a personal shelf.
- Tile boundaries and badges compete with the cover artwork.
- Numbered edition drawers expose implementation structure rather than user-meaningful edition identity.
- Release information is layered on top of covers instead of being integrated into the shelf context.

### Video / movie detail

Current behavior:

- Backdrop + poster + title / original title.
- Core facts are flattened into one line.
- TMDB score and personal score are displayed together.

Current strength:

- Poster and backdrop already have distinct roles.
- The basic archive/detail composition is correct.

Current weakness:

- The implementation is still film-only.
- There is no Film / Series split yet.
- Cast, staff, related works, release history, season posters, and episode structure are not part of the presentation.
- External score and personal state are not yet sufficiently separated in hierarchy.

## 3. Non-goals

Do not use this redesign to:

- replace the existing dark neutral Lakomics shell with a thematic room or bookshelf background;
- add decorative furniture, lamps, walls, windows, or room simulation;
- apply 3D treatment to ordinary controls or the whole application;
- copy Komga, Playnite, Jellyfin, AniList, Plex, Steam, or any other reference product wholesale;
- introduce glassmorphism, strong glow, large rounded cards, or hover-scale decoration;
- turn Game Works into a launcher with play/install/news/achievement UI;
- turn Video Works into a streaming-service clone;
- turn external provider metadata into a long property table;
- change Collection domain ownership or provider-refresh semantics without a separate data-contract task.

## 4. Visual hierarchy rules

Across all Works surfaces, preserve this order:

1. artwork / cover / poster / hero
2. work identity and current context
3. personal state: rating, memo, Showcase, owned/local state
4. useful provider-derived metadata
5. provider/debug/maintenance controls

Provider connection and refresh actions should move toward quiet menus rather than permanent high-visibility controls.

### Density by surface

Use different presentation intensity by surface:

- **Library** — approximately 20% appreciation / 80% navigation and scanning.
- **Detail** — approximately 60% appreciation / 40% information and control.
- **Showcase** — approximately 85% appreciation / 15% control.

These are design ratios, not literal layout measurements.

## 5. Shared visual primitives

Build a small set of reusable presentation primitives instead of one-off CSS effects.

### `WorkTile`

Shared library-level contract with type-specific presentation presets.

Responsibilities:

- cover / poster rendering;
- title and one compact secondary line;
- selected/focus state;
- unread/new release signal without obscuring artwork;
- type-specific object wrapper.

Presets:

- `game-package`
- `manga-book`
- `video-poster`

### `PhysicalCover`

Lightweight CSS 3D primitive for works that benefit from physical depth.

Rules:

- DOM/CSS only; no Three.js/WebGL for normal browsing.
- artwork remains front-facing and recognizable;
- default rotation should be near zero;
- depth should be perceptible only at close inspection;
- shadow belongs outside the preserve-3d subtree where practical;
- no continuous pointer-tracking in dense library grids.

Initial visual range:

- rotate Y: 0-3deg in normal state;
- hover/focus: straighten toward 0deg;
- manga depth: about 4-8px visual depth;
- game case depth: slightly stronger than manga, still restrained;
- hover lift: about 3-5px maximum in appreciation-oriented surfaces;
- radius: 0-2px for artwork faces.

### `ArtworkStrip`

Responsive horizontal strip / grid for screenshots, backdrops, posters, or related artwork.

Requirements:

- adapts to 1, 2, 3, or many items without leaving a large dead region;
- preserves aspect ratio;
- artwork remains visually more important than labels;
- supports click-through appreciation viewer.

### `RelatedWorksRail`

Compact relationship surface for provider-derived and local Collection relationships.

Potential relation labels:

- 원작
- 전작
- 후속작
- 같은 시리즈
- 스핀오프
- 관련 작품

Prefer local Lakomics Collections when a relationship can be resolved locally.

### `MetadataLine`

Dense sentence-like identity line instead of repeated label/value boxes.

Examples:

- `2018 · JRPG · PS4 / Switch / PC`
- `2023- · TV · 28화 · 방영중`
- `1997 · 영화 · 81분 · 애니메이션 / 스릴러`

Use a separate deep-information area when the full list would make the identity line noisy.

## 6. Phase 1 — Manga Shelf Grid

### Why first

Manga is the best visual calibration target because:

- cover artwork is the primary content;
- multiple related covers must coexist in one viewport;
- physical cues can be tested at low intensity;
- shelf spacing, shadows, hover, and cover appreciation can establish the quality bar reused elsewhere.

### Target library appearance

The Collection library should still remain dense, but manga tiles should read as books rather than framed generic cards.

Changes:

- remove or strongly reduce generic card framing around manga covers;
- use `PhysicalCover` with minimal book/page-edge depth;
- keep title and author below the artwork with compact typography;
- do not place permanent decorative badges over the cover unless the state is urgent;
- keep the normal grid dense enough that artwork remains the dominant screen content.

### Target manga detail

Replace the generic volume tile grid with a visual shelf.

Suggested structure:

```text
Title · author                         15권 · 연재중
한국 정발 14권 · 내 소장 12권

[01] [02] [03] [04] [05] [06] [07] [08]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[09] [10] [11] [12] [13] [14] [15]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The shelf line is a presentation cue, not simulated furniture.

### Shelf rules

- open shelf: horizontal support line only; no heavy side walls or wood texture;
- cover front should remain approximately 90-95% of the perceived object;
- books should align to a common baseline rather than float independently;
- cover widths should follow a controlled range while preserving source aspect ratio;
- shelf spacing should be determined by cover height + compact metadata, not large empty room-like spacing;
- avoid heavy drop shadows around every cover; use subtle contact shadow near the shelf instead.

### Volume metadata

Move routine state off the face of the cover where possible.

Preferred:

```text
[cover]
  15
  10.17 예정
━━━━━━━━
```

instead of a large `출간 예정` badge obscuring artwork.

Always-visible information may include:

- volume number;
- new/upcoming state;
- compact local release date when useful.

Deep/on-demand information may include:

- ISBN;
- publisher;
- edition identity;
- provider source;
- Japanese/Korean release comparison.

### Editions

Replace permanent numeric drawer buttons with user-meaningful edition controls.

Rules:

- hide edition UI entirely when only one edition exists;
- use actual edition names when known;
- fall back to neutral labels only when the data has no better identity;
- changing edition must preserve volume order and shelf position where possible.

### Cover interaction

Clicking a volume cover should prioritize cover appreciation.

Target behavior:

- selected cover lifts/comes forward into a focused appreciation viewer;
- previous/next moves by volume order;
- metadata is secondary and available without replacing the artwork-first interaction;
- motion remains restrained and within the functional/collectible exception defined by `DESIGN.md`.

### Phase 1 acceptance gate

- covers clearly read as a shelf rather than a generic grid;
- no furniture/room simulation is needed to communicate the shelf;
- artwork remains more visually prominent than labels, badges, shelf chrome, or shadows;
- 10-20 volume series still fits comfortably in a desktop viewport with useful density;
- multiple editions remain usable;
- release-state information remains readable without covering important cover art;
- keyboard/focus states remain clear;
- real Tauri verification confirms no distracting hover motion or layout jump.

## 7. Phase 2 — Game Exhibit refinement

### Preserve

Keep the current successful foundation:

- hero artwork;
- separate package art;
- restrained package physicality;
- screenshot/artwork gallery;
- provider-managed artwork roles.

### Refine hero composition

Current target:

- reduce hero vertical dominance enough that the first lower content is visible sooner;
- aim for roughly 38-44% of the available detail viewport as a visual starting range, then tune by real use;
- keep package + title + identity information as one coherent lower-hero composition;
- ensure hero artwork is not darkened more than necessary for text readability.

### Package

- slightly increase package importance relative to the current composition if it helps work identity;
- keep the front cover dominant;
- preserve shallow case depth;
- avoid exaggerated side/back faces when only front artwork exists;
- allow stronger interaction only in detail/Showcase, not the dense library grid.

### Metadata composition

Replace the field-grid feeling with compact identity lines.

Preferred top-level information:

```text
2018 · JRPG · PS4 / Switch / PC
Square Enix · HexaDrive

내 평점 ★★★★☆
```

Move complete platform/release details below the hero.

### Artwork area

`ArtworkStrip` must fill the available composition gracefully.

- 1 image: larger single visual, not a tiny orphan thumbnail;
- 2 images: balanced two-up composition;
- 3-4 images: compact rail/grid;
- many: horizontally navigable or bounded gallery.

### Provider/API expansion target

After the visual hierarchy is stable, consider exposing richer IGDB data in structurally useful ways:

- platform-specific release history;
- franchise / collection membership;
- related games;
- themes / game modes / player perspective where genuinely useful;
- additional artwork/screenshots.

Do not add data solely because IGDB exposes it.

### Management controls

Move `작품 관리` toward a quiet overflow menu in the detail chrome.

Management actions remain available but should not compete with the work itself.

### Phase 2 acceptance gate

- hero, package, title, and screenshots form one continuous composition;
- sparse artwork does not create a visually empty lower half;
- personal rating is more prominent than external/provider state;
- package interaction feels collectible without becoming a toy-like 3D demo;
- management controls are discoverable but visually secondary.

## 8. Phase 3 — Type-specific Collection library tiles

After manga and game detail establish the visual quality bar, update the shared Collection library.

### Shared shell remains

Preserve:

- current toolbar density;
- Library/Showcase switch;
- type tabs;
- search;
- sort direction;
- rating filter;
- context menu behavior.

### Remove redundant hierarchy

Review whether the body-level heading such as `게임 컬렉션` is still needed when the toolbar already communicates Collection -> Library -> Game.

Preferred result:

- artwork grid begins earlier;
- total work count may remain as low-priority context;
- no large decorative page heading is added in its place.

### Game tile

- shallow package/case cue;
- front cover nearly flat;
- title + developer/publisher secondary line;
- no launcher-like play status.

### Manga tile

- shallow book cue;
- cover-first;
- title + author secondary line;
- unread release signal should avoid covering the cover when practical.

### Video tile

- flat poster presentation;
- no physical-case cue in normal library mode;
- title + compact structural line, e.g. `1997 · 영화 · 81분` or `2024 · TV · 12화`;
- film and series should be understandable without a large badge.

### Phase 3 acceptance gate

At a glance, the three tabs should feel like:

- Game = package collection
- Manga = shelf/library
- Video = poster archive

while still unmistakably belonging to one Lakomics application.

## 9. Phase 4 — Video Works: Film / Series split

### Product model direction

The current `movie` UI should evolve conceptually into Video Works.

Presentation presets:

- `video-film`
- `video-series`

This plan does not require an immediate persistence/type rename. Data-model changes should be handled separately once the UI/API contract is concrete.

### Shared video hero

Both film and series use:

- backdrop;
- poster;
- title / original title;
- personal rating;
- compact structural identity line.

### Film detail

Suggested order:

1. hero / poster / identity
2. compact overview
3. cast / primary staff
4. artwork posters/backdrops
5. release history
6. related works
7. personal memo / linked Lakomics assets / Showcase state

External score remains secondary.

### Series detail

Suggested order:

1. hero / poster / identity
2. season poster grid
3. selected season summary
4. compact episode list
5. cast / staff
6. artwork
7. related works
8. personal state

Default episode presentation should remain compact. Large episode still grids are optional, not the default.

### Animation vs live action

Do not model animation as a replacement for Film/Series structure.

Conceptually:

```text
Video Work
  shape: Film | Series
  style: Animation | Live Action | ...
```

This allows animated films and TV anime to coexist naturally.

### TMDB expansion target

Potential useful API additions:

- TV search/detail;
- season detail;
- season posters;
- aggregate credits;
- collection/related identity;
- release dates and release types;
- additional posters/backdrops.

Only fetch/store data that supports an approved presentation or relationship use case.

### Phase 4 acceptance gate

- film and series share a recognizable Video Works family without sharing one generic detail layout;
- season structure is immediately readable for TV/anime;
- poster/backdrop remain visually dominant;
- cast/staff/release data increase information density without creating a database-table appearance;
- personal state remains visually distinct from TMDB data.

## 10. Phase 5 — Showcase presentation pass

Implement Showcase only after the ordinary library/detail primitives are stable.

Goals:

- more breathing room;
- stronger collectible presentation;
- fewer visible controls;
- manual order remains authoritative;
- type-aware exhibition remains intact.

Allowed stronger effects:

- slightly greater package/book lift;
- slightly more generous shadow/depth;
- larger artwork presentation;
- curated spacing.

Still avoid:

- simulated room interiors;
- full bookshelf furniture;
- decorative gradients unless artwork itself provides the visual field;
- continuous animation;
- fake platform branding;
- mixed-type layouts that destroy poster/cover proportion.

## 11. API metadata strategy

Provider metadata should be divided into three visibility layers.

### Always visible

Only facts that help identify and scan the work.

Examples:

- title / original title;
- year / release range;
- Film / TV / game platform structure;
- runtime / seasons / episode count;
- author / developer / director or similarly primary creator;
- personal rating.

### Structural

Use relationships as UI structure rather than text fields.

Examples:

- manga volumes -> shelf;
- manga local/upcoming release state -> volume context;
- game screenshots -> artwork strip;
- game franchise -> related work rail;
- series seasons -> season poster grid;
- related/adaptation/prequel/sequel -> related-work rail;
- release dates -> compact timeline.

### Deep / on demand

Examples:

- ISBN;
- full company/platform list;
- complete credits;
- provider source identity;
- exact external score metadata;
- raw external snapshot details.

## 12. Provider caution: manga release data

Current Manga Works combine MangaDex general identity/metadata with Aladin Korean edition/release tracking.

The presentation must not hard-code the UI around `Aladin` as a permanent product concept.

Use a provider-neutral Korean/local-edition release contract so the source can be replaced or supplemented without redesigning the shelf.

The shelf should care about:

- local volume existence;
- release date;
- publisher;
- edition identity;
- ISBN/product identity when needed;
- observed/new release state.

Provider implementation is secondary.

## 13. Accessibility and interaction rules

- every cover/poster remains keyboard reachable where it is interactive;
- hover-only metadata must have keyboard/focus equivalents;
- focus styling must not distort artwork or create large native outlines over cover faces;
- reduced-motion preference must disable nonessential collectible movement;
- cover appreciation viewers must preserve back-navigation priority;
- no interaction should require precise pointer tracking to access core metadata or navigation.

## 14. Performance rules

- normal library grids should use static transforms or no transform; avoid continuous pointer-driven motion;
- CSS 3D is limited to a small DOM subtree around the cover/package;
- do not decode full-resolution provider images for grid tiles;
- reuse existing WorkArtwork thumbnails and image cache paths;
- large screenshot/artwork rails should lazy-load and remain bounded;
- avoid layout measurements on every pointer move except the already-limited detail interactions where required;
- preserve existing collection-entry performance improvements and artwork reuse paths.

## 15. Recommended implementation batches

### Batch A — Shelf primitive + manga detail prototype

- introduce `PhysicalCover` primitive;
- implement `MangaShelf` / shelf-row layout;
- map existing `CollectionVolume` data into the shelf;
- move upcoming state away from cover-obscuring badges;
- replace numeric edition drawers with conditional edition selector;
- preserve current cover appreciation interaction and volume ordering;
- runtime visual gate with short, medium, and long series.

### Batch B — Game detail composition pass

- retune hero height and lower-hero composition;
- convert top metadata to compact identity lines;
- move management to quiet overflow;
- make artwork gallery responsive to item count;
- preserve existing package behavior and provider artwork roles.

### Batch C — Type-aware `WorkTile`

- split shared CollectionCard presentation into type presets without duplicating library behavior;
- remove/reduce generic framed-card appearance;
- add compact video structural secondary line;
- review redundant body heading;
- verify Library and Showcase modes independently.

### Batch D — Video contract and Film viewer

- define provider-neutral Video Work presentation contract;
- refactor current movie detail onto `FilmArchivePreset`;
- add richer cast/staff/artwork/release sections only after data contract review;
- keep current movie collections working throughout the migration.

### Batch E — Series viewer

- add TMDB TV identity and persistence contract;
- season poster grid;
- compact episode list;
- aggregate cast/staff where useful;
- related-work integration;
- animated TV and live-action TV both pass the same structural gate.

### Batch F — Showcase polish

- increase presentation intensity using existing primitives;
- preserve manual membership/order;
- final motion/shadow/spacing tuning;
- verify the result still follows `DESIGN.md` outside the intentional collectible exception.

## 16. Visual review checklist

For every batch, review the running Tauri app rather than judging only screenshots or component tests.

Ask:

- What does the eye notice first?
- Is the artwork still the strongest element?
- Is there any new card/frame that does not carry meaning?
- Did radius, shadow, gradient, or accent usage increase without necessity?
- Does the medium become more recognizable without labels?
- Does the screen still feel like Lakomics rather than the reference product?
- Does sparse data still look intentional?
- Does dense data remain readable?
- Does the first screenful contain useful visual information rather than empty decorative space?
- Are management/provider controls quieter than the work itself?

## 17. Reference-use policy

Useful references may include:

- Komga — cover density and series/volume browsing;
- `book-cover-3d` — lightweight physical-cover construction principles;
- Playnite Helium/Fusion-style themes — game hero/detail information hierarchy;
- Jellyfin Finity/InfiniTV — season grids and wide-screen information use;
- AniList — relation taxonomy and media relationship presentation.

Use them as behavioral/compositional references only.

Do not import GPL theme CSS or duplicate a product's visual identity. Prefer original Lakomics components built from existing tokens and shared UI rules.

## 18. Definition of done

The redesign is complete when:

- the Collection library remains dense and fast but each media type has a distinct visual grammar;
- manga detail feels like a cover-first personal shelf without simulating a literal room;
- game detail feels like a coherent exhibit rather than a hero image followed by sparse metadata;
- Video Works supports both Film and Series presentation, including TV animation;
- provider data increases information density through structure, not field dumping;
- personal rating/state remains visually above external scores/provider status;
- Showcase becomes more exhibition-oriented without creating a separate incompatible UI language;
- all type-specific presentation remains consistent with Lakomics' existing desktop design language and performance expectations.
