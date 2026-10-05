import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {ExchangeSnapshot} from './exchangeModel';
import type {Asset} from './types';
import type {Note} from '../src/notes/store';
import {ApiError} from './transport';
import {Home, type HomeProps} from './Home';
import {setOutboxConnection} from './outboxConnection';
import {resetReleaseStore} from './releaseStore';
import {resetHomeSourceCache} from './homeCache';
import {commitUpcomingWishlist} from './upcomingWishlistOutbox';
import {PRIVACY_MODE_KEY, PRIVACY_MODE_EVENT} from './privacyMode';
import {LaunchSplash, resetLaunchSplashForTests} from '../src/shared/launch/LaunchSplash';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn(), loadThumbnail: vi.fn(), mediaTicket: vi.fn()}));
vi.mock('./transport', async () => { const actual = await vi.importActual<typeof import('./transport')>('./transport'); return {...actual, api: mocks.api, native: mocks.native}; });
vi.mock('./media', () => ({loadThumbnail: mocks.loadThumbnail, mediaTicket: mocks.mediaTicket}));

const works: CollectionSummary[] = [
  {id: 'night', name: '밤의 도서관', type: 'manga', showcase: false, releaseWatch: {enabled: true, available: true}, ownedVolumes: [{editionIndex: 0, count: 3}], releaseSchedule: {kakao: {editionIndex: 0, checkedAt: null, volumes: [{volumeNumber: 4, date: '2026-09-16', status: 'released'}, {volumeNumber: 5, date: '2026-10-08', status: null}]}, mangadex: null}},
  {id: 'sea', name: '바다의 시간', type: 'manga', showcase: false, releaseWatch: {enabled: true, available: true}, ownedVolumes: [{editionIndex: 0, count: 1}], releaseSchedule: {kakao: {editionIndex: 0, checkedAt: null, volumes: [{volumeNumber: 2, date: '2026-10-15', status: 'upcoming'}]}, mangadex: null}},
];
const item = (id: string, at = '2026-09-25T11:00:00Z'): Asset => ({id, kind: 'image', width: 600, height: 800, collected_at: at, thumbnail_available: true});
const releaseReply = {version: 1, revision: 1, counts: {unread: 2, collections: [{collectionId: 'night', unread: 2}]}, items: [], nextCursor: null, hasMore: false};
const revisitReply = {bundles: [{kind: 'date', title: '과거의 이날', items: [item('d1', '2025-09-25T03:00:00Z'), item('d2', '2025-09-25T05:00:00Z')]}, {kind: 'creator', title: '다시 만난 작가', groups: [{creator_key: 'ranzu', creator_name: 'Ranzu', creator_handle: 'ranzu', asset_count: 38, items: [item('r1'), item('r2')]}]}]};
const upcomingEntry = {id: 'game-1', kind: 'game' as const, title: 'Hades II', originalTitle: 'Hades II', date: '2026-10-01', precision: 'exact', platforms: ['PC'], cover: {url: 'https://img.example/hades.jpg'}};
type Server = {upcoming: unknown; avPick: unknown; artists: unknown; summary: unknown; offline: boolean};
let server: Server;
let notes: Note[];

