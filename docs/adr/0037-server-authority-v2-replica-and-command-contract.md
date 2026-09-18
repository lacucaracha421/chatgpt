# Server Authority v2 uses per-domain authority with durable client replicas

Status: Proposed — architecture checkpoint for broader `CLOUD-POST-001` work.

Clarifies [ADR-0036](0036-staged-server-authority.md). It does not replace the
Notes encryption boundary in [ADR-0035](0035-encrypted-personal-notes.md).
ADR-0033 remains the behavior of domains that have not yet been explicitly cut
over to server authority.

## Context

The catalog-bookmark pilot proved the core server-authority pattern in production:
stable operation IDs, entity revisions, receipts, an ordered change cursor and a
PC durable outbox can converge automatically in both directions.

The 2026-09-15 Android and PC audits also showed why the pattern cannot remain a
bookmark-only exception. Most older domains still publish PC snapshots that can
overwrite shared state, Android keeps overlapping metadata copies, and the current
PC recovery path swaps an entire old `library.sqlite`, including sync cursors and
pending-operation tables.

The confirmed product target is a single-user server-authoritative library with a
fast PC replica/workstation and a durable Android replica. Both clients may edit
shared state while briefly offline. R2 remains the durable media-byte source, while
heavy compute may run on the current main PC rather than on the VPS.

## Decision 1: identity and authority boundary
`library_id` identifies the logical server library, not a PC folder or SQLite file.
A newly paired PC may use a different local path while representing the same
`library_id`. Device-local paths, byte presence, caches and credentials never
become shared entity identity.

Each shared domain owns an independent authority state:

- `library_id`;
- stable domain name;
- authority `epoch`;
- `contract_version`;
- monotonically increasing domain `cursor`;
- coherent baseline identity/digest and activation metadata;
- retained-cursor floor where history pruning applies.

There is **no single global correctness cursor**. Domains differ in conflict rules,
baseline size, retention and migration timing; one noisy or blocked domain must not
prevent another from reconciling.

The server may expose an aggregate sync-status/wakeup endpoint returning all active
domain epochs and cursors in one small response. A global wake sequence may be used
only as an optimization to say "something changed" or to drive future SSE/push. It
must never replace the per-domain cursor used for replay correctness.

A domain should be the smallest set of state that needs one authority epoch,
retention policy and atomic invariant. Do not create one domain per SQL table, and
do not combine unrelated semantics merely to reuse transport code.

### Classification authority checkpoint — 2026-09-16

The next Classification cutover uses one `classifications` authority domain for
the hierarchy, appearance and the direct Asset → Classification assignment. These
are one atomic boundary because deleting a non-root classification reparents its
directly assigned Assets to the parent, deleting a root clears those assignments,
and moving a classification may derive a new `kind`. Splitting structure from the
assignment would therefore require cross-domain atomicity and preserve the current
stale-writer race.

Classification assignment is **single-valued per Asset** in the authority contract:
`asset_id -> classification_id | null`. This matches the shipped product operation
and normal-library invariant; N:N organization remains the separate Album domain.
Compatibility reads may continue exposing `classification_ids`, but authority-backed
normal Assets produce only `[]` or `[classification_id]`. Activation must reject,
not silently collapse, staged source data containing more than one Classification
for the same Asset.

The immutable `originals` role is carried in the Classification baseline. Authority
v1 enforces the id-level protections server-side: the protected Classification may
not be renamed, moved or deleted, and the role itself is not a mutable command. The
Existing rule that a character-series subtree may not be moved into `originals`
remains a PC-derived Character constraint for this cutover; Classification Authority
does not absorb Character-series state merely to enforce that rule. Non-PC structural
Classification editing therefore remains disabled until every accepted structural
command can be enforced by the authoritative contract. **Mobile membership/assignment
editing has since been added independently, as this checkpoint anticipated:** Android
now issues `setAssetClassification` only, through a durable single-Asset outbox, while
structural Classification commands stay PC/publisher-only. See the 2026-09-18 Android
write record in `roadmap/lakomics-completed.md`.

## Decision 2: common command envelope, domain-specific semantics
All mutable server-authority domains reuse the same command conventions:

- `libraryId`, `domain`, `epoch`, `contractVersion`;
- durable client-generated `operationId`;
- explicit `commandType` and stable entity key;
- desired payload, never an ambiguous toggle;
- entity revision or domain-specific preconditions captured when the intent formed.

The server records idempotency receipt, domain state mutation, ordered change and
cursor advance in one transaction. Retrying an accepted operation returns the
recorded result. Reusing an accepted operation ID with another payload conflicts.
A conflict that was never accepted may be rebased according to that domain's rule
without pretending the original server mutation succeeded.

Only the mechanics are common. Domain handlers remain typed and own validation,
atomic invariants and conflict behavior. A generic JSON event store is not the
canonical domain model.

Conflict classes are deliberately different:

- desired-state personal scalars may automatically rebase against current entity
  revision when preserving the same user intent is unambiguous;
- structural edits such as hierarchy changes must preserve the pending intent and
  surface a conflict instead of silently selecting a winner;
- automatic-analysis/provider results use fenced input revisions and are rejected
  when a newer manual decision or canonical input invalidates them;
- device wall-clock timestamps are never the authority tie-breaker.

Operation receipts are retained at least as long as supported change replay.
The product's normal disconnected target is one to two days; the common contract
should support at least a 30-day recovery window unless a domain intentionally
keeps longer history. Existing bookmark retention may remain longer.

## Decision 3: baseline and change replay
Every domain exposes a coherent baseline tied to a cursor and ordered changes after
that cursor. A baseline is complete-or-fail: a partial page must never be mistaken
for complete state.

Small domains may use the bookmark-style bounded single response. Large domains
such as assets/classifications may use a server-generated snapshot token/manifest
and deterministic pages. The client stages all pages against that snapshot identity
and only marks the baseline adopted once counts/digest/completeness checks pass.
Normal pagination cursors are not synchronization cursors.

Applying a change page and advancing the local domain cursor is one local
transaction. Remote apply must not create a new outgoing command.

If a client cursor predates retained history, the server returns an explicit
`cursorExpired`-style result. Recovery is:

1. preserve the durable local outbox;
2. obtain and validate a fresh domain baseline;
3. atomically replace only the confirmed local replica for that domain;
4. reapply pending optimistic intents locally;
5. rebase or surface conflicts according to domain policy;
6. resume normal ordered replay.

Absence from a delta page is never interpreted as deletion. Deletes use explicit
tombstones or domain commands. Tombstone retention must cover delayed clients and
product recovery policy.

## Decision 4: PC and Android replica shape

Both clients render their last committed replica immediately, then reconcile in the
background. Opening the UI does not wait for a full remote refresh.
The local data layer should converge on a common shape even when implementation
languages differ:

- per-domain sync state (`library_id`, epoch, contract version, cursor, baseline);
- durable outgoing intents keyed by operation ID and scoped to library/domain;
- confirmed entity revisions, including tombstones where required;
- domain-local optimistic state for immediate UI feedback;
- explicit blocked/conflict state instead of silently dropping an intent.

On PC, `library.sqlite` becomes a materialized replica plus workstation-only state.
It is rebuildable from server state after preserving unsent intents and local-only
metadata. Filesystem paths, local byte presence, FFmpeg/GPU execution state,
drag-out state, caches, credentials and UI preferences remain device-local.

On Android, the durable metadata database becomes the normal source for Library
browsing/search, sync cursors/outbox and Picker/provider metadata where practical.
`picker-library.json`, document metadata JSON and bookmark `localStorage` are
retirement targets only after equivalent native behavior is proven.

The Android and PC sync loops should use the aggregate status endpoint to detect
changed domains and then run domain-specific receive/flush logic. Foreground polling
around five seconds is an acceptable baseline; background wake/SSE/push is an
optimization, not a correctness dependency.

## Decision 5: media and jobs are referenced by state, not carried in the log

Asset changes carry stable media identity, hashes/status and available derivative
metadata. Image/video bytes are fetched through the authenticated media/R2 path and
are not embedded in metadata change logs.

Server authority means the server owns durable job identity and accepted results,
not that every job executes on the VPS. Heavy classification, similarity and FFmpeg
work may be leased to the current main PC; lightweight derivative/provider work may
run server-side. Result commits are fenced by the input/entity revisions they used.

## Decision 6: backup and recovery change under server authority
A whole old PC SQLite snapshot can no longer be a canonical rollback after any
shared domain has switched to server authority. It can restore stale cursors,
outboxes and shared state that the server has already accepted from another client.

The canonical recovery path becomes server-state restoration plus client replica
rebuild. Server backup must cover canonical database state and the media/object
manifest needed to reconstruct the same library generation. The product target is
roughly one month of recoverable server backups, copied to the main PC and a second
cloud destination.

PC recovery becomes:

- preserve or export unaccepted local intents and device-local settings;
- verify/pair to the intended `library_id`;
- rebuild confirmed shared domains from server baselines and deltas;
- reconnect or redownload local media opportunistically;
- regenerate disposable derivatives locally where appropriate.

Legacy full `library.sqlite` snapshots may remain usable only as an explicit
salvage/import source. They must not directly replace authority-managed sync tables
or silently change the paired `library_id` while connected.

The 30-day user-visible change/history feature is a separate semantic product log.
It must not be implemented by exposing the low-level synchronization change log,
whose shape and retention are protocol concerns.

## Decision 7: migration and legacy-write fencing

Cutover remains per domain. Before a domain accepts ordinary server-authoritative
writes, every legacy path capable of overwriting that domain is fenced by authority
epoch. Old clients may continue compatible reads, but their snapshot/publication or
restore write receives a coded conflict after activation.

Do not turn off the old publisher first. The safe order is:
1. add inactive-safe server substrate and coded legacy-write fence;
2. stage and validate a complete baseline against the still-active legacy source;
3. atomically activate the domain epoch and fence old writes;
4. switch PC/Android reads to the new baseline/change contract;
5. enable new commands/outboxes and prove response-loss/restart recovery;
6. retire old publication controls, supervisors and dirty triggers for that domain.

The first broader migration should start with the library structure paths that are
currently easiest for a stale PC to overwrite: classifications, albums and asset
membership. Catalog visibility/preferences can follow because bookmark authority
already established nearby infrastructure. Collection user state requires separating
provider-derived data from user-owned values first. Character manual state requires
new server contracts before its legacy `authority:'pc'` projection can be retired.
Global trash remains gated by its separate tombstone/recovery work.

## Initial implementation batch: safety substrate only

