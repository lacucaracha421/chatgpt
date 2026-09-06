// One observer per window, not one observer/resize listener per book.
const callbacks=new Map<Element,(visible:boolean)=>void>();
let observer:IntersectionObserver|null=null;
export function observeCover(element:Element, callback:(visible:boolean)=>void) {
  if(typeof IntersectionObserver==="undefined") {callback(true);return ()=>undefined;}
  observer??=new IntersectionObserver(entries=>{for(const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);},{rootMargin:"100px"});
  callbacks.set(element,callback);observer.observe(element);
  return ()=>{observer?.unobserve(element);callbacks.delete(element);if(!callbacks.size){observer?.disconnect();observer=null;}};
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
