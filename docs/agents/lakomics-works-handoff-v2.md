# Lakomics — Works / Collection Reference

> Status: current product/architecture/UX reference, not an implementation plan.
> Updated: 2026-08-27
> Visual reference: `docs/prototypes/lakomics-works-v6-reference.html`

## 0. How to use this document

Read this together with `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, and
`docs/agents/implementation.md` before making substantial Collection changes.

This file records **stable product and ownership decisions** for the Collection/Works area.
It does not prescribe a P0→P9 task sequence and must not be treated as a backlog.

At the time of this update, `main` already contains substantial provider and volume infrastructure,
including multiple external bindings, MangaDex/IGDB/TMDB/Aladin flows, Collection volumes,
Work artwork, and Release Watch. Before proposing or rebuilding any of those concepts, inspect the
current code, migrations, and TypeScript contracts first.

Files under `docs/superpowers/plans/` and `docs/superpowers/specs/` are dated implementation records.
They may explain why code exists, but they are not current instructions unless a newer reference
explicitly promotes them.

## 1. Product model

Lakomics has two connected but distinct pillars.

### Asset Library

Answers: **“What media have I collected?”**

It owns user-collected files, provenance, ingestion, duplicate handling, favorites,
classification, albums, trash, metadata backup, viewer behavior, and media-vault lifecycle.

### Collections / Works

Answers: **“What games, manga, and movies do I care about?”**

A Collection is a local work record with type-specific metadata and presentation artwork that can
link back to existing Assets. Product copy can use natural “작품/Work” language where useful,
while persistence and code may continue using `Collection` naming unless a deliberate migration is justified.

### Keep these concepts distinct

Do not collapse the following merely because they are related:

- Asset: a managed media file.
- Classification: hierarchical Asset organization/navigation.
- Album: user-curated Asset membership.
- Collection/Work: a game, manga, or movie record.
- WorkArtwork: provider/local artwork used for Collection presentation.
- Volume: a manga volume/release record.
- ExternalBinding: a provider identity/sync binding for a Collection.

## 2. Provider ownership and local-first rules

A Collection may have zero or more external bindings. One-provider-per-Collection assumptions are
not sufficient; for example, MangaDex can provide manga identity/general metadata while Aladin can
track Korean commercial releases for the same Collection.

Provider-specific remote protocol details belong in provider modules/flows, not in `App.tsx` or
large UI components. Shared interfaces should cover proven common behavior; optional provider
capabilities should remain optional rather than forcing every provider into one oversized abstraction.

Stable local-first rules:

- Provider data needed for normal browsing should be cached locally.
- Existing Collections must remain usable when providers or the network fail.
- Provider refresh must not silently erase explicit user edits or presentation choices.
- Keep enough provider identity/raw snapshot data to reason about refreshes and migrations.
- Avoid unnecessary polling; use stored sync/check timestamps and conservative refresh behavior.
- Do not invent generic provider layers before a second real use case requires them.

## 3. User metadata versus provider metadata

Provider refresh does not own the entire Collection row.

Keep the conceptual distinction between:

- provider-derived metadata
- explicit user edits/overrides
- presentation selections such as chosen cover/hero/backdrop

Editing one user field must not erase untouched imported metadata or provider identity.
Likewise, refreshing a provider must not overwrite user intent merely because the remote value differs.

## 4. Work artwork

Provider artwork is presentation data first, not automatically an Asset.

Artwork used for covers, hero images, backdrops, screenshots, logos, or manga volume covers should
be cached locally for fast/offline Collection presentation without polluting the Asset Library.
Only explicit user promotion/import should turn provider artwork into an Asset.

The Collection may choose different artwork for different presentation roles. In particular, game
hero/main artwork is independent from the smaller cover/package image.

## 5. Manga

### Provider roles

**MangaDex** is primarily useful for work identity and general manga metadata such as titles,
author/artist, description, tags/status/year, and cover information.

**Aladin** is primarily useful for Korean commercial edition/release tracking such as Korean volume
records, ISBN/provider identity, publication dates, preorder/upcoming state, and release changes.

These roles are complementary, not mutually exclusive.

### Volumes

Volume is a first-class Collection concept. Do not regress to treating a loose filename label as the
long-term source of volume identity/order.

Volume number/order is primary on a manga shelf. Do not add a general date rail to a volume shelf
merely because the component exists.

### Cover interaction

Clicking a manga volume cover is primarily **cover appreciation / collectible inspection**, not a
metadata-sheet action.

The viewer may use a restrained quick zoom/lift, small 3D response, dimmed background, previous/next
navigation, and a subtle moving shadow/glare. It should return smoothly and remain consistent with the
collectible-motion exception in `DESIGN.md`.

No metadata panel is required by default when the user clicks the cover itself.

## 6. Games

Game detail should keep the selected main/hero artwork visually dominant.

Roles:

- Hero/main artwork = identity, atmosphere, emotional anchor.
- Cover/package = collectible/physical-object representation.
- Metadata = supporting information.

Do not shrink the hero into a generic card header merely to give a small cover and metadata panel equal weight.

Because providers often supply only front cover art, Lakomics may present a brand-neutral dark package
using the real front cover plus restrained generated shell/spine/depth cues. Do not fake platform branding
or rotate far enough to expose large invented side/back surfaces.

In detail/Showcase contexts, the package may lift slightly with a small Y-axis rotation and changing
contact shadow. Normal management grids should keep this much quieter.

## 7. Movies

Movies remain poster/backdrop driven. Poster, backdrop, localized/original titles, credits, runtime,
release date, genres, overview, and rating metadata fit the medium naturally.

Do not force manga-cover or game-package physical-object treatment onto ordinary movie screens merely
for cross-type consistency. A future physical-media/Blu-ray presentation would be a separate intentional feature.

## 8. Collection browsing and navigation

Do not create a mandatory mixed “All Works” cover gallery that combines game, manga, and movie aspect
ratios without a clear user benefit. Type-specific browsing remains the default direction:

- Games
- Manga
- Movies

A right-side date rail can be reused when chronology is semantically meaningful. It should represent the
active sort chronology (for example created date or explicit release date), not appear on every screen by default.

## 9. Showcase

Showcase is a separate personal exhibition, not an automatic favorites filter or ranking table.

- Membership is chosen manually.
- Order is controlled manually.
- Keep exhibitions type-specific.
- Do not show mandatory 1st/2nd/3rd rank numbers.
- Clicking an exhibited Collection opens the normal Collection detail rather than a duplicate detail model.
- Showcase may use richer presentation because appreciation/exhibition is its purpose.

## 10. Visual and motion reference

`DESIGN.md` remains authoritative for normal Lakomics UI: dense desktop tool, media-first hierarchy,
restrained chrome, minimal decorative motion, and stable high-density browsing.

The limited Works collectible exception permits small scale/translate/3D/contact-shadow behavior only
when its semantic purpose is to communicate picking up, inspecting, or displaying a physical collectible.
It does not apply to ordinary buttons, toolbars, generic cards, settings rows, or Asset tiles.

Use `docs/prototypes/lakomics-works-v6-reference.html` as a **visual/interaction reference**, not production code.
Preserve its intent using current React structure, shared UI, tokens, and modules rather than copying standalone HTML.

The prototype is useful for:

- type separation
- large game hero composition
- restrained generated package language
- manga cover inspection
- collectible lift/tilt/contact shadow
- separate Showcase presentation
- dense dark Lakomics chrome

Do not start a broad “make it modern” redesign from the prototype.

## 11. Implementation cautions

- `App.tsx` should remain orchestration, not the home of provider protocol logic or large Collection behaviors.
- Provider clients/flows own remote protocol details.
- Collection/library modules own persistence and domain invariants.
- Artwork lifecycle belongs behind its owning library/module boundary.
- UI consumes narrow contracts and reuses shared controls/tokens.
- Before adding a provider abstraction, inspect existing provider flows and external-binding code.
- Before changing Collection schemas/contracts, inspect migrations, Rust models, TypeScript types, and edit/update semantics together.
- Preserve user data and existing provider bindings across unrelated edits.

## 12. Current consistency checklist

When modifying this area, check the subset relevant to the change:

- unrelated Collection edits do not erase imported metadata or provider identity
- multiple provider bindings can coexist where required
- provider refresh preserves user intent
- provider artwork stays separate from Assets unless explicitly imported
- manga volumes keep stable identity/order
- release checks avoid excessive provider polling
- type-specific browsing remains coherent
- Showcase membership/order stay user-controlled
- manga cover click remains appreciation-first
- game detail keeps hero artwork dominant
- collectible motion remains restrained and localized
- ordinary Lakomics UI remains compliant with `DESIGN.md`

## 13. Non-goals implied by this reference

This document is not permission to expand Collection work into unrelated product scope such as:

- AI character-by-character auto-tagging
- recommendation engines
- social/community features
- cloud-first synchronization
- decorative analytics dashboards
- broad 3D UI
- redesigning the Asset Library merely to match Collection screens

Evolve the existing product incrementally. Current code and current product references come before old dated plans.
