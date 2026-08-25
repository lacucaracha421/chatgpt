# Game Provider and Detail Design

## Status

Approved product direction from the 2026-08-25 Collection v6 continuation. This is execution item 4 of `2026-08-25-collection-v6-production-design.md`: one complete game provider flow, selected hero artwork, and the game-specific production detail.

This design follows `DESIGN.md`, `docs/agents/lakomics-works-handoff-v2.md`, and the visual intent of `docs/prototypes/lakomics-works-v6-reference.html`. It does not copy the prototype HTML or connect Collection to the Online Catalog.

## 1. Scope

This pass delivers:

- user-configured IGDB credentials;
- IGDB-assisted game search and import;
- explicit cover and hero selection;
- local metadata, binding, cover, and hero caching;
- manual provider refresh that preserves user intent;
- cover/hero reselection;
- a game-specific hero-dominant detail view;
- a restrained brand-neutral package presentation.

Manual game creation remains available. Existing manga, movie, Asset Library, Online Catalog, and provisional Showcase behavior remain outside this pass except where shared Collection fields must remain compatible.

The following are explicit non-goals:

- SteamGridDB or a second game provider;
- a speculative universal provider interface;
- automatic periodic game refresh;
- platform-specific release-date tables;
- official-artwork or screenshot galleries;
- launcher/store ownership integration;
- PlayStation, Xbox, Nintendo, or other platform branding;
- WebGL or a general 3D framework.

## 2. Provider decision

IGDB is the sole game provider for this pass. It supplies the required work identity, developer and publisher roles, genres, platforms, first release date, cover, artworks, screenshots, and overview through one external identity.

IGDB requires a Twitch application Client ID and Client Secret. Lakomics stores both through the existing OS-backed credential Module. It never stores either value in SQLite, provider snapshots, logs, or public error messages.

The backend exchanges the credentials for an app access token. The token is held in memory, reused while valid, and reacquired when absent or expired. It is not persisted as Collection data.

The IGDB Adapter obeys the documented rate limit and requests related fields together where practical. The design assumes the current official API behavior documented at:

- <https://api-docs.igdb.com/>
- <https://dev.twitch.tv/docs/authentication/register-app/>
- <https://dev.twitch.tv/docs/authentication/getting-tokens-oauth>

RAWG is rejected for this pass because its user-facing attribution/link requirements work against Lakomics's quiet desktop detail surface. SteamGridDB remains a possible later artwork-only Adapter if real use proves IGDB artwork insufficient; that need is not assumed now.

## 3. Module seams

### IgdbClient

`IgdbClient` owns the remote protocol implementation:

- application-token acquisition and in-memory reuse;
- search queries;
- one-game detail queries with expanded related fields;
- IGDB image URL construction;
- response decoding and provider-specific validation;
- mapping remote/network failures to stable library errors.

Its interface exposes game search and detail retrieval to the library implementation. It does not write SQLite rows, manage Collection transactions, or decide which artwork the user selects.

### GameImportFlow

`GameImportFlow` owns the local orchestration implementation:

- normalizing search candidates and game previews;
- validating that the chosen cover and hero belong to the selected IGDB game;
- downloading and validating only the selected original images;
- creating or refreshing the Collection and IGDB `ExternalBinding`;
- storing selected images through the existing WorkArtwork lifecycle;
- preserving user-owned values and presentation selections during refresh;
- cleaning prepared files when a transaction cannot commit.

This is an IGDB-specific flow, following the proven MangaDex direction. No shared `GameProvider` or universal `Provider` interface is introduced for a single game Adapter.

### Existing Library and UI seams

The existing Library owns Collection rows, external bindings, WorkArtwork files, migrations, and public commands. The React client receives narrow typed search, preview, apply, refresh, connection, credential, and artwork-selection operations through the existing `LibraryGateway` seam.

Provider protocol logic must not move into `App.tsx`, `CollectionBrowser`, dialogs, or detail components.

## 4. Collection data changes

