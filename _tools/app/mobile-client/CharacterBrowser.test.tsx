import type {ReactNode} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import {CharacterBrowser} from './CharacterBrowser';
import type {CharacterIndex,CharacterPage} from './characterModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),loadThumbnail:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(e:Error)=>e.message}));
vi.mock('./media',()=>({loadThumbnail:mocks.loadThumbnail}));
vi.mock('./Gallery',()=>({Gallery:({items,onOpen,onNearEnd,restoreScroll,intro}:{intro?:import('react').ReactNode;items:Asset[];onOpen(i:number):void;onNearEnd():void;restoreScroll:number})=><div aria-label="character gallery" data-scroll={restoreScroll}>{intro}{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i)}>{a.id}</button>)}<button onClick={onNearEnd}>more</button></div>}));
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

it('navigates series, groups and characters, opens shared assets and returns to parents',async()=>{
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
  fireEvent.click(screen.getByRole('button',{name:'Character · 2개'}));
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
  const last=await screen.findByRole('button',{name:'Extra 8 · 0개'});
  const strip=last.closest('.character-folder-strip') as HTMLElement;
  expect(strip).toBeTruthy();
  expect(strip.querySelectorAll('.character-card')).toHaveLength(10);
  expect(screen.queryByRole('button',{name:'다음 폴더'})).toBeNull();
  const gallery=await screen.findByLabelText('character gallery');
  const asset=screen.getByText('asset-1');
  const reads=mocks.api.mock.calls.length;
  strip.scrollLeft=320;
  const toggle=screen.getByRole('button',{name:'캐릭터 폴더 접기'});
  expect(toggle.getAttribute('aria-controls')).toBe(strip.id);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.parentElement?.contains(screen.getByRole('button',{name:'미분류'}))).toBe(true);
  fireEvent.click(toggle);
  expect(strip.hidden).toBe(true);
  expect(screen.queryByRole('button',{name:'Extra 8 · 0개'})).toBeNull();
  expect(screen.getByText('asset-1')).toBe(asset);
  expect(screen.getByLabelText('character gallery')).toBe(gallery);
  expect(mocks.api).toHaveBeenCalledTimes(reads);
  expect(backRef.current?.()).toBe(false);
  view.rerender(<CharacterBrowser {...props} initialNode="series:s" paused/>);
  view.rerender(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  expect(strip.hidden).toBe(false);expect(strip.scrollLeft).toBe(320);
  fireEvent.click(screen.getByRole('button',{name:'Extra 8 · 0개'}));
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
  const first=await screen.findByRole('button',{name:'Extra 0 · 0개'});
  const last=screen.getByRole('button',{name:'Extra 8 · 0개'});
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

it('keeps series filters usable while folded and offers folding inside a group',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(await screen.findByRole('button',{name:'캐릭터 폴더 접기'}));
  fireEvent.click(screen.getByRole('button',{name:'미분류'}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('filter=unclassified'))).toBe(true));
  expect(screen.getByRole('button',{name:'미분류'}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  fireEvent.click(screen.getByRole('button',{name:'Group · 2개'}));
  await screen.findByRole('heading',{name:'Group'});
  expect(screen.queryByRole('button',{name:'미분류'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 접기'}));
  expect(screen.queryByRole('button',{name:'Character · 2개'})).toBeNull();
  expect(screen.getByText('asset-1')).toBeTruthy();
});

it('preserves bounded landscape pages when rotating from a folded portrait strip',async()=>{
  let rotate!:()=>void;
  const media={matches:false,addEventListener:(_name:string,listener:()=>void)=>{rotate=listener;},removeEventListener:()=>{}};
  vi.stubGlobal('matchMedia',()=>media);
  const many=structuredClone(index);
  many.nodes.push(...Array.from({length:9},(_,i)=>node('character',`extra-${i}`,`Extra ${i}`,'series:s')));
  mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?many:page());
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  fireEvent.click(await screen.findByRole('button',{name:'캐릭터 폴더 접기'}));
  act(()=>{media.matches=true;rotate();});
  expect(screen.queryByRole('button',{name:'캐릭터 폴더 펼치기'})).toBeNull();
  expect(screen.getByRole('button',{name:'Group · 2개'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Extra 8 · 0개'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'다음 폴더'}));
  expect(screen.getByRole('button',{name:'Extra 8 · 0개'})).toBeTruthy();
  act(()=>{media.matches=false;rotate();});
  expect(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 폴더 펼치기'}));
  expect(screen.getByRole('button',{name:'Group · 2개'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Extra 8 · 0개'})).toBeTruthy();
});

it('rejects a late page after changing the series filter',async()=>{
  let finish!:(p:CharacterPage)=>void;
  mocks.api.mockImplementation((path:string)=>{
    if(path.endsWith('/characters'))return Promise.resolve(structuredClone(index));
    if(path.includes('filter=all'))return new Promise(resolve=>{finish=resolve;});
    return Promise.resolve(page([]));
  });
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  await waitFor(()=>expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole('button',{name:'미분류'}));
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
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
  fireEvent.click(await screen.findByRole('button',{name:'more'}));
  await screen.findByText('offline');expect(screen.getByText('asset-1')).toBeTruthy();
  fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
  await screen.findByText('asset-2');expect(screen.getAllByText('asset-1')).toHaveLength(1);
});

it('refreshes a changed revision and returns to root if the selected character disappears',async()=>{
  const result=render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
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
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
  await screen.findByRole('heading',{name:'Group'});
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(await screen.findByRole('heading',{name:'Series'})).toBeTruthy();
  first.unmount();
});

it('does not invent a parent after filtering a directly opened series',async()=>{
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await screen.findByRole('heading',{name:'Series'});
  fireEvent.click(screen.getByRole('button',{name:'미분류'}));
  await waitFor(()=>expect(mocks.api.mock.calls.some(([path])=>path.includes('filter=unclassified'))).toBe(true));
  expect(backRef.current?.()).toBe(false);
});

it('keeps the series overview reachable by stepping up from a series opened inside it',async()=>{
  render(<CharacterBrowser {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
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
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
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
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
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
  fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
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
  fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));await screen.findByText('asset-2');
  fireEvent.click(screen.getByRole('button',{name:'보기 옵션'}));expect(onOptions).toHaveBeenLastCalledWith(page().items);
});
