import {useRef,type ChangeEvent,type CompositionEvent,type FocusEvent,type MutableRefObject} from 'react';

/** Room kept between the caret and the visible bottom (the keyboard's top edge). */
const MARGIN=24;
const COPIED=['boxSizing','width','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','textTransform','wordSpacing','textIndent','tabSize'] as const;

/** The caret's top and line height inside a textarea, measured with an invisible copy of its text. */
export function caretOffset(area:HTMLTextAreaElement):{top:number;height:number} {
  const style=getComputedStyle(area);
  const mirror=document.createElement('div');
  for(const key of COPIED)mirror.style[key]=style[key];
  Object.assign(mirror.style,{position:'absolute',visibility:'hidden',top:'0',left:'-9999px',whiteSpace:'pre-wrap',overflowWrap:'break-word',width:`${area.offsetWidth}px`});
  mirror.textContent=area.value.slice(0,area.selectionEnd??area.value.length);
  const mark=document.createElement('span');mark.textContent='​';mirror.append(mark);
  document.body.append(mirror);
  const result={top:mark.offsetTop,height:mark.offsetHeight||parseFloat(style.lineHeight)||20};
  mirror.remove();
  return result;
}

/** Finds the source offset under a tap by measuring the textarea's own wrapping. */
export function caretOffsetAtPoint(area:HTMLTextAreaElement,x:number,y:number):number|null {
  const style=getComputedStyle(area),rect=area.getBoundingClientRect();
  const mirror=document.createElement('div');
  for(const key of COPIED)mirror.style[key]=style[key];
  Object.assign(mirror.style,{position:'fixed',visibility:'hidden',pointerEvents:'none',top:`${rect.top}px`,left:`${rect.left}px`,width:`${rect.width||area.offsetWidth}px`,height:`${rect.height||area.offsetHeight}px`,whiteSpace:'pre-wrap',overflowWrap:'break-word',overflow:'hidden'});
  mirror.textContent=area.value;
  document.body.append(mirror);
  const documentWithCaret=document as Document & {
    caretPositionFromPoint?: (x:number,y:number)=>{offsetNode:Node;offset:number}|null;
    caretRangeFromPoint?: (x:number,y:number)=>Range|null;
  };
  const position=documentWithCaret.caretPositionFromPoint?.(x,y);
  const range=position?null:documentWithCaret.caretRangeFromPoint?.(x,y);
  const node=position?.offsetNode??range?.startContainer;
  const offset=position?.offset??range?.startOffset;
  const text=mirror.firstChild;
  const result=node===text&&offset!==undefined?Math.max(0,Math.min(area.value.length,offset)):null;
  mirror.remove();
  return result;
}

/**
 * Scrolls `pane` so the focused field's caret sits above the keyboard. The note editor calls
 * it when the visible viewport shrinks (the keyboard opened) and while typing, so the line
 * being written stays in view instead of hiding under the keyboard.
 */
export function revealCaret(pane:HTMLElement|null) {
  const field=document.activeElement;
  if(!pane||!(field instanceof HTMLElement)||!pane.contains(field))return;
  const box=pane.getBoundingClientRect();
  let top:number,bottom:number;
  if(field instanceof HTMLTextAreaElement){
    const caret=caretOffset(field);const area=field.getBoundingClientRect();
    top=area.top+caret.top-field.scrollTop;bottom=top+caret.height;
  }else{const rect=field.getBoundingClientRect();top=rect.top;bottom=rect.bottom;}
  if(bottom>box.bottom-MARGIN)pane.scrollTop+=bottom-(box.bottom-MARGIN);
  else if(top<box.top+MARGIN)pane.scrollTop-=box.top+MARGIN-top;
}

type NoteField=HTMLInputElement|HTMLTextAreaElement;
/** The focused DOM owns its text. Save acknowledgements only update unfocused fields;
 * composition commits once, after the IME has finished its syllable. */
export function useNoteEditor(){
  const composing=useRef(new WeakSet<NoteField>());
  const committed=useRef(new WeakMap<NoteField,string>());
  const isComposing=(field:NoteField)=>composing.current.has(field);
  function bind(value:string,change:(value:string)=>void,externalRef?:MutableRefObject<NoteField|null>){
    const commit=(field:NoteField)=>{if(committed.current.get(field)===field.value)return;committed.current.set(field,field.value);change(field.value);};
    return {
      ref:(field:NoteField|null)=>{
        if(externalRef)externalRef.current=field;
        if(!field||isComposing(field)||document.activeElement===field)return;
        if(field.value!==value)field.value=value;
        committed.current.set(field,value);
      },
      onChange:(event:ChangeEvent<NoteField>)=>{if(!isComposing(event.currentTarget)&&!(event.nativeEvent as InputEvent).isComposing)commit(event.currentTarget);},
      onCompositionStart:(event:CompositionEvent<NoteField>)=>{composing.current.add(event.currentTarget);},
      onCompositionEnd:(event:CompositionEvent<NoteField>)=>{composing.current.delete(event.currentTarget);commit(event.currentTarget);},
      onBlur:(event:FocusEvent<NoteField>)=>{if(!isComposing(event.currentTarget))commit(event.currentTarget);},
    };
  }
  return {bind,isComposing};
}

export function focusNoteEnd(field:NoteField|null){
  if(!field)return;
  field.focus();field.setSelectionRange(field.value.length,field.value.length);
}
