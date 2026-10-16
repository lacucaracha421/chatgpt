import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { dismissPublication, publicationProgressText, startPublication, usePublicationJobs, type PublishProgress } from "./publicationJobs";

afterEach(() => { cleanup(); dismissPublication("catalog"); dismissPublication("characters"); });

it("keeps progress and duplicate protection across screen unmounts, completing only after the server returns", async () => {
  let progress!: (value: PublishProgress) => void;
  let complete!: (value: number) => void;
  const run = vi.fn((notify: (value: PublishProgress) => void) => { progress = notify; return new Promise<number>(resolve => { complete = resolve; }); });
  const first = renderHook(() => usePublicationJobs());
  let task!: Promise<void>;
  act(() => { task = startPublication("catalog", run, result => `${result} items complete`); });
  first.unmount();
  act(() => { progress({ phase: "uploading", completed: 5, total: 10, unit: "bytes" }); });
  const { result } = renderHook(() => usePublicationJobs());
  expect(publicationProgressText(result.current.catalog!.progress)).toContain("50%");
  await act(async () => { await startPublication("catalog", run, String); });
  expect(run).toHaveBeenCalledTimes(1);
  act(() => { progress({ phase: "publishing", completed: 0, total: null, unit: "items" }); });
  expect(result.current.catalog?.progress.phase).toBe("publishing");
  expect(result.current.catalog?.running).toBe(true);
  await act(async () => { complete(12); await task; });
  expect(result.current.catalog).toMatchObject({ running: false, message: "12 items complete" });
});

it("retains errors after navigation and allows an explicit retry without blocking the other job", async () => {
  await act(async () => { await startPublication("characters", async () => { throw new Error("offline"); }, String); });
  const first = renderHook(() => usePublicationJobs());
  expect(first.result.current.characters?.error).toBe(true);
  first.unmount();
  const { result } = renderHook(() => usePublicationJobs());
  expect(result.current.characters?.error).toBe(true);
  await act(async () => { await Promise.all([
    startPublication("characters", async () => 4, result => `${result} items complete`),
    startPublication("catalog", async () => 9, result => `${result} items complete`),
  ]); });
  expect(result.current.characters).toMatchObject({ running: false, message: "4 items complete" });
  expect(result.current.catalog).toMatchObject({ running: false, message: "9 items complete" });
  expect(result.current.characters?.error).toBe(false);
  expect(result.current.catalog?.error).toBe(false);
});
