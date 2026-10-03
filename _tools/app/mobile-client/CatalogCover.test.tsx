import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CatalogCover} from './CatalogCover';
const mocks=vi.hoisted(()=>({ticket:vi.fn()}));
vi.mock('./catalogMedia',()=>({catalogImageTicket:mocks.ticket}));
const item={provider:'kHentai' as const,providerWorkId:'42',thumbnailUrl:'https://ehgt.org/42.jpg'};
type Observer={callback:IntersectionObserverCallback;options:IntersectionObserverInit;target?:Element;targets:Set<Element>;unobserve:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>};
let observers:Observer[];
let sizing:{callback:ResizeObserverCallback;observe:ReturnType<typeof vi.fn>;unobserve:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}[];
function intersect(observer:Observer,yes:boolean){act(()=>observer.callback([{isIntersecting:yes,target:observer.target} as IntersectionObserverEntry],{} as IntersectionObserver));}
function cover(active=true){return <div className="catalog-scroll"><div className="catalog-grid" style={{rowGap:'22px'}}><div className="catalog-card"><CatalogCover item={item} revision="p1" active={active}/></div></div></div>;}
beforeEach(()=>{
  localStorage.clear();observers=[];sizing=[];mocks.ticket.mockReset();
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({height:300,width:200,top:0,bottom:300,left:0,right:200} as DOMRect);
  vi.stubGlobal('IntersectionObserver',class{
    observer:Observer;
    constructor(callback:IntersectionObserverCallback,options:IntersectionObserverInit){this.observer={callback,options,targets:new Set(),unobserve:vi.fn(),disconnect:vi.fn()};observers.push(this.observer);}
    observe(target:Element){this.observer.target=target;this.observer.targets.add(target);}
    unobserve(target:Element){this.observer.unobserve(target);this.observer.targets.delete(target);}
    disconnect(){this.observer.disconnect();this.observer.targets.clear();}
  });
  vi.stubGlobal('ResizeObserver',class{
    record;
    constructor(callback:ResizeObserverCallback){this.record={callback,observe:vi.fn(),unobserve:vi.fn(),disconnect:vi.fn()};sizing.push(this.record);}
    observe(target:Element){this.record.observe(target);}
    unobserve(target:Element){this.record.unobserve(target);}
    disconnect(){this.record.disconnect();}
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
it('shares observers and one row measurement for 40 covers, unobserving only removed covers',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));
  const style=vi.spyOn(window,'getComputedStyle');
  const tree=(count:number)=><div className="catalog-scroll"><div className="catalog-grid" style={{rowGap:'22px'}}>{Array.from({length:count},(_,i)=><div key={i} className="catalog-card"><CatalogCover item={{...item,providerWorkId:String(i)}} revision="p1" active/></div>)}</div></div>;
  const view=render(tree(40));
  expect(observers).toHaveLength(2);
  expect(sizing).toHaveLength(1);
  expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(1);
  expect(style).toHaveBeenCalledTimes(1);
  expect(observers[1].options.rootMargin).toBe('644px 0px');
  const removed=[...observers[0].targets].at(-1)!;
  view.rerender(tree(39));
  for(const observer of observers){expect(observer.unobserve).toHaveBeenCalledWith(removed);expect(observer.targets.size).toBe(39);expect(observer.disconnect).not.toHaveBeenCalled();}
  view.unmount();
  for(const observer of observers){expect(observer.targets.size).toBe(0);expect(observer.disconnect).toHaveBeenCalledOnce();}
  expect(sizing[0].disconnect).toHaveBeenCalledOnce();
});
it('also measures an edition row once while keeping its existing cover margin',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));
  render(<div className="catalog-edition-row" style={{gap:'12px'}}>{[0,1,2].map(i=><button key={i} className="catalog-edition"><div className="catalog-cover"><CatalogCover item={{...item,providerWorkId:String(i)}} revision="p1" active/></div></button>)}</div>);
  expect(observers).toHaveLength(2);expect(sizing).toHaveLength(1);
  expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(1);
  expect(observers[1].options.rootMargin).toBe('600px 0px');
});
it('shares matching ranges across grids, separates roots and margins, and dispatches by target',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return {height:this.closest('[data-short]')?180:300} as DOMRect;});
  const grid=(id:string,short=false)=><div className="catalog-grid" data-short={short||undefined} style={{rowGap:'22px'}}>{[0,1].map(i=><div key={i} className="catalog-card"><CatalogCover item={{...item,providerWorkId:`${id}${i}`}} revision="p1" active/></div>)}</div>;
  const view=render(<><div className="catalog-scroll">{grid('a')}{grid('b')}{grid('c',true)}</div><div className="catalog-scroll">{grid('d')}</div></>);
  expect(observers).toHaveLength(5);expect(sizing).toHaveLength(1);
  expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(4);
  const nearby=observers[1],targets=[...nearby.targets];expect(targets).toHaveLength(4);
  act(()=>nearby.callback([{target:targets[0],isIntersecting:true},{target:targets[1],isIntersecting:false}] as IntersectionObserverEntry[],{} as IntersectionObserver));
  expect(mocks.ticket).toHaveBeenCalledTimes(1);expect(mocks.ticket.mock.calls[0][0].workId).toBe('a0');
  view.unmount();
  const fresh=render(cover());expect(observers).toHaveLength(7);expect(sizing).toHaveLength(2);fresh.unmount();
});
it('remeasures once per resized grid and moves all covers to the new shared range',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));
  const view=render(<div className="catalog-scroll"><div className="catalog-grid" style={{rowGap:'22px'}}>{[0,1,2].map(i=><div key={i} className="catalog-card"><CatalogCover item={{...item,providerWorkId:String(i)}} revision="p1" active/></div>)}</div></div>);
  const root=view.container.querySelector('.catalog-grid')!;
  const bounds=vi.mocked(HTMLElement.prototype.getBoundingClientRect);bounds.mockClear();
  act(()=>sizing[0].callback([{target:root}] as ResizeObserverEntry[],{} as ResizeObserver));
  expect(bounds).toHaveBeenCalledTimes(1);expect(observers).toHaveLength(2);
  bounds.mockReturnValue({height:200} as DOMRect);bounds.mockClear();
  act(()=>sizing[0].callback([{target:root}] as ResizeObserverEntry[],{} as ResizeObserver));
  expect(bounds).toHaveBeenCalledTimes(1);expect(observers).toHaveLength(3);
  expect(observers[1].disconnect).toHaveBeenCalledOnce();expect(observers[2].targets.size).toBe(3);expect(observers[2].options.rootMargin).toBe('444px 0px');
});
it('preloads within two measured rows but leaves far covers unrequested',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));render(cover());
  expect(observers[1].options).toMatchObject({rootMargin:'644px 0px',root:document.querySelector('.catalog-scroll')});
  expect(mocks.ticket).not.toHaveBeenCalled();
  intersect(observers[1],true);expect(mocks.ticket).toHaveBeenCalledTimes(1);
  expect(mocks.ticket.mock.calls[0][2]()).toBe(false);
  intersect(observers[0],true);expect(mocks.ticket.mock.calls[0][2]()).toBe(true);
});
it('keeps an in-flight cover subscribed within two rows and cancels only outside them',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));render(cover());
  intersect(observers[0],true);intersect(observers[1],true);
  const signal=mocks.ticket.mock.calls[0][1] as AbortSignal;
  intersect(observers[0],false);expect(signal.aborted).toBe(false);
  intersect(observers[0],true);expect(mocks.ticket).toHaveBeenCalledTimes(1);
  intersect(observers[1],false);expect(signal.aborted).toBe(true);
  intersect(observers[1],true);expect(mocks.ticket).toHaveBeenCalledTimes(2);
});
it('retains a shown image through scrolling and pause without fading or fetching again',async()=>{
  const animate=vi.fn();vi.stubGlobal('Animation',class{});
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
  mocks.ticket.mockResolvedValue({url:'https://app.lakomics.local/media-cache/test'});
  const view=render(cover());intersect(observers[1],true);
  await waitFor(()=>expect(view.container.querySelector('img')).not.toBeNull());
  const image=view.container.querySelector('img')!;fireEvent.load(image);await act(async()=>{});
  intersect(observers[0],false);intersect(observers[1],false);view.rerender(cover(false));
  expect(view.container.querySelector('img')).toBe(image);expect(image.style.opacity).toBe('');expect(animate).not.toHaveBeenCalled();
  view.rerender(cover());intersect(observers[1],true);expect(mocks.ticket).toHaveBeenCalledTimes(1);
});
it('aborts a pending cover when its screen deactivates',()=>{
  mocks.ticket.mockReturnValue(new Promise(()=>{}));const view=render(cover());intersect(observers[1],true);
  const signal=mocks.ticket.mock.calls[0][1] as AbortSignal;view.rerender(cover(false));expect(signal.aborted).toBe(true);
});
it('bounds the no-observer fallback instead of warming every card',()=>{
  vi.stubGlobal('IntersectionObserver',undefined);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    const far=this.closest('[data-far]');
    return {height:300,width:200,top:far?3000:0,bottom:far?3300:300,left:0,right:200} as DOMRect;
  });
  mocks.ticket.mockReturnValue(new Promise(()=>{}));
  render(<div className="catalog-scroll"><div className="catalog-grid"><div className="catalog-card"><CatalogCover item={item} revision="p1" active/></div>
    {Array.from({length:30},(_,i)=><div key={i} className="catalog-card" data-far><CatalogCover item={{...item,providerWorkId:String(i+43)}} revision="p1" active/></div>)}
  </div></div>);
  expect(mocks.ticket).toHaveBeenCalledTimes(1);
});
