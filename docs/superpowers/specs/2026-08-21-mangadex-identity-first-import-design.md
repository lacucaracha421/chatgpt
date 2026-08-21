# MangaDex Identity-First Import Design

## Goal

Make MangaDex import identify and register a manga without loading a cover gallery. Registering a Work downloads at most one representative Japanese cover, so choosing a search result stays responsive.

## Scope

This change corrects the existing P2 MangaDex provider flow. It does not introduce the P3 `Volume` model or download every volume cover.

Included:

- text-only MangaDex search results
- selection by Work identity in a compact single-column result list
- automatic representative Japanese-cover selection during apply
- successful Work registration when MangaDex has no Japanese cover
- the same behavior for new Works and connections to existing manga Works

Deferred to P3:

- downloading all Japanese volume covers
- first-class volume and edition records
- grouping old, revised, and alternate editions such as `1.1` and `1.2`
- migration from filename-derived cover shelves

## Interaction Design

The dialog follows the v6 reference prototype's dense desktop layout and direct selection flow. The user's performance preference takes precedence only over the prototype's small result thumbnails, which are omitted.

1. The user searches MangaDex by title.
2. A short MangaDex provider note sits beneath the search row, matching the reference hierarchy.
3. Results appear as one compact, full-width list. Each text row contains title, author, year, and `MangaDex`; it contains no thumbnail.
4. Selecting a row visibly marks that row and enables `작품 만들기` or `연결`. There is no second column, metadata detail pane, cover gallery, or cover-selection step.
5. A new Work uses the selected result's title. Title editing remains available later through the existing Work edit flow.
6. Applying closes the dialog only after the Work and provider binding are saved. Existing error behavior keeps the selection available for retry.

The dialog keeps the reference's restrained width, compact row height, separators, small typography, and quiet selection treatment using existing shared controls and design tokens. It adds no decorative cards, large radii, shadows, gradients, or motion. The reference's manga/game/movie provider segment is deferred until another provider flow exists; inactive controls are not added for appearance alone.

## Data Flow

Search remains a bounded MangaDex title request. Selecting a result is local UI state only: it makes no detail, cover-list, or image request. The apply command fetches the authoritative Work metadata and cover records once after the user confirms creation.

The apply request carries the target and MangaDex Work ID, not a user-selected cover ID. The backend fetches the authoritative Work snapshot and chooses a representative cover using this rule:

1. consider only covers whose locale is exactly `ja`
2. prefer volume `1`
3. otherwise use the first Japanese cover returned by MangaDex
4. if no Japanese cover exists, continue without artwork

When a cover is selected, only that original image is downloaded, validated, stored as `WorkArtwork`, and selected for the Work. Work creation, external binding, metadata snapshot, and optional artwork selection remain one database transaction. A failed artwork download fails the apply operation rather than creating a partially connected Work. When no Japanese cover exists, no artwork file is prepared and the transaction saves the Work and binding normally.

Refresh behavior remains unchanged: refresh updates the provider snapshot and blank provider-owned metadata fields without replacing user values or selected artwork.

## Interfaces and Ownership

- `MangaDexImportDialog` owns search, selection, busy state, and retry state. It does not own title editing, metadata preview, cover selection, or image fetching.
- `MangaDexApplyRequest` owns the target and MangaDex identity only.
- The Rust MangaDex flow owns Japanese-cover selection because provider locale semantics and artwork download policy belong behind the library interface.
- Existing `WorkArtwork` storage remains the sole owner of downloaded representative artwork.

No new dependency, background queue, schema, provider abstraction, or UI component is introduced.

## Error Handling

- Empty searches keep the current inline validation.
- Search failures remain visible in the dialog.
- Apply failures preserve the selected Work for retry.
- No Japanese cover is a valid no-artwork outcome, not an error.
- Invalid provider identities, duplicate bindings, invalid images, and network failures retain their current public errors.

## Verification

Verification follows the repository policy and stays targeted:

- one dialog test proving a compact result selection enables apply without a detail pane, rendered image, or cover choice
- one dialog retry test proving selection survives an apply failure
- focused Rust tests for Japanese representative selection and the no-Japanese-cover transaction path
- run only the affected frontend test file and affected Rust library tests

No full test suite or production build is required unless a targeted check exposes broader risk.

## Success Criteria

- Selecting a MangaDex result never starts cover-preview image requests.
- The user can register or connect a Work without choosing a cover.
- Apply downloads no more than one image.
- The automatically selected image is Japanese and prefers volume 1.
- A Work without a Japanese cover is still registered and connected.
- Existing refresh and local-first metadata behavior is unchanged.
