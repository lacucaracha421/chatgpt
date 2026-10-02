# Asset search publication and reads (PC-POLISH-20261002, item 13, stages 2–3)

This is an independent PC-derived tag channel. It never calls the Cloud Library
backfill or `/v1/replication/commit`. No deployment, SSH, production migration or
production data changes were performed during implementation.

## Tablet contract

- `GET /v1/library/search/suggestions?text=&limit=10` takes a client token. `text`
  defaults to empty (popular tags), maximum 200 characters. `limit` is 1–20;
  out-of-range values return 422. Response:
  `{"version":1,"text":"...","limit":10,"items":[{"kind":"tag","id":"long_hair","label":"긴 머리","category":"general","count":7}]}`.
  Suggestions currently contain tags only. Artists and classifications retain
  their existing list/tree endpoints. Matching ignores case, spaces and
  underscores, and supports Korean initial-consonant strings such as `ㄱㅁㄹ`.
  Exact matches precede prefixes, then substrings; ties use descending visible
  committed Asset counts, then tag id. Missing, uncommitted, trashed, tombstoned
  and missing-canonical-state Assets do not count under the existing ordinary
  Asset visibility policy. The Manga Catalog's blocked-tag policy is separate
  from ordinary Asset visibility and is not imported into this search.
- `GET /v1/library/assets` accepts repeated `tag=<tag id>` (AND, maximum 8),
  `artist=<published artist id>` (one), and repeated
  `classification_id=<classification id>` (AND, maximum 8). Empty/invalid ids
  return 422. Duplicate ids are deduplicated and order does not affect identity.
  Tag ids are the original PC Danbooru tag strings, not Korean labels. Artist
  ids are the published ids (including the `artist:` prefix where present),
  URL-encoded as query values. All of an artist's published creator keys match;
  manual/source-URL assignments override creator-key membership, as on PC.
  The tag channel supplies PC URL-only creator keys that older replicated Asset
  rows do not carry. Before its first publication, handle keys and published
  manual assignments already work, while URL-only matches await publication.
- These filters combine with the existing `media_kind`, `aspect_ratio`,
  `duration_ms_min`, `duration_ms_max`, `sort`, `cursor`, `limit`, `toc=1`, and
  `utcOffsetMinutes`. SQL applies them before pagination. `toc=1` counts and
  mints seek cursors from exactly the same selection. Under active Classification
  authority an Asset has one assignment, so AND over two distinct classification
  ids intentionally returns no matches; no ancestor expansion is implied.
- `GET /v1/albums/assets` accepts the same repeated `tag` and single `artist`,
  alongside its existing `libraryId`, `epoch`, `albumId` and media/TOC parameters.
  `GET /v1/library/characters/assets` accepts them alongside its existing `node`,
  `revision`, `filter`, cursor and media parameters. Character order remains the
  published order; `totalCount` uses the new predicates, `sourceCount` retains
  its published meaning. These two routes do not accept `classification_id`.
- Revisit date/creator routes retain their existing scope and parameter contract;
  use `/v1/library/assets?artist=...` for complete merged-artist search.
- List pages and `/v1/library/list-generation` advertise `searchVersion:1`.
  Pages also echo normalized `searchFilters` (`tag` array, `artist` nullable;
  Library pages additionally include a `classification_id` array).
  `filterVersion:1` retains its existing technical-filter meaning. TOC responses
  preserve their shipped shape; their ETags bind the scope and search filters.
  Cursors bind all search filters. Legacy unfiltered/single-classification
  cursors remain supported; they cannot resume a new multi-classification or
  tag/artist query. Tag and artist publication revisions participate in
  `listGeneration`, invalidating existing list/TOC caches when either changes.
- The new suggestions route is GET-only in the Android allowlist. Publisher
  routes remain inaccessible through the Android client API bridge.

Example: `/v1/library/assets?tag=long_hair&tag=glasses&artist=artist%3Aa1&classification_id=folder-a&classification_id=folder-b&toc=1`.

## PC publication contract

`PUT /v1/library/auto-tags` requires a publisher token, maximum 1 MiB:

```json
{
  "version": 1,
  "vocabulary": [{"id": "long_hair", "label": "긴 머리", "category": "general"}],
  "assets": [{"assetId": "asset-1", "creatorKey": "alice", "tags": ["long_hair"]}]
}
```

