import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionDetail, CollectionPage, CollectionSummary} from './collectionModel';
import type {ReleaseEvent} from './collectionReleases';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api,native:mocks.native};
});
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {ApiError} from './transport';
import {Collections} from './Collections';
import {groupReleases, releaseCounts, releaseLine} from './collectionReleases';

const works:CollectionSummary[]=[
  {id:'night',name:'밤의 도서관',type:'manga',showcase:false,selectedWorkArtworkId:'cover-night'},
  {id:'sea',name:'바다의 시간',type:'manga',showcase:false,selectedWorkArtworkId:'cover-sea'},
  {id:'quiet',name:'조용한 숲',type:'manga',showcase:false},
];
const event=(eventId:string,collectionId:string,kind:ReleaseEvent['kind'],volumeNumber:number,previousValue:string|null,currentValue:string|null,detectedAt:string):ReleaseEvent=>
  ({eventId,collectionId,collectionName:works.find(work=>work.id===collectionId)!.name,provider:'aladin',kind,volumeNumber,previousValue,currentValue,detectedAt,read:false,readAt:null});
let events:ReleaseEvent[], offline:boolean, ackFails:boolean;
const acks=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/releases/acknowledge').map(([, ,body])=>body as Record<string,unknown>);
const listReply=()=>{
  const counts:Record<string,number>={};
  for(const item of events)counts[item.collectionId]=(counts[item.collectionId]??0)+1;
  return {version:1,revision:1,generation:'g',publishedAt:null,counts:{unread:events.length,collections:Object.entries(counts).sort().map(([collectionId,unread])=>({collectionId,unread}))},items:events,nextCursor:null,hasMore:false};
};

beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();offline=false;ackFails=false;
  events=[
    event('e1','night','new_volume',13,null,'2026-10-03','2026-09-25T10:00:00Z'),
    event('e2','sea','release_date_changed',4,'2026-10-01','2026-10-15','2026-09-25T09:00:00Z'),
    event('e3','night','new_volume',12,null,null,'2026-09-24T09:00:00Z'),
  ];
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/status')return {revision:'r1'};
    if(path.startsWith('/v1/collections/releases?')){if(offline)throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);return listReply();}
    if(path==='/v1/collections/releases/acknowledge'){
      if(ackFails)throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.',null,null);
      const ids=body!.eventIds as string[]|undefined;
      const hit=events.filter(item=>ids?ids.includes(item.eventId):item.collectionId===body!.collectionId);
      events=events.filter(item=>!hit.includes(item));
      return {version:1,operationId:body!.operationId,acknowledged:hit.map(item=>item.eventId),alreadyRead:[],missing:[],revision:2,lastSequence:hit.length};
    }
    if(path.startsWith('/v1/collections?')){const type=new URLSearchParams(path.split('?')[1]).get('type');return {ready:true,filterVersion:1,revision:'r1',publishedAt:null,items:works.filter(work=>work.type===type),nextCursor:null} satisfies CollectionPage;}
    const id=path.split('/')[3];
    return {revision:'r1',item:{...works.find(work=>work.id===id)!,volumes:[],artworks:[]} satisfies CollectionDetail};
  });
  mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

const renderTab=()=>render(<Collections active paused={false} backRef={{current:null}}/>);
const chip=()=>screen.findByRole('button',{name:/^신간 알림 \d+개 보기$/});
async function openInbox(){
  renderTab();
  fireEvent.click(await chip());
  await screen.findByRole('region',{name:'밤의 도서관'});
}

it('formats and groups events newest first, reading counts defensively',()=>{
  expect(releaseLine(events[0])).toBe('13권 새로 나옴 · 2026.10.3');
  expect(releaseLine(events[1])).toBe('4권 발매일 2026.10.1 → 2026.10.15');
  expect(releaseLine(events[2])).toBe('12권 새로 나옴');
  expect(groupReleases(events).map(group=>[group.collectionId,group.events.map(item=>item.eventId)])).toEqual([['night',['e1','e3']],['sea',['e2']]]);
  expect(releaseCounts(listReply())).toEqual({unread:3,byCollection:{night:2,sea:1}});
  expect(releaseCounts({revision:'r1',item:{}})).toEqual({unread:0,byCollection:{}});
});

it('shows a quiet chip only when unread, and badges manga cards like the PC',async()=>{
  renderTab();
  expect((await chip()).textContent).toBe('신간 3');
  fireEvent.click(screen.getByRole('tab',{name:'만화'}));
  const night=(await screen.findByText('밤의 도서관')).closest('button')!;
  expect(within(night).getByText('신간 2')).toBeTruthy();
  expect(within(screen.getByText('바다의 시간').closest('button')!).getByText('신간 1')).toBeTruthy();
  expect(screen.getByText('조용한 숲').closest('button')!.querySelector('.collection-release-badge')).toBeNull();
  cleanup();events=[];
  renderTab();
  await screen.findByRole('tab',{name:'게임'});
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).startsWith('/v1/collections/releases?'))).toBe(true));
  expect(screen.queryByRole('button',{name:/신간 알림/})).toBeNull();
});

