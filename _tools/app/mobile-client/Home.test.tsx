import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {ExchangeSnapshot} from './exchange';
import type {Asset, Classification} from './types';
import type {Note} from '../src/notes/store';
import {ApiError} from './transport';
import {Home, type HomeProps} from './Home';
import {addedToday, daysAfter, memoRows, releaseRows, shelfEntries, sendingSummary, upcomingReleases} from './homeDashboard';
import {setOutboxConnection} from './outboxConnection';
import {releaseStore, resetReleaseStore} from './releaseStore';
import {HOME_SNAPSHOT_KEY} from './homeDashboard';

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
  localStorage.clear(); setOutboxConnection('https://a.example'); resetReleaseStore(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
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
afterEach(() => {cleanup(); vi.useRealTimers(); setOutboxConnection(null);});

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

describe('Home C', () => {
  const region = (name: string) => screen.getByRole('region', {name});
  it('renders the C blocks, merges upcoming titles, and has no character review tile or tag metric', async () => {
    notes = [...pinnedNotes(), note('second', {type: 'text', title: '두 번째 메모', body: '두 번째 메모 내용', updatedAt: '2026-09-02T12:00:00Z'})];
    const input = props({captures: Array.from({length: 40}, (_, i) => item(`capture-${i}`)), exchange: exchange(true)});
    render(<Home {...input}/>);
    expect(screen.queryByRole('region', {name: '전송'})).toBeNull();
    const memo = region('메모');
    await within(memo).findByRole('button', {name: /Todo/});
    expect(within(memo).getByRole('button', {name: /두 번째 메모/})).toBeTruthy();
    expect(memo.querySelector('.home-memo-grid')?.querySelectorAll('button')).toHaveLength(3);
    expect(within(region('확인할 것')).queryByText('캐릭터 검토')).toBeNull();
    expect(within(region('자산 현황')).queryByText(/캐릭터 자동 태그/)).toBeNull();
    expect(await within(region('신간 · 발매 예정')).findByRole('button', {name: /Hades II/})).toBeTruthy();
    expect(within(memo).getAllByText('250,000원')).toHaveLength(2);
    expect(within(memo).getByText('마트')).toBeTruthy();
    expect(within(region('확인할 것')).getAllByRole('button')).toHaveLength(3);
  });
  it('uses two memo cards when only one non-ledger note is pinned', async () => {
    render(<Home {...props()}/>);
    const memo = await screen.findByRole('region', {name: '메모'});
    await within(memo).findByRole('button', {name: /Todo/});
    expect(memo.querySelector('.home-memo-grid')?.querySelectorAll('button')).toHaveLength(2);
    expect(within(memo).queryByRole('button', {name: /두 번째 메모/})).toBeNull();
  });
  it('masks hidden pinned memo content and uses platform badges for game shelf entries', async () => {
    const game = {...upcomingEntry, platforms: ['PC', 'PS5'], port: true};
    server.upcoming = {version: 1, revision: 2, entries: [game], wishlist: [game], pending: []};
    notes = [note('hidden', {type: 'text', title: '숨은 메모 제목', body: '홈에 보이면 안 되는 본문', concealed: true})];
    render(<Home {...props()}/>);

    const shelf = await screen.findByRole('region', {name: '신간 · 발매 예정'});
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
    const shelf = await screen.findByRole('region', {name: '신간 · 발매 예정'});
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
    expect(region('확인할 것').querySelector('.home-todo-cards')?.className).toBe('home-todo-cards');
    cleanup(); localStorage.clear(); server.avPick = 404;
    render(<Home {...props()}/>);
    await waitFor(() => expect(screen.queryByText('오늘의 AV 배우')).toBeNull());
    expect(region('확인할 것')).toBeTruthy();
  });
  it('renders the four asset counters even when the summary is unavailable', async () => {
    server.summary = 404;
    render(<Home {...props({hasMore: true})}/>);
    expect(await within(region('자산 현황')).findByRole('button', {name: '오늘 추가 1+장'})).toBeTruthy();
    expect(within(region('자산 현황')).getByRole('button', {name: '이번 주 —장'})).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY)!).summary).toBeUndefined();
  });
  it('opens the read-only artist hub from both Home C artist entries', async () => {
    const onArtists = vi.fn();
    render(<Home {...props({onArtists})} />);
    await screen.findByRole('button', {name: /오늘의 작가 · Ranzu/});
    fireEvent.click(screen.getByRole('button', {name: /오늘의 작가 · Ranzu/}));
    fireEvent.click(screen.getByRole('button', {name: '작가 전체'}));
    expect(onArtists).toHaveBeenCalledTimes(2);
  });
});
