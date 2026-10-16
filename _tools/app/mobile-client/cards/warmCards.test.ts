import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {WARM_CONCURRENCY, WARM_MAX_IDS, warmArt, warmTargets} from './warmCards';
import type {TabletCardsApi} from './cardsClient';

const fakeApi = (): TabletCardsApi => ({
  state: vi.fn(), open: vi.fn(), keep: vi.fn(), pack: vi.fn(), album: vi.fn(), setTrashed: vi.fn(),
  art: vi.fn(async id => `https://art.test/${id}.webp`), cutout: vi.fn(async id => `https://cut.test/${id}.png`),
});
// Idle runs on the next tick, so tests control the order with fake timers.
const idle = (run: () => void) => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

it('reads only art ids from the prefetch hint, in pack order without repeats, capped', () => {
  const ids = (prefix: string, count: number) => Array.from({length: count}, (_, i) => `${prefix}${i}`);
  const targets = warmTargets({prefetch: [{packId: 'd-1', assetIds: ['a', 'b', 'a'], cutoutAssetIds: ['c']}, {packId: 'b-1', assetIds: ['b', 'd'], cutoutAssetIds: ['c', 'e']}]});
  expect(targets).toEqual({art: ['a', 'b', 'd'], cutouts: ['c', 'e']});
  expect(warmTargets({prefetch: [{packId: 'd-1', assetIds: ids('a', 40)}]}).art).toHaveLength(WARM_MAX_IDS);
  expect(warmTargets(undefined)).toEqual({art: [], cutouts: []});
  expect(warmTargets({} as never)).toEqual({art: [], cutouts: []});
});

it('loads a few ids at a time, never more than the concurrency', async () => {
  const api = fakeApi(); let active = 0, peak = 0;
  const load = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 50)); active--; });
  warmArt(api, ['a', 'b', 'c', 'd', 'e'], {load, idle, busy: () => false});
  await flush(1000);
  expect(load).toHaveBeenCalledTimes(5);
  expect(peak).toBe(WARM_CONCURRENCY);
  expect(vi.mocked(api.art).mock.calls.map(call => call[0]).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
});

it('waits while the user is busy and goes on when the screen is quiet', async () => {
  const api = fakeApi(); const load = vi.fn(async () => undefined); let busy = true;
  warmArt(api, ['a'], {load, idle, busy: () => busy, retryMs: 100});
  await flush(1000);
  expect(load).not.toHaveBeenCalled();
  expect(api.art).not.toHaveBeenCalled();
  busy = false; await flush(300);
  expect(load).toHaveBeenCalledTimes(1);
});

it('skips ids warmed before, and a changed list costs only its new members', async () => {
  const api = fakeApi(); const load = vi.fn(async () => undefined);
  warmArt(api, ['a', 'b'], {load, idle, busy: () => false}); await flush(100);
  warmArt(api, ['a', 'b', 'c'], {load, idle, busy: () => false}); await flush(100);
  expect(load).toHaveBeenCalledTimes(3);
  expect(vi.mocked(api.art)).toHaveBeenCalledTimes(3);
});

it('warms cutout layers through the cutout ticket, apart from library art', async () => {
  const api = fakeApi(); const load = vi.fn(async () => undefined);
  warmArt(api, ['x'], {load, idle, busy: () => false, cutouts: true}); await flush(100);
  expect(api.cutout).toHaveBeenCalledWith('x');
  expect(api.art).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledWith('https://cut.test/x.png');
  warmArt(api, ['x'], {load, idle, busy: () => false}); await flush(100);
  expect(api.art).toHaveBeenCalledWith('x');
});

it('stops everything when cancelled and survives a failing ticket', async () => {
  const api = fakeApi(); const load = vi.fn(async () => undefined);
  vi.mocked(api.art).mockRejectedValueOnce(new Error('offline'));
  const stop = warmArt(api, ['a', 'b', 'c', 'd'], {load, idle, busy: () => false, concurrency: 1});
  await flush(0);
  stop(); await flush(1000);
  expect(load.mock.calls.length).toBeLessThanOrEqual(1);
  const again = warmArt(api, ['d'], {load, idle, busy: () => false}); await flush(100);
  expect(load).toHaveBeenLastCalledWith('https://art.test/d.webp');
  again();
});
