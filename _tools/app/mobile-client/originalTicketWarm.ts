import {onVisible} from './useVisibleInterval';
import {native} from './transport';
import {onPowerChange} from './deviceSignals';
import {meteredConnection,warmConnection as connection} from './warmNetwork';
import type {Asset} from './types';

// Visibility subscriptions contain no URLs. Native owns capabilities and expiry;
// this bounded mirror only suppresses redundant bridge requests while they are valid.
const visible=new Map<string,Set<symbol>>();
const ready=new Map<string,number>();
// Ids native declined because the battery does not allow warming. They wait for native
// `lakomics-power` (charger connected); the long delay only covers a missed event.
const powerWait=new Set<string>();
const POWER_FALLBACK=30*60_000;
let removePower:(()=>void)|undefined;
const powerChanged=()=>{for(const id of powerWait)ready.delete(id);powerWait.clear();schedule();};
let timer:ReturnType<typeof setTimeout>|undefined;
let active:AbortController|undefined;
let generation=0;
let removeVisible:(()=>void)|undefined;
const hide=()=>{if(document.visibilityState==='hidden')schedule();};
const allowed=()=>document.visibilityState!=='hidden'&&!meteredConnection();
function schedule(){
  if(timer!==undefined)clearTimeout(timer);timer=undefined;
  if(!allowed()){active?.abort();return;}
  if(active||!visible.size)return;
  const next=Math.min(...[...visible.keys()].map(id=>ready.get(id)??0));
  timer=setTimeout(()=>{timer=undefined;void flush();},Math.max(0,next-Date.now()));
}
async function flush(){
  if(!allowed()||active)return;
  const ids=[...visible.keys()].filter(id=>(ready.get(id)??0)<=Date.now()).slice(0,50);
  if(!ids.length){schedule();return;}
  const controller=new AbortController(),epoch=generation;active=controller;
  // A failed batch backs off; visibility churn must not create a request loop.
  for(const id of ids)ready.set(id,Date.now()+30_000);
  try{
    const result=await native<{items:{assetId:string;expires_at:string}[];waiting?:string}>('mediaTickets',{assetIds:ids},controller.signal);
    if(epoch===generation&&!controller.signal.aborted&&result.waiting==='power')for(const id of ids){ready.set(id,Date.now()+POWER_FALLBACK);powerWait.add(id);}
    if(epoch===generation&&!controller.signal.aborted)for(const item of result.items){
      const until=Date.parse(item.expires_at)-15_000;
      if(ids.includes(item.assetId)&&Number.isFinite(until)&&until>Date.now())ready.set(item.assetId,until);
    }
  }catch{/* Ticket warming never prevents opening an asset. */}
  finally{
    if(controller.signal.aborted&&epoch===generation)for(const id of ids)ready.delete(id);
    if(active===controller)active=undefined;
    while(ready.size>240){const oldest=ready.keys().next().value!;ready.delete(oldest);powerWait.delete(oldest);}
    schedule();
  }
}
export function clearOriginalTicketWarm(){generation++;active?.abort();ready.clear();powerWait.clear();schedule();}

/** Call only for intersecting gallery items; release when no longer visible. */
export function warmOriginalTickets(items:Asset[],signal:AbortSignal){
  if(signal.aborted)return;
  const token=Symbol(),ids:string[]=[];
  for(const item of items){
    if(item.pending||!(item.kind==='image'||item.kind==='gif')||ids.includes(item.id))continue;
    // Bound subscriptions too, even for an unusually dense viewport.
    if(!visible.has(item.id)&&visible.size+ids.filter(id=>!visible.has(id)).length>=128)continue;
    ids.push(item.id);
  }
  const wasEmpty=!visible.size;
  for(const id of ids){let watchers=visible.get(id);if(!watchers){watchers=new Set();visible.set(id,watchers);}watchers.add(token);}
  if(wasEmpty&&visible.size){document.addEventListener('visibilitychange',hide);connection()?.addEventListener?.('change',schedule);removeVisible=onVisible(schedule);removePower=onPowerChange(powerChanged);}
  const release=()=>{
    for(const id of ids){const watchers=visible.get(id);watchers?.delete(token);if(!watchers?.size)visible.delete(id);}
    if(!visible.size){document.removeEventListener('visibilitychange',hide);connection()?.removeEventListener?.('change',schedule);removeVisible?.();removeVisible=undefined;removePower?.();removePower=undefined;}
    schedule();
  };
  signal.addEventListener('abort',release,{once:true});schedule();
}
