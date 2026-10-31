import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import {CharacterBrowser,viewerCharacterContext} from './CharacterBrowser';
import type {CharacterIndex,CharacterPage} from './characterModel';
import type {SparseGallerySource} from './assetToc';

const mocks=vi.hoisted(()=>({api:vi.fn(),loadThumbnail:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(e:Error)=>e.message}));
vi.mock('./media',()=>({loadThumbnail:mocks.loadThumbnail}));
vi.mock('./Gallery',()=>({Gallery:({items,onOpen,onNearEnd,restoreScroll,intro,stale,sparse,privacy,likesRevision,onRefresh,selectedIds,onSelectAsset}:{intro?:import('react').ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;restoreScroll:number;stale?:boolean;privacy?:boolean;likesRevision?:unknown;onRefresh?():void;sparse?:SparseGallerySource;selectedIds?:ReadonlySet<string>;onSelectAsset?(id:string):void})=><div aria-label="character gallery" data-likes-revision={String(likesRevision)} data-privacy={String(privacy)} data-scroll={restoreScroll} data-toc={sparse?.toc.totalCount} data-stale={stale?'true':undefined}>{intro}<button onClick={onRefresh}>refresh gallery</button>{items.map((a,i)=><span key={a.id}><button aria-selected={selectedIds?.has(a.id)?true:undefined} onClick={()=>onOpen(i)}>{a.id}</button>{onSelectAsset&&<button onClick={()=>onSelectAsset(a.id)}>select {a.id}</button>}</span>)}<button onClick={onNearEnd}>more</button>{sparse&&<button onClick={()=>void sparse.load(2,1,new AbortController().signal)}>seek</button>}</div>}));
const revision='a'.repeat(64);
const node=(kind:'series'|'group'|'character'|'folder',id:string,name:string,parentId:string|null)=>({id:`${kind}:${id}`,kind,sourceId:id,seriesId:'s',parentId,name,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false});
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:'2026',nodes:[node('series','s','Series',null),node('group','g','Group','series:s'),node('character','c','Character','group:g')],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'series:s',filter:'unclassified',totalCount:0,sourceCount:0},{nodeId:'series:s',filter:'needs_review',totalCount:0,sourceCount:0},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:3}]};
const page=(ids=['asset-1','asset-2'],cursor:string|null=null):CharacterPage=>({revision,items:ids.map(id=>({id,kind:'image'})),totalCount:2,sourceCount:3,has_more:!!cursor,next_cursor:cursor});
const backRef:{current:(()=>boolean)|null}={current:null};
const onOpen=vi.fn();
const onExit=vi.fn();
const props={active:true,paused:false,density:1,refreshKey:1,onOpen,backRef,onExit};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  mocks.api.mockReset();mocks.loadThumbnail.mockReset();mocks.loadThumbnail.mockImplementation(async(a:Asset)=>({...a,preview:'data:image/png;base64,AA=='}));onOpen.mockReset();onExit.mockReset();backRef.current=null;
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(index):page());
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('keeps a loaded empty index visible during re-entry and applies changed metadata at the same revision',async()=>{
  const empty={...structuredClone(index),nodes:[],scopes:[]};
  mocks.api.mockResolvedValue(empty);
  const view=render(<CharacterBrowser {...props}/>);
  await screen.findByText('등록된 시리즈가 없습니다');
  view.rerender(<CharacterBrowser {...props} active={false}/>);
  let finish!:(value:CharacterIndex)=>void;
  mocks.api.mockImplementation(path=>path==='/v1/library/characters'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(page()));
  view.rerender(<CharacterBrowser {...props}/>);
  expect(screen.getByText('등록된 시리즈가 없습니다')).toBeTruthy();
  await act(async()=>finish(structuredClone(empty)));
  expect(screen.getByText('등록된 시리즈가 없습니다')).toBeTruthy();
  view.rerender(<CharacterBrowser {...props} active={false}/>);
  view.rerender(<CharacterBrowser {...props}/>);
  expect(screen.getByText('등록된 시리즈가 없습니다')).toBeTruthy();
  await act(async()=>finish(structuredClone(index)));
  expect(screen.getByRole('button',{name:'Series · 2장'})).toBeTruthy();
  expect(screen.queryByText('등록된 시리즈가 없습니다')).toBeNull();
});

it('keeps a cached asset page on plain re-entry when the index is identical',async()=>{
  const view=render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByText('asset-1');
  fireEvent.click(screen.getByRole('button',{name:'Group · 2장'}));
  await screen.findByRole('heading',{name:'Group'});
  await screen.findByText('asset-1');
  await act(async()=>{backRef.current?.();});
  await screen.findByRole('heading',{name:'Series'});
  await screen.findByText('asset-1');
  const reads=()=>mocks.api.mock.calls.filter(([path])=>String(path).includes('node='));
  const before=reads().length;
  view.rerender(<CharacterBrowser {...props} initialNode="series:s" active={false}/>);
  const pending=Promise.withResolvers<CharacterIndex>();
  mocks.api.mockImplementation(path=>path==='/v1/library/characters'?pending.promise:Promise.resolve(page(['unexpected-reload'])));
  view.rerender(<CharacterBrowser {...props} initialNode="series:s"/>);
  expect(screen.getByText('asset-1')).toBeTruthy();
  await act(async()=>pending.resolve(structuredClone(index)));
  expect(screen.getByText('asset-1')).toBeTruthy();
  expect(reads()).toHaveLength(before);
  expect(screen.queryByText('unexpected-reload')).toBeNull();
});

it.each(['refreshKey','retry'] as const)('keeps the old page until an identical-index %s finishes',async trigger=>{
  const view=render(<CharacterBrowser {...props} initialNode="character:c"/>);
  await screen.findByText('asset-1');
  const pending=Promise.withResolvers<CharacterPage>();
  mocks.api.mockImplementation(path=>path==='/v1/library/characters'?Promise.resolve(structuredClone(index)):pending.promise);
  if(trigger==='refreshKey')view.rerender(<CharacterBrowser {...props} initialNode="character:c" refreshKey={2}/>);
  else fireEvent.click(screen.getByRole('button',{name:'refresh gallery'}));
  await act(async()=>{});
  expect(screen.getByText('asset-1')).toBeTruthy();
  expect(screen.queryByText('updated')).toBeNull();
  await act(async()=>pending.resolve(page(['updated'])));
  await screen.findByText('updated');
  expect(screen.queryByText('asset-1')).toBeNull();
});

