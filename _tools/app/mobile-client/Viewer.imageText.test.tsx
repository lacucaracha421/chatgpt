import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import {ApiError} from './transport';
import {readFileSync} from 'node:fs';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({api: vi.fn(), ticket: vi.fn()}));
vi.mock('./transport', async importOriginal => ({...await importOriginal<typeof import('./transport')>(), api: mocks.api}));
vi.mock('./media', () => ({mediaTicket: mocks.ticket, decodeImage: vi.fn().mockResolvedValue(undefined), invalidateTicket: vi.fn(), loadThumbnail: vi.fn(async (asset: Asset) => asset)}));
vi.mock('./useLibraryArtists', () => ({useLibraryArtists: () => ({allArtists: [], assignments: []})}));
vi.mock('./useLikesAlbum', () => ({useLikesAlbum: () => ({available: false, liked: new Set(), pending: new Set()})}));
vi.mock('./AlbumMembershipEditor', () => ({AlbumMembershipEditor: () => null}));
vi.mock('./ClassificationAssignmentEditor', () => ({ClassificationAssignmentEditor: () => null}));
import {Viewer} from './Viewer';

const text = {digest: 'digest-a', lines: [{original: '原文', korean: '첫 번역', box: {x0: 100, y0: 100, x1: 200, y1: 200}}]};
const items: Asset[] = ['a', 'b'].map(id => ({id, kind: 'image', preview: `https://test.invalid/thumb-${id}`, has_image_text: true}));
const props = {onIndex: vi.fn(), onClose: vi.fn()};
let style: HTMLStyleElement;
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  localStorage.clear(); mocks.api.mockReset(); mocks.ticket.mockReset(); props.onIndex.mockReset(); props.onClose.mockReset();
  mocks.api.mockImplementation((path: string) => Promise.resolve(path.includes('/a/') ? text : {...text, digest: 'digest-b', lines: [{...text.lines[0], korean: '둘째 번역'}]}));
  mocks.ticket.mockImplementation((asset: Asset) => Promise.resolve({url: `https://test.invalid/original-${asset.id}`}));
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: 800});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 1280});
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const width = this.tagName === 'SPAN' && this.style.position === 'fixed' ? [...(this.textContent ?? '')].length * (parseFloat(this.style.fontSize) || 14) : 800;
    return {left:0,top:0,width,height:1000,right:width,bottom:1000} as DOMRect;
  });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) {super(type, options); this.pointerId = options.pointerId ?? 1;}
  });
  style = document.createElement('style');
  style.textContent = readFileSync('src/shared/viewer/image-text.css', 'utf8').replace(/@import[^;]+;/g, '') + readFileSync('mobile-client/Viewer.css', 'utf8') + '.viewer {--badge-height:24px;--touch-target:44px;--type-meta:13px;} .viewer-surface img.viewer-image {width:800px;height:1000px;}';
  document.head.append(style);
});
afterEach(() => {cleanup(); style.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function loaded(id = 'a') {
  let image!: HTMLImageElement;
  await waitFor(() => {image = document.querySelector<HTMLImageElement>(`.viewer-surface img[src$="original-${id}"]`)!; expect(image).toBeTruthy();});
  await act(async () => {fireEvent.load(image); await Promise.resolve();});
}
async function unfold() {
  await loaded();
  fireEvent.click(screen.getByRole('button', {name: '번역', exact: true}));
  expect(screen.getByRole('button', {name: '1번 대사'})).toBeTruthy();
  expect(document.querySelector('.viewer-reading-sheet')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '미디어 정보', exact: true}));
  await screen.findByRole('button', {name: /첫 번역/});
}
function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number, pointerId = 1) {
  fireEvent[type](document.querySelector('.viewer-surface')!, {pointerId, clientX: x, clientY: y, button: 0});
}
it('toggles notes without the info sheet, copies from the card, and consumes Back for the card', async () => {
  const backRef = {current: null as (() => boolean) | null};
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {clipboard: {writeText: copy}, userAgent: 'test'});
  render(<Viewer {...props} items={items} index={0} backRef={backRef}/>);
  await loaded();
  const toggle = screen.getByRole('button', {name:'번역', exact:true});
  fireEvent.click(toggle);
  expect(document.querySelector('.viewer-reading-sheet, .viewer-info-dock, .image-text-section')).toBeNull();
  pointer('pointerDown', 92, 112); pointer('pointerUp', 92, 112);
  expect(screen.getByRole('region', {name:'대사 번역'})).toHaveTextContent('原文첫 번역');
  fireEvent.click(screen.getByRole('button', {name:'복사', exact:true}));
  await waitFor(() => expect(copy).toHaveBeenCalledWith('첫 번역'));
  act(() => {expect(backRef.current?.()).toBe(true);});
  expect(screen.queryByRole('region', {name:'대사 번역'})).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(screen.queryByRole('button', {name:'1번 대사'})).toBeNull();
});
it('reads saved lines without coordinates without starting a surface swipe', async () => {
  mocks.api.mockResolvedValue({digest: 'unpositioned', lines: [{original: '保存された文章', korean: '저장된 번역'}]});
  render(<Viewer {...props} items={items} index={0}/>);
  await loaded();
  fireEvent.click(screen.getByRole('button', {name: '번역', exact: true}));
  const region = screen.getByRole('region', {name: '위치 없는 번역'});
  expect(getComputedStyle(region).position).toBe('absolute');
  expect(getComputedStyle(region).overflow).toBe('auto');
  const row = screen.getByRole('button', {name: /저장된 번역.*保存された文章/});
  fireEvent.pointerDown(row, {pointerId: 1, clientX: 300, clientY: 120});
  fireEvent.pointerUp(row, {pointerId: 1, clientX: 100, clientY: 120});
  fireEvent.click(row);
  expect(row).toHaveAttribute('aria-pressed', 'true');
  expect(props.onIndex).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: '번역', exact: true}));
  expect(screen.queryByRole('region', {name: '위치 없는 번역'})).toBeNull();
});
it('does not fetch or offer translation without the flag or for video, vault and privacy covers', async () => {
  for (const options of [
    {items: [{...items[0], has_image_text: undefined}]},
    {items: [{...items[0], kind: 'video'}]},
    {items: [items[0]], vault: {original: () => 'https://test.invalid/vault', label: () => 'vault'}},
    {items: [items[0]], privacy: true},
  ]) {
    const view = render(<Viewer {...props} {...options} index={0}/>);
    await act(async () => {await Promise.resolve();});
    expect(screen.queryByRole('button', {name: '번역', exact: true})).toBeNull();
    expect(mocks.api).not.toHaveBeenCalled();
    view.unmount();
  }
});
it('fetches once, starts folded and turns the info sheet into a non-dimming 46% reading sheet', async () => {
  const view = render(<Viewer {...props} items={items} index={0}/>);
  await loaded();
  fireEvent.click(screen.getByRole('button', {name: '미디어 정보', exact: true}));
  expect(await screen.findByRole('button', {name: /번역.*1줄/})).toHaveAttribute('aria-expanded', 'false');
  expect(document.querySelector('.viewer-reading-sheet')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: /번역.*1줄/}));
  expect(document.querySelector('.viewer.is-reading')).toBeTruthy();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(getComputedStyle(document.querySelector('.viewer-reading-sheet')!).height).toBe('46%');
  expect(getComputedStyle(document.querySelector('.viewer-surface')!).bottom).toBe('46%');
  expect(document.querySelector('.viewer')).toHaveAttribute('data-filmstrip-visible', 'false');
  expect(parseFloat(screen.getByRole('button', {name:'1번 대사'}).style.fontSize)).toBeGreaterThanOrEqual(14);
  expect(getComputedStyle(screen.getByRole('button', {name: '1번 대사'})).pointerEvents).toBe('none');
  expect(style.textContent).toContain('--touch-target:44px');
  expect(style.textContent).toContain('--type-meta:13px');
  view.rerender(<Viewer {...props} items={items} index={0}/>);
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
it('opens and unfolds from the bar; surface tap selects, repeat tap clears, drag swipes without selecting', async () => {
  render(<Viewer {...props} items={items} index={0}/>); await unfold();
  pointer('pointerDown', 92, 112); pointer('pointerUp', 92, 112);
  expect(screen.getByRole('button', {name: '1번 대사'})).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', {name: /첫 번역/})).toHaveAttribute('aria-pressed', 'true');
  pointer('pointerDown', 600, 600); pointer('pointerUp', 600, 600);
  expect(screen.getByRole('button', {name: '1번 대사'})).toHaveAttribute('aria-pressed', 'true');
  pointer('pointerDown', 92, 112); pointer('pointerUp', 92, 112);
  expect(screen.getByRole('button', {name: '1번 대사'})).toHaveAttribute('aria-pressed', 'false');
  pointer('pointerDown', 92, 112); pointer('pointerMove', 20, 112); pointer('pointerUp', 20, 112);
  expect(props.onIndex).toHaveBeenCalledWith(1);
  expect(screen.getByRole('button', {name: '1번 대사'})).toHaveAttribute('aria-pressed', 'false');
});
it('keeps unfolded across pages, clears selection and swaps rows with the displayed bitmap; revisiting uses the cache', async () => {
  const view = render(<Viewer {...props} items={items} index={0}/>); await unfold();
  fireEvent.click(screen.getByRole('button', {name: /첫 번역/}));
  view.rerender(<Viewer {...props} items={items} index={1}/>);
  expect(screen.getByRole('button', {name: /첫 번역/})).toHaveAttribute('aria-pressed', 'false');
  await loaded('b');
  expect(await screen.findByRole('button', {name: /둘째 번역/})).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryAllByText('첫 번역')).toHaveLength(0);
  expect(screen.getByRole('button', {name: /번역.*1줄/})).toHaveAttribute('aria-expanded', 'true');
  view.rerender(<Viewer {...props} items={items} index={0}/>); await loaded();
  expect(mocks.api).toHaveBeenCalledTimes(2);
});
it('closes the list with the grip or Android Back while retaining notes, and starts a fresh opening folded', async () => {
  const backRef = {current: null as (() => boolean) | null};
  const view = render(<Viewer {...props} items={items} index={0} backRef={backRef}/>); await unfold();
  const grip = document.querySelector('.bottom-sheet-drag-area')!;
  fireEvent.pointerDown(grip, {pointerId: 1, clientX: 200, clientY: 600});
  fireEvent.pointerUp(grip, {pointerId: 1, clientX: 200, clientY: 680});
  expect(document.querySelector('.viewer-reading-sheet')).toBeNull();
  expect(document.querySelector('.viewer')).toHaveAttribute('data-filmstrip-visible', 'true');
  expect(screen.getByRole('button', {name:'1번 대사'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '미디어 정보', exact: true}));
  act(() => {expect(backRef.current?.()).toBe(true);});
  expect(document.querySelector('.viewer-reading-sheet')).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
  view.unmount(); render(<Viewer {...props} items={items} index={0}/>); await loaded();
  fireEvent.click(screen.getByRole('button', {name: '미디어 정보', exact: true}));
  expect(await screen.findByRole('button', {name: /번역.*1줄/})).toHaveAttribute('aria-expanded', 'false');
});
it('uses the existing right panel in landscape', async () => {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1280});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 800});
  render(<Viewer {...props} items={items} index={0}/>); await unfold();
  expect(document.querySelector('.viewer-info-dock .image-text-section')).toBeTruthy();
  expect(document.querySelector('.viewer-reading-sheet')).toBeNull();
});
it('removes translation UI on 404 and caches the missing response for this session', async () => {
  mocks.api.mockRejectedValue(new ApiError('missing', 404, null));
  const view = render(<Viewer {...props} items={items} index={0}/>); await loaded();
  await waitFor(() => expect(screen.queryByRole('button', {name: '번역', exact: true})).toBeNull());
  fireEvent.click(screen.getByRole('button', {name: '미디어 정보', exact: true}));
  expect(document.querySelector('.image-text-section')).toBeNull();
  expect(document.querySelector('.image-text-notes')).toBeNull();
  view.rerender(<Viewer {...props} items={items} index={1}/>); await loaded('b');
  view.rerender(<Viewer {...props} items={items} index={0}/>); await loaded();
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

it('keeps two-finger pinch and zoomed pan over a marker while reading, and rejects an 8px tap', async () => {
  render(<Viewer {...props} items={items} index={0}/>); await unfold();
  pointer('pointerDown', 92, 112); pointer('pointerMove', 100, 112); pointer('pointerUp', 100, 112);
  expect(screen.getByRole('button', {name: '1번 대사'})).toHaveAttribute('aria-pressed', 'false');
  pointer('pointerDown', 92, 112, 1); pointer('pointerDown', 192, 112, 2);
  pointer('pointerMove', 292, 112, 2);
  pointer('pointerUp', 292, 112, 2); pointer('pointerUp', 92, 112, 1);
  const image = document.querySelector<HTMLImageElement>('.viewer-surface img:not([data-stable-image-loading])')!;
  expect(image.style.transform).toContain('scale(2)');
  expect(screen.getByRole('button', {name: '1번 대사'})).toHaveAttribute('aria-pressed', 'false');
  pointer('pointerDown', 92, 112); pointer('pointerMove', 130, 150); pointer('pointerUp', 130, 150);
  expect(image.style.transform).toContain('translate(38px, 38px)');
  expect(props.onIndex).not.toHaveBeenCalled();
});
it('shows the busy label only after 400ms for a flagged image', async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: typeof text) => void;
    mocks.api.mockReturnValue(new Promise<typeof text>(done => {resolve = done;}));
    mocks.ticket.mockReturnValue(new Promise(() => {}));
    render(<Viewer {...props} items={items} index={0}/>);
    await act(async () => {await Promise.resolve();});
    fireEvent.click(screen.getByRole('button', {name: '번역', exact: true}));
    fireEvent.click(screen.getByRole('button', {name: '미디어 정보', exact: true}));
    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByText('불러오는 중')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('불러오는 중')).toBeTruthy();
    await act(async () => {resolve(text);});
    expect(screen.getByRole('button', {name: /첫 번역/})).toBeTruthy();
  } finally {vi.useRealTimers();}
});

