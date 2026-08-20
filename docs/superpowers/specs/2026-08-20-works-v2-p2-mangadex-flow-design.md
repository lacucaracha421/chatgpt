# Works v2 P2 MangaDex Flow Design

## Goal

Implement MangaDex as the first complete provider flow: search a manga, inspect provider metadata and cover candidates, create a new local Work or connect an existing manga Work, cache one user-selected cover as WorkArtwork, browse it offline, and refresh the binding manually without erasing user intent.

## Scope

P2 includes:

- title search against MangaDex
- provider candidate and detail previews
- editable local title before new Work creation
- one user-selected MangaDex cover cached locally
- new manga Work creation
- connection of an existing manga Work
- ExternalBinding snapshot and synchronization time updates
- manual refresh
- WorkArtwork persistence and local media serving
- narrow Tauri and TypeScript Interfaces for the flow

P2 excludes Volume, Aladin, release tracking, automatic synchronization, background polling, WorkArtwork-to-Asset promotion, a generic provider trait, and a broad Works UI redesign.

## Product decisions

- New and existing Work flows share one MangaDex implementation.
- New Works use provider metadata as initial local values. The proposed local title is editable before creation.
- Existing Works keep every nonblank local value. MangaDex fills only blank author, year, genres, and overview fields.
- Title preference is Korean, English, romanized Japanese, then Japanese. Other available titles are shown as alternates.
- The user chooses one cover candidate. Only that cover becomes persistent WorkArtwork.
- Manual refresh updates the raw provider snapshot and fills fields that are still blank. It never changes the local title, a nonblank local field, or the selected cover.
- One MangaDex record may bind to only one local Work. A duplicate is reported as a conflict instead of creating a second Work.
- Provider artwork remains separate from the Asset Library unless a later explicit promotion flow ingests it as an Asset.

## Module design

### `mangadex`

This concrete Module owns the remote MangaDex protocol. It builds fixed-host requests, applies request and response limits, parses provider JSON, chooses localized values, and downloads cover bytes. It does not expose `ureq`, MangaDex response envelopes, endpoint paths, or upload-host paths to React.

Its crate-private Interface supports:

- searching for up to 20 title matches
- fetching one Work preview with all cover candidates needed by P2
- fetching one current Work snapshot for apply or refresh
- opening a validated cover preview response
- downloading a selected full-size cover

There is no generic provider trait in P2. Parsing functions accept stored JSON fixtures, and orchestration tests consume parsed provider values instead of mocking a speculative provider Interface.

### `work_artwork`

This Module owns WorkArtwork rows and files. It validates downloaded images, writes them beneath the library, selects one presentation cover, resolves local media, removes files when persistence fails, and cleans stale pending or unreferenced provider-artwork files when a library opens.

Its files live under:

```text
work-artwork/<collection-id>/<artwork-id>.<validated-extension>
```

Paths stored in SQLite are library-relative. Caller-supplied absolute paths, path separators, and provider filenames never become storage paths.

### `mangadex_flow`

This is the deep orchestration Module used by commands. It coordinates Collection persistence, ExternalBinding persistence, the concrete MangaDex Module, and WorkArtwork persistence.

Its Library Interface exposes:

```text
search_mangadex(query) -> MangaDexSearchResult[]
preview_mangadex(manga_id) -> MangaDexWorkPreview
apply_mangadex(request) -> CollectionSummary
refresh_mangadex(collection_id) -> CollectionSummary
get_mangadex_connection(collection_id) -> MangaDexConnection | null
```

`apply_mangadex` uses a tagged target so invalid new/existing combinations are not representable:

```text
MangaDexApplyRequest
- target: New { name } | Existing { collection_id }
- manga_id
- cover_id
```

The Module refetches current provider detail and verifies that the selected cover belongs to the selected manga before mutating local state.

## Provider mapping

Search requests use MangaDex's public manga endpoint with author, artist, and primary cover relationships included. Detail preview also fetches the manga's cover list. P2 does not require MangaDex authentication.

Provider values map to local fields as follows:

