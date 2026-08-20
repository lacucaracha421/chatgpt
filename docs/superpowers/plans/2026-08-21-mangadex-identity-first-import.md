# MangaDex Identity-First Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cover-picker import flow with the v6 prototype's compact Work-selection flow and automatically store at most one Japanese representative cover during apply.

**Architecture:** The React dialog keeps only search results and a selected MangaDex identity; selecting a row performs no network request. The Rust library fetches authoritative Work data on apply, chooses an optional Japanese representative cover, and commits the Work, binding, snapshot, and optional artwork atomically.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri 2, Rust, rusqlite

## Global Constraints

- Follow `DESIGN.md` and `docs/prototypes/lakomics-works-v6-reference.html` for visual intent.
- Search results contain no remote images and selection starts no preview request.
- Only locale `ja` is eligible for automatic representative artwork; prefer volume `1`.
- A missing Japanese cover must not prevent Work registration.
- Do not add dependencies, schema, background queues, Volume records, or inactive provider controls.
- Use only targeted checks specified below unless one exposes broader risk.
- Preserve the pre-existing uncommitted `app/src-tauri/Cargo.toml` worktree state.

---

### Task 1: Make MangaDex artwork selection automatic and optional

**Files:**
- Modify: `app/src-tauri/src/library/models.rs:447`
- Modify: `app/src-tauri/src/library/mangadex_flow.rs:49`

**Interfaces:**
- Consumes: `MangaDexWorkPreview.covers: Vec<MangaDexCoverCandidate>` with provider locale and volume metadata.
- Produces: `MangaDexApplyRequest { target, manga_id }` and automatic optional `WorkArtwork` selection.

- [ ] **Step 1: Write the failing Rust tests**

Change the test request helper so callers cannot provide a cover ID, then add focused tests in `mangadex_flow.rs`:

```rust
fn request(name: &str) -> MangaDexApplyRequest {
    MangaDexApplyRequest {
        target: MangaDexApplyTarget::New { name: name.into() },
        manga_id: MANGA_ID.into(),
    }
}

#[test]
fn representative_cover_prefers_japanese_volume_one() {
    let preview = fetched("snapshot").preview;
    let selected = representative_japanese_cover(&preview.covers).unwrap();

    assert_eq!(selected.language.as_deref(), Some("ja"));
    assert_eq!(selected.volume.as_deref(), Some("1"));
}

#[test]
fn new_apply_without_a_japanese_cover_commits_without_artwork() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let mut work = fetched("snapshot-v1");
    work.preview.covers.retain(|cover| cover.language.as_deref() != Some("ja"));

    let created = library
        .apply_fetched_mangadex(request("던전밥"), work, None)
        .unwrap();

    assert_eq!(created.name, "던전밥");
    assert!(created.selected_work_artwork_id.is_none());
    assert!(library.get_mangadex_connection(&created.id).unwrap().is_some());
}
```

Update existing `apply_fetched_mangadex` test calls to pass `Some(&cover_bytes())`. These tests must fail to compile because the production request still requires `cover_id` and apply still requires non-optional bytes.

- [ ] **Step 2: Run the focused Rust tests and confirm RED**

Run from `app/src-tauri`:

```powershell
cargo test library::mangadex_flow::tests
```

Expected: compilation fails on the removed `cover_id`, missing `representative_japanese_cover`, or optional byte argument. Do not proceed if the test unexpectedly passes.

- [ ] **Step 3: Implement the minimal backend behavior**

Remove `cover_id` from `MangaDexApplyRequest` in `models.rs`.

Add this private policy helper in `mangadex_flow.rs`:

```rust
fn representative_japanese_cover(
    covers: &[MangaDexCoverCandidate],
) -> Option<&MangaDexCoverCandidate> {
    covers
        .iter()
        .find(|cover| cover.language.as_deref() == Some("ja") && cover.volume.as_deref() == Some("1"))
        .or_else(|| covers.iter().find(|cover| cover.language.as_deref() == Some("ja")))
}
```

Import `MangaDexCoverCandidate`. In `apply_mangadex`, fetch the Work once, select the optional cover, download only its original file when present, and pass `bytes.as_deref()` into `apply_fetched_mangadex`.

Change `apply_fetched_mangadex` to accept `cover_bytes: Option<&[u8]>`. Prepare artwork only when both the deterministic Japanese selection and bytes are present. Reject inconsistent `Some/None` pairs as `InvalidMangaDexIdentity`. Inside the transaction, call `select_work_artwork_in_transaction` only when artwork exists. After commit, call `commit()` only on the optional prepared artwork.

Keep duplicate-binding checks before database writes and preserve drop-based cleanup for a prepared file on error.

- [ ] **Step 4: Run the focused Rust tests and confirm GREEN**

```powershell
cargo test library::mangadex_flow::tests
```

Expected: all `mangadex_flow` tests pass.

- [ ] **Step 5: Commit the backend task**

```powershell
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/mangadex_flow.rs
git commit -m "fix: select MangaDex artwork automatically"
```

---

### Task 2: Match the prototype's direct Work-selection dialog

