import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSimilarityIndex } from "./useSimilarityIndex";

const workload = vi.hoisted(() => ({ restricted: false }));
vi.mock("../app/workloadProfile", () => ({ useWorkloadProfile: () => workload, getWorkloadProfile: () => workload }));
afterEach(() => { vi.useRealTimers(); workload.restricted = false; });

it("runs one library-owned batch at a time until no hashes remain", async () => {
  vi.useFakeTimers();
  const index = vi.fn()
    .mockResolvedValueOnce({ remaining: 1, failed: 1 })
    .mockResolvedValueOnce({ remaining: 0, failed: 1 });
  const { result } = renderHook(() => useSimilarityIndex(index));

  await act(async () => { await Promise.resolve(); });
  expect(index).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(index).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({ running: false, remaining: 0, failed: 1 });
});

it("cancels scheduled work after unmount", async () => {
  vi.useFakeTimers();
  const index = vi.fn().mockResolvedValue({ remaining: 1, failed: 0 });
  const { unmount } = renderHook(() => useSimilarityIndex(index));
  await act(async () => { await Promise.resolve(); });
  unmount();
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(index).toHaveBeenCalledTimes(1);
});

it("stops after a public failure message", async () => {
  const index = vi.fn().mockRejectedValue({ code: "database_failed", message: "인덱스를 준비하지 못했습니다." });
  const { result } = renderHook(() => useSimilarityIndex(index));
  await waitFor(() => expect(result.current.running).toBe(false));
  expect(result.current.message).toBe("인덱스를 준비하지 못했습니다.");
  expect(index).toHaveBeenCalledTimes(1);
});

it("pauses indexing in light and recovery, then resumes the pending batch", async () => {
  workload.restricted = true;
  const index = vi.fn().mockResolvedValue({ remaining: 0, failed: 0 });
  const { result, rerender } = renderHook(() => useSimilarityIndex(index));
  expect(index).not.toHaveBeenCalled();
  expect(result.current.running).toBe(false);
  workload.restricted = false;
  rerender();
  await waitFor(() => expect(index).toHaveBeenCalledOnce());
});