At most 500 vocabulary entries and 100 Assets per request, at most 1000 tags per
Asset. Categories are `general`, `character`, `copyright`, `artist`, `meta`,
`rating`. `creatorKey` is nullable/optional. The complete PC vocabulary is published, including categories whose tags are
not displayed. Suggestions omit artist/meta/rating categories and count only
effective display-tag memberships. Vocabulary entries are upserts, not
a replacement of the entire vocabulary; Assets are atomic full replacements of
that Asset's tag set and creator key. Every referenced tag must already exist or
be in the same request. An empty tag array clears previous tags. Other Assets
are untouched. Duplicate ids/tags, unknown tags and invalid shape return
`422 invalidAutoTagUpload`; an oversized body returns `413 autoTagUploadTooLarge`.
Response: `{"version":1,"revision":1,"changed":true,"assets":1,"vocabulary":1}`.
Identical content is idempotent, including retry after a lost response; generated
timestamps are deliberately absent from the content identity.

The existing quiet publication owner dispatches a separate tag lane every ten
seconds. Lightweight mode holds this lane entirely. A completed local scan waits
at least 60 seconds before the next scan; each tick scans up to three bounded
pages. Initial delivery publishes the vocabulary and each Asset, then only
changed content is sent. Per-endpoint acknowledged digests and scan positions
survive restart. The lane persists retry timing before I/O and uses 60-second to
one-hour exponential backoff. Assets edited behind the current cursor are picked
up in the next scan; new vocabulary introduced during a resumed Asset scan is
published before its Asset batch. Deletion/trash/review produces an empty tag
replacement. Server list reads join the current visible Asset projection throughout. Suggestions
read per-tag visible counts maintained atomically with tag relations, committed
Asset changes and Asset authority lifecycle/activation changes, using the shared
visibility predicate. Startup rebuilds these count projections under a write lock.

Effective tags use the PC inspector's manual additions/removals, hidden/category
rules and character threshold (model score >= 0.85, only without confirmed
character membership). Manual character additions remain visible. If an Asset has more than 1000 effective
tags, publication selects manual additions first, then descending score (missing
scores last), then ascending tag id. The selected ids are serialized in ascending
order for stable retry identity. Invalid individual Assets are logged and skipped;
the cursor advances and a later complete scan retries them. A request-wide network
or server failure still retains the page for retry. The PC frontend
and Rust publisher share `src/autotags/dictionaryData.json` for Korean labels and
hidden tag names; character labels retain the PC's prettified names.

## Migrations and deployment order

1. The controller reviews the focused diff and checks below, then deploys the
   server first using the existing service deployment procedure and backup rules.
   Startup creates eight additive tables: `library_tag_state`,
   `library_tag_vocabulary`, `library_tag_assets`, `library_asset_tags`,
   `library_artist_keys`, `library_artist_assignments`, `library_tag_counts`,
   `library_tag_visibility`, with tag/creator/artist and committed/id indexes.
   The artist key and assignment tables are projections of the already published artist
   document, rebuilt from the stored document in the same `BEGIN IMMEDIATE` transaction at
   startup and atomically replaced by later artist uploads. Search startup runs
   after Asset authority schema installation so count triggers observe future
   activation as well as active lifecycle changes.
   No Asset/authority rows, catalog, media objects or activation flags are rewritten.
2. Verify authorized server startup, auth, `searchVersion:1`, suggestions and a
   filtered list/TOC. Before first tag publication an empty suggestion/tag result
   is expected. Existing unfiltered lists remain available.
3. Build/release the PC after the server is compatible. PC migration
   `0120_auto_tag_publication.sql` raises schema 119 to 120, adding
   `auto_tag_publication_digests` and `auto_tag_publication_state` only. Apply to
   a production library only under the controller's separate approved migration
   and backup procedure. No production library was opened by this task.
4. Resume normal PC publication with its existing cloud settings/publisher token
   and lightweight mode off. Inspect gradual tag counts and a merged artist with
   manual assignments. Do not rerun or extend the completed media backfill.
   Deploy the Android/UI consumer after its own review/device checks.

## Focused checks

From `server/lakomics-api`:
`.venv/bin/python -m unittest discover -s tests -t .`.
The synthetic benchmark in `tests/test_asset_search_performance.py` uses 100,000
Assets and 2,000,000 tag relations, prints timings, checks the artist query plan
for creator/assignment indexes and committed/id lookup, and uses generous CI
bounds (250 ms suggestions, 100 ms sparse artist page). Local targets remain
50 ms and 10 ms respectively.

From `_tools/app/src-tauri`:
`CARGO_BUILD_JOBS=2 cargo test --lib auto_tag`.

