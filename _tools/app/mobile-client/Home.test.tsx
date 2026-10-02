import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {ExchangeSnapshot} from './exchange';
import type {Asset} from './types';
import type {Note} from '../src/notes/store';
import {ApiError} from './transport';
import {Home, type HomeProps} from './Home';
import {setOutboxConnection} from './outboxConnection';
import {resetReleaseStore} from './releaseStore';
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
const pinnedNotes = (): Note[] => [note('shop', {type: 'checklist', title: 'Todo', items: [{id: '1', text: '**우유**', checked: true, order: 'a'}, {id: '2', text: '계란', checked: false, order: 'b'}, {id: '3', text: '두부', checked: true, order: 'c'}]}), note('ledger', {type: 'ledger', title: '가계부', income: 1000000, recurring: [], planned: []}), note('month', {type: 'ledger-month', pinned: false, archived: true, ledger: 'ledger', month: '2026-09', income: null, entries: [{id: 'e1', date: '2026-09-10', amount: 250000, name: '마트', createdAt: '2026-09-10T00:00:00Z'}]})];
const props = (overrides: Partial<HomeProps> = {}): HomeProps => ({items: [item('recent')], hasMore: false, captures: [], busy: false, paused: false, secondaryError: '', scope: 'https://a.example', exchange: exchange(), characters: null, review: {enabled: false, refreshKey: 0}, similarityKey: 0, onPending: vi.fn(), onReview: vi.fn(), onSimilarity: vi.fn(), onDuplicates: vi.fn(), onExchange: vi.fn(), onReleases: vi.fn(), onWork: vi.fn(), onSettings: vi.fn(), onRecent: vi.fn(), onLibrary: vi.fn(), onNotes: vi.fn(), onRefresh: vi.fn(), ...overrides});

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(new Date(2026, 8, 25, 14, 32));
  window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: false}}));
  localStorage.clear(); resetHomeSourceCache(); setOutboxConnection('https://a.example'); resetReleaseStore(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  notes = pinnedNotes(); server = {offline: false, summary: {total: 1500, images: 1200, videos: 300, collections: {game: 10, manga: 20, movie: 30, av: 40}, addedToday: 12, addedThisWeek: 80, unclassified: 7, todayStart: '2026-09-25T00:00:00Z', weekStart: '2026-09-22T00:00:00Z', listGeneration: 'a'.repeat(64)}, upcoming: {version: 1, revision: 2, entries: [upcomingEntry], wishlist: [upcomingEntry], pending: []}, avPick: {version: 1, pick: {personId: 'p1', name: '라라', workCount: 12, cover: null, latestWork: {code: 'LW-1', title: '최근 작품', date: '2026-09-24'}}}, artists: {artists: [{id: 'ranzu', label: 'Ranzu', main: true, assetCount: 38, coverAssetIds: ['r1']}]}};
  mocks.loadThumbnail.mockImplementation(async (asset: Asset) => ({...asset, preview: `blob:${asset.id}`}));
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
  it('stacks the PC pieces in order and omits totals, picks and memo cards', async () => {
    server.upcoming = {version:1, entries:[upcomingEntry], wishlist:[upcomingEntry]};
    render(<Home {...props({captures:[item('pending')]})}/>);
    const today = await screen.findByRole('region', {name:'오늘 할 것 · 5'});
    expect(within(today).getAllByRole('button').map(b => b.textContent)).toEqual(['□미분류 에셋7', '□유사 이미지 검토6쌍', '□처리 대기1', '□중복 판본2', '○Todo남은 항목 1개1']);
    expect(document.querySelector('.home-attention-layout')?.classList.contains('is-tablet')).toBe(true);
    await screen.findByRole('region', {name:'2주 안에 나오는 신간'});
    const regions = screen.getAllByRole('region').map(r => r.getAttribute('aria-label'));
    expect(regions.filter(n => n !== '1년 전 오늘')).toEqual(['오늘 할 것 · 5','새로 나옴 · 지난번 이후','2주 안에 나오는 신간','1년 전 오늘 · 2장']);
    for (const name of ['자산 현황','AV 배우','작가','메모','검토','이어지는 시리즈']) expect(screen.queryByRole('region',{name})).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => ['/v1/home/av-pick','/v1/library/artists'].includes(path))).toBe(false);
  });
  it('shows one quiet empty line when every known attention source is empty', async () => {
    notes=[]; server.summary={...(server.summary as object),unclassified:0};
    const read=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path,...args)=> {
      if(path.startsWith('/v1/library/similarity/review')) return Promise.resolve({ready:true,counts:{open:0}});
      if(path.startsWith('/v1/mobile-catalog/duplicates')) return Promise.resolve({counts:{undecided:0}});
      return read(path,...args);
    });
    render(<Home {...props()}/>);
    expect(await screen.findByText('오늘 할 것이 없습니다')).toBeTruthy();
  });
  it('uses cached calendar release dates since this device visit without a wishlist', async () => {
    localStorage.setItem('lakomics.home.visit.v1:https://a.example',JSON.stringify({lastVisit:new Date(2026,8,23).toISOString(),pending:[],opened:[]}));
    server.upcoming={entries:[{...upcomingEntry,date:'2026-09-24'}],wishlist:[]};
    render(<Home {...props()}/>);
    const row=await screen.findByRole('button',{name:/Hades II/});
    expect(within(row).getByText('NEW')).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByRole('dialog',{name:'Hades II'})).toBeTruthy();
    expect(mocks.api.mock.calls.some(([path])=>path.includes('detail'))).toBe(false);
  });
  it('routes the review and pinned task rows', async () => {
    const p = props({captures:[item('pending')]}); render(<Home {...p}/>);
    fireEvent.click(await screen.findByRole('button',{name:/미분류 에셋7/})); expect(p.onLibrary).toHaveBeenCalled();
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
    const fresh = await screen.findByRole('region',{name:'새로 나옴 · 지난번 이후'});
    expect(within(fresh).getByText('NEW')).toBeTruthy();
    view.unmount(); const next = render(<Home {...p}/>);
    const card = await within(await screen.findByRole('region',{name:'새로 나옴 · 지난번 이후'})).findByRole('button',{name:/밤의 도서관/});
    expect(within(card).getByText('NEW')).toBeTruthy();
    fireEvent.click(card); expect(p.onWork).toHaveBeenCalledWith('night');
    await waitFor(() => expect(screen.queryByRole('region',{name:'새로 나옴 · 지난번 이후'})).toBeNull());
    next.unmount(); render(<Home {...p}/>);
    await screen.findByRole('region',{name:'2주 안에 나오는 신간'});
    expect(screen.queryByText('NEW')).toBeNull();
  });
  it('keeps tasks and covers during refresh rather than showing placeholders', async () => {
    const p = props(); render(<Home {...p}/>);
    await screen.findByRole('button',{name:/Todo남은 항목/});
    const before = within(await screen.findByRole('region',{name:'새로 나옴 · 지난번 이후'})).getByRole('button',{name:/밤의 도서관/});
    const read = mocks.native.getMockImplementation()!;
    mocks.native.mockImplementation((op,...args) => op === 'notesState' ? new Promise(() => {}) : read(op,...args));
    fireEvent(window, new CustomEvent('lakomics-sync-signals',{detail:{notes:'changed'}}));
    expect(screen.getByRole('button',{name:/Todo남은 항목/})).toBeTruthy();
    expect(within(screen.getByRole('region',{name:'새로 나옴 · 지난번 이후'})).getByRole('button',{name:/밤의 도서관/})).toBe(before);
  });
  it('shows a connection problem only when a read fails and offers its owning screen', async () => {
    server.offline = true; const p = props(); render(<Home {...p}/>);
    const button = await screen.findByRole('button',{name:/서버연결 안 됨/});
    fireEvent.click(button); expect(p.onSettings).toHaveBeenCalled();
    expect(screen.queryByText('동기화됨')).toBeNull();
  });
  it('excludes releases past fourteen days and hides an empty revisit', async () => {
    server.upcoming = {entries:[],wishlist:[{...upcomingEntry,date:'2026-10-10'}]};
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path,...args) => path.startsWith('/v1/library/revisit') ? Promise.resolve({bundles:[]}) : original(path,...args));
    render(<Home {...props()}/>);
    await screen.findByRole('region',{name:'새로 나옴 · 지난번 이후'});
    expect(screen.queryByText('Hades II')).toBeNull();
    expect(screen.queryByRole('region',{name:/1년 전 오늘/})).toBeNull();
  });
});