Game presentation needs three Collection fields not currently represented:

- `publisher`: nullable text;
- `platforms`: nullable text containing the provider-normalized display list;
- `selected_hero_artwork_id`: nullable foreign key to existing WorkArtwork.

`selected_work_artwork_id` retains its current representative-cover role. Manga behavior and existing data remain compatible. Game cover/package uses `selected_work_artwork_id`; game hero uses `selected_hero_artwork_id`.

The migration adds the fields without rebuilding unrelated tables. Deleting a referenced hero artwork clears only `selected_hero_artwork_id`. It never deletes an Asset Library Asset.

The existing game fields keep these roles:

- `developer`: game developer only;
- `release_date`: the earliest known official release date;
- `genres`: provider-normalized genre display text;
- `overview`: provider description;
- `my_score`: explicit user rating;
- `ExternalBinding.provider_data_json`: authoritative IGDB snapshot used for refresh reasoning and artwork reselection.

All IGDB platforms supplied for the selected game are stored and displayed. Lakomics does not choose only the first platform and does not add a platform-by-platform date model in this pass.

Provider refresh may update the binding snapshot and fill provider-owned fields that remain blank. It must not replace explicit user edits, `my_score`, selected cover, or selected hero.

## 5. Search and import flow

The game Library add menu contains:

- `IGDB에서 게임 추가`;
- `직접 입력`.

The IGDB dialog has three progressive stages in one shared dialog surface.

### Stage 1: Search

The user searches by title and chooses one result. Each candidate shows only the information needed to disambiguate it:

- cover thumbnail when available;
- title;
- earliest release year/date;
- developer when available.

Search thumbnails remain remote and temporary. They are not inserted into WorkArtwork or the Asset Library.

### Stage 2: Metadata and cover

Lakomics loads the selected game preview and shows normalized metadata. The user explicitly selects one cover candidate when candidates exist.

If IGDB supplies no cover, import remains available with a stable quiet placeholder. Lakomics does not block a valid game identity because artwork is missing.

### Stage 3: Hero

The user explicitly selects the hero.

- IGDB artworks are the normal hero candidates.
- Screenshots are not mixed into the artwork list.
- If no artwork exists, screenshots become the fallback candidate list.
- `hero 없이 가져오기` remains available in either case.

There is no automatic hero choice. The UI may preserve the user's current selection while moving between steps, but it must not preselect an image and silently commit it.

### Apply

On confirmation, the backend:

1. revalidates the game ID and chosen image IDs against the fetched preview;
2. prepares only the selected cover and selected hero files;
3. starts one Collection transaction;
4. creates the game Collection;
5. stores normalized game metadata;
6. stores the IGDB ExternalBinding and provider snapshot;
7. inserts the selected WorkArtwork rows and selection references;
8. commits the transaction;
9. deletes prepared files if validation or commit fails.

The result is immediately browsable offline. Candidate thumbnails and unselected originals are not retained.

## 6. Refresh and artwork reselection

Game refresh is manual and appears in the game detail's visible text-labelled management menu.

`IGDB 새로고침`:

- fetches a fresh normalized preview;
- updates the binding snapshot and sync timestamp;
- fills blank provider-owned Collection fields;
- leaves explicit user values, cover selection, and hero selection unchanged;
- leaves the existing local game usable when IGDB fails.

`표지·hero 변경` reopens the artwork selection portion of the IGDB flow for the existing binding. The user explicitly chooses a new cover and/or hero, or removes the hero. Selection changes use the WorkArtwork lifecycle and do not delete unrelated Assets or provider artwork still referenced elsewhere.

The first implementation does not poll IGDB in the background and does not download newly discovered artwork during refresh.

## 7. Game detail composition

The game detail replaces the central workspace while preserving the application shell, sidebar, stable toolbar height, back behavior, and Escape behavior established by the Collection Library.

### Hero

The selected hero is the dominant visual anchor. It spans the primary upper detail surface and receives only the minimum dark scrim required for readable title and facts. It must remain visibly more important than the package and metadata.

