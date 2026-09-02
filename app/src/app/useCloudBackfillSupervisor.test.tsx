import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { notifyCloudBackfillSupervisor, useCloudBackfillSupervisor } from "./useCloudBackfillSupervisor";

function Harness({ gateway }: { gateway: LibraryGateway }) {
  useCloudBackfillSupervisor(gateway, "C:\\test-library");
  return null;
}

const running = { controlState: "running" as const, totalAssets: 2, queued: 2, preparing: 0, uploading: 0, committing: 0, completed: 0, failed: 0, activeWorkers: 0, lastError: null };

afterEach(() => cleanup());

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
