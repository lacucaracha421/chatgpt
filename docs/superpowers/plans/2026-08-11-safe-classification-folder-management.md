# Safe Classification Folder Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make classification-folder deletion preserve directly linked assets, reject folders with children, and align folder drag feedback with Lakomics's multi-classification model.

**Architecture:** Keep the existing classification schema and gateway interface. Change `Library::delete_classification` into one authoritative SQLite transaction, derive immediately knowable delete restrictions from the loaded tree in React, and simplify internal drag targets to folder-inside drops while preserving the existing multi-classification asset patch.

**Tech Stack:** Rust, rusqlite, React 19, TypeScript, Testing Library/Vitest, Tauri commands.

## Global Constraints

- A classification folder is navigation, not a file-storage location; one asset may belong to several folders.
- A folder with children cannot be deleted.
- Deleting a leaf folder moves every directly linked asset, regardless of asset state, to its parent and preserves all other classification links.
- A root folder without children can be deleted; its direct asset links are removed while the assets remain.
- Delete and asset reassignment must be one database transaction.
- Folder drops target only the inside of another folder; the tree remains name-sorted.
- Root folders cannot move below another folder; work folders can move only below roots.
- Add no dependency, schema migration, delete-preview API, manual ordering, automatic merge, or undo system.

---

### Task 1: Transactional leaf-folder deletion

**Files:**
- Modify: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `Library::delete_classification(&self, id: &str) -> Result<(), LibraryError>` and existing `asset_classifications` uniqueness.
- Produces: the same public method with a `ClassificationHasChildren` failure reason and root-link cleanup in the same transaction.

- [ ] **Step 1: Write failing Rust tests for deletion outcomes**

  Replace the old asset-linked rejection test with cases that assert literal persisted outcomes:

  ```rust
  fixture.library.delete_classification(&fixture.child_tag.id).unwrap();
  assert_eq!(
      fixture.library.get_asset_classifications("asset-1").unwrap()
          .into_iter().map(|entry| entry.id).collect::<Vec<_>>(),
      vec![fixture.parent_tag.id.clone()],
  );
  ```

  Add tests proving a child-bearing folder returns `ClassificationHasChildren`, an asset-bearing root is deleted without deleting its assets, an empty root is deleted, and an asset already linked to the parent remains linked exactly once. Mark directly linked fixtures as normal, review, and trash to prove deletion transfers every asset state without filtering.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

  Run: `cargo test library::classification::tests::deleting --lib` from `app/src-tauri`.

  Expected: FAIL because asset-linked leaf deletion still returns `ClassificationNotEmpty` and the new error variants do not exist.

- [ ] **Step 3: Implement the minimal delete transaction**

  Load the entry, reject an existing child, then branch on `parent_id`. For a child folder, insert parent links from the deleted folder's links using `INSERT OR IGNORE`, delete old links, and delete the entry. For a root, reject any direct asset link before deleting. Commit only after every statement succeeds.

  ```sql
  INSERT OR IGNORE INTO asset_classifications (asset_id, classification_id)
  SELECT asset_id, ?2 FROM asset_classifications WHERE classification_id = ?1;
  DELETE FROM asset_classifications WHERE classification_id = ?1;
  DELETE FROM classification_entries WHERE id = ?1;
  ```

- [ ] **Step 4: Run the classification tests and verify GREEN**

  Run: `cargo test library::classification::tests --lib` from `app/src-tauri`.

  Expected: all classification tests PASS.

- [ ] **Step 5: Commit the library behavior**

  ```powershell
  git add -- app/src-tauri/src/library/classification.rs app/src-tauri/src/library/error.rs app/src-tauri/src/commands.rs
  git commit -m "feat: preserve assets when deleting leaf folders"
  ```

