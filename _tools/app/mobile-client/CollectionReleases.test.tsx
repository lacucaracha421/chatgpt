import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionDetail, CollectionPage, CollectionSummary, ReleaseSchedule} from './collectionModel';
import type {ReleaseEvent} from './collectionReleases';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api,native:mocks.native};
});
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {ApiError} from './transport';
import {Collections} from './Collections';
import {SCHEDULE_ABSENT_NOTE} from './CollectionReleases';
import {japanReleases, koreanReleases, koreanVolumeLine, releaseCounts, releaseLine} from './collectionReleases';

const LIBRARY='e'.repeat(32);
const KINDS=['new_volume','release_date_changed','release_status_changed'];
const kakao=(editionIndex:number,volumes:[number,string|null,'upcoming'|'released'|null][]):ReleaseSchedule['kakao']=>({editionIndex,checkedAt:'2026-09-25T00:00:00Z',volumes:volumes.map(([volumeNumber,date,status])=>({volumeNumber,date,status}))});
const mangadex=(latestVolume:number):ReleaseSchedule['mangadex']=>({checkedAt:null,latestVolume,volumes:Array.from({length:latestVolume},(_,i)=>({volumeNumber:i+1,editionIndex:null}))});
const initialWorks=():CollectionSummary[]=>[
  // 3 owned; 4 out, 5 pre-registered with a future date (no status), 6 announced without a date.
  {id:'night',name:'밤의 도서관',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:3}],
    releaseSchedule:{kakao:kakao(0,[[1,'2025-01-01','released'],[2,'2025-05-01','released'],[3,'2026-01-10','released'],[4,'2026-09-16','released'],[5,'2026-10-10',null],[6,null,'upcoming']]),mangadex:mangadex(9)}},
  // Never tracked: every Korean volume is unowned.
  {id:'sea',name:'바다의 시간',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[],
    releaseSchedule:{kakao:kakao(0,[[1,'2026-08-01','released'],[2,'2026-09-20','released']]),mangadex:null}},
  // 신간 알림 off: never listed, even with unowned volumes.
  {id:'quiet',name:'조용한 숲',type:'manga',showcase:false,releaseWatch:{enabled:false,available:true},ownedVolumes:[{editionIndex:0,count:0}],
    releaseSchedule:{kakao:kakao(0,[[1,'2026-09-01','released']]),mangadex:mangadex(3)}},
  // Everything Korean owned: only on the 일본 tab.
  {id:'full',name:'가득 찬 서가',type:'manga',showcase:false,releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:2}],
    releaseSchedule:{kakao:kakao(0,[[1,'2026-01-01','released'],[2,'2026-05-01','released']]),mangadex:mangadex(4)}},
];
let works:CollectionSummary[];
const event=(eventId:string,collectionId:string,provider:ReleaseEvent['provider'],kind:ReleaseEvent['kind'],volumeNumber:number,previousValue:string|null,currentValue:string|null):ReleaseEvent=>
  ({eventId,collectionId,collectionName:initialWorks().find(work=>work.id===collectionId)!.name,provider,kind,volumeNumber,previousValue,currentValue,detectedAt:'2026-09-25T10:00:00Z',read:false,readAt:null});
let events:ReleaseEvent[], offline:boolean, editsOffline:boolean;
const acks=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/releases/acknowledge').map(([, ,body])=>body as Record<string,unknown>);
const releaseReads=()=>mocks.api.mock.calls.map(([path])=>String(path)).filter(path=>path.startsWith('/v1/collections/releases?'));
const listReply=()=>{
  const counts:Record<string,number>={};
  for(const item of events)counts[item.collectionId]=(counts[item.collectionId]??0)+1;
  return {version:1,revision:1,generation:'g',publishedAt:null,counts:{unread:events.length,collections:Object.entries(counts).sort().map(([collectionId,unread])=>({collectionId,unread}))},items:events,nextCursor:null,hasMore:false};
};

beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2026,8,25,12));
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();offline=false;editsOffline=false;works=initialWorks();
  events=[
    event('e1','night','kakao','new_volume',5,null,'2026-10-10'),
    event('e2','sea','kakao','release_status_changed',2,'upcoming','released'),
    event('e3','full','mangadex','new_volume',4,null,null),
    event('e4','quiet','kakao','new_volume',2,null,'2026-10-01'),
  ];
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/status')return {revision:'r1',capabilities:{collectionPersonalEdit:true,collectionTrackingEdit:true},libraryId:LIBRARY};
    if(path==='/v1/collections/personal-edits'){if(editsOffline)throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);return {version:1,operationId:body!.operationId,changed:true};}
    if(path.startsWith('/v1/collections/releases?')){if(offline)throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);return listReply();}
    if(path==='/v1/collections/releases/acknowledge'){
      const ids=body!.eventIds as string[]|undefined;
      const hit=events.filter(item=>ids?ids.includes(item.eventId):item.collectionId===body!.collectionId&&(body!.kinds as string[]).includes(item.kind));
      events=events.filter(item=>!hit.includes(item));
      return {version:1,operationId:body!.operationId,acknowledged:hit.map(item=>item.eventId),alreadyRead:[],missing:[],revision:2,lastSequence:hit.length};
    }
    if(path.startsWith('/v1/collections?')){const type=new URLSearchParams(path.split('?')[1]).get('type');return {ready:true,filterVersion:1,revision:'r1',publishedAt:null,items:works.filter(work=>work.type===type),nextCursor:null} satisfies CollectionPage;}
    const id=path.split('/')[3];
    return {revision:'r1',item:{...works.find(work=>work.id===id)!,volumes:[],artworks:[]} satisfies CollectionDetail};
  });
  mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

const renderTab=(backRef:{current:(()=>boolean)|null}={current:null})=>render(<Collections active paused={false} backRef={backRef}/>);
const entry=()=>screen.findByRole('button',{name:/^신간 보기/});
const lines=(region:HTMLElement)=>within(region).queryAllByRole('listitem').map(row=>row.querySelector('span')!.textContent);
async function openReleases(backRef?:{current:(()=>boolean)|null}){
  renderTab(backRef);
  await waitFor(async()=>expect((await entry()).getAttribute('aria-label')).toBe('신간 보기, 새 알림 4개'));
  fireEvent.click(await entry());
  await screen.findByRole('region',{name:'밤의 도서관'});
}
const tab=(name:string)=>screen.getByRole('tab',{name});
const workOrder=()=>screen.getAllByRole('region').map(region=>region.getAttribute('aria-label')).filter(name=>name!=='컬렉션');

it('computes unowned Korean volumes, including a future pre-registered one, nearest date first',()=>{
  const today='2026-09-25';
  const owned=(work:CollectionSummary,edition:number)=>work.ownedVolumes?.find(entry=>entry.editionIndex===edition)?.count??null;
  const rows=koreanReleases(works.filter(work=>work.releaseWatch!.enabled),owned,events,today);
  expect(rows.map(row=>row.work.id)).toEqual(['night','sea']);
  expect(rows[0].owned).toBe(3);
  expect(rows[0].volumes.map(volume=>koreanVolumeLine(volume,today))).toEqual(['4권 · 9월 16일 발매됨','5권 · 10월 10일 발매 예정','6권 · 발매일 미정']);
  expect(rows[0].volumes.map(volume=>volume.fresh)).toEqual([false,true,false]);
  expect(rows[1].owned).toBeNull();
  expect(rows[1].volumes.map(volume=>koreanVolumeLine(volume,today))).toEqual(['1권 · 8월 1일 발매됨','2권 · 9월 20일 발매됨']);
  // One more owned volume drops it from the list at once.
  expect(koreanReleases(works.slice(0,1),()=>5,[],today)[0].volumes.map(volume=>volume.volumeNumber)).toEqual([6]);
  expect(koreanReleases(works.slice(0,1),()=>6,[],today)).toEqual([]);
  // A date decides against today, whatever the PC's older status says; status only fills in for no date.
  const stale={...works[0],releaseSchedule:{kakao:kakao(0,[[1,'2026-09-20','upcoming'],[2,'2026-10-01','released'],[3,null,'released']]),mangadex:null}};
  expect(koreanReleases([stale],()=>0,[],today)[0].volumes.map(volume=>koreanVolumeLine(volume,today))).toEqual(['1권 · 9월 20일 발매됨','2권 · 10월 1일 발매 예정','3권 · 발매됨']);
  // A binding with no rows yet lists nothing; duplicated MangaDex volume numbers (other editions) do not inflate anything.
  expect(koreanReleases([{...stale,releaseSchedule:{kakao:kakao(0,[]),mangadex:null}}],()=>null,[],today)).toEqual([]);
  const dup={...works[3],releaseSchedule:{kakao:kakao(0,[[1,'2026-01-01','released']]),mangadex:{checkedAt:null,latestVolume:null,volumes:[{volumeNumber:1,editionIndex:0},{volumeNumber:2,editionIndex:0},{volumeNumber:2,editionIndex:1}]}}};
  expect(japanReleases([dup],[]).map(row=>[row.latest,row.ahead,row.aheadVolumes.map(volume=>volume.volumeNumber)])).toEqual([[2,1,[2]]]);
  expect(koreanVolumeLine({volumeNumber:9,date:'2027-01-05',upcoming:true,released:false,fresh:false},today)).toBe('9권 · 2027년 1월 5일 발매 예정');
  const japan=japanReleases(works.filter(work=>work.releaseWatch!.enabled),events);
  expect(japan.map(row=>[row.work.id,row.latest,row.ahead])).toEqual([['full',4,2],['night',9,3]]);
  expect(japan[0].aheadVolumes).toEqual([{volumeNumber:3,fresh:false},{volumeNumber:4,fresh:true}]);
  expect(releaseLine(events[1])).toBe('2권 출간 예정 → 출간됨');
  expect(releaseCounts(listReply())).toEqual({unread:4,byCollection:{full:1,night:1,quiet:1,sea:1}});
});

