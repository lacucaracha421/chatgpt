import type {ReactNode} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import type {HomeProps} from './Home';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'connection failed',
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:({items,onOpen,onSelect,recentFolders,classifications}:HomeProps)=><div>{classifications.map(f=><button key={f.id} onClick={()=>onSelect({tab:"library",classification:f.id,title:f.name})}>{`${f.name}, ${f.asset_count}개`}</button>)}<button onClick={()=>onSelect({tab:'library',title:'최근 저장'})}>전체 보기</button><span>{`recent-folders:${recentFolders.join(',')}`}</span>{items.slice(0,12).map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div>}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onOpen,onNearEnd,restoreScroll,onScroll}:{intro?:ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;restoreScroll?:number;onScroll?(top:number):void})=><div aria-label="자산 목록" data-restore-scroll={restoreScroll} onScroll={()=>{onNearEnd();onScroll?.(420);}}>{intro}{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}</div>}));
vi.mock('./Viewer',()=>({Viewer:({items,index,onIndex,onClose}:{items:Asset[];index:number;onIndex(i:number):void;onClose():void})=><div><span>{`viewer-${items[index].id}`}</span><button onClick={()=>onIndex(1)}>viewer next</button><button onClick={onClose}>viewer close</button></div>}));
import {App} from './App';
import {ApiError} from './transport';
import {outboxConnection,setOutboxConnection} from './outboxConnection';
const a=[{id:'a1',kind:'image'},{id:'a2',kind:'image'}],b=[{id:'b1',kind:'image'},{id:'b2',kind:'image'}];
async function openFolder(name:string){
  if(!screen.queryByRole('button',{name})){
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
    await screen.findByRole('heading',{name:'라이브러리'});
  }
  fireEvent.click(await screen.findByRole('button',{name}));
}
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockReset();
  mocks.native.mockResolvedValue({configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/list-generation')return {generation:'a'.repeat(64)};
    if(path.includes('classifications'))return{items:[{id:'b',name:'분류 B',asset_count:2,parent_id:null}]};
    if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
    return{items:path.includes('classification_id=b')?b:a,has_more:false,next_cursor:null};
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('points the durable outboxes at the configured connection as soon as the status arrives',async()=>{
  setOutboxConnection(null);
  render(<App/>);
  await waitFor(()=>expect(outboxConnection()).toBe('https://example.invalid'));
});
it('opens character browsing inside Library and uses Android back for its parent',async()=>{
  const original=mocks.api.getMockImplementation()!;
  const revision='a'.repeat(64);
  mocks.api.mockImplementation((path:string)=>{
    if(path==='/v1/library/characters')return Promise.resolve({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'series:s',sourceId:'s',seriesId:'s',kind:'series',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},{id:'group:g',sourceId:'g',seriesId:'s',kind:'group',parentId:'series:s',name:'Group',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2}]});
    if(path.startsWith('/v1/library/characters/assets'))return Promise.resolve({revision,items:b,totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
    return original(path);
  });
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  await openFolder('Series, 2개');
  await screen.findByText('tile-b1');
  // A directly opened folder is a top-level entry, so Back returns to Library instead
  // of consuming the press for a bare Series overview. All is the Library default, so the
  // restore target is the canonical All heading rather than the removed Recent tab.
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('heading',{name:'라이브러리'});
  expect(screen.queryByRole('region',{name:'시리즈·캐릭터'})).toBeNull();
});

it('returns from a directly opened character folder to the non-home folder and scroll it was opened from',async()=>{
  const original=mocks.api.getMockImplementation()!;
  const revision='a'.repeat(64);
  mocks.api.mockImplementation((path:string)=>{
    if(path.includes('classifications'))return Promise.resolve({items:[{id:'b',name:'분류 B',asset_count:2,parent_id:null},{id:'s',name:'Series',asset_count:2,parent_id:'b'}]});
    if(path==='/v1/library/characters')return Promise.resolve({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'series:s',sourceId:'s',seriesId:'s',kind:'series',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2}]});
    if(path.startsWith('/v1/library/characters/assets'))return Promise.resolve({revision,items:b,totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
    return original(path);
  });
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  // Start in a non-home Library folder and scroll it, so a Home fallback cannot pass.
  await openFolder('분류 B, 2개');
  await screen.findByText('tile-b1');
  expect(screen.getByRole('heading',{name:'분류 B'})).toBeTruthy();
  fireEvent.scroll(screen.getByLabelText('자산 목록'));
  fireEvent.click(await screen.findByRole('button',{name:'Series, 2개'}));
  await screen.findByText('tile-b1');
  await screen.findByRole('heading',{name:'Series'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  // Back restores the folder that was actually open, not Home.
  await waitFor(()=>expect(screen.getByRole('heading',{name:'분류 B'})).toBeTruthy());
  expect(screen.queryByText('tile-a1')).toBeNull();
  await waitFor(()=>expect(screen.getAllByLabelText('자산 목록').find(element=>!element.closest('[style="display: none;"]'))?.getAttribute('data-restore-scroll')).toBe('420'));
});

it('keeps the original context when another character folder is selected before leaving',async()=>{
  const original=mocks.api.getMockImplementation()!;
  const revision='a'.repeat(64);
  mocks.api.mockImplementation((path:string)=>{
    if(path==='/v1/library/characters')return Promise.resolve({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'series:s',sourceId:'s',seriesId:'s',kind:'series',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},{id:'series:t',sourceId:'t',seriesId:'t',kind:'series',parentId:null,name:'Other series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'series:t',filter:'all',totalCount:2,sourceCount:2}]});
    if(path.startsWith('/v1/library/characters/assets'))return Promise.resolve({revision,items:b,totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
    return original(path);
  });
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  await openFolder('Series, 2개');
  await screen.findByText('tile-b1');
  // Selecting another folder inside the boundary must not stack a synthetic character parent.
  await openFolder('Other series, 2개');
  await screen.findByRole('heading',{name:'Other series'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('heading',{name:'라이브러리'});
  expect(screen.queryByRole('heading',{name:'Series'})).toBeNull();
});

it('steps up the character hierarchy while drilled down inside the browser',async()=>{
  const original=mocks.api.getMockImplementation()!;
  const revision='a'.repeat(64);
  mocks.api.mockImplementation((path:string)=>{
    if(path==='/v1/library/characters')return Promise.resolve({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'series:s',sourceId:'s',seriesId:'s',kind:'series',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},{id:'group:g',sourceId:'g',seriesId:'s',kind:'group',parentId:'series:s',name:'Group',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2}]});
    if(path.startsWith('/v1/library/characters/assets'))return Promise.resolve({revision,items:b,totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
    return original(path);
  });
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  await openFolder('Series, 2개');
  await screen.findByText('tile-b1');
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
  await screen.findByText('tile-b1');
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('button',{name:'Group · 2개'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('heading',{name:'라이브러리'});
});

it('keeps visited Catalog and Notes panels separate when returning Home',async()=>{
  const api=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/mobile-catalog')?Promise.resolve({ready:true,publicationRevision:'p1',items:[],totalCount:0,countStatus:'ready',context:'c',nextCursor:null}):api(path));
  mocks.native.mockImplementation(async(op:string)=>op.startsWith('notes')?{unlocked:true,notes:[]}:{configured:true,endpoint:'https://example.invalid'});
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  fireEvent.click(screen.getByRole('button',{name:'Catalog',exact:true}));await screen.findByRole('region',{name:'만화 카탈로그'});
  fireEvent.click(screen.getByRole('button',{name:'Notes',exact:true}));await screen.findByRole('button',{name:'동기화',exact:true});
  fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));await screen.findByText('tile-a1');
  expect(screen.queryByRole('button',{name:'동기화',exact:true})).toBeNull();expect(screen.queryByRole('region',{name:'메모',exact:true})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Catalog',exact:true}));await screen.findByRole('region',{name:'만화 카탈로그'});expect(screen.queryByRole('button',{name:'동기화',exact:true})).toBeNull();
});
it('keeps root Albums live so near-end pagination can append',async()=>{
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  const originalApi=mocks.api.getMockImplementation()!;
  mocks.native.mockImplementation(async(op:string)=>op==='albumTree'
    ? {adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[{id:'root',name:'업로드용',parentId:null,iconKey:null,colorKey:null}]}
    : {configured:true,endpoint:'https://example.invalid'});
  mocks.api.mockImplementation((path:string)=>{
    if(path.startsWith('/v1/albums/assets?')){
      const cursor=new URLSearchParams(path.split('?')[1]).get('cursor');
      return Promise.resolve(cursor
        ? {items:[{id:'album-2',kind:'image'}],hasMore:false,nextCursor:null}
        : {items:[{id:'album-1',kind:'image'}],hasMore:true,nextCursor:'album-next'});
    }
    return originalApi(path);
  });
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
  fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
  fireEvent.click(await screen.findByRole('tab',{name:'앨범'}));
  fireEvent.click(await screen.findByText('업로드용'));
  const first=await screen.findByText('tile-album-1');
  fireEvent.scroll(first.parentElement!);
  await screen.findByText('tile-album-2');
  expect(mocks.api.mock.calls.some(([path])=>String(path).includes('cursor=album-next'))).toBe(true);
});

describe('committed view and browsing',()=>{
  it('renders metadata without waiting for thumbnails and appends past 100 without replacing the view',async()=>{
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>{
      if(!path.startsWith('/v1/library/assets?')) return original(path);
      const offset=Number(new URLSearchParams(path.split('?')[1]).get('cursor') ?? 0);
      return Promise.resolve({items:Array.from({length:40},(_,i)=>({id:`n${offset+i}`,kind:'image'})),has_more:offset<80,next_cursor:offset<80?String(offset+40):null});
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-n0');
    // All is the committed Library view on launch, so the gallery is already the target.
    await screen.findByLabelText('자산 목록');
    const first=screen.getByText('tile-n0');
    expect(screen.queryByText('아래로 스크롤하면 계속 이어집니다')).toBeNull();
    expect(document.querySelector('.page-footer')).toBeNull();
    await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('cursor=40'))).toBe(true));
    fireEvent.scroll(screen.getByLabelText('자산 목록')); await screen.findByText('tile-n79');
    fireEvent.scroll(screen.getByLabelText('자산 목록')); await screen.findByText('tile-n119');
    expect(screen.getByText('tile-n0')).toBe(first);
    expect(screen.queryByRole('button',{name:'더 불러오기'})).toBeNull();
    fireEvent.click(screen.getByText('tile-n119'));
    expect(screen.getByText('viewer-n119')).toBeTruthy();
  });
  it('rejects a late appended page after changing classification',async()=>{
    const original=mocks.api.getMockImplementation()!; let resolveMore!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>{
      if(path.includes('cursor=next')) return new Promise(resolve=>{resolveMore=resolve;});
      if(path.startsWith('/v1/library/assets?') && !path.includes('classification_id')) return Promise.resolve({items:a,has_more:true,next_cursor:'next'});
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    await screen.findByLabelText('자산 목록');
    fireEvent.scroll(screen.getByLabelText('자산 목록'));
    await openFolder('분류 B, 2개'); await screen.findByText('tile-b1');
    await act(async()=>{resolveMore({items:[{id:'late',kind:'image'}],has_more:false,next_cursor:null});});
    expect(screen.queryByText('tile-late')).toBeNull(); expect(screen.getByText('tile-b1')).toBeTruthy();
  });
  it('retains loaded items on append failure and deduplicates the retry',async()=>{
    const original=mocks.api.getMockImplementation()!; let fail=true;
    mocks.api.mockImplementation((path:string)=>{
      if(path.includes('cursor=next')) return fail ? Promise.reject(new Error('offline')) : Promise.resolve({items:[a[1],...b],has_more:false,next_cursor:null});
      if(path.startsWith('/v1/library/assets?')) return Promise.resolve({items:a,has_more:true,next_cursor:'next'});
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    await screen.findByLabelText('자산 목록');
    fireEvent.scroll(screen.getByLabelText('자산 목록')); await screen.findByText('connection failed');
    expect(screen.getByText('tile-a1')).toBeTruthy(); fail=false;
    fireEvent.click(screen.getByRole('button',{name:'다시 시도'})); await screen.findByText('tile-b1');
    expect(screen.getAllByText('tile-a2')).toHaveLength(1);
  });
  it('starts Home directly with recent media and has no Continue section',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    expect(screen.queryByText('다시, 이어서.')).toBeNull();
    expect(screen.queryByRole('button',{name:/이어보기/})).toBeNull();
  });
  it('opening the retained gallery cancels a pending replacement and keeps viewer provenance',async()=>{
    const original=mocks.api.getMockImplementation()!; let resolveB!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>path.includes('classification_id=b')?new Promise(resolve=>{resolveB=resolve;}):original(path));
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));
    await screen.findByRole('button',{name:'전체 보기'});
    await openFolder('분류 B, 2개');
    await waitFor(()=>expect(resolveB).toBeTypeOf('function'));
    expect(screen.getByText('tile-a1')).toBeTruthy();
    fireEvent.click(screen.getByText('tile-a1'));
    await act(async()=>{resolveB({items:b,has_more:false,next_cursor:null});});
    fireEvent.click(screen.getByText('viewer next')); fireEvent.click(screen.getByText('viewer close'));
    expect(screen.getByText('tile-a1')).toBeTruthy(); expect(screen.queryByText('tile-b1')).toBeNull();
  });
  it('does not reload or remount committed Home on reselect or return from Collections',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));
    await screen.findByRole('button',{name:'전체 보기'});
    const first=screen.getByText('tile-a1');
    const reads=()=>mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')||path==='/v1/library/list-generation'||path.includes('/revisit?')||path.includes('/captures/pending')).length;
    const count=reads();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));});
    expect(reads()).toBe(count);
    fireEvent.click(screen.getByRole('button',{name:'Collections',exact:true}));
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));});
    expect(reads()).toBe(count);
    expect(screen.getByText('tile-a1')).toBe(first);
  });
  it.each(['success','failure'])('keeps the latest Home intent when a superseded folder request ends in %s',async(result)=>{
    const original=mocks.api.getMockImplementation()!;
    let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void,signal!:AbortSignal;
    mocks.api.mockImplementation((path:string,requestSignal:AbortSignal)=>path.includes('classification_id=b')?new Promise((done,fail)=>{resolve=done;reject=fail;signal=requestSignal;}):original(path,requestSignal));
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true})); await screen.findByRole('button',{name:'전체 보기'});
    await openFolder('분류 B, 2개');
    await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));
    expect(signal.aborted).toBe(true);
    await act(async()=>{if(result==='success')resolve({items:b,has_more:false,next_cursor:null});else reject(new Error('late failure'));});
    expect(screen.getByRole('button',{name:'전체 보기'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'Home',exact:true}).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText('tile-b1')).toBeNull();
    expect(screen.queryByText('connection failed')).toBeNull();
    expect(screen.queryByLabelText('목록 불러오는 중')).toBeNull();
  });
  it.each(['Home','Library'])('refreshes retained %s on area return when generation checks are unavailable',async(tab)=>{
    const original=mocks.api.getMockImplementation()!; let changed=false;
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/list-generation')return Promise.reject(new ApiError('missing',404,null));
      if(changed&&path.startsWith('/v1/library/assets?'))return Promise.resolve({items:[{id:'updated',kind:'image'}],has_more:false,next_cursor:null});
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    if(tab==='Home'){
      fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));await screen.findByRole('button',{name:'전체 보기'});
    }else{
      await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
      fireEvent.scroll(screen.getByLabelText('자산 목록'));
    }
    fireEvent.click(screen.getByRole('button',{name:'Collections',exact:true}));changed=true;
    fireEvent.click(screen.getByRole('button',{name:tab,exact:true}));
    await screen.findByText('tile-updated');
    expect(screen.queryByText('tile-a1')).toBeNull();expect(screen.queryByText('tile-b1')).toBeNull();
    if(tab==='Library'){
      expect(screen.getByRole('heading',{name:'분류 B'})).toBeTruthy();
      await waitFor(()=>expect(screen.getAllByLabelText('자산 목록').find(element=>!element.closest('[style="display: none;"]'))?.getAttribute('data-restore-scroll')).toBe('420'));
    }
  });
  it('does not restart initial navigation when the delayed filter capability arrives',async()=>{
    const original=mocks.api.getMockImplementation()!; let probe=0,resolveCapability!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/list-generation'&&++probe===2)return new Promise(resolve=>{resolveCapability=resolve;});
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개'); await screen.findByText('tile-b1');
    const reads=mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')).length;
    await act(async()=>{resolveCapability({generation:'a'.repeat(64),filterVersion:1});});
    expect(screen.getByRole('heading',{name:'분류 B'})).toBeTruthy();
    expect(screen.getByText('tile-b1')).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?'))).toHaveLength(reads);
  });
  it('restores the last Library classification when switching tabs',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개'); await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true})); await screen.findByText('tile-a1');
    expect(screen.getByText('recent-folders:b')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
    await waitFor(()=>expect(screen.getByText('tile-b1')).toBeTruthy());
  });
  it('active Library returns to root and Back there finishes',async()=>{
    render(<App/>);await screen.findByRole('heading',{name:'라이브러리'});
    fireEvent.click(await screen.findByRole('button',{name:'분류 B, 2개'}));await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));
    await screen.findByRole('heading',{name:'라이브러리'});
    act(()=>window.dispatchEvent(new Event('lakomics-back')));
    await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('finish'));
  });
  it('leaves another area for the assets area when a Library folder is already committed',async()=>{
    // Area and the committed view can disagree: the user is in Catalog while the last Library
    // view is still a folder. Pressing Library must actually return to assets, not no-op.
    const api=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/mobile-catalog')?Promise.resolve({ready:true,publicationRevision:'p1',items:[],totalCount:0,countStatus:'ready',context:'c',nextCursor:null}):api(path));
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개'); await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Catalog',exact:true}));
    await screen.findByRole('region',{name:'만화 카탈로그'});
    const reads=mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')||path==='/v1/library/list-generation').length;
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));});
    expect(screen.queryByRole('region',{name:'만화 카탈로그'})).toBeNull();
    expect(screen.getByText('tile-b1')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'분류 B'})).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')||path==='/v1/library/list-generation')).toHaveLength(reads);
  });
});