**Files:**
- Modify: `app/src/collections/MangaDexImportDialog.test.tsx`
- Modify: `app/src/collections/MangaDexImportDialog.tsx`
- Modify: `app/src/library/types.ts:107`
- Modify: `app/src/shared/ui/Dialog.tsx:5`
- Modify: `app/src/styles/global.css:238,2422`

**Interfaces:**
- Consumes: `LibraryGateway.searchMangaDex(query)` and `MangaDexSearchResult`.
- Produces: `LibraryGateway.applyMangaDex({ target, mangaId })`; result selection is local state only.

- [ ] **Step 1: Write the failing dialog tests**

Replace the cover-selection test with direct-selection expectations:

```tsx
it("selects a text result and creates without requesting or choosing a cover", async () => {
  const user = userEvent.setup();
  const { gateway, onApplied } = renderDialog();

  await user.type(screen.getByRole("searchbox", { name: "만화 검색" }), "  던전밥  ");
  await user.click(screen.getByRole("button", { name: "검색" }));
  const result = await screen.findByRole("button", { name: /던전밥/ });

  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  await user.click(result);

  expect(gateway.previewMangaDex).not.toHaveBeenCalled();
  expect(result).toHaveAttribute("aria-pressed", "true");
  const apply = screen.getByRole("button", { name: "작품 만들기" });
  expect(apply).toBeEnabled();
  await user.click(apply);

  await waitFor(() => expect(gateway.applyMangaDex).toHaveBeenCalledWith({
    target: { kind: "new", name: "던전밥" },
    mangaId: "manga-1",
  }));
  expect(onApplied).toHaveBeenCalledWith(collection);
});
```

Update the existing-collection retry test to select the result row, click `연결`, assert the selected row remains pressed after failure, and expect an apply request with only `target` and `mangaId`.

- [ ] **Step 2: Run the dialog test and confirm RED**

Run from `app`:

```powershell
npm test -- MangaDexImportDialog.test.tsx
```

Expected: the test fails because current selection calls preview, apply requires a cover choice, and the button label/layout differ.

- [ ] **Step 3: Implement the minimal React and type changes**

In `types.ts`, remove `coverId` from `MangaDexApplyRequest`.

In `MangaDexImportDialog.tsx`:

- remove `mangadexCoverPreviewUrl`, `MangaDexWorkPreview`, cover, preview, and editable-name state
- store `selected: MangaDexSearchResult | null`
- make result selection synchronous with `setSelected(result)` and no gateway call
- clear selection when a new search succeeds
- render the exact provider note `MangaDex에서 작품 정보를 검색합니다. 한국 정발 정보는 작품 생성 후 Aladin에 연결할 수 있습니다.`
- render one full-width results list with title and `[author, year]`, plus `MangaDex` as quiet provider text
- use `aria-pressed={selected?.mangaId === result.mangaId}`
- apply with the selected result title for a new Work and no `coverId`
- label the primary action `작품 만들기` for new Works and `연결` for existing Works
- keep the selected result after apply failure

Add a `medium` Dialog variant in `Dialog.tsx` and use it for the import dialog. In `global.css`, set `.ui-dialog--medium` to `min(45rem, calc(100vw - var(--space-6)))`, replace the two-column workspace styles with a single scrollable result list, add a quiet selected-row treatment, and remove the obsolete detail/metadata/overview/cover-grid rules.

- [ ] **Step 4: Run the dialog test and confirm GREEN**

```powershell
npm test -- MangaDexImportDialog.test.tsx
```

Expected: both dialog tests pass with no remote image rendered and no preview call.

- [ ] **Step 5: Run one TypeScript compile check**

```powershell
npx tsc --noEmit
```

Expected: exits successfully. This single check covers the request shape shared by the dialog and Tauri gateway; do not run the full frontend suite.

- [ ] **Step 6: Commit the frontend task**

```powershell
git add app/src/collections/MangaDexImportDialog.test.tsx app/src/collections/MangaDexImportDialog.tsx app/src/library/types.ts app/src/shared/ui/Dialog.tsx app/src/styles/global.css
git commit -m "fix: streamline MangaDex Work import"
```

---

### Task 3: Final targeted evidence and delivery

**Files:**
- No production files unless a targeted check finds a defect.

**Interfaces:**
- Consumes: the two completed tasks and their focused checks.
- Produces: a pushed branch ready for user testing.

- [ ] **Step 1: Review the final diff boundaries**

```powershell
git status --short
git diff HEAD~2 --stat
git diff --check HEAD~2
```

Expected: only the planned files plus the pre-existing `app/src-tauri/Cargo.toml` worktree state appear; no whitespace errors.

- [ ] **Step 2: Do not rerun successful checks**

If Task 1's Rust test, Task 2's dialog test, and TypeScript compile check all passed after their final edits, treat them as sufficient evidence under `AGENTS.md`. Run no full suite and no production build.

- [ ] **Step 3: Push the branch**

```powershell
git push origin codex/works-v2-p1-provider-ownership
```

Expected: the remote branch advances through the design, backend, and frontend commits.
