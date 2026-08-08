# Lakomics Daily-Use UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user explicitly prohibited subagents, so execution is inline by the primary agent only.

**Goal:** Eagle을 참고한 깔끔한 Windows 이미지 작업 공간에서 미분류 수집, 다중 선택·일괄 정리, 양방향 네이티브 드래그와 큰 이미지 감상을 안전하게 사용할 수 있게 한다.

**Architecture:** React는 보기·선택·드래그 피드백만 조립하고, SQLite 조회·원자적 일괄 변경·관리 파일 경로 해석은 Rust `Library` Module 뒤에 둔다. 기존 justified-row 가상화, 공통 UI, Tauri 네이티브 파일 드롭을 확장하며, 앱→탐색기 복사는 `drag` crate를 작은 Windows 전용 Interface 뒤에 감춘다.

**Tech Stack:** Windows 10/11, Tauri 2, React 19, TypeScript 5.8, CSS design tokens, lucide-react, TanStack Virtual, Rust stable MSVC, rusqlite 0.40.1, drag 2.1.1, Vitest, React Testing Library, Cargo tests

## Global Constraints

- 에이전트나 서브에이전트를 사용하지 않는다.
- Windows만 지원하며 Linux·macOS 조건부 구현을 추가하지 않는다.
- 앱을 열면 항상 전체 자산을 표시한다.
- JPEG·PNG·GIF·WebP만 수집한다.
- 사용자 원본과 미디어 금고 원본을 이동하거나 삭제하지 않는다.
- 앱→탐색기 드래그는 항상 복사이며 내부 해시 경로를 TypeScript에 노출하지 않는다.
- HTML5 `draggable`을 사용하지 않는다. Tauri 네이티브 파일 드롭과 충돌하지 않는 pointer 기반 내부 드래그를 사용한다.
- justified-row와 행 가상화를 유지하고 불러오지 않은 자산을 선택하지 않는다.
- shadcn, Tailwind, 외부 글꼴과 모션 라이브러리를 추가하지 않는다.
- 반복되는 색상·간격·높이·모서리·레이어는 `tokens.css`에서 의미 기반으로 관리한다.
- 버튼·메뉴·대화상자·토스트·토글은 `shared/ui` Interface를 확장해 재사용한다.
- Rust 일괄 변경은 한 트랜잭션으로 성공하거나 실패하며 UI가 SQL이나 파일 경로를 알지 않는다.
- 모든 기능 변경은 RED → GREEN → REFACTOR 순서를 따른다.
- 실제 Windows 탐색기 양방향 드래그는 자동 테스트로 대체했다고 주장하지 않는다.

## Source References

- 승인 설계: `docs/superpowers/specs/2026-08-08-lakomics-daily-use-ui-design.md`
- 도메인 언어: `CONTEXT.md`
- Module 규칙: `docs/agents/implementation.md`
- 기존 셸 설계: `docs/superpowers/specs/2026-08-01-lakomics-desktop-shell-design.md`
- Tauri drag-drop event: <https://v2.tauri.app/reference/javascript/api/namespacewebview/>
- `drag` crate 2.1.1: <https://docs.rs/drag/2.1.1/drag/>
- Windows Shell drag: <https://learn.microsoft.com/windows/win32/shell/dragdrop>

---

### Task 1: Product Identity, Tokens, and Shell

**Files:**
- Modify: `app/index.html`
- Modify: `app/package.json`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/tauri.conf.json`
- Modify: `app/src/styles/tokens.css`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/layout/AppShell.tsx`
- Modify: `app/src/layout/AppShell.test.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`

**Interfaces:**
- Keeps: existing `AppShell({ sidebar, content, status })`
- Produces: a stable four-region layout while `AssetBrowser` continues to own its stateful toolbar

- [x] **Step 1: Write failing shell and identity tests**

Add assertions that the workspace has `navigation`, `toolbar`, `main content`, and `contentinfo`, that no floating `라이브러리 안전 설정` button exists in content, and that `tauri.conf.json`/`index.html` use `Lakomics`.

