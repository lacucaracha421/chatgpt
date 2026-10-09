import '@testing-library/jest-dom/vitest';
import {useMemo} from 'react';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {CaseWork, MangaWork, sharedVolume} from './CollectionWork';
import type {CollectionDetail} from './collectionModel';
import {playCaseSound} from '../src/collections/case/caseSounds';

vi.mock('../src/collections/case/caseSounds', async original => ({...await original<typeof import('../src/collections/case/caseSounds')>(), playCaseSound: vi.fn(), preloadCaseSounds: vi.fn()}));

const artwork = vi.hoisted(() => ({urls: {} as Record<string, string>, sources: [] as string[]}));
vi.mock('./collectionArtwork', () => ({usePortraitUrl: () => ({url: null, failed: false}), useArtworkSet: (item: {id: string}, requests: Record<string, {id?: string | null}>) => {
  if (requests.front?.id === 'portrait') artwork.sources.push(item.id);
  return useMemo(() => ({ready: true, urls: Object.fromEntries(Object.entries(requests).map(([key, request]) => [key, request.id ? artwork.urls[request.id] : null]))}), [JSON.stringify(requests), JSON.stringify(artwork.urls)]);
}}));
afterEach(() => {cleanup(); vi.restoreAllMocks();});
const volumes = [1, 2].map(n => sharedVolume({id: `v${n}`, volumeNumber: n, editionIndex: 0, displayLabel: `${n}권`, coverArtworkId: `c${n}`}, '2026-10-02'));
const manga: CollectionDetail = {id: 'manga', name: '만화', type: 'manga', showcase: false, volumes, artworks: []};
const props = {item: manga, revision: 'r1', active: true, privacy: false, volumes, owned: 1, latestKorean: 2, onEnlarge: vi.fn(), info: null};

it('prints published back fields and screenshot thumbnails, preserving real back art', () => {
  artwork.urls = {front: '/front', hero: '/hero', shot: '/shot', extra: '/extra', back: '/back'};
  const item: CollectionDetail = {...manga, type: 'game', selectedWorkArtworkId: 'front', selectedHeroArtworkId: 'hero', publisher: 'Publisher', developer: 'Developer', overview: 'Story',
    artworks: [{id: 'hero', kind: 'screenshot', selected: true}, {id: 'shot', kind: 'screenshot', selected: false}, {id: 'extra', kind: 'artwork', selected: false}]};
  const options = {item, revision: 'r1', active: true, privacy: false, position: 1, total: 1, score: () => null, onStep: vi.fn(), info: () => null};
  const {container, unmount} = render(<CaseWork {...options}/>);
  expect(container.querySelector('.case-back-copy')).toHaveTextContent('Story');
  expect(container.querySelector<HTMLElement>('.case-back-hero')!.style.backgroundImage).toContain('/hero');
  expect([...container.querySelectorAll('.case-back-shots img')].map(img => img.getAttribute('src'))).toEqual(['/hero', '/shot']);
  expect(container.querySelector('.case-back-facts')).toHaveTextContent('개발Developer배급Publisher');
  expect(container.querySelector('.case-back-facts')).not.toHaveTextContent('발매');
  unmount();
  const real = render(<CaseWork {...options} item={{...item, type: 'av', selectedHeroArtworkId: null, artworks: [{id: 'back', kind: 'back', selected: true}]}}/>);
  expect(real.container.querySelector('.k-back .cv')).toHaveAttribute('src', '/back');
  expect(real.container.querySelector('.case-back')).toBeNull();
});

it('omits unpublished back fields and uses the front when the tablet has no hero', () => {
  artwork.urls = {front: '/front'};
  const item: CollectionDetail = {...manga, type: 'movie', selectedWorkArtworkId: 'front'};
  const {container} = render(<CaseWork item={item} revision="r1" active privacy={false} position={1} total={1} score={() => null} onStep={vi.fn()} info={() => null}/>);
  expect(container.querySelector('.case-back-hero')).toHaveClass('is-fallback');
  expect(container.querySelector<HTMLElement>('.case-back-hero')!.style.backgroundImage).toContain('/front');
  expect(container.querySelector('.case-back-copy, .case-back-facts, .case-back-shots')).toBeNull();
});

