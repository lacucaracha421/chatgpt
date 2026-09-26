import {afterEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport', () => ({api:mocks.api,native:mocks.native}));
import {clearOriginalTicketWarm, warmOriginalTickets} from './originalTicketWarm';
import {clearMediaCache, loadThumbnail, prefetchThumbnails, mediaTicket} from './media';
import type {MediaTiming} from './perf';

afterEach(() => {vi.unstubAllGlobals(); clearMediaCache(); mocks.api.mockReset(); mocks.native.mockReset();});

it('correlates originals without changing ticket caching or making another request',async()=>{
  const asset={id:'a',kind:'image' as const,content_type:'image/png'};
  const ticket={url:'https://example.invalid/original',expires_in:240};mocks.native.mockResolvedValue(ticket);
  const first:MediaTiming={requestId:'trace-1',source:'unknown'};
  expect(await mediaTicket(asset,'original',undefined,first)).toBe(ticket);
  expect(first.source).toBe('native');
  expect(mocks.native).toHaveBeenCalledWith('media',{assetId:'a',mime:'image/png',perfId:'trace-1'},expect.any(AbortSignal));
  const second:MediaTiming={requestId:'trace-2',source:'unknown'};
  expect(await mediaTicket(asset,'original',undefined,second)).toBe(ticket);
  expect(second.source).toBe('memory');expect(mocks.native).toHaveBeenCalledOnce();
});

it('bounds thumbnail work, displays a fast image independently, and cancels obsolete queued tiles', async () => {
  vi.stubGlobal('Image', class {
    naturalWidth = 600; naturalHeight = 900;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value:string) {if (value) queueMicrotask(() => this.onload?.());}
    decode() {return Promise.resolve();}
  });
  const complete = new Map<string, () => void>();
  mocks.native.mockImplementation((_op:string, payload:{assetId:string}, signal:AbortSignal) => new Promise((resolve,reject) => {
    complete.set(payload.assetId, () => resolve({url:'https://example.invalid/thumb',expires_in:240}));
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled','AbortError')), {once:true});
  }));
  const controllers = Array.from({length:12}, () => new AbortController());
  const requests = controllers.map((controller,i) => loadThumbnail({id:String(i),kind:'image'}, controller.signal));
  // Attach rejection handlers before aborting, as the actual tiles do.
  const settled = Promise.allSettled(requests);
  // Uncached thumbnails are latency-bound, so ten run at once and the rest wait.
  expect(mocks.native).toHaveBeenCalledTimes(10);
  controllers[10].abort();
  complete.get('1')!();
  const fast = await requests[1];
  expect(fast.preview).toBe('https://example.invalid/thumb');
  expect(fast.ratio).toBeCloseTo(2/3);
  await vi.waitFor(() => expect(complete.has('11')).toBe(true));
  expect(complete.has('10')).toBe(false);
  controllers.forEach(controller => controller.abort());
  const results = await settled;
  expect(results[0].status).toBe('rejected');
  expect(results[10].status).toBe('rejected');
});

it('keeps background work to three slots and behind waiting visible tiles',async()=>{
  const decoded=vi.fn();
  vi.stubGlobal('Image',class {naturalWidth=600;naturalHeight=900;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;set src(value:string){if(value){decoded(value);queueMicrotask(()=>this.onload?.());}}decode(){return Promise.resolve();}});
  const complete=new Map<string,()=>void>();
  mocks.native.mockImplementation((_op:string,payload:{assetId:string})=>new Promise(resolve=>complete.set(payload.assetId,()=>resolve({url:`https://example.invalid/${payload.assetId}`,expires_in:240}))));
  // Twelve visible tiles: ten run, two wait.
  const visible=Array.from({length:12},()=>new AbortController());
  visible.forEach((controller,i)=>void loadThumbnail({id:`v${i}`,kind:'image'},controller.signal).catch(()=>{}));
  const ahead=new AbortController();
  prefetchThumbnails(Array.from({length:5},(_,i)=>({id:`p${i}`,kind:'image'})),ahead.signal);
  const started=()=>[...complete.keys()].filter(key=>key.startsWith('p'));
  // Visible tiles are still waiting, so background work has not started.
  expect(started()).toEqual([]);
  complete.get('v0')!();complete.get('v1')!();
  await vi.waitFor(()=>expect(complete.has('v11')).toBe(true));
  // With no visible tile waiting, at most three background loads run beside the visible ones.
  await vi.waitFor(()=>expect(started()).toEqual(['p0','p1','p2']));
  // Scrolling on drops the queued rest but lets started downloads finish into the cache.
  ahead.abort();
  complete.get('p0')!();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(started()).toEqual(['p0','p1','p2']);
  expect(decoded.mock.calls.some(([url])=>String(url).includes('/p'))).toBe(false);
  visible.forEach(controller=>controller.abort());
});