```tsx
expect(screen.getByRole("navigation", { name: "라이브러리 탐색" })).toBeVisible();
expect(screen.getByRole("toolbar", { name: "자산 도구" })).toBeVisible();
expect(within(screen.getByRole("region", { name: "자산 내용" }))
  .queryByRole("button", { name: "라이브러리 안전 설정" })).not.toBeInTheDocument();
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `Set-Location app; npm.cmd test -- src/layout/AppShell.test.tsx src/app/App.test.tsx`

Expected: FAIL because the asset toolbar has no toolbar landmark and the safety button still floats above the browser.

- [x] **Step 3: Replace visual primitives without changing behavior**

Set package/product/window title to `Lakomics`. Replace orange accent tokens with a calm blue palette, add semantic tokens for elevated surfaces, selection, overlay, inspector width and drag insertion, and keep the 4px spacing scale. Mark the existing `AssetToolbar` as the toolbar landmark instead of lifting its state through `AppShell`. Keep the existing concrete-classification `이 분류만` range toggle beside the location control. Move the safety entry callback into the sidebar contract; do not move backup logic into `layout`.

```tsx
<main className="app-shell" aria-label="라이브러리 작업 공간">
  <div className="app-shell__workspace">
    {sidebar}
    <section className="app-shell__content">{content}</section>
  </div>
  {status}
</main>
```

- [x] **Step 4: Verify shell tests and builds**

Run: `Set-Location app; npm.cmd test -- src/layout src/app; npm.cmd run build`

Expected: PASS; the generated document and Tauri config both say `Lakomics`.

- [x] **Step 5: Commit the shell slice**

```powershell
git add app/index.html app/package.json app/src-tauri/Cargo.toml app/src-tauri/tauri.conf.json app/src/styles app/src/layout app/src/app
git commit -m "feat: establish Lakomics daily-use shell"
```

---

### Task 2: Unsorted Inbox and Sidebar Navigation

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Produces `AssetView` variant `{ kind: "unsorted" }`
- Adds `unclassifiedOnly: boolean` to `AssetQuery` in Rust and TypeScript
- Keeps `classificationId`, `directOnly`, `favoriteOnly` unchanged for existing callers

- [x] **Step 1: Write RED Rust query tests**

Create one normal asset with no `asset_classifications` row and one classified asset. Query with `unclassified_only: true` and assert only the first is returned. Add a cursor test proving multiple unsorted pages have no duplicates.

```rust
let page = library.list_assets(AssetQuery {
    classification_id: None,
    direct_only: false,
    favorite_only: false,
    unclassified_only: true,
    sort: AssetSort::Newest,
    random_pivot: None,
    after: None,
    limit: 100,
}).unwrap();
assert_eq!(ids(page), vec!["unclassified"]);
```

- [x] **Step 2: Run the Rust test and verify RED**

Run: `Set-Location app/src-tauri; cargo test unclassified`

Expected: FAIL because `AssetQuery` lacks `unclassified_only`.

- [x] **Step 3: Implement the unclassified filter in one SQL seam**

Add the boolean parameter to every sort query immediately after `favorite_only` and add:

```sql
AND (?4 = 0 OR NOT EXISTS (
  SELECT 1 FROM asset_classifications AS unsorted_link
  WHERE unsorted_link.asset_id = asset.id
))
```

Shift cursor/limit parameters consistently in all four SQL statements and their `statement.query` calls. Do not add a second set of unsorted SQL constants.

- [x] **Step 4: Write RED React navigation tests**

Assert sidebar order `전체 자산`, `미분류함`, `최근`, `즐겨찾기`; selecting inbox requests `unclassifiedOnly: true`; initial render always requests all assets even if UI preferences contain unrelated values; settings and trash are in the footer.

```tsx
await user.click(screen.getByRole("button", { name: "미분류함" }));
expect(gateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({
  classificationId: null,
  favoriteOnly: false,
  unclassifiedOnly: true,
}));
```

- [x] **Step 5: Implement the sidebar order and settings routing**

Add `unsorted` to `AssetView`, map it to the query flag, keep `LibraryWorkspace` initial view `{ kind: "classification", classificationId: null }`, and move `onOpenSafety` into `ClassificationSidebar`. Do not render a disabled review queue placeholder.

- [x] **Step 6: Verify Task 2**

Run:

```powershell
Set-Location app
npm.cmd test -- src/classification src/assets src/app
npm.cmd run build
Set-Location src-tauri
cargo test unclassified
```

Expected: all commands exit 0.

- [x] **Step 7: Commit the navigation slice**

```powershell
git add app/src app/src-tauri/src/library app/src-tauri/tests
git commit -m "feat: add unsorted inbox navigation"
```

---

### Task 3: Gallery Density and Loaded-Item Multi-Selection

**Files:**
- Create: `app/src/assets/selection.ts`
- Create: `app/src/assets/selection.test.ts`
- Modify: `app/src/preferences/uiPreferences.ts`
- Modify: `app/src/preferences/uiPreferences.test.ts`
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Create: `app/src/shared/ui/Slider.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Produces `SelectionState = { ids: ReadonlySet<string>; anchorId: string | null; focusId: string | null }`
- Produces `applySelectionGesture(state, orderedIds, id, { toggle, range }): SelectionState`
- Adds `thumbnailRowHeight: number` to `UiPreferences`, clamped to `96..320`, default `180`
- `AssetGallery` receives `selectedAssetIds`, `focusAssetId`, `targetRowHeight` and reports pointer/keyboard selection gestures

