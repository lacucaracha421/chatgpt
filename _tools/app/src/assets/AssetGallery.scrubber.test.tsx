import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {AssetSummary} from '../library/types';
import {AssetGallery} from './AssetGallery';

const items: AssetSummary[] = Array.from({length:120}, (_, i) => ({
  id:`asset-${i}`, title:null, originalName:`${i}.png`, byteSize:1, width:200, height:200,
  collectedAt:i < 60 ? '2026-10-01T00:00:00Z' : '2025-09-01T00:00:00Z', favorite:false,
  sourceUrl:null, sourcePublishedAt:null, creatorName:null, creatorHandle:null, creatorUrl:null,
  importSource:null, importBatchId:null, originalModifiedAt:null, media:{kind:'image'},
}));
const rect = (top:number, height:number, width=840) => ({left:0, right:width, top, bottom:top+height, height, width, x:0, y:top, toJSON:()=>({})});
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth:{configurable:true, get:()=>840}, offsetWidth:{configurable:true, get:()=>840},
    clientHeight:{configurable:true, get:()=>400}, offsetHeight:{configurable:true, get:()=>400},
    scrollHeight:{configurable:true, get() { return Number.parseFloat(this.querySelector('.asset-gallery__virtual-space')?.style.height ?? '0'); }},
    setPointerCapture:{configurable:true, value:vi.fn()}, releasePointerCapture:{configurable:true, value:vi.fn()},
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('pc-scrubber-zone') ? rect(28,384,24) : rect(20,400);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

