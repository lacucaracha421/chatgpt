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
import {addedToday, characterTagging, daysAfter, HOME_SNAPSHOT_KEY, memoRows, releaseRows, sendingSummary, upcomingReleases} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {Note} from '../src/notes/store';
import {releaseStore, resetReleaseStore} from './releaseStore';

const folders:Classification[] = Array.from({length:3},(_,index) => ({id:`folder-${index}`,name:`분류 ${index}`,parent_id:index === 1 ? 'folder-0' : null,asset_count:index + 1}));
const kakao = (volumes:[number,string|null,'upcoming'|'released'|null][]) => ({editionIndex:0,checkedAt:null,volumes:volumes.map(([volumeNumber,date,status]) => ({volumeNumber,date,status}))});
const works:CollectionSummary[] = [
  {id:'night',name:'밤의 도서관',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:3}],releaseSchedule:{kakao:kakao([[3,'2026-01-10','released'],[4,'2026-09-16','released'],[5,'2026-10-08',null]]),mangadex:null}},
  {id:'sea',name:'바다의 시간',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:1}],releaseSchedule:{kakao:kakao([[2,'2026-10-15','upcoming']]),mangadex:null}},
  {id:'quiet',name:'조용한 숲',type:'manga',showcase:false,releaseWatch:{enabled:false,available:true},ownedVolumes:[],releaseSchedule:{kakao:kakao([[1,'2026-10-01','upcoming']]),mangadex:null}},
];
type Server = {offline:boolean;publication:string;pendingReview:number;similar:number;duplicates:number;unread:Record<string,number>;catalog:unknown;summary:unknown};
let server:Server;
const shelfReads = () => mocks.api.mock.calls.filter(([path]) => String(path).startsWith('/v1/collections?')).length;
const exchange = (unseen:number,sending=false):ExchangeSnapshot => ({configured:true,tokenConfigured:true,receiveSupported:true,deviceId:'tablet',deviceName:'태블릿',code:'',
  devices:[{deviceId:'pc',name:'작업실 PC',kind:'pc',lastSeenAt:new Date(Date.now() - 3 * 60_000).toISOString()}],incoming:[],unseen,
  outgoing:sending ? [{transferId:'t1',batchId:'b1',fileName:'스케치.zip',sizeBytes:100,bytes:62,peer:'pc',peerId:'pc',state:'uploading',code:'',createdAt:'2026-09-25T10:00:00Z'}] : []});
const items:Asset[] = Array.from({length:5},(_,index) => ({id:`recent-${index}`,kind:'image',creator_name:`작가 ${index}`,width:100,height:100 + index * 40,collected_at:new Date(2026,8,25,11,0).toISOString()}));
const props = (overrides:Partial<HomeProps> = {}):HomeProps => ({items,hasMore:false,captures:[],busy:false,paused:false,secondaryError:'',scope:'https://a.example',exchange:exchange(0),characters:null,
  review:{enabled:true,refreshKey:0},similarityKey:0,
  onPending:vi.fn(),onReview:vi.fn(),onSimilarity:vi.fn(),onDuplicates:vi.fn(),onExchange:vi.fn(),onReleases:vi.fn(),onWork:vi.fn(),onSettings:vi.fn(),
  onRecent:vi.fn(),onLibrary:vi.fn(),onNotes:vi.fn(),onRefresh:vi.fn(),...overrides});
