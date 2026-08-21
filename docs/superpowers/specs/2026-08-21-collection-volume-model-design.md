# Collection Volume Model Design

## Goal

Make manga volumes first-class local records instead of deriving the Work experience from cover filenames. A manga Work opens immediately with its representative cover, then fills supported Japanese volume-cover slots from the stored MangaDex snapshot without making ordinary browsing depend on the network.

This is Works v2 P3. It establishes volume identity, ordering, artwork ownership, legacy adaptation, and the existing four-drawer behavior. It does not implement Aladin release tracking or the final collectible cover viewer.

## Domain Decisions

A `Volume` is the numbered manga installment. An `Edition` is a base or alternate release of that same installment, not another Volume.

The schema is a flattened persistence model: rows with the same `collection_id` and `volume_number` belong to one domain Volume, while `edition_index` distinguishes its displayed editions. P3 does not add an otherwise empty parent row for the Volume.

The local identity is a pair:

```text
(volume_number, edition_index)
```

Examples:

```text
1   -> volume_number 1, edition_index 0
1.1 -> volume_number 1, edition_index 1
1.2 -> volume_number 1, edition_index 2
1.3 -> volume_number 1, edition_index 3
```

MangaDex's `volume` value is the provider authority for this mapping. P3 accepts positive integer labels and the exact decimal suffixes `.1`, `.2`, and `.3`. Values such as `.01`, `.4`, and `.5` remain preserved in the provider snapshot but do not create local Volume rows or trigger downloads in this phase.

Each supported slot has one representative cover. If multiple source covers claim the same slot, the first eligible source item in its stable source order wins. Extra local originals and provider metadata remain untouched.

## Considered Approaches

### 1. One Volume table with an edition slot — selected

Store one row per `(volume_number, edition_index)`. This gives stable numeric ordering and exactly models the four existing drawers without introducing a second table that has no independent behavior yet.

### 2. Separate Volume and Edition tables

This expresses the hierarchy literally, but adds joins, lifecycle rules, and identifiers for an Edition entity whose current behavior is only a fixed slot under a Volume. It can be introduced later if Aladin or user editing gives editions independent metadata and behavior.

### 3. Keep a string `volumeLabel`

This matches the legacy filenames but leaves ordering, validation, provider matching, and edition grouping scattered through the UI and filename parser. It does not satisfy P3's first-class model requirement.

## Persistence

Schema v15 adds `collection_volumes`:

```text
collection_volumes
- id TEXT PRIMARY KEY
- collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE
- volume_number INTEGER NOT NULL
- edition_index INTEGER NOT NULL CHECK (edition_index BETWEEN 0 AND 3)
- sort_order INTEGER NOT NULL
- cover_artwork_id TEXT REFERENCES collection_work_artworks(id) ON DELETE SET NULL
- source_provider TEXT
- source_cover_id TEXT
- source_file_name TEXT
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- UNIQUE (collection_id, volume_number, edition_index)
```

`volume_number` must be positive. `edition_index` is zero for the base edition and one through three for alternate editions. `sort_order` is deterministic from the numeric pair and exists so the repository owns ordering rather than every caller repeating it. The displayed label is derived from the pair; it is not stored as a second source of truth.

A Volume row can exist before its cover download completes, so `cover_artwork_id` is nullable. Provider source fields preserve the chosen MangaDex cover identity needed to resume a missing download. A legacy row instead records its original filename in `source_file_name`. P4 may add title, ISBN13, release dates, provider item identity, and release status when Aladin provides real behavior for those fields; P3 does not add empty speculative columns.

## Artwork Ownership

Volume cover files use the existing `collection_work_artworks` storage and media route. They do not become Asset Library assets.

- The representative cover already downloaded during Work creation can be referenced by the matching base Volume row even when that artwork's kind remains the selected Work cover.
- Other downloaded volume covers are stored as non-selected `volume_cover` WorkArtwork records.
- A Volume points to one WorkArtwork through `cover_artwork_id`; artwork rows do not need a new reverse `volume_id` column.
- Removing an artwork clears the Volume reference through `ON DELETE SET NULL`, leaving the Volume available for a later retry.

This avoids duplicating the representative image and keeps file lifecycle inside the existing WorkArtwork module.

## MangaDex Materialization and Sync

The authoritative MangaDex detail snapshot already stored in the Work's ExternalBinding contains cover IDs, filenames, locale, and volume labels. P3 uses that local snapshot before considering a network request.

When a new MangaDex Work is created or an existing bound Work first loads its volumes:

1. Read Japanese (`ja`) cover records from the stored snapshot.
2. Parse only supported labels: positive integers and `.1` through `.3`.
3. Choose the first eligible cover for each slot in snapshot order.
4. Upsert the corresponding Volume rows without requiring the images to be present.
5. Attach the existing representative Work cover to its matching base slot when identities match.
6. Return the rows immediately so the detail UI can render covers and empty slots.
7. Start one sequential sync attempt for supported rows whose artwork is still missing.

