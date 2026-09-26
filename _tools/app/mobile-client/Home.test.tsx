import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {ExchangeSnapshot} from './exchange';
import {folderBreadcrumb, readRecentFolders, RECENT_FOLDERS_KEY, rememberFolder} from './homeModel';
import type {Asset, Classification} from './types';

const mocks = vi.hoisted(() => ({api:vi.fn(),native:vi.fn(),loadThumbnail:vi.fn()}));
vi.mock('./transport',async() => {
  const actual = await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api,native:mocks.native};
});
vi.mock('./media',() => ({loadThumbnail:mocks.loadThumbnail,mediaTicket:vi.fn()}));
import {ApiError} from './transport';
import {Home, type HomeProps} from './Home';
import {HOME_SNAPSHOT_KEY, releaseRows, sendingSummary, upcomingReleases} from './homeDashboard';
import {releaseStore, resetReleaseStore} from './releaseStore';

const folders:Classification[] = Array.from({length:3},(_,index) => ({id:`folder-${index}`,name:`분류 ${index}`,parent_id:index === 1 ? 'folder-0' : null,asset_count:index + 1}));
const kakao = (volumes:[number,string|null,'upcoming'|'released'|null][]) => ({editionIndex:0,checkedAt:null,volumes:volumes.map(([volumeNumber,date,status]) => ({volumeNumber,date,status}))});
const works:CollectionSummary[] = [
  {id:'night',name:'밤의 도서관',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:3}],releaseSchedule:{kakao:kakao([[3,'2026-01-10','released'],[4,'2026-09-16','released'],[5,'2026-10-08',null]]),mangadex:null}},
  {id:'sea',name:'바다의 시간',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:1}],releaseSchedule:{kakao:kakao([[2,'2026-10-15','upcoming']]),mangadex:null}},
  {id:'quiet',name:'조용한 숲',type:'manga',showcase:false,releaseWatch:{enabled:false,available:true},ownedVolumes:[],releaseSchedule:{kakao:kakao([[1,'2026-10-01','upcoming']]),mangadex:null}},
];
type Server = {offline:boolean;publication:string;pendingReview:number;similar:number;duplicates:number;unread:Record<string,number>};
let server:Server;
const shelfReads = () => mocks.api.mock.calls.filter(([path]) => String(path).startsWith('/v1/collections?')).length;
const exchange = (unseen:number,sending=false):ExchangeSnapshot => ({configured:true,tokenConfigured:true,receiveSupported:true,deviceId:'tablet',deviceName:'태블릿',code:'',
  devices:[{deviceId:'pc',name:'작업실 PC',kind:'pc',lastSeenAt:new Date(Date.now() - 3 * 60_000).toISOString()}],incoming:[],unseen,
  outgoing:sending ? [{transferId:'t1',batchId:'b1',fileName:'스케치.zip',sizeBytes:100,bytes:62,peer:'pc',peerId:'pc',state:'uploading',code:'',createdAt:'2026-09-25T10:00:00Z'}] : []});
const items:Asset[] = Array.from({length:5},(_,index) => ({id:`recent-${index}`,kind:'image',creator_name:`작가 ${index}`,width:100,height:100 + index * 40,collected_at:new Date(2026,8,25,11,0).toISOString()}));
const props = (overrides:Partial<HomeProps> = {}):HomeProps => ({items,classifications:folders,recentFolders:[],captures:[],busy:false,paused:false,secondaryError:'',scope:'https://a.example',exchange:exchange(0),
  review:{enabled:true,refreshKey:0},similarityKey:0,
  onSelect:vi.fn(),onOpen:vi.fn(),onPending:vi.fn(),onReview:vi.fn(),onSimilarity:vi.fn(),onDuplicates:vi.fn(),onExchange:vi.fn(),onReleases:vi.fn(),onWork:vi.fn(),onSettings:vi.fn(),...overrides});

beforeEach(() => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date(2026,8,25,14,32));
  localStorage.clear(); resetReleaseStore();
  mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  mocks.loadThumbnail.mockImplementation(async (asset:Asset) => ({...asset,preview:`blob:${asset.id}`}));
  mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});
  server = {offline:false,publication:'r1',pendingReview:14,similar:6,duplicates:2,unread:{night:2}};
  mocks.api.mockImplementation(async (path:string) => {
    if (server.offline) throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);
    if (path.startsWith('/v1/library/characters/review')) return {ready:true,counts:{total:server.pendingReview}};
    if (path.startsWith('/v1/library/similarity/review')) return {ready:true,counts:{open:server.similar}};
    if (path.startsWith('/v1/mobile-catalog/duplicates')) return {counts:{undecided:server.duplicates}};
    if (path.startsWith('/v1/collections/releases')) return {version:1,revision:1,counts:{unread:Object.values(server.unread).reduce((a,b) => a+b,0),collections:Object.entries(server.unread).map(([collectionId,unread]) => ({collectionId,unread}))},items:[],nextCursor:null,hasMore:false};
    if (path === '/v1/collections/status') return {revision:server.publication};
    if (path.startsWith('/v1/collections?')) return {ready:true,filterVersion:1,revision:server.publication,items:works,nextCursor:null};
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {cleanup(); vi.useRealTimers();});