it('prints the shared manual using queued tablet status, rating and platform', () => {
  artwork.urls = {hero: '/hero'};
  const item: CollectionDetail = {...manga, id: 'game', type: 'game', name: 'Game manual', selectedHeroArtworkId: 'hero', developer: 'Developer', publisher: 'Publisher', status: 'unplayed', ownedPlatform: 'PC'};
  const {container, rerender} = render(<CaseWork item={item} revision="r1" active privacy={false} position={1} total={1} score={() => 3.5} record={() => [['상태', '하는 중'], ['기기', 'PS5']]} onStep={vi.fn()} info={() => null}/>);
  const manual = container.querySelector('.case-manual')!;
  expect(manual).toHaveTextContent('Game manual');
  expect(manual).toHaveTextContent('PS5');
  expect(manual.querySelector('.is-filled')).toHaveAttribute('data-status', 'playing');
  expect(manual.querySelector('.case-score')).toHaveAttribute('aria-label', '내 별점 3.5');
  expect(manual.querySelector<HTMLElement>('.case-manual-cover')!.style.backgroundImage).toContain('/hero');
  rerender(<CaseWork item={item} revision="r1" active privacy={false} position={1} total={1} score={() => null} record={() => []} onStep={vi.fn()} info={() => null}/>);
  expect(container.querySelector('.case-manual .case-writing-line')).toBeInTheDocument();
  expect(container.querySelector('.case-manual .is-filled')).toBeNull();
});

it('renders AV rim, booklet and stored performer crops together, then masks them in privacy mode', () => {
  artwork.urls = {portrait: '/portrait-crop'};
  artwork.sources = [];
  const item: CollectionDetail = {...manga, id: 'av', type: 'av', status: 'watched', runtimeMinutes: 120, av: {productCode: 'ABC-123', maker: 'Maker', label: 'Label', genres: [], people: [
    ...Array.from({length: 5}, (_, index) => ({id: `p${index}`, name: `Performer ${index}`, role: 'performer' as const, order: index, portraitCrop: {artworkId: 'portrait', x: .25, y: .1, w: .5, h: .5}})),
    {id: 'director', name: 'Director', role: 'director', order: 0},
  ]}};
  const source: CollectionDetail = {...item, id: 'portrait-owner', artworkVersions: {portrait: {thumbnail: 'portrait-digest'}}};
  const options = {item, portraitSources: [source, item], revision: 'r1', active: true, privacy: false, position: 1, total: 1, score: () => 4, onStep: vi.fn(), info: () => null};
  const {container, rerender} = render(<CaseWork {...options}/>);
  expect(screen.getByRole('article', {name: 'AV 작품 화면'})).not.toHaveAttribute('inert');
  expect(container.querySelector('textPath')).toHaveTextContent('ABC-123 · Maker · Label');
  expect(container.querySelector('.case-av-book')).toHaveTextContent('수록120분');
  expect(container.querySelector('.case-av-record .is-filled')).toHaveAttribute('data-status', 'watched');
  expect(container.querySelectorAll('.case-pola')).toHaveLength(3);
  expect(container.querySelector('.case-pola-more')).toHaveTextContent('+3');
  expect(container.querySelector('.case-director')).toHaveTextContent('감독 · Director');
  expect(container.querySelector('.k-floor .note')).toBeNull();
  const portrait = container.querySelector<HTMLElement>('.case-pola .av-portrait')!;
  expect(portrait.style.backgroundImage).toContain('/portrait-crop');
  expect(portrait.style.backgroundSize).toBe('200% 200%');
  expect(portrait.style.backgroundPosition).toBe('50% 20%');
  expect(artwork.sources.length).toBeGreaterThan(0);
  expect(artwork.sources.every(id => id === 'portrait-owner')).toBe(true);
  rerender(<CaseWork {...options} privacy/>);
  expect(container.querySelector('textPath, .case-av-book, .case-pola, .case-director')).toBeNull();
  expect(container.querySelector('.k-inner .case-mask')).toBeInTheDocument();
});

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
  fireEvent.click(stage, {detail: 1}); expect(onStep).not.toHaveBeenCalled(); expect(object.getAttribute('aria-expanded')).toBe('true');
  fireEvent.pointerDown(stage, touch); fireEvent.pointerMove(stage, {...touch, clientY: 150}); fireEvent.pointerUp(stage, {...touch, clientY: 150});
  fireEvent.click(stage, {detail: 1}); expect(pane.scrollTop).toBe(150); expect(object.getAttribute('aria-expanded')).toBe('true');
  fireEvent.pointerDown(stage, touch); fireEvent.pointerDown(stage, {...touch, pointerId: 2, clientX: 300});
  fireEvent.pointerMove(stage, {...touch, pointerId: 2, clientX: 400});
  fireEvent.pointerUp(stage, {...touch, pointerId: 2}); fireEvent.pointerUp(stage, touch); fireEvent.click(stage, {detail: 1});
  expect(object.getAttribute('aria-expanded')).toBe('true'); expect(onStep).not.toHaveBeenCalled();
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

