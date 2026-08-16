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
const { createSession, secondaryAngles, primaryAngle } = context.LakomicsGesture;

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
  assert.equal(afterDwell.secondaryLevel.slots.length, 6);
  assert.equal(afterDwell.secondaryLevel.slots[0].id, "child-a");
  assert.equal(afterDwell.secondaryLevel.slots[1].id, "child-b");
});

test("secondary ring hit-test selects a child on release", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  session.move(pointForPrimarySlot(0), 0);
  session.tick(300);
  assert.notEqual(session.snapshot().secondaryLevel, null);
  session.move(pointForSecondarySlot(0, 0, 6, 6), 301);
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
  const switchTree = [
    { id: "parent", kind: "root", name: "Parent", parentId: null },
    { id: "other", kind: "root", name: "Other", parentId: null },
    { id: "child-a", kind: "tag", name: "Child A", parentId: "parent" },
    { id: "child-b", kind: "tag", name: "Child B", parentId: "parent" },
    { id: "child-c", kind: "tag", name: "Child C", parentId: "other" },
  ];
  const switchLayout = context.LakomicsRadial.resetLayout(switchTree);
  const session = createSession({ x: 100, y: 100 }, switchTree, switchLayout);
  session.move(pointForPrimarySlot(0), 0);
  session.tick(300);
  assert.equal(session.snapshot().expandedParentId, "parent");
  session.move(pointForPrimarySlot(1, 6), 301);
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
  session.move({ x: 300, y: 100 }, 0);
  assert.equal(session.tick(300).primaryPage, 1);
  session.move({ x: -100, y: 100 }, 301);
  assert.equal(session.tick(601).primaryPage, 0);
});

function pointForPrimarySlot(index, count = 2) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = (48 + 110) / 2;
  return { x: 100 + Math.cos(angle) * r, y: 100 + Math.sin(angle) * r };
}

function pointForSecondarySlot(index, primaryIndex, primaryCount, secondaryCount) {
  const angles = secondaryAngles(primaryIndex, primaryCount, secondaryCount);
  const angle = angles[index].center;
  const r = (130 + 185) / 2;
  return { x: 100 + Math.cos(angle) * r, y: 100 + Math.sin(angle) * r };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
