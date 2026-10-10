import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {beginScreenTiming,cancelScreenTiming,screenReady,screenTiming,markViewerOpen,takeViewerOpen,viewerTiming} from './perf';
import {resetPerfEnabledForTests} from './perfEnabled';

let request:ReturnType<typeof vi.fn>;
let now=0;
const payloads=()=>request.mock.calls.map(call=>JSON.parse(call[2]));
function root(html=''){
  const host=document.createElement('div');host.innerHTML=html;document.body.append(host);
  const box=()=>({top:0,left:0,right:100,bottom:100,width:100,height:100,x:0,y:0,toJSON(){}});
  host.getBoundingClientRect=box;
  for(const child of host.querySelectorAll('*'))child.getBoundingClientRect=box;
  return host;
}
beforeEach(()=>{
  resetPerfEnabledForTests();
  vi.useFakeTimers();now=10;vi.spyOn(performance,'now').mockImplementation(()=>now);
  request=vi.fn();window.LakomicsNative={request,cancel:vi.fn(),perfEnabled:()=>true};
});
afterEach(()=>{cancelScreenTiming();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();delete window.LakomicsNative;document.body.innerHTML='';});

it('does only the flag check when off, including viewer timestamps',()=>{
  window.LakomicsNative!.perfEnabled=()=>false;
  const observer=vi.spyOn(window,'MutationObserver'),timer=vi.spyOn(window,'setTimeout');
  expect(screenTiming('home','tab')).toBeUndefined();beginScreenTiming('home','tab');
  screenReady('home',root());markViewerOpen();expect(takeViewerOpen()).toBeUndefined();
  viewerTiming('private-id','image',false).log('open');
  expect(performance.now).not.toHaveBeenCalled();expect(observer).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
it('emits a single fixed-name line from the tap through data and existing image settlement',async()=>{
  const host=root('<span data-perf-image-pending="true"></span><img src="https://private/image">');
  const image=host.querySelector('img')!;let complete=false;
  Object.defineProperty(image,'complete',{get:()=>complete});image.decode=vi.fn();
  const span=screenTiming('album','open')!;
  now=40;span.ready(host);expect(request).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  now=80;host.querySelector('span')!.removeAttribute('data-perf-image-pending');await Promise.resolve();
  expect(request).not.toHaveBeenCalled();complete=true;image.dispatchEvent(new Event('load'));
  span.ready(host);span.finish('canceled');image.dispatchEvent(new Event('error'));
  expect(payloads()).toEqual([{event:'screen',screen:'album',trigger:'open',readyMs:30,imagesReadyMs:70,status:'ok'}]);
  expect(image.decode).not.toHaveBeenCalled();expect(image.loading).not.toBe('eager');expect(JSON.stringify(payloads())).not.toContain('private');
});
it('keeps unobserved data/images at -1 on timeout, and removes observers',async()=>{
  const missing=screenTiming('folder','open')!;vi.advanceTimersByTime(15000);missing.finish();
  const host=root('<span data-perf-image-pending="true"></span>'),span=screenTiming('contentSearch','open')!;
  now=50;span.ready(host);vi.advanceTimersByTime(15000);host.replaceChildren();await Promise.resolve();
  expect(payloads()).toEqual([
    {event:'screen',screen:'folder',trigger:'open',readyMs:-1,imagesReadyMs:-1,status:'incomplete'},
    {event:'screen',screen:'contentSearch',trigger:'open',readyMs:40,imagesReadyMs:-1,status:'incomplete'},
  ]);
});
it('cancels superseded interactions and does not accept a different screen ready signal',()=>{
  beginScreenTiming('collections','tab');now=20;beginScreenTiming('notes','tab');
  now=30;screenReady('collections',root());expect(request).toHaveBeenCalledTimes(1);
  now=45;screenReady('notes',root());screenReady('notes',root());vi.advanceTimersByTime(16);
  expect(payloads()).toEqual([
    {event:'screen',screen:'collections',trigger:'tab',readyMs:-1,imagesReadyMs:-1,status:'canceled'},
    {event:'screen',screen:'notes',trigger:'tab',readyMs:25,imagesReadyMs:25,status:'ok'},
  ]);
});
it('records errors separately and immediate retained/empty back entries once',()=>{
  beginScreenTiming('collection.work','open');now=60;screenReady('collection.work',root(),'error');
  beginScreenTiming('home','back');now=70;screenReady('home',root());vi.advanceTimersByTime(16);
  expect(payloads()[0]).toMatchObject({readyMs:50,imagesReadyMs:-1,status:'error'});
  expect(payloads()[1]).toMatchObject({screen:'home',trigger:'back',readyMs:10,imagesReadyMs:10,status:'ok'});
});
it('preserves effect offsets and reports original tap to displayed independently',async()=>{
  markViewerOpen();now=40;const tap=takeViewerOpen();expect(takeViewerOpen()).toBeUndefined();
  const span=viewerTiming('legacy-asset','image',true,tap);now=90;span.log('commit');await Promise.resolve();
  expect(payloads()[0]).toMatchObject({commitMs:50,tapToDisplayedMs:80});
});
it('observes the existing work readiness gate before freezing its first viewport',async()=>{
  const host=root('<article class="tablet-work" aria-busy="true"><img src="https://private/art"></article>');
  Object.defineProperty(host.querySelector('img')!,'complete',{value:true});
  const span=screenTiming('collection.work','open')!;
  now=40;span.ready(host);vi.advanceTimersByTime(16);expect(request).not.toHaveBeenCalled();
  now=90;host.querySelector('article')!.setAttribute('aria-busy','false');await Promise.resolve();
  expect(payloads()).toEqual([{event:'screen',screen:'collection.work',trigger:'open',readyMs:30,imagesReadyMs:80,status:'ok'}]);
});
it('keeps a placeholder replacement in the original cohort and ignores later offscreen images',async()=>{
  const host=root('<span data-perf-image-pending="true"></span>'),span=screenTiming('releaseCalendar','open')!;
  now=30;span.ready(host);vi.advanceTimersByTime(16);
  const image=document.createElement('img');image.src='https://private/cover';let complete=false;
  Object.defineProperty(image,'complete',{get:()=>complete});
  host.firstChild!.replaceWith(image);await Promise.resolve();expect(request).not.toHaveBeenCalled();
  now=60;complete=true;image.dispatchEvent(new Event('load'));
  expect(payloads()).toEqual([{event:'screen',screen:'releaseCalendar',trigger:'open',readyMs:20,imagesReadyMs:50,status:'ok'}]);
});
it('uses StableImage promotion rather than a load event that precedes decode readiness',async()=>{
  const host=root('<img src="https://private/image" data-stable-image-loading="true" data-stable-image-pending="true">');
  const image=host.querySelector('img')!;Object.defineProperty(image,'complete',{value:true});
  const span=screenTiming('assets','tab')!;now=40;span.ready(host);vi.advanceTimersByTime(16);
  image.dispatchEvent(new Event('load'));expect(request).not.toHaveBeenCalled();
  now=90;image.removeAttribute('data-stable-image-loading');image.removeAttribute('data-stable-image-pending');await Promise.resolve();
  expect(payloads()).toEqual([{event:'screen',screen:'assets',trigger:'tab',readyMs:30,imagesReadyMs:80,status:'ok'}]);
});
