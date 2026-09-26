import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', async () => {
  const actual = await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual, api: mocks.api};
});

import {ApiError} from './transport';
import {fetchLibrarySummary, librarySummaryPath, parseLibrarySummary, tzOffsetMinutes} from './librarySummary';

const GENERATION = 'a'.repeat(64);
const REPLY = {
  total: 9800, addedToday: 12, addedThisWeek: 40, unclassified: 3,
  todayStart: '2026-09-25T15:00:00Z', weekStart: '2026-09-20T15:00:00Z',
  tzOffsetMinutes: 540, listGeneration: GENERATION,
};

function at(offsetBehindUtc: number): Date {
  const date = new Date('2026-09-26T00:00:00Z');
  vi.spyOn(date, 'getTimezoneOffset').mockReturnValue(offsetBehindUtc);
  return date;
}

describe('librarySummary', () => {
  beforeEach(() => { mocks.api.mockReset(); });

  it('sends the device offset as minutes east of UTC', () => {
    expect(tzOffsetMinutes(at(-540))).toBe(540);
    expect(tzOffsetMinutes(at(300))).toBe(-300);
    expect(Object.is(tzOffsetMinutes(at(0)), 0)).toBe(true);
    expect(librarySummaryPath(at(-540))).toBe('/v1/library/summary?tzOffsetMinutes=540');
  });

  it('returns the validated summary', async () => {
    mocks.api.mockResolvedValue(REPLY);
    const summary = await fetchLibrarySummary(undefined, at(-540));
    expect(mocks.api).toHaveBeenCalledWith('/v1/library/summary?tzOffsetMinutes=540', undefined);
    expect(summary).toEqual({
      total: 9800, addedToday: 12, addedThisWeek: 40, unclassified: 3,
      todayStart: '2026-09-25T15:00:00Z', weekStart: '2026-09-20T15:00:00Z', listGeneration: GENERATION,
    });
  });

  it('is null on an old server (404)', async () => {
    mocks.api.mockImplementation(async () => { throw new ApiError('Not Found', 404, null); });
    await expect(fetchLibrarySummary()).resolves.toBeNull();
  });

  it('propagates auth and transport failures', async () => {
    mocks.api.mockImplementation(async () => { throw new ApiError('Unauthorized', 401, null); });
    await expect(fetchLibrarySummary()).rejects.toMatchObject({status: 401});
    mocks.api.mockImplementation(async () => { throw new Error('offline'); });
    await expect(fetchLibrarySummary()).rejects.toThrow('offline');
  });

  it('rejects malformed shapes', () => {
    expect(parseLibrarySummary(null)).toBeNull();
    expect(parseLibrarySummary({...REPLY, total: -1})).toBeNull();
    expect(parseLibrarySummary({...REPLY, addedToday: 1.5})).toBeNull();
    expect(parseLibrarySummary({...REPLY, unclassified: '3'})).toBeNull();
    expect(parseLibrarySummary({...REPLY, weekStart: undefined})).toBeNull();
    expect(parseLibrarySummary({...REPLY, listGeneration: 'nope'})).toBeNull();
  });
});
