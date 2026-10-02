import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import {CatalogCover} from './CatalogCover';
import * as catalogMedia from './catalogMedia';
import {ARRIVE_MS} from './motion';
import type {Asset} from './types';
const measured=vi.hoisted(()=>({sizes:[] as number[]}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
 measured.sizes=Array.from({length:count},(_,i)=>estimateSize(i));
 return {measure(){},getTotalSize:()=>measured.sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>measured.sizes.map((_size,index)=>({key:index,index,start:measured.sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));

const animate=vi.fn();
beforeEach(()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 animate.mockReset();
 (HTMLElement.prototype as unknown as {animate:unknown}).animate=function(this:HTMLElement,...args:unknown[]){animate(this,...args);};
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});

const asset=(id:string):Asset=>({id,kind:'image',preview:`data:image/png;base64,${id}`,width:600,height:800});
const tile=(id:string)=>document.querySelector(`[data-asset-id="${id}"]`) as HTMLElement;
const gallery=(items:Asset[],identity='all',stale=false)=><Gallery items={items} density={1} identity={identity} restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false} stale={stale} vault={{label:item=>`항목 ${item.id}`}}/>;
const tileAnimations=(id:string)=>animate.mock.calls.filter(([element])=>element===tile(id));
async function load(id:string){fireEvent.load(tile(id).querySelector('img')!);await act(async()=>{});}

it('shows appended tiles in place without a content entrance animation',async()=>{
 const first=[asset('a'),asset('b')];
 const view=render(gallery(first));
 const original=tile('a');
 view.rerender(gallery([...first,asset('c'),asset('d')]));
 expect(tile('a')).toBe(original);
 expect(tile('c').style.opacity).not.toBe('0');
 expect(tile('d').style.opacity).not.toBe('0');
 await load('c');
 expect(animate).not.toHaveBeenCalled();
 expect(tileAnimations('c')).toHaveLength(0);
});

it('does not animate the first page, a new place or anything under reduced motion',async()=>{
 const view=render(gallery([asset('a')]));
 view.rerender(gallery([asset('x'),asset('y')],'other'));
 expect(tile('y').style.opacity).not.toBe('0');
 expect(animate.mock.calls.filter(([element])=>(element as HTMLElement).classList.contains('media-tile'))).toHaveLength(0);
 cleanup();
 vi.stubGlobal('matchMedia',(query:string)=>({matches:query.includes('reduce'),media:query,addEventListener(){},removeEventListener(){}}));
 const reduced=render(gallery([asset('a')]));
 reduced.rerender(gallery([asset('a'),asset('b')]));
 expect(tile('b').style.opacity).not.toBe('0');
 expect(tile('b').querySelector('img')!.style.opacity).not.toBe('0');
 await load('b');
 expect(animate).not.toHaveBeenCalled();
});

it('keeps a stale list mounted and does not arrive ready thumbnails on replacement',()=>{
 const complete=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'complete');
 const naturalWidth=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'naturalWidth');
 const naturalHeight=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'naturalHeight');
 Object.defineProperty(HTMLImageElement.prototype,'complete',{configurable:true,value:true});
 Object.defineProperty(HTMLImageElement.prototype,'naturalWidth',{configurable:true,value:600});
 Object.defineProperty(HTMLImageElement.prototype,'naturalHeight',{configurable:true,value:800});
 try {
   const first=[asset('a'),asset('b')];
   const view=render(gallery(first));
   view.rerender(gallery(first,'all',true));
   expect(tile('a')).toBeTruthy();
   expect(screen.getByLabelText('자산 목록').hasAttribute('inert')).toBe(true);
   view.rerender(gallery([asset('x'),asset('y')],'replacement'));
   expect(document.querySelector('[data-asset-id="a"]')).toBeNull();
   expect(tile('x').style.opacity).not.toBe('0');
   expect(tileAnimations('x')).toHaveLength(0);
 } finally {
   if(complete)Object.defineProperty(HTMLImageElement.prototype,'complete',complete);else delete (HTMLImageElement.prototype as {complete?:unknown}).complete;
   if(naturalWidth)Object.defineProperty(HTMLImageElement.prototype,'naturalWidth',naturalWidth);else delete (HTMLImageElement.prototype as {naturalWidth?:unknown}).naturalWidth;
   if(naturalHeight)Object.defineProperty(HTMLImageElement.prototype,'naturalHeight',naturalHeight);else delete (HTMLImageElement.prototype as {naturalHeight?:unknown}).naturalHeight;
 }
});

it('keeps slow thumbnails and decoded images in place without fading',async()=>{
 const view=render(gallery([asset('a')]));
 view.rerender(gallery([asset('a'),asset('b')]));
 const image=tile('b').querySelector('img')!;
 expect(tile('b').style.opacity).not.toBe('0');
 expect(image.style.opacity).not.toBe('0');
 await load('b');
 expect(animate).not.toHaveBeenCalled();
});

it('fades a catalog cover in once it decodes, in its already sized box',async()=>{
 vi.stubGlobal('IntersectionObserver',class{constructor(private callback:(entries:{isIntersecting:boolean}[])=>void){} observe(){this.callback([{isIntersecting:true}]);} disconnect(){}});
 vi.spyOn(catalogMedia,'catalogImageTicket').mockResolvedValue({url:'data:image/png;base64,AA'} as Awaited<ReturnType<typeof catalogMedia.catalogImageTicket>>);
 render(<CatalogCover item={{provider:'p',providerWorkId:'w',thumbnailUrl:'https://example.test/c.jpg'}} revision="r" active/>);
 await act(async()=>{});
 const image=document.querySelector('.catalog-cover-image img') as HTMLImageElement;
 expect(image.style.opacity).toBe('0');
 fireEvent.load(image);
 await act(async()=>{});
 expect(image.style.opacity).toBe('');
 expect(animate.mock.calls.filter(([element])=>element===image)).toHaveLength(1);
});