it('always shows the 신간 entry, with a count only while something is unread',async()=>{
  events=[];
  renderTab();
  const button=await entry();
  await waitFor(()=>expect(releaseReads().length).toBeGreaterThan(0));
  expect(button.getAttribute('aria-label')).toBe('신간 보기');
  expect(button.querySelector('.collection-release-count')).toBeNull();
  // Status changes count too: every read names all three kinds.
  expect(releaseReads().every(path=>new URLSearchParams(path.split('?')[1]).get('kinds')===KINDS.join(','))).toBe(true);
  cleanup();
  events=[event('e2','sea','kakao','release_status_changed',2,'upcoming','released')];
  renderTab();
  await waitFor(async()=>expect((await entry()).querySelector('.collection-release-count')?.textContent).toBe('1'));
});

it('lists watched works with unowned Korean volumes and marks the new one',async()=>{
  await openReleases();
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('신간');
  expect(tab('한국 정발').getAttribute('aria-selected')).toBe('true');
  const night=screen.getByRole('region',{name:'밤의 도서관'});
  expect(within(night).getByText('3권까지 소장')).toBeTruthy();
  expect(lines(night)).toEqual(['4권 · 9월 16일 발매됨','5권 · 10월 10일 발매 예정','6권 · 발매일 미정']);
  expect(within(night).getAllByText('미보유')).toHaveLength(3);
  const fresh=within(night).getByText('5권 · 10월 10일 발매 예정').closest('li')!;
  expect(within(fresh).getByText('NEW')).toBeTruthy();
  expect(within(night).getByText('NEW 1')).toBeTruthy();
  const sea=screen.getByRole('region',{name:'바다의 시간'});
  expect(within(sea).getByText('소장 기록 없음')).toBeTruthy();
  expect(lines(sea)).toEqual(['1권 · 8월 1일 발매됨','2권 · 9월 20일 발매됨']);
  // Upcoming first, then the recently released; fully owned and watch-off works are not listed.
  expect(workOrder().slice(0,2)).toEqual(['밤의 도서관','바다의 시간']);
  expect(screen.queryByRole('region',{name:'가득 찬 서가'})).toBeNull();
  // The watch-off work's unread event still has a place, as a plain notification.
  const quiet=screen.getByRole('region',{name:'조용한 숲'});
  expect(within(quiet).queryByText('미보유')).toBeNull();
  expect(lines(quiet)).toEqual(['2권 새로 나옴 · 2026.10.1']);
});

it('shows how far the Japanese edition is ahead, newly found volumes marked',async()=>{
  await openReleases();
  expect(tab('일본').querySelector('.collection-release-count')!.textContent).toBe('1');
  expect(tab('한국 정발').querySelector('.collection-release-count')!.textContent).toBe('2');
  fireEvent.click(tab('일본'));
  const full=await screen.findByRole('region',{name:'가득 찬 서가'});
  expect(within(full).getByText('일본 최신 4권')).toBeTruthy();
  expect(within(full).getByText('한국 정발보다 2권 앞섬')).toBeTruthy();
  const chips=within(full).getByRole('list',{name:'가득 찬 서가 일본 권'});
  expect(within(chips).getAllByRole('listitem').map(chip=>chip.textContent)).toEqual(['3권','4권NEW']);
  const night=screen.getByRole('region',{name:'밤의 도서관'});
  expect(within(night).getByText('일본 최신 9권')).toBeTruthy();
  expect(within(night).getByText('한국 정발보다 3권 앞섬')).toBeTruthy();
  expect(workOrder().slice(0,2)).toEqual(['가득 찬 서가','밤의 도서관']);
});

