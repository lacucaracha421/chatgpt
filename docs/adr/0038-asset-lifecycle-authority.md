# ADR-0038: Asset lifecycle authority

Status: **Proposed** — designed and implemented locally behind an activation gate; not activated in production.

This ADR defines Asset *lifecycle* authority. It extends the server-authority model of
ADR-0036/0037 to the Asset itself and closes the last asymmetric path: Classification,
Album and Catalog Bookmarks already have a server-owned truth and a fenced legacy writer,
while Asset existence and lifecycle are still PC-owned and one-directional.

## Context

Two facts from the current code define the problem.

**Asset creation is PC-mediated and one-directional.** A mobile or extension save becomes
a server *Capture*, the PC polls and imports it, and only then does the PC replicate an
Asset back up. The server therefore cannot produce a canonical Asset on its own; a
PC that is offline, or whose background workers are stopped, leaves the save in `pending`
indefinitely. This is measured, not hypothetical: on 2026-09-18 22:44 KST a locked desktop
keyring stopped the PC capture poll for 49 minutes, and the accepted Capture sat unimported
even though its R2 inbox object already existed.

**Asset lifecycle is PC-local only.** `trash_assets`, `restore_assets`, `empty_trash` and
`purge_expired_trash` change only the PC SQLite `assets.status` column and PC files. They
enqueue no cloud work and issue no server request, and the server `assets` table has no
lifecycle column at all — only `committed`. Every server read filters on `committed = 1`
and nothing else, so an Asset the user trashed on the PC stays visible to Android and the
extension until something unrelated happens to remove it.

Neither half can be fixed by itself. Promotion without lifecycle authority would let the
server create Assets that can never be retired; lifecycle authority without promotion would
leave the server authoritative over rows it cannot create.

## Decision

### 1. The server owns Asset lifecycle; the PC materializes it

For every Asset the server knows about, canonical lifecycle state (`normal` → `trash` →
`tombstoned`) lives in an `assets` authority domain. Clients hold replicas:

| Role | Owns |
| --- | --- |
| Server | canonical Asset identity, lifecycle state, entity revision, change log |
| PC | local materialization of that Asset, local media bytes, local derived analysis |
| Android / extension | read replica |

Once the domain is active, a PC that presents a stale lifecycle snapshot cannot overwrite a
newer server state. That is enforced by the same compare-and-set on entity revision that the
Classification and Album domains use, not by arrival order.

### 2. Identity is stable and server-allocated

A logical Asset has exactly one canonical ID for its whole life, including across
create-anywhere/materialize-elsewhere, trash, restore and tombstone.

Forbidden, and the reason this is written down:

```text
server Asset A
  → PC downloads the bytes
  → PC inserts a new local Asset B for the same media
  → PC uploads B
  → two canonical Assets for one logical Asset
```

Therefore a cloud-created Asset's ID is allocated **on the server, before any PC
involvement**, and the Capture → Asset mapping is durable. A PC materializing that Asset
inserts the row under the server's ID, and that insert is explicitly *not* an outbound
replication event.

The canonical ID is never derived from a filename, a path, or a local row id. The content
hash (`sha256`) identifies *bytes*, which is what duplicate detection needs; it is not
identity, because the same bytes can legitimately exist as two logical Assets.

### 3. Lifecycle is a state machine, and deletion is two-stage

```text
                 trash                tombstone
   normal  ───────────────▶  trash  ───────────────▶  tombstoned
      ▲                        │                            │
      └────────────────────────┘                       (irreversible
              restore                                  at the logical layer)
```

* **trash** is reversible and preserves the Asset ID.
* **restore** returns the same Asset to `normal`.
* **tombstone** is the logical end. It is irreversible at the logical layer: reviving a
  tombstoned ID would resurrect an Asset whose deletion the change log already recorded.
* **Physical media deletion is not part of any lifecycle command.** Moving to trash and
  tombstones never delete an R2 object. Physical GC is a separate, later, server-side task
  with its own eligibility rule (§7).

### 4. Classification and Album relationships survive trash

