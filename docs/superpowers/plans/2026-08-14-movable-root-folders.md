# Movable Root Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow ordinary classification folders to move between the top level and nested positions without losing assets or descendants.

**Architecture:** Keep the existing `move_classification(id, parent_id)` interface. The Rust library transaction derives `root` or `tag` from the destination and updates `kind` with `parent_id`; the React sidebar only stops pre-rejecting those valid moves and exposes the corresponding dialog destinations.

**Tech Stack:** Rust, rusqlite, React 19, TypeScript, Vitest, Testing Library

## Global Constraints

- Moving `root` below another classification changes it to `tag`.
- Moving `tag` to the top level changes it to `root`.
- `work` remains valid only directly below a `root`.
- Asset links and descendant parent links remain unchanged.
- Cycles and duplicate sibling names remain invalid.
- No new API, migration, kind-conversion dialog, or dependency.

---

### Task 1: Atomic Classification Kind Transition

**Files:**
- Modify: `app/src-tauri/src/library/classification.rs`

**Interfaces:**
- Consumes: `Library::move_classification(&self, id: &str, parent_id: Option<&str>)`.
- Produces: the same interface with destination-derived `ClassificationKind::Root | Tag` for ordinary folders.

- [ ] **Step 1: Write a failing Rust test for root demotion and data preservation**

Create two roots, a child tag below the moving root, and one asset directly assigned to it. Move the root below the other root, then assert:

```rust
assert_eq!(moved.kind, ClassificationKind::Tag);
assert_eq!(moved.parent_id, Some(destination.id));
assert_eq!(child.parent_id, Some(moved.id.clone()));
assert_eq!(library.get_asset_classifications("asset-a").unwrap(), vec![moved]);
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test moving_a_root_below_another_root_demotes_it_without_moving_contents`

Expected: FAIL with `InvalidClassificationParent` from the current root-parent validation.

- [ ] **Step 3: Implement the minimal transactional kind transition**

Derive the kind before validation:

```rust
let next_kind = match (&entry.kind, parent.as_ref()) {
    (ClassificationKind::Root, Some(_)) => ClassificationKind::Tag,
    _ => entry.kind.clone(),
};
validate_parent(&next_kind, parent.as_ref())?;
```

Update both values in the existing transaction:

```sql
UPDATE classification_entries SET kind = ?1, parent_id = ?2 WHERE id = ?3
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cargo test moving_a_root_below_another_root_demotes_it_without_moving_contents`

Expected: PASS.

- [ ] **Step 5: Write a failing root-promotion test**

Move the just-demoted folder to `None` and assert `kind == Root`, `parent_id == None`, and the child/assets remain linked. Run:

`cargo test moving_a_tag_to_the_top_level_promotes_it_without_moving_contents`

Expected: FAIL with `InvalidClassificationParent` because a tag still requires a parent.

- [ ] **Step 6: Add the tag-to-root transition and verify GREEN**

Add the second destination-derived branch:

```rust
(ClassificationKind::Tag, None) => ClassificationKind::Root,
```

Run: `cargo test moving_a_tag_to_the_top_level_promotes_it_without_moving_contents`

Expected: PASS.

- [ ] **Step 7: Run all classification tests**

Run: `cargo test library::classification`

Expected: all classification tests PASS, including cycle and work-parent constraints.

- [ ] **Step 8: Commit Task 1**

```powershell
git add app/src-tauri/src/library/classification.rs
git commit -m "fix: move root classification folders"
```

### Task 2: Sidebar Drag and Dialog Destinations

**Files:**
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`

**Interfaces:**
- Consumes: unchanged `gateway.moveClassification(id, parentId)`.
- Produces: valid root-folder drop targets and reversible top-level dialog destinations.

- [ ] **Step 1: Write a failing root drag test**

Render `게임` and `이미지` as separate roots, drag `이미지` inside `게임`, and assert:

```tsx
expect(gamesRow).toHaveAttribute("data-drop-state", "valid");
await waitFor(() => expect(libraryGateway.moveClassification).toHaveBeenCalledWith(images.id, games.id));
```

- [ ] **Step 2: Run the App test and verify RED**

Run: `npm.cmd test -- --run src/app/App.test.tsx`

Expected: FAIL because `validClassificationDrop` rejects every `root` payload.

- [ ] **Step 3: Allow root drag through existing structural checks**

Remove only the unconditional `entry.kind === "root"` rejection. Preserve current self, current-parent, descendant, duplicate-name, and `work → root` checks.

- [ ] **Step 4: Run the App test and verify GREEN**

Run: `npm.cmd test -- --run src/app/App.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing move-dialog tests**

Replace the old fixed-root assertion with a test that opens `Games` → `폴더 이동` and sees `Images`. Add a test that opens `Arona` → `폴더 이동` and sees `최상위`.

- [ ] **Step 6: Run the sidebar test and verify RED**

Run: `npm.cmd test -- --run src/classification/ClassificationSidebar.test.tsx`

Expected: FAIL because root movement is disabled and tag destinations omit `최상위`.

- [ ] **Step 7: Expose reversible destinations**

Use the normal `폴더 이동` action for roots and stop disabling it. Update `moveParents`:

```tsx
if (entry.kind === "work") {
  return entries.filter((candidate) => candidate.kind === "root" && candidate.id !== entry.id);
}
const parents = entries.filter((candidate) =>
  candidate.id !== entry.id && !isDescendant(candidate.id, entry.id, entries)
);
return entry.kind === "tag" ? [null, ...parents] : parents;
```

- [ ] **Step 8: Run both focused frontend suites**

Run: `npm.cmd test -- --run src/app/App.test.tsx src/classification/ClassificationSidebar.test.tsx`

Expected: both files PASS.

- [ ] **Step 9: Commit Task 2**

```powershell
git add app/src/app/App.tsx app/src/app/App.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "fix: allow nesting top-level folders"
```

### Task 3: Full Verification

**Files:**
- Verify all modified files from Tasks 1 and 2.

**Interfaces:**
- Consumes: completed Rust and React behavior.
- Produces: full test/build evidence.

- [ ] **Step 1: Run all frontend tests**

Run: `npm.cmd test -- --run`

Expected: 296 or more tests pass with zero failures.

- [ ] **Step 2: Run the frontend production build**

Run: `npm.cmd run build`

Expected: TypeScript and Vite exit with code 0.

- [ ] **Step 3: Run all Rust tests**

Run: `cargo test`

Expected: all unit, integration, and doc tests pass; explicitly ignored acceptance tests remain ignored.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff main...HEAD --check` and `git status --short`

Expected: no whitespace errors and only intentional commits.
