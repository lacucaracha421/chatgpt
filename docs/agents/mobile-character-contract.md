# Mobile character projection and manual exclusion contract

Source checkpoint: 2026-09-20, manual exclusion working changes on `1a8ede1`.
Server code is deployed and Android 0.6.7 (23) is installed on Galaxy Tab S11.
An upgraded Linux PC published the feature-aware projection. A user-submitted Galaxy
Tab exclusion was verified while the PC was closed, then received and acknowledged
by the PC. This establishes the named live flow, not Windows native acceptance.
Broader authority work remains tracked in [CLOUD-AUTH-001](../roadmap/lakomics-backlog.md).

## Publication and authority

PC **Settings → 데이터 관리 → 모바일 캐릭터 업데이트** explicitly publishes the current
registered series, display groups, characters and ordinary direct child folders.
An independent read-only SQLite connection holds one transaction while preparing
the projection. PC gallery queries and publication use the same SQL scopes.
Projection construction does not change classifications, references or analysis jobs.
With manual exclusion support adopted, publication first receives pending corrections
and records their explicit rejected decisions locally.

The server persists an atomic read projection. Mobile reads it directly, including
after the PC exits. Changes made on PC and assets uploaded after publication become
visible on the next publication. The existing quiet publication lane also publishes
dirty character projections; the explicit action remains available. This is not
server-side character inference. Neither publication nor correction reception starts
media derivation or a full-library backfill.

The envelope is `version: 1`, `authority: "pc"`, `authorityEpoch: 0`, with
`capabilities: {read: true, write: false}`. Structural character writes, inference,
reference management and full character metadata import remain PC-owned. The separate
`capabilities.manualExclusion` flag enables only the scoped correction channel below,
not a general character authority switch. ADR-0033 still describes current authority.
The future transition is proposed in [ADR-0036](../adr/0036-staged-server-authority.md).

## Identity and gallery semantics

| Field or scope | Meaning |
| --- | --- |
| `id` | Typed navigation ID: `series:ID`, `group:ID`, `character:ID`, or `folder:ID` |
| `sourceId` | Existing PC ID, never a filesystem path or a name-derived identity |
| `seriesId` | Registered series classification ID |
| `parentId` | Null for series; series for groups/folders; series or group for characters |
| Presentation | `name`, `description`, optional `thumbnailAssetId`, `manualOnly`, `excluded` |
| `heroAssetId` | Optional, explicitly selected series hero; separate from a fallback card thumbnail. Only exposed when committed to the server. |
| Series scopes | `all`, `unclassified`, `needs_review`, from canonical PC queries |
| Group scope | Deduplicated union of member character galleries; presentation grouping does not change classification |
| Character scope | Canonical accepted/base-reference membership with current source and exclusion rules |
| Folder scope | Recursive ordinary folder gallery; excludes linked character and separately registered series cards from the direct-child navigation list |
| `sourceCount` | Number of distinct PC asset IDs in the scope at export time |
| `totalCount` | Index: visible published membership count. Asset page: visible published members matching the requested media/aspect/duration filters. |

Each scope retains the PC's `collected_at DESC, id DESC` order. Assets shared by
characters appear once in a group scope. Ordinary folder viewing remains distinct
from exclusion from automatic classification. The exporter does not infer roles
from names or change the quiet character workflow.

This navigation projection does not carry reference image bytes/evidence, decision
history, prediction jobs or local media paths. An upgraded snapshot adds protected
base/learned reference asset IDs for exclusion safety, not an authoritative character
model. Corrections bind to the existing configured server library identity and use
the existing client/publisher credential roles; no multi-library hosting is added.

## API

All routes require bearer authentication. Index, status and asset reads allow the
existing client credentials. An upgraded publication and the exclusion-log GET require
the publisher credential; legacy publication is allowed only before adoption under
its existing shared-token contract. Android allows index/status/asset GET and exactly
one correction POST, not publisher log reads or projection/structural writes.

| Request | Response / behavior |
| --- | --- |
| `GET /v1/library/characters` | Envelope, `ready`, nullable `revision`/`publishedAt`, `nodes`, and scope counts. Before first publication: `ready:false`, empty lists. An explicitly published empty library is `ready:true`. |
| `GET /v1/library/characters/status` | Current nullable revision for quiet refresh checks. |
| `PUT /v1/library/characters/replica` | PC body `{version:1, baseRevision, nodes, scopes:[{nodeId, filter, assetIds}]}`; returns `{revision,nodes}`. |
| `GET /v1/library/characters/assets?node=…&filter=all&revision=…&limit=40&cursor=…` | `{revision,items,totalCount,sourceCount,has_more,next_cursor}`. `limit` is 1–100. |

