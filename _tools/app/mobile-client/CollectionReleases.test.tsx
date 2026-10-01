import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
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
import {loadShelf, resetReleaseStore} from './releaseStore';
import {koreanReleases, releaseBoardEntry, releaseCaption, releaseCounts, releaseInboxItem} from './collectionReleases';
import {groupInbox, koreanVolumeLine, releaseLine} from '../src/collections/releaseCaption';
import {japanReleaseLedger, koreanReleaseLedger} from '../src/collections/releaseLedger';
import type {CollectionSummary as SharedSummary} from '../src/library/types';

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
let events:ReleaseEvent[], offline:boolean, editsOffline:boolean, publication:string;
const acks=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/releases/acknowledge').map(([, ,body])=>body as Record<string,unknown>);
const releaseReads=()=>mocks.api.mock.calls.map(([path])=>String(path)).filter(path=>path.startsWith('/v1/collections/releases?'));
const listReply=()=>{
  const counts:Record<string,number>={};
  for(const item of events)counts[item.collectionId]=(counts[item.collectionId]??0)+1;
  return {version:1,revision:1,generation:'g',publishedAt:null,counts:{unread:events.length,collections:Object.entries(counts).sort().map(([collectionId,unread])=>({collectionId,unread}))},items:events,nextCursor:null,hasMore:false};
};

beforeEach(()=>{setOutboxConnection('https://a.example');resetReleaseStore();
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2026,8,25,12));
  localStorage.clear();for(const kind of ['game','manga','movie','av'])localStorage.setItem(`lakomics.mobile.collectionView.${kind}.v1`,JSON.stringify({layout:'grid',perRow:4}));mocks.api.mockReset();mocks.native.mockReset();offline=false;editsOffline=false;publication='r1';works=initialWorks();
  events=[
    event('e1','night','kakao','new_volume',5,null,'2026-10-10'),
    event('e2','sea','kakao','release_status_changed',2,'upcoming','released'),
    event('e3','full','mangadex','new_volume',4,null,null),
    event('e4','quiet','kakao','new_volume',2,null,'2026-10-01'),
  ];
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/status')return {revision:publication,capabilities:{collectionPersonalEdit:true,collectionTrackingEdit:true},libraryId:LIBRARY};
    if(path==='/v1/collections/personal-edits'){if(editsOffline)throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);return {version:1,operationId:body!.operationId,changed:true};}
    if(path.startsWith('/v1/collections/releases?')){if(offline&&new URLSearchParams(path.split('?')[1]).get('limit')==='100')throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);return listReply();}
    if(path==='/v1/collections/releases/acknowledge'){
      const ids=body!.eventIds as string[]|undefined;
      const hit=events.filter(item=>ids?ids.includes(item.eventId):item.collectionId===body!.collectionId&&(body!.kinds as string[]).includes(item.kind));
      events=events.filter(item=>!hit.includes(item));
      return {version:1,operationId:body!.operationId,acknowledged:hit.map(item=>item.eventId),alreadyRead:[],missing:[],revision:2,lastSequence:hit.length};
    }
    if(path.startsWith('/v1/collections?')){const type=new URLSearchParams(path.split('?')[1]).get('type');return {ready:true,filterVersion:1,revision:publication,publishedAt:null,items:works.filter(work=>work.type===type),nextCursor:null} satisfies CollectionPage;}
    const id=path.split('/')[3];
    return {revision:'r1',item:{...works.find(work=>work.id===id)!,volumes:[],artworks:[]} satisfies CollectionDetail};
  });
  mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

