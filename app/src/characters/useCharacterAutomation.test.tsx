import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCharacterAutomation, type AutomaticCharacterApi, type IncrementalStatus } from "./useCharacterAutomation";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const idle = {
  running: true,
  workActive: false,
  paused: false,
  completed: 0,
  confirmed: 0,
  historyRefreshActive: false,
  persistentError: null,
} satisfies IncrementalStatus;

it("keeps normal background scheduler details out of the renderer contract", async () => {
  vi.useFakeTimers();
  const api: AutomaticCharacterApi = {
    status: vi.fn().mockResolvedValue({
      ...idle,
      workActive: true,
      activeAssetId: "image",
      pending: 12,
      activeSeriesName: "젠레스",
    }),
    pause: vi.fn(),
  };
  const { result } = renderHook(() => useCharacterAutomation(vi.fn(), api));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  expect(result.current.historyRefreshActive).toBe(false);
  expect(result.current.persistentError).toBeNull();
  expect(result.current).not.toHaveProperty("progress");
  expect(result.current).not.toHaveProperty("queuePending");
  expect(result.current).not.toHaveProperty("activeSeriesName");
});

it("publishes one revision per durable completion and does not cancel on navigation", async () => {
  vi.useFakeTimers();
  let state = idle;
  const api: AutomaticCharacterApi = {
    status: vi.fn(async () => state),
    pause: vi.fn(),
  };
  const changed = vi.fn();
  const { result, unmount } = renderHook(() => useCharacterAutomation(changed, api));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  state = { ...state, completed: 1, confirmed: 1 };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });

  expect(changed).toHaveBeenCalledWith(true);
  expect(result.current.revision).toBe(1);
  unmount();
  expect(api.pause).not.toHaveBeenCalled();
});

it("keeps a persistent owner failure dismissible and provides runtime setup", async () => {
  vi.useFakeTimers();
  const setup = vi.fn().mockResolvedValue(undefined);
  const api: AutomaticCharacterApi = {
    status: vi.fn().mockResolvedValue({
      ...idle,
      running: false,
      persistentError: "런타임을 시작하지 못했습니다.",
    }),
    pause: vi.fn(),
    setup,
  };
  const { result } = renderHook(() => useCharacterAutomation(vi.fn(), api));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  expect(result.current.persistentError).toContain("런타임을 시작하지 못했습니다.");
  act(() => result.current.dismissError());
  expect(result.current.persistentError).toBeNull();
  await act(async () => {
    await result.current.setupRuntime();
  });
  expect(setup).toHaveBeenCalledTimes(1);
});

it("keeps the runtime error visible when setup is cancelled", async () => {
  vi.useFakeTimers();
  const setup = vi.fn().mockResolvedValue(false);
  const api: AutomaticCharacterApi = {
    status: vi.fn().mockResolvedValue({
      ...idle,
      running: false,
      persistentError: "분석 환경 설정이 필요합니다.",
    }),
    pause: vi.fn(),
    setup,
  };
  const { result } = renderHook(() => useCharacterAutomation(vi.fn(), api));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  await act(async () => {
    await result.current.setupRuntime();
  });

  expect(setup).toHaveBeenCalledTimes(1);
  expect(result.current.persistentError).toContain("분석 환경 설정이 필요합니다.");
});

it("controls pause and resume for an explicit history refresh", async () => {
  vi.useFakeTimers();
  const pause = vi.fn().mockResolvedValue(undefined);
  const api: AutomaticCharacterApi = {
    status: vi.fn().mockResolvedValue({
      ...idle,
      historyRefreshActive: true,
    }),
    pause,
  };
  const { result } = renderHook(() => useCharacterAutomation(vi.fn(), api));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  expect(result.current.historyRefreshActive).toBe(true);
  await act(async () => {
    result.current.pauseHistoryRefresh();
  });
  expect(api.pause).toHaveBeenCalledWith(true);
  await act(async () => {
    result.current.resumeHistoryRefresh();
  });
  expect(api.pause).toHaveBeenCalledWith(false);
});

it("refreshes promptly on visibility and reports whether membership changed", async () => {
  vi.useFakeTimers();
  let visible = false;
  let state = idle;
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => (visible ? "visible" : "hidden"));
  const api: AutomaticCharacterApi = {
    status: vi.fn(async () => state),
    pause: vi.fn(),
  };
  const changed = vi.fn();
  renderHook(() => useCharacterAutomation(changed, api));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(api.status).toHaveBeenCalledTimes(1);

  state = { ...state, completed: 1 };
  visible = true;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenLastCalledWith(false);
  visibility.mockRestore();
});
