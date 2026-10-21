import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "./useAssetAuthoritySync";
import type { LibraryGateway } from "../library/types";
import { CLOUD_PROGRESS_EVENT, notifyCloudBackfillSupervisor, useCloudBackfillSupervisor } from "./useCloudBackfillSupervisor";

const nativeSignals = vi.hoisted(() => new Map<string, (event?: unknown) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: (event?: unknown) => void) => {
    nativeSignals.set(event, callback);
    return () => { nativeSignals.delete(event); };
  }),
}));

function Harness({ gateway }: { gateway: LibraryGateway }) {
  useCloudBackfillSupervisor(gateway, "C:\\test-library");
  return null;
}

const running = { controlState: "running" as const, totalAssets: 2, queued: 2, preparing: 0, uploading: 0, committing: 0, completed: 0, failed: 0, activeWorkers: 0, lastError: null };

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("polls idle progress every 60 s and immediately on return", async () => {
  vi.useFakeTimers();
  const progress = vi.fn().mockResolvedValue({ ...running, controlState: "idle", queued: 0 });
  const gateway = { cloudBackfillProgress: progress } as unknown as LibraryGateway;
  const { unmount } = render(<Harness gateway={gateway} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(progress).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(progress).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(progress).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new Event("blur")));
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(progress).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(progress).toHaveBeenCalledTimes(3);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(progress).toHaveBeenCalledTimes(4);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(progress).toHaveBeenCalledTimes(5);
  unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(progress).toHaveBeenCalledTimes(5);
});

it("runs queued work from one application-level supervisor", async () => {
  const run = vi.fn().mockResolvedValue({ committed: 2, retryScheduled: 0, permanentFailures: 0 });
  const gateway = { cloudBackfillProgress: vi.fn().mockResolvedValueOnce(running).mockResolvedValue({ ...running, controlState: "idle", queued: 0, completed: 2 }), cloudBackfillRunCycle: run, cloudBackfillSetControlState: vi.fn().mockResolvedValue("idle") } as unknown as LibraryGateway;
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
});

it("coalesces repeated wake-ups while a worker cycle is already active", async () => {
  let finish!: () => void;
  const cycle = new Promise<void>((resolve) => { finish = resolve; });
  const run = vi.fn().mockReturnValue(cycle);
  const gateway = { cloudBackfillProgress: vi.fn().mockResolvedValue(running), cloudBackfillRunCycle: run, cloudBackfillSetControlState: vi.fn() } as unknown as LibraryGateway;
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  notifyCloudBackfillSupervisor();
  notifyCloudBackfillSupervisor();
  expect(run).toHaveBeenCalledTimes(1);
  finish();
});

it("drains incremental pending work while control stays idle without flipping state", async () => {
  const idlePending = { ...running, controlState: "idle" as const };
  const run = vi.fn().mockResolvedValue({ committed: 1, retryScheduled: 0, permanentFailures: 0 });
  const setControlState = vi.fn().mockResolvedValue("idle");
  const gateway = {
    cloudBackfillProgress: vi.fn()
      .mockResolvedValueOnce(idlePending)
      .mockResolvedValue({ ...idlePending, queued: 0, completed: 2 }),
    cloudBackfillRunCycle: run,
    cloudBackfillSetControlState: setControlState,
  } as unknown as LibraryGateway;
  render(<Harness gateway={gateway} />);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // idle 구간의 증분 처리는 컨트롤 상태를 건드리지 않는다.
  expect(setControlState).not.toHaveBeenCalled();
});

