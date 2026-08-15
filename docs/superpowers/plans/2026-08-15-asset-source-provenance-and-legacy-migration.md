# Asset Source Provenance and Legacy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user requires inline execution without subagents.

**Goal:** Add editable publication and creator metadata, read-only ingestion provenance in the asset inspector, and a safe one-time tool that migrates the 6,473 legacy images in `C:\lakomics\save` into the current library.

**Architecture:** Nullable source and provenance columns live on `assets`, while validation and patching stay behind a focused Rust `asset_metadata` module. Every ingestion caller supplies a controlled origin and batch UUID; the library captures local source modification time and preserves provenance on exact duplicates. A standalone Rust binary reuses the library interface to parse the two legacy snapshots, reconstruct classification paths, ingest images, and emit a report without adding a permanent migration screen.

**Tech Stack:** Rust 2021, rusqlite/SQLite, serde/serde_json, chrono, uuid, url, Tauri 2, React 19, TypeScript 5.8, Vitest/Testing Library.

## Global Constraints

- Preserve the meanings of `source_url`, `collected_at`, and `favorite` defined in `CONTEXT.md`.
- New metadata columns are nullable; never fabricate values for existing assets.
- Editable fields are publication time, creator name, creator handle, and creator URL only.
- `import_source`, `import_batch_id`, and `original_modified_at` are system-owned and read-only.
- Supported origins are `direct`, `browser_extension`, `metadata_import`, and `legacy_lakomics`.
- Exact duplicates may enrich source-facing metadata but must not overwrite their original ingestion provenance.
- Never fetch or scrape source pages to fill metadata.
- Keep the inspector compact; add no card, shadow, dialog, gradient, or decorative surface.
- Preserve all files in `C:\lakomics\save`; migration copies into the media vault and never moves, renames, or deletes legacy originals.
- Treat `.jfif` as JPEG during the legacy migration.
- Run implementation directly in the current session; do not dispatch subagents.

---

### Task 1: Schema version 9 and complete asset read model

**Files:**
- Create: `app/src-tauri/migrations/0009_asset_source_provenance.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`
- Modify: `app/src-tauri/tests/video_acceptance.rs`
- Test: `app/src-tauri/src/library/db.rs`
- Test: `app/src-tauri/src/library/query.rs`

**Interfaces:**
- Produces: `ImportSource`, the seven new nullable `AssetSummary` fields, and SQLite schema version 9.
- Consumes: existing `AssetSummary`, `asset_summary_from_row`, and rotating pre-migration backup behavior.

- [ ] **Step 1: Write the failing v8-to-v9 migration test**

Add a `migrates_v8_to_asset_source_provenance` test in `db.rs`. Build an in-memory v8 database from migrations 1–8, insert one asset, run `migrate_to_latest`, and assert both preservation and the new nullable columns:

```rust
let metadata = connection.query_row(
    "SELECT source_published_at, creator_name, creator_handle, creator_url,
            import_source, import_batch_id, original_modified_at
       FROM assets WHERE id = 'asset-1'",
    [],
    |row| Ok((
        row.get::<_, Option<String>>(0)?,
        row.get::<_, Option<String>>(1)?,
        row.get::<_, Option<String>>(2)?,
        row.get::<_, Option<String>>(3)?,
        row.get::<_, Option<String>>(4)?,
        row.get::<_, Option<String>>(5)?,
        row.get::<_, Option<String>>(6)?,
    )),
).unwrap();
assert_eq!(metadata, (None, None, None, None, None, None, None));
assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 9);
```

- [ ] **Step 2: Run the focused migration test and confirm it fails**

Run:

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::db::tests::migrates_v8_to_asset_source_provenance -- --exact
```

Expected: FAIL because schema version 9 and the new columns do not exist.

- [ ] **Step 3: Add migration 0009 and register it**

Create the SQL migration:

```sql
ALTER TABLE assets ADD COLUMN source_published_at TEXT;
ALTER TABLE assets ADD COLUMN creator_name TEXT;
ALTER TABLE assets ADD COLUMN creator_handle TEXT;
ALTER TABLE assets ADD COLUMN creator_url TEXT;
ALTER TABLE assets ADD COLUMN import_source TEXT;
ALTER TABLE assets ADD COLUMN import_batch_id TEXT;
ALTER TABLE assets ADD COLUMN original_modified_at TEXT;
PRAGMA user_version = 9;
```

In `db.rs`, set `SCHEMA_VERSION` to 9, include `0009_asset_source_provenance.sql`, migrate `version <= 8`, and expand the accepted old-version range to `0..=8`.

- [ ] **Step 4: Extend the Rust asset model and query projections**

Define the origin enum and add nullable fields:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportSource {
    Direct,
    BrowserExtension,
    MetadataImport,
    LegacyLakomics,
}

pub struct AssetSummary {
    // existing fields stay unchanged
    pub source_published_at: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub creator_url: Option<String>,
    pub import_source: Option<ImportSource>,
    pub import_batch_id: Option<String>,
    pub original_modified_at: Option<String>,
}
```