it('links inner series through classifications after characters and opens plain folders outside the hub',async()=>{
  const nested=structuredClone(index);
  // An older publication may still mark a folder excluded; the shelf no longer shows it.
  nested.nodes.push({...node('folder','band','밴드물','series:s'),excluded:true},node('series','bocchi','봇치',null));
  const classifications=[{id:'s',name:'Series',parent_id:null,asset_count:0},{id:'band',name:'밴드물',parent_id:'s',asset_count:0},{id:'bocchi',name:'봇치',parent_id:'s',asset_count:0}];
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?nested:page());
  const onOpenFolder=vi.fn();
  render(<CharacterBrowser {...props} classifications={classifications} onOpenFolder={onOpenFolder} initialNode="series:s"/>);
  const inner=await screen.findByRole('button',{name:'봇치'});
  const shelf=inner.closest('.home-shelf__track')!;
  expect([...shelf.querySelectorAll('.character-card')].map(card=>card.getAttribute('data-kind'))).toEqual(['group','series','folder']);
  expect(screen.queryByText('분류 제외')).toBeNull();
  expect(shelf.textContent).not.toContain('분류 제외');
  fireEvent.click(inner);
  await screen.findByRole('heading',{name:'봇치'});
  act(()=>{expect(backRef.current?.()).toBe(true);});
  await screen.findByRole('heading',{name:'Series'});
  fireEvent.click(screen.getByRole('button',{name:'밴드물'}));
  expect(onOpenFolder).toHaveBeenCalledWith('band');
  expect(mocks.api.mock.calls.some(([path])=>path.includes('node=folder%3Aband'))).toBe(false);
});

it('requests a date TOC and seeks with its bucket cursor without extending the loaded-page scale',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    const params=new URL(path,'https://test').searchParams;
    expect(params.get('node')).toBe('character:c');
    expect(params.get('sort')).toBe('newest');
    if(params.has('toc')){
      expect(params.has('utcOffsetMinutes')).toBe(true);
      return {tocVersion:1,listGeneration:'g1',sort:'newest',totalCount:3,buckets:[{key:'2026-10',startIndex:0,count:2,startCursor:null},{key:'2025-01',startIndex:2,count:1,startCursor:'bucket'}]};
    }
    return {...page([params.has('cursor')?'destination':'first']),listGeneration:'g1',has_more:!params.has('cursor'),next_cursor:params.has('cursor')?null:'next'};
  });
  render(<CharacterBrowser {...props} initialNode="character:c"/>);
  await screen.findByText('first');
  expect(screen.getByLabelText('character gallery').getAttribute('data-toc')).toBe('3');
  fireEvent.click(screen.getByText('seek'));
  await screen.findByText('destination');
  expect(mocks.api.mock.calls.some(([path])=>path.includes('cursor=bucket'))).toBe(true);
  expect(screen.getByLabelText('character gallery').getAttribute('data-toc')).toBe('3');
  fireEvent.click(screen.getByText('destination'));
  expect(onOpen.mock.calls.at(-1)?.[0].map((asset:Asset)=>asset.id)).toEqual(['first','destination']);
});

it('keeps cursor paging when the optional character TOC cannot be read',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('toc=1'))throw new Error('offline TOC');
    return path.includes('cursor=next')?page(['second']):{...page(['first']),has_more:true,next_cursor:'next'};
  });
  render(<CharacterBrowser {...props} initialNode="character:c"/>);
  await screen.findByText('first');
  expect(screen.getByLabelText('character gallery').hasAttribute('data-toc')).toBe(false);
  fireEvent.click(screen.getByText('more'));
  await screen.findByText('second');
});

it('navigates series, groups and characters, opens shared assets and returns to parents',async()=>{
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2장'}));
  fireEvent.click(await screen.findByRole('button',{name:'Character · 2장'}));
  fireEvent.click(await screen.findByText('asset-2'));
  // The third argument is the character origin this gallery hands its viewer. This node is a
  // character, whose published index here advertises no manual-exclusion capability, so the
  // context is legitimately absent rather than an invented target.
  expect(onOpen).toHaveBeenCalledWith(page().items,1,null);
  expect(screen.getByText(/아직 공유되지 않은 자산 1개/)).toBeTruthy();
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(await screen.findByRole('heading',{name:'Group'})).toBeTruthy();
  act(()=>{backRef.current?.();});
  expect(await screen.findByRole('heading',{name:'Series'})).toBeTruthy();
  expect(mocks.api.mock.calls.some(([p])=>p.includes('node=character%3Ac')&&p.includes(`revision=${revision}`))).toBe(true);
});

it('shows every portrait child in one scroll strip and collapses it without replacing the gallery',async()=>{
  const many=structuredClone(index);
  many.nodes.push(...Array.from({length:9},(_,i)=>node('character',`extra-${i}`,`Extra ${i}`,'series:s')));
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?many:page());
  const view=render(<CharacterBrowser {...props} initialNode="series:s"/>);
  const last=await screen.findByRole('button',{name:'Extra 8'});
  const strip=last.closest('.home-shelf__track') as HTMLElement;
  expect(strip).toBeTruthy();
  expect(strip.querySelectorAll('.character-card')).toHaveLength(10);
  expect(screen.queryByRole('button',{name:'다음 폴더'})).toBeNull();
  const gallery=await screen.findByLabelText('character gallery');
  const asset=screen.getByText('asset-1');
  const reads=mocks.api.mock.calls.length;
  strip.scrollLeft=320;
  const toggle=screen.getByRole('button',{name:'캐릭터 폴더 접기'});
  const controlled=document.getElementById(toggle.getAttribute('aria-controls')!);
  expect(controlled).toBeTruthy();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('radiogroup',{name:'이미지 범위'})).toBeTruthy();
  fireEvent.click(toggle);
  // The strip folds away out of reach at once, and is hidden once the fold has finished.
  expect(controlled?.getAttribute('data-open')).toBe('false');
  await waitFor(()=>expect(controlled?.hidden).toBe(true));
  expect(screen.queryByRole('button',{name:'Extra 8'})).toBeNull();
  expect(screen.getByText('asset-1')).toBe(asset);
  expect(screen.getByLabelText('character gallery')).toBe(gallery);
  expect(mocks.api).toHaveBeenCalledTimes(reads);
  expect(backRef.current?.()).toBe(false);
  view.rerender(<CharacterBrowser {...props} initialNode="series:s" paused/>);
  view.rerender(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  expect(controlled?.hidden).toBe(false);expect(strip.scrollLeft).toBe(320);
  fireEvent.click(screen.getByRole('button',{name:'Extra 8'}));
  await screen.findByRole('heading',{name:'Extra 8'});
  expect(screen.queryByRole('button',{name:'캐릭터 폴더 접기'})).toBeNull();
  act(()=>{expect(backRef.current?.()).toBe(true);});
  await screen.findByRole('heading',{name:'Series'});
});

