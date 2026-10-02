import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { collectionCoverSourceRef, useCollectionCoverPerf } from "./collectionPerf";

function Surface() {
  const ref = useRef<HTMLDivElement>(null);
  useCollectionCoverPerf(ref, "fixture", null);
  return <div ref={ref}><span className="cs-front"><img ref={collectionCoverSourceRef} src="/cover" alt="cover" /></span></div>;
}

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
  delete (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf;
});

it("does not read geometry or decode covers when the native kit is absent", () => {
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const timing = vi.spyOn(performance, "measure");
  const { getByRole } = render(<Surface />);
  const image = getByRole("img") as HTMLImageElement;
  image.decode = vi.fn().mockResolvedValue(undefined);
  fireEvent.load(image);
  expect(measure).not.toHaveBeenCalled();
  expect(image.decode).not.toHaveBeenCalled();
  expect(timing).not.toHaveBeenCalled();
});

it("reports a visible decoded cover once, after two frame boundaries", async () => {
  vi.useFakeTimers();
  (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf = {};
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });
  const timing = vi.spyOn(performance, "measure");
  const { getByRole } = render(<Surface />);
  const image = getByRole("img") as HTMLImageElement;
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
  image.decode = vi.fn().mockResolvedValue(undefined);
  await act(async () => { fireEvent.load(image); });
  expect(timing.mock.calls.map(call => call[0])).toEqual(["w4:collections.list-to-first-cover.list-committed", "w4:collections.first-cover.src-assigned", "w4:collections.list-to-first-cover.src-observed", "w4:collections.list-to-first-cover.loaded", "w4:collections.list-to-first-cover.decoded"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(timing.mock.calls[timing.mock.calls.length - 1]?.[0]).toBe("w4:collections.list-to-first-cover.visible");
  fireEvent.load(image);
  expect(image.decode).toHaveBeenCalledOnce();
});

it("separates available resource timing from the load callback without recording the URL", async () => {
  (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf = {};
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });
  const entries = vi.spyOn(performance, "getEntriesByName").mockReturnValue([{ startTime: 10, responseEnd: 20 } as PerformanceResourceTiming]);
  const timing = vi.spyOn(performance, "measure");
  const { getByRole } = render(<Surface />);
  const image = getByRole("img") as HTMLImageElement;
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
  image.decode = vi.fn().mockResolvedValue(undefined);
  await act(async () => fireEvent.load(image));
  expect(entries).toHaveBeenCalledWith(image.src, "resource");
  expect(timing).toHaveBeenCalledWith("w4:collections.first-cover.resource", { start: 10, end: 20 });
  expect(timing).toHaveBeenCalledWith("w4:collections.first-cover.resource-to-loaded", { start: 20, end: expect.any(Number) });
  expect(timing.mock.calls.every(([name]) => !name.includes("/cover"))).toBe(true);
});

it("does not force layout while cold covers or style mutations are still loading", async () => {
  vi.useFakeTimers();
  (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf = {};
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const { getByRole } = render(<Surface />);
  const image = getByRole("img");
  for (let index = 0; index < 8; index++) {
    await act(async () => { image.style.opacity = String(index / 10); });
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(geometry).not.toHaveBeenCalled();
});

it("records hidden image load and decode separately from its later visibility", async () => {
  vi.useFakeTimers();
  (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf = {};
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });
  const timing = vi.spyOn(performance, "measure");
  const { getByRole } = render(<Surface />);
  const image = getByRole("img") as HTMLImageElement;
  image.style.visibility = "hidden";
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
  let decode!: () => void;
  image.decode = vi.fn(() => new Promise<void>(resolve => { decode = resolve; }));
  await act(async () => fireEvent.load(image));
  const names = () => timing.mock.calls.map(([name]) => name);
  expect(names()).toContain("w4:collections.list-to-first-cover.loaded");
  expect(names()).not.toContain("w4:collections.list-to-first-cover.decoded");
  await act(async () => decode());
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(names()).toContain("w4:collections.list-to-first-cover.decoded");
  expect(names()).not.toContain("w4:collections.list-to-first-cover.visible");
  await act(async () => { image.style.visibility = ""; });
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(names()).toContain("w4:collections.list-to-first-cover.visible");
  expect(image.decode).toHaveBeenCalledOnce();
});

it("coalesces ready cover mutation bursts into one geometry pass and cancels on unmount", async () => {
  vi.useFakeTimers();
  (window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf = {};
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });
  const timing = vi.spyOn(performance, "measure");
  const { getByRole, unmount } = render(<Surface />);
  const image = getByRole("img") as HTMLImageElement;
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 } });
  image.decode = vi.fn().mockResolvedValue(undefined);
  await act(async () => fireEvent.load(image));
  for (let index = 0; index < 8; index++) await act(async () => { image.style.opacity = String(index / 10); });
  expect(geometry).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(17); });
  expect(geometry).toHaveBeenCalledTimes(2); // Scroll root + first visible front.
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(timing.mock.calls.map(([name]) => name)).not.toContain("w4:collections.list-to-first-cover.visible");
});
