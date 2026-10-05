import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {finishStartupTiming,observeStartupSplash,resetStartupTimingForTests,startupMark,startupRequest,startupRoute} from './startupPerf';
import {native} from './transport';

let now:number,request:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  now=20;vi.spyOn(performance,'now').mockImplementation(()=>now);
  request=vi.fn();window.LakomicsNative={request,cancel:vi.fn(),perfEnabled:()=>true};
  resetStartupTimingForTests();
});
afterEach(()=>{delete window.LakomicsNative;document.body.innerHTML='';vi.restoreAllMocks();});
it('does no timing, observation or logging when disabled',()=>{
  window.LakomicsNative!.perfEnabled=()=>false;
  const observer=vi.spyOn(window,'MutationObserver');
  startupMark('firstReactRenderMs');expect(startupRequest('api',{path:'/v1/library/assets'})).toBeUndefined();
  observeStartupSplash();finishStartupTiming();
  expect(observer).not.toHaveBeenCalled();expect(performance.now).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
it('emits one summary with navigation offsets, cancellations, exact reissues and page counts',()=>{
  startupMark('firstReactRenderMs');
  const path='/v1/collections?type=manga&limit=48&cursor=secret';
  const cancel=startupRequest('api',{path});now=50;cancel?.('canceled');cancel?.('ok');
  now=60;const retry=startupRequest('api',{path});now=80;retry?.('ok');
  now=90;startupRequest('api',{path:'/v1/collections?type=manga&limit=48&cursor=another-secret'});
  startupMark('homeReadyMs');now=110;startupMark('viewportImagesReadyMs');
  now=120;finishStartupTiming();finishStartupTiming();
  const payloads=request.mock.calls.map(call=>JSON.parse(call[2]));
  expect(payloads.filter(p=>p.event==='startup')).toEqual([expect.objectContaining({
    firstReactRenderMs:20,homeReadyMs:90,viewportImagesReadyMs:110,splashEndMs:120,
    requests:[{name:'collections.manga',firstStartMs:20,firstEndMs:50,lastEndMs:80,issued:3,cancelled:1,reissued:1,pending:1}],
  })]);
  expect(JSON.stringify(payloads)).not.toContain('secret');
  expect(startupRequest('notesState',{})).toBeUndefined();
});
it('observes the existing splash leaving and removal without ending it',async()=>{
  document.body.innerHTML='<div id="root"><div class="launch-splash"></div><div class="home-tablet-layout"></div></div>';
  observeStartupSplash();
  const splash=document.querySelector('.launch-splash')!;
  now=100;splash.setAttribute('data-state','leaving');await Promise.resolve();
  expect(splash.isConnected).toBe(true);expect(request).not.toHaveBeenCalled();
  now=340;splash.remove();await Promise.resolve();
  expect(JSON.parse(request.mock.calls[0][2])).toMatchObject({event:'startup',splashLeavingMs:100,viewportImagesReadyMs:100,splashEndMs:340});
});
it('never logs dynamic route segments, query strings or arbitrary operation names',()=>{
  expect(startupRoute('api',{path:'/v1/library/assets?token=secret'})).toBe('library.assets');
  expect(startupRoute('api',{path:'/v1/home/covers/private-name/media-ticket?token=secret'})).toBe('home.coverTicket');
  expect(startupRoute('api',{path:'/v1/collections/private-title?token=secret'})).toBe('collections.detail');
  expect(startupRoute('api',{path:'/v1/collections?type=private-title'})).toBe('collections');
  expect(startupRoute('private-title',{})).toBe('other');
});
it('keeps pending finishes visible after the summary and does not confuse different media reads',()=>{
  const first=startupRequest('thumbnail',{assetId:'private-first',revision:'r1'});
  now=30;first?.('canceled');
  const second=startupRequest('thumbnail',{assetId:'private-second',revision:'r1'});
  now=40;finishStartupTiming();now=80;second?.('ok');
  const payloads=request.mock.calls.map(call=>JSON.parse(call[2]));
  expect(payloads.find(p=>p.event==='startup').requests).toEqual([expect.objectContaining({issued:2,cancelled:1,reissued:0,pending:1})]);
  expect(payloads.at(-1)).toMatchObject({event:'startup_request',name:'thumbnail',startMs:30,endMs:80,status:'ok'});
  expect(JSON.stringify(payloads)).not.toContain('private-');
});
it('counts actual bridge cancellation and reissue without changing its replies',async()=>{
  const controller=new AbortController(),payload={path:'/v1/library/assets?limit=48'};
  const first=native('api',payload,controller.signal);controller.abort();
  await expect(first).rejects.toMatchObject({name:'AbortError'});
  now=40;const second=native('api',payload);
  const id=request.mock.calls.filter(call=>call[1]==='api').at(-1)![0];
  now=60;window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id,ok:true,data:{items:[]}}}));
  await expect(second).resolves.toEqual({items:[]});finishStartupTiming();
  const summary=request.mock.calls.map(call=>JSON.parse(call[2])).find(p=>p.event==='startup');
  expect(summary.requests).toEqual([expect.objectContaining({name:'library.assets',issued:2,cancelled:1,reissued:1,pending:0})]);
});
