import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import type {ComponentProps, MutableRefObject} from 'react';
import {readFileSync} from 'node:fs';
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
  it('keeps the idle band invisible',()=>{mount();expect(document.querySelector('.mobile-scrubber-bubble')).toBeNull();expect(document.querySelector('.mobile-scrubber.is-active,.mobile-scrubber.is-released')).toBeNull();expect(document.querySelector('.mobile-scrubber-zone')).not.toBeNull();});

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
    expect(document.querySelector('.mobile-scrubber-bubble')).toBeNull();expect(list.scrollTop).toBe(0);
  });

  it('fades after release and shows a hairline for one second after ordinary scrolling',()=>{
    vi.useFakeTimers();const {list}=mount();const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:300,clientY:10});fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:300,clientY:10});
    expect(document.querySelector('.mobile-scrubber-rail')).not.toBeNull();act(()=>vi.advanceTimersByTime(300));expect(document.querySelector('.mobile-scrubber.is-fading')).not.toBeNull();act(()=>vi.advanceTimersByTime(220));expect(document.querySelector('.mobile-scrubber-rail')).toBeNull();
    fireEvent.scroll(list);expect(document.querySelector('.mobile-scrubber-rail')).not.toBeNull();act(()=>vi.advanceTimersByTime(1000));expect(document.querySelector('.mobile-scrubber-rail')).toBeNull();
  });

  it('shows the bar on a tap of the bottom band and hides it again',()=>{
    vi.useFakeTimers();mount();const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:200,clientY:10});fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:201,clientY:10});
    expect(document.querySelector('.mobile-scrubber.is-released .mobile-scrubber-rail')).not.toBeNull();
    act(()=>vi.advanceTimersByTime(2600));expect(document.querySelector('.mobile-scrubber.is-fading')).not.toBeNull();
    act(()=>vi.advanceTimersByTime(220));expect(document.querySelector('.mobile-scrubber-rail')).toBeNull();
  });
  it('hides when the list fits in roughly one and a half screens',()=>{mount({short:true});expect(document.querySelector('.mobile-scrubber-zone')).toBeNull();expect(document.querySelector('.mobile-scrubber-bubble')).toBeNull();});

  it('keeps one rail element from the resting line to the active bar, with a small one-line label',()=>{
    vi.useFakeTimers();const {list}=mount();
    fireEvent.scroll(list);
    const rest=document.querySelector('.mobile-scrubber-rail');expect(rest).not.toBeNull();
    expect(document.querySelector('.mobile-scrubber.is-active,.mobile-scrubber.is-released')).toBeNull();expect(document.querySelector('.mobile-scrubber-bubble')).toBeNull();
    const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:500,clientY:12});
    expect(document.querySelector('.mobile-scrubber-rail')).toBe(rest);expect(document.querySelector('.mobile-scrubber.is-active')).not.toBeNull();
    const bubble=document.querySelector('.mobile-scrubber-bubble')!;
    expect(bubble.querySelector('b')?.textContent).toMatch(/^2025년 \d+월$/);expect(bubble.querySelector('small')?.textContent).toMatch(/^\d+ \/ 40$/);
    fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:500,clientY:12});
  });

  it('declares the rail ends and baseline once so rest and active share them',()=>{
    const css=readFileSync('src/shared/ui/scrubber/scrubber.css','utf8');
    expect(css).toMatch(/\.mobile-scrubber-rail \{[^}]*left:20px; right:20px; bottom:14px;/);
    const stateRules=css.split('\n').filter(line=>/\.is-(active|released)/.test(line)&&/mobile-scrubber-(rail|track|thumb|fill)/.test(line));
    expect(stateRules.length).toBeGreaterThan(0);
    stateRules.forEach(line=>{expect(line).not.toMatch(/[{; ](left|right)\s*:/);});
    expect(css).not.toMatch(/\.is-(active|released) \.mobile-scrubber-rail/);
  });

  it('shows year labels at least 44px apart, first and last included',()=>{
    vi.useFakeTimers();vi.stubGlobal('innerWidth',420);
    const values=Array.from({length:40},(_,i)=>`${2026-i}-06-01`);
    const {list}=mount({sort:{kind:'date',values}});void list;
    const zone=document.querySelector('.mobile-scrubber-zone')!;
    fireEvent.pointerDown(zone,{pointerId:1,pointerType:'touch',clientX:40,clientY:10});fireEvent.pointerMove(zone,{pointerId:1,pointerType:'touch',clientX:200,clientY:12});
    const labels=Array.from(document.querySelectorAll('.mobile-scrubber-years span'));
    const xs=labels.map(node=>parseFloat((node as HTMLElement).style.left));
    expect(labels[0].textContent).toBe('2026');expect(labels[labels.length-1].textContent).toBe('1987');
    expect(labels.length).toBeLessThan(40);
    xs.slice(1).forEach((x,i)=>expect(x-xs[i]).toBeGreaterThanOrEqual(44));
    fireEvent.pointerUp(zone,{pointerId:1,pointerType:'touch',clientX:200,clientY:12});
  });
});
