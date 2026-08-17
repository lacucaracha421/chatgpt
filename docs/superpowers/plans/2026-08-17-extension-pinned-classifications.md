# Extension Pinned Classifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an options-page pin feature so selected child classifications can appear in the extension's first-level radial ring without changing the desktop app's classification tree.

**Architecture:** Extend `layout.js` with a virtual `__pinned__` parent that combines root entries and pinned entries into one first-level ring. Store pinned ids in `chrome.storage.local`. Update the background worker, options page, and gesture session to use the pinned first-level ring.

**Tech Stack:** Vanilla JS, Chrome extension APIs (`chrome.runtime.sendMessage`, `chrome.storage.local`), Node test runner.

## Global Constraints

- No animation in the radial menu.
- Two-ring maximum; third-level expansion stays out of scope.
- English code and comments; Korean only for user-facing strings.
- Tests must pass before claiming completion.

---

### Task 1: Layout support for pinned first-level ring

**Files:**
- Modify: `extension/src/layout.js`
- Test: `extension/tests/layout.test.mjs`

**Interfaces:**
- Produces: `LakomicsRadial.PINNED`, `LakomicsRadial.getPinnedLevel(entries, layout, pinnedIds, page)`, `LakomicsRadial.togglePinned(layout, entries, entryId)`.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/layout.test.mjs
const { getPinnedLevel, togglePinned, PINNED } = context.LakomicsRadial;

const entries = [
  { id: "game", name: "게임", parentId: null },
  { id: "reverse", name: "리버스", parentId: "game" },
  { id: "manga", name: "만화", parentId: null },
  { id: "zenless", name: "젠레스", parentId: "game" },
];
const layout = context.LakomicsRadial.resetLayout(entries);

assert.equal(PINNED, "__pinned__");

const level = getPinnedLevel(entries, layout, ["reverse", "zenless"], 0);
assert.equal(level.slotCount, 6);
assert.deepEqual(level.slots.map((s) => s?.id).sort(), ["game", "manga", "reverse", "zenless", null, null].sort());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extension/tests/layout.test.mjs`
Expected: FAIL with `getPinnedLevel is not a function`

- [ ] **Step 3: Write minimal implementation**

In `extension/src/layout.js`:
- Add `const PINNED = "__pinned__";`
- Add helper `isFirstLevelVisible(entry, pinnedIds)`: returns `entry.parentId === null || pinnedIds?.has(entry.id)`.
- Add `getPinnedLevel(entries, layout, pinnedIds, page)`:
  - `const children = entries.filter((e) => isFirstLevelVisible(e, pinnedIds));`
  - `const count = slotCount(children.length);`
  - Read/write `layout.parents[PINNED]`.
  - Same return shape as `getLevel`.
- Add `togglePinned(layout, entries, entryId)`:
  - Deep clone layout.
  - Find entry and collect currently pinned ids from layout `__pinned__` pages (flatten) OR accept current pinned set.
  - Actually, toggle should know the current pinned list. Simpler: expose `reorderPinned(layout, entries, pinnedIds)` and let the caller manage the set.
  - Provide `reorderPinned(layout, entries, pinnedIds)` that rebuilds `__pinned__` pages from root + pinned entries in a stable order.

```js
function getPinnedLevel(entries, layout, pinnedIds, requestedPage) {
  const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  const children = entries.filter((entry) => entry?.parentId === null || pinnedSet.has(entry.id));
  const count = slotCount(children.length);
  const pages = layout?.parents?.[PINNED] ?? [Array(count).fill(null)];
  const pageCount = Math.max(1, pages.length);
  const page = Math.min(Math.max(0, Number(requestedPage) || 0), pageCount - 1);
  const byId = new Map(children.map((entry) => [entry.id, entry]));
  const ids = [...(pages[page] ?? [])];
  while (ids.length < count) ids.push(null);
  return {
    parentId: PINNED,
    page,
    pageCount,
    slotCount: count,
    slots: ids.slice(0, count).map((id) => (id ? byId.get(id) ?? null : null)),
  };
}

function reorderPinned(layout, entries, pinnedIds) {
  const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
  const children = entries.filter((entry) => entry?.parentId === null || pinnedSet.has(entry.id));
  const count = slotCount(children.length);
  const pages = layout?.parents?.[PINNED] ?? [Array(count).fill(null)];
  const oldFlat = pages.flat();
  const byId = new Map(children.map((entry) => [entry.id, entry]));
  const ordered = [];
  for (const id of oldFlat) {
    if (id && byId.has(id)) { ordered.push(id); byId.delete(id); }
  }
  for (const entry of children) {
    if (byId.has(entry.id)) { ordered.push(entry.id); byId.delete(entry.id); }
  }
  while (ordered.length < pages.flat().length) ordered.push(null);
  const next = JSON.parse(JSON.stringify(layout));
  next.parents[PINNED] = chunk(ordered, pages[0]?.length ?? count);
  return next;
}
```

Export `PINNED`, `getPinnedLevel`, `reorderPinned`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extension/tests/layout.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit (user-requested)**

Wait for user explicit commit request per repository policy.

---

### Task 2: Background worker pinned storage

**Files:**
- Modify: `extension/src/background.js`
- Test: `extension/tests/background.test.mjs` (extend existing)

**Interfaces:**
- Consumes: `classifications:refresh` still returns entries/layout; now also returns `pinnedIds`.
- Produces: `pinned:get` and `pinned:set` messages.

- [ ] **Step 1: Write the failing test**

```js
const response = await handleMessage({ type: "pinned:get" });
assert.equal(response.ok, true);
assert.deepEqual(response.pinnedIds, []);

