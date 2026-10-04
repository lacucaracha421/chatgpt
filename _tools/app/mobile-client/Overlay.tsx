import {useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
import {layerEnterTime} from './motion';
import {motionDefaults,motionSpring,motionTime,prefersReducedMotion} from '../src/shared/motion/curves';
import './overlay.css';

/** How long the sheet takes to slide back down (0.7× its rise), or the reduced-motion fade. */
const exitTime=(node:Element)=>prefersReducedMotion()?motionTime('--motion-micro',motionDefaults.micro,node):motionSpring('gentle',node).duration*.7;

/** A tall tablet sheet. Its scrolling children stay mounted while a work covers it.
 * The owner handles system Back, so a nested work or dialog consumes it first.
 *
 * Motion: opening rises the sheet from the bottom edge on the gentle spring while the dim area
 * fades in; closing slides it back down and fades the dim area in about 0.7× that time, without
 * taking input. Both are transitions, so a quick reopen or close reverses from where it is. A
 * work covering the sheet hides it at once, and uncovering shows it in place: the rise plays only
 * when the sheet opens. */
export function Overlay({open,covered=false,title,count,onClose,children,deferContent=false}:{open:boolean;covered?:boolean;title:string;count?:number;onClose():void;children:ReactNode|((ready:boolean)=>ReactNode);deferContent?:boolean}) {
  const id=useId(),host=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null);
  const visible=open&&!covered;
  // A closed sheet stays painted while it slides down; covering ends that at once.
  const [leaving,setLeaving]=useState(false);
  const previous=useRef({open:false,visible:false});
  useLayoutEffect(()=>{
    const before=previous.current;previous.current={open,visible};
    const element=host.current;
    if(visible){
      setLeaving(false);
      // Only an opening rises: a sheet returning from under a work shows in place, and one
      // reopened while it was still leaving turns back from where it is.
      if(before.open||leaving||!element)return;
      element.dataset.entering='';
      // Establish the starting position before the first paint, then let it transition.
      for(const part of [element,...element.children])void getComputedStyle(part).translate;
      const frame=requestAnimationFrame(()=>{delete element.dataset.entering;});
      return()=>{cancelAnimationFrame(frame);delete element.dataset.entering;};
    }
    if(!before.visible||covered||!element){setLeaving(false);return;}
    setLeaving(true);
    const timer=window.setTimeout(()=>setLeaving(false),exitTime(element));
    return()=>window.clearTimeout(timer);
  },[open,visible]);// eslint-disable-line react-hooks/exhaustive-deps
  const [entered,setEntered]=useState(false);
  useEffect(()=>{
    if(!open){setEntered(false);return;}
    if(!deferContent||entered||!visible)return;
    if(prefersReducedMotion()){setEntered(true);return;}
    // transitionend is authoritative; the fallback handles absent/disabled CSS transitions.
    const timer=window.setTimeout(()=>setEntered(true),layerEnterTime()+50);
    const panelElement=panel.current;
    const end=(event:TransitionEvent)=>{if(event.target===panelElement&&event.propertyName==='translate')setEntered(true);};
    panelElement?.addEventListener('transitionend',end);
    return()=>{window.clearTimeout(timer);panelElement?.removeEventListener('transitionend',end);};
  },[open,visible,deferContent,entered]);
  const drag=useRef<{id:number;x:number;y:number}|null>(null);
  useEffect(()=>{
    if(open)opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    else if(opener.current?.isConnected&&!opener.current.closest('[inert]'))opener.current.focus({preventScroll:true});
  },[open]);
  useEffect(()=>{
    if(!visible)return;
    panel.current?.querySelector<HTMLElement>('button')?.focus({preventScroll:true});
    // Keep keyboard focus on this surface, including when the bottom navigation is outside
    // Collections. Dialogs opened by its content keep their own focus handling.
    const key=(event:KeyboardEvent)=>{
      const host=panel.current;
      if(event.key!=='Tab'||!host||!host.contains(document.activeElement))return;
      const targets=Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(element=>!element.closest('[inert],[hidden],[style*="display: none"]'));
      const first=targets[0],last=targets[targets.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',key);
    return()=>document.removeEventListener('keydown',key);
  },[visible]);
  const down=(event:PointerEvent<HTMLElement>)=>{
    if(event.isPrimary===false||event.button>0||(event.target as HTMLElement).closest('button'))return;
    drag.current={id:event.pointerId,x:event.clientX,y:event.clientY};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const end=(event:PointerEvent<HTMLElement>)=>{
    const from=drag.current;if(!from||from.id!==event.pointerId)return;
    drag.current=null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const dy=event.clientY-from.y,dx=Math.abs(event.clientX-from.x);
    if(event.type==='pointerup'&&dy>=64&&dy>dx)onClose();
  };
  return <div ref={host} className="mobile-overlay" data-state={visible?'open':'closed'} style={{display:visible||leaving?undefined:'none'}} aria-hidden={!visible||undefined} inert={!visible||undefined}>
    <div className="mobile-overlay__scrim" onClick={onClose}/>
    <div ref={panel} className="mobile-overlay__panel" role="dialog" aria-modal="true" aria-labelledby={id}>
      <div className="mobile-overlay__header" onPointerDown={down} onPointerUp={end} onPointerCancel={end}>
        <div className="mobile-overlay__grab" aria-hidden="true"/>
        <div className="mobile-overlay__title-row"><h2 id={id}>{title}</h2>{count!=null&&<span className="numeric muted">{count.toLocaleString()}</span>}<IconButton label={`${title} 닫기`} icon={XMarkIcon} onClick={onClose}/></div>
      </div>
      <div className="mobile-overlay__body">{typeof children==='function'?children(!deferContent||entered):children}</div>
    </div>
  </div>;
}
