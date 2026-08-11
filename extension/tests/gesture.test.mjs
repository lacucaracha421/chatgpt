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
  { id: "child", kind: "tag", name: "Child", parentId: "parent" },
];
const layout = context.LakomicsRadial.resetLayout(tree);

test("preserves a click below twelve pixels and opens at the threshold", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  assert.equal(session.move({ x: 111, y: 100 }, 0).opened, false);
  assert.deepEqual(plain(session.release()), { type: "click" });

  const opening = createSession({ x: 100, y: 100 }, tree, layout);
  assert.equal(opening.move({ x: 112, y: 100 }, 0).opened, true);
});

test("release before dwell selects a parent and dwell enters its children", () => {
  const immediate = createSession({ x: 100, y: 100 }, tree, layout);
  immediate.move(pointForSlot(0), 0);
  assert.deepEqual(plain(immediate.release()), { type: "select", classificationId: "parent" });

  const descended = createSession({ x: 100, y: 100 }, tree, layout);
  descended.move(pointForSlot(0), 0);
  const afterDwell = descended.tick(300);
  assert.equal(afterDwell.parentId, "parent");
  assert.equal(afterDwell.level.slots[0].id, "child");
  descended.move({ x: 100, y: 100 }, 301);
  assert.deepEqual(plain(descended.release()), { type: "select", classificationId: "parent" });
});

test("leaving a sector cancels its dwell timer", () => {
  const session = createSession({ x: 100, y: 100 }, tree, layout);
  session.move(pointForSlot(0), 0);
  session.move({ x: 300, y: 300 }, 200);
  session.move(pointForSlot(0), 400);
  assert.equal(session.tick(699).parentId, null);
  assert.equal(session.tick(700).parentId, "parent");
});

test("dwell pages and returns through the exterior controls", () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    id: `root-${index}`,
    kind: "root",
    name: `Root ${index}`,
    parentId: null,
  }));
  const session = createSession({ x: 100, y: 100 }, many, context.LakomicsRadial.resetLayout(many));
  session.move({ x: 260, y: 100 }, 0);
  assert.equal(session.tick(300).page, 1);
  session.move({ x: -60, y: 100 }, 301);
  assert.equal(session.tick(601).page, 0);
});

function pointForSlot(index, count = 6) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  return { x: 100 + Math.cos(angle) * 84, y: 100 + Math.sin(angle) * 84 };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