it('pinches the shared book without rotation or volume swipe, resumes one-finger turning, and resets both through 정면으로', async () => {
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
  view.rerender(<MangaWork {...props} item={{...manga, id: 'another'}}/>);
  expect(zoom()).toBeGreaterThan(1);
  await act(async () => view.container.querySelectorAll('[data-work-pending] img').forEach(image => fireEvent.load(image)));
  expect(zoom()).toBe(1);
});

it('keeps the manga book, backdrop and shelf until every actual incoming image decodes, settling errors without blocking', async () => {
  artwork.urls = {c1: '/one', c2: '/two'};
  const view = render(<MangaWork {...props}/>);
  await act(async () => view.container.querySelectorAll('img').forEach(image => fireEvent.load(image)));
  const old = view.container.querySelector<HTMLImageElement>('.work-backdrop .is-painted')!;
  const book = view.container.querySelector<HTMLImageElement>('.manga-bb-front img')!;
  const shelf = view.container.querySelector('.manga-bookcase')!;
  fireEvent.click(screen.getByRole('button', {name: '다음 권'}));
  const pending = view.container.querySelector('[data-work-pending]')!;
  const next = pending.querySelector<HTMLImageElement>('.work-backdrop img')!;
  let decoded!: () => void;
  Object.defineProperty(next, 'decode', {value: () => new Promise<void>(resolve => {decoded = resolve;})});
  await act(async () => pending.querySelectorAll('img').forEach(image => fireEvent.load(image)));
  expect(old).toBeVisible(); expect(book).toBeVisible(); expect(shelf).toBeVisible();
  expect(next).not.toBeVisible(); expect(screen.getByRole('article')).toHaveAttribute('inert');
  await act(async () => decoded());
  expect(next).toBeVisible(); expect(next).toHaveClass('is-painted');
  expect(pending.querySelector('.manga-bb-front img')).toBeVisible();
  expect(old).not.toBeVisible(); expect(book).not.toBeVisible();
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

it('keeps only thumbnails, returns to the case on a repeated artwork tap or empty stage tap, and frees the strip row without tiles', async () => {
  artwork.urls = {art: '/art'};
  const item: CollectionDetail = {...manga, id: 'game', type: 'game', artworks: [{id: 'art', kind: 'screenshot', selected: false}]};
  const props = {item, revision: 'r1', active: true, privacy: false, position: 1, total: 1, score: () => null, onStep: vi.fn(), info: () => null};
  const view = render(<CaseWork {...props}/>);
  expect(screen.queryByRole('button', {name: '케이스'})).toBeNull();
  expect(screen.queryByRole('button', {name: '안쪽'})).toBeNull();
  const tile = screen.getByRole('button', {name: '아트워크 1'});
  fireEvent.click(tile);
  expect(screen.queryByRole('group', {name: '케이스'})).toBeNull();
  fireEvent.click(tile);
  expect(screen.getByRole('group', {name: '케이스'}).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(tile);
  fireEvent.click(view.container.querySelector('.work-art img')!);
  expect(screen.queryByRole('group', {name: '케이스'})).toBeNull();
  fireEvent.click(view.container.querySelector('.work-art')!);
  expect(screen.getByRole('group', {name: '케이스'})).toBeTruthy();
  view.rerender(<CaseWork {...props} item={{...item, artworks: []}}/>);
  expect(view.container.querySelector('.tablet-work > div[aria-hidden="false"] .work-strip')).toBeNull();
  expect((view.container.querySelector('.tablet-work > div[aria-hidden="false"] .tablet-work__frame') as HTMLElement).style.getPropertyValue('--work-strip-height')).toBe('0px');
});

it('keeps the AV front-thumbnail flat tile first and returns from it on a repeated tap', async () => {
  artwork.urls = {front: '/front', art: '/art'};
  const item: CollectionDetail = {...manga, id: 'av', type: 'av', selectedWorkArtworkId: 'front', artworks: [{id: 'art', kind: 'screenshot', selected: false}]};
  const view = render(<CaseWork item={item} revision="r1" active privacy={false} position={1} total={1} score={() => null} onStep={vi.fn()} info={() => null}/>);
  const flat = screen.getByRole('button', {name: '펼친 표지'});
  expect(view.container.querySelector('.work-strip button')).toBe(flat);
  expect(flat.querySelector('img')?.getAttribute('src')).toBe('/front');
  expect(flat.textContent).toBe('');
  await act(async () => {view.container.querySelectorAll('.work-flat img').forEach(image => fireEvent.load(image));});
  fireEvent.click(flat); expect(flat.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('group', {name: '케이스'})).toBeNull();
  fireEvent.click(flat); expect(screen.getByRole('group', {name: '케이스'})).toBeTruthy();
});

it.each(['game', 'movie', 'av'] as const)('ignores horizontal stage swipes on %s, hides the position counter, and keeps edge navigation', type => {
  artwork.urls = {};
  const item: CollectionDetail = {...manga, id: type, name: '작품', type, releaseDate: '2026-09-01'};
  const onStep = vi.fn();
  const {container} = render(<CaseWork item={item} revision="r1" active privacy={false} position={37} total={181} score={() => null} onStep={onStep} info={() => null}/>);
  expect(screen.getByRole('heading', {name: '작품'})).toBeTruthy();
  const identity = container.querySelector('.tablet-work__identity')!;
  expect(identity.textContent).not.toMatch(/37\s*\/\s*181/);
  expect(identity.querySelector('small')?.textContent).toContain('9.1');
  const stage = container.querySelector('.work-stage')!;
  const touch = {pointerType: 'touch', pointerId: 1, button: 0, clientX: 200, clientY: 200};
  for (const clientX of [100, 300]) {
    fireEvent.pointerDown(stage, touch);
    fireEvent.pointerMove(stage, {...touch, clientX});
    fireEvent.pointerUp(stage, {...touch, clientX});
  }
  expect(onStep).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: '이전 작품'}));
  fireEvent.click(screen.getByRole('button', {name: '다음 작품'}));
  expect(onStep.mock.calls).toEqual([[-1], [1]]);
});


