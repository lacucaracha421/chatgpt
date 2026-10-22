# Mobile Catalog Reader Prefetch Implementation Plan

> **For agentic workers:** Execute this plan directly in the current checkout. Do not spawn subagents. Preserve all unrelated working-tree changes and do not commit, push, deploy, or touch production data unless separately authorized.

**Goal:** Reduce the delay after tapping `읽기` in the Android/mobile manga catalog by fetching and caching the reader manifest while the user is already viewing a work detail page.

**Architecture:** Reuse the existing in-memory `readerCache` and existing `/v1/mobile-catalog/works/.../reader` endpoint. After a detail page has settled, start one bounded, cancellable background prefetch for that exact publication/work/context. A later `읽기` action consumes the cached manifest instead of issuing a second request; changing work, publication, or leaving the catalog cancels or invalidates the prefetch.

**Tech Stack:** React, TypeScript, Vitest/Testing Library, existing native transport.

**Spec:** Direct user-approved parallel optimization scope from 2026-09-16; no separate spec file.

## Global Constraints

- Modify only `_tools/app/mobile-client/` files for this plan.
- Do not modify `_tools/app/src/manga/`, any server file, any authority contract, or Android Java.
- Do not pre-download manga page image bytes in this task; manifest-only prefetch keeps bandwidth and cache behavior predictable.
- Preserve publication revision/context validation and existing reader error handling.
- Do not make the detail page wait for the prefetch and do not show a loading state for background work.

---

### Task 1: Add a single reusable reader-manifest prefetch

**Files:**
- Modify: `_tools/app/mobile-client/Catalog.tsx`
- Test: `_tools/app/mobile-client/Catalog.test.tsx`

**Interfaces:**
- Consumes: `catalogReaderPath`, `api<CatalogReaderManifest>`, `readerCache`, `readerOwner`, `lruSet`.
- Produces: at most one in-flight background reader-manifest request for the currently selected work, reusable by `loadReader(false)`.
- [ ] **Step 1: Add the regression test first.**

Extend the existing `mobile catalog reads` suite with a test that:

1. renders the catalog and opens `밤의 도서관`;
2. waits for the detail body to resolve;
3. waits until exactly one `/reader?` request has been issued by background prefetch;
4. clicks `읽기`;
5. waits for `읽기 닫기`;
6. asserts the `/reader?` request count is still exactly one.

Use the existing mock manifest in `beforeEach`; do not add a second fixture system.

- [ ] **Step 2: Add an in-flight prefetch holder beside the existing caches.**

Use a dedicated ref rather than overloading the list-page `prefetches` map. The state should identify the exact cache key, owner, abort controller, and promise, conceptually:

```ts
type ReaderPrefetch={
  cacheKey:string;
  owner:string;
  controller:AbortController;
  promise:Promise<CatalogReaderManifest>;
};
```

Keep it local to `Catalog`; no new module is needed.

- [ ] **Step 3: Start prefetch only after detail data is available.**

Add an effect gated by all of:

```ts
active && !paused && selected && detail && page?.context && page.publicationRevision && !reader
```

If `readerCache` already contains the exact publication/work key, do nothing. Otherwise issue `api<CatalogReaderManifest>(catalogReaderPath(...))` with its own controller. Validate the same publication/provider/work identity currently checked by `loadReader`, then put the manifest into the existing LRU cache. Background failure must be swallowed; the explicit Read action remains the user-visible retry path.
- [ ] **Step 4: Reuse an in-flight prefetch from `loadReader(false)`.**

Before creating a new reader request, check the dedicated prefetch ref for the same cache key/owner. If it matches and `force === false`, await that promise instead of issuing another API call. Keep `readerBusy` and existing explicit error presentation exactly as they work today.

A forced refresh (`loadReader(true)`) must ignore/abort the old prefetch and fetch a fresh manifest.

- [ ] **Step 5: Cancel stale background work.**

Extend the existing reader-owner and unmount cleanup so a prefetch is aborted when any identity input changes: selected work, page context, publication revision, active/paused ownership, reload, or component unmount. A transport that ignores abort must still be prevented from populating the cache by checking the captured `readerOwner` and returned manifest identity before `lruSet`.

- [ ] **Step 6: Add a stale-result regression test.**

Reuse the suite's deferred-promise pattern. Hold a prefetch response, make the catalog inactive or change owner, resolve the old promise, and assert that reopening does not expose a reader from that stale response. Prefer extending the existing `ignores a reader response after the catalog becomes inactive even if transport ignores abort` coverage rather than duplicating the same scenario.

### Task 2: Verification

- [ ] Run only the focused mobile-client test first from `_tools/app`:

```bash
npm run mobile:test -- Catalog.test.tsx
```

If the package's Vitest wrapper expects a different path form, use the existing package script with the exact `Catalog.test.tsx` filter; do not broaden until the focused suite passes.

- [ ] Because the change is isolated to one existing mobile component, run the mobile-client test group or the package's normal frontend test command only if the focused test passes and the package script makes that grouping available.

- [ ] Inspect the scoped diff:

```bash
git diff -- _tools/app/mobile-client/Catalog.tsx \
  _tools/app/mobile-client/Catalog.test.tsx
```

Confirm there are no edits under `_tools/app/src/manga/`, `server/`, `android/`, or unrelated frontend files.

- [ ] Do **not** commit or push. Report the exact reader request-count evidence and any device-only timing acceptance still needed.
