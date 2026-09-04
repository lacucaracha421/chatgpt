# Lakomics Works viewer / presentation direction

> Status: current product/design direction for future Works presentation work.
> This is a design reference, not a second backlog. Concrete implementation work remains in `docs/roadmap/lakomics-backlog.md`, especially LONG-002 and LONG-004.
> Existing code, migrations, schemas, `CONTEXT.md`, `DESIGN.md`, and `docs/agents/lakomics-works-handoff-v2.md` remain authoritative for implemented behavior and stable domain boundaries.

## Purpose

Lakomics Works should not present games, manga, and video works through one generic detail template.

They may share navigation, metadata ownership rules, ratings, notes, external bindings, and common UI primitives, but **the browsing and viewing experience should follow the way each medium is naturally collected and appreciated**.

The intended character is:

- **Manga** — a cover-first personal library / shelf centered on volumes.
- **Game** — a work-centered digital exhibit centered on hero art, package art, and related visual material.
- **Video** — a poster-centered archive for films and series, with series expanding into seasons and episodes.

The goal is not to reproduce a real room, bookshelf, store, streaming service, or game launcher. Lakomics remains a dense desktop media library. Physical cues exist only to make collected works feel tangible while keeping the source artwork dominant.

## Shared design principles

### 1. Artwork stays first

Visual priority remains:

1. cover / poster / hero artwork
2. work identity and current context
3. user-owned state and actions
4. useful external metadata
5. provider/debug/maintenance details

Presentation chrome must not compete with the artwork.

### 2. Shared shell, type-specific viewer

Common Works infrastructure may provide:

- type navigation and filtering
- search and sorting
- personal rating
- memo / personal notes where supported
- Showcase membership
- external binding controls
- refresh/apply metadata actions
- shared dialogs, menus, loading/error states, and back-navigation

The central browsing/detail surface should use a type-specific presentation preset instead of one universal layout.

Conceptually:

```text
Collection
  -> presentation preset
       manga
       game
       video-film
       video-series
```

This does not require an immediate schema rename or migration. Current implementation names may remain until a concrete implementation task justifies changing them.

### 3. API metadata should shape the screen, not become a data dump

External APIs are not only auto-fill sources for title, year, and cover.

Use provider data in three levels:

- **Always visible** — a small set of identity facts that help recognition.
- **Structural information** — relationships that can become shelves, timelines, seasons, artwork strips, related-work rails, or release state.
- **Deep information** — ISBNs, complete credits, every platform/release row, raw provider details, and similar secondary data available on demand.

A screen should be information-dense without becoming a long property table.

### 4. Personal data outranks external score/data

Lakomics is the user's library, not a read-only IGDB/TMDB/MangaDex client.

Personal rating, memo, Showcase status, owned/local state, and linked Lakomics assets should remain visually distinct from external score and provider metadata.

External refresh must continue to preserve explicit user edits and presentation choices.

---

# Manga preset — Shelf Grid

## Character

Manga is **volume-centric**.

The central pleasure is seeing volumes together, understanding sequence and release/collection state, and opening a specific cover for appreciation.

The shelf is an organizational visual cue, not a realistic room simulation.

Avoid:

- rendered rooms, desks, lamps, windows, plants, or decorative furniture
- thick wooden frames around every shelf
- spine-only browsing as the everyday default
- heavy 3D that reduces visible cover area

## Browser / shelf appearance

The default shelf should be close to a cover grid with a subtle horizontal support line beneath each row.

```text
[cover] [cover] [cover] [cover] [cover]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[cover] [cover] [cover] [cover] [cover]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Recommended visual behavior:

- front cover remains roughly 90–95% of the visible object
- optional very thin book/page-edge depth
- almost front-facing by default
- no invented illustrated spine when only front artwork exists
- subtle contact shadow or shelf separation only
- small hover lift / straighten, without continuous pointer-tracked 3D
- cover aspect ratio is preserved; the shelf adapts to the works rather than cropping covers to fit a fake cabinet

## Work detail

Opening a manga Collection should make the **volume shelf** the main content rather than treating it as a generic metadata detail page.

Example hierarchy:

```text
Title · author · personal rating
serialization status · Japanese volume count · Korean release count · local/registered count

[01] [02] [03] [04] [05] [06] [07]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[08] [09] [10] [11] [12] [13] [14]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The exact counts must be shown only when their backing data is reliable.

## Volume state as part of the shelf

When provider/local data supports it, the shelf may quietly communicate states such as:

