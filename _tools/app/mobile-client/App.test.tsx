import type {ReactNode} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import type {SparseGallerySource} from './assetToc';
import type {HomeProps} from './Home';
import type {ExchangeSnapshot} from './exchangeModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:()=> 'connection failed',
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}}}));
vi.mock('./media',()=>({clearMediaCache:vi.fn(),loadThumbnail:vi.fn(async(a)=>a),prepareAssets:()=>new Promise(()=>{})}));
vi.mock('./Home',()=>({Home:({items,onRecent,onArtists}:HomeProps)=><div><button onClick={onRecent}>전체 보기</button><button onClick={onArtists}>작가 전체</button>{items.slice(0,12).map(a=><span key={a.id}>{`tile-${a.id}`}</span>)}</div>}));
vi.mock('./Gallery',()=>({Gallery:({intro,items,onOpen,onNearEnd,restoreScroll,onScroll,sparse,onSelectAsset}:{onSelectAsset?(id:string):void;sparse?:SparseGallerySource;intro?:ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;restoreScroll?:number;onScroll?(top:number):void})=><div aria-label="자산 목록" data-restore-scroll={restoreScroll} data-toc-total={sparse?.toc.totalCount} onScroll={()=>{onNearEnd();onScroll?.(420);}}>{intro}{items.map((a,i)=><button key={a.id} onContextMenu={event=>{event.preventDefault();onSelectAsset?.(a.id);}} onClick={()=>onOpen(i)}>{`tile-${a.id}`}</button>)}{sparse&&<button onClick={()=>void sparse.load(2,2,new AbortController().signal)}>seek bucket</button>}</div>}));
vi.mock('./Viewer',()=>({Viewer:({items,index,onIndex,onClose}:{items:Asset[];index:number;onIndex(i:number):void;onClose():void})=><div><span>{`viewer-${items[index].id}`}</span><button onClick={()=>onIndex(1)}>viewer next</button><button onClick={onClose}>viewer close</button></div>}));
import {App} from './App';
import {viewerEditEvent} from './listGeneration';
import {ApiError} from './transport';
import {outboxConnection,setOutboxConnection} from './outboxConnection';
const a=[{id:'a1',kind:'image'},{id:'a2',kind:'image'}],b=[{id:'b1',kind:'image'},{id:'b2',kind:'image'}];
const exchangeSnapshot = (overrides: Partial<ExchangeSnapshot> = {}): ExchangeSnapshot => ({configured: true, tokenConfigured: true, receiveSupported: true, deviceId: 'tablet', deviceName: '태블릿', code: '', devices: [{deviceId: 'pc', name: '작업실 PC', kind: 'pc', lastSeenAt: '2026-09-25T11:29:00Z'}], incoming: [], unseen: 0, outgoing: [], ...overrides});
async function openFolder(name:string){
  if(!screen.queryByRole('button',{name})){
    // From another tab Library first returns to its last place; reselecting it goes to the root.
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
    await waitFor(()=>expect(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}).getAttribute('aria-current')).toBe('page'));
    if(!screen.queryByRole('heading',{name:'에셋'}))fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
    await screen.findByRole('heading',{name:'에셋'});
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
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete window.LakomicsNative;delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
it('prewarms the two retained list areas only after startup paint and idle, without mounting Notes',async()=>{
  vi.useFakeTimers();
  let sequence=0,idle:IdleRequestCallback|undefined;
  const frames=new Map<number,FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=++sequence;frames.set(id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('requestIdleCallback',(callback:IdleRequestCallback)=>{idle=callback;return 1;});
  vi.stubGlobal('cancelIdleCallback',()=>{idle=undefined;});
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:true,endpoint:'https://example.invalid'}),request:vi.fn(),cancel:vi.fn()};
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/mobile-catalog/status')return {publicationRevision:'p1',capabilities:{displayPreferencesVersion:1}};
    if(path.startsWith('/v1/mobile-catalog/search?'))return {ready:true,publicationRevision:'p1',items:[],nextCursor:null,countStatus:'ready'};
    if(path.startsWith('/v1/collections?'))return {ready:true,filterVersion:1,revision:'r1',items:[],nextCursor:null};
    return original(path);
  });
  try {
    render(<App/>);await act(async()=>{});
    const listReads=()=>mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/mobile-catalog/search?')||path.startsWith('/v1/collections?'));
    expect(listReads()).toHaveLength(0);expect(document.querySelector('.mobile-catalog, .mobile-collections')).toBeNull();
    for(let index=0;index<2;index++)await act(async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(performance.now()));});
    await act(async()=>{vi.advanceTimersByTime(1500);});
    expect(listReads()).toHaveLength(0);expect(idle).toBeDefined();
    await act(async()=>idle!({didTimeout:false,timeRemaining:()=>50}));
    expect(listReads()).toHaveLength(2);
    expect(document.querySelector('[data-motion-view="catalog"] .mobile-catalog')).not.toBeNull();
    expect(document.querySelector('[data-motion-view="collections"] .mobile-collections')).not.toBeNull();
    expect(document.querySelector('.mobile-notes')).toBeNull();
    expect(mocks.native.mock.calls.some(([op])=>op==='notesState'||op==='catalogImage'||op==='collectionArtwork')).toBe(false);
  } finally {cleanup();vi.unstubAllGlobals();vi.useRealTimers();}
});
it('keeps the visible folder and scroll DOM through a delayed foreground refresh without replaying area motion',async()=>{
  let visibility:DocumentVisibilityState='visible';
  const visibilitySpy=vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
  try{
    render(<App/>);await screen.findByRole('heading',{name:'에셋'});await openFolder('분류 B, 2개');
    const old=await screen.findByText('tile-b1');
    const gallery=screen.getByLabelText('자산 목록');fireEvent.scroll(gallery);
    const layer=old.closest<HTMLElement>('[data-motion-view]')!;
    const animate=vi.fn(()=>({cancel(){}}));
    Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
    const original=mocks.api.getMockImplementation()!;
    const generation='b'.repeat(64);
    let resolve!:(page:unknown)=>void;
    const replacement=new Promise(done=>{resolve=done;});
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/list-generation')return Promise.resolve({generation});
      if(path.startsWith('/v1/library/assets?')&&path.includes('classification_id=b')&&!path.includes('toc=1'))return replacement;
      return original(path);
    });
    visibility='hidden';
    act(()=>{
      window.dispatchEvent(new Event('lakomics-pause'));document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation}}));
    });
    const reads=mocks.api.mock.calls.length;
    visibility='visible';
    await act(async()=>{window.dispatchEvent(new Event('lakomics-resume'));document.dispatchEvent(new Event('visibilitychange'));});
    expect(mocks.api.mock.calls.length).toBeGreaterThan(reads);
    expect(screen.getByText('tile-b1')).toBe(old);
    expect(screen.getByLabelText('자산 목록')).toBe(gallery);
    expect(layer.style.visibility).toBe('');expect(layer.style.display).toBe('');
    expect(animate).not.toHaveBeenCalled();
    await act(async()=>resolve({items:[{id:'foreground-new',kind:'image'}],has_more:false,next_cursor:null,list_generation:generation}));
    await screen.findByText('tile-foreground-new');
    expect(screen.queryByText('tile-b1')).toBeNull();
    expect(screen.getByLabelText('자산 목록')).toBe(gallery);
    expect(gallery.getAttribute('data-restore-scroll')).toBe('420');
    expect(animate).not.toHaveBeenCalled();
  }finally{visibilitySpy.mockRestore();}
});
describe('asset TOC list wiring',()=>{
  const G='a'.repeat(64),G2='b'.repeat(64);
  const table=(generation=G)=>({tocVersion:1,listGeneration:generation,totalCount:4,sort:'newest',buckets:[{key:'2026-09',startIndex:0,count:2,startCursor:null},{key:'2025-12',startIndex:2,count:2,startCursor:'bucket-b'}]});
  it('does not bless an optimistic legacy page with a generation observed only after it was read',async()=>{
    const original=mocks.api.getMockImplementation()!;let generation=G,opening=false,pageReads=0;
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/list-generation')return Promise.resolve({generation});
      const url=new URL(path,'https://test');
      if(url.pathname==='/v1/library/assets'&&url.searchParams.has('toc')){opening=true;return Promise.reject(new ApiError('old server',400,null));}
      if(url.pathname==='/v1/library/assets'&&opening){
        pageReads++;generation=G2;
        return Promise.resolve({items:pageReads===1?a:b,has_more:false,next_cursor:null});
      }
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    await screen.findByText('tile-b1');expect(screen.queryByText('tile-a1')).toBeNull();expect(pageReads).toBe(2);
  });
  it('starts the first page alongside the optional TOC and shows cursor content until TOC arrives',async()=>{
    const original=mocks.api.getMockImplementation()!;
    let resolveToc!:(value:unknown)=>void,resolvePage!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>{
      const url=new URL(path,'https://test');
      if(url.pathname==='/v1/library/assets'&&url.searchParams.has('toc'))return new Promise(resolve=>{resolveToc=resolve;});
      if(url.pathname==='/v1/library/assets'&&resolveToc)return new Promise(resolve=>{resolvePage=resolve;});
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    await waitFor(()=>{expect(resolveToc).toBeDefined();expect(resolvePage).toBeDefined();});
    await act(async()=>{resolvePage({items:a,has_more:true,next_cursor:'bucket-b',listGeneration:G});});
    await screen.findByText('tile-a1');expect(screen.getByLabelText('자산 목록').getAttribute('data-toc-total')).toBeNull();
    await act(async()=>{resolveToc(table());});
    await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-toc-total')).toBe('4'));
  });
  it('refetches TOC and first page after a changed seek generation while retaining current content',async()=>{
    const original=mocks.api.getMockImplementation()!;let generation=G,firstReads=0,tocReads=0;
    let refreshPage!:(value:unknown)=>void,refreshToc!:(value:unknown)=>void;
    mocks.api.mockImplementation((path:string)=>{
      const url=new URL(path,'https://test');
      if(url.pathname==='/v1/library/assets'&&url.searchParams.has('toc')){
        tocReads++;return generation===G?Promise.resolve(table()):new Promise(resolve=>{refreshToc=resolve;});
      }
      if(url.pathname==='/v1/library/assets'&&url.searchParams.get('cursor')==='bucket-b'){
        generation=G2;return Promise.resolve({items:b,has_more:false,next_cursor:null,listGeneration:G2});
      }
      if(url.pathname==='/v1/library/assets'&&tocReads){
        firstReads++;return generation===G?Promise.resolve({items:a,has_more:true,next_cursor:'bucket-b',listGeneration:G}):new Promise(resolve=>{refreshPage=resolve;});
      }
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    fireEvent.click(await screen.findByRole('button',{name:'seek bucket'}));
    await waitFor(()=>{expect(refreshPage).toBeDefined();expect(refreshToc).toBeDefined();});
    expect(screen.getByText('tile-a1')).toBeTruthy();expect(screen.queryByText('tile-b1')).toBeNull();
    expect(firstReads).toBe(2);expect(tocReads).toBe(2);
    await act(async()=>{refreshToc(table(G2));refreshPage({items:b,has_more:true,next_cursor:'tail',listGeneration:G2});});
    await screen.findByText('tile-b1');expect(screen.queryByText('tile-a1')).toBeNull();
    await waitFor(()=>expect(screen.getByLabelText('자산 목록').getAttribute('data-toc-total')).toBe('4'));
  });
});
it('opens Home 작가 전체 in the 에셋 작가 segment instead of the detail overlay',async()=>{
 render(<App/>);
 // Without a saved connection the start settles on the 에셋 root once the first library page
 // loads (the startup root read); Home is opened from there, not from the transient first frame.
 await screen.findByRole('heading',{name:'에셋'});
 fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'홈'}));
 fireEvent.click(await screen.findByRole('button',{name:'작가 전체'}));
 expect(await screen.findByRole('radio',{name:'작가'})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:'작가'})).toBeNull();
 await screen.findByRole('heading',{name:'에셋'});
 act(()=>{window.dispatchEvent(new Event('lakomics-back'));});
 expect(await screen.findByRole('button',{name:'작가 전체'})).toBeTruthy();
});
it('renders Home from a saved native connection while the async status read is pending', async()=>{
  let resolveStatus!: (value: unknown) => void;
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:true,endpoint:'https://example.invalid'}),request:vi.fn(),cancel:vi.fn()};
  mocks.native.mockImplementation((op:string)=>op==='status' ? new Promise(resolve=>{resolveStatus=resolve;}) : Promise.resolve({configured:true,endpoint:'https://example.invalid'}));
  render(<App/>);
  expect(screen.getByRole('button',{name:'전체 보기'})).toBeTruthy();
  expect(screen.queryByText('어디서든,')).toBeNull();
  await act(async()=>{resolveStatus({configured:false,endpoint:''});});
  expect(await screen.findByRole('button',{name:'라이브러리 연결'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'전체 보기'})).toBeNull();
});
it('keeps the connect screen while a device without a saved connection is checking',()=>{
  window.LakomicsNative={localStatus:()=>JSON.stringify({configured:false,endpoint:''}),request:vi.fn(),cancel:vi.fn()};
  mocks.native.mockImplementation((op:string)=>op==='status' ? new Promise(()=>{}) : Promise.resolve({configured:false,endpoint:''}));
  render(<App/>);
  expect(screen.getByRole('button',{name:'라이브러리 연결'}).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByText('연결 확인 중')).toBeNull();
  expect(screen.queryByRole('button',{name:'전체 보기'})).toBeNull();
});
it('points the durable outboxes at the configured connection as soon as the status arrives',async()=>{
  setOutboxConnection(null);
  render(<App/>);
  await waitFor(()=>expect(outboxConnection()).toBe('https://example.invalid'));
});
it('shows unseen transfers in the Home header and opens the exchange screen', async () => {
  const snapshot = exchangeSnapshot({unseen: 3});
  mocks.native.mockImplementation(async (op: string) => op === 'status' ? {configured: true, endpoint: 'https://example.invalid'} : op === 'exchangeState' || op === 'exchangeVisible' ? snapshot : {configured: true, endpoint: 'https://example.invalid'});
  render(<App/>);
  await screen.findByRole('heading', {name: '에셋'});
  fireEvent.click(await screen.findByRole('button', {name: '홈', exact: true}));
  await screen.findByRole('button', {name: '전체 보기'});
  const transfer = await screen.findByRole('button', {name: '전송 · 받은 파일 3개'});
  expect(transfer.closest('.header-action-badge')?.querySelector('.header-badge')?.textContent).toBe('3');
  fireEvent.click(transfer);
  expect(await screen.findByRole('dialog', {name: '전송'})).toBeTruthy();
});
it('shows the outgoing transfer percentage when there are no unseen files', async () => {
  const snapshot = exchangeSnapshot({outgoing: [{transferId: 'tx1', batchId: 'b1', fileName: '스케치.zip', sizeBytes: 100, bytes: 62, peer: 'pc', peerId: 'pc', state: 'uploading', code: '', createdAt: '2026-09-25T10:00:00Z'}]});
  mocks.native.mockImplementation(async (op: string) => op === 'status' ? {configured: true, endpoint: 'https://example.invalid'} : op === 'exchangeState' || op === 'exchangeVisible' ? snapshot : {configured: true, endpoint: 'https://example.invalid'});
  render(<App/>);
  await screen.findByRole('heading', {name: '에셋'});
  fireEvent.click(await screen.findByRole('button', {name: '홈', exact: true}));
  await screen.findByRole('button', {name: '전체 보기'});
  const transfer = await screen.findByRole('button', {name: '전송 · 보내는 중 62%'});
  expect(transfer.closest('.header-action-badge')?.querySelector('.header-badge')?.textContent).toBe('62%');
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
  await screen.findByRole('heading',{name:'에셋'});
  expect(screen.queryByRole('region',{name:'시리즈·캐릭터'})).toBeNull();
});

