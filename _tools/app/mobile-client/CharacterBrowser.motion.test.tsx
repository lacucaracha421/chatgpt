import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
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
  groupPage=new Promise(resolve=>{releaseGroup=()=>resolve(page(['group-1','group-2']));});
  mocks.api.mockReset();
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.endsWith('/characters'))return structuredClone(index);
    if(path.includes('toc=1'))throw new Error('no toc');
    const at=new URL(path,'https://test').searchParams.get('node');
    return at==='group:g'?groupPage:at==='character:c'?page(['character-1']):page([]);
  });
});
afterEach(()=>{cleanup();animate.mockClear();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as Partial<HTMLElement>).animate;});

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

it('gives series and character folder cards their first-batch entrance in every place, keeping the old shelf until the next place commits',async()=>{
  render(<CharacterBrowser {...props}/>);
  const series=await screen.findByRole('button',{name:'Series · 3장'});
  await waitFor(()=>expect(cardRise('Series')).toBe(true));
  fireEvent.click(series);
  await screen.findByRole('button',{name:'Group · 2장'});
  await waitFor(()=>expect(cardRise('Group')).toBe(true));
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
  await waitFor(()=>expect(cardRise('Character')).toBe(true));
  // Nothing was on screen to move from, so the group's first tiles enter like a first visit's.
  await waitFor(()=>expect(tileRise('group-1')).toBe(true));
  expect(document.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
});

it('moves from shown tiles into a character folder with the directional folder move after its images are ready',async()=>{
  releaseGroup();
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  animate.mockClear();
  fireEvent.click(screen.getByRole('button',{name:'Character · 1장'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  // The group's decoded tiles stay underneath while the character's tiles wait for their images.
  expect(document.querySelector('.gallery-scroll')!.getAttribute('data-folder-move')).toBe('pending');
  await waitFor(()=>expect(canvasMoves()).toContainEqual({opacity:0,transform:'translateX(16px)'}));
  // The folder move owns this arrival: the tiles do not also replay the first batch.
  expect(tileRise('character-1')).toBe(false);
});

it('keeps reduced motion to the folder move fade and skips the card and tile rise',async()=>{
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  releaseGroup();
  render(<CharacterBrowser {...props} initialNode="group:g"/>);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="group-1"]')).not.toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'Character · 1장'}));
  await waitFor(()=>expect(document.querySelector('[data-asset-id="character-1"]')).not.toBeNull());
  await waitFor(()=>expect(canvasMoves()).toContainEqual({opacity:0}));
  const moves=animate.mock.calls.filter((_call,i)=>(animate.mock.contexts[i] as unknown as HTMLElement).matches('.gallery-canvas'));
  expect(moves.every(call=>call[1]?.duration===120)).toBe(true);
  expect(risen('.character-card, [data-asset-id]')).toHaveLength(0);
});