| MangaDex value | Local ownership |
|---|---|
| selected localized title | proposed `Collection.name`, editable for new Works only |
| author and artist relationship names | `Collection.author` |
| publication year | `Collection.year` |
| localized description | `Collection.overview` |
| tag names | `Collection.genres` |
| manga UUID | MangaDex ExternalBinding `external_id` |
| complete current detail response | ExternalBinding `provider_data_json` |
| selected cover | WorkArtwork |
| status, content rating, alternate titles, unused tags | provider snapshot only in P2 |

For existing Works, blank means SQL `NULL` or a trimmed empty string. `name` is never provider-refreshed because valid Collections already require a nonblank name. User score, external score, description, director, showcase state, source path, and Asset membership are not provider-owned.

## Schema v14

Schema v14 adds `collection_work_artworks`:

```text
id TEXT PRIMARY KEY
collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE
provider TEXT NOT NULL
provider_image_id TEXT NOT NULL
kind TEXT NOT NULL
relative_path TEXT NOT NULL UNIQUE
mime_type TEXT NOT NULL
width INTEGER NOT NULL
height INTEGER NOT NULL
language TEXT
selected INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
UNIQUE(collection_id, provider, provider_image_id)
```

`kind` must be nonblank; P2 writes only `cover`. A partial unique index allows at most one selected artwork per `(collection_id, kind)`. The schema does not add Volume or provider-specific cover columns.

`CollectionSummary` adds `selected_work_artwork_id`. Collection queries obtain it from the selected `cover` row. The value is an opaque media identifier, not a path.

## Apply transaction and file safety

All network fetches and image decoding finish before local metadata changes begin.

Apply follows this order:

1. Validate target, manga identity, selected cover membership, response shape, byte limit, MIME, and decoded image dimensions.
2. Write the cover with a generated artwork ID into the WorkArtwork directory.
3. Open one SQLite transaction.
4. Create the new Collection, or update only blank provider-fillable fields on the existing Collection.
5. Upsert the MangaDex ExternalBinding with the exact current snapshot and one synchronization timestamp.
6. Upsert and select the WorkArtwork row, clearing the previous selected `cover` row for that Work.
7. Commit the transaction.
8. If any database step fails, remove the newly written file.

The database never commits a path before the final file exists. A process crash can therefore leave an unreferenced file but cannot leave a committed row pointing at a file that was never written. Library-open cleanup removes stale pending and unreferenced WorkArtwork files.

## New Work flow

1. The Collection `+` menu offers `MangaDex에서 만화 추가` first and `직접 입력` second.
2. The user submits a trimmed query of at least two Unicode scalar values.
3. The dialog displays up to 20 results with title, author, year, status, and a proxied primary-cover preview.
4. Selecting a result loads detailed metadata and cover candidates.
5. The dialog proposes a localized local title and permits editing it.
6. The user selects exactly one cover and confirms.
7. `apply_mangadex` creates the local manga Collection, binding, and selected WorkArtwork.
8. The Collection list refreshes and can display the cached cover without the network.

Manual entry remains available and unchanged.

## Existing Work flow

The manga overlay offers `MangaDex 연결` when no MangaDex binding exists. It reuses the same search, preview, and cover-selection dialog with an existing target.

Apply preserves every nonblank local value and fills only blank `author`, `year`, `genres`, and `overview`. The chosen cover becomes the selected WorkArtwork because the user explicitly selected it during apply. If another Work already owns the MangaDex ID, apply fails without changing either Work.

When a binding exists, the overlay offers `MangaDex 새로고침`. Changing the bound MangaDex identity is done by reopening the connection flow and explicitly selecting a different result; it is not part of refresh.

## Manual refresh

Refresh performs no artwork selection or download. It fetches the current bound MangaDex Work, validates and serializes the response, then uses one SQLite transaction to:

- update the ExternalBinding snapshot and `last_synced_at`
- fill local author, year, genres, and overview fields that remain blank
- leave all other local values and selected WorkArtwork unchanged

Fetch, rate-limit, and parse failures occur before the transaction, so the prior snapshot and Work remain usable offline.

## Media serving

Search and preview images use a Lakomics media route rather than widening the WebView CSP to MangaDex hosts:

```text
mangadex-cover-preview/<manga-id>/<provider-file-name>
```

The handler validates a MangaDex UUID and a conservative provider filename, constructs only the fixed MangaDex uploads host URL, bounds the response size, and returns image bytes without creating WorkArtwork.

