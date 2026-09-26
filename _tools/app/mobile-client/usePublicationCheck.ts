import {useEffect,useRef} from 'react';
import {SIGNAL_FALLBACK_MS,subscribeSyncSignals,syncSignal,syncSignalsLive} from './syncSignals';
import {api} from './transport';
import {visibleInterval} from './useVisibleInterval';

type Listener={interval:number;receive(value:unknown):void;error():void};
type Poll={listeners:Set<Listener>;controller:AbortController|null;again:boolean;stop():void;interval:number;check(signalled?:boolean):Promise<void>;arm():void;seen:string|undefined;unsignal():void};
const polls=new Map<string,Poll>();

/** The `/v1/sync/status` signal that moves exactly when this status document does, if any. */
function signalKey(path:string) {
  const base=path.split('?')[0];
  return base==='/v1/library/characters/status'?'characters'
    :base==='/v1/collections/status'?'collections'
    :base==='/v1/collections/releases'?'releases'
    :base==='/v1/mobile-catalog/status'?'catalog':null;
}

/**
 * One visible conditional status stream per endpoint path, shared by all consumers.
 *
 * While the native status long-poll is live, a path with a signal is checked when that signal
 * moves, and its timer is only a {@link SIGNAL_FALLBACK_MS} safety net.
 */
function subscribe(path:string,listener:Listener) {
  let poll=polls.get(path);
  if(!poll){
    const key=signalKey(path);
    const entry:Poll={listeners:new Set(),controller:null,again:false,stop:()=>{},interval:0,seen:key?syncSignal(key):undefined,unsignal:()=>{},check:async(signalled=false)=>{
      if(document.visibilityState==='hidden')return;
      // Concurrent checks share one request, but a signal that moves during a check may
      // postdate what it read: that one checks once more afterwards.
      if(entry.controller){if(signalled)entry.again=true;return;}
      const controller=entry.controller=new AbortController();
      try{
        const value=await api<{revision?:string|null;publicationRevision?:string|null}>(path,controller.signal,undefined,'GET',true);
        if(!value||(!Object.prototype.hasOwnProperty.call(value,'revision')&&!Object.prototype.hasOwnProperty.call(value,'publicationRevision')))throw new Error('Missing revision');
        if(!controller.signal.aborted)entry.listeners.forEach(item=>item.receive(value));
      }catch{if(!controller.signal.aborted)entry.listeners.forEach(item=>item.error());}
      finally{
        if(entry.controller===controller){entry.controller=null;if(entry.again&&!controller.signal.aborted){entry.again=false;void entry.check();}}
      }
    },arm:()=>{
      const wanted=Math.min(...Array.from(entry.listeners,item=>item.interval));
      const interval=key&&syncSignalsLive()?Math.max(wanted,SIGNAL_FALLBACK_MS):wanted;
      if(interval===entry.interval)return;
      entry.stop();entry.interval=interval;
      entry.stop=visibleInterval(()=>void entry.check(),interval);
    }};
    if(key)entry.unsignal=subscribeSyncSignals(()=>{
      entry.arm();
      const next=syncSignal(key);
      if(next===undefined)return;
      const moved=next!==entry.seen;
      entry.seen=next;
      if(moved)void entry.check(true);
    });
    poll=entry;polls.set(path,poll);
  }
  const current=poll;
  current.listeners.add(listener);current.arm();void current.check();
  return()=>{
    current.listeners.delete(listener);
    if(current.listeners.size){current.arm();return;}
    current.stop();current.unsignal();current.again=false;current.controller?.abort();polls.delete(path);
  };
}

export function usePublicationCheck(active:boolean,path:string,revision:string|null|undefined,onChange:(reply:unknown,changed:boolean)=>void,intervalMs=60_000,options:{onError?():void;retryKey?:number}={}) {
  const latest=useRef({revision,onChange,onError:options.onError});latest.current={revision,onChange,onError:options.onError};
  useEffect(()=>{
    if(!active)return;
    return subscribe(path,{interval:intervalMs,error:()=>latest.current.onError?.(),receive:reply=>{
      const value=reply as {revision?:string|null;publicationRevision?:string|null};
      const next=value.revision??value.publicationRevision??null;
      latest.current.onChange(value,latest.current.revision!==undefined&&next!==latest.current.revision);
    }});
  },[active,path,intervalMs,options.retryKey]);
}