it('only requests nearby strip covers and retains loaded previews through folding',async()=>{
  const observed=new Map<Element,(visible:boolean)=>void>();
  vi.stubGlobal('IntersectionObserver',class {
    constructor(private callback:(entries:{isIntersecting:boolean}[])=>void){}
    observe(element:Element){observed.set(element,visible=>this.callback([{isIntersecting:visible}]));}
    disconnect(){}
  });
  const many=structuredClone(index);
  many.nodes.push(...Array.from({length:9},(_,i)=>({...node('character',`extra-${i}`,`Extra ${i}`,'series:s'),thumbnailAssetId:`thumb-${i}`})));
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?many:page());
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  const first=await screen.findByRole('button',{name:'Extra 0'});
  const last=screen.getByRole('button',{name:'Extra 8'});
  expect(mocks.loadThumbnail).not.toHaveBeenCalled();
  await act(async()=>{observed.get(first)!(true);});
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1);
  const image=first.querySelector('img');expect(image).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 접기'}));
  act(()=>{observed.get(first)!(false);});
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  await act(async()=>{observed.get(first)!(true);});
  expect(first.querySelector('img')).toBe(image);
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1);
  await act(async()=>{observed.get(first)!(false);observed.get(last)!(true);});
  expect(mocks.loadThumbnail).toHaveBeenCalledTimes(2);
  expect(mocks.loadThumbnail.mock.calls.at(-1)?.[0].id).toBe('thumb-8');
});
it('keeps a loaded character folder thumbnail when the published revision changes',async()=>{
 const first=structuredClone(index);first.nodes=first.nodes.map(item=>item.id==='group:g'?{...item,thumbnailAssetId:'group-thumb'}:item);
 let current=first;
 mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?current:page());
 const view=render(<CharacterBrowser {...props} initialNode="series:s"/>);
 const image=await waitFor(()=>{const element=document.querySelector('.character-card img');if(!element)throw new Error('thumbnail not ready');return element;});
 current={...first,revision:'b'.repeat(64)};
 view.rerender(<CharacterBrowser {...props} initialNode="series:s" refreshKey={2}/>);
 await waitFor(()=>expect(document.querySelector('.character-card img')).toBe(image));
 expect(mocks.loadThumbnail).toHaveBeenCalledTimes(1);
});

it('keeps series filters usable while folded and offers folding inside a group',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(await screen.findByRole('button',{name:'캐릭터 폴더 접기'}));
  fireEvent.click(screen.getByRole('radio',{name:/미분류/}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('filter=unclassified'))).toBe(true));
  expect(screen.getByRole('radio',{name:/미분류/}).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  fireEvent.click(screen.getByRole('button',{name:'Group · 2장'}));
  await screen.findByRole('heading',{name:'Group'});
  expect(screen.queryByRole('radio',{name:/미분류/})).toBeNull();
  expect(screen.getByRole('button',{name:'캐릭터 폴더 접기'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Character · 2장'})).toBeTruthy();
  expect(screen.getByText('asset-1')).toBeTruthy();
});

it('keeps the same shelf available when rotating from a folded portrait strip',async()=>{
  let rotate!:()=>void;
  const media={matches:false,addEventListener:(_name:string,listener:()=>void)=>{rotate=listener;},removeEventListener:()=>{}};
  vi.stubGlobal('matchMedia',(query:string)=>query.includes('orientation')?media:{matches:false,addEventListener(){},removeEventListener(){}});
  const many=structuredClone(index);
  many.nodes.push(...Array.from({length:9},(_,i)=>node('character',`extra-${i}`,`Extra ${i}`,'series:s')));
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?many:page());
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(await screen.findByRole('button',{name:'캐릭터 폴더 접기'}));
  act(()=>{media.matches=true;rotate();});
  expect(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Extra 8'})).toBeNull();
  act(()=>{media.matches=false;rotate();});
  expect(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  expect(screen.getByRole('button',{name:'Group · 2장'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Extra 8'})).toBeTruthy();
});

it('rejects a late page after changing the series filter',async()=>{
  let finish!:(p:CharacterPage)=>void;
  mocks.api.mockImplementation((path:string)=>{
    if(path.endsWith('/characters'))return Promise.resolve(structuredClone(index));
    // A series opens on its default 미분류, whose page is held back here.
    if(path.includes('filter=unclassified'))return new Promise(resolve=>{finish=resolve;});
    return Promise.resolve(page([]));
  });
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  await waitFor(()=>expect(finish).toBeDefined());
  expect(screen.getByRole('radio',{name:/미분류/}).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:/전체/}));
  await screen.findByText('이 보기에 자산이 없습니다');
  await act(async()=>finish(page(['late'])));
  expect(screen.queryByText('late')).toBeNull();
});

it('keeps loaded items on append failure and retries without duplicate assets',async()=>{
  let fail=true;
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('cursor=next')){if(fail)throw new Error('offline');return page(['asset-1','asset-2']);}
    return page(['asset-1'],'next');
  });
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  fireEvent.click(await screen.findByRole('button',{name:'more'}));
  await screen.findByText('offline');expect(screen.getByText('asset-1')).toBeTruthy();
  fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
  await screen.findByText('asset-2');expect(screen.getAllByText('asset-1')).toHaveLength(1);
});

it('refreshes a changed revision and returns to root if the selected character disappears',async()=>{
  const result=render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  await screen.findByText('asset-1');
  mocks.api.mockResolvedValue({...index,revision:'b'.repeat(64),nodes:[],scopes:[]});
  result.rerender(<CharacterBrowser {...props} refreshKey={2}/>);
  await screen.findByText('등록된 시리즈가 없습니다');
  expect(screen.queryByText('asset-1')).toBeNull();
});

it('declines Back for a directly opened folder but steps up from drilled-down nodes',async()=>{
  const first=render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('heading',{name:'Series'});
  expect(backRef.current?.()).toBe(false);
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2장'}));
  await screen.findByRole('heading',{name:'Group'});
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(await screen.findByRole('heading',{name:'Series'})).toBeTruthy();
  first.unmount();
});

it('does not invent a parent after filtering a directly opened series',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('heading',{name:'Series'});
  fireEvent.click(screen.getByRole('radio',{name:/미분류/}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('filter=unclassified'))).toBe(true));
  expect(backRef.current?.()).toBe(false);
});

