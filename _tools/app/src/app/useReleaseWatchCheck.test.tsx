import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReleaseWatchCheck } from "./useReleaseWatchCheck";
import type { CollectionUpdateStatus, LibraryGateway, ReleaseWatchRunResult } from "../library/types";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function Harness({ gateway, changed, root = "fixture" }: {gateway: LibraryGateway; changed: (result: ReleaseWatchRunResult) => Promise<void>; root?: string}) {
  useReleaseWatchCheck(gateway, root, changed); return null;
}
const status: CollectionUpdateStatus = {provider:"mangadex",checked:0,changedCollections:0,failed:0,remaining:0,requests:0,elapsedMs:0,networkMs:0,throttleMs:0,startedAt:null,finishedAt:null,retryAt:null,stopReason:null,busy:false};
it("continues pending batches and keeps Kakao independent of MangaDex errors", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const run = vi.fn(async (provider: string) => {
    if (provider === "mangadex") throw new Error("unavailable");
    calls++;
    return {...status, provider: "kakao", checked: calls, changedCollections: calls, remaining: calls === 1 ? 1 : 0, startedAt: "now"};
  });
  const gateway = { collectionTracking: {runUpdates: run, updateStatus: vi.fn().mockResolvedValue({...status,remaining:1})} } as unknown as LibraryGateway;
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<Harness gateway={gateway} changed={changed}/>);
  await act(async () => {});
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({provider:"kakao",checked:1}));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(calls).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(calls).toBe(2);
});
it("does not start further requests after the library is unmounted", async () => {
  vi.useFakeTimers();
  let finish!: (value: CollectionUpdateStatus) => void;
  const run = vi.fn(() => new Promise<CollectionUpdateStatus>(resolve => { finish = resolve; }));
  const gateway = { collectionTracking: {runUpdates: run, updateStatus: vi.fn().mockResolvedValue({...status,remaining:1})} } as unknown as LibraryGateway;
  const changed = vi.fn().mockResolvedValue(undefined);
  const mounted = render(<Harness gateway={gateway} changed={changed}/>);
  await act(async () => {});
  mounted.unmount();
  await act(async () => { finish({...status,remaining:8}); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
  expect(run).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
});

it("wakes at the provider retry deadline instead of the hourly interval", async () => {
  vi.useFakeTimers();
  const retryAt = new Date(Date.now() + 5000).toISOString();
  const current = {...status, remaining: 1, retryAt, stopReason: "unavailable" as const};
  const run = vi.fn(async () => ({...status, checked: 1, startedAt: "run", finishedAt: "done"}));
  const gateway = {collectionTracking: {
    updateStatus: vi.fn(async (provider: string) => provider === "mangadex" ? current : {...status, provider: "kakao"}),
    runUpdates: run,
  }} as unknown as LibraryGateway;
  render(<Harness gateway={gateway} changed={vi.fn().mockResolvedValue(undefined)}/>);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(run).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(run).toHaveBeenCalledWith("mangadex");
});

it("schedules a new failure deadline while the other provider continues", async () => {
  vi.useFakeTimers();
  let failed = false;
  const run = vi.fn(async (provider: string) => {
    if (provider === "kakao") return {...status,provider:"kakao",checked:1,remaining:0};
    if (!failed) {
      failed = true;
      return {...status,remaining:1,retryAt:new Date(Date.now()+5000).toISOString(),stopReason:"unavailable"};
    }
    return {...status,checked:1,remaining:0};
  });
  const gateway = {collectionTracking:{
    updateStatus:vi.fn(async () => ({...status,remaining:1})), runUpdates:run,
  }} as unknown as LibraryGateway;
  render(<Harness gateway={gateway} changed={vi.fn().mockResolvedValue(undefined)}/>);
  await act(async () => {});
  expect(run.mock.calls.map(([provider])=>provider)).toEqual(["mangadex","kakao"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(run).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(run.mock.calls[2][0]).toBe("mangadex");
});