it("keeps polling while idle pending work remains after a cycle", async () => {
  vi.useFakeTimers();
  try {
    const idlePending = { ...running, controlState: "idle" as const };
    const run = vi.fn().mockResolvedValue({ committed: 1, retryScheduled: 0, permanentFailures: 0 });
    const gateway = {
      cloudBackfillProgress: vi.fn().mockResolvedValue(idlePending),
      cloudBackfillRunCycle: run,
      cloudBackfillSetControlState: vi.fn(),
    } as unknown as LibraryGateway;
    render(<Harness gateway={gateway} />);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not start upload cycles while replication is paused", async () => {
  vi.useFakeTimers();
  try {
    const pausedPending = { ...running, controlState: "paused" as const };
    const run = vi.fn();
    const progress = vi.fn().mockResolvedValue(pausedPending);
    const gateway = {
      cloudBackfillProgress: progress,
      cloudBackfillRunCycle: run,
      cloudBackfillSetControlState: vi.fn(),
    } as unknown as LibraryGateway;

    render(<Harness gateway={gateway} />);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(11_000);

    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});


it("publishes fresh progress during a long worker cycle without starting another cycle", async () => {
  vi.useFakeTimers();
  const receive = vi.fn();
  window.addEventListener(CLOUD_PROGRESS_EVENT, receive);
  try {
    const run = vi.fn().mockReturnValue(new Promise(() => {}));
    const progress = vi.fn().mockResolvedValue(running);
    render(<Harness gateway={{ cloudBackfillProgress: progress, cloudBackfillRunCycle: run } as unknown as LibraryGateway} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally { window.removeEventListener(CLOUD_PROGRESS_EVENT, receive); vi.useRealTimers(); }
});

it("wakes idle progress on control and Asset change signals", async () => {
  vi.useFakeTimers();
  const progress = vi.fn().mockResolvedValue({ ...running, controlState: "idle", queued: 0 });
  render(<Harness gateway={{ cloudBackfillProgress: progress } as unknown as LibraryGateway} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { notifyCloudBackfillSupervisor(); await vi.advanceTimersByTimeAsync(0); });
  expect(progress).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT)); await vi.advanceTimersByTimeAsync(0); });
  expect(progress).toHaveBeenCalledTimes(3);
});

it("retains a wake received while an idle status read is in flight", async () => {
  vi.useFakeTimers();
  const idle = { ...running, controlState: "idle" as const, queued: 0 };
  let finish!: (value: typeof idle) => void;
  const progress = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(idle);
  render(<Harness gateway={{ cloudBackfillProgress: progress } as unknown as LibraryGateway} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  act(() => notifyCloudBackfillSupervisor());
  await act(async () => { finish(idle); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(progress).toHaveBeenCalledTimes(2);
});

it("uses 1.5 s for active work then backs off after completion", async () => {
  vi.useFakeTimers();
  const progress = vi.fn().mockResolvedValueOnce(running).mockResolvedValue({ ...running, controlState: "idle", queued: 0 });
  render(<Harness gateway={{ cloudBackfillProgress: progress, cloudBackfillRunCycle: vi.fn().mockResolvedValue({}) } as unknown as LibraryGateway} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
  expect(progress).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(progress).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(progress).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(progress).toHaveBeenCalledTimes(3);
});

it("wakes on existing native ingestion, Asset and workload signals and unsubscribes", async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  try {
    const progress = vi.fn().mockResolvedValue({ ...running, controlState: "idle", queued: 0 });
    const { unmount } = render(<Harness gateway={{ cloudBackfillProgress: progress } as unknown as LibraryGateway} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let calls = 1;
    for (const event of ["extension://ingestion", "library://asset-authority-changed", "workload://changed"]) {
      expect(listen).toHaveBeenCalledWith(event, expect.any(Function));
      await act(async () => { nativeSignals.get(event)!(); await vi.advanceTimersByTimeAsync(0); });
      expect(progress).toHaveBeenCalledTimes(++calls);
    }
    const activities = nativeSignals.get("library://activities-changed")!;
    const send = async (jobs: unknown[]) => act(async () => {
      activities({ payload: { jobs } }); await vi.advanceTimersByTimeAsync(0);
    });
    // Upload status publications must not feed another status read back into themselves.
    await send([{ id: "upload", kind: "cloud_upload", state: "running" }]);
    expect(progress).toHaveBeenCalledTimes(calls);
    const ingest = { id: "import", kind: "ingestion", state: "running" };
    await send([ingest]);
    expect(progress).toHaveBeenCalledTimes(++calls);
    await send([ingest, { id: "upload", kind: "cloud_upload", state: "running" }]);
    expect(progress).toHaveBeenCalledTimes(calls);
    await send([{ ...ingest, state: "done" }]);
    expect(progress).toHaveBeenCalledTimes(++calls);
    unmount();
    expect(nativeSignals.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(progress).toHaveBeenCalledTimes(calls);
  } finally { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); }
});
