# Move shared domains to server authority in stages

Status: Proposed — target contract for CLOUD-AUTH-001; no domain authority switch
is implemented by the character read projection.

Intended relationship: partially supersede ADR-0033 only for domains explicitly
cut over. ADR-0033 remains the current behavior until those domain gates exist.
Notes retains ADR-0035's encryption and recovery-key boundary.

## Context and direction

The requested target is a server that accepts shared changes while PC is off,
with PC and Android reading the same domain model. Current PC uploads include
replaceable snapshots, so adding mobile writes without fencing those uploads would
allow a stale PC to erase accepted mobile changes.

Keep the existing Tauri/React/Rust, Android/shared React, Python API, SQLite and R2
boundaries. First publish comparable read projections of the current PC model.
Then move one write domain at a time, beginning with catalog bookmarks. Read
projection revision and authority epoch have different meanings and must not be
used interchangeably.

## Proposed write contract

1. Persist a stable library ID plus authority state per domain. Each state carries
   an authority epoch, supported contract version, snapshot revision and change
   cursor. Current single-library character publication predates this namespace;
   importing it must explicitly bind it to the selected library.
2. Use stable entity IDs, including `(provider, providerWorkId)` for catalog works.
   Device IDs and device-local paths do not become entity identity. Series,
   characters, ordinary classifications, display groups and Works remain separate.
3. Before accepting a server-owned mutation, fence every legacy snapshot/backup
   restore path that can write that domain. Switching authority and rejecting the
   old epoch must be transactional. An old client may keep reading compatible data
   but cannot restore authority by uploading a snapshot.
4. Commands carry library/domain, epoch, durable client-generated operation ID,
   desired state and the affected entity's expected revision. Persist operation
   receipt, entity change and ordered change-log entry in the same transaction.
   The same operation/payload returns its recorded result; reuse with another
   payload conflicts. Bookmark commands set a boolean rather than toggle it.
5. For concurrent changes, accept an already-matching desired state as idempotent;
   otherwise reject a stale entity revision with the current server state. Clients
   fetch that state before retrying an explicit new operation. Do not choose by
   device wall-clock time or silently replay a stale destructive intent.
6. PC/mobile store pending operations durably, display pending state separately
   from confirmed state, and retry the same operation ID after lost responses.
   A local transaction applies each server change batch and advances its cursor.
   Local database writes made while applying remote changes must not re-enqueue
   equivalent outgoing commands.
7. Keep tombstones and receipts long enough for supported offline clients. If a
   cursor has expired, require a fresh baseline plus reconciliation of outstanding
   operations; do not treat missing entities as permission to delete media.

Precise retention periods, permission roles and baseline sizes require deployment
capacity and offline-window decisions before enabling writes. The current shared
bearer token and Android route allowlist are not sufficient proof of publisher vs
reader authorization at the server boundary.

## Transition and recovery

Stage a complete baseline in isolated storage, validate IDs/counts/memberships and
preserved user values, then atomically activate the new epoch with all old write
paths fenced. While staging, existing reads continue using the active baseline.
Keep an export of baseline plus subsequent accepted operations for recovery.
After accepting mobile writes, rollback cannot mean restoring a stale PC snapshot:
pause writes and reconcile/replay accepted operations before changing authority.

Workers are a separate transition: capture finalization, required media processing,
catalog/new-release refresh and character automation need durable jobs, idempotent
effects and stale-result checks. Catalog replacement must preserve bookmarks;
Collection refresh must preserve explicit zero vs unknown ownership, provider
baselines, subscriptions and event-ID acknowledgements. Character workers must
preserve manual decisions, reference exclusions and explicit historical-refresh
semantics. Global media deletion remains MOBILE-003 HOLD.

For every domain, acceptance includes PC-off mobile operation, response loss and
retry, concurrent clients, stale snapshot rejection, restart recovery, and later
Windows/Linux PC reconciliation without lost changes. Server deployment, active
data migration and service provisioning remain separately authorized actions.

Current read implementation: [mobile character contract](../agents/mobile-character-contract.md).
Remaining work and ordering are tracked only in [CLOUD-AUTH-001](../roadmap/lakomics-backlog.md).

Implementation checkpoint (2026-09-13): MOBILE-008 adds a bounded server worker for
new catalog works after an existing PC publication. An additive ledger protects
those works when old PC content is published again; it does not transfer user
metadata authority or implement this ADR's full library/epoch/delta contract.
Existing PC groups are preserved, new works initially remain singleton groups,
and deployment/native/live-source acceptance remain pending. See the
[mobile catalog refresh checkpoint](../agents/mobile.md#catalog-refresh-source-checkpoint--2026-09-13).
