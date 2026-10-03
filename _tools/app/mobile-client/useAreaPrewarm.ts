import {useEffect, useState, type RefObject} from 'react';
import {viewReady} from '../src/shared/motion/AreaSwitch';
import {NETWORK_EVENT, type NetworkChange} from './deviceSignals';
import {meteredConnection, warmConnection} from './warmNetwork';

export const AREA_PREWARM_IDLE_MS = 1500;

/** One list-only warm-up per connection, after the foreground screen has painted and settled. */
export function useAreaPrewarm(scope:string, enabled:boolean, host:RefObject<HTMLElement|null>) {
  const [warmed,setWarmed]=useState<string|null>(null);
  const [online,setOnline]=useState(()=>navigator.onLine!==false);
  const [visible,setVisible]=useState(()=>document.visibilityState!=='hidden');
  const [networkVersion,setNetworkVersion]=useState(0);
  useEffect(()=>{
    const connection=warmConnection();
    const refresh=()=>{setOnline(navigator.onLine!==false);setNetworkVersion(value=>value+1);};
    const native=(event:Event)=>{setOnline((event as CustomEvent<NetworkChange>).detail.online);};
    const visibility=()=>setVisible(document.visibilityState!=='hidden');
    const pause=()=>setVisible(false),resume=()=>setVisible(document.visibilityState!=='hidden');
    window.addEventListener('online',refresh);window.addEventListener('offline',refresh);
    window.addEventListener(NETWORK_EVENT,native);
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('lakomics-pause',pause);window.addEventListener('lakomics-resume',resume);
    connection?.addEventListener?.('change',refresh);
    return()=>{
      window.removeEventListener('online',refresh);window.removeEventListener('offline',refresh);
      window.removeEventListener(NETWORK_EVENT,native);connection?.removeEventListener?.('change',refresh);
      document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('lakomics-pause',pause);window.removeEventListener('lakomics-resume',resume);
    };
  },[]);
  const allowed=enabled&&online&&visible&&!meteredConnection();
  useEffect(()=>{
    if(!allowed||warmed===scope)return;
    let timer=0,frame=0,idle:number|undefined,stopped=false,painted=false;
    const cancel=()=>{
      window.clearTimeout(timer);window.cancelAnimationFrame(frame);
      if(idle!==undefined)window.cancelIdleCallback?.(idle);
      idle=undefined;
    };
    const ready=()=>{
      const stage=host.current?.querySelector<HTMLElement>('.motion-stage');
      const shown=stage?.dataset.motionShown;
      const view=stage?.querySelector<HTMLElement>(`[data-motion-view="${shown}"]`);
      return stage?.dataset.motionActive===shown&&(shown==='home'||shown==='library')&&!!view&&viewReady(view);
    };
    const finish=()=>{
      idle=undefined;
      if(stopped||document.visibilityState==='hidden'||navigator.onLine===false||meteredConnection())return;
      if(!ready()){arm();return;}
      setWarmed(scope);
    };
    const arm=()=>{
      if(!painted)return;
      cancel();
      if(document.visibilityState==='hidden')return;
      timer=window.setTimeout(()=>{
        timer=0;
        if(window.requestIdleCallback)idle=window.requestIdleCallback(finish);
        else finish();
      },AREA_PREWARM_IDLE_MS);
    };
    // A passive effect alone may run before paint. The second frame guarantees a
    // rendering opportunity before even the idle timer is armed.
    frame=window.requestAnimationFrame(()=>{frame=window.requestAnimationFrame(()=>{painted=true;arm();});});
    const pause=()=>cancel();
    const events=['pointerdown','touchstart','keydown','wheel','scroll'] as const;
    for(const event of events)window.addEventListener(event,arm,{passive:true,capture:true});
    document.addEventListener('visibilitychange',arm);
    window.addEventListener('lakomics-pause',pause);
    window.addEventListener('lakomics-resume',arm);
    return()=>{
      stopped=true;cancel();
      for(const event of events)window.removeEventListener(event,arm,true);
      document.removeEventListener('visibilitychange',arm);
      window.removeEventListener('lakomics-pause',pause);window.removeEventListener('lakomics-resume',arm);
    };
  },[scope,allowed,warmed,host,networkVersion]);
  return {mounted:warmed===scope,prefetch:warmed===scope&&allowed};
}
