import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const CONNECTION='https://a.example';
import type {CollectionDetail, CollectionPage} from './collectionModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api,native:mocks.native};
});
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {ApiError} from './transport';
import {Collections} from './Collections';
import {collectionEditKey, commitCollectionEdit, readCollectionEdit, readCollectionEdits, sameEditValue} from './collectionEditOutbox';
import {flushCollectionEdits} from './collectionEditDelivery';

const LIBRARY='e'.repeat(32);
const volumes=[0,1,2,3,4].map(i=>({id:`v${i}`,volumeNumber:i+1,editionIndex:0,displayLabel:`${i+1}권`})).concat([{id:'s1',volumeNumber:1,editionIndex:1,displayLabel:'1권'}]);
const base:CollectionDetail={id:'w',name:'밤의 도서관',type:'manga',showcase:false,myScore:null,volumes,artworks:[],
  releaseWatch:{enabled:false,available:true},ownedVolumes:[{editionIndex:0,count:3}]};
let item:CollectionDetail, revision:string, personal:boolean, tracking:boolean, command:(body:Record<string,unknown>)=>unknown;
const page=():CollectionPage=>({ready:true,filterVersion:1,revision,publishedAt:null,items:[item],nextCursor:null});
const commands=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/personal-edits').map(([, ,body])=>body as Record<string,unknown>);
const conflict=(current:unknown)=>new ApiError('다른 기기에서 값이 바뀌었습니다.',409,{detail:{code:'collectionPersonalConflict',message:'다른 기기에서 값이 바뀌었습니다.',current}});

beforeEach(()=>{setOutboxConnection(CONNECTION);
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  item={...base};revision='r1';personal=true;tracking=true;
  command=body=>{
    // A tiny server applying tracking fields like collection_personal_edits.patch.
    if(body.field==='releaseWatch')item={...item,releaseWatch:{...item.releaseWatch!,enabled:body.value as boolean}};
    if(body.field==='ownedVolumes'){const value=body.value as {editionIndex:number;count:number};item={...item,ownedVolumes:[...(item.ownedVolumes??[]).filter(entry=>entry.editionIndex!==value.editionIndex),value].sort((a,b)=>a.editionIndex-b.editionIndex)};}
    revision='r2';
    return {version:1,operationId:body.operationId,collectionId:body.collectionId,field:body.field,value:body.value,sequence:1,revision,changed:true};
  };
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/status')return {revision,capabilities:{collectionPersonalEdit:personal,collectionTrackingEdit:tracking},libraryId:LIBRARY};
    if(path==='/v1/collections/personal-edits'){const reply=command(body!);if(reply instanceof Error)throw reply;return reply;}
    if(path.startsWith('/v1/collections/releases'))return {version:1,revision:1,counts:{unread:0,collections:[]},items:[],nextCursor:null,hasMore:false};
    if(path.startsWith('/v1/collections?'))return page();
    return {revision,item};
  });
  mocks.native.mockResolvedValue({url:'https://example.invalid/cover',expires_in:300});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

async function openDetail(){
  render(<Collections active paused={false} backRef={{current:null}}/>);
  fireEvent.click(await screen.findByText(base.name));
  await screen.findByRole('region',{name:'내 기록'});
}
const section=()=>screen.getByRole('region',{name:'내 기록'});
/** 신간 알림 is a bell in the detail's top bar. */
const actions=()=>screen.getByRole('group',{name:'작품 동작'});
const watchSwitch=async()=>{await screen.findByRole('group',{name:'작품 동작'});return within(actions()).findByRole('button',{name:/^신간 알림/});};

it('turns 신간 알림 on through the personal-edit outbox with the expected value',async()=>{
  await openDetail();
  const toggle=await watchSwitch();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  await waitFor(()=>expect(commands()).toHaveLength(1));
  expect(commands()[0]).toMatchObject({version:1,libraryId:LIBRARY,collectionId:'w',field:'releaseWatch',value:true,expected:false});
  await waitFor(()=>expect(readCollectionEdits()).toEqual({}));
  await waitFor(async()=>expect((await watchSwitch()).getAttribute('aria-pressed')).toBe('true'));
  expect((await watchSwitch()).classList.contains('is-pending')).toBe(false);
});

