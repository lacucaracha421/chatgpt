import './transport';
import {catalogPerfEnabled} from './catalogPerf';
import {viewportImages,viewportImageDecoded} from '../src/shared/motion/viewportImages';
import {viewReady} from '../src/shared/motion/AreaSwitch';

export type PerfScreen='home'|'assets'|'collections'|'catalog'|'notes'|'more'|'collection.work'|'album'|'folder'|'releaseCalendar'|'contentSearch'|'catalog.reader';
export type PerfTrigger='tab'|'open'|'back';
let screen:ReturnType<typeof screenTiming>|undefined;
let viewerTap:number|undefined;
export function markViewerOpen(){if(catalogPerfEnabled())viewerTap=performance.now();}
export function takeViewerOpen(){if(!catalogPerfEnabled())return;const tap=viewerTap;viewerTap=undefined;return tap;}

/** One passive span per action. It observes existing DOM readiness; never decodes or promotes images. */
export function screenTiming(name:PerfScreen,trigger:PerfTrigger){
  if(!catalogPerfEnabled())return;
  const start=performance.now();let readyMs=-1,imagesReadyMs=-1,done=false;
  let stop:()=>void=()=>{};
  const finish=(status:'ok'|'incomplete'|'error'|'canceled'='incomplete')=>{
    if(done)return;done=true;stop();window.clearTimeout(timer);
    if(!catalogPerfEnabled())return;
    try{window.LakomicsNative?.request('','perfLog',JSON.stringify({event:'screen',screen:name,trigger,readyMs,imagesReadyMs,status}));}catch{/* Best effort. */}
  };
  // A timeout records missing observations, not a new readiness deadline for the screen.
  const timer=window.setTimeout(()=>finish(),15000);
  const ready=(root:HTMLElement,status:'ok'|'error'='ok')=>{
    if(done||readyMs>=0||!catalogPerfEnabled())return;
    readyMs=performance.now()-start;
    if(status==='error'){finish('error');return;}
    const visible=(element:Element)=>{
      const r=element.getBoundingClientRect(),b=root.getBoundingClientRect();
      const clip=element.closest('.asset-gallery__scroll, .gallery-scroll')?.getBoundingClientRect()??b;
      return r.width>0&&r.height>0&&r.bottom>Math.max(0,b.top,clip.top)&&r.top<Math.min(window.innerHeight,b.bottom,clip.bottom)&&r.right>Math.max(0,b.left,clip.left)&&r.left<Math.min(window.innerWidth,b.right,clip.right);
    };
    // Freeze the first viewport's hosts, including bridge placeholders before they have an <img>.
    let targets:{element:HTMLElement;parent:HTMLElement|null}[]|undefined,sampled=false;
    const check=()=>{
      if(done||!sampled||!catalogPerfEnabled()||!viewReady(root))return;
      if(name==='collection.work'&&!root.querySelector('.tablet-work'))return;
      targets??=[...viewportImages(root),...Array.from(root.querySelectorAll<HTMLElement>('[data-perf-image-pending="true"], .collection-light-case[data-ready="false"]')).filter(visible)].map(element=>({element,parent:element.parentElement}));
      const settled=(image:HTMLImageElement)=>!image.dataset.stableImagePending&&(!!image.dataset.stableImageLoading||viewportImageDecoded(image)||image.complete);
      if(targets.every(({element,parent})=>{
        // A placeholder may be replaced by StableImage's <img>; retain its original slot's parent.
        const target=element.isConnected?element:parent?.isConnected?parent:null;
        return target&&target.dataset.perfImagePending!=='true'&&target.dataset.ready!=='false'&&!target.querySelector('[data-perf-image-pending="true"], .collection-light-case[data-ready="false"]')&&(target instanceof HTMLImageElement?settled(target):Array.from(target.querySelectorAll('img')).every(settled));
      })){
        imagesReadyMs=performance.now()-start;finish('ok');
      }
    };
    const observer=new MutationObserver(check);
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['src','srcset','data-perf-image-pending','data-catalog-decoded','data-stable-image-loading','data-stable-image-pending','data-ready','aria-busy','class','style']});
    root.addEventListener('load',check,true);root.addEventListener('error',check,true);
    // Observe after the existing layout effects/virtualizer have one rendering opportunity.
    const frame=window.requestAnimationFrame(()=>{sampled=true;check();});
    stop=()=>{window.cancelAnimationFrame(frame);observer.disconnect();root.removeEventListener('load',check,true);root.removeEventListener('error',check,true);};
  };
  return {name,ready,finish};
}
export function beginScreenTiming(name:PerfScreen,trigger:PerfTrigger){
  if(!catalogPerfEnabled())return;
  screen?.finish('canceled');screen=screenTiming(name,trigger);
}
export function screenReady(name:PerfScreen,root:HTMLElement|null,status:'ok'|'error'='ok'){
  if(!catalogPerfEnabled()||!root||screen?.name!==name)return;
  screen.ready(root,status);
}
export function cancelScreenTiming(){if(!catalogPerfEnabled())return;screen?.finish('canceled');screen=undefined;}

