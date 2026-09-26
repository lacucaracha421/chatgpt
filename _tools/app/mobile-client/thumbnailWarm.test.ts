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
  mocks.native.mockImplementation(async (op:string, payload:{assetId:string}) => op==='status'?{battery:{charging:false,level:80,powerSave:false}}:({url:`https://example.invalid/${payload.assetId}`, expires_in:240}));
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
  expect(mocks.native.mock.calls.filter(([op])=>op!=='status').map(([op, payload]) => `${op}:${payload.assetId}`)).toEqual(['thumbnail:a', 'thumbnail:b', 'thumbnail:c']);
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