it('edits the owned count per edition with the stepper, number field and 전체 shortcut',async()=>{
  await openDetail();
  // One row per edition: tracked 기본판, and 판본 2 that has volumes but no count yet.
  const main=within(section()).getByRole('button',{name:'기본판 소장 3권까지, 바꾸기'});
  expect(main.textContent).toContain('3권까지 / 전체 5권');
  expect(within(section()).getByRole('button',{name:'판본 2 소장 기록 없음, 바꾸기'})).toBeTruthy();
  fireEvent.click(main);
  const sheet=await screen.findByRole('dialog',{name:'기본판 소장 권수'});
  const field=within(sheet).getByRole('textbox',{name:'소장 권수'}) as HTMLInputElement;
  expect(field.value).toBe('3');
  fireEvent.click(within(sheet).getByRole('button',{name:'한 권 더하기'}));
  expect(field.value).toBe('4');
  fireEvent.click(within(sheet).getByRole('button',{name:'전체 5권'}));
  expect(field.value).toBe('5');
  fireEvent.click(within(sheet).getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(commands()).toHaveLength(1));
  expect(commands()[0]).toMatchObject({field:'ownedVolumes',value:{editionIndex:0,count:5},expected:{editionIndex:0,count:3}});
  await waitFor(()=>expect(within(section()).getByRole('button',{name:'기본판 소장 5권까지, 바꾸기'})).toBeTruthy());
  // An untracked edition sends `count: null` as the expected value.
  fireEvent.click(within(section()).getByRole('button',{name:'판본 2 소장 기록 없음, 바꾸기'}));
  const second=await screen.findByRole('dialog',{name:'판본 2 소장 권수'});
  fireEvent.change(within(second).getByRole('textbox',{name:'소장 권수'}),{target:{value:'1'}});
  fireEvent.click(within(second).getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(commands()).toHaveLength(2));
  expect(commands()[1]).toMatchObject({field:'ownedVolumes',value:{editionIndex:1,count:1},expected:{editionIndex:1,count:null}});
});

it('refuses an out-of-range count in the sheet instead of queuing it',async()=>{
  await openDetail();
  fireEvent.click(within(section()).getByRole('button',{name:/기본판 소장/}));
  const sheet=await screen.findByRole('dialog',{name:'기본판 소장 권수'});
  fireEvent.change(within(sheet).getByRole('textbox',{name:'소장 권수'}),{target:{value:'2001'}});
  expect(within(sheet).getByRole('alert').textContent).toContain('0–2,000권');
  expect((within(sheet).getByRole('button',{name:'저장'}) as HTMLButtonElement).disabled).toBe(true);
  expect(() => commitCollectionEdit('w','ownedVolumes',{editionIndex:0,count:2001},{editionIndex:0,count:3},LIBRARY)).toThrow();
  expect(readCollectionEdits()).toEqual({});
});

it('rebases an owned-count conflict onto the PC value once and keeps the user\'s count',async()=>{
  let calls=0;
  const apply=command;
  command=body=>{
    if(++calls===1){item={...item,ownedVolumes:[{editionIndex:0,count:4}]};return conflict({editionIndex:0,count:4});}
    return apply(body);
  };
  await openDetail();
  fireEvent.click(within(section()).getByRole('button',{name:/기본판 소장/}));
  const sheet=await screen.findByRole('dialog',{name:'기본판 소장 권수'});
  fireEvent.change(within(sheet).getByRole('textbox',{name:'소장 권수'}),{target:{value:'7'}});
  fireEvent.click(within(sheet).getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(commands()).toHaveLength(2));
  expect(commands()[0]).toMatchObject({value:{editionIndex:0,count:7},expected:{editionIndex:0,count:3}});
  expect(commands()[1]).toMatchObject({value:{editionIndex:0,count:7},expected:{editionIndex:0,count:4}});
  expect(commands()[1].operationId).not.toBe(commands()[0].operationId);
  await waitFor(()=>expect(readCollectionEdits()).toEqual({}));
  await waitFor(()=>expect(within(section()).getByRole('button',{name:'기본판 소장 7권까지, 바꾸기'})).toBeTruthy());
});

it('disables 신간 알림 with a short reason when the Collection has no Aladin/Kakao binding',async()=>{
  item={...base,releaseWatch:{enabled:false,available:false}};
  await openDetail();
  const toggle=await watchSwitch() as HTMLButtonElement;
  expect(toggle.getAttribute('aria-disabled')).toBe('true');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByText('알라딘이나 카카오와 연결된 작품만 켤 수 있습니다.',{selector:'.collection-toast'})).toBeNull();
  // A tap explains why in a brief toast instead of queuing anything.
  fireEvent.click(toggle);
  expect(screen.getByText('알라딘이나 카카오와 연결된 작품만 켤 수 있습니다.',{selector:'.collection-toast'})).toBeTruthy();
  expect(commands()).toHaveLength(0);
  expect(readCollectionEdits()).toEqual({});
});