Before migrating another user-editable domain, implement a bounded safety batch that
changes no inactive-domain behavior:

- generalize/read the `authority_domains` registry without changing bookmark data;
- add a small aggregate sync-status contract for active domain epochs/cursors;
- define reusable coded errors for inactive, epoch mismatch, unsupported contract,
  stale legacy writer and expired cursor cases;
- provide a server-side helper/fence that legacy snapshot routes can adopt one at a
  time without duplicating authority checks;
- prevent the current full-PC restore path from silently replacing authority-managed
  state once any protected domain is active; the replacement UX may initially be a
  clear refusal plus "rebuild from server" follow-up;
- keep all existing routes byte/behavior compatible while no new authority row is
  active.

This batch does **not** activate classifications, albums or another new domain, does
not deploy production changes, and does not rewrite active library data.

Landed 2026-09-15 (implementation checkpoint, not a new plan):

- `server/lakomics-api/authority.py` reads the shipped `authority_domains` table.
  It never activates, mutates or migrates a row, and owns no domain state. Public
  helpers: `active_domains`, `active_domain`, `require_active`, `fence_legacy_write`.
- `GET /v1/sync/status` (`server/lakomics-api/sync_status.py`, registered in
  `app.py`) returns `{protocolVersion, active, libraryId, domains[]}` where each
  domain carries `domain`, `libraryId`, `epoch`, `contractVersion`, `cursor`. It is
  read-only and uses the shipped `client_guard` authorization. There is no global
  cursor field, by design.
- Coded error vocabulary: `authorityInactive`, `authorityAmbiguous`,
  `authorityLibraryMismatch`, `authorityContractUnsupported`, `legacyWriterFenced`.
  The shipped `cursorExpired` code string is reused rather than duplicated. Existing
  catalog-bookmark wire responses were left byte-compatible, including their
  existing uncoded 409 bodies.
- `fence_legacy_write(db, domain, library_id=None)` is a no-op with no authority
  row, rejects an active domain with `legacyWriterFenced`, and rejects a writer
  presenting another library with `authorityLibraryMismatch` so disagreeing about
  the library cannot bypass the fence. It performs reads only, so a legacy route
  can call it inside the same transaction as the protected write. No legacy route
  is wired to it yet.
- `restore_cloud_library_from_server` now calls `ensure_full_restore_is_safe`
  before the snapshot download and before any destructive step.
- **This batch also guards the local restore path.** `Library::restore_backup` and
  `restore_cloud_metadata_snapshot` share `restore_snapshot_locked`, which now calls
  `refuse_restore_with_adopted_authority` before any destructive work. It reads the
  still-intact current database through `library/restore_guard.rs`, whose `PROBES`
  list is the extension point: a domain adds one probe that reports whether its own
  local state has adopted a server authority. The shipped probe covers
  `catalog-bookmarks` (the `catalog_bookmark_sync` singleton row, which migration
  0080 defines as the adoption marker). An empty list means the legacy behavior
  proceeds unchanged, preserving pre-authority compatibility.
- Restore-specific error contract, one coherent set for both restore paths:
  * `RestoreAuthorityActive { domains }` — a domain is server-authoritative, or local
    state has adopted one. Refusal; nothing destructive ran.
  * `RestoreAuthorityUnknown` — the authority status could not be interpreted:
    an older server without `/v1/sync/status` (404), an unparseable body, a
    semantically inconsistent envelope, or an unexpectedly large domain list.
  * `SyncProtocolUnsupported` — the server reported an aggregate protocol version
    this build does not implement.
  * Credential and plain transport failures keep their own existing variants
    (for example `CloudUnauthorized`, `CloudRequestUnavailable`). They are still
    refusals but must stay actionable rather than being reported as an authority
    problem.
  All four classes fail closed: no class allows a whole-database restore to proceed.
- `CloudClient::sync_status` requires the exact supported aggregate protocol version
  and validates the envelope before any caller may read `!active` as proof that
  legacy restore is safe: `active == !domains.is_empty()`, inactive means
  `libraryId == null` and no domains, active requires a valid `libraryId`, every
  domain must carry that same library identity, domain names must be non-empty and
  unique, and `epoch >= 1`, `contractVersion >= 1`, `cursor >= 0`.
- Local pre-restore backup machinery, backup creation and backup listing are
  unchanged.

Album authority 2A — server baseline, contract and fence, landed 2026-09-15
(implementation checkpoint only; Album authority is **not** active anywhere, and no
client adopts it yet):

- `server/lakomics-api/album_authority.py` owns the `albums` domain. Typed state, not
  a JSON event store: `album_authority_state` (identity, name, parent, icon/color,
  tombstone, `entity_revision`), `album_authority_members` (Asset↔Album as a
  desired-state table with its own `desired_state` and `entity_revision`, so removal
  retains a tombstone revision), `album_authority_receipts`,
  `album_authority_changes` and `album_authority_retention`. It reuses the Safety
  Batch 0 `authority_domains` registry and adds no generic canonical-state abstraction.
- **Domain boundary**: canonical Album state is identity, trimmed non-empty name,
  parent hierarchy, icon/color appearance and Asset↔Album membership. Asset
  collected time, dimensions, video duration and media variants are *not* Album
  state; the legacy `album_replica` snapshot mixes both because it is a
  display-oriented read replica, and that shape is not the canonical model.
  Filesystem paths are never Album identity.
- Preserved PC invariants: trimmed non-empty names, case-insensitive unique sibling
  names, parent must exist, no self/descendant cycles, no delete with children,
  appearance values restricted to the `folder_appearance.rs` key sets (compared by
  test, not trusted), ordinary membership adds require an existing Album and committed
  Asset, and add/remove uses explicit desired state. Activation is the migration exception:
  a trusted version-3 baseline may retain a relation to an Asset not yet materialized on
  the server (for example local trash), while read projections hide that relation until
  the Asset becomes committed. A sibling-name UNIQUE violation at
  a valid current revision returns `duplicateAlbumName`; only a stale revision returns
  `revisionConflict`, matching the PC's own distinction.
- **Activation is bound to the staged snapshot, not to caller-supplied state.**
  `PUT /v1/library/album-snapshot` accepts a versioned shape whose wire name is
  camelCase `snapshotVersion` (the Pydantic field uses an explicit alias, so the
  documented contract and the accepted contract cannot drift). Version 1 is the older
  PC's identity/name/parent display snapshot; version 2 adds `icon_key`/`color_key`;
  version 3 adds the canonical `memberships` collection. Versions 1 and 2 remain
  accepted for the display replica, and **only version 3 is authority-ready**. The
  route returns the stored snapshot digest. The activation body carries only
  `libraryId` and `expectedSnapshotDigest`; inside one `BEGIN IMMEDIATE` the server
  re-checks the stored digest and derives Albums and memberships from **those stored
  bytes**. A caller therefore cannot present snapshot A's digest while activating
  unrelated state B. A version-1/2 snapshot is refused with
  `albumSnapshotNotAuthorityReady` rather than defaulting appearance to `null` or
  membership to the display array, because either default would silently destroy real
  user state.
- **Display state and canonical membership are separate fields.** The `media` array
  stays the normal-visible display replica. Version 3's `memberships` collection is
  canonical Album state built from every `asset_albums` relation regardless of Asset
  display status, because the PC deliberately preserves those relations when an Asset
  moves to trash and restoring it must return its Albums. A version-3 snapshot must
  state the field explicitly: an absent set is rejected as `missingAlbumMemberships`
  rather than read as empty, so a publisher cannot silently publish no canonical
  membership. Activation retains canonical relations even when their Asset is not yet
  materialized in the server Asset replica; this is required for local-trash relations
  that must survive restore. Authority reads join only committed Assets, so such withheld
  relations remain invisible until the Asset is materialized later. Ordinary new
  membership commands still reject `desiredState=true` for a missing/uncommitted Asset.
  The legacy `/v1/library/album-media` route is unchanged, so a trashed Asset does not
  start appearing in display output just because canonical membership is now richer.
- `POST /v1/albums/authority/activate` (publisher-only) writes the derived typed state,
  creates the `albums` epoch at cursor 0 and fences the legacy writer in that same
  transaction. Idempotent only for an identical retry (same digest and revision);
  any other second activation is rejected. There is no automatic activation at startup.
- **Paginated, frozen baseline.** An unpaginated response could not stay recoverable:
  100,000 memberships do not fit one bounded response, and ordinary commands keep
  adding memberships after activation. `GET /v1/albums/baseline` therefore returns one
  bounded page at a time. The first request establishes `snapshotCursor` (equal to the
  Album authority cursor); every later page supplies it, and a mutation in between
  returns `baselineChanged`, so pages can never describe two different states. Because
  every Album mutation advances this domain's cursor, that equality *is* the proof the
  materialized Album state did not move. Sections are `albums` then `memberships`,
  each deterministically ordered, and only the final membership page sets
  `complete: true` — no page subset can be mistaken for a whole baseline. Page sizes
  keep the worst-case encoded page under `MAX_BASELINE_PAGE_BYTES = 2 MiB`, measured by
  test at maximum-length identifiers rather than estimated. Deletion is never derived
  from absence: deletes leave tombstones carried by the change log.
- **The baseline carries membership tombstone revisions.** Membership pages include
  both live and tombstoned relations of live Albums, each with its authoritative
  `entityRevision` and `desiredState`. A baseline that listed only live relations would
  leave a fresh client able to compose only revision 0 for a relation someone had
  already removed, producing a false `revisionConflict` against a revision reached
  before that client existed. Tombstone rows are revision state, not visible
  membership: display membership remains `desiredState: true` only. Relations of a
  deleted Album are excluded, since no command can target them again.
- **Self-contained, replayable changes.** `GET /v1/albums/changes` rows carry the
  canonical delta directly: a structural change carries the full resulting
  `{"album": {id, name, parentId, iconKey, colorKey, deleted, entityRevision}}` and a
  membership change carries
  `{"membership": {albumId, assetId, desiredState, entityRevision}}`. A replica can
  therefore rebuild authority state from baseline + changes without a point-read after
  every change; a test adopts a baseline into a replica, runs create/rename/move/
  appearance/membership-add/membership-remove/delete, replays only the change rows and
  proves equality with authoritative state. `cursorExpired` still demands a fresh
  baseline, and `cursorAhead` stays distinct.
