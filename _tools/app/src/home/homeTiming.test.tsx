import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLocalDayClock } from "../shared/useLocalDayClock";

afterEach(() => vi.useRealTimers());

it("keeps one midnight timer across unrelated renders and schedules the next day", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 59));
  const { result, rerender, unmount } = renderHook(() => useLocalDayClock());
  expect(vi.getTimerCount()).toBe(1);
  rerender();
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(result.current.getMonth()).toBe(9);
  expect(result.current.getDate()).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(86_400_000); });
  expect(result.current.getDate()).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
