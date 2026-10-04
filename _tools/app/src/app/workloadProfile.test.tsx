import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("./performanceProfile", () => ({ loadPerformanceProfile: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { bridge.handlers.set(name, callback); return () => bridge.handlers.delete(name); }) }));
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); bridge.handlers.clear(); vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks(); });
const normal = { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: false, hidden: false, trayAvailable: true };
it("receives native changes and keeps slow polling during recovery", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  bridge.invoke.mockResolvedValue(normal);
  const api = await import("./workloadProfile");
  const { result } = renderHook(api.useWorkloadProfile);
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(api.workloadPollDelay(5000)).toBe(5000);
  act(() => bridge.handlers.get("workload://changed")?.({ payload: { ...normal, lightweight: true, restricted: true } }));
  expect(result.current.lightweight).toBe(true);
  expect(api.workloadPollDelay(5000)).toBe(60_000);
  act(() => bridge.handlers.get("workload://changed")?.({ payload: { ...normal, restricted: true } }));
  expect(result.current.lightweight).toBe(false);
  expect(api.workloadPollDelay(5000)).toBe(60_000);
  act(() => bridge.handlers.get("workload://changed")?.({ payload: normal }));
  expect(api.workloadPollDelay(5000)).toBe(5000);
});
it("does not optimistically report a failed settings write", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  bridge.invoke.mockResolvedValueOnce(normal).mockRejectedValueOnce(new Error("disk"));
  const api = await import("./workloadProfile");
  const { result } = renderHook(api.useWorkloadProfile);
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(() => api.updateWorkloadSettings({ lightweight: true }));
  expect(result.current.lightweight).toBe(false);
  expect(result.current.error).toContain("저장하지 못했습니다");
});

it.each(["profile", "second listener"])("retries failed initialization (%s) without duplicate listeners", async failure => {
  vi.useFakeTimers();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  if (failure === "profile") bridge.invoke.mockRejectedValueOnce(new Error("bridge"));
  else vi.mocked(listen).mockImplementationOnce(async (name, callback) => {
    bridge.handlers.set(name, callback as (event: { payload: unknown }) => void);
    return () => { bridge.handlers.delete(name); };
  }).mockRejectedValueOnce(new Error("listen"));
  bridge.invoke.mockResolvedValue(normal);
  const api = await import("./workloadProfile");
  expect(api.getWorkloadProfile()).toMatchObject({ ready: false, restricted: true });
  expect(api.workloadPollDelay(5000)).toBe(60_000);
  const { result, unmount } = renderHook(api.useWorkloadProfile);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current).toMatchObject({ ready: false, restricted: true });
  expect(result.current.error).toContain("불러오지 못했습니다");
  expect(bridge.handlers.size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(result.current).toMatchObject({ ready: true, restricted: false, error: null });
  expect(bridge.handlers.size).toBe(2);
  expect(listen).toHaveBeenCalledTimes(4);
  const another = renderHook(api.useWorkloadProfile);
  expect(listen).toHaveBeenCalledTimes(4);
  act(() => bridge.handlers.get("workload://changed")?.({ payload: { ...normal, lightweight: true, restricted: true } }));
  expect(another.result.current.lightweight).toBe(true);
  unmount(); another.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending retry on unmount and allows the next mount to retry", async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  bridge.invoke.mockRejectedValueOnce(new Error("bridge")).mockResolvedValue(normal);
  const api = await import("./workloadProfile");
  const view = renderHook(api.useWorkloadProfile);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const next = renderHook(api.useWorkloadProfile);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(next.result.current.ready).toBe(true);
  expect(bridge.handlers.size).toBe(2);
});