it('keeps the reading sheet on an unflagged page and swaps away its old rows with the image', async () => {
  const mixed = [items[0], {...items[1], has_image_text: false}];
  const view = render(<Viewer {...props} items={mixed} index={0}/>); await unfold();
  view.rerender(<Viewer {...props} items={mixed} index={1}/>);
  expect(document.querySelector('.viewer-reading-sheet')).toBeTruthy();
  expect(screen.getByRole('button', {name: /첫 번역/})).toBeTruthy();
  await loaded('b');
  expect(document.querySelector('.image-text-section')).toBeNull();
  expect(document.querySelector('.image-text-notes')).toBeNull();
  expect(document.querySelector('.viewer-reading-sheet')).toBeTruthy();
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
it('does not fetch text or expose translation through an NSFW cover', () => {
  localStorage.setItem('lakomics.mobile.nsfwFilter', '1');
  render(<Viewer {...props} items={[{...items[0], contentRating: 'e'}]} index={0}/>);
  expect(screen.queryByRole('button', {name: '번역', exact: true})).toBeNull();
  expect(document.querySelector('.image-text-section')).toBeNull();
  expect(document.querySelector('.image-text-notes')).toBeNull();
  expect(mocks.api).not.toHaveBeenCalled();
});

it('pans to an off-screen row marker in 200ms without changing zoom', async () => {
  render(<Viewer {...props} items={items} index={0}/>); await unfold();
  const image = document.querySelector<HTMLImageElement>('.viewer-surface img:not([data-stable-image-loading])')!;
  Object.defineProperty(image, 'naturalWidth', {value: 800});
  Object.defineProperty(image, 'naturalHeight', {value: 1000});
  pointer('pointerDown', 92, 112, 1); pointer('pointerDown', 192, 112, 2);
  pointer('pointerMove', 292, 112, 2); pointer('pointerUp', 292, 112, 2); pointer('pointerUp', 92, 112, 1);
  fireEvent.click(screen.getByRole('button', {name: /첫 번역/}));
  expect(image.style.transform).toBe('translate(400px, 500px) scale(2)');
  expect(document.querySelector('.image-text-notes')).toHaveAttribute('data-panning', 'true');
  expect(getComputedStyle(image).transition).toBe('transform 200ms var(--ease-standard)');
});
