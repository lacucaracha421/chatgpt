import {useRef,useState} from 'react';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AreaSwitch,MotionScope,READY_CAP_MS,viewReady} from '../src/shared/motion/AreaSwitch';
import {Catalog} from './Catalog';
import {Collections} from './Collections';
import {AREA_PREWARM_IDLE_MS,useAreaPrewarm} from './useAreaPrewarm';
import {usePrivacyMode} from './privacyMode';
import type {CatalogPage} from './catalogModel';
import type {CollectionPage} from './collectionModel';

const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:String}));
const catalog:CatalogPage={ready:true,publicationRevision:'p1',publishedAt:null,context:'context',countToken:'count',countStatus:'pending',totalCount:null,nextCursor:'catalog-next',items:[{
  provider:'kHentai',providerWorkId:'42',groupId:'group',title:'Catalog first',titleJpn:null,thumbnailUrl:'https://example.invalid/cover.jpg',artists:[],series:[],fileCount:40,views:1,posted:1000,bookmarked:false,versionCount:1,hasBookmarkedVersion:false,
}]};
const collections:CollectionPage={ready:true,filterVersion:1,revision:'r1',publishedAt:null,nextCursor:'collection-next',items:[{id:'game',type:'game',name:'Collection first',selectedWorkArtworkId:'cover'}]};
const status={publicationRevision:'p1',capabilities:{bookmarkWrite:false,displayPreferencesVersion:1}};
const areas=['catalog','collections'] as const;
type Area=typeof areas[number];

// The same retained-view and active/prefetch contract used by the tablet shell.
function Shell({enabled=true,scope='connection',busy=false}:{enabled?:boolean;scope?:string;busy?:boolean}) {
  const host=useRef<HTMLDivElement>(null),catalogBack=useRef(null),collectionBack=useRef(null);
  const [active,setActive]=useState('home'),[visited,setVisited]=useState<string[]>([]);
  const [privacy]=usePrivacyMode();
  const warm=useAreaPrewarm(scope,enabled&&active==='home'&&!privacy,host);
  const ready=(element:HTMLElement,key:string)=>viewReady(element)&&(key==='home'||!!element.querySelector(key==='catalog'?'.catalog-card, .empty-state:not([role="status"]), .inline-error':'.collection-tile, .collection-card, .collection-grid > *, .manga-bookcase, .empty-state, .error-message'));
  return <MotionScope><div ref={host}>
    {areas.map(area=><button key={area} onClick={()=>{setVisited(value=>[...value,area]);setActive(area);}}>{area}</button>)}
    <AreaSwitch activeKey={active} retained={['home',...areas]} ready={ready} views={{
      home:<div aria-busy={busy}>Home</div>,
      catalog:(warm.mounted||visited.includes('catalog'))&&<Catalog key={scope} endpoint={scope} active={active==='catalog'} prefetch={warm.prefetch&&!visited.includes('catalog')} paused={false} backRef={catalogBack}/>,
      collections:(warm.mounted||visited.includes('collections'))&&<Collections key={scope} active={active==='collections'} prefetch={warm.prefetch&&!visited.includes('collections')} paused={false} backRef={collectionBack}/>,
    }}/>
  </div></MotionScope>;
}
let frames:Map<number,FrameRequestCallback>,idles:Map<number,IdleRequestCallback>,sequence:number,animate:ReturnType<typeof vi.fn>;
const flush=async()=>{await act(async()=>{});};
async function frame(){await act(async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(performance.now()));});}
async function time(ms:number){await act(async()=>{vi.advanceTimersByTime(ms);});}
async function idle(){await act(async()=>{const callbacks=[...idles.values()];idles.clear();callbacks.forEach(callback=>callback({didTimeout:false,timeRemaining:()=>50}));});}
async function warm(){await frame();await frame();await time(AREA_PREWARM_IDLE_MS);await idle();await flush();}
const lists=(area:Area)=>mocks.api.mock.calls.filter(([path])=>area==='catalog'?path.startsWith('/v1/mobile-catalog/search?'):path.startsWith('/v1/collections?')&&!path.includes('showcase=true'));
const first=(area:Area)=>lists(area).filter(([path])=>!new URL(path,'https://test').searchParams.has('cursor'));
const mounted=(area:Area)=>document.querySelector(area==='catalog'?'.mobile-catalog':'.mobile-collections');
// Area switches swap atomically (user 2026-10-04): a switch has happened once the stage shows a non-Home area.
const dissolves=()=>{const shown=document.querySelector('.motion-stage')?.getAttribute('data-motion-shown');return shown&&shown!=='home'?[shown]:[];};
beforeEach(()=>{
  vi.useFakeTimers();localStorage.clear();localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'grid',perRow:4}));sequence=0;frames=new Map();idles=new Map();
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=++sequence;frames.set(id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('requestIdleCallback',(callback:IdleRequestCallback)=>{const id=++sequence;idles.set(id,callback);return id;});
  vi.stubGlobal('cancelIdleCallback',(id:number)=>idles.delete(id));
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  // Even a faulty observer saying that hidden covers are nearby must not trigger media I/O.
  vi.stubGlobal('IntersectionObserver',class{constructor(private callback:IntersectionObserverCallback){} observe(target:Element){this.callback([{target,isIntersecting:true} as IntersectionObserverEntry],this as unknown as IntersectionObserver);}unobserve(){}disconnect(){}});
  vi.stubGlobal('navigator',Object.defineProperties(Object.create(navigator),{onLine:{value:true,configurable:true},connection:{value:undefined,configurable:true}}));
  animate=vi.fn(()=>({cancel(){},finish(){},onfinish:null}));HTMLElement.prototype.animate=animate;
  mocks.api.mockReset();mocks.native.mockReset();mocks.native.mockResolvedValue({url:'https://app.lakomics.local/media-cache/cover',expires_in:300});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/mobile-catalog/status')return status;
    if(path.startsWith('/v1/mobile-catalog/count'))return {publicationRevision:'p1',totalCount:1};
    if(path.startsWith('/v1/mobile-catalog/search'))return path.includes('cursor=')?{...catalog,items:[],nextCursor:null}:catalog;
    if(path==='/v1/collections/status')return {revision:'r1'};
    if(path.startsWith('/v1/collections?'))return path.includes('cursor=')||path.includes('showcase=true')?{...collections,items:[],nextCursor:null}:collections;
    return {items:[],revision:'r1'};
  });
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();delete (HTMLElement.prototype as {animate?:unknown}).animate;});

