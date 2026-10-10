import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {Profiler,useState} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import {useAssetToc,type AssetToc,type AssetTocPage} from './assetToc';
import {EMPTY_FILTERS} from './assetFilters';
import type {Asset,Page,View} from './types';

const mocks=vi.hoisted(()=>({api:vi.fn(),loadThumbnail:vi.fn(),prepareAssets:vi.fn(),renders:0}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(error:Error)=>error.message}));
vi.mock('./media',()=>({prefetchThumbnails:vi.fn(),prepareAssets:mocks.prepareAssets,loadThumbnail:mocks.loadThumbnail,invalidateTicket:vi.fn(),mediaTicket:vi.fn()}));
vi.mock('@tanstack/react-virtual',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('@tanstack/react-virtual')>();
  return {...actual,useVirtualizer:(options:Parameters<typeof actual.useVirtualizer>[0])=>{mocks.renders++;return actual.useVirtualizer(options);}};
});
vi.mock('./originalTicketWarm',()=>({warmOriginalTickets:vi.fn()}));
const observers:{callback:ResizeObserverCallback;target?:Element}[]=[];
const descriptors=new Map<string,PropertyDescriptor|undefined>();
const G='a'.repeat(64);
const assets=(start:number,count:number):Asset[]=>Array.from({length:count},(_,i)=>({id:`asset-${start+i}`,kind:'image',preview:`https://test.invalid/${start+i}.webp`,width:600,height:600,collected_at:start+i<25_000?'2026-09-01':'2025-12-01'}));
type Host=Page&AssetTocPage&{version:number;generation:string;view:View;filters:typeof EMPTY_FILTERS;cursor:null};
let current:Host;
let currentSource:ReturnType<typeof useAssetToc>;
let commits=0;
const onScroll=vi.fn(),onOpen=vi.fn(),reload=vi.fn(),onError=vi.fn();
function toc(total=50_000):AssetToc{return {tocVersion:1,listGeneration:G,totalCount:total,sort:'newest',buckets:[{key:'2026-09',startIndex:0,count:25_000,startCursor:null},{key:'2025-12',startIndex:25_000,count:total-25_000,startCursor:'bucket-25000'}]};}
function Host({total=50_000,withToc=true,paused=false,privacy=false,identity='all',seedPreview=true}:{total?:number;withToc?:boolean;paused?:boolean;privacy?:boolean;identity?:string;seedPreview?:boolean}) {
  const [page,setPage]=useState<Host>(()=>({items:assets(0,40).map(asset=>seedPreview?asset:{...asset,preview:undefined}),has_more:true,next_cursor:'40',generation:G,list_generation:G,version:1,view:{tab:'library',title:'All'},filters:EMPTY_FILTERS,cursor:null,tocRequest:withToc?Promise.resolve(toc(total)):undefined}));
  current=page;
  const source=useAssetToc(page,setPage,reload,onError);currentSource=source;
  return <Profiler id="gallery" onRender={()=>{commits++;}}><Gallery sparse={source} items={page.items} density={1} identity={identity} restoreScroll={0} onScroll={onScroll} onOpen={onOpen} onReady={()=>{}} onNearEnd={()=>{}} paused={paused} privacy={privacy}/></Profiler>;
}
beforeEach(()=>{
  commits=0;mocks.renders=0;observers.length=0;vi.clearAllMocks();
  mocks.loadThumbnail.mockImplementation(async(asset:Asset)=>asset);mocks.prepareAssets.mockImplementation(async(items:Asset[])=>items);
  vi.stubGlobal('innerWidth',1000);
  vi.stubGlobal('ResizeObserver',class{
    entry:{callback:ResizeObserverCallback;target?:Element};
    constructor(callback:ResizeObserverCallback){this.entry={callback};observers.push(this.entry);}
    observe(target:Element){this.entry.target=target;}unobserve(){}disconnect(){}
  });
  for(const [name,size] of [['offsetHeight',1000],['offsetWidth',632],['clientHeight',1000],['clientWidth',632]] as const) {
    descriptors.set(name,Object.getOwnPropertyDescriptor(HTMLElement.prototype,name));
    Object.defineProperty(HTMLElement.prototype,name,{configurable:true,get:()=>size});
  }
  descriptors.set('scrollHeight',Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollHeight'));
  Object.defineProperty(HTMLElement.prototype,'scrollHeight',{configurable:true,get(){return parseFloat((this as HTMLElement).querySelector<HTMLElement>('.gallery-canvas')?.style.height??'4000');}});
  Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:vi.fn(async()=>{})});
  mocks.api.mockImplementation(async(path:string)=>{
    const cursor=new URL(path,'https://test').searchParams.get('cursor'),start=cursor==='bucket-25000'?25_000:Number(cursor??0);
    return {items:assets(start,40),has_more:true,next_cursor:String(start+40),listGeneration:G};
  });
});
afterEach(()=>{
  cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();delete (HTMLImageElement.prototype as {decode?:unknown}).decode;
  for(const [name,descriptor] of descriptors){if(descriptor)Object.defineProperty(HTMLElement.prototype,name,descriptor);else delete (HTMLElement.prototype as unknown as Record<string,unknown>)[name];}descriptors.clear();
});
function resize(){act(()=>{for(const entry of observers)if(entry.target)entry.callback([{target:entry.target,borderBoxSize:[{inlineSize:632,blockSize:1000}]} as unknown as ResizeObserverEntry],{} as ResizeObserver);});}
async function mount(options:{total?:number;withToc?:boolean}={}){render(<Host {...options}/>);resize();if(options.withToc!==false)await waitFor(()=>expect(current.assetRanges).toBeDefined());const scroll=screen.getByLabelText('자산 목록');fireEvent.scroll(scroll);return scroll;}
function release(index:number,total=50_000){
  const zone=document.querySelector('.mobile-scrubber-zone')!,left=document.querySelector('.mobile-scrubber-track')?.getBoundingClientRect().left??20,x=left+960*index/(total-1);
  fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});
  fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:x,clientY:12});
  fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:x,clientY:12});
}
async function settleDestination(){
  await waitFor(()=>expect(document.querySelector('[data-asset-id="asset-25000"] img')).not.toBeNull());
  await act(async()=>{for(const image of document.querySelectorAll<HTMLImageElement>('[inert] img'))fireEvent.load(image);});
}