- [ ] **Step 1: Write exhaustive selection RED tests**

Cover plain click, Ctrl toggle, Shift range, Ctrl+Shift additive range, Ctrl+A over loaded IDs only, selection reconciliation after page refresh, and arrow movement staying inside loaded IDs.

```ts
expect(applySelectionGesture(empty, ids, "b", { toggle: false, range: false }).ids)
  .toEqual(new Set(["b"]));
expect(applySelectionGesture(from("b"), ids, "d", { toggle: false, range: true }).ids)
  .toEqual(new Set(["b", "c", "d"]));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `Set-Location app; npm.cmd test -- src/assets/selection.test.ts src/preferences/uiPreferences.test.ts`

Expected: FAIL because the Module and preference do not exist.

- [ ] **Step 3: Implement the pure selection Module and preference migration**

Keep selection calculations free of React and DOM. Read older `lakomics.uiPreferences.v1` values by filling the new height default; do not rename the storage key just for an additive field.

- [ ] **Step 4: Write gallery interaction RED tests**

Use `userEvent.keyboard("{Control>}a{/Control}")`, Ctrl/Shift clicks, Delete and Escape. Assert `aria-selected`, not `aria-pressed`, and assert that changing the slider changes row sizing without a new `listAssets` call.

- [ ] **Step 5: Wire selection and density into existing virtualization**

Pass `thumbnailRowHeight` directly to `buildJustifiedRows`; keep `@tanstack/react-virtual`, overscan 3 and next-page threshold 5. Use a roving `tabIndex` for asset tiles, explicit image dimensions, `loading="lazy"`, and do not animate GIF thumbnails.

- [ ] **Step 6: Verify Task 3**

Run: `Set-Location app; npm.cmd test -- src/assets src/preferences; npm.cmd run build`

Expected: all tests pass and list pagination tests remain unchanged.

- [ ] **Step 7: Commit the gallery slice**

```powershell
git add app/src/assets app/src/preferences app/src/shared/ui/Slider.tsx app/src/styles/global.css
git commit -m "feat: add dense multi-select asset gallery"
```

---

### Task 4: Atomic Batch Classification, Favorite, Trash, and Undo

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/library/favorite.rs`
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/shared/ui/Toast.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**

```ts
type AssetClassificationPatch = {
  assetIds: string[];
  addClassificationIds: string[];
  removeClassificationIds: string[];
};

patchAssetClassifications(patch: AssetClassificationPatch): Promise<void>;
setAssetsFavorite(assetIds: string[], favorite: boolean): Promise<void>;
trashAssets(assetIds: string[]): Promise<void>;
restoreAssets(assetIds: string[]): Promise<void>;
```

Rust exposes the same four operations on `Library`; existing single-asset methods delegate to the batch implementation to retain one rule seam.

- [ ] **Step 1: Write transaction RED tests**

Test adding one classification to two assets while retaining old classifications, removing only named classifications, rejecting unknown IDs without partial writes, bulk favorite, bulk trash, and bulk restore preserving metadata.

