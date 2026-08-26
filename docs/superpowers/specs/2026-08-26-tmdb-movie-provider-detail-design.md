# TMDB Movie Provider and Detail Design

## Status

Approved product direction from the 2026-08-26 Collection v6 continuation. This is execution item 5 of `2026-08-25-collection-v6-production-design.md`: one complete movie provider flow, selected poster and backdrop artwork, and the movie-specific production detail.

This design follows `DESIGN.md`, `docs/agents/lakomics-works-handoff-v2.md`, and the visual intent of `docs/prototypes/lakomics-works-v6-reference.html`. It does not copy the prototype HTML or connect Collection to the Online Catalog.

## 1. Scope

This pass delivers:

- a user-configured TMDB API Read Access Token;
- TMDB-assisted movie search and import;
- Korean-first metadata with deterministic original/English fallback;
- explicit poster and backdrop selection in one preview stage;
- local metadata, binding, poster, and backdrop caching;
- connection of an existing manual movie to a selected TMDB identity;
- manual provider refresh that preserves user intent;
- poster/backdrop reselection;
- a movie-specific backdrop-dominant detail view.

The movie type includes live-action and animated feature films. TV series, TV animation series, seasons, and episodes are outside this pass. Manual movie creation remains available.

Explicit non-goals are:

- TV or multi-search endpoints;
- series, season, or episode persistence;
- a universal provider interface or a broad provider refactor;
- automatic periodic refresh;
- country-specific theatrical, streaming, or re-release date tracking;
- watch-provider availability;
- cast galleries, trailers, reviews, recommendations, or social data;
- retaining unselected provider images;
- a poster inspection viewer;
- connecting Collection to the Online Catalog.

## 2. Provider and authentication decision

TMDB is the sole movie provider for this pass. Lakomics uses the TMDB v3 movie search and movie detail APIs, authenticated with the application API Read Access Token as a Bearer token.

The token is stored through the existing OS-backed credential module. It is never stored in SQLite, provider snapshots, logs, frontend state returned by the backend, URLs, or public error messages. Settings expose only configured/unconfigured status and write-only token replacement or deletion.

The backend owns all TMDB requests. React never receives the token or an arbitrary provider URL.

Official API references:

- <https://developer.themoviedb.org/docs/authentication-application>
- <https://developer.themoviedb.org/reference/search-movie>
- <https://developer.themoviedb.org/reference/movie-details>
- <https://developer.themoviedb.org/reference/movie-images>
- <https://developer.themoviedb.org/docs/append-to-response>
- <https://developer.themoviedb.org/docs/image-basics>

## 3. Module seams

### TmdbClient

`TmdbClient` owns remote protocol details:

- Bearer authentication;
- movie-only title search;
- localized movie detail, credits, and image retrieval;
- poster/backdrop URL construction from validated TMDB file paths;
- response decoding and normalization;
- mapping authentication, rate-limit, timeout, unavailable, not-found, malformed-response, and invalid-image failures to stable library errors.

The client does not write Collection rows, manage transactions, select presentation artwork, or expose remote URLs to React.

### MovieImportFlow

`MovieImportFlow` owns local orchestration:

- normalizing search candidates and preview data;
- validating the selected TMDB movie and selected image paths;
- downloading and validating only the selected poster and backdrop originals;
- creating a new movie or attaching a TMDB binding to an existing manual movie;
- storing provider metadata, the TMDB binding snapshot, and selected WorkArtwork atomically;
- preserving user-owned values during connection and refresh;
- cleaning newly prepared files when validation or a transaction fails.

This remains TMDB-specific. Shared abstractions are extracted only if the implemented TMDB and IGDB flows expose a small, genuinely identical mechanism.

### Existing Library and UI seams

The existing Library owns Collection persistence, external bindings, WorkArtwork files, migrations, credentials, and public commands. React consumes narrow typed credential, search, preview, apply, connect, refresh, connection-status, and artwork-replacement operations through `LibraryGateway`.

Provider protocol and persistence logic do not move into `App.tsx`, `CollectionBrowser`, dialogs, or detail components.

## 4. Localization and metadata

