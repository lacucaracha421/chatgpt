# Collection card cover resilience design

## Goal

Collection browsing cards should reuse already cached manga volume artwork when no explicit Work cover exists, and should show the existing placeholder instead of a browser broken-image indicator when any chosen thumbnail URL fails.

## Selected behavior

1. The Collection summary continues to prefer an explicitly selected `cover` WorkArtwork.
2. When that selection is absent, the summary returns the earliest locally cached volume cover, ordered by edition, sort order, volume number, and stable artwork ID.
3. Collection browsing continues to request the existing bounded thumbnail routes. No original media is introduced into grids.
4. `CollectionCard` hides only the URL that most recently failed. A different URL is attempted immediately, so a provider refresh or later cover selection can recover without reopening the browser.

## Boundaries

- Keep the fallback inside the existing Collection summary query; do not add per-card volume requests.
- Do not copy artwork, contact providers, migrate data, or delete legacy source paths.
- Do not change large-viewer media behavior.
- Do not import the preserved gateway characterization test or dated work summaries; they do not protect either selected behavior.
- Discard the extension alpha 15.20 stash because current `main` already contains the corresponding alpha 15.22 behavior.

## Verification

- A Rust regression test proves volume-one ordering and explicit-cover precedence.
- A React regression test proves failed thumbnails become placeholders and a changed URL is retried while retaining asynchronous decoding.
- Run only those targeted tests unless they reveal wider risk.