- **Two revision lineages, deliberately independent.** An Album's `entity_revision`
  versions its own projection; each `(albumId, assetId)` relation has its own
  `entity_revision` starting at 0 for a never-seen relation. Removal retains the
  tombstone revision so a later re-add can present it, and an already-matching desired
  state is accepted and receipted without a new change (or a revision the caller could
  not know). Because the lineages are separate, an Album revision cannot satisfy a
  membership compare-and-set, and a membership edit never bumps the Album.
  `setAlbumMembership` carries the relation's `expectedRevision`.
- **Staged snapshot upload bound.** `MAX_STAGING_BYTES = 96 MiB` replaces the inherited
  16 MiB, which could not admit a supported library (2,000 Albums + 100,000 display
  rows + 100,000 canonical relations encode to roughly 55 MiB at maximum-length
  identifiers). This is a publisher-only staging payload, not a normal mobile response,
  and a test measures the real encoded shape at the documented maxima rather than
  estimating it.
- **Cursor semantics.** For a changed command `authorityCursor` equals
  `changeSequence` — the cursor *after* acceptance. For an accepted no-op it is the
  existing cursor with no change sequence. The recorded receipt stores that same
  value, so a retry after a lost response returns the corrected acceptance cursor
  rather than one behind the change it describes.
- PC `album.rs` mutation behavior, Android Album UI/Picker,
  `cloud_metadata_publication_state(kind='albums')` and the migration 0076 triggers are
  all unchanged. The PC publisher now includes `snapshotVersion: 2` and each Album's
  appearance, which is the minimal change needed for a snapshot to be authority-ready.
  **Rolling-upgrade order matters** and is deliberate: (1) deploy the server that
  understands snapshot version 3; (2) then install the PC build that publishes version
  3; (3) verify the stored snapshot reports version 3 and the expected digest; (4) only
  then perform Album authority activation. Publishing version 3 against an older server
  would be rejected as an unsupported version, and activating a version-1/2 snapshot
  fails as not authority-ready.
  PC 2B must materialize only `desiredState=true` relations into `asset_albums` while
  retaining all membership revisions separately, and must consume the baseline's
  tombstone rows for compare-and-set.

Album authority PC 2B — durable replica, outbox and receive, landed 2026-09-15
(implementation checkpoint only; Album authority is **not** active anywhere, and the
legacy publication path is still the writer of record until activation):

- Migration 0082 adds the PC's durable Album state: `album_authority_sync` (the adopted
  identity/epoch/contract/cursor; its singleton row's presence *is* the adoption marker,
  so an unadopted library is byte-identical to before), `album_authority_revisions`
  (confirmed Album entity revisions including tombstones), and
  `album_authority_membership_revisions` (confirmed relation revisions keyed by the
  relation itself, so a rename can never satisfy a membership compare-and-set).
- `album_authority_outbox` is **strict FIFO and never coalesced**, unlike the bookmark
  outbox. Albums are structural: `create A -> rename A -> move A` are ordered dependent
  operations, and a later command must present the revision the queue ahead of it
  implies. `predicted_album_revision` composes that expectation from confirmed state plus
  queued operations; membership expectations come only from the separate membership
  lineage.
- Confirmed revisions and pending intent are deliberately separate. The revision caches
  record what the *server* confirmed; speculative revisions exist only inside queued
  payloads. The send half updates only the caches, because the following receive pass
  replays the ordered log and converges the visible materialization.
- **Sync order is flush-first**: `flush pending intents -> only when clean, receive`.
  The bookmark pilot deliberately uses `receive -> flush -> receive`. A received
  structural page must never replace a local edit the server has not accepted or
  explicitly rejected, so a non-empty queue defers the receive and reports
  `deferredToOutbox`. A blocked queue stops delivery entirely, because a later operation
  may depend on the unresolved one.
- A remote apply never enqueues. Baseline install and change replay write the replica and
  the caches and create no outgoing work, so the two halves cannot form a loop.
- Every accepted local Album mutation commits its durable intent in the same transaction
  as the local effect, so a crash cannot leave a changed Album with no queued intent nor
  an intent for an Album that never changed. Membership intents are per relation, because
  the server's command is per relation and one payload could not atomically
  compare-and-set several.
- Baseline install and change-page apply defer foreign-key checks inside their
  transaction: `albums.parent_id` is `ON DELETE RESTRICT` with an immediate check, so a
  wholesale replace and an out-of-hierarchy-order page would otherwise trip on their own
  intermediate states. A genuinely dangling parent is still refused at `COMMIT`.
- **A relation to an Asset this PC has not materialized still converges.** The authority
  accepts assets from more than one ingest route, and a fresh PC rebuilds Albums before
  it reconnects local media, so a correct relation can legitimately name an Asset absent
  locally. Failing that page would stop the domain cursor forever on correct state, so
  the confirmed relation revision is always recorded and only the *visible* `asset_albums`
  row is conditional on the Asset existing. The display row converges on the next
  baseline adoption, which compares the authority's live set against the local table.
  First adoption is stricter on purpose: activation ran from this PC's own staged
  snapshot, so a baseline relation to an Asset absent locally is a genuine divergence and
  returns `AlbumFirstAdoptionMismatch`. Relations to *trashed* Assets are materialized and
  compared without filtering by status, because the PC retains them so restoring the
  Asset returns it to its Albums.
- First adoption on the main PC requires the server baseline to match the local Album
  state exactly (`AlbumFirstAdoptionMismatch` otherwise): the authority was activated
  from this PC's own staged snapshot, so a difference means the activation raced the PC
  and overwriting local state would destroy data rather than converge it. Re-adoption
  after a library/epoch change replaces the replica and the caches together.
- `cursorExpired` and `cursorAhead` recover with a fresh baseline, bounded to a few
  attempts because any Album command advances the cursor and a concurrent change
  invalidates a frozen snapshot mid-walk.
- The restore guard gained an `albums` probe, so a whole-database swap is refused while
  Album authority is adopted locally.
- Frontend: `useAlbumAuthoritySync` runs flush-then-receive every 5 seconds plus
  online/focus recovery, and each local Album mutation attempts an immediate flush so the
  window where another device sees the old structure stays short. A remote page that was
  actually applied announces a sidebar refresh.

Album authority PC 2B.1 — review fixes, landed 2026-09-15 (still no active Album
authority; the legacy publication lane is consumed, not deleted):

- **Multi-page catch-up.** Progress is now measured against the cursor a page was
  *requested* from. Comparing a freshly assigned cursor against itself could never fail, so
  every honest `hasMore` was reported as a protocol error and catch-up was capped at one
  page (100 changes), leaving the local cursor behind permanently. A repeated or regressing
  `nextAfter` is still rejected.
- **Withheld memberships are no longer baseline-only.** A confirmed relation whose Asset is
  not yet local had no guaranteed recovery: a client whose epoch and cursor stay valid can
  reconcile incrementally forever without adopting another baseline. Every clean cycle now
  runs an idempotent local projection that materializes such relations once their Asset
  exists. It invents no revision, writes no outbox row and advances no cursor; it is skipped
  while any intent is unresolved, so confirmed state cannot overwrite the user's pending
  edit. Tombstones and deleted Albums stay absent, and trashed Assets still materialize.
- **Legacy publication handoff.** Before local adoption the `albums` metadata lane is
  byte-identical to before: a dirty generation publishes version-3
  `/v1/library/album-snapshot` and acknowledges on success. After adoption the generation is
  *consumed locally without any request*, because the route is fenced server-side and the
  Album outbox/change protocol owns the state. Migration 0076's triggers still fire —
  including for a remote apply — so without consuming the generation the fenced route would
  be retried forever and report a permanent publication failure. Triggers, publication
  tables and the server route are all still present. `classifications` and `saved_x` are
  unchanged.
- **Accepted responses are validated against the stored command.** A 200 is only an
  acceptance of *this* intent if `libraryId`, `epoch`, `contractVersion`, `operationId` and
  `commandType` agree exactly with the stored payload, the returned projection is the single
  kind the command targets, and the entity matches the command target (Album id for a
  structural command; `(albumId, assetId)` for a membership command). Without this, a
  mismatched echo would retire the wrong queue row and write a foreign revision into the
  confirmed caches. A malformed 200 is an explicit protocol-integrity error that preserves
  the intent.
- **Coded rejections are mapped by code, never by status.** Authority/protocol states stay
  typed errors rather than user conflicts: `authorityInactive`, `authorityLibraryMismatch`,
  `authorityAmbiguous`, `authorityContractUnsupported`, `unsupportedAlbumCommand`,
  `operationConflict`, and the malformed-command codes (`invalidAlbumCommand`,
  `invalidAlbumRevision`, `emptyAlbumName`, `albumNameTooLong`, `invalidAlbumAppearance`,
  `invalidAlbumBaseline`), which get a dedicated `AlbumCommandRejected { code }` because
  reporting them as a contract upgrade would be false. Semantic structural rejections durably
  block the intent without rebasing: `revisionConflict`, `duplicateAlbumName`, `albumCycle`,
  `albumHasChildren`, `albumExists`, `albumNotFound`, `invalidAlbumParent`,
  `invalidAlbumMembership`. An uncoded or unknown result stays retryable with the identical
  operation id and payload, and a 422 no longer collapses into `AlbumContractUnsupported`.

Android 2C-1 landed 2026-09-16 (below). The remaining Album work is 2C-2: additive
Album readers and then Album editing.

**Correction (2026-09-16): Classification and Album are separate canonical domains.**
An earlier draft of 2C-2 described it as cutting Photo Picker, `LibraryDocumentsProvider`
and the WebView Library *from* a classification-backed model *to* the Album replica. That
framing was wrong, and the source proves it:

* `classifications`/`classification_entries` (migration 0001, `kind IN
  ('root','work','tag')`) and `albums` (migration 0008) are different tables with different
  schemas, different hierarchies and different ids. Neither is derived from the other.
* The desktop UI already distinguishes the two actions: `target.kind === "album" ?
  "앨범에 추가" : "폴더로 이동"`. Adding to an Album and moving to a folder are different
  user operations.
* The WebView Library sidebar renders Classification *plus* Character/Group navigation from
  the character index, which has no Album equivalent at all.

So the existing `class:<classification-id>` Photo Picker collections and
`class:<classification-id>` DocumentsProvider directories are **not** a second canonical
Album source: they are the Classification domain exposed through Android collection/folder
APIs. Album Authority governs only Albums and Album↔Asset membership, and its work is
additive. `class:` and `album:` identifiers coexist because they name different domains, and
Classification/Character navigation is never removed, replaced, renamed or retired as part of
Album Authority work. When Album authority is inactive, or the current Android connection
scope has not adopted it, only Album-specific surfaces are absent; Classification and
Character functionality continues unchanged.

