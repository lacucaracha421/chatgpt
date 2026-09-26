import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import type {CharacterIndex} from './characterModel';

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:vi.fn(),
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}},
  errorText:(error:Error)=>error.message}));
vi.mock('./media',()=>({loadThumbnail:vi.fn((asset:Asset)=>Promise.resolve({...asset,preview:`thumb:${asset.id}`}))}));
import {ApiError} from './transport';
import {CharacterReviewOverview} from './CharacterReviewOverview';
import {groupReviewItems,OVERVIEW_PAGE,OVERVIEW_PAGES} from './useCharacterReview';
import {commitReviewDecision} from './characterReviewOutbox';
import {setOutboxConnection} from './outboxConnection';
import {clockLabel} from './homeDashboard';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const LIBRARY='e'.repeat(32);
const node=(kind:'series'|'character',sourceId:string,seriesId:string,name:string,thumbnailAssetId:string|null=null)=>({id:`${kind}:${sourceId}`,kind,sourceId,seriesId,parentId:null,name,description:'',thumbnailAssetId,manualOnly:false,excluded:false});
const index={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false,characterReview:true},libraryId:LIBRARY,ready:true,revision:'a'.repeat(64),publishedAt:null,scopes:[],
  nodes:[node('series','yuri','yuri','백합','cover-yuri'),node('character','lara','yuri','라라','p-lara'),node('character','mari','yuri','마리'),node('series','wuwa','wuwa','명조'),node('character','rover','wuwa','방랑자')]} as CharacterIndex;
const targets={lara:{name:'라라',seriesId:'yuri',seriesName:'백합',references:[]},mari:{name:'마리',seriesId:'yuri',seriesName:'백합',references:[]},rover:{name:'방랑자',seriesId:'wuwa',seriesName:'명조',references:[]}};
const candidates=(spec:[string,number][],from=0)=>spec.flatMap(([targetId,count])=>Array.from({length:count},(_,i)=>({targetId,assetId:`${targetId}-${from+i}`,sources:['s36'],verdict:'recommended',knn3:null,basis:'b',asset:{id:`${targetId}-${from+i}`,kind:'image'}})));
const head=(total:number,extra:Record<string,unknown>={})=>({version:1,ready:true,counts:{total},items:[],targets:{},nextCursor:null,hasMore:false,...extra});
const reads=()=>mocks.api.mock.calls.map(([path])=>new URLSearchParams(String(path).split('?')[1]));

function mount(refreshKey:unknown=0){
  const onOpen=vi.fn(),onClose=vi.fn(),back={current:null as (()=>boolean)|null};
  const view=render(<CharacterReviewOverview libraryId={LIBRARY} characters={index} refreshKey={refreshKey} paused={false} backRef={back} onOpen={onOpen} onClose={onClose}/>);
  return {onOpen,onClose,back,rerender:(key:unknown)=>view.rerender(<CharacterReviewOverview libraryId={LIBRARY} characters={index} refreshKey={key} paused={false} backRef={back} onOpen={onOpen} onClose={onClose}/>)};
}
const section=(name:RegExp)=>screen.getByRole('region',{name});

beforeEach(()=>{setOutboxConnection('https://a.example');localStorage.clear();mocks.api.mockReset();});
afterEach(()=>{cleanup();localStorage.clear();});

