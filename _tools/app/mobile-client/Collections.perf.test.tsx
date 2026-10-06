/**
 * PERF-ALL-001 measurement harness: the Collections
 * cold-start cover path and the Collections tab's idle request volume.
 *
 * Metrics are printed as `[perf] …` lines and are deterministic under fake timers. Most
 * assertions only check that the scenario ran; the saturated cold start is a gate for the
 * visible-cover retry (harness before the fix: 4 of 16 covers shown and 12 failed at 30 s).
 */
import {act, cleanup, fireEvent, render} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionPage, CollectionSummary} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn(),caseRenders:0}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
vi.mock('../src/collections/case/LightCase',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/collections/case/LightCase')>();
  const {createElement}=await import('react');
  return {...actual,LightCase:(props:Parameters<typeof actual.LightCase>[0])=>{
    mocks.caseRenders++;return createElement(actual.LightCase,props);
  }};
});
import {Collections} from './Collections';

const digest=(n:number)=>n.toString(16).padStart(64,'0');
const works:CollectionSummary[]=Array.from({length:48},(_,i)=>({id:`game-${i}`,name:`Game ${i}`,type:'game',showcase:false,
  selectedWorkArtworkId:'cover',artworkVersions:{cover:{thumbnail:digest(i+1),original:digest(i+1000)}}}));
const page:CollectionPage={ready:true,filterVersion:1,revision:'r1',publishedAt:null,items:works,nextCursor:null};
/** Covers on the first S11 portrait screen plus the 120 px observer margin (4 columns x 4 rows). */
const FIRST_SCREEN=16;

let observed:Element[]=[];
class FirstScreenObserver {
  constructor(private callback:IntersectionObserverCallback){}
  observe(element:Element){
    observed.push(element);
    const visible=observed.indexOf(element)<FIRST_SCREEN;
    // Report asynchronously, as the platform does.
    queueMicrotask(()=>this.callback([{isIntersecting:visible,target:element} as IntersectionObserverEntry],this as unknown as IntersectionObserver));
  }
  disconnect(){} unobserve(){} takeRecords(){return [];}
}

beforeEach(()=>{
  observed=[];mocks.caseRenders=0;
  // Deterministic S11 portrait fixture; jsdom does not lay out grid tracks.
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(768);
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('collection-scroll')?900:0;});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    const list=this.closest<HTMLElement>('.collection-list'),root=this.closest<HTMLElement>('.collection-scroll');
    const height=this.classList.contains('collection-list__cell')&&list?parseFloat(list.style.getPropertyValue('--case-height'))+64:900;
    const top=this.classList.contains('collection-list__cell')?100+(Number(this.style.gridRow)-1)*(height+16)-(root?.scrollTop??0):0;
    return {top,bottom:top+height,left:0,right:768,width:768,height,x:0,y:top,toJSON(){}};
  });
  localStorage.clear();localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'grid',perRow:4}));
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver',FirstScreenObserver);
  mocks.api.mockReset();mocks.native.mockReset();
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.startsWith('/v1/collections?')&&path.includes('showcase=true'))return {...page,items:[],totalCount:0};
    if(path.startsWith('/v1/collections?'))return page;
    if(path.startsWith('/v1/collections/status'))return {revision:'r1'};
    if(path.startsWith('/v1/collections/releases'))return {items:[],unreadCount:0,revision:'x'};
    return {};
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});

async function coldCovers(latencyMs:number){
  let inFlight=0,peak=0;const finished:number[]=[];const started=Date.now();
  mocks.native.mockImplementation((op:string)=>{
    if(op!=='collectionArtwork')return Promise.resolve({});
    inFlight++;peak=Math.max(peak,inFlight);
    return new Promise(resolve=>setTimeout(()=>{inFlight--;finished.push(Date.now()-started);resolve({url:'https://app.lakomics.local/media-cache/0/x',expires_in:240});},latencyMs));
  });
  render(<Collections active paused={false} backRef={{current:null}}/>);
  // List load (resolved mock) and observer callbacks.
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  for(let t=0;t<60&&finished.length<FIRST_SCREEN;t++)await act(async()=>{await vi.advanceTimersByTimeAsync(latencyMs/2);});
  const requested=mocks.native.mock.calls.filter(([op])=>op==='collectionArtwork').length;
  return {requested,peak,allFirstScreenMs:finished[FIRST_SCREEN-1]??-1,firstCoverMs:finished[0]??-1};
}

