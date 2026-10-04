import {useCallback,useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {EASE_STANDARD as EASE_OUT,motionDefaults,motionSpring,motionTime,prefersReducedMotion} from '../src/shared/motion/curves';
import {waitForViewportImages} from '../src/shared/motion/viewportImages';
export {EASE_OUT,prefersReducedMotion};

/**
 * Motion spec (transform and opacity only, all ≤ 220 ms, nothing under reduced motion):
 * - Bottom-tab switches show content and its backdrop together without an entrance animation.
 * - Deeper level: the content is pushed in from 20px right (0.5 → 1) in LEVEL_MOTION_MS, and the
 *   first tiles fade in with a short stagger that ends by the same 220 ms.
 * - Shallower level: the content comes back from 20px left, without a stagger (it was retained).
 * - Same depth: a quick fade from 0.6 in SWAP_MOTION_MS.
 * - Segment swap (a type or region tab inside a screen): the content slides SEGMENT_SHIFT_PX in
 *   the direction of the tab order (a tab further right brings it in from the right) and fades
 *   from 0.5 in SEGMENT_MOTION_MS; the tab underline glides to the new tab over the same time.
 */
export const LEVEL_MOTION_MS=220;
export const SWAP_MOTION_MS=140;
export const SEGMENT_MOTION_MS=200;
export const SEGMENT_SHIFT_PX=16;
const STAGGER_TILES=10,STAGGER_STEP_MS=12,STAGGER_TILE_MS=110;
const TILE_SELECTOR='.media-tile,.library-folder,.character-card';

const hidden=(element:HTMLElement)=>element.hidden||element.style.display==='none';
/**
 * The parts of a screen that move: every shown child except the top bar and floating notices.
 * A child that carries its own top bar (the Library root, a character level) is opened up one
 * level, so its bar stays still too. With nothing else to move, the host itself moves.
 */
export function motionParts(host:HTMLElement):HTMLElement[]{
  const parts:HTMLElement[]=[];
  const collect=(parent:HTMLElement,depth:number)=>{
    for(const child of Array.from(parent.children)){
      if(!(child instanceof HTMLElement)||hidden(child)||child.matches('.top-bar,.floating-notices,.loading-line'))continue;
      if(depth<2&&Array.from(child.children).some(inner=>inner.classList.contains('top-bar')))collect(child,depth+1);
      else parts.push(child);
    }
  };
  collect(host,0);
  return parts.length?parts:[host];
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
  const running=useRef<{animations:Animation[];stop?:()=>void}>({animations:[]});
  const cancel=()=>{running.current.stop?.();for(const animation of running.current.animations)animation.cancel();};
  useEffect(()=>()=>cancel(),[]);// eslint-disable-line react-hooks/exhaustive-deps
  return (next:Animation[],stop?:()=>void)=>{cancel();running.current={animations:next,stop};};
}

/**
 * Like the PC (AreaSwitch, FolderMove), an entrance starts only once the incoming view's
 * first-viewport images have decoded, capped at IMAGE_READY_CAP_MS: the animations are created
 * at once and held on their first frame, then played. Images that come later fade in by
 * themselves (StableImage).
 */
function afterViewportImages(host:HTMLElement,animations:Animation[],run:(next:Animation[],stop?:()=>void)=>void){
  for(const animation of animations)animation.pause?.();
  let stop:(()=>void)|undefined;
  run(animations,()=>stop?.());
  stop=waitForViewportImages(host,()=>{stop=undefined;for(const animation of animations)animation.play?.();});
}

/**
 * Plays a short entrance when a drill-down level commits: a deeper level is pushed in from the
 * right, a shallower one comes back from the left, and a different place at the same depth only
 * fades.
 *
 * Callers change `key` only once the new level's data has committed, so the motion never plays
 * over stale content and nothing flashes twice. Enter-only by design: the previous level is
 * replaced at once, nothing is kept alive, and only transform and opacity move. A `null` key
 * means "no level is on screen" and cancels an unfinished entrance, so returning to a retained
 * tab shows its content and backdrop at their final opacity and position. `stagger` false leaves
 * the tiles to their own gallery entrance (the PC's first batch).
 */
export function useLevelMotion(host:RefObject<HTMLElement|null>,key:string|null,depth:number,stagger=true){
  const previous=useRef<{key:string|null;depth:number}|null>(null);
  const run=useRunning();
  useLayoutEffect(()=>{
    const before=previous.current;previous.current={key,depth};
    if(key===null){run([]);return;}
    const element=host.current;
    if(!before||before.key===null||before.key===key||!element||prefersReducedMotion())return;
    const step=Math.sign(depth-before.depth);
    const parts=motionParts(element);
    afterViewportImages(element,step
      ?[...animateAll(parts,[{transform:`translateX(${step*20}px)`,opacity:.5},{transform:'none',opacity:1}],{duration:LEVEL_MOTION_MS,easing:EASE_OUT}),...(step>0&&stagger?staggerTiles(element):[])]
      :animateAll(parts,[{opacity:.6},{opacity:1}],{duration:SWAP_MOTION_MS,easing:EASE_OUT}),run);
  },[host,key,depth]);// eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Plays a lateral swap when a segment (a type or region tab) inside a screen changes: the parts
 * slide in from the side the new tab lies on and fade in. `host` itself moves unless `parts`
 * picks what moves (for example everything under the segment control).
 *
 * Callers pass `null` while the new segment's data is still loading, so the swap plays once,
 * when the new content commits, and never over stale content. `null` keeps the last shown
 * segment; the first segment shown and a repeat of the same one do not move. `scope` names the
 * place the segment belongs to (a folder, say): a segment first shown in another place does not
 * move either, since that change is a navigation with its own motion.
 */
export function useSegmentMotion(host:RefObject<HTMLElement|null>,key:string|null,index:number,parts?:(host:HTMLElement)=>HTMLElement[],scope=''){
  const shown=useRef<{key:string;index:number;scope:string}|null>(null);
  const pick=useRef(parts);pick.current=parts;
  const run=useRunning();
  useLayoutEffect(()=>{
    if(key===null)return;
    const before=shown.current;shown.current={key,index,scope};
    const element=host.current;
    if(!before||before.key===key||before.scope!==scope||!element||prefersReducedMotion())return;
    const step=Math.sign(index-before.index);
    afterViewportImages(element,animateAll(pick.current?.(element)??[element],[{transform:`translateX(${step*SEGMENT_SHIFT_PX}px)`,opacity:.5},{transform:'none',opacity:1}],{duration:SEGMENT_MOTION_MS,easing:EASE_OUT}),run);
  },[host,key,index,scope]);// eslint-disable-line react-hooks/exhaustive-deps
}

/** Under a list's section bar, what a segment swap moves: everything but the bar, pull and scrubber. */
export const sectionListParts=(host:HTMLElement)=>[...host.children].filter((child):child is HTMLElement=>child instanceof HTMLElement&&!child.matches('.ui-section-bar,.section-shade-rows,.pull-refresh,.mobile-scrubber'));

/**
 * Places one underline element under the selected tab of `list` (its `[role=tab]` children)
 * with a transform only: it glides to a newly selected tab, and is placed without motion on
 * mount, when the tabs change size, and under reduced motion. The underline is 1px wide and
 * scaled to the tab's width less the list's `--tab-inset` on each side.
 */
export function useTabIndicator(list:RefObject<HTMLElement|null>,indicator:RefObject<HTMLElement|null>,index:number){
  const selected=useRef(index);selected.current=index;
  const place=useCallback((glide:boolean)=>{
    const host=list.current,bar=indicator.current;if(!host||!bar)return;
    const tab=host.querySelectorAll<HTMLElement>('[role=tab]')[selected.current];if(!tab)return;
    const inset=Number.parseFloat(getComputedStyle(host).getPropertyValue('--tab-inset'))||0;
    bar.style.transition=glide&&!prefersReducedMotion()?`transform ${SEGMENT_MOTION_MS}ms ${EASE_OUT}`:'none';
    bar.style.transform=`translateX(${tab.offsetLeft+inset}px) scaleX(${Math.max(0,tab.offsetWidth-2*inset)})`;
  },[list,indicator]);
  const placed=useRef(false);
  useLayoutEffect(()=>{place(placed.current);placed.current=true;},[place,index]);
  // Sizes settle later (fonts, the screen being shown, a narrower bar); follow them without motion.
  useEffect(()=>{
    const host=list.current;if(!host||typeof ResizeObserver!=='function')return;
    const observer=new ResizeObserver(()=>place(false));observer.observe(host);
    return()=>observer.disconnect();
  },[list,place]);
}

/**
 * Arrival of media that loads after its box is on screen (an appended gallery tile, a cover
 * whose image comes late). The box keeps its final size the whole time, so nothing shifts: the
 * element is only held transparent until its image is decoded, then fades in (and rises
 * ARRIVE_RISE_PX when asked) over ARRIVE_MS. Under reduced motion nothing is held or moved.
 */
export const ARRIVE_MS=180;
export const ARRIVE_RISE_PX=8;
/** An appended tile whose image is still not decoded after this long is shown anyway. */
export const ARRIVE_WAIT_MS=600;
const HELD='0';

/** Holds `element` transparent until `arrive` is called. Returns false (nothing held) under reduced motion. */
export function holdArrival(element:HTMLElement|null):boolean{
  if(!element||prefersReducedMotion())return false;
  element.style.opacity=HELD;
  return true;
}

/** Holds an image that is not decoded yet; one already decoded (a cached thumbnail) is left alone. */
export function holdImage(image:HTMLImageElement|null):boolean{
  if(!image||(image.complete&&image.naturalWidth>0))return false;
  return holdArrival(image);
}

/**
 * Plays the arrival of an element held by `holdArrival`/`holdImage`, once: an element that is
 * not held (never held, or already arrived) is left alone and false is returned.
 */
export function arrive(element:HTMLElement|null,rise=0):boolean{
  if(!element||element.style.opacity!==HELD)return false;
  element.style.opacity='';
  if(prefersReducedMotion()||typeof element.animate!=='function')return true;
  element.animate(rise
    ?[{opacity:0,transform:`translateY(${rise}px)`},{opacity:1,transform:'none'}]
    :[{opacity:0},{opacity:1}],{duration:ARRIVE_MS,easing:EASE_OUT});
  return true;
}

/**
 * Which items of a growing list were appended by a page load and have not arrived yet. The
 * first page of a place (`identity`), a replaced list (a new head) and items seen before never
 * arrive; only items added to the same list do, once each.
 */
export function useAppendArrivals(identity:unknown,ids:readonly string[]){
  const tracked=useRef({identity,head:undefined as string|undefined,known:new Set<string>(),pending:new Set<string>()});
  const current=tracked.current,head=ids[0];
  if(current.identity!==identity||!current.known.size||current.head!==head)tracked.current={identity,head,known:new Set(ids),pending:new Set()};
  else for(const id of ids)if(!current.known.has(id)){current.known.add(id);current.pending.add(id);}
  const arrived=useRef((id:string)=>{tracked.current.pending.delete(id);}).current;
  return {arriving:(id:string)=>tracked.current.pending.has(id),arrived};
}

/** What a card's cover tells its card: whether the card still waits, and that the cover is ready (decoded, failed or absent). */
export type CardArrival={waiting():boolean;ready():void};

/**
 * An appended card (`arriving` at mount) stays transparent in its final box until its cover
 * reports ready, then rises in as one piece (cover, title and meta together). A cover that is
 * still not decoded ARRIVE_WAIT_MS after the card comes into view does not hold the card any
 * longer: the card rises in with its placeholder and the cover fades in by itself later.
 * Catalog disables late image fading so a displayed cover always stays visible.
 */
export function useCardArrival(host:RefObject<HTMLElement|null>,arriving:boolean,onArrived:()=>void,fadeLateImage=true):CardArrival{
  const waiting=useRef(false),done=useRef(onArrived);done.current=onArrived;
  useLayoutEffect(()=>{
    if(!arriving)return;
    waiting.current=holdArrival(host.current);
    if(!waiting.current)done.current();
  },[]);// eslint-disable-line react-hooks/exhaustive-deps
  const [arrival]=useState<CardArrival>(()=>({
    waiting:()=>waiting.current,
    ready:()=>{if(!waiting.current)return;waiting.current=false;done.current();arrive(host.current,ARRIVE_RISE_PX);},
  }));
  useEffect(()=>{
    const element=host.current;if(!waiting.current||!element)return;
    let timer=0;
    const giveUp=()=>{
      if(!waiting.current)return;
      // The cover's image, if it is already in place but not decoded, fades in on its own load.
      if(fadeLateImage)holdImage(element.querySelector('img'));
      arrival.ready();
    };
    const start=()=>{if(!timer)timer=window.setTimeout(giveUp,ARRIVE_WAIT_MS);};
    if(!window.IntersectionObserver){start();return()=>window.clearTimeout(timer);}
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();start();}});
    observer.observe(element);
    return()=>{observer.disconnect();window.clearTimeout(timer);};
  },[]);// eslint-disable-line react-hooks/exhaustive-deps
  return arrival;
}

/** Calls `then` once `image` is decoded (or cannot be). */
export function afterDecode(image:HTMLImageElement,then:()=>void){
  void (typeof image.decode==='function'?image.decode():Promise.resolve()).catch(()=>{}).then(then);
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

/** How long a full-screen layer takes to push in: the gentle spring, or the reduced-motion fade. */
export function layerEnterTime(){
  return prefersReducedMotion()?motionTime('--motion-micro',motionDefaults.micro):motionSpring('gentle').duration;
}

/**
 * Whether an open full-screen layer has finished pushing in over the page, so the page beneath
 * may be hidden. It is false at once when the layer closes, so the page is already back in place
 * under the layer's exit.
 */
export function useLayerCovered(open:boolean){
  const [covered,setCovered]=useState(false);
  useEffect(()=>{
    if(!open){setCovered(false);return;}
    const timer=window.setTimeout(()=>setCovered(true),layerEnterTime());
    return()=>window.clearTimeout(timer);
  },[open]);
  return open&&covered;
}