it('shows the direct image empty state when a plain folder only has child folders',async()=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string,signal?:AbortSignal)=>{
    if(path.includes('classifications'))return Promise.resolve({items:[{id:'parent',name:'Parent',asset_count:0,parent_id:null},{id:'child',name:'Child',asset_count:1,parent_id:'parent'}]});
    if(path.includes('classification_id=parent'))return Promise.resolve({items:[],has_more:false,next_cursor:null});
    return original(path,signal);
  });
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:'Parent, 0개'}));
  await screen.findByRole('heading',{name:'Parent'});
  expect(screen.getByText('이 폴더에 바로 들어 있는 이미지가 없습니다')).toBeTruthy();
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
  fireEvent.click(await screen.findByRole('button',{name:'Series, 2장'}));
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
  await screen.findByRole('heading',{name:'에셋'});
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
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2장'}));
  await screen.findByText('tile-b1');
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('button',{name:'Group · 2장'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('heading',{name:'에셋'});
});

it('keeps visited Catalog and Notes panels separate when returning Home',async()=>{
  const api=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/mobile-catalog')?Promise.resolve({ready:true,publicationRevision:'p1',items:[],totalCount:0,countStatus:'ready',context:'c',nextCursor:null}):api(path));
  mocks.native.mockImplementation(async(op:string)=>op.startsWith('notes')?{unlocked:true,notes:[]}:{configured:true,endpoint:'https://example.invalid'});
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  fireEvent.click(screen.getByRole('button',{name:'카탈로그',exact:true}));await screen.findByRole('region',{name:'만화 카탈로그'});
  fireEvent.click(screen.getByRole('button',{name:'메모',exact:true}));await screen.findByRole('button',{name:'동기화',exact:true});
  fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));await screen.findByText('tile-a1');
  expect(screen.queryByRole('button',{name:'동기화',exact:true})).toBeNull();expect(screen.queryByRole('region',{name:'메모',exact:true})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'카탈로그',exact:true}));await screen.findByRole('region',{name:'만화 카탈로그'});expect(screen.queryByRole('button',{name:'동기화',exact:true})).toBeNull();
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
  fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
  fireEvent.click(await screen.findByRole('radio',{name:'앨범'}));
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
  it('does not reload or remount committed Home on reselect or return from Collections',async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));
    await screen.findByRole('button',{name:'전체 보기'});
    const first=screen.getByText('tile-a1');
    const reads=()=>mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')||path==='/v1/library/list-generation'||path.includes('/revisit?')||path.includes('/captures/pending')).length;
    const count=reads();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));});
    expect(reads()).toBe(count);
    fireEvent.click(screen.getByRole('button',{name:'컬렉션',exact:true}));
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));});
    expect(reads()).toBe(count);
    expect(screen.getByText('tile-a1')).toBe(first);
  });
  it.each(['success','failure'])('keeps the latest Home intent when a superseded folder request ends in %s',async(result)=>{
    const original=mocks.api.getMockImplementation()!;
    let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void,signal!:AbortSignal;
    mocks.api.mockImplementation((path:string,requestSignal:AbortSignal)=>path.includes('classification_id=b')?new Promise((done,fail)=>{resolve=done;reject=fail;signal=requestSignal;}):original(path,requestSignal));
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true})); await screen.findByRole('button',{name:'전체 보기'});
    await openFolder('분류 B, 2개');
    await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));
    expect(signal.aborted).toBe(true);
    await act(async()=>{if(result==='success')resolve({items:b,has_more:false,next_cursor:null});else reject(new Error('late failure'));});
    expect(screen.getByRole('button',{name:'전체 보기'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'홈',exact:true}).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText('tile-b1')).toBeNull();
    expect(screen.queryByText('connection failed')).toBeNull();
    expect(screen.queryByLabelText('목록 불러오는 중')).toBeNull();
  });
  it.each(['홈','에셋'])('refreshes retained %s on area return when generation checks are unavailable',async(tab)=>{
    const original=mocks.api.getMockImplementation()!; let changed=false;
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/list-generation')return Promise.reject(new ApiError('missing',404,null));
      if(changed&&path.startsWith('/v1/library/assets?'))return Promise.resolve({items:[{id:'updated',kind:'image'}],has_more:false,next_cursor:null});
      return original(path);
    });
    render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/})); await screen.findByText('tile-a1');
    if(tab==='홈'){
      fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));await screen.findByRole('button',{name:'전체 보기'});
    }else{
      await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
      fireEvent.scroll(screen.getByLabelText('자산 목록'));
    }
    fireEvent.click(screen.getByRole('button',{name:'컬렉션',exact:true}));changed=true;
    fireEvent.click(screen.getByRole('button',{name:tab,exact:true}));
    await screen.findByText('tile-updated');
    expect(screen.queryByText('tile-a1')).toBeNull();expect(screen.queryByText('tile-b1')).toBeNull();
    if(tab==='에셋'){
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
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true})); await screen.findByText('tile-a1');
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
    await waitFor(()=>expect(screen.getByText('tile-b1')).toBeTruthy());
  });
  it('active Library returns to root and Back there finishes',async()=>{
    render(<App/>);await screen.findByRole('heading',{name:'에셋'});
    fireEvent.click(await screen.findByRole('button',{name:'분류 B, 2개'}));await screen.findByText('tile-b1');
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));
    await screen.findByRole('heading',{name:'에셋'});
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
    fireEvent.click(screen.getByRole('button',{name:'카탈로그',exact:true}));
    await screen.findByRole('region',{name:'만화 카탈로그'});
    const reads=mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')||path==='/v1/library/list-generation').length;
    await act(async()=>{fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));});
    expect(screen.queryByRole('region',{name:'만화 카탈로그'})).toBeNull();
    expect(screen.getByText('tile-b1')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'분류 B'})).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/library/assets?')||path==='/v1/library/list-generation')).toHaveLength(reads);
  });
});

