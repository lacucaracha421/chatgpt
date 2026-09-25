import {Bars3Icon,ChevronDownIcon,ChevronRightIcon,PlusIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type PointerEvent} from 'react';
import {byOrder,keyBetween,NOTE_LIMITS,placeInGroup,type ChecklistItem} from '../src/notes/model';

/** Touch hold on the handle before a row starts moving, so a quick swipe still scrolls. */
export const DRAG_HOLD_MS=250;
const EDGE=56;

/**
 * Touch-first checklist editing: 44px checkboxes, Enter adds an item below, Backspace in an
 * empty item removes it, and a long press on the handle drags the row (the page auto-scrolls
 * near the edges). Checked items move into a collapsible 완료 group. A move rewrites only the
 * moved item's order key, as on the PC.
 */
export function NoteChecklist({items,readOnly=false,onChange}:{items:ChecklistItem[];readOnly?:boolean;onChange(items:ChecklistItem[]):void}) {
  const open=items.filter(item=>!item.checked).sort(byOrder);
  const done=items.filter(item=>item.checked).sort(byOrder);
  const [doneOpen,setDoneOpen]=useState(true);
  const [drag,setDrag]=useState<{id:string;index:number}|null>(null);
  const hold=useRef<{timer:ReturnType<typeof setTimeout>;id:string;index:number;pointer:number}|null>(null);
  const scroller=useRef<number|undefined>(undefined);
  const listRef=useRef<HTMLUListElement>(null);
  const focus=useRef<{id:string;caret:'start'|'end'}|null>(null);
  useLayoutEffect(()=>{
    const target=focus.current;if(!target)return;focus.current=null;
    const input=listRef.current?.parentElement?.querySelector<HTMLInputElement>(`input[data-item-id="${target.id}"]`);if(!input)return;
    input.focus();const at=target.caret==='end'?input.value.length:0;input.setSelectionRange(at,at);
  });
  useEffect(()=>()=>{if(hold.current)clearTimeout(hold.current.timer);cancelAnimationFrame(scroller.current??0);},[]);
  const update=(id:string,change:Partial<ChecklistItem>)=>onChange(items.map(item=>item.id===id?{...item,...change}:item));
  function insertAfter(index:number){
    if(items.length>=NOTE_LIMITS.items)return;
    const id=crypto.randomUUID();
    let next=[...items,{id,text:'',checked:false,order:keyBetween(open[open.length-1]?.order??null,null)}];
    const group=[...open.slice(0,index+1),next[next.length-1]!,...open.slice(index+1)];
    next=placeInGroup(next,group,id,index+1);
    focus.current={id,caret:'start'};onChange(next);
  }
  function remove(item:ChecklistItem,focusPrevious:boolean){
    const index=open.findIndex(entry=>entry.id===item.id);const previous=index>0?open[index-1]:open[index+1];
    if(focusPrevious&&previous)focus.current={id:previous.id,caret:'end'};
    onChange(items.filter(entry=>entry.id!==item.id));
  }
  function keyDown(event:KeyboardEvent<HTMLInputElement>,item:ChecklistItem,index:number){
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    if(event.key==='Enter'&&!item.checked){event.preventDefault();insertAfter(index);}
    else if(event.key==='Backspace'&&item.text===''){event.preventDefault();remove(item,true);}
  }
  function dropIndex(clientY:number){
    const rows=[...(listRef.current?.querySelectorAll<HTMLElement>('li[data-row]')??[])];
    const index=rows.findIndex(row=>{const box=row.getBoundingClientRect();return clientY<box.top+box.height/2;});
    return index===-1?rows.length:index;
  }
  /** Scrolls the editor while the finger rests near its top or bottom edge. */
  function autoscroll(clientY:number){
    cancelAnimationFrame(scroller.current??0);
    const pane=listRef.current?.closest<HTMLElement>('.notes-editor');if(!pane)return;
    const box=pane.getBoundingClientRect();
    const speed=clientY<box.top+EDGE?-Math.ceil((box.top+EDGE-clientY)/4):clientY>box.bottom-EDGE?Math.ceil((clientY-box.bottom+EDGE)/4):0;
    if(!speed)return;
    const step=()=>{pane.scrollTop+=speed;scroller.current=requestAnimationFrame(step);};
    scroller.current=requestAnimationFrame(step);
  }
  function pointerDown(event:PointerEvent<HTMLButtonElement>,item:ChecklistItem,index:number){
    if(readOnly||(event.pointerType==='mouse'&&event.button!==0))return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const start=()=>{hold.current=null;navigator.vibrate?.(10);setDrag({id:item.id,index});};
    // A mouse or pen drags at once; a finger holds first.
    if(event.pointerType==='touch'){if(hold.current)clearTimeout(hold.current.timer);hold.current={timer:setTimeout(start,DRAG_HOLD_MS),id:item.id,index,pointer:event.pointerId};}
    else start();
  }
  function pointerMove(event:PointerEvent<HTMLButtonElement>){
    if(!drag)return;
    event.preventDefault();
    setDrag({...drag,index:dropIndex(event.clientY)});autoscroll(event.clientY);
  }
  function pointerEnd(){
    if(hold.current){clearTimeout(hold.current.timer);hold.current=null;}
    cancelAnimationFrame(scroller.current??0);
    if(!drag)return;
    const from=open.findIndex(item=>item.id===drag.id);const to=drag.index>from?drag.index-1:drag.index;
    setDrag(null);
    if(from!==-1&&to!==from)onChange(placeInGroup(items,open,drag.id,to));
  }
  const row=(item:ChecklistItem,index:number,draggable:boolean)=><li key={item.id} data-row={draggable?'':undefined} className={`notes-check${item.checked?' is-checked':''}${drag?.id===item.id?' is-dragging':''}${draggable&&drag&&drag.index===index&&drag.id!==item.id?' is-drop-target':''}`}>
    {draggable&&!readOnly?<button type="button" className="notes-check__handle" aria-label="길게 눌러 끌어서 순서 바꾸기" tabIndex={-1}
      onPointerDown={event=>pointerDown(event,item,index)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={()=>{if(hold.current){clearTimeout(hold.current.timer);hold.current=null;}cancelAnimationFrame(scroller.current??0);setDrag(null);}}
      onContextMenu={event=>event.preventDefault()}><Bars3Icon aria-hidden="true"/></button>:<span className="notes-check__handle" aria-hidden="true"/>}
    <label className="notes-check__box"><input type="checkbox" checked={item.checked} disabled={readOnly} aria-label={`${item.text.trim()||'빈 항목'} 완료`} onChange={event=>update(item.id,{checked:event.currentTarget.checked})}/></label>
    <input className="notes-check__text" data-item-id={item.id} aria-label="체크리스트 항목" value={item.text} readOnly={readOnly} maxLength={NOTE_LIMITS.itemChars} placeholder="항목" enterKeyHint="next"
      onChange={event=>update(item.id,{text:event.currentTarget.value.replace(/[\r\n]+/g,' ')})} onKeyDown={event=>keyDown(event,item,index)}/>
    {!readOnly&&<button type="button" className="notes-check__remove" aria-label="항목 삭제" onClick={()=>remove(item,false)}><XMarkIcon aria-hidden="true"/></button>}
  </li>;
  return <div className="notes-checklist">
    <ul ref={listRef} className="notes-checklist__open" aria-label="할 일">
      {open.map((item,index)=>row(item,index,true))}
      {drag&&drag.index===open.length&&<li className="notes-check__drop-end" aria-hidden="true"/>}
    </ul>
    {!readOnly&&<button type="button" className="notes-checklist__add" disabled={items.length>=NOTE_LIMITS.items} onClick={()=>insertAfter(open.length-1)}><PlusIcon aria-hidden="true"/>항목 추가</button>}
    {done.length>0&&<section className="notes-checklist__done">
      <button type="button" className="notes-checklist__done-toggle" aria-expanded={doneOpen} onClick={()=>setDoneOpen(!doneOpen)}>{doneOpen?<ChevronDownIcon aria-hidden="true"/>:<ChevronRightIcon aria-hidden="true"/>}완료 {done.length}</button>
      {doneOpen&&<ul aria-label="완료한 항목">{done.map((item,index)=>row(item,index,false))}</ul>}
    </section>}
  </div>;
}
