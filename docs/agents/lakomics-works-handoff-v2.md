# Lakomics — Works / Collection Handoff v2

> Status: authoritative implementation handoff for the next Works/Collection development pass.
> Updated: 2026-08-20
> Visual reference: `docs/prototypes/lakomics-works-v6-reference.html`

## 0. How to use this document

Read this document together with the repository root `CONTEXT.md`, `DESIGN.md`, and
`docs/agents/implementation.md` before changing Works/Collection code.

For the Works/Collection feature specifically, this handoff records newer product decisions
than a few stale clauses in `CONTEXT.md`. The included `codex-docs-alignment.patch` updates
those conflicting clauses and adds the Works-specific collectible-motion exception to
`DESIGN.md`.

Do not reinterpret the rest of `CONTEXT.md` or `DESIGN.md` broadly. The goal is to evolve
the existing Lakomics product, not redesign the application from scratch.

## 1. Product model

Lakomics now has two major, connected pillars.

### Asset Library

The Asset Library answers: **“What media have I collected?”**

It owns actual user-collected files, provenance, ingestion, duplicate handling, favorites,
classification, albums, trash, metadata backup, viewer behavior, and media-vault lifecycle.

### Works / Collections

Works answers: **“What games, manga, and movies do I care about?”**

This is not a minor grouping feature. It is a local works database and metadata/artwork
sync hub that can connect back to Assets.

The current code may continue to use `Collection` naming where renaming would cause churn.
Product language can say “Work” while persistence/API compatibility remains `Collection`
until a deliberate migration is justified.

### Keep these concepts distinct

Do not collapse the following concepts into one table or UI abstraction merely because
they are related:

- Asset: a managed media file.
- Classification: hierarchical organization for Assets.
- Album: user-curated Asset membership.
- Work/Collection: a game, manga, or movie with metadata and artwork.
- WorkArtwork: provider/local artwork belonging to a Work presentation context.
- Volume: a manga volume/release record.
- ExternalBinding: a provider identity/sync binding for a Work.

## 2. Immediate correctness issue — fix first

Before expanding provider synchronization, fix the existing Collection edit data-loss path.

Current frontend behavior in `CollectionEditDialog.tsx` can submit fields such as
`genres: null` and `overview: null`, while the Rust update model also contains external
identity fields that are not represented symmetrically in the TypeScript update type.
The backend update SQL writes those values.

The practical failure mode is that editing a simple user field such as title or score can
erase provider-imported metadata or provider identity.

### Required behavior

- Editing one user field must not erase untouched metadata.
- Imported provider identity must survive unrelated edits.
- Prefer true partial-update semantics when reasonable.
- If partial-update migration is too large for the first patch, explicitly preserve
  untouched values and add regression tests.

### Required regression tests

At minimum, prove that editing title and/or score does **not** erase:

- overview
- genres
- external/provider identity currently stored by the legacy model
- other imported metadata not present in the edit UI

This is P0 because broader provider work makes this bug more damaging.

## 3. Work creation flow

The intended primary creation flow is provider-assisted, not a blank manual form.

1. Choose Work type: game, manga, or movie.
2. Search a title.
3. Show provider candidates.
4. Select the correct result.
5. Fetch metadata and available artwork.
6. Create the local Work.
7. Store provider binding(s).
8. Cache presentation metadata/artwork locally.
9. Browse normally while offline.
10. Refresh provider data explicitly or according to conservative sync rules.

Manual entry remains a fallback for works that cannot be found or where the user
intentionally wants a local-only record.

## 4. Provider architecture

The legacy `externalId / externalSource / externalSyncedAt` shape assumes one provider per
Collection. That is insufficient.

A manga can legitimately use MangaDex for work identity and Aladin for Korean commercial
volume/release tracking. The architecture therefore needs multiple bindings.

### Suggested model: ExternalBinding

Conceptually:

```text
work_external_sources
- id
- work_id
- provider
- external_id
- sync_enabled
- last_synced_at
- last_checked_at (when useful)
- provider_data_json
- provider_config_json (optional, provider-specific)
```

Names can follow the existing codebase conventions. The important point is ownership:
the Work owns zero or more provider bindings.

### Provider interface direction

