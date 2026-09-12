# Lakomics — Works / Collection Reference

> Status: current product/architecture/UX reference. Updated 2026-08-31. This is not a backlog.
> Retained product/interaction reference: `docs/prototypes/lakomics-works-v6-reference.html`.
> Current PC visual/UX rules: `docs/agents/pc-design-reference.md` (2026-09-06), with type-specific presentation in `docs/agents/works-viewer-design.md`. Historical Lab/Works prototypes do not override the domain/ownership contracts below.

## Product boundary

Lakomics has two connected but distinct pillars:

- **Asset Library** — user-collected media files, provenance, classification, albums, duplicate handling, trash, viewers, and media-vault lifecycle.
- **Collections / Works** — games, manga, and movies the user cares about, with type-specific metadata and presentation artwork that can link to existing Assets.

Do not collapse Asset, Classification, Album, Collection/Work, WorkArtwork, Volume, or ExternalBinding into one concept merely because they are related.

Current implemented Collection types are game, manga, movie, and AV. AV supports manual metadata, ID-based people/role/order relations, and explicitly selected local front/spine/back artwork. Its current focused viewer snaps to the actual surface using the shared package renderer; original-image viewing remains available. External AV providers and arbitrary-angle rotation are not implemented. AV is excluded from the Mobile Collections replica, but remains part of full PC metadata recovery backups; this is not an encrypted vault. Artwork bytes need the existing separate library-file backup. Native production-library and device acceptance remain separate from implementation checks. Future collection types or specialized presentation systems belong in the roadmap until implemented.

The `movie` persistence type now contains Film and TV Series (2026-09-06). TMDB's
numeric movie binding identity is preserved; TV identities use `tv:ID`. Media type
must accompany searches/previews and is validated during apply/refresh/artwork updates.
Series season/episode data is cached in the provider snapshot, with season posters
stored as Collection-owned artwork. Preview/artwork selection does not fetch all
episodes; explicit import/refresh performs the full season sync. Normal viewing reads
the local snapshot with a compact paged episode list, including when offline.

## Provider and ownership rules

A Collection may have multiple external bindings. Provider protocol details belong in provider modules/flows, not `App.tsx` or large UI components.

Stable rules:

- cache provider data needed for normal browsing locally;
- existing Collections remain usable when providers/network fail;
- provider refresh must not silently erase explicit user edits or presentation choices;
- preserve provider identity/raw snapshot data needed to reason about refreshes and migrations;
- avoid unnecessary polling;
- do not invent generic provider abstraction layers before a second real use case proves the common interface.

Provider-derived metadata, explicit user edits/overrides, and presentation selections are different ownership domains. Editing one field must not erase unrelated provider data; refresh must not overwrite explicit user intent.

## Work artwork

Provider/local artwork used for covers, hero images, backdrops, screenshots, logos, or manga volume covers is presentation data first, not automatically an Asset.

Cache artwork locally for fast/offline Collection presentation without polluting the Asset Library. Only explicit user import/promotion should turn it into an Asset.

Different presentation roles may use different artwork; game hero/main artwork is independent from the smaller package/cover image.

## Manga

- MangaDex is useful for work identity/general manga metadata.
- Kakao book search supplies Korean commercial edition/release tracking. Legacy Aladin bindings and source snapshots are retained for existing collections.
- These providers are complementary and can coexist on one Collection.
- New connections use Kakao REST API credentials stored separately as `Lakomics/KakaoBooks`. Legacy Aladin credentials are not overwritten or deleted.
- Existing Aladin-linked collections require an explicit Kakao series selection; title similarity alone never migrates their provider identity. Connecting Kakao preserves volume IDs/artwork and transfers an existing release watch without creating notifications for the initial import.
- Daily desktop refresh checks all MangaDex/Kakao-linked manga, including works without notification subscriptions, after 24 hours since the last successful provider refresh. Startup/hourly checks continue in bounded batches while the app runs. Legacy-only Aladin connections remain dormant until reconnection.
- MangaDex records newly seen Japanese cover volume slots separately from Korean releases. Its first refresh establishes a quiet baseline; cover replacement or reappearance does not repeat an alert. Metadata pagination reads beyond the first 100 covers. Daily refresh updates metadata/volume rows, without downloading every cover image.
- Kakao creates events only when the work has an explicitly entered owned count and an enabled release subscription. Schema v73 records count entry independently, including zero; existing ownership rows become tracked. An old unrecorded zero cannot be recovered as explicit entry. Future publication dates are treated as upcoming when supplied by Kakao, without promising advance coverage.
- MangaDex and Kakao notifications occupy separate title-only lists in the manga Collection content area, using the shared virtual grid. Clicking a title opens the work and keeps the notification unread; explicit confirmation acknowledges only the captured provider-specific events. Back navigation returns to the notification view.
- Provider refresh status retains request counts, processing/network/pacing times and remaining works. Metadata clients share connection pools and request pacing (MangaDex 250ms, Kakao 100ms); temporary transport/server failures retry after 5s, 30s, 2m, then 10m; quota failures back off from 1m to 15m and honor server retry deadlines (up to 24h). Authentication/access failures retain a one-hour wait. The app schedules the earliest pending retry instead of waiting for its hourly pass. Safe failure details retain the affected collection, request stage, HTTP code or transport category; request URLs, queries, credentials and raw bodies are never recorded. Legacy generic transport cooldowns use the new short retry policy. Individual invalid/missing works are deferred for 24 hours so later works can proceed. These are app-running checks, not OS notifications or off-app scheduling.
- The manga ownership row exposes a persistent `신간 알림` checkbox beside the owned count; Kakao connection is required. The redundant subscription status block and upcoming-release line are omitted. Collection rating filters use a square-thumb horizontal slider with ten half-point cells, plus all/unrated presets.
- Verification for the daily update change is recorded in `docs/performance/collection-daily-updates-20260913.md`; native application/production migration acceptance is separate.
- Kakao search follows all result pages (`size=50`, at most 50 pages); incomplete results fail rather than silently apply. Publisher/author/title groups remain distinct. Covers remain owned by the current artwork selection; Kakao thumbnail URLs in raw snapshots are not automatically applied.
- Schema v40 expands the release subscription provider constraint without rewriting legacy sources. Applying it to an active library requires the separate operational approval in `AGENTS.md`.
- Volume is a first-class concept; stable volume identity/order must not regress to loose filename labels.
- Manga volume shelves are ordered primarily by volume number, not a generic date rail.
- Clicking a manga cover is primarily collectible/cover appreciation, not a metadata-dialog action.