it('cold start: first-screen game covers use eight slots and finish within two fixture waves', async()=>{
  // One uncached cover costs a ticket (~0.1-0.2 s + a cold R2 HEAD on the server) plus the
  // R2 download (~1.5-2.4 s measured on the tablet, MOBILE-PERF-002): model 2 s.
  const result=await coldCovers(2000);
  console.info(`[perf] collections cold covers: firstScreen=${FIRST_SCREEN} requested=${result.requested} peakConcurrent=${result.peak} firstCoverMs=${result.firstCoverMs} allFirstScreenMs=${result.allFirstScreenMs} (2000 ms per uncached cover)`);
  expect(result.requested).toBeGreaterThanOrEqual(FIRST_SCREEN);
  expect(result.peak).toBe(8);
  expect(result.allFirstScreenMs).toBeLessThanOrEqual(4000);
  expect(result.allFirstScreenMs).toBeGreaterThan(0);
});

it('cold start with a saturated native media lane: every first-screen cover shows within 30 s', async()=>{
  // Gate (MOBILE-PERF-002): the first 8 cover requests meet a full native queue ("media_busy")
  // and the next 4 fail outright (a bridge timeout or native "Media busy"); the rest take 2 s.
  // Before the retry, those 12 covers stayed blank until the tab changed.
  let requests=0;
  mocks.native.mockImplementation((op:string)=>{
    if(op!=='collectionArtwork')return Promise.resolve({});
    const n=++requests;
    if(n<=8)return Promise.reject(Object.assign(new Error('요청이 많습니다. 잠시 후 다시 시도해 주세요.'),{status:null,details:{code:'media_busy'}}));
    if(n<=12)return new Promise((_,reject)=>setTimeout(()=>reject(new Error('Media busy')),500));
    return new Promise(resolve=>setTimeout(()=>resolve({url:'https://app.lakomics.local/media-cache/0/x',expires_in:240}),2000));
  });
  render(<Collections active paused={false} backRef={{current:null}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  for(let t=0;t<30;t++)await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  const shown=document.querySelectorAll('.collection-art img').length;
  const failed=[...document.querySelectorAll('.collection-art-placeholder')].filter(node=>node.textContent==='이미지를 불러오지 못했습니다').length;
  console.info(`[perf] collections saturated cold start: firstScreen=${FIRST_SCREEN} requested=${requests} shownAt30s=${shown} failedAt30s=${failed}`);
  expect(failed).toBe(0);
  expect(shown).toBe(FIRST_SCREEN);
  // 16 covers, 8 busy and 4 failed replies each retried once: never a retry storm.
  expect(requests).toBeLessThanOrEqual(FIRST_SCREEN+12);
});

it('cold start on the shelf with a saturated native media lane: every first-screen case shows its cover within 30 s', async()=>{
  // Gate (MOBILE-PERF-002): the first 8 cover requests meet a full native queue ("media_busy")
  // and the next 4 fail outright (a bridge timeout or native "Media busy"); the rest take 2 s.
  // Before the retry, those 12 covers stayed blank until the tab changed.
  let requests=0;
  mocks.native.mockImplementation((op:string)=>{
    if(op!=='collectionArtwork')return Promise.resolve({});
    const n=++requests;
    if(n<=8)return Promise.reject(Object.assign(new Error('요청이 많습니다. 잠시 후 다시 시도해 주세요.'),{status:null,details:{code:'media_busy'}}));
    if(n<=12)return new Promise((_,reject)=>setTimeout(()=>reject(new Error('Media busy')),500));
    return new Promise(resolve=>setTimeout(()=>resolve({url:'https://app.lakomics.local/media-cache/0/x',expires_in:240}),2000));
  });
  localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'shelf',perRow:4}));
  render(<Collections active paused={false} backRef={{current:null}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  for(let t=0;t<30;t++)await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  // jsdom never loads images: settle every requested face the way the browser would, then let the shelf reveal it.
  await act(async()=>{for(const image of document.querySelectorAll('.collection-light-case img'))image.dispatchEvent(new Event('load'));await vi.advanceTimersByTimeAsync(1000);});
  // The shared light case shows the cover through StableImage; a case still without one shows its material.
  const shown=[...document.querySelectorAll('.collection-light-case .cs-front img')].filter(image=>(image as HTMLElement).style.visibility!=='hidden').length;
  console.info(`[perf] collections shelf saturated cold start: firstScreen=${FIRST_SCREEN} requested=${requests} shownAt30s=${shown}`);
  expect(shown).toBe(FIRST_SCREEN);
  // 16 covers, 8 busy and 4 failed replies each retried once: never a retry storm.
  expect(requests).toBeLessThanOrEqual(FIRST_SCREEN+12);
});

it('cold start on the shelf with published spines: covers first, then only the visible cases\' spines', async()=>{
  // An upgraded server publishes `spineArtworkId`: each shelf case adds one spine ticket, but only
  // after its own front is shown and only while it is near the viewport, so the first-screen
  // covers keep the four-wide queue to themselves and off-screen cases ask for nothing.
  const spined=works.map((work,i)=>({...work,spineArtworkId:'spine',artworkVersions:{...work.artworkVersions,spine:{thumbnail:digest(i+5000)}}}));
  const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(path:string)=>path.startsWith('/v1/collections?')&&!path.includes('showcase=true')?{...page,items:spined}:base(path));
  const started=Date.now();const done:Record<string,number[]>={cover:[],spine:[]};
  mocks.native.mockImplementation((op:string,payload:{artworkId?:string})=>{
    if(op!=='collectionArtwork')return Promise.resolve({});
    const kind=payload.artworkId==='spine'?'spine':'cover';
    return new Promise(resolve=>setTimeout(()=>{done[kind]!.push(Date.now()-started);resolve({url:`https://app.lakomics.local/media-cache/0/${kind}`,expires_in:240});},2000));
  });
  localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'shelf',perRow:4}));
  render(<Collections active paused={false} backRef={{current:null}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  for(let t=0;t<30;t++)await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  const covers=done.cover!,spines=done.spine!;
  console.info(`[perf] collections shelf with spines: firstScreen=${FIRST_SCREEN} coverRequests=${covers.length} spineRequests=${spines.length} allCoversMs=${covers[FIRST_SCREEN-1]??-1} firstSpineMs=${spines[0]??-1} allSpinesMs=${spines[FIRST_SCREEN-1]??-1}`);
  // The covers arrive as fast as without spines (4 at a time, 2 s each: 8 s), and every spine follows.
  expect(covers.length).toBe(FIRST_SCREEN);
  expect(covers[FIRST_SCREEN-1]).toBeLessThanOrEqual(8000);
  expect(spines.length).toBe(FIRST_SCREEN);
  expect(document.querySelectorAll('.collection-light-case img[src$="/spine"]').length).toBeGreaterThan(0);
});

