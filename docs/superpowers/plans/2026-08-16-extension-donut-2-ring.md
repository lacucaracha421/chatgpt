# Edge Extension Donut 2-Ring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the extension radial classification donut from a single ring with slot replacement to a two-ring structure where the second-level ring expands outside the first-level ring.

**Architecture:** The gesture session (`gesture.js`) tracks two concurrent levels: a primary ring (always visible) and an optional secondary ring (expanded on dwell). The hit-test distinguishes three radial zones: center, primary ring, secondary ring. The renderer (`content.js`) draws both rings as SVG sector paths when the secondary is open. `layout.js` is unchanged — it already supports per-parent level queries.

**Tech Stack:** Vanilla JavaScript (browser extension content script), SVG, Node.js test runner (`node --test`)

## Global Constraints

- All user-facing strings in Korean. All code, comments, and internal thinking in English.
- Extension tests: `node --test extension/tests/*.test.mjs` (run from `C:\chatgpt`).
- The extension uses `globalThis.LakomicsRadial`, `globalThis.LakomicsGesture`, `globalThis.LakomicsXSource` for inter-module communication.
- Test files load source via `vm.runInNewContext` — no ES modules in the content scripts.
- No external dependencies. No build step. Pure vanilla JS + SVG.
- DESIGN.md principles apply to the donut visual style (quiet chrome, images are hero, no unnecessary decoration).
- The donut is pointer-driven transient UI: no animations on ring open/close/switch.

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/src/gesture.js` | Gesture session: hit-test for two rings, dwell expansion, ring switching, center close, page controls |
| `extension/src/content.js` | SVG rendering: both rings, center, page controls; removes "위로" back button |
| `extension/src/content.css` | Second-level ring sector styles (dimmer fill/stroke/label) |
| `extension/src/layout.js` | Unchanged — already supports per-parent `getLevel` |
| `extension/tests/gesture.test.mjs` | Updated + new tests for two-ring hit-test, expansion, center close, ring switch |
| `extension/tests/content-controller.test.mjs` | Updated for new snapshot shape (secondary level in snapshot) |

---

### Task 1: Redesign gesture.js for two-ring hit-test

**Files:**
- Modify: `extension/src/gesture.js` (full rewrite of hit-test and state logic)
- Modify: `extension/tests/gesture.test.mjs` (update existing tests, add new ones)

**Interfaces:**
- Consumes: `globalThis.LakomicsRadial.getLevel(entries, layout, parentId, page)` — unchanged
- Produces: `createSession(origin, entries, layout)` → `{ move, tick, release, snapshot }` where `snapshot` now includes both `primaryLevel` and `secondaryLevel` (null when not expanded)

**Snapshot shape change:**
```js
// Old:
{ opened, parentId, path, page, hover, hoverSince, dwellDeadline, level }

// New:
{ opened, expandedParentId, primaryPage, secondaryPage, hover, hoverSince, dwellDeadline,
  primaryLevel, secondaryLevel }
