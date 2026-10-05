import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import type {Asset} from './types';

// The real virtualizer, with a scroller whose size the test controls: a retained tab hidden
// with display:none reports a zero-size box until it is shown again.
let hidden=false;
const observers:{callback:ResizeObserverCallback;target?:Element}[]=[];
beforeEach(()=>{
  hidden=false;observers.length=0;
  vi.stubGlobal('ResizeObserver',class {
    entry:{callback:ResizeObserverCallback;target?:Element};
    constructor(callback:ResizeObserverCallback){this.entry={callback};observers.push(this.entry);}
    observe(target:Element){this.entry.target=target;}
    unobserve(){}
    disconnect(){}
  });
  for(const [name,size] of [['offsetHeight',1000],['offsetWidth',632],['clientHeight',1000],['clientWidth',632]] as const)
    Object.defineProperty(HTMLElement.prototype,name,{configurable:true,get(){return hidden?0:size;}});
});
afterEach(()=>{
  cleanup();vi.unstubAllGlobals();
  for(const name of ['offsetHeight','offsetWidth','clientHeight','clientWidth'])delete (HTMLElement.prototype as unknown as Record<string,unknown>)[name];
});
const resize=()=>act(()=>{for(const entry of observers)if(entry.target){const size=hidden?0:(entry.target as HTMLElement).offsetHeight;entry.callback([{target:entry.target,borderBoxSize:[{inlineSize:hidden?0:632,blockSize:size}]} as unknown as ResizeObserverEntry],{} as ResizeObserver);}});

it('keeps every tile and its image element while the retained tab is hidden and shown again',()=>{
  const items:Asset[]=Array.from({length:60},(_,index)=>({id:`asset-${index}`,kind:'image',preview:`https://example.invalid/${index}.webp`,width:600,height:600}));
  render(<Gallery items={items} density={1} identity="all" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false}/>);
  resize();
  const before=[...document.querySelectorAll<HTMLImageElement>('.tile-picture img')];
  expect(before.length).toBeGreaterThan(9);
  hidden=true;resize();
  hidden=false;resize();
  const after=[...document.querySelectorAll<HTMLImageElement>('.tile-picture img')];
  expect(after.map(image=>image.src)).toEqual(before.map(image=>image.src));
  // The same elements: nothing was unmounted, so nothing has to decode again.
  after.forEach((image,index)=>expect(image).toBe(before[index]));
});

it('publishes a segment offset before paint and renders the clamped viewport of a shorter list',()=>{
  const items=(prefix:string,count:number):Asset[]=>Array.from({length:count},(_,index)=>({id:`${prefix}-${index}`,kind:'image',preview:`https://example.invalid/${prefix}/${index}.webp`,width:600,height:600}));
  const onScroll=vi.fn();
  const props={density:1,restoreScroll:0,onScroll,onOpen:()=>{},onReady:()=>{},onNearEnd:()=>{},paused:false,folderScope:'series',folderPath:['series']};
  const view=render(<Gallery {...props} identity="unclassified" items={items('old',200)}/>);
  resize();
  const scroll=document.querySelector<HTMLElement>('.gallery-scroll')!;
  scroll.scrollTop=10000;fireEvent.scroll(scroll);
  view.rerender(<Gallery {...props} restoreScroll={10000} identity="all" items={items('new',60)}/>);
  const height=Number.parseFloat(scroll.querySelector<HTMLElement>('.gallery-canvas')!.style.height);
  expect(scroll.scrollTop).toBe(Math.max(0,height-1000));
  expect(onScroll).toHaveBeenLastCalledWith(scroll.scrollTop);
  // No native scroll event is dispatched after replacement: virtualization must already
  // paint rows intersecting the corrected viewport, rather than leave a blank band.
  const rows=[...scroll.querySelectorAll<HTMLElement>('[data-gallery-row]')];
  expect(rows.some(row=>{
    const top=Number.parseFloat(row.style.transform.slice('translateY('.length));
    return top<scroll.scrollTop+1000&&top+Number.parseFloat(row.style.height)>scroll.scrollTop;
  })).toBe(true);
  expect(scroll.dataset.folderMove).toBeUndefined();
  view.rerender(<Gallery {...props} restoreScroll={scroll.scrollTop} identity="unclassified" items={items('short',1)}/>);
  expect(scroll.scrollTop).toBe(0);
  expect(scroll.querySelector('[data-asset-id="short-0"]')).not.toBeNull();
});
