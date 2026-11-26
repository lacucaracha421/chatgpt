import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Asset} from './types';

// Parity U06 (같은 게시물 in 정보).
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./useLibraryArtists', () => ({useLibraryArtists: () => ({allArtists: [], assignments: []})}));
vi.mock('./transport', () => ({api: mocks.api, native: mocks.native, errorText: (e: Error) => e.message}));
vi.mock('./media', () => ({loadThumbnail: async (asset: Asset) => ({...asset, preview: `blob:${asset.id}`})}));
import {ViewerInfo} from './ViewerInfo';

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