```
- `expandedParentId`: the first-level entry whose children are shown in the secondary ring, or `null` when no secondary ring is open.
- `primaryLevel`: always present when opened — the first-level `getLevel` result.
- `secondaryLevel`: present when `expandedParentId !== null` — the second-level `getLevel` result for that parent's children. `null` otherwise.
- `primaryPage` / `secondaryPage`: page indices for each ring independently.
- `hover`: `{ type: "primary-slot" | "secondary-slot" | "center" | "next" | "previous" | "outside", index?, entry? }`
- `path` is removed (no longer needed — the two-ring model has at most one expansion).

**Constants:**
```js
const OPEN_DISTANCE_PX = 12;
const DWELL_MS = 300;
const CENTER_RADIUS = 42;
const PRIMARY_INNER_RADIUS = 48;
const PRIMARY_OUTER_RADIUS = 110;
const SECONDARY_INNER_RADIUS = 130;
const SECONDARY_OUTER_RADIUS = 185;
const CONTROL_RADIUS = 210;
const CONTROL_HIT_HALF_HEIGHT = 72;
```

- [ ] **Step 1: Write failing tests for new two-ring gesture behavior**

Update `extension/tests/gesture.test.mjs`. Replace the old tests with new ones matching the two-ring model:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const layoutSource = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const gestureSource = fs.readFileSync(new URL("../src/gesture.js", import.meta.url), "utf8");
const context = { globalThis: null };
context.globalThis = context;
vm.runInNewContext(layoutSource, context, { filename: "layout.js" });
vm.runInNewContext(gestureSource, context, { filename: "gesture.js" });
const { createSession } = context.LakomicsGesture;

const tree = [
  { id: "parent", kind: "root", name: "Parent", parentId: null },
  { id: "other", kind: "root", name: "Other", parentId: null },
  { id: "child-a", kind: "tag", name: "Child A", parentId: "parent" },
  { id: "child-b", kind: "tag", name: "Child B", parentId: "parent" },
];
const layout = context.LakomicsRadial.resetLayout(tree);

test("preserves a click below twelve pixels and opens at the threshold", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  assert.equal(session.move({ x: 111, y: 100 }, 0).opened, false);
  assert.deepEqual(plain(session.release()), { type: "click" });

  const opening = createSession({ x: 100, y: 100 }, tree, layout);
  assert.equal(opening.move({ x: 112, y: 100 }, 0).opened, true);
});

test("release before dwell selects a primary and dwell expands secondary ring", () => {
  const immediate = createSession({ x: 100, y: 100 }, tree, layout);
  immediate.move(pointForPrimarySlot(0), 0);
  assert.deepEqual(plain(immediate.release()), { type: "select", classificationId: "parent" });

  const descended = createSession({ x: 100, y: 100 }, tree, layout);
  descended.move(pointForPrimarySlot(0), 0);
  assert.equal(descended.snapshot().secondaryLevel, null);
  const afterDwell = descended.tick(300);
  assert.equal(afterDwell.expandedParentId, "parent");
  assert.equal(afterDwell.secondaryLevel.slots.length, 2);
  assert.equal(afterDwell.secondaryLevel.slots[0].id, "child-a");
});

test("secondary ring hit-test selects a child on release", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  session.move(pointForPrimarySlot(0), 0);
  session.tick(300);
  assert.notEqual(session.snapshot().secondaryLevel, null);
  session.move(pointForSecondarySlot(0, 2), 301);
  const result = session.release();
  assert.deepEqual(plain(result), { type: "select", classificationId: "child-a" });
});

test("center entry closes the secondary ring and selects the parent on release", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  session.move(pointForPrimarySlot(0), 0);
  session.tick(300);
  assert.notEqual(session.snapshot().secondaryLevel, null);
  session.move({ x: 100, y: 100 }, 301);
  assert.equal(session.snapshot().secondaryLevel, null);
  assert.equal(session.snapshot().expandedParentId, null);
  const result = session.release();
  assert.deepEqual(plain(result), { type: "select", classificationId: "parent" });
});

test("ring switch requires 300ms dwell on the new primary", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  session.move(pointForPrimarySlot(0), 0);
  session.tick(300);
  assert.equal(session.snapshot().expandedParentId, "parent");
  session.move(pointForPrimarySlot(1), 301);
  assert.equal(session.snapshot().expandedParentId, "parent");
  session.tick(601);
  assert.equal(session.snapshot().expandedParentId, "other");
});

test("childless primary does not expand on dwell", () => {
  const single = [{ id: "lonely", kind: "root", name: "Lonely", parentId: null }];
  const singleLayout = context.LakomicsRadial.resetLayout(single);
  const session = createSession({ x: 100, y: 100 }, single, singleLayout);
  session.move(pointForPrimarySlot(0, 1), 0);
  session.tick(300);
  assert.equal(session.snapshot().secondaryLevel, null);
  assert.deepEqual(plain(session.release()), { type: "select", classificationId: "lonely" });
});

test("dwell pages through exterior controls for the active ring", () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    id: `root-${index}`, kind: "root", name: `Root ${index}`, parentId: null,
  }));
  const session = createSession({ x: 100, y: 100 }, many, context.LakomicsRadial.resetLayout(many));
  session.move({ x: 260, y: 100 }, 0);
  assert.equal(session.tick(300).primaryPage, 1);
  session.move({ x: -60, y: 100 }, 301);
  assert.equal(session.tick(601).primaryPage, 0);
});

function pointForPrimarySlot(index, count = 2) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = (48 + 110) / 2;
  return { x: 100 + Math.cos(angle) * r, y: 100 + Math.sin(angle) * r };
}

function pointForSecondarySlot(index, count) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = (130 + 185) / 2;
  return { x: 100 + Math.cos(angle) * r, y: 100 + Math.sin(angle) * r };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test extension/tests/gesture.test.mjs`
