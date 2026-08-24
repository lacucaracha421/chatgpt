# Collection v6 Production Design

## Status

Approved product direction from the 2026-08-25 design grilling session. This document is the production target for evolving the existing Collection implementation. It complements `docs/agents/lakomics-works-handoff-v2.md` and the visual reference at `docs/prototypes/lakomics-works-v6-reference.html`.

Implementation must be split into independently testable plans. This document is not permission to replace the existing React application with prototype HTML.

## 1. Product boundary

Collection is Lakomics's local, typed work library for games, manga, and movies. The user-facing name remains **컬렉션**, and the existing internal `Collection` naming remains valid.

The Online Catalog is a separate remote manga browsing product surface. It supports remote search, immediate reading, bookmarks, and reading progress. It must not:

- create a Collection from a bookmark;
- offer “add to Collection” from Online Catalog results;
- synchronize Online Catalog state into Collections;
- act as a Collection metadata provider.

Collection may use its own media-specific metadata providers during Collection creation and refresh. Those provider flows remain independent of the Online Catalog.

Legacy `gacha` and game-character records are not a fourth Collection type and remain excluded from normal game Collections.

## 2. Primary experience

Collection has two deliberate modes:

- **Library** is the quiet, dense management view used for finding, adding, editing, and opening Collections.
- **Showcase** is a separate personal exhibition used to appreciate manually selected Collections.

The modes appear as `라이브러리 | 쇼케이스`, not as a boolean filter disguised as a toolbar toggle. Both modes expose `게임 | 만화 | 영화` as a separate media axis. There is no mixed “All” view. Lakomics restores the last-used media type when the user returns.

The application-level top bar remains stable. Collection owns a compact secondary control row rather than replacing global chrome as selection or detail state changes.

## 3. Library controls and navigation

The Library control row contains only predictable collection-level controls:

- Library/Showcase mode switch;
- game/manga/movie media switch;
- title search;
- sort selection and direction;
- exact personal-rating filter;
- add Collection action.

Supported sorting is:

- recently added, the default;
- name;
- media date: game release, manga publication, or movie release.

Every sort supports ascending and descending direction where meaningful. Missing media dates sort after dated records in either direction.

The personal-rating control is a compact single-select filter rather than a sort or a row of ten buttons. It contains `전체`, exact values from 5.0 down in 0.5 increments, and `미평가`. Each media type remembers its last selected rating filter.

Opening a Collection replaces the central workspace with its detail view while preserving the application shell and sidebar. Back navigation and Escape return to the originating list state.

## 4. Library cards

Cards are media-first and intentionally sparse. Every card shows:

- cover or poster;
- title;
- one media-specific credit line;
- a small release-change badge only when unread release information exists.

The credit line is:

- manga: author;
- game: developer;
- movie: production company.

Multiple credits show at most two values joined by ` · `. Missing credit data leaves the secondary line visually reserved but empty; publisher, distributor, or director must not be mislabeled as developer or production company.

Cards do not repeat the active media type and do not foreground asset count, year, external score, or personal rating. Those values belong in detail or controls.

Game cards may use a restrained generic package frame and contact shadow. Manga covers and movie posters remain flat. Normal Library cards must not use persistent tilt, glare, bounce, or large-angle 3D motion.

## 5. Detail composition

Detail is media-specific rather than one generic cover-plus-properties template.

### Game

- selected hero artwork is the dominant visual anchor;
- the authentic front cover appears inside a subtle brand-neutral package;
- developer, release data, platform, genres, external metadata, and personal rating support the artwork rather than compete with it;
- package lift/tilt is restrained and limited to detail or Showcase.

### Manga

- work information and a volume-ordered shelf/grid share the workspace;
- volume order is primary; no general date rail is added to the volume shelf;
- clicking a volume cover opens the existing collectible cover viewer rather than a metadata dialog;
- MangaDex and Aladin actions live in the detail overflow menu or focused provider UI, not as a changing row of top-bar buttons.

### Movie

- backdrop and poster drive the composition;
- production company, release data, director, runtime, genres, overview, and personal rating remain supporting metadata;
- the game-package treatment is not reused for movies.

## 6. Actions and accessibility

Card context menus contain edit, add/remove Showcase, and delete. The detail view exposes a visible text-labelled overflow menu with the same relevant actions plus provider connection and refresh actions.

No important function is right-click only. Existing shared menu, dialog, button, focus, and keyboard interfaces must be reused. Destructive actions retain confirmation. The top bar must not accumulate item-specific provider actions.