it.each(['game', 'movie', 'av'] as const)('retains every painted %s surface until the actual incoming images decode together', async type => {
  artwork.urls = {front1: '/front1', hero1: '/hero1', art1: '/art1', front2: '/front2', hero2: '/hero2', art2: '/art2', spine1: '/spine1', back1: '/back1', spine2: '/spine2', back2: '/back2'};
  const item: CollectionDetail = {...manga, id: 'one', name: '작품 하나', type, selectedWorkArtworkId: 'front1', selectedHeroArtworkId: 'hero1', artworks: [{id: 'art1', kind: 'screenshot', selected: false}, {id: 'spine1', kind: 'spine', selected: true}, ...(type === 'av' ? [{id: 'back1', kind: 'back', selected: true}] : [])]};
  const options = {item, revision: 'r1', active: true, privacy: false, position: 1, total: 2, score: () => null, onStep: vi.fn(), info: (work: CollectionDetail) => <p>{work.name} 정보</p>};
  const {container, rerender} = render(<CaseWork {...options}/>);
  await act(async () => container.querySelectorAll('img').forEach(image => fireEvent.load(image)));
  const root = screen.getByRole('article');
  const oldCase = screen.getByRole('group', {name: '케이스'});
  fireEvent.keyDown(oldCase, {key: 'Enter'});
  const oldAngle = oldCase.getAttribute('data-angle');
  const oldImages = [...container.querySelectorAll<HTMLImageElement>('.work-case-slot img:not([aria-hidden="true"]), .work-hero-band img, .work-strip img, .work-backdrop .is-painted')];
  const next = {...item, id: 'two', name: '작품 둘', selectedWorkArtworkId: 'front2', selectedHeroArtworkId: 'hero2', artworks: [{id: 'art2', kind: 'screenshot', selected: false}, {id: 'spine2', kind: 'spine', selected: true}, ...(type === 'av' ? [{id: 'back2', kind: 'back', selected: true}] : [])]};
  rerender(<CaseWork {...options} item={next} position={2}/>);
  expect(screen.getByRole('heading', {name: '작품 하나'})).toBeInTheDocument();
  for (const image of oldImages) expect(image).toBeVisible();
  expect(root).toHaveAttribute('inert');
  expect(oldCase).toHaveAttribute('aria-expanded', 'true');
  expect(oldCase.getAttribute('data-angle')).toBe(oldAngle);
  const incoming = container.querySelector<HTMLElement>('[data-work-pending]')!;
  const thumbnail = incoming.querySelector<HTMLImageElement>('.work-strip img[src="/art2"]')!;
  let decoded!: () => void;
  Object.defineProperty(thumbnail, 'decode', {value: () => new Promise<void>(resolve => {decoded = resolve;})});
  await act(async () => incoming.querySelectorAll('img').forEach(image => fireEvent.load(image)));
  for (const image of oldImages) expect(image).toBeVisible();
  expect(screen.getByRole('heading', {name: '작품 하나'})).toBeInTheDocument();
  await act(async () => decoded());
  expect(screen.getByRole('article')).toBe(root);
  expect(screen.getByRole('heading', {name: '작품 둘'})).toBeInTheDocument();
  expect(thumbnail).toBeVisible();
  for (const image of oldImages) expect(image).not.toBeVisible();
  expect(root).not.toHaveAttribute('inert');
  expect(screen.getByRole('group', {name: '케이스'})).toHaveAttribute('aria-expanded', 'false');
});

