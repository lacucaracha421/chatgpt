import {afterEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport', () => ({api:mocks.api,native:mocks.native}));
import {clearMediaCache, loadThumbnail, prefetchThumbnails} from './media';

afterEach(() => {vi.unstubAllGlobals(); clearMediaCache(); mocks.api.mockReset(); mocks.native.mockReset();});

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

it('prefetches only with idle capacity, never decodes, and drops queued work when scrolled on',async()=>{
  const decoded=vi.fn();
  vi.stubGlobal('Image',class {naturalWidth=600;naturalHeight=900;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;set src(value:string){if(value){decoded(value);queueMicrotask(()=>this.onload?.());}}decode(){return Promise.resolve();}});
  const complete=new Map<string,()=>void>();
  mocks.native.mockImplementation((_op:string,payload:{assetId:string})=>new Promise(resolve=>complete.set(payload.assetId,()=>resolve({url:`https://example.invalid/${payload.assetId}`,expires_in:240}))));
  const visible=Array.from({length:10},(_,i)=>new AbortController());
  visible.forEach((controller,i)=>void loadThumbnail({id:`v${i}`,kind:'image'},controller.signal).catch(()=>{}));
  const ahead=new AbortController();
  prefetchThumbnails(Array.from({length:3},(_,i)=>({id:`p${i}`,kind:'image'})),ahead.signal);
  // Every slot is busy with visible tiles, so nothing ahead has started.
  expect([...complete.keys()].filter(key=>key.startsWith('p'))).toEqual([]);
  complete.get('v0')!();
  await vi.waitFor(()=>expect(complete.has('p0')).toBe(true));
  // Scrolling on drops the queued rest but lets the started download finish into the cache.
  ahead.abort();
  complete.get('v1')!();complete.get('p0')!();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(complete.has('p1')).toBe(false);
  expect(decoded.mock.calls.some(([url])=>String(url).includes('/p'))).toBe(false);
  visible.forEach(controller=>controller.abort());
});