it('does no mounting or requests before paint and idle, then fetches only one first page per hidden area',async()=>{
  render(<Shell/>);
  await time(5000);expect(mocks.api).not.toHaveBeenCalled();areas.forEach(area=>expect(mounted(area)).toBeNull());
  await frame();await time(5000);expect(mocks.api).not.toHaveBeenCalled();
  await frame();await time(AREA_PREWARM_IDLE_MS-1);expect(mocks.api).not.toHaveBeenCalled();
  await time(1);expect(idles.size).toBe(1);expect(mocks.api).not.toHaveBeenCalled();
  await idle();await flush();
  for(const area of areas){expect(mounted(area)).not.toBeNull();expect(first(area)).toHaveLength(1);expect(lists(area)).toHaveLength(1);}
  expect(mocks.api.mock.calls.map(([path])=>path)).toHaveLength(3); // Catalog capability + two lists.
  expect(mocks.native).not.toHaveBeenCalled();expect(document.querySelector('img')).toBeNull();
  await time(65_000);expect(mocks.api).toHaveBeenCalledTimes(3);expect(mocks.native).not.toHaveBeenCalled();
});
it.each(areas)('starts the warmed %s dissolve after exactly two frames, with no first-page reread',async area=>{
  const shell=render(<Shell/>);await warm();animate.mockClear();
  fireEvent.click(shell.getByText(area));await flush();
  expect(dissolves()).toHaveLength(0);expect(document.querySelector('.motion-stage')?.getAttribute('data-motion-shown')).toBe('home');
  await frame();expect(dissolves()).toHaveLength(0);
  await frame();expect(dissolves()).toHaveLength(1);expect(first(area)).toHaveLength(1);
  expect(mocks.native.mock.calls.some(([op])=>op===(area==='catalog'?'catalogImage':'collectionArtwork'))).toBe(true);
});
it('prewarms the default Collection shelf without loading either cover face',async()=>{
  localStorage.removeItem('lakomics.mobile.collectionView.game.v1');
  const shell=render(<Shell/>);await warm();
  expect(document.querySelector('.collection-card')).not.toBeNull();expect(mocks.native).not.toHaveBeenCalled();
  expect(document.querySelector('img')).toBeNull();
  fireEvent.click(shell.getByText('collections'));await flush();await frame();await frame();
  expect(dissolves()).toHaveLength(1);expect(first('collections')).toHaveLength(1);
});
it.each(areas)('keeps Home until the in-flight %s first page is ready when tapped before warming finishes',async area=>{
  let resolve!:(page:unknown)=>void;
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string,...args:unknown[])=>{
    if(area==='catalog'?path.startsWith('/v1/mobile-catalog/search?'):path.startsWith('/v1/collections?')&&!path.includes('showcase=true'))return new Promise(done=>{resolve=done;});
    return original(path,...args);
  });
  const shell=render(<Shell/>);await warm();fireEvent.click(shell.getByText(area));await flush();
  await frame();await frame();expect(dissolves()).toHaveLength(0);expect(first(area)).toHaveLength(1);
  await act(async()=>resolve(area==='catalog'?catalog:collections));await frame();await frame();
  expect(dissolves()).toHaveLength(1);expect(first(area)).toHaveLength(1);
});
it.each(areas)('preserves the readiness cap for a cold %s switch',async area=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string,...args:unknown[])=>path.includes('/search?')||path.startsWith('/v1/collections?')?new Promise(()=>{}):original(path,...args));
  const shell=render(<Shell/>);fireEvent.click(shell.getByText(area));await flush();
  await time(READY_CAP_MS-1);expect(dissolves()).toHaveLength(0);
  await time(1);expect(dissolves()).toHaveLength(1);
});
it('defers for scrolling, even if the idle callback was already queued',async()=>{
  render(<Shell/>);await frame();await frame();await time(AREA_PREWARM_IDLE_MS);
  fireEvent.scroll(window);expect(idles.size).toBe(0);
  await time(AREA_PREWARM_IDLE_MS-1);expect(mocks.api).not.toHaveBeenCalled();
  await time(1);await idle();expect(first('catalog')).toHaveLength(1);
});
it.each(['privacy','offline','cellular','saveData','busy','viewer','hidden'] as const)('does no warm-up while %s blocks it',async reason=>{
  if(reason==='privacy')localStorage.setItem('lakomics.mobile.privacyMode','1');
  if(reason==='offline')Object.defineProperty(navigator,'onLine',{value:false});
  if(reason==='cellular'||reason==='saveData')Object.defineProperty(navigator,'connection',{value:reason==='cellular'?{type:'cellular'}:{saveData:true}});
  if(reason==='hidden')vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  render(<Shell enabled={reason!=='viewer'} busy={reason==='busy'}/>);await warm();
  expect(mocks.api).not.toHaveBeenCalled();expect(mocks.native).not.toHaveBeenCalled();
  if(reason==='hidden')vi.restoreAllMocks();
});
it('waits for network restoration and starts a fresh warm-up after the connection changes',async()=>{
  const shell=render(<Shell/>);await act(async()=>window.dispatchEvent(new CustomEvent('lakomics-network',{detail:{online:false,restored:false}})));await warm();
  expect(mocks.api).not.toHaveBeenCalled();
  await act(async()=>window.dispatchEvent(new CustomEvent('lakomics-network',{detail:{online:true,restored:true}})));await warm();
  expect(first('catalog')).toHaveLength(1);
  shell.rerender(<Shell scope="other"/>);await warm();expect(first('catalog')).toHaveLength(2);expect(first('collections')).toHaveLength(2);
});
it('uses the idle timer after paint when requestIdleCallback is unavailable',async()=>{
  vi.stubGlobal('requestIdleCallback',undefined);render(<Shell/>);
  await frame();await frame();await time(AREA_PREWARM_IDLE_MS-1);expect(mocks.api).not.toHaveBeenCalled();
  await time(1);expect(first('catalog')).toHaveLength(1);expect(first('collections')).toHaveLength(1);
});
it.each(areas)('does not repeat an interrupted hidden %s request, but retries it on activation',async area=>{
  const original=mocks.api.getMockImplementation()!;let pending:AbortSignal|undefined;
  mocks.api.mockImplementation((path:string,signal:AbortSignal,...args:unknown[])=>{
    if((area==='catalog'?path.startsWith('/v1/mobile-catalog/search?'):path.startsWith('/v1/collections?')&&!path.includes('showcase=true'))&&!pending){pending=signal;return new Promise(()=>{});}
    return original(path,signal,...args);
  });
  const shell=render(<Shell/>);await warm();expect(pending?.aborted).toBe(false);
  shell.rerender(<Shell enabled={false}/>);await flush();expect(pending?.aborted).toBe(true);
  shell.rerender(<Shell/>);await warm();expect(first(area)).toHaveLength(1);
  fireEvent.click(shell.getByText(area));await flush();expect(first(area)).toHaveLength(2);
  await frame();await frame();expect(dissolves()).toHaveLength(1);
});
it.each(areas)('retries a failed hidden %s list on activation',async area=>{
  const original=mocks.api.getMockImplementation()!;let failed=false;
  mocks.api.mockImplementation((path:string,...args:unknown[])=>{
    if((area==='catalog'?path.startsWith('/v1/mobile-catalog/search?'):path.startsWith('/v1/collections?')&&!path.includes('showcase=true'))&&!failed){failed=true;return Promise.reject(new Error('offline'));}
    return original(path,...args);
  });
  const shell=render(<Shell/>);await warm();expect(first(area)).toHaveLength(1);
  fireEvent.click(shell.getByText(area));await flush();expect(first(area)).toHaveLength(2);
});
