import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({api:vi.fn(), native:vi.fn()}));
vi.mock('./transport', () => ({api:mocks.api, native:mocks.native}));
import {clearMediaCache} from './media';
import {resetWarmProgress, setWarmEnabled, startThumbnailWarm, warmState} from './thumbnailWarm';

const asset = (id:string) => ({id, kind:'image'});
const pages:Record<string,{items:{id:string;kind:string}[];has_more:boolean;next_cursor:string|null}> = {
  first:{items:[asset('a'), asset('b')], has_more:true, next_cursor:'c2'},
  c2:{items:[asset('c')], has_more:false, next_cursor:null},
};
let stop:(()=>void)|null = null;
let generation = 'cache-1';
const cached = new Set<string>();
beforeEach(() => {
  vi.useFakeTimers({shouldAdvanceTime:true});
  localStorage.clear(); resetWarmProgress(); setWarmEnabled(true); cached.clear(); generation = 'cache-1';
  mocks.api.mockImplementation(async (path:string) => pages[new URL(path, 'https://x.invalid').searchParams.get('cursor') ?? 'first']);
  mocks.native.mockImplementation(async (op:string, payload:{assetId:string;assetIds:string[]}) => {
    if(op==='status')return {battery:{charging:false,level:80,powerSave:false}};
    if(op==='thumbnailsCached')return {generation,cachedIds:payload.assetIds.filter(id=>cached.has(id))};
    cached.add(payload.assetId);return {url:`https://example.invalid/${payload.assetId}`,expires_in:240};
  });
});
afterEach(() => { vi.useRealTimers(); stop?.(); stop = null; clearMediaCache(); mocks.api.mockReset(); mocks.native.mockReset(); vi.unstubAllGlobals(); });

it('walks every Library page once, asking native for each thumbnail, then reports done', async () => {
  stop = startThumbnailWarm('https://server.invalid');
  // The first screen gets a head start before background work begins.
  await vi.advanceTimersByTimeAsync(4_000);
  expect(mocks.api).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_500);
  await vi.waitFor(() => expect(warmState().status).toBe('done'));
  expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
    expect.stringContaining('/v1/library/assets?limit=100'),
    expect.stringContaining('cursor=c2'),
  ]);
  expect(mocks.native.mock.calls.filter(([op])=>op==='thumbnail').map(([op, payload]) => `${op}:${payload.assetId}`)).toEqual(['thumbnail:a', 'thumbnail:b', 'thumbnail:c']);
  expect(warmState().warmed).toBe(3);
  // A finished pass is not repeated within a day.
  stop(); stop = startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(() => expect(warmState().status).toBe('done'));
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

it('resumes from the saved cursor for the same endpoint only', async () => {
  localStorage.setItem('lakomics.mobile.thumbnailWarm', JSON.stringify({scope:'https://server.invalid', cursor:'c2', warmed:2, completedAt:null, generation:'cache-1'}));
  stop = startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(() => expect(warmState().status).toBe('done'));
  expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([expect.stringContaining('cursor=c2')]);
  expect(warmState().warmed).toBe(3);
  stop(); mocks.api.mockClear();
  stop = startThumbnailWarm('https://other.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(() => expect(warmState().status).toBe('done'));
  expect(mocks.api.mock.calls[0][0]).not.toContain('cursor=');
});

it('stays paused when switched off or on a cellular or data-saving link', async () => {
  setWarmEnabled(false);
  stop = startThumbnailWarm('https://server.invalid');
  expect(warmState().status).toBe('off');
  stop();
  setWarmEnabled(true);
  vi.stubGlobal('navigator', {...navigator, connection:{type:'cellular'}});
  stop = startThumbnailWarm('https://server.invalid');
  expect(warmState().status).toBe('metered');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mocks.api).not.toHaveBeenCalled();
});


it.each([
  {charging:false,level:49,powerSave:false},
  {charging:false,level:95,powerSave:true},
  undefined,
])('does not warm on a disallowed or unknown battery state: %j',async battery=>{
  mocks.native.mockResolvedValue({battery});
  stop=startThumbnailWarm('battery-test');
  await vi.advanceTimersByTimeAsync(65_000);
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.native.mock.calls.every(([op])=>op==='status')).toBe(true);
  expect(warmState().status).toBe('waiting');
});
it('allows charging even below fifty percent',async()=>{
  const original=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op:string,payload:{assetId:string})=>op==='status'?Promise.resolve({battery:{charging:true,level:10,powerSave:false}}):original(op,payload));
  stop=startThumbnailWarm('charging-test');await vi.advanceTimersByTimeAsync(5500);
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

