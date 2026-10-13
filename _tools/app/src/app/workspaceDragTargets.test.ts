import { afterEach, expect, it, vi } from "vitest";
import { sidebarTargetAt, swallowNextClick } from "./workspaceDragTargets";

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

function groupRow(id: string, seriesId: string) {
  const row = document.createElement("div");
  row.dataset.characterGroupId = id;
  row.dataset.seriesId = seriesId;
  row.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} });
  document.body.append(row);
  return row;
}
const payload = { kind: "character-group", groupId: "g1", seriesId: "s1" } as const;
const over = (element: Element | null) => { document.elementFromPoint = vi.fn(() => element); };

it("drops a dragged group before the upper half and after the lower half of another group of its series", () => {
  over(groupRow("g2", "s1"));
  expect(sidebarTargetAt(10, 105, payload, [], [])).toEqual({ kind: "character-group", entryId: "g2", position: "before", valid: true });
  expect(sidebarTargetAt(10, 115, payload, [], [])).toEqual({ kind: "character-group", entryId: "g2", position: "after", valid: true });
});

it("refuses the group's own row and another series' group, and finds no place off a group row", () => {
  over(groupRow("g1", "s1"));
  expect(sidebarTargetAt(10, 105, payload, [], [])?.valid).toBe(false);
  over(groupRow("g9", "s2"));
  expect(sidebarTargetAt(10, 105, payload, [], [])?.valid).toBe(false);
  const folder = document.createElement("div");
  folder.dataset.classificationId = "folder";
  over(folder);
  expect(sidebarTargetAt(10, 105, payload, [], [])).toBeNull();
});

it("swallows only the click that follows a drag", () => {
  vi.useFakeTimers();
  const first = vi.fn();
  document.addEventListener("click", first);
  swallowNextClick();
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(first).not.toHaveBeenCalled();
  swallowNextClick();
  vi.advanceTimersByTime(200);
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(first).toHaveBeenCalledTimes(1);
  document.removeEventListener("click", first);
  vi.useRealTimers();
});

it("measures the half a pointer is in without the gap the row's own drop mark opens", () => {
  // A row of 20 px that opened a 20 px gap above it: the box is 40 px high, the row itself is its lower 20 px.
  const row = groupRow("g2", "s1");
  row.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} });
  row.style.paddingTop = "20px";
  row.dataset.dropState = "valid"; row.dataset.dropPosition = "before";
  over(row);
  // In the gap and in the row's upper half: still before; only the row's lower half is after.
  expect(sidebarTargetAt(10, 105, payload, [], [])?.position).toBe("before");
  expect(sidebarTargetAt(10, 125, payload, [], [])?.position).toBe("before");
  expect(sidebarTargetAt(10, 135, payload, [], [])?.position).toBe("after");
});