const renderTab=(backRef:{current:(()=>boolean)|null}={current:null})=>render(<Collections active paused={false} backRef={backRef}/>);
const type=(name:string)=>screen.getByRole('radio',{name});
const selectManga=()=>fireEvent.click(type('만화'));
const shortcuts=()=>screen.getByRole('group',{name:'컬렉션 바로가기'});
const waitForEntry=async(unread?:string)=>{
  const button=await within(shortcuts()).findByRole('button',{name:unread===undefined?/^신간(?: \d+)?$/:`신간 ${unread}`});
  return button;
};
const emptyEntry=()=>within(shortcuts()).findByRole('button',{name:'신간'});
/** A ledger row's cells: 소장, the chips of the volumes not owned, 날짜 and 상태. */
const ledger=(row:HTMLElement)=>({
  owned:row.querySelector('.collection-releases__owned')!.textContent,
  chips:[...row.querySelectorAll('.collection-releases__chips > *')].map(chip=>chip.textContent),
  date:row.querySelector('.collection-releases__date')!.textContent,
  state:row.querySelector('.collection-releases__state > div')!.textContent,
});
const workRow=(name:string)=>screen.findByRole('row',{name});
/** The plain notification lines of a work no ledger row lists. */
const notices=(name:string)=>screen.getByRole('region',{name}).querySelector('span.numeric')!.textContent;
async function openReleases(backRef?:{current:(()=>boolean)|null}){
  const view=renderTab(backRef);
  selectManga();
  fireEvent.click(await waitForEntry('4'));
  await workRow('밤의 도서관');
  return view;
}
const tab=(name:string)=>screen.getByRole('radio',{name:new RegExp(`^${name}`)});
const workOrder=()=>screen.getAllByRole('row').map(row=>row.getAttribute('aria-label')).filter(Boolean);

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
  expect(koreanVolumeLine({volumeNumber:9,date:'2027-01-05',upcoming:true,released:false,fresh:false},today)).toBe('9권 · 2027년 1월 5일 발매 예정');
  // The published schedule in the PC's board shape feeds the shared ledger rules unchanged.
  const watching=(work:CollectionSummary)=>!!work.releaseWatch?.enabled;
  const board=new Map(works.map(work=>[work.id,releaseBoardEntry(work,owned,watching)]));
  const inbox=groupInbox(events.map(releaseInboxItem));
  const korean=koreanReleaseLedger(works as unknown as SharedSummary[],board,inbox,today);
  expect(korean.map(row=>[row.work.id,row.owned,row.chips.map(chip=>chip.label),row.status])).toEqual([['night',3,['4권','5권 10.10','6권 미정'],'NEW'],['sea',null,['1권','2권'],'NEW']]);
  // A queued owned count is what the board carries.
  expect(releaseBoardEntry(works[0],()=>5,watching).ownedVolumes).toEqual([{editionIndex:0,count:5}]);
  const japan=japanReleaseLedger(works as unknown as SharedSummary[],board,inbox,today);
  expect(japan.map(row=>[row.work.id,row.ahead])).toEqual([['full','한국보다 2권 앞섬'],['night','한국보다 3권 앞섬']]);
  expect(releaseLine(releaseInboxItem(events[1]))).toBe('2권 출간 예정 → 출간됨');
  expect(releaseCounts(listReply())).toEqual({unread:4,byCollection:{full:1,night:1,quiet:1,sea:1}});
});

it('always shows the 신간 entry, with a count only while something is unread',async()=>{
  events=[];
  renderTab();
  selectManga();
  const button=await emptyEntry();
  await waitFor(()=>expect(releaseReads().length).toBeGreaterThan(0));
  expect(button.textContent).toBe('신간');
  expect(button.querySelector('.collection-shortcuts__count')).toBeNull();
  // Status changes count too: every read names all three kinds.
  expect(releaseReads().every(path=>new URLSearchParams(path.split('?')[1]).get('kinds')===KINDS.join(','))).toBe(true);
  cleanup();
  events=[event('e2','sea','kakao','release_status_changed',2,'upcoming','released')];
  renderTab();
  selectManga();
  await waitFor(()=>expect(releaseReads().length).toBeGreaterThan(0));
  await waitForEntry('1');
});