Append the seven columns to every asset-summary SELECT in `query.rs`, `trash.rs`, and `similarity.rs`. Update `asset_summary_from_row` once. Shift every column read after the summary: random hash/bucket indices in `query.rs`, `trashed_at` in `trash.rs`, and any similarity-review columns following the joined asset summary. Update every `AssetSummary` construction site in `models.rs`, `query.rs`, `ingestion.rs`, `trash.rs`, `foundation_flow.rs`, and `video_acceptance.rs` with explicit values.

Because rusqlite does not deserialize the enum through serde, add explicit `ImportSource::as_str()` and `ImportSource::parse(&str)` helpers. Persist only `as_str()` values; turn a null database value into `None` and an unrecognized stored value into `None` at the read boundary.

- [ ] **Step 5: Add a query round-trip test for all new fields**

Insert an asset containing all seven values and assert `get_asset`/`list_assets` returns:

```rust
assert_eq!(asset.source_published_at.as_deref(), Some("2026-08-01T10:20:30Z"));
assert_eq!(asset.creator_name.as_deref(), Some("Example Artist"));
assert_eq!(asset.creator_handle.as_deref(), Some("example"));
assert_eq!(asset.creator_url.as_deref(), Some("https://x.com/example"));
assert_eq!(asset.import_source, Some(ImportSource::MetadataImport));
assert_eq!(asset.import_batch_id.as_deref(), Some("31d1f90c-214b-41e2-9d84-f9d964bb5bc3"));
assert_eq!(asset.original_modified_at.as_deref(), Some("2026-07-31T09:00:00Z"));
```

- [ ] **Step 6: Run schema and query tests**

Run:

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::db::tests
cargo test library::query::tests
```

Expected: PASS.

- [ ] **Step 7: Commit the schema/read-model slice**

```powershell
Set-Location C:\chatgpt
git add app/src-tauri/migrations/0009_asset_source_provenance.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/query.rs app/src-tauri/src/library/trash.rs app/src-tauri/src/library/similarity.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/tests/foundation_flow.rs app/src-tauri/tests/video_acceptance.rs
git commit -m "feat: add asset source provenance schema"
```

---

### Task 2: Validated source metadata editing interface

**Files:**
- Create: `app/src-tauri/src/library/asset_metadata.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/src/library/asset_metadata.rs`

**Interfaces:**
- Consumes: `Library::get_asset(&str) -> Result<AssetSummary, LibraryError>` from Task 1.
- Produces: `AssetMetadataPatch` and `Library::update_asset_metadata(AssetMetadataPatch) -> Result<AssetSummary, LibraryError>`.

- [ ] **Step 1: Write failing metadata patch tests**

Cover successful update, clearing with null, invalid URL, invalid RFC 3339 time, missing asset, and atomic failure. Use this request shape:

```rust
let updated = library.update_asset_metadata(AssetMetadataPatch {
    asset_id: asset.id.clone(),
    source_published_at: Some("2026-08-01T10:20:30Z".into()),
    creator_name: Some("Example Artist".into()),
    creator_handle: Some("example".into()),
    creator_url: Some("https://x.com/example".into()),
}).unwrap();
assert_eq!(updated.creator_handle.as_deref(), Some("example"));
```

For clearing, pass four `None` values and assert the persisted columns are null. For atomicity, combine a changed name with `creator_url: Some("javascript:alert(1)".into())` and assert the old name remains.

- [ ] **Step 2: Run the focused test and confirm it fails**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::asset_metadata::tests
```

Expected: FAIL because the module and patch interface do not exist.

- [ ] **Step 3: Implement normalization and validation**

Create one normalization function used by editing and ingestion:

