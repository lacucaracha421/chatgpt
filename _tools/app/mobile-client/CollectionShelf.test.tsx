import {act, fireEvent, cleanup, render, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
const mocks = vi.hoisted(() => ({native: vi.fn()}));
vi.mock('./transport', () => ({native: mocks.native}));
import {ShelfTile, workCaseData} from './CollectionShelf';
import {READY_CAP_MS} from '../src/shared/motion/AreaSwitch';

const item: CollectionSummary = {id: 'manga', name: '만화 제목', author: '작가 이름', type: 'manga', showcase: false,
  selectedWorkArtworkId: 'first', volumes: [
    {id: 'v1', volumeNumber: 1, editionIndex: 0, displayLabel: '1', coverArtworkId: 'first', coverFocusX: .25},
    {id: 'v2', volumeNumber: 2, editionIndex: 0, displayLabel: '2', coverArtworkId: 'second', coverFocusX: .75},
  ]};
afterEach(() => {cleanup(); vi.useRealTimers(); vi.clearAllMocks();});

it('does not retry a definitive artwork 404 and retries when the publication changes', async () => {
  vi.useFakeTimers();
  mocks.native.mockRejectedValue(Object.assign(new Error('Artwork variant unavailable'), {status: 404}));
  const work:CollectionSummary={id:'zelda',name:'The Legend of Zelda',type:'game',showcase:false,selectedWorkArtworkId:'cover'};
  const tile=(revision:string)=><ShelfTile item={work} revision={revision} active privacy={false} picked={false} onTap={()=>{}}/>;
  const view=render(tile('r1'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
  expect(mocks.native.mock.calls.filter(([op])=>op==='collectionArtwork')).toHaveLength(1);
  view.rerender(tile('r2'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(mocks.native.mock.calls.filter(([op])=>op==='collectionArtwork')).toHaveLength(2);
});

it('uses only the matching front cover volume for focus and the optional 1 marker', () => {
  expect(workCaseData(item, {front: '/front'}, false)).toMatchObject({author: item.author, coverFocus: .25, volumeNumber: 1, front: '/front'});
  expect(workCaseData({...item, selectedWorkArtworkId: 'second'}, {front: '/front'}, false)).toMatchObject({coverFocus: .75, volumeNumber: null});
  expect(workCaseData({...item, selectedWorkArtworkId: 'custom'}, {front: '/front'}, false)).toMatchObject({coverFocus: null, volumeNumber: null});
  expect(workCaseData({...item, selectedWorkArtworkId: null}, {front: '/front'}, false)).toMatchObject({coverFocus: .25, volumeNumber: 1});
  expect(workCaseData({...item, selectedWorkArtworkId: null, volumes: undefined}, {front: '/front'}, false)).toMatchObject({coverFocus: null, volumeNumber: null});
});

it('requests the original through the shelf for the published thumbnail-less Zelda cover', async () => {
  mocks.native.mockResolvedValue({url:'https://example.invalid/zelda-original'});
  const cover='e5448c5e-4b3a-4da8-947c-9eaa693fd2b1',digest='4a865c75'+'a'.repeat(56);
  const work:CollectionSummary={id:'b8845f02-459e-461f-a49d-c0b9a6ae78dd',name:'The Legend of Zelda',type:'game',showcase:false,selectedWorkArtworkId:cover,artworkVersions:{[cover]:{thumbnail:null,original:digest}}};
  const {container}=render(<ShelfTile item={work} revision="r1" active privacy={false} picked={false} onTap={()=>{}}/>);
  await waitFor(()=>expect(container.querySelector('.cs-front img')).not.toBeNull());
  expect(mocks.native).toHaveBeenCalledWith('collectionArtwork',{collectionId:work.id,artworkId:cover,variant:'original',revision:'r1',digest},expect.any(AbortSignal));
});

it('draws title, the same front source and author without requesting a separate manga spine', async () => {
  mocks.native.mockResolvedValue({url: 'https://example.invalid/cover'});
  const {container} = render(<ShelfTile item={{...item, spineArtworkId: 'unused'}} revision="r1" active privacy={false} picked={false} onTap={() => undefined}/>);
  await waitFor(() => expect(container.querySelector('.cs-front img')).not.toBeNull());
  expect(container.querySelector('.manga-jspine-title')?.textContent).toBe(item.name);
  expect([...container.querySelectorAll('.manga-jspine-author .manga-jspine-column')].map(node => node.textContent)).toEqual(['작가', '이름']);
  // The same shared gate holds the DOM spine and both actual image elements.
  expect(container.querySelector('.collection-light-case')?.getAttribute('data-revealed')).toBe('false');
  fireEvent.load(container.querySelector('.cs-front img')!);
  expect(container.querySelector('.collection-light-case')?.getAttribute('data-revealed')).toBe('false');
  expect(container.querySelector('.cs-spine img')?.getAttribute('src')).toBe(container.querySelector('.cs-front img')?.getAttribute('src'));
  fireEvent.load(container.querySelector('.cs-spine img')!);
  expect(container.querySelector('.collection-light-case')?.getAttribute('data-ready')).toBe('true');
  expect(container.querySelector('.manga-jspine-number')?.textContent).toBe('1');
  expect(mocks.native).toHaveBeenCalledTimes(1);
  expect(mocks.native).toHaveBeenCalledWith('collectionArtwork', expect.objectContaining({artworkId: 'first'}), expect.any(AbortSignal));
});

it('holds a tablet item while front and spine tickets arrive separately, then reveals together', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  let resolveFront!: (ticket: {url: string}) => void, resolveSpine!: (ticket: {url: string}) => void;
  mocks.native.mockImplementation((_command, args) => new Promise(resolve => {
    if (args.artworkId === 'spine') resolveSpine = resolve; else resolveFront = resolve;
  }));
  const game = {...item, id: 'ticket-game', type: 'game' as const, spineArtworkId: 'spine'};
  const {container} = render(<ShelfTile item={game} revision="r1" active privacy={false} picked={false} onTap={() => undefined}/>);
  const frame = container.querySelector('.collection-light-case')!;
  expect(frame.getAttribute('data-revealed')).toBe('false');
  expect(container.querySelector('.spine-title')).toBeNull();
  await act(async () => resolveFront({url: 'https://example.invalid/tablet-front'}));
  const front = container.querySelector<HTMLImageElement>('.cs-front img')!;
  fireEvent.load(front);
  expect(front.style.visibility).toBe('hidden');
  await act(async () => resolveSpine({url: 'https://example.invalid/tablet-spine'}));
  const spine = container.querySelector<HTMLImageElement>('.cs-spine img')!;
  fireEvent.load(spine);
  expect(frame.getAttribute('data-ready')).toBe('true');
  expect(front.style.visibility).toBe('');
  expect(spine.style.visibility).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

it('caps a stalled tablet spine ticket and fills it without hiding the ready front', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  let resolveSpine!: (ticket: {url: string}) => void;
  mocks.native.mockImplementation((_command, args) => args.artworkId === 'spine'
    ? new Promise(resolve => { resolveSpine = resolve; }) : Promise.resolve({url: 'https://example.invalid/cap-front'}));
  const game = {...item, id: 'cap-game', type: 'game' as const, spineArtworkId: 'spine'};
  const {container} = render(<ShelfTile item={game} revision="r1" active privacy={false} picked={false} onTap={() => undefined}/>);
  await act(async () => {});
  const front = container.querySelector<HTMLImageElement>('.cs-front img')!;
  fireEvent.load(front);
  act(() => vi.advanceTimersByTime(READY_CAP_MS - 1));
  expect(front.style.visibility).toBe('hidden');
  act(() => vi.advanceTimersByTime(1));
  expect(front.style.visibility).toBe('');
  expect(container.querySelector('.spine-title')).toBeNull();
  await act(async () => resolveSpine({url: 'https://example.invalid/cap-spine'}));
  fireEvent.load(container.querySelector('.cs-spine img')!);
  expect(container.querySelector('.cs-front img')).toBe(front);
  expect(front.style.visibility).toBe('');
  expect(container.querySelector('.collection-light-case')?.getAttribute('data-ready')).toBe('true');
});
