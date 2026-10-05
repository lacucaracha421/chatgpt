import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {Catalog} from './Catalog';
import {adoptPins,flushPins,pendingPins,queuePin,visiblePins,INDEX_PATH,type PinSnapshot,type PinState} from './mangaIndexPins';
import {setOutboxConnection} from './outboxConnection';
import {ApiError} from './transport';
import type {MangaFrequentIndex,MangaIndexIdentity} from '../src/library/types';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./media',()=>({decodeImage:vi.fn()}));
vi.mock('./transport',async original=>({...await original<typeof import('./transport')>(),api:mocks.api,native:mocks.native}));
const authority={libraryId:'a'.repeat(32),epoch:1,contractVersion:1},connection='https://example.invalid';
const identity=(namespace:string,value:string,label=value):MangaIndexIdentity=>({kind:namespace==='artist'?'artist':'tag',namespace,value,label});
const tag=identity('female','tag','태그'),artist=identity('artist','john_doe','john doe');
const state=(row:MangaIndexIdentity,desiredState=true,entityRevision=1):PinState=>({...row,desiredState,entityRevision,createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'});
let snapshot:PinSnapshot,index:MangaFrequentIndex,offline:boolean;
const status={ready:true,publicationRevision:'p1',authorityLibraryId:authority.libraryId,authorityEpoch:1,authorityContractVersion:1,authorityCursor:1,capabilities:{bookmarkWrite:true,displayPreferencesVersion:1,refreshRequest:false}};
const page={ready:true,publicationRevision:'p1',publishedAt:null,items:[],nextCursor:null,context:'c',countToken:null,totalCount:0,countStatus:'ready'};
const reads=()=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/mobile-catalog/search?'));
const commands=()=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith(`${INDEX_PATH}/pins/`));
async function openSheet(){render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('검색 결과 없음');fireEvent.click(screen.getByRole('button',{name:'필터'}));return screen.findByRole('button',{name:'태그 9'});}
async function hold(button:HTMLElement){vi.useFakeTimers();fireEvent.pointerDown(button,{button:0,clientX:10,clientY:10});await act(async()=>{vi.advanceTimersByTime(500);});fireEvent.pointerUp(button,{button:0});fireEvent.click(button);vi.useRealTimers();}
beforeEach(()=>{
  setOutboxConnection(connection);localStorage.clear();vi.stubGlobal('PointerEvent',MouseEvent);
  snapshot={...authority,revision:0,items:[]};offline=false;
  index={bookmarkCount:12,tagLimit:8,artistLimit:5,tags:[{...tag,count:9},...Array.from({length:9},(_,i)=>({...identity('male',`tag${i}`),count:8-i}))],artists:[{...artist,count:6},...Array.from({length:5},(_,i)=>({...identity('artist',`artist${i}`),count:5-i}))]};
  mocks.api.mockReset();mocks.native.mockReset();mocks.native.mockResolvedValue(status);
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body:Record<string,unknown>|undefined)=>{
    if(path.startsWith(INDEX_PATH)&&offline)throw new ApiError('연결 실패',null,null);
    if(path.includes('/status'))return status;
    if(path.startsWith(`${INDEX_PATH}/frequent`))return {...index,ready:true,publicationRevision:'p1'};
    if(path.startsWith(`${INDEX_PATH}/pins/`)){
      const [kind,namespace]=path.split('/').slice(-2),row=identity(namespace,body!.value as string,body!.label as string);row.kind=kind;
      const previous=snapshot.items.find(item=>item.kind===kind&&item.namespace===namespace&&item.value===row.value);
      const next=state(row,body!.desiredState as boolean,(previous?.entityRevision??0)+1);
      snapshot={...snapshot,revision:snapshot.revision+1,items:[...snapshot.items.filter(item=>item.value!==row.value||item.namespace!==namespace),next]};
      return {...authority,revision:snapshot.revision,changed:true,...next};
    }
    if(path.startsWith(`${INDEX_PATH}/pins?`))return structuredClone(snapshot);
    return page;
  });
});
afterEach(()=>{cleanup();setOutboxConnection(null);vi.useRealTimers();vi.unstubAllGlobals();});