const note = (id:string,values:Partial<Note>):Note => ({id,title:'',body:'',pinned:true,deleted:false,createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',localRevision:1,pending:false,conflict:false,...values});
const summaryReply = (values:Record<string,number> = {}) => ({total:1500,addedToday:12,addedThisWeek:80,unclassified:7,todayStart:'2026-09-24T15:00:00Z',weekStart:'2026-09-20T15:00:00Z',listGeneration:'a'.repeat(64),...values});
const month = '2026-09';
let notes:Note[];
const pinnedNotes = ():Note[] => [
  note('shop',{type:'checklist',title:'장보기',color:'green',updatedAt:'2026-09-25T08:00:00Z',items:[{id:'i1',text:'우유',checked:true,order:'a'},{id:'i2',text:'계란',checked:false,order:'b'},{id:'i3',text:'두부',checked:true,order:'c'}]}),
  note('ledger',{type:'ledger',title:'가계부',updatedAt:'2026-09-20T08:00:00Z',income:1000000,recurring:[],planned:[]}),
  note('month',{type:'ledger-month',title:'가계부 9월',pinned:false,archived:true,ledger:'ledger',month,income:null,entries:[{id:'e1',date:'2026-09-10',amount:250000,name:'마트',createdAt:'2026-09-10T00:00:00Z'}]}),
  note('memo',{title:'서버 이사 메모',updatedAt:'2026-09-18T08:00:00Z',body:'# 할 일\n- VPS 스냅샷 확인\n- R2 주소'}),
  note('secret',{type:'secret',title:'계정',updatedAt:'2026-09-17T08:00:00Z',redacted:true}),
  note('old',{title:'고정 안 함',pinned:false}),
  note('gone',{title:'지운 메모',deleted:true}),
];
const characterIndex = (all:number,left:number):CharacterIndex => ({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision:'r',publishedAt:null,
  nodes:[{id:'series:a',kind:'series',sourceId:'a',seriesId:'a',parentId:null,name:'A',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],
  scopes:[{nodeId:'series:a',filter:'all',totalCount:all,sourceCount:all},{nodeId:'series:a',filter:'unclassified',totalCount:left,sourceCount:left}]});

beforeEach(() => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date(2026,8,25,14,32));
  localStorage.clear(); resetReleaseStore();
  mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  mocks.loadThumbnail.mockImplementation(async (asset:Asset) => ({...asset,preview:`blob:${asset.id}`}));
  notes = pinnedNotes();
  mocks.native.mockImplementation(async (op:string) => op === 'notesState' ? {unlocked:true,notes,lastSyncedAt:null} : {url:'https://example.invalid/cover',expires_in:300});
  server = {offline:false,publication:'r1',pendingReview:14,similar:6,duplicates:2,unread:{night:2},catalog:null,summary:summaryReply()};
  mocks.api.mockImplementation(async (path:string) => {
    if (server.offline) throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);
    if (path.startsWith('/v1/library/characters/review')) return {ready:true,counts:{total:server.pendingReview}};
    if (path.startsWith('/v1/library/similarity/review')) return {ready:true,counts:{open:server.similar}};
    if (path.startsWith('/v1/mobile-catalog/duplicates')) return {counts:{undecided:server.duplicates}};
    if (path.startsWith('/v1/collections/releases')) return {version:1,revision:1,counts:{unread:Object.values(server.unread).reduce((a,b) => a+b,0),collections:Object.entries(server.unread).map(([collectionId,unread]) => ({collectionId,unread}))},items:[],nextCursor:null,hasMore:false};
    if (path === '/v1/collections/status') return {revision:server.publication};
    if (path === '/v1/mobile-catalog/refresh') return {job:server.catalog};
    if (path.startsWith('/v1/library/summary?')) { if (server.summary === 404) throw new ApiError('없음',404,null); return server.summary; }
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
  it('counts 오늘 추가 from the first page and says N+ when the whole page is from today',() => {
    const now = new Date(2026,8,25,14,32);
    expect(addedToday(items,false,now)).toEqual({count:5,more:false});
    expect(addedToday(items,true,now)).toEqual({count:5,more:true});
    expect(addedToday([...items,{collected_at:new Date(2026,8,24,23,0).toISOString()}],true,now)).toEqual({count:5,more:false});
    expect(daysAfter('2026-10-08','2026-09-25')).toBe(13);
  });
  it('derives 캐릭터 자동 태그 from the series scopes, or nothing without them',() => {
    expect(characterTagging(characterIndex(200,50))).toEqual({done:.75,left:50});
    expect(characterTagging({...characterIndex(200,50),scopes:[]})).toBeNull();
    expect(characterTagging(null)).toBeNull();
  });
  it('lists pinned notes newest first as one line each; month notes, unpinned and deleted notes never show',() => {
    expect(memoRows(pinnedNotes(),'2026-09-25')).toEqual([
      {id:'shop',title:'장보기',color:expect.any(String),kind:'checklist',done:2,total:3},
      {id:'ledger',title:'가계부',color:null,kind:'ledger',month:9,label:'쓸 수 있는 돈',amount:750000},
      {id:'memo',title:'서버 이사 메모',color:null,kind:'text',snippet:'할 일 VPS 스냅샷 확인 R2 주소'},
      {id:'secret',title:'계정',color:null,kind:'secret'},
    ]);
  });
});

describe('Home',() => {
  const region = (name:string) => screen.getByRole('region',{name});

  it('busy: every card shows its rows and opens the right screen',async() => {
    const input = props({captures:Array.from({length:40},(_,i) => ({id:`c${i}`,kind:'image'})),exchange:exchange(3,true),characters:characterIndex(200,50)});
    render(<Home {...input}/>);
    // ① 확인할 것: one row per waiting count.
    const todo = region('확인할 것');
    fireEvent.click(await within(todo).findByRole('button',{name:'캐릭터 검토 14건'})); expect(input.onReview).toHaveBeenCalled();
    fireEvent.click(within(todo).getByRole('button',{name:'처리 대기 40+건'})); expect(input.onPending).toHaveBeenCalled();
    fireEvent.click(await within(todo).findByRole('button',{name:'유사 이미지 6쌍'})); expect(input.onSimilarity).toHaveBeenCalled();
    fireEvent.click(await within(todo).findByRole('button',{name:'중복 판본 2건'})); expect(input.onDuplicates).toHaveBeenCalled();
    // ② 신간: small covers only here.
    const news = region('신간');
    fireEvent.click(await within(news).findByRole('button',{name:/밤의 도서관/})); expect(input.onWork).toHaveBeenLastCalledWith('night');
    fireEvent.click(within(news).getAllByRole('button')[0]); expect(input.onReleases).toHaveBeenCalledTimes(1);
    // ③ 발매 예정: the next 30 days; 게임 · 영화 wait for data.
    const upcoming = region('발매 예정');
    await within(upcoming).findByText('바다의 시간');
    expect(within(upcoming).getByRole('button',{name:/게임/}).hasAttribute('disabled')).toBe(true);
    expect(within(upcoming).getByRole('button',{name:/영화/}).hasAttribute('disabled')).toBe(true);
    expect(within(upcoming).getByRole('button',{name:/밤의 도서관/}).textContent).toContain('13일 후');
    fireEvent.click(within(upcoming).getByRole('button',{name:/바다의 시간/})); expect(input.onWork).toHaveBeenLastCalledWith('sea');
    // ④ 전송
    const transfer = region('전송');
    fireEvent.click(within(transfer).getByRole('button',{name:'받은 파일 3개'})); expect(input.onExchange).toHaveBeenCalledTimes(1);
    expect(within(transfer).getByRole('button',{name:'보내는 중 스케치.zip → 작업실 PC'}).textContent).toContain('62');
    // ⑤ 자산 현황: counted, never shown as images.
    const assets = region('자산 현황');
    fireEvent.click(await within(assets).findByRole('button',{name:'오늘 추가 12장'})); expect(input.onRecent).toHaveBeenCalledTimes(1);
    fireEvent.click(within(assets).getByRole('button',{name:'이번 주 추가 80장'})); expect(input.onRecent).toHaveBeenCalledTimes(2);
    fireEvent.click(within(assets).getByRole('button',{name:'전체 1500장'})); expect(input.onRecent).toHaveBeenCalledTimes(3);
    fireEvent.click(within(assets).getByRole('button',{name:'분류 안 됨 7장'})); expect(input.onLibrary).toHaveBeenCalledTimes(1);
    fireEvent.click(within(assets).getByRole('button',{name:'캐릭터 자동 태그 75%'})); expect(input.onLibrary).toHaveBeenCalledTimes(2);
    expect(within(assets).getByRole('button',{name:'전체 1500장'}).textContent).toContain('1,500');
    expect(document.querySelector('[data-asset-id]')).toBeNull();
    // ⑥ 메모: pinned notes from the device store.
    const memo = region('메모');
    const rows = await within(memo).findAllByRole('button',{name:/장보기|가계부|서버 이사 메모/});
    expect(rows.map(row => row.textContent)).toEqual(['장보기2/3 완료','가계부9월 쓸 수 있는 돈 750,000원','서버 이사 메모할 일 VPS 스냅샷 확인 R2 주소']);
    fireEvent.click(rows[1]); expect(input.onNotes).toHaveBeenLastCalledWith('ledger');
    fireEvent.click(within(memo).getAllByRole('button')[0]); expect(input.onNotes).toHaveBeenLastCalledWith();
    // ⑧ 서버 상태: one line while all is well.
    const serverCard = region('서버 상태');
    expect(serverCard.className).toContain('is-calm');
    expect(serverCard.textContent).toContain('연결됨 · 작업실 PC · 3분 전');
    fireEvent.click(within(serverCard).getByRole('button')); expect(input.onSettings).toHaveBeenCalled();
    expect(screen.queryByRole('region',{name:'오늘의 AV 배우'})).toBeNull();
  });

  it('calm: cards with nothing to act on collapse to one line',async() => {
    Object.assign(server,{pendingReview:0,similar:0,duplicates:0,unread:{},summary:summaryReply({addedToday:0,addedThisWeek:41,unclassified:0})});
    notes = pinnedNotes().map(entry => ({...entry,pinned:false}));
    vi.setSystemTime(new Date(2026,7,1,9,0));
    render(<Home {...props({items:[]})}/>);
    const todo = region('확인할 것');
    expect(within(todo).getByText('확인하는 중…')).toBeTruthy();
    await within(todo).findByText('모두 확인함');
    await within(region('신간')).findByText(/새 신간 없음/);
    expect(region('신간').textContent).toContain('만화 2편 지켜보는 중');
    await within(region('발매 예정')).findByText(/30일 안에 없음 · 다음/);
    expect(region('전송').textContent).toContain('받은 파일 · 보낼 파일 없음');
    await waitFor(() => expect(region('자산 현황').textContent).toContain('이번 주 41장 · 오늘 0'));
    await within(region('메모')).findByText('고정한 메모 없음');
    for (const name of ['확인할 것','신간','발매 예정','전송','자산 현황','메모','서버 상태']) {
      expect(region(name).className).toContain('is-calm');
      expect(region(name).querySelector('.home-card-body')).toBeNull();
    }
  });

  it('falls back to counting the first page when the server has no library summary',async() => {
    server.summary = 404;
    const input = props({hasMore:true});
    render(<Home {...input}/>);
    const assets = region('자산 현황');
    await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => String(path).startsWith('/v1/library/summary?'))).toBe(true));
    expect(await within(assets).findByRole('button',{name:'오늘 추가 5+장'})).toBeTruthy();
    expect(within(assets).queryByRole('button',{name:/이번 주 추가/})).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a running catalog refresh on the one-line 서버 상태, and a failed one expanded',async() => {
    server.catalog = {id:'j',language:'korean',state:'running',pages:3,added:0,hasMore:true,error:null,publicationRevision:null};
    const first = render(<Home {...props()}/>);
    await within(region('서버 상태')).findByText('카탈로그 갱신 중 · 3쪽');
    first.unmount();
    server.catalog = {id:'j',language:'korean',state:'failed',pages:0,added:0,hasMore:false,error:'갱신하지 못했습니다.',publicationRevision:null};
    render(<Home {...props()}/>);
    await within(region('서버 상태')).findByText('갱신하지 못했습니다.');
    expect(region('서버 상태').className).toContain('is-alert');
  });

  it('does not read the manga shelf again on reopening Home, only after the publication moved',async() => {
    const first = render(<Home {...props()}/>);
    await within(region('신간')).findByRole('button',{name:/밤의 도서관/});
    expect(shelfReads()).toBe(1);
    first.unmount();
    render(<Home {...props()}/>);
    await within(region('신간')).findByRole('button',{name:/밤의 도서관/});
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
    await within(region('신간')).findByRole('button',{name:/밤의 도서관/});
    expect(releaseStore.current.shelf?.works).toHaveLength(3);
    expect(releaseStore.current.loaded).toBe(false);
  });

  it('offline: a notice with 다시 연결, the last values with their time, 메모 as usual',async() => {
    const first = render(<Home {...props({captures:[{id:'c',kind:'image'}]})}/>);
    await within(region('신간')).findByRole('button',{name:/밤의 도서관/});
    await waitFor(() => expect(JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY)!).counts.duplicates.value).toBe(2));
    first.unmount(); resetReleaseStore();
    vi.setSystemTime(new Date(2026,8,25,15,10));
    server.offline = true;
    const input = props({captures:null,exchange:exchange(0,true)});
    render(<Home {...input}/>);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('오프라인');
    expect(notice.textContent).toContain('14:32 기준으로 남겨 둔 값');
    const todo = region('확인할 것');
    expect(within(todo).getByText('14:32 기준')).toBeTruthy();
    expect(within(todo).getByRole('button',{name:'처리 대기 1건'})).toBeTruthy();
    expect(within(todo).getByRole('button',{name:'캐릭터 검토 14건'})).toBeTruthy();
    expect(within(region('신간')).getByText('14:32 기준')).toBeTruthy();
    expect(within(region('자산 현황')).getByText('14:32 기준')).toBeTruthy();
    expect(within(region('자산 현황')).getByRole('button',{name:'분류 안 됨 7장'})).toBeTruthy();
    expect(within(region('발매 예정')).getByText('밤의 도서관')).toBeTruthy();
    expect(within(region('전송')).getByRole('button',{name:'보내기 멈춤 1개'})).toBeTruthy();
    expect(region('서버 상태').className).toContain('is-alert');
    expect(region('서버 상태').textContent).toContain('연결 안 됨');
    await within(region('메모')).findByText('장보기');
    const reads = mocks.api.mock.calls.length;
    fireEvent.click(within(notice).getByRole('button',{name:'다시 연결'}));
    expect(input.onRefresh).toHaveBeenCalled();
    await waitFor(() => expect(mocks.api.mock.calls.length).toBeGreaterThan(reads));
  });

  it('ignores a snapshot written for another connection',() => {
    localStorage.setItem(HOME_SNAPSHOT_KEY,JSON.stringify({scope:'https://other.example',counts:{pending:{value:9,at:0}}}));
    server.offline = true;
    render(<Home {...props({captures:null})}/>);
    expect(screen.queryByRole('button',{name:'처리 대기 9건'})).toBeNull();
  });
});