Search and detail requests prefer Korean (`ko-KR`). Normalized text follows this fallback order when Korean data is absent or blank:

1. Korean-localized value;
2. original-language value supplied by TMDB;
3. English (`en-US`) value.

Search candidates show poster thumbnail when available, localized title, original title when different, and the representative release date. Search uses the movie endpoint only and excludes adult results by default.

The persisted movie presentation fields are:

- localized `name`;
- nullable `originalTitle`;
- `director`, containing at most two director names joined by ` · `;
- `productionCompany`, containing at most two production-company names joined by ` · `;
- one representative `releaseDate` from the normalized TMDB movie detail;
- nullable `runtimeMinutes`;
- normalized `genres`;
- localized `overview`;
- TMDB `externalScore` as reference metadata, normalized to the existing 0–100 integer convention by rounding `vote_average * 10`, or null when TMDB reports no votes;
- explicit user `myScore`, kept separate from the provider score.

This pass does not model country-specific release events. Sorting by movie date uses the single persisted representative release date.

## 5. Artwork model and lifecycle

Movie poster and backdrop are distinct presentation roles:

- the poster uses `WorkArtwork(kind='cover')` and the existing `selectedWorkArtworkId` projection;
- the backdrop uses `WorkArtwork(kind='backdrop')` and a new nullable `selectedBackdropArtworkId` projection.

The game-specific `hero` kind and `selectedHeroArtworkId` are not reused for movie backdrops. The selected-per-kind WorkArtwork constraint continues to allow at most one selected poster and one selected backdrop for a movie.

Search thumbnails and preview candidates are temporary. On apply, Lakomics downloads only the explicitly selected poster and backdrop originals. Either selection may be omitted, and missing provider artwork never blocks a valid movie import or connection. Provider artwork remains outside the Asset Library unless the user explicitly promotes it through normal Asset ingestion.

Changing or clearing one artwork kind leaves the other kind and unrelated Assets untouched. A provider refresh never changes either selected artwork.

## 6. New movie import

The movie Library add menu contains:

- `TMDB에서 영화 추가`;
- `직접 입력`.

The TMDB dialog has two stages.

### Stage 1: Search

The user searches for a movie and explicitly selects one result. Candidates contain only the fields needed to disambiguate identity: poster thumbnail, localized title, original title when different, and representative release date.

### Stage 2: Preview and artwork

Lakomics shows normalized movie metadata and separate poster/backdrop candidate groups. Neither group silently preselects its first item. The user may explicitly select an image or choose no image for either role. If one group has no candidates, its no-image decision is implicitly valid.

### Apply

On confirmation, the backend:

1. refetches and validates the TMDB movie identity;
2. verifies selected image paths belong to that preview;
3. rejects a TMDB identity already bound to another Collection;
4. prepares only the selected poster and backdrop files;
5. opens one transaction;
6. creates the movie Collection;
7. stores normalized metadata and the TMDB ExternalBinding snapshot;
8. inserts and selects the prepared WorkArtwork rows;
9. commits and disarms prepared-file cleanup.

The result is immediately browsable offline. A post-commit UI refresh or obsolete-file cleanup failure must not report the successful mutation as failed.

## 7. Connecting an existing manual movie

An existing movie without a TMDB binding exposes `TMDB에 연결` in its visible management menu. It reuses the same two-stage search and preview dialog, with the existing Collection as the target.

Connection follows these rules:

- the target must be a movie and must not already have a TMDB binding;
- the chosen TMDB identity must not belong to another Collection;
- explicit title, description, and personal rating are preserved;
- blank director, production company, release date, runtime, genres, and overview fields may be filled;
- poster and backdrop change only when the user makes an explicit artwork decision;
- the binding, provider metadata, and selected artwork changes commit atomically.

Closing or navigating away after the backend succeeds cannot convert the completed connection into an error state.

## 8. Refresh and artwork replacement

Connected movie details expose `TMDB 새로고침` and `포스터·배경 변경`.

Refresh compares the previous provider snapshot, the new normalized provider data, and the current Collection value. A field may follow the provider only when the current value still equals the previous provider value or is blank without evidence of an explicit user clear. User-edited or explicitly cleared values remain unchanged.