it('retains painted content until actual destination images decode, then lands on the bucket first item',async()=>{
  const scroll=await mount(),old=document.querySelector('[data-asset-id="asset-0"]')!;
  release(25_000);
  expect(scroll.scrollTop).toBe(0);expect(document.querySelector('[data-asset-id="asset-0"]')).toBe(old);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="asset-25000"] img')).not.toBeNull());
  expect(scroll.scrollTop).toBe(0);expect(document.querySelector('[data-asset-id="asset-0"]')).toBe(old);
  const firstImage=document.querySelector('[data-asset-id="asset-25000"] img')!;
  await settleDestination();
  await waitFor(()=>expect(scroll.scrollTop).toBeGreaterThan(0));
  const firstRow=document.querySelector<HTMLElement>('[data-gallery-row="asset-25000"]')!;
  expect(scroll.scrollTop).toBe(parseFloat(firstRow.style.transform.slice('translateY('.length)));
  expect(document.querySelector('[data-asset-id="asset-25000"] img')).toBe(firstImage);
  expect((firstImage as HTMLImageElement).style.opacity).not.toBe('0');
  expect(new URL(mocks.api.mock.calls[0][0],'https://test').searchParams.get('cursor')).toBe('bucket-25000');
  fireEvent.click(document.querySelector('[data-asset-id="asset-25000"]')!);expect(onOpen).toHaveBeenCalledWith(40);
});
it('cancels a superseded seek, including a destination already staged and waiting to decode',async()=>{
  const scroll=await mount();release(25_000);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="asset-25000"]')).not.toBeNull());
  release(0);
  await waitFor(()=>expect(document.querySelector('[data-gallery-row="asset-0"]')?.hasAttribute('inert')).toBe(true));
  await act(async()=>{for(const image of document.querySelectorAll('img'))fireEvent.load(image);});
  await waitFor(()=>expect(onScroll).toHaveBeenCalled());expect(scroll.scrollTop).toBe(0);
});
it('aborts a superseded page request before it can publish or move the viewport',async()=>{
  const scroll=await mount();let signal!:AbortSignal;
  mocks.api.mockImplementationOnce((_path:string,requestSignal:AbortSignal)=>{
    signal=requestSignal;
    return new Promise((_resolve,reject)=>requestSignal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  });
  release(25_000);await waitFor(()=>expect(signal).toBeDefined());release(0);
  expect(signal.aborted).toBe(true);
  await act(async()=>{for(const image of document.querySelectorAll('img'))fireEvent.load(image);});
  await waitFor(()=>expect(onScroll).toHaveBeenCalled());
  expect(scroll.scrollTop).toBe(0);expect(current.items).toHaveLength(40);expect(onError.mock.calls.every(([message])=>message==='')).toBe(true);
});
it.each(['paused','identity'] as const)('clears a staged seek when %s changes and can seek after returning',async(change)=>{
  const host=render(<Host/>);resize();await waitFor(()=>expect(current.assetRanges).toBeDefined());
  const scroll=screen.getByLabelText('자산 목록');fireEvent.scroll(scroll);release(25_000);
  await waitFor(()=>expect(document.querySelector('[data-asset-id="asset-25000"] img')).not.toBeNull());
  host.rerender(<Host {...(change==='paused'?{paused:true}:{identity:'refreshed'})}/>);
  await act(async()=>{for(const image of document.querySelectorAll('img'))fireEvent.load(image);});
  expect(scroll.scrollTop).toBe(0);expect(document.querySelector('[data-gallery-row][inert]')).toBeNull();
  host.rerender(<Host/>);release(25_000);await settleDestination();await waitFor(()=>expect(scroll.scrollTop).toBeGreaterThan(0));
});
it('stays at the current viewport and reports the existing inline error on a failed seek',async()=>{
  const scroll=await mount(),old=document.querySelector('[data-asset-id="asset-0"]');
  mocks.api.mockRejectedValueOnce(new Error('offline'));release(25_000);
  await waitFor(()=>expect(onError).toHaveBeenCalledWith('offline'));
  expect(scroll.scrollTop).toBe(0);expect(document.querySelector('[data-asset-id="asset-0"]')).toBe(old);
});
it('seeks in privacy mode without requesting or decoding thumbnails',async()=>{
  render(<Host privacy/>);resize();await waitFor(()=>expect(current.assetRanges).toBeDefined());
  const scroll=screen.getByLabelText('자산 목록');fireEvent.scroll(scroll);release(25_000);
  await waitFor(()=>expect(scroll.scrollTop).toBeGreaterThan(0));
  expect(document.querySelectorAll('img')).toHaveLength(0);expect(mocks.loadThumbnail).not.toHaveBeenCalled();
});
it('prepares missing previews on already-mounted tiles and waits for those actual images',async()=>{
  render(<Host seedPreview={false}/>);resize();await waitFor(()=>expect(current.assetRanges).toBeDefined());
  const scroll=screen.getByLabelText('자산 목록');fireEvent.scroll(scroll);
  const tile=document.querySelector('[data-asset-id="asset-3"]');
  mocks.prepareAssets.mockImplementation(async(items:Asset[])=>items.map(asset=>({...asset,preview:`https://test.invalid/${asset.id}.webp`})));
  release(3);await waitFor(()=>expect(document.querySelector('[data-asset-id="asset-3"] img')).not.toBeNull());
  expect(scroll.scrollTop).toBe(0);expect(document.querySelector('[data-asset-id="asset-3"]')).toBe(tile);
  expect(mocks.api).not.toHaveBeenCalled();
  await act(async()=>{for(const image of document.querySelectorAll('[inert] img'))fireEvent.load(image);});
  await waitFor(()=>expect(onScroll).toHaveBeenCalled());
  expect((document.querySelector('[data-asset-id="asset-3"] img') as HTMLImageElement).style.opacity).not.toBe('0');
});
it('keeps the total at 50,000 after a seek and subsequent page arrival',async()=>{
  await mount();release(25_000);expect(screen.getByText(/\/ 50,000/)).toBeTruthy();
  await settleDestination();expect(current.items.length).toBeGreaterThan(40);
  expect(current.assetRanges!.toc.totalCount).toBe(50_000);
  release(25_001);expect(screen.getByText(/\/ 50,000/)).toBeTruthy();
});
it('keeps ordinary cursor-paged Gallery behaviour without a TOC',async()=>{
  const scroll=await mount({withToc:false});commits=0;mocks.renders=0;const started=performance.now();release(20,40);
  console.info(`Paged loaded seek baseline: renders=${mocks.renders}, commits=${commits}, ms=${(performance.now()-started).toFixed(1)}`);
  expect(scroll.scrollTop).toBeGreaterThan(0);expect(current.assetRanges).toBeUndefined();expect(mocks.api).not.toHaveBeenCalled();
});
it.each([50_000,500_000])('bounds seek commits and loaded work independently of the %i-item total',async(total)=>{
  const scroll=await mount({total});commits=0;mocks.renders=0;const started=performance.now();
  release(25_000,total);await settleDestination();await waitFor(()=>expect(scroll.scrollTop).toBeGreaterThan(0));
  const seekCommits=commits,elapsed=performance.now()-started;
  expect(current.items.length).toBeLessThanOrEqual(120);expect(document.querySelectorAll('.media-tile').length).toBeLessThan(100);
  // StableImage records the first loaded slot in one extra child commit; Gallery's work stays bounded.
  expect(seekCommits).toBeLessThanOrEqual(8);expect(mocks.renders).toBeLessThanOrEqual(7);
  console.info(`TOC seek total=${total}: renders=${mocks.renders}, commits=${seekCommits}, loaded=${current.items.length}, ms=${elapsed.toFixed(1)}`);
});
it('loads across a spacer with bounded commits',async()=>{
  const scroll=await mount();commits=0;mocks.renders=0;const started=performance.now();
  const start=parseFloat(document.querySelector<HTMLElement>('.gallery-canvas')!.style.height)*40/50_000;
  scroll.scrollTop=start+20;fireEvent.scroll(scroll);
  await waitFor(()=>expect(current.items.length).toBeGreaterThan(40));
  expect(mocks.api.mock.calls.some(([path])=>new URL(path,'https://test').searchParams.get('cursor')==='40')).toBe(true);
  expect(commits).toBeLessThanOrEqual(4);expect(mocks.renders).toBeLessThanOrEqual(4);
  console.info(`TOC spacer: renders=${mocks.renders}, commits=${commits}, loaded=${current.items.length}, ms=${(performance.now()-started).toFixed(1)}`);
});

it('keeps a static canvas pattern when fast flings outrun delayed range pages',async()=>{
  const scroll=await mount();
  vi.useFakeTimers();
  mocks.api.mockImplementation((_path:string,signal:AbortSignal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  }));
  const canvas=document.querySelector<HTMLElement>('.gallery-canvas')!;
  const height=canvas.style.height,pitch=canvas.style.getPropertyValue('--gallery-placeholder-pitch');
  expect(pitch).toBe('230px');
  for(let fling=1;fling<=20;fling++) {
    scroll.scrollTop=10_000+fling*1800;fireEvent.scroll(scroll);
    await act(async()=>{await vi.advanceTimersByTimeAsync(400);});
    expect(canvas.style.getPropertyValue('--gallery-placeholder-pitch')).toBe(pitch);
    expect(canvas.style.height).toBe(height);
    expect(parseFloat(height)).toBeGreaterThan(scroll.scrollTop+scroll.clientHeight);
    expect(document.querySelector('[data-gallery-placeholder-row]')).toBeNull();
    expect(document.querySelector('.gallery-complete-tail')).toBeNull();
  }
  expect(current.items).toHaveLength(40);
  expect(mocks.api).toHaveBeenCalled();
});

it('preserves a painted asset and its pixel offset as real rows replace an earlier spacer',async()=>{
  const scroll=await mount();release(25_000);await settleDestination();await waitFor(()=>expect(scroll.scrollTop).toBeGreaterThan(0));
  scroll.scrollTop+=73;fireEvent.scroll(scroll);
  const element=document.querySelector('[data-asset-id="asset-25000"]')!;
  const top=()=>parseFloat(document.querySelector<HTMLElement>('[data-gallery-row="asset-25000"]')!.style.transform.slice('translateY('.length));
  expect(scroll.scrollTop-top()).toBeCloseTo(73);
  await act(async()=>{await currentSource!.load(1000,40,new AbortController().signal);});
  expect(scroll.scrollTop-top()).toBeCloseTo(73);
  expect(document.querySelector('[data-asset-id="asset-25000"]')).toBe(element);
});
