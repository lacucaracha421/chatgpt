import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {ExchangeSnapshot} from './exchangeModel';
import type {Asset} from './types';
import type {Note} from '../src/notes/store';
import {ApiError} from './transport';
import {Home, type HomeProps} from './Home';
import {setOutboxConnection} from './outboxConnection';
import {HOME_RELEASE_SHELF_KEY, readHomeShelf, resetReleaseStore} from './releaseStore';
import {resetHomeSourceCache} from './homeCache';
import {commitUpcomingWishlist} from './upcomingWishlistOutbox';
import {PRIVACY_MODE_KEY, PRIVACY_MODE_EVENT} from './privacyMode';
import {LaunchSplash, resetLaunchSplashForTests} from '../src/shared/launch/LaunchSplash';
import {resetTabletHomeNotes} from './homeTablet/notesStore';
import {parseLinks, serializeLinks} from '../src/home/links';
import {TabletLinksSheet} from './homeTablet/TabletLinksSheet';
import {tabletHomeNotes} from './homeTablet/notesStore';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn(), loadThumbnail: vi.fn(), mediaTicket: vi.fn()}));
vi.mock('./transport', async () => { const actual = await vi.importActual<typeof import('./transport')>('./transport'); return {...actual, api: mocks.api, native: mocks.native}; });
vi.mock('./media', () => ({loadThumbnail: mocks.loadThumbnail, mediaTicket: mocks.mediaTicket}));
// The card slot belongs to the cards worker; Home only places it and passes privacy and the album callback.
vi.mock('./cards/TabletDailyCard', () => ({TabletDailyCard: ({privacy, onOpenAlbum}: {privacy: boolean; onOpenAlbum(): void}) =>
  <section aria-label="오늘의 카드" data-privacy={String(privacy)}><button onClick={onOpenAlbum}>앨범 열기</button></section>}));

const works: CollectionSummary[] = [
  {id: 'night', name: '밤의 도서관', type: 'manga', showcase: false, releaseWatch: {enabled: true, available: true}, ownedVolumes: [{editionIndex: 0, count: 3}], releaseSchedule: {kakao: {editionIndex: 0, checkedAt: null, volumes: [{volumeNumber: 4, date: '2026-09-23', status: 'released'}, {volumeNumber: 5, date: '2026-10-08', status: null}]}, mangadex: null}},
  {id: 'sea', name: '바다의 시간', type: 'manga', showcase: false, releaseWatch: {enabled: true, available: true}, ownedVolumes: [{editionIndex: 0, count: 1}], releaseSchedule: {kakao: {editionIndex: 0, checkedAt: null, volumes: [{volumeNumber: 2, date: '2026-10-15', status: 'upcoming'}]}, mangadex: null}},
];
const item = (id: string, at = '2026-09-25T11:00:00Z'): Asset => ({id, kind: 'image', width: 600, height: 800, collected_at: at, thumbnail_available: true});
const releaseReply = {version: 1, revision: 1, counts: {unread: 2, collections: [{collectionId: 'night', unread: 2}]}, items: [], nextCursor: null, hasMore: false};
const revisitReply = {bundles: [{kind: 'date', title: '과거의 이날', items: [item('d1', '2025-09-25T03:00:00Z'), item('d2', '2025-09-25T05:00:00Z')]}, {kind: 'creator', title: '다시 만난 작가', groups: [{creator_key: 'ranzu', creator_name: 'Ranzu', creator_handle: 'ranzu', asset_count: 38, items: [item('r1'), item('r2')]}]}]};
const upcomingEntry = {id: 'game-1', kind: 'game' as const, title: 'Hades II', originalTitle: 'Hades II', date: '2026-10-01', precision: 'exact', platforms: ['PC'], cover: {url: 'https://img.example/hades.jpg'}};
type Server = {savedDays?: (path: string) => unknown; upcoming: unknown; avPick: unknown; artists: unknown; summary: unknown; offline: boolean; review?: unknown};
let server: Server;
let notes: Note[];

const exchange = (sending = false): ExchangeSnapshot => ({configured: true, tokenConfigured: true, receiveSupported: true, deviceId: 'tablet', deviceName: '태블릿', code: '', devices: [{deviceId: 'pc', name: '작업실 PC', kind: 'pc', lastSeenAt: '2026-09-25T11:29:00Z'}], incoming: [{transferId: 'rx1', batchId: 'b', fileName: '받은 표지.jpg', sizeBytes: 100, bytes: 100, peer: 'pc', peerId: 'pc', state: 'saved', code: '', createdAt: '2026-09-25T11:00:00Z'}], unseen: 1, outgoing: sending ? [{transferId: 'tx1', batchId: 'b2', fileName: '스케치.zip', sizeBytes: 100, bytes: 62, peer: 'pc', peerId: 'pc', state: 'uploading', code: '', createdAt: '2026-09-25T10:00:00Z'}] : []});
const note = (id: string, values: Partial<Note>): Note => ({id, title: '', body: '', pinned: true, deleted: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', localRevision: 1, pending: false, conflict: false, ...values});
const pinnedNotes = (): Note[] => [note('shop', {type: 'checklist', title: 'Todo', items: [{id: '1', text: '**우유**', checked: true, order: 'a'}, {id: '2', text: '계란', checked: false, order: 'b'}, {id: '3', text: '두부', checked: true, order: 'c'}]}), note('ledger', {type: 'ledger', title: '가계부', income: 1000000, recurring: [], planned: []}), note('month', {type: 'ledger-month', pinned: false, archived: true, ledger: 'ledger', month: '2026-09', income: null, entries: [{id: 'e1', date: '2026-09-10', amount: 250000, name: '마트', createdAt: '2026-09-10T00:00:00Z'}]})];
/** The month grid's cell of a date, and the day sheet a double tap on it opens. */
const cell = (date: string) => document.querySelector<HTMLElement>(`[data-day="${date}"]`)!;
const monthRegion = () => screen.findByRole('region', {name: '달력'});
async function openDay(date: string) {
  await monthRegion();
  fireEvent.click(cell(date)); fireEvent.click(cell(date));
  return screen.findByRole('dialog', {name: new RegExp(`^${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일`)});
}
const props = (overrides: Partial<HomeProps> = {}): HomeProps => ({items: [item('recent')], hasMore: false, captures: [], busy: false, paused: false, secondaryError: '', scope: 'https://a.example', exchange: exchange(), characters: null, review: {enabled: false, refreshKey: 0}, similarityKey: 0, onPending: vi.fn(), onReview: vi.fn(), onSimilarity: vi.fn(), onDuplicates: vi.fn(), onExchange: vi.fn(), onReleases: vi.fn(), onWork: vi.fn(), onSettings: vi.fn(), onRecent: vi.fn(), onLibrary: vi.fn(), onUnclassified: vi.fn(), onNotes: vi.fn(), onRefresh: vi.fn(), ...overrides});

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(new Date(2026, 8, 25, 14, 32));
  window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: false}}));
  localStorage.clear(); resetHomeSourceCache(); resetTabletHomeNotes(); setOutboxConnection('https://a.example'); resetReleaseStore(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  notes = pinnedNotes(); server = {offline: false, summary: {total: 1500, images: 1200, videos: 300, collections: {game: 10, manga: 20, movie: 30, av: 40}, addedToday: 12, addedThisWeek: 80, unclassified: 7, todayStart: '2026-09-25T00:00:00Z', weekStart: '2026-09-22T00:00:00Z', listGeneration: 'a'.repeat(64)}, upcoming: {version: 1, revision: 2, entries: [upcomingEntry], wishlist: [upcomingEntry], pending: []}, avPick: {version: 1, pick: {personId: 'p1', name: '라라', workCount: 12, cover: null, latestWork: {code: 'LW-1', title: '최근 작품', date: '2026-09-24'}}}, artists: {artists: [{id: 'ranzu', label: 'Ranzu', main: true, assetCount: 38, coverAssetIds: ['r1']}]}};
  mocks.loadThumbnail.mockImplementation(async (asset: Asset) => ({...asset, preview: `blob:${asset.id}`}));
  mocks.mediaTicket.mockImplementation(async (asset: Asset, variant: string) => ({url: `https://img.example/${asset.id}/${variant}`}));
  mocks.native.mockImplementation(async (op: string) => op === 'notesState' ? {unlocked: true, notes, lastSyncedAt: null} : op === 'exchangeThumbnail' ? {url: 'blob:received'} : {url: 'https://example.invalid/cover', expires_in: 300});
  mocks.api.mockImplementation(async (path: string, _signal?: AbortSignal, body?: unknown, method?: string) => {
    if (server.offline) throw new ApiError('서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.', null, null);
    if (path.startsWith('/v1/library/similarity/review')) return {ready: true, counts: {open: 6}};
    if (path.startsWith('/v1/library/characters/review?')) return server.review;
    if (path.startsWith('/v1/mobile-catalog/duplicates')) return {counts: {undecided: 2}};
    if (path.startsWith('/v1/collections/releases')) return releaseReply;
    if (path === '/v1/collections/status') return {revision: 'r1'};
    if (path === '/v1/mobile-catalog/refresh') return {job: null};
    if (path.startsWith('/v1/library/summary?')) { if (server.summary === 404) throw new ApiError('not found', 404, null); return server.summary; }
    if (path.startsWith('/v1/library/revisit?')) return revisitReply;
    if (path === '/v1/home/upcoming') { if (server.upcoming === 404) throw new ApiError('not found', 404, null); return server.upcoming; }
    if (path === '/v1/home/av-pick') { if (server.avPick === 404) throw new ApiError('not found', 404, null); return server.avPick; }
    if (path === '/v1/library/artists') return server.artists;
    if (path === '/v1/home/upcoming/wishlist') return {version: 1, operationId: (body as {operationId: string}).operationId, sequence: 1, revision: 3};
    if (path.startsWith('/v1/collections?')) return {ready: true, filterVersion: 1, revision: 'r1', items: works, nextCursor: null};
    if (path.startsWith('/v1/library/saved-days?') && server.savedDays) return server.savedDays(path);
    throw new Error(`unexpected ${path} ${method ?? ''}`);
  });
});
afterEach(() => {cleanup(); vi.useRealTimers(); setOutboxConnection(null); delete window.LakomicsNative;});