Refresh may update:

- original title;
- director;
- production company;
- representative release date;
- runtime;
- genres;
- overview;
- TMDB external score in the normalized 0–100 convention;
- the provider snapshot and sync timestamp.

Refresh never changes the local title, description, personal rating, poster, or backdrop. Provider failure leaves the existing local movie usable.

Artwork replacement refetches the preview, validates new selections, and changes only the kinds explicitly marked select or clear. A keep decision performs no write for that kind.

## 9. Movie detail presentation

The approved visual direction is the backdrop-dominant overlay layout, option A from the design session.

- A wide selected backdrop is the primary visual anchor.
- A restrained readability scrim sits over the backdrop without decorative glass surfaces or unrelated gradients.
- The poster and compact identity block sit near the lower edge of the backdrop.
- The identity block shows localized title, original title when different, release date, runtime, director, and production company when present.
- Genres, TMDB reference score, personal rating, and overview continue in the body below.
- Missing metadata produces no empty cards.
- A missing backdrop uses a neutral token-based surface and never stretches or blurs the poster as a substitute.
- A missing poster uses a stable quiet placeholder.

Movie posters remain flat. The game package lift/tilt and manga collectible-cover behavior are not applied to movies. A poster inspection viewer remains a future feature only if real use justifies generalizing the existing cover viewer.

The visible text-labelled `작품 관리` menu contains:

- edit;
- add/remove Showcase;
- delete;
- `TMDB에 연결` for unconnected manual movies;
- `TMDB 새로고침` and `포스터·배경 변경` for connected movies.

The application top bar remains stable. No important action is right-click only. Focus, keyboard activation, Escape/back navigation, and `prefers-reduced-motion` follow existing shared behavior.

## 10. Error and security behavior

Public failures distinguish missing credentials, unauthorized credentials, rate limiting, timeout, provider unavailability, not found, malformed response, invalid identity, and invalid image selection without exposing tokens, response bodies, or internal URLs.

The settings UI never reads the stored token back into an input. Provider-image preview routes accept only validated TMDB image identities and fixed poster/backdrop variants. React cannot proxy an arbitrary remote URL through the media protocol.

All local mutations use a transaction. Newly prepared files are cleaned on pre-commit failure, while post-commit cleanup is best-effort and cannot reverse or misreport a completed mutation.

## 11. Verification boundaries

Verification remains deliberately narrow.

During implementation:

- use one focused Rust client check for normalization and secret-safe errors;
- use one `MovieImportFlow` module group for import, manual connection, user-value preservation, artwork isolation, and cleanup;
- use directly affected React test files for the two-stage dialog and movie detail orchestration;
- skip automated tests and production builds for visual-only CSS adjustments unless compile or behavioral risk is identified;
- do not rerun a successful check unless later edits invalidate it.

Final verification consists of:

1. one focused `MovieImportFlow` Rust module filter;
2. one focused frontend group covering the TMDB dialog and movie detail/overlay;
3. one TypeScript/Vite production build.

The full Rust or frontend suite is run only when a failure or concrete cross-module risk warrants expansion. Live TMDB success is reported only if exercised with a configured user token.

## 12. Acceptance criteria

- Movie search never returns TV series or TV animation series.
- Live-action and animated feature films can both be imported.
- Korean metadata is preferred with deterministic original/English fallback.
- Search candidates distinguish localized and original titles.
- Poster and backdrop decisions are explicit, independent, and optional.
- Only selected artwork originals are retained locally.
- A new import creates one movie, one TMDB binding, and only selected WorkArtwork atomically.
- A manual movie can connect to TMDB without losing user title, description, or personal rating.
- Duplicate TMDB identities are rejected.
- Refresh preserves user edits, explicit clears, personal rating, poster, and backdrop.
- Existing local movies remain usable during TMDB failure.
- Movie detail keeps the backdrop dominant and the poster flat.
- Missing backdrop never reuses a blurred or enlarged poster.
- TMDB reference score never drives personal-rating filtering or sorting.
- Credentials and remote error bodies never reach logs, SQLite, provider snapshots, or React.
- Online Catalog remains independent from Collection.