it('joins an in-flight original and aborts only after the last subscriber leaves',async()=>{
  let finish!:(value:{url:string;expires_in:number})=>void;
  mocks.native.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const asset={id:'neighbour',kind:'image'},prefetch=new AbortController(),main=new AbortController();
  const warm=mediaTicket(asset,'original',prefetch.signal).catch(error=>error);
  const opened=mediaTicket(asset,'original',main.signal);
  expect(mocks.native).toHaveBeenCalledTimes(1);
  const nativeSignal=mocks.native.mock.calls[0][2] as AbortSignal;
  prefetch.abort();expect(nativeSignal.aborted).toBe(false);
  finish({url:'https://test.invalid/original',expires_in:240});
  expect((await opened).url).toContain('/original');expect((await warm).name).toBe('AbortError');
  const leaving=new AbortController();void mediaTicket({id:'other',kind:'image'},'original',leaving.signal).catch(()=>{});
  const otherSignal=mocks.native.mock.lastCall![2] as AbortSignal;
  leaving.abort();expect(otherSignal.aborted).toBe(true);
});

it('warms only visible image tickets once while valid, in batches, then renews at the safety margin',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
  const first=new AbortController(),second=new AbortController();
  mocks.native.mockImplementation(async(op:string,payload:{assetIds:string[]})=>{
    expect(op).toBe('mediaTickets');
    return {items:payload.assetIds.map(assetId=>({assetId,expires_at:new Date(Date.now()+300_000).toISOString()}))};
  });
  try{
    warmOriginalTickets([{id:'a',kind:'image'},{id:'b',kind:'gif'},{id:'v',kind:'video'},{id:'p',kind:'image',pending:true}],first.signal);
    warmOriginalTickets([{id:'a',kind:'image'}],second.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(mocks.native.mock.calls[0][1]).toEqual({assetIds:['a','b']});
    first.abort();
    await vi.advanceTimersByTimeAsync(284_999);expect(mocks.native).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(mocks.native).toHaveBeenCalledTimes(2);
    expect(mocks.native.mock.calls[1][1]).toEqual({assetIds:['a']});
  }finally{first.abort();second.abort();vi.useRealTimers();}
});

it('pauses ticket warming while hidden or metered and drops items that leave before dispatch',async()=>{
  vi.useFakeTimers();
  const connection=new EventTarget() as EventTarget & {type:string};connection.type='cellular';
  vi.stubGlobal('navigator',{...navigator,connection});
  const current=new AbortController(),gone=new AbortController();
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  mocks.native.mockImplementation(async(_op:string,payload:{assetIds:string[]})=>({items:payload.assetIds.map(assetId=>({assetId,expires_at:new Date(Date.now()+300_000).toISOString()}))}));
  try{
    warmOriginalTickets([{id:'a',kind:'image'}],current.signal);
    warmOriginalTickets([{id:'gone',kind:'image'}],gone.signal);gone.abort();
    await vi.advanceTimersByTimeAsync(0);expect(mocks.native).not.toHaveBeenCalled();
    visibility.mockReturnValue('hidden');connection.type='wifi';connection.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(0);expect(mocks.native).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(mocks.native.mock.calls[0][1]).toEqual({assetIds:['a']});
  }finally{current.abort();visibility.mockRestore();vi.useRealTimers();}
});

