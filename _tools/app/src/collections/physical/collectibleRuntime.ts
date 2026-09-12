import { drawGameCase } from "../drawGameCase";
import { PaperbackEngine, PAPERBACK_FINAL, type BookTexture } from "./PaperbackEngine";
import { RenderCache, type RenderResult, type Snapshot } from "./RenderCache";
import { loadCoverImage } from "./loadCoverImage";
export type CoverRequest = { kind:"book"|"game"; src:string; scope:string; revision:string; pixels:number };
const cache=new RenderCache();
let engine:PaperbackEngine|null=null, bookCanvas:HTMLCanvasElement|null=null, gameCanvas:HTMLCanvasElement|null=null;
let contextLost=false, unavailable=false, liveOwner:symbol|null=null, wakeLive:(()=>void)|null=null;
let visibilityInstalled=false;
function ensureEngine() {
  if(contextLost||unavailable) throw new Error("Book renderer unavailable");
  if(engine&&!engine.disposed) return engine;
  if(!bookCanvas) {
    bookCanvas=document.createElement("canvas"); bookCanvas.setAttribute("aria-hidden","true");
    bookCanvas.addEventListener("webglcontextlost",event=>{ event.preventDefault(); contextLost=true; cache.pause(true); wakeLive?.(); });
    bookCanvas.addEventListener("webglcontextrestored",()=>{ engine?.dispose(); engine=null; contextLost=false; unavailable=false; cache.pause(liveOwner!==null||document.hidden); wakeLive?.(); });
  }
  try { engine=new PaperbackEngine(bookCanvas); return engine; } catch(error) { unavailable=true; throw error; }
}
function visibilityChanged() { cache.pause(document.hidden||liveOwner!==null||contextLost); wakeLive?.(); }
function watchVisibility() {
  if(visibilityInstalled||typeof document==="undefined") return; visibilityInstalled=true;
  document.addEventListener("visibilitychange",visibilityChanged);
}
function snapshot(canvas:HTMLCanvasElement, width=canvas.width, height=canvas.height):Promise<RenderResult> {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve({blob,width,height}):reject(new Error("Snapshot unavailable")),"image/png"));
}
export function coverKey(request:CoverRequest) { return JSON.stringify([request.kind==="game"?"collectible-game-fit-v3":"collectible-final-v1",request.kind,request.scope,request.src,request.revision,request.pixels]); }
function sourceUrl(request:Pick<CoverRequest,"src"|"revision"|"scope">) {
  if((!request.revision&&!request.scope)||request.src.startsWith("data:")||request.src.startsWith("blob:")) return request.src;
  const scopeTag=[...request.scope].reduce((hash,char)=>Math.imul(hash^char.charCodeAt(0),16777619)>>>0,2166136261).toString(16);
  return `${request.src}${request.src.includes("?")?"&":"?"}v=${encodeURIComponent(request.revision)}&scope=${scopeTag}`;
}
async function bake(request:CoverRequest, signal:AbortSignal):Promise<RenderResult> {
  if(signal.aborted) throw new DOMException("Cancelled","AbortError");
  if(request.kind==="book") {
    const renderer=ensureEngine(), width=request.pixels, height=Math.round(width*368/256);
    const texture=await renderer.texture(coverKey(request),sourceUrl(request),512,signal);
    if(signal.aborted) throw new DOMException("Cancelled","AbortError");
    renderer.draw(texture,{width,height,rx:PAPERBACK_FINAL.rx,ry:PAPERBACK_FINAL.bakeRy,rz:0,zoom:Math.min(1.13,width/height*1.8/texture.ratio),bake:true});
    return snapshot(renderer.canvas);
  }
  if(typeof CanvasRenderingContext2D==="undefined") throw new Error("Canvas unavailable");
  const image=request.src?await loadCoverImage(sourceUrl(request),signal):null;
  const output=document.createElement("canvas");
  try {
    if(signal.aborted) throw new DOMException("Cancelled","AbortError");
    gameCanvas??=document.createElement("canvas");
    // Preserve the approved projection and its 2x sampling; cache the final raster.
    if(!drawGameCase(gameCanvas,image,request.pixels/(window.devicePixelRatio||1))) throw new Error("Case renderer unavailable");
    output.width=request.pixels; output.height=Math.ceil(request.pixels*260/184);
    const ctx=output.getContext("2d"); if(!ctx) throw new Error("Canvas unavailable");
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high"; ctx.drawImage(gameCanvas,0,0,output.width,output.height);
    return await snapshot(output);
  } finally { if(image) image.src=""; output.width=output.height=0; if(gameCanvas) gameCanvas.width=gameCanvas.height=2; }
}
export function acquireCover(request:CoverRequest, listener:(value:Snapshot)=>void) {
  watchVisibility(); cache.pause(document.hidden||liveOwner!==null||contextLost);
  return cache.acquire(coverKey(request),signal=>bake(request,signal),listener);
}
export function collectibleStats() {
  return { cache:cache.stats(), book:engine?.stats()??null, liveModels:liveOwner?1:0, gameContexts:gameCanvas?1:0, contextLost };
}
export type LiveBook = { tilt(x:number,y:number):void; refresh():void; dispose():void };
let releaseLive:(()=>void)|null=null;
export function attachLiveBook(host:HTMLElement, request:CoverRequest, onReady:(ready:boolean)=>void):LiveBook {
  releaseLive?.(); watchVisibility();
  const owner=Symbol("live-book"); liveOwner=owner; cache.pause(true);
  const abort=new AbortController();
  let disposed=false, texture:BookTexture|null=null, renderer:PaperbackEngine|null=null;
  let timer:ReturnType<typeof setTimeout>|null=null, raf=0, busy=false, dirty=false,last=0,x=0,y=0;
  const current=()=>!disposed&&liveOwner===owner&&!abort.signal.aborted;
  const cancelFrame=()=>{if(timer!==null) clearTimeout(timer); timer=null; if(raf) cancelAnimationFrame(raf); raf=0;};
  function refresh() {
    if(!current()) return;
    if(contextLost) { texture=null; renderer=null; onReady(false); cancelFrame(); return; }
    if(document.hidden) {cancelFrame(); return;}
    dirty=true;
    if(busy||timer!==null||raf) return;
    timer=setTimeout(()=>{timer=null;raf=requestAnimationFrame(()=>{raf=0;void draw();});},Math.max(0,1000/30-(performance.now()-last)));
  }
  async function draw() {
    if(!current()||document.hidden||contextLost) return;
    busy=true; dirty=false;
    try {
      await cache.whenIdle(); if(!current()) return;
      const active=ensureEngine();
      if(renderer!==active) {renderer=active; texture=null;}
      texture??=await active.texture(coverKey(request),sourceUrl(request),1024,abort.signal);
      if(!current()||document.hidden||contextLost) return;
      const rect=host.getBoundingClientRect(); if(rect.width<1||rect.height<1) return;
      const cssWidth=Math.min(rect.width,rect.height*1.45),cssHeight=rect.height;
      let scale=Math.min(window.devicePixelRatio||1,1.5,1300/Math.max(cssWidth,cssHeight));
      scale=Math.min(scale,Math.sqrt(1_400_000/(cssWidth*cssHeight)));
      const width=Math.max(1,Math.round(cssWidth*scale)),height=Math.max(1,Math.round(cssHeight*scale));
      if(active.canvas.parentElement!==host) host.append(active.canvas);
      active.canvas.style.width=`${cssWidth}px`; active.canvas.style.height=`${cssHeight}px`;
      active.draw(texture,{width,height,rx:PAPERBACK_FINAL.rx-y*.12,ry:PAPERBACK_FINAL.ry+x*.18,rz:PAPERBACK_FINAL.rz,zoom:Math.min(1.08,width/height*1.8/texture.ratio)});
      last=performance.now(); onReady(true);
    } catch { if(current()) onReady(false); }
    finally { busy=false; if(dirty&&current()) refresh(); }
  }
  const resize=typeof ResizeObserver==="undefined"?null:new ResizeObserver(refresh); resize?.observe(host);
  window.addEventListener("resize",refresh); wakeLive=refresh;
  function dispose() {
    if(disposed) return; disposed=true; abort.abort(); cancelFrame(); resize?.disconnect(); window.removeEventListener("resize",refresh);
    if(bookCanvas?.parentElement===host) bookCanvas.remove();
    if(liveOwner===owner) {liveOwner=null;wakeLive=null;releaseLive=null;engine?.shrink();cache.pause(document.hidden||contextLost);}
  }
  releaseLive=dispose; refresh();
  return {tilt:(nextX,nextY)=>{x=nextX;y=nextY;refresh();},refresh,dispose};
}
// Development/test observation only; no polling, telemetry upload or persistent state.
export function clearCollectibleCache() { cache.clear(); engine?.clearTextures(); }
export function attachLiveCase(host:HTMLElement, request:{src:string;scope:string;revision:string;pose:"front"|"spine"|"back"}, onReady:(ready:boolean)=>void) {
  releaseLive?.();watchVisibility();
  const owner=Symbol("live-case");liveOwner=owner;cache.pause(true);
  const abort=new AbortController(),canvas=document.createElement("canvas");
  let disposed=false,frame=0,source:HTMLImageElement|null=null;
  const current=()=>!disposed&&liveOwner===owner&&!abort.signal.aborted;
  function draw() {
    frame=0;if(!current()||document.hidden||!source)return;
    const rect=host.getBoundingClientRect();
    if(rect.width<1||rect.height<1)return;
    const cssWidth=Math.min(rect.width,rect.height*184/260);
    const pixelWidth=Math.min(900,cssWidth*Math.min(window.devicePixelRatio||1,1.5));
    try {
      if(!drawGameCase(canvas,source,pixelWidth/((window.devicePixelRatio||1)*2),request.pose))throw new Error("Canvas unavailable");
      canvas.style.width=`${cssWidth}px`;canvas.style.height=`${cssWidth*260/184}px`;
      if(canvas.parentElement!==host)host.append(canvas);
      onReady(true);
    } catch {onReady(false);}
  }
  function refresh() {if(!current())return;if(frame)cancelAnimationFrame(frame);frame=0;if(!document.hidden)frame=requestAnimationFrame(draw);}
  const resize=typeof ResizeObserver==="undefined"?null:new ResizeObserver(refresh);resize?.observe(host);
  window.addEventListener("resize",refresh);wakeLive=refresh;
  // Bounded native thumbnails are sufficient for the snap overview. Original mode
  // explicitly loads the full surface; no full-resolution image cache is retained.
  void loadCoverImage(sourceUrl(request),abort.signal).then(image=>{if(!current()){image.src="";return;}source=image;refresh();},()=>{if(current())onReady(false);});
  function dispose() {
    if(disposed)return;disposed=true;abort.abort();if(frame)cancelAnimationFrame(frame);resize?.disconnect();window.removeEventListener("resize",refresh);
    if(source)source.src="";source=null;canvas.remove();canvas.width=canvas.height=2;
    if(liveOwner===owner){liveOwner=null;wakeLive=null;releaseLive=null;cache.pause(document.hidden||contextLost);}
  }
  releaseLive=dispose;return {dispose};
}
if(import.meta.hot) import.meta.hot.dispose(()=>{releaseLive?.();cache.clear();engine?.dispose();document.removeEventListener("visibilitychange",visibilityChanged);});