it('uses drill-down in both orientations and keeps settings only on Home',async()=>{
  render(<App/>);await screen.findByRole('heading',{name:'에셋'});
  expect(screen.queryByRole('button',{name:'사이드바 열기'})).toBeNull();
  expect(document.querySelector('.desktop-index')).toBeNull();
  expect(screen.queryByRole('heading',{name:'최근 연 폴더'})).toBeNull();
  expect(document.querySelector('.classification-tree')).toBeNull();
  expect(screen.queryByRole('button',{name:'연결 및 설정'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));
  await screen.findByRole('button',{name:'연결 및 설정'});
  fireEvent.click(screen.getByRole('button',{name:'컬렉션',exact:true}));
  expect(screen.queryByRole('button',{name:'연결 및 설정'})).toBeNull();
  // Collections draws its own title bar; Home's bar leaves with the Home view once the switch commits.
  await waitFor(()=>expect([...document.querySelectorAll('.app-header')].filter(header=>!header.closest('[style*="display: none"], [aria-hidden="true"]'))).toHaveLength(0),{timeout:2500});
  expect(screen.queryByRole('button',{name:'사이드바 열기'})).toBeNull();
  // Catalog and Notes also draw their own title bars; no area offers the old sidebar.
  for(const area of ['카탈로그','메모']){
    fireEvent.click(screen.getByRole('button',{name:area,exact:true}));
    expect(screen.queryByRole('button',{name:'연결 및 설정'})).toBeNull();
    await waitFor(()=>expect([...document.querySelectorAll('.app-header')].filter(header=>!header.closest('[style*="display: none"], [aria-hidden="true"]'))).toHaveLength(0),{timeout:2500});
    expect(screen.queryByRole('button',{name:'사이드바 열기'})).toBeNull();
  }
});
it.each([false,true])('swaps bottom tabs atomically after readiness and retains visited screens (reduced=%s)',async(reduced)=>{
  vi.stubGlobal('matchMedia',()=>({matches:reduced,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  const api=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/collections?')?Promise.resolve({ready:true,revision:'m1',items:[],nextCursor:null}):path.startsWith('/v1/mobile-catalog')?Promise.resolve({ready:true,publicationRevision:'p1',items:[],totalCount:0,countStatus:'ready',context:'c',nextCursor:null}):api(path));
  let releaseNotes!:()=>void;
  const notes=new Promise(resolve=>{releaseNotes=()=>resolve({unlocked:true,notes:[]});});
  mocks.native.mockImplementation(async(op:string)=>op.startsWith('notes')?notes:{configured:true,endpoint:'https://example.invalid'});
  let observer:MutationObserver|undefined;
  const animate=vi.fn(function(this:HTMLElement){return {cancel(){}};});
  const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'animate');
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
  try {
    render(<App/>);
    await screen.findByRole('heading',{name:'에셋'});
    const body=document.querySelector('.app-body')!;
    await waitFor(()=>expect(body.querySelector('.motion-stage')?.getAttribute('data-motion-shown')).toBe('library'));
    const stage=body.querySelector<HTMLElement>('.motion-stage')!;
    const visibleViews=()=>[...stage.children].filter((view)=>{
      const style=(view as HTMLElement).style;
      return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0';
    }).map(view=>view.getAttribute('data-motion-view'));
    const visibilitySnapshots:ReturnType<typeof visibleViews>[]=[];
    observer=new MutationObserver(()=>visibilitySnapshots.push(visibleViews()));
    observer.observe(stage,{subtree:true,attributes:true,childList:true});
    const retained=new Map<string,Element>();
    const tabs=[['홈','home','[data-motion-view=home] .library-main'],['에셋','library','.library-root'],['컬렉션','collections','.mobile-collections'],['카탈로그','catalog','.mobile-catalog'],['메모','notes','.mobile-notes']] as const;
    for(const [label,key,selector] of [...tabs,...tabs]){
      animate.mockClear();
      await act(async()=>{fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:label,exact:true}));});
      expect(body.getAttribute('data-active-tab')).toBe(key);
      const shown=body.querySelector(selector)!;
      expect(shown).toBeTruthy();
      if(key==='notes'&&!retained.has(key)){
        expect(stage.getAttribute('data-motion-shown')).toBe('catalog');
        expect(visibleViews()).toEqual(['catalog']);
        expect(stage.querySelector('[data-motion-view=catalog]')?.hasAttribute('inert')).toBe(true);
        expect(stage.querySelector('[data-motion-view=notes]')?.getAttribute('aria-hidden')).toBe('true');
        await act(async()=>releaseNotes());
      }
      await waitFor(()=>expect(body.querySelector(`[data-motion-view=${key}]`)?.getAttribute('aria-hidden')).toBeNull());
      expect((animate.mock.contexts as HTMLElement[]).filter(element=>element.classList.contains('motion-stage__view'))).toHaveLength(0);
      await waitFor(()=>expect(body.querySelector('.motion-stage')?.getAttribute('data-motion-shown')).toBe(key));
      expect(visibleViews()).toEqual([key]);
      if(key!=='home'){
        if(retained.has(key))expect(shown).toBe(retained.get(key));
        else retained.set(key,shown);
      }
    }
    observer.disconnect();
    expect(visibilitySnapshots.length).toBeGreaterThan(0);
    expect(visibilitySnapshots.every(views=>views.length===1)).toBe(true);
  } finally {
    observer?.disconnect();
    if(descriptor)Object.defineProperty(HTMLElement.prototype,'animate',descriptor);
    else delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;
  }
});
it('sets the thumbnail size with a slider, stores it and keeps 보기 quiet',async()=>{
  localStorage.setItem('lakomics.mobile.density','0');
  render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
  // A pre-slider stored value (0 = 크게) is still honoured, but 보기 has no changed badge.
  const opener=screen.getByRole('button',{name:'보기 옵션'});
  expect(opener.classList.contains('is-changed')).toBe(false);
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
  render(<App/>);await screen.findByRole('heading',{name:'에셋'});
  fireEvent.click(await screen.findByRole('button',{name:'Parent, 2개'}));await screen.findByRole('heading',{name:'Parent'});
  fireEvent.scroll(screen.getByLabelText('자산 목록'));
  fireEvent.click(screen.getByRole('button',{name:'Child, 2장'}));await screen.findByRole('heading',{name:'Child'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));await screen.findByRole('heading',{name:'Parent'});
  await waitFor(()=>expect(screen.getAllByLabelText('자산 목록').find(element=>!element.closest('[style="display: none;"]'))?.getAttribute('data-restore-scroll')).toBe('420'));
  act(()=>window.dispatchEvent(new Event('lakomics-back')));await screen.findByRole('heading',{name:'에셋'});
  act(()=>window.dispatchEvent(new Event('lakomics-back')));await waitFor(()=>expect(mocks.native).toHaveBeenCalledWith('finish'));
  fireEvent.click(screen.getByRole('button',{name:'Parent, 2개'}));await screen.findByRole('heading',{name:'Parent'});
  fireEvent.click(screen.getByRole('button',{name:'Child, 2장'}));await screen.findByRole('heading',{name:'Child'});
  fireEvent.click(screen.getByRole('button',{name:'Grandchild, 2장'}));await screen.findByRole('heading',{name:'Grandchild'});
  fireEvent.click(within(screen.getByRole('navigation',{name:'현재 위치'})).getByRole('button',{name:'Parent'}));await screen.findByRole('heading',{name:'Parent'});
  fireEvent.click(within(screen.getByRole('navigation',{name:'현재 위치'})).getByRole('button',{name:'에셋',exact:true}));await screen.findByRole('heading',{name:'에셋'});
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
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));
    await waitFor(()=>expect(screen.queryByText('tile-a1')).toBeNull());
  });
  it('keeps the viewer open after a like or classification made from it, but closes it for other moves',async()=>{
    const server=fixture();render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    fireEvent.click(await screen.findByText('tile-a1'));await screen.findByText('viewer-a1');
    server.change(a);act(()=>window.dispatchEvent(viewerEditEvent()));
    await waitFor(()=>expect(mocks.api.mock.calls.filter(([path])=>path==='/v1/library/list-generation').length).toBeGreaterThan(0));
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
    expect(screen.getByText('viewer-a1')).toBeTruthy();
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+60_000);
    server.change(a);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
    await waitFor(()=>expect(screen.queryByText('viewer-a1')).toBeNull());
    vi.restoreAllMocks();
  });
  it.each(['success','failure'])('holds the viewer through a delayed long-resume generation refresh: %s',async outcome=>{
    const server=fixture();render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
    fireEvent.click(await screen.findByText('tile-a1'));const viewer=await screen.findByText('viewer-a1');
    let resolve!:(value:unknown)=>void,reject!:(reason:Error)=>void;
    const pending=new Promise((done,fail)=>{resolve=done;reject=fail;});
    const original=mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/library/assets?')&&!path.includes('toc=1')?pending:original(path));
    let visibility:DocumentVisibilityState='hidden';
    const spy=vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+10*60_000);
    try {
      act(()=>window.dispatchEvent(new Event('lakomics-pause')));
      server.change([]);act(()=>window.dispatchEvent(new CustomEvent('lakomics-list-generation',{detail:{generation:server.generation()}})));
      visibility='visible';await act(async()=>window.dispatchEvent(new Event('lakomics-resume')));
      expect(screen.getByText('viewer-a1')).toBe(viewer);
      if(outcome==='success'){
        await act(async()=>resolve({items:[],has_more:false,next_cursor:null,list_generation:server.generation()}));
        await waitFor(()=>expect(screen.queryByText('viewer-a1')).toBeNull());
      }else{
        await act(async()=>reject(new Error('offline')));
        expect(screen.getByText('viewer-a1')).toBe(viewer);
      }
    } finally {spy.mockRestore();clock.mockRestore();}
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
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));await screen.findByText('tile-a1');
    await openFolder('분류 B, 2개');await screen.findByText('tile-b1');
    expect(fetches()).toBeGreaterThan(first);
  });
});
it('closes an open search on Back before leaving the Library root',async()=>{
  render(<App/>);
  await screen.findByRole('button',{name:/^분류 B, /});
  fireEvent.click(screen.getByRole('button',{name:'검색'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'에셋 찾기'}),{target:{value:'분류'}});
  mocks.native.mockClear();
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  expect(screen.queryByRole('searchbox',{name:'에셋 찾기'})).toBeNull();
  expect(mocks.native.mock.calls.some(([op])=>op==='finish')).toBe(false);
});
it('keeps the Library root mounted behind an open folder, so Back returns to the same search without rebuilding it',async()=>{
  render(<App/>);
  await screen.findByRole('button',{name:/^분류 B, /});
  fireEvent.click(screen.getByRole('button',{name:'검색'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'에셋 찾기'}),{target:{value:'분류'}});
  fireEvent.click(await screen.findByRole('button',{name:/^분류 B/}));
  await screen.findByRole('heading',{name:'분류 B'});
  // Hidden, not unmounted: it is out of the accessibility tree while the folder is shown.
  expect(screen.queryByRole('searchbox',{name:'에셋 찾기'})).toBeNull();
  act(()=>window.dispatchEvent(new Event('lakomics-back')));
  await screen.findByRole('heading',{name:'에셋'});
  expect((screen.getByRole('searchbox',{name:'에셋 찾기'}) as HTMLInputElement).value).toBe('분류');
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
  const pageReads=()=>mocks.api.mock.calls.filter(([path])=>String(path).startsWith('/v1/library/assets?')&&!String(path).includes('toc=1')).length;
  const generationReads=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/library/list-generation').length;
  async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}

  it('loads a Library page in one request once the server carries the generation',async()=>{
    fixture(true);render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));await screen.findByText('tile-a1');
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));await screen.findByRole('heading',{name:'에셋'});await settle();
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
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));await screen.findByRole('button',{name:'전체 보기'});
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
    fireEvent.click(screen.getByRole('button',{name:'홈',exact:true}));await screen.findByRole('button',{name:'전체 보기'});
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
    fireEvent.click(within(screen.getByRole('navigation',{name:'주요 탐색'})).getByRole('button',{name:'에셋',exact:true}));await screen.findByRole('heading',{name:'에셋'});await settle();
    const [pages,generations]=[pageReads(),generationReads()];
    fireEvent.click(await screen.findByRole('button',{name:'분류 B, 2개'}));await screen.findByText('tile-b1');await settle();
    expect(pageReads()-pages).toBe(1);
    expect(generationReads()-generations).toBe(2);
  });
});

