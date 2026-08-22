# Aladin Release Watch Design

**Date:** 2026-08-22

## Goal

Allow a user to opt a manga Collection with an Aladin External Binding into Release Watch. When Lakomics starts, it checks due subscriptions without blocking normal library use, records newly discovered or changed Korean release information, and keeps an unread indication until the user opens that Collection.

This pass extends the proven Aladin refresh flow. It does not create a generic provider scheduler, a resident Windows service, or an application-wide notification center.

## Existing behavior

- A manga Collection can hold MangaDex and Aladin External Bindings at the same time.
- The Aladin binding stores stable provider identity, the successful provider snapshot, and `last_synced_at`.
- An explicit Aladin refresh reconciles typed release data into Collection Volumes without overwriting local Collection metadata or MangaDex artwork.
- Collection cards and the Collection overlay have no unread release state.
- Toast is the existing transient notification surface.
- Lakomics performs no startup Aladin sweep, periodic polling, scheduled retry, or Windows notification.

## Domain language

**Release Watch** is a user-selected function that periodically checks an External Binding for Release Changes and retains those changes until the user sees them.

**Release Change** is a newly discovered Volume or a change to an existing Volume's Korean release date or release status. A successful provider refresh without one of these differences is not a Release Change.

Release Watch is not a synonym for refresh. Refresh updates the current provider-backed state; Release Watch additionally owns opt-in timing and unread change records.

## Scope

This pass includes:

- explicit per-Collection opt-in for an existing Aladin binding;
- one due check after application startup when the previous successful check is at least 24 hours old;
- the existing explicit Aladin refresh action;
- detection of new Volumes, release-date changes, and release-status changes;
- persistent unread Release Changes;
- one unread badge per Collection card;
- one inline summary when the user opens a Collection with unread changes;
- one transient startup Toast summarizing how many Collections received changes.

This pass excludes:

- checks while Lakomics is closed;
- recurring timers while Lakomics remains open;
- Windows notifications;
- purchase, preorder, wishlist, or missing-volume tracking;
- a global notification history or sidebar destination;
- provider-agnostic scheduler, queue, retry, or capability interfaces;
- MangaDex monitoring;
- fuzzy or automatic Aladin connection;
- automatic enabling when an Aladin binding is created.

## Data ownership

### Release Watch subscription

Add `release_watch_subscriptions` with one row for each enabled binding:

- `external_binding_id` — primary key and foreign key to `external_bindings(id)` with cascade delete;
- `last_checked_at` — nullable UTC timestamp of the last successful watch check.

Row presence means enabled. Disabling Release Watch deletes the subscription row, avoiding a separate boolean state. Only an Aladin External Binding may receive a subscription; the Library Module enforces this before insertion.

`last_checked_at` differs from `external_bindings.last_synced_at`. The latter records any successful provider synchronization, while the former controls whether the startup watcher considers a subscription due.

### Release Change

Add `release_watch_events` with one row per detected difference:

- opaque event ID;
- `collection_id` with cascade delete;
- event kind: `new_volume`, `release_date_changed`, or `release_status_changed`;
- Volume number;
- nullable previous value;
- nullable current value;
- UTC detection timestamp;
- nullable `read_at` timestamp.

The event stores the user-facing change snapshot rather than relying on the subsequently mutable Collection Volume row. Disabling a subscription does not delete existing events. Deleting the Collection deletes its events.

Unread counts are projected into `CollectionSummary`; they are not stored separately. Multiple unread event rows are grouped into one Collection-level summary in the UI.

## Library interfaces

The Library Module exposes small Release Watch operations:

- get the watch status for a Collection;
- enable or disable watch for an existing Aladin binding;
- run all due startup checks and return an aggregate result;
- list and mark a Collection's unread Release Changes in one operation.

The frontend receives typed status, event, and aggregate result models. Provider response JSON, credential values, database row IDs other than opaque public IDs, and managed paths remain inside Rust.

The existing explicit Aladin refresh uses the same reconciliation path. When watch is enabled, a successful manual refresh records Release Changes and advances `last_checked_at`. When watch is disabled, explicit refresh updates current release data without creating watch events.

## Startup flow

After the library UI becomes available, `App` invokes the due-check command once and does not await it before rendering the workspace.

The Rust command selects subscriptions whose `last_checked_at` is null or at least 24 hours old, ordered from oldest to newest, and processes them sequentially. It does not start a timer or a parallel request pool.

For each due subscription:

1. Load the Aladin credential inside Rust.
2. Use the existing stable binding query and anchor identity to fetch the authoritative group.
3. Compare the new typed releases with the current Collection Volumes.
4. In one transaction, insert Release Change events, reconcile current release fields, update the binding snapshot and `last_synced_at`, and update the subscription's `last_checked_at`.
5. Commit before processing the next subscription.

No difference produces no event, but still advances both successful timestamps. Because event insertion and state reconciliation share one transaction, interruption cannot persist the new current state without its event or create the same event again on restart.

When the aggregate command finishes, `App` reloads Collections. If one or more Collections received events, it shows one existing Toast: `새 출간 정보가 있는 작품 N개`.

## Failure handling

`last_checked_at` changes only after a successful provider check and transaction.

Failures that make subsequent checks meaningless stop the startup run:

- missing or invalid Aladin credential;
- provider rate limit;
- provider timeout or unavailability;
- malformed provider envelope that prevents trustworthy processing.

A failure specific to one binding skips that Collection and permits later subscriptions to continue:

