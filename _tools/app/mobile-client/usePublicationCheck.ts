import {useEffect,useRef} from 'react';
import {api} from './transport';
import {visibleInterval} from './useVisibleInterval';

type Listener={interval:number;receive(value:unknown):void;error():void};
type Poll={listeners:Set<Listener>;controller:AbortController|null;stop():void;interval:number;check():Promise<void>};
const polls=new Map<string,Poll>();

/** One visible conditional status stream per endpoint path, shared by all consumers. */
function subscribe(path:string,listener:Listener) {
  let poll=polls.get(path);
  if(!poll){
    const entry:Poll={listeners:new Set(),controller:null,stop:()=>{},interval:0,check:async()=>{
      if(entry.controller||document.visibilityState==='hidden')return;
      const controller=entry.controller=new AbortController();
      try{
        const value=await api<{revision?:string|null;publicationRevision?:string|null}>(path,controller.signal,undefined,'GET',true);
        if(!value||(!Object.prototype.hasOwnProperty.call(value,'revision')&&!Object.prototype.hasOwnProperty.call(value,'publicationRevision')))throw new Error('Missing revision');
        if(!controller.signal.aborted)entry.listeners.forEach(item=>item.receive(value));
      }catch{if(!controller.signal.aborted)entry.listeners.forEach(item=>item.error());}
      finally{if(entry.controller===controller)entry.controller=null;}
    }};
    poll=entry;polls.set(path,poll);
  }
  const current=poll;
  const arm=()=>{
    const interval=Math.min(...Array.from(current.listeners,item=>item.interval));
    if(interval===current.interval)return;
    current.stop();current.interval=interval;
    current.stop=visibleInterval(()=>void current.check(),interval);
  };
  current.listeners.add(listener);arm();void current.check();
  return()=>{
    current.listeners.delete(listener);
    if(current.listeners.size){arm();return;}
    current.stop();current.controller?.abort();polls.delete(path);
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
