import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CharacterBrowser} from './CharacterBrowser';
import type {CharacterIndex,CharacterPage} from './characterModel';

// The real tablet Gallery and shelf: series and character folders use the shared motion paths
// (useFirstAppearance for shelf cards and a new place's first tiles, FolderMove between places).
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(e:Error)=>e.message}));
vi.mock('./media',async original=>({...await original<typeof import('./media')>(),loadThumbnail:vi.fn(async(asset:unknown)=>asset),prefetchThumbnails:vi.fn()}));
const measured=vi.hoisted(()=>({sizes:[] as number[]}));
vi.mock('@tanstack/react-virtual',async original=>({...await original<typeof import('@tanstack/react-virtual')>(),useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
  measured.sizes=Array.from({length:count},(_,i)=>estimateSize(i));
  return {measure(){},getTotalSize:()=>measured.sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>measured.sizes.map((_size,index)=>({key:index,index,start:measured.sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));

const revision='b'.repeat(64);
const node=(kind:'series'|'group'|'character',id:string,name:string,parentId:string|null)=>({id:`${kind}:${id}`,kind,sourceId:id,seriesId:'s',parentId,name,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false});
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:'2026',
  nodes:[node('series','s','Series',null),node('group','g','Group','series:s'),node('character','c','Character','group:g')],
  scopes:[{nodeId:'series:s',filter:'all',totalCount:3,sourceCount:3},{nodeId:'series:s',filter:'unclassified',totalCount:0,sourceCount:0},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:1,sourceCount:1}]};
const page=(ids:string[]):CharacterPage=>({revision,items:ids.map(id=>({id,kind:'image',preview:`data:image/png;base64,${id}`,width:600,height:800})),totalCount:ids.length,sourceCount:ids.length,has_more:false,next_cursor:null});
const animate=vi.fn((_frames:Keyframe[],_options?:KeyframeAnimationOptions)=>({cancel:vi.fn(),pause:vi.fn(),play:vi.fn(),onfinish:null as (()=>void)|null}));
const box=(width:number,height:number)=>({left:0,top:0,right:width,bottom:height,width,height,x:0,y:0,toJSON:()=>({})});
let groupPage:Promise<CharacterPage>;
let releaseGroup:()=>void;
const props={active:true,paused:false,density:1,refreshKey:1,onOpen:vi.fn(),backRef:{current:null},onExit:vi.fn()};

beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  vi.stubGlobal('CSS',{supports:()=>false});
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(box(400,300) as DOMRect);
  vi.spyOn(HTMLImageElement.prototype,'complete','get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype,'naturalWidth','get').mockReturnValue(200);
  Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:vi.fn(async()=>{})});
  groupPage=new Promise(resolve=>{releaseGroup=()=>resolve(page(['group-1','group-2']));});
  mocks.api.mockReset();
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('toc=1'))throw new Error('no toc');
    const at=new URL(path,'https://test').searchParams.get('node');
    return at==='group:g'?groupPage:at==='character:c'?page(['character-1']):page([]);
  });
});
afterEach(()=>{cleanup();animate.mockClear();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as Partial<HTMLElement>).animate;delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;delete (document as Partial<Document>).startViewTransition;});

const RISE={transform:'translateY(8px) scale(.98)'};
/** Cards (shelf) or tiles (gallery) that received the shared first-batch entrance. */
const risen=(selector:string)=>animate.mock.calls.flatMap((call,i)=>{
  const element=animate.mock.contexts[i] as unknown as HTMLElement;
  const first=call[0][0] as Keyframe;
  return element.matches(selector)&&first.transform===RISE.transform?[element]:[];
});
const cardRise=(name:string)=>risen('.character-card').some(card=>card.getAttribute('aria-label')?.startsWith(name));
const tileRise=(id:string)=>risen('[data-asset-id]').some(tile=>tile.dataset.assetId===id);
const canvasMoves=()=>animate.mock.calls.flatMap((call,i)=>(animate.mock.contexts[i] as unknown as HTMLElement).matches('.gallery-canvas')?[call[0][0] as Keyframe]:[]);

