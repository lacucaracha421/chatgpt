import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {catalogImageTicket,type CatalogImageRequest} from './catalogMedia';
import {shelfForegroundBusy} from './shelfWarmActivity';
import {resetPerfEnabledForTests} from './perfEnabled';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native}));
const request:CatalogImageRequest={workId:'42',revision:'a'.repeat(64),kind:'cover',index:0,url:'https://ehgt.org/cover.jpg'};
let controllers:AbortController[],replies:PromiseWithResolvers<{url:string}>[];
function load(id:string,visible=()=>true){
  const controller=new AbortController();controllers.push(controller);
  const result=catalogImageTicket({...request,workId:id},controller.signal,visible);
  void result.catch(()=>{});return result;
}
beforeEach(()=>{
  resetPerfEnabledForTests();
  localStorage.clear();controllers=[];replies=[];mocks.native.mockReset();
  mocks.native.mockImplementation(()=>{const reply=Promise.withResolvers<{url:string}>();replies.push(reply);return reply.promise;});
  delete window.LakomicsNative;
});
afterEach(async()=>{for(const controller of controllers)controller.abort();for(const reply of replies)reply.resolve({url:'cached'});await Promise.resolve();delete window.LakomicsNative;vi.restoreAllMocks();});
it('starts six transfers and holds foreground for queued and active covers',async()=>{
  const requests=Array.from({length:9},(_,i)=>load(String(i+1)));
  expect(mocks.native).toHaveBeenCalledTimes(6);expect(shelfForegroundBusy()).toBe(true);
  replies[0].resolve({url:'cached'});await requests[0];expect(mocks.native).toHaveBeenCalledTimes(7);
  for(let i=1;i<9;i++){replies[i].resolve({url:'cached'});await requests[i];}
  expect(shelfForegroundBusy()).toBe(false);
});
it('lets visible covers overtake preloads, including a queued preload promoted by scrolling',async()=>{
  const running=Array.from({length:6},(_,i)=>load(String(i+1)));
  let promoted=false;
  load('7',()=>false);load('8',()=>promoted);load('9',()=>true);
  replies[0].resolve({url:'cached'});await running[0];
  expect(mocks.native.mock.calls[6][1].workId).toBe('9');
  promoted=true;replies[1].resolve({url:'cached'});await running[1];
  expect(mocks.native.mock.calls[7][1].workId).toBe('8');
});
it('removes queued cancellation and releases foreground exactly once on in-flight cancellation',async()=>{
  const running=Array.from({length:6},(_,i)=>load(String(i+1)));
  const queued=load('7');controllers[6].abort();await expect(queued).rejects.toHaveProperty('name','AbortError');
  controllers[0].abort();await expect(running[0]).rejects.toHaveProperty('name','AbortError');
  replies[0].resolve({url:'late'});await Promise.resolve();
  expect(mocks.native).toHaveBeenCalledTimes(6);
  for(let i=1;i<6;i++){replies[i].resolve({url:'cached'});await running[i];}
  expect(shelfForegroundBusy()).toBe(false);
});
it('rejects a pre-aborted request without occupying foreground or a slot',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(catalogImageTicket(request,controller.signal)).rejects.toHaveProperty('name','AbortError');
  expect(mocks.native).not.toHaveBeenCalled();expect(shelfForegroundBusy()).toBe(false);
});
it('passes JS queue time only when the native perf switch is on',async()=>{
  let now=10;vi.spyOn(performance,'now').mockImplementation(()=>now);
  window.LakomicsNative={request:vi.fn(),cancel:vi.fn(),perfEnabled:()=>true};
  const requests=Array.from({length:7},(_,i)=>load(String(i+1)));
  expect(mocks.native.mock.calls[0][1]).toMatchObject({perfId:expect.stringMatching(/^catalog-/),jsQueueMs:expect.any(Number)});
  now=260;replies[0].resolve({url:'cached'});await requests[0];
  expect(mocks.native.mock.calls[6][1].jsQueueMs).toBe(250);
  delete window.LakomicsNative;
  // A disabled bridge represents a new page; the current page keeps its memoized flag.
  resetPerfEnabledForTests();
  replies[1].resolve({url:'cached'});await requests[1];
  load('8');expect(mocks.native.mock.calls[7][1].perfId).toBeUndefined();
});
it('measures the six-slot queue with twelve cold visible covers at fixed fixture latency',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);
  let running=0,peak=0,first:number|null=null,ninety:number|null=null,completed=0;
  mocks.native.mockImplementation(()=>{
    running++;peak=Math.max(peak,running);
    return new Promise(resolve=>setTimeout(()=>{running--;resolve({url:'cached'});},200));
  });
  try{
    const requests=Array.from({length:12},(_,i)=>load(String(i+1)).then(()=>{
      completed++;first??=Date.now();if(completed===11)ninety=Date.now();
    }));
    await vi.advanceTimersByTimeAsync(400);await Promise.all(requests);
    expect({peak,first,ninety,completed}).toEqual({peak:6,first:200,ninety:400,completed:12});
    console.info(`[perf] catalog queue fixture: visible=12 bridgeCalls=${mocks.native.mock.calls.length} peak=${peak} firstCoverMs=${first} visible90Ms=${ninety} (fixed 200ms native replies; not device latency)`);
  }finally{vi.useRealTimers();}
});

it.each(['cover','page'] as const)('blocks a %s request under only the NSFW filter',async kind=>{
  localStorage.setItem('lakomics.mobile.nsfwFilter','1');
  await expect(catalogImageTicket({...request,kind},new AbortController().signal)).rejects.toHaveProperty('name','AbortError');
  expect(mocks.native).not.toHaveBeenCalled();expect(shelfForegroundBusy()).toBe(false);
});
it('does not start queued preloads if the NSFW filter was enabled while waiting',async()=>{
  const running=Array.from({length:6},(_,i)=>load(String(i+1)));
  const queued=load('7',()=>false);
  localStorage.setItem('lakomics.mobile.nsfwFilter','1');
  replies[0].resolve({url:'cached'});await running[0];
  await expect(queued).rejects.toHaveProperty('name','AbortError');
  expect(mocks.native).toHaveBeenCalledTimes(6);
});