it.each(['native', 'http'])('reuses a valid Home cover immediately on remount and renews it after expiry (%s)', async mode => {
  const sha256 = (mode === 'native' ? 'c' : 'd').repeat(64);
  const entry = {...upcomingEntry, cover: {sha256}};
  server.upcoming = {entries: [entry], wishlist: [entry]};
  if (mode === 'native') window.LakomicsNative = {} as typeof window.LakomicsNative;
  const ticket = vi.fn().mockResolvedValue({url: 'https://img.example/cached-cover', expires_in: 31});
  const readApi = mocks.api.getMockImplementation()!;
  const readNative = mocks.native.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => path.includes('/home/covers/') ? ticket() : readApi(path, ...args));
  mocks.native.mockImplementation((op, ...args) => op === 'homeCover' ? ticket() : readNative(op, ...args));
  render(<Home {...props()}/>);
  const day = within(await openDay('2026-10-01'));
  const open = () => fireEvent.click(day.getByRole('button', {name: /Hades II/}));
  open();
  let sheet = within(screen.getByRole('dialog', {name: entry.title}));
  expect((await sheet.findByRole('img', {name: entry.title})).getAttribute('src')).toBe('https://img.example/cached-cover');
  const requests = ticket.mock.calls.length;
  fireEvent.click(sheet.getByRole('button', {name: '닫기', exact: true}));
  ticket.mockImplementation(() => new Promise(() => {}));
  open();
  sheet = within(screen.getByRole('dialog', {name: entry.title}));
  expect(sheet.getByRole('img', {name: entry.title}).getAttribute('src')).toBe('https://img.example/cached-cover');
  expect(ticket).toHaveBeenCalledTimes(requests);
  fireEvent.click(sheet.getByRole('button', {name: '닫기', exact: true}));
  vi.setSystemTime(Date.now() + 1001);
  open();
  sheet = within(screen.getByRole('dialog', {name: entry.title}));
  // A new img must not start a request with an expired ticket.
  expect(sheet.queryByRole('img', {name: entry.title})).toBeNull();
  expect(ticket).toHaveBeenCalledTimes(requests + 1);
});

describe('shared Home attention on tablet', () => {
  it('acknowledges unread wishlist notices when a Home title is opened', async () => {
    const released = {...upcomingEntry, date: '2026-09-24', released: true, events: [{id: 'release-event', kind: 'released', previousValue: null, currentValue: '2026-09-24', detectedAt: '2026-09-25T00:00:00Z', readAt: null}]};
    server.upcoming = {version: 1, revision: 3, entries: [released], wishlist: [released], pending: []};
    render(<Home {...props()}/>);
    fireEvent.click(await within(await openDay('2026-09-24')).findByRole('button', {name: /Hades II/}));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/v1/home/upcoming/wishlist', expect.anything(), expect.objectContaining({action: 'acknowledge', itemId: released.id, eventIds: ['release-event']}), 'POST', false, props().scope));
  });
  it('shows failed notice acknowledgement inside the open title sheet', async () => {
    const released = {...upcomingEntry, date: '2026-09-24', released: true, events: [{id: 'release-event', kind: 'released', previousValue: null, currentValue: '2026-09-24', detectedAt: '2026-09-25T00:00:00Z', readAt: null}]};
    server.upcoming = {version: 1, revision: 3, entries: [released], wishlist: [released], pending: []};
    const read = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, ...args: unknown[]) => path === '/v1/home/upcoming/wishlist' ? Promise.reject(new Error('offline')) : read(path, ...args));
    render(<Home {...props()}/>);
    fireEvent.click(await within(await openDay('2026-09-24')).findByRole('button', {name: /Hades II/}));
    expect((await screen.findByRole('alert')).textContent).toContain('발매 캘린더에서 다시 확인');
  });
  it('waits for foreground Home reads before full paging and keeps an uncached Home covered until every page is ready', async () => {
    const read=mocks.api.getMockImplementation()!;
    let finishMemos!:(value:unknown)=>void;
    const pages:{path:string;finish(value:unknown):void}[]=[];
    mocks.native.mockImplementation(op=>op==='notesState'?new Promise(finish=>{finishMemos=finish;}):Promise.resolve({}));
    mocks.api.mockImplementation((path,...args)=>path.startsWith('/v1/collections?')?new Promise(finish=>pages.push({path,finish})):read(path,...args));
    const view=render(<Home {...props({captures:null})}/>);
    await act(async()=>{});
    expect(pages).toHaveLength(0);
    await act(async()=>finishMemos({notes:[],revision:1}));
    expect(pages).toHaveLength(0);
    view.rerender(<Home {...props({captures:[]})}/>);
    await waitFor(()=>expect(pages).toHaveLength(3));
    expect(screen.getByRole('status',{name:'홈 미디어'})).toBeTruthy();
    await act(async()=>pages.forEach(page=>page.finish({ready:true,revision:'r1',items:[],nextCursor:'next'})));
    expect(pages).toHaveLength(6);
    expect(screen.queryByRole('region',{name:'달력'})).toBeNull();
    await act(async()=>pages.slice(3).forEach(page=>page.finish({ready:true,revision:'r1',items:page.path.includes('type=manga')?works:[],nextCursor:null})));
    await screen.findByRole('region',{name:'달력'});
    expect(readHomeShelf(props().scope)?.value.works).toEqual(works);
  });
  const hasRelease = (date: string) => cell(date).getAttribute('aria-label')!.includes('발매');