const exchange = (sending = false): ExchangeSnapshot => ({configured: true, tokenConfigured: true, receiveSupported: true, deviceId: 'tablet', deviceName: '태블릿', code: '', devices: [{deviceId: 'pc', name: '작업실 PC', kind: 'pc', lastSeenAt: '2026-09-25T11:29:00Z'}], incoming: [{transferId: 'rx1', batchId: 'b', fileName: '받은 표지.jpg', sizeBytes: 100, bytes: 100, peer: 'pc', peerId: 'pc', state: 'saved', code: '', createdAt: '2026-09-25T11:00:00Z'}], unseen: 1, outgoing: sending ? [{transferId: 'tx1', batchId: 'b2', fileName: '스케치.zip', sizeBytes: 100, bytes: 62, peer: 'pc', peerId: 'pc', state: 'uploading', code: '', createdAt: '2026-09-25T10:00:00Z'}] : []});
const note = (id: string, values: Partial<Note>): Note => ({id, title: '', body: '', pinned: true, deleted: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', localRevision: 1, pending: false, conflict: false, ...values});
const pinnedNotes = (): Note[] => [note('shop', {type: 'checklist', title: 'Todo', items: [{id: '1', text: '**우유**', checked: true, order: 'a'}, {id: '2', text: '계란', checked: false, order: 'b'}, {id: '3', text: '두부', checked: true, order: 'c'}]}), note('ledger', {type: 'ledger', title: '가계부', income: 1000000, recurring: [], planned: []}), note('month', {type: 'ledger-month', pinned: false, archived: true, ledger: 'ledger', month: '2026-09', income: null, entries: [{id: 'e1', date: '2026-09-10', amount: 250000, name: '마트', createdAt: '2026-09-10T00:00:00Z'}]})];
const props = (overrides: Partial<HomeProps> = {}): HomeProps => ({items: [item('recent')], hasMore: false, captures: [], busy: false, paused: false, secondaryError: '', scope: 'https://a.example', exchange: exchange(), characters: null, review: {enabled: false, refreshKey: 0}, similarityKey: 0, onPending: vi.fn(), onReview: vi.fn(), onSimilarity: vi.fn(), onDuplicates: vi.fn(), onExchange: vi.fn(), onReleases: vi.fn(), onWork: vi.fn(), onSettings: vi.fn(), onRecent: vi.fn(), onLibrary: vi.fn(), onUnclassified: vi.fn(), onNotes: vi.fn(), onRefresh: vi.fn(), ...overrides});

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(new Date(2026, 8, 25, 14, 32));
  window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: false}}));
  localStorage.clear(); resetHomeSourceCache(); setOutboxConnection('https://a.example'); resetReleaseStore(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  notes = pinnedNotes(); server = {offline: false, summary: {total: 1500, images: 1200, videos: 300, collections: {game: 10, manga: 20, movie: 30, av: 40}, addedToday: 12, addedThisWeek: 80, unclassified: 7, todayStart: '2026-09-25T00:00:00Z', weekStart: '2026-09-22T00:00:00Z', listGeneration: 'a'.repeat(64)}, upcoming: {version: 1, revision: 2, entries: [upcomingEntry], wishlist: [upcomingEntry], pending: []}, avPick: {version: 1, pick: {personId: 'p1', name: '라라', workCount: 12, cover: null, latestWork: {code: 'LW-1', title: '최근 작품', date: '2026-09-24'}}}, artists: {artists: [{id: 'ranzu', label: 'Ranzu', main: true, assetCount: 38, coverAssetIds: ['r1']}]}};
  mocks.loadThumbnail.mockImplementation(async (asset: Asset) => ({...asset, preview: `blob:${asset.id}`}));
  mocks.mediaTicket.mockImplementation(async (asset: Asset, variant: string) => ({url: `https://img.example/${asset.id}/${variant}`}));
  mocks.native.mockImplementation(async (op: string) => op === 'notesState' ? {unlocked: true, notes, lastSyncedAt: null} : op === 'exchangeThumbnail' ? {url: 'blob:received'} : {url: 'https://example.invalid/cover', expires_in: 300});
  mocks.api.mockImplementation(async (path: string, _signal?: AbortSignal, body?: unknown, method?: string) => {
    if (server.offline) throw new ApiError('서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.', null, null);
    if (path.startsWith('/v1/library/similarity/review')) return {ready: true, counts: {open: 6}};
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
    throw new Error(`unexpected ${path} ${method ?? ''}`);
  });
});
afterEach(() => {cleanup(); vi.useRealTimers(); setOutboxConnection(null); delete window.LakomicsNative;});

