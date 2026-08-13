# Extension Metadata Folder Import Design

## Goal

Add a repeatable, first-class Lakomics workflow for importing image folders exported by the browser extension. The import treats the export metadata as authoritative for classification path, source URL, and collected time while preserving the source folder unchanged.

The initial supported format is `lakomics-x-metadata` version 3. The design keeps format-specific knowledge behind one module so later versions can be added without spreading JSON details through ingestion, settings, or classification code.

## Source Contract

The user selects one export folder. A valid folder contains exactly one JSON file whose top-level fields identify:

- `format: "lakomics-x-metadata"`;
- `version: 3`;
- a `tagLayout` containing primary and secondary tag slots;
- `items` containing `filename`, `tagPath`, `tagNames`, `tagKeys`, `tweetUrl`, and `savedAt`.

Image files are matched to items by the exact `filename` basename. The importer supports the media formats already accepted by Lakomics ingestion and never moves, deletes, renames, or edits files in the selected folder.

The selected folder must contain exactly one matching metadata JSON. Zero or multiple matching files stop the import before any library mutation.

## Metadata Import Module

Add a Rust `metadata_import` module with one external interface: inspect a selected folder and return a normalized import plan.

The module hides:

- JSON discovery and version dispatch;
- version 3 deserialization;
- structural validation;
- filename and path safety checks;
- tag hierarchy normalization;
- union of layout paths and item paths;
- media-file presence checks;
- per-item URL and timestamp validation.

The returned plan contains no format-specific slot structure. It exposes:

- ordered classification paths that must exist;
- valid image import entries with source path, classification path, tweet URL, and saved time;
- skipped entries with filename and reason;
- the selected metadata file and aggregate counts needed by the UI.

This is a deep module: callers learn one plan interface rather than the extension JSON schema. Version dispatch remains inside the module. Version 3 is the only implementation included now; no speculative adapter hierarchy is added before another version exists.

## Classification Path Rules

Metadata paths are authoritative, but existing user structure is not rearranged.

The complete required path set is the union of:

1. every non-null primary slot and its non-null secondary slots in `tagLayout`;
2. every item's `tagPath`, including items whose image file is missing.

This creates empty layout folders such as tags that currently have no exported image.

Path behavior:

- a top-level segment is created as `root`;
- a missing descendant segment is created as `tag`;
- an existing exact path is reused regardless of whether the descendant is currently `work` or `tag`;
- sibling-name matching is case-insensitive;
- an existing entry's spelling, kind, parent, icon, and color are preserved;
- a same-named entry at a different path is not reused, moved, renamed, or deleted;
- each image is directly assigned only to the deepest entry in its item `tagPath`.

This follows the current single-direct-folder rule. Ancestor membership remains a recursive query result rather than duplicate links.

## Import Orchestration

Add an app-level metadata import work module. It survives settings-section navigation and orchestrates the normalized plan through existing library interfaces.

For each run it:

1. asks the backend to inspect and validate the selected folder;
2. resolves or creates required classification paths from shallowest to deepest;
3. ingests each valid image sequentially through the existing media-ingestion path;
4. updates progress and aggregate results after each image;
5. reports skipped and failed entries without stopping later valid images;
6. refreshes sidebar and asset data when the run changes the library.

Only one metadata import runs at a time. A retry reruns the entire selected folder. Whole-folder retry is intentionally used instead of a checkpoint protocol because path reuse and content-hash duplicate detection make the operation idempotent.

## Metadata Preservation and Exact Duplicates

Extend the internal media-ingestion request with an optional collected timestamp. Existing callers pass no timestamp and retain their current `now` behavior. Metadata-folder imports pass the item's validated `savedAt`.

For a newly added asset:

- direct classification is the deepest `tagPath` entry;
- `sourceUrl` is `tweetUrl`;
- `collectedAt` is `savedAt`;
- original filename remains the image filename from the export folder.

For an exact content duplicate found during metadata import:

- no media or thumbnail is copied again;
- direct classification is replaced with the deepest metadata path;
- source URL is replaced with `tweetUrl`;
- collected time is replaced with `savedAt`;
- title, favorite state, media files, and other existing fields remain unchanged.

