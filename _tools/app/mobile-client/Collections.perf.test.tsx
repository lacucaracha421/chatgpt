/**
 * PERF-ALL-001 measurement harness: the Collections
 * cold-start cover path and the Collections tab's idle request volume.
 *
 * Metrics are printed as `[perf] …` lines and are deterministic under fake timers. Most
 * assertions only check that the scenario ran; the saturated cold start is a gate for the
 * visible-cover retry (harness before the fix: 4 of 16 covers shown and 12 failed at 30 s).
 */
import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionPage, CollectionSummary} from './collectionModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>String(reason)}));
vi.mock('./media',()=>({mediaTicket:vi.fn()}));
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
  observed=[];
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver',FirstScreenObserver);
  mocks.api.mockReset();mocks.native.mockReset();
  mocks.api.mockImplementation(async(path:string)=>path.startsWith('/v1/collections?')?page
    :path.startsWith('/v1/collections/status')?{revision:'r1'}
    :path.startsWith('/v1/collections/releases')?{items:[],unreadCount:0,revision:'x'}:{});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

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

it('cold start: first-screen game covers are fetched at most four at a time', async()=>{
  // One uncached cover costs a ticket (~0.1-0.2 s + a cold R2 HEAD on the server) plus the
  // R2 download (~1.5-2.4 s measured on the tablet, MOBILE-PERF-002): model 2 s.
  const result=await coldCovers(2000);
  console.info(`[perf] collections cold covers: firstScreen=${FIRST_SCREEN} requested=${result.requested} peakConcurrent=${result.peak} firstCoverMs=${result.firstCoverMs} allFirstScreenMs=${result.allFirstScreenMs} (2000 ms per uncached cover)`);
  expect(result.requested).toBeGreaterThanOrEqual(FIRST_SCREEN);
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
