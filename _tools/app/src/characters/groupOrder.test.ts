import { expect, it } from "vitest";
import { movedGroupIds, seriesGroupIds, steppedGroupIds, withGroupOrder } from "./groupOrder";

const groups = [
  { id: "a", seriesId: "s1" }, { id: "b", seriesId: "s1" }, { id: "x", seriesId: "s2" }, { id: "c", seriesId: "s1" },
];

it("lists one series' groups in list order", () => {
  expect(seriesGroupIds(groups, "s1")).toEqual(["a", "b", "c"]);
  expect(seriesGroupIds(groups, "none")).toEqual([]);
});

it("drops a group before or after another group of its series", () => {
  expect(movedGroupIds(groups, "s1", "c", "a", "before")).toEqual(["c", "a", "b"]);
  expect(movedGroupIds(groups, "s1", "a", "c", "after")).toEqual(["b", "c", "a"]);
  expect(movedGroupIds(groups, "s1", "a", "c", "before")).toEqual(["b", "a", "c"]);
});

it("reports nothing to store when the order would not change or a group is not in the series", () => {
  expect(movedGroupIds(groups, "s1", "a", "b", "before")).toBeNull();
  expect(movedGroupIds(groups, "s1", "b", "a", "after")).toBeNull();
  expect(movedGroupIds(groups, "s1", "a", "a", "after")).toBeNull();
  expect(movedGroupIds(groups, "s1", "a", "x", "after")).toBeNull();
  expect(movedGroupIds(groups, "s2", "x", "a", "before")).toBeNull();
});

it("steps a group one place and stops at the ends", () => {
  expect(steppedGroupIds(groups, "s1", "b", -1)).toEqual(["b", "a", "c"]);
  expect(steppedGroupIds(groups, "s1", "b", 1)).toEqual(["a", "c", "b"]);
  expect(steppedGroupIds(groups, "s1", "a", -1)).toBeNull();
  expect(steppedGroupIds(groups, "s1", "c", 1)).toBeNull();
  expect(steppedGroupIds(groups, "s1", "x", 1)).toBeNull();
});

it("applies a stored order to its series only, keeping the other series' slots", () => {
  const ordered = withGroupOrder(groups, "s1", ["c", "a", "b"]);
  expect(ordered.map(group => group.id)).toEqual(["c", "a", "x", "b"]);
  expect(ordered[2]).toBe(groups[2]);
});

it("places a group made since after the listed ones, skips one removed since, and keeps identity when nothing moves", () => {
  expect(withGroupOrder(groups, "s1", ["c", "gone", "a"]).map(group => group.id)).toEqual(["c", "a", "x", "b"]);
  expect(withGroupOrder(groups, "s1", ["a", "b", "c"])).toBe(groups);
});