```rust
library.patch_asset_classifications(AssetClassificationPatch {
    asset_ids: vec!["a".into(), "b".into()],
    add_classification_ids: vec!["new-tag".into()],
    remove_classification_ids: vec![],
}).unwrap();
assert_eq!(classification_ids(&library, "a"), set!["old-tag", "new-tag"]);
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run: `Set-Location app/src-tauri; cargo test batch_`

Expected: FAIL because batch methods and request types are missing.

- [ ] **Step 3: Implement batch operations behind `Library`**

Validate non-empty, deduplicated ID lists and every referenced asset/classification before mutation. Use one SQLite transaction per call. Reuse the existing trash state transition and timestamp policy; do not loop over public single-asset methods with separate connections.

- [ ] **Step 4: Add commands and gateway methods**

Expose `patch_asset_classifications`, `set_assets_favorite`, `trash_assets`, and `restore_assets`. Keep internal paths and SQL out of serialized request/response types.

- [ ] **Step 5: Write RED toolbar and undo tests**

Assert selected count, explicit `즐겨찾기 추가/제거`, classification add/remove, one bulk trash call, and an actionable Toast whose `실행 취소` calls `restoreAssets` with the exact IDs. A failed mutation must leave all selected tiles visible.

- [ ] **Step 6: Implement batch toolbar and actionable Toast**

Extend `Toast` with optional `actionLabel`, `onAction`, and `actionDisabled`. Keep the Toast live region non-modal. Refresh the first page after a successful batch and reconcile selection against returned items.

- [ ] **Step 7: Verify Task 4**

Run:

```powershell
Set-Location app
npm.cmd test -- src/assets src/shared
npm.cmd run build
Set-Location src-tauri
cargo fmt --all --check
cargo test batch_
```

- [ ] **Step 8: Commit the batch slice**

```powershell
git add app/src app/src-tauri/src
git commit -m "feat: add atomic bulk asset actions"
```

---

### Task 5: Pointer-Based Internal Drag

**Files:**
- Create: `app/src/shared/interaction/pointerDrag.ts`
- Create: `app/src/shared/interaction/pointerDrag.test.ts`
- Create: `app/src/shared/ui/DragLayer.tsx`
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**

```ts
type InternalDragPayload =
  | { kind: "assets"; assetIds: string[] }
  | { kind: "classification"; entryId: string };

type PointerDragState =
  | { phase: "idle" }
  | { phase: "armed"; payload: InternalDragPayload; startX: number; startY: number }
  | { phase: "dragging"; payload: InternalDragPayload; x: number; y: number };
```

The pure reducer starts dragging only after a 6px threshold. React owns pointer capture and renders one shared `DragLayer`.

- [ ] **Step 1: Write pointer state RED tests**

Cover threshold, Escape/pointercancel, selected-vs-unselected asset payload, target enter/leave, and no text selection while dragging.

- [ ] **Step 2: Implement the small pointer reducer and DragLayer**

Do not use `draggable`, `dragstart`, `dataTransfer`, or a dependency. Use `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, and `document.elementFromPoint`.

- [ ] **Step 3: Write asset-to-classification RED tests**

Drag a selected tile set over a classification row, assert visual target state, release, and expect one `patchAssetClassifications` call with only `addClassificationIds`.

- [ ] **Step 4: Implement asset classification drops**

Keyboard users keep the Task 4 classification menu. Drop failure preserves selection and reports a Toast.

- [ ] **Step 5: Write classification move RED tests**

Drag a tree row onto another row and assert `moveClassification(entryId, parentId)`. Assert self/descendant targets are visually invalid and never call the gateway.

- [ ] **Step 6: Implement classification move targets**

Reuse `buildTree` ancestry data and the existing Rust cycle validation. Render a line for between-row insertion and a row highlight for child placement; map both to the existing single-parent model.

- [ ] **Step 7: Verify and commit Task 5**

Run: `Set-Location app; npm.cmd test -- src/shared/interaction src/classification src/assets src/app; npm.cmd run build`

```powershell
git add app/src/shared app/src/assets app/src/classification app/src/app app/src/styles/global.css
git commit -m "feat: add pointer-based library dragging"
```

