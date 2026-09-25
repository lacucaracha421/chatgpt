import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AuthoritySyncHealth, CloudBackfillProgress, LibraryGateway } from "../library/types";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "./useAssetAuthoritySync";
import { CLOUD_PROGRESS_EVENT } from "./useCloudBackfillSupervisor";
import { cloudProblemCount, useAuthoritySyncHealth, useCloudProblems } from "./useCloudProblems";

const progress = { failed: 2, activity: [
  { direction: "replication", lastError: "전송 실패", metadataLastError: "기록 실패" },
  { direction: "capture", lastError: "수신 실패" },
] } as CloudBackfillProgress;

it("counts failed assets once and independent capture/metadata problems", () => {
  expect(cloudProblemCount(progress)).toBe(4);
  expect(cloudProblemCount({ ...progress, failed: 0 })).toBe(3);
  expect(cloudProblemCount({ failed: 0 } as CloudBackfillProgress)).toBe(0);
});

it("uses supervisor updates, ignores other libraries and clears resolved problems", async () => {
  const gateway = { cloudBackfillProgress: vi.fn().mockResolvedValue(progress) } as unknown as LibraryGateway;
  const { result, unmount } = renderHook(() => useCloudProblems(gateway, "test"));
  await waitFor(() => expect(result.current).toBe(4));
  const emit = (root: string) => window.dispatchEvent(new CustomEvent(CLOUD_PROGRESS_EVENT, { detail: { gateway, libraryRoot: root, progress: { failed: 0, activity: [] } } }));
  act(() => { emit("other"); });
  expect(result.current).toBe(4);
  act(() => { emit("test"); });
  expect(result.current).toBe(0);
  unmount();
});

it("does not replace a fresh supervisor result with a late initial snapshot", async () => {
  let resolve!: (value: CloudBackfillProgress) => void;
  const gateway = { cloudBackfillProgress: () => new Promise<CloudBackfillProgress>(done => { resolve = done; }) } as LibraryGateway;
  const { result, unmount } = renderHook(() => useCloudProblems(gateway, "test"));
  await act(async () => {});
  act(() => { window.dispatchEvent(new CustomEvent(CLOUD_PROGRESS_EVENT, { detail: { gateway, libraryRoot: "test", progress: { failed: 0 } } })); });
  await act(async () => resolve(progress));
  expect(result.current).toBe(0);
  unmount();
});

it("reads server sync health on mount, on refresh and after authority changes", async () => {
  const health = { albums: { blockedCount: 1 } } as unknown as AuthoritySyncHealth;
  const authoritySyncHealth = vi.fn().mockResolvedValue(health);
  const gateway = { authoritySyncHealth } as unknown as LibraryGateway;
  const { result, unmount } = renderHook(() => useAuthoritySyncHealth(gateway, "test"));
  await waitFor(() => expect(result.current.health).toBe(health));
  expect(authoritySyncHealth).toHaveBeenCalledTimes(1);
  act(() => { result.current.refresh(); });
  await waitFor(() => expect(authoritySyncHealth).toHaveBeenCalledTimes(2));
  act(() => { window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT)); });
  await waitFor(() => expect(authoritySyncHealth).toHaveBeenCalledTimes(3));
  unmount();
  window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT));
  expect(authoritySyncHealth).toHaveBeenCalledTimes(3);
});