it('lists watched works as ledger rows with their unowned Korean volumes, new ones first',async()=>{
  await openReleases();
  expect(screen.getByRole('dialog',{name:'신간'})).toBeTruthy();
  expect(tab('한국 정발').getAttribute('aria-checked')).toBe('true');
  // The volume counts above the ledger: new, out but not owned, pre-registered.
  expect(screen.getByLabelText('권별 집계').textContent).toBe('1새로 나옴2나왔지만 아직 없음2발매 예정');
  expect(ledger(await workRow('밤의 도서관'))).toEqual({owned:'1–3 권',chips:['4권','5권 10.10','+1'],date:'10.10',state:'NEW'});
  expect(ledger(await workRow('바다의 시간'))).toEqual({owned:'기록 없음',chips:['1권','2권'],date:'9.20',state:'NEW'});
  expect((await workRow('바다의 시간')).querySelector('[data-chip-kind="new"]')!.textContent).toBe('2권');
  // Unread first, by date; fully owned and watch-off works are not rows.
  expect(workOrder()).toEqual(['밤의 도서관','바다의 시간']);
  // The watch-off work's unread event still has a place, as a plain notification.
  expect(notices('조용한 숲')).toBe('2권 새로 나옴 · 10.1');
});

it('shows how far the Japanese edition is ahead, newly found volumes marked',async()=>{
  await openReleases();
  expect(tab('일본').querySelector('.ui-segmented__count')!.textContent).toBe('2');
  expect(tab('한국 정발').querySelector('.ui-segmented__count')!.textContent).toBe('2');
  fireEvent.click(tab('일본'));
  const full=await workRow('가득 찬 서가');
  expect(ledger(full).state).toBe('NEW한국보다 2권 앞섬');
  expect(full.querySelector('[data-chip-kind="new"]')!.textContent).toBe('4권');
  expect(ledger(await workRow('밤의 도서관')).state).toBe('NEW한국보다 3권 앞섬');
  expect(workOrder()).toEqual(['가득 찬 서가','밤의 도서관']);
});

it('confirms one work with all three kinds and keeps its release information',async()=>{
  await openReleases();
  fireEvent.click(screen.getByRole('button',{name:'바다의 시간 확인'}));
  await waitFor(async()=>expect(ledger(await workRow('바다의 시간')).state).toBe('미보유 2'));
  expect(acks()).toEqual([{version:1,operationId:expect.any(String),collectionId:'sea',kinds:KINDS}]);
  expect(ledger(await workRow('바다의 시간')).chips).toEqual(['1권','2권']);
  expect(screen.queryByRole('button',{name:'바다의 시간 확인'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'신간 닫기'}));
  await waitForEntry('3');
});

it('confirms everything with the per-Collection form, the information staying',async()=>{
  await openReleases();
  fireEvent.click(screen.getByRole('button',{name:'모두 확인'}));
  const dialog=await screen.findByRole('dialog',{name:'모두 확인할까요?'});
  fireEvent.click(within(dialog).getByRole('button',{name:'모두 확인'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'모두 확인'}) as HTMLButtonElement).disabled).toBe(true));
  expect(acks().map(body=>[body.collectionId,body.kinds])).toEqual([['full',KINDS],['night',KINDS],['quiet',KINDS],['sea',KINDS]]);
  expect(ledger(await workRow('밤의 도서관')).chips).toEqual(['4권','5권 10.10','+1']);
  expect(screen.queryByText('NEW')).toBeNull();
  expect(screen.queryByRole('region',{name:'조용한 숲'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'신간 닫기'}));
  expect((await emptyEntry()).querySelector('.collection-shortcuts__count')).toBeNull();
});

