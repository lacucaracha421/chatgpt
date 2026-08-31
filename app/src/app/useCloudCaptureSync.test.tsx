import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCaptureSyncResult, LibraryGateway } from "../library/types";
import { useCloudCaptureSync } from "./useCloudCaptureSync";

const result: CloudCaptureSyncResult = {
  attempted: 2,
  acknowledged: 1,
  failed: 0,
  reviewPending: 1,
  added: 1,
  videoAdded: 1,
  classificationChanged: 0,
};

describe("useCloudCaptureSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the immediate result and repeats every five minutes", async () => {
    const gateway = { runDueCloudCaptureSync: vi.fn().mockResolvedValue(result) } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());

    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(result);

    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("retries after a failed poll without reporting a false result", async () => {
    const gateway = {
      runDueCloudCaptureSync: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(result),
    } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(result);
  });
});