it('lets 신간 알림 be turned off even without a binding',async()=>{
  item={...base,releaseWatch:{enabled:true,available:false}};
  await openDetail();
  const toggle=await watchSwitch() as HTMLButtonElement;
  expect(toggle.getAttribute('aria-disabled')).toBeNull();
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(toggle);
  await waitFor(()=>expect(commands()[0]).toMatchObject({field:'releaseWatch',value:false,expected:true}));
});

it('drops an edit the server refuses as unavailable and says why',async()=>{
  command=()=>new ApiError('알라딘 또는 카카오와 연결된 만화만 신간 알림을 켤 수 있습니다.',409,{detail:{code:'releaseWatchUnavailable',message:'x'}});
  await openDetail();
  fireEvent.click(await watchSwitch());
  expect((await within(section()).findByRole('alert')).textContent).toContain('신간 알림을 켤 수 있어 되돌렸습니다');
  expect(readCollectionEdits()).toEqual({});
  expect((await watchSwitch()).getAttribute('aria-pressed')).toBe('false');
});

it('shows tracking read-only with a short note while the PC has not been upgraded',async()=>{
  tracking=false;
  await openDetail();
  await waitFor(()=>expect(within(section()).getByText('PC 앱을 업데이트하면 신간 알림과 소장 권수를 여기서 바꿀 수 있습니다.')).toBeTruthy());
  // The bell shows the state read-only; a tap says the PC needs the update.
  const bell=await watchSwitch();
  expect(bell.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(bell);
  expect(screen.getByText('PC 앱을 업데이트하면 신간 알림을 여기서 바꿀 수 있습니다.',{selector:'.collection-toast'})).toBeTruthy();
  expect(commands()).toHaveLength(0);
  expect(within(section()).queryByRole('button',{name:/소장/})).toBeNull();
  expect(within(section()).getByText('3권까지')).toBeTruthy();
  // Rating stays editable: only the tracking fields wait for the PC.
  expect(within(section()).getByRole('button',{name:/내 평점/})).toBeTruthy();
});

it('withholds a queued tracking edit until the capability returns, while other edits still send',async()=>{
  tracking=false;
  commitCollectionEdit('w','releaseWatch',true,false,LIBRARY);
  commitCollectionEdit('w','myScore',4,null,LIBRARY);
  const report=await flushCollectionEdits();
  expect(report.outcomes).toEqual(expect.arrayContaining([{key:'w:releaseWatch',outcome:'withheld'},{key:'w:myScore',outcome:'confirmed'}]));
  expect(commands().map(body=>body.field)).toEqual(['myScore']);
  expect(readCollectionEdit('w','releaseWatch')).not.toBeNull();
  tracking=true;
  await flushCollectionEdits();
  expect(commands().map(body=>body.field)).toEqual(['myScore','releaseWatch']);
  expect(readCollectionEdits()).toEqual({});
});

it('shows nothing extra for a legacy manga publication or other Collection types',async()=>{
  item={...base,releaseWatch:undefined,ownedVolumes:undefined};
  await openDetail();
  await waitFor(()=>expect(within(section()).getByRole('button',{name:/내 평점/})).toBeTruthy());
  expect(within(section()).queryByText(/신간 알림|소장/)).toBeNull();
  expect(within(actions()).queryByRole('button',{name:/신간 알림/})).toBeNull();
  cleanup();
  item={...base,type:'game',volumes:[]};
  await openDetail();
  await waitFor(()=>expect(within(section()).getByRole('button',{name:/내 평점/})).toBeTruthy());
  expect(within(section()).queryByText(/신간 알림|소장/)).toBeNull();
});

it('keeps one queue entry per edition and compares owned entries by content',()=>{
  expect(collectionEditKey('w','ownedVolumes',{editionIndex:2,count:5})).toBe('w:ownedVolumes:2');
  expect(sameEditValue({editionIndex:0,count:3},{editionIndex:0,count:3})).toBe(true);
  expect(sameEditValue({editionIndex:0,count:3},{editionIndex:1,count:3})).toBe(false);
  expect(commitCollectionEdit('w','ownedVolumes',{editionIndex:0,count:3},{editionIndex:0,count:3},LIBRARY)).toBeNull();
  commitCollectionEdit('w','ownedVolumes',{editionIndex:0,count:4},{editionIndex:0,count:3},LIBRARY);
  commitCollectionEdit('w','ownedVolumes',{editionIndex:1,count:2},{editionIndex:1,count:null},LIBRARY);
  expect(Object.keys(readCollectionEdits()).sort()).toEqual(['w:ownedVolumes:0','w:ownedVolumes:1']);
});
