import {useEffect, useRef} from 'react';

/** Native resume and WebView visibility often describe the same foreground transition. */
const listeners=new Set<()=>void>();
let lastResume=-Infinity;
const resume=()=>{
  if(document.visibilityState==='hidden'){lastResume=-Infinity;return;}
  if(Date.now()-lastResume<500)return;
  lastResume=Date.now();Array.from(listeners).forEach(listener=>listener());
};
const pause=()=>{lastResume=-Infinity;};
export function onVisible(callback:()=>void) {
  if(!listeners.size){
    lastResume=-Infinity;
    window.addEventListener('lakomics-resume',resume);
    window.addEventListener('lakomics-pause',pause);
    document.addEventListener('visibilitychange',resume);
  }
  listeners.add(callback);
  return()=>{
    listeners.delete(callback);
    if(!listeners.size){window.removeEventListener('lakomics-resume',resume);window.removeEventListener('lakomics-pause',pause);document.removeEventListener('visibilitychange',resume);}
  };
}

/** Effect-level primitive, also used when a poll owns an AbortController or subscription. */
export function visibleInterval(callback:()=>void,delay:number,immediate=false) {
  let timer:ReturnType<typeof setInterval>|undefined;
  const clear=()=>{clearInterval(timer);timer=undefined;};
  const arm=()=>{
    if(document.visibilityState==='hidden'){clear();return;}
    if(timer===undefined)timer=setInterval(callback,delay);
  };
  const removeResume=onVisible(()=>{arm();callback();});
  document.addEventListener('visibilitychange',arm);
  arm();if(immediate&&document.visibilityState!=='hidden')callback();
  return()=>{clear();removeResume();document.removeEventListener('visibilitychange',arm);};
}

export function useVisibleInterval(callback:()=>void,delay:number|null,immediate=false) {
  const latest=useRef(callback);latest.current=callback;
  useEffect(()=>delay===null?undefined:visibleInterval(()=>latest.current(),delay,immediate),[delay,immediate]);
}
