# Manga Cover Viewer and Thumbnail Performance Design

**Date:** 2026-08-21  
**Status:** Approved for implementation planning  
**Visual reference:** `docs/prototypes/lakomics-works-v6-reference.html`

## Goal

Complete the manga Work detail experience defined by the v6 reference while removing the collection-grid stutter caused by rendering original WorkArtwork files as thumbnails.

The interaction boundary is deliberate:

- browsing uses small cached thumbnails;
- the selected detail cover and full-screen appreciation viewer use the original artwork;
- MangaDex search remains text-only and does not fetch cover images.

## Scope

This pass covers two connected changes:

1. a first-class manga cover appreciation viewer opened from a Volume tile;
2. persistent WorkArtwork thumbnails for collection cards and Volume tiles.

It does not add Aladin, release metadata, game/movie detail redesigns, Showcase ordering, or broad Works layout changes. Those remain later passes.

## Confirmed performance cause

`CollectionBrowser` and `CollectionVolumeGrid` currently render `workArtworkUrl(artworkId)`. The `work-artwork` media route resolves the original locally cached file, and MangaDex downloads the original cover with a maximum accepted size of 32 MiB. Browser lazy loading delays off-screen requests but does not reduce the bytes or decode cost of visible originals.

The fix must provide a genuinely smaller media representation. CSS sizing and `loading="lazy"` alone are insufficient.

## Interaction design

### Volume shelf

- The existing four edition drawers remain the navigation model for base editions and `.1`, `.2`, `.3` alternates.
- Volume tiles use cached thumbnails and preserve numeric ordering.
- A tile with no attached artwork remains a quiet placeholder and does not open the viewer.
- Clicking a tile with artwork opens the appreciation viewer immediately. It is not a two-step select-then-open interaction.
- Opening a tile also makes that Volume the selected detail cover so the underlying detail view remains coherent after closing.

### Appreciation viewer

The viewer is a full-window overlay inside the existing application shell:

- dimmed background;
- one large original-resolution cover centered in the available area;
- previous and next controls;
- compact position text in `{current} / {total}` format and the Volume display label;
- close control;
- no metadata panel, descriptive card, or provider controls.

Navigation is restricted to artwork-bearing Volumes visible in the currently selected edition drawer. Placeholder Volumes are skipped. The order is numeric by `volumeNumber`.

Supported input:

- click a Volume tile to open;
- `ArrowLeft` and `ArrowRight` navigate;
- `Escape`, the close control, or the dimmed backdrop closes;
- clicks on the cover itself do not close;
- closing restores keyboard focus to the tile that opened the viewer when it still exists.

Previous/next controls remain visible but disabled at the ends. Navigation does not wrap.

### Collectible motion

The cover may use the Works collectible exception in `DESIGN.md`:

- opening transition: 120–160 ms opacity and restrained scale/lift;
- pointer-driven `rotateX` and `rotateY`, clamped to approximately 3 degrees;
- a restrained moving shadow;
- a very weak glare layer;
- immediate smooth return to the front-facing state on pointer leave.

There is no spring, bounce, large-angle rotation, constant animation, gradient-heavy holo treatment, or motion on ordinary controls. With `prefers-reduced-motion: reduce`, the cover remains front-facing and the open/close transition is effectively removed.

## Component boundaries

### `MangaCoverViewer`

A focused React component owns viewer presentation and interaction. It consumes an ordered list of artwork-bearing `CollectionVolume` records, the active Volume ID, and a close callback. It owns keyboard handling, previous/next selection, pointer tilt values, backdrop behavior, and focus restoration.

It does not fetch Volume data, synchronize MangaDex, change drawers, or update persistence.

### `CollectionVolumeGrid`

The grid continues to own edition filtering and numeric ordering. Its selection callback becomes the viewer-open action for artwork-bearing Volumes. Tile images use the thumbnail URL; placeholders keep their current no-request behavior.

### `CollectionOverlay`

The overlay continues to own Volume loading, MangaDex synchronization, edition selection, and the selected Volume. It adds only the viewer's open Volume ID and passes the current edition's ordered, artwork-bearing Volumes into `MangaCoverViewer`.

The central hero continues to use original WorkArtwork. Opening or navigating the viewer updates the selected Volume so the hero matches when the viewer closes.

