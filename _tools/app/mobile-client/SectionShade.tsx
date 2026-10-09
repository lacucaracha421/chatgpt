import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type MouseEvent as ReactMouseEvent,type ReactNode} from 'react';
import {ChevronDownIcon} from '@heroicons/react/24/outline';
import {SectionBar} from '../src/shared/ui/SectionBar';
import type {SegmentedOption} from '../src/shared/ui/SegmentedControl';
import './sectionShade.css';

/**
 * The tablet's section bar (docs/prototypes/section-bar-20261001): the shared SectionBar is the
 * first row of the screen's scrolling list and scrolls away with it. Once it is off screen the
 * top-bar title names the current section ("컬렉션 · 게임 ⌄"), and pulling the top bar down (or
 * tapping that title) drops a second copy from under the top bar like Android's notification
 * shade. Section picks keep it open; a tap outside, Back, Escape or 64px of user scroll closes it.
 */
export type SectionShadeBar<T extends string>={label:string;options:readonly SegmentedOption<T>[];value:T;onChange(value:T):void;trailing?:ReactNode;extra?:ReactNode};
export type SectionShade={
  /** The bar as the list's first row. */
  inline:ReactNode;
  /** The dropped copy; place it directly after the top bar. Null while the bar is in view. */
  shade:ReactNode;
  /** The top-bar title: `base` alone at the top, `base · section ⌄` (a toggle) once scrolled away. */
  title(base:string):ReactNode;
  /** Attach to the top bar that is pulled. */
  barRef(element:HTMLElement|null):void;
  away:boolean;
  open:boolean;
};

/** Movement before a press on the top bar becomes a pull (and no longer a tap). */
const PULL_SLOP=8;
const SCROLL_CLOSE_DISTANCE=64;
/** Open shades, so the system Back closes the visible one before navigating. */
const openShades=new Set<{element():HTMLElement|null;close():void}>();
/** A retained tab is hidden with an inline `display:none`; its shade does not count. */
const shown=(element:HTMLElement|null)=>!!element?.isConnected&&!element.closest('[style*="display: none"]');
/** Closes the visible open shade, as Back does. Returns false when there is none. */
export function closeVisibleShade() {
  for(const shade of openShades)if(shown(shade.element())){shade.close();return true;}
  return false;
}
/** The tap that closes the shade from outside does nothing else, as on a scrim. */
function swallowNextClick() {
  const swallow=(event:MouseEvent)=>{event.preventDefault();event.stopPropagation();done();};
  const done=()=>{window.clearTimeout(timer);document.removeEventListener('click',swallow,true);};
  // A press that turns into a scroll never clicks; its swallow lapses.
  const timer=window.setTimeout(done,700);
  document.addEventListener('click',swallow,true);
}
/** The bar has left the top of its scroller (jsdom has no layout, so a scrolled list counts as away). */
function scrolledPast(scroller:HTMLElement,bar:HTMLElement) {
  return scroller.scrollTop>0&&bar.getBoundingClientRect().bottom<=scroller.getBoundingClientRect().top+1;
}

