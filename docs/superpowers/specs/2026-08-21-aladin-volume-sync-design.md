# Aladin Korean Volume Sync Design

**Date:** 2026-08-21  
**Status:** Approved direction, pending written-spec review  
**Provider:** Aladin OpenAPI / TTB

## Goal

Connect an existing manga Collection to Aladin and import Korean commercial release information into the existing Volume shelf without changing MangaDex artwork or user-owned Collection metadata.

This is the first, deliberately manual Aladin pass:

- the user stores a TTB key;
- searches Aladin from an existing manga Collection;
- chooses the matching Korean series from text-only candidates;
- imports or refreshes Korean volume records on demand;
- sees Korean publication information alongside the existing MangaDex/local cover shelf.

MangaDex remains responsible for Work identity, general manga metadata, and Japanese-language cover artwork. Aladin is responsible for Korean commercial volume identity and release data.

## Confirmed context

The current code already has the prerequisites this pass should build on:

- a Collection can own multiple `ExternalBinding` records;
- MangaDex is an established provider flow;
- manga Volume rows have stable integer volume numbers and four edition drawers;
- WorkArtwork and cover selection are locally cached and must not be overwritten by Aladin;
- ordinary Collection edits preserve provider snapshots and bindings;
- the application is Windows-first and the library SQLite database is included in rotating metadata backups.

The old Flutter implementation is useful only as a behavioral reference. Its title search and volume-number parsing can inform the new implementation, but its map-shaped responses, broad monitoring flow, and embedded credential handling must not be copied.

Aladin's official OpenAPI supports title search and JSON output. Ordinary access is limited to 5,000 calls per day, so this pass uses explicit user-triggered requests and no background polling.

## Considered approaches

### A. Manual connection and sync first — selected

Build credential storage, text-only series selection, transactional Volume reconciliation, and explicit refresh. Add Release Watch only after the stored identity and matching behavior have been proven with real libraries.

This produces a complete narrow workflow and keeps API use predictable.

### B. Port the complete legacy monitor immediately

Implement connection, missing-volume calculation, future releases, scheduling, notifications, and background retries together.

This would combine uncertain title matching with scheduling and notification state, making incorrect matches harder to diagnose and undo. It is rejected for this pass.

### C. Show transient search results without persistence

Call Aladin and display results without an ExternalBinding or stored release records.

This is quick but provides no offline value and would need to be replaced before Release Watch. It is rejected.

## User experience

### TTB key setting

Settings gains a compact `외부 서비스` section with an `알라딘 TTB 키` password field.

- The field never reveals a saved key after reopening Settings.
- The UI reports only `설정됨` or `설정되지 않음` for an existing credential.
- Saving a non-empty value replaces the credential.
- A separate remove action deletes it after confirmation.
- The key is never written to logs, error messages, URLs shown in the UI, SQLite, metadata exports, or rotating library backups.

The credential is stored in Windows Credential Manager under a Lakomics-owned target name. This follows the Windows-first product decision and prevents library backups or synced library folders from copying the secret. A small credential interface hides the operating-system calls so provider code only asks for the current TTB key.

The old application's embedded or preference-stored key is not imported automatically.

### Connect Aladin

An existing manga Collection exposes an `Aladin 연결` toolbar action when it has no Aladin binding.

Opening it shows the shared Lakomics dialog structure, not a new page:

1. The query is prefilled from the Collection title.
2. Search starts only when the user submits at least two non-whitespace characters.
3. Results are text-only and never request cover images.
4. Each row represents a grouped series candidate rather than an individual volume.
5. A row shows the normalized series title, author, publisher, parsed volume range, and matched-item count.
6. Selecting a row shows the parsed volumes that will be attached.
7. One emphasized `연결` action performs a fresh backend search, verifies the selected group, and applies it transactionally.

The text-only result design keeps search responsive and avoids the cover-loading problem previously seen in MangaDex search.

### Refresh Aladin

After connection, the toolbar action becomes `Aladin 새로고침`.

- Refresh uses the stored query and group identity.
- It runs only after a user action in this pass.
- Existing known provider item IDs are used to identify the same candidate group.
- If the provider response can no longer be matched unambiguously, refresh stops and asks the user to reconnect instead of attaching another similarly named series.
- A successful refresh reloads the Volume shelf and reports how many releases were added, updated, unchanged, or ignored.

MangaDex refresh and Aladin refresh remain separate actions because they have different ownership and failure modes.

