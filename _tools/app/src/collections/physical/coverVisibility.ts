// Two observers per scroll root, not one observer/resize listener per book.
// `near` starts work half a viewport ahead; `visible` puts on-screen covers first in the render queue.
type Tracked = { near: boolean; visible: boolean; callback: (near: boolean, visible: boolean) => void };
type Observers = { near: IntersectionObserver; visible: IntersectionObserver; count: number };
const tracked=new Map<Element,Tracked>();
const observers=new Map<Element|null,Observers>();
function update(entries: IntersectionObserverEntry[], field: "near"|"visible") {
  for(const entry of entries) {
    const state=tracked.get(entry.target); if(!state||state[field]===entry.isIntersecting) continue;
    state[field]=entry.isIntersecting; state.callback(state.near||state.visible,state.visible);
  }
}
/** Grids mark their scroller: a root margin on the window would be clipped by the scroller anyway. */
export function observeCover(element:Element, callback:(near:boolean, visible:boolean)=>void) {
  if(typeof IntersectionObserver==="undefined") {callback(true,true);return ()=>undefined;}
  const root=element.parentElement?.closest("[data-cover-scroll-root]")??null;
  let pair=observers.get(root);
  if(!pair) {
    pair={near:new IntersectionObserver(entries=>update(entries,"near"),{root,rootMargin:"50% 0px"}),visible:new IntersectionObserver(entries=>update(entries,"visible"),{root}),count:0};
    observers.set(root,pair);
  }
  tracked.set(element,{near:false,visible:false,callback});pair.count++;pair.near.observe(element);pair.visible.observe(element);
  return ()=>{
    if(!tracked.delete(element)||!pair) return;
    pair.near.unobserve(element);pair.visible.unobserve(element);
    if(--pair.count===0){pair.near.disconnect();pair.visible.disconnect();observers.delete(root);}
  };
}
const sizes=new Map<Element,(width:number)=>void>();
let resize:ResizeObserver|null=null;
const windowResized=()=>{for(const [element,callback] of sizes)callback(element.getBoundingClientRect().width);};
export function observeCoverSize(element:Element, callback:(width:number)=>void) {
  if(typeof ResizeObserver==="undefined") return ()=>undefined;
  resize??=new ResizeObserver(entries=>{for(const entry of entries) sizes.get(entry.target)?.(entry.contentRect.width);});
  if(!sizes.size)window.addEventListener("resize",windowResized);
  sizes.set(element,callback);resize.observe(element);
  return ()=>{resize?.unobserve(element);sizes.delete(element);if(!sizes.size){resize?.disconnect();resize=null;window.removeEventListener("resize",windowResized);}};
}