it('idle Collections tab: conditional polls per hour', async()=>{
  mocks.native.mockResolvedValue({url:'https://app.lakomics.local/media-cache/0/x',expires_in:240});
  render(<Collections active paused={false} backRef={{current:null}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  mocks.api.mockClear();
  await act(async()=>{await vi.advanceTimersByTimeAsync(60*60_000);});
  const counts=new Map<string,number>();
  for(const [path] of mocks.api.mock.calls as [string][]){const key=path.split('?')[0];counts.set(key,(counts.get(key)??0)+1);}
  console.info(`[perf] collections idle hour: ${[...counts].map(([path,n])=>`${path}=${n}`).join(' ')} total=${mocks.api.mock.calls.length}`);
  expect(mocks.api.mock.calls.length).toBeGreaterThan(0);
});

it('idle Collections tab with the native status long-poll live: checks only what moved', async()=>{
  // PERF-ALL-001 T1 gate: 120 conditional polls per idle hour -> <= 12 (10 min fallbacks),
  // list-generation 0, and a moved signal is checked at once.
  const report=(signals:Record<string,unknown>)=>act(()=>{window.dispatchEvent(new CustomEvent('lakomics-sync-signals',{detail:{live:true,signals}}));});
  const signals={listGeneration:'g1',characters:'c1',collections:{revision:'r1',personalEditCursor:3,appliedPersonalEditCursor:3},releases:7,catalog:'p1',bindingRequests:{last:2,updatedAt:null},notes:5};
  try{
    report(signals);
    mocks.native.mockResolvedValue({url:'https://app.lakomics.local/media-cache/0/x',expires_in:240});
    render(<Collections active paused={false} backRef={{current:null}}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    mocks.api.mockClear();
    await act(async()=>{await vi.advanceTimersByTimeAsync(60*60_000);});
    const counts=new Map<string,number>();
    for(const [path] of mocks.api.mock.calls as [string][]){const key=path.split('?')[0];counts.set(key,(counts.get(key)??0)+1);}
    console.info(`[perf] collections idle hour (signals live): ${[...counts].map(([path,n])=>`${path}=${n}`).join(' ')} total=${mocks.api.mock.calls.length}`);
    expect(mocks.api.mock.calls.length).toBeLessThanOrEqual(12);
    expect(counts.get('/v1/library/list-generation')??0).toBe(0);
    mocks.api.mockClear();
    report({...signals,notes:6,bindingRequests:{last:3,updatedAt:'t'}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(mocks.api).not.toHaveBeenCalled();
    report({...signals,notes:6,collections:{...signals.collections,appliedPersonalEditCursor:4}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(mocks.api.mock.calls.map(([path])=>path)).toEqual(['/v1/collections/status']);
    mocks.api.mockClear();
    report({...signals,notes:6,collections:{...signals.collections,appliedPersonalEditCursor:4},releases:8});
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(mocks.api.mock.calls.map(([path])=>(path as string).split('?')[0])).toEqual(['/v1/collections/releases']);
    // The watcher failing restores the one-minute polls.
    mocks.api.mockClear();
    act(()=>{window.dispatchEvent(new CustomEvent('lakomics-sync-signals',{detail:{live:false,signals:null}}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
    expect(mocks.api.mock.calls.length).toBe(2);
  }finally{
    act(()=>{window.dispatchEvent(new CustomEvent('lakomics-sync-signals',{detail:{live:false,signals:null}}));});
  }
});


it('bounds shelf cases after prefetch, picking and opening showcase',async()=>{
  const all=Array.from({length:192},(_,i)=>({...works[i%works.length],id:`large-${i}`,selectedWorkArtworkId:null,artworkVersions:{}}));
  let finish:(value:CollectionPage)=>void=()=>{};
  const rest=new Promise<CollectionPage>(resolve=>{finish=resolve;});
  const base=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>{
    if(path.startsWith('/v1/collections?')){
      if(path.includes('showcase=true'))return Promise.resolve({...page,items:all,totalCount:192});
      if(path.includes('cursor='))return rest;
      return Promise.resolve({...page,items:all.slice(0,48),nextCursor:'rest',totalCount:192});
    }
    return base(path);
  });
  localStorage.setItem('lakomics.mobile.collectionView.game.v1',JSON.stringify({layout:'shelf',perRow:4}));
  const view=render(<Collections active paused={false} backRef={{current:null}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  const count=()=>view.container.querySelectorAll('.collection-light-case').length;
  const first=count();
  await act(async()=>{finish({...page,items:all.slice(48),nextCursor:null});await vi.advanceTimersByTimeAsync(0);});
  const prefetched=count();
  let start=mocks.caseRenders;
  fireEvent.click(view.container.querySelector('[data-collection-id="large-0"]')!);
  const pick=mocks.caseRenders-start;
  for(const id of ['large-1','large-0']){
    start=mocks.caseRenders;
    fireEvent.click(view.container.querySelector(`[data-collection-id="${id}"]`)!);
    expect(mocks.caseRenders-start).toBeLessThanOrEqual(2);
  }
  start=mocks.caseRenders;
  const read=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation((path:string)=>path.startsWith('/v1/collections/releases')?Promise.resolve({items:[],unreadCount:1,revision:'x2'}):read(path));
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  const countRenders=mocks.caseRenders-start;
  start=mocks.caseRenders;
  fireEvent.click(view.container.querySelector('.collection-shortcuts button[aria-label="쇼케이스"]')!);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  const open=count(),openRenders=mocks.caseRenders-start;
  // Past the sheet's spring rise (the deferred body's fallback when no transitionend arrives).
  await act(async()=>{await vi.advanceTimersByTimeAsync(500);});
  const settled=count(),settledRenders=mocks.caseRenders-start;
  console.info(`[perf] S11 shelf 192: first=${first} prefetched=${prefetched} pickRenders=${pick} countRenders=${countRenders} overlayOpening=${open} overlayOpeningRenders=${openRenders} overlaySettled=${settled} overlaySettledRenders=${settledRenders}\n`);
  // These caps only tighten after an improvement; do not relax them to accommodate regressions.
  expect(first).toBeLessThanOrEqual(20);
  expect(prefetched).toBeLessThanOrEqual(20);
  expect(pick).toBeLessThanOrEqual(1);
  expect(countRenders).toBe(0);
  expect(open).toBeLessThanOrEqual(20);
  expect(openRenders).toBe(0);
  expect(settled).toBeLessThanOrEqual(40);
  expect(settledRenders).toBeLessThanOrEqual(20);
  expect(settled).toBeGreaterThan(prefetched); // Deferred content really arrived.
  const root=view.container.querySelector<HTMLElement>('.mobile-collections .motion-stage__view > .collection-scroll')!;
  const tracks=()=>[...root.querySelectorAll<HTMLElement>('.collection-list__cell')].map(cell=>[cell.style.gridRow,cell.style.height]);
  const geometry=tracks();
  root.scrollTop=6000;fireEvent.scroll(root);
  expect(root.querySelector('[data-collection-id="large-64"]')).not.toBeNull();
  expect(root.querySelector('[data-collection-id="large-0"]')).not.toBeNull(); // Pick survives window exit.
  expect(tracks()).toEqual(geometry);
  root.scrollTop=0;fireEvent.scroll(root);
  expect(root.querySelector('[data-collection-id="large-4"]')).not.toBeNull();
});