Persistent artwork uses:

```text
work-artwork/<artwork-id>
```

The handler resolves the opaque ID through SQLite and applies the same canonical library-root path check used by managed media.

Collection-card image precedence is:

1. selected WorkArtwork
2. Cover Asset
3. collection source preview
4. empty state

The existing manga overlay continues to prefer its ordered local source-folder covers. Selected WorkArtwork is the hero fallback only when that list is empty.

## UI structure

`MangaDexImportDialog` owns the search, result, preview, cover choice, editable new-Work title, loading state, and apply state. It accepts either a new target or an existing manga Collection. `CollectionBrowser` owns the new-Work dialog entry, `CollectionOverlay` owns existing-Work connect and refresh actions, and both call their existing `onChanged` callback after success. `App.tsx` gains no provider network or synchronization state.

The dialog uses existing Button, TextField, Skeleton, Toast, and Dialog Interfaces. The common Dialog Interface gains a restrained `wide` variant because provider results and cover selection need more horizontal space than a property dialog. No new card system, state library, Tailwind, shadcn, gradient, hover scale, or decorative entrance motion is introduced.

The existing overlay loads `get_mangadex_connection` to choose between connect and refresh actions. Refresh reports progress in the invoking control and failures through the existing Toast pattern.

## Network and resource policy

- API origin is fixed to `https://api.mangadex.org`.
- Cover origin is fixed to `https://uploads.mangadex.org`.
- Search is explicit; there is no debounce, automatic retry, polling, or scheduler.
- Only one request generated by a dialog action is active at a time.
- Search is capped at 20 results and cover preview is capped at the first 100 provider cover records.
- JSON responses are capped at 4 MiB.
- Preview images are capped at 8 MiB.
- persistent cover downloads are capped at 32 MiB.
- Requests use a 30-second total timeout and identify the Lakomics application/version.
- HTTP 429 maps to a rate-limit error. Timeout, transport, server, not-found, invalid-response, and invalid-image conditions remain distinguishable Library errors.

## Error behavior

The command error surface adds stable codes for:

- invalid MangaDex query or identity
- MangaDex unavailable or timed out
- MangaDex rate limited
- MangaDex Work not found
- invalid MangaDex response
- duplicate provider binding
- invalid WorkArtwork image
- WorkArtwork file write failure

Search errors retain the dialog and query. Preview errors retain the search results. Apply errors retain the selected result and cover. Refresh errors leave the existing offline Work intact. User-facing Korean messages do not expose raw provider payloads or local paths.

## Verification strategy

Verification follows the repository's proportional policy.

- Stored JSON fixtures test title fallback, alternate titles, authors/artists, tags, overview, year, primary cover, and cover-list parsing without live network calls.
- Focused WorkArtwork tests use a temporary library to prove path safety, decoded dimensions, selected-cover uniqueness, cascade behavior, and local media resolution.
- Focused flow tests consume parsed provider values and real temporary SQLite/filesystem state to prove new creation, existing blank-field fill, nonblank user-value preservation, duplicate binding rejection, file cleanup on persistence failure, and refresh preservation.
- Command serialization tests cover the tagged apply target and stable error codes where those contracts could realistically regress.
- One dialog test file covers search, candidate selection, editable title, cover choice, new apply, existing apply, and error state retention through the real React component with the gateway as the remote seam.
- One overlay test covers connect/refresh action selection and confirms refresh leaves the current presentation visible on failure.
- Type checking verifies Rust/TypeScript shape alignment.
- No production build, live MangaDex test, or full suite is run unless a targeted check exposes a plausible cross-module failure.

## Acceptance criteria

- A user can search MangaDex and create a manga Work with an edited local title and one selected cached cover.
- A user can connect an existing manga Work and only blank local metadata is filled.
- A MangaDex record cannot silently bind to two local Works.
- The selected provider cover displays after restart and with no network.
- WorkArtwork does not appear as an Asset.
- Manual refresh updates the provider snapshot without changing user values or selected artwork.
- Provider or image failures leave the prior local Work usable.
- React does not call MangaDex hosts directly or contain MangaDex response parsing.
- P2 introduces no speculative multi-provider trait or P3/P4 schema.
