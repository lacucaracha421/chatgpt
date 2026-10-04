import {cleanup, renderHook, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {pickHomeDailyAsset, useTabletHomeDaily} from './HomeMedia';
import {resetHomeSourceCache} from './homeCache';
import type {Asset} from './types';

const mocks = vi.hoisted(() => ({native: vi.fn(), api: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), native: mocks.native, api: mocks.api}));
const image = (id: string, width: number, height: number, kind = 'image'): Asset => ({id, width, height, kind});
beforeEach(() => {resetHomeSourceCache(); mocks.native.mockReset(); mocks.api.mockReset();});
afterEach(cleanup);

it('matches the PC daily hash, prefers portraits and near squares and excludes wide, unknown and video assets', () => {
  const candidates = [image('portrait', 800, 1200), image('square', 1100, 1000), image('landscape', 1800, 1000), image('wide', 2100, 1000), image('video', 800, 1200, 'video'), image('unknown', 800, 0)];
  expect(pickHomeDailyAsset(candidates, '2026-10-04')?.id).toBe('square');
  expect(pickHomeDailyAsset([...candidates].reverse(), '2026-10-04')?.id).toBe('square');
  const seen = new Set(Array.from({length: 31}, (_, index) => pickHomeDailyAsset(candidates, `2026-10-${String(index + 1).padStart(2, '0')}`)?.id));
  expect([...seen].sort()).toEqual(['portrait', 'square']);
  expect(pickHomeDailyAsset(candidates.slice(2), '2026-10-04')?.id).toBe('landscape');
  expect(pickHomeDailyAsset(candidates.slice(3), '2026-10-04')).toBeNull();
});

it('reads the designated likes album across every page rather than assuming its name or using legacy favorites', async () => {
  mocks.native.mockResolvedValue({adopted: true, libraryId: 'lib', epoch: 2, albums: []});
  mocks.api.mockImplementation(async (path: string) => path.startsWith('/v1/albums/likes') ? {albumId: 'renamed-likes'} : new URL(path, 'https://test').searchParams.has('cursor')
    ? {items: [image('portrait', 800, 1200)], hasMore: false, nextCursor: null}
    : {items: [image('landscape', 1800, 1000)], hasMore: true, nextCursor: 'page2'});
  const {result} = renderHook(() => useTabletHomeDaily(true, 'scope', '2026-10-04', 0));
  await waitFor(() => expect(result.current.value?.asset?.id).toBe('portrait'));
  expect(mocks.api).toHaveBeenCalledTimes(3);
  expect(new URL(mocks.api.mock.calls[2][0], 'https://test').searchParams.get('albumId')).toBe('renamed-likes');
});

it('reports unsupported album authority separately from an available but empty favorite list', async () => {
  mocks.native.mockResolvedValue({adopted: false});
  const {result, rerender} = renderHook(({scope}) => useTabletHomeDaily(true, scope, '2026-10-04', 0), {initialProps: {scope: 'old'}});
  await waitFor(() => expect(result.current.value).toEqual({asset: null, available: false}));
  mocks.native.mockResolvedValue({adopted: true, libraryId: 'lib', epoch: 2}); mocks.api.mockResolvedValue({albumId: null});
  rerender({scope: 'new'});
  await waitFor(() => expect(result.current.value).toEqual({asset: null, available: true}));
});