describe('shared Home attention on tablet', () => {
  it('groups the shared PC pieces into media and day columns and omits totals, picks and memo cards', async () => {
    server.upcoming = {version:1, entries:[upcomingEntry], wishlist:[upcomingEntry]};
    render(<Home {...props({captures:[item('pending')]})}/>);
    const today = await screen.findByRole('region', {name:'오늘 할 것'});
    await waitFor(()=>expect(within(today).getAllByRole('button').map(b => b.textContent)).toEqual(['□미분류 에셋7', '□유사 이미지 검토6쌍', '□처리 대기1', '□중복 판본2', '○Todo남은 항목 1개1']));
    expect(document.querySelector('.home-tablet-layout')).toBeTruthy();
    expect(document.querySelector('.home-tablet-day-column')?.querySelectorAll('section')).toHaveLength(2);
    expect(document.querySelector('.home-tablet-media-column')?.querySelectorAll('section')).toHaveLength(1);
    await screen.findByRole('region', {name:/^2주 안에 발매/});
    const regions = screen.getAllByRole('region').map(r => r.getAttribute('aria-label'));
    expect(regions).toEqual(['오늘 할 것','1년 전 오늘','2주 안에 발매']);
    for (const name of ['자산 현황','AV 배우','작가','메모','검토','이어지는 시리즈']) expect(screen.queryByRole('region',{name})).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => ['/v1/home/av-pick','/v1/library/artists'].includes(path))).toBe(false);
  });
  it('omits today when every known attention source is empty', async () => {
    notes=[]; server.summary={...(server.summary as object),unclassified:0};
    const read=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path,...args)=> {
      if(path.startsWith('/v1/library/similarity/review')) return Promise.resolve({ready:true,counts:{open:0}});
      if(path.startsWith('/v1/mobile-catalog/duplicates')) return Promise.resolve({counts:{undecided:0}});
      return read(path,...args);
    });
    render(<Home {...props()}/>);
    await screen.findByRole('region', {name:'1년 전 오늘'}); expect(screen.queryByRole('region', {name:/오늘 할 것/})).toBeNull();
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
    const row=await screen.findByRole('button',{name:/Hades II/});
    expect(within(row).getByText('NEW')).toBeTruthy();
    expect(screen.queryByRole('button',{name:/Muted movie/})).toBeNull();
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
    if (interested) {
      const row = await screen.findByRole('button',{name:/Hades II/});
      expect(within(row).getByText('NEW')).toBeTruthy();
    } else expect(screen.queryByText('Hades II')).toBeNull();
  });
  it('routes the review and pinned task rows', async () => {
    const p = props({captures:[item('pending')]}); render(<Home {...p}/>);
    fireEvent.click(await screen.findByRole('button',{name:/미분류 에셋7/})); expect(p.onUnclassified).toHaveBeenCalled(); expect(p.onLibrary).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:/유사 이미지 검토6쌍/})); expect(p.onSimilarity).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:/처리 대기1/})); expect(p.onPending).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:/Todo남은 항목/})); expect(p.onNotes).toHaveBeenCalledWith('shop');
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
    const fresh = await screen.findByRole('region',{name:/^2주 안에 발매/});
    expect(within(fresh).getByText('NEW')).toBeTruthy();
    view.unmount(); const next = render(<Home {...p}/>);
    const card = await within(await screen.findByRole('region',{name:/^2주 안에 발매/})).findByRole('button',{name:/4권.*밤의 도서관/});
    expect(within(card).getByText('NEW')).toBeTruthy();
    fireEvent.click(card); expect(p.onWork).toHaveBeenCalledWith('night');
    await waitFor(() => expect(screen.queryByText('NEW')).toBeNull());
    next.unmount(); render(<Home {...p}/>);
    await screen.findByRole('region',{name:/^2주 안에 발매/});
    expect(screen.queryByText('NEW')).toBeNull();
  });
  it('keeps tasks and covers during refresh rather than showing placeholders', async () => {
    const p = props(); render(<Home {...p}/>);
    await screen.findByRole('button',{name:/Todo남은 항목/});
    const before = within(await screen.findByRole('region',{name:/^2주 안에 발매/})).getByRole('button',{name:/4권.*밤의 도서관/});
    const read = mocks.native.getMockImplementation()!;
    mocks.native.mockImplementation((op,...args) => op === 'notesState' ? new Promise(() => {}) : read(op,...args));
    fireEvent(window, new CustomEvent('lakomics-sync-signals',{detail:{notes:'changed'}}));
    expect(screen.getByRole('button',{name:/Todo남은 항목/})).toBeTruthy();
    expect(within(screen.getByRole('region',{name:/^2주 안에 발매/})).getByRole('button',{name:/4권.*밤의 도서관/})).toBe(before);
  });
  it('shows a connection problem only when a read fails and offers its owning screen', async () => {
    server.offline = true; const p = props(); render(<Home {...p}/>);
    const button = await screen.findByRole('button',{name:/서버연결 안 됨/});
    fireEvent.click(button); expect(p.onSettings).toHaveBeenCalled();
    expect(screen.queryByText('동기화됨')).toBeNull();
  });
  it('excludes releases past fourteen days and shows the anniversary empty state on a busy day', async () => {
    server.upcoming = {entries:[],wishlist:[{...upcomingEntry,date:'2026-10-10'}]};
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path,...args) => path.startsWith('/v1/library/revisit') ? Promise.resolve({bundles:[]}) : original(path,...args));
    render(<Home {...props()}/>);
    await screen.findByRole('region',{name:/^2주 안에 발매/});
    expect(screen.queryByText('Hades II')).toBeNull();
    expect(screen.getByText('1년 전 오늘 저장한 이미지가 없습니다')).toBeTruthy();
  });
});