it('shows the kept shelf before paging finishes and converges to the refreshed shelf', async () => {
    const oldGame: CollectionSummary = {id: 'old-game', name: 'Kept Game', type: 'game', showcase: false, releaseDate: '2026-10-02'};
    const newGame: CollectionSummary = {id: 'new-game', name: 'Refreshed Game', type: 'game', showcase: false, releaseDate: '2026-10-03'};
    localStorage.setItem(HOME_RELEASE_SHELF_KEY, JSON.stringify({scope: props().scope, libraryId: null,
      value: {ready: true, revision: 'r0', works: [oldGame]}}));
    const read = mocks.api.getMockImplementation()!;
    const pages: {finish(value: unknown): void; path: string}[] = [];
    mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/collections?')
      ? new Promise(finish => pages.push({finish, path})) : read(path, ...args));
    render(<Home {...props()}/>);
    await monthRegion();
    expect(hasRelease('2026-10-02')).toBe(true);
    await waitFor(()=>expect(pages).toHaveLength(3));
    expect(readHomeShelf(props().scope)?.value.revision).toBe('r0');
    await act(async () => {
      pages.forEach(page => page.finish({ready: true, revision: 'r1', items: [], nextCursor: 'next'}));
    });
    expect(pages).toHaveLength(6);
    expect(hasRelease('2026-10-02')).toBe(true);
    await act(async () => {
      pages.slice(3).forEach(page => page.finish({ready: true, revision: 'r1',
        items: page.path.includes('type=game') ? [newGame] : works, nextCursor: null}));
    });
    await waitFor(() => expect(hasRelease('2026-10-03')).toBe(true));
    expect(hasRelease('2026-10-02')).toBe(false);
    expect(readHomeShelf(props().scope)?.value.works).toEqual([...works, newGame]);
    // A new process has an empty module store but retains the complete input.
    cleanup(); resetReleaseStore(); resetHomeSourceCache(); pages.length = 0;
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(hasRelease('2026-10-03')).toBe(true));
    await waitFor(()=>expect(pages).toHaveLength(3));
  });

  it.each(['other-server', 'other-library', 'invalid'])('does not use a shelf belonging to %s', async kind => {
    localStorage.setItem(HOME_RELEASE_SHELF_KEY, JSON.stringify({scope: kind === 'other-server' ? 'https://other.example' : props().scope, libraryId: 'old-library',
      value: {ready: true, revision: 'r0', works: kind === 'invalid' ? {} : works}}));
    const read = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path, ...args) => {
      if (path === '/v1/collections/status') return Promise.resolve({revision: 'r1', libraryId: 'current-library'});
      if (path.startsWith('/v1/collections?')) return new Promise(() => {});
      return read(path, ...args);
    });
    render(<Home {...props()}/>);
    await act(async () => {});
    expect(screen.queryByRole('region', {name: '달력'})).toBeNull();
    expect(screen.getByRole('status', {name: '홈 미디어'})).toBeTruthy();
  });

  it('stacks the PC parts in order: month, card with 오늘 할 것, transfer with memo; none of the removed sections, 링크 보관 included', async () => {
    server.upcoming = {version:1, entries:[upcomingEntry], wishlist:[upcomingEntry]};
    render(<Home {...props({captures:[item('pending')]})}/>);
    const today = await screen.findByRole('region', {name:'오늘 할 것'});
    await waitFor(()=>expect(within(today).getAllByRole('button').map(b => b.textContent)).toEqual(['□미분류 에셋7장', '□유사 이미지 검토6쌍', '□처리 대기1건', '□Todo남은 항목 1개1개']));
    // The PC's mark (□, ! for a problem), not a glyph badge.
    expect(today.querySelectorAll('.home-attention-mark')).toHaveLength(4);
    await monthRegion();
    expect(screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['달력','오늘의 카드','전송','오늘 할 것','빠른 메모']);
    const layout = document.querySelector('.home-tablet-layout')!;
    const pairs = [...layout.querySelectorAll(':scope > .home-tablet-pair')];
    expect(pairs).toHaveLength(2);
    expect(within(pairs[0] as HTMLElement).getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['오늘의 카드','전송']);
    expect(within(pairs[1] as HTMLElement).getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['오늘 할 것','빠른 메모']);
    for (const name of ['1년 전 오늘','오늘의 한 장','지금 하는 중','2주 안에 발매','자산 현황','AV 배우','작가','메모','검토','이어지는 시리즈']) expect(screen.queryByRole('region',{name})).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => ['/v1/home/av-pick','/v1/library/artists'].includes(path) || path.startsWith('/v1/library/revisit') || path.startsWith('/v1/albums/'))).toBe(false);
    expect(mocks.native.mock.calls.some(([op]) => op === 'albumTree')).toBe(false);
  });
  it('hands the card slot privacy and the album callback', async () => {
    const p = props({onAlbum: vi.fn()}); render(<Home {...p}/>);
    const card = await screen.findByRole('region', {name:'오늘의 카드'});
    expect(card.getAttribute('data-privacy')).toBe('false');
    fireEvent.click(within(card).getByRole('button', {name:'앨범 열기'})); expect(p.onAlbum).toHaveBeenCalledOnce();
    await act(async () => {localStorage.setItem(PRIVACY_MODE_KEY, '1'); window.dispatchEvent(new Event(PRIVACY_MODE_EVENT));});
    expect(screen.getByRole('region', {name:'오늘의 카드'}).getAttribute('data-privacy')).toBe('true');
  });
  it('keeps an empty 오늘 할 것 beside the card when every attention source is empty', async () => {
    notes=[]; server.summary={...(server.summary as object),unclassified:0};
    const read=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path,...args)=> {
      if(path.startsWith('/v1/library/similarity/review')) return Promise.resolve({ready:true,counts:{open:0}});
      if(path.startsWith('/v1/mobile-catalog/duplicates')) return Promise.resolve({counts:{undecided:0}});
      return read(path,...args);
    });
    render(<Home {...props()}/>);
    // The card keeps its half; an empty 오늘 할 것 shows its empty line beside it.
    await monthRegion();
    expect(screen.getByRole('region', {name:/오늘 할 것/}).textContent).toContain('오늘 할 것이 없습니다');
    expect(screen.getByRole('region', {name:'오늘의 카드'})).toBeTruthy();
    expect(document.querySelector('.home-tablet-pair.is-single')).toBeNull();
  });
  it.each(['2026-09-24', '2026-09-25'])('never marks an unwished Korean calendar movie NEW on %s, including a saved pending arrival', async date => {
    const key = 'lakomics.home.visit.v1:https://a.example';
    const previous = new Date(2026,8,23).toISOString();
    localStorage.setItem(key,JSON.stringify({lastVisit:previous,pending:[`title:digger:${date}`],opened:[]}));
    server.upcoming={entries:[{...upcomingEntry,id:'digger',title:'디거',kind:'movie',region:'korea',date}],wishlist:[]};
    render(<Home {...props()}/>);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).lastVisit).not.toBe(previous));
    expect(screen.queryByText('디거')).toBeNull();
  });
  it('keeps a wished title\'s unread release NEW before the previous visit, unless muted', async () => {
    localStorage.setItem('lakomics.home.visit.v1:https://a.example',JSON.stringify({lastVisit:new Date(2026,8,25).toISOString(),pending:[],opened:[]}));
    const watched = {...upcomingEntry,date:'2026-09-22',source:'calendar',released:true,events:[{id:'release',kind:'released',currentValue:'2026-09-22',detectedAt:'2026-09-24T10:00:00Z',readAt:null}]};
    server.upcoming={entries:[],wishlist:[watched,{...watched,id:'muted',title:'Muted movie',muted:true}]};
    render(<Home {...props()}/>);
    const sheet=within(await openDay('2026-09-22'));
    const row=await sheet.findByRole('button',{name:/Hades II/});
    expect(within(row).getByText('NEW')).toBeTruthy();
    expect(sheet.queryByRole('button',{name:/Muted movie/})).toBeNull();
    fireEvent.click(row);
    expect(await screen.findByRole('dialog',{name:'Hades II'})).toBeTruthy();
    expect(mocks.api.mock.calls.some(([path])=>path.includes('detail'))).toBe(false);
  });
  it.each([false, true])('uses the pending wishlist choice (%s) for calendar arrivals', async interested => {
    const key = 'lakomics.home.visit.v1:https://a.example';
    const previous = new Date(2026,8,23).toISOString();
    localStorage.setItem(key,JSON.stringify({lastVisit:previous,pending:['title:game-1:2026-09-24'],opened:[]}));
    const released = {...upcomingEntry,date:'2026-09-24'};
    server.upcoming={entries:[released],wishlist:interested ? [] : [released]};
    commitUpcomingWishlist(released.id, interested);
    render(<Home {...props()}/>);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).lastVisit).not.toBe(previous));
    const sheet = within(await openDay('2026-09-24'));
    if (interested) expect(within(await sheet.findByRole('button',{name:/Hades II/})).getByText('NEW')).toBeTruthy();
    else expect(sheet.queryByText('Hades II')).toBeNull();
  });
  it('routes the review and pinned task rows', async () => {
    const p = props({captures:[item('pending')]}); render(<Home {...p}/>);
    fireEvent.click(await screen.findByRole('button',{name:/미분류 에셋7/})); expect(p.onUnclassified).toHaveBeenCalled(); expect(p.onLibrary).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:/유사 이미지 검토6쌍/})); expect(p.onSimilarity).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:/처리 대기1/})); expect(p.onPending).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:/Todo남은 항목/})); expect(p.onNotes).toHaveBeenCalledWith('shop');
  });
  it('shows one 확인 row with the PC list total and opens it, only when the PC has published a list', async () => {
    server.review = {version: 1, ready: true, counts: {total: 5, s36: 3, b36: 1, doubtful: 1, pendingPc: 0, skipped: 0}, items: [], targets: {}};
    const p = props({review: {enabled: true, refreshKey: 1}}); render(<Home {...p}/>);
    const row = await screen.findByRole('button',{name:/확인5/});
    expect(row.textContent).not.toMatch(/검토|캐릭터/);
    fireEvent.click(row); expect(p.onReview).toHaveBeenCalled();
  });
  it('shows no 확인 row where the PC list is off or empty, and never waits for it', async () => {
    server.review = {version: 1, ready: false, counts: {total: 0}, items: [], targets: {}};
    const p = props({captures: [item('pending')], review: {enabled: true, refreshKey: 1}}); render(<Home {...p}/>);
    expect(await screen.findByRole('button',{name:/처리 대기1/})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/^□?확인/})).toBeNull();
  });
  it('shares subscription and trial-window rows from the on-device ledger', async () => {
    notes = [note('ledger',{type:'ledger',pinned:false,recurring:[{id:'r',name:'무료',amount:10000,every:1,unit:'month',start:'2026-09-28',trial:true,until:null,remindDays:3,memo:'',order:'a'}]})];
    render(<Home {...props()}/>);
    expect(await screen.findByText('구독 이번 달 ₩10,000')).toBeTruthy();
    const reminder = await screen.findByRole('button',{name:/무료 무료 끝남/});
    expect(within(reminder).getByText('D-3')).toBeTruthy();
  });
  it('keeps NEW across tab visits, then clears it only when the item is opened', async () => {
    const p = props(); const view = render(<Home {...p}/>);
    const fresh = await monthRegion();
    expect(fresh.querySelector('[data-new]')).toBeTruthy();
    view.unmount(); const next = render(<Home {...p}/>);
    const card = await within(await openDay('2026-09-23')).findByRole('button',{name:/밤의 도서관.*4권/});
    expect(within(card).getByText('NEW')).toBeTruthy();
    fireEvent.click(card); expect(p.onWork).toHaveBeenCalledWith('night');
    await waitFor(() => expect(screen.queryByText('NEW')).toBeNull());
    next.unmount(); render(<Home {...p}/>);
    await monthRegion();
    expect(screen.queryByText('NEW')).toBeNull();
  });
  it('keeps tasks and calendar days during refresh rather than showing placeholders', async () => {
    const p = props(); render(<Home {...p}/>);
    await screen.findByRole('button',{name:/Todo남은 항목/});
    await monthRegion();
    const before = cell('2026-09-23');
    expect(before.getAttribute('aria-label')).toContain('발매 1개');
    const read = mocks.native.getMockImplementation()!;
    mocks.native.mockImplementation((op,...args) => op === 'notesState' ? new Promise(() => {}) : read(op,...args));
    fireEvent(window, new CustomEvent('lakomics-sync-signals',{detail:{notes:'changed'}}));
    expect(screen.getByRole('button',{name:/Todo남은 항목/})).toBeTruthy();
    expect(cell('2026-09-23')).toBe(before);
  });
  it('shows a connection problem only when a read fails and offers its owning screen', async () => {
    server.offline = true; const p = props(); render(<Home {...p}/>);
    const button = await screen.findByRole('button',{name:/서버연결 안 됨/});
    fireEvent.click(button); expect(p.onSettings).toHaveBeenCalled();
    expect(screen.queryByText('동기화됨')).toBeNull();
  });
  it('puts a wishlist title on its own day, past the old two weeks, and pages months with the buttons', async () => {
    server.upcoming = {entries:[],wishlist:[{...upcomingEntry,date:'2026-10-10'}]};
    render(<Home {...props()}/>);
    await monthRegion();
    expect(cell('2026-10-10').getAttribute('aria-label')).toContain('발매 1개');
    fireEvent.click(screen.getByRole('button',{name:'다음 달'}));
    expect(screen.getByRole('heading',{name:'10월'})).toBeTruthy();
    expect(cell('2026-10-10').getAttribute('aria-label')).toContain('발매 1개');
    fireEvent.click(screen.getByRole('button',{name:'다음 달'}));
    expect(screen.getByRole('heading',{name:'11월'})).toBeTruthy();
    expect(document.querySelector('[data-day="2026-10-10"]')).toBeNull();
  });
});

