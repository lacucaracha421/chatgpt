# Aladin Release Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Aladin Release Watch that checks due manga Collections after startup, records unread release changes, and clears their card badge when the Collection is opened.

**Architecture:** Reuse the existing Aladin binding, search, and transactional reconciliation flow. Two focused SQLite tables own subscriptions and unread events; a new `release_watch` Library module owns timing, event reads, and the sequential due runner, while existing Collection projections and UI surfaces only expose counts, toggles, and summaries.

**Tech Stack:** Rust 1.98, rusqlite, chrono, serde, Tauri 2 commands, React 19, TypeScript 7, Vitest 4, Testing Library, existing CSS tokens and UI components.

**Spec:** `docs/superpowers/specs/2026-08-22-aladin-release-watch-design.md`

## Global Constraints

- Existing Aladin bindings remain unsubscribed after migration; connecting Aladin never enables Release Watch automatically.
- Startup checks only subscriptions whose last successful check is null or at least 24 hours old.
- Startup checking is sequential, runs once per open Library, and never blocks initial workspace rendering.
- A startup run performs no same-session retry and starts no recurring timer.
- Detect only a new Volume, a changed publication date, or a derived `upcoming`/`released` status change.
- Preserve MangaDex bindings, WorkArtwork, local Collection metadata, and existing explicit Aladin refresh behavior.
- Keep the TTB key, credential-bearing URLs, raw provider JSON, database internals, and managed paths inside Rust.
- Use stored provider fixtures in automated tests; make no live Aladin request.
- Add no dependency, Windows notification, background service, notification center, generic provider scheduler, job table, provider capability interface, or unrelated visual redesign.
- Keep the existing targeted-check policy: run the smallest test that proves each task, then the affected integration set once at completion.

---

## File Structure

- `app/src-tauri/migrations/0017_aladin_release_watch.sql` owns subscription/event storage and indexes.
- `app/src-tauri/src/library/release_watch.rs` owns subscription status, unread-event lifecycle, due selection, sequential execution, and stop/skip classification.
- `app/src-tauri/src/library/aladin_flow.rs` remains the single Aladin grouping/reconciliation path and emits pending Release Changes inside its existing transaction.
- `app/src-tauri/src/library/collection.rs` projects unread counts into `CollectionSummary` without storing a duplicate counter.
- `app/src-tauri/src/library/models.rs` owns serialized Rust contracts.
- `app/src-tauri/src/commands.rs` and `app/src-tauri/src/lib.rs` expose the four Release Watch commands and stable public failures.
- `app/src/library/types.ts` and `app/src/library/client.ts` mirror the Tauri contracts.
- `app/src/collections/ReleaseWatchSummary.tsx` renders the compact, session-retained unread summary.
- `app/src/collections/CollectionCard.tsx` and `CollectionOverlay.tsx` own the existing card and detail entry points.
- `app/src/app/App.tsx` invokes one due run per keyed `LibraryWorkspace` and refreshes Collection projections after it completes.
- `app/src/styles/global.css` adds only badge, inline summary, and toolbar-adjacent styles using existing tokens.

---

### Task 1: Persist Release Watch state and project unread counts

**Files:**
- Create: `app/src-tauri/migrations/0017_aladin_release_watch.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`

**Interfaces:**
- Consumes: `collection_external_bindings(collection_id, provider)` and `collections(id)`.
- Produces: schema version `17`, `release_watch_subscriptions`, `release_watch_events`, and `CollectionSummary.unread_release_count: u64` serialized as `unreadReleaseCount`.

- [ ] **Step 1: Add a failing v16 migration test**

In `db.rs`, add `migrates_v16_to_release_watch_without_enabling_bindings`. Build an in-memory v16 database with the existing migration constants, insert one manga Collection and one Aladin binding, call `migrate_to_latest(&mut connection, 16)`, then assert:

```rust
assert_eq!(SCHEMA_VERSION, 17);
assert_eq!(
    connection.query_row(
        "SELECT COUNT(*) FROM release_watch_subscriptions",
        [],
        |row| row.get::<_, i64>(0),
    ).unwrap(),
    0,
);
connection.execute(
    "INSERT INTO release_watch_subscriptions (collection_id, provider, last_checked_at)
     VALUES ('work-1', 'mangadex', NULL)",
    [],
).unwrap_err();
```

Also insert one valid `new_volume` event, reject an unknown event kind, delete the Collection, and assert both new tables cascade to zero rows.

