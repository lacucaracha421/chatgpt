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
