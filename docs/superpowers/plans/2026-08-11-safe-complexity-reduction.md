# Safe Complexity Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove high-confidence dead code and duplicate implementation without changing user-visible behavior or weakening file, backup, path, and concurrency safety.

**Architecture:** Keep the existing React/Tauri/SQLite boundaries. Shrink only contracts whose values have no production reader, reuse existing shared UI utilities, and preserve all ingestion rollback, backup recovery, Windows deletion, pagination, and asynchronous coordination logic.

**Tech Stack:** React 19, TypeScript 5.8, Vitest, Tauri 2, Rust 2021, rusqlite

## Global Constraints

- Do not modify or stage `manual-skill-commands.txt` or the untracked Windows shortcut files.
- Do not change the SQLite schema or existing library data format.
- Do not remove ingestion identity checks, backup rollback hooks, Windows handle deletion, similarity resolving recovery, video interruption recovery, cursor validation, or domain locks.
- Add no dependencies; remove `@radix-ui/react-tooltip` and `hex` only after their last use is deleted.
- Preserve current visible labels, formatting, and error behavior.

---

### Task 1: Remove dead tooltip and dialog compatibility UI

**Files:**
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/shared/ui/Dialog.tsx`
- Modify: `app/src/styles/global.css`
- Modify: `app/package.json`
- Modify: `app/package-lock.json`
- Delete: `app/src/shared/ui/Tooltip.tsx`
- Delete: `app/src/shared/ui/Tooltip.test.tsx`

**Interfaces:**
- Consumes: existing `Button` accessibility contract
- Produces: the same reshuffle button with `aria-label="다시 섞기"`; `Dialog` without `closeDisabled`

- [ ] **Step 1: Record the current UI baseline**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/assets/AssetToolbar.test.tsx src/shared/ui/Dialog.test.tsx
```

- [ ] **Step 2: Remove tooltip coverage and verify the old import fails**

Delete `Tooltip.test.tsx`, remove the `Tooltip` import and wrapper from `AssetToolbar.tsx`, then run:

```powershell
npm run build
```

Expected before deleting `Tooltip.tsx`: build still succeeds; `rg Tooltip src` shows only the now-dead component.

- [ ] **Step 3: Delete the dead component, styles, dependency, and dialog option**

```tsx
{sort === "random" && !recent && <Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /></Button>}
```

Remove `closeDisabled` and its three branches; retain the opener focus restoration.

- [ ] **Step 4: Verify the focused tests and build**

```powershell
npm test -- src/assets/AssetToolbar.test.tsx src/shared/ui/Dialog.test.tsx
npm run build
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/assets/AssetToolbar.tsx app/src/shared/ui/Dialog.tsx app/src/shared/ui/Tooltip.tsx app/src/shared/ui/Tooltip.test.tsx app/src/styles/global.css app/package.json app/package-lock.json
git commit -m "refactor: remove unused tooltip stack"
```

### Task 2: Shrink frontend state and remove dead compatibility contracts

**Files:**
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/ingestion/DropOverlay.tsx`
- Modify: `app/src/ingestion/DropOverlay.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/classification/buildTree.ts`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/assets/AssetGallery.tsx`

**Interfaces:**
- Consumes: native Tauri drag events and classification entries
- Produces: boolean drop-over state and `{ roots, hasOrphans }` classification tree

- [ ] **Step 1: Change tests to the reduced contracts and verify failure**

```ts
expect(result.current.over).toBe(true);
expect(buildClassificationTree(entries).hasOrphans).toBe(true);
```

Remove tests that call legacy `onResult` or require `{x, y}` to survive after event adaptation.

```powershell
Set-Location C:\chatgpt\app
npm test -- src/ingestion/useFileDrop.test.ts src/ingestion/DropOverlay.test.tsx src/classification/ClassificationSidebar.test.tsx
```

Expected: type errors or assertion failures because the production contracts still expose coordinates and orphan arrays.

- [ ] **Step 2: Implement the minimum state changes**

