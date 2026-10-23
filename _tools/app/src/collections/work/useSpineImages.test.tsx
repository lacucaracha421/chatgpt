import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSpineImages } from "./useSpineImages";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("loads opening and approaching spines, and retains them when they leave the strip", () => {
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe = vi.fn(); unobserve = vi.fn(); disconnect = disconnect;
  });
  const viewport = document.createElement("div");
  const track = document.createElement("div");
  track.className = "home-shelf__track";
  track.getBoundingClientRect = () => ({ left: 0, right: 500, width: 500 } as DOMRect);
  viewport.append(track);
  const volumes = Array.from({ length: 115 }, (_, index) => ({ id: `v${index}` }));
  const buttons = volumes.map((volume, index) => {
    const button = document.createElement("button");
    button.dataset.volumeId = volume.id;
    button.getBoundingClientRect = () => ({ left: index * 25, right: index * 25 + 20 } as DOMRect);
    track.append(button);
    return button;
  });
  const ref = { current: viewport };
  const { result, unmount } = renderHook(() => useSpineImages(ref, true, volumes));
  expect(result.current.measured).toBe(true);
  expect(result.current.requested?.has("v0")).toBe(true);
  expect(result.current.requested?.has("v19")).toBe(true);
  expect(result.current.requested?.has("v114")).toBe(false);
  expect(result.current.requested!.size).toBeLessThan(30);
  const entry = (isIntersecting: boolean): IntersectionObserverEntry => ({
    target: buttons[114], isIntersecting, time: 0, intersectionRatio: isIntersecting ? 1 : 0,
    boundingClientRect: buttons[114].getBoundingClientRect(), intersectionRect: new DOMRect(), rootBounds: track.getBoundingClientRect(),
  });
  act(() => intersect([entry(true)], {} as IntersectionObserver));
  expect(result.current.requested?.has("v114")).toBe(true);
  act(() => intersect([entry(false)], {} as IntersectionObserver));
  expect(result.current.requested?.has("v114")).toBe(true);
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