it('opens a work, and a queued owned-count change updates the list when Back returns',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  await openReleases(backRef);
  editsOffline=true;
  fireEvent.click(within(await workRow('밤의 도서관')).getByRole('button',{name:'밤의 도서관'}));
  await screen.findByRole('heading',{level:1,name:'밤의 도서관'});
  fireEvent.click(await screen.findByRole('button',{name:'소장 3권까지, 바꾸기'}));
  const dialog=await screen.findByRole('dialog',{name:'소장 권수'});
  fireEvent.change(within(dialog).getByRole('textbox',{name:'소장 권수'}),{target:{value:'5'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'저장'}));
  await screen.findByRole('button',{name:/소장 5권까지, 전송 대기/});
  act(()=>{expect(backRef.current!()).toBe(true);});
  const night=await workRow('밤의 도서관');
  expect(screen.getByRole('dialog',{name:'신간'})).toBeTruthy();
  expect(ledger(night)).toMatchObject({owned:'1–5 권',chips:['6권 미정']});
});

it('says the PC needs an update when no release schedule is published, still listing notifications',async()=>{
  works=initialWorks().map(({releaseSchedule:_schedule,...work})=>work);
  renderTab();
  selectManga();
  fireEvent.click(await waitForEntry('4'));
  expect((await screen.findByRole('note')).textContent).toBe(SCHEDULE_ABSENT_NOTE);
  await screen.findByRole('region',{name:'밤의 도서관'});
  expect(notices('밤의 도서관')).toBe('5권 새로 나옴 · 10.10');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText('신간 알림을 켠 만화가 없습니다')).toBeNull();
});

it('offers a retry when the release information cannot be read',async()=>{
  renderTab();
  await waitFor(()=>expect(releaseReads().length).toBeGreaterThan(0));
  offline=true;
  selectManga();
  const button=await waitForEntry('4');
  fireEvent.click(button);
  const alert=await screen.findByRole('alert');
  expect(alert.textContent).toContain('연결을 확인한 뒤 다시 시도해 주세요.');
  offline=false;
  fireEvent.click(within(alert).getByRole('button',{name:'다시 시도'}));
  await workRow('밤의 도서관');
  // The only release routes are the client read and 확인; publisher routes are never touched.
  expect(mocks.api.mock.calls.every(([path])=>!String(path).includes('/releases/reads')&&!String(path).includes('/releases/unread'))).toBe(true);
});

it('words the grid 신간 marker from the unread count and the schedule, in priority',()=>{
  const today='2026-09-25';
  const [night,sea,quiet,full]=works;
  // (a) Unread: the unowned Korean volumes already out, and the latest of their dates.
  expect(releaseCaption(night,1,3,true,today)).toEqual({kind:'new',text:'신간 4권',date:'9.16'});
  expect(releaseCaption(night,2,1,true,today)).toEqual({kind:'new',text:'신간 2–4권',date:'9.16'});
  // No owned count: only the newest volume is named.
  expect(releaseCaption(sea,1,null,true,today)).toEqual({kind:'new',text:'신간 2권',date:'9.20'});
  expect(releaseCaption(quiet,1,0,false,today)).toEqual({kind:'new',text:'신간 1권',date:'9.1'});
  // Unread news the schedule cannot name (a MangaDex volume): the count.
  expect(releaseCaption(full,1,2,true,today)).toEqual({kind:'new',text:'신간 알림 1',date:null});
  // (b) Nothing unread, watched: Korean volumes out but not owned, as on the 신간 screen.
  expect(releaseCaption(night,0,3,true,today)).toEqual({kind:'out',text:'신간 4권',date:'9.16'});
  expect(releaseCaption(sea,0,null,true,today)).toEqual({kind:'out',text:'신간 2권',date:'9.20'});
  const screenRow=koreanReleases([night],()=>3,[],today)[0];
  expect(screenRow.volumes.filter(volume=>volume.released).map(volume=>volume.volumeNumber)).toEqual([4]);
  // (c) Nothing out: the soonest dated pre-registered volume, with the year when it differs.
  expect(releaseCaption(night,0,4,true,today)).toEqual({kind:'ahead',text:'5권 예약',date:'10.10'});
  expect(releaseCaption(night,0,3,true,'2025-12-30')).toEqual({kind:'ahead',text:'4권 예약',date:'2026.9.16'});
  // 신간 알림 off, or nothing unowned: no marker.
  expect(releaseCaption(night,0,3,false,today)).toBeNull();
  expect(releaseCaption(full,0,2,true,today)).toBeNull();
  // Games and movies: only unread notices, as a count.
  expect(releaseCaption({...night,type:'game'},3,0,true,today)).toEqual({kind:'new',text:'신간 알림 3',date:null});
  expect(releaseCaption({...night,type:'movie'},0,0,true,today)).toBeNull();
});

