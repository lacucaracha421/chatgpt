import { expect, it, vi } from "vitest";
import type { CloudBackfillProgress, LibraryGateway } from "../library/types";
import { readCloudProgress } from "./cloudProgressRead";

it("shares overlapping reads by gateway and library, and reads again after completion or failure", async () => {
  let finish!: (value: CloudBackfillProgress) => void;
  const progress = { totalAssets: 1 } as CloudBackfillProgress;
  const gateway = { cloudBackfillProgress: vi.fn().mockImplementation(() => new Promise<CloudBackfillProgress>(resolve => { finish = resolve; })) } as unknown as LibraryGateway;
  const first = readCloudProgress(gateway, "root");
  expect(readCloudProgress(gateway, "root")).toBe(first);
  expect(readCloudProgress(gateway, "root")).toBe(first);
  await Promise.resolve();
  expect(gateway.cloudBackfillProgress).toHaveBeenCalledTimes(1);
  finish(progress);
  await first;
  gateway.cloudBackfillProgress = vi.fn().mockResolvedValue(progress);
  await readCloudProgress(gateway, "root");
  expect(gateway.cloudBackfillProgress).toHaveBeenCalledTimes(1);
  const a = readCloudProgress(gateway, "a");
  const b = readCloudProgress(gateway, "b");
  expect(a).not.toBe(b);
  await Promise.all([a, b]);
  gateway.cloudBackfillProgress = vi.fn().mockRejectedValue(new Error("failed"));
  await expect(readCloudProgress(gateway, "root")).rejects.toThrow("failed");
  await expect(readCloudProgress(gateway, "root")).rejects.toThrow("failed");
  expect(gateway.cloudBackfillProgress).toHaveBeenCalledTimes(2);
});