---

### Task 6: Universal Incoming File Drop, Overlay, and Session Work Tray

**Files:**
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Create: `app/src/ingestion/DropOverlay.tsx`
- Create: `app/src/ingestion/DropOverlay.test.tsx`
- Create: `app/src/ingestion/WorkTray.tsx`
- Create: `app/src/ingestion/WorkTray.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/layout/StatusBar.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**

```ts
type NativeFileDropEvent =
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "cancel" };

type IngestionWork = {
  id: string;
  total: number;
  completed: number;
  failures: Array<{ sourcePath: string; message: string }>;
  status: "running" | "completed" | "failed";
};
```

`DropSubscriber` now passes the full union. `useFileDrop` returns `{ progress, over, works, retryFailed }`.

- [ ] **Step 1: Write native event RED tests**

Assert `subscribeToTauriDrops` translates Tauri `over`, `drop`, and `cancel`; no event is lost during React rerenders; inactive maintenance/trash/settings states ignore drops.

- [ ] **Step 2: Write destination behavior RED tests**

Drop in all-assets/recent/favorites/unsorted and expect `classificationId: null`. Drop in a concrete classification and expect that ID. Ensure FIFO batches and exact-duplicate behavior remain unchanged.

- [ ] **Step 3: Implement the full event subscription and destination rule**

Enable drops for every normal `AssetBrowser` view. Disable only trash, settings, and maintenance. The overlay says either `<분류 이름>에 저장` or `미분류함에 저장` and always lists the four accepted formats. Exact file validation happens after drop because Tauri `over` has no paths.

- [ ] **Step 4: Write overlay/work tray RED tests**

Assert full-window overlay on over, removal on cancel/drop, `aria-live` progress, one expandable work row, filename-only failure display, and retry of only failed source paths.

- [ ] **Step 5: Implement overlay and in-memory work tray**

Keep the FIFO promise chain in `useFileDrop`. Store only the current session's batches; do not add SQLite jobs in this phase. Collapse completed successful work after the Toast; retain failures until dismissed or retried.

- [ ] **Step 6: Verify and commit Task 6**

Run: `Set-Location app; npm.cmd test -- src/ingestion src/app src/layout; npm.cmd run build`

```powershell
git add app/src/ingestion app/src/app app/src/classification app/src/layout app/src/styles/global.css
git commit -m "feat: make image drops visible and universal"
```

---

### Task 7: Windows Native Drag-Out Copy

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/src/library/drag_out.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Create: `app/src/drag-out/startAssetDrag.ts`
- Create: `app/src/drag-out/startAssetDrag.test.ts`
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/styles/global.css`
- Modify: `app/README.md`

**Interfaces:**

```rust
pub struct PreparedAssetDrag {
    pub files: Vec<std::path::PathBuf>,
    pub preview: std::path::PathBuf,
    cleanup_root: std::path::PathBuf,
}

impl Library {
    pub fn prepare_asset_drag(&self, asset_ids: &[String])
        -> Result<PreparedAssetDrag, LibraryError>;
    pub fn cleanup_stale_asset_drags(&self) -> Result<(), LibraryError>;
}
```

```ts
export type StartAssetDrag = (assetIds: string[]) => Promise<void>;
```

The Tauri command is `start_asset_drag(asset_ids, window, state)`. It resolves paths in Rust and permits `drag::DragMode::Copy` only.

- [ ] **Step 1: Add `drag = "2.1.1"` only to Windows target dependencies**

Do not add the Tauri drag plugin or an npm package. The custom command is smaller and prevents arbitrary filesystem paths from crossing the frontend Interface.

- [ ] **Step 2: Write RED preparation tests**

Test normal asset validation, trash/missing rejection, one and multiple assets, original filename preservation, case-insensitive duplicate filenames receiving ` (2)`, hard-link creation with copy fallback, cleanup on drop, and cleanup of stale drag directories at library open.

```rust
let prepared = library.prepare_asset_drag(&["a".into(), "b".into()]).unwrap();
assert_eq!(file_names(&prepared.files), vec!["image.png", "image (2).png"]);
assert!(prepared.files.iter().all(|path| path.exists()));
drop(prepared);
assert!(!drag_staging_root.exists());
```

