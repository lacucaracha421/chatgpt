import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LibraryGateway } from '../library/types';
import { LAUNCH_MAINTENANCE_FALLBACK_MS, LaunchSplash, releaseLaunchSplash, resetLaunchSplashForTests } from '../shared/launch/LaunchSplash';
import { useDailyLibraryMaintenance } from './useDailyLibraryMaintenance';

const elapsed = () => 0;
beforeEach(() => { vi.useFakeTimers(); resetLaunchSplashForTests(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function maintenance(restricted = false) {
  const gateway = {
    ensureDailyBackup: vi.fn().mockResolvedValue(null),
    purgeExpiredTrash: vi.fn().mockResolvedValue({ failedAssetIds: [] }),
  };
  const message = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(({ restricted }) => useDailyLibraryMaintenance(gateway as unknown as LibraryGateway, restricted, message, refresh), { initialProps: { restricted } });
  return { ...gateway, message, refresh, ...hook };
}

it('waits until the splash is gone, then runs backup before trash maintenance once', async () => {
  render(<LaunchSplash elapsed={elapsed} capMs={60000} />);
  const jobs = maintenance();
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(jobs.ensureDailyBackup).not.toHaveBeenCalled();
  expect(jobs.purgeExpiredTrash).not.toHaveBeenCalled();
  act(releaseLaunchSplash);
  await act(async () => { vi.advanceTimersByTime(240); });
  await act(async () => { vi.advanceTimersByTime(299); });
  expect(jobs.ensureDailyBackup).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledOnce();
  expect(jobs.purgeExpiredTrash).toHaveBeenCalledOnce();
  expect(jobs.ensureDailyBackup.mock.invocationCallOrder[0]).toBeLessThan(jobs.purgeExpiredTrash.mock.invocationCallOrder[0]!);
  expect(jobs.refresh).toHaveBeenCalledOnce();
  await act(async () => { vi.advanceTimersByTime(LAUNCH_MAINTENANCE_FALLBACK_MS); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledOnce();
});

it('runs once after the fallback delay if readiness never arrives', async () => {
  render(<LaunchSplash elapsed={elapsed} capMs={60000} />);
  const jobs = maintenance();
  await act(async () => { vi.advanceTimersByTime(LAUNCH_MAINTENANCE_FALLBACK_MS - 1); });
  expect(jobs.ensureDailyBackup).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledOnce();
  expect(jobs.purgeExpiredTrash).toHaveBeenCalledOnce();
  act(releaseLaunchSplash);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledOnce();
});

it('cancels pending daily work when its workspace unmounts', async () => {
  render(<LaunchSplash elapsed={elapsed} capMs={60000} />);
  const jobs = maintenance();
  jobs.unmount();
  await act(async () => { vi.advanceTimersByTime(LAUNCH_MAINTENANCE_FALLBACK_MS + 1000); });
  expect(jobs.ensureDailyBackup).not.toHaveBeenCalled();
  expect(jobs.purgeExpiredTrash).not.toHaveBeenCalled();
});

it('keeps daily jobs disabled in restricted mode', async () => {
  const jobs = maintenance(true);
  await act(async () => { vi.advanceTimersByTime(LAUNCH_MAINTENANCE_FALLBACK_MS + 1000); });
  expect(jobs.ensureDailyBackup).not.toHaveBeenCalled();
});

it('retries hourly, reports failures once until success, and cancels on unmount', async () => {
  const jobs = maintenance();
  jobs.ensureDailyBackup.mockRejectedValue(new Error('backup failed'));
  jobs.purgeExpiredTrash.mockResolvedValue({ failedAssetIds: ['locked'] });
  const hour = 60 * 60 * 1000;
  await act(async () => { await vi.advanceTimersByTimeAsync(LAUNCH_MAINTENANCE_FALLBACK_MS); });
  expect(jobs.message).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(hour); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledTimes(2);
  expect(jobs.purgeExpiredTrash).toHaveBeenCalledTimes(2);
  expect(jobs.message).toHaveBeenCalledTimes(2);
  jobs.ensureDailyBackup.mockResolvedValue(null);
  jobs.purgeExpiredTrash.mockResolvedValue({ failedAssetIds: [] });
  await act(async () => { await vi.advanceTimersByTimeAsync(hour); });
  jobs.ensureDailyBackup.mockRejectedValue(new Error('backup failed'));
  jobs.purgeExpiredTrash.mockRejectedValue(new Error('trash failed'));
  await act(async () => { await vi.advanceTimersByTimeAsync(hour); });
  expect(jobs.message).toHaveBeenCalledTimes(4);
  jobs.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(hour * 2); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledTimes(4);
});

it('stops hourly work while restricted and runs again after restriction ends', async () => {
  const jobs = maintenance();
  await act(async () => { await vi.advanceTimersByTimeAsync(LAUNCH_MAINTENANCE_FALLBACK_MS); });
  jobs.rerender({ restricted: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledOnce();
  jobs.rerender({ restricted: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(LAUNCH_MAINTENANCE_FALLBACK_MS); });
  expect(jobs.ensureDailyBackup).toHaveBeenCalledTimes(2);
});