## Thumbnail storage and media routing

### Representation

Each WorkArtwork keeps its original file unchanged. A derived WebP thumbnail is stored under a deterministic managed path based on its collection and artwork IDs. The maximum bounding box is 360×360 pixels, matching the existing Asset thumbnail scale and preserving aspect ratio.

No database column is added. The thumbnail is derived cache data, not domain state. Its path is computed from IDs already stored with the WorkArtwork row.

### Creation

- New WorkArtwork preparation writes both the original and its WebP thumbnail before the database transaction is committed.
- If preparation or the database transaction fails, both files are removed.
- Existing WorkArtwork is supported by lazy backfill: the thumbnail media resolver creates the deterministic thumbnail once when it is missing, then serves the cached file.
- Lazy backfill reads only the trusted WorkArtwork path resolved by artwork ID and writes only inside the managed thumbnail directory.
- Concurrent requests for the same missing thumbnail must tolerate another request winning the write race.

This makes newly imported collections fast immediately while upgrading existing libraries without a blocking startup migration.

### Routing

The dedicated `work-artwork-thumbnail/{artworkId}` media route serves the derived WebP. The existing `work-artwork/{artworkId}` route continues to serve the original.

Frontend URL helpers make the distinction explicit:

- `workArtworkThumbnailUrl(id)` for collection cards and Volume tiles;
- `workArtworkUrl(id)` for the detail hero and appreciation viewer.

The protocol validates the artwork UUID and resolves collection ownership through the database before reading either file.

### Cleanup

WorkArtwork cleanup removes unreferenced originals and their deterministic thumbnails. Deleting a Collection must not leave its thumbnail directory behind. A missing thumbnail is recoverable; a missing original remains a media-not-found condition.

## Loading and failure behavior

- Collection and Volume grids do not fall back to originals when thumbnail generation fails; they show the existing image failure/placeholder state rather than reintroducing the performance problem.
- The full-screen viewer opens only for a Volume with an original WorkArtwork ID.
- Failure to decode an invalid existing original returns a media error and does not create a partial cache file.
- MangaDex synchronization behavior and retry messages remain unchanged.
- The viewer does not make network requests because all displayed WorkArtwork is locally cached.

## Accessibility

- The viewer uses dialog semantics with an accessible label based on the Work and Volume.
- Focus moves into the viewer on open and returns to the originating tile on close.
- Close, previous, and next controls have explicit Korean accessible names.
- Keyboard navigation mirrors the visible controls.
- The large cover alt value is `{displayLabel}권 표지`.
- Disabled boundary controls expose their disabled state.
- Reduced-motion preference disables collectible tilt and transition effects.

## Verification

Verification follows the repository policy and stops after sufficient targeted evidence:

- a WorkArtwork test proves a 360×360-bounded WebP thumbnail is created and cleaned up with failed preparation;
- a media protocol test proves the thumbnail route validates IDs, lazily backfills existing artwork, returns WebP, and reuses the cached file;
- URL helper tests distinguish thumbnail and original routes;
- the Collection browser test proves cards use thumbnail URLs for WorkArtwork;
- the Collection overlay test proves Volume tiles use thumbnails while the hero and viewer use originals;
- the viewer component test covers open, non-wrapping navigation, keyboard close, backdrop close, and focus restoration.

Use the smallest relevant Rust test module and frontend test file during iteration. Run one TypeScript interface check only if shared types or component contracts make it necessary. Do not run the full suite unless targeted evidence reveals broader risk.

## Acceptance criteria

- Visible collection cards no longer request original WorkArtwork files.
- Visible Volume tiles no longer request original WorkArtwork files.
- The detail hero and appreciation viewer retain original-quality artwork.
- Existing WorkArtwork gains a persistent thumbnail on first thumbnail request.
- Newly imported WorkArtwork already has its thumbnail before it is shown.
- Clicking an artwork-bearing Volume opens the viewer in one action.
- Previous/next navigation follows numeric Volume order within the current edition and skips placeholders.
- Escape and backdrop close the viewer and restore focus.
- Pointer tilt remains restrained and is absent under reduced-motion preference.
- No new provider, dependency, metadata panel, or unrelated Works redesign is introduced.
