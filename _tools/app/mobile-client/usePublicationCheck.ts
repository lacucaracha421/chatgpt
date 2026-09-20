import {useEffect,useRef} from 'react';
import {api} from './transport';

/**
 * Small revision checks; callers retain their displayed content until replacement commits.
 *
 * The reply itself is handed to `onChange` on every check, together with whether
 * the revision moved. A `/status` check also carries the authority advertisement,
 * so callers that own a bookmark queue observe it here instead of issuing a
 * second request for the same document.
 */
export function usePublicationCheck(active:boolean,path:string,revision:string|null|undefined,onChange:(reply:unknown,changed:boolean)=>void,intervalMs=60_000,options:{onError?():void;retryKey?:number}={}) {
  const latest=useRef({revision,onChange,onError:options.onError});latest.current={revision,onChange,onError:options.onError};
  useEffect(()=>{
    if(!active)return;const controller=new AbortController();let running=false;
    const check=async()=>{if(running||document.visibilityState==='hidden')return;running=true;try{
      const value=await api<{revision?:string|null;publicationRevision?:string|null}>(path,controller.signal);
      if(!value||(!Object.prototype.hasOwnProperty.call(value,'revision')&&!Object.prototype.hasOwnProperty.call(value,'publicationRevision'))){if(!controller.signal.aborted)latest.current.onError?.();return;}
      if(controller.signal.aborted)return;
      const next=value.revision??value.publicationRevision??null;
      // Before the caller's own load commits there is no revision to compare
      // against, so the first check is reported as unchanged.
      const changed=latest.current.revision!==undefined&&next!==latest.current.revision;
      latest.current.onChange(value,changed);
    }catch{if(!controller.signal.aborted)latest.current.onError?.();}finally{running=false;}};
    void check();const timer=setInterval(()=>void check(),intervalMs);
    window.addEventListener('lakomics-resume',check);document.addEventListener('visibilitychange',check);
    return()=>{controller.abort();clearInterval(timer);window.removeEventListener('lakomics-resume',check);document.removeEventListener('visibilitychange',check);};
  },[active,path,intervalMs,options.retryKey]);
}
