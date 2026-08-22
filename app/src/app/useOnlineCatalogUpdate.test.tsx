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
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_600_000));
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a slow due check", async () => {
    let finish: (() => void) | undefined;
    const gateway = {
      runDueOnlineCatalogUpdate: vi.fn(() => new Promise<null>((resolve) => {
        finish = () => resolve(null);
      })),
    } as unknown as LibraryGateway;

    renderHook(() => useOnlineCatalogUpdate(gateway, "C:\\Library"));
    await act(async () => vi.advanceTimersByTimeAsync(7_200_000));
    expect(gateway.runDueOnlineCatalogUpdate).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
  });
});