describe('home model',() => {
  it('resolves ID breadcrumbs without looping through malformed ancestry',() => {
    expect(folderBreadcrumb(folders[1],folders)).toBe('분류 0 / 분류 1');
    const cycle = [{...folders[0],parent_id:'folder-1'},folders[1]];
    expect(folderBreadcrumb(cycle[0],cycle)).toBe('분류 1 / 분류 0');
  });
  it('scopes recent IDs to connection and bounds and deduplicates visits',() => {
    localStorage.setItem(RECENT_FOLDERS_KEY,JSON.stringify({scope:'one',ids:['folder-1']}));
    expect(readRecentFolders('two')).toEqual([]);
    expect(readRecentFolders('one')).toEqual(['folder-1']);
    expect(rememberFolder(['folder-1','folder-2'],'folder-2')).toEqual(['folder-2','folder-1']);
    expect(rememberFolder(Array.from({length:8},(_,i) => `f${i}`),'new')).toHaveLength(6);
  });
  it('lists unread works from the shelf and dated upcoming volumes of watched manga, soonest first',() => {
    const shelf = {works,revision:'r1',ready:true};
    expect(releaseRows(shelf,{unread:3,byCollection:{night:2,gone:1}},'2026-09-25')).toEqual([{id:'night',name:'밤의 도서관',unread:2,caption:{kind:'new',text:'신간 4권',date:'9.16'}}]);
    expect(upcomingReleases(shelf,'2026-09-25')).toEqual([{id:'night',name:'밤의 도서관',date:'2026-10-08',volumeNumber:5},{id:'sea',name:'바다의 시간',date:'2026-10-15',volumeNumber:2}]);
    expect(sendingSummary(exchange(0,true))).toEqual({name:'스케치.zip',more:0,peer:'작업실 PC',progress:.62});
    expect(sendingSummary(exchange(0))).toBeNull();
  });
});

