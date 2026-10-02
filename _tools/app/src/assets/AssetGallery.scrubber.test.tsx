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