The revision is a SHA-256 digest of canonical navigation, ordered memberships and
server-hydrated asset metadata. Asset responses retain the existing mobile asset
shape, including classification IDs, without object keys or filesystem paths.
Membership, ordering and ordinary display metadata remain frozen with the projection.
The 2026-09-20 source update overlays live canonical `width`, `height`, `duration_ms`
and visibility on Asset pages, allowing metadata repair to work without PC republication.
Filtered `totalCount` describes the entire matching scope, not the current page;
`sourceCount` stays the exported PC count. Deployed in the authorized 0.6.6 rollout;
live filtered Character rows were checked against canonical technical metadata.
Media tickets still resolve through the existing live asset service; the revision
is not an immutable copy of media bytes or a guarantee that an object remains available.

Publication validates the entire graph and every scope, freezes committed assets,
then replaces all projection tables and revision in one server transaction.
Unchanged content returns the current revision without changing `publishedAt`,
even if a retry carries an old base. Different content must match the current
`baseRevision`; concurrent stale publication returns 409. A failed publication
keeps the previous projection. There is no silent merge or partial replacement.

Asset pages additionally accept `media_kind=images|videos`,
`aspect_ratio=square|landscape|portrait`, and inclusive `duration_ms_min` / exclusive
`duration_ms_max` bounds. GIF counts as an image; duration bounds select videos only.
Unknown dimensions/durations do not match their corresponding filters. Responses
advertise `filterVersion:1`; predicates run before pagination. Mobile refresh clears
cached technical metadata even when membership revision has not changed.

New cursors bind the Asset filters as well as revision, node, scope filter and
ordered position. Shipped unfiltered legacy cursors remain accepted only with
matching revision/node/scope slots. A stale revision
returns 409, an invalid/cross-scope cursor returns 400, and an unknown scope returns
404. Invalid snapshots return sanitized 422 responses; limits return 413.
Transport failures leave the old server view available and the PC publication job
shows an error. Retrying the PC action reads the current base revision again.

Bounds: 24 MiB request, 10,000 nodes, 30,000 scopes, 250,000 IDs per scope and
1,000,000 total memberships. Index JSON is capped at 3 MiB, below Android's 4 MiB
authenticated JSON response budget. Large real libraries have not been benchmarked.

## Scoped manual exclusions

The action means **exclude this asset from this named character**, not move a file
or change canonical folder assignment. Files, albums and other character memberships
are preserved. A character may still legitimately include assets assigned to a series
ancestor, so moving an asset to that folder does not implicitly reject the character.

### Activation and requests

1. The upgraded PC probes the publisher-only
   `GET /v1/library/characters/exclusions?libraryId=…&after=0&limit=1` route.
   A validated empty page is enough to bootstrap. Only HTTP 404 means an older server;
   authorization, identity, cursor and service failures do not silently downgrade.
2. The PC publishes `manualExclusionVersion:1`, `libraryId` and `exclusionCursor`,
   plus `protectedAssetIds` on every character node, including empty arrays.
   The cursor and memberships are read in the same SQLite snapshot transaction.
3. Only then does the index advertise `capabilities.manualExclusion:true`, `libraryId`,
   `exclusionCursor` (server log end), and `appliedExclusionCursor` (published PC ack).
   Missing publisher credentials permit legacy behavior only before adoption.

Client-authenticated `POST /v1/library/characters/exclusions` accepts:

