# Medium-Priority Review Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the four remaining medium-priority review fixes without expanding into the separate hardening backlog.

**Architecture:** Keep each fix at its existing ownership boundary: Rust video-media lifecycle, Collection overlay navigation, App-owned UI preferences, and LibraryContext-owned startup restoration. Each task begins with an observable regression test and makes the smallest behavior change that turns it green.

**Tech Stack:** Rust 2021, React 19, TypeScript, Vitest, Testing Library, Chrono/rusqlite existing stack

## Global Constraints

- Process tasks in the listed order.
- Do not alter `C:\New_lakomics_assets`; Rust tests use temporary libraries.
- Do not create commits unless the user explicitly requests one.
- Preserve existing visual structure and design tokens; these fixes add no new visual treatment.
- Exclude the separate a11y, quick-preview, copy-feedback, and low-priority hardening backlog.

---

### Task 1: Remove failed video preparation directories

**Files:**
- Modify: `app/src-tauri/src/library/video_media.rs`
- Test: `app/src-tauri/src/library/video_media.rs`

**Interfaces:**
- Consumes: a completed pending directory and final derivative directory.
- Produces: `install_prepared_directory(pending: &Path, final_directory: &Path) -> Result<(), LibraryError>`.

- [x] **Step 1: Add a failing rename-cleanup test**

Create a pending directory with a marker file and a non-empty destination directory, call `install_prepared_directory`, and assert `VideoPreparationFailed` plus a missing pending directory:

```rust
#[test]
fn failed_derivative_install_removes_the_pending_directory() {
    let temp = tempfile::tempdir().unwrap();
    let pending = temp.path().join(".pending-test");
    let destination = temp.path().join("video-1");
    fs::create_dir(&pending).unwrap();
    fs::write(pending.join("poster.webp"), b"poster").unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("existing"), b"keep").unwrap();

    let result = install_prepared_directory(&pending, &destination);

    assert!(matches!(result, Err(LibraryError::VideoPreparationFailed)));
    assert!(!pending.exists());
    assert!(destination.join("existing").is_file());
}
```

- [x] **Step 2: Run the test and verify RED**

Run: `cargo test library::video_media::tests::failed_derivative_install_removes_the_pending_directory --lib`

Expected: FAIL because the installation helper does not exist.

- [x] **Step 3: Add the cleanup-aware install helper**

```rust
fn install_prepared_directory(pending: &Path, final_directory: &Path) -> Result<(), LibraryError> {
    if fs::rename(pending, final_directory).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_dir_all(pending);
    Err(LibraryError::VideoPreparationFailed)
}
```

Use best-effort removal in the pre-existing destination branch and replace the direct `fs::rename` call with this helper.

- [x] **Step 4: Run the focused and module tests**

Run: `cargo test library::video_media::tests::failed_derivative_install_removes_the_pending_directory --lib`

Run: `cargo test library::video_media::tests --lib`

Expected: both commands PASS.

### Task 2: Keep Escape inside the top Collection dialog

**Files:**
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/app/App.test.tsx`
- Test: `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Consumes: `editMode`, `deleteOpen`, and unread release `onChanged` callback state.
- Produces: one-layer Escape behavior and handled refresh failures.

- [x] **Step 1: Add failing edit/delete Escape tests**

For each `편집` and `삭제` menu action, open its dialog, press Escape once, assert the dialog closes and `onExit` remains uncalled.

- [x] **Step 2: Add the rejected unread-refresh regression**

Render with unread events and `onChanged = vi.fn().mockRejectedValue(new Error("refresh failed"))`; wait for the release summary and callback. The test must finish without an unhandled rejection.

- [x] **Step 3: Run the Collection overlay tests and verify RED**

Run: `npm test -- src/collections/CollectionOverlay.test.tsx`

Expected: edit/delete Escape calls `onExit`, and the rejected refresh escapes the effect.

- [x] **Step 4: Gate the parent Escape handler and contain refresh rejection**