it('shows owned game and movie releases since the last visit without a wishlist',async()=>{
  localStorage.setItem('lakomics.home.visit.v1:https://a.example',JSON.stringify({lastVisit:new Date(2026,8,23).toISOString(),pending:[],opened:[]}));
  server.upcoming={entries:[],wishlist:[]};
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path,...args)=>{
    if(path.startsWith('/v1/collections?')) {
      const type=new URL(path,'https://test').searchParams.get('type');
      return Promise.resolve({ready:true,revision:'r1',items:type==='manga'?works:[{id:type,name:`owned ${type}`,type,releaseDate:type==='game'?'2026-09-24':'2026-09-25'}],nextCursor:null});
    }
    return original(path,...args);
  });
  const p=props();render(<Home {...p}/>);
  for(const [type,date] of [['game','2026-09-24'],['movie','2026-09-25']]) {
    const row=await within(await openDay(date)).findByRole('button',{name:new RegExp(`owned ${type}`)});
    expect(within(row).getByText('NEW')).toBeTruthy();
    fireEvent.click(row);expect(p.onWork).toHaveBeenCalledWith(type);
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  }
});

it.each(['/v1/collections/releases', '/v1/collections/status', '/v1/collections?', '/v1/home/upcoming'])('waits for %s before advancing this visit', async blocked => {
  const key = 'lakomics.home.visit.v1:https://a.example';
  const previous = new Date(2026,8,23).toISOString();
  localStorage.setItem(key, JSON.stringify({lastVisit:previous,pending:[],opened:[]}));
  server.upcoming={entries:[{...upcomingEntry,date:'2026-09-24'}],wishlist:[{...upcomingEntry,date:'2026-09-24'}]};
  const original=mocks.api.getMockImplementation()!;
  let complete: (() => void) | undefined;
  mocks.api.mockImplementation((path,...args) => {
    if(path.startsWith(blocked) && !complete) return new Promise(resolve => {complete=() => {void original(path,...args).then(resolve);};});
    return original(path,...args);
  });
  render(<Home {...props()}/>);
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  expect(JSON.parse(localStorage.getItem(key)!).lastVisit).toBe(previous);
  complete!();
  const card=await within(await openDay('2026-09-24')).findByRole('button',{name:/Hades II/});
  expect(within(card).getByText('NEW')).toBeTruthy();
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).lastVisit).not.toBe(previous));
});