it('lists the inbox grouped by Collection with each change on its own line',async()=>{
  await openInbox();
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('신간 알림 3');
  const night=screen.getByRole('region',{name:'밤의 도서관'});
  expect(within(night).getByText('신간 2')).toBeTruthy();
  expect(within(night).getByText('13권 새로 나옴 · 2026.10.3')).toBeTruthy();
  expect(within(night).getByText('12권 새로 나옴')).toBeTruthy();
  expect(within(screen.getByRole('region',{name:'바다의 시간'})).getByText('4권 발매일 2026.10.1 → 2026.10.15')).toBeTruthy();
  const order=screen.getAllByRole('region').map(region=>region.getAttribute('aria-label')).filter(name=>name==='밤의 도서관'||name==='바다의 시간');
  expect(order).toEqual(['밤의 도서관','바다의 시간']);
  // The only reads are the list routes; the publisher routes are never touched.
  expect(mocks.api.mock.calls.every(([path])=>!String(path).includes('/releases/reads')&&!String(path).includes('/releases/unread'))).toBe(true);
});

it('acknowledges one event by id and removes it once the server confirms',async()=>{
  await openInbox();
  fireEvent.click(screen.getByRole('button',{name:'13권 새로 나옴 · 2026.10.3 확인'}));
  await waitFor(()=>expect(screen.queryByText('13권 새로 나옴 · 2026.10.3')).toBeNull());
  expect(acks()).toHaveLength(1);
  expect(acks()[0]).toMatchObject({version:1,eventIds:['e1']});
  expect(String(acks()[0].operationId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('신간 알림 2');
  expect(within(screen.getByRole('region',{name:'밤의 도서관'})).getByText('신간 1')).toBeTruthy();
});

it('acknowledges a whole Collection with the per-Collection form, then every Collection one by one',async()=>{
  await openInbox();
  fireEvent.click(screen.getByRole('button',{name:'밤의 도서관 모두 확인'}));
  await waitFor(()=>expect(screen.queryByRole('region',{name:'밤의 도서관'})).toBeNull());
  expect(acks()[0]).toEqual({version:1,operationId:expect.any(String),collectionId:'night'});
  fireEvent.click(screen.getByRole('button',{name:'모두 확인'}));
  const dialog=await screen.findByRole('dialog',{name:'모두 확인할까요?'});
  fireEvent.click(within(dialog).getByRole('button',{name:'모두 확인'}));
  await screen.findByText('새 신간 알림이 없습니다');
  expect(acks().slice(1)).toEqual([{version:1,operationId:expect.any(String),collectionId:'sea'}]);
  // Back to the tab: no chip is left.
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:/신간 알림 \d+개 보기/})).toBeNull());
});

it('opens the Collection detail from a group and returns to the inbox on Back',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  render(<Collections active paused={false} backRef={backRef}/>);
  fireEvent.click(await chip());
  fireEvent.click(await screen.findByText('4권 발매일 2026.10.1 → 2026.10.15'));
  await screen.findByRole('heading',{level:1,name:'바다의 시간'});
  expect(backRef.current!()).toBe(true);
  await screen.findByRole('region',{name:'밤의 도서관'});
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('신간 알림 3');
});

it('shows the empty state when nothing is unread any more',async()=>{
  renderTab();
  const button=await chip();
  // The PC read everything meanwhile: the inbox reads an empty list.
  events=[];
  fireEvent.click(button);
  await screen.findByText('새 신간 알림이 없습니다');
  expect(screen.queryByRole('button',{name:'모두 확인'})).toBeNull();
});

it('keeps an item and says why when 확인 cannot reach the server',async()=>{
  await openInbox();
  ackFails=true;
  fireEvent.click(screen.getByRole('button',{name:'13권 새로 나옴 · 2026.10.3 확인'}));
  expect((await screen.findByRole('alert')).textContent).toContain('연결을 확인한 뒤 다시 시도해 주세요.');
  expect(screen.getByText('13권 새로 나옴 · 2026.10.3')).toBeTruthy();
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('신간 알림 3');
  // Reachable again: the same tap works.
  ackFails=false;
  fireEvent.click(screen.getByRole('button',{name:'13권 새로 나옴 · 2026.10.3 확인'}));
  await waitFor(()=>expect(screen.queryByText('13권 새로 나옴 · 2026.10.3')).toBeNull());
});

it('offers a retry when the inbox cannot be read, and shows it once reachable',async()=>{
  renderTab();
  const button=await chip();
  offline=true;
  fireEvent.click(button);
  const alert=await screen.findByRole('alert');
  expect(alert.textContent).toContain('연결을 확인한 뒤 다시 시도해 주세요.');
  expect(screen.queryByText('새 신간 알림이 없습니다')).toBeNull();
  offline=false;
  fireEvent.click(within(alert).getByRole('button',{name:'다시 시도'}));
  await screen.findByRole('region',{name:'밤의 도서관'});
});