it('keeps the series overview reachable by stepping up from a series opened inside it',async()=>{
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  await screen.findByRole('heading',{name:'Series'});
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(await screen.findByRole('heading',{name:'시리즈'})).toBeTruthy();
  // The bare overview was entered from the index, so the next Back belongs to the host.
  expect(backRef.current?.()).toBe(false);
});

it('sends the header arrow to the host on a direct entry without impersonating Back',async()=>{
  const backEvents:Event[]=[];
  const listener=()=>backEvents.push(new Event('lakomics-back'));
  window.addEventListener('lakomics-back',listener);
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('heading',{name:'Series'});
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  // The host owns the exit, so no global Back event is synthesised.
  expect(onExit).toHaveBeenCalledTimes(1);
  expect(backEvents).toHaveLength(0);
  // Drilled down, the arrow still steps up inside the browser instead of exiting.
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2장'}));
  await screen.findByRole('heading',{name:'Group'});
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  expect(await screen.findByRole('heading',{name:'Series'})).toBeTruthy();
  expect(onExit).toHaveBeenCalledTimes(1);
  window.removeEventListener('lakomics-back',listener);
});

it('distinguishes an older server from an unpublished character view',async()=>{
  mocks.api.mockRejectedValue(Object.assign(new Error('missing'),{status:404}));
  render(<CharacterBrowser {...props}/>);
  await screen.findByText('서버에 캐릭터 보기 업데이트가 필요합니다.');
  mocks.api.mockResolvedValue({...index,ready:false,revision:null,nodes:[],scopes:[]});
  fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
  await screen.findByText('캐릭터 보기가 아직 공유되지 않았습니다');
});

 it('uses the PC overview in landscape and keeps the compact portrait view on rotation',async()=>{
  let rotate!:()=>void;
  const media={matches:true,addEventListener:(_name:string,listener:()=>void)=>{rotate=listener;},removeEventListener:()=>{}};
  vi.stubGlobal('matchMedia',(query:string)=>query.includes('orientation')?media:{matches:false,addEventListener(){},removeEventListener(){}});
  const withHero=structuredClone(index);withHero.nodes[0].heroAssetId='hero';
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?withHero:page());
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  const hero=await screen.findByRole('img',{name:'Series 대표 이미지'});
  expect(screen.getByLabelText('character gallery').contains(hero)).toBe(true);
  expect(screen.getByRole('heading',{name:'Series'})).toBeTruthy();
  await screen.findByText('asset-1');
  act(()=>{media.matches=false;rotate();});
  expect(screen.queryByRole('img',{name:'Series 대표 이미지'})).toBeNull();
  expect(screen.getByRole('heading',{name:'Series'})).toBeTruthy();
  expect(screen.getByText('asset-1')).toBeTruthy();
});

it('keeps an internal level on tab return but resets an explicit re-entry to its series',async()=>{
  const view=render(<CharacterBrowser {...props} initialNode="series:s" entryKey={1}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2장'}));
  await screen.findByRole('heading',{name:'Group'});
  view.rerender(<CharacterBrowser {...props} initialNode="series:s" entryKey={1} active={false}/>);
  view.rerender(<CharacterBrowser {...props} initialNode="series:s" entryKey={1}/>);
  await screen.findByRole('heading',{name:'Group'});
  view.rerender(<CharacterBrowser {...props} initialNode="series:s" entryKey={2}/>);
  await screen.findByRole('heading',{name:'Series'});
  expect(backRef.current?.()).toBe(false);
});

it('hands the visible scope items to the options menu so the host can offer FAULT',async()=>{
  const onOptions=vi.fn();
  render(<CharacterBrowser {...props} onOptions={onOptions}/>);
  fireEvent.click(screen.getByRole('button',{name:'보기'}));expect(onOptions).toHaveBeenLastCalledWith([]);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));await screen.findByText('asset-2');
  fireEvent.click(screen.getByRole('button',{name:'보기'}));expect(onOptions).toHaveBeenLastCalledWith(page().items);
});