it('shows the 신간 marker after the year and stars in the manga grid, with nothing on the cover',async()=>{
  works=works.map(work=>({...work,year:2020,myScore:work.id==='night'?4.5:null}));
  renderTab();
  selectManga();
  await waitForEntry('4');
  const tile=(name:string)=>screen.getByText(name,{selector:'.collection-grid .collection-title'}).closest('button')!;
  await waitFor(()=>expect(tile('밤의 도서관').querySelector('.collection-release-line.is-new')?.textContent).toBe('신간 4권 · 9.16'));
  // One meta line: the year, the stars, then the marker (DOM reversed for the narrow-tile drop).
  const meta=tile('밤의 도서관').querySelector('.collection-card-meta')!;
  expect(meta.querySelector('.collection-date')!.textContent).toBe('2020');
  expect(meta.querySelector('.collection-card-meta__tail .collection-score')!.getAttribute('aria-label')).toBe('내 별점 4.5점');
  expect(meta.querySelector('.collection-card-meta__tail')!.textContent).toBe('4.5·신간 4권 · 9.16');
  expect(tile('밤의 도서관').querySelector('.collection-art .collection-release-badge,.collection-release-badge')).toBeNull();
  expect(tile('가득 찬 서가').querySelector('.collection-release-line')!.textContent).toBe('신간 알림 1');
  cleanup();
  // Everything read: a watched work shows its unowned Korean volume out, or the next pre-registered one.
  events=[];
  works=works.map(work=>work.id==='sea'?{...work,ownedVolumes:[{editionIndex:0,count:2}],releaseSchedule:{kakao:kakao(0,[[1,'2026-08-01','released'],[2,'2026-09-20','released'],[3,'2026-11-02',null]]),mangadex:null}}:work);
  renderTab();
  selectManga();
  await emptyEntry();
  await waitFor(()=>expect(tile('밤의 도서관').querySelector('.collection-release-line.is-out')?.textContent).toBe('신간 4권 · 9.16'));
  expect(tile('바다의 시간').querySelector('.collection-release-line.is-ahead')!.textContent).toBe('3권 예약 · 11.2');
  expect(tile('바다의 시간').querySelector('.collection-card-meta')!.textContent).toBe('3권 예약 · 11.22020');
  expect(tile('가득 찬 서가').querySelector('.collection-release-line')).toBeNull();
  expect(tile('조용한 숲').querySelector('.collection-release-line')).toBeNull();
  expect(tile('조용한 숲').querySelector('.collection-card-meta')!.textContent).toBe('2020');
});