Two further consequences follow from that boundary:

* **`/v1/library/album-media` is not the new authority read source.** It reads the legacy
  display-oriented `album_replica` snapshot, whose shape mixes Album state with Asset display
  state. An authority read needs a dedicated projection over authoritative membership.
* **Album membership alone cannot render Asset rows.** The replica stores Album identity,
  hierarchy and `(albumId, assetId, desiredState, entityRevision)` only — no content type,
  size or dates. Asset metadata must keep coming from the Asset projection, and Asset
  metadata must not be duplicated into `library-replica.sqlite`.

Album authority Android 2C-1 — durable read-only Album replica foundation, landed
2026-09-16 (implementation checkpoint only; Album authority is **not active anywhere**,
Android Album writes are still disabled, and no production Album authority was
activated). This batch is deliberately smaller than PC 2B.

- **A second, general-purpose Android database.** `library-replica.sqlite` is app-private
  and separate from `notes.sqlite`, because Notes is an encrypted personal domain with its
  own sync rules and merging the two would couple an encrypted store to a plaintext
  authority replica that must be replaceable wholesale. `PRAGMA user_version` 1 holds the
  Album domain. `LibraryReplicaStore` owns every rule about what the replica holds — which
  rows are written, which are retained as tombstones, when the cursor moves, and what one
  transaction contains — over a semantic `ReplicaDb` seam; `AndroidReplicaDb` is a
  mechanical translation that also owns the file location. The seam is deliberately not a
  SQL executor: passing SQL through it would put the schema and the transaction semantics
  on the Android side, leaving the store's rules testable only by re-implementing SQLite.
- **Retained tombstones on both lineages.** `album_state.deleted` and
  `album_membership_state.desired_state = 0` are revision state, not absence. The baseline
  carries membership tombstones so a fresh client can compose the next command for a
  relation someone already removed instead of presenting a false revision 0, and deleting
  an Album retires its live relations without bumping them, because the delete change row
  carries only the Album tombstone and an invented relation revision could not be
  reproduced by replaying it.
- **Android is already a replica, so first adoption does not compare against local
  canonical state.** The PC's `AlbumFirstAdoptionMismatch` rule exists because activation
  ran from that PC's own staged snapshot; on Android a difference is convergence, not
  divergence. Adoption is still complete-or-fail: every page is accumulated outside the
  live replica and installed in one transaction only after the final membership page
  reports `complete`, so a failed or interrupted walk leaves the previous replica byte-
  identical.
- **Ordered replay with a single transaction boundary.** Contiguity is checked against the
  stored cursor *inside* the transaction that writes the page and advances the cursor, so
  the cursor can never advance over a change that was not applied. Progress is measured
  against the cursor a page was requested from, which is what makes honest multi-page
  catch-up work rather than reporting `hasMore` as a protocol error.
- **Coded recovery, never status-based.** `cursorExpired`, `cursorAhead` and
  `baselineChanged` all arrive as 409 and all recover by adopting a fresh baseline; mapping
  by status would collapse them into one meaning. That recovery is safe in this batch
  precisely because there is no Android write queue: there is no unaccepted intent a
  baseline could overwrite. `authorityInactive` and `authorityContractUnsupported` write
  nothing, and an identity/epoch change re-adopts because the stored cursor describes a
  different authority.
- **The allowlist is the enforcement, not a convention.** `NetworkPolicy` gains exactly
  three read-only paths and `PUT /v1/albums/commands` stays blocked, so a future editing
  batch cannot appear by accident. The 4 MiB generic response limit is unchanged: baseline
  pages are server-bounded at 2 MiB.
- **Foreground-only scheduling.** `AlbumReplicaService` reconciles on resume and then about
  every 5 s, is single-flight, takes no wake lock and schedules no WorkManager job. A pass
  in flight when the connection changes is invalidated so it cannot publish the replaced
  account's state. The replica is scoped by an opaque endpoint+token hash following the
  existing native cache convention, and a connection change clears it without touching
  user media.
- **Consumers are deliberately not cut over.** `PickerLibrary`/`PickerSnapshot`
  `class:<classification-id>` albums, `LibraryDocumentsProvider` metadata caching and the
  WebView Library's server-direct reads are all unchanged; `album:<album-id>` is not added
  to Photo Picker yet. The bridge gains one read-only `albumStatus` operation and no Album
  mutation operation.
- Verification: 124 new native checks against a real local HTTP fixture and a real SQLite
  engine, with the atomicity and contiguity claims mutation-tested; NetworkPolicy 266,
  DocumentTreePolicy 19, ThumbnailCache 19, MediaTransfer 22, TemporaryImagePolicy 23,
  NotesCrypto 4 and PickerSnapshot unchanged; 137 existing mobile frontend tests; and the
  server's own `tests/test_album_authority.py` (63 passed). The real server's baseline and
  change documents were additionally fed through the shipped Java parser and engine
  validation. Android device/runtime verification is unperformed.

Album authority Android 2C-1.3 — Scope H read isolation, landed 2026-09-16 (still no
active Album authority; Android Album writes remain disabled):

- **Replica reads are scope-aware at the store boundary.** `adopted(scope)` already hid an
  authority stored under another connection, but `status()`, `albums()` and `memberships()`
  returned the stored rows regardless of which connection owned them, and
  `AlbumAuthoritySync.liveAlbums()`/`liveMemberships()` exposed those unscoped reads. A
  connection that was told "not adopted" could therefore still be handed the previous
  connection's Albums, memberships and diagnostic counts.
- Every read now takes the scope explicitly: `State.status(scope)`,
  `State.albums(scope, liveOnly)`, `State.memberships(scope, liveOnly)`, and the sync-facing
  `status(scope)` / `liveAlbums(scope)` / `liveMemberships(scope)`. The scope is a required
  argument rather than an implicit field, so 2C-2 consumers cannot drift back onto an
  unscoped path.
- A private `owns(scope)` performs the check, and it runs **inside the same lock** as the row
  read it guards. Reading the authority and the rows in two separate critical sections would
  let a replacement land between them and serve one connection's rows under another's
  identity.
- Rows are hidden, never deleted. A mismatched read returns nothing and zero counts; the
  durable revision state, including tombstones, stays in place for whichever scope owns it.
  Only an explicit replacement/reset performs the existing clear.
- `AlbumReplicaService.status()` resolves the configured scope once and uses it for both the
  identity and the counters, so the two cannot describe different connections.
- Verification: 190 AlbumReplicaTest checks (33 new Scope H checks) and 39
  AlbumReplicaScheduleTest checks, NetworkPolicy 266, DocumentTreePolicy 19, ThumbnailCache
  19, MediaTransfer 22, TemporaryImagePolicy 23, NotesCrypto 4 and PickerSnapshot unchanged,
  native compilation against android-35, `d8 --release` DEX packaging and `git diff --check`.
  Each of the four scope checks (albums, memberships, counts, ownership predicate) was
  mutation-tested. Baseline adoption, incremental replay, timer generations, owed-pass
  behavior and NetworkPolicy are unchanged.

Album authority Android 2C-1.2 — generation, ordering and wire-boundary corrections,
landed 2026-09-16 (still no active Album authority; Android Album writes remain disabled):

- **Arm generations are real, not a shared flag.** A restart disarms and re-arms in one
  step, so a repeating task left over from the cancelled arm saw `armed == true` again —
  for a *newer* arm — and ran a pass that no longer belonged to it. Each armed timer now
  carries a generation, and `tick` compares it under the same monitor that arms and
  disarms; the callback also runs while that monitor is held, so a restart either completes
  before a tick or waits for it. That makes the boundary atomic rather than a narrowed race
  window.
- **Replacement ordering is explicit.** `restartAfter(invalidate)` runs the invalidation
  *before* arming, because arming invokes the immediate pass synchronously: arming first let
  the replacement connection's own reconciliation be invalidated by the clear that followed
  it, and since that pass had started nothing was recorded as owed, so the new connection
  waited for the next interval. `ForegroundSchedule` now owns both steps so their order
  cannot be reintroduced as a caller mistake.
- **A refused immediate pass is owed, not dropped.** Single-flight refuses a request while
  a pass is in flight. The immediate callback reports whether it started, and
  `passFinished()` starts an owed pass when the slot frees — so a resume or a replacement
  connection reconciles as soon as single-flight permits instead of at the next interval.
  A stopped schedule owes nothing.
- **A successful changes page is bounded by the advertised authority cursor.** The server
  answers `after > cursor` with 409 `cursorAhead`, so in any 200 both the requested cursor
  and the resulting `nextAfter` are bounded by `cursor`. Without this, an empty page that
  claimed to continue past the authority was accepted whenever `hasMore` agreed with it —
  which it does when both sides are false. The continuation rule and the store's contiguity
  rule are unchanged and still protect their own invariants.
- Verification: 157 AlbumReplicaTest checks and 39 AlbumReplicaScheduleTest checks,
  NetworkPolicy 266, DocumentTreePolicy 19, ThumbnailCache 19, MediaTransfer 22,
  TemporaryImagePolicy 23, NotesCrypto 4, PickerSnapshot unchanged, 137 mobile frontend
  tests, the server's own album suite (63 passed), native compilation, `d8 --release` DEX
  packaging and `git diff --check`. The real server's documents were re-fed through the
  shipped parser. Every rule above was mutation-tested, including the two bounds separately
  and the lock boundary across the callback.

Album authority Android 2C-1.1 — lifecycle fix and changes-page hardening, landed
2026-09-16 (still no active Album authority; Android Album writes remain disabled):

- **Connection replacement no longer stops reconciliation.** `reset()` stops polling, and
  `configure` called it without any pause/resume cycle to re-arm the loop, so after
  configuring or replacing the connection while the activity stayed foregrounded, Album
  reconciliation stayed stopped until the user backgrounded and resumed the app. The
  transitions now live in `ForegroundSchedule`, and `configure` uses
  `AlbumReplicaService.replaceConnection()`, which restarts the schedule and clears the
  replica in one step. It deliberately does **not** compose `reset()` with a restart:
  `stop()` means "the activity left the foreground", so clearing first would make the
  restart unable to re-arm. `disconnect` still uses `reset()` — it must not poll against a
  configuration that no longer exists.
- `ForegroundSchedule` is the smallest seam that makes this testable: it owns whether the
  activity is foregrounded, whether the repeating pass is armed, and the handle that
  cancels it. A tick already dequeued when the pass was cancelled is ignored by the state
  machine itself, so no caller has to remember to check. The connection-race `attempt`
  guard, scope isolation, replica clearing and single-flight behavior are unchanged.