```rust
pub(crate) fn normalize_source_metadata(
    published_at: Option<String>,
    creator_name: Option<String>,
    creator_handle: Option<String>,
    creator_url: Option<String>,
) -> Result<NormalizedSourceMetadata, LibraryError> {
    let published_at = optional_text(published_at);
    if published_at.as_deref().is_some_and(|value| DateTime::parse_from_rfc3339(value).is_err()) {
        return Err(LibraryError::InvalidSourcePublishedAt);
    }
    let creator_url = optional_text(creator_url);
    if creator_url.as_deref().is_some_and(|value| !valid_http_url(value)) {
        return Err(LibraryError::InvalidCreatorUrl);
    }
    Ok(NormalizedSourceMetadata {
        published_at,
        creator_name: optional_text(creator_name),
        creator_handle: optional_text(creator_handle),
        creator_url,
    })
}
```

Trim values and convert empty strings to null. Accept only `http` and `https` creator URLs.

- [ ] **Step 4: Implement one-transaction patching and return the updated summary**

Use one transaction and never include provenance columns in the update:

```rust
let changed = transaction.execute(
    "UPDATE assets
        SET source_published_at = ?2, creator_name = ?3,
            creator_handle = ?4, creator_url = ?5
      WHERE id = ?1 AND status = 'normal'",
    params![request.asset_id, metadata.published_at, metadata.creator_name,
            metadata.creator_handle, metadata.creator_url],
)?;
if changed == 0 { return Err(LibraryError::AssetNotFound); }
transaction.commit()?;
self.get_asset(&request.asset_id)
```

Add `InvalidSourcePublishedAt` and `InvalidCreatorUrl` error variants and stable command error codes.

- [ ] **Step 5: Expose the Tauri command**

Add and register:

```rust
#[tauri::command]
pub fn update_asset_metadata(
    request: AssetMetadataPatch,
    state: State<'_, AppState>,
) -> Result<AssetSummary, CommandError> {
    current_required(state)?.update_asset_metadata(request).map_err(CommandError::from)
}
```

- [ ] **Step 6: Run focused and full Rust library tests**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::asset_metadata::tests
cargo test library::
```

Expected: PASS.

- [ ] **Step 7: Commit the edit interface**

```powershell
Set-Location C:\chatgpt
git add app/src-tauri/src/library/asset_metadata.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat: edit asset source metadata"
```

---

### Task 3: Provenance-aware ingestion across every caller

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/asset_metadata.rs`
- Modify: `app/src-tauri/src/extension_api.rs`
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/metadataImport.ts`
- Modify: `app/src/library/types.ts`
- Test: `app/src-tauri/src/library/ingestion.rs`
- Test: `app/src-tauri/src/extension_api.rs`
- Test: `app/src-tauri/tests/foundation_flow.rs`
- Test: `app/src-tauri/tests/video_acceptance.rs`
- Test: `app/src/ingestion/useFileDrop.test.ts`
- Test: `app/src/ingestion/metadataImport.test.ts`

**Interfaces:**
- Consumes: `ImportSource` and source metadata normalization from Tasks 1–2.
- Produces: expanded `IngestMediaRequest`/`IngestMediaInput` with source metadata, `import_source`, and `import_batch_id`.

- [ ] **Step 1: Write failing ingestion provenance tests**

Add Rust tests proving:

```rust
let request = IngestMediaRequest {
    source_path: source.clone(),
    classification_id: None,
    source_url: Some("https://x.com/example/status/1".into()),
    collected_at: None,
    replace_duplicate_metadata: false,
    source_published_at: Some("2026-08-01T10:20:30Z".into()),
    creator_name: Some("Example Artist".into()),
    creator_handle: Some("example".into()),
    creator_url: Some("https://x.com/example".into()),
    import_source: ImportSource::Direct,
    import_batch_id: "31d1f90c-214b-41e2-9d84-f9d964bb5bc3".into(),
};
```

Assertions:

- new local assets store all source metadata, origin, batch ID, and source-file modification time;
- malformed batch UUID, creator URL, and publication time fail before registration;
- browser-extension origin leaves `original_modified_at` null;
- exact-duplicate enrichment updates source-facing fields but preserves first origin, batch ID, and modification time.

- [ ] **Step 2: Add failing frontend caller tests for shared batch IDs**

In `useFileDrop.test.ts`, drop two paths and assert both calls contain the same non-empty `importBatchId` and `importSource: "direct"`.

In `metadataImport.test.ts`, assert every planned item receives the work ID as `importBatchId` and `importSource: "metadata_import"`.

Run:

```powershell
Set-Location C:\chatgpt\app
npm test -- src/ingestion/useFileDrop.test.ts src/ingestion/metadataImport.test.ts
```

Expected: FAIL because the request fields are absent.

- [ ] **Step 3: Expand and validate the ingestion request**

Add fields with camelCase serde mapping:

```rust
pub struct IngestMediaRequest {
    // existing fields
    pub source_published_at: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub creator_url: Option<String>,
    pub import_source: ImportSource,
    pub import_batch_id: String,
}
```

Parse `import_batch_id` with `Uuid::parse_str`. Normalize source metadata before staging. For origins other than `BrowserExtension`, capture modification time with:

```rust
let original_modified_at = source_metadata.modified().ok()
    .map(chrono::DateTime::<chrono::Utc>::from)
    .map(|value| value.to_rfc3339());