- [ ] **Step 3: Implement safe staging in `library/drag_out.rs`**

Create a UUID directory under a library-owned `.drag-out` root. Resolve only `status = 'normal'` asset and thumbnail relative paths, canonicalize them under the library root, create original-name hard links, and fall back to `std::fs::copy` only when hard links fail. `Drop` removes only its exact UUID directory. Library open removes stale children under `.drag-out` after validating the resolved parent.

- [ ] **Step 4: Write RED command tests around path secrecy and copy mode**

Keep `PreparedAssetDrag` fields non-serializable. Add stable `asset_drag_failed` and `invalid_asset_selection` errors without internal paths in `CommandError.message`.

- [ ] **Step 5: Implement `start_asset_drag` on the Tauri main thread**

Resolve the prepared files first, then call:

```rust
drag::start_drag(
    &window,
    drag::DragItem::Files(prepared.files.clone()),
    drag::Image::File(prepared.preview.clone()),
    move |_result, _cursor| drop(prepared),
    drag::Options { mode: drag::DragMode::Copy, ..Default::default() },
)
```

Return command setup failures; completion/cancel cleanup happens in the callback. Never accept a path from TypeScript.

- [ ] **Step 6: Write frontend RED tests**

Mock only `StartAssetDrag`. Assert leaving the viewport during an armed asset pointer drag passes selected IDs, an unselected tile passes only its own ID, Escape does not start native drag, and failures appear in the work tray.

- [ ] **Step 7: Connect pointer exit to the native command**

Create a small `startAssetDrag` adapter that invokes `start_asset_drag`. The internal pointer drag remains active inside the viewport for sidebar classification; crossing the viewport boundary promotes the same payload to native drag-out exactly once.

- [ ] **Step 8: Run automated verification**

```powershell
Set-Location app
npm.cmd test -- src/drag-out src/assets src/app
npm.cmd run build
Set-Location src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test drag_out
```

- [ ] **Step 9: Run mandatory Windows Explorer acceptance**

Use an isolated test library and verify:

1. one selected PNG dragged to Explorer appears with its original name;
2. two selected files appear together;
3. duplicate original names receive a stable suffix;
4. cancel leaves no `.drag-out/<uuid>` directory;
5. successful drop leaves the managed assets untouched;
6. restart removes a deliberately left stale staging directory.

Record exact paths and results in `app/README.md`. If any boundary fails, keep Task 7 incomplete and debug the native seam; do not substitute a folder picker.

- [ ] **Step 10: Commit the native drag slice**

```powershell
git add app/src-tauri app/src/drag-out app/src/assets app/src/app app/src/styles/global.css app/README.md
git commit -m "feat: copy selected assets by native drag"
```

---

### Task 8: Full-Screen Viewer and Collapsible Inspector

