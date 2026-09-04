import { describe, expect, it } from "vitest";
import {
  arrowAdvance,
  displayOrder,
  edgeAdvance,
  nextSpreadStart,
  prevSpreadStart,
  spreadForPage,
} from "./readerSpread";

describe("spreadForPage", () => {
  it("pairs predictably with cover-single enabled", () => {
    expect(spreadForPage(1, 7, true)).toEqual([1]);
    expect(spreadForPage(2, 7, true)).toEqual([2, 3]);
    expect(spreadForPage(3, 7, true)).toEqual([2, 3]);
    expect(spreadForPage(4, 7, true)).toEqual([4, 5]);
    expect(spreadForPage(7, 7, true)).toEqual([6, 7]);
  });

  it("pairs from page one with cover-single disabled", () => {
    expect(spreadForPage(1, 7, false)).toEqual([1, 2]);
    expect(spreadForPage(2, 7, false)).toEqual([1, 2]);
    expect(spreadForPage(3, 7, false)).toEqual([3, 4]);
  });

  it("keeps a lone odd final page by itself", () => {
    expect(spreadForPage(7, 8, true)).toEqual([6, 7]);
    expect(spreadForPage(8, 8, true)).toEqual([8]);
    expect(spreadForPage(7, 7, false)).toEqual([7]);
  });

  it("clamps out-of-range pages", () => {
    expect(spreadForPage(0, 5, true)).toEqual([1]);
    expect(spreadForPage(99, 5, true)).toEqual([4, 5]);
  });
});

describe("spread navigation", () => {
  it("advances and retreats by stable spreads", () => {
    expect(nextSpreadStart(1, 7, true)).toBe(2);
    expect(nextSpreadStart(2, 7, true)).toBe(4);
    expect(nextSpreadStart(3, 7, true)).toBe(4);
    expect(nextSpreadStart(6, 7, true)).toBe(7);
    expect(prevSpreadStart(4, 7, true)).toBe(2);
    expect(prevSpreadStart(3, 7, true)).toBe(1);
    expect(prevSpreadStart(1, 7, true)).toBe(1);
    expect(nextSpreadStart(5, 6, false)).toBe(6);
    expect(prevSpreadStart(3, 6, false)).toBe(1);
  });
});

describe("reading direction", () => {
  it("keeps logical order for LTR and mirrors it for RTL", () => {
    expect(displayOrder([2, 3], "ltr")).toEqual([2, 3]);
    expect(displayOrder([2, 3], "rtl")).toEqual([3, 2]);
    expect(displayOrder([1], "rtl")).toEqual([1]);
  });

  it("maps physical edges to logical advances", () => {
    expect(edgeAdvance("left", "ltr")).toBe("prev");
    expect(edgeAdvance("right", "ltr")).toBe("next");
    expect(edgeAdvance("left", "rtl")).toBe("next");
    expect(edgeAdvance("right", "rtl")).toBe("prev");
  });

  it("maps arrow keys to logical advances", () => {
    expect(arrowAdvance("ArrowLeft", "ltr")).toBe("prev");
    expect(arrowAdvance("ArrowRight", "ltr")).toBe("next");
    expect(arrowAdvance("ArrowLeft", "rtl")).toBe("next");
    expect(arrowAdvance("ArrowRight", "rtl")).toBe("prev");
    expect(arrowAdvance("ArrowUp", "ltr")).toBeNull();
  });
});