Cover inspection may use restrained zoom/lift, small 3D response, dimmed background, previous/next navigation, and subtle shadow/glare consistent with `DESIGN.md`.

## Games

Game detail should keep selected hero/main artwork visually dominant.

- Hero/main artwork: identity and atmosphere.
- Cover/package: collectible physical-object representation.
- Metadata: supporting information.

When only front cover art exists, a brand-neutral package shell/depth effect is acceptable. Do not invent platform branding or rotate far enough to expose large fake side/back artwork.

## Movies

Movies remain primarily poster/backdrop driven in normal browsing. Do not force manga-book or game-package effects onto ordinary movie screens solely for cross-type consistency.

A future physical-media/Blu-ray/DVD presentation is a separate intentional presentation preset, not a reason to redesign current movie browsing now.

## Collection browsing and Showcase

Type-specific browsing remains the default. Do not add a mandatory mixed all-Works grid that ignores incompatible media proportions without a clear user benefit.

Showcase is a personal exhibition:

- membership is manual;
- ordering is manual;
- exhibitions remain type-aware;
- it is not an automatic favorites filter or ranking table;
- clicking an exhibited Collection opens the normal detail model;
- richer presentation is allowed because appreciation/exhibition is the purpose.

## Presentation evolution

Normal Lakomics UI still follows `DESIGN.md`: dense desktop tool, media-first hierarchy, restrained chrome, stable browsing, minimal decorative motion.

Collection-specific collectible presentation is a limited semantic exception. The roadmap may evolve this into reusable `collectionType → presentation preset` behavior (for example game package, manga book, movie physical media, or future AV DVD cases), but ordinary controls, settings, Asset tiles, and navigation must not inherit broad 3D decoration.

Implement richer shelf/display modes only after reusable presentation primitives exist; do not build one-off 3D effects independently per screen.

## Online Catalog boundary

The Online Manga Catalog is separate from Works/Collection provider bindings. Heliotrope/VPS catalog work belongs to the online-catalog architecture and must not silently create or mutate Collections, bookmarks, or reading progress outside their owned data paths.

## Implementation cautions

- `App.tsx` remains orchestration, not provider protocol/business-logic storage.
- Provider clients/flows own remote protocol details.
- Collection/library modules own persistence and invariants.
- Artwork lifecycle stays behind its owning module boundary.
- UI consumes narrow contracts and shared controls/tokens.
- Before schema/contract changes, inspect migrations, Rust models, TypeScript types, and update semantics together.
- Preserve user data, explicit presentation choices, and existing provider bindings across unrelated edits.

## Consistency checklist

For relevant Collection changes verify that:

- unrelated edits do not erase imported metadata/provider identity;
- multiple provider bindings can coexist;
- provider refresh preserves user intent;
- provider artwork stays separate from Assets unless explicitly imported;
- manga volumes keep stable identity/order;
- release checks avoid excessive polling;
- type-specific browsing remains coherent;
- Showcase membership/order remain user-controlled;
- collectible motion stays localized and restrained;
- ordinary Lakomics UI still follows `DESIGN.md`.

Use `docs/roadmap/lakomics-backlog.md` for planned Collection improvements and long-term presentation ideas rather than turning this reference into a task list.