it('offers 미분류 and 전체 이미지 only, opens a series on 미분류, and keeps 보기 quiet',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s" optionsHost={null}/>);
  await screen.findByRole('heading',{name:'Series'});
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).includes('node=series%3As')&&String(path).includes('filter=unclassified'))).toBe(true));
  expect(mocks.api.mock.calls.some(([path])=>String(path).includes('filter=needs_review'))).toBe(false);
  expect(screen.queryByRole('button',{name:'추가 확인'})).toBeNull();
  expect([...screen.getByRole('radiogroup',{name:'이미지 범위'}).querySelectorAll('.ui-segmented__label > span:first-child')].map(b=>b.textContent)).toEqual(['미분류','전체']);
  expect(screen.queryByRole('group',{name:'자산 필터'})).toBeNull();
  const options=()=>screen.getByRole('button',{name:'보기'});
  expect(options().classList.contains('is-changed')).toBe(false);
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:/전체/}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).includes('filter=all'))).toBe(true));
  expect(options().classList.contains('is-changed')).toBe(false);
  expect(options().textContent).not.toContain('1');
  // Back resets the series to its default 미분류 before leaving.
  let consumed=false;act(()=>{consumed=backRef.current?.()??false;});expect(consumed).toBe(true);
  await waitFor(()=>expect(screen.getByRole('radio',{name:/미분류/}).getAttribute('aria-checked')).toBe('true'));
  expect(options().classList.contains('is-changed')).toBe(false);
});
it('hosts character view filters and sorting in the shared view sheet without toolbar filters',async()=>{
 const host=document.createElement('div');document.body.append(host);
 try{
  render(<CharacterBrowser {...props} initialNode="series:s" optionsHost={host}/>);
  await screen.findByRole('heading',{name:'Series'});
  expect(screen.queryByRole('group',{name:'자산 필터'})).toBeNull();
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'비율'})).getByRole('radio',{name:'가로형'}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).includes('aspect_ratio=landscape'))).toBe(true));
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'정렬'})).getByRole('radio',{name:'오래된순'}));
  await waitFor(()=>{const path=String(mocks.api.mock.calls.at(-1)?.[0]);expect(new URL(path,'https://test').searchParams.getAll('sort')).toEqual(['oldest']);});
  fireEvent.click(screen.getByRole('radio',{name:'이미지'}));
  // Length only narrows videos, so its row leaves while only images are shown.
  await waitFor(()=>expect(screen.queryByRole('radiogroup',{name:'길이'})).toBeNull());
 }finally{host.remove();}
});
it('opens the image range explanation from the info button',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('radiogroup',{name:'이미지 범위'});
  fireEvent.click(screen.getByRole('button',{name:'미분류와 전체 설명'}));
  const sheet=await screen.findByRole('dialog',{name:'미분류와 전체'});
  expect(within(sheet).getByText(/이 폴더에 바로 들어 있고 아직 캐릭터나 하위 폴더에 없는 이미지/)).toBeTruthy();
  expect(within(sheet).getByText(/캐릭터와 하위 폴더까지 모두/)).toBeTruthy();
});
it('uses the series unclassified empty state',async()=>{
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(index):page([]));
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  expect(await screen.findByText('미분류 이미지가 없습니다')).toBeTruthy();
});
it("enters another folder without showing the last visit's tiles while the new page loads",async()=>{
  let finish!:(result:CharacterPage)=>void;
  mocks.api.mockImplementation((path:string)=>{
    if(path.endsWith('/characters'))return Promise.resolve(structuredClone(index));
    if(path.includes('toc=1'))return Promise.resolve({});
    if(path.includes('character%3Ac')||path.includes('character:c'))return new Promise(resolve=>{finish=resolve;});
    return Promise.resolve(page(['old']));
  });
  const view=render(<CharacterBrowser {...props} initialNode="series:s" entryKey={1}/>);
  await screen.findByText('old');
  // Leave the character boundary (another Library place), then enter a different folder.
  view.rerender(<CharacterBrowser {...props} active={false} initialNode="series:s" entryKey={1}/>);
  view.rerender(<CharacterBrowser {...props} initialNode="character:c" entryKey={2}/>);
  // The folder visited earlier is a different place: none of its tiles stand in for this one.
  expect(screen.queryByText('old')).toBeNull();
  await waitFor(()=>expect(finish).toBeDefined());
  expect(screen.queryByText('old')).toBeNull();
  await act(async()=>finish(page(['new'])));
  expect(await screen.findByText('new')).toBeTruthy();
});
it('keeps the committed gallery page while a series filter replacement is pending',async()=>{
  let finish!:(result:CharacterPage)=>void;
  mocks.api.mockImplementation((path:string)=>{
    if(path.endsWith('/characters'))return Promise.resolve(structuredClone(index));
    if(path.includes('toc=1'))return Promise.resolve({});
    if(path.includes('filter=all'))return new Promise(resolve=>{finish=resolve;});
    return Promise.resolve(page(['old']));
  });
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByText('old');
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:/전체/}));
  expect(screen.getByText('old')).toBeTruthy();
  await waitFor(()=>expect(finish).toBeDefined());
  expect(screen.getByLabelText('character gallery').getAttribute('data-stale')).toBe('true');
  await act(async()=>finish(page([])));
  await waitFor(()=>expect(screen.queryByText('old')).toBeNull());
  expect(screen.getByLabelText('character gallery').getAttribute('data-stale')).toBeNull();
  expect(screen.getByText('이 보기에 자산이 없습니다')).toBeTruthy();
});

it('keeps each character header with its own images when returning and opening a sibling',async()=>{
  const siblings=structuredClone(index);
  siblings.nodes.push(node('character','other','Other','group:g'));
  siblings.scopes.push({nodeId:'character:other',filter:'all',totalCount:7,sourceCount:7});
  const next=Promise.withResolvers<CharacterPage>();
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return siblings;
    if(path.includes('toc=1'))return {};
    const selected=new URL(path,'https://test').searchParams.get('node');
    return selected==='character:other'?next.promise:page([selected==='character:c'?'first-character':'group-image']);
  });
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  await screen.findByText('group-image');
  fireEvent.click(screen.getByRole('button',{name:'Character · 2장'}));
  await screen.findByText('first-character');
  expect(screen.getByRole('heading',{name:'Character'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await screen.findByText('group-image');
  expect(screen.getByRole('heading',{name:'Group'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Other · 7장'}));
  await waitFor(()=>expect(screen.getByLabelText('character gallery').getAttribute('data-stale')).toBe('true'));
  expect(screen.getByRole('heading',{name:'Group'})).toBeTruthy();
  expect(screen.getByText('group-image')).toBeTruthy();
  expect(screen.queryByText('first-character')).toBeNull();
  await act(async()=>next.resolve({...page(['second-character']),totalCount:7,sourceCount:7}));
  await screen.findByText('second-character');
  expect(screen.getByRole('heading',{name:'Other'})).toBeTruthy();
  expect(screen.queryByText('group-image')).toBeNull();
});
it('shows the character breadcrumb parents and keeps the title free of a count',async()=>{
  const characterIndex=structuredClone(index);
  characterIndex.nodes.push(node('character','child','Child','character:c'));
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?characterIndex:page());
  render(<CharacterBrowser {...props} initialNode="character:c"/>);
  const heading=await screen.findByRole('heading',{name:'Character'});
  const navigation=screen.getByRole('navigation',{name:'현재 위치'});
  expect([...navigation.querySelectorAll('button')].map(button=>button.textContent)).toEqual(['Series','Group']);
  expect(heading.textContent).toBe('Character');
  expect(heading.parentElement?.textContent).not.toContain('2장');
});
it('shows a scope or filter load only as the line in the top bar, never inside the content',async()=>{
  const held:((p:CharacterPage)=>void)[]=[];let hold=true;
  mocks.api.mockImplementation((path:string)=>{
    if(path.endsWith('/characters'))return Promise.resolve(structuredClone(index));
    return hold?new Promise<CharacterPage>(resolve=>{held.push(resolve);}):Promise.resolve(page(['a1']));
  });
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  const inBar=()=>waitFor(()=>{
    const line=screen.getByRole('status',{name:'캐릭터 보기 불러오는 중'});
    expect(line.closest('header.top-bar')).not.toBeNull();
    expect(line.closest('[aria-label="character gallery"]')).toBeNull();
    expect(document.querySelectorAll('.loading-line:not(.is-bottom)')).toHaveLength(1);
  });
  await inBar();
  hold=false;await act(async()=>held.splice(0).forEach(resolve=>resolve(page(['a1']))));
  await waitFor(()=>expect(screen.queryByRole('status',{name:'캐릭터 보기 불러오는 중'})).toBeNull());
  hold=true;fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:/전체/}));
  await inBar();
});

