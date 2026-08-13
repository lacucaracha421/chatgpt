# Extension Metadata Folder Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repeatable Settings workflow that reads a `lakomics-x-metadata` v3 export folder, creates its complete classification hierarchy, imports present images with JSON metadata, and reports partial failures without changing the source folder.

**Architecture:** A deep Rust `metadata_import` module validates untrusted export data and returns a format-neutral plan. An app-level React hook resolves classification paths through existing gateway methods and feeds each planned image through the existing ingestion path, while WorkTray owns durable progress and retry UI.

**Tech Stack:** Rust, serde/serde_json, chrono, url, Tauri 2 commands, React 19, TypeScript, Vitest, Testing Library, SQLite/rusqlite

## Global Constraints

- Support only `format: "lakomics-x-metadata"`, `version: 3`.
- Treat JSON and filenames as untrusted input; media must resolve to direct children of the selected folder.
- Never fetch remote media or write, move, rename, or delete anything in the selected export folder.
- Create every path from `tagLayout` and every item `tagPath`, including empty and missing-image paths.
- Reuse exact case-insensitive sibling paths; never move or rename an existing classification.
- Keep one direct classification per asset: the deepest `tagPath` entry.
- Preserve `tweetUrl` as source URL and `savedAt` as collected time.
- Metadata import exact duplicates replace classification, source URL, and collected time only; ordinary ingestion behavior stays unchanged.
- Continue after item-level failures and retry by rerunning the entire folder.
- Do not add dependencies; `chrono` and `url` are already present.

---

### Task 1: Versioned Metadata Import Plan Module

