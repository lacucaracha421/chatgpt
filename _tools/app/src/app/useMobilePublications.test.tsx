import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { useMobilePublications } from "./useMobilePublications";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("sends the navigation order only at startup or when it changes", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue(undefined);
  const gateway = { runDueMobilePublications: send } as unknown as LibraryGateway;
  const { rerender } = renderHook(({ order }) => useMobilePublications(gateway, "root", order), { initialProps: { order: ["a"] } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  rerender({ order: ["a"] });
  expect(send).toHaveBeenCalledOnce();
  rerender({ order: ["b", "a"] });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(["b", "a"]);
});
it("backs off a failed save and stops waking after success", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
  const gateway = { runDueMobilePublications: send } as unknown as LibraryGateway;
  renderHook(() => useMobilePublications(gateway, "root", ["a"]));
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
  expect(send).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
  expect(send).toHaveBeenCalledTimes(2);
});

it("serializes a changed order behind an in-flight save", async () => {
  let release!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
  const gateway = { runDueMobilePublications: send } as unknown as LibraryGateway;
  const { rerender } = renderHook(({ order }) => useMobilePublications(gateway, "root", order), { initialProps: { order: ["a"] } });
  await act(async () => { await Promise.resolve(); });
  rerender({ order: ["b"] });
  await act(async () => { await Promise.resolve(); });
  expect(send).toHaveBeenCalledOnce();
  await act(async () => { release(); });
  expect(send).toHaveBeenLastCalledWith(["b"]);
  expect(send).toHaveBeenCalledTimes(2);
});
