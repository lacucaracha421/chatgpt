import {useRef, type PointerEvent, type ReactNode} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {Button,Dialog,DialogDescription} from './ui';
export function BottomSheet({title,onClose,children,headerActions,tall=false,stacked=false}:{title:string;onClose():void;children:ReactNode;headerActions?:ReactNode;tall?:boolean;stacked?:boolean}) {
  const drag=useRef<{id:number;x:number;y:number}|null>(null);
  const down=(event:PointerEvent<HTMLDivElement>)=>{
    if(event.isPrimary===false||event.button>0)return;
    drag.current={id:event.pointerId,x:event.clientX,y:event.clientY};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const end=(event:PointerEvent<HTMLDivElement>)=>{
    const from=drag.current;if(!from||from.id!==event.pointerId)return;
    drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId);
    const dy=event.clientY-from.y;
    if(event.type==='pointerup'&&dy>=64&&dy>Math.abs(event.clientX-from.x))onClose();
  };
  return <Dialog open title={title} onClose={onClose}><DialogDescription className="sr-only">옵션을 선택하면 적용됩니다.</DialogDescription><div className={`library-sheet${tall?' library-sheet--tall':''}${stacked?' library-sheet--stacked':''}`}>
    {tall&&<><div className="bottom-sheet-drag-area" onPointerDown={down} onPointerUp={end} onPointerCancel={end}><span aria-hidden="true"/></div><div className="bottom-sheet-header-actions">{headerActions}<Button variant="ghost" aria-label={`${title} 닫기`} onClick={onClose}><XMarkIcon aria-hidden="true"/></Button></div></>}
    {children}{!tall&&<Button variant="ghost" onClick={onClose}>닫기</Button>}
  </div></Dialog>;
}
