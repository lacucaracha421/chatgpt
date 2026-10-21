import {useCallback,useEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {VIEW_HERO_ATTRIBUTE} from '../../src/shared/motion/AreaSwitch';
import {reducedMotion} from '../../src/shared/motion/curves';
import {startViewSwap,viewTransitionRunning,viewTransitionsSupported,type ViewSwap} from '../../src/shared/motion/viewSwap';
import {waitForViewportImages} from '../../src/shared/motion/viewportImages';
import '../../src/shared/motion/viewTransitions.css';

/** Prepare the retained detail behind the grid, then hand both portraits to the shared swap. */
export function useFavoriteHero() {
  const [selected,setSelected]=useState<string|null>(null),[pending,setPending]=useState<string|null>(null),[noMotion,setNoMotion]=useState(false);
  const grid=useRef<HTMLDivElement>(null),detail=useRef<HTMLDivElement>(null);
  const swap=useRef<ViewSwap|null>(null),cleanup=useRef<(()=>void)|undefined>(undefined),stop=useRef<(()=>void)|undefined>(undefined),request=useRef(0);
  const cancel=useCallback(()=>{request.current++;stop.current?.();stop.current=undefined;swap.current?.cancel();swap.current=null;cleanup.current?.();cleanup.current=undefined;},[]);
  useEffect(()=>cancel,[cancel]);
  const portrait=(host:HTMLElement|null,id?:string|null)=>{
    const card=id?Array.from(host?.querySelectorAll<HTMLElement>('[data-favorite-card]')??[]).find(item=>item.dataset.favoriteCard===id):host;
    return card?.querySelector<HTMLElement>('.favorite-portrait')??null;
  };
  const onScreen=(element:HTMLElement|null,host:HTMLElement|null)=>{
    const rect=element?.getBoundingClientRect(),clip=host?.querySelector('.favorite-scroll,.gallery-scroll')?.getBoundingClientRect();
    return !!rect&&rect.width>0&&rect.height>0&&rect.bottom>Math.max(0,clip?.top??0)&&rect.top<Math.min(window.innerHeight,clip?.bottom??window.innerHeight);
  };
  const exchange=(next:string|null)=>{
    const previous=selected;
    cancel();
    const oldHero=previous?portrait(detail.current):portrait(grid.current,next);
    const newHero=next?portrait(detail.current):portrait(grid.current,previous);
    const hero=!reducedMotion()&&viewTransitionsSupported()&&!viewTransitionRunning()&&onScreen(oldHero,previous?detail.current:grid.current)&&onScreen(newHero,next?detail.current:grid.current);
    const commit=()=>{oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);setNoMotion(hero);setSelected(next);setPending(null);if(hero)newHero?.setAttribute(VIEW_HERO_ATTRIBUTE,'');};
    if(!hero){flushSync(commit);return;}
    oldHero?.setAttribute(VIEW_HERO_ATTRIBUTE,'');
    const transition=startViewSwap({attribute:'data-area-view-transition',value:'hero',commit});
    if(!transition){oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);flushSync(commit);return;}
    swap.current=transition;
    cleanup.current=()=>{oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);newHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);};
    void transition.finished.then(()=>{if(swap.current===transition){cleanup.current?.();cleanup.current=undefined;swap.current=null;}});
  };
  const open=(id:string)=>{cancel();setPending(id);};
  const close=()=>{if(pending&&!selected){cancel();setPending(null);}else exchange(null);};
  const reset=()=>{cancel();setPending(null);setSelected(null);};
  const ready=()=>{
    if(!pending||stop.current)return;
    const host=detail.current?.querySelector<HTMLElement>('.mobile-overlay__panel');
    if(!host)return;
    const token=request.current;
    stop.current=waitForViewportImages(host,()=>{queueMicrotask(()=>{if(request.current===token)exchange(pending);});});
  };
  const replace=(id:string)=>{cancel();setSelected(id);setPending(null);};
  return {selected,pending,displayed:pending??selected,noMotion,grid,detail,open,close,reset,replace,ready};
}