- [ ] **Step 2: Run the migration test to verify it fails**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml migrates_v16_to_release_watch_without_enabling_bindings
```

Expected: FAIL because schema version 17 and the new tables do not exist.

- [ ] **Step 3: Add migration 0017 and register it**

Create `0017_aladin_release_watch.sql` with the complete schema:

```sql
CREATE TABLE release_watch_subscriptions (
    collection_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'aladin'),
    last_checked_at TEXT,
    PRIMARY KEY (collection_id, provider),
    FOREIGN KEY (collection_id, provider)
        REFERENCES collection_external_bindings(collection_id, provider)
        ON DELETE CASCADE
);

CREATE TABLE release_watch_events (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN ('new_volume', 'release_date_changed', 'release_status_changed')
    ),
    volume_number INTEGER NOT NULL CHECK (volume_number BETWEEN 1 AND 999),
    previous_value TEXT,
    current_value TEXT,
    detected_at TEXT NOT NULL,
    read_at TEXT
);

CREATE INDEX release_watch_subscriptions_by_due
ON release_watch_subscriptions(last_checked_at, collection_id);

CREATE INDEX release_watch_events_by_collection_unread
ON release_watch_events(collection_id, read_at, detected_at, id);

PRAGMA user_version = 17;
```

In `db.rs`, set `SCHEMA_VERSION` to `17`, include the new file as `ALADIN_RELEASE_WATCH_SCHEMA`, permit prior versions through `16`, and execute the schema when `version <= 16`.

- [ ] **Step 4: Add unread count to the Rust Collection projection**

Add this field to `CollectionSummary`:

```rust
pub unread_release_count: u64,
```

Append this expression before `collection.source_path` in `COLLECTION_SUMMARY_SQL`:

```sql
(
    SELECT COUNT(*)
    FROM release_watch_events AS release_event
    WHERE release_event.collection_id = collection.id
      AND release_event.read_at IS NULL
),
```

Update `collection_from_row` and the serialization fixture in `models.rs` with `unread_release_count: 0`. Add a focused Collection test that inserts two unread events and one read event, then asserts `get_collection(id).unread_release_count == 2`.

- [ ] **Step 5: Run the focused migration and Collection tests**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml migrates_v16_to_release_watch_without_enabling_bindings
cargo test --manifest-path app/src-tauri/Cargo.toml collection_summary_counts_only_unread_release_events
```

Expected: both tests PASS.

- [ ] **Step 6: Commit the persistence slice**

```powershell
git add -- app/src-tauri/migrations/0017_aladin_release_watch.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs
git commit -m "feat: persist Aladin release watch state"
```

---

### Task 2: Add subscription and unread-event Library interfaces

**Files:**
- Create: `app/src-tauri/src/library/release_watch.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`

**Interfaces:**
- Consumes: Task 1 tables and the existing Aladin composite binding key.
- Produces:
  - `ReleaseWatchStatus { enabled: bool, last_checked_at: Option<String> }`
  - `ReleaseWatchEventKind::{NewVolume, ReleaseDateChanged, ReleaseStatusChanged}`
  - `ReleaseWatchEvent { id, kind, volume_number, previous_value, current_value, detected_at }`
  - `Library::get_release_watch_status(&self, collection_id: &str) -> Result<ReleaseWatchStatus, LibraryError>`
  - `Library::set_release_watch_enabled(&self, collection_id: &str, enabled: bool) -> Result<ReleaseWatchStatus, LibraryError>`
  - `Library::take_unread_release_changes(&self, collection_id: &str) -> Result<Vec<ReleaseWatchEvent>, LibraryError>`

- [ ] **Step 1: Write failing subscription and unread lifecycle tests**

In `release_watch.rs`, create a test helper that opens a temporary Library, creates a manga Collection, and optionally inserts an Aladin binding. Add tests proving:

```rust
assert!(matches!(
    library.set_release_watch_enabled(&collection_id, true),
    Err(LibraryError::ReleaseWatchRequiresAladinBinding)
));

let enabled = library.set_release_watch_enabled(&collection_id, true).unwrap();
assert!(enabled.enabled);
assert_eq!(enabled.last_checked_at.as_deref(), Some("2026-08-21T00:00:00Z"));

let disabled = library.set_release_watch_enabled(&collection_id, false).unwrap();
assert!(!disabled.enabled);
```

Seed the subscription from the binding's existing `last_synced_at`, make repeated enable/disable calls idempotent, and prove enabling a non-manga or non-Aladin Collection fails without inserting a row.

For unread lifecycle, insert three events in detection order, call `take_unread_release_changes`, assert the returned typed values and order, assert their `read_at` values become non-null, and assert a second call returns an empty vector. Delete the subscription before taking events and prove the events survive.

