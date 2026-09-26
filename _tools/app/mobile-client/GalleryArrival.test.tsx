import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import {CatalogCover} from './CatalogCover';
import * as catalogMedia from './catalogMedia';
import {ARRIVE_MS,ARRIVE_WAIT_MS} from './motion';
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
const gallery=(items:Asset[],identity='all')=><Gallery items={items} density={1} identity={identity} restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false} vault={{label:item=>`항목 ${item.id}`}}/>;
const tileAnimations=(id:string)=>animate.mock.calls.filter(([element])=>element===tile(id));
async function load(id:string){fireEvent.load(tile(id).querySelector('img')!);await act(async()=>{});}

it('holds appended tiles until their thumbnail decodes, then rises them in once',async()=>{
 const first=[asset('a'),asset('b')];
 const view=render(gallery(first));
 expect(tile('a').style.opacity).not.toBe('0');
 const more=[...first,asset('c'),asset('d')];
 view.rerender(gallery(more));
 expect(tile('c').style.opacity).toBe('0');
 expect(tile('d').style.opacity).toBe('0');
 await load('c');
 expect(tile('c').style.opacity).toBe('');
 expect(tileAnimations('c')).toHaveLength(1);
 const [,frames,options]=tileAnimations('c')[0] as [HTMLElement,Keyframe[],KeyframeAnimationOptions];
 expect(frames[0]).toMatchObject({opacity:0,transform:expect.stringContaining('translateY')});
 expect(options.duration).toBe(ARRIVE_MS);
 expect(ARRIVE_MS).toBeLessThanOrEqual(180);
 // Loading again or re-rendering the same list never replays it.
 await load('c');
 view.rerender(gallery([...more]));
 expect(tile('c').style.opacity).toBe('');
 expect(tileAnimations('c')).toHaveLength(1);
 expect(screen.getByRole('button',{name:'항목 d'}).style.opacity).toBe('0');
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

it('shows an appended tile whose thumbnail is slow after a short wait, then fades the image in',async()=>{
 vi.useFakeTimers();
 const view=render(gallery([asset('a')]));
 view.rerender(gallery([asset('a'),asset('b')]));
 expect(tile('b').style.opacity).toBe('0');
 act(()=>{vi.advanceTimersByTime(ARRIVE_WAIT_MS);});
 expect(tile('b').style.opacity).toBe('');
 expect(tileAnimations('b')).toHaveLength(1);
 const image=tile('b').querySelector('img')!;
 // jsdom never decodes, so the image counts as not ready and waits for its own fade.
 expect(image.style.opacity).toBe('0');
 fireEvent.load(image);
 await act(async()=>{await Promise.resolve();});
 expect(image.style.opacity).toBe('');
 expect(animate.mock.calls.filter(([element])=>element===image)).toHaveLength(1);
 expect(tileAnimations('b')).toHaveLength(1);
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
