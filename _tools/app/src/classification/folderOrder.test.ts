import { expect, it } from "vitest";
import type { ClassificationEntry } from "../library/types";
import { applyInitialCountOrder, reorderFolders } from "./folderOrder";
import { DEFAULT_UI_PREFERENCES, loadUiPreferences, saveUiPreferences } from "../preferences/uiPreferences";
import { buildTree } from "./buildTree";

it("sorts populated counts once and preserves later manual order across reloads", () => {
  const entries = [
    { id: "a", name: "A", parentId: null, assetCount: 2 },
    { id: "b", name: "B", parentId: null, assetCount: 20 },
    { id: "c", name: "C", parentId: "a", assetCount: 30 },
  ].map((entry) => ({ ...entry, kind: "root", iconKey: null, colorKey: null })) as ClassificationEntry[];
  expect(applyInitialCountOrder([], DEFAULT_UI_PREFERENCES)).toBe(DEFAULT_UI_PREFERENCES);
  const sorted = applyInitialCountOrder(entries, DEFAULT_UI_PREFERENCES);
  expect(buildTree(entries, sorted.classificationOrderIds).map((node) => node.entry.id)).toEqual(["b", "a"]);
  const manual = { ...sorted, classificationOrderIds: ["a", "b", "c"] };
  saveUiPreferences(manual);
  const restored = loadUiPreferences();
  expect(applyInitialCountOrder(entries, restored)).toBe(restored);
  expect(restored.classificationOrderIds).toEqual(["a", "b", "c"]);
  localStorage.clear();
});

it("preserves manual sibling order and appends moved children without changing unrelated branches", () => {
  const entries = [
    { id: "a", name: "A", parentId: null }, { id: "b", name: "B", parentId: null },
    { id: "c", name: "C", parentId: "a" }, { id: "d", name: "D", parentId: "a" },
  ].map((entry) => ({ ...entry, kind: "tag", iconKey: null, colorKey: null })) as ClassificationEntry[];
  const order = reorderFolders(entries, [], "b", { kind: "classification", entryId: "a", position: "before", valid: true }, null);
  expect(buildTree(entries, order).map((node) => node.entry.id)).toEqual(["b", "a"]);
  const next = reorderFolders(entries, order, "d", { kind: "classification", entryId: "c", position: "before", valid: true }, "a");
  expect(buildTree(entries, next)[1].children.map((node) => node.entry.id)).toEqual(["d", "c"]);
  expect(reorderFolders(entries, next, "b", { kind: "classification", entryId: "a", position: "inside", valid: true }, "a")).toEqual(["a", "d", "c", "b"]);
});