it('uses drill-down in both orientations and keeps settings only on Home',async()=>{
  render(<App/>);await screen.findByRole('heading',{name:'라이브러리'});
  expect(screen.queryByRole('button',{name:'사이드바 열기'})).toBeNull();
  expect(document.querySelector('.desktop-index')).toBeNull();
  expect(screen.queryByRole('heading',{name:'최근 연 폴더'})).toBeNull();
  expect(document.querySelector('.classification-tree')).toBeNull();
  expect(screen.queryByRole('button',{name:'연결 및 설정'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));
  await screen.findByRole('button',{name:'연결 및 설정'});
  fireEvent.click(screen.getByRole('button',{name:'Collections',exact:true}));
  expect(screen.queryByRole('button',{name:'연결 및 설정'})).toBeNull();
  // Collections draws its own title bar, so the shared bar and its sidebar button are absent.
  expect(document.querySelector('.app-header')).toBeNull();
  expect(screen.queryByRole('button',{name:'사이드바 열기'})).toBeNull();
  // Catalog and Notes also draw their own title bars; no area offers the old sidebar.
  for(const area of ['Catalog','Notes']){
    fireEvent.click(screen.getByRole('button',{name:area,exact:true}));
    expect(screen.queryByRole('button',{name:'연결 및 설정'})).toBeNull();
    expect(document.querySelector('.app-header')).toBeNull();
    expect(screen.queryByRole('button',{name:'사이드바 열기'})).toBeNull();
  }
});
it('sets the thumbnail size with a slider, stores it and counts only a size other than the default',async()=>{
  localStorage.setItem('lakomics.mobile.density','0');
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  // A pre-slider stored value (0 = 크게) is still honoured, and it differs from 균형.
  const opener=screen.getByRole('button',{name:'보기 옵션'});
  expect(opener.classList.contains('is-changed')).toBe(true);
  opener.focus();fireEvent.click(opener);
  const slider=screen.getByRole('slider',{name:'썸네일 크기'}) as HTMLInputElement;
  expect(slider.value).toBe('0');expect(slider.getAttribute('aria-valuetext')).toBe('크게');
  fireEvent.change(slider,{target:{value:'3'}});
  expect(localStorage.getItem('lakomics.mobile.density')).toBe('1.5');
  expect(slider.getAttribute('aria-valuetext')).toBe('조금 촘촘하게');
  fireEvent.change(slider,{target:{value:'2'}});
  expect(slider.getAttribute('aria-valuetext')).toBe('균형 · 기본');
  expect(localStorage.getItem('lakomics.mobile.density')).toBe('1');
  act(()=>window.dispatchEvent(new Event('lakomics-back')));expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(()=>expect(document.activeElement).toBe(opener));
  expect(opener.classList.contains('is-changed')).toBe(false);
  expect(screen.getByRole('heading',{name:'모든 자산'})).toBeTruthy();
});
it('walks root, parent, child, Back, Back, root, finish and supports breadcrumb jumps',async()=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.includes('classifications')?Promise.resolve({items:[{id:'p',name:'Parent',asset_count:2,parent_id:null},{id:'b',name:'Child',asset_count:2,parent_id:'p'},{id:'g',name:'Grandchild',asset_count:2,parent_id:'b'}]}):original(path));
  render(<App/>);await screen.findByRole('heading',{name:'라이브러리'});
  fireEvent.click(await screen.findByRole('button',{name:'Parent, 2개'}));await screen.findByRole('heading',{name:'Parent'});
  fireEvent.scroll(screen.getByLabelText('자산 목록'));
  fireEvent.click(screen.getByRole('button',{name:'Child, 2개'}));await screen.findByRole('heading',{name:'Child'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));await screen.findByRole('heading',{name:'Parent'});
  await waitFor(()=>expect(screen.getAllByLabelText('자산 목록').find(element=>!element.closest('[style="display: none;"]'))?.getAttribute('data-restore-scroll')).toBe('420'));
  act(()=>window.dispatchEvent(new Event('lakomics-back')));await screen.findByRole('heading',{name:'라이브러리'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('finish'));
  fireEvent.click(screen.getByRole('button',{name:'Parent, 2개'}));await screen.findByRole('heading',{name:'Parent'});
  fireEvent.click(screen.getByRole('button',{name:'Child, 2개'}));await screen.findByRole('heading',{name:'Child'});
  fireEvent.click(screen.getByRole('button',{name:'Grandchild, 2개'}));await screen.findByRole('heading',{name:'Grandchild'});
  fireEvent.click(within(screen.getByRole('navigation',{name:'현재 위치'})).getByRole('button',{name:'Parent'}));await screen.findByRole('heading',{name:'Parent'});
  fireEvent.click(screen.getByRole('button',{name:'라이브러리',exact:true}));await screen.findByRole('heading',{name:'라이브러리'});
});

