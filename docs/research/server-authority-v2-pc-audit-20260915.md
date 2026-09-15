# Server Authority v2 — PC publication and recovery audit

Status: read-only current-state audit input, not an implementation plan.

Date: 2026-09-15. The audit was performed against the current checkout under
`/home/laku/chatgpt`; it reported no file, database, production or Git writes.
Operating-server state, deployed binaries and Windows native runtime were outside
its verification scope.

Related references:
- [Server Authority v2 product decisions](server-authority-v2-product-decisions-20260915.md)
- [ADR-0036 staged server authority](../adr/0036-staged-server-authority.md)
- [ADR-0037 replica/command contract](../adr/0037-server-authority-v2-replica-and-command-contract.md)
- [living backlog](../roadmap/lakomics-backlog.md)

## 1. Headline findings

The PC currently has nine server publication/synchronization paths. Eight are whole
snapshot/replacement or PC-derived upsert flows; Catalog bookmarks and Notes are the
mature delta/cursor-style exceptions.

The main migration risk is therefore not missing mobile UI. It is that an older PC
publication or full SQLite restore can overwrite state that a server-authoritative
client has already accepted.

The current PC also starts its cloud/sync supervisors only after a local library
folder is opened. This makes the local folder/SQLite file an application-entry
precondition even though the Server Authority v2 product target makes it a
rebuildable workstation replica.

## 2. Current PC -> server paths
| Path | Current shape | Main risk after server authority |
|---|---|---|
| classifications | full `classification_entries` snapshot | no client revision fence; stale PC can replace tree |
| albums | full `albums` + membership snapshot | stale defense relies on PC `published_at` clock |
| Saved X media keys | full source-key snapshot | overwrite semantics; may remain extension runtime support |
| asset replication | per-asset prepare/commit upsert | classification membership is deleted/replaced from PC state |
| Collections / Works | full mobile replica replacement | current revision blocks races, not a freshly-read stale PC truth |
| characters | full nodes/scopes projection | server envelope is still explicitly `authority:'pc'` |
| Catalog publication | large immutable replica + user snapshot | mostly fenced around bookmarks; publication mental model remains |
| Catalog visibility | full hidden/blocked preference replacement | user policy is replaced as one snapshot |
| Notes | revision + operation ID + ordered sequence | mature bidirectional contract; keep ADR-0035 boundary |

The automatic supervisors currently include:
- `useMobilePublications`: 10-second scheduler for Collections, Characters and visibility;
- `useCloudCaptureSync`: focused 15-second / hidden 60-second capture plus metadata publication;
- `useCloudBackfillSupervisor`: asset replication worker loop;
- `useOnlineCatalogUpdate`: hourly provider update;
- `useCatalogBookmarkSync`: five-second receive -> flush -> receive authority loop;
- release-watch background checks.

`mobile_publication_state` and `cloud_metadata_publication_state` are driven by dozens
of dirty triggers. If those triggers survive a domain cutover, applying a server
change locally can mark the old PC publisher dirty and create a publication feedback
loop. Bookmark reconciliation is the reference counterexample: remote apply writes
confirmed state without creating outgoing intent.

## 3. Shared state vs PC-only state

Shared server-authority candidates include classification hierarchy, albums and
membership, asset favorites, Collection user values, character manual decisions /
references / exclusions, durable analysis results, Catalog user preferences,
release/ownership state, trash/tombstones and recent-view history.
PC-local state should remain device-scoped:
- physical media paths and local byte presence;
- video poster/scrub/playback derivatives and interrupted FFmpeg state;
- drag-out staging and native filesystem integration;
- provider/download caches such as `catalogs/kdata.db`;
- device UI preferences and credentials;
- `.lakomics.lock` process lease;
- USB/private-vault data and its local index.

The audit also found that `assets.favorite` currently has no server publication at
all, while several Collection user values are mixed inside provider-derived JSON.
Those are schema-boundary problems, not merely missing sync buttons.

## 4. Recovery is the highest-risk legacy path

`create_cloud_metadata_snapshot` takes an online backup of the complete PC
`library.sqlite`. The restore path then swaps that database back through
`restore_snapshot_locked`.

That snapshot includes authority/client machinery such as Catalog bookmark cursors,
outbox rows and local bookmark state. Restoring an old snapshot can therefore roll
back the local cursor and, more importantly, erase unaccepted local outbox intent.
`library_id` is also restored as part of the database, so a snapshot from another
library can silently change local identity before the server rejects it.

This is incompatible with a server-authoritative rollback model. Once any protected
domain is active, recovery must not mean "make this old PC SQLite canonical again".
The safer target is server-state restore plus client replica rebuild, with old PC
snapshots usable only through an explicit salvage/import path.

## 5. Other concrete migration blockers

- Classifications expose no synchronization revision/change cursor to clients.
- Album stale protection uses a client-generated timestamp rather than server order.
- Asset replication replaces `asset_classifications` after PC-local CAS checks.
- `LibraryContext` requires `openLibrary(path)` before the workspace and sync hooks mount.
- Several media/open/drag paths assume the original is physically present on PC.
- `cloud_sync_queue.revision` and `assets.metadata_revision` are separate revision lineages.
- Cloud-problem reporting merges several domain failures into broad generic messages.
## 6. Safe retirement order from the audit

The audit's safe ordering is fence-first, not UI-first:

1. add server-side authority fences while inactive behavior remains unchanged;
2. make coded authority conflicts visible rather than generic publication failure;
3. migrate one domain at a time using baseline -> epoch activation -> new reads/writes;
4. retire the corresponding manual publication controls only after convergence works;
5. remove `mobile_publication_state` / `cloud_metadata_publication_state` triggers last.

Turning off the old publisher before the replacement domain exists would merely let
PC and server diverge silently.

The recommended early migration order is classifications / albums / asset membership,
then Catalog visibility/preferences, then Collection user-owned state after separating
provider data, then character manual decisions/exclusions. Global trash remains gated
by its dedicated recovery contract.

## 7. Main later modification surfaces

PC Rust: `src/cloud/auto_publication.rs`, `collections.rs`, `characters.rs`,
`captures.rs`, `albums.rs`, `catalog.rs`, `metadata_backup.rs`, `backfill.rs`,
`queue.rs`, `activity.rs`, `src/library/backup.rs`, `mobile_catalog.rs`,
`catalog_visibility.rs` and database migrations.

PC TypeScript: `useMobilePublications.ts`, `useCloudCaptureSync.ts`,
`useCloudBackfillSupervisor.ts`, `useCloudProblems.ts`, publication settings/actions,
and the existing `useCatalogBookmarkSync.ts` reference path.

Migrations `0080_bookmark_reconciliation.sql` and `0081_bookmark_outbox.sql` are the
strongest existing PC template for receive cursor + durable send intent. Notes is the
other mature reference for revision/operation-ID conflict handling.

## 8. Verification boundary

This audit is a source/schema/API correspondence record. It does not claim the
production VPS, installed Galaxy Tab APK, active production library schema or Windows
native runtime were inspected. Future implementation must re-check the affected
source paths and preserve unrelated working-tree changes before modifying them.
