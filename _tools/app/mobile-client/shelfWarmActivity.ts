/** Visible artwork takes priority over the shelf's speculative transfers. */
export const SHELF_ACTIVITY='lakomics-shelf-activity';
let foreground=0;
export const shelfForegroundBusy=()=>foreground>0;
export function beginShelfForeground() {
  foreground++;
  window.dispatchEvent(new Event(SHELF_ACTIVITY));
  let done=false;
  return ()=>{if(done)return;done=true;foreground--;window.dispatchEvent(new Event(SHELF_ACTIVITY));};
}