- registered/local volume
- Korean release exists but is not registered locally
- Japanese release exists but Korean release is not yet known
- upcoming release
- newly detected release change
- alternate edition

Do not rely on color alone. Use restrained opacity, outline, small status text/icon, or placeholder treatment.

A selected volume may expose a compact contextual line such as:

```text
12권 · 한국 2025-08-20 · 출판사 · ISBN ... · 일본판 2024-12-19
```

Detailed edition/provider data remains secondary.

## Cover interaction

Clicking a volume cover primarily enters **cover appreciation**:

- enlarged cover
- previous/next volume navigation
- optional restrained book-depth cue
- metadata available as a secondary action rather than replacing the cover immediately

This follows the existing Works rule that manga cover click is primarily for appreciation.

## Provider use

### MangaDex

Use for:

- work identity
- localized/alternate titles
- author/artist
- year/status
- tags/genres
- overview
- volume-numbered and language-specific cover candidates

### Korean release provider

The current implementation uses Aladin for Korean commercial-edition information and release watch. Future UI must not hard-code the product model to Aladin.

Treat this role as a provider-neutral **Korean release / edition source** capable of supplying, where available:

- Korean volume number
- publication date
- publisher
- ISBN
- commercial edition/product identity
- release-change detection

If the provider changes, the shelf concepts should survive unchanged.

---

# Game preset — Work Exhibit

## Character

Games are **work-centric**, not volume-centric.

One game should feel like a small digital exhibit:

- selected hero/main artwork establishes identity and atmosphere
- package/cover art communicates collectibility
- screenshots/artworks show the work itself
- metadata and relationships support the exhibit instead of dominating it

## Browser

The everyday game browser should prioritize recognizable cover/package fronts.

A light physical-object cue is allowed:

- shallow package depth
- restrained plastic/box edge
- small floor/contact shadow
- tiny static tilt
- hover lift/straighten

Do not invent platform branding, fake back covers, or deep rotations when only front artwork exists.

## Game detail layout

Suggested content order:

```text
HERO ART

[package]  title
           release / genres / platforms
           developer · publisher
           personal rating

SCREENSHOTS / ARTWORK
[wide] [wide] [wide] ...

RELEASES / PLATFORMS
compact timeline or rows

RELATED WORKS
franchise / collection / prequel / sequel when reliable

DEEP INFO
secondary metadata and provider details
```

Hero art should remain visually dominant over metadata.

## IGDB use

Current Lakomics integration already uses:

- summary
- first/platform release dates
- genres
- platforms
- developer / publisher
- cover
- artworks
- screenshots

Future enrichment should prioritize provider relationships that improve presentation rather than adding every available IGDB field.

High-value candidates:

- franchise / collection membership
- platform-specific release chronology
- game modes
- themes
- player perspective
- age rating
- language support
- related videos
- engine / version information when genuinely useful

Use these to create compact structure such as a franchise rail or release timeline instead of a large metadata table.

Example:

```text
Release
PC    2024-05-23
PS5   2025-01-02

Series
[previous work] [current work] [related work]
```

Related-work presentation should prefer Collections that already exist in the user's Lakomics library, with external-only relations clearly secondary.

---

# Video preset — Poster Archive

## Scope

The video Works area is broader than theatrical movies.

It should be designed to contain:

- live-action films
- animated films
- TV drama / live-action series
- TV animation / anime series
- streaming series

The important structural distinction is primarily:

```text
Video Work
  -> Film
  -> Series
```

Animation versus live action is better treated as a property/filter/presentation characteristic than as the top structural boundary.

The current code's `movie` naming and movie-only TMDB endpoint usage are implementation facts, not a reason to keep the future design movie-only.

## Main browser — Poster Wall

Video browsing should be a dense poster archive.

```text
[poster] [poster] [poster] [poster] [poster]
 title    title    title    title    title
 1997     2024     2023     2019     2008
 81m      Film     28 ep    2 S      5 S
```

Keep each card simple:

- poster
- title
- year/range
- compact structural line such as runtime, season count, or episode count

Do not show full cast, production company, genres, and score on every browser card.

Useful filters may eventually include:

- all / film / series
- animation / live action
- year
- genre
- personal rating
- watched/status if Lakomics later owns such state

## Shared video hero

Film and series may share an opening identity region:

```text
BACKDROP

[poster]  localized title
          original title
          year / format / status
          genres
          personal rating
```

Backdrop remains supportive. Poster and title must stay readable and dominant.

## Film detail

Film is a single-work archive.

Suggested order:

