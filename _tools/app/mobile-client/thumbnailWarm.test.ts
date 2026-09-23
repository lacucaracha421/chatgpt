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
beforeEach(() => {
  vi.useFakeTimers({shouldAdvanceTime:true});
  localStorage.clear(); resetWarmProgress(); setWarmEnabled(true);
  mocks.api.mockImplementation(async (path:string) => pages[new URL(path, 'https://x.invalid').searchParams.get('cursor') ?? 'first']);
  mocks.native.mockImplementation(async (_op:string, payload:{assetId:string}) => ({url:`https://example.invalid/${payload.assetId}`, expires_in:240}));
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
  expect(mocks.native.mock.calls.map(([op, payload]) => `${op}:${payload.assetId}`)).toEqual(['thumbnail:a', 'thumbnail:b', 'thumbnail:c']);
  expect(warmState().warmed).toBe(3);
  // A finished pass is not repeated within a day.
  stop(); stop = startThumbnailWarm('https://server.invalid');
  await vi.advanceTimersByTimeAsync(5_500);
  await vi.waitFor(() => expect(warmState().status).toBe('done'));
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

it('resumes from the saved cursor for the same endpoint only', async () => {
  localStorage.setItem('lakomics.mobile.thumbnailWarm', JSON.stringify({scope:'https://server.invalid', cursor:'c2', warmed:2, completedAt:null}));
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