describe('server list generation',()=>{
  function fixture(){
    let revision=0;let items=a;
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/list-generation')return {generation:revision.toString(16).padStart(64,'0')};
      if(path.startsWith('/v1/library/assets'))return {items,has_more:false,next_cursor:null};
      return original(path);
    });
    return {change(next:typeof a){revision++;items=next;},generation(){return revision.toString(16).padStart(64,'0');}};
  }
  it.each(['mobile assignment','remote assignment','remote trash','remote tombstone'])('%s removes an Asset from cached A on foreground',async()=>{
    const server=fixture();render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    await screen.findByLabelText('자산 목록');
    server.change([]);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
    await waitFor(()=>expect(screen.queryByText('tile-a1')).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));
    await waitFor(()=>expect(screen.queryByText('tile-a1')).toBeNull());
  });
  it('remote restore returns the same ID and new canonical Assets appear without restart',async()=>{
    const server=fixture();render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    server.change([]);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
    await waitFor(()=>expect(screen.queryByText('tile-a1')).toBeNull());
    server.change(a);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
    await screen.findByText('tile-a1');
    server.change([...a,...b]);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
    await screen.findByText('tile-b1');
  });
  it('has no periodic list-generation fetch while idle; native events refresh it',async()=>{
    const server=fixture();render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    await act(async()=>{});vi.useFakeTimers();
    try{
      const before=mocks.api.mock.calls.filter(([path])=>path==='/v1/library/list-generation').length;
      await act(()=>vi.advanceTimersByTimeAsync(180_000));
      expect(mocks.api.mock.calls.filter(([path])=>path==='/v1/library/list-generation')).toHaveLength(before);
      server.change([]);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
      await act(async()=>{});expect(screen.queryByText('tile-a1')).toBeNull();
    }finally{vi.useRealTimers();}
  });
  // A server that predates the generation endpoint answers 404. The list fetch must
  // survive that: generation invalidation is an optimization over the canonical read,
  // so an unsupported optimization cannot be allowed to empty the library. This was a
  // real regression - Home rendered nothing but "동기화된 자산이 없습니다" against the
  // deployed server whose only fault was not having the route yet.
  it('still loads the list when the server has no list-generation endpoint',async()=>{
    const missing=()=>new ApiError('요청한 정보를 찾을 수 없습니다.',404,null);
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/list-generation')throw missing();
      if(path.includes('classifications'))return{items:[{id:'b',name:'분류 B',asset_count:2,parent_id:null}]};
      if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
      return{items:a,has_more:false,next_cursor:null};
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    await screen.findByText('tile-a1');
    expect(screen.queryByText(/찾을 수 없습니다/)).toBeNull();
  });
  it('keeps paging when the server has no list-generation endpoint',async()=>{
    const missing=()=>new ApiError('요청한 정보를 찾을 수 없습니다.',404,null);
    // Keyed on the cursor so concurrent Home requests cannot be mistaken for pages.
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/list-generation')throw missing();
      if(path.includes('classifications'))return{items:[{id:'b',name:'분류 B',asset_count:2,parent_id:null}]};
      if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
      return path.includes('cursor=c1')
        ? {items:b,has_more:false,next_cursor:null}
        : {items:a,has_more:true,next_cursor:'c1'};
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    await screen.findByLabelText('자산 목록');
    fireEvent.scroll(screen.getByLabelText('자산 목록'));
    await screen.findByText('tile-b1');
  });
  // Without a generation the cache cannot be validated, so a revisit must refetch
  // rather than serve a page a mutation may have invalidated. This is what keeps the
  // stale-view bug closed on a server that predates the endpoint.
  it('refetches a revisited classification when the server has no generation endpoint',async()=>{
    const missing=()=>new ApiError('요청한 정보를 찾을 수 없습니다.',404,null);
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/list-generation')throw missing();
      if(path.includes('classifications'))return{items:[{id:'b',name:'분류 B',asset_count:2,parent_id:null}]};
      if(path.includes('revisit'))return{bundles:[]}; if(path.includes('captures'))return{captures:[]};
      return{items:path.includes('classification_id=b')?b:a,has_more:false,next_cursor:null};
    });
    const fetches=()=>mocks.api.mock.calls.filter(([p])=>String(p).includes('classification_id=b')).length;
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
    const first=fetches();
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
    expect(fetches()).toBeGreaterThan(first);
  });
  it('manual refresh fetches even when generation is unchanged',async()=>{
    fixture();render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    const before=mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/library/assets')).length;
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));
    await screen.findByRole('button',{name:'전체 보기'});
    const reads=mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/library/assets')).length;
    fireEvent.click(screen.getByRole('button',{name:'새로고침',exact:true}));
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/library/assets')).length).toBe(reads+1));
  });
});
it('closes an open search on Back before leaving the Library root',async()=>{
  render(<App/>);
  await screen.findByRole('button',{name:/^분류 B, /});
  fireEvent.click(screen.getByRole('button',{name:'검색'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'폴더·캐릭터 찾기'}),{target:{value:'분류'}});
  mocks.native.mockClear();
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  expect(screen.queryByRole('searchbox',{name:'폴더·캐릭터 찾기'})).toBeNull();
  expect(mocks.native.mock.calls.some(([op])=>op==='finish')).toBe(false);
});
it('keeps the Library root mounted behind an open folder, so Back returns to the same search without rebuilding it',async()=>{
  render(<App/>);
  await screen.findByRole('button',{name:/^분류 B, /});
  fireEvent.click(screen.getByRole('button',{name:'검색'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'폴더·캐릭터 찾기'}),{target:{value:'분류'}});
  fireEvent.click(await screen.findByRole('button',{name:/^분류 B, /}));
  await screen.findByRole('heading',{name:'분류 B'});
  // Hidden, not unmounted: it is out of the accessibility tree while the folder is shown.
  expect(screen.queryByRole('searchbox',{name:'폴더·캐릭터 찾기'})).toBeNull();
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('heading',{name:'라이브러리'});
  expect((screen.getByRole('searchbox',{name:'폴더·캐릭터 찾기'}) as HTMLInputElement).value).toBe('분류');
});
it('shows a failed load over the bottom of the content instead of inserting it above the list',async()=>{
  render(<App/>);
  const folder=await screen.findByRole('button',{name:/^분류 B, /});
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(path:string)=>{if(path.includes('classification_id=b'))throw new Error('offline');return original(path);});
  fireEvent.click(folder);
  const alert=await screen.findByRole('alert');
  expect(alert.parentElement?.className).toBe('floating-notices');
});

