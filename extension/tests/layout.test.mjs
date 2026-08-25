import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const context = { globalThis: null };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "layout.js" });
const layoutApi = context.LakomicsRadial;

test("uses six, twelve, and paged twelve-slot levels", () => {
  const six = entries(6);
  const seven = entries(7);
  const thirteen = entries(13);

  assert.equal(layoutApi.getLevel(six, layoutApi.resetLayout(six), null, 0).slots.length, 6);
  assert.equal(layoutApi.getLevel(seven, layoutApi.resetLayout(seven), null, 0).slots.length, 12);
  const paged = layoutApi.getLevel(thirteen, layoutApi.resetLayout(thirteen), null, 1);
  assert.equal(paged.pageCount, 2);
  assert.equal(paged.slots.length, 12);
  assert.equal(paged.slots[0].id, "id-12");
  assert.equal(paged.slots[1], null);
});


test("honors an explicit twelve-slot secondary layout even with only one child", () => {
  const current = [
    { id: "root", kind: "root", name: "Root", parentId: null },
    { id: "child", kind: "tag", name: "Child", parentId: "root" },
  ];
  const layout = {
    version: 1,
    parents: {
      root: [[null, null, "child", null, null, null, null, null, null, null, null, null]],
    },
  };

  const level = layoutApi.getLevel(current, layout, "root", 0);

  assert.equal(level.slotCount, 12);
  assert.equal(level.slots.length, 12);
  assert.equal(level.slots[2].id, "child");
});

test("preserves ID positions across rename and fills the first empty slot", () => {
  const original = entries(3);
  const stored = {
    version: 1,
    parents: {
      __root__: [["id-1", null, "id-0", null, "id-2", null]],
    },
  };
  const renamedAndAdded = [
    { ...original[0], name: "Renamed" },
    original[1],
    original[2],
    { id: "id-3", kind: "tag", name: "New", parentId: null },
  ];

  const reconciled = layoutApi.reconcileLayout(renamedAndAdded, stored);

  assert.deepEqual(plain(reconciled.parents.__root__[0]), ["id-1", "id-3", "id-0", null, "id-2", null]);
});

test("removes deleted and moved IDs from their old parent", () => {
  const current = [
    { id: "parent-a", kind: "root", name: "A", parentId: null },
    { id: "parent-b", kind: "root", name: "B", parentId: null },
    { id: "child", kind: "tag", name: "Child", parentId: "parent-b" },
  ];
  const stored = {
    version: 1,
    parents: {
      __root__: [["parent-a", "parent-b", null, null, null, null]],
      "parent-a": [["child", "deleted", null, null, null, null]],
    },
  };

  const reconciled = layoutApi.reconcileLayout(current, stored);

  assert.equal(reconciled.parents["parent-a"], undefined);
  assert.equal(reconciled.parents["parent-b"][0][0], "child");
});

test("swaps occupied and empty slots without changing the tree", () => {
  const current = entries(3);
  const layout = layoutApi.resetLayout(current);

  const moved = layoutApi.moveSlot(layout, null, 0, 4);

  assert.equal(moved.parents.__root__[0][0], null);
  assert.equal(moved.parents.__root__[0][4], "id-0");
  assert.equal(layout.parents.__root__[0][0], "id-0");
});

test("combines roots and pinned children into the pinned first-level ring", () => {
  const pinnedEntries = [
    { id: "game", name: "게임", parentId: null },
    { id: "reverse", name: "리버스", parentId: "game" },
    { id: "manga", name: "만화", parentId: null },
    { id: "zenless", name: "젠레스", parentId: "game" },
  ];
  const pinnedLayout = layoutApi.resetLayout(pinnedEntries);

  assert.equal(layoutApi.PINNED, "__pinned__");

  const level = layoutApi.getPinnedLevel(pinnedEntries, pinnedLayout, ["reverse", "zenless"], 0);
  assert.equal(level.slotCount, 6);
  assert.deepEqual(
    [...level.slots.map((s) => s?.id ?? null)].sort(),
    [...["game", "manga", "reverse", "zenless", null, null]].sort(),
  );
});

test("reorderPinned preserves stored order, drops stale ids, and appends newly visible ids", () => {
  const pinnedEntries = [
    { id: "game", name: "게임", parentId: null },
    { id: "reverse", name: "리버스", parentId: "game" },
    { id: "manga", name: "만화", parentId: null },
    { id: "zenless", name: "젠레스", parentId: "game" },
  ];
  const pinnedLayout = {
    version: 1,
    parents: {
      __pinned__: [["game", "stale", "reverse", "zenless", null, null]],
    },
  };

  const reordered = layoutApi.reorderPinned(pinnedLayout, pinnedEntries, ["reverse", "zenless"]);

  assert.deepEqual(plain(reordered.parents.__pinned__), [["game", "reverse", "zenless", "manga", null, null]]);
});

test("reorderPinned rebuilds pinned pages without mutating the input layout", () => {
  const pinnedEntries = [
    { id: "game", name: "게임", parentId: null },
    { id: "reverse", name: "리버스", parentId: "game" },
    { id: "manga", name: "만화", parentId: null },
    { id: "zenless", name: "젠레스", parentId: "game" },
  ];
  const pinnedLayout = layoutApi.resetLayout(pinnedEntries);

  const reordered = layoutApi.reorderPinned(pinnedLayout, pinnedEntries, ["reverse", "zenless"]);
  const ids = reordered.parents.__pinned__.flat();
  assert.equal(ids.length, 6);
  assert.equal(ids.filter(Boolean).length, 4);
  assert.ok(ids.includes("game"));
  assert.ok(ids.includes("manga"));
  assert.ok(ids.includes("reverse"));
  assert.ok(ids.includes("zenless"));
  assert.equal(pinnedLayout.parents.__pinned__, undefined);
});

function entries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `id-${index}`,
    kind: "tag",
    name: `Entry ${index}`,
    parentId: null,
  }));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