- **The changes page must now describe exactly the rows it sent.** The parser requires
  `nextAfter` to equal the last change's `sequence` (or the requested cursor for an empty
  page) and `hasMore` to equal `nextAfter < cursor`, which is how the server derives both.
  A page whose continuation disagrees with its rows, or that omits rows and would otherwise
  look like an honest empty page, is refused before it is committed. The engine keeps its
  own progress guard, because an empty page that honestly reports more work without
  advancing satisfies the parser and would otherwise be requested forever.

Android 2C-2 remains, under the corrected boundary above: add Album-specific surfaces
alongside the untouched Classification/Character navigation, then expose Album editing with a
durable outbox. No Classification/Character surface is retired by this work, and the legacy
`album_replica`-backed publication path is a separate retirement question.

### Album authority 2C-2 — domain-boundary correction, authority Album contents read, additive Android readers

Landed 2026-09-16. No production Album authority was activated; the acceptance sequence
below ran on an isolated test server.

**Server.** `GET /v1/albums/assets` is the authority-backed Album contents projection.
It requires an active Album authority and validates `libraryId`/`epoch`/contract like the
other Album read routes; contents come from `album_authority_members` rows with
`desired_state = 1` joined to committed `assets`; a deleted Album returns
`404 albumNotFound` rather than an empty page; pagination is a strict
`(COALESCE(collected_at, created_at), id)` descending walk with the Album id bound into
the cursor, so a cursor cannot be replayed against another Album and the walk cannot loop.
Asset display metadata is joined from the Asset domain, never copied into the replica.
The mobile Asset projection is injected from `app.mobile_asset_item`, so there is exactly
one display shape. `/v1/albums/commands` remains the only write route and Android still
does not call it.

**Android.** `AlbumCollections` is the platform-free additive projection: visible Albums
and live memberships become `album:<album-id>` collections beside the untouched
`class:<classification-id>` ones, tombstones are hidden while retained, and an unadopted
or replaced connection contributes nothing. The Photo Picker merges those memberships onto
Assets it already found eligible, so an Album cannot make an ineligible Asset visible. The
DocumentsProvider exposes an explicit `Albums` directory beside the Classification tree
and reads its contents from `/v1/albums/assets`; `DocumentTreePolicy` keeps the two
namespaces mutually unreachable. The WebView adds a distinct Albums section that renders
nothing while Album authority is unadopted. `/v1/albums/assets` was added to
`NetworkPolicy` only now that a consumer exists.

**Corrected during review.** An earlier draft of 2C-2 described this as a
Classification-to-Album source cutover (see the correction above). It is additive:
`class:` and `album:` coexist, Classification/Character navigation is unchanged, and only
Album-specific surfaces are absent when Album authority is inactive.

**Galaxy Tab device acceptance, 2026-09-16.** The isolated authority fixture was exercised
end to end on the Galaxy Tab. The WebView Album dialog exposed two device-only integration
defects that are now covered by regressions: `/v1/albums/assets` returns camelCase
`hasMore`/`nextCursor`, and the portrait drawer's visible Album reader must not inherit the
hidden desktop reader's paused state. With those fixes, a 45-Asset Album requested its
40-item first page and its 5-item continuation on device. Android Photo Picker then showed
Classification and Album collections side by side, including parent/child Album paths, and
a 10-member child Album returned exactly those 10 Assets. The personal-device cloud-provider
allowlist was switched from the retired PoC package to `com.lakomics.mobile`, after which the
main `com.lakomics.mobile.cloud` provider supplied the collections. A real HTTPS PNG fixture
was fetched through media tickets, displayed in Photo Picker, selected, and uploaded by the
calling app. SAF/DocumentsProvider showed the separate `Albums` tree, rendered the same real
thumbnail when `thumbnail_available` was advertised, and a temporary receiver app read the
selected original as 8,090 bytes with the expected SHA-256. The temporary server and media
fixture were isolated under `/tmp`; no production Album authority or production data was
modified.

### Album authority Android 2C-3 — membership-only optimistic writes and durable outbox

Implemented 2026-09-16 without production authority activation or production data writes.
The first Android write slice is intentionally **membership-only**: a Viewer Asset can be
added to or removed from an existing Album. Album create/rename/move/delete/appearance stay
PC-only, and Classification/Character behavior is unchanged.

`library-replica.sqlite` schema version 3 owns `album_authority_outbox`. A real local
membership transition writes the optimistic `album_membership_state` value and one immutable
`setAlbumMembership` command in the same SQLite transaction; selecting the already-desired
state is a no-op. Multiple real toggles for one relation remain strict FIFO rather than being
coalesced, and each later command predicts its `expectedRevision` from the last confirmed
membership revision plus its queued predecessors, matching the PC model. The stored operation
id and payload are reused after a lost response. A semantic conflict is retained as a durable
`blocked` row and stops later delivery; the optimistic choice remains visible rather than
silently choosing a winner.

The foreground Album cycle is now **flush -> receive only when the outbox is clean**.
Successful acceptance updates confirmed membership revision and retires only that outbox row;
a later optimistic toggle for the same relation is not overwritten. Each outbox row stores
its `libraryId`, epoch and contract version as durable identity in addition to the frozen
payload. Baseline re-adoption and incremental change application re-project only queued
intents composed for that exact authority identity. A replacement library/epoch/contract
blocks mismatched rows inside the same transaction that installs the new confirmed state, so
an old optimistic choice can never appear inside a replacement library and is never silently
rebased across revision lineages. `cursorExpired` recovery under the same identity still
replays pending intent after the fresh baseline. Because the outbox contains state the server
may not know yet, an unknown future replica schema is no longer deleted by an older app: it is
preserved and opening fails closed. The known read-only v1 schema creates v3 directly. The
unreleased intermediate v2 schema upgrades conservatively to v3: missing library/contract
identity columns receive non-sendable sentinel values, preserving any row while forcing it to
block instead of guessing its authority.

Android's network allowlist now exposes exactly one Album write route,
`PUT /v1/albums/commands`; all other Album mutation paths remain denied. Accepted command
responses are validated against the stored library/epoch/contract/operation/entity/desired
state before a queue row can be retired. Photo Picker refresh is requested after accepted
membership writes so its published collection snapshot can catch up without making it a
second source of truth.

Viewer adds an `앨범` action with a hierarchy-preserving checkbox dialog. Local persistence
changes the checkbox immediately; pending rows show `저장 대기` and blocked rows show
`동기화 충돌`. 2C-4 adds explicit conflict resolution instead of an automatic merge policy:
`서버 상태 사용` discards the blocking intent, restores confirmed authority state and then
replays later immutable FIFO intents for presentation; `내 선택 다시 적용` discards the
blocker and creates a brand-new operation id/payload against the current authority identity
and confirmed membership revision. Later queued payloads are never silently rebased.

Verification covers atomic optimistic enqueue, same-state no-op suppression, FIFO revision
prediction, SQLite restart durability, lost-response retry with the same stored payload,
strict accepted-result validation, durable conflict blocking, flush-before-receive ordering,
baseline replay of pending intent, library/epoch replacement recovery, future-schema
fail-closed behavior and network allowlisting. The mobile frontend suite covers Viewer entry,
hierarchy, optimistic checkbox state, pending/conflict presentation and five-second local
refresh.

**Galaxy Tab isolated write acceptance, 2026-09-16.** The production Android storage/outbox
classes were executed directly on the real tablet runtime through a temporary `app_process`
harness, using only `/data/local/tmp` and an isolated PC test server. The device created a
real Android SQLite replica, enqueued `root` ↔ `asset_1` from confirmed tombstone revision 3,
sent the stored `setAlbumMembership` payload through the production `NetworkPolicy`, received
and validated a 200 acceptance, retired the outbox row and retained `desiredState=true` at
confirmed revision 4. Final device output was `PASS android-sqlite schema=3 identity-bound outbox=0 sent=1
desired=true revision=4`; the isolated server independently logged one
`PUT /v1/albums/commands` 200 for the same operation id. The main Lakomics package/settings
and production Album authority/data were not used for the write fixture. The normal APK was
also updated in place from the intermediate v2 database to v3 and cold-started successfully
with no fatal, missing-column or SQLite migration error in the startup log.

**Production Album cutover, 2026-09-16.** After a verified SQLite online backup and a
version-3 staged snapshot, production Album authority activated at epoch 1 / contract 1 with
3 Albums and 39 canonical memberships. Seven baseline relations initially failed the committed-
Asset activation guard; all seven were local-trash Assets, so activation was corrected to retain
trusted staged relations while Album display continues to hide unmaterialized Assets. The focused
server authority/asset regression suite passed 111 tests before the hotfix was deployed. PC then
adopted the same authority, consumed the legacy Album publication generation locally instead of
sending a fenced snapshot, and Android adopted through the existing Tailscale Serve connection.
A reversible membership canary completed both directions: PC remove/add advanced the authority
cursor 0 -> 2 and Android followed; Android remove/add advanced 2 -> 4 and PC followed. Final
state restored the relation live at revision 5 with PC outbox 0 and all 39 memberships present.
The user performed the frontend membership toggles; verification outside the UI used server/PC
state and logs.

**Galaxy Tab production conflict-resolution acceptance, 2026-09-16.** The signed 2C-4
APK was installed in place and both explicit conflict actions were exercised against the live
Album authority with a reversible stale-revision scenario on the same `임시` membership.
For `서버 상태 사용`, Android's queued remove first received `409 revisionConflict` after PC
advanced the relation to revision 7; resolving the blocker produced no new command receipt or
cursor advance, restored the server's live membership locally, and Android resumed polling from
`after=7`. For `내 선택 다시 적용`, a second queued remove conflicted after PC advanced the
relation to revision 9; resolving it generated a fresh operation against the current confirmed
revision, the new `PUT /v1/albums/commands` returned 200, and authority advanced to cursor 10
with `desired_state=false`, revision 10. PC then reconciled that exact state with outbox 0. The
user restored the membership normally; final authority/PC state is cursor 11,
`desired_state=true`, membership revision 11, PC outbox 0. The later live membership total is
40 rather than the activation baseline's 39 because an independent `업로드용` membership was
added earlier at authority sequence 5; server and PC agree on 40. All frontend conflict actions
were performed by the user; command/receipt/cursor and PC convergence evidence came from the
server and local replica state.

**Still not done.** Android structural Album editing and retirement/removal of the legacy
`album_replica` publication implementation. The path is fenced and no longer the writer after
cutover, but code/schema removal remains a separate follow-up.

