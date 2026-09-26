/**
 * PERF-ALL-001 measurement harness: the cost of one Library thumbnail warm-up pass in bridge
 * calls, and what a transient page failure costs. Metrics are printed as `[perf] …` lines.
 * The failure scenario is a gate (baseline 134 pages / 13,300 thumbnail calls when a failure
 * restarted the walk): the retry resumes at the failed page, so the pass reads each page once
 * plus the one retry. Thresholds may only tighten.
 */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native}));
import {clearMediaCache} from './media';
import {resetWarmProgress, setWarmEnabled, startThumbnailWarm, warmState} from './thumbnailWarm';

/** The Linux library had 9,300 Assets on 2026-09-26; the walk reads 100 per page. */
const ASSETS=9300, PAGE=100;
const pageOf=(cursor:string|null)=>{
  const start=cursor?Number(cursor):0;
  const items=Array.from({length:Math.min(PAGE,ASSETS-start)},(_,i)=>({id:`a${start+i}`,kind:'image'}));
  const next=start+PAGE<ASSETS?String(start+PAGE):null;
  return {items,has_more:next!==null,next_cursor:next};
};
let stop:(()=>void)|null=null;
const cached=new Set<string>();
beforeEach(()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  localStorage.clear();resetWarmProgress();setWarmEnabled(true);cached.clear();
  mocks.native.mockImplementation(async(op:string,payload:{assetId:string;assetIds:string[]})=>{
    if(op==='status')return {battery:{charging:true,level:80,powerSave:false}};
    if(op==='thumbnailsCached')return {generation:'cache-1',cachedIds:payload.assetIds.filter(id=>cached.has(id))};
    cached.add(payload.assetId);return {url:`https://app.lakomics.local/media-cache/0/${payload.assetId}`,expires_in:240};
  });
});
afterEach(()=>{vi.useRealTimers();stop?.();stop=null;clearMediaCache();mocks.api.mockReset();mocks.native.mockReset();});

const tally=()=>{const ops=new Map<string,number>();for(const [op] of mocks.native.mock.calls as [string][])ops.set(op,(ops.get(op)??0)+1);return ops;};

it('one full pass: pages, status checks and thumbnail bridge calls', async()=>{
  mocks.api.mockImplementation(async(path:string)=>pageOf(new URL(path,'https://x.invalid').searchParams.get('cursor')));
  stop=startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('done'),{timeout:20_000});
  const ops=tally();
  console.info(`[perf] warm-up full pass (${ASSETS} assets): apiPages=${mocks.api.mock.calls.length} nativeStatus=${ops.get('status')??0} nativeThumbnail=${ops.get('thumbnail')??0} (each native thumbnail = one mediaWorkers slot + SecureSettings.read + cache lookup, even on a cache hit)`);
  expect(warmState().warmed).toBe(ASSETS);
});

it('a transient page failure mid-pass resumes at the failed page', async()=>{
  let failed=false;
  mocks.api.mockImplementation(async(path:string)=>{
    const cursor=new URL(path,'https://x.invalid').searchParams.get('cursor');
    if(cursor==='4000'&&!failed){failed=true;throw new Error('network');}
    return pageOf(cursor);
  });
  stop=startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('error'),{timeout:20_000});
  const before=mocks.api.mock.calls.length;
  // The retry comes after RETRY_AFTER (60 s).
  await vi.advanceTimersByTimeAsync(60_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('done'),{timeout:20_000});
  const firstRetryPath=(mocks.api.mock.calls[before]?.[0] as string)??'';
  console.info(`[perf] warm-up after one failed page at 4000/${ASSETS}: pagesBeforeFailure=${before} pagesTotal=${mocks.api.mock.calls.length} retryStartsAt=${new URL(firstRetryPath,'https://x.invalid').searchParams.get('cursor')??'first page'} nativeThumbnail=${tally().get('thumbnail')??0}`);
  expect(failed).toBe(true);
  expect(before).toBe(41);
  expect(new URL(firstRetryPath,'https://x.invalid').searchParams.get('cursor')).toBe('4000');
  expect(mocks.api).toHaveBeenCalledTimes(ASSETS/PAGE+1);
  expect(tally().get('thumbnail')).toBe(ASSETS);
  expect(warmState().warmed).toBe(ASSETS);
});

const nextDay=async()=>{
  stop?.();stop=null;clearMediaCache();mocks.api.mockClear();mocks.native.mockClear();
  vi.setSystemTime(Date.now()+24*60*60*1000+1);
  stop=startThumbnailWarm('https://server.invalid');await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('done'));
};

it('gates a cached 9,300-asset sweep, unchanged daily pass and 50 additions',async()=>{
  for(let i=0;i<ASSETS;i++)cached.add(`a${i}`);
  let added=0;
  mocks.api.mockImplementation(async(path:string)=>{
    const cursor=new URL(path,'https://x.invalid').searchParams.get('cursor');
    if(!cursor&&added)return {items:[...Array.from({length:added},(_,i)=>({id:`new${i}`,kind:'image'})),...pageOf(null).items.slice(0,PAGE-added)],has_more:true,next_cursor:'50'};
    return pageOf(cursor);
  });
  stop=startThumbnailWarm('https://server.invalid');await vi.advanceTimersByTimeAsync(5_500);
  expect(warmState().status).toBe('done');
  expect(mocks.api).toHaveBeenCalledTimes(93);
  expect(tally().get('thumbnailsCached')).toBe(93);
  expect(mocks.native.mock.calls.length).toBeLessThanOrEqual(ASSETS/PAGE*2);
  expect(tally().get('thumbnail')??0).toBe(0);
  await nextDay();
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(mocks.native).toHaveBeenCalledTimes(2);
  expect(tally().get('thumbnail')??0).toBe(0);
  expect(warmState().warmed).toBe(0);
  added=50;await nextDay();
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(tally().get('thumbnail')).toBe(50);
  expect(mocks.native.mock.calls.filter(([op])=>op==='thumbnail').map(([,p])=>p.assetId)).toEqual(Array.from({length:50},(_,i)=>`new${i}`));
  expect(warmState().warmed).toBe(50);
});
