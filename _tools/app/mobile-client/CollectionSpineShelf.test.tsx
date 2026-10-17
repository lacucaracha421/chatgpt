import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {resetSpineWarmForTests} from '../src/collections/spineShelfWarm';
import {ArtworkMemoryContext, artworkSource, type ArtworkMemory} from './collectionArtwork';
import type {CollectionSummary} from './collectionModel';
import {TabletSpineShelf} from './CollectionSpineShelf';

const game = (id: string) => ({id, name: `게임 ${id}`, type: 'game', spineArtworkId: `spine-${id}`}) as unknown as CollectionSummary;
const titles = () => screen.queryAllByRole('button').map(button => button.getAttribute('aria-label')!.split(' ·')[0]);

let releases: (() => void)[];
let requested: string[];
let urls: Map<string, string>;
let memory: ArtworkMemory;
beforeEach(() => {
  releases = []; requested = []; urls = new Map();
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('collection-scroll') ? 800 : 0; });
  memory = {
    get: (source: string) => urls.get(source) ?? null,
    request: vi.fn((item: CollectionSummary, id: string, revision: string, original: boolean) => new Promise<{url: string}>(resolve => {
      requested.push(item.id);
      releases.push(() => { const url = `https://art.test/${id}`; urls.set(artworkSource(item, id, revision, original), url); resolve({url}); });
    })),
  } as unknown as ArtworkMemory;
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); resetSpineWarmForTests();});

const shelf = (items: CollectionSummary[]) => <ArtworkMemoryContext.Provider value={memory}>
  <div className="collection-scroll">
    <TabletSpineShelf items={items} grouping="sort" size="normal" label="게임 작품 목록" revision="r1" active privacy={false} picked={null} onPick={() => undefined} onOpen={() => undefined}/>
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