## Consequences
Positive:
- PC and Android can share one synchronization model without becoming thin REST clients.
- Domain failures and migrations stay isolated instead of sharing one fragile global cursor.
- Old clients cannot regain authority by replaying a stale snapshot.
- A damaged or replacement PC can rebuild without trusting an old SQLite file as truth.
- Android can replace overlapping JSON/localStorage replicas with one durable local source.

Costs:
- Each domain still needs explicit typed commands, projections and conflict rules.
- Large-domain baseline staging and validation are more work than simple page caching.
- Existing backup/restore and publication UI must be retired carefully rather than deleted early.
- Server backup becomes more important because canonical state is no longer recoverable from one PC DB alone.

## Acceptance for the common contract

Before calling the substrate proven beyond bookmarks, tests/evidence must cover:

- inactive domains preserve old behavior;
- authority activation and legacy-write fencing are atomic;
- lost command responses retry idempotently without double apply;
- concurrent stale edits return current authoritative state rather than choosing by time;
- local change apply and cursor advance are atomic and do not enqueue a mirror command;
- cursor expiry preserves pending local intent through a fresh-baseline rebuild;
- a stale PC snapshot and a legacy full-DB restore cannot overwrite an active domain;
- a fresh PC can pair to the same `library_id` in a different local path and rebuild;
- Windows/Linux PC and Android can converge the same domain after restart/offline use.


### Classification authority 2A — inactive server substrate, landed 2026-09-16

Implementation checkpoint only. Classification authority is **not active anywhere**, no
production data was touched, and no legacy publication/replication/capture route changed.

- `server/lakomics-api/classification_authority.py` owns the `classifications` domain:
  `classification_authority_state` (kind, name, parent, appearance, tombstone,
  `entity_revision`), `classification_authority_assignments`, `classification_authority_roles`,
  receipts, ordered changes and retention. It reuses the Safety Batch 0 `authority_domains`
  registry and adds no generic canonical-state abstraction.
- **Domain boundary**: hierarchy, appearance and the direct Asset -> Classification assignment
  are one epoch because deleting a non-root classification reparents its directly assigned
  Assets, deleting a root clears them, and a move may derive a new `kind`. Asset presentation
  metadata and the trashed-vs-normal distinction are not Classification state; character-series
  membership is not absorbed either.
- **Assignment is single-valued**: `(library_id, asset_id) -> classification_id | null`, keyed
  by the Asset, deliberately not Album's independent relation. An unassigned Asset is a retained
  row at `entity_revision >= 1`, so clearing is a comparable value and two Classifications can
  never both hold one Asset. Compatibility reads may still expose `classification_ids` as `[]`
  or `[classification_id]`. 2A.1 must reject, not collapse, staged data assigning one Asset to
  several Classifications.
