# Lakomics Sidebar Folder UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lakomics classification management feel like an Eagle-style folder tree and prevent X from opening an image after a radial collection drag.

**Architecture:** Keep the existing classification database, gateway methods, controlled expanded state, shared context menu, and pointer-drag move path. Replace create/rename dialogs with one inline editor state owned by `ClassificationSidebar`, keep move/delete in shared dialogs, and add a tiny one-shot click suppressor to the extension content script.

**Tech Stack:** React 19, TypeScript, Radix context menu, Testing Library/Vitest, Chromium Manifest V3 content script, Node test runner.

## Global Constraints

- User-facing classification entries are labelled as folders; internal `root`, `work`, and `tag` types remain unchanged.
- A top-level folder is created as `root`; a child folder is created as `tag`.
- The extension remains read-only for classification editing.
- Use existing gateway methods, common UI components, CSS tokens, and pointer-drag infrastructure; add no dependencies or database migrations.
- `Ctrl+Shift+N` creates a top-level folder, `Alt+N` creates a child, `F2` renames, and `Delete` opens delete confirmation.
- Inline editing saves with `Enter`, cancels with `Escape`, and retains the editor when validation or the gateway fails.
- Only a gesture that crossed the 12px donut threshold suppresses its first follow-up click.

---

### Task 1: Folder-style classification commands and inline editing

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: existing `LibraryGateway.createClassification`, `renameClassification`, `moveClassification`, and `deleteClassification` methods.
- Produces: inline `InlineEdit` state, `openTopLevelCreate()`, `openChildCreate(entry)`, `openRename(entry)`, and the existing controlled `onChanged()` refresh callback.

- [ ] **Step 1: Write failing tests for folder creation and inline editing**

  Add Testing Library cases that right-click the blank tree region and choose `새 폴더`, right-click `Games` and choose `하위 폴더 만들기`, then assert inline textbox behavior and literal gateway requests:

  ```tsx
  expect(gateway.createClassification).toHaveBeenCalledWith({
    kind: "root", name: "Comics", parentId: null,
  });
  expect(gateway.createClassification).toHaveBeenCalledWith({
    kind: "tag", name: "Characters", parentId: "root",
  });
  ```

  Add rename cases for `F2`, `Enter`, and `Escape`, and assert no rename request is sent after cancellation.

- [ ] **Step 2: Run the sidebar test and verify RED**

  Run: `npm test -- --run app/src/classification/ClassificationSidebar.test.tsx` from `app`.

  Expected: FAIL because the folder menu labels and inline textbox do not exist.

- [ ] **Step 3: Implement the minimal shared command paths and inline editor**

  Replace create/rename dialog state with:

  ```tsx
  type InlineEdit =
    | { type: "create"; parentId: string | null; kind: "root" | "tag" }
    | { type: "rename"; entry: ClassificationEntry };
  ```

  Use a shared `InlineFolderEditor` inside the tree. Top-level creation passes `kind: "root"`; child creation passes `kind: "tag"` and expands the parent. Keep move/delete dialogs and use the existing `ContextMenu`, `Menu`, `Button`, `Select`, and `Toast` components. Add only token-based CSS for the input and inline error.

- [ ] **Step 4: Run the sidebar test and verify GREEN**

  Run: `npm test -- --run app/src/classification/ClassificationSidebar.test.tsx` from `app`.

  Expected: PASS.

- [ ] **Step 5: Commit the folder creation and inline editing change**

  ```powershell
  git add -- app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/styles/global.css
  git commit -m "feat: add folder-style classification editing"
  ```

### Task 2: Folder move/delete safety and keyboard commands

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`

**Interfaces:**
- Consumes: Task 1 command functions and existing controlled tree focus/expansion.
- Produces: one keyboard handler that routes to the same create, rename, move, and delete commands as menus; `moveParents(entry, entries)` without self or descendant targets.

- [ ] **Step 1: Write failing tests for shortcuts, safe move targets, and delete failures**

  Assert `Ctrl+Shift+N`, `Alt+N`, `F2`, and `Delete` open the same user-visible flows as their menu commands. Add a nested tag fixture and verify its descendant is absent from the move select. Make `deleteClassification` reject and assert the confirmation remains open with the returned reason visible.

- [ ] **Step 2: Run the sidebar test and verify RED**

  Run: `npm test -- --run app/src/classification/ClassificationSidebar.test.tsx` from `app`.

  Expected: FAIL because the shortcuts and descendant filtering are absent.

- [ ] **Step 3: Implement the minimal keyboard and safety logic**

  Extend the tree row key handler with exact modifier checks, route every shortcut to the functions from Task 1, and stop propagation when a shortcut is handled. Change `moveParents` to exclude the entry and every entry for which walking `parentId` reaches the moving entry. Keep failed move/delete dialogs open and show `commandErrorMessage` through the existing toast.

- [ ] **Step 4: Run the sidebar test and verify GREEN**

  Run: `npm test -- --run app/src/classification/ClassificationSidebar.test.tsx` from `app`.

  Expected: PASS.

- [ ] **Step 5: Commit the keyboard and safety change**

  ```powershell
  git add -- app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
  git commit -m "fix: make classification folder commands safe"
  ```

### Task 3: Suppress X's follow-up image click after donut drag

**Files:**
- Modify: `extension/tests/content-controller.test.mjs`
- Modify: `extension/src/content.js`

**Interfaces:**
- Produces: `createClickSuppressor()` with `arm()` and `consume(event)`; the content script arms it only when the current pointer crossed `LakomicsGesture.OPEN_DISTANCE_PX` and listens for capture-phase `click` events.

- [ ] **Step 1: Write a failing one-shot click suppression test**

  Export `createClickSuppressor` in test mode and assert literal observable behavior:

  ```js
  suppressor.arm();
  assert.equal(suppressor.consume(firstClick), true);
  assert.equal(firstClick.defaultPrevented, true);
  assert.equal(firstClick.immediatePropagationStopped, true);
  assert.equal(suppressor.consume(secondClick), false);
  ```

  Also assert an unarmed suppressor leaves an ordinary click untouched.

- [ ] **Step 2: Run the extension test and verify RED**

  Run: `npm test -- --test-name-pattern="click suppression"` from `extension`.

  Expected: FAIL because `createClickSuppressor` is not exported.

- [ ] **Step 3: Implement and wire the one-shot suppressor**

  Add the minimal stateful helper. In `installContentScript`, add a capture `click` listener, arm on pointer-up and cancellation only when `thresholdCrossed` is true, and consume with `preventDefault()` plus `stopImmediatePropagation()`. Do not arm below 12px.

- [ ] **Step 4: Run all extension tests and verify GREEN**

  Run: `npm test` from `extension`.

  Expected: all tests PASS.

- [ ] **Step 5: Commit the click fix**

  ```powershell
  git add -- extension/src/content.js extension/tests/content-controller.test.mjs
  git commit -m "fix: suppress X click after radial drag"
  ```

### Task 4: Full verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: fresh evidence that the app and extension are ready together.

- [ ] **Step 1: Run the complete app check**

  Run: `npm run check` from `app`.

  Expected: all Vitest tests pass and the TypeScript/Vite production build exits 0.

- [ ] **Step 2: Run the complete extension test suite**

  Run: `npm test` from `extension`.

  Expected: all Node tests pass.

- [ ] **Step 3: Inspect the final diff and worktree**

  Run: `git diff --check HEAD~3..HEAD` and `git status --short` from the repository root.

  Expected: no whitespace errors; only the user's pre-existing unrelated files remain unstaged.