it('plays the shared case sounds only for the tapped open and close, cancelled by a quick reopen or a new work', async () => {
  vi.useFakeTimers();
  try {
    const play = vi.mocked(playCaseSound); play.mockClear();
    artwork.urls = {};
    const item: CollectionDetail = {...manga, id: 'one', name: '작품 하나', type: 'game', platforms: 'Nintendo Switch'};
    const options = {item, revision: 'r1', active: true, privacy: false, position: 1, total: 2, score: () => null, onStep: vi.fn(), info: () => null};
    const {container, rerender} = render(<CaseWork {...options}/>);
    const kase = screen.getByRole('group', {name: '케이스'});
    act(() => vi.advanceTimersByTime(2000));
    expect(play).not.toHaveBeenCalled();
    fireEvent.keyDown(kase, {key: 'Enter'});
    expect(play.mock.calls).toEqual([['sw', 'open']]);
    fireEvent.click(container.querySelector('.work-stage')!);
    act(() => vi.advanceTimersByTime(529));
    expect(play).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(play.mock.calls).toEqual([['sw', 'open'], ['sw', 'close']]);
    fireEvent.keyDown(kase, {key: 'Enter'}); fireEvent.keyDown(kase, {key: 'Enter'}); fireEvent.keyDown(kase, {key: 'Enter'});
    act(() => vi.advanceTimersByTime(2000));
    expect(play.mock.calls.slice(2)).toEqual([['sw', 'open'], ['sw', 'open']]);
    // Closing and moving on at once: the next work paints silently and the old close sound is dropped.
    fireEvent.keyDown(kase, {key: 'Enter'}); play.mockClear();
    rerender(<CaseWork {...options} item={{...item, id: 'two', name: '작품 둘', platforms: 'PS5'}} position={2}/>);
    await act(async () => container.querySelectorAll('[data-work-pending] img').forEach(image => fireEvent.load(image)));
    expect(screen.getByRole('heading', {name: '작품 둘'})).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(play).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('opens a manga volume with a book sound, but not in privacy mode', () => {
  const play = vi.mocked(playCaseSound); play.mockClear();
  artwork.urls = {c1: '/one', c2: '/two'};
  const onEnlarge = vi.fn();
  const view = render(<MangaWork {...props} onEnlarge={onEnlarge}/>);
  fireEvent.doubleClick(view.container.querySelector('[data-volume-id="v2"]')!);
  expect(play.mock.calls).toEqual([['book', 'open']]);
  expect(onEnlarge).toHaveBeenCalledExactlyOnceWith('v2');
  view.rerender(<MangaWork {...props} privacy onEnlarge={onEnlarge}/>);
  fireEvent.doubleClick(view.container.querySelector('[data-volume-id="v1"]')!);
  expect(play).toHaveBeenCalledTimes(1);
});

it('uses a per-work credit name inside the AV case and the display rule otherwise',()=>{
 const item:CollectionDetail={...manga,type:'av',av:{genres:[],people:[{id:'p',name:'日本名',nameJa:'日本名',stashdbProfile:{name:'Roman Name'},creditName:'작품 속 이름',role:'performer',order:0},{id:'q',name:'別名',nameJa:'別名',stashdbProfile:{name:'Other Roman'},role:'performer',order:1}]}};
 const {container}=render(<CaseWork item={item} revision="credit" active privacy={false} position={1} total={1} score={()=>null} record={()=>[]} onStep={vi.fn()} info={()=>null}/>);
 expect(container.querySelector('.case-pola')).toHaveTextContent('작품 속 이름');expect(container.querySelectorAll('.case-pola')[1]).toHaveTextContent('Other Roman');
});