it('bounds visible ticket subscriptions to 128 and each native batch to 50',async()=>{
  vi.useFakeTimers();
  const controller=new AbortController();
  mocks.native.mockImplementation(async(_op:string,payload:{assetIds:string[]})=>({items:payload.assetIds.map(assetId=>({assetId,expires_at:new Date(Date.now()+300_000).toISOString()}))}));
  try{
    warmOriginalTickets(Array.from({length:200},(_,i)=>({id:`visible-${i}`,kind:'image'})),controller.signal);
    await vi.advanceTimersByTimeAsync(5);
    expect(mocks.native.mock.calls.map(([,payload])=>payload.assetIds.length)).toEqual([50,50,28]);
    expect(new Set(mocks.native.mock.calls.flatMap(([,payload])=>payload.assetIds)).size).toBe(128);
  }finally{controller.abort();vi.useRealTimers();}
});

it('treats a new thumbnail revision of the same asset as a different ticket and URL',async()=>{
  mocks.native.mockImplementation(async(_op:string,payload:{assetId:string;revision?:string})=>({url:`https://app.lakomics.local/media-cache/0/${payload.revision ?? 'none'}`,expires_in:240}));
  const before={id:'a',kind:'image',thumbnail_revision:'r1'};
  const first=await mediaTicket(before,'thumbnail');
  expect(await mediaTicket(before,'thumbnail')).toBe(first);
  const after=await mediaTicket({...before,thumbnail_revision:'r2'},'thumbnail');
  expect(after.url).not.toBe(first.url);
  expect(mocks.native.mock.calls.map(([op,payload])=>[op,payload])).toEqual([
    ['thumbnail',{assetId:'a',revision:'r1'}],
    ['thumbnail',{assetId:'a',revision:'r2'}],
  ]);
  // A server without revisions keeps today's request; an unusable token is not sent to native.
  await mediaTicket({id:'b',kind:'image'},'thumbnail');
  await mediaTicket({id:'c',kind:'image',thumbnail_revision:'../x'},'thumbnail');
  expect(mocks.native.mock.calls.slice(2).map(([,payload])=>payload)).toEqual([{assetId:'b'},{assetId:'c'}]);
});

it('waits for the native power event instead of retrying tickets native declined on battery',async()=>{
  vi.useFakeTimers();clearOriginalTicketWarm();
  const controller=new AbortController();let charging=false;
  mocks.native.mockImplementation(async(_op:string,payload:{assetIds:string[]})=>charging
    ?{items:payload.assetIds.map(assetId=>({assetId,expires_at:new Date(Date.now()+300_000).toISOString()}))}
    :{items:[],waiting:'power'});
  try{
    warmOriginalTickets([{id:'power-a',kind:'image'}],controller.signal);
    await vi.advanceTimersByTimeAsync(0);expect(mocks.native).toHaveBeenCalledTimes(1);
    // The old 30 s failure back-off no longer re-asks while the battery rule is unchanged.
    await vi.advanceTimersByTimeAsync(10*60_000);expect(mocks.native).toHaveBeenCalledTimes(1);
    charging=true;window.dispatchEvent(new CustomEvent('lakomics-power',{detail:{charging:true,level:40,powerSave:false}}));
    await vi.advanceTimersByTimeAsync(0);expect(mocks.native).toHaveBeenCalledTimes(2);
    expect(mocks.native.mock.calls[1][1]).toEqual({assetIds:['power-a']});
    // Warmed now: a later power event does not re-ask a valid ticket.
    window.dispatchEvent(new CustomEvent('lakomics-power',{detail:null}));
    await vi.advanceTimersByTimeAsync(0);expect(mocks.native).toHaveBeenCalledTimes(2);
  }finally{controller.abort();vi.useRealTimers();}
});
