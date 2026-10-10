import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {viewerTiming} from './perf';
import {resetPerfEnabledForTests} from './perfEnabled';

beforeEach(resetPerfEnabledForTests);

afterEach(()=>{delete window.LakomicsNative;vi.restoreAllMocks();});

it('sends durations one-way without URLs, duplicate commits or cancellation after commit',async()=>{
  const request=vi.fn();window.LakomicsNative={request,cancel:vi.fn(),perfEnabled:()=>true};
  let now=10;vi.spyOn(performance,'now').mockImplementation(()=>now);
  const span=viewerTiming('asset-1','image',false);
  span.log('open');span.media.source='native';now=30;span.log('native');
  now=40;span.log('decoded');now=45;span.log('commit');span.log('end','canceled');
  expect(request).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(4);
  expect(request.mock.calls.every(([id,op])=>id===''&&op==='perfLog')).toBe(true);
  const payload=JSON.parse(request.mock.calls[3][2]);
  expect(payload).toMatchObject({event:'commit',source:'native',prepared:false,nativeMs:20,decodeMs:30,commitMs:35});
  expect(Object.keys(payload).sort()).toEqual(['event','req','kind','prepared','source','status','elapsedMs','nativeMs','decodeMs','commitMs'].sort());
  expect(JSON.stringify(request.mock.calls)).not.toContain('asset-1');
});

it('ignores missing and throwing bridges',async()=>{
  viewerTiming('a','image',false).log('open');
  await Promise.resolve();
  window.LakomicsNative={request:()=>{throw new Error('unavailable');},cancel:vi.fn()};
  viewerTiming('a','image',false).log('open');
  await Promise.resolve();
});
