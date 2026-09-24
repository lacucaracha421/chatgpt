import {useEffect,useLayoutEffect,useRef,type RefObject} from 'react';

/** Drill-down entrance length; a same-level swap uses the shorter fade. */
export const LEVEL_MOTION_MS=200;
export const SWAP_MOTION_MS=120;
const EASE_OUT='cubic-bezier(0.2,0,0,1)';

export function prefersReducedMotion(){
  try{return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false;}catch{return false;}
}

/**
 * Plays a short entrance when a drill-down level commits: a deeper level slides in from the
 * right, a shallower one from the left, and a different place at the same depth only fades.
 *
 * Enter-only by design: the previous level is replaced at once, so nothing is kept alive, the
 * commit path is untouched and only the container's transform and opacity move (never the
 * tiles inside it). A `null` key means "no level is on screen", so the next level after it
 * appears without motion, as after a tab switch.
 */
export function useLevelMotion(host:RefObject<HTMLElement|null>,key:string|null,depth:number){
  const previous=useRef<{key:string|null;depth:number}|null>(null);
  const running=useRef<Animation|null>(null);
  useLayoutEffect(()=>{
    const before=previous.current;previous.current={key,depth};
    const element=host.current;
    if(!before||before.key===null||key===null||before.key===key||!element||typeof element.animate!=='function'||prefersReducedMotion())return;
    const step=Math.sign(depth-before.depth);
    running.current?.cancel();
    running.current=element.animate(step
      ?[{transform:`translateX(${step*32}px)`,opacity:.35},{transform:'none',opacity:1}]
      :[{opacity:.55},{opacity:1}],
    {duration:step?LEVEL_MOTION_MS:SWAP_MOTION_MS,easing:EASE_OUT});
  },[host,key,depth]);
  useEffect(()=>()=>running.current?.cancel(),[]);
}

/**
 * Remembers the scroll offset of every scroller inside `host` and puts it back when `key`
 * changes. Retained tabs are hidden with `display:none`, which drops a scroller's offset in
 * Chromium, so returning to a tab would otherwise start at the top and then jump.
 *
 * Restoring runs in a layout effect, before paint, and only rewrites an offset that differs.
 */
export function useScrollMemory(host:RefObject<HTMLElement|null>,key:string){
  const tops=useRef(new Map<HTMLElement,number>());
  useEffect(()=>{
    const element=host.current;if(!element)return;
    const record=(event:Event)=>{const target=event.target;if(target instanceof HTMLElement&&target!==element)tops.current.set(target,target.scrollTop);};
    element.addEventListener('scroll',record,{capture:true,passive:true});
    return()=>element.removeEventListener('scroll',record,{capture:true});
  },[host]);
  const last=useRef(key);
  useLayoutEffect(()=>{
    if(last.current===key)return;last.current=key;
    for(const [target,top] of tops.current){
      if(!target.isConnected){tops.current.delete(target);continue;}
      if(target.scrollTop!==top)target.scrollTop=top;
    }
  },[key]);
}