it('shows owned game and movie releases since the last visit without a wishlist',async()=>{
  localStorage.setItem('lakomics.home.visit.v1:https://a.example',JSON.stringify({lastVisit:new Date(2026,8,23).toISOString(),pending:[],opened:[]}));
  server.upcoming={entries:[],wishlist:[]};
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path,...args)=>{
    if(path.startsWith('/v1/collections?')) {
      const type=new URL(path,'https://test').searchParams.get('type');
      return Promise.resolve({ready:true,revision:'r1',items:type==='manga'?works:[{id:type,name:`owned ${type}`,type,releaseDate:'2026-09-24'}],nextCursor:null});
    }
    return original(path,...args);
  });
  const p=props();render(<Home {...p}/>);
  for(const type of ['game','movie']) {
    const row=await screen.findByRole('button',{name:new RegExp(`owned ${type}`)});
    expect(within(row).getByText('NEW')).toBeTruthy();
    fireEvent.click(row);expect(p.onWork).toHaveBeenCalledWith(type);
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
  const card=await screen.findByRole('button',{name:/Hades II/});
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
  await screen.findByRole('button',{name:/밤의 도서관/});
  await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).lastVisit).not.toBe(previous));
});


it('holds the complete arrangement until a delayed cold revisit reply', async () => {
  const read = mocks.api.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/library/revisit?') ? new Promise(resolve => {finish = resolve;}) : read(path, ...args));
  render(<Home {...props()}/>);
  expect(screen.getByLabelText('홈').querySelector('[aria-busy=true]')).toBeTruthy(); await waitFor(() => expect(finish).toBeTypeOf('function')); expect(screen.queryByRole('button', {name: /Todo남은 항목/})).toBeNull();
  expect(screen.queryByRole('region', {name: /^2주 안에 발매/})).toBeNull();
  await act(async () => {finish(revisitReply);});
  expect(screen.getByRole('region', {name: '1년 전 오늘'}).querySelector('.home-revisit')).toBeTruthy();
  expect(await screen.findByRole('region', {name: /^2주 안에 발매/})).toBeTruthy();
});

it('restores the same-day revisit snapshot on the first render after a process-style cache reset', async () => {
  const first = render(<Home {...props()}/>);
  await screen.findByRole('region', {name: '1년 전 오늘'});
  first.unmount(); resetHomeSourceCache();
  const read = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/library/revisit?') ? new Promise(() => {}) : read(path, ...args));
  render(<Home {...props()}/>);
  expect(await screen.findByRole('region', {name: '1년 전 오늘'})).toBeTruthy();
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

it('uses the shared shelf only for playing games and watching movies and opens the work', async () => {
  const read = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => {
    if (path.startsWith('/v1/collections?')) {
      const type = new URL(path, 'https://test').searchParams.get('type');
      const items = type === 'manga' ? works : [
        {id: `${type}-active`, name: `active ${type}`, type, showcase: false, status: type === 'game' ? 'playing' : 'watching', ownedPlatform: 'PS5', myScore: 4.5},
        {id: `${type}-done`, name: `done ${type}`, type, showcase: false, status: 'done'},
      ];
      return Promise.resolve({ready: true, revision: 'r1', items, nextCursor: null});
    }
    return read(path, ...args);
  });
  const p = props(); render(<Home {...p} />);
  const shelf = await screen.findByRole('region', {name: '지금 하는 중'});
  expect(shelf.querySelectorAll('.collection-light-case')).toHaveLength(2);
  fireEvent.click(within(shelf).getByRole('button', {name: 'active game 열기'}));
  expect(p.onWork).toHaveBeenCalledWith('game-active');
  expect(within(shelf).queryByText('done game')).toBeNull();
  expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual(['오늘 할 것', '1년 전 오늘', '지금 하는 중', '2주 안에 발매']);
});

function quietDay() {
  notes = []; server.summary = {...(server.summary as object), unclassified: 0};
  const read = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => {
    if (path.startsWith('/v1/library/similarity/review')) return Promise.resolve({ready: true, counts: {open: 0}});
    if (path.startsWith('/v1/mobile-catalog/duplicates')) return Promise.resolve({counts: {undecided: 0}});
    if (path.startsWith('/v1/library/revisit')) return Promise.resolve({bundles: []});
    if (path.startsWith('/v1/albums/likes')) return Promise.resolve({albumId: 'likes', memberships: []});
    if (path.startsWith('/v1/albums/assets')) return Promise.resolve({items: [item('favorite', '2023-07-18T12:00:00Z')], hasMore: false, nextCursor: null});
    return read(path, ...args);
  });
  const nativeRead = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op, ...args) => op === 'albumTree' ? Promise.resolve({adopted: true, libraryId: 'library', epoch: 1, albums: []}) : nativeRead(op, ...args));
}

