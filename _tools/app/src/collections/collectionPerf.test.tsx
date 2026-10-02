import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useCollectionCoverPerf } from "./collectionPerf";

function Surface() {
  const ref = useRef<HTMLDivElement>(null);
  useCollectionCoverPerf(ref, "fixture", null);
  return <div ref={ref}><span className="cs-front"><img src="/cover" alt="cover" /></span></div>;
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
  expect(timing.mock.calls.map(call => call[0])).toEqual(["w4:collections.list-to-first-cover.loaded", "w4:collections.list-to-first-cover.decoded"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(timing.mock.calls[timing.mock.calls.length - 1]?.[0]).toBe("w4:collections.list-to-first-cover.visible");
  fireEvent.load(image);
  expect(image.decode).toHaveBeenCalledOnce();
});