A shared provider interface can expose core operations such as:

```text
search(query)
getWork(externalId)
getArtwork(externalId)
refresh(binding)
```

Then expose optional capabilities rather than forcing every provider into one oversized
interface:

```text
getVolumes(...)
checkReleases(...)
getEditions(...)
```

Do not build speculative abstractions before a second real provider requires them.
A capability boundary is useful because MangaDex, Aladin, a game provider, and TMDB have
genuinely different roles.

### Local-first rules

- Provider data must be cached locally.
- Ordinary Work browsing must not require the network.
- Provider failures must not make an existing Work unusable.
- Sync must never silently erase explicit user changes.
- Store enough raw/provider data to reason about refreshes and migrations.
- Do not spam provider APIs; use `last_checked` / `last_synced` and conservative refresh behavior.

## 5. User metadata versus provider metadata

Do not let provider refresh own the entire Work row.

A robust direction is to distinguish:

- provider-derived metadata
- explicit user edits/overrides
- presentation selections such as chosen hero/cover

Exact schema can evolve incrementally, but the rule is stable:
**provider refresh must not erase user intent**.

This is especially important for titles, score/rating, selected artwork, notes if added
later, and any manually corrected localized metadata.

## 6. Work artwork

Provider artwork should be downloaded locally for fast/offline Work presentation, but it
should **not automatically pollute the Asset Library**.

Treat this as WorkArtwork unless the user explicitly promotes/imports it as an Asset.

Conceptual fields:

```text
WorkArtwork
- id
- work_id
- provider
- provider_image_id
- kind
- local_path
- width
- height
- language
- volume_id (nullable)
- sort_order
- selected
```

Useful `kind` values include:

```text
cover
poster
background
hero
artwork
screenshot
logo
volume_cover
```

The game detail UI particularly needs a selected **main/hero artwork** that is independent
from the smaller cover/package image.

## 7. Manga

### Provider roles

**MangaDex** is intended primarily for work identity and general metadata:

- title / alternate titles
- author / artist
- description
- tags / genres
- status / year
- MangaDex ID
- representative artwork / covers where available

**Aladin** is intended for Korean commercial edition/release tracking:

- Korean volume title/number
- ISBN / ISBN13
- provider item ID
- Korean publication date
- preorder/upcoming status where available
- changed/newly listed release detection

These are complementary sources, not mutually exclusive choices.

### Volume needs to become a first-class model

Do not keep relying on a loose filename `volumeLabel` for the long-term Work experience.

A useful conceptual Volume shape is:

```text
Volume
- id
- work_id
- volume_number
- display_label
- title
- original_release_date
- local_release_date
- isbn13
- provider_item_id
- status
- sort_order
```

Volume ordering is primary in the manga shelf/grid. Do not force the general Works date rail
onto a volume shelf where volume order is semantically stronger.

### Release Watch

Aladin-backed manga can support a conservative Release Watch:

- periodically or manually check cached bindings
- detect newly listed volumes
- detect changed release dates/status
- remember known provider item IDs
- store last checked/synced times
- avoid repeated network calls when nothing can reasonably have changed

This is a release-tracking feature, not a social/news feed.

### Manga volume click — important UX decision

Clicking an individual volume cover is **not primarily a metadata action**.

The primary action is cover appreciation / collectible inspection:

- quick open/zoom transition, approximately 120–170 ms
- cover rises slightly from its surface
- a very small Y-axis angle establishes physical depth
- enlarged cover can react to pointer position with restrained `rotateX / rotateY`
- restrained moving shadow and very weak glare are allowed
- pointer leaving returns the cover smoothly to front-facing
- background is dimmed
- left/right navigation can move between volumes
- Escape / backdrop closes
- closing should return toward the original grid position when practical
- no metadata panel by default

Metadata still exists and remains useful elsewhere in the Work UI. The decision is
specifically that **cover click means inspect the cover, not open a property sheet**.

## 8. Games

### Game detail composition

The selected game’s main artwork should be visually dominant.

Think of the roles as:

- **Hero/main artwork** = identity, atmosphere, emotional visual anchor.
- **Cover/package** = collectible/physical-object representation.
- **Metadata** = secondary supporting information.

