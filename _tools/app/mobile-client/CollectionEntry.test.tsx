import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CollectionDetail } from './collectionModel';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', () => ({...mocks, errorText: String}));
import { Collections } from './Collections';
import { resetReleaseStore } from './releaseStore';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  localStorage.clear(); resetReleaseStore();
  localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
  const item: CollectionDetail = {id: 'entry', name: 'Entry work', type: 'game', showcase: false, selectedWorkArtworkId: 'front', selectedHeroArtworkId: 'hero', ownedPlatform: 'PS5', volumes: [], artworks: [{id: 'hero', kind: 'hero', selected: true}]};
  const detail = Promise.withResolvers<{revision: string; item: CollectionDetail}>();
  mocks.native.mockResolvedValue({url: 'https://example.invalid/art', expires_in: 300});
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/v1/collections/entry') return detail.promise;
    if (path.endsWith('/status')) return {revision: 'entry'};
    if (path.startsWith('/v1/collections/releases')) return {revision: 1, counts: {unread: 0, collections: []}, items: [], nextCursor: null};
    if (path === '/v1/home/upcoming') return {entries: [], wishlist: []};
    return {ready: true, filterVersion: 1, revision: 'entry', items: path.includes('showcase=true') ? [] : [item], nextCursor: null};
  });
  return {item, detail};
}
it('keeps the shelf until the record and the actual work images are ready, then returns to the same shelf', async () => {
  const {item, detail} = fixture();
  const view = render(<Collections active paused={false} backRef={{current: null}}/>);
  fireEvent.click(await screen.findByText(item.name));
  const stage = view.container.querySelector('.motion-stage')!;
  const shelf = view.container.querySelector('.collection-scroll');
  expect(stage.getAttribute('data-motion-shown')).toBe('shelf');
  await act(async () => detail.resolve({revision: 'entry', item}));
  await waitFor(() => expect(view.container.querySelector('.tablet-work .kase img')).toBeTruthy());
  expect(stage.getAttribute('data-motion-shown')).toBe('shelf');
  await act(async () => view.container.querySelectorAll('.tablet-work img').forEach(image => fireEvent.load(image)));
  await waitFor(() => expect(stage.getAttribute('data-motion-shown')).toBe('work'));
  expect(screen.getByRole('heading', {name: item.name})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '뒤로'}));
  await waitFor(() => expect(stage.getAttribute('data-motion-shown')).toBe('shelf'));
  expect(view.container.querySelector('.collection-scroll')).toBe(shelf);
});
it('bounds a stalled entry with the same five-second cap as the PC', async () => {
  vi.useFakeTimers();
  fixture();
  const view = render(<Collections active paused={false} backRef={{current: null}}/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  fireEvent.click(screen.getByText('Entry work'));
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  const stage = view.container.querySelector('.motion-stage')!;
  expect(stage.getAttribute('data-motion-shown')).toBe('shelf');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(stage.getAttribute('data-motion-shown')).toBe('work');
});