it('passes privacy to the gallery opened directly from Find',async()=>{
  localStorage.setItem('lakomics.mobile.privacyMode','1');
  try {
    render(<CharacterBrowser {...props} initialNode="character:c"/>);
    await screen.findByText('asset-1');
    expect(screen.getByLabelText('character gallery').getAttribute('data-privacy')).toBe('true');
  } finally {localStorage.removeItem('lakomics.mobile.privacyMode');}
});


it('replaces covers by asset identity and reuses cached previews on A → B → A or tab remount',async()=>{
  let current=structuredClone(index);
  current.nodes=current.nodes.map(item=>item.id==='series:s'?{...item,thumbnailAssetId:'f2-mobile-a'}:item);
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?current:page());
  mocks.loadThumbnail.mockImplementation(async(a:Asset)=>({...a,preview:`data:image/png;base64,${a.id}`}));
  let view=render(<CharacterBrowser {...props}/>);
  const card=()=>screen.getByRole('button',{name:'Series · 2장'});
  const first=await waitFor(()=>{const image=card().querySelector('img')!;expect(image?.getAttribute('src')).toContain('f2-mobile-a');return image;});
  fireEvent.load(first);
  let finish!:(asset:Asset)=>void;
  mocks.loadThumbnail.mockImplementation((a:Asset)=>a.id==='f2-mobile-b'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({...a,preview:`data:image/png;base64,${a.id}`}));
  current={...current,revision:'b'.repeat(64),nodes:current.nodes.map(item=>item.id==='series:s'?{...item,thumbnailAssetId:'f2-mobile-b'}:item)};
  view.rerender(<CharacterBrowser {...props} refreshKey={2}/>);
  await waitFor(()=>expect(mocks.loadThumbnail.mock.calls.some(([a])=>a.id==='f2-mobile-b')).toBe(true));
  expect(card().querySelector('img')).toBeNull();
  expect(card().querySelector('.character-card-image > svg')).toBeTruthy();
  await act(async()=>finish({id:'f2-mobile-b',kind:'image',preview:'data:image/png;base64,f2-mobile-b'}));
  const next=card().querySelector<HTMLImageElement>('img')!;
  expect(next?.getAttribute('src')).toBe('data:image/png;base64,f2-mobile-b');
  expect(card().contains(first)).toBe(false);
  fireEvent.load(next);
  expect(next.style.visibility).not.toBe('hidden');
  current={...current,revision:'c'.repeat(64),nodes:current.nodes.map(item=>item.id==='series:s'?{...item,thumbnailAssetId:'f2-mobile-a'}:item)};
  view.rerender(<CharacterBrowser {...props} refreshKey={3}/>);
  await waitFor(()=>expect(card().querySelector('img:not([aria-hidden])')?.getAttribute('src')).toContain('f2-mobile-a'));
  expect(card().querySelector('.character-card-image > svg')).toBeNull();
  expect(mocks.loadThumbnail.mock.calls.filter(([a])=>a.id==='f2-mobile-a')).toHaveLength(1);
  view.unmount();
  mocks.loadThumbnail.mockReturnValue(new Promise(()=>{}));
  view=render(<CharacterBrowser {...props}/>);
  await screen.findByRole('button',{name:'Series · 2장'});
  expect(card().querySelector('img')?.getAttribute('src')).toContain('f2-mobile-a');
  expect(card().querySelector('.character-card-image > svg')).toBeNull();
  expect(mocks.loadThumbnail.mock.calls.filter(([a])=>a.id==='f2-mobile-a')).toHaveLength(1);
});

it('drops an old explicit cover when the filter turns on and a new safe cover is still loading',async()=>{
 const oldId='review-old-explicit',newId='review-new-safe';
 let current={...structuredClone(index),contentRatings:{[oldId]:'e' as const,[newId]:'g' as const}};
 current.nodes[0].thumbnailAssetId=oldId;
 mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(current):page());
 const safe=Promise.withResolvers<Asset>();
 mocks.loadThumbnail.mockImplementation((asset:Asset)=>asset.id===newId?safe.promise:Promise.resolve({...asset,preview:`https://test.invalid/${oldId}`}));
 try {
  const {container,rerender}=render(<CharacterBrowser {...props}/>);
  await waitFor(()=>expect(container.querySelector(`img[src$="/${oldId}"]`)).toBeTruthy());
  const oldImage=container.querySelector('img');
  current.nodes[0].thumbnailAssetId=newId;
  localStorage.setItem('lakomics.mobile.nsfwFilter','1');
  act(()=>window.dispatchEvent(new CustomEvent('lakomics-privacy-mode')));
  rerender(<CharacterBrowser {...props} refreshKey={2}/>);
  await waitFor(()=>expect(mocks.loadThumbnail.mock.calls.some(([asset])=>asset.id===newId)).toBe(true));
  expect(container.querySelector(`img[src$="/${oldId}"]`)).toBeNull();
  safe.resolve({id:newId,kind:'image',contentRating:'g',preview:`https://test.invalid/${newId}`});
  await waitFor(()=>expect(container.querySelector(`img[src$="/${newId}"]`)).toBeTruthy());
  expect(container.contains(oldImage)).toBe(false);
 }finally {localStorage.removeItem('lakomics.mobile.nsfwFilter');}
});

