# Lakomics icon

Refined vector proposal based on the existing three outlined bars in the workspace rail.

- `lakomics-mark.svg`: transparent 256-unit master. Equal-width side bars, taller center bar, symmetric spacing, 8-unit outline converted to filled paths. Uses `currentColor`, default warm ivory `#DCD8CB`.
- `lakomics-app-icon.svg`: app tile with a neutral charcoal background `#1B1C1B`, inset mark, and restrained corner radius.
- `lakomics-mark-small.svg`: optically adjusted 16px version with whole-pixel edges and 1px outlines; use at 16px or integer multiples when the master would appear too thin.

All SVGs are self-contained, with no fonts, external resources, filters, or raster images.

## Selected identity

Version 01 (Outline) was selected on 2026-09-06. Production sources are `app/src/brand/lakomics-mark.svg` (workspace rail) and `app/src/brand/lakomics-icon.svg` (charcoal app tile). The five studies here remain design references.

PC icon files under `app/src-tauri/icons/` are generated using the existing Tauri icon command from the app tile source. Extension PNGs under `extension/icons/` use the same tile at 16, 32, 48, and 128px; the manifest references both toolbar and extension management icons. Native executable icons take effect after rebuilding/restarting the app; installed extensions need a reload/update.