it('gives folder cards the first-batch entrance on the first visit only, then swaps the shelf in one step, keeping the old shelf until the next place commits',async()=>{
  render(<CharacterBrowser {...props}/>);
  const series=await screen.findByRole('button',{name:'Series · 3장'});
  await waitFor(()=>expect(cardRise('Series')).toBe(true));
  fireEvent.click(series);
  await screen.findByRole('button',{name:'Group · 2장'});
  // Moving inside the browser swaps the shelf without animation (user 2026-10-05).
  expect(cardRise('Group')).toBe(false);
  // The series opens on an empty 미분류 page; entering the group keeps the series shelf on screen
  // (never a blank or half-built shelf) until the group's page has committed.
  animate.mockClear();
  fireEvent.click(screen.getByRole('button',{name:'Group · 2장'}));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  expect(screen.getByRole('button',{name:'Group · 2장'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Character · 1장'})).toBeNull();
  expect(cardRise('Character')).toBe(false);
  await act(async()=>{releaseGroup();await groupPage;});
  await screen.findByRole('button',{name:'Character · 1장'});
  expect(cardRise('Character')).toBe(false);
  // Even with nothing on screen to move from, the group's tiles swap in without the first-visit rise.
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
  expect(tileRise('group-1')).toBe(false);
  expect(document.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
});

it('moves from shown tiles into a character folder in one step, without animation, after its images are ready',async()=>{
  releaseGroup();
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  animate.mockClear();
  fireEvent.click(screen.getByRole('button',{name:'Character · 1장'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  // The group's decoded tiles stay underneath while the character's tiles wait for their images.
  expect(document.querySelector('.gallery-scroll')!.getAttribute('data-folder-move')).toBe('pending');
  await waitFor(()=>expect(document.querySelector('.gallery-scroll')!.hasAttribute('data-folder-move')).toBe(false));
  // The folder move owns this arrival (user 2026-10-05: no animation): no canvas move, no first-batch replay.
  expect(canvasMoves()).toHaveLength(0);
  expect(tileRise('character-1')).toBe(false);
});

it('keeps a reduced-motion folder move still and skips the card and tile rise',async()=>{
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  releaseGroup();
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'Character · 1장'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  await waitFor(()=>expect(document.querySelector('.gallery-scroll')!.hasAttribute('data-folder-move')).toBe(false));
  expect(canvasMoves()).toHaveLength(0);
  expect(risen('.character-card, [data-asset-id]')).toHaveLength(0);
});

it('retains the decoded parent shelf through a character visit and return',async()=>{
  releaseGroup();
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  const card=await screen.findByRole('button',{name:'Character · 1장'});
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  fireEvent.click(card);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  expect(card.isConnected).toBe(true);
  expect(screen.queryByRole('button',{name:'Character · 1장'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  expect(screen.getByRole('button',{name:'Character · 1장'})).toBe(card);
});

it('keeps a cached character offset while the return page waits, then restores the parent offset',async()=>{
  releaseGroup();
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  const scroll=document.querySelector<HTMLElement>('.gallery-scroll')!;
  Object.defineProperty(scroll,'clientHeight',{configurable:true,value:300});
  scroll.scrollTop=300;fireEvent.scroll(scroll);
  fireEvent.click(screen.getByRole('button',{name:'Character · 1장'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  scroll.scrollTop=180;fireEvent.scroll(scroll);
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  expect(scroll.scrollTop).toBe(300);
  fireEvent.click(screen.getByRole('button',{name:'Character · 1장'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  expect(scroll.scrollTop).toBe(180);
  const ready=Promise.withResolvers<void>();
  let waiting=false;
  vi.spyOn(HTMLImageElement.prototype,'decode').mockImplementation(function(this:HTMLImageElement){
    if(this.src.endsWith('group-1')||this.src.endsWith('group-2')){waiting=true;return ready.promise;}
    return Promise.resolve();
  });
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(waiting).toBe(true));
  expect(scroll.scrollTop).toBe(180);
  expect(screen.getByRole('heading',{name:'Character'})).toBeTruthy();
  await act(async()=>{ready.resolve();});
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  expect(scroll.scrollTop).toBe(300);
});

it('swaps series segments through the shared motion without moving folders or resetting scroll',async()=>{
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('toc=1'))throw new Error('no toc');
    return page(Array.from({length:80},(_,i)=>`${path.includes('filter=all')?'all':'unclassified'}-${i}`));
  });
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="unclassified-0"]')).not.toBeNull());
  const scroll=document.querySelector<HTMLElement>('.gallery-scroll')!;
  Object.defineProperty(scroll,'clientHeight',{configurable:true,value:300});
  scroll.scrollTop=800;fireEvent.scroll(scroll);
  animate.mockClear();
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:/전체/}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="all-0"]')).not.toBeNull());
  expect(scroll.scrollTop).toBe(800);
  expect(scroll.dataset.folderMove).toBeUndefined();
  expect(scroll.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
  expect(animate.mock.calls.some((call,i)=>animate.mock.contexts[i]===scroll&&call[0][0].transform==='translateX(16px)'&&call[1]?.duration===240)).toBe(true);
});

it('keeps a character and its chrome until the cached series images decode, reusing its shelf images',async()=>{
  const direct=structuredClone(index);
  direct.nodes=direct.nodes.filter(item=>item.kind!=='group').map(item=>item.kind==='character'?{...item,parentId:'series:s',thumbnailAssetId:'return-cover'}:item);
  const {loadThumbnail}=await import('./media');
  vi.mocked(loadThumbnail).mockImplementation(async asset=>({...asset,preview:`data:image/png;base64,${asset.id}`}));
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return direct;
    if(path.includes('toc=1'))throw new Error('no toc');
    return page(path.includes('character%3Ac')?['character-return']:['series-return']);
  });
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="series-return"]')).not.toBeNull());
  const card=screen.getByRole('button',{name:'Character · 1장'});
  await waitFor(()=>expect(card.querySelector('img')).not.toBeNull());
  const cover=card.querySelector('img');
  fireEvent.click(card);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-return"]')).not.toBeNull());
  let decode!:()=>void;
  vi.spyOn(HTMLImageElement.prototype,'decode').mockImplementation(function(this:HTMLImageElement){
    return this.src.endsWith('series-return')?new Promise<void>(resolve=>{decode=resolve;}):Promise.resolve();
  });
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(decode).toBeDefined());
  expect(screen.getByRole('heading',{name:'Character'})).toBeTruthy();
  expect(screen.queryByRole('radiogroup',{name:'이미지 범위'})).toBeNull();
  expect(document.querySelector('[data-asset-id="character-return"]')).not.toBeNull();
  expect(document.querySelector('[data-asset-id="series-return"]')).toBeNull();
  await act(async()=>{decode();});
  await waitFor(()=>expect(document.querySelector('[data-asset-id="series-return"]')).not.toBeNull());
  expect(screen.getByRole('heading',{name:'Series'})).toBeTruthy();
  expect(screen.getByRole('radio',{name:'미분류 0'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Character · 1장'})).toBe(card);
  expect(card.querySelector('img')).toBe(cover);
});

it('uses a single segment snapshot with a stationary control, and drops a superseded snapshot commit',async()=>{
  const callbacks:(()=>void)[]=[];
  const finished=Promise.withResolvers<void>();
  const skipTransition=vi.fn();
  Object.defineProperty(document,'startViewTransition',{configurable:true,value:(commit:()=>void)=>{
    callbacks.push(commit);return {ready:Promise.resolve(),finished:finished.promise,skipTransition};
  }});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('toc=1'))throw new Error('no toc');
    return page([path.includes('filter=all')?'snapshot-all':'snapshot-unclassified']);
  });
  render(<CharacterBrowser {...props} initialNode="series:s"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="snapshot-unclassified"]')).not.toBeNull());
  fireEvent.click(within(screen.getByRole('radiogroup',{name:'이미지 범위'})).getByRole('radio',{name:/전체/}));
  await waitFor(()=>expect(callbacks).toHaveLength(1));
  expect(document.documentElement.dataset.viewSwap).toBe('forward');
  expect(document.querySelector('.gallery-scroll')?.hasAttribute('data-view-swap-target')).toBe(true);
  expect(document.querySelector('.character-filters')?.hasAttribute('data-view-swap-still')).toBe(true);
  expect(document.querySelector('[data-asset-id="snapshot-all"]')).toBeNull();
  // Back changes the requested range before the browser has taken its new snapshot.
  fireEvent.click(screen.getByRole('button',{name:'뒤로'}));
  await waitFor(()=>expect(skipTransition).toHaveBeenCalled());
  await act(async()=>{callbacks[0]();finished.resolve();});
  expect(document.querySelector('[data-asset-id="snapshot-all"]')).toBeNull();
  expect(document.querySelector('[data-asset-id="snapshot-unclassified"]')).not.toBeNull();
  expect(document.documentElement.hasAttribute('data-view-swap')).toBe(false);
});