## 7. Showcase

Showcase membership and order are user-controlled per media type. There is no hard item limit, ranking number, automatic favorite import, or mixed-media wall. The layout should be strongest with roughly 6–12 works without enforcing that range.

All exhibited works have equal visual rank. Manual order determines position, not a featured first place. The v6 exhibition wall is the visual reference:

- game Collections exhibit the package object;
- manga Collections exhibit the cover;
- movie Collections exhibit the poster;
- collectible motion remains restrained and localized to the depicted object.

Users add or remove membership from Library context menus. Showcase provides an explicit edit mode for pointer drag reordering plus keyboard-accessible reordering. Clicking an exhibit opens the normal media-specific detail view.

## 8. Data model direction

The current `author` and `director` columns are insufficient and must not continue as overloaded generic credit storage. The model must represent, at minimum:

- manga author;
- game developer;
- movie production company;
- media date with full date when a provider supplies it and year-only fallback for manual input;
- personal rating;
- Showcase order per media type.

Personal rating uses a 5-star UI and stores the displayed value directly as `0.0..5.0` in 0.5 increments. Existing integer ratings from 0 through 5 already mean the same displayed values and remain unchanged. SQLite can retain half-step real values in the existing `my_score` column without rebuilding the table. Unrated remains null. Validation must reject out-of-range values and values that are not half-step increments.

Provider-derived fields, explicit user values, selected presentation artwork, and provider snapshots must remain distinguishable enough that refresh cannot erase user intent. A Collection may own multiple external bindings. Do not introduce a speculative universal provider interface before the next real provider requires it.

## 9. Artwork lifecycle

Only artwork needed by a Collection is retained for normal offline presentation:

- selected cover or poster;
- selected hero or backdrop;
- manga volume covers.

Provider search candidate thumbnails are temporary. WorkArtwork remains outside the Asset Library unless the user explicitly promotes it through normal Asset ingestion. Removing or changing a selected artwork must follow the WorkArtwork lifecycle without deleting unrelated Assets.

## 10. Provider-assisted creation

The primary add flow is provider-assisted per media type, with manual entry as fallback. It is not an Online Catalog flow.

1. Choose game, manga, or movie.
2. Search the relevant provider.
3. Select a candidate.
4. Preview metadata and available presentation artwork.
5. Create the local Collection and external binding.
6. Cache selected presentation artwork.
7. Browse the Collection offline.

MangaDex remains the current manga identity provider, with Aladin as the complementary Korean release provider. Game and movie providers are selected and implemented in their own later design/plan cycles rather than guessed in the foundation work.

## 11. Error and empty states

- Existing Collections remain browsable when providers fail.
- Provider failure messages use public command errors and preserve existing local data.
- Empty Library states offer the add action for the active media type.
- Empty Showcase states explain how to add items from the Library without presenting an automatic fill action.
- Missing artwork uses a quiet placeholder with stable card geometry.
- Missing credit, rating, or date never blocks opening or displaying a Collection.

## 12. Verification targets

At minimum, the implementation series must prove:

- Online Catalog actions never create or update Collections;
- media, mode, sort, direction, and exact rating filtering compose correctly;
- unrated and undated records follow the defined ordering/filter rules;
- editing personal rating or other user fields does not erase provider metadata or bindings;
- cards render the correct media-specific credit and never substitute a different role;
- Library and Showcase restore their expected per-media state;
- Showcase membership/order persist and remain keyboard accessible;
- WorkArtwork stays out of the Asset Library;
- each media detail retains its distinct composition and navigation behavior.

## 13. Execution decomposition

This target is intentionally delivered as separate implementation plans:

1. Collection foundation: typed credits, media dates, rating validation, Showcase order, and safe migrations.
2. Collection Library shell: stable navigation, search, sorting, rating filter, and revised cards.
3. Manga production detail: provider actions, volume shelf, and cover viewer integration.
4. Game provider and detail: provider-assisted creation, hero artwork, and package presentation.
5. Movie provider and detail: provider-assisted creation, backdrop, poster, and movie metadata.
6. Showcase production view: equal-rank exhibition and accessible manual ordering.
7. Final v6 comparison and visual tuning with real data.

Each plan must leave the application usable and independently testable. No plan may copy the standalone prototype wholesale, add an “All” gallery, connect Online Catalog to Collections, or broaden collectible motion into ordinary Lakomics UI.