const cursors=()=>mocks.api.mock.calls.map(([path])=>new URL(path as string,'https://x.invalid').searchParams.get('cursor')??'first');
it('resumes at the failed page after a transient error',async()=>{
  let fail=1;
  mocks.api.mockImplementation(async(path:string)=>{const cursor=new URL(path,'https://x.invalid').searchParams.get('cursor')??'first';if(cursor==='c2'&&fail-->0)throw new Error('network');return pages[cursor];});
  stop=startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('error'));
  await vi.advanceTimersByTimeAsync(65_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('done'));
  expect(cursors()).toEqual(['first','c2','c2']);
  expect(warmState().warmed).toBe(3);
});
it('starts again from the first page when the server rejects the saved cursor',async()=>{
  let fail=1;
  mocks.api.mockImplementation(async(path:string)=>{const cursor=new URL(path,'https://x.invalid').searchParams.get('cursor')??'first';if(cursor==='c2'&&fail-->0)throw Object.assign(new Error('Invalid cursor'),{status:400});return pages[cursor];});
  stop=startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('error'));
  await vi.advanceTimersByTimeAsync(65_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('done'));
  expect(cursors()).toEqual(['first','c2','first','c2']);
  expect(warmState().warmed).toBe(3);
});
it('bounds retries at one page: the third consecutive failure starts the pass again',async()=>{
  let fail=3;
  mocks.api.mockImplementation(async(path:string)=>{const cursor=new URL(path,'https://x.invalid').searchParams.get('cursor')??'first';if(cursor==='c2'&&fail-->0)throw new Error('network');return pages[cursor];});
  stop=startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  for(let retry=0;retry<3;retry++)await vi.advanceTimersByTimeAsync(65_500);
  await vi.waitFor(()=>expect(warmState().status).toBe('done'));
  expect(cursors()).toEqual(['first','c2','c2','c2','first','c2']);
});

const start = async () => {stop?.();stop=startThumbnailWarm('https://server.invalid');await vi.advanceTimersByTimeAsync(5_500);};
const downloads = () => mocks.native.mock.calls.filter(([op])=>op==='thumbnail').map(([,payload])=>payload.assetId);
const daily = async () => {stop?.();stop=null;vi.setSystemTime(Date.now()+24*60*60*1000+1);await start();};

it('persists the high-water mark across restarts and stops before old pages',async()=>{
  await start();expect(warmState().status).toBe('done');
  mocks.api.mockClear();mocks.native.mockClear();clearMediaCache();
  await daily();
  expect(cursors()).toEqual(['first']);expect(downloads()).toEqual([]);
  expect(warmState().warmed).toBe(0);
});

it.each(['cache clear','connection replacement'])('invalidates even a recent completion after %s',async()=>{
  await start();cached.clear();generation='cache-2';mocks.api.mockClear();mocks.native.mockClear();
  await start();
  expect(cursors()).toEqual(['first','c2']);expect(downloads()).toEqual(['a','b','c']);
  expect(warmState().status).toBe('done');
});

it('discards an old resume cursor when the native generation changes',async()=>{
  localStorage.setItem('lakomics.mobile.thumbnailWarm',JSON.stringify({scope:'https://server.invalid',cursor:'c2',warmed:2,completedAt:null,generation:'old'}));
  await start();
  expect(cursors()).toEqual(['c2','first','c2']);expect(downloads()).toEqual(['a','b','c']);
});

it('does not advance past a failed thumbnail, and retries that page',async()=>{
  const original=mocks.native.getMockImplementation()!;let failed=false;
  mocks.native.mockImplementation((op,payload)=>{
    if(op==='thumbnail'&&payload.assetId==='c'&&!failed){failed=true;return Promise.reject(new Error('download'));}
    return original(op,payload);
  });
  await start();expect(warmState().status).toBe('error');
  expect(JSON.parse(localStorage.getItem('lakomics.mobile.thumbnailWarm')!).cursor).toBe('c2');
  await vi.advanceTimersByTimeAsync(65_500);
  expect(cursors()).toEqual(['first','c2','c2']);expect(warmState().status).toBe('done');
});