it('confirms one work with all three kinds and keeps its release information',async()=>{
  await openReleases();
  fireEvent.click(screen.getByRole('button',{name:'바다의 시간 확인'}));
  await waitFor(()=>expect(within(screen.getByRole('region',{name:'바다의 시간'})).queryByText(/^NEW/)).toBeNull());
  expect(acks()).toEqual([{version:1,operationId:expect.any(String),collectionId:'sea',kinds:KINDS}]);
  expect(lines(screen.getByRole('region',{name:'바다의 시간'}))).toEqual(['1권 · 8월 1일 발매됨','2권 · 9월 20일 발매됨']);
  expect(screen.queryByRole('button',{name:'바다의 시간 확인'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(async()=>expect((await entry()).getAttribute('aria-label')).toBe('신간 보기, 새 알림 3개'));
});

it('confirms everything with the per-Collection form, the information staying',async()=>{
  await openReleases();
  fireEvent.click(screen.getByRole('button',{name:'모두 확인'}));
  const dialog=await screen.findByRole('dialog',{name:'모두 확인할까요?'});
  fireEvent.click(within(dialog).getByRole('button',{name:'모두 확인'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'모두 확인'})).toBeNull());
  expect(acks().map(body=>[body.collectionId,body.kinds])).toEqual([['full',KINDS],['night',KINDS],['quiet',KINDS],['sea',KINDS]]);
  expect(lines(screen.getByRole('region',{name:'밤의 도서관'}))).toHaveLength(3);
  expect(screen.queryByText('NEW')).toBeNull();
  expect(screen.queryByRole('region',{name:'조용한 숲'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(async()=>expect((await entry()).getAttribute('aria-label')).toBe('신간 보기'));
});

it('opens a work, and a queued owned-count change updates the list when Back returns',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  await openReleases(backRef);
  editsOffline=true;
  fireEvent.click(screen.getByRole('region',{name:'밤의 도서관'}).querySelector('.collection-release-group__open')!);
  await screen.findByRole('heading',{level:1,name:'밤의 도서관'});
  fireEvent.click(await screen.findByRole('button',{name:'소장 3권까지, 바꾸기'}));
  const dialog=await screen.findByRole('dialog',{name:'소장 권수'});
  fireEvent.change(within(dialog).getByRole('textbox',{name:'소장 권수'}),{target:{value:'5'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'저장'}));
  await screen.findByRole('button',{name:/소장 5권까지, 전송 대기/});
  expect(backRef.current!()).toBe(true);
  const night=await screen.findByRole('region',{name:'밤의 도서관'});
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('신간');
  expect(within(night).getByText('5권까지 소장')).toBeTruthy();
  expect(lines(night)).toEqual(['6권 · 발매일 미정']);
});

it('says the PC needs an update when no release schedule is published, still listing notifications',async()=>{
  works=initialWorks().map(({releaseSchedule:_schedule,...work})=>work);
  renderTab();
  fireEvent.click(await entry());
  expect((await screen.findByRole('note')).textContent).toBe(SCHEDULE_ABSENT_NOTE);
  expect(lines(await screen.findByRole('region',{name:'밤의 도서관'}))).toEqual(['5권 새로 나옴 · 2026.10.10']);
  expect(screen.queryByText('미보유')).toBeNull();
  expect(screen.queryByText('신간 알림을 켠 만화가 없습니다')).toBeNull();
});

it('offers a retry when the release information cannot be read',async()=>{
  renderTab();
  const button=await entry();
  offline=true;
  fireEvent.click(button);
  const alert=await screen.findByRole('alert');
  expect(alert.textContent).toContain('연결을 확인한 뒤 다시 시도해 주세요.');
  offline=false;
  fireEvent.click(within(alert).getByRole('button',{name:'다시 시도'}));
  await screen.findByRole('region',{name:'밤의 도서관'});
  // The only release routes are the client read and 확인; publisher routes are never touched.
  expect(mocks.api.mock.calls.every(([path])=>!String(path).includes('/releases/reads')&&!String(path).includes('/releases/unread'))).toBe(true);
});