describe('Home',() => {
  it('shows a tile per waiting count, the 보내는 중 strip, and opens each screen',async() => {
    const input = props({captures:Array.from({length:40},(_,i) => ({id:`c${i}`,kind:'image'})),exchange:exchange(3,true)});
    render(<Home {...input}/>);
    const todo = screen.getByRole('region',{name:'할 일'});
    await within(todo).findByRole('button',{name:'캐릭터 14건'});
    await within(todo).findByRole('button',{name:'신간 1편'});
    fireEvent.click(within(todo).getByRole('button',{name:'처리 대기 40+건'})); expect(input.onPending).toHaveBeenCalled();
    fireEvent.click(within(todo).getByRole('button',{name:'캐릭터 14건'})); expect(input.onReview).toHaveBeenCalled();
    fireEvent.click(await within(todo).findByRole('button',{name:'유사 6쌍'})); expect(input.onSimilarity).toHaveBeenCalled();
    fireEvent.click(await within(todo).findByRole('button',{name:'중복 판본 2건'})); expect(input.onDuplicates).toHaveBeenCalled();
    fireEvent.click(within(todo).getByRole('button',{name:'받은 파일 3개'})); expect(input.onExchange).toHaveBeenCalledTimes(1);
    fireEvent.click(within(todo).getByRole('button',{name:'신간 1편'})); expect(input.onReleases).toHaveBeenCalled();
    fireEvent.click(within(todo).getByRole('button',{name:/보내는 중 스케치.zip → 작업실 PC/})); expect(input.onExchange).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('확인할 것 없음')).toBeNull();
    // 신간 and 발매 예정 open the work; the connection card opens settings.
    const releases = await screen.findByRole('region',{name:'신간'});
    fireEvent.click(within(releases).getByRole('button',{name:/밤의 도서관/})); expect(input.onWork).toHaveBeenLastCalledWith('night');
    const upcoming = screen.getByRole('region',{name:'발매 예정'});
    expect(within(upcoming).getAllByRole('button').map(row => row.textContent)).toEqual(['신간 화면','10.8목요일밤의 도서관5권 예약','10.15목요일바다의 시간2권 예약']);
    fireEvent.click(within(upcoming).getByRole('button',{name:/바다의 시간/})); expect(input.onWork).toHaveBeenLastCalledWith('sea');
    fireEvent.click(screen.getByRole('button',{name:'연결 및 설정'})); expect(input.onSettings).toHaveBeenCalled();
    expect(screen.getByText(/작업실 PC ·/).textContent).toContain('3분 전');
  });

  it('collapses to one line when nothing waits: 확인할 것 없음, 신간 0, the next release',async() => {
    Object.assign(server,{pendingReview:0,similar:0,duplicates:0,unread:{}});
    const input = props();
    render(<Home {...input}/>);
    const todo = screen.getByRole('region',{name:'할 일'});
    expect(within(todo).getByText('확인하는 중…')).toBeTruthy();
    await within(todo).findByText('확인할 것 없음');
    expect(within(todo).getByText('처리 대기 · 캐릭터 · 유사 · 중복 판본 · 받은 파일 모두 0')).toBeTruthy();
    await within(todo).findByRole('button',{name:'신간 0편'});
    fireEvent.click(await within(todo).findByRole('button',{name:'다음 발매 10.8, 밤의 도서관 5권'}));
    expect(input.onWork).toHaveBeenCalledWith('night');
    expect(screen.queryByRole('region',{name:'신간'})).toBeNull();
  });

  it('opens recent saves in the viewer by their list index and the full list from 전체 보기',() => {
    const input = props();
    render(<Home {...input}/>);
    const feed = screen.getByRole('region',{name:'최근 저장'});
    expect(within(feed).getByText('오늘')).toBeTruthy();
    fireEvent.click(within(feed).getByRole('button',{name:'작가 0, 11:00'})); expect(input.onOpen).toHaveBeenLastCalledWith(0);
    fireEvent.click(within(feed).getByRole('button',{name:'작가 3, 11:00'})); expect(input.onOpen).toHaveBeenLastCalledWith(3);
    fireEvent.click(within(feed).getByRole('button',{name:'전체 보기'}));
    expect(input.onSelect).toHaveBeenLastCalledWith({tab:'library',title:'최근 저장'});
  });

  it('does not read the manga shelf again on reopening Home, only after the publication moved',async() => {
    const first = render(<Home {...props()}/>);
    await screen.findByRole('region',{name:'신간'});
    expect(shelfReads()).toBe(1);
    first.unmount();
    render(<Home {...props()}/>);
    await screen.findByRole('region',{name:'신간'});
    await waitFor(() => expect(mocks.api.mock.calls.filter(([path]) => path === '/v1/collections/status')).toHaveLength(2));
    expect(shelfReads()).toBe(1);
    // A newer publication makes the kept shelf stale: the next visit reads it once more.
    cleanup();
    server.publication = 'r2';
    render(<Home {...props()}/>);
    await waitFor(() => expect(shelfReads()).toBe(2));
    expect(releaseStore.current.shelf?.revision).toBe('r2');
  });

  it('shares the shelf read with the 신간 screen store instead of reading it twice',async() => {
    render(<Home {...props()}/>);
    await screen.findByRole('region',{name:'신간'});
    expect(releaseStore.current.shelf?.works).toHaveLength(3);
    expect(releaseStore.current.loaded).toBe(false);
  });

  it('offline: greys the numbers, keeps the last known values with their time, and shows a notice',async() => {
    const first = render(<Home {...props({captures:[{id:'c',kind:'image'}]})}/>);
    await screen.findByRole('region',{name:'신간'});
    await waitFor(() => expect(JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY)!).counts.duplicates.value).toBe(2));
    first.unmount(); resetReleaseStore();
    vi.setSystemTime(new Date(2026,8,25,15,10));
    server.offline = true;
    render(<Home {...props({captures:null})}/>);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('오프라인 · 14:32 기준');
    const todo = screen.getByRole('region',{name:'할 일'});
    expect(todo.className).toContain('is-stale');
    expect(within(todo).getByRole('button',{name:'처리 대기 1건'})).toBeTruthy();
    expect(within(todo).getByRole('button',{name:'캐릭터 14건'})).toBeTruthy();
    const releases = screen.getByRole('region',{name:'신간'});
    expect(within(releases).getByText('14:32 기준')).toBeTruthy();
    expect(within(screen.getByRole('region',{name:'발매 예정'})).getByText('밤의 도서관')).toBeTruthy();
    expect(screen.getByRole('button',{name:'연결 및 설정'}).textContent).toContain('오프라인');
  });

  it('ignores a snapshot written for another connection',() => {
    localStorage.setItem(HOME_SNAPSHOT_KEY,JSON.stringify({scope:'https://other.example',counts:{pending:{value:9,at:0}}}));
    server.offline = true;
    render(<Home {...props({captures:null})}/>);
    expect(screen.queryByRole('button',{name:'처리 대기 9건'})).toBeNull();
  });
});