**Files:**
- Create: `app/src/assets/AssetViewer.tsx`
- Create: `app/src/assets/AssetViewer.test.tsx`
- Create: `app/src/assets/AssetInspector.tsx`
- Create: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Remove: `app/src/assets/AssetDetailDialog.tsx`
- Remove: `app/src/assets/AssetDetailDialog.test.tsx`
- Modify: `app/src/shared/ui/Dialog.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- `AssetViewer({ items, activeId, onActiveIdChange, onClose })`
- `AssetInspector({ assets, classifications, open, onOpenChange, onPatchClassifications })`
- Viewer navigation is limited to the currently loaded ordered `items`

- [ ] **Step 1: Write viewer RED tests**

Assert double-click/Enter opens, left/right changes active ID, Escape closes, boundary keys do not wrap, GIF uses the original asset URL, ordinary images use the original asset URL only after open, and focus returns to the source tile.

- [ ] **Step 2: Implement viewer by replacing the old detail dialog**

Use the existing native `Dialog` Interface with a fullscreen variant; do not create a second focus-trap implementation. Show a contained image, compact controls and no always-visible metadata card.

- [ ] **Step 3: Write inspector RED tests**

Assert default closed, one-asset metadata, multi-selection summary, source link opening through the existing opener path, and classification add/remove using Task 4's batch Interface.

- [ ] **Step 4: Implement the collapsible inspector**

Keep inspector state in `AssetBrowser`; use CSS grid to reserve width only while open. At narrow widths, render it as an overlay panel instead of shrinking the gallery below its minimum width.

- [ ] **Step 5: Verify and commit Task 8**

Run: `Set-Location app; npm.cmd test -- src/assets src/shared; npm.cmd run build`

```powershell
git add app/src/assets app/src/shared/ui/Dialog.tsx app/src/styles/global.css
git commit -m "feat: add focused asset viewing workspace"
```

---

### Task 9: Whole-Slice Verification and User Visual Approval

**Files:**
- Modify: `app/README.md`
- Modify: `docs/superpowers/plans/2026-08-08-lakomics-daily-use-ui.md` only to mark completed checkboxes and record evidence

**Interfaces:**
- Consumes: Tasks 1–8
- Produces: reproducible automated, Windows-native, performance, accessibility and visual evidence

- [ ] **Step 1: Run the full automated suite**

```powershell
Set-Location app
npm.cmd test
npm.cmd run build
Set-Location src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
Set-Location ..
npm.cmd run tauri build -- --debug --no-bundle
```

Expected: every command exits 0 and `app/src-tauri/target/debug/app.exe` exists.

- [ ] **Step 2: Run the Windows interaction matrix**

With an isolated library, verify all-assets startup, classified and unsorted incoming drop, unsupported file failure, exact duplicate, multi-selection, batch tag add/remove, favorite, trash/undo, asset-to-sidebar drag, classification move, single/multi drag-out, viewer keys, GIF behavior, settings, trash and backup entry.

- [ ] **Step 3: Run layout and accessibility checks**

Capture 1440×900 and 900×650 screenshots. Confirm no horizontal overflow, no clipped toolbar actions, visible focus, named icon buttons, live progress, reduced-motion behavior and no raw unstyled native control that conflicts with the common UI language.

- [ ] **Step 4: Verify performance boundaries**

Use generated metadata fixtures to load enough pages to exercise 5만 장 pagination semantics without creating 5만 full media files. Confirm DOM tile count remains bounded by virtual rows, density changes do not trigger DB calls, and selection operations scale with loaded IDs only.

- [ ] **Step 5: Present the running UI to the user**

Show the actual application at normal and narrow sizes. Ask for visual approval. UI quality is incomplete until the user approves; record requested changes in this plan and re-run affected checks.

- [ ] **Step 6: Update README and commit verification evidence**

Document current formats, startup view, selection keys, incoming/outgoing drag copy semantics, session-only work tray and deferred features.

```powershell
git add app/README.md docs/superpowers/plans/2026-08-08-lakomics-daily-use-ui.md
git commit -m "docs: verify Lakomics daily-use UI"
```

---

## Self-Review

- **Spec coverage:** Tasks 1–9 cover the approved shell, sidebar, all-assets startup, unsorted inbox, density, loaded-item selection, batch actions, internal drag, universal incoming drop, work tray, native drag-out, viewer, inspector, keyboard, performance and user approval. Similar-image review and review-queue UI remain in the next independent plan as approved.
- **Module depth:** React never receives a managed asset path. Rust owns SQL transactions, safe path resolution, original-name staging and copy-only native drag. Selection and pointer drag are pure Modules with small Interfaces.
- **YAGNI:** No shadcn/Tailwind, no persistent background job schema, no disabled review placeholder, no folder recursion, no new search or media formats, and no generic Adapter without two real callers.
- **Data safety:** Batch writes are transactional, drag-out stages aliases without moving originals, cleanup targets a validated UUID directory, and native copy mode is mandatory.
- **Type consistency:** `unclassifiedOnly`, `AssetClassificationPatch`, the four batch gateway methods, `SelectionState`, `InternalDragPayload`, `NativeFileDropEvent`, `IngestionWork`, and `StartAssetDrag` use the same names at their producing and consuming tasks.
- **Verification:** Each task has focused RED/GREEN commands and a commit. Task 9 repeats full frontend, Rust, Clippy, Tauri, native Windows, performance, accessibility and visual checks.