```

- [ ] **Step 4: Persist new metadata for images and videos**

Populate the `AssetSummary`, image INSERT, and video INSERT with all normalized values. Extend duplicate enrichment only with source-facing values:

```sql
UPDATE assets
SET source_url = COALESCE(?2, source_url),
    collected_at = COALESCE(?3, collected_at),
    source_published_at = COALESCE(?4, source_published_at),
    creator_name = COALESCE(?5, creator_name),
    creator_handle = COALESCE(?6, creator_handle),
    creator_url = COALESCE(?7, creator_url)
WHERE id = ?1
```

Do not mention `import_source`, `import_batch_id`, or `original_modified_at` in the duplicate update.

- [ ] **Step 5: Set origin and batch at every production call site**

Use the existing work UUID as the batch:

```ts
await ingestMedia({
  sourcePath,
  classificationId: destination,
  sourceUrl: null,
  importSource: "direct",
  importBatchId: workId,
});
```

Metadata import passes `metadata_import` and its `workId`. The extension API constructs `BrowserExtension` and a new UUID per HTTP request. Add a conservative helper that returns `example` for `https://x.com/example/status/123` but returns null for `https://x.com/i/status/123` and unknown hosts.

Update all `IngestMediaRequest` fixtures in `ingestion.rs`, `similarity.rs`, `models.rs`, `extension_api.rs`, `foundation_flow.rs`, and `video_acceptance.rs` with explicit origins and valid deterministic batch UUIDs.

- [ ] **Step 6: Run ingestion, extension, and frontend caller tests**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::ingestion::tests
cargo test extension_api::tests
Set-Location C:\chatgpt\app
npm test -- src/ingestion/useFileDrop.test.ts src/ingestion/metadataImport.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit provenance-aware ingestion**

```powershell
Set-Location C:\chatgpt
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/src/library/similarity.rs app/src-tauri/src/library/asset_metadata.rs app/src-tauri/src/extension_api.rs app/src/ingestion/useFileDrop.ts app/src/ingestion/metadataImport.ts app/src/library/types.ts app/src-tauri/tests/foundation_flow.rs app/src-tauri/tests/video_acceptance.rs
git commit -m "feat: record asset ingestion provenance"
```

---

### Task 4: Frontend contract and compact metadata formatting

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/client.test.ts`
- Modify: `app/src/assets/assetMetadata.ts`
- Create: `app/src/assets/assetMetadata.test.ts`
- Modify: every frontend test fixture returned by `rg -l "sourceUrl:" app/src --glob "*.test.ts" --glob "*.test.tsx"`

**Interfaces:**
- Consumes: Tauri `update_asset_metadata` and expanded `AssetSummary` from Tasks 1–2.
- Produces: `AssetMetadataPatch`, `LibraryGateway.updateAssetMetadata`, `creatorLabel`, `importSourceLabel`, `localDateTime`, and `batchLabel`.

- [ ] **Step 1: Write failing client and formatting tests**

Assert the client invokes the exact command payload:

```ts
await libraryGateway.updateAssetMetadata({
  assetId: "asset-1",
  sourcePublishedAt: "2026-08-01T10:20:30Z",
  creatorName: "Example Artist",
  creatorHandle: "example",
  creatorUrl: "https://x.com/example",
});
expect(invoke).toHaveBeenCalledWith("update_asset_metadata", { request: expect.any(Object) });
```

Formatting assertions:

```ts
expect(creatorLabel("Example Artist", "example")).toBe("Example Artist (@example)");
expect(creatorLabel(null, "@example")).toBe("@example");
expect(importSourceLabel("legacy_lakomics")).toBe("구버전 Lakomics 이전");
expect(importSourceLabel("future_value" as never)).toBe("—");
expect(localDateTime("bad date")).toBe("—");
```

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/library/client.test.ts src/assets/assetMetadata.test.ts
```

