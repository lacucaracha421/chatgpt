import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {MutableRefObject} from 'react';
import {ArtistGrid} from './ArtistGrid';
import {Artists} from './Artists';
import type {LibraryArtist} from './artistsModel';

// Parity U14 (PC hub buckets and sorts) and U15 (artist page 다시보기).
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn(), loadThumbnail: vi.fn()}));
vi.mock('./transport', () => ({api: mocks.api, native: mocks.native, errorText: (e: Error) => e.message}));
vi.mock('./media', () => ({loadThumbnail: mocks.loadThumbnail}));
vi.mock('./Gallery', () => ({Gallery: ({intro, items}: {intro?: React.ReactNode; items: {id: string}[]}) => <div aria-label="자산 목록">{intro}{items.map(item => <span key={item.id}>asset-{item.id}</span>)}</div>}));

const artist = (id: string, label: string, overrides: Partial<LibraryArtist> = {}): LibraryArtist => ({
  id, label, displayName: null, sourceName: label, keys: [id], assetCount: 12, recentCount: 0,
  firstSavedAt: '2024-01-01T00:00:00Z', lastSavedAt: '2026-09-01T00:00:00Z', lastOpenedAt: null,
  pinned: false, hidden: false, main: false, coverAssetIds: [`${id}-1`], ...overrides,
});
const artists = [artist('main', '주연', {main: true, assetCount: 80}), artist('two', '둘째', {assetCount: 3}),
  artist('one', '외톨이', {assetCount: 1}), artist('repost', '퍼옴', {reposter: true, main: true})];
const page = {items: [{id: 'p-1', kind: 'image', width: 600, height: 800}], has_more: false, next_cursor: null, filterVersion: 1};

beforeEach(() => {
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockResolvedValue({}); mocks.loadThumbnail.mockReset();
  mocks.loadThumbnail.mockImplementation(async (asset: {id: string}) => ({...asset, preview: `blob:${asset.id}`}));
  mocks.api.mockImplementation(async (path: string) => {
    if (path.startsWith('/v1/library/assets?')) return page;
    if (path.startsWith('/v1/library/artists/')) return {version: 1, artist: artists[0]};
    if (path.startsWith('/v1/library/artist-rediscovery?')) return {
      onThisDay: {total: 5, yearsAgo: 2, localDate: '2024-10-22', items: [{id: 'old-1', kind: 'image'}, {id: 'old-2', kind: 'image'}]},
      longUnseen: null, longUnseenKnown: false};
    throw new Error(`unexpected path ${path}`);
  });
});
afterEach(cleanup);

const names = () => [...document.querySelectorAll('.artist-grid-card .artist-grid-name')].map(node => node.textContent);

it('splits the published artists into the PC buckets, with 작가 미상 scopes from the snapshot', async () => {
  const open = vi.fn();
  render(<ArtistGrid artists={artists} state="ready" paused={false} endpoint="e" onOpenArtist={open}/>);
  act(() => { window.dispatchEvent(new CustomEvent('lakomics-artist-snapshot-ready', {detail: {endpoint: 'e', reply: {revision: 1, artists, unknown: {none: 3, source: 2}}}})); });
  await waitFor(() => expect(names()).toEqual(['주연']));
  expect(screen.getByRole('button', {name: '퍼온 계정 1'}).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', {name: '그 외 작가 2'}));
  await waitFor(() => expect(names()).toEqual(['둘째', '외톨이']));
  fireEvent.click(screen.getByRole('button', {name: '한 장뿐인 작가 1'}));
  await waitFor(() => expect(names()).toEqual(['외톨이']));
  fireEvent.click(screen.getByRole('button', {name: '작가 미상 5'}));
  await waitFor(() => expect(names()).toEqual(['작가 미상 · 출처 없음', '작가 미상 · 출처만 있음']));
  expect(screen.queryByRole('button', {name: /^정렬/})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '작가 미상 · 출처 없음, 3장'}));
  await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({id: 'unknown:none'})));
  expect(mocks.api.mock.calls.some(([path]) => String(path).includes('artist=unknown%3Anone'))).toBe(true);
});

it('shows the 다시보기 rows with the first artist page and opens the viewer on their own Assets', async () => {
  const backRef: MutableRefObject<(() => boolean) | null> = {current: null};
  const viewer = vi.fn();
  render(<Artists endpoint="e" backRef={backRef} onOpenViewer={viewer} initialArtist={artists[0]}/>);
  fireEvent.click(await screen.findByRole('button', {name: '2년 전 오늘 2번째 열기'}));
  expect(viewer).toHaveBeenCalledWith([expect.objectContaining({id: 'old-1'}), expect.objectContaining({id: 'old-2'})], 1);
  expect(screen.getByText('asset-p-1')).toBeTruthy();
  expect(screen.getByText('오래 안 본 작품은 PC 앱에서')).toBeTruthy();
  expect(String(mocks.api.mock.calls.find(([path]) => String(path).startsWith('/v1/library/artist-rediscovery?'))?.[0])).toContain('artist=main');
});

it('lists a 작가 미상 scope without the artist read, rename menu or 다시보기', async () => {
  const backRef: MutableRefObject<(() => boolean) | null> = {current: null};
  const unknown = {...artist('unknown:none', '작가 미상 · 출처 없음'), keys: [], coverAssetIds: []};
  render(<Artists endpoint="e" backRef={backRef} onOpenViewer={vi.fn()} initialArtist={unknown}/>);
  await screen.findByText('asset-p-1');
  const paths = mocks.api.mock.calls.map(([path]) => String(path));
  expect(paths.some(path => path.startsWith('/v1/library/artists/') || path.startsWith('/v1/library/artist-rediscovery'))).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: '더보기'}));
  expect(screen.queryByRole('button', {name: '이름 바꾸기'})).toBeNull();
});
