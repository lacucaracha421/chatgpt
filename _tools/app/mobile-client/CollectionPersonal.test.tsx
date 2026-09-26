import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
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
import {readCollectionEdit, readCollectionEdits} from './collectionEditOutbox';

const LIBRARY='e'.repeat(32);
const base:CollectionDetail={id:'w',name:'밤의 도서관',type:'manga',showcase:false,myScore:3,description:'PC 메모',overview:'provider',volumes:[],artworks:[]};
let item:CollectionDetail, revision:string, capable:boolean, command:(body:Record<string,unknown>)=>unknown;
const page=():CollectionPage=>({ready:true,filterVersion:1,revision,publishedAt:null,items:[item],nextCursor:null});
const commands=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/personal-edits').map(([, ,body])=>body as Record<string,unknown>);

beforeEach(()=>{setOutboxConnection(CONNECTION);
  localStorage.clear();mocks.api.mockReset();mocks.native.mockReset();
  item={...base};revision='r1';capable=true;
  command=body=>{
    // A tiny server: apply, bump the revision, answer with a receipt.
    const key=body.field==='memo'?'description':body.field as 'myScore'|'showcase';
    item={...item,[key]:body.value};revision='r2';
    return {version:1,operationId:body.operationId,collectionId:body.collectionId,field:body.field,value:body.value,sequence:1,revision,changed:true};
  };
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/status')return capable?{revision,capabilities:{collectionPersonalEdit:true,collectionTrackingEdit:true},libraryId:LIBRARY}:{revision,capabilities:{collectionPersonalEdit:false}};
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
/** Showcase and 신간 알림 sit in the detail's top bar. */
const actions=()=>screen.getByRole('group',{name:'작품 동작'});

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
  fireEvent.click(within(actions()).getByRole('button',{name:/쇼케이스/}));
  await waitFor(()=>expect(commands()).toHaveLength(1));
  const toggle=within(actions()).getByRole('button',{name:/쇼케이스, 전송 대기/});
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(toggle.classList.contains('is-pending')).toBe(true);
  const id=readCollectionEdit('w','showcase')!.operationId;
  cleanup();
  await openDetail();
  expect(within(actions()).getByRole('button',{name:/쇼케이스, 전송 대기/}).getAttribute('aria-pressed')).toBe('true');
  expect(readCollectionEdit('w','showcase')!.operationId).toBe(id);
});

it('keeps fields read-only without errors while the server lacks the capability',async()=>{
  capable=false;
  await openDetail();
  await act(async()=>{});
  expect(within(personal()).queryAllByRole('button')).toHaveLength(0);
  expect(within(personal()).getByText('★ 3.0 / 5')).toBeTruthy();
  // Showcase is off, so the read-only bar has nothing to show for it.
  expect(within(actions()).queryByRole('button')).toBeNull();
  expect(within(actions()).queryByRole('img',{name:/쇼케이스/})).toBeNull();
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
  fireEvent.click(within(actions()).getByRole('button',{name:/쇼케이스/}));
  expect(await within(personal()).findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('PC에서 삭제'));
  expect(readCollectionEdits()).toEqual({});
  expect(within(actions()).getByRole('button',{name:'쇼케이스'}).getAttribute('aria-pressed')).toBe('false');
});

it('does not show an edit the device could not store as queued',async()=>{
  await openDetail();
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
  fireEvent.click(within(actions()).getByRole('button',{name:/쇼케이스/}));
  expect((await within(personal()).findByRole('alert')).textContent).toBe('기기에 저장하지 못했습니다.');
  expect(within(actions()).getByRole('button',{name:'쇼케이스'}).classList.contains('is-pending')).toBe(false);
  expect(within(actions()).getByRole('button',{name:'쇼케이스'}).getAttribute('aria-pressed')).toBe('false');
  expect(commands()).toHaveLength(0);
});