describe('tablet filter-sheet Manga index',()=>{
  it('shows counted pinned chips, top eight tags and top five artists before existing settings',async()=>{
    snapshot={...snapshot,revision:1,items:[state(tag)]};
    await openSheet();
    const pinned=screen.getByRole('region',{name:'고정'}),tags=screen.getByRole('region',{name:'자주 찾는 태그'}),artists=screen.getByRole('region',{name:'작가'});
    expect(within(pinned).getByRole('button',{name:'태그 9'}).querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
    expect(within(tags).getAllByRole('button')).toHaveLength(8);expect(within(artists).getAllByRole('button')).toHaveLength(5);
    expect(pinned.compareDocumentPosition(screen.getByRole('region',{name:'포함할 분류'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region',{name:'회피할 태그'})).toBeTruthy();
  });
  it('taps one tag, replaces it with an artist, then clears the list token',async()=>{
    fireEvent.click(await openSheet());
    await waitFor(()=>expect(new URL(reads().at(-1)![0],'https://x').searchParams.get('text')).toBe('female:"tag"'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(new URL(reads().at(-1)![0],'https://x').searchParams.get('sort')).toBe('latest');
    expect(screen.getByRole('button',{name:'태그 필터 빼기'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'필터 1개 적용'}));
    fireEvent.click(await screen.findByRole('button',{name:'john doe 6'}));
    await waitFor(()=>expect(new URL(reads().at(-1)![0],'https://x').searchParams.get('text')).toBe('artist:"john_doe"'));
    fireEvent.click(screen.getByRole('button',{name:'john doe 필터 빼기'}));
    // Clearing can reuse the previously cached browse page without another read.
    await waitFor(()=>expect(screen.queryByRole('button',{name:'john doe 필터 빼기'})).toBeNull());
    expect(screen.getByRole('button',{name:'카탈로그 정렬 오늘 인기'}).hasAttribute('disabled')).toBe(false);
  });
  it('adds one AND condition without changing a typed OR expression',async()=>{
    await openSheet();fireEvent.click(screen.getByRole('button',{name:'필터 닫기'}));
    fireEvent.click(screen.getByRole('button',{name:'검색'}));
    fireEvent.change(screen.getByRole('textbox',{name:'카탈로그 검색'}),{target:{value:'alpha OR beta'}});
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(screen.getByRole('button',{name:'필터'}));fireEvent.click(await screen.findByRole('button',{name:'태그 9'}));
    await waitFor(()=>expect(new URL(reads().at(-1)![0],'https://x').searchParams.get('text')).toBe('(alpha OR beta) AND female:"tag"'));
    expect((screen.getByRole('textbox',{name:'카탈로그 검색'}) as HTMLInputElement).value).toBe('alpha OR beta');
  });
  it('long-press pins and unpins without tapping a catalog filter',async()=>{
    const chip=await openSheet(),before=reads().length;
    await hold(chip);await waitFor(()=>expect(commands()).toHaveLength(1));
    const pinned=within(screen.getByRole('region',{name:'고정'})).getByRole('button',{name:'태그 9'});
    expect(commands()[0][3]).toBe('PUT');expect(commands()[0][2]).toMatchObject({value:'tag',label:'태그',desiredState:true});
    await hold(pinned);await waitFor(()=>expect(commands()).toHaveLength(2));
    expect(commands()[1][2]).toMatchObject({desiredState:false,expectedRevision:1});
    expect(reads()).toHaveLength(before);
  });
  it('cancels a long-press when the user scrolls',async()=>{
    const chip=await openSheet();vi.useFakeTimers();fireEvent.pointerDown(chip,{button:0,clientX:10,clientY:10});fireEvent.pointerMove(chip,{clientX:10,clientY:40});act(()=>vi.advanceTimersByTime(600));vi.useRealTimers();
    expect(commands()).toHaveLength(0);
  });
  it('shows the single-line empty state and quietly hides an unavailable index',async()=>{
    index={...index,bookmarkCount:0,tags:[],artists:[]};
    render(<Catalog active paused={false} backRef={{current:null}}/>);await screen.findByText('검색 결과 없음');fireEvent.click(screen.getByRole('button',{name:'필터'}));
    await screen.findByText('북마크한 작품이 생기면 자주 찾는 태그와 작가가 여기에 모입니다.');
    expect(screen.queryByRole('region',{name:'자주 찾는 태그'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'필터 닫기'}));offline=true;fireEvent.click(screen.getByRole('button',{name:'필터'}));
    await waitFor(()=>expect(screen.queryByLabelText('망가 목차')).toBeNull());expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('region',{name:'회피할 태그'})).toBeTruthy();
  });
  it('keeps an offline long-press durable and shows its existing inline error',async()=>{
    const chip=await openSheet();offline=true;await hold(chip);
    await screen.findByText(/고정 저장 대기 · 연결 실패/);expect(pendingPins(authority)).toBe(1);
    expect(visiblePins(authority)[0]).toMatchObject({...tag,pending:true});
    offline=false;await flushPins(authority);expect(pendingPins(authority)).toBe(0);
  });
});

describe('tablet pin merge and delivery',()=>{
  it('retains operation ids across a lost response and adopts server tombstones',async()=>{
    adoptPins(authority,snapshot);queuePin(authority,tag,true);
    const implementation=mocks.api.getMockImplementation()!;let first=true;
    mocks.api.mockImplementation(async(...args)=>{const reply=await implementation(...args);if(String(args[0]).startsWith(`${INDEX_PATH}/pins/`)&&first){first=false;throw new Error('lost reply');}return reply;});
    await expect(flushPins(authority)).rejects.toThrow('lost reply');
    const operation=commands()[0][2].operationId;
    // Replay the original durable receipt, as the real server does.
    mocks.api.mockImplementation(async(...args)=>String(args[0]).startsWith(`${INDEX_PATH}/pins/`)?{...authority,revision:1,...state(tag)}:implementation(...args));
    await flushPins(authority);expect(commands()[1][2].operationId).toBe(operation);expect(pendingPins(authority)).toBe(0);
    adoptPins(authority,{...authority,revision:2,items:[state(tag,false,2)]});expect(visiblePins(authority)).toEqual([]);
  });
  it('rebases a conflict and protects superseding intent from an acknowledgement',async()=>{
    adoptPins(authority,snapshot);queuePin(authority,tag,true);
    const implementation=mocks.api.getMockImplementation()!;let conflicts=0;
    mocks.api.mockImplementation(async(...args)=>{
      if(String(args[0]).startsWith(`${INDEX_PATH}/pins/`)){
        if(conflicts++===0)throw new ApiError('conflict',409,{code:'revisionConflict',authorityCursor:2,current:state(tag,false,2)});
        expect(args[2]).toMatchObject({expectedRevision:2});queuePin(authority,tag,false);
        snapshot={...authority,revision:3,items:[state(tag,true,3)]};return {...authority,revision:3,...state(tag,true,3)};
      }
      return implementation(...args);
    });
    await flushPins(authority);expect(commands()[0][2].operationId).not.toBe(commands()[1][2].operationId);
    expect(pendingPins(authority)).toBe(1);expect(visiblePins(authority)).toEqual([]);
  });
  it('fences libraries, preserves another connection queue, and refuses malformed snapshots',async()=>{
    adoptPins(authority,snapshot);queuePin(authority,tag,true);
    setOutboxConnection('https://other.invalid');expect(pendingPins(authority)).toBe(0);await flushPins(authority);expect(commands()).toHaveLength(0);
    setOutboxConnection(connection);expect(pendingPins(authority)).toBe(1);
    expect(()=>adoptPins(authority,{...snapshot,libraryId:'b'.repeat(32)})).toThrow();
    expect(()=>adoptPins(authority,{...snapshot,revision:1,items:[state(tag),state(tag)]})).toThrow();
  });
});