This duplicate enrichment must be explicitly requested by metadata import data. Ordinary file drop and live extension ingestion preserve their existing exact-duplicate behavior.

## Settings Experience

Add a dedicated `메타데이터 가져오기` section to Settings.

Initial state:

- explain that the feature reads an extension export folder and copies supported images into the current library;
- provide `폴더 선택 후 가져오기`.

After the first valid selection:

- remember the last valid folder path in local UI preferences;
- show the path;
- provide `최근 폴더 다시 가져오기` and `다른 폴더 선택`;
- disable starting another metadata import while one is running.

A valid selection starts immediately after preflight. No wizard or confirmation dialog is added.

## Progress and Results

Extend the existing WorkTray work model with a metadata-import kind rather than building a second progress surface.

Running state displays the completed and total valid image count. Completion displays:

- classification folders created;
- existing paths reused;
- assets added;
- exact duplicates enriched;
- similarity reviews pending;
- missing or invalid entries skipped;
- ingestion failures.

Skipped and failed entries show filename and reason. A retry action reruns the remembered folder. Existing actions for opening exact duplicates and pending similarity reviews remain available where applicable.

## Validation and Error Handling

Fatal preflight errors stop before any library mutation:

- no matching metadata JSON or more than one matching metadata JSON;
- unsupported format or version;
- malformed top-level structure;
- duplicate item filenames;
- empty or unresolvable tag hierarchy;
- an absolute filename, path separator, parent traversal, or any source path that resolves outside the selected folder.

Item-level errors are included in the plan as skipped entries while valid items continue:

- referenced image missing;
- invalid `tweetUrl`;
- invalid `savedAt`;
- unsupported or damaged media;
- per-image ingestion failure.

The parser must place conservative size limits on the JSON file and item count before allocating unbounded data. Exact limits belong with the parser implementation and tests, not the UI.

Classification creation and ingestion are not one filesystem transaction. Recovery relies on idempotent whole-folder reruns: exact paths are reused, content hashes prevent duplicate assets, and metadata duplicate enrichment converges on the JSON values.

## Security and Source Safety

- Treat all JSON strings as untrusted input.
- Resolve media only as direct children of the selected folder.
- Never fetch `originalUrl` or any other remote URL during folder import.
- Store validated `tweetUrl`; do not open it during import.
- Never write into the selected source folder.
- Do not expose internal library paths in user-facing failures.

## Testing

Rust module tests cover:

- a valid version 3 export plan;
- union of `tagLayout` and item `tagPath` values;
- creation planning for unused layout tags;
- present and missing image matching;
- deterministic path ordering;
- zero, multiple, malformed, and unsupported metadata files;
- duplicate filenames and unsafe filenames;
- invalid per-item tweet URLs and saved times;
- parser size limits.

Library integration tests cover:

- root and descendant creation;
- exact full-path reuse with case-insensitive sibling matching;
- preservation of same-named entries at other paths;
- deepest-only direct classification;
- new-asset preservation of source URL and collected time;
- exact-duplicate metadata enrichment without changing favorite state;
- two identical imports producing no duplicate folders or assets.

Frontend tests cover:

- folder selection and cancellation;
- last valid folder persistence;
- running-state exclusion of a second import;
- progress and final counts;
- whole-folder retry;
- sidebar and gallery refresh after changes;
- fatal preflight errors and item-level skipped results.

Final verification includes all Rust tests, the complete frontend test suite, TypeScript compilation, and the Vite production build. Windows Tauri acceptance uses the real `C:\Users\namwoojun\Desktop\lako_image` folder as read-only input and a disposable library, expecting 121 present images and 6 missing entries from the current export. It verifies the source folder is byte-for-byte unchanged after import.

## Scope

Included:

- repeatable local folder import for `lakomics-x-metadata` version 3;
- complete metadata-defined folder creation;
- source URL and collected-time preservation;
- exact-duplicate metadata enrichment;
- settings, progress, results, and retry support.

Excluded:

- remote image downloading for missing files;
- automatic watching of the export folder;
- support for arbitrary third-party JSON formats;
- import cancellation or resumable checkpoints;
- moving or deleting existing classifications;
- modifying source exports;
- speculative parser adapters for versions that do not yet exist.