Expected: FAIL because the contract and helpers do not exist.

- [ ] **Step 3: Add required nullable TypeScript fields and patch contract**

```ts
export type ImportSource = "direct" | "browser_extension" | "metadata_import" | "legacy_lakomics";

export type AssetSummary = {
  // existing fields
  sourcePublishedAt: string | null;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorUrl: string | null;
  importSource: ImportSource | null;
  importBatchId: string | null;
  originalModifiedAt: string | null;
};

export type AssetMetadataPatch = {
  assetId: string;
  sourcePublishedAt: string | null;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorUrl: string | null;
};
```

Add `updateAssetMetadata(request): Promise<AssetSummary>` to the gateway and client. Keep fields required-but-nullable so fixtures cannot silently omit runtime data.

- [ ] **Step 4: Implement formatting helpers and update fixtures**

Normalize an already-prefixed handle before display:

```ts
export function creatorLabel(name: string | null, handle: string | null): string {
  const account = handle ? `@${handle.replace(/^@+/, "")}` : null;
  if (name && account) return `${name} (${account})`;
  return name || account || "—";
}
```

Map the four origin values to Korean labels and return `—` for null or unknown. Add explicit nulls to all `AssetSummary` test factories found by the `rg` command in the Files section.

- [ ] **Step 5: Run client, formatting, and TypeScript build checks**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/library/client.test.ts src/assets/assetMetadata.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit the frontend contract**

```powershell
Set-Location C:\chatgpt
git add app/src/library app/src/assets/assetMetadata.ts app/src/assets/assetMetadata.test.ts app/src/video/VideoTileMedia.test.tsx app/src/video/VideoPlayer.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/ingestion/metadataImport.test.ts app/src/similarity/SimilarityReviewBrowser.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetGallery.test.tsx app/src/ingestion/useFileDrop.test.ts app/src/assets/AssetViewer.test.tsx app/src/app/App.test.tsx
git commit -m "feat: expose asset provenance metadata"
```

---

### Task 5: Asset inspector display and inline editing

**Files:**
- Modify: `app/src/assets/AssetInspector.tsx`
- Modify: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `LibraryGateway.updateAssetMetadata` and Task 4 formatting helpers.
- Produces: `AssetInspector.onAssetUpdated(asset: AssetSummary)` so the parent page replaces stale summaries.

- [ ] **Step 1: Write failing display tests**

Render one asset with complete metadata and assert the compact rows and links:

```tsx
expect(screen.getByText("Example Artist (@example)")).toBeVisible();
expect(screen.getByText("브라우저 확장")).toBeVisible();
expect(screen.getByText("31d1f90c-214b-41e2-9d84-f9d964bb5bc3")).toBeVisible();
await user.click(screen.getByRole("button", { name: "제작자 페이지 열기" }));
expect(openUrl).toHaveBeenCalledWith("https://x.com/example");
```

Also render null metadata and assert each row displays `—`; omit the batch row entirely when `importBatchId` is null.

- [ ] **Step 2: Write failing edit-state tests**

Cover:

- `편집` reveals four labeled fields;
- `취소` restores persisted values;
- save trims empty fields to null and calls `updateAssetMetadata` once;
- successful save calls `onAssetUpdated` with the returned summary;
- invalid URL/date error preserves the draft;
- backend failure stays in edit mode;
- Escape leaves edit mode before a later Escape closes the inspector.
- multi-selection still hides per-asset source metadata and keeps the existing selection summary and organization controls.

Use labels `게시 시각`, `제작자 이름`, `계정명`, and `제작자 URL` so tests enforce accessible names.

