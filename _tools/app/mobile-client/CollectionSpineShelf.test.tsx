import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {resetSpineWarmForTests} from '../src/collections/spineShelfWarm';
import {ArtworkMemoryContext, artworkSource, type ArtworkMemory} from './collectionArtwork';
import type {CollectionSummary} from './collectionModel';
import {TabletSpineShelf} from './CollectionSpineShelf';

const game = (id: string) => ({id, name: `게임 ${id}`, type: 'game', spineArtworkId: `spine-${id}`}) as unknown as CollectionSummary;
const titles = () => screen.queryAllByRole('button').map(button => button.getAttribute('aria-label')!.split(' ·')[0]);

let releases: (() => void)[];
let requested: string[];
let asked: {id: string; original: boolean; medium: boolean}[];
let originals: (() => void)[];
let originalOf: Record<string, () => void>;
let urls: Map<string, string>;
let memory: ArtworkMemory;
beforeEach(() => {
  releases = []; requested = []; urls = new Map(); asked = []; originals = []; originalOf = {};
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('collection-scroll') ? 800 : 0; });
  memory = {
    get: (source: string) => urls.get(source) ?? null,
    request: vi.fn((item: CollectionSummary, id: string, revision: string, original: boolean, _signal: AbortSignal, medium = false) => new Promise<{url: string}>(resolve => {
      requested.push(item.id); asked.push({id, original, medium});
      const release = () => { const url = `https://art.test/${id}${original ? '-original' : ''}`; urls.set(artworkSource(item, id, revision, original, medium), url); resolve({url}); };
      if (original) { originals.push(release); originalOf[id] = release; } else releases.push(release);
    })),
  } as unknown as ArtworkMemory;
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); resetSpineWarmForTests();});

const shelf = (items: CollectionSummary[], picked: string | null = null) => <ArtworkMemoryContext.Provider value={memory}>
  <div className="collection-scroll">
    <TabletSpineShelf items={items} grouping="sort" size="normal" label="게임 작품 목록" revision="r1" active privacy={false} picked={picked} onPick={() => undefined} onOpen={() => undefined}/>
  </div>
</ArtworkMemoryContext.Provider>;

it('keeps the old tablet shelf until the new order\'s first-screen spines are requested and decoded', async () => {
  const {rerender} = render(shelf([game('g1'), game('g2')]));
  await act(async () => { releases.splice(0).forEach(release => release()); });
  expect(titles()).toEqual(['게임 g1', '게임 g2']);

  requested.length = 0;
  rerender(shelf([game('g3'), game('g1')]));
  // Only the work not seen before is requested; the old shelf stays until it is ready.
  expect(requested).toEqual(['g3']);
  expect(titles()).toEqual(['게임 g1', '게임 g2']);
  await act(async () => { releases.splice(0).forEach(release => release()); });
  expect(titles()).toEqual(['게임 g3', '게임 g1']);
});

it('shows an order whose spines are all remembered without waiting', async () => {
  const {rerender} = render(shelf([game('g1'), game('g2')]));
  await act(async () => { releases.splice(0).forEach(release => release()); });
  requested.length = 0;
  rerender(shelf([game('g2'), game('g1')]));
  expect(titles()).toEqual(['게임 g2', '게임 g1']);
  expect(requested).toEqual([]);
});

it('asks for a work\'s action sheet on a long press of its spine instead of picking it', async () => {
  const onPick = vi.fn(), onActions = vi.fn();
  render(<ArtworkMemoryContext.Provider value={memory}><div className="collection-scroll">
    <TabletSpineShelf items={[game('g1'), game('g2')]} grouping="sort" size="normal" label="게임 작품 목록" revision="r1" active privacy={false} picked={null} onPick={onPick} onOpen={() => undefined} onActions={onActions}/>
  </div></ArtworkMemoryContext.Provider>);
  await act(async () => { releases.splice(0).forEach(release => release()); });
  const spine = screen.getByRole('button', {name: /게임 g2/});
  vi.useFakeTimers();
  fireEvent.pointerDown(spine, {button: 0, clientX: 30, clientY: 30});
  act(() => { vi.advanceTimersByTime(450); });
  fireEvent.pointerUp(spine, {button: 0});
  vi.useRealTimers();
  expect(onActions).toHaveBeenCalledWith('g2');
  fireEvent.click(spine);
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.click(spine);
  expect(onPick).toHaveBeenCalledWith('g2');
});

it('shows the pulled-out case with the shelf images first and swaps each face to its original only once decoded', async () => {
  const av = {id: 'a1', name: 'AV 1', type: 'av', selectedWorkArtworkId: 'cover', spineArtworkId: 'spine', backArtworkId: 'back', artworkVersions: {spine: {thumbnail: 't', medium: 'm'.repeat(64)}}} as unknown as CollectionSummary;
  render(shelf([av], 'a1'));
  await act(async () => { releases.splice(0).forEach(release => release()); });
  await act(async () => { releases.splice(0).forEach(release => release()); });
  const face = (name: string) => document.querySelector<HTMLImageElement>(`.spine-shelf__out img[alt="${name}"]`)?.getAttribute('src');
  // The shelf's own images (the spine is the medium copy) are on the case, and the originals are asked for after them.
  expect(face('AV 1 앞면')).toBe('https://art.test/cover');
  expect(face('AV 1 뒷면')).toBe('https://art.test/back');
  expect(asked).toContainEqual({id: 'spine', original: false, medium: true});
  expect(asked.filter(request => request.original).map(request => request.id).sort()).toEqual(['back', 'cover', 'spine']);
  originalOf.cover();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  // Only the decoded original replaced its face; the others keep the smaller image until theirs is ready.
  expect([face('AV 1 앞면'), face('AV 1 뒷면')].filter(src => src?.endsWith('-original'))).toHaveLength(1);
  await act(async () => { originals.splice(0).forEach(release => release()); });
  expect(face('AV 1 앞면')).toBe('https://art.test/cover-original');
  expect(face('AV 1 뒷면')).toBe('https://art.test/back-original');
});

it('asks for a back cover only for an AV case', async () => {
  const game = {id: 'g1', name: '게임 g1', type: 'game', selectedWorkArtworkId: 'cover', spineArtworkId: 'spine', backArtworkId: 'back'} as unknown as CollectionSummary;
  render(shelf([game], 'g1'));
  await act(async () => { releases.splice(0).forEach(release => release()); });
  await act(async () => { originals.splice(0).forEach(release => release()); });
  expect(asked.some(request => request.id === 'back')).toBe(false);
});

it('keeps the thumbnail on a shelved spine whose medium copy cannot be loaded', async () => {
  const game = {id: 'g1', name: '게임 g1', type: 'game', spineArtworkId: 'spine-g1', artworkVersions: {'spine-g1': {thumbnail: 't'.repeat(64), medium: 'm'.repeat(64)}}} as unknown as CollectionSummary;
  vi.mocked(memory.request).mockImplementation(((_item: CollectionSummary, id: string, _revision: string, _original: boolean, _signal: AbortSignal, medium = false) =>
    medium ? Promise.reject(new Error('gone')) : Promise.resolve({url: `https://art.test/${id}-thumbnail`})) as never);
  render(shelf([game]));
  await waitFor(() => expect(document.querySelector('.spine img')?.getAttribute('src')).toBe('https://art.test/spine-g1-thumbnail'));
});