it('preserves the visit after a failed release read and advances after a successful retry', async () => {
  const key='lakomics.home.visit.v1:https://a.example';
  const previous=new Date(2026,8,23).toISOString();
  localStorage.setItem(key,JSON.stringify({lastVisit:previous,pending:[],opened:[]}));
  const original=mocks.api.getMockImplementation()!;
  let fail=true;
  mocks.api.mockImplementation((path,...args)=>path.startsWith('/v1/collections/releases')&&fail
    ? Promise.reject(new ApiError('failed',500,null)) : original(path,...args));
  render(<Home {...props()}/>);
  await screen.findByRole('button',{name:/서버요청을 처리할 수 없음/});
  expect(JSON.parse(localStorage.getItem(key)!).lastVisit).toBe(previous);
  fail=false;
  const home=screen.getByLabelText('홈');
  fireEvent.touchStart(home,{touches:[{clientX:0,clientY:0}]});
  fireEvent.touchMove(home,{touches:[{clientX:0,clientY:150}]});
  fireEvent.touchEnd(home);
  await waitFor(()=>expect(document.querySelector('[data-new]')).toBeTruthy());
  await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).lastVisit).not.toBe(previous));
});


it('makes no HTTP source reads during nine minutes of visible idle with live signals', async () => {
  vi.useFakeTimers();
  const signals = {collections: 'r1', releases: 1, listGeneration: 'a', catalog: 1, upcoming: 1, notes: 1};
  window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: true, signals}}));
  render(<Home {...props()}/>);
  await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
  const initial = mocks.api.mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  await act(async () => {await vi.advanceTimersByTimeAsync(9 * 60_000);});
  expect(mocks.api).toHaveBeenCalledTimes(initial);
  await act(async () => {window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: true, signals: {...signals, upcoming: 2}}}));});
  expect(mocks.api).toHaveBeenCalledTimes(initial + 1);
});

it('does not read favorites or show the daily fallback while attention is present', async () => {
  const read = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/library/revisit') ? Promise.resolve({bundles: []}) : read(path, ...args));
  render(<Home {...props()} />);
  await screen.findByRole('region', {name: '오늘 할 것'});
  expect(screen.queryByRole('region', {name: '오늘의 한 장'})).toBeNull();
  expect(mocks.native.mock.calls.some(([op]) => op === 'albumTree')).toBe(false);
});

it('includes an owned upcoming game from the replica without a wishlist', async () => {
  server.upcoming = {entries: [], wishlist: []};
  const read = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => {
    if (path.startsWith('/v1/collections?') && new URL(path, 'https://test').searchParams.get('type') === 'game') return Promise.resolve({ready: true, revision: 'r1', nextCursor: null, items: [{id: 'owned-game', type: 'game', name: 'owned future', showcase: false, releaseDate: '2026-09-28'}]});
    return read(path, ...args);
  });
  const p = props(); render(<Home {...p} />);
  const sheet = within(await openDay('2026-09-28'));
  const card = await sheet.findByRole('button', {name: /owned future/});
  expect(within(card).getByRole('img', {name: '게임'})).toBeTruthy();
  expect(within(card).getByText('D-3')).toBeTruthy();
  fireEvent.click(card); expect(p.onWork).toHaveBeenCalledWith('owned-game');
});

it('covers the first Home load on app start with the launch splash, leaves when Home is ready, and never returns', async () => {
  resetLaunchSplashForTests();
  const read = mocks.native.getMockImplementation()!;
  const finish: (() => void)[] = [];
  mocks.native.mockImplementation((op, ...args) => op === 'notesState' ? new Promise(resolve => finish.push(() => resolve({unlocked: true, notes, lastSyncedAt: null}))) : read(op, ...args));
  const splash = render(<LaunchSplash elapsed={() => 0}/>);
  const first = render(<Home {...props()}/>);
  await waitFor(() => expect(finish.length).toBeGreaterThan(0));
  expect(screen.getByRole('status', {name: 'Lakomics 여는 중'}).hasAttribute('data-state')).toBe(false);
  expect(screen.getByLabelText('홈').querySelector('[aria-busy=true]')).toBeTruthy();
  await act(async () => {finish.forEach(done => done());});
  await waitFor(() => expect(document.querySelector('.launch-splash')).toBeNull());
  first.unmount(); resetHomeSourceCache();
  mocks.native.mockImplementation((op, ...args) => op === 'notesState' ? new Promise(() => undefined) : read(op, ...args));
  render(<Home {...props()}/>);
  expect(screen.getByLabelText('홈').querySelector('[aria-busy=true]')).toBeTruthy();
  expect(document.querySelector('.launch-splash')).toBeNull();
  splash.unmount();
});

/** The on-device notes backend: saves land in `notes`, so the next state read returns them. */
function notesBackend() {
  const saves: Note[] = [];
  const read = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation(async (op: string, input?: unknown) => {
    if (op === 'notesSave') {
      const draft = input as Note, previous = notes.find(entry => entry.id === draft.id);
      const saved = {...previous, ...draft, createdAt: previous?.createdAt ?? '2026-09-25T00:00:00Z', localRevision: (previous?.localRevision ?? 0) + 1, pending: false, conflict: false} as Note;
      notes = [saved, ...notes.filter(entry => entry.id !== draft.id)]; saves.push(saved);
      return saved;
    }
    if (op === 'notesSync') return {unlocked: true, notes, lastSyncedAt: '2026-09-25T05:00:00Z'};
    if (op === 'notesLedgerMonthId') { const {ledger, month} = input as {ledger: string; month: string}; return {id: notes.find(entry => entry.type === 'ledger-month' && entry.ledger === ledger && entry.month === month)?.id ?? `month-${month}`}; }
    return read(op, input);
  });
  return saves;
}
const savedBodies = (saves: Note[], title: string) => saves.filter(entry => entry.title === title).map(entry => entry.body);

