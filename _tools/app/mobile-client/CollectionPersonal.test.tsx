import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionDetail, CollectionPage} from './collectionModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',async()=>{
  const actual=await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual,api:mocks.api,native:mocks.native};
});
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
import {ApiError} from './transport';
import {Collections} from './Collections';
import {readCollectionEdit, readCollectionEdits} from './collectionEditOutbox';

const LIBRARY='e'.repeat(32);
const base:CollectionDetail={id:'w',name:'밤의 도서관',type:'manga',showcase:false,myScore:3,description:'PC 메모',overview:'provider',volumes:[],artworks:[]};
let item:CollectionDetail, revision:string, capable:boolean, command:(body:Record<string,unknown>)=>unknown;
const page=():CollectionPage=>({ready:true,filterVersion:1,revision,publishedAt:null,items:[item],nextCursor:null});
const commands=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/personal-edits').map(([, ,body])=>body as Record<string,unknown>);

beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  item={...base};revision='r1';capable=true;
  command=body=>{
    // A tiny server: apply, bump the revision, answer with a receipt.
    const key=body.field==='memo'?'description':body.field as 'myScore'|'showcase';
    item={...item,[key]:body.value};revision='r2';
    return {version:1,operationId:body.operationId,collectionId:body.collectionId,field:body.field,value:body.value,sequence:1,revision,changed:true};
  };
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/status')return capable?{revision,capabilities:{collectionPersonalEdit:true},libraryId:LIBRARY}:{revision,capabilities:{collectionPersonalEdit:false}};
    if(path==='/v1/collections/personal-edits'){const reply=command(body!);if(reply instanceof Error)throw reply;return reply;}
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
const personal=()=>screen.getByRole('region',{name:'내 기록'});
const memoSection=()=>screen.getByRole('region',{name:'내 메모'});

it('edits my rating from the sheet and shows the confirmed value',async()=>{
  await openDetail();
  const row=await within(personal()).findByRole('button',{name:/내 평점 ★ 3.0 \/ 5/});
  fireEvent.click(row);
  const sheet=await screen.findByRole('dialog',{name:'내 평점'});
  expect(within(sheet).getByRole('radio',{name:'미평가'})).toBeTruthy();
  expect(within(sheet).getAllByRole('radio')).toHaveLength(12);
  fireEvent.click(within(sheet).getByRole('radio',{name:'4.5점'}));
  await waitFor(()=>expect(commands()).toHaveLength(1));
  expect(commands()[0]).toMatchObject({version:1,libraryId:LIBRARY,collectionId:'w',field:'myScore',value:4.5,expected:3});
  await waitFor(()=>expect(readCollectionEdits()).toEqual({}));
  await waitFor(()=>expect(within(personal()).getByRole('button',{name:/내 평점 ★ 4.5 \/ 5/})).toBeTruthy());
  // Unrated is a real choice, and 0.0 is a rating rather than 미평가.
  fireEvent.click(within(personal()).getByRole('button',{name:/내 평점/}));
  fireEvent.click(within(await screen.findByRole('dialog',{name:'내 평점'})).getByRole('radio',{name:'0.0점'}));
  await waitFor(()=>expect(commands().at(-1)).toMatchObject({value:0,expected:4.5}));
});

it('keeps a queued value visible as 전송 대기 and survives a remount',async()=>{
  command=()=>new Error('연결 시간이 초과되었습니다.');
  await openDetail();
  fireEvent.click(within(personal()).getByRole('button',{name:/쇼케이스/}));
  await waitFor(()=>expect(commands()).toHaveLength(1));
  const toggle=within(personal()).getByRole('button',{name:/쇼케이스, 전송 대기/});
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(within(personal()).getByText('전송 대기')).toBeTruthy();
  const id=readCollectionEdit('w','showcase')!.operationId;
  cleanup();
  await openDetail();
  expect(within(personal()).getByRole('button',{name:/쇼케이스, 전송 대기/}).getAttribute('aria-pressed')).toBe('true');
  expect(readCollectionEdit('w','showcase')!.operationId).toBe(id);
});

