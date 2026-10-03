import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CatalogCover} from './CatalogCover';
const mocks=vi.hoisted(()=>({ticket:vi.fn()}));
vi.mock('./catalogMedia',()=>({catalogImageTicket:mocks.ticket}));
const item={provider:'kHentai' as const,providerWorkId:'42',thumbnailUrl:'https://ehgt.org/42.jpg'};
type Observer={callback:IntersectionObserverCallback;options:IntersectionObserverInit;target?:Element};
let observers:Observer[];
function intersect(observer:Observer,yes:boolean){act(()=>observer.callback([{isIntersecting:yes,target:observer.target} as IntersectionObserverEntry],{} as IntersectionObserver));}
function cover(active=true){return <div className="catalog-scroll"><div className="catalog-grid" style={{rowGap:'22px'}}><div className="catalog-card"><CatalogCover item={item} revision="p1" active={active}/></div></div></div>;}
beforeEach(()=>{
  localStorage.clear();observers=[];mocks.ticket.mockReset();
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({height:300,width:200,top:0,bottom:300,left:0,right:200} as DOMRect);
  vi.stubGlobal('IntersectionObserver',class{
    observer:Observer;
    constructor(callback:IntersectionObserverCallback,options:IntersectionObserverInit){this.observer={callback,options};observers.push(this.observer);}
    observe(target:Element){this.observer.target=target;}
    disconnect(){}
  });
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
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
