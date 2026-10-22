import {useEffect,useState} from 'react';

/** Height the window must lose, with a text field focused, to count as a soft keyboard. */
const KEYBOARD_MIN_HEIGHT=120;
const NON_TEXT_INPUTS=new Set(['button','checkbox','color','file','image','radio','range','reset','submit']);

function textFieldFocused(){
  const element=document.activeElement;
  if(element instanceof HTMLTextAreaElement)return !element.readOnly;
  if(element instanceof HTMLInputElement)return !element.readOnly&&!NON_TEXT_INPUTS.has(element.type);
  return element instanceof HTMLElement&&element.isContentEditable;
}

/**
 * Whether the Android soft keyboard is open. The native host pads the WebView by the IME inset
 * (MainActivity), so an open keyboard shows up as a much shorter window while a text field has
 * focus; a hardware keyboard leaves the height alone. The tallest height is remembered per window
 * width so rotating the tablet starts a new baseline.
 */
export function useSoftKeyboardOpen(){
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    const viewport=window.visualViewport;
    let width=window.innerWidth,tallest=0,frame=0;
    const height=()=>Math.min(window.innerHeight,viewport&&viewport.scale===1?viewport.height:Infinity);
    const update=()=>{
      frame=0;
      const current=height();
      if(window.innerWidth!==width){width=window.innerWidth;tallest=current;}
      tallest=Math.max(tallest,current);
      setOpen(textFieldFocused()&&tallest-current>=KEYBOARD_MIN_HEIGHT);
    };
    // Focus moves before the keyboard finishes resizing the window; check again on the next frame.
    const later=()=>{if(!frame)frame=requestAnimationFrame(update);};
    update();
    viewport?.addEventListener('resize',later);
    window.addEventListener('resize',later);
    document.addEventListener('focusin',later);
    document.addEventListener('focusout',later);
    return()=>{
      if(frame)cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize',later);
      window.removeEventListener('resize',later);
      document.removeEventListener('focusin',later);
      document.removeEventListener('focusout',later);
    };
  },[]);
  return open;
}
