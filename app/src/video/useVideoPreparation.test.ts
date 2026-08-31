import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useVideoPreparation } from "./useVideoPreparation";
import type { VideoPreparationProgress } from "../library/types";
import type { Mock } from "vitest";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

it("prepares one pending video at a time until remaining is zero", async () => {
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const prepare = vi
    .fn()
    .mockImplementationOnce(async () => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;
      return { processed: 1, remaining: 1, failed: 0, changedAssetIds: ["v1"] };
    })
    .mockImplementationOnce(async () => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      activeCalls -= 1;
      return { processed: 1, remaining: 0, failed: 0, changedAssetIds: ["v2"] };
    });
  const onChanged = vi.fn();

  const { result } = renderHook(() =>
    useVideoPreparation({ enabled: true, trigger: 0, prepare, retry: vi.fn(), onChanged }),
  );

  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(prepare).toHaveBeenNthCalledWith(1, 5);
  expect(prepare).toHaveBeenNthCalledWith(2, 5);
  expect(maximumActiveCalls).toBe(1);
  expect(onChanged.mock.calls.map(([ids]) => ids)).toEqual([["v1"], ["v2"]]);
  expect(result.current.work?.status).toBe("completed");
});

it("stops scheduling when unmounted", async () => {
  let resolve!: (value: {
    processed: number;
    remaining: number;
    failed: number;
    changedAssetIds: string[];
  }) => void;
  const prepare = vi.fn().mockReturnValue(
    new Promise((next) => {
      resolve = next;
    }),
  );
  const onChanged = vi.fn();
  const { unmount } = renderHook(() =>
    useVideoPreparation({ enabled: true, trigger: 0, prepare, retry: vi.fn(), onChanged }),
  );
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());

  unmount();
  await act(async () => {
    resolve({ processed: 1, remaining: 1, failed: 0, changedAssetIds: ["v1"] });
    await Promise.resolve();
  });

  expect(prepare).toHaveBeenCalledOnce();
  expect(onChanged).not.toHaveBeenCalled();
});

it("shows a recoverable work item and retries a failed asset", async () => {
  const prepare = vi
    .fn()
    .mockResolvedValueOnce({ processed: 1, remaining: 0, failed: 1, changedAssetIds: ["v1"] })
    .mockResolvedValueOnce({ processed: 1, remaining: 0, failed: 0, changedAssetIds: ["v1"] });
  const retry = vi.fn().mockResolvedValue("pending");
  const { result } = renderHook(() =>
    useVideoPreparation({ enabled: true, trigger: 0, prepare, retry, onChanged: vi.fn() }),
  );
  await waitFor(() => expect(result.current.work?.status).toBe("failed"));

  await act(async () => result.current.retryFailed());

  expect(retry).toHaveBeenCalledWith("v1");
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(result.current.work?.status).toBe("completed");
});

it("turns a rejected preparation call into one recoverable work item", async () => {
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(new Error("tool unavailable"))
    .mockResolvedValueOnce({ processed: 0, remaining: 0, failed: 0, changedAssetIds: [] });
  const { result } = renderHook(() =>
    useVideoPreparation({ enabled: true, trigger: 0, prepare, retry: vi.fn(), onChanged: vi.fn() }),
  );
  await waitFor(() => expect(result.current.work?.status).toBe("failed"));
  expect(result.current.work?.failures[0]?.message).toBe("tool unavailable");

  await act(async () => result.current.retryFailed());

  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(result.current.work).toBeNull();
});

it("runs preparation after StrictMode effect replay", async () => {
  const prepare = vi
    .fn()
    .mockResolvedValueOnce({ processed: 1, remaining: 0, failed: 0, changedAssetIds: ["v1"] })
    .mockResolvedValue({ processed: 0, remaining: 0, failed: 0, changedAssetIds: [] });
  const onChanged = vi.fn();

  renderHook(
    () => useVideoPreparation({ enabled: true, trigger: 0, prepare, retry: vi.fn(), onChanged }),
    { wrapper: StrictMode },
  );

  await waitFor(() => expect(prepare).toHaveBeenCalled());
  expect(onChanged).toHaveBeenCalledWith(["v1"]);
});

it("keeps scheduling later runs while a preparation run is already active", async () => {
  let concurrent = 0;
  let peak = 0;
  let calls = 0;
  const firstGate = deferred<void>();
  const prepare: Mock = vi.fn().mockImplementation(async () => {
    calls += 1;
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    try {
      if (calls === 1) {
        await firstGate.promise;
        return { processed: 1, remaining: 1, failed: 0, changedAssetIds: ["v1"] };
      }
      return { processed: 0, remaining: 0, failed: 0, changedAssetIds: [] };
    } finally {
      concurrent -= 1;
    }
  });
  const onChanged = vi.fn();

  const { rerender } = renderHook(
    ({ trigger }: { trigger: number }) =>
      useVideoPreparation({ enabled: true, trigger, prepare, retry: vi.fn(), onChanged }),
    { initialProps: { trigger: 0 }, wrapper: StrictMode },
  );
  await waitFor(() => expect(calls).toBe(1));
  expect(peak).toBe(1);

  await act(async () => {
    rerender({ trigger: 1 });
    firstGate.resolve();
  });

  await waitFor(() => expect(calls).toBeGreaterThan(1));
  expect(prepare).toHaveBeenCalledWith(5);
  expect(peak).toBe(1);
});

it("does not schedule more preparation after a real unmount", async () => {
  const { promise: pending, resolve: settle } =
    deferred<VideoPreparationProgress>();
  const prepare = vi.fn().mockReturnValue(pending);
  const onChanged = vi.fn();

  const { unmount } = renderHook(
    () => useVideoPreparation({ enabled: true, trigger: 0, prepare, retry: vi.fn(), onChanged }),
    { wrapper: StrictMode },
  );
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));

  unmount();
  await act(async () => {
    settle({ processed: 1, remaining: 1, failed: 0, changedAssetIds: ["v1"] });
    await Promise.resolve();
  });

  expect(prepare).toHaveBeenCalledTimes(1);
  expect(onChanged).not.toHaveBeenCalled();
});
