import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";
import { CLOUD_PROGRESS_EVENT } from "./useCloudBackfillSupervisor";
import { cloudProblemCount, useCloudProblems } from "./useCloudProblems";

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