The sync downloads original Japanese cover images one at a time. Each successful image and Volume attachment is committed before moving to the next row. One failed item does not block later items. The result reports completed, skipped, and failed counts.

There is no persistent queue, worker, scheduler, or automatic polling. Refreshing or reopening the Work starts another attempt for still-missing rows. Completed rows are not downloaded again. If the provider snapshot itself is absent, the existing Work remains usable and sync reports that there is nothing local to materialize rather than erasing data.

## Legacy Cover Adaptation

Existing manga folders continue to work without an eager database-wide migration.

The first volume load for a Collection performs an idempotent lazy adaptation inside the Volume module:

1. Scan the Collection's existing cover filenames with the current legacy parser.
2. Accept only integer, `.1`, `.2`, and `.3` labels.
3. For each unoccupied slot, copy the first matching local cover into managed WorkArtwork storage and create or update its Volume row.
4. Leave all original files in place, including duplicates and unsupported labels.
5. Record enough source identity to avoid copying the same selected file again.

Local artwork wins. A later MangaDex materialization may fill empty slots, but it never replaces a Volume cover selected from the user's existing files. Provider candidates for occupied slots remain available in the raw snapshot. If several local files map to one slot, the first file in the existing stable scan order becomes representative; the rest remain recoverable in their original folder.

## Module Interface

The frontend receives a narrow Collection Volume interface:

```text
listCollectionVolumes(collectionId)
syncMangaDexVolumeCovers(collectionId)
```

`listCollectionVolumes` is a prepare-and-list operation: internally it performs the idempotent legacy adaptation and local snapshot materialization before returning ordered Volume records. Callers do not parse filenames, inspect provider JSON, copy files, or query WorkArtwork directly.

`syncMangaDexVolumeCovers` performs one resumable sequential attempt for missing provider-backed covers and returns counts. It owns provider-label parsing, download validation, managed-file persistence, and per-item transaction boundaries. The UI may call it asynchronously after the initial list has rendered, then refresh the returned Volume list as items complete or after the attempt finishes.

No generic provider-volume abstraction is added in P3. MangaDex is the only real volume source today; P4 can extract a shared capability only where Aladin demonstrates one.

## UI Behavior

P3 preserves the current manga detail composition and the v6 reference's dense four-drawer shelf concept. It changes the data source, not the whole screen.

- The large existing hero/viewer remains visible immediately.
- The cover grid consumes Volume IDs, derived display labels, and WorkArtwork media URLs rather than filenames.
- Drawer 1 shows base editions, drawer 2 shows `.1`, drawer 3 shows `.2`, and drawer 4 shows `.3`.
- Each drawer sorts by `volume_number`; drawer 1 is selected by default.
- Rows whose cover is not downloaded yet can appear as quiet placeholders while the sequential sync runs.
- The current editable `권 번호` field is removed because it only changes React-local state and falsely implies persistence. The panel shows the selected Volume label and cover count as read-only information instead.

The P7 cover-appreciation transition, pointer tilt, glare, left/right viewer navigation, and broader type-specific detail production pass remain out of scope. P3 does not redesign the screen beyond the data-driven states required by the new model.

## Error Handling and Safety

- Invalid and unsupported provider labels are ignored for local rows but remain in the raw snapshot.
- A malformed provider record cannot prevent valid sibling records from materializing.
- Network or image-validation failure leaves the Volume row and existing artwork unchanged and retryable.
- A sync never replaces a non-null local-first cover reference.
- A failed per-item database write does not roll back covers already completed in earlier items.
- Repeated list and sync calls are idempotent for already materialized rows and stored artwork.
- Existing Work browsing remains available offline.

## Verification

Verification follows the repository's targeted policy:

- one focused v14-to-v15 migration test for the table, constraints, and artwork delete behavior
- focused Volume module coverage for supported-label parsing, numeric ordering, lazy local precedence, provider materialization, and retrying only missing items
- the affected Collection UI test file for drawer mapping, ordering, placeholders, and removal of the false editable volume field

Run only the smallest relevant Rust test target and affected frontend test file during iteration. Do not run the full suite or production build unless a targeted failure reveals broader impact.

## Success Criteria

- Volume identity and ordering no longer depend on filenames in the UI.
- Labels `1`, `1.1`, `1.2`, and `1.3` map to one numbered Volume with four edition slots.
- Unsupported decimals stay preserved without being downloaded or deleted.
- The Work detail opens before remaining cover downloads finish.
- Missing Japanese covers download sequentially and resume after interruption without repeating completed work.
- Local legacy covers take precedence and their original files remain untouched.
- The four drawers show the correct edition slot in numeric volume order.
- Volume covers remain WorkArtwork rather than Asset Library assets.

## Deferred Work

- Aladin metadata, ISBN13, Korean release dates, preorder status, and Release Watch (P4)
- independent Edition entities or editable edition metadata
- unsupported MangaDex decimal suffixes beyond `.1` through `.3`
- manual duplicate-cover selection within one slot
- final manga cover inspection motion and the broader production detail UI (P7)
