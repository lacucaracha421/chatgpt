import './transport';

export type MediaTiming = {requestId:string; source:'unknown'|'prepared'|'memory'|'shared'|'native'|'pending'};
type Event = 'open'|'native'|'decoded'|'commit'|'end'|'prefetch_start'|'prefetch_finish';
// Distinguish WebView sessions without persisting anything or using asset metadata.
const session = Date.now().toString(36);
let sequence = 0;

export function viewerTiming(id:string, kind:string|undefined, prepared:boolean) {
  const start = performance.now();
  const media:MediaTiming = {requestId:`${session}-${++sequence}`, source:prepared?'prepared':'unknown'};
  let nativeMs:number|undefined, decodeMs:number|undefined, done=false;
  const log = (event:Event, status:'ok'|'error'|'canceled'='ok') => {
    if(done)return;
    const elapsedMs = performance.now()-start;
    if(event==='native')nativeMs=elapsedMs;
    if(event==='decoded')decodeMs=elapsedMs;
    if(event==='commit'||event==='end'||event==='prefetch_finish')done=true;
    const payload={event,id,req:media.requestId,kind:kind==='image'||kind==='video'?kind:'other',prepared,source:media.source,status,elapsedMs,nativeMs,decodeMs,...(event==='commit'?{commitMs:elapsedMs}:{})};
    // No native() promise, timer, reply or worker slot. Logging cannot reject a load.
    try{queueMicrotask(()=>{try{window.LakomicsNative?.request('', 'perfLog', JSON.stringify(payload));}catch{/* Best effort. */}});}catch{/* Best effort. */}
  };
  return {media,log,get done(){return done;}};
}

type VideoEvent = 'loadstart'|'loadedmetadata'|'canplay'|'playing'|'waiting'|'stalled'|'suspend'|'abort'|'emptied'|'error';
/**
 * One line per media-element state change of a library video: the event, the element's
 * network/ready state and, on error, the MediaError code and Chromium's leading error name.
 * Never the URL or any other text from the page.
 */
export function videoEvent(id:string, event:VideoEvent, element:HTMLVideoElement) {
  const error = element.error;
  const payload = {event:'video', id, media:event, network:element.networkState, ready:element.readyState,
    ...(error ? {code:error.code, name:/^[A-Z][A-Z0-9_]+/.exec(error.message ?? '')?.[0] ?? ''} : {})};
  try{queueMicrotask(()=>{try{window.LakomicsNative?.request('', 'perfLog', JSON.stringify(payload));}catch{/* Best effort. */}});}catch{/* Best effort. */}
}
