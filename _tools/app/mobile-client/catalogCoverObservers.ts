type Notify = (intersecting:boolean) => void;
type Pool = {observer:IntersectionObserver;targets:Map<Element,Set<Notify>>;states:Map<Element,boolean>};
type Cover = {visible:Notify;near:Notify;stopVisible:()=>void;stopNear:()=>void};
type Grid = {element:Element;card:Element;root:Element|null;margin:number;covers:Map<HTMLElement,Cover>};

// Intersection geometry is shared by root/range; row sizing is shared by grid.
const roots=new Map<Element|null,Map<number,Pool>>();
const grids=new Map<Element,Grid>();
let sizing:ResizeObserver|null=null;

function observe(root:Element|null,margin:number,element:Element,notify:Notify){
  let ranges=roots.get(root);
  if(!ranges){ranges=new Map();roots.set(root,ranges);}
  let pool=ranges.get(margin);
  if(!pool){
    const targets=new Map<Element,Set<Notify>>();
    const states=new Map<Element,boolean>();
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries){
        if(!targets.has(entry.target))continue;
        states.set(entry.target,entry.isIntersecting);
        for(const callback of targets.get(entry.target)!)callback(entry.isIntersecting);
      }
    },{root,rootMargin:`${margin}px 0px`});
    pool={observer,targets,states};ranges.set(margin,pool);
  }
  const shared=pool;
  let callbacks=shared.targets.get(element);
  if(!callbacks){callbacks=new Set();shared.targets.set(element,callbacks);}
  callbacks.add(notify);
  if(callbacks.size===1)shared.observer.observe(element);
  else if(shared.states.has(element))notify(shared.states.get(element)!);
  return()=>{
    callbacks.delete(notify);
    if(callbacks.size)return;
    shared.observer.unobserve(element);shared.targets.delete(element);shared.states.delete(element);
    if(shared.targets.size)return;
    shared.observer.disconnect();ranges.delete(margin);
    if(!ranges.size)roots.delete(root);
  };
}

/** Measure two real rows once per grid, and again only when its size changes. */
function rowMargin(card:Element,grid:Element){
  return Math.ceil(2*(card.getBoundingClientRect().height+(parseFloat(getComputedStyle(card.parentElement??grid).rowGap)||0)));
}

function measureFallback(grid:Grid,covers:Iterable<[HTMLElement,Cover]>=grid.covers){
  const bounds=grid.root?.getBoundingClientRect()??{top:0,bottom:window.innerHeight,left:0,right:window.innerWidth};
  for(const [element,cover] of covers){
    const box=element.getBoundingClientRect(),horizontal=box.right>bounds.left&&box.left<bounds.right;
    cover.visible(box.height>0&&horizontal&&box.bottom>bounds.top&&box.top<bounds.bottom);
    cover.near(box.height>0&&horizontal&&box.bottom>bounds.top-grid.margin&&box.top<bounds.bottom+grid.margin);
  }
}

function resizeGrid(grid:Grid){
  const margin=rowMargin(grid.card,grid.element);
  if(grid.margin!==margin){
    grid.margin=margin;
    if(window.IntersectionObserver)for(const [element,cover] of grid.covers){
      cover.stopNear();cover.stopNear=observe(grid.root,margin,element,cover.near);
    }
  }
  if(!window.IntersectionObserver)measureFallback(grid);
}
function resize(){for(const grid of grids.values())resizeGrid(grid);}
function scroll(){if(!window.IntersectionObserver)for(const grid of grids.values())measureFallback(grid);}
function startSizing(){
  sizing=window.ResizeObserver?new ResizeObserver(entries=>{
    for(const grid of grids.values())if(entries.some(entry=>entry.target===grid.element||entry.target===grid.card))resizeGrid(grid);
  }):null;
  window.addEventListener('resize',resize);
  if(!window.IntersectionObserver)window.addEventListener('scroll',scroll,true);
}

/** Shared on-screen priority and two-row preload range, with per-cover teardown. */
export function observeCatalogCover(element:HTMLElement,visible:Notify,near:Notify){
  const card=element.closest('.catalog-card')??element.parentElement??element;
  const gridElement=element.closest('.catalog-grid, .catalog-edition-row')??card.parentElement??card;
  let grid=grids.get(gridElement);
  if(!grid){
    if(!grids.size)startSizing();
    grid={element:gridElement,card,root:element.closest('.catalog-scroll, .catalog-detail, .catalog-edition-row'),margin:rowMargin(card,gridElement),covers:new Map()};
    grids.set(gridElement,grid);sizing?.observe(gridElement);sizing?.observe(card);
  }
  const group=grid;
  const cover:Cover={visible,near,stopVisible:()=>{},stopNear:()=>{}};
  group.covers.set(element,cover);
  if(window.IntersectionObserver){
    cover.stopVisible=observe(group.root,0,element,visible);
    cover.stopNear=observe(group.root,group.margin,element,near);
  }else measureFallback(group,[[element,cover]]);
  return()=>{
    cover.stopVisible();cover.stopNear();group.covers.delete(element);
    if(group.covers.size){
      // Do not retain a removed first card as the sizing representative.
      if(card===group.card&&!card.isConnected){
        const next=[...group.covers.keys()].find(host=>host.isConnected);
        if(next){
          sizing?.unobserve(group.card);
          group.card=next.closest('.catalog-card')??next.parentElement??next;
          sizing?.observe(group.card);resizeGrid(group);
        }
      }
      return;
    }
    sizing?.unobserve(group.element);sizing?.unobserve(group.card);grids.delete(gridElement);
    if(grids.size)return;
    sizing?.disconnect();sizing=null;
    window.removeEventListener('resize',resize);window.removeEventListener('scroll',scroll,true);
  };
}