const setResponse = await handleMessage({ type: "pinned:set", pinnedIds: ["reverse"] });
assert.equal(setResponse.ok, true);

const afterSet = await handleMessage({ type: "pinned:get" });
assert.deepEqual(afterSet.pinnedIds, ["reverse"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extension/tests/background.test.mjs`
Expected: FAIL with `unknown_message` or missing handler.

- [ ] **Step 3: Write minimal implementation**

In `extension/src/background.js`:
- Load `pinnedClassificationIds` in `classifications:refresh` and include in cache/response.
- Add cases:
  - `case "pinned:get": return { ok: true, pinnedIds: await loadPinned() };`
  - `case "pinned:set": if (!Array.isArray(message.pinnedIds)) return { ok: false, code: "invalid_pinned" }; await chrome.storage.local.set({ pinnedClassificationIds: message.pinnedIds }); return { ok: true };`
- Add `async function loadPinned()` that reads `pinnedClassificationIds` from storage and returns array.
- Update `classificationCache` to include `pinnedIds`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extension/tests/background.test.mjs`
Expected: PASS

---

### Task 3: Options page pin UI

**Files:**
- Modify: `extension/options/options.js`
- Modify: `extension/options/options.css`
- Test: manual only (UI wiring)

**Interfaces:**
- Consumes: `pinned:get`, `pinned:set`, `classifications:refresh` responses, `LakomicsRadial.getPinnedLevel`, `LakomicsRadial.reorderPinned`, `LakomicsRadial.moveSlot`.

- [ ] **Step 1: Load and render pinned state**

In `extension/options/options.js`:
- Add `let pinnedIds = [];`.
- In `initialize()`, also call `pinned:get` and populate `pinnedIds`.
- In refresh button handler, capture `response.pinnedIds` into `pinnedIds`.
- Replace `getLevel` call in `renderEditor` with `getPinnedLevel(entries, workingLayout, pinnedIds, page)` when `path.length === 0`; keep `getLevel` for deeper levels.
- Remove the hardcoded `ROOT_PRESET_ORDER` and the "기본 순서로 정렬" button added earlier.

- [ ] **Step 2: Add pin toggle to each slot**

For each rendered slot button, append a small pin button:
- Only for entries that are not root (`entry.parentId !== null`).
- Text: "고정" when not pinned, "해제" when pinned.
- Clicking it toggles the id in `pinnedIds`, calls `workingLayout = LakomicsRadial.reorderPinned(workingLayout, entries, pinnedIds)`, and re-renders.
- Stop propagation so it doesn't trigger slot selection.

- [ ] **Step 3: Save pinned ids with layout**

In `saveLayout()`:
- Also send `pinned:set` with current `pinnedIds`.
- Update status text to mention both saved.

- [ ] **Step 4: Style pin toggle**

In `extension/options/options.css`:
- Add `.radial-slot-pin` class with small size, absolute position, accent color when pinned.

- [ ] **Step 5: Run extension tests**

Run: `node --test extension/tests/*.test.mjs`
Expected: PASS

---

### Task 4: Gesture session uses pinned first level

**Files:**
- Modify: `extension/src/gesture.js`
- Test: `extension/tests/gesture.test.mjs`

**Interfaces:**
- Consumes: `response.pinnedIds` from `classifications:refresh`; `LakomicsRadial.getPinnedLevel`.

- [ ] **Step 1: Write the failing test**

```js
const tree = [
  { id: "game", kind: "root", name: "게임", parentId: null },
  { id: "reverse", kind: "tag", name: "리버스", parentId: "game" },
  { id: "reverse-child", kind: "tag", name: "리버스 하위", parentId: "reverse" },
];
const layout = context.LakomicsRadial.resetLayout(tree);
const session = createSession({ x: 100, y: 100 }, tree, layout, ["reverse"]);
session.move(pointForPinnedSlot(0, 6), 0); // or find reverse slot
session.tick(300);
assert.equal(session.snapshot().expandedParentId, "reverse");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extension/tests/gesture.test.mjs`
Expected: FAIL

- [ ] **Step 3: Update gesture session**

In `extension/src/gesture.js`:
- `createSession(origin, entries, layout, pinnedIds = [])` signature change.
- `currentPrimaryLevel()` uses `getPinnedLevel(entries, workingLayout, pinnedIds, primaryPage)`.
- Store `pinnedIds` in session state.

- [ ] **Step 4: Update content.js call site**

In `extension/src/content.js`:
- `controller.begin(...)` passes `pointer.classifications.pinnedIds` to `createSession`.

- [ ] **Step 5: Update background.js `classifications:get` response**

Ensure `classifications:get` and `classifications:refresh` return `pinnedIds`.

- [ ] **Step 6: Run tests**

Run: `node --test extension/tests/*.test.mjs`
Expected: PASS

---

### Task 5: Update existing design spec if needed

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-extension-pinned-classifications-design.md`

- [ ] **Step 1: Add final interface summary**

Document exact function signatures and storage keys after implementation.

---

### Task 6: Regression check

**Files:**
- All extension tests and desktop app tests.

- [ ] **Step 1: Run extension tests**

Run: `node --test extension/tests/*.test.mjs`
Expected: PASS

- [ ] **Step 2: Run desktop tests**

Run vitest in `app/`
Expected: PASS

## Self-Review

- **Spec coverage:** All spec sections map to tasks above.
- **Placeholder scan:** No TBDs; each step includes concrete code or exact commands.
- **Type consistency:** `PINNED`, `getPinnedLevel`, `reorderPinned` exported from `layout.js`; `pinnedIds` is always `string[]`.