it('keeps fields read-only without errors while the server lacks the capability',async()=>{
  capable=false;
  await openDetail();
  await act(async()=>{});
  expect(within(personal()).queryAllByRole('button')).toHaveLength(0);
  expect(within(personal()).getByText('★ 3.0 / 5')).toBeTruthy();
  // The memo stays visible, but offers no editing.
  expect(within(memoSection()).getByText('PC 메모')).toBeTruthy();
  expect(within(memoSection()).queryByRole('button')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(commands()).toHaveLength(0);
});

it('shows the memo for manga beside the overview and edits it with a counter',async()=>{
  item={...base,type:'movie',overview:'줄거리'};
  await openDetail();
  expect(screen.getByText('줄거리')).toBeTruthy();
  expect(within(memoSection()).getByText('PC 메모')).toBeTruthy();
  fireEvent.click(within(memoSection()).getByRole('button',{name:'편집'}));
  const sheet=await screen.findByRole('dialog',{name:'내 메모'});
  const box=within(sheet).getByRole('textbox',{name:'내 메모'}) as HTMLTextAreaElement;
  expect(box.value).toBe('PC 메모');
  expect(within(sheet).getByText('5 / 2,000')).toBeTruthy();
  fireEvent.change(box,{target:{value:'가'.repeat(2001)}});
  expect(within(sheet).getByText('2,001 / 2,000')).toBeTruthy();
  expect((within(sheet).getByRole('button',{name:'저장'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(box,{target:{value:'  새 메모  '}});
  fireEvent.click(within(sheet).getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(commands()[0]).toMatchObject({field:'memo',value:'새 메모',expected:'PC 메모'}));
  await waitFor(()=>expect(within(memoSection()).getByText('새 메모')).toBeTruthy());
});

it('asks about a memo the PC changed meanwhile, then overwrites',async()=>{
  command=body=>body.expected==='PC 메모'
    ?new ApiError('x',409,{detail:{code:'collectionPersonalConflict',message:'m',current:'PC가 바꾼 메모'}})
    :{version:1,operationId:body.operationId,collectionId:'w',field:'memo',value:body.value,sequence:2,revision:'r3',changed:true};
  await openDetail();
  fireEvent.click(within(memoSection()).getByRole('button',{name:'편집'}));
  const sheet=await screen.findByRole('dialog',{name:'내 메모'});
  fireEvent.change(within(sheet).getByRole('textbox',{name:'내 메모'}),{target:{value:'모바일 초안'}});
  fireEvent.click(within(sheet).getByRole('button',{name:'저장'}));
  const choice=await screen.findByRole('dialog',{name:'PC에서 메모가 바뀌었습니다'});
  expect(within(choice).getByText('PC가 바꾼 메모')).toBeTruthy();
  expect(within(choice).getByText('모바일 초안')).toBeTruthy();
  expect(commands()).toHaveLength(1);
  fireEvent.click(within(choice).getByRole('button',{name:'덮어쓰기'}));
  await waitFor(()=>expect(commands()).toHaveLength(2));
  expect(commands()[1]).toMatchObject({expected:'PC가 바꾼 메모',value:'모바일 초안'});
  // Overwriting changes the payload, so it goes out under a new operation id.
  expect(commands()[1].operationId).not.toBe(commands()[0].operationId);
  await waitFor(()=>expect(readCollectionEdits()).toEqual({}));
});

it('discards the draft on a memo conflict',async()=>{
  command=()=>new ApiError('x',409,{detail:{code:'collectionPersonalConflict',message:'m',current:'PC가 바꾼 메모'}});
  await openDetail();
  fireEvent.click(within(memoSection()).getByRole('button',{name:'편집'}));
  const sheet=await screen.findByRole('dialog',{name:'내 메모'});
  fireEvent.change(within(sheet).getByRole('textbox',{name:'내 메모'}),{target:{value:'버릴 메모'}});
  fireEvent.click(within(sheet).getByRole('button',{name:'저장'}));
  fireEvent.click(within(await screen.findByRole('dialog',{name:'PC에서 메모가 바뀌었습니다'})).getByRole('button',{name:'버리기'}));
  expect(readCollectionEdits()).toEqual({});
  expect(within(memoSection()).queryByText('버릴 메모')).toBeNull();
  expect(commands()).toHaveLength(1);
});

it('says briefly why an edit for a deleted Collection went back',async()=>{
  command=()=>new ApiError('x',404,{detail:{code:'collectionNotFound',message:'m'}});
  await openDetail();
  fireEvent.click(within(personal()).getByRole('button',{name:/쇼케이스/}));
  expect(await within(personal()).findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('PC에서 삭제'));
  expect(readCollectionEdits()).toEqual({});
  expect(within(personal()).getByRole('button',{name:'쇼케이스'}).getAttribute('aria-pressed')).toBe('false');
});

it('does not show an edit the device could not store as queued',async()=>{
  await openDetail();
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
  fireEvent.click(within(personal()).getByRole('button',{name:/쇼케이스/}));
  expect((await within(personal()).findByRole('alert')).textContent).toBe('기기에 저장하지 못했습니다.');
  expect(within(personal()).queryByText('전송 대기')).toBeNull();
  expect(within(personal()).getByRole('button',{name:'쇼케이스'}).getAttribute('aria-pressed')).toBe('false');
  expect(commands()).toHaveLength(0);
});