describe('asset search scope navigation',()=>{
  it.each(['folder','character','album','artist'] as const)('opens a chosen %s and returns to the unfiltered gallery when its chip is removed',async kind=>{
    vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
    const revision='a'.repeat(64),names={folder:'검색 폴더',character:'검색 캐릭터',album:'검색 앨범',artist:'검색 작가'};
    const original=mocks.api.getMockImplementation()!;
    const artist={id:'search-artist',label:names.artist,displayName:names.artist,keys:['search-artist'],assetCount:2,recentCount:0,pinned:false,hidden:false,main:true,coverAssetIds:[]};
    mocks.native.mockImplementation(async(op:string)=>op==='albumTree'?{adopted:true,libraryId:'library',epoch:1,code:'',albums:[{id:'search-album',name:names.album,parentId:null,iconKey:null,colorKey:null,assetCount:2}]}:{configured:true,endpoint:'https://example.invalid'});
    mocks.api.mockImplementation((path:string)=>{
      if(path==='/v1/library/classifications')return Promise.resolve({items:[{id:'b',name:names.folder,asset_count:2,parent_id:null}]});
      if(path==='/v1/library/characters')return Promise.resolve({version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'series:s',sourceId:'s',seriesId:'s',kind:'series',parentId:null,name:'시리즈',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},{id:'character:c',sourceId:'c',seriesId:'s',kind:'character',parentId:'series:s',name:names.character,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:2}]});
      if(path.startsWith('/v1/library/characters/assets'))return Promise.resolve({revision,items:b,totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
      if(path.startsWith('/v1/albums/assets?'))return Promise.resolve({items:b,hasMore:false,nextCursor:null});
      if(path==='/v1/library/artists')return Promise.resolve({artists:[artist]});
      if(path==='/v1/library/artists/search-artist')return Promise.resolve({artist});
      if(new URL(path,'https://test').searchParams.get('artist')==='search-artist')return Promise.resolve({items:b,has_more:false,next_cursor:null});
      return original(path);
    });
    render(<App/>);
    fireEvent.click(await screen.findByRole('button',{name:'검색',exact:true}));
    fireEvent.change(screen.getByRole('searchbox',{name:'에셋 찾기'}),{target:{value:'검색'}});
    fireEvent.click(await screen.findByRole('button',{name:new RegExp(`^${names[kind]}`)}));
    const chip=await screen.findByRole('button',{name:`${names[kind]} 범위 제거`});
    await screen.findByText('tile-b1');
    expect(screen.getAllByRole('group',{name:'에셋 검색 범위'})).toHaveLength(1);
    fireEvent.click(chip);
    await waitFor(()=>expect(screen.queryByRole('button',{name:`${names[kind]} 범위 제거`})).toBeNull());
    expect(screen.getByRole('button',{name:'검색',exact:true})).toBeTruthy();
  });
});