it('uses the timestamp and id boundary even if the newest warmed asset was deleted',async()=>{
  let items=[{...asset('b'),collected_at:'2026-09-25'}, {...asset('a'),collected_at:'2026-09-25'}];
  mocks.api.mockImplementation(async()=>({items,has_more:false,next_cursor:null}));
  await start();
  items=[{...asset('c'),collected_at:'2026-09-25'}, {...asset('a'),collected_at:'2026-09-25'}];
  mocks.native.mockClear();await daily();expect(downloads()).toEqual(['c']);
});

it('keeps the old boundary during an interrupted incremental pass',async()=>{
  await start();
  let failed=false;
  mocks.api.mockImplementation(async(path:string)=>{
    const cursor=new URL(path,'https://x.invalid').searchParams.get('cursor');
    if(!cursor)return {items:[asset('new-2')],has_more:true,next_cursor:'delta'};
    if(!failed){failed=true;throw new Error('network');}
    return {items:[asset('new-1'),asset('a')],has_more:true,next_cursor:'old'};
  });
  await daily();expect(warmState().status).toBe('error');
  let saved=JSON.parse(localStorage.getItem('lakomics.mobile.thumbnailWarm')!);
  expect(saved.highWater.id).toBe('a');expect(saved.newest.id).toBe('new-2');
  await vi.advanceTimersByTimeAsync(65_500);expect(warmState().status).toBe('done');
  saved=JSON.parse(localStorage.getItem('lakomics.mobile.thumbnailWarm')!);
  expect(saved.highWater.id).toBe('new-2');expect(saved.warmed).toBe(2);
});

it('sweeps old evictions monthly instead of every day',async()=>{
  await start();cached.delete('c');mocks.api.mockClear();mocks.native.mockClear();
  stop?.();stop=null;vi.setSystemTime(Date.now()+31*24*60*60*1000);await start();
  expect(cursors()).toEqual(['first','c2']);expect(downloads()).toEqual(['c']);
});

it('rechecks the battery before continuing to another page',async()=>{
  const original=mocks.native.getMockImplementation()!;let checks=0;
  mocks.native.mockImplementation((op,payload)=>op==='status'&&++checks>1?Promise.resolve({battery:{charging:false,level:20,powerSave:false}}):original(op,payload));
  await start();
  expect(cursors()).toEqual(['first']);expect(warmState().status).toBe('waiting');
  expect(JSON.parse(localStorage.getItem('lakomics.mobile.thumbnailWarm')!).cursor).toBe('c2');
});

it('restarts when cache clearing races a page download',async()=>{
  const original=mocks.native.getMockImplementation()!;let cleared=false;
  mocks.native.mockImplementation(async(op,payload)=>{
    const result=await original(op,payload);
    if(op==='thumbnail'&&payload.assetId==='c'&&!cleared){cleared=true;cached.clear();generation='cache-2';}
    return result;
  });
  await start();
  expect(cursors()).toEqual(['first','c2','first','c2']);
  expect(warmState().status).toBe('done');expect([...cached].sort()).toEqual(['a','b','c']);
});

it('does not save completion after its owner stops during a cache probe',async()=>{
  const original=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation(async(op,payload)=>{
    const result=await original(op,payload);
    if(op==='thumbnailsCached')stop?.();
    return result;
  });
  await start();expect(downloads()).toEqual([]);
  expect(localStorage.getItem('lakomics.mobile.thumbnailWarm')).toBeNull();
});

it('probes the native cache with each thumbnail revision, the same key the tiles load', async () => {
  const revised = {first:{items:[{id:'a',kind:'image',thumbnail_revision:'r2'},asset('b')],has_more:false,next_cursor:null}};
  mocks.api.mockImplementation(async () => revised.first);
  stop = startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(() => expect(warmState().status).toBe('done'));
  const probes = mocks.native.mock.calls.filter(([op]) => op === 'thumbnailsCached').map(([, payload]) => payload);
  expect(probes[0]).toEqual({assetIds:['a','b'], revisions:['r2','']});
  expect(mocks.native.mock.calls.filter(([op]) => op === 'thumbnail').map(([, payload]) => payload)).toEqual([{assetId:'a',revision:'r2'},{assetId:'b'}]);
});