- [ ] **Step 3: Run inspector tests and confirm failure**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/assets/AssetInspector.test.tsx src/assets/AssetBrowser.test.tsx
```

Expected: FAIL because the new rows and editor do not exist.

- [ ] **Step 4: Implement the read-only rows and quiet links**

Keep one `<dl>` and the approved order. Use existing ghost/icon buttons for external links. Render provenance as plain text; do not put each row in a card.

```tsx
<div><dt>제작자</dt><dd>{creatorLabel(asset.creatorName, asset.creatorHandle)}</dd></div>
<div><dt>게시 날짜</dt><dd>{localDateTime(asset.sourcePublishedAt)}</dd></div>
<div><dt>가져온 방식</dt><dd>{importSourceLabel(asset.importSource)}</dd></div>
<div><dt>원본 수정 날짜</dt><dd>{localDateTime(asset.originalModifiedAt)}</dd></div>
```

- [ ] **Step 5: Implement inline editing and parent convergence**

Maintain a local draft only while editing. On save:

```tsx
const updated = await gateway.updateAssetMetadata({
  assetId: asset.id,
  sourcePublishedAt: nullable(draft.sourcePublishedAt),
  creatorName: nullable(draft.creatorName),
  creatorHandle: nullable(draft.creatorHandle),
  creatorUrl: nullable(draft.creatorUrl),
});
onAssetUpdated(updated);
setEditing(false);
```

In `AssetBrowser`, replace the matching item in the active page and requested asset when `onAssetUpdated` fires. Do not refetch the whole library.

- [ ] **Step 6: Add compact inspector styling**

Reuse spacing and controls from tokens:

```css
.asset-inspector__metadata-editor {
  display: grid;
  gap: var(--space-2);
}

