import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ fps: 30, restricted: false, draw: vi.fn() }));
vi.mock("../../app/performanceProfile", () => ({ getPerformanceProfile: () => ({ budgets: { liveBookFps: state.fps } }) }));
vi.mock("../../app/workloadProfile", () => ({ getWorkloadProfile: () => ({ restricted: state.restricted }) }));
vi.mock("./snapshotStore", () => ({ createSnapshotStore: () => null }));
vi.mock("./PaperbackEngine", () => ({
  PAPERBACK_FINAL: { rx: 0, ry: 0, rz: 0, depth: .16 },
  PaperbackEngine: class {
    disposed = false;
    constructor(public canvas: HTMLCanvasElement) {}
    texture = async () => ({ ratio: .7 });
    draw = state.draw;
    shrink() {}
  },
}));
import { attachLiveBook } from "./collectibleRuntime";
let live: ReturnType<typeof attachLiveBook> | undefined;
beforeEach(() => {
  vi.useFakeTimers(); state.draw.mockClear(); state.restricted = false;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { live?.dispose(); live = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each([[30, false, 30], [60, false, 60], [60, true, 30]] as const)(
  "bounds requested frames at %i fps (restricted %s), leaves idle rendering stopped", async (fps, restricted, expected) => {
    state.fps = fps; state.restricted = restricted;
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({ width: 600, height: 400 } as DOMRect);
    live = attachLiveBook(host, { kind: "book", src: "fixture", scope: "test", revision: "1", pixels: 512 }, vi.fn());
    await vi.advanceTimersByTimeAsync(40);
    expect(state.draw).toHaveBeenCalledTimes(1);
    const start = state.draw.mock.calls.length;
    for (let ms = 0; ms < 1000; ms++) {
      live.tilt(.1, .1);
      await vi.advanceTimersByTimeAsync(1);
    }
    const frames = state.draw.mock.calls.length - start;
    expect(frames).toBeGreaterThanOrEqual(expected - 2);
    expect(frames).toBeLessThanOrEqual(expected + 1);
    await vi.advanceTimersByTimeAsync(100);
    const idle = state.draw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.draw).toHaveBeenCalledTimes(idle);
    expect(host.querySelector("canvas")).not.toBeNull();
  },
);
