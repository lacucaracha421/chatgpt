import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { useOnlineCatalogUpdate } from "./useOnlineCatalogUpdate";

describe("useOnlineCatalogUpdate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks immediately and once per hour", async () => {
    const gateway = {
      runDueOnlineCatalogUpdate: vi.fn().mockResolvedValue(null),
    } as unknown as LibraryGateway;

    renderHook(() => useOnlineCatalogUpdate(gateway, "C:\\Library"));
    await act(async () => Promise.resolve());
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(1);
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(2, "japanese");

    await act(async () => vi.advanceTimersByTimeAsync(3_600_000));
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(3);
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(4, "japanese");
  });

  it("attempts the Japanese due check when the Korean check fails", async () => {
    const gateway = {
      runDueOnlineCatalogUpdate: vi.fn()
        .mockRejectedValueOnce(new Error("Korean check failed"))
        .mockResolvedValueOnce(null),
    } as unknown as LibraryGateway;

    renderHook(() => useOnlineCatalogUpdate(gateway, "C:\\Library"));
    await act(async () => Promise.resolve());

    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(1);
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(2, "japanese");
  });

  it("does not overlap a slow due check", async () => {
    let finish: (() => void) | undefined;
    const gateway = {
      runDueOnlineCatalogUpdate: vi.fn()
        .mockImplementationOnce(() => new Promise<null>((resolve) => {
          finish = () => resolve(null);
        }))
        .mockResolvedValue(null),
    } as unknown as LibraryGateway;

    renderHook(() => useOnlineCatalogUpdate(gateway, "C:\\Library"));
    await act(async () => vi.advanceTimersByTimeAsync(7_200_000));
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(2, "japanese");
  });

  it("does not overlap while the Japanese due check is pending", async () => {
    const japanese = deferred<null>();
    const gateway = {
      runDueOnlineCatalogUpdate: vi.fn()
        .mockResolvedValueOnce(null)
        .mockReturnValueOnce(japanese.promise)
        .mockResolvedValue(null),
    } as unknown as LibraryGateway;

    renderHook(() => useOnlineCatalogUpdate(gateway, "C:\\Library"));
    await act(async () => Promise.resolve());
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenNthCalledWith(2, "japanese");

    await act(async () => vi.advanceTimersByTimeAsync(7_200_000));
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(2);
    await act(async () => japanese.resolve(null));
  });

  it("does not start Japanese after unmounting during the Korean due check", async () => {
    const korean = deferred<null>();
    const gateway = {
      runDueOnlineCatalogUpdate: vi.fn()
        .mockReturnValueOnce(korean.promise)
        .mockResolvedValue(null),
    } as unknown as LibraryGateway;

    const { unmount } = renderHook(() => useOnlineCatalogUpdate(gateway, "C:\\Library"));
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => korean.resolve(null));

    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
