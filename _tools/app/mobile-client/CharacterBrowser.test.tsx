import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import {CharacterBrowser} from './CharacterBrowser';
import type {CharacterIndex,CharacterPage} from './characterModel';
import type {SparseGallerySource} from './assetToc';

const mocks=vi.hoisted(()=>({api:vi.fn(),loadThumbnail:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(e:Error)=>e.message}));
vi.mock('./media',()=>({loadThumbnail:mocks.loadThumbnail}));
vi.mock('./Gallery',()=>({Gallery:({items,onOpen,onNearEnd,restoreScroll,intro,stale,sparse,privacy,likesRevision,onRefresh}:{intro?:import('react').ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;restoreScroll:number;stale?:boolean;privacy?:boolean;likesRevision?:unknown;onRefresh?():void;sparse?:SparseGallerySource})=><div aria-label="character gallery" data-likes-revision={String(likesRevision)} data-privacy={String(privacy)} data-scroll={restoreScroll} data-toc={sparse?.toc.totalCount} data-stale={stale?'true':undefined}>{intro}<button onClick={onRefresh}>refresh gallery</button>{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{a.id}</button>)}<button onClick={onNearEnd}>more</button>{sparse&&<button onClick={()=>void sparse.load(2,1,new AbortController().signal)}>seek</button>}</div>}));
const revision='a'.repeat(64);
const node=(kind:'series'|'group'|'character',id:string,name:string,parentId:string|null)=>({id:`${kind}:${id}`,kind,sourceId:id,seriesId:'s',parentId,name,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false});
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
  fireEvent.click(screen.getByRole('button',{name:'Character · 2장'}));
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
  expect(controlled?.hidden).toBe(true);
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
  vi.stubGlobal('matchMedia',()=>media);
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
  fireEvent.click(screen.getByRole('button',{name:'새로고침'}));
  await screen.findByText('캐릭터 보기가 아직 공유되지 않았습니다');
});

 it('uses the PC overview in landscape and keeps the compact portrait view on rotation',async()=>{
  let rotate!:()=>void;
  const media={matches:true,addEventListener:(_name:string,listener:()=>void)=>{rotate=listener;},removeEventListener:()=>{}};
  vi.stubGlobal('matchMedia',()=>media);
  const withHero=structuredClone(index);withHero.nodes[0].heroAssetId='hero';
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?withHero:page());
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));
  const hero=await screen.findByRole('img',{name:'Series 대표 이미지'});
  expect(screen.getByLabelText('character gallery').contains(hero)).toBe(true);
  expect(screen.getByRole('navigation',{name:'현재 위치'})).toBeTruthy();
  await screen.findByText('asset-1');
  act(()=>{media.matches=false;rotate();});
  expect(screen.queryByRole('img',{name:'Series 대표 이미지'})).toBeNull();
  expect(screen.getByRole('navigation',{name:'현재 위치'})).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));expect(onOptions).toHaveBeenLastCalledWith([]);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2장'}));await screen.findByText('asset-2');
  fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));expect(onOptions).toHaveBeenLastCalledWith(page().items);
});

it('offers 미분류 and 전체 이미지 only, opens a series on 미분류, and keeps 보기 quiet',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s" optionsHost={null}/>);
  await screen.findByRole('heading',{name:'Series'});
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>String(path).includes('node=series%3As')&&String(path).includes('filter=unclassified'))).toBe(true));
  expect(mocks.api.mock.calls.some(([path])=>String(path).includes('filter=needs_review'))).toBe(false);
  expect(screen.queryByRole('button',{name:'추가 확인'})).toBeNull();
  expect([...screen.getByRole('radiogroup',{name:'이미지 범위'}).querySelectorAll('.ui-segmented__label > span:first-child')].map(b=>b.textContent)).toEqual(['미분류','전체']);
  expect([...screen.getByRole('group',{name:'자산 필터'}).querySelectorAll('button')].map(button=>button.textContent)).toEqual(['비율','길이']);
  const options=()=>screen.getByRole('button',{name:'보기 옵션'});
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
it('opens the matching character filter sheet and hides length for images',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('heading',{name:'Series'});
  const toolbar=screen.getByRole('group',{name:'자산 필터'});
  fireEvent.click(within(toolbar).getByRole('button',{name:'비율'}));
  expect(await screen.findByRole('dialog',{name:'비율'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'닫기'}));
  fireEvent.click(screen.getByRole('radio',{name:'이미지'}));
  expect([...screen.getByRole('group',{name:'자산 필터'}).querySelectorAll('button')].map(button=>button.textContent)).toEqual(['비율']);
  expect(screen.queryByText('필터 해제')).toBeNull();
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
it('shows the character breadcrumb parents and keeps the title free of a count',async()=>{
  const characterIndex=structuredClone(index);
  characterIndex.nodes.push(node('character','child','Child','character:c'));
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?characterIndex:page());
  render(<CharacterBrowser {...props} initialNode="character:c"/>);
  const heading=await screen.findByRole('heading',{name:'Character'});
  const navigation=screen.getByRole('navigation',{name:'현재 위치'});
  expect([...navigation.querySelectorAll('button')].map(button=>button.textContent)).toEqual(['Series','Group']);
  expect(heading.getAttribute('aria-label')).toBe('Character');
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


it('never replaces a known preview with a placeholder on A → B → A or tab remount',async()=>{
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
  expect(card().querySelector('img')).toBe(first);
  expect(card().querySelector('.character-card-image > svg')).toBeNull();
  await act(async()=>finish({id:'f2-mobile-b',kind:'image',preview:'data:image/png;base64,f2-mobile-b'}));
  const next=card().querySelector<HTMLImageElement>('[data-stable-image-loading="true"]')!;
  expect(next?.getAttribute('src')).toBe('data:image/png;base64,f2-mobile-b');
  expect(first.style.visibility).not.toBe('hidden');
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