```text
Hero / poster / backdrop
Core info: year · runtime · genres · director
Overview
Cast / key staff
Poster & backdrop artwork
Release history
Related Collection / franchise works
Personal Lakomics data / linked assets
```

Release history is especially useful when reliable country/type data exists. Prefer a compact chronology over one generic `release date` field.

## Series detail

Series is **season/episode structured**.

Suggested order:

```text
Hero / poster / backdrop
Core info: year range · status · season count · episode count

SEASONS
[season poster] [season poster] [season poster]
 S1 · 28 ep     S2 · ...

selected season
compact episode list
01  title  date
02  title  date
03  title  date

Artwork
Key staff / cast
Related works
Personal Lakomics data
```

Season posters should feel like chronological visual markers, not books on a shelf.

Default episode display should remain compact. Episode stills may be an optional richer view rather than forcing dozens of large thumbnails into the normal detail page.

## Animation-specific information

When reliable metadata exists, animation/anime works may emphasize staff roles that are more meaningful for that medium, for example:

- director
- series composition
- character design
- animation studio
- original work/source
- music

Live-action works may emphasize a different compact staff set.

Do not require every role to be present, and do not reserve large empty regions for missing provider data.

## TMDB use

Current Lakomics movie integration already uses:

- localized/original title
- overview
- release date
- runtime
- genres
- director
- production companies
- external score
- posters
- backdrops

Future video enrichment should extend TMDB support to television/series rather than creating a separate visual product silo.

High-value candidates include:

- TV search/detail
- season detail and season poster
- episode identity/date
- aggregate series credits
- collection / related-work identity
- richer release-date history for films
- networks / production information where useful
- cast/profile imagery only when it improves browsing and does not overwhelm the poster-first hierarchy

---

# Information-density model

Across all presets, use three layers.

## Layer A — always visible

Approximately 5–8 high-value facts that identify the work.

Examples:

- title
- original/alternate title when useful
- year or year range
- format/type
- personal rating
- one or two key creator/company facts
- structural count such as manga volumes or TV seasons

## Layer B — structural visualization

Data that changes the shape of the page:

- manga volume shelf and release state
- game screenshot/artwork strip
- game franchise/release timeline
- film release history
- video season posters
- episode list
- related Lakomics works

This layer is the main target for richer API use.

## Layer C — drill-down

Secondary material available through detail/inspector/actions:

- ISBN and edition IDs
- complete cast/crew
- every platform or territory release
- provider source/snapshot information
- low-value technical metadata

---

# Related Works principle

Provider relationship data becomes more valuable when it reconnects to the user's own library.

Prefer:

```text
Related works
- already in my Lakomics library
- externally known but not in my library
```

Possible relationship reasons include:

- same franchise / series
- sequel / prequel
- same director / creator
- same animation studio / developer where meaningful

Do not build a graph visualization merely because the data forms a graph. Compact rails or grouped relations fit Lakomics better unless a future use case proves otherwise.

---

# Physical presentation and shelf mode

This document refines the ideas already tracked by LONG-002 and LONG-004.

Everyday browsing should remain efficient and cover/poster recognizable.

A future Display / Shelf mode may exaggerate collectibility somewhat more, but still follows these rules:

- manga may use an open shelf cue
- games may use package-display cues
- video may use poster/archive or optional physical-media cues
- Showcase may allow a more curated exhibition layout
- avoid full room simulation
- avoid decorative scenery that competes with media
- use lightweight DOM/CSS depth before considering WebGL/Three.js for ordinary grids

The display system should evolve from reusable presentation primitives, not independent one-off 3D tricks per screen.

---

# Design-reference search targets

When researching external references, evaluate each source for a specific reusable pattern rather than copying an entire product UI.

## Manga references

Look for:

- cover-first shelf/grid hybrids
- high-density volume sequencing
- selected-cover appreciation
- release/owned-state visualization
- subtle CSS physical-depth treatments

## Game references

Look for:

- hero + package hierarchy
- artwork/screenshot rails
- franchise/related-work presentation
- dense release/platform information
- front-cover-first 3D package treatment

## Video references

Look for:

- poster-wall density
- backdrop + poster detail composition
- season-poster navigation
- compact episode lists
- cast/staff presentation that does not turn the page into a streaming-service clone

## Reject references that depend on

- giant streaming-service hero banners on every screen
- excessive glassmorphism/gradients/cards
- oversized spacing and low information density
- decorative 3D rooms
- poster/cover cropping for layout uniformity
- hover animation that moves every item substantially

The reference should be translated into Lakomics' existing design language rather than copied wholesale.
