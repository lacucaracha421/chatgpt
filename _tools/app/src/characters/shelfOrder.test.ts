import { describe, expect, it } from "vitest";
import { canMove, edgeScrollSpeed, inCentralZone, insertionIndex, movedIds, movedToIndex, orderAnnouncement, slideOffsets, withCharacterOrder, withListedOrder, type SlotBox } from "./shelfOrder";

const slots: SlotBox[] = ["a", "b", "c", "d"].map((id, index) => ({ id, left: index * 144, width: 132 }));

describe("band moves", () => {
  it("steps one place and jumps to the ends, and reports a card that cannot move", () => {
    const ids = ["a", "b", "c", "d"];
    expect(movedIds(ids, "b", "prev")).toEqual(["b", "a", "c", "d"]);
    expect(movedIds(ids, "b", "next")).toEqual(["a", "c", "b", "d"]);
    expect(movedIds(ids, "c", "first")).toEqual(["c", "a", "b", "d"]);
    expect(movedIds(ids, "b", "last")).toEqual(["a", "c", "d", "b"]);
    expect(movedIds(ids, "a", "prev")).toBeNull();
    expect(movedIds(ids, "a", "first")).toBeNull();
    expect(movedIds(ids, "d", "next")).toBeNull();
    expect(movedIds(ids, "d", "last")).toBeNull();
    expect(movedIds(ids, "x", "next")).toBeNull();
    expect(canMove(ids, "a", "prev")).toBe(false);
    expect(canMove(ids, "a", "last")).toBe(true);
  });

  it("moves to an index and clamps it", () => {
    expect(movedToIndex(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(movedToIndex(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
    expect(movedToIndex(["a", "b", "c"], "b", 1)).toBeNull();
  });
});

describe("carrying", () => {
  it("lands the card among the others by their middles, never outside its band", () => {
    expect(insertionIndex(slots, "a", -500)).toBe(0);
    expect(insertionIndex(slots, "a", 100)).toBe(0);
    // b's middle is 144 + 66 = 210; c's middle is 354.
    expect(insertionIndex(slots, "a", 211)).toBe(1);
    expect(insertionIndex(slots, "a", 360)).toBe(2);
    expect(insertionIndex(slots, "a", 5_000)).toBe(3);
    expect(insertionIndex(slots, "d", 0)).toBe(0);
  });

  it("opens the gap by sliding the neighbours one slot and moving the carried place", () => {
    const offsets = slideOffsets(slots, "a", 2);
    expect(Object.fromEntries(offsets)).toEqual({ a: 288, b: -144, c: -144 });
    expect(slideOffsets(slots, "d", 0).get("d")).toBe(-432);
    expect(slideOffsets(slots, "b", 1).size).toBe(0);
  });

  it("recognises the middle of a group card as the put-in zone", () => {
    // 60% of 132 is 79.2 px: 26.4 px stay free on each side.
    expect(inCentralZone(0, 132, 10)).toBe(false);
    expect(inCentralZone(0, 132, 27)).toBe(true);
    expect(inCentralZone(0, 132, 66)).toBe(true);
    expect(inCentralZone(0, 132, 105)).toBe(true);
    expect(inCentralZone(0, 132, 106)).toBe(false);
  });

  it("scrolls only in the 48px end zones, faster the deeper the pointer is", () => {
    expect(edgeScrollSpeed(500, 0, 1000)).toBe(0);
    expect(edgeScrollSpeed(47, 0, 1000)).toBeLessThan(0);
    expect(edgeScrollSpeed(1, 0, 1000)).toBeLessThan(edgeScrollSpeed(40, 0, 1000));
    expect(edgeScrollSpeed(960, 0, 1000)).toBeGreaterThan(0);
    expect(edgeScrollSpeed(999, 0, 1000)).toBeGreaterThan(edgeScrollSpeed(955, 0, 1000));
    expect(edgeScrollSpeed(-10, 0, 1000)).toBe(0);
    expect(edgeScrollSpeed(1010, 0, 1000)).toBe(0);
  });
});

describe("lists", () => {
  it("announces the new place", () => {
    expect(orderAnnouncement("character", "히나", 2)).toBe("히나, 캐릭터 3번째");
    expect(orderAnnouncement("group", "선도부", 0)).toBe("선도부, 그룹 1번째");
  });

  it("rearranges the listed items inside their own slots", () => {
    const items = ["a", "x", "b", "y", "c"].map(id => ({ id }));
    expect(withListedOrder(items, ["c", "a", "b"]).map(item => item.id)).toEqual(["c", "x", "a", "y", "b"]);
    // Unknown ids are skipped and an already ordered list is returned as it is.
    expect(withListedOrder(items, ["ghost", "a", "b", "c"])).toBe(items);
  });

  it("orders one series' band only", () => {
    const targets = [
      { id: "a", seriesClassificationId: "s" }, { id: "o", seriesClassificationId: "other" },
      { id: "b", seriesClassificationId: "s" }, { id: "c", seriesClassificationId: "s" },
    ];
    expect(withCharacterOrder(targets, "s", ["c", "b", "o"]).map(target => target.id)).toEqual(["a", "o", "c", "b"]);
    expect(withCharacterOrder(targets, "s", ["a", "b", "c"])).toBe(targets);
  });
});
