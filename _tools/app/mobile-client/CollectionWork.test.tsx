import {useMemo} from 'react';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {CaseWork, MangaWork, sharedVolume} from './CollectionWork';
import type {CollectionDetail} from './collectionModel';

const artwork = vi.hoisted(() => ({urls: {} as Record<string, string>}));
vi.mock('./collectionArtwork', () => ({useArtworkSet: (_item: unknown, requests: Record<string, {id?: string | null}>) => useMemo(() => ({ready: true, urls: Object.fromEntries(Object.entries(requests).map(([key, request]) => [key, request.id ? artwork.urls[request.id] : null]))}), [JSON.stringify(requests), JSON.stringify(artwork.urls)])}));
afterEach(() => {cleanup(); vi.restoreAllMocks();});
const volumes = [1, 2].map(n => sharedVolume({id: `v${n}`, volumeNumber: n, editionIndex: 0, displayLabel: `${n}권`, coverArtworkId: `c${n}`}, '2026-10-02'));
const manga: CollectionDetail = {id: 'manga', name: '만화', type: 'manga', showcase: false, volumes, artworks: []};
const props = {item: manga, revision: 'r1', active: true, privacy: false, volumes, owned: 1, latestKorean: 2, onEnlarge: vi.fn(), info: null};

it('enlarges the tapped spine while a different volume is displayed',()=>{
  artwork.urls={c1:'/one',c2:'/two'};
  const onEnlarge=vi.fn();
  const {container}=render(<MangaWork {...props} onEnlarge={onEnlarge}/>);
  fireEvent.doubleClick(container.querySelector('[data-volume-id="v2"]')!);
  expect(onEnlarge).toHaveBeenCalledExactlyOnceWith('v2');
});

it('taps empty stage to close an open case, preserves a closed pose/zoom, and leaves controls and case taps working', () => {
  artwork.urls = {};
  const item: CollectionDetail = {...manga, id: 'game', type: 'game'};
  const onStep = vi.fn();
  const view = render(<CaseWork item={item} revision="r1" active privacy={false} position={1} total={2} score={() => null} onStep={onStep} info={() => null}/>);
  const object = screen.getByRole('group', {name: '케이스'});
  const stage = view.container.querySelector('.work-stage')!;
  const slot = view.container.querySelector('.work-case-slot')!;
  const zoom = view.container.querySelector('.work-zoom-object')!;
  const touch = {pointerType: 'touch', pointerId: 1, button: 0, clientX: 100, clientY: 100};
  const tap = (target: Element) => {fireEvent.pointerDown(target, touch); fireEvent.pointerUp(target, touch); fireEvent.click(target, {detail: 1});};
  fireEvent.keyDown(object, {key: 'ArrowRight'}); const angle = object.getAttribute('data-angle');
  fireEvent.wheel(stage, {deltaY: -100}); const scale = zoom.getAttribute('data-zoom');
  tap(slot); expect(object.getAttribute('aria-expanded')).toBe('false');
  expect(object.getAttribute('data-angle')).toBe(angle); expect(zoom.getAttribute('data-zoom')).toBe(scale);
  tap(object); expect(object.getAttribute('aria-expanded')).toBe('true');
  tap(screen.getByRole('button', {name: '다음 작품'})); expect(onStep).toHaveBeenCalledWith(1);
  expect(object.getAttribute('aria-expanded')).toBe('true');
  tap(slot); expect(object.getAttribute('aria-expanded')).toBe('false');
  expect(object.getAttribute('data-angle')).toBe(angle); expect(zoom.getAttribute('data-zoom')).toBe(scale);
  tap(object); expect(object.getAttribute('aria-expanded')).toBe('true');
  tap(object); expect(object.getAttribute('aria-expanded')).toBe('false');
});