- Commands: `createClassification`, `renameClassification`, `moveClassification`,
  `deleteClassification`, `updateClassificationAppearance`, `setAssetClassification`, with the
  ADR-0037 envelope and per-command compare-and-set. Derived move semantics are preserved
  (`root` under a parent becomes `tag`, `tag` at top level becomes `root`; a `work` keeps the
  PC's parent rules), as are trimmed non-empty names, case-insensitive sibling uniqueness via a
  **partial** unique index (a tombstone must not reserve its name), parent/kind validation,
  cycle prevention, and the appearance key sets compared against `folder_appearance.rs` by test.
- **Delete is one atomic change.** The PC moves every directly assigned Asset to the deleted
  node's parent, or clears them for a root. That effect is expressed as **one** change row — the
  Classification tombstone plus a deterministic assignment transition
  (`fromClassificationId` -> `toClassificationId`, every matching assignment revision
  incrementing by exactly one, with an `affectsAssignments` count) — so `GET /changes` can never
  split a delete into an externally committable partial state. Emitting one row per affected
  Asset would let a replica commit a page where the Classification is already deleted while only
  some assignments moved. Because the baseline carries every assignment row, including unassigned
  and not-yet-materialized ones, a replica at the preceding cursor applies the whole transition
  in one local transaction with no point read, and one accepted state-changing command advances
  the cursor exactly once. Idempotency remains owned solely by the
  `(library_id, epoch, operation_id)` receipt.
- **The protected role ships in the baseline.** `originals` is immutable authority state that no
  command can produce, so it has no change row to be learned from; a small deterministic `roles`
  projection is carried on every baseline page instead, so a fresh PC rebuilds the protected id
  from server authority alone. It is carried whole rather than as a second paginated section
  (v1 has exactly one role, bounded by the schema's own `CHECK`), and its worst-case encoded cost
  is measured by test.
- **Structural commands are publisher-only.** `setAssetClassification` accepts an ordinary client
  credential because assignment is the normal organization action; create/rename/move/delete/
  appearance require the publisher role, since R2 leaves the character-series-into-originals rule
  to the PC and the server therefore cannot yet enforce every structural invariant itself. This
  reuses the shipped `client_guard`/`publisher_guard` roles, and the legacy shared credential is a
  client and never gains publisher capability. Authorization runs before envelope validation, so
  an under-privileged caller cannot probe the structural command contract.
- **Each baseline page is internally coherent.** The baseline route opens one explicit read
  transaction covering the authority-row/cursor read and the page-state read; without it Python's
  sqlite3 issues two independent snapshots, so a command committing between them would produce a
  response labeled with an older `snapshotCursor` while carrying newer canonical state. The
  cross-request `baselineChanged` check is unchanged.
- **U1 boundary (v1)**: the immutable `originals` role is carried, and the server refuses
  rename/move/delete of the protected id (and the role has no command at all). The PC-side rule
  that a character-series subtree may not move into `originals` stays a Character-domain derived
  constraint; Classification Authority does not carry series state to enforce it. Non-PC
  structural editing therefore stays disabled, and Android structural editing is out of scope.
- **No activation path ships in this batch**, not even an unused route. Routes are
  `/v1/classifications/authority/{baseline,changes,commands}` under a dedicated prefix, because
  `/v1/classifications` and `/v1/classifications/meta` already belong to the legacy published
  snapshot; while no authority row exists every route returns `authorityInactive`, and the
  baseline uses the Album contract (frozen `snapshotCursor`, `baselineChanged`, two ordered
  sections, `complete` only on the final assignment page, `cursorExpired`/`cursorAhead`).
- Verification: `tests/test_classification_authority.py` (114 tests, 48 subtests) covers inactive
  behavior including a legacy-state immutability check, create/rename/move/appearance/delete
  validation, derived kinds, cycles, sibling uniqueness, `originals` protection, assignment
  create/change/clear, stale-revision conflicts, idempotent retry and operation-id reuse, baseline
  paging and determinism, baseline + ordered-change replay equivalence, cursor semantics, the
  role projection on every page, the client/publisher authorization boundary, and delete
  atomicity under a changes-page limit smaller than the affected assignment count. Fourteen
  mutations of the load-bearing rules were each detected, including a delete split back into
  per-asset rows and a baseline missing its read transaction. The full server suite passed 635
  tests.
- **Follow-up (not fixed here): `album_authority.py` has the same baseline read pattern.** Its
  baseline and assets routes read the authority row and then page state without an explicit read
  transaction, so the same two-snapshot window exists there. It is outside this correction pass's
  Classification scope and is recorded as a separate follow-up rather than widened into Album
  code.

### Classification 2A.1 — server-side staging contract, landed 2026-09-16

Historical implementation checkpoint: at the 2A.1 landing, Classification authority was not
active and the shipped PC publisher/legacy readers remained wire-compatible. Publication timestamps
are required to be timezone-aware so staleness can be ordered by instant; the shipped publisher
already emits RFC3339 timestamps with an offset. A later explicitly authorized rollout deployed
this server half, upgraded the PC publisher, and staged the real v2 snapshot; that rollout is
recorded below and still did **not** activate Classification authority.

This is the **server-first half** of the rolling upgrade: the server now accepts an
authority-ready snapshot while continuing to accept the shipped version-1 publisher unchanged,
so a new PC build can never publish a shape an older deployed server would reject. The PC
publisher is deliberately not changed by this batch.

- `server/lakomics-api/classification_snapshot.py` owns staging. `PUT /v1/classifications` now
  reads its body raw so the size guard applies before parsing and so "collection absent" stays
  distinguishable from "collection explicitly empty".
- **Version 1 keeps the shipped wire/data shape**: an absent `snapshotVersion` means 1, its entries
  are stored **verbatim and opaque**, its 512 KiB bound is unchanged, and no canonical collection is
  added. The new publication-order check requires an aware timestamp; the shipped publisher already
  satisfies that. Validating v1 entries would break a deployed client — the publisher always
  serializes the display-only `assetCount`, and can carry an appearance key predating the current
  UI. v1 bytes are a display/publication representation, not canonical staging input.
- **Version 2 is fully validated** and must state `assignments` and `roles` explicitly; an absent
  collection is rejected with `missingClassificationAssignments`/`missingClassificationRoles`
  rather than defaulted, because defaulting it would let a publisher silently stage "no
  assignment" or "no protected role" and activation would read that as real user state.
  Unsupported versions are rejected with `unsupportedClassificationSnapshotVersion`.
- Entry `kind` is **preserved from the publisher and validated**, never derived: `work` is a legal
  schema kind that cannot be reconstructed from the parent alone. Staging also enforces id
  validity/uniqueness, trimmed non-empty bounded names, root/work/tag parent compatibility
  (including for a parentless entry), parent existence, no self-parent or cycle,
  case-insensitive sibling-name uniqueness, and renderable appearance keys — so a structurally
  invalid snapshot is refused instead of normalized into a different hierarchy.
- Assignment is single-valued (`assetId -> classificationId`): a duplicate Asset is
  `duplicateClassificationAssignment`, and a reference to a Classification outside the staged set
  is rejected. A staged assignment deliberately does **not** require the Asset to exist or be
  committed server-side, so a locally trashed Asset keeps its assignment (the Album activation
  precedent). The ordinary `setAssetClassification` command keeps its committed-Asset rule.
- `roles` must carry exactly one supported `originals` role naming a staged Classification
  (`missingClassificationOriginalsRole`, `duplicateClassificationRole`,
  `unsupportedClassificationRole`, `invalidClassificationRole`). There is no role mutation API.
- **Staleness**: one `BEGIN IMMEDIATE` covers the stored-timestamp read and the replacement. A
  strictly newer instant wins; an equal instant is accepted only when the canonical staging state
  is identical (an idempotent retry), otherwise `staleClassificationSnapshot`; an uninterpretable
  legacy stored instant imposes no ordering, so a publisher is never wedged by a server-side
  timestamp problem. Timestamps are normalized to UTC, so order is by instant, not by text.
- **Bound**: `MAX_STAGING_BYTES = 96 MiB` (Album's shared publisher-only bound) replaces 512 KiB,
  which could not hold the measured 8,907 assignments. Measured by test at maximum row width: the
  active library encodes to ~2.57 MiB and 20,000 classifications plus 100,000 assignments to
  ~57.5 MiB. Exceeding it is a coded 413, never truncation.
- **Canonical authority identity is separated from the legacy display projection.** Version 2 stores
  normalized authority `entries` plus an internal `legacyEntries` sidecar preserving publisher order
  and display-only fields such as `assetCount`. `snapshotDigest` is recomputed from the stored
  canonical `entries`/`assignments`/`roles` only, excluding `published_at` and `legacyEntries`, so
  display-count churn cannot change authority identity. `GET /meta` gains additive
  `snapshotVersion`/`snapshotDigest`; the legacy `revision` continues to count display-entry changes.
- **Legacy reads are unchanged in projection**: `GET /v1/classifications` returns the preserved
  display `entries`/`published_at`/`revision` explicitly, while a stored version-2 row never leaks
  `assignments`, `roles`, `snapshotVersion` or canonical-only normalization to an old reader. The
  extension bootstrap and the mobile readers keep working while the domain is inactive.
- **Staging is not activation**: a staging PUT creates no `authority_domains` row and populates no
  `classification_authority_*` canonical state. At the 2A.1 landing there was intentionally no
  activation route; 2A.2 below adds an explicit publisher-only route, but staging by itself remains
  inert and leaves every legacy path unfenced.
- Verification: `tests/test_classification_snapshot_staging.py` (75 tests, 30 subtests) covers v1
  acceptance/verbatim storage/bound/revision semantics, v2 acceptance and storage, explicit
  collections, unsupported versions, all entry/hierarchy/appearance rules, assignment cardinality
  and unmaterialized Assets, role requirements, staleness and offset normalization, digest
  determinism, legacy read compatibility, non-activation, and the measured bounds. Five mutations
  of the load-bearing rules were each detected. A final review also pinned non-object JSON, strict
  integer snapshot versions, and the split between canonical authority entries and legacy display
  entries. The full server suite passed 711 tests / 109 subtests.
- **PC publisher v2 is implemented locally after the server-first deployment.**
  `ClassificationSnapshotPublish` now sends `snapshotVersion: 2`, canonical `assignments` from
  `asset_classifications` with no Asset-status predicate, and immutable `roles` from
  `classification_roles`. Entries, assignments and roles are read under one SQLite transaction,
  so one upload cannot mix hierarchy from one local instant with assignments from another. The
  legacy `assetCount` projection still counts normal Assets only. Focused verification passed all
  26 Cloud Capture tests plus the two Classification-list regressions. The later authorized rollout
  deployed 2A.1 first and then staged the real v2 snapshot: 58 Classifications, 8,915 single-valued
  assignments (including 45 relations for locally trashed Assets), one `originals` role, zero
  multi-assigned Assets, and digest
  `1aab6e0848e7f4f2daf8d3be2f5661b17ebef158e4d66e0742f2fdbcd6caf65f`. Legacy display revision
  remained 453 and Classification authority remained inactive.


### Classification 2A.2 — digest-bound cutover fences, deployed inactive 2026-09-16

Implementation and inactive-deployment checkpoint. The 2A.2 server code is deployed, but production
Classification authority remains **inactive**: there is still no `authority_domains` row for the
domain and all six `classification_authority_*` tables remain empty. No activation, client cutover
or legacy retirement was performed by this batch.

- **Activation is explicit, publisher-only and bound to the stored staging bytes.**
  `POST /v1/classifications/authority/activate` accepts only `libraryId` and
  `expectedSnapshotDigest`. Inside one `BEGIN IMMEDIATE`, the server rereads the stored
  `classification_snapshots` row, recomputes its canonical digest, revalidates the stored v2
  `entries`/`assignments`/`roles`, and only then creates epoch 1 / contract 1 / cursor 0 plus the
  typed authority baseline. Caller-supplied canonical state is impossible. Version 1 is refused
  with `classificationSnapshotNotAuthorityReady`; a digest mismatch is
  `classificationBaselineChanged`; identical activation retry is idempotent. Trusted staged
  assignments to Assets not currently materialized on the server are retained at revision 1,
  matching the Album migration exception.
- **Cross-domain library identity is checked before activation.** A single-library server may not
  activate Classification under a `libraryId` that disagrees with already-active Album/Bookmark
  domains; that request fails with `authorityLibraryMismatch`. An already-inconsistent multi-library
  authority registry fails closed as `authorityAmbiguous`. Unowned typed Classification rows without
  an authority-domain row are also refused rather than guessed disposable.
- **The protected role is activation-ready state, not a label hint.** v2 staging now additionally
  requires `originals` to name a top-level `root`; the stored payload is revalidated again at
  activation. The role remains immutable and has no command.
- **The whole-snapshot legacy writer is fenced atomically with cutover.**
  `PUT /v1/classifications` calls the shared `authority.fence_legacy_write` inside the same write
  transaction that would replace staging. While inactive it is a no-op; once activation commits,
  later snapshot publication receives `legacyWriterFenced` and cannot replace the staged/authority
  generation.
- **Asset replication survives the cutover, Classification replication does not.**
  `POST /v1/replication/commit` continues to commit media/Asset metadata and advance its existing
  metadata revision after Classification activation, but it stops deleting/inserting
  `asset_classifications`. Thus a stale PC may continue the Asset replication lane without being
  able to overwrite canonical Classification assignment. While inactive the route preserves the
  shipped relation-write behavior exactly. General compatibility reads backed by
  `asset_classifications` are intentionally migrated later, before production activation.
- **Security-sensitive reads switch immediately once authority is active.** SAF
  `/v1/library/classifications/{classificationId}/contains/{assetId}` checks the committed Asset,
  canonical single assignment and canonical parent chain in one read transaction after cutover;
  before cutover it retains the legacy snapshot + replicated-membership behavior. Extension Capture
  validation likewise checks live, non-tombstoned authority Classification ids after cutover, so a
  deleted Classification cannot remain usable merely because the frozen legacy display snapshot
  still contains it. Admin Capture behavior is unchanged.
- **Scope boundary:** `/v1/library/classifications`, general `/v1/library/assets` Classification
  filtering/projection, PC durable replica/outbox, Android Classification replica/write support,
  production activation/canary and legacy-table retirement remain later batches. In particular,
  2A.2 does not try to mirror authority assignments back into `asset_classifications`: staged
  authority legitimately contains trash/unmaterialized Asset ids that the legacy FK-backed table
  cannot represent, and dual-writing would recreate two writers.
- Verification: the new `tests/test_classification_cutover.py` has 8 integration tests covering
  digest binding, v2/publisher gates, idempotent activation, baseline readability, unmaterialized
  assignments, `originals` root enforcement, cross-domain library identity, snapshot fencing,
  replication relation suppression, SAF authority membership and Capture stale-id rejection. The
  focused Classification/staging/replication/mobile/capture regression set passed 339 tests / 94
  subtests before the final identity guard; the final full server suite passed **719 tests / 109
  subtests**.
- **Inactive production deployment:** Git commit `da01a1f` was pushed to `main`; the deployed
  `app.py`, `classification_authority.py` and `classification_snapshot.py` SHA-256 values are
  `09be2c6e...88be0`, `a1606c29...dd037` and `a0bd34b7...0b0af`. Before replacement, the deployed
  three-file baseline matched Git commit `40a3c4f` byte-for-byte and an SQLite online backup was
  retained at `backups/classification-2a2-20260916T142415Z/` (`23,810,048` bytes,
  `quick_check=ok`). The new process (`PID 1346986`) is active; raw and Tailscale HTTPS health both
  return 200, and an unauthenticated activation probe returns 401 rather than 404, proving the new
  route is loaded without invoking it. Production DB verification still shows zero Classification
  authority/domain rows. During the pre-restart window the **old** server process accepted a normal
  PC v2 publication at `2026-09-16T14:25:23Z`, advancing staging revision `453 -> 454`, assignments
  `8,915 -> 8,918` and canonical digest to
  `bce1a49f3d5bbb823806e01bfcd1e7f450749bf051d6deda75e52d8439b1b9ee`; this happened before the
  2A.2 process started and is recorded as normal pre-activation staging churn, not as evidence of the
  new fence behavior.


Production migration, deployment, active-data writes, R2 cleanup and Git writes remain
separately authorized operations under repository policy.

### Classification 2D — production activation and canary, landed 2026-09-17

The user explicitly authorized production activation and the reversible assignment canary.
Classification authority is **active** in production as epoch 1 / contract 1, starting at
**cursor 0**, alongside the already-active `albums` (cursor 11) and `catalog-bookmarks`
(cursor 12) domains under the same canonical `libraryId`
`e6395585d5eeae9540ec9b8f8e96d98c`.

- **No server deployment was needed.** The deployed `app.py`, `classification_authority.py` and
  `classification_snapshot.py` were already byte-identical to the activation source
  (`09be2c6e…88be0`, `a1606c29…dd037`, `a0bd34b7…0b0af`), `git diff` from the 2A.2 deploy commit
  to `main` was empty for `server/`, and the deployed OpenAPI route/method set matched a locally
  generated one exactly (71 routes).
- **The baseline was freshly staged, not reused.** A pre-activation PC publication produced staging
  revision `464`, `snapshotVersion 2`, digest
  `83ad4705438467e28b9f460af11a7ddfb344c626b1339e0d01184ee3a9181b21`, with 58 classifications,
  8,936 assignments and 1 role. The digest was independently reproduced from current PC canonical
  state and accepted by the server's own `stage()`/`authority_ready_state()` validators before
  activation. Assignments grew `8,927 -> 8,936` since preflight because the PC was legitimately
  running: it ingested assets and Character autotag applied 9 new tag assignments.
- **Activation response:** `libraryId` unchanged, `epoch 1`, `contractVersion 1`, `cursor 0`,
  `classificationCount 58`, `assignmentCount 8,936`, `roleCount 1`,
  `baselineDigest 83ad4705…1b21`, `activatedAt 2026-09-17T12:19:50Z`. The digest-bound request used
  the publisher credential; the client credential is rejected with 401 for activation.
- **Legacy writer fence verified in production.** `PUT /v1/classifications` now returns
  `409 {"code":"legacyWriterFenced","epoch":1}` and staging remained at revision 464, so the
  pre-activation display snapshot is no longer replaceable. The fence is the first statement inside
  the publishing transaction, so it rejects before any mutation. The only post-activation
  `PUT /v1/classifications` entries are this verification attempt plus two earlier
  under-credentialed probes (401); no successful legacy publication occurred after activation.
- **Client adoption.** The PC adopted epoch 1 / contract 1 / cursor 0, populated 58 confirmed
  Classification revisions and 8,936 confirmed assignment revisions, and its durable outbox stayed
  at zero throughout. A first adoption writes only the three durable authority tables and requires
  the baseline to match local canonical state exactly, so the pre-activation staging had to be
  re-verified against live PC state immediately before activation. Android (2C, APK 0.6.2 built
  from this source) fetched the complete baseline at `2026-09-17T12:33:33Z` and then polled ordered
  changes, converging to the same identity.
- **Reversible assignment canary.** Through the normal PC product path (asset card dragged onto a
  sidebar Classification), asset `15e472db-acde-415d-8ec8-595f6f5cee3a` moved `나히아` →
  `백합` as server sequence 1 (`operationId f103070c-…`, assignment revision 2), then back to
  `나히아` as sequence 2 (`operationId 5832acc4-…`, revision 3). Each step produced exactly one
  command, one cursor increment, one assignment-revision increment and a zeroed outbox, and Android
  advanced its ordered cursor `0 -> 2`. Final state is the original `ce594b93-…` at revision 3, with
  no multi-valued assignment anywhere.
- **Cross-domain and service sanity.** Album (cursor 11) and catalog-bookmark (cursor 12) authority
  identities were unchanged; server `quick_check=ok`, `foreign_key_check` clean, service
  active with `NRestarts=0`, health 200 on both raw and Tailscale HTTPS paths.
- **Rollback boundary.** There is still no supported deactivation path, so the canonical
  post-activation rollback remains a full restore of the pre-activation online backup at
  `backups/classification-2d-20260917T114545Z/lakomics.sqlite3` (`24,825,856` bytes, SHA-256
  `91df1c3b747a5d43c9af8051e6d499d42fe3a26c0c29393b1430288262d2e29b`, `quick_check=ok`, zero
  violation `foreign_key_check`) after stopping all Classification-capable clients. No rollback was
  required.
- **Follow-up, resolved by 2E:** the PC receive loop used to rewrite every confirmed assignment
  each pass, so migration 0076's `classifications` dirty counter churned continuously while still
  being consumed locally rather than re-published. Authority 2E removed it; see below.

The `android/build.py` and `build.ps1` JVM check lists were not extended for 2C, so the documented
release procedure could not build a 2C APK: the harness compile step omitted `ClassificationReplica`
and `ClassificationAuthoritySync`, which `LibraryReplicaStore`/`ReplicaDb` now require. **Fixed in
2E's first commit** by deriving that source set from the tree instead of listing it.

### Classification 2E — legacy dirty-mechanism retirement and build-path repair, landed 2026-09-17

Activation is proven and stable, so the legacy Classification publication machinery that is now
provably superseded was retired. Two separable commits: the Android release-build verification
repair, then the retirement itself.

**Android release-build repair.** `android/build.py` and `build.ps1` hand-listed the sources they
compiled for the plain JVM. Classification 2C made `LibraryReplicaStore`/`ReplicaDb` reference
`ClassificationReplica`, so the stale list stopped compiling and the documented release build
failed *before packaging* — from a clean checkout, with the shipped source correct. The list was a
copy of an invariant ("replica sources importing neither the Android runtime nor `org.json`"), so
both scripts now derive it from the tree, compile `ClassificationReplicaTest` with the Album replica
tests and run it. Adding a replica class no longer requires editing a list.

**What was retired.** Only the mechanisms whose own producer is gone:

- `project_assignment_impl` no longer writes when the local relation already holds the authoritative
  value. The write is a `DELETE` + `INSERT` (assignment is single-valued), so it fired two triggers
  per confirmed assignment per pass while changing nothing. The Classification-target validation
  stays unconditional because it is a read.
- Migration **0085** replaces the Classification-specific triggers from 0076 with versions guarded on
  the absence of the adoption singleton row, reusing 0082/0083's "row present means adopted"
  convention. Pre-adoption behaviour is byte-identical. The Asset triggers that also served
  `saved_x`/`albums` keep those kinds unconditionally. 0076 itself is untouched, so old databases
  still upgrade.

**Deliberately retained, and why:**

- `cloud_metadata_publication_state` and the `saved_x`/`albums` lanes: shared, still live producers.
- `PUT /v1/classifications` and its staging row: the fence *is* what makes an old writer unable to
  regain authority, and staging still serves recovery. Retiring a fenced writer buys nothing while
  the fence already holds and costs the recovery path. Production re-confirmed `409
  legacyWriterFenced` with staging unchanged at revision 464.
- Compatibility reads `GET /v1/classifications`, `/v1/classifications/meta`, `/v1/library/classifications`
  and `/v1/library/classifications/{id}/contains/{asset}`: all still have consumers. The extension
  bootstrap serves its own `/v1/classifications` from the locally-open library, Android's
  `LibraryDocumentsProvider`, `PickerLibrary` and `CloudClient` read `/v1/library/classifications`,
  and the `contains` route is authority-backed after cutover. None was removed; a live read returned
  58 items after 2E.
- Historical migrations: required for upgrading real older databases.

**Verification.** The clean-pass regression test fails under either pre-2E behaviour (the legacy
Classification generation went 8 → 28 over five passes) and passes after it; a second test counts the
assignment writes directly through a temporary trigger and fails when the skip is removed (10 → 0);
a migration test upgrades an 0084 database and asserts both the unadopted dirtying and the adopted
silence. Classification 187, cloud 124, album 53, bookmark 64, db 56 and restore-guard 9 pass;
`cargo check` clean; the Android release build still produces a 2C APK with no Classification
write/outbox. Six Rust lib failures and 38 frontend failures are pre-existing, byte-identical at this
commit's parent, and separately recorded rather than patched.

**Production.** No server deploy was needed: 2E changes no server file. The PC applied migration 0085
through its normal startup path, which took its own `v84` pre-migration backup. The legacy
Classification generation, which had been climbing ~357 increments/minute, was then measured frozen
for 60 s across repeated five-second sync passes while `albums` (110) and `saved_x` (252) stayed
unchanged. Authority stayed epoch 1 / cursor 2, outbox 0, canary asset at its restored revision 3,
and the service healthy with `NRestarts=0`.

### Classification 2F — authority-backed tree projection, landed 2026-09-18

The read cutover had moved membership, filtering and counts to the authority while the *tree itself*
still came from the frozen `classification_snapshots` payload. Accepted structural commands —
create/rename/move/delete/appearance — therefore did not appear in the tree consumers, because those
readers re-rendered pre-activation bytes. This batch moves structural truth to authority state and
leaves the frozen publication with one job: display order.

**Ownership.** For every authority-backed tree reader:

- **authority** owns existence (a tombstoned node is absent), id, kind, name, parent, icon, color and
  the assignment count per node;
- **the frozen publication** is a display-order sidecar only. `classification_snapshot.display_order`
  extracts `{id: (position, observedParentId)}` from a legacy display list and nothing else, so no
  frozen name/parent/kind/appearance/`assetCount`/existence can override canonical state;
- **authority roles** stay in the baseline; the compatibility tree carries no role field, so none was
  invented for consumers that never had one.

**Ordering rule.** A position ranks a node only inside the sibling set it was observed in, so a node
whose recorded parent no longer matches its authority parent (a move) is an *arrival* in its new set
and cannot carry a stale display slot into a set it never belonged to. Ranked nodes keep their
existing user-visible order; unranked arrivals — creations, and moves into a set — sort after every
ranked node, ordered by `created_at` then id. Both keys are stored, immutable authority columns, so
the order is deterministic across requests and restarts and a rename cannot reshuffle it. A create is
therefore visible immediately rather than being hidden for want of a display slot. The list stays
flat, exactly as the shipped route was: each consumer re-parents it from `parent_id` and keeps each
parent's relative order, and `sort_index` is the node's position in the shipped list.

**Two historical orders, deliberately preserved.** The mobile route always iterated the stored
canonical `entries` (id-sorted for a version-2 row), while the extension bootstrap always iterated
`legacyEntries` (the publisher's order). Each reader now extracts its sidecar from its *own* historical
list, so its pre-activation order is unchanged.

**One projection, reused.** `classification_authority.compatibility_tree` is the single canonical
projection. `GET /v1/library/classifications`, `_classification_snapshot()` (`GET
/v1/extension/bootstrap` and the `/v1/extension/pair` exchange) all call it, so a structural command
cannot appear in one surface and not another.

**Snapshot consistency.** The mobile route and the bootstrap each read inside one explicit read
transaction, so the tree, the counts and the sidecar describe one state; no global lock is held across
network IO. If the staging row is missing entirely, the authority tree is still served and only
display order degrades to the deterministic `created_at, id` order — a lost sidecar can never hide
canonical structure.

**Deliberately left legacy**, with reason: `GET /v1/classifications` and `/v1/classifications/meta`
remain the *staging publication* surface (its fence is what stops an old writer regaining authority,
and staging still serves recovery); the extension's own `GET /v1/classifications` is served from the
locally-open library (`extension_api.rs`), not from this server; `extension/` is the frozen legacy
tree; PC/Android structural *editing* stays out of scope per 2A/2C.

**Verification.** `tests/test_classification_cutover.py` gained `ClassificationTreeCutoverTests`
(14 tests) driving real HTTP routes over real SQLite: rename, create, move (including the derived
kind), appearance, delete (with its authority assignment semantics), role-node structure, display
order across creations and a restart, a move not stealing a display slot, the bootstrap and pairing
exchange, a missing sidecar, inactive compatibility, and the query shape. Six mutations were each
applied to the real source and killed: forcing the frozen name, dropping authority-only nodes,
using the frozen parent, letting tombstones back in, removing the deterministic fallback, and routing
an inactive library through authority. Measured by `EXPLAIN QUERY PLAN` at 2,000 classifications and
9,000 assignments: the tree read is one index seek
(`classification_authority_by_parent`) and the counts read is one covering-index grouped read —
never one query per Classification. Full server suite 744 tests / 109 subtests pass, mobile 181,
extension-list 117; the 38 frontend failures remain the pre-existing set recorded in 2E.
