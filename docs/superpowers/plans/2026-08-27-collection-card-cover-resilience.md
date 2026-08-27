# Collection Card Cover Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse a locally cached first manga-volume cover when no explicit Work cover exists and replace failed Collection card thumbnails with the existing placeholder.

**Architecture:** Extend the existing Collection summary SQL projection with one ordered fallback subquery, avoiding per-card requests or artwork copies. Keep image failure state inside `CollectionCard`, remembering only the failed URL so a changed URL is retried automatically.

**Tech Stack:** Rust 2021, SQLite, React 19, TypeScript 7, Vitest, Testing Library

## Global Constraints

- Explicitly selected Work cover artwork always wins.
- Collection browsing continues to use bounded thumbnail routes; large-viewer media remains unchanged.
- Do not contact providers, duplicate artwork, migrate data, or add dependencies.
- Preserve `loading="lazy"`, `decoding="async"`, and existing card layout and interactions.
- Do not import the preserved gateway test or stale dated work summaries.
- Run focused tests during iteration and broaden only if they expose cross-module risk.

---

### Task 1: Reuse the earliest cached volume cover

**Files:**
- Modify: `app/src-tauri/src/library/collection.rs`
- Test: `app/src-tauri/src/library/collection.rs`

**Interfaces:**
- Consumes: `COLLECTION_SUMMARY_SQL`, `collection_volumes.cover_artwork_id`, and `CollectionSummary.selected_work_artwork_id: Option<String>`.
- Produces: the same summary field, preferring a selected `cover` artwork and otherwise returning the earliest linked volume artwork.

- [ ] **Step 1: Write the failing summary test**

Add `summary_uses_first_volume_cover_when_no_selected_cover`. Insert volume 2 and volume 1 artwork and volume rows in reverse order, then assert:

```rust
assert_eq!(
    library
        .get_collection(&collection.id)
        .unwrap()
        .selected_work_artwork_id
        .as_deref(),
    Some("volume-1-art")
);
```

Insert a selected `kind = 'cover'` artwork and assert it replaces the fallback with `selected-cover-art`.

- [ ] **Step 2: Run the test and verify RED**

Run from `app/src-tauri`:

```powershell
cargo test --lib summary_uses_first_volume_cover_when_no_selected_cover
```

Expected: FAIL because the summary currently returns `None` when no selected `cover` artwork exists.

- [ ] **Step 3: Add the minimal ordered SQL fallback**

Wrap the selected-cover subquery in `COALESCE` and add:

```sql
SELECT artwork.id
FROM collection_volumes AS volume
JOIN collection_work_artworks AS artwork ON artwork.id = volume.cover_artwork_id
WHERE volume.collection_id = collection.id
ORDER BY volume.edition_index, volume.sort_order, volume.volume_number, artwork.id
LIMIT 1
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the same targeted command and expect one passing test.

- [ ] **Step 5: Commit the backend fallback**

```powershell
git add app/src-tauri/src/library/collection.rs
git commit -m "fix: reuse volume cover on collection cards"
```

---

### Task 2: Hide failed Collection card thumbnails

**Files:**
- Modify: `app/src/collections/CollectionCard.test.tsx`
- Modify: `app/src/collections/CollectionCard.tsx`

**Interfaces:**
- Consumes: `CollectionCard`'s existing `coverUrl: string | null` prop.
- Produces: the same component contract; only the failed current URL is replaced by `.collection-card__placeholder`.

- [ ] **Step 1: Write the failing component test**

Import `fireEvent`, render `broken.jpg`, dispatch an image error, and assert that the image disappears and the placeholder appears. Rerender with `working.jpg` and assert that the new URL is rendered with `decoding="async"`.

```tsx
const view = render(
  <CollectionCard collection={sample} coverUrl="broken.jpg" selected={false} onClick={vi.fn()} />,
);
fireEvent.error(screen.getByRole("img", { name: "Sample" }));
expect(screen.queryByRole("img", { name: "Sample" })).not.toBeInTheDocument();
expect(document.querySelector(".collection-card__placeholder")).toBeInTheDocument();
view.rerender(
  <CollectionCard collection={sample} coverUrl="working.jpg" selected={false} onClick={vi.fn()} />,
);
expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("src", "working.jpg");
expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("decoding", "async");
```

- [ ] **Step 2: Run the test and verify RED**

Run from `app`:

```powershell
npm.cmd test -- src/collections/CollectionCard.test.tsx
```

Expected: FAIL because the broken image remains mounted.

- [ ] **Step 3: Track only the failed URL**

Add one state value and derive the visible URL:

```tsx
const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
const visibleCoverUrl = coverUrl && coverUrl !== failedCoverUrl ? coverUrl : null;
```

Render `visibleCoverUrl` and set it as failed from `onError`. Preserve all existing image attributes.

- [ ] **Step 4: Run the component test and verify GREEN**

Run the same targeted command and expect the file to pass.

- [ ] **Step 5: Commit the frontend fallback**

```powershell
git add app/src/collections/CollectionCard.tsx app/src/collections/CollectionCard.test.tsx
git commit -m "fix: hide broken collection cover images"
```

---

### Task 3: Verify, synchronize, and remove superseded preservation data

**Files:**
- Verification and Git cleanup only.

**Interfaces:**
- Consumes: Tasks 1 and 2 and the preserved local branch/stash.
- Produces: synchronized `main` with no preservation branch or obsolete stash.

- [ ] **Step 1: Run the two focused checks once on the final tree**

```powershell
cargo test --lib summary_uses_first_volume_cover_when_no_selected_cover
npm.cmd test -- src/collections/CollectionCard.test.tsx
```

- [ ] **Step 2: Confirm Git integrity and push `main`**

Run `git diff --check`, confirm the working tree is clean, and push `main` to `origin`.

- [ ] **Step 3: Remove only the reviewed preservation targets**

Confirm `codex/local-preserved-2026-08-27` and `stash@{0}` still identify the reviewed data, then force-delete the unmerged local preservation branch and drop that stash.

- [ ] **Step 4: Fetch/prune and verify final state**

Confirm local and remote `main` point to the same commit, the worktree is clean, the preservation branch is absent, and no stash remains.
