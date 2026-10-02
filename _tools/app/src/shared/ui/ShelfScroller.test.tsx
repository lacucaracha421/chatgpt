import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfScroller } from "./ShelfScroller";
import { WorkStrip } from "../../collections/work/WorkStage";
import { StrictMode } from "react";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback); return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function flushFrames() {
  act(() => {
    for (let i = 0; frames.size && i < 100; i++) {
      const batch = [...frames.values()]; frames.clear();
      batch.forEach(callback => callback(i * 16));
    }
  });
  expect(frames.size).toBe(0);
}

function wheel(node: HTMLElement, at: number, deltaY: number, deltaX = 0) {
  const event = new WheelEvent("wheel", { deltaY, deltaX, bubbles: true, cancelable: true });
  Object.defineProperty(event, "timeStamp", { value: at });
  fireEvent(node, event);
  return event;
}

function renderShelf() {
  const view = render(<ShelfScroller><button>첫 항목</button><button>다음 항목</button></ShelfScroller>);
  const track = view.container.querySelector<HTMLElement>(".home-shelf__track")!;
  Object.defineProperties(track, { clientWidth: { value: 200 }, scrollWidth: { value: 800 } });
  track.scrollLeft = 590;
  return { ...view, track };
}

describe("ShelfScroller wheel and touch boundaries", () => {
  it("holds the wheel at the pending animated end, then releases a new gesture", () => {
    const { track } = renderShelf();
    expect(wheel(track, 0, 30).defaultPrevented).toBe(true);
    // The pending destination is already at the end before the first frame is painted.
    expect(track.scrollLeft).toBe(590);
    expect(wheel(track, 100, 30).defaultPrevented).toBe(true);
    flushFrames();
    expect(track.scrollLeft).toBe(600);
    expect(wheel(track, 399, 30).defaultPrevented).toBe(true);
    expect(wheel(track, 699, 30).defaultPrevented).toBe(false);
    expect(track.scrollLeft).toBe(600);
    expect(wheel(track, 750, -30).defaultPrevented).toBe(true);
    flushFrames();
    expect(track.scrollLeft).toBe(552);
  });

  it("retains a gesture across a render and contains touch overscroll", () => {
    const view = renderShelf();
    wheel(view.track, 0, 30); flushFrames();
    view.rerender(<ShelfScroller><button>새 항목</button></ShelfScroller>);
    expect(wheel(view.track, 100, 30).defaultPrevented).toBe(true);
    expect(view.track.style.overscrollBehaviorX).toBe("contain");
    view.unmount();
    expect(view.track.style.overscrollBehaviorX).toBe("");
    expect(wheel(view.track, 150, -30).defaultPrevented).toBe(false);
  });

  it("pans horizontal trackpad deltas", () => {
    const { track } = renderShelf(); track.scrollLeft = 100;
    expect(wheel(track, 0, 2, 20).defaultPrevented).toBe(true);
    flushFrames();
    expect(track.scrollLeft).toBe(132);
  });

  it("pans and pages without animation when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { track, getByRole } = renderShelf(); track.scrollLeft = 100;
    expect(wheel(track, 0, 30).defaultPrevented).toBe(true);
    expect(track.scrollLeft).toBe(148);
    fireEvent.click(getByRole("button", { name: "다음 발매 예정" }));
    expect(track.scrollLeft).toBe(328);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("latches a real artwork strip without smooth scrolling, including StrictMode ref cleanup", () => {
    const { container } = render(<StrictMode><WorkStrip av={false} mode="case" artworks={[{id:"art"}]} privacy onPick={() => undefined}/></StrictMode>);
    const strip = container.querySelector<HTMLElement>(".work-strip")!;
    Object.defineProperties(strip, {clientWidth:{value:200}, scrollWidth:{value:800}});
    strip.scrollLeft = 590;
    expect(wheel(strip, 0, 30).defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(600);
    expect(wheel(strip, 100, 30).defaultPrevented).toBe(true);
    expect(wheel(strip, 400, 30).defaultPrevented).toBe(false);
    expect(wheel(strip, 450, -30).defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(570);
    expect(strip.style.overscrollBehaviorX).toBe("contain");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