describe('character review overview',()=>{
  it('groups candidates by series and character, busiest first, leaving queued pairs out',()=>{
    const groups=groupReviewItems(candidates([['lara',5],['rover',1],['mari',2]]) as never,targets,new Set(['lara:lara-0']));
    expect(groups).toEqual([
      {seriesId:'yuri',seriesName:'백합',count:6,characters:[{id:'lara',name:'라라',count:4},{id:'mari',name:'마리',count:2}]},
      {seriesId:'wuwa',seriesName:'명조',count:1,characters:[{id:'rover',name:'방랑자',count:1}]},
    ]);
  });

  it('uses the exact per-character counts in one request, less queued decisions, and opens scoped reviews',async()=>{
    commitReviewDecision({libraryId:LIBRARY,targetId:'lara',assetId:'x1',decision:'accepted',origin:'feed',basis:'b'});
    mocks.api.mockResolvedValue(head(12,{countsByTarget:[{targetId:'lara',seriesId:'yuri',pending:6},{targetId:'mari',seriesId:'yuri',pending:2},{targetId:'rover',seriesId:'wuwa',pending:4},{targetId:'gone',seriesId:'wuwa',pending:0}]}));
    const {onOpen,onClose,back}=mount();
    const yuri=await screen.findByRole('region',{name:'백합 7건'});
    expect(reads()).toHaveLength(1);
    expect(reads()[0].get('limit')).toBe('1');
    expect(screen.getByText('대기 11건 · 시리즈 2')).toBeTruthy();
    // Names and portraits come from the character index.
    expect(within(yuri).getAllByRole('button').map(button=>button.getAttribute('aria-label'))).toEqual(['백합 전체 검토 7건','라라 검토 5건','마리 검토 2건']);
    expect(section(/^명조/).textContent).toContain('방랑자4');
    expect(screen.queryByText(/^외/)).toBeNull();
    await vi.waitFor(()=>expect([...yuri.querySelectorAll('img')].map(img=>img.getAttribute('src'))).toEqual(['thumb:cover-yuri','thumb:p-lara']));
    fireEvent.click(screen.getByRole('button',{name:'백합 전체 검토 7건'}));
    expect(onOpen).toHaveBeenLastCalledWith({series:{id:'yuri',name:'백합'},serverSeries:true});
    fireEvent.click(screen.getByRole('button',{name:'마리 검토 2건'}));
    expect(onOpen).toHaveBeenLastCalledWith({target:{id:'mari',name:'마리'}});
    fireEvent.click(screen.getByRole('button',{name:'전체 검토'}));
    expect(onOpen).toHaveBeenLastCalledWith({target:null});
    expect(back.current?.()).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('without per-character counts pages the whole list, series reviews filter locally, and re-reads on refresh',async()=>{
    const pages=[candidates([['lara',3],['rover',1]]),candidates([['lara',2],['mari',2]],10),candidates([['mari',1]],20)];
    mocks.api.mockImplementation(async(path:string)=>{
      const query=new URLSearchParams(path.split('?')[1]);
      if(query.get('limit')==='1')return head(9);
      const page=Number(query.get('cursor')??0);
      return head(9,{items:pages[page],targets,nextCursor:page<2?String(page+1):null,hasMore:page<2});
    });
    const {onOpen,rerender}=mount(0);
    expect(await screen.findByRole('region',{name:'백합 8건'})).toBeTruthy();
    expect(reads().map(query=>[query.get('limit'),query.get('cursor')])).toEqual([['1',null],[String(OVERVIEW_PAGE),null],[String(OVERVIEW_PAGE),'1'],[String(OVERVIEW_PAGE),'2']]);
    expect(screen.getByRole('button',{name:'라라 검토 5건'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'마리 검토 3건'})).toBeTruthy();
    expect(screen.queryByText(/^외/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'명조 전체 검토 1건'}));
    expect(onOpen).toHaveBeenLastCalledWith({series:{id:'wuwa',name:'명조'},serverSeries:false});
    // A review closed over it: counts are read again.
    pages[0]=candidates([['lara',3]]);
    rerender(1);
    await vi.waitFor(()=>expect(screen.queryByRole('region',{name:/^명조/})).toBeNull());
  });

  it('caps the paging and shows the rest as 외 N건',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{
      const query=new URLSearchParams(path.split('?')[1]);
      if(query.get('limit')==='1')return head(5000);
      const page=Number(query.get('cursor')??0);
      return head(5000,{items:candidates([['lara',OVERVIEW_PAGE]],page*OVERVIEW_PAGE),targets,nextCursor:String(page+1),hasMore:true});
    });
    mount();
    const shown=OVERVIEW_PAGES*OVERVIEW_PAGE;
    expect(await screen.findByRole('region',{name:`백합 ${shown}건`})).toBeTruthy();
    expect(reads()).toHaveLength(OVERVIEW_PAGES+1);
    expect(screen.getByText(/^외/).textContent).toBe(`외 ${5000-shown}건 · 전체 검토에서 이어서 볼 수 있습니다.`);
  });

  it('offline: shows the last overview with its time, or a clear offline state',async()=>{
    mocks.api.mockRejectedValue(new ApiError('offline',null,null));
    mount();
    expect(await screen.findByRole('heading',{name:'오프라인입니다'})).toBeTruthy();
    cleanup();
    mocks.api.mockReset();
    mocks.api.mockResolvedValue(head(3,{countsByTarget:[{targetId:'lara',seriesId:'yuri',pending:3}]}));
    mount();
    await screen.findByRole('region',{name:'백합 3건'});
    const at=JSON.parse(localStorage.getItem('lakomics.characters.review.overview.v1')!).value.at;
    cleanup();
    mocks.api.mockReset();
    mocks.api.mockRejectedValue(new ApiError('offline',null,null));
    mount();
    expect(await screen.findByText(`${clockLabel(at)} 기준`)).toBeTruthy();
    expect(screen.getByRole('button',{name:'라라 검토 3건'})).toBeTruthy();
  });

  it('says when no PC has published a review list yet',async()=>{
    mocks.api.mockResolvedValue({version:1,ready:false,counts:{total:0},items:[],targets:{}});
    mount();
    expect(await screen.findByRole('heading',{name:'PC 업데이트가 필요합니다'})).toBeTruthy();
  });
});
