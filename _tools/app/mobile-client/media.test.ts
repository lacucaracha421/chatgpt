import {afterEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport', () => ({api:mocks.api,native:mocks.native}));
import {clearMediaCache, loadThumbnail} from './media';

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
  const controllers = Array.from({length:6}, () => new AbortController());
  const requests = controllers.map((controller,i) => loadThumbnail({id:String(i),kind:'image'}, controller.signal));
  // Attach rejection handlers before aborting, as the actual tiles do.
  const settled = Promise.allSettled(requests);
  expect(mocks.native).toHaveBeenCalledTimes(4);
  controllers[4].abort();
  complete.get('1')!();
  const fast = await requests[1];
  expect(fast.preview).toBe('https://example.invalid/thumb');
  expect(fast.ratio).toBeCloseTo(2/3);
  await vi.waitFor(() => expect(complete.has('5')).toBe(true));
  expect(complete.has('4')).toBe(false);
  controllers.forEach(controller => controller.abort());
  const results = await settled;
  expect(results[0].status).toBe('rejected');
  expect(results[4].status).toBe('rejected');
});