Expected: FAIL — old gesture.js does not produce the new snapshot shape.

- [ ] **Step 3: Rewrite gesture.js**

Full rewrite of `extension/src/gesture.js`:

```js
(() => {
  "use strict";

  const OPEN_DISTANCE_PX = 12;
  const DWELL_MS = 300;
  const CENTER_RADIUS = 42;
  const PRIMARY_INNER_RADIUS = 48;
  const PRIMARY_OUTER_RADIUS = 110;
  const SECONDARY_INNER_RADIUS = 130;
  const SECONDARY_OUTER_RADIUS = 185;
  const CONTROL_RADIUS = 210;
  const CONTROL_HIT_HALF_HEIGHT = 72;

  function createSession(origin, entries, layout) {
    let opened = false;
    let expandedParentId = null;
    let primaryPage = 0;
    let secondaryPage = 0;
    let hover = null;
    let hoverSince = null;
    let dwellDeadline = null;

    function move(point, time) {
      if (!opened) {
        if (distance(origin, point) < OPEN_DISTANCE_PX) return snapshot();
        opened = true;
      }
      const target = hitTest(point);
      if (!sameTarget(target, hover)) {
        hover = target;
        hoverSince = time;
        dwellDeadline = canDwell(target) ? time + DWELL_MS : null;
      } else if (dwellDeadline !== null && time >= dwellDeadline) {
        applyDwell();
      }
      return snapshot();
    }

    function tick(time) {
      if (opened && dwellDeadline !== null && time >= dwellDeadline) applyDwell();
      return snapshot();
    }

    function release() {
      if (!opened) return { type: "click" };
      if (hover?.type === "secondary-slot" && hover.entry) {
        return { type: "select", classificationId: hover.entry.id };
      }
      if (hover?.type === "primary-slot" && hover.entry) {
        return { type: "select", classificationId: hover.entry.id };
      }
      if (hover?.type === "center" && expandedParentId) {
        return { type: "select", classificationId: expandedParentId };
      }
      if (hover?.type === "center") {
        return { type: "cancel" };
      }
      return { type: "cancel" };
    }

    function hitTest(point) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      const radius = Math.hypot(dx, dy);

      if (radius <= CENTER_RADIUS) return { type: "center" };

      if (expandedParentId !== null && radius >= SECONDARY_INNER_RADIUS && radius <= SECONDARY_OUTER_RADIUS) {
        const level = currentSecondaryLevel();
        const sector = (Math.PI * 2) / level.slotCount;
        const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const index = Math.floor(((angle + sector / 2) % (Math.PI * 2)) / sector);
        return { type: "secondary-slot", index, entry: level.slots[index] ?? null };
      }

      if (radius >= PRIMARY_INNER_RADIUS && radius <= PRIMARY_OUTER_RADIUS) {
        const level = currentPrimaryLevel();
        const sector = (Math.PI * 2) / level.slotCount;
        const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const index = Math.floor(((angle + sector / 2) % (Math.PI * 2)) / sector);
        return { type: "primary-slot", index, entry: level.slots[index] ?? null };
      }

      if (radius <= CONTROL_RADIUS && Math.abs(dy) <= CONTROL_HIT_HALF_HEIGHT) {
        if (dx > SECONDARY_OUTER_RADIUS) {
          if (expandedParentId !== null) {
            const level = currentSecondaryLevel();
            if (secondaryPage + 1 < level.pageCount) return { type: "next" };
          } else {
            const level = currentPrimaryLevel();
            if (primaryPage + 1 < level.pageCount) return { type: "next" };
          }
        }
        if (dx < -SECONDARY_OUTER_RADIUS) {
          if (expandedParentId !== null) {
            if (secondaryPage > 0) return { type: "previous" };
          } else {
            if (primaryPage > 0) return { type: "previous" };
          }
        }
      }
      return { type: "outside" };
    }

    function canDwell(target) {
      if (target?.type === "next" || target?.type === "previous") return true;
      if (target?.type !== "primary-slot") return false;
      if (!target.entry) return false;
      return entries.some((entry) => entry.parentId === target.entry.id);
    }

    function applyDwell() {
      if (hover?.type === "primary-slot" && hover.entry
        && entries.some((entry) => entry.parentId === hover.entry.id)) {
        if (expandedParentId !== hover.entry.id) {
          expandedParentId = hover.entry.id;
          secondaryPage = 0;
        }
      } else if (hover?.type === "next") {
        if (expandedParentId !== null) secondaryPage += 1;
        else primaryPage += 1;
      } else if (hover?.type === "previous") {
        if (expandedParentId !== null) secondaryPage -= 1;
        else primaryPage -= 1;
      }
      hover = null;
      hoverSince = null;
      dwellDeadline = null;
    }

    function currentPrimaryLevel() {
      return globalThis.LakomicsRadial.getLevel(entries, layout, null, primaryPage);
    }

    function currentSecondaryLevel() {
      return globalThis.LakomicsRadial.getLevel(entries, layout, expandedParentId, secondaryPage);
    }

    function snapshot() {
      const primaryLevel = currentPrimaryLevel();
      primaryPage = primaryLevel.page;
      const secondaryLevel = expandedParentId !== null ? currentSecondaryLevel() : null;
      if (secondaryLevel) secondaryPage = secondaryLevel.page;
      return {
        opened,
        expandedParentId,
        primaryPage,
        secondaryPage,
        hover,
        hoverSince,
        dwellDeadline,
        primaryLevel,
        secondaryLevel,
      };
    }

    return { move, tick, release, snapshot };
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function sameTarget(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === "primary-slot" || a.type === "secondary-slot") return a.index === b.index;
    return true;
  }

  globalThis.LakomicsGesture = {
    OPEN_DISTANCE_PX,
    DWELL_MS,
    CENTER_RADIUS,
    PRIMARY_INNER_RADIUS,
    PRIMARY_OUTER_RADIUS,
    SECONDARY_INNER_RADIUS,
    SECONDARY_OUTER_RADIUS,
    CONTROL_RADIUS,
    createSession,
    distance,
  };
})();
```