it('shows the whole daily favorite only on a quiet day and masks both copies', async () => {
  quietDay();
  render(<Home {...props()} />);
  const daily = await screen.findByRole('region', {name: '오늘의 한 장'});
  expect(within(daily).getByText('2023.7.18에 저장')).toBeTruthy();
  expect(screen.queryByRole('region', {name:/오늘 할 것/})).toBeNull();
  await waitFor(() => expect(daily.querySelectorAll('img')).toHaveLength(2));
  await act(async () => {localStorage.setItem(PRIVACY_MODE_KEY, '1'); window.dispatchEvent(new Event(PRIVACY_MODE_EVENT));});
  expect(daily.querySelectorAll('img')).toHaveLength(0);
});

it('keeps the old shelf and daily image while a pull refresh is pending', async () => {
  quietDay(); const p = props(); render(<Home {...p} />);
  const daily = await screen.findByRole('region', {name: '오늘의 한 장'});
  const card = screen.getByRole('button', {name:/4권.*밤의 도서관/});
  const read = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/albums/assets') || path.startsWith('/v1/collections?') ? new Promise(() => {}) : read(path, ...args));
  const home = screen.getByLabelText('홈');
  fireEvent.touchStart(home, {touches:[{clientX:0,clientY:0}]});
  fireEvent.touchMove(home, {touches:[{clientX:0,clientY:150}]}); fireEvent.touchEnd(home);
  expect(screen.getByRole('region', {name: '오늘의 한 장'})).toBe(daily);
  expect(screen.getByRole('button', {name:/4권.*밤의 도서관/})).toBe(card);
});

it('keeps the quiet-day slot as the anniversary empty state when album authority is unavailable', async () => {
  quietDay();
  const read = mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op, ...args) => op === 'albumTree' ? Promise.resolve({adopted: false}) : read(op, ...args));
  render(<Home {...props()} />);
  expect(await screen.findByText('1년 전 오늘 저장한 이미지가 없습니다')).toBeTruthy();
  expect(screen.queryByRole('region', {name: '오늘의 한 장'})).toBeNull();
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
  const card = await screen.findByRole('button', {name: /owned future/});
  expect(within(card).getByText('9.28 · 게임')).toBeTruthy();
  expect(within(card).getByText('D-3')).toBeTruthy();
  fireEvent.click(card); expect(p.onWork).toHaveBeenCalledWith('owned-game');
});

it('covers the first Home load on app start with the launch splash, leaves when Home is ready, and never returns', async () => {
  resetLaunchSplashForTests();
  const read = mocks.api.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/library/revisit?') ? new Promise(resolve => {finish = resolve;}) : read(path, ...args));
  const splash = render(<LaunchSplash elapsed={() => 0}/>);
  const first = render(<Home {...props()}/>);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.getByRole('status', {name: 'Lakomics 여는 중'}).hasAttribute('data-state')).toBe(false);
  expect(screen.getByLabelText('홈').querySelector('[aria-busy=true]')).toBeTruthy();
  await act(async () => {finish(revisitReply);});
  await waitFor(() => expect(document.querySelector('.launch-splash')).toBeNull());
  first.unmount(); resetHomeSourceCache();
  mocks.api.mockImplementation((path, ...args) => path.startsWith('/v1/library/revisit?') ? new Promise(() => undefined) : read(path, ...args));
  render(<Home {...props()}/>);
  expect(screen.getByLabelText('홈').querySelector('[aria-busy=true]')).toBeTruthy();
  expect(document.querySelector('.launch-splash')).toBeNull();
  splash.unmount();
});
