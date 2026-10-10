import {viewportImages, viewportImageDecoded} from '../src/shared/motion/viewportImages';
import {perfEnabled as enabled} from './perfEnabled';

type Milestone = 'firstReactRenderMs'|'homeReadyMs'|'viewportImagesReadyMs'|'splashLeavingMs'|'splashEndMs';
type Route = {name:string;firstStartMs:number;firstEndMs:number;lastEndMs:number;issued:number;cancelled:number;reissued:number;pending:number};
let state: {marks:Partial<Record<Milestone,number>>;routes:Map<string,Route>;cancelledKeys:Set<string>;done:boolean}|undefined;
const send=(payload:unknown)=>{try{window.LakomicsNative?.request('','perfLog',JSON.stringify(payload));}catch{/* Measurement cannot fail startup. */}};

/** Fixed route vocabulary. Queries are never logged; only the Collection type enum is classified. */
export function startupRoute(operation:string, payload:Record<string,unknown>) {
  if(operation!=='api')return /^(status|notesState|notesSync|syncSignals|albumTree|albumStatus|pickerStatus|exchangeState|exchangeDevices|cacheStatus|thumbnail|media|homeCover|collectionArtwork|catalogImage|mediaTickets|thumbnailsCached|collectionArtworksCached)$/.test(operation)?operation:'other';
  const path=typeof payload.path==='string'?payload.path:'';
  const [plain,query]=path.split('?',2);
  const params=new URLSearchParams(query);
  if(plain==='/v1/library/assets')return params.get('subtree')==='1'?'library.assets.subtree':(params.has('tag')||params.has('artist'))?'library.assets.search':'library.assets';
  if(/^\/v1\/(library\/search\/description|albums\/(commands|baseline|changes)|classifications\/authority\/(commands|baseline|changes)|home\/upcoming\/wishlist|collections\/bindings\/(status|requests|search\/(kakao|mangadex)))$/.test(plain))return plain.slice(4).replace(/\//g,'.');
  if(/^\/v1\/collections\/bindings\/requests\/[^/]+(?:\/cancel)?$/.test(plain))return 'collections.bindings.requests';
  if(plain==='/v1/collections') {
    const type=new URLSearchParams(query).get('type');
    return type==='manga'||type==='game'||type==='movie'?`collections.${type}`:'collections';
  }
  if(/^\/v1\/(library\/(assets|summary|classifications|characters|characters\/status|characters\/review|similarity\/review|revisit|list-generation|media-tickets)|captures\/pending|home\/(upcoming|av-pick)|collections\/(status|releases|releases\/counts)|mobile-catalog\/(status|refresh|count|duplicates)|albums\/(likes|assets)|sync\/status)$/.test(plain))return plain.slice(4).replace(/\//g,'.');
  if(plain.startsWith('/v1/notes/'))return 'notes';
  if(plain.startsWith('/v1/collections/'))return 'collections.detail';
  if(plain.startsWith('/v1/home/covers/'))return 'home.coverTicket';
  if(plain.startsWith('/v1/library/assets/'))return 'library.assetTicket';
  return 'other';
}
export function startupMark(name:Milestone) {
  if(!enabled()||state?.done)return;
  state??={marks:{},routes:new Map(),cancelledKeys:new Set(),done:false};
  state.marks[name]??=performance.now();
}
export function startupRequest(operation:string,payload:Record<string,unknown>) {
  if(!enabled()||state?.done)return;
  state??={marks:{},routes:new Map(),cancelledKeys:new Set(),done:false};
  const session=state,name=startupRoute(operation,payload),startMs=performance.now();
  const route=session.routes.get(name)??{name,firstStartMs:startMs,firstEndMs:-1,lastEndMs:-1,issued:0,cancelled:0,reissued:0,pending:0};
  session.routes.set(name,route);route.issued++;route.pending++;
  // An exact canceled read issued again is a reissue. A new pagination cursor is a new read.
  // The key stays in memory only and is discarded when the splash ends.
  const key=JSON.stringify([operation,payload.path,payload.assetId,payload.collectionId,payload.artworkId,payload.workId,payload.sha256,payload.revision,payload.kind,payload.variant,payload.index]);
  if(session.cancelledKeys.delete(key))route.reissued++;
  const first=route.issued===1;
  let done=false;
  return (status:'ok'|'error'|'canceled')=>{
    if(done||!enabled())return;done=true;
    const endMs=performance.now();route.pending--;route.lastEndMs=endMs;
    if(first)route.firstEndMs=endMs;
    if(status==='canceled'){route.cancelled++;if(!session.done)session.cancelledKeys.add(key);}
    send({event:'startup_request',name,startMs,endMs,status});
  };
}
export function finishStartupTiming() {
  if(!enabled()||state?.done)return;
  startupMark('splashEndMs');const session=state!;session.done=true;
  send({event:'startup',...session.marks,requests:[...session.routes.values()]});
  session.cancelledKeys.clear();
}

/** Observe the shared splash's existing DOM transitions; never release it or schedule work. */
export function observeStartupSplash() {
  if(!enabled())return;
  let seen=false;
  const check=()=>{
    const splash=document.querySelector('.launch-splash');
    if(splash)seen=true;
    if(splash?.getAttribute('data-state')==='leaving') {
      startupMark('splashLeavingMs');
      const home=document.querySelector<HTMLElement>('.home-tablet-layout');
      if(home&&viewportImages(home).every(image=>viewportImageDecoded(image)||image.complete))startupMark('viewportImagesReadyMs');
    }
    if(seen&&!splash){observer.disconnect();finishStartupTiming();}
  };
  const observer=new MutationObserver(check);
  observer.observe(document.getElementById('root')!,{subtree:true,childList:true,attributes:true,attributeFilter:['data-state']});
  check();
}
export function resetStartupTimingForTests(){state=undefined;}