Add `editMode === null && !deleteOpen` to the parent Escape condition and both values to the effect dependencies. Wrap the unread `onChangedRef.current()` await in a local `try/catch` that keeps the received event state.

In the App test gateway, make `getIgdbConnection` and `getTmdbConnection` default to `vi.fn().mockResolvedValue(null)` so every Collection overlay test double respects the Promise contract.

- [x] **Step 5: Run Collection and current failing App tests**

Run: `npm test -- src/collections/CollectionOverlay.test.tsx src/app/App.test.tsx`

Expected: all tests in both files PASS.

### Task 3: Debounce persisted sidebar width

**Files:**
- Modify: `app/src/app/App.tsx`
- Test: `app/src/app/App.test.tsx`

**Interfaces:**
- Consumes: integer clamped widths emitted by `ClassificationSidebar`.
- Produces: live local `sidebarWidth` and a 150ms delayed update to `UiPreferences.sidebarWidth`.

- [x] **Step 1: Add a failing storage-write debounce test**

Open the workspace, locate the sidebar separator, then start fake timers and spy on `Storage.prototype.setItem`. Emit rapid pointer moves ending at 320px. Assert the sidebar style updates immediately, no UI preference write occurs at 149ms, and exactly one write containing `sidebarWidth: 320` occurs at 150ms.

- [x] **Step 2: Run the App test and verify RED**

Run: `npm test -- src/app/App.test.tsx`

Expected: FAIL because pointermove currently updates preferences and localStorage immediately.

- [x] **Step 3: Add scoped live width state and debounce**

Initialize `sidebarWidth` from `preferences.sidebarWidth`. On change, schedule a 150ms timer that updates only `preferences.sidebarWidth`; cancel it on a newer width or unmount. Pass the live width and `setSidebarWidth` to `ClassificationSidebar`. Leave the existing preferences persistence effect unchanged for all other fields.

- [x] **Step 4: Run App and sidebar tests**

Run: `npm test -- src/app/App.test.tsx src/classification/ClassificationSidebar.test.tsx`

Expected: both files PASS; the sidebar component still emits clamped integer values while App persistence is debounced.

### Task 4: Remove only a failed restored library path

**Files:**
- Modify: `app/src/library/LibraryContext.tsx`
- Test: `app/src/library/LibraryContext.test.tsx`

**Interfaces:**
- Consumes: a stored startup library path and `gateway.openLibrary`.
- Produces: internal `tryOpenLibrary(path: string) -> Promise<boolean>` while preserving public `openLibrary(path: string) -> Promise<void>`.

- [x] **Step 1: Add a failing stale startup path test**

Store `C:\\Missing`, reject `gateway.openLibrary`, render the provider, wait for the error, and assert `LIBRARY_PATH_STORAGE_KEY` is absent.

- [x] **Step 2: Run LibraryContext tests and verify RED**

Run: `npm test -- src/library/LibraryContext.test.tsx`

Expected: FAIL because the stored missing path remains.

- [x] **Step 3: Split automatic restore from public manual open behavior**

Create an internal callback returning `true` on success and `false` after setting the existing error message on failure. The public callback awaits it without clearing storage. The startup effect removes the key only when the failed path still equals the current stored value.

- [x] **Step 4: Run LibraryContext tests and verify GREEN**

Run: `npm test -- src/library/LibraryContext.test.tsx`

Expected: startup failure clears the stale path; the existing manual-switch failure test preserves `C:\\Current`.

### Task 5: Full verification

**Files:**
- Verify all changed files and existing suites.

- [x] **Step 1: Run diff and focused formatting checks**

Run: `git diff --check`

Run: `cargo fmt --check`

Expected: no whitespace errors from changed hunks. Existing repository-wide rustfmt drift is reported without reformatting unrelated files.

- [x] **Step 2: Run full tests**

Run: `cargo test`

Run from `app`: `npm test`

Expected: report exact totals and distinguish any pre-existing unrelated failures from these four fixes.
