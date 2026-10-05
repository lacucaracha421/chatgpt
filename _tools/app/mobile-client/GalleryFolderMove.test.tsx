import {act,cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import type {Asset} from './types';
const measured=vi.hoisted(()=>({sizes:[] as number[]}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
 measured.sizes=Array.from({length:count},(_,i)=>estimateSize(i));
 return {measure(){},getTotalSize:()=>measured.sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>measured.sizes.map((_size,index)=>({key:index,index,start:measured.sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));

// The tablet gallery uses the PC's FolderMove (src/assets/FolderWave.tsx) for folder to folder.
const animate=vi.fn((_frames:Keyframe[],_options:KeyframeAnimationOptions)=>({cancel:vi.fn(),onfinish:null as (()=>void)|null}));
const box=(width:number,height:number)=>({left:0,top:0,right:width,bottom:height,width,height,x:0,y:0,toJSON:()=>({})});
beforeEach(()=>{
 vi.useFakeTimers();
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(box(400,300) as DOMRect);
 vi.spyOn(HTMLImageElement.prototype,'complete','get').mockReturnValue(true);
 vi.spyOn(HTMLImageElement.prototype,'naturalWidth','get').mockReturnValue(200);
});
afterEach(()=>{cleanup();animate.mockClear();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});

const asset=(id:string):Asset=>({id,kind:'image',preview:`data:image/png;base64,${id}`,width:600,height:800});
const gallery=(scope:string,ids:string[],path=[scope])=><Gallery items={ids.map(asset)} folderScope={scope} folderPath={path} density={1} identity={`${scope}:${ids.join()}`} restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false} vault={{label:item=>`항목 ${item.id}`}}/>;
const tick=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
const host=()=>document.querySelector<HTMLElement>('.gallery-scroll')!;

it.each([[['a'],['a','b']],[['a','b'],['a']]] as const)('keeps the old folder on screen, then shows the new one in one step without animation (%j → %j)',async(from,to)=>{
 const view=render(gallery(from.at(-1)!,['old-1','old-2'],[...from]));
 await tick(1000);animate.mockClear();
 view.rerender(gallery(to.at(-1)!,['new-1'],[...to]));
 // Old decoded images stay painted while the new tiles wait hidden for their first viewport.
 expect(host().dataset.folderMove).toBe('pending');
 expect(host().querySelectorAll('.asset-gallery__folder-snapshot img')).toHaveLength(2);
 await tick(40);
 expect(host().querySelector('.asset-gallery__folder-snapshot')).toBeNull();
 expect(host().dataset.folderMove).toBeUndefined();
 await tick(200);
 expect(animate).not.toHaveBeenCalled();
});

it('does not move folders for a filter or paging change inside the same place',async()=>{
 const view=render(gallery('a',['old-1']));
 await tick(1000);animate.mockClear();
 view.rerender(gallery('a',['old-1','old-2']));
 expect(host().querySelector('.asset-gallery__folder-snapshot')).toBeNull();
 expect(host().dataset.folderMove).toBeUndefined();
});

it('swaps in a place reached with nothing on screen to move from without the first-batch entrance (user 2026-10-05)',async()=>{
 const rises=()=>animate.mock.calls.filter((call,i)=>(animate.mock.contexts[i] as unknown as HTMLElement).matches('[data-asset-id]')&&(call[0][0] as Keyframe).transform==='translateY(8px) scale(.98)').length;
 const view=render(gallery('a',['first']));
 await tick(1000);
 view.rerender(gallery('b',[],['b']));
 await tick(1000);animate.mockClear();
 view.rerender(gallery('c',['new-1','new-2'],['c']));
 expect(host().querySelector('.asset-gallery__folder-snapshot')).toBeNull();
 await tick(100);
 expect(rises()).toBe(0);
 // From shown tiles the folder move owns the arrival; the first batch is not replayed.
 await tick(1000);animate.mockClear();
 view.rerender(gallery('d',['next-1'],['d']));
 expect(host().dataset.folderMove).toBe('pending');
 expect(rises()).toBe(0);
});