export type MediaTiming = {requestId:string; source:'unknown'|'prepared'|'memory'|'shared'|'native'|'pending'};
type Event = 'open'|'native'|'decoded'|'commit'|'end'|'prefetch_start'|'prefetch_finish';
// Distinguish WebView sessions without persisting anything or using asset metadata.
const session = Date.now().toString(36);
let sequence = 0;

export function viewerTiming(_id:string, kind:string|undefined, prepared:boolean, tapMs?:number) {
  if(!catalogPerfEnabled())return {media:{requestId:'',source:prepared?'prepared':'unknown'} as MediaTiming,log:()=>{},get done(){return true;}};
  const start = performance.now();
  const media:MediaTiming = {requestId:`${session}-${++sequence}`, source:prepared?'prepared':'unknown'};
  let nativeMs:number|undefined, decodeMs:number|undefined, done=false;
  const log = (event:Event, status:'ok'|'error'|'canceled'='ok') => {
    if(done||!catalogPerfEnabled())return;
    const elapsedMs = performance.now()-start;
    if(event==='native')nativeMs=elapsedMs;
    if(event==='decoded')decodeMs=elapsedMs;
    if(event==='commit'||event==='end'||event==='prefetch_finish')done=true;
    const payload={event,req:media.requestId,kind:kind==='image'||kind==='video'?kind:'other',prepared,source:media.source,status,elapsedMs,nativeMs,decodeMs,...(event==='commit'?{commitMs:elapsedMs,...(tapMs===undefined?{}:{tapToDisplayedMs:performance.now()-tapMs})}:{})};
    // No native() promise, timer or reply. Logging cannot reject a load.
    try{queueMicrotask(()=>{try{window.LakomicsNative?.request('', 'perfLog', JSON.stringify(payload));}catch{/* Best effort. */}});}catch{/* Best effort. */}
  };
  return {media,log,get done(){return done;}};
}

/** Element states, plus `retry`: the viewer renewed a library video that made no progress. */
type VideoEvent = 'loadstart'|'loadedmetadata'|'canplay'|'playing'|'waiting'|'stalled'|'suspend'|'abort'|'emptied'|'error'|'retry';
/**
 * One line per media-element state change of a library video: the event, the element's
 * network/ready state and, on error, the MediaError code and Chromium's leading error name.
 * Never the URL or any other text from the page.
 */
export function videoEvent(_id:string, event:VideoEvent, element:HTMLVideoElement) {
  if(!catalogPerfEnabled())return;
  const error = element.error;
  const payload = {event:'video', media:event, network:element.networkState, ready:element.readyState,
    ...(error ? {code:error.code, name:/^[A-Z][A-Z0-9_]+/.exec(error.message ?? '')?.[0] ?? ''} : {})};
  try{queueMicrotask(()=>{try{window.LakomicsNative?.request('', 'perfLog', JSON.stringify(payload));}catch{/* Best effort. */}});}catch{/* Best effort. */}
}