export function useSectionShade<T extends string>(bar:SectionShadeBar<T>,{active=true}:{active?:boolean}={}):SectionShade {
  const id=useId();
  const [away,setAway]=useState(false),[open,setOpen]=useState(false),[dragging,setDragging]=useState(false);
  const [topBar,setTopBar]=useState<HTMLElement|null>(null);
  const inline=useRef<HTMLDivElement|null>(null),shade=useRef<HTMLDivElement|null>(null),toggleButton=useRef<HTMLButtonElement|null>(null);
  const state=useRef({away,open});state.current={away,open};
  const focusOnOpen=useRef(false);
  const listScroller=useRef<HTMLElement|null>(null);
  const scrolling=useRef({top:0,distance:0,userUntil:0,pointer:false});
  const close=useCallback(()=>setOpen(false),[]);
  const inlineRef=useCallback((element:HTMLDivElement|null)=>{inline.current=element;if(!element){setAway(false);setOpen(false);}},[]);
  const barRef=useCallback((element:HTMLElement|null)=>setTopBar(element),[]);
  // Hand the finger's position to the committed open/closed class before clearing it. Clearing
  // it in pointerup lets the release height read resolve the still-closed transform first.
  useLayoutEffect(()=>{if(!dragging&&shade.current)shade.current.style.transform='';},[dragging,open]);
  // A hidden screen closes its shade.
  useEffect(()=>{if(!active)setOpen(false);},[active]);
  // Content swaps/reset scroll without user input. Only accumulate movement from a list gesture.
  useEffect(()=>{
    const scrolled=(event:Event)=>{
      const scroller=event.target,bar=inline.current;
      if(!(scroller instanceof HTMLElement)||!bar||!scroller.contains(bar))return;
      listScroller.current=scroller;
      setAway(scrolledPast(scroller,bar));
      const tracking=scrolling.current,delta=Math.abs(scroller.scrollTop-tracking.top);
      tracking.top=scroller.scrollTop;
      if(state.current.open&&(tracking.pointer||Date.now()<tracking.userUntil)){
        tracking.distance+=delta;tracking.userUntil=Date.now()+200;
        if(tracking.distance>=SCROLL_CLOSE_DISTANCE)setOpen(false);
      }
    };
    document.addEventListener('scroll',scrolled,true);
    return()=>document.removeEventListener('scroll',scrolled,true);
  },[]);
  // The pull: a downward drag that starts on the top bar while the bar is away. The shade follows
  // the finger and opens when released past half its height, otherwise it springs back.
  useEffect(()=>{
    const element=topBar;if(!element)return;
    // Vertical moves on the top bar belong to the pull, not to a page pan.
    const touchAction=element.style.touchAction;element.style.touchAction='pan-x';
    let drag:{pointer:number;x:number;y:number;pulling:boolean}|null=null,swallowClick=false;
    const height=()=>shade.current?.offsetHeight??0;
    const follow=(dy:number)=>{const target=shade.current,full=height();if(target)target.style.transform=`translateY(${Math.max(0,Math.min(full,dy))-full}px)`;};
    const down=(event:PointerEvent)=>{
      if(event.isPrimary===false||event.button>0)return;
      swallowClick=false;
      if(!state.current.away||state.current.open)return;
      drag={pointer:event.pointerId,x:event.clientX,y:event.clientY,pulling:false};
    };
    const move=(event:PointerEvent)=>{
      if(!drag||event.pointerId!==drag.pointer)return;
      const dy=event.clientY-drag.y,dx=Math.abs(event.clientX-drag.x);
      if(!drag.pulling){
        if(dy<PULL_SLOP&&dx<PULL_SLOP)return;
        // Sideways or upward: not a pull (a breadcrumb may scroll sideways).
        if(dy<PULL_SLOP||dx>dy){drag=null;return;}
        drag.pulling=true;element.setPointerCapture?.(event.pointerId);setDragging(true);
      }
      if(event.cancelable)event.preventDefault();
      follow(dy);
    };
    const end=(event:PointerEvent)=>{
      if(!drag||event.pointerId!==drag.pointer)return;
      const pulled=drag.pulling,dy=event.clientY-drag.y;drag=null;
      if(!pulled)return;
      // The click that ends a pull on the title (or an action) is not a tap.
      // Keep the guard until that click or the next press, even when the WebView delays it.
      swallowClick=true;
      element.releasePointerCapture?.(event.pointerId);
      setDragging(false);
      setOpen(event.type==='pointerup'&&dy>height()/2);
    };
    const click=(event:MouseEvent)=>{if(!swallowClick)return;swallowClick=false;if(event.detail===0)return;event.preventDefault();event.stopPropagation();};
    // A fast pull can leave the 56px bar before the first move establishes capture.
    element.addEventListener('pointerdown',down);document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);element.addEventListener('click',click,true);
    return()=>{element.style.touchAction=touchAction;element.removeEventListener('pointerdown',down);document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);element.removeEventListener('click',click,true);};
  },[topBar]);
  // While open: a tap outside, Escape and Back close it.
  useEffect(()=>{
    if(!open)return;
    scrolling.current={top:listScroller.current?.scrollTop??0,distance:0,userUntil:0,pointer:false};
    const entry={element:()=>shade.current,close};
    openShades.add(entry);
    let press:{id:number;x:number;y:number;moved:boolean}|null=null;
    const inList=(target:Node|null)=>!!target&&!!inline.current&&!!listScroller.current?.contains(target);
    const outside=(event:PointerEvent)=>{
      const target=event.target as Node|null;
      if(!target||shade.current?.contains(target)||topBar?.contains(target))return;
      if(inList(target)){scrolling.current.top=listScroller.current!.scrollTop;press={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};return;}
      close();swallowNextClick();
    };
    const move=(event:PointerEvent)=>{
      if(!press||press.id!==event.pointerId)return;
      if(Math.hypot(event.clientX-press.x,event.clientY-press.y)<PULL_SLOP)return;
      press.moved=true;scrolling.current.pointer=true;
    };
    const end=(event:PointerEvent)=>{
      if(!press||press.id!==event.pointerId)return;
      scrolling.current.pointer=false;
      if(press.moved||event.type==='pointercancel')scrolling.current.userUntil=Date.now()+200;
      else if(event.type==='pointerup'){close();swallowNextClick();}
      press=null;
    };
    const wheel=(event:WheelEvent)=>{if(inList(event.target as Node)&&event.deltaY!==0){scrolling.current.top=listScroller.current!.scrollTop;scrolling.current.userUntil=Date.now()+200;}};
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
      if(inList(event.target as Node)&&['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key))scrolling.current.userUntil=Date.now()+200;
    };
    document.addEventListener('pointerdown',outside,true);document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',end,true);document.addEventListener('pointercancel',end,true);document.addEventListener('wheel',wheel,true);document.addEventListener('keydown',key,true);
    return()=>{openShades.delete(entry);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',end,true);document.removeEventListener('pointercancel',end,true);document.removeEventListener('wheel',wheel,true);document.removeEventListener('keydown',key,true);};
  },[open,close,topBar]);
  // Keyboard: opening from the title moves focus to the current section; closing returns it.
  useEffect(()=>{
    if(open&&focusOnOpen.current){focusOnOpen.current=false;shade.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"]')?.focus();}
    if(!open&&shade.current?.contains(document.activeElement))toggleButton.current?.focus();
  },[open]);
  const toggle=(event:ReactMouseEvent<HTMLButtonElement>)=>{focusOnOpen.current=!open&&event.detail===0;setOpen(value=>!value);};
  const pick=(value:T)=>{scrolling.current.userUntil=0;scrolling.current.pointer=false;bar.onChange(value);};
  const current=bar.options.find(option=>option.value===bar.value)?.label;
  const lifted=away||open;
  return {
    away,open,barRef,
    inline:bar.extra?<div ref={inlineRef} className="section-shade-rows section-shade-rows--inline"><SectionBar placement="inline" fullWidth label={bar.label} options={bar.options} value={bar.value} onChange={bar.onChange} trailing={bar.trailing}/>{bar.extra}</div>:<SectionBar ref={inlineRef} placement="inline" fullWidth label={bar.label} options={bar.options} value={bar.value} onChange={bar.onChange} trailing={bar.trailing}/>,
    shade:lifted?<div className="section-shade-anchor">
      <div ref={shade} id={id} className={`section-shade${open?' is-open':''}${dragging?' is-dragging':''}`} aria-hidden={!open||undefined} inert={!open||undefined}>
        <SectionBar placement="shade" fullWidth label={bar.label} options={bar.options} value={bar.value} onChange={pick} trailing={bar.trailing}/>{bar.extra&&<div className="section-shade-extra" onClick={close}>{bar.extra}</div>}
      </div>
    </div>:null,
    title:base=>lifted
      ?<button ref={toggleButton} type="button" className="section-shade-title" aria-label={current?`${base} · ${current}`:base} aria-expanded={open} aria-controls={id} onClick={toggle}>{base}{current&&<span className="section-shade-title__now">· {current}</span>}<ChevronDownIcon aria-hidden="true"/></button>
      :base,
  };
}