```ts
export type FileDropState = {
  progress: DropProgress | null;
  over: boolean;
  works: IngestionWork[];
  retryFailed(workId: string): void;
  dismissWork(workId: string): void;
};
```

Set `over` to `true` for native `over` events and `false` for leave/drop. Return `hasOrphans: visible.size !== entries.length` from the classification tree.

- [ ] **Step 3: Delete compatibility-only props and callbacks**

Remove `FileDropResult`, `onResult`, and unused `AssetGallery` props `classifications`, `directOnly`, and `onDirectOnlyChange`.

- [ ] **Step 4: Verify focused tests and type checking**

```powershell
npm test -- src/ingestion/useFileDrop.test.ts src/ingestion/DropOverlay.test.tsx src/classification/ClassificationSidebar.test.tsx src/assets/AssetGallery.test.tsx
npm run build
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/ingestion app/src/classification app/src/assets/AssetGallery.tsx app/src/app/App.tsx
git commit -m "refactor: shrink frontend state contracts"
```

### Task 3: Remove redundant frontend tests and helpers

**Files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/layout/AppShell.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/shared/ui/useAutoDismiss.ts`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/assets/AssetViewer.test.tsx`
- Modify: `app/src/ingestion/useFileDrop.test.ts`

**Interfaces:**
- Consumes: existing DOM behavior tests and `useAutoDismiss`
- Produces: identical UI behavior with fewer change-detector and repeated fixture lines

- [ ] **Step 1: Run the affected test baseline**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/app/App.test.tsx src/layout/AppShell.test.tsx src/assets/AssetBrowser.test.tsx src/ingestion/useFileDrop.test.ts
```

- [ ] **Step 2: Replace App's duplicate timer with the shared hook**

```ts
useAutoDismiss(message, setMessage);
```

Keep `useAutoDismiss` string-focused and its fixed five-second timeout because no caller configures another type or duration.

- [ ] **Step 3: Delete implementation-detail tests**

Remove filesystem reads of CSS/config files, CSS declaration regex assertions, and legacy `showModal`/`close` shims. Keep rendered DOM and interaction assertions.

- [ ] **Step 4: Consolidate repeated drop-hook setup locally**

```ts
function dropHarness(overrides: Partial<UseFileDropOptions> = {}) {
  let drop: ((paths: string[]) => void) | undefined;
  const subscribe: DropSubscriber = async (handler) => { drop = handler; return () => undefined; };
  const hook = renderHook(() => useFileDrop({ enabled: true, subscribe, classificationId: null, ingestMedia: vi.fn(), ...overrides }));
  return { ...hook, drop: (paths: string[]) => act(() => drop?.(paths)) };
}
```

Use this helper only where it makes a test shorter; keep special subscription lifecycle cases explicit.

- [ ] **Step 5: Verify tests and build**

```powershell
npm test
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add app/src
git commit -m "test: remove redundant frontend scaffolding"
```

### Task 4: Remove unused Tauri commands and response data

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/client.test.ts`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/similarity.rs`
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/classification.rs`

**Interfaces:**
- Consumes: batch trash/classification commands and similarity UI reload behavior
- Produces: `decide_similarity_review -> ()`, similarity progress without `processed`, and no unused single-item/current-library commands

- [ ] **Step 1: Change contract tests first and verify failure**

```ts
decideSimilarityReview(request: { reviewId: string; decision: SimilarityDecision }): Promise<void>;
```

Update the similarity test mock to resolve `undefined` and remove `processed` from similarity progress fixtures.

```powershell
Set-Location C:\chatgpt\app
npm test -- src/similarity/SimilarityReviewBrowser.test.tsx src/similarity/useSimilarityIndex.test.ts src/library/client.test.ts
```

Expected: TypeScript failures until gateway and backend-facing types are reduced.

- [ ] **Step 2: Remove frontend gateway surface**

Delete `currentLibrary`, `trashAsset`, and `setAssetClassifications`; retain their batch or patch replacements.

- [ ] **Step 3: Remove backend commands and wrappers**

