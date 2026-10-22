import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Asset} from './types';

// Parity U06 (같은 게시물 in 정보) and U27 (통계 from More).
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./useLibraryArtists', () => ({useLibraryArtists: () => ({allArtists: [], assignments: []})}));
vi.mock('./transport', () => ({api: mocks.api, native: mocks.native, errorText: (e: Error) => e.message}));
vi.mock('./media', () => ({loadThumbnail: async (asset: Asset) => ({...asset, preview: `blob:${asset.id}`})}));
import {ViewerInfo} from './ViewerInfo';
import {TabletStatistics} from './TabletStatistics';
import {tabletMoreEntries} from './MoreSheet';

const asset = (id: string, overrides: Partial<Asset> = {}): Asset => ({id, kind: 'image', width: 600, height: 800,
  source_url: `https://x.com/artist/status/123/photo/${id}`, ...overrides});

beforeEach(() => {
  mocks.api.mockReset(); mocks.native.mockReset();
  mocks.native.mockResolvedValue({adopted: false});
});
afterEach(cleanup);

it('shows the same-post group with the current image marked and opens a tapped one', async () => {
  const group = [asset('1'), asset('2'), asset('3')];
  mocks.api.mockResolvedValue({version: 1, assetId: '2', items: group});
  const open = vi.fn();
  render(<ViewerInfo asset={group[1]} onOpenAsset={open}/>);
  const third = await screen.findByRole('button', {name: '같은 게시물 3번째 열기'});
  expect(mocks.api).toHaveBeenCalledWith('/v1/library/assets/2/same-post', expect.any(AbortSignal));
  expect(screen.getByRole('button', {name: '같은 게시물 2번째 열기'}).getAttribute('aria-current')).toBe('true');
  fireEvent.click(third);
  expect(open).toHaveBeenCalledWith(group, 2);
});

it('asks for a group only for an X post and shows none for a single image', async () => {
  render(<ViewerInfo asset={asset('web', {source_url: 'https://example.com/status/123'})}/>);
  expect(mocks.api).not.toHaveBeenCalled();
  cleanup();
  mocks.api.mockResolvedValue({version: 1, assetId: 'solo', items: [asset('solo')]});
  render(<ViewerInfo asset={asset('solo')}/>);
  await waitFor(() => expect(mocks.api).toHaveBeenCalled());
  expect(screen.queryByRole('region', {name: '같은 게시물'})).toBeNull();
});

it('shows the server counts and keeps PC-only activity labelled as such', async () => {
  mocks.api.mockResolvedValue({assets: 1234, mediaKinds: [{label: 'image', count: 1200}, {label: 'video', count: 34}],
    favorites: null, unclassified: 5, originalRecordedBytes: 2048, collections: {total: 3, byType: {game: 3, manga: 0, movie: 0, av: 0}},
    collectedMonths: [{label: '2026-10', count: 7}], artists: [{id: 'a', label: '주연', count: 80}], artistsPublishedAt: null,
    classifications: [{id: 'c', label: '배경', count: 9}]});
  render(<TabletStatistics onClose={vi.fn()}/>);
  const totals = await screen.findByRole('region', {name: '보관 현황'});
  expect(totals.textContent).toContain('1,234');
  expect(totals.textContent).toContain('좋아요—');
  expect(screen.getByText('주연')).toBeTruthy();
  expect(screen.getByText('2026-10')).toBeTruthy();
  expect(screen.getByRole('region', {name: 'PC 앱에서'})).toBeTruthy();
  expect(String(mocks.api.mock.calls[0][0])).toMatch(/^\/v1\/library\/statistics\?utcOffsetMinutes=-?\d+$/);
});

it('offers 통계 in More only where the app wires it', () => {
  const base = {reviewCount: 0, unsortedCount: null, unseen: 0, trashCount: null, vaultPresent: false,
    onReview: vi.fn(), onUnsorted: vi.fn(), onExchange: vi.fn(), onVault: vi.fn(), onArtists: vi.fn(), onTrash: vi.fn(), onSettings: vi.fn()};
  expect(tabletMoreEntries(base).some(entry => entry.id === 'statistics')).toBe(false);
  const onStatistics = vi.fn();
  tabletMoreEntries({...base, onStatistics}).find(entry => entry.id === 'statistics')!.run();
  expect(onStatistics).toHaveBeenCalled();
});
