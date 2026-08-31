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

let visibilityState: DocumentVisibilityState;
let visibilitySpy: ReturnType<typeof vi.spyOn>;
let focusSpy: ReturnType<typeof vi.spyOn>;

describe("useCloudCaptureSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState);
    focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    visibilitySpy.mockRestore();
    focusSpy.mockRestore();
    vi.useRealTimers();
  });

  it("polls immediately and every 15 seconds while visible", async () => {
    const gateway = {
      runDueCloudCaptureSync: vi.fn().mockResolvedValue(result),
    } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());

    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(result);

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("uses a 60 second background interval and syncs immediately when visible again", async () => {
    const gateway = {
      runDueCloudCaptureSync: vi.fn().mockResolvedValue(result),
    } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(3);
  });

  it("uses the background interval while the window is blurred", async () => {
    const gateway = {
      runDueCloudCaptureSync: vi.fn().mockResolvedValue(result),
    } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());

    act(() => window.dispatchEvent(new Event("blur")));
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);
  });

  it("syncs immediately on focus and restarts the visible timer", async () => {
    const gateway = {
      runDueCloudCaptureSync: vi.fn().mockResolvedValue(result),
    } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(3);
  });

  it("retries after a failed visible poll without reporting a false result", async () => {
    const gateway = {
      runDueCloudCaptureSync: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(result),
    } as unknown as LibraryGateway;
    const onResult = vi.fn();

    renderHook(() => useCloudCaptureSync(gateway, "C:\\Library", onResult));
    await act(async () => Promise.resolve());
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(gateway.runDueCloudCaptureSync).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(result);
  });
});