it('does not close the open case after an empty-stage swipe, pinch or vertical scroll', () => {
  artwork.urls = {};
  const item: CollectionDetail = {...manga, id: 'game', type: 'game'};
  const onStep = vi.fn();
  const view = render(<div data-testid="scroll" style={{overflowY: 'auto'}}><CaseWork item={item} revision="r1" active privacy={false} position={1} total={2} score={() => null} onStep={onStep} info={() => null}/></div>);
  const pane = screen.getByTestId('scroll');
  Object.defineProperties(pane, {scrollHeight: {value: 2000}, clientHeight: {value: 800}}); pane.scrollTop = 100;
  const object = screen.getByRole('group', {name: '케이스'}); const stage = view.container.querySelector('.work-stage')!;
  fireEvent.keyDown(object, {key: 'Enter'});
  const touch = {pointerType: 'touch', pointerId: 1, button: 0, clientX: 200, clientY: 200};
  fireEvent.pointerDown(stage, touch); fireEvent.pointerMove(stage, {...touch, clientX: 100}); fireEvent.pointerUp(stage, {...touch, clientX: 100});
  fireEvent.click(stage, {detail: 1}); expect(onStep).toHaveBeenCalledExactlyOnceWith(1); expect(object.getAttribute('aria-expanded')).toBe('true');
  fireEvent.pointerDown(stage, touch); fireEvent.pointerMove(stage, {...touch, clientY: 150}); fireEvent.pointerUp(stage, {...touch, clientY: 150});
  fireEvent.click(stage, {detail: 1}); expect(pane.scrollTop).toBe(150); expect(object.getAttribute('aria-expanded')).toBe('true');
  fireEvent.pointerDown(stage, touch); fireEvent.pointerDown(stage, {...touch, pointerId: 2, clientX: 300});
  fireEvent.pointerMove(stage, {...touch, pointerId: 2, clientX: 400});
  fireEvent.pointerUp(stage, {...touch, pointerId: 2}); fireEvent.pointerUp(stage, touch); fireEvent.click(stage, {detail: 1});
  expect(object.getAttribute('aria-expanded')).toBe('true'); expect(onStep).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(stage, touch); fireEvent.pointerUp(stage, touch); fireEvent.click(stage, {detail: 1});
  expect(object.getAttribute('aria-expanded')).toBe('false');
});

it.each(['av', 'game', 'movie'] as const)('uses only the AV jacket front as a backdrop (%s) and removes it in privacy mode', async type => {
  artwork.urls = {cover: '/front'};
  const item: CollectionDetail = {...manga, id: type, type, selectedWorkArtworkId: 'cover'};
  const options = {item, revision: 'r1', active: true, privacy: false, position: 1, total: 1, score: () => null, onStep: vi.fn(), info: () => null};
  const view = render(<CaseWork {...options}/>);
  const image = view.container.querySelector<HTMLImageElement>('.work-backdrop img');
  if (type !== 'av') { expect(image).toBeNull(); return; }
  expect(image?.getAttribute('src')).toBe('/front');
  expect(image?.className).toBe('');
  await act(async () => fireEvent.load(image!)); expect(image?.className).toBe('is-painted');
  view.rerender(<CaseWork {...options} privacy/>);
  expect(view.container.querySelector('.work-backdrop')).toBeNull();
});

it('pinches the shared book without rotation or volume swipe, resumes one-finger turning, and resets both through 정면으로', () => {
  artwork.urls = {c1: '/one', c2: '/two'};
  const view = render(<MangaWork {...props}/>);
  const book = screen.getByRole('group', {name: '책'});
  const zoom = () => Number(view.container.querySelector('.work-zoom-object')!.getAttribute('data-zoom'));
  const touch = {pointerType: 'touch', button: 0, clientY: 100};
  fireEvent.pointerDown(book, {...touch, pointerId: 1, clientX: 100});
  fireEvent.pointerDown(book, {...touch, pointerId: 2, clientX: 200});
  fireEvent.pointerMove(book, {...touch, pointerId: 2, clientX: 800});
  expect(zoom()).toBe(2.5); expect(book.getAttribute('data-angle')).toBe('0');
  fireEvent.pointerMove(book, {...touch, pointerId: 2, clientX: 101}); expect(zoom()).toBe(.6);
  fireEvent.pointerUp(book, {...touch, pointerId: 2, clientX: 0});
  fireEvent.pointerMove(book, {...touch, pointerId: 1, clientX: 300}); expect(book.getAttribute('data-angle')).toBe('0');
  fireEvent.pointerUp(book, {...touch, pointerId: 1, clientX: 300});
  fireEvent.click(screen.getByRole('button', {name: '다음 권'}), {detail: 1});
  expect(view.container.querySelector('.manga-bb-front img')!.getAttribute('src')).toBe('/one');
  fireEvent.pointerDown(book, {...touch, pointerId: 3, clientX: 100});
  fireEvent.pointerMove(book, {...touch, pointerId: 3, clientX: 150});
  fireEvent.pointerUp(book, {...touch, pointerId: 3, clientX: 150});
  expect(book.getAttribute('data-angle')).toBe('30');
  fireEvent.click(screen.getByRole('button', {name: '정면으로'}));
  expect(zoom()).toBe(1); expect(book.getAttribute('data-angle')).toBe('0');
  fireEvent.wheel(view.container.querySelector('.work-stage')!, {deltaY: -100});
  view.rerender(<MangaWork {...props} item={{...manga, id: 'another'}}/>); expect(zoom()).toBe(1);
});

