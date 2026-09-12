import { describe, expect, it } from "vitest";
import {
  applySelectionGesture,
  emptySelection,
  moveSelectionFocus,
  reconcileSelection,
  selectAllLoaded,
  type SelectionState,
} from "./selection";

const ids = ["a", "b", "c", "d"];

function from(...selectedIds: string[]): SelectionState {
  const last = selectedIds[selectedIds.length - 1] ?? null;
  return { ids: new Set(selectedIds), anchorId: last, focusId: last };
}

describe("asset selection", () => {
  it("replaces selection on a plain click and toggles one loaded item with Ctrl", () => {
    expect(applySelectionGesture(emptySelection(), ids, "b", { toggle: false, range: false }))
      .toEqual(from("b"));
    expect(applySelectionGesture(from("b"), ids, "c", { toggle: true, range: false }).ids)
      .toEqual(new Set(["b", "c"]));
    expect(applySelectionGesture(from("b", "c"), ids, "c", { toggle: true, range: false }).ids)
      .toEqual(new Set(["b"]));
  });

  it("selects an anchored Shift range and adds it with Ctrl+Shift", () => {
    expect(applySelectionGesture(from("b"), ids, "d", { toggle: false, range: true }).ids)
      .toEqual(new Set(["b", "c", "d"]));
    expect(applySelectionGesture(from("a"), ids, "c", { toggle: true, range: true }).ids)
      .toEqual(new Set(["a", "b", "c"]));
  });

  it("selects all and reconciles only IDs that are currently loaded", () => {
    expect(selectAllLoaded(from("outside"), ids).ids).toEqual(new Set(ids));
    expect(reconcileSelection(from("outside", "b", "d"), ["a", "b", "c"]))
      .toEqual({ ids: new Set(["b"]), anchorId: "b", focusId: "b" });
  });

  it("moves keyboard focus inside loaded IDs and optionally extends the range", () => {
    expect(moveSelectionFocus(from("b"), ids, 1, false)).toEqual(from("c"));
    expect(moveSelectionFocus(from("b"), ids, 2, true)).toEqual({
      ids: new Set(["b", "c", "d"]),
      anchorId: "b",
      focusId: "d",
    });
    expect(moveSelectionFocus(from("d"), ids, 1, false)).toEqual(from("d"));
  });
});
