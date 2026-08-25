# Manga Collection Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing manga Collection overlay into the approved shelf-first production detail, move MangaDex/Aladin/Release Watch actions out of the top toolbar, and preserve the existing collectible cover viewer.

**Architecture:** Keep `CollectionOverlay` as the data-loading and command-orchestration boundary, because it already owns every required provider and volume operation. Recompose only its manga render branch with the existing `CollectionInfoPanel`, `CollectionVolumeGrid`, and `MangaCoverViewer`; use the shared `Menu` for provider actions and leave non-manga behavior unchanged.

**Tech Stack:** React 19, TypeScript 7, Radix Dropdown Menu/Dialog through existing shared UI, Vitest, Testing Library, existing Lakomics CSS tokens.

## Global Constraints

- Follow `DESIGN.md` and `docs/agents/lakomics-works-handoff-v2.md`.
- Match the intent of `docs/prototypes/lakomics-works-v6-reference.html`; do not copy its standalone HTML.
- Do not add dependencies, backend commands, migrations, provider interfaces, or Online Catalog integration.
- Keep the application top toolbar stable; manga-specific provider actions belong inside the detail workspace.
- Manga volume order is primary and the shelf has no date rail.
- Clicking an available volume cover opens cover appreciation, not a metadata dialog.
- Keep collectible motion restrained and honor the existing reduced-motion behavior.
- Preserve all unrelated dirty work and stage only files named by each task.

---

### Task 1: Move manga provider actions into the detail menu

**Files:**
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Test: `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Consumes: existing `Menu({ label, trigger, items })`, `refresh()`, `refreshAladin()`, `toggleReleaseWatch()`, `setImportOpen(true)`, and `setAladinOpen(true)`.
- Produces: a visible text-labelled `연결 및 갱신` menu inside the manga detail workspace; the `ViewToolbar` retains only the close action.

- [ ] **Step 1: Write the failing provider-menu tests**

Replace direct toolbar-button expectations with tests that assert provider actions are absent before opening the menu and available as menu items afterward:

```tsx
const providerMenu = await screen.findByRole("button", { name: "연결 및 갱신" });
expect(screen.queryByRole("button", { name: "MangaDex 연결" })).not.toBeInTheDocument();
await user.click(providerMenu);
await user.click(screen.getByRole("menuitem", { name: "MangaDex 연결" }));
expect(screen.getByRole("heading", { name: "MangaDex 연결" })).toBeInTheDocument();
```

For connected providers, open the same menu and activate `MangaDex 새로고침`, `Aladin 새로고침`, and the current `신간 알림 켜기`/`신간 알림 끄기` label. Retain the existing assertions for gateway calls, local shelf preservation, error toasts, and dialog isolation.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run app/src/collections/CollectionOverlay.test.tsx`

Expected: FAIL because provider actions are still individual toolbar buttons and there is no `연결 및 갱신` trigger.

- [ ] **Step 3: Implement the minimal shared-menu composition**

Import `Menu` and render it inside the manga detail body with a visible text trigger:

```tsx
<Menu
  label="연결 및 갱신"
  trigger={<span>연결 및 갱신</span>}
  items={[
    {
      id: "mangadex",
      label: mangaDexConnection ? "MangaDex 새로고침" : "MangaDex 연결",
      disabled: mangaDexConnection === undefined || refreshing,
      onSelect: () => mangaDexConnection ? void refresh() : setImportOpen(true),
    },
    {
      id: "aladin",
      label: aladinConnection ? "Aladin 새로고침" : "Aladin 연결",
      disabled: aladinConnection === undefined || aladinRefreshing,
      onSelect: () => aladinConnection ? void refreshAladin() : setAladinOpen(true),
    },
    ...(aladinConnection && releaseWatchStatus ? [{
      id: "release-watch",
      label: releaseWatchStatus.enabled ? "신간 알림 끄기" : "신간 알림 켜기",
      disabled: releaseWatchSaving,
      onSelect: () => void toggleReleaseWatch(),
    }] : []),
  ]}
/>
```

Remove the three manga-specific `Button` blocks from `ViewToolbar.actions`; keep the icon-labelled close button unchanged. Do not create a second menu component or duplicate provider command functions.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --run app/src/collections/CollectionOverlay.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the provider-menu change**

```bash
git add app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx
git commit -m "feat: move manga provider actions into detail"
```

### Task 2: Recompose manga detail around the volume shelf

**Files:**
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionVolumeGrid.tsx`
- Modify: `app/src/styles/global.css`
- Test: `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Consumes: `CollectionInfoPanel`, `CollectionVolumeGrid`, `ReleaseWatchSummary`, `MangaCoverViewer`, `volumes`, `editionIndex`, `selectedVolumeId`, and the provider menu from Task 1.
- Produces: `.collection-overlay__manga-layout` with the ordered shelf as the main region and `.collection-overlay__manga-aside` for work information/provider controls; non-manga `.collection-overlay__body` remains unchanged.

- [ ] **Step 1: Write the failing shelf-first composition test**

