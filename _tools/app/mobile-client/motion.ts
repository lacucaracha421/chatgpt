import {useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react';

/**
 * Motion spec (transform and opacity only, all ≤ 220 ms, nothing under reduced motion):
 * - Tab switch: the new tab's content rises 6px and fades from 0.4 in TAB_MOTION_MS. The top
 *   bar never moves, so the logo and the bar stay put while only the content settles.
 * - Deeper level: the content is pushed in from 20px right (0.5 → 1) in LEVEL_MOTION_MS, and the
 *   first tiles fade in with a short stagger that ends by the same 220 ms.
 * - Shallower level: the content comes back from 20px left, without a stagger (it was retained).
 * - Same depth: a quick fade from 0.6 in SWAP_MOTION_MS.
 */
export const TAB_MOTION_MS=200;
export const LEVEL_MOTION_MS=220;
export const SWAP_MOTION_MS=140;
/** A fast start that settles softly, like the system's own screen transitions. */
export const EASE_OUT='cubic-bezier(0.2,0,0,1)';
const STAGGER_TILES=10,STAGGER_STEP_MS=12,STAGGER_TILE_MS=110;
const TILE_SELECTOR='.media-tile,.library-folder,.character-card';

export function prefersReducedMotion(){
  try{return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false;}catch{return false;}
}

const hidden=(element:HTMLElement)=>element.hidden||element.style.display==='none';
/**
 * The parts of a screen that move: every shown child except the top bar and floating notices.
 * A child that carries its own top bar (the Library root, a character level) is opened up one
 * level, so its bar stays still too. With nothing else to move, the host itself moves unless
 * `bareHost` is false (a tab still loading shows only its bar, which must not move).
 */
export function motionParts(host:HTMLElement,bareHost=true):HTMLElement[]{
  const parts:HTMLElement[]=[];
  const collect=(parent:HTMLElement,depth:number)=>{
    for(const child of Array.from(parent.children)){
      if(!(child instanceof HTMLElement)||hidden(child)||child.matches('.top-bar,.floating-notices,.loading-line'))continue;
      if(depth<2&&Array.from(child.children).some(inner=>inner.classList.contains('top-bar')))collect(child,depth+1);
      else parts.push(child);
    }
  };
  collect(host,0);
  return parts.length||!bareHost?parts:[host];
}

function animateAll(parts:HTMLElement[],frames:Keyframe[],options:KeyframeAnimationOptions){
  return parts.filter(part=>typeof part.animate==='function').map(part=>part.animate(frames,options));
}

/** The first tiles on screen fade in one after another; later ones are not touched. */
function staggerTiles(host:HTMLElement):Animation[]{
  const bottom=host.getBoundingClientRect().bottom||Infinity;
  const tiles=Array.from(host.querySelectorAll<HTMLElement>(TILE_SELECTOR)).filter(tile=>tile.getBoundingClientRect().top<bottom).slice(0,STAGGER_TILES);
  return tiles.filter(tile=>typeof tile.animate==='function').map((tile,index)=>tile.animate([{opacity:0},{opacity:1}],{duration:STAGGER_TILE_MS,delay:index*STAGGER_STEP_MS,easing:EASE_OUT,fill:'backwards'}));
}

function useRunning(){
  const running=useRef<Animation[]>([]);
  useEffect(()=>()=>{for(const animation of running.current)animation.cancel();},[]);
  return (next:Animation[])=>{for(const animation of running.current)animation.cancel();running.current=next;};
}

/**
 * Plays a short entrance when a drill-down level commits: a deeper level is pushed in from the
 * right, a shallower one comes back from the left, and a different place at the same depth only
 * fades.
 *
 * Callers change `key` only once the new level's data has committed, so the motion never plays
 * over stale content and nothing flashes twice. Enter-only by design: the previous level is
 * replaced at once, nothing is kept alive, and only transform and opacity move. A `null` key
 * means "no level is on screen", so the next level after it appears without motion, as after a
 * tab switch.
 */
export function useLevelMotion(host:RefObject<HTMLElement|null>,key:string|null,depth:number){
  const previous=useRef<{key:string|null;depth:number}|null>(null);
  const run=useRunning();
  useLayoutEffect(()=>{
    const before=previous.current;previous.current={key,depth};
    const element=host.current;
    if(!before||before.key===null||key===null||before.key===key||!element||prefersReducedMotion())return;
    const step=Math.sign(depth-before.depth);
    const parts=motionParts(element);
    run(step
      ?[...animateAll(parts,[{transform:`translateX(${step*20}px)`,opacity:.5},{transform:'none',opacity:1}],{duration:LEVEL_MOTION_MS,easing:EASE_OUT}),...(step>0?staggerTiles(element):[])]
      :animateAll(parts,[{opacity:.6},{opacity:1}],{duration:SWAP_MOTION_MS,easing:EASE_OUT}));
  },[host,key,depth]);// eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Settles the content of a newly selected tab: a 6px rise and a fade from 0.4, while the bar
 * stays still. `host` holds the tabs; the one shown is the child that is not hidden. Retained
 * tabs appear with their content already laid out, so only transform and opacity change.
 */
export function useTabMotion(host:RefObject<HTMLElement|null>,tab:string){
  const last=useRef(tab);
  const run=useRunning();
  useLayoutEffect(()=>{
    if(last.current===tab)return;last.current=tab;
    const element=host.current;
    if(!element||prefersReducedMotion())return;
    const shown=Array.from(element.children).filter((child):child is HTMLElement=>child instanceof HTMLElement&&!hidden(child));
    run(shown.flatMap(section=>animateAll(motionParts(section,false),[{transform:'translateY(6px)',opacity:.4},{transform:'none',opacity:1}],{duration:TAB_MOTION_MS,easing:EASE_OUT})));
  },[host,tab]);// eslint-disable-line react-hooks/exhaustive-deps
}

/** A load shorter than this shows nothing. */
export const PROGRESS_DELAY_MS=350;
/** Once shown, the line stays at least this long, so it never blinks. */
export const PROGRESS_MIN_MS=400;
/** Fade-out length; the CSS uses the same value. */
export const PROGRESS_FADE_MS=180;
export type Presence='hidden'|'shown'|'leaving';

/**
 * Presence of a loading indicator for a load that is `active`: it appears only when the load
 * outlasts PROGRESS_DELAY_MS, then stays at least PROGRESS_MIN_MS and leaves through a
 * PROGRESS_FADE_MS fade ('leaving'). Under reduced motion it leaves at once.
 */
export function useDelayedPresence(active:boolean,{delay=PROGRESS_DELAY_MS,min=PROGRESS_MIN_MS,fade=PROGRESS_FADE_MS}:{delay?:number;min?:number;fade?:number}={}):Presence{
  const [presence,setPresence]=useState<Presence>('hidden');
  const shownAt=useRef(0);
  useEffect(()=>{
    let timer:number|undefined;
    const later=(ms:number,next:()=>void)=>{if(ms<=0)next();else timer=window.setTimeout(next,ms);};
    if(active){
      if(presence==='hidden')later(delay,()=>{shownAt.current=Date.now();setPresence('shown');});
      else if(presence==='leaving'){shownAt.current=Date.now();setPresence('shown');}
    }else if(presence==='shown')later(shownAt.current+min-Date.now(),()=>setPresence(prefersReducedMotion()||fade<=0?'hidden':'leaving'));
    else if(presence==='leaving')later(fade,()=>setPresence('hidden'));
    return()=>window.clearTimeout(timer);
  },[active,presence,delay,min,fade]);
  return presence;
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