function mount() {
  const view=render(<AssetGallery layout="masonry" items={items} />);
  const list=view.container.querySelector('.asset-gallery__scroll') as HTMLElement;
  const zone=document.querySelector('.pc-scrubber-zone') as HTMLElement;
  return {...view,list,zone};
}
describe('AssetGallery PC scrubber', () => {
  it('sizes the thumb from the real scroll height when a filter narrows a 30-item scope', () => {
    const {container, rerender}=render(<AssetGallery layout="masonry" groupDates={false} scopeKey="all" items={items.slice(0,30)} totalCount={30} />);
    const list=container.querySelector('.asset-gallery__scroll') as HTMLElement;
    const thumb=()=>document.querySelector('.pc-scrubber-thumb') as HTMLElement;
    const expectedHeight=()=>384 * list.clientHeight / list.scrollHeight;
    const fullHeight=list.scrollHeight;
    expect(Number.parseFloat(thumb().style.height)).toBeCloseTo(expectedHeight());
    const oldThumbHeight=Number.parseFloat(thumb().style.height);

    rerender(<AssetGallery layout="masonry" groupDates={false} scopeKey="images" items={items.slice(0,18)} totalCount={18} />);
    expect(list.scrollHeight).toBeLessThan(fullHeight);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(Number.parseFloat(thumb().style.height)).toBeCloseTo(expectedHeight());
    expect(Number.parseFloat(thumb().style.height)).toBeGreaterThan(oldThumbHeight);
  });

  it('keeps the reserved range and thumb size stable when another page arrives', () => {
    const {container, rerender}=render(<AssetGallery layout="masonry" groupDates={false} scopeKey="paged" items={items.slice(0,12)} totalCount={30} hasNextPage />);
    const space=container.querySelector('.asset-gallery__virtual-space') as HTMLElement;
    fireEvent.scroll(container.querySelector('.asset-gallery__scroll')!);
    const height=space.style.height;
    const thumb=()=>document.querySelector('.pc-scrubber-thumb') as HTMLElement;
    expect(Number.parseFloat(thumb().style.height)).toBeCloseTo(384 * 400 / Number.parseFloat(height));
    const thumbHeight=thumb().style.height;
    rerender(<AssetGallery layout="masonry" groupDates={false} scopeKey="paged" items={items.slice(0,18)} totalCount={30} hasNextPage />);
    expect(space.style.height).toBe(height);
    expect(thumb().style.height).toBe(thumbHeight);
  });

  it('grabs a large thumb without jumping and drags it through its available travel', () => {
    const {container}=render(<AssetGallery layout="masonry" groupDates={false} items={items.slice(0,18)} totalCount={18} />);
    const list=container.querySelector('.asset-gallery__scroll') as HTMLElement;
    const thumb=document.querySelector('.pc-scrubber-thumb') as HTMLElement;
    const zone=document.querySelector('.pc-scrubber-zone')!;
    const travel=384 - Number.parseFloat(thumb.style.height);
    expect(travel).toBeGreaterThan(0);
    expect(travel).toBeLessThan(100);
    fireEvent.pointerDown(thumb,{pointerType:'mouse',button:0,buttons:1,pointerId:7,clientY:38});
    expect(list.scrollTop).toBe(0);
    fireEvent.pointerMove(zone,{pointerType:'mouse',buttons:1,pointerId:7,clientY:38 + travel});
    expect(list.scrollTop).toBeCloseTo(list.scrollHeight - list.clientHeight);
    expect(Number.parseFloat(thumb.style.top)).toBeCloseTo(travel);
    fireEvent.pointerUp(zone,{pointerType:'mouse',pointerId:7,clientY:38 + travel});
  });

  it('keeps a usable minimum on a long range and hides when the scope fits', () => {
    const {container, rerender}=render(<AssetGallery layout="masonry" items={items} totalCount={10000} hasNextPage />);
    fireEvent.scroll(container.querySelector('.asset-gallery__scroll')!);
    expect((document.querySelector('.pc-scrubber-thumb') as HTMLElement).style.height).toBe('32px');
    rerender(<AssetGallery layout="masonry" groupDates={false} scopeKey="short" items={items.slice(0,6)} totalCount={6} />);
    expect(document.querySelector('.pc-scrubber-thumb')).toBeNull();
  });

  it('hides the native scrollbar without changing content layout, and grows near the pointer', () => {
    const {list, zone}=mount();
    expect(list).toHaveClass('scrubber-scroll-host'); expect(list).toHaveAttribute('tabindex','0');
    const space=list.querySelector('.asset-gallery__virtual-space')!;
    const before=space.getAttribute('style');
    expect(zone.parentElement).not.toHaveClass('is-visible');
    fireEvent.pointerMove(list,{pointerType:'mouse',clientX:830,clientY:200});
    expect(zone.parentElement).toHaveClass('is-visible','is-grown');
    expect(space.getAttribute('style')).toBe(before);
    expect(document.querySelector('.mobile-scrubber-zone')).toBeNull();
  });
  it('seeks mounted virtual tiles by mouse drag and shows their month near the pointer', () => {
    const {list,zone}=mount();
    fireEvent.pointerDown(zone,{pointerType:'mouse',button:0,buttons:1,pointerId:7,clientY:44});
    fireEvent.pointerMove(zone,{pointerType:'mouse',buttons:1,pointerId:7,clientY:320});
    expect(list.scrollTop).toBeGreaterThan(1000);
    expect(screen.getByText('2025년 9월')).toBeInTheDocument();
    // The destination cells are rendered during drag, not an empty estimated spacer.
    expect(list.querySelector('[data-asset-id="asset-93"]')).not.toBeNull();
    fireEvent.pointerUp(zone,{pointerType:'mouse',pointerId:7,clientY:320});
    expect(zone.parentElement).toHaveAttribute('data-state','released');
    act(()=>vi.advanceTimersByTime(1000)); expect(zone.parentElement).toHaveClass('is-fading');
    act(()=>vi.advanceTimersByTime(220)); expect(zone.parentElement).not.toHaveClass('is-visible');
  });
  it('jumps on track click, ignores other buttons and later hovers after an outside release', () => {
    const {list,zone}=mount();
    fireEvent.pointerDown(zone,{pointerType:'mouse',button:2,pointerId:4,clientY:320});
    expect(list.scrollTop).toBe(0);
    fireEvent.pointerDown(zone,{pointerType:'mouse',button:0,buttons:1,pointerId:7,clientY:220});
    expect(list.scrollTop).toBeGreaterThan(0);
    fireEvent.pointerUp(window,{pointerId:7});
    const top=list.scrollTop;
    fireEvent.pointerMove(zone,{pointerType:'mouse',buttons:0,pointerId:7,clientY:400});
    expect(list.scrollTop).toBe(top);
  });
  it('leaves wheel and keyboard defaults on the list, forwards strip wheel input and hides after idle', () => {
    const {list,zone}=mount();
    expect(fireEvent.wheel(list,{deltaY:100})).toBe(true);
    // jsdom does not execute browser wheel/keyboard defaults; neither is cancelled by the scrubber.
    expect(list.scrollTop).toBe(0);
    for (const key of ['PageUp','PageDown','Home','End']) expect(fireEvent.keyDown(list,{key})).toBe(true);
    list.scrollTop=200; fireEvent.scroll(list);
    expect(zone.parentElement).toHaveClass('is-visible');
    fireEvent.wheel(zone,{deltaY:100}); expect(list.scrollTop).toBe(300);
    act(()=>vi.advanceTimersByTime(1000)); expect(zone.parentElement).toHaveClass('is-fading');
    act(()=>vi.advanceTimersByTime(220)); expect(zone.parentElement).not.toHaveClass('is-visible');
    fireEvent.pointerEnter(zone,{pointerType:'mouse'}); expect(zone.parentElement).toHaveClass('is-grown');
    fireEvent.pointerLeave(zone,{pointerType:'mouse'});
    act(()=>vi.advanceTimersByTime(1220)); expect(zone.parentElement).not.toHaveClass('is-visible');
  });
  it('keeps the current tiles until another page is ready when seeking the loaded end', () => {
    const loadMore=vi.fn();
    const {container}=render(<AssetGallery layout="masonry" items={items} totalCount={1000} hasNextPage onLoadNextPage={loadMore} />);
    const zone=document.querySelector('.pc-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerType:'mouse',button:0,buttons:1,pointerId:7,clientY:412});
    expect(loadMore).toHaveBeenCalled();
    expect(container.querySelector('[data-asset-id="asset-119"]')).not.toBeNull();
  });
});