it('selects like the plain gallery, reports its loaded items and pages for a viewer opened from it',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    return path.includes('cursor=next')?page(['second']):{...page(['first']),has_more:true,next_cursor:'next'};
  });
  const onSelect=vi.fn(),onToggle=vi.fn(),onClear=vi.fn(),onItems=vi.fn();
  const moreRef:{current:(()=>void)|null}={current:null};
  render(<CharacterBrowser {...props} initialNode="character:c" selection={{ids:new Set(['first']),onSelect,onToggle,onClear}} onItems={onItems} moreRef={moreRef}/>);
  await screen.findByText('first');
  expect(screen.getByText('first').getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByText('select first'));
  expect(onSelect).toHaveBeenCalledWith('first');
  await waitFor(()=>expect(onItems.mock.calls.at(-1)?.[0].map((asset:Asset)=>asset.id)).toEqual(['first']));
  act(()=>{moreRef.current?.();});
  await screen.findByText('second');
  await waitFor(()=>expect(onItems.mock.calls.at(-1)?.[0].map((asset:Asset)=>asset.id)).toEqual(['first','second']));
});

it('shows a role:"extras" node as a 기타 card last among the character cards, in series and group screens',async()=>{
  const withExtras=structuredClone(index);
  // The stored name is "<group or series> 기타"; the cards say just 기타. Server order puts it first on purpose.
  withExtras.nodes.unshift({...node('character','x-s','Series 기타','series:s'),role:'extras' as const},{...node('character','x-g','Group 기타','group:g'),role:'extras' as const});
  withExtras.nodes.push(node('character','plain','Plain','series:s'),node('series','inner','Inner',null));
  withExtras.scopes.push({nodeId:'character:x-s',filter:'all',totalCount:42,sourceCount:42},{nodeId:'character:x-g',filter:'all',totalCount:7,sourceCount:7});
  const classifications=[{id:'s',name:'Series',parent_id:null,asset_count:0},{id:'inner',name:'Inner',parent_id:'s',asset_count:0}];
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?withExtras:page());
  const view=render(<CharacterBrowser {...props} classifications={classifications} initialNode="series:s"/>);
  const extras=await screen.findByRole('button',{name:'기타 · 42장'});
  const track=extras.closest('.home-shelf__track')!;
  // 그룹 → 그룹 밖 캐릭터 → 기타 → 안쪽 시리즈.
  expect([...track.querySelectorAll('.character-card')].map(card=>card.getAttribute('aria-label'))).toEqual(['Group · 2장','Plain','기타 · 42장','Inner']);
  expect(screen.queryByText('Series 기타')).toBeNull();
  expect(track.querySelector('.character-card-image--extras')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Group · 2장'}));
  const groupExtras=await screen.findByRole('button',{name:'기타 · 7장'});
  const members=[...groupExtras.closest('.home-shelf__track')!.querySelectorAll('.character-card')].map(card=>card.getAttribute('aria-label'));
  expect(members).toEqual(['Character · 2장','기타 · 7장']);
  fireEvent.click(groupExtras);
  // Opening shows its images under the title 기타, with the group in the path.
  await screen.findByRole('heading',{name:'기타'});
  expect(mocks.api.mock.calls.some(([p])=>p.includes('node=character%3Ax-g'))).toBe(true);
  expect(screen.getByRole('button',{name:'Group'})).toBeTruthy();
  view.unmount();
});

it('keeps working with a snapshot that has no role: every character node is an ordinary character',async()=>{
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  const card=await screen.findByRole('button',{name:'Character · 2장'});
  expect(card.querySelector('.character-card-image--extras')).toBeNull();
  expect(screen.queryByRole('button',{name:/^기타/})).toBeNull();
});

it('names a 기타 in the manual-exclusion context so the viewer says 기타, not the stored name',()=>{
  const capable={...structuredClone(index),libraryId:'b'.repeat(32),exclusionCursor:0,capabilities:{read:true,write:false,manualExclusion:true}};
  const extras={...node('character','x','Group 기타','group:g'),role:'extras' as const,protectedAssetIds:[]};
  expect(viewerCharacterContext(extras,capable)).toMatchObject({targetId:'x',name:'기타'});
});

it('opens a group whose only child is its 기타 straight to the 기타 images under the group name',async()=>{
  const soloGroup=structuredClone(index);
  soloGroup.nodes=[node('series','s','Series',null),node('group','solo','Solo group','series:s'),{...node('character','x-solo','Solo group 기타','group:solo'),role:'extras' as const}];
  soloGroup.scopes.push({nodeId:'group:solo',filter:'all',totalCount:5,sourceCount:5},{nodeId:'character:x-solo',filter:'all',totalCount:5,sourceCount:5});
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(soloGroup):page(['solo-1','solo-2']));
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Solo group · 5장'}));
  await screen.findByText('solo-1');
  expect(screen.getByRole('heading',{name:'Solo group'})).toBeTruthy();
  // The images are the 기타's own; no 기타 title, no 기타 card.
  expect(screen.queryByRole('heading',{name:'기타'})).toBeNull();
  expect(screen.queryByRole('button',{name:/^기타/})).toBeNull();
  expect(mocks.api.mock.calls.some(([p])=>p.includes('node=character%3Ax-solo'))).toBe(true);
  expect(mocks.api.mock.calls.some(([p])=>p.includes('node=group%3Asolo'))).toBe(false);
  // Back leaves the group for its series as for any group.
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(await screen.findByRole('heading',{name:'Series'})).toBeTruthy();
});