describe('tablet Home month calendar', () => {
  it('shows the month Sunday first with today filled, pages by swipe and buttons, and comes back with 오늘', async () => {
    render(<Home {...props()}/>);
    const region = await monthRegion();
    expect(screen.getByRole('heading', {name: '9월'})).toBeTruthy();
    expect(region.querySelectorAll('.home-cal__day')).toHaveLength(42);
    expect([...region.querySelectorAll('.home-cal__weekday')].map(day => day.textContent).join('')).toBe('일월화수목금토');
    expect(region.querySelector('.home-cal__day')?.getAttribute('data-day')).toBe('2026-08-30');
    expect(region.querySelector('.home-cal__day[data-tense="today"] .home-cal__date')?.textContent).toBe('25');
    const strip = document.querySelector('.home-tablet-month')!;
    // A mostly vertical drag is the page scrolling, not a swipe.
    fireEvent.touchStart(strip, {touches: [{clientX: 300, clientY: 100}]});
    fireEvent.touchEnd(strip, {changedTouches: [{clientX: 200, clientY: 260}]});
    expect(screen.getByRole('heading', {name: '9월'})).toBeTruthy();
    fireEvent.touchStart(strip, {touches: [{clientX: 300, clientY: 100}]});
    fireEvent.touchEnd(strip, {changedTouches: [{clientX: 200, clientY: 110}]});
    expect(screen.getByRole('heading', {name: '10월'})).toBeTruthy();
    fireEvent.touchStart(strip, {touches: [{clientX: 100, clientY: 100}]});
    fireEvent.touchEnd(strip, {changedTouches: [{clientX: 260, clientY: 100}]});
    expect(screen.getByRole('heading', {name: '9월'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '이전 달'}));
    expect(screen.getByRole('heading', {name: '8월'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '오늘'}));
    expect(screen.getByRole('heading', {name: '9월'})).toBeTruthy();
    expect((screen.getByRole('button', {name: '오늘'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps a past release on its day and shows no saved-image heat while the server gives no counts', async () => {
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(cell('2026-09-23').getAttribute('aria-label')).toContain('발매 1개'));
    expect(cell('2026-10-08').getAttribute('aria-label')).toContain('발매 1개');
    expect(document.querySelector('[data-heat]')).toBeNull();
    expect(cell('2026-09-24').textContent).not.toMatch(/\d+장/);
  });
  it('places ledger payments on their day and keeps them read-only in the day sheet', async () => {
    notes = [note('ledger', {type: 'ledger', title: '가계부', pinned: false, income: null, recurring: [{id: 'r', name: '넷플릭스', amount: 17000, every: 1, unit: 'month', start: '2026-08-27', trial: false, until: null, remindDays: 0, memo: '', order: 'a'}], planned: []})];
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(cell('2026-09-27').textContent).toContain('넷플릭스'));
    expect(cell('2026-09-27').textContent).not.toContain('17,000');
    const sheet = within(await openDay('2026-09-27'));
    const charge = sheet.getByRole('group', {name: '넷플릭스 결제 예정'});
    expect(charge.textContent).toContain('고정·구독 자동');
    expect(sheet.getByLabelText('하루 합계').textContent).toBe('₩17,000');
    expect(sheet.queryByRole('button', {name: /넷플릭스/})).toBeNull();
  });
  it('opens the release calendar from the header', async () => {
    const p = props(); render(<Home {...p}/>);
    await monthRegion();
    fireEvent.click(screen.getByRole('button', {name: '발매 캘린더'})); expect(p.onReleases).toHaveBeenCalledTimes(1);
  });
});

/** The saved-days reply for the 42 days of `path`: `counts` by date, zero elsewhere. */
const savedDaysReply = (path: string, counts: Record<string, number>) => {
  const from = new URL(path, 'https://a.example').searchParams.get('from')!;
  const first = new Date(`${from}T12:00:00Z`);
  return {version: 1, listGeneration: 'g', days: Array.from({length: 42}, (_, index) => { const date = new Date(first.getTime() + index * 86_400_000).toISOString().slice(0, 10); return {date, count: counts[date] ?? 0}; })};
};

describe('tablet Home month saved-image counts', () => {
  it('asks once for the shown month\'s 42 local days and draws the heat strip and the count', async () => {
    const asked: string[] = [];
    server.savedDays = path => { asked.push(path); return savedDaysReply(path, {'2026-09-24': 4, '2026-09-23': 40, '2026-09-26': 9}); };
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(cell('2026-09-24').getAttribute('data-heat')).toBeTruthy());
    expect(asked).toHaveLength(1);
    const query = new URL(asked[0]!, 'https://a.example').searchParams;
    expect(query.get('from')).toBe('2026-08-30');
    expect(query.get('bounds')!.split(',')).toHaveLength(43);
    expect(cell('2026-09-24').getAttribute('aria-label')).toContain('저장 4장');
    expect(Number(cell('2026-09-23').getAttribute('data-heat'))).toBeGreaterThan(Number(cell('2026-09-24').getAttribute('data-heat')));
    // Today and the past only: a future day never shows saved images.
    expect(cell('2026-09-26').hasAttribute('data-heat')).toBe(false);
    expect(cell('2026-09-22').hasAttribute('data-heat')).toBe(false);
  });
  it('shows a 저장한 이미지 row at the top of the day sheet that opens the library', async () => {
    server.savedDays = path => savedDaysReply(path, {'2026-09-24': 1234});
    const p = props(); render(<Home {...p}/>);
    await waitFor(() => expect(cell('2026-09-24')?.getAttribute('aria-label')).toContain('저장 1,234장'));
    const sheet = within(await openDay('2026-09-24'));
    const row = sheet.getByRole('button', {name: /저장한 이미지/});
    expect(row.textContent).toContain('1,234장');
    expect(row.compareDocumentPosition(sheet.getByRole('region', {name: '메모'})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(row);
    expect(p.onLibrary).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A day without saved images has no row.
    expect(within(await openDay('2026-09-22')).queryByRole('button', {name: /저장한 이미지/})).toBeNull();
  });
  it('keeps the counts on screen while the next month loads', async () => {
    const waiting: Array<(reply: unknown) => void> = [];
    server.savedDays = path => {
      if (new URL(path, 'https://a.example').searchParams.get('from') === '2026-08-30') return savedDaysReply(path, {'2026-09-04': 4, '2026-09-24': 2});
      return new Promise(finish => waiting.push(finish));
    };
    render(<Home {...props()}/>);
    await waitFor(() => expect(cell('2026-09-04').getAttribute('data-heat')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', {name: '이전 달'}));
    await waitFor(() => expect(waiting).toHaveLength(1));
    expect(screen.getByRole('heading', {name: '8월'})).toBeTruthy();
    // 9/4 is in August's grid as well and keeps its strip from the earlier read while August loads.
    expect(cell('2026-09-04').getAttribute('data-heat')).toBeTruthy();
    await act(async () => { waiting[0]!(savedDaysReply('/v1/library/saved-days?from=2026-07-26', {'2026-08-10': 7, '2026-09-04': 5})); });
    await waitFor(() => expect(cell('2026-08-10').getAttribute('data-heat')).toBeTruthy());
    expect(cell('2026-09-04').getAttribute('data-heat')).toBeTruthy();
  });
  it('leaves the cells without heat when the server does not know the route', async () => {
    let asked = 0;
    server.savedDays = () => { asked++; throw new ApiError('not found', 404, null); };
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(asked).toBe(1));
    fireEvent.click(screen.getByRole('button', {name: '이전 달'}));
    expect(screen.getByRole('heading', {name: '8월'})).toBeTruthy();
    expect(document.querySelector('[data-heat]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The route is not asked again for the other months.
    expect(asked).toBe(1);
  });
});

describe('tablet Home day opening', () => {
  it('selects a day on one tap without opening it, and opens it on a second tap on the same day', async () => {
    render(<Home {...props()}/>);
    await monthRegion();
    fireEvent.click(cell('2026-09-24'));
    expect(cell('2026-09-24').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(cell('2026-09-24'));
    expect(await screen.findByRole('dialog', {name: /^9월 24일/})).toBeTruthy();
  });
  it('does not open on taps on two different days or on two taps more than 300 ms apart', async () => {
    render(<Home {...props()}/>);
    await monthRegion();
    fireEvent.click(cell('2026-09-24')); fireEvent.click(cell('2026-09-23'));
    expect(cell('2026-09-23').getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-09-24').getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(cell('2026-09-24'));
    act(() => { vi.setSystemTime(new Date(2026, 8, 25, 14, 32, 0, 400)); });
    fireEvent.click(cell('2026-09-24'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(cell('2026-09-24'));
    expect(await screen.findByRole('dialog', {name: /^9월 24일/})).toBeTruthy();
  });
  it('opens the day on Enter and still pages months by swipe', async () => {
    render(<Home {...props()}/>);
    await monthRegion();
    cell('2026-09-24').focus();
    fireEvent.keyDown(cell('2026-09-24'), {key: 'Enter'});
    expect(await screen.findByRole('dialog', {name: /^9월 24일/})).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: '닫기'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const strip = document.querySelector('.home-tablet-month')!;
    fireEvent.touchStart(strip, {touches: [{clientX: 300, clientY: 100}]});
    fireEvent.touchEnd(strip, {changedTouches: [{clientX: 200, clientY: 110}]});
    expect(screen.getByRole('heading', {name: '10월'})).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('tablet Home day sheet', () => {
  it('opens on a tapped day with the sections, keeps the day marked and closes with 닫기', async () => {
    render(<Home {...props()}/>);
    const sheet = within(await openDay('2026-09-24'));
    expect(sheet.getByRole('region', {name: '메모'})).toBeTruthy();
    expect(sheet.getByRole('region', {name: '가계부'})).toBeTruthy();
    expect(sheet.getByRole('region', {name: '모든 구독'})).toBeTruthy();
    expect(sheet.getByRole('region', {name: '사고 싶은 것'})).toBeTruthy();
    expect(cell('2026-09-24').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(sheet.getByRole('button', {name: '닫기'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cell('2026-09-24').getAttribute('aria-selected')).toBe('true');
  });
  it('writes the day memo into the hidden per-month note and shows the memo another device wrote', async () => {
    notes = [...pinnedNotes(), note('memo-0924', {type: 'checklist', title: '달력 메모 2026-09', pinned: false, archived: true, items: [{id: '2026-09-24', text: 'PC에서 쓴 메모', checked: false, order: 'V'}]})];
    const saves = notesBackend();
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(cell('2026-09-24').getAttribute('aria-label')).toContain('메모 있음'));
    const other = within(await openDay('2026-09-24')).getByRole('textbox', {name: '9월 24일 메모'}) as HTMLTextAreaElement;
    expect(other.value).toBe('PC에서 쓴 메모');
    fireEvent.click(screen.getByRole('button', {name: '닫기'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const memo = within(await openDay('2026-09-25')).getByRole('textbox', {name: '9월 25일 메모'});
    fireEvent.change(memo, {target: {value: '엣지러너 정주행'}});
    await waitFor(() => expect(saves.at(-1)).toMatchObject({id: 'memo-0924', archived: true}), {timeout: 3000});
    expect(saves.at(-1)!.items).toEqual([{id: '2026-09-24', text: 'PC에서 쓴 메모', checked: false, order: 'V'}, {id: '2026-09-25', text: '엣지러너 정주행', checked: false, order: 'V'}]);
    expect(cell('2026-09-25').getAttribute('aria-label')).toContain('메모 있음');
  });
  it('lists the day\'s entries with the day total, and an entry opens the 가계부 sheet where it can be removed', async () => {
    const saves = notesBackend();
    render(<Home {...props()}/>);
    await monthRegion();
    await waitFor(() => expect(cell('2026-09-10').getAttribute('aria-label')).toContain('지출 250,000원'));
    const sheet = within(await openDay('2026-09-10'));
    expect(sheet.getByLabelText('하루 합계').textContent).toBe('₩250,000');
    fireEvent.click(sheet.getByRole('button', {name: /마트/}));
    fireEvent.click(await screen.findByRole('button', {name: '삭제'}));
    await waitFor(() => expect(saves.some(saved => saved.id === 'month' && saved.entries?.length === 0)).toBe(true));
    await waitFor(() => expect(sheet.getByText('기록 없음')).toBeTruthy());
  });
  it('adds a spending line to the tapped day with the 가계부 quick input', async () => {
    const saves = notesBackend();
    render(<Home {...props()}/>);
    await monthRegion();
    const sheet = within(await openDay('2026-09-25'));
    fireEvent.change(await sheet.findByRole('textbox', {name: '이날 지출 빠른 입력'}), {target: {value: '점심 8000'}});
    fireEvent.click(within(sheet.getByRole('region', {name: '가계부'})).getByRole('button', {name: '추가'}));
    await waitFor(() => expect(saves.some(saved => saved.id === 'month' && saved.entries?.some(entry => entry.date === '2026-09-25' && entry.amount === 8000 && entry.name === '점심'))).toBe(true));
    expect(await sheet.findByText('점심')).toBeTruthy();
  });
  it('adds something to buy in place from the folded list', async () => {
    const saves = notesBackend();
    render(<Home {...props()}/>);
    await monthRegion();
    const sheet = within(await openDay('2026-09-25'));
    fireEvent.click(sheet.getByRole('button', {name: /^사고 싶은 것/}));
    fireEvent.change(await sheet.findByRole('textbox', {name: '사고 싶은 것 빠른 입력'}), {target: {value: '키보드 120000'}});
    fireEvent.click(within(sheet.getByRole('region', {name: '사고 싶은 것'})).getByRole('button', {name: '추가'}));
    await waitFor(() => expect(saves.some(saved => saved.id === 'ledger' && saved.planned?.some(plan => plan.name === '키보드' && plan.amount === 120000))).toBe(true));
  });
  it('hides amounts in privacy mode but keeps names and the memo, and leaves entries read-only', async () => {
    localStorage.setItem(PRIVACY_MODE_KEY, '1');
    render(<Home {...props()}/>);
    await monthRegion();
    const sheet = within(await openDay('2026-09-10'));
    const row = await sheet.findByRole('group', {name: '마트'});
    expect(row.textContent).toContain('마트');
    expect(row.textContent).not.toContain('250,000');
    expect(within(row).getByLabelText('금액 숨김')).toBeTruthy();
    expect(sheet.queryByRole('button', {name: /마트/})).toBeNull();
    expect(cell('2026-09-10').getAttribute('aria-label')).not.toContain('250,000');
    expect(sheet.getByRole('textbox', {name: '9월 10일 메모'})).toBeTruthy();
  });
});


describe('tablet Home tools and the 링크 보관 sheet', () => {
  it('saves 빠른 메모 by itself into one plain note titled 빠른 메모, and keeps editing the same note', async () => {
    notes = []; const saves = notesBackend();
    render(<Home {...props()}/>);
    const memo = await screen.findByRole('textbox', {name: '빠른 메모'});
    await waitFor(() => expect((memo as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(memo, {target: {value: '우유 사기'}});
    await waitFor(() => expect(savedBodies(saves, '빠른 메모')).toContain('우유 사기'), {timeout: 3000});
    expect(saves[0]).toMatchObject({title: '빠른 메모', pinned: false});
    fireEvent.change(memo, {target: {value: '우유 사기 / 계란'}});
    await waitFor(() => expect(savedBodies(saves, '빠른 메모')).toContain('우유 사기 / 계란'), {timeout: 3000});
    expect(new Set(saves.filter(entry => entry.title === '빠른 메모').map(entry => entry.id)).size).toBe(1);
  });
  it('shows the PC-written 빠른 메모 and writes back to that note', async () => {
    notes = [note('qm', {title: '빠른 메모', body: 'PC에서 쓴 글', pinned: false})]; const saves = notesBackend();
    render(<Home {...props()}/>);
    const memo = await screen.findByRole('textbox', {name: '빠른 메모'});
    await waitFor(() => expect((memo as HTMLTextAreaElement).value).toBe('PC에서 쓴 글'));
    fireEvent.change(memo, {target: {value: 'PC에서 쓴 글 + 태블릿'}});
    fireEvent.blur(memo);
    await waitFor(() => expect(saves.at(-1)).toMatchObject({id: 'qm', body: 'PC에서 쓴 글 + 태블릿'}), {timeout: 3000});
  });
  it('keeps a pasted link in the shared 링크 보관 note format, without a preview, and ignores a repeat', async () => {
    notes = []; const saves = notesBackend();
    render(<TabletLinksSheet store={tabletHomeNotes(props().scope)} root={props().scope} privacy={false} onOpenNotes={vi.fn()} onClose={vi.fn()}/>);
    const input = await screen.findByRole('textbox', {name: 'URL 붙여넣기'});
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.paste(input, {clipboardData: {getData: () => 'https://www.example.org/a'}});
    await waitFor(() => expect(savedBodies(saves, '링크 보관')).toHaveLength(1));
    const rows = parseLinks(savedBodies(saves, '링크 보관')[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({url: 'https://www.example.org/a', title: 'example.org'});
    expect(rows[0].imageUrl).toBeUndefined();
    expect(saves[0].body.startsWith('링크 보관\n\n```json')).toBe(true);
    expect(await screen.findByRole('button', {name: /example\.org.*example\.org/})).toBeTruthy();
    fireEvent.change(input, {target: {value: 'https://www.example.org/a'}});
    fireEvent.click(screen.getByRole('button', {name: '보관'}));
    await act(async () => {await Promise.resolve();});
    for (const body of savedBodies(saves, '링크 보관')) expect(parseLinks(body)).toHaveLength(1);
    fireEvent.change(input, {target: {value: 'not a url'}});
    fireEvent.click(screen.getByRole('button', {name: '보관'}));
    expect((await screen.findAllByRole('status')).some(status => status.textContent?.includes('http 또는 https'))).toBe(true);
  });
  it('shows PC-filled previews, loads only https thumbnails and masks them in privacy mode', async () => {
    const kept = [
      {url: 'https://a.example/1', title: '첫 글', siteName: 'A 사이트', imageUrl: 'https://img.example/1.png', savedAt: '2026-09-25T09:00:00Z'},
      {url: 'https://b.example/2', title: 'b.example', savedAt: '2026-09-24T09:00:00Z'},
      {url: 'https://c.example/3', title: '평문 이미지', imageUrl: 'http://img.example/3.png', savedAt: '2026-09-23T09:00:00Z'},
    ];
    notes = [{...note('links', {title: '링크 보관', pinned: false}), body: serializeLinks(kept)}];
    const view = render(<TabletLinksSheet store={tabletHomeNotes(props().scope)} root={props().scope} privacy={false} onOpenNotes={vi.fn()} onClose={vi.fn()}/>);
    const first = await screen.findByRole('button', {name: /첫 글.*A 사이트/});
    await waitFor(() => expect(first.querySelector('img')?.getAttribute('src')).toBe('https://img.example/1.png'));
    expect(screen.getByRole('button', {name: /b\.example.*b\.example/})).toBeTruthy();
    expect(screen.getByRole('button', {name: /평문 이미지(?! (복사|삭제))/}).querySelector('img')).toBeNull();
    view.rerender(<TabletLinksSheet store={tabletHomeNotes(props().scope)} root={props().scope} privacy onOpenNotes={vi.fn()} onClose={vi.fn()}/>);
    const section = screen.getByRole('region', {name: '링크 보관'});
    expect(section.querySelectorAll('img')).toHaveLength(0);
    // Only the link with a usable https image keeps a (masked) thumbnail; the others show text only.
    expect(section.querySelectorAll('.home-cover-placeholder.is-private')).toHaveLength(1);
    expect(section.querySelectorAll('.home-tab-link__thumb')).toHaveLength(1);
    view.unmount();
  });
  it('lists every kept link in the sheet, while Home no longer carries 링크 보관', async () => {
    const many = Array.from({length: 6}, (_, index) => ({url: `https://a.example/${index}`, title: `글 ${index}`, savedAt: `2026-09-2${index}T09:00:00Z`}));
    notes = [{...note('links', {title: '링크 보관', pinned: false}), body: serializeLinks(many)}];
    const view = render(<Home {...props()}/>);
    await monthRegion();
    expect(screen.queryByRole('region', {name: '링크 보관'})).toBeNull();
    view.unmount();
    render(<TabletLinksSheet store={tabletHomeNotes(props().scope)} root={props().scope} privacy={false} onOpenNotes={vi.fn()} onClose={vi.fn()}/>);
    expect(await screen.findAllByRole('button', {name: /^글 \d(?!.*(복사|삭제)$)/})).toHaveLength(6);
  });
  it('opens a kept link outside the app', async () => {
    notes = [{...note('links', {title: '링크 보관', pinned: false}), body: serializeLinks([{url: 'https://a.example/1', title: '첫 글', savedAt: '2026-09-25T09:00:00Z'}])}];
    render(<TabletLinksSheet store={tabletHomeNotes(props().scope)} root={props().scope} privacy={false} onOpenNotes={vi.fn()} onClose={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', {name: /첫 글(?!.*(복사|삭제)$)/}));
    await waitFor(() => expect(mocks.native).toHaveBeenCalledWith('openExternal', {url: 'https://a.example/1'}));
  });
  it('sends files to the PC through the exchange picker and shows the newest send on the icon alone', async () => {
    const p = props({exchange: exchange(true)}); render(<Home {...p}/>);
    const send = await screen.findByRole('button', {name: /PC로 파일 보내기/});
    expect(send.getAttribute('aria-label')).toBe('스케치.zip 업로드 중 · PC로 파일 보내기');
    expect(screen.queryByRole('list', {name: '최근 보낸 파일'})).toBeNull();
    fireEvent.click(send);
    await waitFor(() => expect(mocks.native).toHaveBeenCalledWith('exchangeSend', {toDevice: 'pc'}));
    fireEvent.click(screen.getByRole('button', {name: /^상세/})); expect(p.onExchange).toHaveBeenCalled();
  });
  it('cannot send while the exchange is not set up and says why', async () => {
    render(<Home {...props({exchange: {...exchange(), tokenConfigured: false}})}/>);
    const send = await screen.findByRole('button', {name: /토큰/});
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.native.mock.calls.some(([op]) => op === 'exchangeSend')).toBe(false);
  });
  it('shows a failed pick as a message', async () => {
    mocks.native.mockImplementation(async (op: string) => { if (op === 'exchangeSend') throw new Error('파일을 읽지 못했습니다'); return op === 'notesState' ? {unlocked: true, notes, lastSyncedAt: null} : {url: 'https://example.invalid/cover', expires_in: 300}; });
    render(<Home {...props({exchange: exchange()})}/>);
    fireEvent.click(await screen.findByRole('button', {name: 'PC로 파일 보내기'}));
    expect((await screen.findByRole('alert')).textContent).toContain('파일을 읽지 못했습니다');
    expect(screen.getByRole('button', {name: /보내지 못했습니다: 파일을 읽지 못했습니다/})).toBeTruthy();
  });
});