- [ ] **Step 2: Run the module tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml release_watch::tests
```

Expected: FAIL because the module, models, and error variant do not exist.

- [ ] **Step 3: Define serialized Release Watch models and error**

Add to `models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWatchStatus {
    pub enabled: bool,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseWatchEventKind {
    NewVolume,
    ReleaseDateChanged,
    ReleaseStatusChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseWatchEvent {
    pub id: String,
    pub kind: ReleaseWatchEventKind,
    pub volume_number: i64,
    pub previous_value: Option<String>,
    pub current_value: Option<String>,
    pub detected_at: String,
}
```

Add `LibraryError::ReleaseWatchRequiresAladinBinding` with Korean text explaining that Aladin must be connected before enabling notifications. Register `mod release_watch;` in `library/mod.rs`.

- [ ] **Step 4: Implement the minimal subscription operations**

In `release_watch.rs`, use row presence as the boolean. Enabling uses one `INSERT ... SELECT` so binding validation and initial timestamp are atomic:

```rust
let inserted = connection.execute(
    "INSERT INTO release_watch_subscriptions (collection_id, provider, last_checked_at)
     SELECT binding.collection_id, binding.provider, binding.last_synced_at
     FROM collection_external_bindings AS binding
     JOIN collections AS collection ON collection.id = binding.collection_id
     WHERE binding.collection_id = ?1
       AND binding.provider = 'aladin'
       AND collection.type = 'manga'
     ON CONFLICT(collection_id, provider) DO NOTHING",
    [collection_id],
)?;
if inserted == 0 && !subscription_exists(&connection, collection_id)? {
    return Err(LibraryError::ReleaseWatchRequiresAladinBinding);
}
```

Disabling deletes only the subscription. `get_release_watch_status` first requires the Collection, then returns `{ enabled: false, last_checked_at: None }` when no row exists.

- [ ] **Step 5: Implement atomic take-and-read**

Use one transaction. Query only `read_at IS NULL` ordered by `detected_at, id`, map event kinds explicitly, update exactly the returned IDs to one `read_at = now`, then commit. Do not delete event rows and do not mark events that arrived after the query.

Use the same `now` string for all returned rows:

```rust
for event in &events {
    transaction.execute(
        "UPDATE release_watch_events SET read_at = ?1
         WHERE id = ?2 AND read_at IS NULL",
        params![now, event.id],
    )?;
}
```

- [ ] **Step 6: Run the module tests and commit**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml release_watch::tests
```

Expected: all subscription and unread lifecycle tests PASS.

```powershell
git add -- app/src-tauri/src/library/release_watch.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs
git commit -m "feat: manage release watch subscriptions"
```

---

### Task 3: Detect Release Changes inside Aladin reconciliation

**Files:**
- Modify: `app/src-tauri/src/library/aladin_flow.rs`
- Modify: `app/src-tauri/src/library/release_watch.rs`

**Interfaces:**
- Consumes: Task 2 subscription lookup and event models.
- Produces:
  - `pub(super) struct PendingReleaseChange { kind, volume_number, previous_value, current_value }`
  - `pub(super) fn pending_release_changes(existing: Option<&StoredAladinSource>, item: &AladinItem, previous_checked_at: Option<&str>, checked_at: &str) -> Vec<PendingReleaseChange>`
  - `pub(super) struct AladinReconcileOutcome { sync_result: AladinSyncResult, release_event_count: u64 }`
  - `pub(super) fn refresh_aladin_items_at(&self, collection_id: &str, items: Vec<AladinItem>, checked_at: &str) -> Result<AladinReconcileOutcome, LibraryError>`
  - the existing `apply_aladin`, `refresh_aladin`, and `AladinSyncResult` public signatures remain unchanged.

- [ ] **Step 1: Write failing pure change-detection tests**

In `release_watch.rs`, test the pure helper with fixed timestamps and exact expected vectors:

```rust
let checked_at = "2026-08-22T00:00:00Z";
let previous = "2026-08-20T00:00:00Z";

assert_eq!(
    pending_release_changes(None, &item(13, Some("2026-09-01")), Some(previous), checked_at)
        .iter().map(|change| change.kind).collect::<Vec<_>>(),
    vec![ReleaseWatchEventKind::NewVolume],
);

assert_eq!(
    pending_release_changes(
        Some(&stored(12, Some("2026-08-21"))),
        &item(12, Some("2026-08-20")),
        Some(previous),
        checked_at,
    ).iter().map(|change| change.kind).collect::<Vec<_>>(),
    vec![
        ReleaseWatchEventKind::ReleaseDateChanged,
        ReleaseWatchEventKind::ReleaseStatusChanged,
    ],
);
```

Also prove unchanged data produces no event, an unchanged date crossing from future at `previous` to past at `checked_at` produces only `ReleaseStatusChanged`, and `previous_checked_at: None` produces no synthetic status change.

- [ ] **Step 2: Run the change-detection tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml pending_release_changes_
```

Expected: FAIL because the helper and pending type do not exist.

- [ ] **Step 3: Implement deterministic date/status comparison**

Move the stored Aladin source tuple into a named `pub(super) StoredAladinSource` containing the fields already compared by `reconcile_source`. Add:

```rust
fn release_status_at(publication_date: Option<&str>, checked_at: &str) -> Option<&'static str> {
    let date = chrono::NaiveDate::parse_from_str(publication_date?, "%Y-%m-%d").ok()?;
    let checked = chrono::DateTime::parse_from_rfc3339(checked_at).ok()?.date_naive();
    Some(if date > checked { "upcoming" } else { "released" })
}
```

`pending_release_changes` emits in stable order: `NewVolume` alone for no stored source; otherwise `ReleaseDateChanged` first when dates differ, followed by `ReleaseStatusChanged` when both a previous check and different derived statuses exist. Previous/current values are the exact nullable dates or `upcoming`/`released` strings.

- [ ] **Step 4: Write failing transactional integration tests**

In `aladin_flow.rs`, add tests that enable Release Watch, run `refresh_aladin_items` with fixture items, then call `take_unread_release_changes`. Prove:

- one newly returned Volume creates one `NewVolume` event;
- a date edit creates the expected date and status events;
- an unchanged repeated refresh creates no additional event;
- when source reconciliation fails with a duplicate provider item, the source update, events, and `last_checked_at` all roll back;
- refresh while watch is disabled updates sources but leaves `release_watch_events` empty;
- initial `apply_aladin` creates no event because no subscription exists.

Pass explicit check timestamps through a private `reconcile_aladin_at(..., checked_at: &str)` helper so tests never depend on the wall clock.

- [ ] **Step 5: Integrate event insertion with the existing transaction**

Inside `reconcile_aladin_at`:

1. Query the subscription's `last_checked_at` before looping sources.
2. Have `reconcile_source` return its stored source and perform the existing upsert.
3. Build pending changes only when the subscription exists.
4. Insert each event with `uuid::Uuid::new_v4()`, exact snapshots, and the same `checked_at`.
5. Update `release_watch_subscriptions.last_checked_at = checked_at` only after every source succeeds.
6. Keep binding snapshot update, event insertion, source reconciliation, and timestamp update inside the current transaction.

Return the existing sync counts and inserted event count in the internal `AladinReconcileOutcome`. The public `apply_aladin` and `refresh_aladin` wrappers return only `outcome.sync_result`; the due runner uses `release_event_count` to count changed Collections without a second database query. `refresh_aladin_items_at` reloads the binding identity/config internally, so the runner does not parse provider configuration outside `aladin_flow.rs`.

The event insert is concrete:

```rust
transaction.execute(
    "INSERT INTO release_watch_events (
        id, collection_id, event_kind, volume_number,
        previous_value, current_value, detected_at, read_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
    params![
        uuid::Uuid::new_v4().to_string(),
        request.collection_id,
        event_kind_str(change.kind),
        change.volume_number,
        change.previous_value,
        change.current_value,
        checked_at,
    ],
)?;
```

- [ ] **Step 6: Run focused Aladin and Release Watch tests**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml pending_release_changes_
cargo test --manifest-path app/src-tauri/Cargo.toml aladin_flow::tests
```

Expected: change-detection and all existing/new Aladin flow tests PASS.

- [ ] **Step 7: Commit transactional detection**

```powershell
git add -- app/src-tauri/src/library/aladin_flow.rs app/src-tauri/src/library/release_watch.rs
git commit -m "feat: record Aladin release changes"
```

---

### Task 4: Run due subscriptions and expose typed Tauri contracts

**Files:**
- Modify: `app/src-tauri/src/library/release_watch.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify gateway mocks in:
  - `app/src/app/App.test.tsx`
  - `app/src/assets/AssetBrowser.test.tsx`
  - `app/src/assets/AssetInspector.test.tsx`
  - `app/src/classification/ClassificationAppearanceDialog.test.tsx`
  - `app/src/classification/ClassificationSidebar.test.tsx`
  - `app/src/collections/AladinConnectDialog.test.tsx`
  - `app/src/collections/CollectionBrowser.test.tsx`
  - `app/src/collections/CollectionOverlay.test.tsx`
  - `app/src/collections/MangaDexImportDialog.test.tsx`
  - `app/src/ingestion/metadataImport.test.ts`
  - `app/src/library/LibraryContext.test.tsx`
  - `app/src/library/LibrarySetup.test.tsx`
  - `app/src/manga/MangaBrowser.test.tsx`
  - `app/src/safety/TrashBrowser.test.tsx`
  - `app/src/settings/SettingsView.test.tsx`
  - `app/src/similarity/SimilarityReviewBrowser.test.tsx`
- Modify CollectionSummary fixtures in:
  - `app/src/app/App.test.tsx`
  - `app/src/assets/AssetBrowser.test.tsx`
  - `app/src/assets/AssetInspector.test.tsx`
  - `app/src/assets/AssetToolbar.test.tsx`
  - `app/src/collections/CollectionBrowser.test.tsx`
  - `app/src/collections/CollectionEditDialog.test.tsx`
  - `app/src/collections/CollectionOverlay.test.tsx`
  - `app/src/collections/MangaDexImportDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3 transactional refresh and Task 2 status/event APIs.
- Produces:
  - `ReleaseWatchRunStopReason = CredentialNotConfigured | InvalidCredential | RateLimited | TimedOut | Unavailable | InvalidResponse`
  - `ReleaseWatchRunResult { checked, changed_collections, skipped, stop_reason }`
  - `Library::run_due_release_watch(&self, ttb_key: &str) -> Result<ReleaseWatchRunResult, LibraryError>`
  - Tauri/gateway commands `getReleaseWatchStatus`, `setReleaseWatchEnabled`, `takeUnreadReleaseChanges`, and `runDueReleaseWatch`.

- [ ] **Step 1: Write failing due-selection and runner tests**

In `release_watch.rs`, use a private `run_due_release_watch_with(checked_at, fetch)` seam whose fetch closure accepts the stored query and returns fixture `Vec<AladinItem>`. Add tests proving:

```rust
let result = library.run_due_release_watch_with(
    "2026-08-22T12:00:00Z",
    |_query| Ok(fixture_items()),
).unwrap();
assert_eq!(result.checked, 2);
assert_eq!(result.changed_collections, 1);
assert_eq!(result.skipped, 0);
assert_eq!(result.stop_reason, None);
```

Seed subscriptions at null, exactly 24 hours old, 23:59:59 old, and older timestamps. Record closure call order to prove only due subscriptions run, oldest first, one closure call at a time.

Add one test where `AmbiguousAladinBinding` increments `skipped` and continues, and one per provider-wide family proving `InvalidAladinCredential`, `AladinRateLimited`, `AladinTimedOut`, `AladinUnavailable`, and `InvalidAladinResponse` set the matching stop reason and make no later fetch call.

- [ ] **Step 2: Run runner tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml run_due_release_watch_
```

Expected: FAIL because the run result and runner do not exist.

- [ ] **Step 3: Add a single-run lock and implement the sequential runner**

Add to `Library`:

```rust
// ponytail: one startup Release Watch run per Library; split only if real provider latency demands it.
release_watch_lock: Arc<Mutex<()>>,
```

Initialize it in `Library::open`. `run_due_release_watch_with` holds this lock, selects due rows ordered by `COALESCE(last_checked_at, ''), collection_id`, drops the database connection before provider calls, and processes each row sequentially through the Task 3 refresh path.

Use `chrono::DateTime::parse_from_rfc3339` and `checked_at - chrono::Duration::hours(24)` for due comparison. A malformed stored timestamp is treated as due rather than silently disabling the subscription.

Map only these provider-wide failures to stop reasons:

```rust
fn stop_reason(error: &LibraryError) -> Option<ReleaseWatchRunStopReason> {
    match error {
        LibraryError::InvalidAladinCredential => Some(ReleaseWatchRunStopReason::InvalidCredential),
        LibraryError::AladinRateLimited => Some(ReleaseWatchRunStopReason::RateLimited),
        LibraryError::AladinTimedOut => Some(ReleaseWatchRunStopReason::TimedOut),
        LibraryError::AladinUnavailable => Some(ReleaseWatchRunStopReason::Unavailable),
        LibraryError::InvalidAladinResponse => Some(ReleaseWatchRunStopReason::InvalidResponse),
        _ => None,
    }
}
```

All other binding-specific errors increment `skipped` and continue. Select the stable query with each due row, fetch by that query, then call Task 3's `refresh_aladin_items_at`. Count a Collection as changed when `release_event_count > 0`; return a distinct Collection count rather than an event count.

- [ ] **Step 4: Add Rust command contracts and stable error mapping**

Add synchronous commands for status, toggle, and take; add an async `run_due_release_watch` command using `spawn_blocking`, matching existing Aladin commands.

For a missing credential, return a successful aggregate with `stop_reason: CredentialNotConfigured`, zero counts, and no provider call. Credential-store failures remain `CommandError` values. Register `release_watch_requires_aladin_binding` in `CommandError::from` and add the four commands to `tauri::generate_handler!`.

Add a command serialization test proving run results and events contain no TTB key, provider URL, raw JSON, or managed path field.

- [ ] **Step 5: Mirror exact contracts in TypeScript and the client**

Add required `unreadReleaseCount: number` to `CollectionSummary`, then define:

```ts
export type ReleaseWatchStatus = {
  enabled: boolean;
  lastCheckedAt: string | null;
};

export type ReleaseWatchEvent = {
  id: string;
  kind: "new_volume" | "release_date_changed" | "release_status_changed";
  volumeNumber: number;
  previousValue: string | null;
  currentValue: string | null;
  detectedAt: string;
};

export type ReleaseWatchRunResult = {
  checked: number;
  changedCollections: number;
  skipped: number;
  stopReason: "credential_not_configured" | "invalid_credential" | "rate_limited" | "timed_out" | "unavailable" | "invalid_response" | null;
};
```

Add these required `LibraryGateway` methods and client invokes:

```ts
getReleaseWatchStatus(collectionId: string): Promise<ReleaseWatchStatus>;
setReleaseWatchEnabled(collectionId: string, enabled: boolean): Promise<ReleaseWatchStatus>;
takeUnreadReleaseChanges(collectionId: string): Promise<ReleaseWatchEvent[]>;
runDueReleaseWatch(): Promise<ReleaseWatchRunResult>;
```

Update every listed gateway mock with deterministic defaults and every listed Collection fixture with `unreadReleaseCount: 0`. Do not make the new fields or methods optional to avoid hiding contract drift.

- [ ] **Step 6: Run runner, command, and TypeScript contract checks**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml run_due_release_watch_
cargo test --manifest-path app/src-tauri/Cargo.toml release_watch_commands_serialize_public_fields_only
npm --prefix app run build
```

Expected: Rust tests PASS and TypeScript/Vite production build exits 0.

- [ ] **Step 7: Commit the runner and IPC slice**

```powershell
git add -- app/src-tauri/src/library/release_watch.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetToolbar.test.tsx app/src/classification/ClassificationAppearanceDialog.test.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/collections/AladinConnectDialog.test.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionEditDialog.test.tsx app/src/collections/CollectionOverlay.test.tsx app/src/collections/MangaDexImportDialog.test.tsx app/src/ingestion/metadataImport.test.ts app/src/library/LibraryContext.test.tsx app/src/library/LibrarySetup.test.tsx app/src/manga/MangaBrowser.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git commit -m "feat: expose due Aladin release checks"
```

---

### Task 5: Show watch controls, unread badges, and inline summaries

**Files:**
- Create: `app/src/collections/ReleaseWatchSummary.tsx`
- Modify: `app/src/collections/CollectionCard.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 4 gateway methods and typed models.
- Produces: accessible `신간 N` card badge, `신간 알림 켜기/끄기` overlay action, and `ReleaseWatchSummary({ events })`.

- [ ] **Step 1: Write the failing card-badge test**

In `CollectionBrowser.test.tsx`, render `{ ...sample, unreadReleaseCount: 3 }` and assert:

```ts
expect(screen.getByText("신간 3")).toBeInTheDocument();
```

Render the zero-count sample and assert `queryByText(/신간/)` is null. Keep the card's Collection name, type, and asset count assertions unchanged.

- [ ] **Step 2: Run the card test to verify it fails**

Run:

```powershell
npm --prefix app test -- src/collections/CollectionBrowser.test.tsx
```

Expected: FAIL because `CollectionCard` does not render the badge.

- [ ] **Step 3: Implement the badge with existing card markup**

Inside `.collection-card__cover`, add only when the count is positive:

```tsx
{collection.unreadReleaseCount > 0 && (
  <span className="collection-card__release-badge">
    신간 {collection.unreadReleaseCount}
  </span>
)}
```

Make `.collection-card__cover` positioned and place the badge at the top-right using existing accent, surface, radius, and text-size tokens. Do not add an icon, animation, or dependency.

- [ ] **Step 4: Write failing overlay lifecycle tests**

In `CollectionOverlay.test.tsx`, add focused cases:

- connected manga + disabled status shows `신간 알림 켜기`; clicking calls `setReleaseWatchEnabled(collection.id, true)` and changes the accessible name to `신간 알림 끄기`;
- connected manga + enabled status toggles off;
- manga without Aladin binding exposes neither toggle;
- `takeUnreadReleaseChanges` returning new/date/status events renders one `새 출간 정보` region containing the affected Volume numbers and value changes, calls `onChanged` once, and does not alter the selected cover;
- an empty event result renders no `새 출간 정보` region and does not call `onChanged` merely for reading;
- manual Aladin refresh reloads watch status after success while retaining all existing cover assertions.

Use this event fixture:

```ts
const unread: ReleaseWatchEvent[] = [
  { id: "e1", kind: "new_volume", volumeNumber: 13, previousValue: null, currentValue: "2026-09-01", detectedAt: "2026-08-22T00:00:00Z" },
  { id: "e2", kind: "release_date_changed", volumeNumber: 12, previousValue: "2026-08-21", currentValue: "2026-08-23", detectedAt: "2026-08-22T00:00:00Z" },
  { id: "e3", kind: "release_status_changed", volumeNumber: 11, previousValue: "upcoming", currentValue: "released", detectedAt: "2026-08-22T00:00:00Z" },
];
```

- [ ] **Step 5: Run overlay tests to verify they fail**

Run:

```powershell
npm --prefix app test -- src/collections/CollectionOverlay.test.tsx
```

Expected: FAIL because status, toggle, take, and summary UI are absent.

- [ ] **Step 6: Implement the compact summary component**

Create `ReleaseWatchSummary.tsx`. Group events by kind in stable order and render one compact region:

```tsx
export function ReleaseWatchSummary({ events }: { events: ReleaseWatchEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section className="release-watch-summary" aria-label="새 출간 정보">
      <strong>새 출간 정보</strong>
      <ul>
        {summaryLines(events).map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}
```

`summaryLines` emits Korean text using exact data:

- `새 권: 13권, 14권`
- `출간일 변경: 12권 2026-08-21 → 2026-08-23`
- `출간 상태 변경: 11권 출간 예정 → 출간됨`

Use `알 수 없음` only for a nullable previous/current date value. Map only `upcoming` and `released`; render an unknown status string unchanged rather than inventing a label.

- [ ] **Step 7: Integrate overlay status, take, and toggle**

Add states:

```ts
const [releaseWatchStatus, setReleaseWatchStatus] = useState<ReleaseWatchStatus | null>(null);
const [releaseChanges, setReleaseChanges] = useState<ReleaseWatchEvent[]>([]);
const [releaseWatchSaving, setReleaseWatchSaving] = useState(false);
```

For every manga Collection, take unread events once per `collectionId`. Retain the returned array locally and call `onChanged()` only when its length is positive. Separately fetch watch status only after an Aladin connection exists.

Add one toolbar button next to `Aladin 새로고침`, disabled while saving. On success, replace status with the returned value. On failure, preserve the current status and show the existing Toast through `commandErrorMessage`.

Render `ReleaseWatchSummary` between the Toast and `.collection-overlay__body`, so it remains visible until the overlay closes without disturbing the three-column body or selected Volume.

- [ ] **Step 8: Add restrained styles and run both UI tests**

Add styles for `.collection-card__release-badge` and `.release-watch-summary` using existing spacing, accent, border, surface, radius, and text tokens. Use no gradient, scale transform, entrance animation, fixed overlay, or new card system.

Run:

```powershell
npm --prefix app test -- src/collections/CollectionBrowser.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: both test files PASS and existing MangaDex/Aladin cover-flow assertions remain green.

- [ ] **Step 9: Commit the Collection UI slice**

```powershell
git add -- app/src/collections/ReleaseWatchSummary.tsx app/src/collections/CollectionCard.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx app/src/styles/global.css
git commit -m "feat: show unread Aladin releases"
```

---

### Task 6: Trigger one startup run and complete focused verification

**Files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/README.md`
- Modify: `docs/superpowers/plans/2026-08-22-aladin-release-watch.md` (check off executed steps and record evidence)
- Verify: `docs/superpowers/specs/2026-08-22-aladin-release-watch-design.md`

**Interfaces:**
- Consumes: `LibraryGateway.runDueReleaseWatch`, `refreshCollections`, `appendMessage`, and `LibraryWorkspace`'s existing `key={library.root}` remount boundary.
- Produces: one cancellable startup effect per open Library and final user documentation.

- [ ] **Step 1: Write failing App startup tests**

In `App.test.tsx`, add a test with an open Library and a deferred `runDueReleaseWatch` promise. Assert the workspace and navigation render before resolving the promise, and assert the method is invoked once for that `LibraryWorkspace`.

Resolve with:

```ts
{
  checked: 3,
  changedCollections: 2,
  skipped: 0,
  stopReason: null,
}
```

Then assert `listCollections` runs again and one status Toast contains `새 출간 정보가 있는 작품 2개`.

Add a stale-result test using the existing Settings flow from `remounts and reloads the workspace after switching library roots`: open library A, leave its watcher deferred, click `설정` then `다른 저장소 열기` to open B, resolve A, and assert A's result does not refresh B or show a Toast. Add a zero-change result test proving no Release Watch Toast appears.

- [ ] **Step 2: Run the App tests to verify they fail**

Run:

```powershell
npm --prefix app test -- src/app/App.test.tsx
```

Expected: FAIL because the startup effect does not exist.

- [ ] **Step 3: Implement the cancellable startup effect**

Add beside existing backup/purge startup effects:

```tsx
useEffect(() => {
  let active = true;
  void (async () => {
    const result = await gateway.runDueReleaseWatch();
    if (!active) return;
    await refreshCollections();
    if (!active || result.changedCollections === 0) return;
    appendMessage(`새 출간 정보가 있는 작품 ${result.changedCollections}개`);
  })().catch((error) => {
    if (active) {
      console.warn("Release Watch startup check failed", commandErrorMessage(error, "신간 확인을 완료하지 못했습니다."));
    }
  });
  return () => { active = false; };
}, [appendMessage, gateway, libraryRoot, refreshCollections]);
```

Do not show a second failure Toast, retry, interval, or WorkTray item. The error path logs only the redacted public command message and never provider data or a request URL.

- [ ] **Step 4: Run the App test and affected UI set**

Run:

```powershell
npm --prefix app test -- src/app/App.test.tsx src/collections/CollectionBrowser.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: all affected React tests PASS.

- [ ] **Step 5: Document the user-visible behavior**

In `app/README.md`, add one concise paragraph in the Collection/Aladin area:

```markdown
Release Watch is opt-in per Aladin-connected manga. On startup Lakomics checks subscriptions whose last successful check is at least 24 hours old, shows an unread `신간 N` badge for new or changed Korean releases, and marks those changes read when the Collection is opened. Lakomics does not check while the app is closed.
```

- [ ] **Step 6: Run focused Rust integration evidence**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml release_watch
cargo test --manifest-path app/src-tauri/Cargo.toml aladin_flow::tests
cargo test --manifest-path app/src-tauri/Cargo.toml collection_summary_counts_only_unread_release_events
```

Expected: subscription, runner, transactional Aladin, and projection tests PASS.

- [ ] **Step 7: Run final formatting, frontend build, and diff checks**

Run:

```powershell
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
npm --prefix app run build
git diff --check
git status --short
```

Expected:

- Rust formatting exits 0.
- TypeScript and Vite production build exit 0; the existing large-chunk warning is informational.
- `git diff --check` exits 0.
- only Release Watch implementation, tests, README, spec alignment, and this checked-off plan are modified.

- [ ] **Step 8: Review scope against the design**

Compare `git diff main...HEAD` with every acceptance criterion in `docs/superpowers/specs/2026-08-22-aladin-release-watch-design.md`. Confirm explicitly:

- no existing binding is auto-subscribed;
- no timer, service, Windows notification, notification center, provider abstraction, or live-provider test was added;
- no TTB key, credential-bearing URL, raw provider response, or managed path is serialized or logged;
- startup is cancellable by Library switch and does not block workspace rendering;
- manual refresh and startup use one transactional reconciliation path;
- unread events survive disabling and are marked read only when returned to the overlay.

- [ ] **Step 9: Commit startup integration and documentation**

```powershell
git add -- app/src/app/App.tsx app/src/app/App.test.tsx app/README.md docs/superpowers/plans/2026-08-22-aladin-release-watch.md
git commit -m "feat: check Aladin releases after startup"
```

---

## Completion Evidence

Before declaring the feature complete, record the exact successful commands and counts from Task 6. Do not run the entire Rust or Vitest suite solely for ceremony; expand beyond the affected set only when a focused failure identifies a cross-module regression.

Expected commit sequence:

1. `feat: persist Aladin release watch state`
2. `feat: manage release watch subscriptions`
3. `feat: record Aladin release changes`
4. `feat: expose due Aladin release checks`
5. `feat: show unread Aladin releases`
6. `feat: check Aladin releases after startup`