**Files:**
- Create: `app/src-tauri/src/library/metadata_import.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: a selected export folder path
- Produces: `MetadataImportPlan { metadata_file, classification_paths, items, skipped }`
- Produces command: `inspect_metadata_import(folder: String) -> Result<MetadataImportPlan, CommandError>`

- [ ] **Step 1: Write failing parser tests**

In `metadata_import.rs`, add fixture helpers that write a synthetic v3 manifest and direct-child image files. Add tests whose hand-checked assertions cover:

```rust
assert_eq!(plan.classification_paths, vec![
    vec!["게임".into()],
    vec!["게임".into(), "블아".into()],
    vec!["기타".into()],
    vec!["기타".into(), "밈".into()], // unused layout tag
]);
assert_eq!(plan.items[0].classification_path, vec!["게임", "블아"]);
assert_eq!(plan.items[0].source_url, "https://x.com/example/status/1");
assert_eq!(plan.items[0].collected_at, "2026-08-10T10:47:04.409Z");
assert_eq!(plan.skipped[0].reason, MetadataImportSkipReason::MissingFile);
```

Add separate tests for zero and two matching manifests, unsupported version, duplicate filenames, `../escape.jpg`, `sub/image.jpg`, empty tag segments, invalid X post URL, invalid RFC3339 timestamp, deterministic shallow-first path order, 16 MiB manifest limit, and 100,000-item limit. Assert fatal cases return before any plan is produced; invalid URL/time and missing media become skipped entries.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `cargo test metadata_import --lib`

Expected: FAIL because `metadata_import` and its plan types do not exist.

- [ ] **Step 3: Implement the normalized plan**

Use these public shapes in `metadata_import.rs`:

```rust
pub const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_METADATA_ITEMS: usize = 100_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataImportPlan {
    pub metadata_file: String,
    pub classification_paths: Vec<Vec<String>>,
    pub items: Vec<MetadataImportItem>,
    pub skipped: Vec<MetadataImportSkipped>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataImportItem {
    pub file_name: String,
    pub source_path: PathBuf,
    pub classification_path: Vec<String>,
    pub source_url: String,
    pub collected_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataImportSkipped {
    pub file_name: String,
    pub reason: MetadataImportSkipReason,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetadataImportSkipReason {
    MissingFile,
    InvalidSourceUrl,
    InvalidCollectedAt,
}
```

Keep v3 serde structs private. Discover only direct-child files matching `lakomics-x-metadata*.json`, require exactly one, check size before `read_to_string`, then deserialize. Build a `BTreeSet<Vec<String>>` from layout primary/secondary names plus every parsed `tagPath`; sort by depth and case-insensitive joined path. Validate a filename as exactly one `Component::Normal`, reject duplicates case-insensitively, canonicalize present files, and require their canonical paths to remain below the canonical selected folder. Validate `tweetUrl` with `url::Url`, requiring `https` and host `x.com` or `twitter.com`; validate `savedAt` with `chrono::DateTime::parse_from_rfc3339`.

Add explicit `LibraryError` variants and stable command codes:

```rust
MetadataImportManifestCount,
UnsupportedMetadataImport,
InvalidMetadataImport,
MetadataImportTooLarge,
UnsafeMetadataImportPath,
ReadMetadataImport { source: std::io::Error },
```

Do not include selected filesystem paths in public messages.

- [ ] **Step 4: Expose one Tauri command**

Export `pub mod metadata_import` from `library/mod.rs`, import `MetadataImportPlan` in `commands.rs`, add:

```rust
#[tauri::command]
pub async fn inspect_metadata_import(folder: String) -> Result<MetadataImportPlan, CommandError> {
    tauri::async_runtime::spawn_blocking(move || metadata_import::inspect(Path::new(&folder)))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}
```

Register it in `lib.rs`. This command performs no library mutation.

- [ ] **Step 5: Run focused Rust tests and verify GREEN**

Run: `cargo test metadata_import --lib && cargo test command_error_has_stable_json_fields --lib`

Expected: PASS with every parser and public-error assertion green.

- [ ] **Step 6: Commit the plan module**

```powershell
git add app/src-tauri/src/library/metadata_import.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/error.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat: inspect extension metadata exports"
```

### Task 2: Timestamp Preservation and Exact-Duplicate Enrichment

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/extension_api.rs`

**Interfaces:**
- Consumes: `IngestMediaRequest.collected_at: Option<String>` and `replace_duplicate_metadata: bool`
- Produces: exact-duplicate outcome with `classification_changed` and `metadata_changed`

- [ ] **Step 1: Write failing ingestion tests**

Add tests proving:

```rust
let first = fixture.ingest("same.jpg", None, None, false);
fixture.library.set_asset_favorite(&first_id, true).unwrap();
let duplicate = fixture.ingest(
    "same-copy.jpg",
    Some("https://x.com/example/status/2"),
    Some("2026-08-10T10:47:04.409Z"),
    true,
);
assert!(matches!(duplicate, IngestOutcome::ExactDuplicate {
    metadata_changed: true, ..
}));
assert_eq!(fixture.asset(&first_id).source_url.as_deref(), Some("https://x.com/example/status/2"));
assert_eq!(fixture.asset(&first_id).collected_at, "2026-08-10T10:47:04.409Z");
assert!(fixture.asset(&first_id).favorite);
```

Also assert a newly added asset uses the supplied timestamp, an invalid supplied timestamp is rejected, and an ordinary duplicate with `replace_duplicate_metadata: false` retains its old source and time.

- [ ] **Step 2: Run focused ingestion tests and verify RED**

Run: `cargo test ingestion::tests --lib`

Expected: FAIL because the request and outcome fields are absent.

- [ ] **Step 3: Implement minimal ingestion changes**

Change `IngestMediaRequest` to:

```rust
pub struct IngestMediaRequest {
    pub source_path: PathBuf,
    pub classification_id: Option<String>,
    pub source_url: Option<String>,
    pub collected_at: Option<String>,
    #[serde(default)]
    pub replace_duplicate_metadata: bool,
}
```

Normalize a supplied timestamp once at the start with `DateTime::parse_from_rfc3339`; otherwise use `Utc::now()`. Use it for new image and video assets. For exact duplicates, keep current classification replacement behavior and, only when the flag is true, update `assets.source_url` and `assets.collected_at` in SQLite without touching favorite/title/media fields. Return whether either persisted value changed via `metadata_changed`.

Add `LibraryError::InvalidCollectedAt` with public code `invalid_collected_at`; this protects the Tauri command seam even though metadata plans already validate timestamps.

Update every Rust request literal, including extension API requests, to pass `collected_at: None` and `replace_duplicate_metadata: false` so existing paths remain explicit and unchanged.

- [ ] **Step 4: Run ingestion and extension tests and verify GREEN**

Run: `cargo test ingestion::tests --lib && cargo test extension_api --lib`

Expected: PASS; live extension exact duplicates retain existing behavior.

- [ ] **Step 5: Commit ingestion metadata support**

```powershell
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/src/extension_api.rs
git commit -m "feat: preserve imported asset metadata"
```

### Task 3: Frontend Contracts and Classification Path Resolution

**Files:**
- Create: `app/src/metadata-import/classificationPaths.ts`
- Create: `app/src/metadata-import/classificationPaths.test.ts`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/classification/ClassificationAppearanceDialog.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/library/LibrarySetup.test.tsx`
- Modify: `app/src/manga/MangaBrowser.test.tsx`
- Modify: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`

**Interfaces:**
- Consumes: `MetadataImportPlan` from Task 1 and existing classification gateway methods
- Produces: `ensureClassificationPaths(paths, existing, create) -> { byPath, created, reused, entries }`

- [ ] **Step 1: Add failing pure resolver tests**

Test exact behavior with real `ClassificationEntry` values and a small fake creator:

```ts
const result = await ensureClassificationPaths(
  [["게임"], ["게임", "블아"], ["기타", "블아"]],
  [{ id: "games", kind: "root", name: "게임", parentId: null, iconKey: null, colorKey: null }],
  create,
);
expect(result.created).toBe(3);
expect(result.reused).toBe(1);
expect(result.byPath.get(pathKey(["게임", "블아"]))).toBe("created-games-blue");
expect(result.byPath.get(pathKey(["기타", "블아"]))).toBe("created-etc-blue");
```

Add tests that reuse `게임 > 블아` case-insensitively, preserve an existing `work` child, and never reuse same-named `블아` under another root.

- [ ] **Step 2: Run resolver test and verify RED**

Run: `npm.cmd test -- src/metadata-import/classificationPaths.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add shared TypeScript contracts**

Add to `library/types.ts`:

```ts
export type MetadataImportPlan = {
  metadataFile: string;
  classificationPaths: string[][];
  items: Array<{ fileName: string; sourcePath: string; classificationPath: string[]; sourceUrl: string; collectedAt: string }>;
  skipped: Array<{ fileName: string; reason: "missing_file" | "invalid_source_url" | "invalid_collected_at" }>;
};
```

Extend `IngestMediaInput` with `collectedAt: string | null` and `replaceDuplicateMetadata: boolean`; extend exact-duplicate outcome with `metadataChanged: boolean`; add `inspectMetadataImport(folder: string)` to `LibraryGateway` and `client.ts`. Update all existing callers to pass `null` and `false`, and update test gateway fakes with `inspectMetadataImport: vi.fn()`.

- [ ] **Step 4: Implement the pure path resolver**

Use a stable key made from case-folded segments joined with a delimiter that cannot be confused with path display. Walk required paths shallow-first. Match siblings by `parentId` and `name.toLocaleLowerCase()`. Create missing top-level entries as `root` and descendants as `tag`, append returned entries to the local list, and return counts plus the deepest ID for every exact path.

- [ ] **Step 5: Run focused frontend tests and type build**

Run: `npm.cmd test -- src/metadata-import/classificationPaths.test.ts src/library/client.test.ts && npm.cmd run build`

Expected: PASS with no missing gateway methods or request fields.

- [ ] **Step 6: Commit contracts and resolver**

```powershell
git add app/src/metadata-import/classificationPaths.ts app/src/metadata-import/classificationPaths.test.ts app/src/library/types.ts app/src/library/client.ts app/src/ingestion/useFileDrop.ts app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/classification/ClassificationAppearanceDialog.test.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/library/LibrarySetup.test.tsx app/src/manga/MangaBrowser.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git commit -m "feat: resolve metadata classification paths"
```

### Task 4: Durable Metadata Import Work Module and WorkTray Results

**Files:**
- Create: `app/src/metadata-import/useMetadataImport.ts`
- Create: `app/src/metadata-import/useMetadataImport.test.ts`
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/WorkTray.tsx`
- Modify: `app/src/ingestion/WorkTray.test.tsx`

**Interfaces:**
- Consumes: metadata plan inspection, path resolution, ingestion gateway
- Produces: `MetadataImportState { running, work, start, retry, dismiss }`

- [ ] **Step 1: Write failing hook tests**

Use a real rendered test fixture around the hook and gateway fakes. Cover:

- preflight runs before any `createClassification` or `ingestMedia` call;
- paths are created before the first image;
- each image receives deepest classification ID, `sourceUrl`, `collectedAt`, and `replaceDuplicateMetadata: true`;
- skipped entries are present before processing starts;
- added, duplicate-enriched, pending-review, and failure counters update;
- a second `start` while running is ignored;
- retry invokes inspection for the same folder and reruns the whole plan;
- callbacks fire for sidebar refresh, asset refresh, and review-count refresh.

- [ ] **Step 2: Run hook tests and verify RED**

Run: `npm.cmd test -- src/metadata-import/useMetadataImport.test.ts`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Generalize the work result shape minimally**

Extend `IngestionWork.kind` with `"metadata_import"` and add defaulted fields:

```ts
foldersCreated: number;
pathsReused: number;
duplicatesEnriched: number;
skipped: Array<{ fileName: string; message: string }>;
sourceFolder: string | null;
```

Update every existing work constructor with zero/empty/null values. Do not create a second tray model.

- [ ] **Step 4: Implement `useMetadataImport`**

Expose:

```ts
export function useMetadataImport(options: {
  gateway: LibraryGateway;
  onClassificationsChanged(): Promise<void>;
  onIngested(result: IngestOutcome): void;
}): {
  running: boolean;
  work: IngestionWork | null;
  start(folder: string): Promise<boolean>;
  retry(): void;
  dismiss(): void;
}
```

`start` returns `false` on fatal preflight failure after creating a failed work result, and `true` once a valid plan begins. Keep the selected folder in a ref for retry. Sequentially ingest items, catch errors per item, and update immutable work snapshots. A run with item failures has `status: "failed"`; skipped-only completion remains `completed` because skipped reasons are expected plan results.

- [ ] **Step 5: Extend WorkTray rendering tests and implementation**

For running metadata work, render `메타데이터 가져오는 중 N / M`. For completion render folder-created/reused, added, duplicates, enriched duplicates, pending review, skipped, and failures. Label the retry button `같은 폴더 다시 가져오기`. Keep existing ingestion and preparation output unchanged.

- [ ] **Step 6: Run hook and WorkTray tests and verify GREEN**

Run: `npm.cmd test -- src/metadata-import/useMetadataImport.test.ts src/ingestion/WorkTray.test.tsx src/ingestion/useFileDrop.test.ts`

Expected: PASS with existing work kinds unchanged.

- [ ] **Step 7: Commit durable work handling**

```powershell
git add app/src/metadata-import/useMetadataImport.ts app/src/metadata-import/useMetadataImport.test.ts app/src/ingestion
git commit -m "feat: run metadata folder imports"
```

### Task 5: Settings UI and Last-Folder Preference

**Files:**
- Modify: `app/src/preferences/uiPreferences.ts`
- Modify: `app/src/preferences/uiPreferences.test.ts`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes props: `metadataImportRunning`, `lastMetadataImportFolder`, `onMetadataImportFolder`
- Produces selected folder via existing Tauri directory picker

- [ ] **Step 1: Write failing preference and Settings tests**

Assert the default and malformed-storage fallback use `lastMetadataImportFolder: null`, while a stored string is preserved. In Settings tests, navigate to `메타데이터 가져오기`, choose `C:\Exports`, and assert `onMetadataImportFolder("C:\Exports")`. Cover picker cancellation, remembered path display, `최근 폴더 다시 가져오기`, `다른 폴더 선택`, and disabled buttons while running.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd test -- src/preferences/uiPreferences.test.ts src/settings/SettingsView.test.tsx`

Expected: FAIL because the preference and section do not exist.

- [ ] **Step 3: Implement preference compatibility**

Add `lastMetadataImportFolder: string | null` to `UiPreferences` and its default. Load only non-empty strings; otherwise return `null`. Keep the existing storage key so old saved preferences migrate through tolerant field loading without a separate migration.

- [ ] **Step 4: Implement the compact Settings section**

Add `"metadata_import"` to the local section union and a `메타데이터 가져오기` navigation button after `브라우저 확장`. Use the existing field/list surface styles, not a card. Show explanatory copy, the last path when present, and the approved buttons. `chooseMetadataFolder` calls `open({ directory: true, multiple: false })`; a valid string is passed directly to `onMetadataImportFolder`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm.cmd test -- src/preferences/uiPreferences.test.ts src/settings/SettingsView.test.tsx`

Expected: PASS, including existing manga picker and backup behavior.

- [ ] **Step 6: Commit Settings UI**

```powershell
git add app/src/preferences app/src/settings app/src/styles/global.css
git commit -m "feat: add metadata import settings"
```

### Task 6: App Integration and Refresh Semantics

**Files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: `useMetadataImport`, Settings callbacks, WorkTray work
- Produces: persistent import across Settings section changes and refreshes affected library views

- [ ] **Step 1: Write failing App integration tests**

Add a test that opens Settings, selects the metadata section and folder, supplies a plan, and verifies:

```ts
expect(gateway.inspectMetadataImport).toHaveBeenCalledWith("C:\\Exports");
expect(gateway.createClassification).toHaveBeenCalled();
expect(gateway.ingestMedia).toHaveBeenCalledWith(expect.objectContaining({
  collectedAt: "2026-08-10T10:47:04.409Z",
  replaceDuplicateMetadata: true,
}));
expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY)!)).toEqual(
  expect.objectContaining({ lastMetadataImportFolder: "C:\\Exports" }),
);
```

Also assert an invalid preflight does not remember the folder, a successful import refreshes classifications/assets, and WorkTray retry routes to metadata import before file-drop retry.

- [ ] **Step 2: Run App tests and verify RED**

Run: `npm.cmd test -- src/app/App.test.tsx`

Expected: FAIL because App has no metadata import state.

- [ ] **Step 3: Wire the hook once at app scope**

Instantiate `useMetadataImport` beside `useFileDrop`. Pass `refreshClassifications` and existing `handleIngested`. On a `true` return from `start(folder)`, update `lastMetadataImportFolder`. Pass state and start callback to Settings. Add metadata work to the WorkTray list. Route retry/dismiss by work ID before falling back to existing work handlers. Keep metadata work alive when the Settings section changes or Settings closes.

- [ ] **Step 4: Run App tests and full frontend check**

Run: `npm.cmd test -- src/app/App.test.tsx && npm.cmd run check`

Expected: all frontend tests and production build PASS.

- [ ] **Step 5: Commit app integration**

```powershell
git add app/src/app/App.tsx app/src/app/App.test.tsx
git commit -m "feat: integrate metadata imports"
```

### Task 7: End-to-End Verification With Read-Only Real Export

**Files:**
- Modify only if required by discovered defects: files already listed in Tasks 1-6
- Verify: `C:\Users\namwoojun\Desktop\lako_image`

**Interfaces:**
- Consumes: completed feature and a disposable Lakomics library
- Produces: evidence that the real export plans 121 present and 6 missing items without source mutation

- [ ] **Step 1: Run fresh automated verification**

Run from `app/src-tauri`:

```powershell
cargo test
```

Run from `app`:

```powershell
npm.cmd run check
```

Expected: all Rust and frontend tests pass; TypeScript and Vite build succeed.

- [ ] **Step 2: Snapshot source hashes before acceptance**

Use a read-only PowerShell command to record SHA-256 hashes for every file under `C:\Users\namwoojun\Desktop\lako_image` into a temporary file outside the source folder. Record counts by extension. Do not modify the source folder.

- [ ] **Step 3: Exercise the real folder against a disposable library**

Launch the Tauri app with a new temporary library, open Settings → `메타데이터 가져오기`, select `C:\Users\namwoojun\Desktop\lako_image`, and wait for completion. Verify the result reports 121 present items and 6 missing items; inspect `리버스`, `게임 > 블아`, `만화 > 백합`, and unused empty layout folders such as `기타 > 밈`. Run `최근 폴더 다시 가져오기` and verify no duplicate folders or assets appear and exact duplicates are reported.

- [ ] **Step 4: Verify source immutability**

Recompute source hashes and compare them to the pre-import snapshot. Expected: identical file paths, sizes, and SHA-256 values with no new or removed files.

- [ ] **Step 5: Inspect final repository state**

Run:

```powershell
git diff --check
git status --short
git log --oneline -8
```

Expected: no whitespace errors or uncommitted product changes; only the planned commits are present.
