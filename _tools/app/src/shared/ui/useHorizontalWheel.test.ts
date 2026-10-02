import { describe, expect, it } from "vitest";
import { createHorizontalWheelHandler } from "./useHorizontalWheel";

function strip(left = 0, width = 800) {
  const node = document.createElement("div");
  Object.defineProperties(node, { clientWidth: { value: 200 }, scrollWidth: { value: width } });
  node.scrollLeft = left;
  return { node, wheel: createHorizontalWheelHandler(node) };
}

function event(at: number, deltaY: number, init: WheelEventInit = {}) {
  const wheel = new WheelEvent("wheel", { deltaY, cancelable: true, ...init });
  Object.defineProperty(wheel, "timeStamp", { value: at });
  return wheel;
}

describe("horizontal wheel gesture ownership", () => {
  it.each([1, -1])("holds the gesture at either end (direction %s)", direction => {
    const { node, wheel } = strip(direction > 0 ? 590 : 10);
    const start = event(0, direction * 30);
    wheel(start);
    expect(start.defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(direction > 0 ? 600 : 0);
    for (const at of [100, 350, 600]) {
      const tail = event(at, direction * 30);
      wheel(tail);
      expect(tail.defaultPrevented).toBe(true);
      expect(node.scrollLeft).toBe(direction > 0 ? 600 : 0);
    }
    const next = event(900, direction * 30);
    wheel(next);
    expect(next.defaultPrevented).toBe(false);
  });

  it("scrolls back into the strip when the direction reverses", () => {
    const { node, wheel } = strip(600);
    const outward = event(0, 30);
    wheel(outward);
    expect(outward.defaultPrevented).toBe(false);
    const inward = event(100, -30);
    wheel(inward);
    expect(inward.defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(570);
  });

  it("can reverse a latched gesture at the end", () => {
    const { node, wheel } = strip(590);
    wheel(event(0, 30));
    wheel(event(100, 30));
    const inward = event(200, -30);
    wheel(inward);
    expect(inward.defaultPrevented).toBe(true);
    expect(node.scrollLeft).toBe(570);
  });

  it("keeps horizontal trackpad deltas and latches their tail", () => {
    const { node, wheel } = strip(590);
    wheel(event(0, 2, { deltaX: 30 }));
    expect(node.scrollLeft).toBe(600);
    const tail = event(100, 2, { deltaX: 30 });
    wheel(tail);
    expect(tail.defaultPrevented).toBe(true);
    const next = event(400, 2, { deltaX: 30 });
    wheel(next);
    expect(next.defaultPrevented).toBe(false);
  });

  it.each([[1, 40], [2, 200]])("normalizes delta mode %s", (deltaMode, expected) => {
    const { node, wheel } = strip();
    wheel(event(0, 1, { deltaMode }));
    expect(node.scrollLeft).toBe(expected);
  });

  it("lets a non-overflowing row and pinch zoom pass through", () => {
    const short = strip(0, 200);
    const e = event(0, 20);
    short.wheel(e);
    expect(e.defaultPrevented).toBe(false);
    const { node, wheel } = strip(100);
    const pinch = event(0, 20, { ctrlKey: true });
    wheel(pinch);
    expect(pinch.defaultPrevented).toBe(false);
    expect(node.scrollLeft).toBe(100);
  });

  it("ignores zero deltas and events already consumed by a child", () => {
    const { node, wheel } = strip();
    wheel(event(0, 0));
    const consumed = event(100, 30);
    consumed.preventDefault();
    wheel(consumed);
    expect(node.scrollLeft).toBe(0);
  });
});