### Volume presentation

The shelf continues to be ordered by integer Volume number and continues to use the four existing cover drawers.

Aladin data appears as quiet secondary information for the selected Volume:

- Korean publication date;
- ISBN13 when present;
- release state derived from the publication date (`출간 예정` or `출간됨`).

This pass does not add badges to every grid tile, a missing-volume dashboard, purchase tracking, or notification chrome.

## Series matching

Aladin search results are individual products, while Lakomics needs a series-level connection. The backend therefore performs deterministic grouping.

### Volume parsing

The parser accepts positive integer volumes from restrained patterns such as:

- `1권`, `제1권`;
- `Vol. 1`, `Volume 1`;
- a final standalone integer when it is clearly separated from the title.

It rejects:

- numbers outside 1–999;
- sets, bundles, boxes, guides, art books, novels, calendars, and other clearly marked non-volume products;
- results with no unambiguous integer volume;
- decimal or fractional volume identities in this first pass.

Ignored products are visible in the preview count but are never silently materialized as Volumes.

### Candidate grouping

Parsed items are grouped by a normalized base title plus normalized author and publisher. Normalization removes only the parsed volume suffix and known edition/product qualifiers; it does not use fuzzy similarity or AI matching.

Each candidate has:

- a display title;
- author and publisher;
- a stable group fingerprint derived from normalized grouping fields;
- the provider item IDs found in that group;
- parsed volume summaries;
- an anchor item ID used as the ExternalBinding's provider identity.

The anchor is an actual Aladin item ID from the selected group, not a synthetic search string. Provider configuration separately stores the search query and group fingerprint.

On refresh, the backend chooses a group only when its fingerprint matches and it shares a known item ID, or when the prior anchor is still present. No title-only fallback may silently switch the binding.

## Persistence model

### Credential

The TTB key lives outside the library in Windows Credential Manager. SQLite stores only whether Aladin is connected to a Collection and the provider data returned by successful searches.

### ExternalBinding extension

The actual second provider requires configuration that is distinct from the latest response snapshot. Add a nullable `provider_config_json` column to `collection_external_bindings`.

For an Aladin binding:

- `provider` is `aladin`;
- `external_id` is the selected anchor Aladin item ID;
- `provider_config_json` contains the explicit search query, group fingerprint, and known provider item IDs required to identify the same series later;
- `provider_data_json` contains the latest normalized provider snapshot needed for offline inspection and diagnostics;
- `last_synced_at` changes only after a successful transaction.

No generic provider abstraction is added beyond the already real shared binding storage. MangaDex and Aladin keep separate clients and orchestration because their protocols and capabilities differ.

### Aladin volume sources

Provider-owned Korean release data is stored separately from cover/edition rows in a new table conceptually named `collection_volume_sources`:

```text
collection_id
volume_number
provider                 # aladin in this pass
provider_item_id
title
author
publisher
isbn13
publication_date
item_url
provider_data_json
created_at
updated_at
```

The logical key is `(collection_id, volume_number, provider)`. `provider_item_id` is also unique per provider so one Aladin product cannot be silently attached to two Collections.

This table keeps provider-owned fields and raw snapshots out of the user-facing Collection row. It also avoids pretending that a Korean commercial release owns a MangaDex cover edition.

For every accepted Aladin source, a base Volume row `(volume_number, edition_index = 0)` is ensured to exist. Existing Volume rows are reused. Missing base rows are inserted with normal numeric ordering and no artwork. Alternate cover drawers remain untouched.

The `CollectionVolume` projection adds nullable Korean release fields from the Aladin source join. The UI does not need to know the storage table.

## Synchronization transaction

Connection and refresh share one reconciliation operation:

1. Resolve the TTB key from the credential store.
2. Validate the query and call Aladin over HTTPS with a bounded timeout.
3. Parse the JSON envelope and provider-level error fields.
4. Parse items, reject non-volume products, and group candidates.
5. Resolve the explicitly selected or previously bound group without fuzzy fallback.
6. Start one SQLite transaction.
7. Upsert accepted `collection_volume_sources` by Volume number.
8. Ensure matching base Volume rows exist without changing any cover fields.
9. Remove no previously known release merely because one search response omitted it.
10. Upsert the Aladin ExternalBinding snapshot/configuration and sync time.
11. Commit and return added/updated/unchanged/ignored counts.

Failure before commit changes neither the binding nor Volume data. Refresh is additive and corrective, not destructive.

