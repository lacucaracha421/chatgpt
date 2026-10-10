import './transport';
import {perfEnabled} from './perfEnabled';

const DECODED='lakomics-catalog-cover-decoded';
let sequence=0;
export const catalogPerfEnabled=perfEnabled;
export function catalogCoverDecoded(host:HTMLElement){
  host.dataset.catalogDecoded='true';
  if(catalogPerfEnabled())host.dispatchEvent(new Event(DECODED,{bubbles:true}));
}

/** Freeze the visible cohort when the list is shown; preloads never inflate the denominator. */
export function catalogScreenTiming(root:HTMLElement){
  if(!catalogPerfEnabled())return ()=>{};
  const start=performance.now(),screen=`catalog-screen-${++sequence}`,bounds=root.getBoundingClientRect();
  const targets=new Set(Array.from(root.querySelectorAll<HTMLElement>('[data-catalog-cover]')).filter(host=>{
    const box=host.getBoundingClientRect();
    return box.width>0&&box.height>0&&box.bottom>bounds.top&&box.top<bounds.bottom&&box.right>bounds.left&&box.left<bounds.right;
  }));
  if(!targets.size)return ()=>{};
  const loaded=new Set<HTMLElement>();
  let firstMs:number|null=null,ninetyMs:number|null=null,done=false;
  const log=()=>{
    if(done)return;done=true;
    root.removeEventListener(DECODED,decoded);
    const payload={event:'catalog_screen',screen,visible:targets.size,loaded:loaded.size,firstCoverMs:firstMs??-1,visible90Ms:ninetyMs??-1,status:ninetyMs===null?'incomplete':'ok'};
    try{window.LakomicsNative?.request('','perfLog',JSON.stringify(payload));}catch{/* Best effort. */}
  };
  const record=(host:HTMLElement)=>{
    if(!targets.has(host)||loaded.has(host))return;
    loaded.add(host);const elapsed=performance.now()-start;
    firstMs??=elapsed;
    if(loaded.size>=Math.ceil(targets.size*0.9)){ninetyMs=elapsed;log();}
  };
  const decoded=(event:Event)=>{if(event.target instanceof HTMLElement)record(event.target);};
  root.addEventListener(DECODED,decoded);
  for(const host of targets)if(host.dataset.catalogDecoded==='true')record(host);
  return log;
}
