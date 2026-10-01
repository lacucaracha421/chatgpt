import {useEffect, useId, useRef, type PointerEvent, type ReactNode} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
import './overlay.css';

/** A tall tablet sheet. Its scrolling children stay mounted while a work covers it.
 * The owner handles system Back, so a nested work or dialog consumes it first. */
export function Overlay({open,covered=false,title,count,onClose,children}:{open:boolean;covered?:boolean;title:string;count?:number;onClose():void;children:ReactNode}) {
  const id=useId(),panel=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null);
  const visible=open&&!covered;
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
  return <div className="mobile-overlay" style={{display:visible?undefined:'none'}} aria-hidden={!visible||undefined} inert={!visible||undefined}>
    <div className="mobile-overlay__scrim" onClick={onClose}/>
    <div ref={panel} className="mobile-overlay__panel" role="dialog" aria-modal="true" aria-labelledby={id}>
      <div className="mobile-overlay__header" onPointerDown={down} onPointerUp={end} onPointerCancel={end}>
        <div className="mobile-overlay__grab" aria-hidden="true"/>
        <div className="mobile-overlay__title-row"><h2 id={id}>{title}</h2>{count!=null&&<span className="numeric muted">{count.toLocaleString()}</span>}<IconButton label={`${title} 닫기`} icon={XMarkIcon} onClick={onClose}/></div>
      </div>
      <div className="mobile-overlay__body">{children}</div>
    </div>
  </div>;
}
