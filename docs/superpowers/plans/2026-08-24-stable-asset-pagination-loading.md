# Stable Asset Pagination Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent adjacent-page loading from resizing the Asset Gallery and flashing a gray band above the status bar.

**Architecture:** Keep pagination state and status reporting unchanged. Remove only the two pagination `Skeleton` nodes that participate in the gallery column layout; the existing status bar remains the non-layout loading feedback.

**Tech Stack:** React 19, TypeScript 7, Testing Library, Vitest

## Global Constraints

- Preserve the first-page loading skeleton.
- Preserve pagination errors and retry controls.
- Preserve `AssetBrowserStatus.loading` for first, next, and previous page requests.
- Do not change pagination, virtualization, date-rail behavior, or page size.
- Do not modify unrelated working-tree changes.

---

### Task 1: Keep adjacent-page loading out of gallery layout

**Files:**
- Modify: `app/src/assets/AssetBrowser.tsx:286-287`
- Test: `app/src/assets/AssetBrowser.test.tsx`

**Interfaces:**
- Consumes: existing `AssetBrowserStatus.loading`, `nextLoading`, `prevLoading`, `currentNextError`, and `currentPrevError` state.
- Produces: a stable `.asset-gallery` layout during unresolved adjacent-page requests; no new public interface.

- [ ] **Step 1: Write the failing regression test**

Add this test inside `describe("AssetBrowser", ...)`:

```tsx
it("keeps the gallery layout stable while the next page is loading", async () => {
  const pendingNext = new Promise<AssetPage>(() => undefined);
  const status = vi.fn();
  const gateway = createGateway();
  vi.mocked(gateway.listAssets)
    .mockResolvedValueOnce({
      items: Array.from({ length: 50 }, (_, index) => asset(index)),
      nextCursor: { token: "next" },
    })
    .mockReturnValueOnce(pendingNext);

  const { container } = renderBrowser(gateway, { status });

  expect(await screen.findByRole("option", { name: "asset-0.png" })).toBeInTheDocument();
  await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
  expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ loading: true }));
  expect(container.querySelector(".asset-gallery")).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "자산을 더 불러오는 중" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify the regression fails**

Run:

```powershell
cd C:\chatgpt\app
npm test -- --run src/assets/AssetBrowser.test.tsx -t "keeps the gallery layout stable while the next page is loading"
```

Expected: FAIL because the current component renders the `자산을 더 불러오는 중` status skeleton.

- [ ] **Step 3: Remove only the adjacent-page skeletons**

Replace the two loading/error lines after `AssetGallery` with error rendering only:

```tsx
{currentNextError && <div className="asset-browser__next-error"><Toast>{currentNextError}</Toast><Button onClick={() => loadNextPage(true)}>다시 시도</Button></div>}
{currentPrevError && <div className="asset-browser__next-error"><Toast>{currentPrevError}</Toast><Button onClick={() => loadPrevPage(true)}>다시 시도</Button></div>}
```

Do not remove `nextLoading` or `prevLoading` state because `onStatusChange` still consumes both values.

- [ ] **Step 4: Run the focused AssetBrowser test file**

Run:

```powershell
cd C:\chatgpt\app
npm test -- --run src/assets/AssetBrowser.test.tsx
```

Expected: the test file exits 0 with all tests passing and no unhandled errors.

- [ ] **Step 5: Verify the live development build**

With `npm run tauri -- dev` running, trigger fast wheel scrolling and date-rail dragging. Confirm the status bar can report loading while no gray skeleton band appears above it and the gallery viewport height remains fixed.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx
git commit -m "fix: keep asset pagination out of gallery layout"
```