Key logic notes for the implementer:
- **Center closes secondary**: When `hitTest` returns `center` and `expandedParentId !== null`, the `move` function's hover change to `center` does NOT directly close the secondary. Instead, `release()` checks: if hover is `center` and `expandedParentId` is set, it selects the parent. The secondary ring stays visible until release. BUT — per Q12, entering center should close the secondary immediately. So: in `move`, when the new target is `center` and `expandedParentId !== null`, set `expandedParentId = null` and `secondaryPage = 0`. This closes the secondary ring on center entry, and then release in center selects the parent (since `expandedParentId` is now null, release returns cancel). Wait — Q12 says "entering center closes secondary, releasing in center selects the current first-level item." So we need to remember which parent was expanded even after closing. Add `lastExpandedParentId` to track it.

  **Revised center handling**: In `move`, when target becomes `center`:
  - If `expandedParentId !== null`: set `lastExpandedParentId = expandedParentId`, then `expandedParentId = null`, `secondaryPage = 0`. The secondary ring closes.
  - In `release`: if hover is `center` and `lastExpandedParentId` is set, select `lastExpandedParentId`. If hover is `center` and `lastExpandedParentId` is null, cancel.

  Add `lastExpandedParentId` to the session state. Reset it when the pointer moves to a non-center target.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/tests/gesture.test.mjs`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/gesture.js extension/tests/gesture.test.mjs
git commit -m "feat: redesign gesture session for two-ring donut hit-test"
```

---

### Task 2: Update content.js rendering for two rings

**Files:**
- Modify: `extension/src/content.js` (render functions)
- Modify: `extension/src/content.css` (secondary ring styles)
- Modify: `extension/tests/content-controller.test.mjs` (snapshot shape)

**Interfaces:**
- Consumes: new snapshot shape from gesture.js (`primaryLevel`, `secondaryLevel`, `expandedParentId`, `primaryPage`, `secondaryPage`)
- Produces: SVG with both rings rendered when secondary is open

- [ ] **Step 1: Write failing test for two-ring rendering**

In `content-controller.test.mjs`, update the `loadContent` helper to handle the new snapshot. The existing tests call `controller.move()` which triggers `renderSnapshot` — the test mock `snapshot` function receives the new shape. Update any assertions that check snapshot fields.

Add a new test:

