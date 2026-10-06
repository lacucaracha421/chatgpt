import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";
import { LaunchSplash, releaseLaunchSplash, resetLaunchSplashForTests } from "../shared/launch/LaunchSplash";
import { useCloudBackfillSupervisor } from "./useCloudBackfillSupervisor";
import { useCloudSyncStatus } from "./useCloudProblems";

afterEach(() => { cleanup(); resetLaunchSplashForTests(); vi.useRealTimers(); });

it("defers both Home/status readers and polling through the splash fade, then shares one pending read", async () => {
  vi.useFakeTimers();
  resetLaunchSplashForTests();
  let finish!: (progress: CloudBackfillProgress) => void;
  const read = vi.fn().mockReturnValue(new Promise<CloudBackfillProgress>(resolve => { finish = resolve; }));
  const gateway = { cloudBackfillProgress: read } as unknown as LibraryGateway;
  function Consumers() {
    useCloudSyncStatus(gateway, "root");
    useCloudSyncStatus(gateway, "root");
    useCloudBackfillSupervisor(gateway, "root");
    return null;
  }
  render(<><LaunchSplash elapsed={() => 0} /><Consumers /></>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(read).not.toHaveBeenCalled();
  act(() => releaseLaunchSplash());
  await act(async () => { await vi.advanceTimersByTimeAsync(239); });
  expect(read).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => finish({ totalAssets: 0, completed: 0, activeWorkers: 0, lastError: null, failed: 0, activity: [], queued: 0, preparing: 0, uploading: 0, committing: 0, controlState: "idle" }));
});

it("publishes a completed control state without mutating the snapshot shared with status readers", async () => {
  vi.useFakeTimers();
  resetLaunchSplashForTests();
  let finish!: (progress: CloudBackfillProgress) => void;
  const read = vi.fn().mockReturnValue(new Promise<CloudBackfillProgress>(resolve => { finish = resolve; }));
  const idle = vi.fn().mockResolvedValue("idle");
  const gateway = { cloudBackfillProgress: read, cloudBackfillSetControlState: idle } as unknown as LibraryGateway;
  function Consumers() {
    const status = useCloudSyncStatus(gateway, "root");
    useCloudBackfillSupervisor(gateway, "root");
    return <output>{status.progress?.controlState}</output>;
  }
  render(<Consumers />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const snapshot: CloudBackfillProgress = { totalAssets: 0, completed: 0, activeWorkers: 0, lastError: null, failed: 0, activity: [], queued: 0, preparing: 0, uploading: 0, committing: 0, controlState: "running" };
  await act(async () => finish(snapshot));
  expect(read).toHaveBeenCalledTimes(1);
  expect(idle).toHaveBeenCalledWith("idle");
  expect(snapshot.controlState).toBe("running");
  expect(screen.getByRole("status")).toHaveTextContent("idle");
});