- the stored anchor can no longer identify one group safely;
- the binding or Collection disappeared after due selection;
- one Collection's reconciliation fails without invalidating the credential or provider response for all others.

The startup runner does not retry in the same application session. The subscription remains due for the next startup or an explicit manual refresh. Normal offline browsing and previously stored release information remain available.

There is no persistent error-history table. The aggregate result contains checked, changed, skipped, and stopped counts plus a stable public stop reason when applicable. It contains no credential-bearing URL, TTB key, raw provider response, or managed path.

## Frontend behavior

### Collection card

`CollectionSummary` gains an unread Release Change count. `CollectionCard` renders `신간 N` only when the count is greater than zero. The badge exposes the same text to assistive technology and does not replace the Collection name or type.

### Collection overlay

When a manga Collection has an Aladin binding, the existing toolbar adds one restrained `신간 알림 켜기` or `신간 알림 끄기` action. Creating the Aladin binding leaves Release Watch disabled.

On opening a Collection, the overlay requests unread Release Changes. The Library returns the unread snapshot and marks those rows read in the same operation. The overlay retains the returned snapshot in local state until it closes and renders one compact inline summary grouped by change kind and Volume number. It then calls the existing Collection refresh callback so the card badge disappears.

Reading changes does not refresh Aladin and does not dismiss or alter the current Volume selection. Opening a Collection with no unread changes adds no empty panel.

### Startup result

The startup watcher is an application effect tied to the current open Library. `LibraryWorkspace` already remounts with `key={library.root}`; the new effect also captures `libraryRoot` and uses an active flag in its cleanup. A result from a previously open Library therefore cannot refresh or notify the newly selected Library.

Only the aggregate success Toast is added. Detailed change content remains in the relevant Collection overlay, where it cannot vanish on a timer before the user reads it.

## Concurrency and lifecycle

- Only one startup Release Watch run may exist for one open Library.
- Checks are sequential to bound provider traffic and database writes.
- An explicit Aladin refresh and the startup runner use the Library's existing serialized mutation boundary, so they cannot reconcile the same binding concurrently.
- Closing or switching the Library does not expose a stale result to the new workspace.
- The first successful startup check supplies the 24-hour timestamp; repeated application starts inside that window make no provider request for that subscription.

No generic job persistence is added. Database state itself supplies the resume boundary: each successful subscription commits independently, and an unchecked or failed subscription remains due.

## Security and privacy

- The TTB key remains in Windows Credential Manager and is read only inside Rust.
- Credential-bearing request URLs and raw provider responses are never logged or returned to TypeScript.
- Release Change rows contain only Volume number and changed release values.
- Stable public error codes preserve the existing Aladin redaction rules.
- Startup checks use the same bounded request size and timeout as explicit Aladin refresh.

## Migration

Add one schema migration for both Release Watch tables and their indexes. Existing libraries begin with no subscriptions and no events, so migration performs no provider request and changes no existing Collection or Volume data.

The migration constrains event kind and nonblank IDs, enables the required foreign keys, and stores timestamps as UTC text using the existing schema convention. It derives the next schema version through the existing `SCHEMA_VERSION` pattern rather than scattering a new literal through tests.

## Verification

Rust-focused tests prove:

- migration creates the subscription and event constraints without enabling existing bindings;
- only an existing Aladin binding can be subscribed;
- null or 24-hour-old subscriptions are due and newer subscriptions are skipped;
- due subscriptions are processed oldest first and sequentially;
- new Volume, release-date change, and release-status change produce the correct event snapshots;
- an unchanged refresh produces no event;
- reconciliation and event insertion roll back together;
- a repeated check after success creates no duplicate event;
- `last_checked_at` advances only on success;
- credential/provider-wide failures stop the run while binding-specific failures skip one Collection;
- listing unread events marks exactly the returned rows read;
- deleting a subscription preserves events and deleting a Collection removes them;
- aggregate results expose no secret or internal path.

React-focused tests prove:

- `CollectionCard` shows and hides the accessible unread badge;
- the overlay exposes watch enable/disable only for an Aladin-connected manga Collection;
- enabling, disabling, and manual refresh update watch status through typed gateway calls;
- opening an unread Collection renders the grouped inline summary and refreshes the card projection;
- opening a Collection without unread events renders no placeholder;
- startup invokes the watcher once, keeps the workspace interactive, refreshes Collections on completion, and shows at most one aggregate Toast;
- a stale result after Library switching is ignored.

Provider parsing continues to use stored JSON fixtures. Automated verification makes no live Aladin request and requires no real TTB key. Tests remain focused by task; a final integration pass runs the affected Rust tests, affected Vitest files, TypeScript production build, formatting check, and `git diff --check`.

## Acceptance criteria

- Existing Aladin bindings remain unsubscribed after migration.
- A user can enable or disable Release Watch from the Collection overlay.
- Startup checks only enabled subscriptions whose successful check is at least 24 hours old.
- Startup checking never blocks opening or browsing the Library.
- Checks are sequential and make no automatic retry in the same session.
- New Volumes and meaningful release field changes create persistent unread events.
- Unchanged results and repeated successful checks create no duplicate events.
- A Collection card shows its unread count until that Collection is opened.
- Opening the Collection shows the changes and marks exactly those changes read.
- Manual Aladin refresh shares reconciliation and event detection when watch is enabled.
- A provider-wide failure stops the run; one binding-specific failure does not block later bindings.
- Credentials, credential-bearing URLs, provider JSON, and managed paths never reach the frontend or logs.
- No Windows notification, background service, periodic timer, global notification center, generic provider scheduler, or unrelated UI redesign is introduced.