```js
test("secondary ring expands on dwell and renders child slots", async () => {
  const api = loadContent(async () => ({ ok: true, status: "added" }));
  const controller = api.createCollectorController({ send: api.send, status() {} });
  const entries = [
    { id: "parent", kind: "root", name: "Parent", parentId: null },
    { id: "child", kind: "tag", name: "Child", parentId: "parent" },
  ];
  const layout = api.radial.resetLayout(entries);
  controller.begin({ mediaUrl: "https://x.com/img.jpg", sourceUrl: "https://x.com/u/1" }, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  controller.tick(300);
  const lastSnapshot = api.lastSnapshot;
  assert.notEqual(lastSnapshot.secondaryLevel, null);
  assert.equal(lastSnapshot.secondaryLevel.slots[0].id, "child");
});
```

Note: the `loadContent` helper needs to expose `lastSnapshot` — check the existing test file for how `snapshot` is mocked and add a `lastSnapshot` capture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test extension/tests/content-controller.test.mjs`
Expected: FAIL — content.js still uses old snapshot shape.

- [ ] **Step 3: Rewrite renderSnapshot and renderSectors in content.js**

Update `renderSnapshot` to use the new snapshot fields:

```js
function renderSnapshot(snapshot) {
  if (!pointer || !snapshot?.opened) return;
  closeRadial();
  overlay = document.createElement("div");
  overlay.className = "lakomics-radial-overlay";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "-220 -220 440 440");
  svg.style.left = `${pointer.origin.x}px`;
  svg.style.top = `${pointer.origin.y}px`;
  svg.classList.add("lakomics-radial-menu");
  renderPrimarySectors(svg, snapshot);
  if (snapshot.secondaryLevel) renderSecondarySectors(svg, snapshot);
  renderCenter(svg, snapshot);
  renderControls(svg, snapshot);
  overlay.append(svg);
  document.documentElement.append(overlay);
}
```

Update viewBox to `-220 -220 440 440` to fit the secondary ring (185px radius + margin).

`renderPrimarySectors` (replaces `renderSectors`):

```js
function renderPrimarySectors(svg, snapshot) {
  const count = snapshot.primaryLevel.slotCount;
  snapshot.primaryLevel.slots.forEach((entry, index) => {
    const start = -Math.PI / 2 + (Math.PI * 2 * (index - 0.5)) / count;
    const end = -Math.PI / 2 + (Math.PI * 2 * (index + 0.5)) / count;
    const path = svgElement("path", {
      d: sectorPath(48, 110, start, end),
      class: `lakomics-sector${snapshot.hover?.type === "primary-slot" && snapshot.hover.index === index ? " is-active" : ""}${entry ? "" : " is-empty"}${snapshot.expandedParentId === entry?.id ? " is-expanded" : ""}`,
    });
    svg.append(path);
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
    const text = svgElement("text", {
      x: Math.cos(angle) * 79,
      y: Math.sin(angle) * 79,
      class: "lakomics-sector-label",
    });
    text.textContent = entry?.name ?? "";
    svg.append(text);
  });
}
```

`renderSecondarySectors` (new):

```js
function renderSecondarySectors(svg, snapshot) {
  const count = snapshot.secondaryLevel.slotCount;
  snapshot.secondaryLevel.slots.forEach((entry, index) => {
    const start = -Math.PI / 2 + (Math.PI * 2 * (index - 0.5)) / count;
    const end = -Math.PI / 2 + (Math.PI * 2 * (index + 0.5)) / count;
    const path = svgElement("path", {
      d: sectorPath(130, 185, start, end),
      class: `lakomics-sector-secondary${snapshot.hover?.type === "secondary-slot" && snapshot.hover.index === index ? " is-active" : ""}${entry ? "" : " is-empty"}`,
    });
    svg.append(path);
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
    const text = svgElement("text", {
      x: Math.cos(angle) * 157,
      y: Math.sin(angle) * 157,
      class: "lakomics-sector-label-secondary",
    });
    text.textContent = entry?.name ?? "";
    svg.append(text);
  });
}
```

Update `renderCenter` to use `expandedParentId`:

```js
function renderCenter(svg, snapshot) {
  const circle = svgElement("circle", {
    cx: 0, cy: 0, r: 42,
    class: `lakomics-radial-center${snapshot.hover?.type === "center" ? " is-active" : ""}`,
  });
  const label = svgElement("text", { x: 0, y: 4, class: "lakomics-center-label" });
  const parentEntry = snapshot.primaryLevel.slots.find((s) => s?.id === snapshot.expandedParentId);
  label.textContent = parentEntry?.name ?? "취소";
  svg.append(circle, label);
}
```

Update `renderControls` to use the new page fields and remove "위로":

```js
function renderControls(svg, snapshot) {
  const activePage = snapshot.secondaryLevel ? snapshot.secondaryPage : snapshot.primaryPage;
  const activePageCount = snapshot.secondaryLevel ? snapshot.secondaryLevel.pageCount : snapshot.primaryLevel.pageCount;
  if (activePage > 0) renderControl(svg, -195, 0, "‹", snapshot.hover?.type === "previous");
  if (activePage + 1 < activePageCount) renderControl(svg, 195, 0, "›", snapshot.hover?.type === "next");
}
```

Remove the "위로" back control rendering entirely. Adjust control x positions to 195px (outside secondary ring).

Update `scheduleDwell` in the content script: the `dwellDeadline` is still in the snapshot, so the dwell timer logic stays the same.

- [ ] **Step 4: Add secondary ring CSS**

Add to `extension/src/content.css`:

```css
.lakomics-sector-secondary {
  fill: rgb(24 25 29 / 92%);
  stroke: #3a3d47;
  stroke-width: 1.5;
}

