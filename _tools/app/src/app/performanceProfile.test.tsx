import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetModules(); vi.clearAllMocks(); });
const laptop = { selected: "laptop", active: "laptop", budgets: { liveBookFps: 30, inboxSuccessSeconds: 3600 } };
function native() { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} }); }
it("keeps applied budgets until restart and writes only the profile", async () => {
  native();
  bridge.invoke.mockResolvedValueOnce(laptop).mockResolvedValueOnce({ ...laptop, selected: "main" });
  const api = await import("./performanceProfile");
  const { result } = renderHook(api.usePerformanceProfile);
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(() => api.updatePerformanceProfile("main"));
  expect(bridge.invoke).toHaveBeenLastCalledWith("performance_profile", { profile: "main" });
  expect(result.current.selected).toBe("main");
  expect(result.current.active).toBe("laptop");
  expect(result.current.budgets.liveBookFps).toBe(30);
  expect(result.current.budgets.inboxSuccessSeconds).toBe(3600);
});
it("does not claim a failed save or overwrite applied budgets", async () => {
  native();
  bridge.invoke.mockResolvedValueOnce(laptop).mockRejectedValueOnce(new Error("disk"));
  const api = await import("./performanceProfile");
  const { result } = renderHook(api.usePerformanceProfile);
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(() => api.updatePerformanceProfile("main"));
  expect(result.current.selected).toBe("laptop");
  expect(result.current.error).toContain("저장하지 못했습니다");
});
it("uses the native applied main budgets after a fresh start", async () => {
  native();
  bridge.invoke.mockResolvedValue({ selected: "main", active: "main", budgets: { liveBookFps: 60, inboxSuccessSeconds: 300 } });
  const api = await import("./performanceProfile");
  await api.loadPerformanceProfile();
  expect(api.getPerformanceProfile().budgets).toEqual({ liveBookFps: 60, inboxSuccessSeconds: 300 });
});