it('uses the shown cover, keeps the painted backdrop through a pending decode and failure, and removes it in privacy mode', async () => {
  artwork.urls = {c1: '/one', c2: '/two'};
  const view = render(<MangaWork {...props}/>);
  const old = view.container.querySelector<HTMLImageElement>('.work-backdrop img')!;
  await act(async () => fireEvent.load(old)); expect(old.className).toBe('is-painted');
  fireEvent.click(screen.getByRole('button', {name: '다음 권'}));
  const next = view.container.querySelector<HTMLImageElement>('.work-backdrop img:not(.is-painted)')!;
  expect(next.getAttribute('src')).toBe(view.container.querySelector('.manga-bb-front img')!.getAttribute('src'));
  expect(old.className).toBe('is-painted');
  fireEvent.error(next); expect(old.className).toBe('is-painted');
  let decoded!: () => void;
  Object.defineProperty(next, 'decode', {value: () => new Promise<void>(resolve => {decoded = resolve;})});
  fireEvent.load(next); expect(old.className).toBe('is-painted');
  await act(async () => decoded()); expect(next.className).toBe('is-painted'); expect(old.className).toBe('');
  view.rerender(<MangaWork {...props} privacy/>); expect(view.container.querySelector('.work-backdrop')).toBeNull();
});

it('pinches a case without opening or turning it, resets, and uses the AV jacket backdrop', () => {
  artwork.urls = {cover: '/cover'};
  const item: CollectionDetail = {...manga, id: 'av', type: 'av', selectedWorkArtworkId: 'cover'};
  const onStep = vi.fn(); const view = render(<CaseWork item={item} revision="r1" active privacy={false} position={1} total={2} score={() => null} onStep={onStep} info={() => null}/>);
  const object = screen.getByRole('group', {name: '케이스'});
  const angle = object.getAttribute('data-angle');
  const touch = {pointerType: 'touch', button: 0, clientY: 100};
  fireEvent.pointerDown(object, {...touch, pointerId: 1, clientX: 100});
  fireEvent.pointerDown(object, {...touch, pointerId: 2, clientX: 200});
  fireEvent.pointerMove(object, {...touch, pointerId: 1, clientX: 50});
  fireEvent.pointerUp(object, {...touch, pointerId: 1, clientX: 50});
  fireEvent.pointerUp(object, {...touch, pointerId: 2, clientX: 400});
  expect(object.getAttribute('data-angle')).toBe(angle); expect(object.getAttribute('aria-expanded')).toBe('false'); expect(onStep).not.toHaveBeenCalled();
  expect(view.container.querySelector('.work-zoom-object')!.getAttribute('data-zoom')).toBe('1.5');
  fireEvent.click(screen.getByRole('button', {name: '정면으로'}));
  expect(view.container.querySelector('.work-zoom-object')!.getAttribute('data-zoom')).toBe('1'); expect(object.getAttribute('data-angle')).toBe('0');
  expect(view.container.querySelector('.work-backdrop img')?.getAttribute('src')).toBe('/cover');
});