Delete registrations and functions for `current_library`, `trash_asset`, and `set_asset_classifications`. Remove their one-item `Library` wrappers and the `replace` branch used only by the removed classification method.

- [ ] **Step 4: Reduce similarity result models**

Change `decide_similarity_review` and `Library::decide_similarity_review` to `Result<(), _>`. Delete `SimilarityDecisionOutcome`, `SimilarityDecisionStatus`, `similarity_decision_outcome`, and `SimilarityIndexProgress.processed`.

- [ ] **Step 5: Verify frontend and Rust contracts**

```powershell
Set-Location C:\chatgpt\app
npm test
npm run build
Set-Location C:\chatgpt\app\src-tauri
cargo test
```

- [ ] **Step 6: Commit**

```powershell
git add app/src app/src-tauri/src
git commit -m "refactor: remove unused command contracts"
```

### Task 5: Shrink video, manga, and library metadata

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/manga/MangaBrowser.tsx`
- Modify: manga and app frontend tests
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/video_media.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/manga.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Consumes: existing manga cards, video preparation, and library opening behavior
- Produces: smaller serialized models with unchanged visible UI

- [ ] **Step 1: Reduce frontend fixtures and verify type failure**

```ts
export type MangaSeries = {
  id: string;
  title: string;
  author: string;
  pageCount: number;
};
```

Remove `assetCount` from `LibrarySummary` fixtures and change `retryVideoPreparation` to `Promise<void>`.

```powershell
Set-Location C:\chatgpt\app
npm run build
```

Expected: failures until the gateway and Rust serialization contract are updated.

- [ ] **Step 2: Remove dead video metadata**

Delete `VideoProbe.frame_rate`, `ProbeStream.avg_frame_rate`, `parse_fraction`, their test assertions, and fixture fields. Change retry to return `()`.

- [ ] **Step 3: Reduce manga and library summaries**

Serialize only the four manga fields used by the UI. Keep DB columns and scan bookkeeping unchanged. Remove the unused `Library` scan parameter, include series ID in the existing-row query, and delete `LibrarySummary.asset_count` plus its COUNT query.

- [ ] **Step 4: Remove impossible error variants and duplicate manga refresh flow**

Delete `InvalidMangaFolder` and `MangaThumbnail`. Share one `refreshSeries` path between initial manga loading and the refresh button while preserving unmount checks.

- [ ] **Step 5: Verify focused and full tests**

```powershell
Set-Location C:\chatgpt\app
npm test -- src/manga/MangaBrowser.test.tsx src/app/App.test.tsx src/video/useVideoPreparation.test.ts
npm run build
Set-Location C:\chatgpt\app\src-tauri
cargo test
```

- [ ] **Step 6: Commit**

```powershell
git add app/src app/src-tauri/src
git commit -m "refactor: shrink media metadata contracts"
```

### Task 6: Remove one-use dependencies and run final verification

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`
- Modify: `app/src-tauri/src/library/ingestion.rs`

**Interfaces:**
- Consumes: SHA-256 digest bytes
- Produces: the identical lowercase hexadecimal content hash without the `hex` crate

- [ ] **Step 1: Add a digest-format assertion and verify the old expression is exercised**

```rust
assert_eq!(content_hash.len(), 64);
assert!(content_hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
```

Run the existing ingestion hash test before changing production code:

```powershell
Set-Location C:\chatgpt\app\src-tauri
cargo test library::ingestion
```

- [ ] **Step 2: Replace the encoder and remove the dependency**

```rust
Ok((format!("{:x}", hasher.finalize()), byte_size))
```

Remove `hex = "0.4.3"` and regenerate `Cargo.lock` with Cargo.

- [ ] **Step 3: Run complete verification**

```powershell
Set-Location C:\chatgpt\app
npm test
npm run build
Set-Location C:\chatgpt\app\src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

- [ ] **Step 4: Inspect scope and commit**

```powershell
Set-Location C:\chatgpt
git diff --check
git status --short
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/library/ingestion.rs
git commit -m "refactor: use standard digest formatting"
```