When no hero is selected, Lakomics renders a neutral game-detail background. It does not enlarge the portrait cover into a blurred pseudo-hero.

### Package

The selected cover appears inside a brand-neutral dark package made with CSS:

- authentic front cover insert;
- thin shell and restrained spine;
- shallow edge depth;
- weak material cue;
- grounded contact shadow.

The package never invents platform branding and never rotates far enough to expose a fake empty back or side.

In game detail, click/keyboard activation toggles a small lifted state of roughly 10–18 px with only a few degrees of Y-axis rotation. Pointer tilt after lift is restrained. Pointer leave returns to a stable pose. `prefers-reduced-motion` removes lift/tilt transitions and presents the same content without motion.

The normal Library card keeps the existing quieter package treatment and does not inherit detail motion.

### Metadata and actions

The supporting information is limited to:

- title;
- developer;
- publisher;
- earliest release date;
- all platforms;
- genres;
- personal rating;
- overview.

Missing values reserve no decorative empty cards and never block the detail.

The stable top toolbar retains navigation/close behavior only. The visible `작품 관리` menu contains:

- edit;
- add/remove Showcase;
- delete with confirmation;
- IGDB refresh or connection;
- cover/hero change.

No essential action is right-click only. Provider status and errors remain secondary to the artwork and local metadata.

The production detail does not add the prototype's official-artwork count, screenshot count, asset count chips, or gallery tabs. Only selected presentation artwork is retained in this pass.

## 8. Error and empty behavior

- Missing credentials route the user to the IGDB credential settings without exposing secrets.
- Invalid credentials, token failure, timeout, rate limit, unavailable service, not found, invalid image, and malformed response map to stable public command errors.
- Existing games remain browsable when any provider operation fails.
- Search failure preserves the query and dialog state where practical.
- Preview failure permits returning to results without closing the dialog.
- Import failure creates no Collection, binding, artwork row, or orphaned file.
- Refresh failure preserves the Collection row, binding snapshot, selected cover, selected hero, and cached files.
- Missing cover or hero renders a stable quiet placeholder rather than blocking the game.

## 9. Verification strategy

Verification remains targeted and proportional.

Backend coverage focuses on the real seams:

- IGDB response normalization and public error mapping;
- credential save/status/delete without value exposure;
- atomic Collection, binding, cover, and hero apply with file cleanup on failure;
- refresh preserving user values and artwork selections;
- migration compatibility for the new fields and hero foreign key.

Frontend coverage focuses on:

- the three-stage search/cover/hero selection flow;
- explicit selection and the no-cover/no-hero paths;
- game Library add-menu routing;
- hero-dominant detail semantics, package activation, management actions, and keyboard dismissal;
- reduced-motion behavior at the stylesheet contract level without brittle pixel-by-pixel assertions.

During implementation, run only the directly affected test file or smallest relevant Rust test target. Do not repeat a successful check unless later edits can invalidate it. Run the production build once after the final code change. Expand to broader tests only when a targeted failure identifies cross-Module risk.

## 10. Acceptance criteria

- The user can configure IGDB Client ID and Client Secret without either value entering SQLite or logs.
- The user can search IGDB and disambiguate game candidates.
- The user explicitly chooses the cover when candidates exist.
- The user explicitly chooses an artwork hero; screenshots appear only when no artworks exist.
- Games with no cover or no hero can still be imported.
- Apply stores one local Collection, one IGDB binding, normalized metadata, and only the selected presentation artwork.
- WorkArtwork remains outside the Asset Library.
- Game detail keeps hero artwork visually dominant and package/metadata secondary.
- The package is brand-neutral, restrained, keyboard operable, and reduced-motion safe.
- All IGDB platforms are displayed; the representative release date is the earliest official release.
- Manual refresh never replaces explicit user values, selected cover, or selected hero.
- Provider failure never makes an existing local game unusable.
- The top toolbar remains stable and provider/item actions live in the detail management menu.
