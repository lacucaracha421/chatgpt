import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {ExchangeSnapshot} from './exchange';
import type {Asset, Classification} from './types';
import type {Note} from '../src/notes/store';
import {ApiError} from './transport';
import {Home, type HomeProps} from './Home';
import {HomeTodoBadges} from './App';
import {addedToday, daysAfter, memoRows, releaseRows, shelfEntries, sendingSummary, upcomingReleases} from './homeDashboard';
import {setOutboxConnection} from './outboxConnection';
import {releaseStore, resetReleaseStore} from './releaseStore';
import {HOME_SNAPSHOT_KEY, HOME_UPCOMING_CACHE_KEY} from './homeDashboard';
import {resetHomeSourceCache} from './homeCache';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn(), loadThumbnail: vi.fn()}));
vi.mock('./transport', async () => { const actual = await vi.importActual<typeof import('./transport')>('./transport'); return {...actual, api: mocks.api, native: mocks.native}; });
vi.mock('./media', () => ({loadThumbnail: mocks.loadThumbnail, mediaTicket: vi.fn()}));

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
const pinnedNotes = (): Note[] => [note('shop', {type: 'checklist', title: 'Todo', items: [{id: '1', text: '우유', checked: true, order: 'a'}, {id: '2', text: '계란', checked: false, order: 'b'}, {id: '3', text: '두부', checked: true, order: 'c'}]}), note('ledger', {type: 'ledger', title: '가계부', income: 1000000, recurring: [], planned: []}), note('month', {type: 'ledger-month', pinned: false, archived: true, ledger: 'ledger', month: '2026-09', income: null, entries: [{id: 'e1', date: '2026-09-10', amount: 250000, name: '마트', createdAt: '2026-09-10T00:00:00Z'}]})];
const props = (overrides: Partial<HomeProps> = {}): HomeProps => ({items: [item('recent')], hasMore: false, captures: [], busy: false, paused: false, secondaryError: '', scope: 'https://a.example', exchange: exchange(), characters: null, review: {enabled: false, refreshKey: 0}, similarityKey: 0, onPending: vi.fn(), onReview: vi.fn(), onSimilarity: vi.fn(), onDuplicates: vi.fn(), onExchange: vi.fn(), onReleases: vi.fn(), onWork: vi.fn(), onSettings: vi.fn(), onRecent: vi.fn(), onLibrary: vi.fn(), onNotes: vi.fn(), onRefresh: vi.fn(), ...overrides});

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(new Date(2026, 8, 25, 14, 32));
  window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: false}}));
  localStorage.clear(); resetHomeSourceCache(); setOutboxConnection('https://a.example'); resetReleaseStore(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  notes = pinnedNotes(); server = {offline: false, summary: {total: 1500, addedToday: 12, addedThisWeek: 80, unclassified: 7}, upcoming: {version: 1, revision: 2, entries: [upcomingEntry], wishlist: [upcomingEntry], pending: []}, avPick: {version: 1, pick: {personId: 'p1', name: '라라', workCount: 12, cover: null, latestWork: {code: 'LW-1', title: '최근 작품', date: '2026-09-24'}}}, artists: {artists: [{id: 'ranzu', label: 'Ranzu', main: true, assetCount: 38, coverAssetIds: ['r1']}]}};
  mocks.loadThumbnail.mockImplementation(async (asset: Asset) => ({...asset, preview: `blob:${asset.id}`}));
  mocks.native.mockImplementation(async (op: string) => op === 'notesState' ? {unlocked: true, notes, lastSyncedAt: null} : op === 'exchangeThumbnail' ? {url: 'blob:received'} : {url: 'https://example.invalid/cover', expires_in: 300});
  mocks.api.mockImplementation(async (path: string, _signal?: AbortSignal, body?: unknown, method?: string) => {
    if (server.offline) throw new ApiError('offline', null, null);
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

describe('home model', () => {
  it('keeps release, transfer and memo calculations bounded to existing sources', () => {
    const shelf = {works, revision: 'r1', ready: true};
    expect(releaseRows(shelf, {unread: 2, byCollection: {night: 2, missing: 1}}, '2026-09-25')).toHaveLength(1);
    expect(upcomingReleases(shelf, '2026-09-25')).toEqual([{id: 'night', name: '밤의 도서관', date: '2026-10-08', volumeNumber: 5}, {id: 'sea', name: '바다의 시간', date: '2026-10-15', volumeNumber: 2}]);
    expect(sendingSummary(exchange(true))).toMatchObject({name: '스케치.zip', progress: .62});
    expect(daysAfter('2026-10-08', '2026-09-25')).toBe(13);
  });
  it('shows the five checklist lines and falls back to latest ledger entries when categories are absent', () => {
    const rows = memoRows(pinnedNotes(), '2026-09-25');
    expect(rows[0]).toMatchObject({kind: 'checklist', done: 2, total: 3});
    expect((rows[0] as Extract<typeof rows[number], {kind: 'checklist'}>).items[0]).toEqual({text: '우유', checked: true});
    expect(rows[1]).toMatchObject({kind: 'ledger', amount: 250000, label: '쓴 돈', categories: [], latest: [{label: '마트', amount: 250000}]});
  });
  it('keeps shelf ordering and today counts deterministic', () => {
    const release = (id: string, date: string | null) => ({id, name: id, unread: 1, caption: {kind: 'new' as const, text: '신간 1권', date}});
    expect(shelfEntries([release('old', '9.16'), release('today', null)], [{id: 'soon', name: 'soon', date: '2026-09-30', volumeNumber: 8}], '2026-09-25').map(row => row.id)).toEqual(['today', 'old', 'soon']);
    expect(addedToday([item('a', '2026-09-25T01:00:00Z')], true, new Date(2026, 8, 25, 14))).toEqual({count: 1, more: true});
  });
});

describe('Home A', () => {
  const region = (name: string) => screen.getByRole('region', {name});
  const calls = (path: string) => mocks.api.mock.calls.filter(([request]) => request === path || (typeof request === 'string' && request.startsWith(path)));

  it('keeps Home sources across a tab return for one minute, then refreshes them', async () => {
    const first = render(<Home {...props()} />);
    await waitFor(() => {
      expect(calls('/v1/home/upcoming')).toHaveLength(1);
      expect(calls('/v1/home/av-pick')).toHaveLength(1);
      expect(calls('/v1/library/artists')).toHaveLength(1);
      expect(calls('/v1/library/revisit?')).toHaveLength(1);
      expect(calls('/v1/library/similarity/review')).toHaveLength(1);
    });
    first.unmount();
    render(<Home {...props()} />);
    await act(async () => { await Promise.resolve(); });
    expect(calls('/v1/home/upcoming')).toHaveLength(1);
    expect(calls('/v1/home/av-pick')).toHaveLength(1);
    expect(calls('/v1/library/artists')).toHaveLength(1);
    expect(calls('/v1/library/revisit?')).toHaveLength(1);
    expect(calls('/v1/library/similarity/review')).toHaveLength(1);
    cleanup();
    vi.setSystemTime(new Date(Date.now() + 60_001));
    render(<Home {...props()} />);
    await waitFor(() => {
      expect(calls('/v1/home/upcoming')).toHaveLength(2);
      expect(calls('/v1/home/av-pick')).toHaveLength(2);
      expect(calls('/v1/library/artists')).toHaveLength(2);
      expect(calls('/v1/library/revisit?')).toHaveLength(2);
      expect(calls('/v1/library/similarity/review')).toHaveLength(2);
    });
  });

  it('uses a moved sync signal to refresh only its affected Home source', async () => {
    render(<Home {...props()} />);
    await waitFor(() => expect(calls('/v1/home/upcoming')).toHaveLength(1));
    window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: true, signals: {upcoming: 'next'}}}));
    await waitFor(() => expect(calls('/v1/home/upcoming')).toHaveLength(2));
    expect(calls('/v1/library/artists')).toHaveLength(1);
    expect(calls('/v1/home/av-pick')).toHaveLength(1);
    expect(calls('/v1/library/revisit?')).toHaveLength(1);
  });

  it('pull to refresh forces a Home reload', async () => {
    const onRefresh = vi.fn();
    render(<Home {...props({onRefresh})} />);
    const scroll = screen.getByLabelText('홈');
    fireEvent.touchStart(scroll, {touches: [{clientX: 0, clientY: 0}]});
    fireEvent.touchMove(scroll, {touches: [{clientX: 0, clientY: 140}], cancelable: true});
    fireEvent.touchEnd(scroll);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps memo, shelf and AV placeholders stable while their reads are loading', () => {
    mocks.native.mockImplementation(async (op: string) => {
      if (op === 'notesState') return await new Promise<never>(() => {});
      return {url: 'https://example.invalid/cover', expires_in: 300};
    });
    render(<Home {...props()}/>);
    const memo = region('메모');
    expect(within(memo).queryByText('고정한 메모가 없습니다.')).toBeNull();
    expect(memo.querySelectorAll('.home-tall-memo.is-loading')).toHaveLength(2);
    expect(document.querySelectorAll('.home-release-block .home-shelf-item.is-loading')).toHaveLength(6);
    expect(document.querySelector('.home-today-block .home-av-card.is-loading')).toBeTruthy();
  });

  it('asks native for hashed Home covers when the Android bridge is available', async () => {
    const sha256 = 'a'.repeat(64);
    const hashed = {...upcomingEntry, cover: {sha256}};
    server.upcoming = {version: 1, revision: 2, entries: [hashed], wishlist: [hashed], pending: []};
    window.LakomicsNative = {request: vi.fn(), cancel: vi.fn()};
    render(<Home {...props()}/>);
    await screen.findByRole('button', {name: /Hades II/});
    await waitFor(() => expect(mocks.native).toHaveBeenCalledWith('homeCover', {sha256}, expect.any(AbortSignal)));
    expect(mocks.api.mock.calls.some(([path]) => path === `/v1/home/covers/${sha256}/media-ticket`)).toBe(false);
  });

  it('renders the scoped upcoming cache immediately and replaces it with the fresh reply', async () => {
    const cached = {...upcomingEntry, id: 'cached-game', title: 'Cached Game'};
    const fresh = {...upcomingEntry, id: 'fresh-game', title: 'Fresh Game'};
    localStorage.setItem(HOME_UPCOMING_CACHE_KEY, JSON.stringify([{scope: 'https://a.example', reply: {version: 1, entries: [cached], wishlist: [cached]}, at: 1}]));
    const original = mocks.api.getMockImplementation()!;
    let resolveFresh!: (value: unknown) => void;
    mocks.api.mockImplementation((path: string, signal?: AbortSignal, body?: unknown, method?: string) => path === '/v1/home/upcoming'
      ? new Promise(resolve => {resolveFresh = resolve;})
      : original(path, signal, body, method));
    render(<Home {...props()}/>);
    expect(screen.getByRole('button', {name: /Cached Game/})).toBeTruthy();
    await waitFor(() => expect(resolveFresh).toBeTypeOf('function'));
    await act(async () => {resolveFresh({version: 1, entries: [fresh], wishlist: [fresh]});});
    expect(await screen.findByRole('button', {name: /Fresh Game/})).toBeTruthy();
    expect(screen.queryByRole('button', {name: /Cached Game/})).toBeNull();
  });

  it('ignores an upcoming cache belonging to another server scope', () => {
    const other = {...upcomingEntry, id: 'other-game', title: 'Other Server Game'};
    localStorage.setItem(HOME_UPCOMING_CACHE_KEY, JSON.stringify([{scope: 'https://other.example', reply: {version: 1, entries: [other], wishlist: [other]}, at: 1}]));
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, signal?: AbortSignal, body?: unknown, method?: string) => path === '/v1/home/upcoming'
      ? new Promise(() => {})
      : original(path, signal, body, method));
    render(<Home {...props()}/>);
    expect(screen.queryByRole('button', {name: /Other Server Game/})).toBeNull();
  });

  it('renders the four A blocks without the removed labels and metrics', async () => {
    notes = [...pinnedNotes(), note('second', {type: 'text', title: '두 번째 메모', body: '두 번째 메모 내용', updatedAt: '2026-09-02T12:00:00Z'})];
    const input = props({captures: Array.from({length: 40}, (_, i) => item(`capture-${i}`)), exchange: exchange(true), onArtists: vi.fn()});
    render(<Home {...input}/>);
    expect(screen.queryByRole('region', {name: '전송'})).toBeNull();
    const memo = region('메모');
    await within(memo).findByRole('button', {name: /Todo/});
    expect(within(memo).getByRole('button', {name: /두 번째 메모/})).toBeTruthy();
    expect(memo.querySelector('.home-memo-grid')?.querySelectorAll('button')).toHaveLength(3);
    expect(screen.queryByRole('region', {name: '확인할 것'})).toBeNull();
    expect(screen.queryByRole('region', {name: '다시 보기'})).toBeNull();
    expect(screen.queryByRole('region', {name: '자산 현황'})).toBeNull();
    expect(await within(region('신간')).findByRole('button', {name: /Hades II/})).toBeTruthy();
    expect(document.querySelector('.home-shelf .home-kind')).toBeNull();
    expect(screen.queryByText('발매 예정')).toBeNull();
    expect(screen.queryByText('♥')).toBeNull();
    expect(screen.queryByText('♡')).toBeNull();
    expect(within(region('오늘')).queryByText('편 소장')).toBeNull();
    expect(within(region('오늘')).getByRole('button', {name: '1년 전 오늘'})).toBeTruthy();
    expect(within(region('기록')).getByText('오늘의 작가 · Ranzu')).toBeTruthy();
    expect(within(memo).getAllByText('250,000원')).toHaveLength(2);
    expect(within(memo).getByText('마트')).toBeTruthy();
    expect(within(region('메모')).getByRole('button', {name: '메모 전체'})).toBeTruthy();
    expect(within(region('신간')).getByRole('button', {name: '신간 전체'})).toBeTruthy();
    expect(within(region('오늘')).getByRole('button', {name: '오늘 전체'})).toBeTruthy();
    expect(within(region('기록')).getByRole('button', {name: '작가 전체'})).toBeTruthy();
  });
  it('uses two memo cards when only one non-ledger note is pinned', async () => {
    render(<Home {...props()}/>);
    const memo = await screen.findByRole('region', {name: '메모'});
    await within(memo).findByRole('button', {name: /Todo/});
    expect(memo.querySelector('.home-memo-grid')?.querySelectorAll('button')).toHaveLength(2);
    expect(within(memo).queryByRole('button', {name: /두 번째 메모/})).toBeNull();
  });
  it('keeps each minimal section arrow on its existing destination', async () => {
    const onNotes = vi.fn(), onReleases = vi.fn(), onRevisit = vi.fn(), onArtists = vi.fn();
    render(<Home {...props({onNotes, onReleases, onRevisit, onArtists})} />);
    await screen.findByRole('region', {name: '기록'});
    fireEvent.click(screen.getByRole('button', {name: '메모 전체'}));
    fireEvent.click(screen.getByRole('button', {name: '신간 전체'}));
    fireEvent.click(screen.getByRole('button', {name: '오늘 전체'}));
    fireEvent.click(screen.getByRole('button', {name: '작가 전체'}));
    expect(onNotes).toHaveBeenCalledTimes(1);
    expect(onReleases).toHaveBeenCalledTimes(1);
    expect(onRevisit).toHaveBeenCalledTimes(1);
    expect(onArtists).toHaveBeenCalledTimes(1);
  });
  it('masks hidden pinned memo content and uses platform badges for game shelf entries', async () => {
    const game = {...upcomingEntry, platforms: ['PC', 'PS5'], port: true};
    server.upcoming = {version: 1, revision: 2, entries: [game], wishlist: [game], pending: []};
    notes = [note('hidden', {type: 'text', title: '숨은 메모 제목', body: '홈에 보이면 안 되는 본문', concealed: true})];
    render(<Home {...props()}/>);

    const shelf = await screen.findByRole('region', {name: '신간'});
    const gameCard = within(shelf).getByRole('button', {name: /Hades II/});
    expect(within(gameCard).getByRole('img', {name: 'PC'})).toBeTruthy();
    expect(within(gameCard).getByRole('img', {name: 'PS5'})).toBeTruthy();
    expect(within(gameCard).getByText('이식')).toBeTruthy();

    const memoCard = within(region('메모')).getByRole('button', {name: /숨은 메모 제목/});
    expect(memoCard.textContent).toContain('숨긴 메모');
    expect(memoCard.textContent).not.toContain('홈에 보이면 안 되는 본문');
  });
  it('handles an empty or 404 upcoming publication without dropping manga', async () => {
    server.upcoming = 404;
    render(<Home {...props()}/>);
    const shelf = await screen.findByRole('region', {name: '신간'});
    expect(within(shelf).getAllByRole('button', {name: /밤의 도서관/})).toHaveLength(2);
    expect(within(shelf).queryByRole('button', {name: /Hades II/})).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows only 관심 목록 titles and posts an idempotent remove intent', async () => {
    render(<Home {...props()}/>);
    fireEvent.click(await screen.findByRole('button', {name: /Hades II/}));
    fireEvent.click(await screen.findByRole('button', {name: '관심 목록에서 빼기'}));
    await waitFor(() => expect(mocks.api.mock.calls.some(([path, , body]) => path === '/v1/home/upcoming/wishlist' && body)).toBe(true));
    const call = mocks.api.mock.calls.find(([path, , body]) => path === '/v1/home/upcoming/wishlist' && body);
    expect(call?.[2]).toMatchObject({version: 1, action: 'remove', itemId: 'game-1'});
    expect(typeof (call?.[2] as {operationId?: unknown}).operationId).toBe('string');
  });
  it('hides the AV card for privacy mode and for an unavailable pick', async () => {
    localStorage.setItem('lakomics.mobile.privacyMode', '1');
    render(<Home {...props()}/>);
    expect(screen.queryByText('오늘의 AV 배우')).toBeNull();
    expect(screen.queryByRole('region', {name: '확인할 것'})).toBeNull();
    cleanup(); localStorage.clear(); server.avPick = 404;
    render(<Home {...props()}/>);
    await waitFor(() => expect(screen.queryByText('오늘의 AV 배우')).toBeNull());
    expect(screen.queryByRole('region', {name: '확인할 것'})).toBeNull();
  });
  it('renders the four asset counters even when the summary is unavailable', async () => {
    server.summary = 404;
    render(<Home {...props({hasMore: true})}/>);
    expect(await within(region('기록')).findByRole('button', {name: '오늘 1+장'})).toBeTruthy();
    expect(within(region('기록')).getByRole('button', {name: '이번 주 —장'})).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY)!).summary).toBeUndefined();
  });
  it('opens the read-only artist hub from both Home A artist entries', async () => {
    const onArtists = vi.fn();
    render(<Home {...props({onArtists})} />);
    await screen.findByRole('button', {name: /오늘의 작가 · Ranzu/});
    fireEvent.click(screen.getByRole('button', {name: /오늘의 작가 · Ranzu/}));
    fireEvent.click(screen.getByRole('button', {name: '작가 전체'}));
    expect(onArtists).toHaveBeenCalledTimes(2);
  });

  it('shows only non-zero Home header badges and routes each one to its existing destination', () => {
    const onPending = vi.fn(), onSimilarity = vi.fn(), onDuplicates = vi.fn();
    const {rerender} = render(<HomeTodoBadges snapshot={{scope: 'https://a.example', pending: null, similar: 5, duplicates: 0}} pending={3} onPending={onPending} onSimilar={onSimilarity} onDuplicates={onDuplicates} />);
    expect(screen.getByRole('button', {name: '처리 대기 3'})).toBeTruthy();
    expect(screen.getByRole('button', {name: '유사 이미지 5'})).toBeTruthy();
    expect(screen.queryByRole('button', {name: /중복/})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '처리 대기 3'}));
    fireEvent.click(screen.getByRole('button', {name: '유사 이미지 5'}));
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onSimilarity).toHaveBeenCalledTimes(1);
    rerender(<HomeTodoBadges snapshot={{scope: 'https://a.example', pending: null, similar: null, duplicates: 0}} pending={null} onPending={onPending} onSimilar={onSimilarity} onDuplicates={onDuplicates} />);
    expect(screen.queryByRole('button', {name: /처리 대기|유사 이미지|중복/})).toBeNull();
  });

  it('reuses a decoded manga cover across a Home revisit within its cache window', async () => {
    const artworkWork = {...works[0], selectedWorkArtworkId: 'magic-cover', artworkVersions: {'magic-cover': {thumbnail: 'magic-digest'}}};
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path: string, signal?: AbortSignal, body?: unknown, method?: string) => {
      if (path.startsWith('/v1/collections?')) return {ready: true, revision: 'r1', items: [artworkWork], nextCursor: null};
      return original(path, signal, body, method);
    });
    const first = render(<Home {...props()} />);
    const artworkCalls = () => mocks.native.mock.calls.filter(([op, payload]) => op === 'collectionArtwork' && (payload as {artworkId?: string})?.artworkId === 'magic-cover');
    await waitFor(() => expect(artworkCalls()).toHaveLength(1));
    first.unmount();
    render(<Home {...props()} />);
    await act(async () => { await Promise.resolve(); });
    expect(artworkCalls()).toHaveLength(1);
  });

  it('omits Home entry animation classes when reduced motion is requested', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {configurable: true, value: vi.fn(() => ({matches: true, media: '(prefers-reduced-motion: reduce)', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()}))});
    try {
      const {container} = render(<Home {...props()} />);
      expect(container.querySelector('.home-enter-block')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', {configurable: true, value: original});
      else delete (window as Partial<Window>).matchMedia;
    }
  });
});