describe('pages that carry their own list generation',()=>{
  const G=(n:number)=>n.toString(16).padStart(64,'0');
  // `carries` switches between a server that puts `listGeneration` on each page and one
  // that predates the field (the endpoint alone is available there).
  function fixture(carries:boolean){
    let revision=0;
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string)=>{
      if(path==='/v1/library/list-generation')return {generation:G(revision),filterVersion:1};
      if(path.startsWith('/v1/library/assets')){
        const page=path.includes('cursor=c1')?{items:b,has_more:false,next_cursor:null}
          :{items:path.includes('classification_id=b')?b:a,has_more:!path.includes('classification_id=b'),next_cursor:path.includes('classification_id=b')?null:'c1'};
        return carries?{...page,listGeneration:G(revision)}:page;
      }
      return original(path);
    });
    return {bump(){revision++;}};
  }
  const pageReads=()=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/library/assets?')).length;
  const generationReads=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/library/list-generation').length;
  async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}

  it('loads a Library page in one request once the server carries the generation',async()=>{
    fixture(true);render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));await screen.findByRole('heading',{name:'라이브러리'});await settle();
    const [pages,generations]=[pageReads(),generationReads()];
    fireEvent.click(await screen.findByRole('button',{name:'분류 B, 2개'}));await screen.findByText('tile-b1');await settle();
    expect(pageReads()-pages).toBe(1);
    expect(generationReads()-generations).toBe(0);
  });
  it('appends the next page without a generation read and reloads when the page moved',async()=>{
    const server=fixture(true);render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    // Learn the capability on one navigation, then commit a fresh page that is bound by it.
    await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));await screen.findByRole('button',{name:'전체 보기'});
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'}));await screen.findByText('tile-a1');await settle();
    const generations=generationReads();
    fireEvent.scroll(screen.getAllByLabelText('자산 목록').find(element=>!element.closest('[style="display: none;"]'))!);
    await screen.findByText('tile-b1');await settle();
    expect(generationReads()).toBe(generations);
  });
  it('reloads instead of splicing a continuation read under another generation',async()=>{
    fixture(true);const served=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async(path:string)=>{
      const reply=await served(path);
      return path.includes('cursor=c1')?{...reply,listGeneration:G(9)}:reply;
    });
    render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
    fireEvent.click(screen.getByRole('button',{name:'Home',exact:true}));await screen.findByRole('button',{name:'전체 보기'});
    fireEvent.click(screen.getByRole('button',{name:'전체 보기'}));await screen.findByText('tile-a1');await settle();
    const firstPages=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/library/assets?limit=40').length;
    const before=firstPages();
    fireEvent.scroll(screen.getAllByLabelText('자산 목록').find(element=>!element.closest('[style="display: none;"]'))!);
    await waitFor(()=>expect(firstPages()).toBe(before+1));await settle();
    expect(screen.queryByText('tile-b1')).toBeNull();
  });
  it('keeps the bracketed generation reads against a server whose pages lack the field',async()=>{
    fixture(false);render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'Library',exact:true}));await screen.findByRole('heading',{name:'라이브러리'});await settle();
    const [pages,generations]=[pageReads(),generationReads()];
    fireEvent.click(await screen.findByRole('button',{name:'분류 B, 2개'}));await screen.findByText('tile-b1');await settle();
    expect(pageReads()-pages).toBe(1);
    expect(generationReads()-generations).toBe(2);
  });
});
