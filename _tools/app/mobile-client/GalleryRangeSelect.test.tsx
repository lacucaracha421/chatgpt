import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
 const sizes=Array.from({length:count},(_,i)=>estimateSize(i));
 return {measure(){},getTotalSize:()=>sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>sizes.map((_size,index)=>({key:index,index,start:sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));

const items=Array.from({length:6},(_,index)=>({id:`t${index}`,kind:'image',preview:'data:image/png;base64,AA',width:600,height:600}));
let probe:Record<number,string>={};
const originalProbe=document.elementFromPoint;
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.useFakeTimers();
  // The tile under the finger: x is the tile index times 100.
  document.elementFromPoint=((x:number)=>document.querySelector(`[data-asset-id="${probe[Math.floor(x/100)]}"]`)) as typeof document.elementFromPoint;
  probe=Object.fromEntries(items.map((item,index)=>[index,item.id]));
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();document.elementFromPoint=originalProbe;});

function Host({initial=[]}:{initial?:string[]}){
  const [ids,setIds]=useState<ReadonlySet<string>>(new Set(initial));
  return <Gallery items={items} density={1} identity="range" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false}
    selectedIds={ids} onSelectAsset={id=>setIds(current=>new Set(current).add(id))} onToggleSelection={()=>{}} onReplaceSelection={setIds}/>;
}
const tile=(id:string)=>document.querySelector<HTMLElement>(`[data-asset-id="${id}"]`)!;
const selected=()=>items.filter(item=>tile(item.id).getAttribute('aria-selected')==='true').map(item=>item.id);
const hold=(id:string,x:number)=>{fireEvent.pointerDown(tile(id),{pointerType:'touch',pointerId:7,clientX:x,clientY:10});act(()=>{vi.advanceTimersByTime(450);});};
const drag=(x:number,y=10)=>act(()=>{fireEvent.pointerMove(window,{pointerType:'touch',pointerId:7,clientX:x,clientY:y});});

it('selects the run of tiles between the hold and the finger, and shrinks it when the finger returns',()=>{
  render(<Host/>);
  hold('t1',150);
  expect(selected()).toEqual(['t1']);
  drag(350);
  expect(selected()).toEqual(['t1','t2','t3']);
  drag(250);
  expect(selected()).toEqual(['t1','t2']);
  // Dragging above the start tile selects backwards in list order.
  drag(50);
  expect(selected()).toEqual(['t0','t1']);
  fireEvent.pointerUp(window,{pointerId:7});
  drag(450);
  expect(selected()).toEqual(['t0','t1']);
});

it('keeps what was selected before the drag when adding a run',()=>{
  render(<Host initial={['t5']}/>);
  hold('t1',150);
  drag(250);
  expect(selected()).toEqual(['t1','t2','t5']);
});

it('starting on a selected tile removes the run instead',()=>{
  render(<Host initial={['t0','t1','t2','t3']}/>);
  hold('t2',250);
  expect(selected()).toEqual(['t0','t1','t3']);
  drag(350);
  expect(selected()).toEqual(['t0','t1']);
  drag(50);
  expect(selected()).toEqual(['t3']);
});

it('locks scrolling while the finger is down after the hold and frees it afterwards',()=>{
  render(<Host/>);
  const move=()=>{const event=new Event('touchmove',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;};
  expect(move()).toBe(false);
  hold('t1',150);
  expect(move()).toBe(true);
  fireEvent.pointerUp(window,{pointerId:7});
  expect(move()).toBe(false);
});

it('scrolls itself within 96 px of the top or bottom edge, faster deeper in, and not elsewhere',()=>{
  render(<Host/>);
  const scroller=screen.getByLabelText('자산 목록');
  scroller.getBoundingClientRect=()=>({top:0,bottom:600,left:0,right:800,width:800,height:600,x:0,y:0,toJSON(){}}) as DOMRect;
  scroller.scrollTop=300;
  hold('t1',150);
  const frames=(count:number)=>act(()=>{vi.advanceTimersByTime(count*16);});
  drag(150,300);frames(5);
  expect(scroller.scrollTop).toBe(300);
  drag(150,590);frames(1);
  const nearBottom=scroller.scrollTop;
  expect(nearBottom).toBeGreaterThan(300);
  drag(150,520);frames(1);
  const shallow=scroller.scrollTop-nearBottom;
  expect(shallow).toBeGreaterThan(0);
  expect(shallow).toBeLessThan(nearBottom-300);
  scroller.scrollTop=300;
  drag(150,4);frames(2);
  expect(scroller.scrollTop).toBeLessThan(300);
  const stopped=scroller.scrollTop;
  fireEvent.pointerUp(window,{pointerId:7});frames(5);
  expect(scroller.scrollTop).toBe(stopped);
});
