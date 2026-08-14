# Asset Source and Provenance Metadata Design

## Goal

Extend Lakomics asset metadata with the source publication time, creator identity, and ingestion provenance needed to understand where an asset came from and when it originally appeared. Show these values in the existing asset inspector and allow users to correct source-facing metadata without making system provenance editable.

This work also establishes the metadata fields needed by the one-time legacy Lakomics image migration. Notes, external popularity counts, ratings, bookmarks, and a general-purpose metadata bag are outside this design.

## Asset Metadata

Add nullable fields to the managed asset record:

- `source_published_at`: the date and time the source post was published;
- `creator_name`: the creator's display name;
- `creator_handle`: the creator's account identifier, stored without presentation assumptions;
- `creator_url`: the creator's profile or canonical page URL;
- `import_source`: a controlled ingestion-origin value;
- `import_batch_id`: an opaque identifier shared by assets processed in one ingestion run;
- `original_modified_at`: the source file's modification time observed before ingestion.

The existing fields retain their current meanings:

- `source_url` is the page or post where the asset was found;
- `collected_at` is when the asset entered the Lakomics library;
- `favorite` remains the user's personal preference and is not an external like count.

All new fields are optional so existing libraries migrate without fabricated values. An absent value is different from an empty value and is rendered as unavailable.

## Ingestion Provenance

`import_source` is system-owned and uses stable internal values mapped to Korean UI labels. The initial values are:

- `direct`: direct file drop or ordinary file selection;
- `browser_extension`: live browser-extension ingestion;
- `metadata_import`: extension metadata-folder import;
- `legacy_lakomics`: the one-time legacy Lakomics migration.

Unknown legacy rows remain null rather than being guessed. Display labels are presentation data and are not persisted.

Each user-visible ingestion run creates one UUID `import_batch_id` and applies it to every newly added asset in that run. A single direct-file ingestion still receives a batch identifier. `original_modified_at` is read from the source file before copying it into the media vault.

Exact duplicates do not create a second asset or overwrite the original asset's ingestion provenance. A metadata import that already has explicit duplicate-enrichment behavior may update source-facing metadata, but it must preserve `import_source`, `import_batch_id`, and `original_modified_at` on the existing asset.

## Source Metadata Input

Ingestion requests accept optional source-facing metadata:

- source publication time;
- creator display name;
- creator handle;
- creator URL.

Callers pass only values they actually know. Lakomics may derive a creator handle from a source URL only when the URL structure identifies the account unambiguously. Generic `/i/status/...` links, redirects, and unfamiliar hosts are not guessed.

Source and creator URLs must use `http` or `https`. Timestamps must parse as RFC 3339 before they reach persistence. Invalid optional metadata is rejected by explicit validation rather than silently stored in a malformed form.

The current extension metadata version does not contain all new values. Supporting future extension fields remains a contract-version change and is not simulated by scraping remote pages during ingestion.

## Editing

The asset inspector provides a quiet `편집` action for a single selected asset. Edit mode exposes:

- 게시 시각;
- 제작자 이름;
- 계정명;
- 제작자 URL.

The existing source URL remains visible and retains its current open action. This scope does not add source URL editing.

Saving submits one metadata patch through the library interface. Empty input clears the corresponding optional value. Cancel restores the persisted values. Validation errors stay within the inspector, preserve the user's draft, and do not change the asset. A failed save leaves persisted data unchanged and returns the inspector to neither a false success state nor stale displayed values.

System provenance is always read-only:

- 가져온 방식;
- 가져오기 묶음;
- 원본 수정 날짜.

## Asset Inspector

Keep the current inspector as one compact information sheet. Do not introduce cards, shadows, or a separate dialog.

For a single selected asset, the metadata rows appear in this order:

1. 파일명;
2. 출처;
3. 제작자;
4. 게시 날짜;
5. 가져온 날짜;
6. 가져온 방식;
7. 원본 수정 날짜;
8. 크기;
9. 가져오기 묶음, only when present.

The creator row prefers the display name, appends the handle when both exist, and falls back to the handle. When `creator_url` is valid, the creator value opens that URL. Missing values render as `—`. Dates use the existing local-date presentation; batch IDs use compact technical typography and may wrap or be copied without widening the inspector.

Edit controls replace only the four editable source-facing rows. Save and cancel use existing shared button interfaces. The panel remains keyboard reachable, and Escape exits edit mode before it closes the inspector.

Multi-selection continues to show only the current selection summary and organization controls. Bulk source-metadata editing is excluded.

## Library Interface

Keep persistence, validation, and SQLite access inside the library module. Add a focused asset-metadata patch operation rather than exposing SQL-shaped fields to the frontend.

The asset summary returned by list queries includes the new display fields so opening the inspector does not cause stale data. The patch operation returns the updated asset summary, allowing the gallery, inspector, and open viewer state to converge without a full-library reload.

Schema migration adds nullable columns and must be idempotent for existing libraries. Rotating metadata backups continue to include the entire SQLite database, so no separate backup format is required.

## One-Time Legacy Migration

The legacy migration assigns:

- `import_source = legacy_lakomics`;
- one shared `import_batch_id` for the migration run;
- each file's observed modification time to `original_modified_at`;
- source URL and custom title through their already compatible fields;
- creator data only when it can be derived unambiguously from the stored source URL;
- source publication time only when the legacy metadata contains an explicit trustworthy value.

The migration must not reinterpret the legacy file modification time as the source publication time. Missing creator and publication data remain null.

## Error Handling

- Reject malformed creator URLs and source publication timestamps before writing.
- Apply an asset metadata patch in one SQLite transaction.
- Return asset-not-found when the asset was removed while being edited.
- Treat an unknown `import_source` value as unavailable in the UI while preserving the stored value for forward compatibility.
- Never overwrite system provenance through the user-edit command.

## Testing

Rust tests cover:

- schema migration of an existing database;
- persistence and clearing of every editable field;
- URL and timestamp validation;
- atomic failure behavior;
- system provenance recording for each ingestion origin;
- one batch ID shared across a multi-file run;
- preservation of original provenance during exact-duplicate enrichment;
- source-file modification time capture.

Frontend tests cover:

- display and fallback formatting for creator, dates, origin, and batch ID;
- creator-link opening;
- entering, cancelling, and saving edit mode;
- clearing optional values;
- inline validation and failed-save behavior;
- Escape leaving edit mode before closing the inspector;
- unchanged multi-selection behavior.

Integration verification covers direct ingestion, browser-extension ingestion, metadata-folder ingestion, and the one-time legacy migration against a disposable library.

## Scope

Included:

- source publication time;
- creator display name, handle, and URL;
- system-owned ingestion origin, batch ID, and original modification time;
- compact display in the existing asset inspector;
- single-asset editing of source-facing metadata;
- legacy migration population rules.

Excluded:

- asset notes;
- multiple source records per asset;
- source URL editing;
- external like counts or ratings;
- creator entities or creator browsing screens;
- arbitrary metadata key/value storage;
- bulk metadata editing;
- remote metadata fetching or source-page scraping.