describe('combined asset search chips',()=>{
 const revision='c'.repeat(64);
 const artist={id:'artist:one',label:'검색 작가',keys:['one'],assetCount:2,recentCount:0,pinned:false,hidden:false,main:true,coverAssetIds:[]};
 beforeEach(()=>{
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  mocks.native.mockImplementation(async(op:string)=>op==='albumTree'?{adopted:true,libraryId:'library',epoch:3,code:'',albums:[{id:'album',name:'검색 앨범',parentId:null,iconKey:null,colorKey:null,assetCount:2}]}:{configured:true,endpoint:'https://example.invalid'});
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(path:string)=>{
   const url=new URL(path,'https://test');
   if(url.pathname==='/v1/library/search/suggestions')return{items:[{kind:'tag',id:'long_hair',label:'긴 머리',count:2},{kind:'tag',id:'glasses',label:'안경',count:1}]};
   if(path==='/v1/library/artists')return{artists:[artist]};
   if(path==='/v1/library/characters')return{version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,nodes:[{id:'character:c',sourceId:'c',seriesId:'s',kind:'character',parentId:null,name:'검색 캐릭터',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false}],scopes:[{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:2}]};
   if(url.pathname==='/v1/library/characters/assets')return{revision,items:b,totalCount:2,sourceCount:2,has_more:false,next_cursor:null};
   if(url.pathname==='/v1/library/assets'||url.pathname==='/v1/albums/assets'){
    if(url.searchParams.has('toc'))return{tocVersion:1,listGeneration:revision,totalCount:2,sort:'newest',buckets:[{key:'2026-10',startIndex:0,count:2,startCursor:null}]};
    return{items:b,has_more:false,next_cursor:null,hasMore:false,nextCursor:null,listGeneration:revision};
   }
   return original(path);
  });
 });
 async function choose(query:string,name:RegExp){
  if(!screen.queryByRole('searchbox'))fireEvent.click(await screen.findByRole('button',{name:'검색',exact:true}));
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:query}});
  fireEvent.click(await screen.findByRole('button',{name}));
 }
 it.each(['folder','album','character'] as const)('combines tags and artist inside a %s gallery and sends the same selection to page/TOC reads',async kind=>{
  render(<App/>);await screen.findByRole('heading',{name:'에셋'});
  await choose(kind==='folder'?'분류 B':'검색',kind==='folder'?/^분류 B/:kind==='album'?/^검색 앨범/:/^검색 캐릭터/);
  await screen.findByText('tile-b1');
  await choose('긴',/^긴 머리/);await screen.findByRole('button',{name:'긴 머리 범위 제거'});
  await choose('안경',/^안경/);await screen.findByRole('button',{name:'안경 범위 제거'});
  await choose('검색 작가',/^검색 작가/);await screen.findByRole('button',{name:'검색 작가 범위 제거'});
  const route=kind==='folder'?'/v1/library/assets':kind==='album'?'/v1/albums/assets':'/v1/library/characters/assets';
  const urls=mocks.api.mock.calls.map(([path])=>new URL(String(path),'https://test')).filter(url=>url.pathname===route&&url.searchParams.has('artist'));
  expect(urls.length).toBeGreaterThan(0);
  for(const url of urls){
   expect(url.searchParams.getAll('tag')).toEqual(['long_hair','glasses']);expect(url.searchParams.getAll('artist')).toEqual(['artist:one']);
   expect(url.searchParams.getAll('classification_id')).toEqual(kind==='folder'?['b']:[]);
   if(kind==='album'){expect(url.searchParams.get('libraryId')).toBe('library');expect(url.searchParams.get('epoch')).toBe('3');expect(url.searchParams.get('albumId')).toBe('album');}
   if(kind==='character'){expect(url.searchParams.get('node')).toBe('character:c');expect(url.searchParams.get('revision')).toBe(revision);}
  }
  if(kind!=='character')expect(urls.some(url=>url.searchParams.get('toc')==='1')).toBe(true);
  expect(screen.getByRole('button',{name:'모두 지우기'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'긴 머리 범위 제거'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'긴 머리 범위 제거'})).toBeNull());
  expect(screen.getByRole('button',{name:'안경 범위 제거'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'모두 지우기'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'안경 범위 제거'})).toBeNull());
  expect(screen.queryByRole('button',{name:'안경 범위 제거'})).toBeNull();
 });
 it.each(['folder','character'] as const)('drops an invalid tag after 422 in a %s scope while keeping its valid scope/artist and gallery',async kind=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(path:string)=>{
   const url=new URL(path,'https://test');
   if(url.searchParams.getAll('tag').includes('long_hair')&&url.pathname.endsWith('/assets'))throw new ApiError('invalid',422,null);
   return original(path);
  });
  render(<App/>);await screen.findByRole('heading',{name:'에셋'});
  await choose(kind==='folder'?'분류 B':'검색',kind==='folder'?/^분류 B/:/^검색 캐릭터/);await screen.findByText('tile-b1');
  await choose('검색 작가',/^검색 작가/);await screen.findByRole('button',{name:'검색 작가 범위 제거'});
  await choose('긴',/^긴 머리/);
  await screen.findByText('사용할 수 없는 검색 조건을 지웠습니다.');
  await waitFor(()=>expect(screen.queryByRole('button',{name:'긴 머리 범위 제거'})).toBeNull());
  expect(screen.getByRole('button',{name:'검색 작가 범위 제거'})).toBeTruthy();
  expect(screen.getByRole('button',{name:kind==='folder'?'분류 B 범위 제거':'검색 캐릭터 범위 제거'})).toBeTruthy();
  expect(screen.getByText('tile-b1')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
 });
 it('drops a stale folder id while retaining an already selected artist',async()=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>new URL(path,'https://test').searchParams.getAll('classification_id').includes('b')?Promise.reject(new ApiError('invalid folder',422,null)):original(path));
  render(<App/>);await screen.findByRole('heading',{name:'에셋'});
  await choose('검색 작가',/^검색 작가/);await screen.findByRole('button',{name:'검색 작가 범위 제거'});
  await choose('분류 B',/^분류 B/);await screen.findByText('사용할 수 없는 검색 조건을 지웠습니다.');
  await waitFor(()=>expect(screen.queryByRole('button',{name:'분류 B 범위 제거'})).toBeNull());
  expect(screen.getByRole('button',{name:'검색 작가 범위 제거'})).toBeTruthy();expect(screen.getByText('tile-b1')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
 });
 it('keeps the previous gallery and committed chips during a delayed replacement, then swaps without fading the list',async()=>{
  const fades:Keyframe[][]=[];
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,writable:true,value:function(this:HTMLElement,frames:Keyframe[]){if(this.getAttribute('aria-label')==='자산 목록')fades.push(frames);return {cancel(){},onfinish:null};}});
  render(<App/>);await screen.findByRole('heading',{name:'에셋'});
  await choose('분류 B',/^분류 B/);await screen.findByText('tile-b1');
  const fadeCount=fades.length;
  const original=mocks.api.getMockImplementation()!;let finish!:(reply:unknown)=>void;
  mocks.api.mockImplementation((path:string)=>new URL(path,'https://test').searchParams.has('tag')&&!path.includes('toc=1')?new Promise(resolve=>{finish=resolve;}):original(path));
  await choose('긴',/^긴 머리/);
  await waitFor(()=>expect(finish).toBeDefined());expect(screen.getByText('tile-b1')).toBeTruthy();expect(screen.queryByRole('button',{name:'긴 머리 범위 제거'})).toBeNull();
  await act(async()=>finish({items:b,has_more:false,next_cursor:null,listGeneration:revision}));
  await screen.findByRole('button',{name:'긴 머리 범위 제거'});expect(screen.getByText('tile-b1')).toBeTruthy();
  expect(fades).toHaveLength(fadeCount);
  fireEvent.click(screen.getByRole('button',{name:'모두 지우기'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'긴 머리 범위 제거'})).toBeNull());expect(fades).toHaveLength(fadeCount);
 });
});


it('opens the shared info from a single list selection and consumes Back before clearing selection',async()=>{
 render(<App/>);fireEvent.click(await screen.findByRole('button',{name:/모든 자산/}));
 fireEvent.contextMenu(await screen.findByText('tile-a1'));
 fireEvent.click(screen.getByRole('button',{name:'정보',exact:true}));
 const sheet=await screen.findByRole('dialog',{name:'미디어 정보'});
 expect(within(sheet).getByLabelText('미디어 정보',{selector:'section'})).toBeTruthy();
 expect(screen.queryByText('viewer-a1')).toBeNull();
 act(()=>window.dispatchEvent(new Event('lakomics-back')));
 expect(screen.queryByRole('dialog',{name:'미디어 정보'})).toBeNull();
 expect(screen.getByText('1개 선택')).toBeTruthy();
 fireEvent.contextMenu(screen.getByText('tile-a2'));
 expect(screen.queryByRole('button',{name:'정보',exact:true})).toBeNull();
 act(()=>window.dispatchEvent(new Event('lakomics-back')));
 expect(screen.queryByText('2개 선택')).toBeNull();
});
