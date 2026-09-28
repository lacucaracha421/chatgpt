import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import type {ComponentProps, MutableRefObject} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Scrubber} from './Scrubber';

afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

function mount(options:{short?:boolean;sort?:ComponentProps<typeof Scrubber>['sort']}={}) {
  const {short=false,sort}=options;
  const ref={current:null} as MutableRefObject<HTMLDivElement|null>;
  const defaultSort={kind:'date' as const,values:Array.from({length:40},(_,i)=>`2025-${String(Math.min(12,Math.floor(i / 4) + 1)).padStart(2,'0')}-01`)};
  const chosenSort=sort ?? defaultSort;
  const view=render(<div><div ref={node=>{ref.current=node;}} aria-label="scrub list"><div style={{height:2000}}/><Scrubber scrollRef={ref} total={40} sort={chosenSort}/></div></div>);
  const list=screen.getByLabelText('scrub list');
  const clientHeight=short ? 100 : 400;
  const scrollHeight=short ? 140 : 2000;
  Object.defineProperty(list,'clientHeight',{configurable:true,value:clientHeight});
  Object.defineProperty(list,'scrollHeight',{configurable:true,value:scrollHeight});
  act(()=>{fireEvent.scroll(list);});
  return {view,list};
}

describe('Scrubber',()=>{
  it('keeps the idle band invisible',()=>{mount();expect(document.querySelector('.mobile-scrubber-bar')).toBeNull();expect(document.querySelector('.mobile-scrubber-zone')).not.toBeNull();});

  it('scrubs horizontally from the band and shows the date bubble',()=>{
    const {list}=mount();const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});
    fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:500,clientY:12});
    expect(list.scrollTop).toBeGreaterThan(0);expect(screen.getByText(/2025년/)).toBeTruthy();expect(screen.getByText(/\/ 40/)).toBeTruthy();
    fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:500,clientY:12});
  });

  it('lets a vertical drag pass through without capturing the scrubber',()=>{
    const {list}=mount();const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});
    fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:44,clientY:40});
    expect(document.querySelector('.mobile-scrubber-bar')).toBeNull();expect(list.scrollTop).toBe(0);
  });

  it('fades after release and shows a hairline for one second after ordinary scrolling',()=>{
    vi.useFakeTimers();const {list}=mount();const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:300,clientY:10});fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:300,clientY:10});
    expect(document.querySelector('.mobile-scrubber-bar')).not.toBeNull();act(()=>vi.advanceTimersByTime(800));expect(document.querySelector('.mobile-scrubber.is-fading')).not.toBeNull();act(()=>vi.advanceTimersByTime(180));expect(document.querySelector('.mobile-scrubber-bar')).toBeNull();
    fireEvent.scroll(list);expect(document.querySelector('.mobile-scrubber-hint')).not.toBeNull();act(()=>vi.advanceTimersByTime(1000));expect(document.querySelector('.mobile-scrubber-hint')).toBeNull();
  });

  it('hides when the list fits in roughly one and a half screens',()=>{mount({short:true});expect(document.querySelector('.mobile-scrubber-zone')).toBeNull();expect(document.querySelector('.mobile-scrubber-bar')).toBeNull();});
});
