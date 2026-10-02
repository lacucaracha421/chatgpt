import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {MutableRefObject} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {Scrubber} from './Scrubber';

const toc = {kind:'toc' as const,totalCount:1000,buckets:[
  {key:'2026-10',startIndex:0,count:400}, {key:'2025-09',startIndex:400,count:600},
]};
afterEach(()=>{cleanup(); vi.useRealTimers(); vi.restoreAllMocks();});
it('keeps tablet TOC seeks deferred until release and labels unloaded indices from the TOC',()=>{
  const ref={current:null} as MutableRefObject<HTMLDivElement|null>;
  const seek=vi.fn();
  render(<><div aria-label="sparse list" ref={ref}/><Scrubber scrollRef={ref} total={1000} sort={toc} onSeek={seek} indexAtScroll={()=>100}/></>);
  const list=screen.getByLabelText('sparse list');
  Object.defineProperties(list,{clientHeight:{value:400}, scrollHeight:{value:4000}});
  fireEvent.scroll(list);
  const zone=document.querySelector('.mobile-scrubber-zone')!;
  fireEvent.pointerDown(zone,{pointerType:'touch',pointerId:1,clientX:40,clientY:10});
  fireEvent.pointerMove(zone,{pointerType:'touch',pointerId:1,clientX:700,clientY:10});
  expect(seek).not.toHaveBeenCalled(); expect(list.scrollTop).toBe(0);
  expect(screen.getByText('2025년 9월')).toBeTruthy();
  fireEvent.pointerUp(zone,{pointerType:'touch',pointerId:1,clientX:700,clientY:10});
  expect(seek).toHaveBeenCalledOnce(); expect(seek.mock.calls[0][0]).toBeGreaterThan(400);
});
it('uses the same TOC labels for pointer seeks and restores the host on unmount',()=>{
  vi.useFakeTimers();
  const ref={current:null} as MutableRefObject<HTMLDivElement|null>;
  const seek=vi.fn();
  const {unmount}=render(<><div aria-label="sparse list" ref={ref}/><Scrubber input="pointer" scrollRef={ref} total={1000} sort={toc} onSeek={seek} indexAtScroll={()=>100}/></>);
  const list=screen.getByLabelText('sparse list');
  Object.defineProperties(list,{clientHeight:{value:400}, scrollHeight:{value:4000}});
  fireEvent.scroll(list);
  const zone=document.querySelector('.pc-scrubber-zone')!;
  vi.spyOn(zone,'getBoundingClientRect').mockReturnValue({top:0,height:400} as DOMRect);
  fireEvent.pointerDown(zone,{pointerType:'mouse',button:0,buttons:1,pointerId:1,clientY:260});
  expect(seek).toHaveBeenCalled(); expect(list.scrollTop).toBe(0);
  expect(screen.getByText('2025년 9월')).toBeTruthy();
  fireEvent.pointerUp(zone,{pointerId:1});
  act(()=>vi.advanceTimersByTime(1220)); expect(document.querySelector('.pc-scrubber-bubble')).toBeNull();
  unmount(); expect(list.classList.contains('scrubber-scroll-host')).toBe(false);
});
