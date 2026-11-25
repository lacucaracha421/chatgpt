import {native} from './transport';
import {tabletCatalogMasked} from './catalogMask';
import {beginShelfForeground} from './shelfWarmActivity';
import {catalogPerfEnabled} from './catalogPerf';
import type {Ticket} from './types';

export type CatalogImageKind = 'cover'|'page';
export type CatalogImageRequest = {
  workId:string;
  revision:string;
  kind:CatalogImageKind;
  index:number;
  url:string;
  source?:'kHentai'|'somi';
};
type Queued = {start():void;visible():boolean;kind:CatalogImageKind;index:number};
let active=0,activeVisiblePages=0,lastTargetPage=0,sequence=0,microScheduled=false;
const queue:Queued[]=[];
const MAX_ACTIVE=6;
function drain(){
  while(active<MAX_ACTIVE&&queue.length){
    const visiblePage=queue.findIndex(entry=>entry.kind==='page'&&entry.visible());
    if(visiblePage>=0){
      lastTargetPage=queue[visiblePage].index;
      queue.splice(visiblePage,1)[0].start();
      continue;
    }
    const visibleCover=queue.findIndex(entry=>entry.kind==='cover'&&entry.visible());
    if(visibleCover>=0){
      queue.splice(visibleCover,1)[0].start();
      continue;
    }
    const nextIndex=queue.findIndex(entry=>entry.kind!=='page'||activeVisiblePages===0);
    if(nextIndex<0)break;
    if(queue[nextIndex].kind==='page'){
      const forward=queue.findIndex(entry=>entry.kind==='page'&&activeVisiblePages===0&&entry.index>lastTargetPage);
      queue.splice(forward<0?nextIndex:forward,1)[0].start();
    }else{
      queue.splice(nextIndex,1)[0].start();
    }
  }
}

/** Only nearby covers enter this queue; an on-screen cover overtakes queued preloads. */
export const catalogImageTicket:((request:CatalogImageRequest,signal:AbortSignal,visible?:()=>boolean)=>Promise<Ticket>)&{drain?:()=>void}=function catalogImageTicket(request:CatalogImageRequest,signal:AbortSignal,visible:()=>boolean=()=>true):Promise<Ticket>{
  if(signal.aborted||tabletCatalogMasked())return Promise.reject(new DOMException('Cancelled','AbortError'));
  if(request.kind==='cover'&&request.url.startsWith('https://app.lakomics.local/media-cache/'))return Promise.resolve({url:request.url,expires_in:240} as Ticket);
  const submitted=performance.now(),perfId=`catalog-${Date.now().toString(36)}-${++sequence}`;
  const foregroundDone=request.kind==='cover'?beginShelfForeground():()=>{};
  return new Promise((resolve,reject)=>{
    let started=false,startedVisiblePage=false,settled=false;
    const finish=()=>{
      if(settled)return false;settled=true;signal.removeEventListener('abort',cancel);
      if(started){active--;if(startedVisiblePage)activeVisiblePages--;}
      // Drain before releasing foreground so background warm never sees a gap.
      drain();foregroundDone();return true;
    };
    const cancel=()=>{
      const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);
      if(finish())reject(new DOMException('Cancelled','AbortError'));
    };
    const start=()=>{
      if(signal.aborted||tabletCatalogMasked()){cancel();return;}
      started=true;active++;
      if(request.kind==='page'&&visible()){startedVisiblePage=true;activeVisiblePages++;lastTargetPage=request.index;}
      const timing=request.kind==='cover'&&catalogPerfEnabled()?{perfId,jsQueueMs:performance.now()-submitted}:{};
      const job=request.source==='somi'?native<Ticket>('somiImage',{id:request.workId,kind:request.kind,index:request.index,...timing},signal,70_000):native<Ticket>('catalogImage',{...request,...timing},signal);
      void job.then(value=>{if(finish())resolve(value);},error=>{if(finish())reject(error);});
    };
    const entry:Queued={start,visible,kind:request.kind,index:request.index};
    signal.addEventListener('abort',cancel,{once:true});
    queue.push(entry);
    if(request.kind==='page'&&!visible()){
      if(!microScheduled){microScheduled=true;queueMicrotask(()=>{microScheduled=false;drain();});}
    }else drain();
  });
};
catalogImageTicket.drain=drain;