describe('artwork across a confirmed Showcase edit',()=>{
  const artwork=()=>[...document.querySelectorAll<HTMLImageElement>('.collection-art img')];
  const detailCalls=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/w');
  const artworkCalls=()=>mocks.native.mock.calls.filter(([op])=>op==='collectionArtwork');
  /** The list card loads before the detail opens (a hidden list does not load artwork). */
  async function openWithArtwork(){
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await waitFor(()=>expect(artwork()).toHaveLength(1));
    fireEvent.click(screen.getByText(base.name));
    await screen.findByRole('region',{name:'내 기록'});
    await waitFor(()=>expect(artwork()).toHaveLength(2));
  }

  it('keeps the same image elements and URLs when only the publication revision moved',async()=>{
    item={...base,selectedWorkArtworkId:'cover',artworkVersions:{cover:{thumbnail:'a'.repeat(64)}}};
    // Native answers a digest-keyed cache URL, which does not depend on the revision.
    mocks.native.mockImplementation(async(_op:string,payload:{digest:string})=>({url:`https://app.lakomics.local/media-cache/1/${payload.digest.slice(0,8)}`}));
    await openWithArtwork();
    const before=artwork(),sources=before.map(image=>image.getAttribute('src')),requested=artworkCalls().length;
    fireEvent.click(within(actions()).getByRole('button',{name:/쇼케이스/}));
    await waitFor(()=>expect(readCollectionEdits()).toEqual({}));
    await waitFor(()=>expect(detailCalls().length).toBeGreaterThan(1));
    await waitFor(()=>expect(within(actions()).getByRole('button',{name:'쇼케이스'}).getAttribute('aria-pressed')).toBe('true'));
    await act(async()=>{});
    expect(revision).toBe('r2');
    const after=artwork();
    expect(after.map(image=>image.getAttribute('src'))).toEqual(sources);
    after.forEach((image,index)=>expect(image).toBe(before[index]));
    expect(document.querySelector('.collection-art-placeholder')).toBeNull();
    expect(artworkCalls()).toHaveLength(requested);
  });

  it('keeps showing the old image until a revision-keyed replacement is ready',async()=>{
    item={...base,selectedWorkArtworkId:'cover'};
    const next=Promise.withResolvers<{url:string}>();
    mocks.native.mockImplementation(async(_op:string,payload:{revision:string})=>payload.revision==='r1'?{url:'https://example.invalid/r1'}:next.promise);
    await openWithArtwork();
    const before=artwork();
    fireEvent.click(within(actions()).getByRole('button',{name:/쇼케이스/}));
    await waitFor(()=>expect(artworkCalls().some(([, payload])=>payload.revision==='r2')).toBe(true));
    // Waiting for the new ticket never falls back to the placeholder.
    expect(document.querySelector('.collection-art-placeholder')).toBeNull();
    expect(artwork().map(image=>image.getAttribute('src'))).toEqual(['https://example.invalid/r1','https://example.invalid/r1']);
    await act(async()=>next.resolve({url:'https://example.invalid/r2'}));
    // The open detail swaps in place; the hidden list card follows once it is shown again.
    await waitFor(()=>expect(artwork()[1].getAttribute('src')).toBe('https://example.invalid/r2'));
    expect(artwork()[0].getAttribute('src')).toBe('https://example.invalid/r1');
    fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
    await waitFor(()=>expect(artwork()[0].getAttribute('src')).toBe('https://example.invalid/r2'));
    expect(document.querySelector('.collection-list .collection-art-placeholder')).toBeNull();
    artwork().slice(0,1).forEach((image,index)=>expect(image).toBe(before[index]));
  });
});