it('reopens the 신간 screen from what it read, reading again only after the publication moved',async()=>{
  const shelfReads=()=>mocks.api.mock.calls.map(([path])=>String(path)).filter(path=>path.startsWith('/v1/collections?')&&path.includes('type=manga')&&path.includes('sort=name&direction=asc')).length;
  const eventReads=()=>releaseReads().filter(path=>new URLSearchParams(path.split('?')[1]).get('limit')==='100').length;
  const backRef:{current:(()=>boolean)|null}={current:null};
  const view=await openReleases(backRef);
  await waitFor(()=>expect([shelfReads(),eventReads()]).toEqual([1,1]));
  const reopen=async()=>{
    act(()=>{expect(backRef.current!()).toBe(true);});
    await waitFor(()=>expect(screen.queryByRole('row',{name:'밤의 도서관'})).toBeNull());
    fireEvent.click(await waitForEntry('4'));
    return workRow('밤의 도서관');
  };
  const calls=mocks.api.mock.calls.length;
  // Shown at once from the kept copy, without a single request.
  expect(ledger(await reopen()).chips).toEqual(['4권','5권 10.10','+1']);
  expect(mocks.api.mock.calls.length).toBe(calls);
  // The PC publishes: the status check sees a new revision, and the next show reads once.
  const gridReads=()=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/collections?')&&String(path).includes('type=manga')&&String(path).includes('showcase=false')&&String(path).includes('sort=media_date')).length,grid=gridReads();
  expect(view.container.querySelector('.collection-grid .collection-title')?.textContent).toBeTruthy();
  expect(screen.queryByRole('group',{name:'컬렉션 바로가기'})).toBeNull();
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path==='/v1/collections/status')).toBe(true));
  act(()=>{expect(backRef.current!()).toBe(true);});
  publication='r2';
  // Returning to the active tab refreshes the shortcut count. The full inbox snapshot
  // is read when its overlay opens again.
  view.rerender(<Collections active={false} paused={false} backRef={backRef}/>);
  view.rerender(<Collections active paused={false} backRef={backRef}/>);
  await waitFor(()=>expect(gridReads()).toBeGreaterThan(grid));
  expect([shelfReads(),eventReads()]).toEqual([1,1]);
  fireEvent.click(await waitForEntry('4'));
  await workRow('밤의 도서관');
  await waitFor(()=>expect([shelfReads(),eventReads()]).toEqual([2,2]));
});

it('uses a shelf Home already read for this publication, reading only the unread events',async()=>{
  const shelfReads=()=>mocks.api.mock.calls.map(([path])=>String(path)).filter(path=>path.startsWith('/v1/collections?')&&path.includes('type=manga')&&path.includes('sort=name&direction=asc')).length;
  await loadShelf(new AbortController().signal);
  expect(shelfReads()).toBe(1);
  const view=render(<Collections active paused={false} backRef={{current:null}} request={{kind:'releases',key:1}}/>);
  // Home's 신간 tile opens the screen directly.
  expect(ledger(await workRow('밤의 도서관')).chips).toEqual(['4권','5권 10.10','+1']);
  expect(shelfReads()).toBe(1);
  expect(releaseReads().filter(path=>new URLSearchParams(path.split('?')[1]).get('limit')==='100')).toHaveLength(1);
  // Home's 발매 예정 row opens one work's detail.
  view.rerender(<Collections active paused={false} backRef={{current:null}} request={{kind:'work',id:'sea',key:2}}/>);
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path==='/v1/collections/sea')).toBe(true));
});

it('returns to Home from the entry level Home opened, after closing deeper levels first',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null},home=vi.fn();
  const view=render(<Collections active paused={false} backRef={backRef} request={{kind:'releases',key:1}} onReturnHome={home}/>);
  // 신간 → a work: Back closes the work back to 신간 and stays inside.
  fireEvent.click(within(await workRow('밤의 도서관')).getByRole('button',{name:'밤의 도서관'}));
  await screen.findByRole('heading',{level:1,name:'밤의 도서관'});
  act(()=>{expect(backRef.current!()).toBe(true);});
  await workRow('밤의 도서관');
  expect(home).not.toHaveBeenCalled();
  // The inbox opened from Home returns there when its overlay closes.
  fireEvent.click(screen.getByRole('button',{name:'신간 닫기'}));
  expect(home).toHaveBeenCalledTimes(1);
  // A work opened directly from Home returns Home from the detail (Android Back).
  view.rerender(<Collections active paused={false} backRef={backRef} request={{kind:'work',id:'sea',key:2}} onReturnHome={home}/>);
  await screen.findByRole('heading',{level:1,name:'바다의 시간'});
  act(()=>{expect(backRef.current!()).toBe(true);});
  expect(home).toHaveBeenCalledTimes(2);
});

it('keeps Collections Back inside the tab when the screen was not opened from Home',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  await openReleases(backRef);
  act(()=>{expect(backRef.current!()).toBe(true);});
  await waitForEntry('4');
  expect(backRef.current!()).toBe(false);
});
