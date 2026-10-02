import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";
import { CLOUD_PROGRESS_EVENT } from "./useCloudBackfillSupervisor";
import { useCloudSyncStatus } from "./useCloudProblems";

afterEach(cleanup);
const progress: CloudBackfillProgress = { controlState: "idle", totalAssets: 1, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: 1, failed: 0, activeWorkers: 0, lastError: null, activity: [] };

it("skips equal serialized progress while retaining nested changes and library resets", async () => {
  const gateway = { cloudBackfillProgress: vi.fn().mockResolvedValue(progress) } as unknown as LibraryGateway;
  const committed = vi.fn();
  function Status({ root }: { root: string }) {
    const status = useCloudSyncStatus(gateway, root);
    return <output>{JSON.stringify(status.progress)}</output>;
  }
  const tree = (root: string) => <Profiler id="cloud" onRender={committed}><Status root={root} /></Profiler>;
  const view = render(tree("one"));
  await act(async () => {});
  committed.mockClear();
  const emit = (next: CloudBackfillProgress, root = "one") => window.dispatchEvent(new CustomEvent(CLOUD_PROGRESS_EVENT, { detail: { gateway, libraryRoot: root, progress: next } }));
  for (let i = 0; i < 6; i++) await act(async () => { emit(JSON.parse(JSON.stringify(progress))); });
  expect(committed).not.toHaveBeenCalled();
  const changed = { ...progress, activity: [{ direction: "capture" as const, lastAttemptAt: null, lastSuccessAt: null, lastError: "offline", processed: 0, problems: 1 }] };
  await act(async () => { emit(changed); });
  expect(screen.getByRole("status")).toHaveTextContent("offline");
  expect(committed).toHaveBeenCalledTimes(1);
  gateway.cloudBackfillProgress = vi.fn(() => new Promise<CloudBackfillProgress>(() => {}));
  view.rerender(tree("two"));
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("null");
  await act(async () => { emit(changed); });
  expect(screen.getByRole("status")).toHaveTextContent("null");
  await act(async () => { emit(changed, "two"); });
  expect(screen.getByRole("status")).toHaveTextContent("offline");
});
