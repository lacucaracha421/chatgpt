import { afterEach, expect, it, vi } from "vitest";
import { beginNativePhase } from "./nativePerf";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("does no timing work without the native kit", () => {
  const mark = vi.spyOn(performance, "mark");
  expect(beginNativePhase("viewer.request")).toBeNull();
  expect(mark).not.toHaveBeenCalled();
});

it("records each phase once and cancels safely when a view disappears", () => {
  vi.stubGlobal("window", { __nativeCheckPerf: {} });
  const mark = vi.spyOn(performance, "mark");
  const measure = vi.spyOn(performance, "measure");
  const clear = vi.spyOn(performance, "clearMarks");
  const phase = beginNativePhase("viewer.request")!;
  phase.mark("decoded"); phase.mark("decoded");
  expect(measure).toHaveBeenCalledTimes(1);
  expect(measure).toHaveBeenCalledWith("w4:viewer.request.decoded", mark.mock.calls[0][0]);
  phase.cancel(); phase.mark("visible");
  expect(measure).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledWith(mark.mock.calls[0][0]);
});