Trashing hides an Asset from ordinary views; it does not silently re-organize the library.
Classification assignment and Album membership are retained, so restoring returns the Asset
to exactly the organization it had. This matches the PC's existing behaviour, where trash
only sets `status` and leaves `asset_classifications` and Album relations in place — and the
server already documents the same rule for Albums ("a trashed Asset keeps its Album
relations").

Tombstone is the opposite: the logical Asset is gone, so its relationships are **retained
but become unreachable**. They are not deleted, because the tombstone may need to be
explained (which Classification did this Asset belong to?) and because deleting them would
require a second, separately-failable mutation. One documented invariant:

> A tombstoned Asset keeps its rows; every read that exposes relationships excludes
> tombstoned Assets. Relationship rows are removed only by the same physical GC that
> removes the media.

### 5. Revision and command model

Every state-changing command carries `operationId` and `expectedEntityRevision`:

```text
operationId            idempotency key, unique per (library, epoch)
expectedEntityRevision compare-and-set; a stale writer is rejected, not merged
```

Semantics, all inherited from ADR-0037 rather than redefined:

| Field | Meaning |
| --- | --- |
| `libraryId` | which library's authority this is; a mismatch is an identity error |
| `epoch` | authority generation; a command from another epoch cannot present a meaningful revision |
| `contractVersion` | unsupported versions are refused, so an old client learns to stop |
| `cursor` | monotonically increasing domain position, one sequence per accepted change |
| `entityRevision` | per-Asset compare-and-set counter |
| `operationId` | idempotent receipt key; a retry returns the recorded result |

A stale `expectedEntityRevision` yields a coded `revisionConflict` carrying current server
state, so the client rebases instead of overwriting.

The lifecycle command lineage is **separate from Classification assignment revisions**.
`setAssetClassification` revision and Asset lifecycle revision are different counters on
different domains; conflating them would make a rename of a Classification invalidate an
unrelated lifecycle command.

### 6. The authority log never stores media

Change rows carry lifecycle state, the Asset ID, the revision, and non-secret metadata
needed to materialize (object key, content hash, size, content type, source metadata,
Classification assignment). They never carry media bytes, credentials, or R2 signed URLs.
Signed URLs are per-request and would be both a secret leak and immediately stale.

### 7. R2 retention and GC boundary

Trash and tombstone are logical. Object deletion is deferred to a server GC task with an
explicit eligibility rule:

```text
tombstoned
AND retention window expired
AND no active transfer
AND no recovery hold
```

Only then are the original and any derivative objects deleted and the completion recorded.
**Physical GC is not implemented in this phase**; the logical path is implemented and tested
first, and this ADR does not claim otherwise.

### 8. Mobile cache invalidation is revision-driven

The mobile client keeps an in-memory `viewCache` of four views. Today it can show an Asset
that the server has already removed from a Classification, until a force restart. Patching
one "moved from current folder" case would leave every other case broken.

Instead, Asset-list responses carry a publication revision, and a cached view is reused only
while that revision is unchanged. Any lifecycle change to an Asset, and any Classification
assignment change that affects membership, advances it. A refresh is always a canonical
fetch. The cache is a performance detail; correctness comes from the server response.

### 9. Legacy fence and rollback

Same shape as the other domains: an inactive domain leaves legacy behaviour byte-identical,
and an active domain rejects the legacy writer (`fence_legacy_write`) so an old PC
replication commit cannot resurrect a trashed or tombstoned Asset.

Rollback before activation returns to legacy behaviour. **After** activation, rollback is
*not* "make the old PC database canonical again": PC state is a replica, so the boundary is

```text
restore the server authority backup
+ rebuild client replicas
```

identical to the Classification and Album domains.

## Consequences

* The server can create a canonical Asset with no PC involvement, so a mobile save is no
  longer gated on a PC being online, unlocked and running.
* PC trash becomes durable user intent rather than local state, and all clients converge.
* Asset lifecycle gains a revision model, a change feed, a baseline and a retention floor,
  so it can be replicated, fenced and rolled back like the other domains.
* The PC must gain a reconciliation path (server Asset → local Asset with the same ID) that
  is new work, and it must not enqueue materialization as an outbound replication event.
* Mobile must invalidate cached views from a revision rather than from special cases.
* Duplicate handling is deliberately split: an exact content-hash duplicate is a server
  decision where the semantics already match, while perceptual similarity remains PC
  analysis and can never destroy or re-identify a cloud-created Asset.

## Deferred, explicitly

* Physical R2 GC (§7).
* Server-side perceptual similarity.
* Promoting existing `pending` Captures for libraries that have not activated the domain.
* Mobile materialization of media (Android remains a read replica).