.lakomics-sector-secondary.is-active {
  fill: #2f6db5;
  stroke: #8ec4ff;
}

.lakomics-sector-secondary.is-empty {
  fill: rgb(20 21 25 / 78%);
  stroke-dasharray: 4 4;
}

.lakomics-sector-label-secondary {
  fill: #d8dbe0;
  font-size: 12px;
  font-weight: 600;
  text-anchor: middle;
  dominant-baseline: middle;
  pointer-events: none;
}

.lakomics-sector.is-expanded {
  fill: #2a3f5f;
  stroke: #5a8ab5;
}
```

The `.is-expanded` class highlights the primary sector whose children are shown in the secondary ring.

Update the SVG container size in CSS:

```css
.lakomics-radial-menu {
  position: fixed;
  width: 440px;
  height: 440px;
  transform: translate(-50%, -50%);
  overflow: visible;
  filter: drop-shadow(0 10px 28px rgb(0 0 0 / 55%));
}
```

- [ ] **Step 5: Run tests**

Run: `node --test extension/tests/content-controller.test.mjs`
Expected: PASS

- [ ] **Step 6: Run all extension tests**

Run: `node --test extension/tests/*.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add extension/src/content.js extension/src/content.css extension/tests/content-controller.test.mjs
git commit -m "feat: render two-ring donut with secondary expansion"
```

---

### Task 3: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run all extension tests**

Run: `node --test extension/tests/*.test.mjs`
Expected: All pass.

- [ ] **Step 2: Verify no regressions in desktop app tests**

Run: `cmd.exe /c npx vitest run` (workdir: `app`)
Expected: 340 tests pass.

- [ ] **Step 3: Commit if any stray changes**

```bash
git add -A
git commit -m "chore: verify extension donut 2-ring end to end"
```

---

## Self-Review

**Spec coverage:**
- Two-ring structure (primary always visible, secondary expands outside): Task 1 (gesture hit-test) + Task 2 (rendering) ✅
- Dynamic slot count (not fixed 6): Task 1 uses `getLevel` which returns dynamic counts ✅
- 12+ items paginate with page controls: Task 1 (hit-test for next/previous per active ring) + Task 2 (render controls) ✅
- 300ms dwell expansion: Task 1 (`canDwell` + `applyDwell`) ✅
- Center closes secondary + selects parent: Task 1 (center handling in move + release) ✅
- Ring switch requires 300ms re-dwell: Task 1 (`canDwell` only triggers on primary-slot with children) ✅
- Childless primary does not expand: Task 1 (`canDwell` checks children existence) ✅
- No third-level: Task 1 (secondary-slot is not a dwell target — `canDwell` only checks primary-slot) ✅
- No animation: Task 2 (immediate rendering, no CSS transitions) ✅
- No "위로" back button: Task 2 (removed from renderControls) ✅
- Visual style (dimmer secondary, expanded highlight): Task 2 (CSS) ✅
- Radii: Task 1 (constants: 48/110, 130/185) ✅

**Placeholder scan:** No TBDs. All code blocks are complete implementations.

**Type consistency:** Snapshot shape is consistent across gesture.js (produces) → content.js (consumes) → tests (assert). `primaryLevel`/`secondaryLevel` field names match throughout. Hover types (`primary-slot`/`secondary-slot`/`center`/`next`/`previous`/`outside`) match between hit-test and render checks.