Do not let a small cover and a metadata panel shrink the hero artwork into a generic card header.

### Generic game package

Most game data sources only provide front cover art. Do not depend on finding complete
real-world box scans for every title.

Lakomics can generate a **brand-neutral dark premium package** procedurally with CSS/SVG:

- front cover insert using the real front cover
- thin shell/frame
- modest spine
- restrained edge depth
- very weak plastic/paper surface cue
- contact shadow

Avoid fake PlayStation/Xbox/Switch branding unless the product later deliberately supports
platform-specific accurate frames.

The package should not expose large empty sides. Limit rotation so missing side/back artwork
is not revealed.

A future optional `Retro Box` / `Collector Box` presentation can exist, but it should remain
generic: front cover stays authentic while spine/side material is generated by Lakomics.

### Physical lift interaction

In detail/showcase contexts, a game package may behave like an object resting on a display
surface:

- default state appears grounded with a soft contact shadow
- click/selection can raise it roughly 10–18 px visually
- simultaneously rotate only a few degrees around the vertical axis
- contact shadow becomes wider/softer as the object lifts
- after the initial lift, pointer-driven tilt may remain subtle

This is meant to communicate weight and “pick up the collectible,” not to create a flashy
3D demo.

In the normal management grid, keep the same package language much quieter.

## 9. Movies

Movies remain poster/backdrop driven.

A sensible provider is TMDB or an equivalent provider with:

- poster
- backdrop
- title/localized/original titles
- director / key credits
- runtime
- release date
- genres
- overview

Do **not** force the game-package or manga-cover physical-object treatment onto movie
management screens solely for consistency.

A future Blu-ray/physical-media presentation can be a separate intentional feature if desired.

## 10. Works navigation and date rail

### No mixed “All Works” gallery

Do not use a single `All` gallery that mixes game, manga, and movie cover aspect ratios.
It becomes visually uneven and does not add enough value.

Works should expose type-specific browsing:

- Games
- Manga
- Movies

Entering Works can restore the last-used type or use another simple deterministic choice.

### Date rail

Reuse the established AssetGallery-style right-side date rail for Works when appropriate.

The existing AssetGallery date rail is the behavioral reference: it maps dated gallery rows
into a compact right-side rail and supports pointer-driven scrolling.

For Works, default the rail to the Work’s library-added/created date when sorting by that
chronology. If the user is explicitly sorting by release date, the rail can represent that
sort date instead.

Do not add a date rail to manga volume shelves merely because the component exists;
volume number/order is primary there.

## 11. Showcase

Showcase is a **separate personal exhibition**, not a filter and not an automatically mixed
favorite grid.

The user chooses approximately ten especially loved works for each medium:

- game showcase
- manga showcase
- movie showcase

### Showcase behavior

- The user manually chooses membership.
- The user manually controls exhibition order.
- Do not show mandatory 1st/2nd/3rd ranking numbers.
- Clicking an exhibited Work opens the normal Work detail; do not create a duplicate
  “showcase detail” model.
- Showcase can use a richer presentation than the management grid because
  appreciation/exhibition is its purpose.

A future schema can use either fields or a membership table. Prefer a small membership/order
table if it keeps ordering clean, but do not over-engineer before needed.

Conceptually the minimum information is:

```text
work_id
showcase_type or inherited work type
showcase_order
```

## 12. Collectible interaction exception to DESIGN.md

The global Lakomics design rules remain authoritative: dense desktop tool, media-first,
minimal decorative motion, restrained shadows, no generic hover-scale UI.

However Works now has one deliberate exception.

### Collectible Interaction Exception

The prohibition against decorative `scale`, `translate`, 3D transforms, and shadows does
**not** apply to a restrained interaction whose semantic purpose is to represent picking up,
inspecting, or displaying a collectible Work object.

Allowed examples:

- manga cover inspection viewer
- game package lift/tilt in detail or Showcase
- contact shadow that communicates whether a depicted object is resting on or lifted from a surface

Constraints:

- do not apply this to ordinary buttons, toolbars, settings rows, generic cards, or unrelated Asset tiles
- normal browsing remains quiet
- no large spring/bounce motion
- no exaggerated holo/glare treatment
- no large-angle 3D spin
- no constant animation
- transitions should generally stay within the existing ~80–160 ms motion language,
  with only small exceptions for the shared cover zoom if necessary