```json
{
  "version": 1,
  "libraryId": "0123456789abcdef0123456789abcdef",
  "operationId": "fde9ef1b-86bd-4d7d-b791-13acfc3a9fbd",
  "targetId": "character-target-id",
  "assetId": "asset-id",
  "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The receipt contains `version`, the same operation/library/target/asset identities,
positive `sequence`, new `revision`, and `pendingPc:true`. The server validates the
active library, published membership, committed visible asset/hash, revision and
protected reference IDs. It stores the correction and receipt atomically. Identical
retries return the original receipt before revision/member checks; reuse of the
operation ID with different content conflicts. The request is limited to 8 KiB.

### Projection and PC consumption

- Pending corrections immediately suppress the named character membership on the
  server, before pagination/counting. Group union membership is hidden only if no
  other published child character still owns the asset. Series and ordinary folder
  membership are unchanged. Hidden cover IDs are cleared and revisions invalidate
  stale cursors. The small pending overlay is materialized on writes, not rebuilt
  by running character inference for each gallery read.
- The PC polls while Cloud sync is enabled, independently of local publication dirtiness,
  with a persisted 60-second background-poll throttle. Explicit publication also receives
  corrections before exporting. Pages contain at most 100 entries; a pass reads at most
  10 pages, resuming from its durable cursor later.
- A log page has `version`, `libraryId`, `after`, `nextCursor`, `hasMore`, and ordered
  `items` containing `sequence`, `operationId`, `targetId`, `assetId`, `assetSha256`,
  `createdAt`. The PC revalidates target, normal asset, byte hash and base/learned
  reference protection. Rejections use existing decision provenance and review-state
  handling, bypassing only folder eligibility so already-moved assets remain correctable.
- Local decisions, scoped receipts and cursor advancement commit atomically per page.
  Replayed entries never rewind the cursor or override a later deliberate PC reaccept.
  Even a correction already rejected locally dirties publication to deliver its ack.
- The server keeps pending suppression until a coherent PC snapshot acknowledges it.
  Snapshots below the acknowledged cursor, beyond the log end, or lacking the adopted
  feature are rejected. A later explicit PC reaccept can appear after acknowledgement.
- A missing/deleted asset or target, changed hash or newly protected reference stops PC
  consumption without advancing that page's cursor. Mobile suppression stays pending.
  There is no conflict-resolution UI or automatic skip in this increment; resolve the
  local conflict before retrying. No inference, feature extraction or backfill runs on
  the server.

### Mobile interaction and rollout

Only a viewer opened from a character node receives the named exclusion action.
Series/group/folder origins, missing capability/identity/protection metadata and protected
assets do not offer it. Confirmation names the character and explains that files,
folders and other characters remain unchanged. Android Back dismisses confirmation first.

The exact confirmed body is stored locally by endpoint/library/target/asset before sending.
Ambiguous failures survive close, swipe, restart and revision changes; user retry resends
that body. Storage failure prevents sending. This is retry durability, not a background
offline queue. A matching receipt closes the viewer and refreshes the character gallery
and sidebar; transport failures do not optimistically remove assets or claim success.

Rollout requires an upgraded server including `character_exclusions.py`, an upgraded PC
with publisher credentials and its first feature-aware publication, then the updated APK.
After activation, mobile corrections work with the PC off; durable PC decisions arrive
when the upgraded PC next syncs. Deployment, production-library publication/correction,
and APK installation require separate authorization.

### Authorized rollout checkpoint — 2026-09-20

- Deployed only `app.py`, `mobile_characters.py`, `character_exclusions.py`, after
  matching the existing source to its baseline and taking a checked online SQLite
  backup. Rollback: `/home/linuxuser/lakomics-character-067-ri8brlhv/rollback/`.
- Live health and authenticated index passed. Unauthenticated POST and client-token
  publisher-log GET returned 401. The character revision and 9,006-Asset count stayed
  unchanged at initial deployment, with empty exclusion state/log and
  `manualExclusion:false` before the PC activation. API service finished active/running,
  `NRestarts=0`.
- Android 0.6.7 (23) built and installed in place with the existing signer. Version,
  signatures, alignment and all 12 asset bytes were checked; cold launch succeeded,
  and a subsequent portrait media-viewer screenshot was inspected. See
  [Android delivery evidence](../../android/README.md).
- PC release build `npm run tauri -- build --no-bundle` initially timed out at 240
  seconds; the authorized 15-minute retry passed in 128 seconds. Binary SHA-256:
  `41d77f144ec0cabe7c0c31448d666b7c0409a4823c575230799b5724583278f1`.
  An online local backup passed `quick_check` before the native application opened the
  configured library and migrated schema 88 to 89. Finite WebDriver sessions used the
  actual release app and Settings publication action, not a mocked API or debug binary.
  Publishing 90 views activated `manualExclusion:true` with protected metadata.
- The user submitted LaLa target `77d88ce4-a2b4-4b8e-9752-54cc1741b5fa` / Asset
  `1d8d1f34-b84c-421b-865e-733d1a3230b8` while the PC verification app was closed.
  Server receipt sequence 1 was observed once, and the complete live character page
  changed from 22 to 21 without the Asset. The controller did not submit another POST.
- The next native PC publication stored `rejected`, `origin=manual`, and consumed
  receipt sequence 1. Server acknowledgement reached `applied_cursor=last_sequence=1`,
  with no pending overlay rows; the acknowledged character page still omits the Asset.
  Canonical manga assignment and entity revision 2 are unchanged. The local original
  path/hash match the pre-rollout backup; server original/thumbnail metadata is unchanged.
- Native sessions were closed after checking results. Windows acceptance and broader
  device interaction cases remain separate; no Git commit/push occurred in this rollout.

## Mobile behavior

Library exposes **시리즈·캐릭터**. Series cards lead to group/character/folder cards
and the existing media gallery/viewer. Series filters expose all/unclassified/
needs-review galleries. Cards use at most two rows per page; six recently visited
scope pages and scroll positions are cached in memory. Android back moves to the
parent, then Home. Late responses cannot replace a newly selected scope.

S11 landscape is the PC-alignment reference. On wide landscape screens (at least
900 CSS pixels), the explicit hero, 3:4 character cards, group mosaics and gallery
share one scroll container. Breadcrumbs preserve series/group context; groups,
ungrouped characters and ordinary folders keep that display order. Cards remain
bounded to two rows, with stable page height. In portrait the compact overview
and separate gallery scrolling are retained. Mobile gallery rows and read-only
controls remain distinct from PC masonry and editing tools.

The screen distinguishes an older server (404), an unpublished projection, an empty
scope, missing cloud assets and failed/stale requests. Refresh reads a new index;
revision changes invalidate scope caches. If the selected node disappears, navigation
returns to the root. Append failures retry without discarding already loaded items.

Character navigation is currently in the app only. DocumentsProvider and
CloudMediaProvider trees do not yet expose these typed nodes. Offline durable
character-index storage is also not part of this phase.

## Verification of the manual exclusion source update

- Server: 49 isolated tests across `test_character_exclusions`,
  `test_mobile_characters` and `test_asset_filters` passed. Temporary SQLite databases,
  fake object storage and copied source were used, not production data or a deployed app.
- On the server host, the synthetic 9,000-asset/100-character fixture measured approximately
  38 ms for exclusion, 48 ms for index and 43 ms for an asset page. These are in-process
  fixture measurements, not device/network latency or a production capacity guarantee.
- PC: targeted `cargo test --lib character_exclusions`, `cloud::characters` and
  `auto_publication` passed, including cursor-only acknowledgement and real two-page
  receive coverage. `cargo check --lib` also passed. Existing compiler warnings remain;
  this is not a full-suite claim.
- Mobile: 81 tests across CharacterExclusion, CharacterBrowser, Viewer and App passed;
  `tsc -p tsconfig.mobile.json --noEmit` passed. React act warnings remain in the tests.
- Android: the standalone NetworkPolicy JVM test passed 372 checks. APK build/install
  and the named live correction happened later in the authorized rollout above.
  Linux native receive/publication was verified; Windows acceptance remains unverified.

## Historical read-projection verification (2026-09-13)

- Rust: two isolated export tests compare IDs/order/counts to actual paged PC
  gallery queries and `tests/fixtures/mobile-character-projection.json`; cover shared
  membership, accepted ancestor assets, base references, ordinary/excluded folders,
  trash, later rejection and series-asset exclusion. `cargo check --lib` passed.
- Server: 92 tests across character, mobile library and collections suites passed;
  the seven character tests passed again after preserving frozen classification IDs.
  Rust and Python consume the same projection fixture. Tests use temporary SQLite
  databases and a fake object store, without production connections.
- Frontend: 28 mobile tests (App, CharacterBrowser, model) passed. The existing 41
  SettingsView tests and the added publication/remount test passed. Desktop/mobile
  TypeScript checks and the mobile production build passed; build output went to
  a temporary directory, not Android's packaged assets.
- Android network policy: 108 standalone JVM checks passed, including GET access
  and denied mutation/publication paths.
- Browser preview: synthetic data at 1279×720 and 800×1100; series/group/character
  navigation, card layout, shared viewer and parent return checked. This does not
  establish authenticated Android media transport or native PC publication.

Before rollout, deploy `app.py` together with `mobile_characters.py` and the existing
runtime modules, publish only with authorization for the
selected library, package/install Android and test with PC off. Preserve separate
Windows and Linux native publication evidence, real-library parity/count checks,
and device media acceptance. No such rollout action was performed here.
