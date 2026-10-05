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
  const hook = renderHook(() => useDailyLibraryMaintenance(gateway as unknown as LibraryGateway, restricted, message, refresh));
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