From `_tools/app`: `npm test -- --run src/autotags/autoTagModel.test.ts`.
Android: compile `NetworkPolicy.java` and `NetworkPolicyTest.java` with the
installed JDK into a temporary directory, then run
`com.lakomics.mobile.NetworkPolicyTest` with that classpath.

The current sandbox rejects asyncio wakeup socket writes; direct TestClient runs
stall. Server tests here use a temporary harness that adds a 2 ms event-loop
polling timer without changing app/test code, auth, ASGI dispatch, threadpool or
sandbox permissions. Native PC, Windows, Android device and live publication
acceptance remain separate from these fixture checks. Review was performed inline.

## Changed file inventory

- Server: `library_search.py`, `app.py`, `asset_filters.py`, `album_authority.py`,
  `mobile_characters.py`, `library_artists.py`, `tests/test_library_search.py`,
  `asset_list_query.py`, `tests/test_library_artists.py`,
  `tests/test_asset_search_performance.py`, `ASSET_SEARCH.md` (paths relative to `server/lakomics-api`).
- PC Rust: `src/cloud/auto_publication.rs`, `src/cloud/home_publications.rs`,
  `src/library/auto_tag_publication.rs`, `src/library/auto_tag_publication_tests.rs`,
  `src/library/auto_tags.rs`, `src/library/db.rs`, `src/library/mod.rs`,
  `migrations/0120_auto_tag_publication.sql` (relative to `_tools/app/src-tauri`).
- Shared PC dictionary: `_tools/app/src/autotags/dictionary.ts`,
  `_tools/app/src/autotags/dictionaryData.json`. All six label groups and the
  hidden-tag list were compared to HEAD and preserved exactly.
- Android: `android/src/com/lakomics/mobile/NetworkPolicy.java`,
  `android/tests/NetworkPolicyTest.java`.

Initial implementation validation observed: the five server modules ran 78 tests successfully, then the
expanded search module's seven tests passed again (79 distinct tests across the
final suites). The final targeted Rust run passed eight tests; dictionary display
passed six Vitest tests and a focused TypeScript check; Android policy passed
899 checks. `git diff --check` and rustfmt checks for the two new Rust files passed.
Existing touched Rust modules have pre-existing whole-file rustfmt differences;
check-only inspection left those unchanged to avoid unrelated formatting edits.


## Review fixes (2026-10-02)

The HTTP request/response shapes, tag limit, cursor identity, TOC selection and
ETag bindings retain the contracts above. Artist startup now reads and replaces
its search projection under one write lock. Suggestions use transactional visible
counts; sparse artist lists use indexed candidate ids and sort only the selection.
PC publication caps effective tags deterministically and advances past malformed
individual Assets without acknowledging them, so later scans can retry repairs.

Files changed specifically for these review fixes:

- Server code: `library_artists.py`, `library_search.py`, `asset_filters.py`,
  `asset_list_query.py`, `app.py`, `album_authority.py`.
- Server tests: `tests/test_library_artists.py`, `tests/test_library_search.py`,
  `tests/test_asset_search_performance.py`, `tests/test_replication_api.py`.
- PC Rust: `src/library/auto_tag_publication.rs`,
  `src/library/auto_tag_publication_tests.rs` (relative to `_tools/app/src-tauri`).
- Contract and verification notes: this document.

Review-fix validation: the final full server discovery ran 1706 tests in 195.919 s,
all passing, with no skipped cases. The direct discovery invocation timed out
at 60 s under the denied asyncio socket-wakeup policy; the successful run used
only the temporary 2 ms polling harness described above. The first complete run
caught the startup-order fixture's old expectation; the final run includes its
updated ordering and assertions that lifecycle count tables/triggers exist.

On the synthetic in-memory SQLite fixture (100k Assets, 2M memberships, 4000 tag
ids), the original suggestions took 1363.82–1385.17 ms across empty, broad,
exact, Korean, Korean-initial and no-match queries; the final full run measured
1.62–17.53 ms. Sparse artist first page improved from 49.69 ms to 0.17 ms.
EXPLAIN confirms indexed creator/assignment candidates and committed/id lookup,
with no scan of the date-order Asset index. Generous CI timing bounds remain
separate from these local measurements. The startup race test was also observed
failing against the pre-fix implementation and passing against the final code.

The final `CARGO_BUILD_JOBS=2 cargo test --lib auto_tag` passed 24 tests; two
existing real-file/scale probes remained ignored. Task-scoped whitespace checks
(including untracked files) and direct rustfmt checks passed. Review was inline.
No commit, deployment, SSH, dependency installation or production-library writes
were performed. Native application publication and live server acceptance remain
unverified.