### Task 2: Safe sidebar deletion UX

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`

**Interfaces:**
- Consumes: existing `deleteClassification(id)` gateway call and controlled `onViewChange` / `onExpandedIdsChange` props.
- Produces: disabled `삭제 — 하위 폴더 있음` actions, matching `Delete` shortcut feedback, parent selection after child deletion, and all-assets selection after root deletion.

- [ ] **Step 1: Write failing sidebar tests**

  Add user-visible cases that assert:

  ```tsx
  expect(screen.getByRole("menuitem", { name: "삭제 — 하위 폴더 있음" })).toHaveAttribute("data-disabled");
  expect(onViewChange).toHaveBeenCalledWith({ kind: "classification", classificationId: "root" });
  ```

  Cover the disabled menu and shortcut toast for a folder with children, child confirmation copy mentioning parent reassignment, a root confirmation stating it must be empty, successful child deletion selecting its parent, and successful empty-root deletion selecting `classificationId: null`.

- [ ] **Step 2: Run the sidebar test and verify RED**

  Run: `npm.cmd test -- --run src/classification/ClassificationSidebar.test.tsx` from `app`.

  Expected: FAIL because every row currently offers the same enabled delete action and successful deletion only refreshes entries.

- [ ] **Step 3: Implement the minimal sidebar logic**

  Derive `hasChildren` from each `TreeItem`, change only its delete `MenuItem` label and `disabled` value, and handle `Delete` on the selected entry through the same child check. After a successful gateway call, remove the deleted ID from expanded preferences, navigate to `entry.parentId`, and refresh classifications. Keep gateway failures in the existing confirmation dialog with the server message.

- [ ] **Step 4: Run the sidebar test and build**

  Run: `npm.cmd test -- --run src/classification/ClassificationSidebar.test.tsx` and `npm.cmd run build` from `app`.

  Expected: sidebar tests PASS and TypeScript/Vite build exits 0.

- [ ] **Step 5: Commit the sidebar behavior**

  ```powershell
  git add -- app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
  git commit -m "fix: make folder deletion outcomes explicit"
  ```

### Task 3: Inside-only folder drops and additive asset feedback

**Files:**
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Create: `app/src/shared/ui/DragLayer.test.tsx`
- Modify: `app/src/shared/ui/DragLayer.tsx`
- Modify: `app/src/shared/interaction/pointerDrag.ts`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `patchAssetClassifications` with an empty `removeClassificationIds` list and existing folder/work/root kind checks.
- Produces: only `position: "inside"` classification targets, duplicate-name rejection before drop, `폴더에 추가` drag text, and automatic expansion of the new parent after a folder move.

- [ ] **Step 1: Write failing drag tests**

  Update the app pointer-drag tests so pointer positions near row edges still produce `data-drop-position="inside"`, duplicate sibling destinations are invalid, a successful move expands the destination ID, and additive asset drag shows and reports `폴더에 추가` while sending:

  ```ts
  { assetIds: ["asset-arona"], addClassificationIds: ["root-games"], removeClassificationIds: [] }
  ```

  Add a focused `DragLayer` assertion for `1개 자산 · 폴더에 추가`. Add sidebar cases proving a root's move action is disabled and labelled with its reason, a work folder offers only roots as parents, and dialog-based movement expands the chosen parent. The work row remains a folder but renders the existing work-oriented icon instead of the generic folder icon.

- [ ] **Step 2: Run focused frontend tests and verify RED**

  Run: `npm.cmd test -- --run src/app/App.test.tsx src/shared/ui/DragLayer.test.tsx` from `app`.

  Expected: FAIL because edge drops still emit before/after positions, duplicate names are not prefiltered, and drag copy uses the old labels.

- [ ] **Step 3: Implement the minimal drag changes**

  Narrow `ClassificationDropPosition` to `"inside"`, make `classificationTargetAt` return that position, remove before/after CSS, reject no-op moves and targets whose children already contain a case-insensitive sibling name, and update existing drag strings. On successful classification movement, add `target.entryId` to `expandedClassificationIds` without removing existing IDs. Route dialog movement through the same controlled expansion behavior, disable root movement with an explanatory label, retain work-only-to-root filtering, and render work rows with their distinct icon.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run: `npm.cmd test -- --run src/app/App.test.tsx src/shared/ui/DragLayer.test.tsx` from `app`.

  Expected: focused tests PASS.

- [ ] **Step 5: Commit drag semantics**

  ```powershell
  git add -- app/src/app/App.tsx app/src/app/App.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/shared/ui/DragLayer.tsx app/src/shared/ui/DragLayer.test.tsx app/src/shared/interaction/pointerDrag.ts app/src/styles/global.css
  git commit -m "fix: clarify classification folder drops"
  ```

### Task 4: Full verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: fresh evidence for the full desktop library and UI behavior.

- [ ] **Step 1: Run all Rust tests**

  Run: `cargo test` from `app/src-tauri`.

  Expected: all Rust unit, integration, acceptance, and doc tests PASS, excluding already ignored tests.

- [ ] **Step 2: Run the complete frontend check**

  Run: `npm.cmd run check` from `app`.

  Expected: all Vitest tests pass and the TypeScript/Vite build exits 0.

- [ ] **Step 3: Inspect the final branch state**

  Run: `git diff --check HEAD~3..HEAD` and `git status --short` from the repository root.

  Expected: no whitespace errors; only the user's pre-existing unrelated files remain unstaged.