Aladin synchronization must never change:

- Collection title, author, overview, score, genres, or selected artwork;
- MangaDex ExternalBinding or snapshots;
- WorkArtwork files or selection;
- `cover_artwork_id`, cover source fields, or edition drawer assignment;
- user-created Assets or Collection membership.

## Module boundaries

### `aladin` client

Owns HTTPS request construction, response envelopes, typed provider items, error mapping, and volume-product parsing. It never opens SQLite or changes UI state.

### Aladin sync module

Owns candidate grouping, connection identity, stored configuration, group re-identification, and transactional reconciliation. It consumes the client and library persistence interfaces.

### Credential module

Owns Windows Credential Manager reads, writes, status checks, and deletion. It exposes no credential value to the frontend; only provider operations inside Rust can read it.

### Frontend dialog

Owns query input, loading/error/empty/result states, candidate selection, confirmation, and focus behavior. It receives typed candidates and never parses titles or provider JSON.

### Collection overlay

Owns only whether the dialog is open, the current connection summary, explicit refresh state, and reloading Volumes after successful synchronization.

## Error handling

User-facing errors distinguish:

- TTB key not configured;
- invalid or rejected TTB key;
- query shorter than two characters;
- provider timeout or unavailable response;
- provider rate limit;
- malformed provider response;
- no parsable volume products;
- previously connected series can no longer be identified safely;
- duplicate Aladin item already connected to another Collection.

The request URL must never be logged because it contains the TTB key as a query parameter. Logs may include the provider name, operation, HTTP status, item counts, and redacted error category only.

An Aladin outage does not affect normal offline Collection browsing. Previously synchronized Korean release information remains visible.

## API-call policy

- Search occurs only on explicit form submission.
- Connection may repeat the selected search once to validate and apply authoritative backend data.
- Refresh occurs only on explicit user action.
- No search-on-keystroke, automatic opening request, background timer, startup sweep, or per-Collection polling is introduced.
- Requests use a bounded result count and timeout.
- The API key and full credential-bearing URL never leave the Rust backend.

This remains comfortably within the ordinary 5,000-call daily limit and leaves scheduling policy to the later Release Watch design.

## Verification

Verification follows the repository's targeted-check policy:

- parser tests cover accepted Korean/English volume patterns and rejected bundles/special products;
- response tests cover valid JSON, empty results, provider error envelopes, malformed items, and key/rate-limit error mapping;
- grouping tests prove similarly named series remain separate and refresh never falls back to an ambiguous group;
- one persistence test proves Aladin sources create missing base Volumes while preserving MangaDex binding, artwork IDs, alternate drawers, and Collection metadata;
- one refresh test proves omitted provider results do not delete existing releases;
- credential tests use a fake credential interface and prove status/read commands never return the saved key to the frontend;
- the Settings test covers masked status, replace, and remove actions;
- the dialog test covers text-only results, candidate preview, connect, empty/error states, and keyboard focus;
- the Collection overlay test proves successful sync reloads release fields without changing cover URLs.

No live Aladin request is part of the automated suite. A single explicit manual smoke check with the user's configured key is appropriate after implementation.

## Deferred work

The following are intentionally excluded:

- scheduled or startup Release Watch;
- Windows notifications;
- missing-volume and purchase tracking;
- preorder notifications or change history;
- Aladin cover downloads;
- automatic matching across all manga Collections;
- importing the old application's TTB key;
- fuzzy/AI series matching;
- fractional volumes, box sets, novels, guides, and art books;
- game/movie provider work or unrelated visual redesign.

The next design pass may add Release Watch using the stable Aladin binding and source records from this pass, including `last_checked_at`, conservative polling, new/changed release detection, and user-controlled notification settings.

## Acceptance criteria

- The TTB key is stored outside SQLite, is never returned to the frontend after saving, and is absent from logs.
- Aladin search remains text-only and makes no cover-image requests.
- The user explicitly chooses a grouped Korean series before connecting.
- The connection coexists with MangaDex on the same Collection.
- Accepted Korean products are represented by typed, locally cached release records.
- Missing base Volume rows are created in numeric order without artwork.
- Existing MangaDex/local covers and edition drawers are unchanged.
- Refresh can identify the same group without fuzzy title fallback.
- Provider omissions do not delete previously synchronized releases.
- Normal Collection browsing remains available offline.
- No background polling, notification system, or unrelated provider abstraction is added.