it('moves the Showcase switch once: no flip back between the server receipt and the refreshed detail',async()=>{
  await openDetail();
  // The refreshed detail arrives late, so the screen still holds the pre-edit value after the receipt.
  let release!:()=>void;const late=new Promise<void>(resolve=>{release=resolve;});
  const fallback=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(path:string,signal:unknown,body?:Record<string,unknown>)=>{
    if(path==='/v1/collections/w'){await late;}
    return fallback(path,signal,body);
  });
  const button=within(actions()).getByRole('button',{name:'쇼케이스'});
  const slot=button.querySelector('.collection-bar-pending')!;
  const pressed:(string|null)[]=[];
  const observer=new MutationObserver(()=>pressed.push(button.getAttribute('aria-pressed')));
  observer.observe(button,{attributes:true,attributeFilter:['aria-pressed']});
  fireEvent.click(button);
  expect(button.getAttribute('aria-pressed')).toBe('true');
  await waitFor(()=>expect(commands()).toHaveLength(1));
  await waitFor(()=>expect(readCollectionEdits()).toEqual({}));
  // Confirmed, detail not yet re-read: still on, same switch and the same (now empty) pending slot.
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.classList.contains('is-pending')).toBe(false);
  await act(async()=>{release();});
  await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>path==='/v1/collections/w').length).toBeGreaterThan(1));
  expect(within(actions()).getByRole('button',{name:'쇼케이스'})).toBe(button);
  expect(button.querySelector('.collection-bar-pending')).toBe(slot);
  observer.disconnect();
  expect(pressed.every(value=>value==='true')).toBe(true);
  expect(button.getAttribute('aria-pressed')).toBe('true');
});

describe('manga detail layout',()=>{
  const manga:CollectionDetail={...base,author:'서유진',publisher:'대원씨아이',year:2021,genres:'Action, Romance, isekai, Slice of Life, Action',
    volumes:[1,2,3,4].map(n=>({id:`v${n}`,volumeNumber:n,editionIndex:0,displayLabel:`${n}권`})),releaseWatch:{enabled:true,available:true},ownedVolumes:[{editionIndex:0,count:2}]};
  const column=()=>document.querySelector('.collection-detail-intro .collection-detail-identity') as HTMLElement;

  it('puts facts, Korean genres, my rating and owned volumes beside the cover, with no separate info section',async()=>{
    item={...manga};
    await openDetail();
    const info=within(column());
    expect(info.getByRole('heading',{level:1,name:'밤의 도서관'})).toBeTruthy();
    expect(info.getByText('작가 · 서유진')).toBeTruthy();
    expect(within(info.getByLabelText('작품 정보',{selector:'dl'})).getByText('대원씨아이')).toBeTruthy();
    expect(info.getByText('2021')).toBeTruthy();
    expect(within(info.getByRole('list',{name:'장르'})).getAllByRole('listitem').map(li=>li.textContent)).toEqual(['액션','로맨스','이세계','일상']);
    // 내 기록 lives inside the column: rating and owned volumes, both editable.
    expect(column().contains(personal())).toBe(true);
    fireEvent.click(within(personal()).getByRole('button',{name:/내 평점 ★ 3.0 \/ 5/}));
    expect(await screen.findByRole('dialog',{name:'내 평점'})).toBeTruthy();
    fireEvent.keyDown(document.activeElement??document.body,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'내 평점'})).toBeNull());
    // The top bar carries Showcase (off) and 신간 알림 (on) as toggles.
    expect(within(actions()).getByRole('button',{name:'쇼케이스'}).getAttribute('aria-pressed')).toBe('false');
    expect(within(actions()).getByRole('button',{name:'신간 알림'}).getAttribute('aria-pressed')).toBe('true');
    const owned=within(personal()).getByRole('button',{name:'소장 2권까지, 바꾸기'});
    expect(owned.textContent).toContain('2권까지 / 전체 4권');
    fireEvent.click(owned);
    expect(await screen.findByRole('dialog',{name:'소장 권수'})).toBeTruthy();
    // Nothing is repeated below: no 작품 정보 section, and the provider overview stays hidden.
    expect(screen.queryByRole('region',{name:'작품 정보 영역'})).toBeNull();
    expect(screen.queryByText('provider')).toBeNull();
  });

  it('shows Showcase membership read-only in the bar while the server lacks the capability',async()=>{
    item={...manga,showcase:true};capable=false;
    await openDetail();
    await act(async()=>{});
    expect(within(actions()).queryByRole('button',{name:/쇼케이스/})).toBeNull();
    expect(within(actions()).getByRole('img',{name:'쇼케이스에 추가됨'})).toBeTruthy();
    expect(within(personal()).queryByRole('button',{name:/내 평점/})).toBeNull();
  });
});