Add assertions that the manga detail uses a single shelf-first layout, does not render the generic hero or selected-volume metadata panel, and keeps the viewer behavior:

```tsx
const detail = screen.getByRole("region", { name: "만화 상세" });
expect(detail.querySelector(".collection-overlay__manga-layout")).not.toBeNull();
expect(detail.querySelector(".collection-overlay__hero")).toBeNull();
expect(screen.queryByRole("heading", { name: "선택한 권" })).not.toBeInTheDocument();
expect(await screen.findByRole("heading", { name: "권별 표지" })).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "2권 표지" }));
expect(screen.getByRole("dialog", { name: "던전밥 2권 표지 감상" })).toBeInTheDocument();
```

Keep the existing ordering, edition drawer, placeholder, focus restoration, release summary, and provider failure assertions.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run app/src/collections/CollectionOverlay.test.tsx`

Expected: FAIL because manga currently renders the generic hero/detail block and `선택한 권` panel.

- [ ] **Step 3: Implement the manga-only layout branch**

Render manga separately from the generic cover overlay:

```tsx
{isManga ? (
  <div className="collection-overlay__manga-layout" role="region" aria-label="만화 상세">
    <main className="collection-overlay__manga-main">
      {volumes !== null && (
        <CollectionVolumeGrid
          volumes={volumes}
          selectedVolumeId={selectedVolumeId}
          editionIndex={editionIndex}
          onEditionIndexChange={selectEdition}
          onSelect={openVolume}
        />
      )}
    </main>
    <aside className="collection-overlay__manga-aside">
      {collection && <CollectionInfoPanel collection={collection} />}
      {providerMenu}
    </aside>
  </div>
) : (
  <>
    {/* existing non-manga hero/details and CollectionCoverGrid */}
  </>
)}
```

Delete manga use of the generic hero and `CollectionVolumePanel`; remove now-unused manga hero state derivation/imports only if TypeScript proves they are unused. Keep `selectedVolumeId` because it drives viewer selection and focus state in the shelf.

In `CollectionVolumeGrid`, keep numeric sorting and edition drawers, but expose the current grid as the main shelf without adding dates, cards, or another wrapper component.

- [ ] **Step 4: Apply the production CSS using existing tokens**

Add a dense two-column manga layout: `minmax(0, 1fr)` shelf plus a restrained fixed-width information sheet, collapsing to one column at the existing narrow breakpoint. Remove or stop using manga-only generic-hero rules. Preserve 4–12px spacing, 0–2px cover radii, flat manga covers, existing selection outline, existing viewer motion, and existing `prefers-reduced-motion` behavior. Do not add gradients, decorative shadows, hover scaling, or raw colors where a token already exists.

- [ ] **Step 5: Run the focused tests and type/build check**

Run: `npm test -- --run app/src/collections/CollectionOverlay.test.tsx app/src/collections/MangaCoverViewer.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: PASS; the existing Vite chunk-size warning is acceptable.

- [ ] **Step 6: Commit the shelf-first detail**

```bash
git add app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionVolumeGrid.tsx app/src/collections/CollectionOverlay.test.tsx app/src/styles/global.css
git commit -m "feat: build shelf-first manga collection detail"
```

### Task 3: Verify the production manga detail as one coherent flow

**Files:**
- Modify only if verification exposes a regression: `app/src/collections/CollectionOverlay.tsx`
- Modify only if verification exposes a regression: `app/src/collections/MangaCoverViewer.tsx`
- Modify only if verification exposes a regression: `app/src/styles/global.css`
- Test: `app/src/collections/CollectionOverlay.test.tsx`
- Test: `app/src/collections/MangaCoverViewer.test.tsx`
- Test: `app/src/collections/AladinConnectDialog.test.tsx`
- Test: `app/src/collections/MangaDexImportDialog.test.tsx`

**Interfaces:**
- Consumes: the complete manga detail flow from Tasks 1–2.
- Produces: evidence that local browsing survives provider failures, all provider actions are keyboard reachable, and cover appreciation remains keyboard navigable and dismissible.

- [ ] **Step 1: Run the focused manga detail suite**

Run: `npm test -- --run app/src/collections/CollectionOverlay.test.tsx app/src/collections/MangaCoverViewer.test.tsx app/src/collections/AladinConnectDialog.test.tsx app/src/collections/MangaDexImportDialog.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run the Collection integration tests**

Run: `npm test -- --run app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionCard.test.tsx app/src/collections/collectionLibrary.test.ts`

Expected: PASS, proving list state and card behavior still integrate with detail navigation.

- [ ] **Step 3: Run the production build once**

Run: `npm run build`

Expected: PASS; the existing Vite chunk-size warning is acceptable.

- [ ] **Step 4: Commit only if verification required a correction**

If a correction was necessary, stage only its exact files and commit:

```bash
git add app/src/collections/CollectionOverlay.tsx app/src/collections/MangaCoverViewer.tsx app/src/collections/CollectionOverlay.test.tsx app/src/collections/MangaCoverViewer.test.tsx app/src/styles/global.css
git commit -m "fix: preserve manga detail interactions"
```

If no correction was necessary, do not create an empty commit.