it('fills a group card with its 기타 images: a 기타-only group shows up to four, a group with one member fills the rest',async()=>{
  const filled=structuredClone(index);
  const cover=(id:string,thumbnailAssetId:string)=>({...node('character',id,id,'group:fill-one'),thumbnailAssetId});
  filled.nodes=[
    node('series','s','Series',null),
    node('group','fill-only','Only 기타','series:s'),{...node('character','fill-x-only','Only 기타 기타','group:fill-only'),role:'extras' as const,thumbnailAssetId:'only-1'},
    node('group','fill-one','One member','series:s'),cover('fill-m','member-1'),{...node('character','fill-x-one','One member 기타','group:fill-one'),role:'extras' as const,thumbnailAssetId:'one-1'},
  ];
  filled.scopes.push({nodeId:'group:fill-only',filter:'all',totalCount:6,sourceCount:6},{nodeId:'group:fill-one',filter:'all',totalCount:6,sourceCount:6});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(filled);
    const node=new URL(path,'https://test').searchParams.get('node');
    if(node==='character:fill-x-only')return page(['only-1','only-2','only-3','only-4','only-5','only-6']);
    if(node==='character:fill-x-one')return page(['one-1','one-2','one-3','one-4']);
    return page();
  });
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  const only=await screen.findByRole('button',{name:'Only 기타 · 6장'});
  const one=screen.getByRole('button',{name:'One member · 6장'});
  const shown=(card:HTMLElement)=>[...card.querySelectorAll('.character-mosaic > span')].map(slot=>slot.querySelector('img')?.getAttribute('src')??'');
  await waitFor(()=>expect(only.querySelector('.character-mosaic')?.getAttribute('data-count')).toBe('4'));
  await waitFor(()=>expect(one.querySelector('.character-mosaic')?.getAttribute('data-count')).toBe('4'));
  const requested=mocks.loadThumbnail.mock.calls.map(([asset])=>asset.id);
  // Members first, then the 기타's newest images; one read per 기타.
  expect(requested).toEqual(expect.arrayContaining(['only-1','only-2','only-3','only-4','member-1','one-1','one-2','one-3']));
  expect(requested).not.toContain('only-5');expect(requested).not.toContain('one-4');
  await waitFor(()=>expect(shown(one).filter(Boolean)).toHaveLength(4));
  expect(shown(only).filter(Boolean)).toHaveLength(4);
  expect(mocks.api.mock.calls.filter(([p])=>p.includes('node=character%3Afill-x-only'))).toHaveLength(1);
});

it('lists a series groups in the order the PC published, and in the server order for an old snapshot',async()=>{
  const groups=structuredClone(index);
  groups.nodes.push(node('group','h','Hares','series:s'),node('group','i','Interns','series:s'));
  const cards=()=>[...document.querySelectorAll('.character-card[data-kind="group"]')].map(card=>card.textContent);
  // An old snapshot has no group entries: the server's order stays.
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(groups):page());
  const first=render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('button',{name:/Interns/});
  expect(cards().map(text=>text?.replace(/\d.*$/,''))).toEqual(['Group','Hares','Interns']);
  first.unmount();cleanup();
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?{...structuredClone(groups),navigationOrder:['series:s','group:i','group:g','group:h']}:page());
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('button',{name:/Interns/});
  expect(cards().map(text=>text?.replace(/\d.*$/,''))).toEqual(['Interns','Group','Hares']);
});


it.each(['series:s','group:g','character:c'])('shows and clears the committed filter chip in %s without flashing',async(initialNode)=>{
  let finish!:(value:unknown)=>void, holdClear=false;
  mocks.api.mockImplementation((path:string)=>{
    if(path==='/v1/library/characters')return Promise.resolve(structuredClone(index));
    if(path.includes('toc=1'))return Promise.resolve({});
    if(path.includes('media_kind=videos')||holdClear)return new Promise(resolve=>{finish=resolve;});
    return Promise.resolve({...page(['old']),filterVersion:1});
  });
  render(<CharacterBrowser {...props} initialNode={initialNode}/>);
  await screen.findByText('old');
  expect(screen.queryByRole('group',{name:'보기 필터'})).toBeNull();
  fireEvent.click(screen.getByRole('radio',{name:'영상'}));
  await waitFor(()=>expect(finish).toBeDefined());
  expect(screen.getByText('old')).toBeTruthy();
  expect(screen.queryByRole('group',{name:'보기 필터'})).toBeNull();
  await act(async()=>finish({...page(['video']),filterVersion:1}));
  const chip=await screen.findByRole('group',{name:'보기 필터'});
  expect(chip.textContent).toBe('영상만');
  expect(chip.closest('.top-bar__title')?.querySelector('h1')).toBeTruthy();
  holdClear=true;fireEvent.click(within(chip).getByRole('button',{name:'필터 초기화'}));
  await waitFor(()=>expect(String(mocks.api.mock.calls.at(-1)?.[0])).not.toContain('media_kind'));
  expect(screen.getByText('video')).toBeTruthy();
  expect(screen.getByRole('group',{name:'보기 필터'})).toBeTruthy();
  await act(async()=>finish({...page(['old']),filterVersion:1}));
  await waitFor(()=>expect(screen.queryByRole('group',{name:'보기 필터'})).toBeNull());
  expect(screen.getByText('old')).toBeTruthy();
});

it('names the applied filter in an empty character scope and preserves sort on clear',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/library/characters')return structuredClone(index);
    if(path.includes('toc=1'))return {};
    return {...page(path.includes('duration_ms_min')?[]:['old']),filterVersion:1};
  });
  const host=document.createElement('div');document.body.append(host);
  try{
    render(<CharacterBrowser {...props} initialNode="character:c" optionsHost={host}/>);
    await screen.findByText('old');
    fireEvent.click(screen.getByRole('radio',{name:'영상'}));
    await screen.findByRole('group',{name:'보기 필터'});
    fireEvent.click(screen.getByRole('radio',{name:'오래된순'}));
    fireEvent.click(screen.getByRole('radio',{name:'세로형'}));
    fireEvent.click(screen.getByRole('radio',{name:'1–5분'}));
    await screen.findByText('1–5분 세로형 영상 없음');
    expect(screen.getByText('1–5분 세로형 영상만 보는 중')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group',{name:'보기 필터'})).getByRole('button',{name:'필터 초기화'}));
    await screen.findByText('old');
    await waitFor(()=>expect(screen.queryByRole('group',{name:'보기 필터'})).toBeNull());
    const url=new URL(String(mocks.api.mock.calls.findLast(([path])=>!path.includes('toc=1'))?.[0]),'https://test');
    expect(url.searchParams.get('sort')).toBe('oldest');
    for(const key of ['media_kind','aspect_ratio','duration_ms_min','duration_ms_max'])expect(url.searchParams.has(key)).toBe(false);
  }finally{host.remove();}
});