.asset-inspector__metadata-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.asset-inspector__batch-id {
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
```

If `--font-mono` does not exist, add one semantic token in `tokens.css` rather than hardcoding a stack.

- [ ] **Step 7: Run UI tests and production build**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/assets/AssetInspector.test.tsx src/assets/AssetBrowser.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit the inspector feature**

```powershell
Set-Location C:\chatgpt
git add app/src/assets/AssetInspector.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src/styles/global.css app/src/styles/tokens.css
git commit -m "feat: show and edit asset source details"
```

---

### Task 6: Legacy snapshot parser and deterministic migration plan

**Files:**
- Create: `app/src-tauri/src/library/legacy_migration.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Test: `app/src-tauri/src/library/legacy_migration.rs`

**Interfaces:**
- Consumes: `Library::ingest_media`, classification APIs, metadata patching, and `ImportSource::LegacyLakomics`.
- Produces: `inspect_legacy_migration(LegacyMigrationPaths) -> Result<LegacyMigrationPlan, LibraryError>` and `Library::execute_legacy_migration(plan, progress) -> Result<LegacyMigrationReport, LibraryError>`.

- [ ] **Step 1: Write fixture-driven failing parser tests**

Create temporary JSON fixtures in the test rather than reading personal data. Include:

- primary `metadata_latest.json` with one image and embedded `contentPreferences.storage_tag_tree`;
- fallback `storage_metadata_latest.json` with a second image absent from the primary;
- a third disk image absent from both snapshots;
- a `.jfif` image;
- a tree where `c:라플라스` is nested under `게임/리버스/라플라스`.

Assert:

```rust
assert_eq!(plan.images.len(), 4);
assert_eq!(plan.metadata_matched, 3);
assert_eq!(plan.unclassified, 1);
assert_eq!(plan.classification_paths, vec![
    vec!["게임".into()],
    vec!["게임".into(), "리버스".into()],
    vec!["게임".into(), "리버스".into(), "라플라스".into()],
]);
assert_eq!(plan.images[0].import_batch_id, plan.images[1].import_batch_id);
```

- [ ] **Step 2: Run the parser tests and confirm failure**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::legacy_migration::tests
```

Expected: FAIL because the migration module does not exist.

- [ ] **Step 3: Implement strict snapshot parsing and precedence**

Accept explicit paths for library root, legacy root, primary snapshot, and fallback snapshot. Enumerate only direct child files of the legacy root with extensions `jpg`, `jpeg`, `jfif`, `png`, `gif`, and `webp`.

Index metadata case-insensitively by basename. Prefer the primary snapshot and use the fallback only when the basename is absent. Reject duplicate basenames inside one snapshot rather than choosing nondeterministically.

```rust
let metadata = primary.get(&key).or_else(|| fallback.get(&key));
```

Never descend into `assets`, `thumbnails`, `trash`, `backups`, `.lakomics`, `dd.library`, or `video-media`.

- [ ] **Step 4: Reconstruct classification paths from the embedded tree**

Parse `contentPreferences.storage_tag_tree`, traverse depth-first, and map every `autoTags` entry to its node path. For each image, select the deepest matching path. Break equal-depth ties by tree order and record a warning in the plan. Strip no prefix by string heuristics; use only the stored tree labels and `autoTags` mapping.

- [ ] **Step 5: Support JFIF as JPEG in normal ingestion**

Extend the existing kind check:

```rust
"jpg" | "jpeg" | "jfif" | "png" | "gif" | "webp" => Ok(IngestKind::Image),
```

`inspect_image` determines JPEG from bytes and `extension_for(ImageFormat::Jpeg)` stores the managed copy as `.jpg`; `original_name` retains `.jfif`. Add an ingestion test with JPEG bytes saved under a `.jfif` source name.

- [ ] **Step 6: Implement idempotent execution and reporting**

Create/reuse classification paths shallowest-first with case-insensitive sibling matching. Ingest each image using one plan batch UUID, `LegacyLakomics`, source URL, custom title, and file modification time. Set `replace_duplicate_metadata: true` so reruns converge.

For `customTitle`, add an internal optional ingestion title used only when explicitly supplied by a trusted caller; duplicate enrichment may update title but ordinary direct ingestion passes null.

Return a report containing totals for planned, added, exact duplicate, review pending, failed, metadata matched, unclassified, folders created/reused, and warnings. Continue after per-image failures.

- [ ] **Step 7: Run parser, JFIF, and migration execution tests**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::legacy_migration::tests
cargo test jfif
```

Expected: PASS, including a second execution that creates no duplicate asset or folder.

- [ ] **Step 8: Commit the reusable migration engine**

```powershell
Set-Location C:\chatgpt
git add app/src-tauri/src/library/legacy_migration.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/ingestion.rs
git commit -m "feat: add legacy Lakomics migration engine"
```

---

### Task 7: One-time migration CLI, preflight, and safety report

**Files:**
- Create: `app/src-tauri/src/bin/legacy_lakomics_migrate.rs`
- Modify: `app/src-tauri/src/library/backup.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Test: `app/src-tauri/src/bin/legacy_lakomics_migrate.rs`
- Create at runtime: `C:\lakomics\save\backups\legacy-migration-YYYYMMDDTHHMMSSZ.json`

**Interfaces:**
- Consumes: Task 6 inspection/execution interfaces.
- Produces: CLI `legacy_lakomics_migrate` with `--dry-run` and `--execute` modes, plus `Library::create_pre_migration_backup(label)`.

- [ ] **Step 1: Write failing argument and dry-run tests**

Extract argument parsing into a testable function and assert:

```rust
assert_eq!(parse_args(valid_args_with("--dry-run")).unwrap().mode, Mode::DryRun);
assert!(parse_args(args_with_both_modes()).is_err());
assert!(parse_args(args_without_snapshot()).is_err());
```

Dry-run tests must assert no SQLite database, asset, thumbnail, classification, or backup changes occur.

- [ ] **Step 2: Add an explicit verified pre-migration backup interface**

Reuse `backup::create_verified_snapshot` behind:

```rust
pub fn create_pre_migration_backup(&self, label: &str) -> Result<MetadataBackup, LibraryError>
```

Sanitize the label to a fixed safe value owned by the caller (`legacy-lakomics` in this CLI). Test that the snapshot opens, passes integrity checks, and appears as `BackupKind::PreMigration`.

- [ ] **Step 3: Implement explicit CLI modes**

Required arguments:

```text
--library LIBRARY_PATH
--legacy-root LEGACY_IMAGE_PATH
--primary-metadata PRIMARY_JSON_PATH
--fallback-metadata FALLBACK_JSON_PATH
--dry-run | --execute
```

Do not add a parsing dependency. Iterate `std::env::args_os`, reject duplicate/unknown arguments, canonicalize every input, and print a JSON summary to stdout.

- [ ] **Step 4: Add execution safety gates**

Execution must:

1. inspect and print the plan;
2. require the exact flag `--execute`;
3. open the library, naturally rejecting an active `.lakomics.lock`;
4. create and verify the pre-migration SQLite backup;
5. execute with progress every 100 images;
6. write the final JSON report inside `backups`;
7. return a nonzero exit code when any image failed.

The CLI never deletes or rewrites legacy images or either metadata JSON.

- [ ] **Step 5: Run CLI tests and a disposable-library acceptance test**

Implement the CLI integration test with `tempfile::tempdir()` so it creates its own source directory, two snapshot files, and disposable library. Then run:

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test --bin legacy_lakomics_migrate
```

Expected: PASS; the test's disposable source fixture hash manifest is unchanged and a verified pre-migration backup/report exists before the temporary directory is released.

- [ ] **Step 6: Commit the one-time CLI**

```powershell
Set-Location C:\chatgpt
git add app/src-tauri/src/bin/legacy_lakomics_migrate.rs app/src-tauri/src/library/backup.rs app/src-tauri/src/library/models.rs
git commit -m "feat: add safe legacy migration command"
```

---

### Task 8: Full verification and real-library migration checkpoint

**Files:**
- Verify: `C:\chatgpt\app`
- Read-only source: `C:\lakomics\save` top-level legacy images
- Read-only metadata: `C:\lakomics\save\.lakomics\backups\metadata_latest.json`
- Read-only fallback metadata: `C:\Users\namwoojun\AppData\Roaming\com.lakomics\Lakomics\storage_metadata_backups\storage_metadata_latest.json`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified application build and, after the explicit checkpoint, the migrated current library plus report.

- [ ] **Step 1: Run complete automated verification**

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
Set-Location C:\chatgpt\app
npm run check
```

Expected: every command exits 0.

- [ ] **Step 2: Run the real-data dry run while making no library changes**

The current Lakomics app only needs to be closed before execution; dry-run inspection does not acquire the mutable library lease. Run:

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo run --bin legacy_lakomics_migrate -- `
  --library 'C:\lakomics\save' `
  --legacy-root 'C:\lakomics\save' `
  --primary-metadata 'C:\lakomics\save\.lakomics\backups\metadata_latest.json' `
  --fallback-metadata 'C:\Users\namwoojun\AppData\Roaming\com.lakomics\Lakomics\storage_metadata_backups\storage_metadata_latest.json' `
  --dry-run
```

Expected baseline from the 2026-08-15 inspection: 6,473 images, 6,459 metadata matches, 14 unclassified images, 44 JFIF images, and 60 legacy tree nodes. Differences must be explained from files changed after the inspection before execution.

- [ ] **Step 3: Record a read-only pre-migration baseline**

Record current asset/classification counts from SQLite in read-only mode and compute a SHA-256 manifest for only the 6,473 top-level legacy images. Store the manifest in a temporary directory outside `C:\lakomics\save`:

```powershell
$migrationAudit = Join-Path $env:TEMP ('lakomics-legacy-audit-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $migrationAudit | Out-Null
```

Use the migration inspector's exact planned file list to generate the manifest; do not recursively hash managed `assets` or thumbnails.

- [ ] **Step 4: Stop at the real-library mutation checkpoint**

Report the dry-run counts, current library counts, estimated copied bytes, and intended backup path. Confirm the running Lakomics process has closed and the library lock is released before executing. Do not bypass or delete the lock file.

- [ ] **Step 5: Execute the approved one-time migration**

After the checkpoint is satisfied, rerun the Task 8 Step 2 command with `--execute`. Keep the terminal session alive until the report completes; poll at intervals shorter than 60 seconds so progress remains visible.

Expected: all readable images are either added, exact duplicates, or review pending; zero source deletions and zero unexplained failures.

- [ ] **Step 6: Verify the real result**

Verify:

- post-migration asset count equals baseline plus added assets;
- direct classification links match the migration report;
- 14 no-metadata images are in the unsorted inbox unless later data changed;
- source URLs and custom titles are populated at reported counts;
- every migrated asset has `legacy_lakomics`, the shared batch ID, and original modification time;
- the pre-migration backup opens and passes `PRAGMA integrity_check`;
- the pre/post legacy source manifests are byte-for-byte identical;
- the final JSON report exists under `C:\lakomics\save\backups`.

- [ ] **Step 7: Restart the latest Live Dev app and perform visual acceptance**

Start `C:\Users\namwoojun\Desktop\Lakomics Live Dev.lnk`, open one migrated asset, and verify the additional information panel shows creator/publication values when available and provenance values for all migrated assets. Edit and save creator/publication metadata once, reopen the asset, and confirm persistence.

- [ ] **Step 8: Confirm the tracked worktree remains clean after operational verification**

```powershell
Set-Location C:\chatgpt
git status --short
```

Expected: no output. Runtime reports and migrated media stay under `C:\lakomics\save` and are not committed.
