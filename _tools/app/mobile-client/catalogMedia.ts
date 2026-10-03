import {native} from './transport';
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
};
type Queued = {start():void;visible():boolean};
let active=0,sequence=0;
const queue:Queued[]=[];
const MAX_ACTIVE=6;
function drain(){
  while(active<MAX_ACTIVE&&queue.length){
    const visible=queue.findIndex(entry=>entry.visible());
    queue.splice(visible<0?0:visible,1)[0].start();
  }
}

/** Only nearby covers enter this queue; an on-screen cover overtakes queued preloads. */
export function catalogImageTicket(request:CatalogImageRequest,signal:AbortSignal,visible:()=>boolean=()=>true):Promise<Ticket>{
  if(signal.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  const submitted=performance.now(),perfId=`catalog-${Date.now().toString(36)}-${++sequence}`;
  const foregroundDone=request.kind==='cover'?beginShelfForeground():()=>{};
  return new Promise((resolve,reject)=>{
    let started=false,settled=false;
    const finish=()=>{
      if(settled)return false;settled=true;signal.removeEventListener('abort',cancel);
      if(started)active--;
      // Drain before releasing foreground so background warm never sees a gap.
      drain();foregroundDone();return true;
    };
    const cancel=()=>{
      const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);
      if(finish())reject(new DOMException('Cancelled','AbortError'));
    };
    const start=()=>{
      if(signal.aborted){cancel();return;}started=true;active++;
      const timing=request.kind==='cover'&&catalogPerfEnabled()?{perfId,jsQueueMs:performance.now()-submitted}:{};
      void native<Ticket>('catalogImage',{...request,...timing},signal).then(value=>{if(finish())resolve(value);},error=>{if(finish())reject(error);});
    };
    const entry:Queued={start,visible};
    signal.addEventListener('abort',cancel,{once:true});
    queue.push(entry);drain();
  });
}
