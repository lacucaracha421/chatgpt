# Mobile character read contract

Source checkpoint: 2026-09-13, `24f3efb` plus the CLOUD-AUTH-001 working changes.
This describes implemented source. Deployment, publication of the active library,
and Windows/Linux/Android native acceptance are not established by this checkpoint.
Execution status belongs to [CLOUD-AUTH-001](../roadmap/lakomics-backlog.md).

## Publication and authority

PC **Settings → 데이터 관리 → 모바일 캐릭터 업데이트** explicitly publishes the current
registered series, display groups, characters and ordinary direct child folders.
An independent read-only SQLite connection holds one transaction while preparing
the projection. PC gallery queries and publication use the same SQL scopes.
Publication does not change classifications, decisions, references or analysis jobs.

The server persists an atomic read projection. Mobile reads it directly, including
after the PC exits. Changes made on PC and assets uploaded after publication become
visible on the next explicit publication. This is not automatic character sync.
No additional media derivative or full-library backfill is started by this action.

The envelope is `version: 1`, `authority: "pc"`, `authorityEpoch: 0`, with
`capabilities: {read: true, write: false}`. These are fixed values describing this
phase; there is no implemented authority switch, mobile mutation route, operation
log or full character metadata import. ADR-0033 still describes current authority.
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
| `totalCount` | Number of those assets committed to the server at publication time |

Each scope retains the PC's `collected_at DESC, id DESC` order. Assets shared by
characters appear once in a group scope. Ordinary folder viewing remains distinct
from exclusion from automatic classification. The exporter does not infer roles
from names or change the quiet character workflow.

This navigation projection intentionally does not carry reference images/evidence,
decision history, prediction jobs, full exclusion records, or local media paths.
It cannot reconstruct an authoritative character model. It uses the existing
single configured server library and bearer authorization; it does not introduce
multi-library identity or distinct reader/publisher credentials.

## API

All routes require the existing bearer token. Android's authenticated transport
allows only the two GET routes; character PUT/POST/PATCH/DELETE are not allowed.
That device transport rule is not a server-side credential-role separation.

| Request | Response / behavior |
| --- | --- |
| `GET /v1/library/characters` | Envelope, `ready`, nullable `revision`/`publishedAt`, `nodes`, and scope counts. Before first publication: `ready:false`, empty lists. An explicitly published empty library is `ready:true`. |
| `PUT /v1/library/characters/replica` | PC body `{version:1, baseRevision, nodes, scopes:[{nodeId, filter, assetIds}]}`; returns `{revision,nodes}`. |
| `GET /v1/library/characters/assets?node=…&filter=all&revision=…&limit=40&cursor=…` | `{revision,items,totalCount,sourceCount,has_more,next_cursor}`. `limit` is 1–100. |

The revision is a SHA-256 digest of canonical navigation, ordered memberships and
server-hydrated asset metadata. Asset responses retain the existing mobile asset
shape, including classification IDs, without object keys or filesystem paths.
Availability and display metadata are frozen with the projection so page counts
and membership do not drift while uploads or metadata updates run.
Media tickets still resolve through the existing live asset service; the revision
is not an immutable copy of media bytes or a guarantee that an object remains available.

Publication validates the entire graph and every scope, freezes committed assets,
then replaces all projection tables and revision in one server transaction.
Unchanged content returns the current revision without changing `publishedAt`,
even if a retry carries an old base. Different content must match the current
`baseRevision`; concurrent stale publication returns 409. A failed publication
keeps the previous projection. There is no silent merge or partial replacement.

The cursor is bound to revision, node, filter and ordered position. A stale revision
returns 409, an invalid/cross-scope cursor returns 400, and an unknown scope returns
404. Invalid snapshots return sanitized 422 responses; limits return 413.
Transport failures leave the old server view available and the PC publication job
shows an error. Retrying the PC action reads the current base revision again.

Bounds: 24 MiB request, 10,000 nodes, 30,000 scopes, 250,000 IDs per scope and
1,000,000 total memberships. Index JSON is capped at 3 MiB, below Android's 4 MiB
authenticated JSON response budget. Large real libraries have not been benchmarked.

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

## Verification at this checkpoint

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