This is a semantic physical-object interaction, not a blanket license to decorate the app.

## 13. Visual reference prototype

Use:

`docs/prototypes/lakomics-works-v6-reference.html`

as the visual/interaction reference for the current direction.

The prototype is **not production code** and should not be copied wholesale into React.
It is a behavioral reference for:

- Works type separation
- large game hero artwork
- generated game package language
- Manga volume cover inspection
- restrained lift / Y-axis tilt / contact-shadow behavior
- separate Showcase
- dense dark Lakomics chrome

When the prototype conflicts with normal application architecture, preserve the **visual
intent** and implement it with existing components/tokens/modules rather than copying
standalone HTML structure.

The visual direction has already been explored. Do not start a fresh broad “make it modern”
redesign. Final production tuning should happen after the Work/provider ownership model is stable.

## 14. App structure / implementation cautions

`App.tsx` is already orchestration-heavy. Do not continue putting provider-specific network
logic, sync state, and large Work detail behavior directly into the application root.

Prefer deep modules with clear ownership:

- provider clients own remote protocol details
- Work repository/service owns persistence and orchestration
- artwork cache owns local provider artwork lifecycle
- UI components consume narrow interfaces/state

Reuse existing common UI and tokens according to `docs/agents/implementation.md`.

## 15. Recommended implementation order

### P0 — data-loss fix

Fix Collection edit update semantics and add regression tests.

### P1 — Work/provider ownership model

Introduce or prepare the normalized multi-binding model. Decide clearly where provider data,
user overrides, WorkArtwork, and sync timestamps live.

### P2 — one complete provider flow

Implement one provider end-to-end as the reference implementation. MangaDex is a good
candidate because it exercises title search, identity, metadata, and cover artwork without
yet requiring the full release-watch capability.

### P3 — Volume model

Add first-class manga volumes and migrate/adapt existing volume labels where necessary.

### P4 — Aladin release tracking

Add Aladin as a second binding/capability for Korean editions and Release Watch behavior.

### P5 — game provider

Implement game search/import, selected main artwork, cover, developer/publisher/platform/
genre/release metadata, and provider binding.

### P6 — movie provider

Implement movie search/import and poster/backdrop metadata flow.

### P7 — type-specific Work detail production UI

Implement the proven visual direction using production React/components/tokens:

- game hero + package
- manga volumes + cover viewer
- movie poster/backdrop detail
- date rail where semantically appropriate
- Showcase exhibition behavior

### P8 — final design integration/tuning

Do not redesign from zero. Compare the production implementation against the v6 reference,
then tune spacing, motion, shadows, and density using real provider data.

### P9 — documentation and acceptance

Update stale README/CONTEXT text, add acceptance coverage, and document provider/local-first
behavior after implementation settles.

## 16. Acceptance checklist

Before considering the Work system coherent, verify at least the following:

- unrelated Collection edits cannot erase imported metadata
- a Work can hold multiple provider bindings
- provider refresh does not erase user overrides
- provider artwork is available offline after caching
- provider artwork does not automatically appear as a normal Asset
- manga volumes have stable ordering and release identity
- Aladin checks can detect a new/changed Korean release without excessive polling
- Works has no mixed All gallery
- Works date rail behaves consistently with its selected chronological sort
- Showcase membership and order are user-controlled per medium
- Manga cover click opens the appreciation viewer, not a metadata sheet
- Game detail keeps hero artwork dominant
- collectible motion is restrained and localized to semantically physical Work objects
- ordinary Lakomics UI remains compliant with `DESIGN.md`

## 17. Non-goals for this pass

Do not expand scope into unrelated features before the Work/provider core is coherent:

- AI character-by-character auto-tagging
- recommendation engines
- social/community features
- cloud-first synchronization
- decorative analytics/stats dashboards
- broad 3D UI
- redesigning the Asset Library just to match Works

The priority is a stable, local-first connection between Works, providers, artwork, releases,
and existing user Assets, with the v6 visual direction applied deliberately after ownership
and persistence are correct.
