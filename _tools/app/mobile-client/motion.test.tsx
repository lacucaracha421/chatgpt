import {useRef} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {act} from 'react';
import {PROGRESS_DELAY_MS,PROGRESS_FADE_MS,PROGRESS_MIN_MS,useDelayedPresence,useLevelMotion,useScrollMemory,useTabMotion} from './motion';
import {BarProgress} from './TopBar';

function Level({levelKey,depth}:{levelKey:string|null;depth:number}){const host=useRef<HTMLDivElement>(null);useLevelMotion(host,levelKey,depth);return <div ref={host} data-testid="level"/>;}
let animate:ReturnType<typeof vi.fn>;
function reduced(value:boolean){vi.stubGlobal('matchMedia',(query:string)=>({matches:value&&query.includes('reduce'),media:query,addEventListener(){},removeEventListener(){}}));}
beforeEach(()=>{animate=vi.fn(function(this:HTMLElement){return {cancel(){}};});(HTMLElement.prototype as unknown as {animate:unknown}).animate=animate;reduced(false);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
const firstFrame=(call:number)=>(animate.mock.calls[call][0] as Keyframe[])[0];

it('slides a deeper level in from the right and a shallower one from the left',()=>{
  const view=render(<Level levelKey="root" depth={0}/>);
  expect(animate).not.toHaveBeenCalled();
  view.rerender(<Level levelKey="folder" depth={1}/>);
  expect(firstFrame(0).transform).toBe('translateX(20px)');
  view.rerender(<Level levelKey="root" depth={0}/>);
  expect(firstFrame(1).transform).toBe('translateX(-20px)');
  // A different place at the same depth only fades; a refresh of the same place does nothing.
  view.rerender(<Level levelKey="sibling" depth={0}/>);
  expect(firstFrame(2).transform).toBeUndefined();
  view.rerender(<Level levelKey="sibling" depth={0}/>);
  expect(animate).toHaveBeenCalledTimes(3);
});
it('does not move after a tab switch or when reduced motion is requested',()=>{
  const view=render(<Level levelKey="root" depth={0}/>);
  view.rerender(<Level levelKey={null} depth={0}/>);
  view.rerender(<Level levelKey="folder" depth={1}/>);
  expect(animate).not.toHaveBeenCalled();
  reduced(true);
  view.rerender(<Level levelKey="deeper" depth={2}/>);
  expect(animate).not.toHaveBeenCalled();
});

function Tabs({tab}:{tab:string}){const host=useRef<HTMLDivElement>(null);useScrollMemory(host,tab);return <div ref={host}><div data-testid="list" style={{display:tab==='a'?undefined:'none'}}/></div>;}
it('puts a retained tab back where it was when the tab returns',()=>{
  const view=render(<Tabs tab="a"/>);const list=view.getByTestId('list');
  list.scrollTop=480;list.dispatchEvent(new Event('scroll'));
  view.rerender(<Tabs tab="b"/>);
  // Chromium drops the offset of a scroller hidden with display:none.
  list.scrollTop=0;
  view.rerender(<Tabs tab="a"/>);
  expect(list.scrollTop).toBe(480);
});

function Screen({levelKey,depth}:{levelKey:string;depth:number}){const host=useRef<HTMLDivElement>(null);useLevelMotion(host,levelKey,depth);return <div ref={host}><header className="top-bar"/><div className="library-root" style={{display:'none'}}><header className="top-bar"/></div><div data-testid="content"><button className="media-tile"/><button className="media-tile"/></div></div>;}
it('moves the content under a still bar and staggers the first tiles only on a deeper level',()=>{
  const view=render(<Screen levelKey="root" depth={0}/>);
  view.rerender(<Screen levelKey="folder" depth={1}/>);
  const targets=animate.mock.contexts as HTMLElement[];
  expect(targets[0]).toBe(view.getByTestId('content'));
  expect(targets.some(target=>target.classList.contains('top-bar'))).toBe(false);
  // Two tiles fade in one after another, and the whole entrance ends within 220 ms.
  const tiles=animate.mock.calls.slice(1);
  expect(tiles).toHaveLength(2);
  expect((tiles[1][1] as KeyframeAnimationOptions).delay).toBeGreaterThan((tiles[0][1] as KeyframeAnimationOptions).delay as number);
  for(const [,options] of animate.mock.calls){const o=options as KeyframeAnimationOptions;expect((o.delay??0)+(o.duration as number)).toBeLessThanOrEqual(220);}
  // Going back comes from the left and has no stagger: the level was retained.
  animate.mockClear();
  view.rerender(<Screen levelKey="root" depth={0}/>);
  expect(animate).toHaveBeenCalledTimes(1);
});

function TabHost({tab}:{tab:string}){const host=useRef<HTMLDivElement>(null);useTabMotion(host,tab);return <div ref={host}>
  <section data-testid="a" style={{display:tab==='a'?undefined:'none'}}><header className="top-bar"/><div data-testid="a-content"/></section>
  <section data-testid="b" style={{display:tab==='b'?undefined:'none'}}><header className="top-bar"/><div data-testid="b-content"/></section>
</div>;}
it('settles only the shown tab\'s content on a tab switch, and nothing under reduced motion',()=>{
  const view=render(<TabHost tab="a"/>);
  expect(animate).not.toHaveBeenCalled();
  view.rerender(<TabHost tab="b"/>);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate.mock.contexts[0]).toBe(view.getByTestId('b-content'));
  expect(firstFrame(0).transform).toBe('translateY(6px)');
  expect((animate.mock.calls[0][1] as KeyframeAnimationOptions).duration).toBeLessThanOrEqual(220);
  reduced(true);
  view.rerender(<TabHost tab="a"/>);
  expect(animate).toHaveBeenCalledTimes(1);
});
it('leaves a tab that still shows only its bar alone',()=>{
  function Loading({tab}:{tab:string}){const host=useRef<HTMLDivElement>(null);useTabMotion(host,tab);return <div ref={host}><section style={{display:tab==='a'?undefined:'none'}}><header className="top-bar"/></section></div>;}
  const view=render(<Loading tab="b"/>);
  view.rerender(<Loading tab="a"/>);
  expect(animate).not.toHaveBeenCalled();
});

function Presence({active}:{active:boolean}){return <span data-testid="presence">{useDelayedPresence(active)}</span>;}
describe('delayed loading presence',()=>{
  beforeEach(()=>{vi.useFakeTimers();});
  afterEach(()=>{vi.useRealTimers();});
  const state=(view:ReturnType<typeof render>)=>view.getByTestId('presence').textContent;
  it('shows nothing for a load shorter than the delay',()=>{
    const view=render(<Presence active/>);
    act(()=>{vi.advanceTimersByTime(PROGRESS_DELAY_MS-50);});
    view.rerender(<Presence active={false}/>);
    act(()=>{vi.advanceTimersByTime(2000);});
    expect(state(view)).toBe('hidden');
  });
  it('holds a shown line for the minimum time, then fades it out',()=>{
    const view=render(<Presence active/>);
    act(()=>{vi.advanceTimersByTime(PROGRESS_DELAY_MS);});
    expect(state(view)).toBe('shown');
    act(()=>{vi.advanceTimersByTime(50);});
    view.rerender(<Presence active={false}/>);
    act(()=>{vi.advanceTimersByTime(PROGRESS_MIN_MS-60);});
    expect(state(view)).toBe('shown');
    act(()=>{vi.advanceTimersByTime(10);});
    expect(state(view)).toBe('leaving');
    act(()=>{vi.advanceTimersByTime(PROGRESS_FADE_MS);});
    expect(state(view)).toBe('hidden');
  });
  it('comes back without blinking when a new load starts during the fade',()=>{
    const view=render(<Presence active/>);
    act(()=>{vi.advanceTimersByTime(PROGRESS_DELAY_MS+PROGRESS_MIN_MS);});
    view.rerender(<Presence active={false}/>);
    expect(state(view)).toBe('leaving');
    view.rerender(<Presence active/>);
    expect(state(view)).toBe('shown');
  });
  it('leaves at once under reduced motion',()=>{
    reduced(true);
    const view=render(<Presence active/>);
    act(()=>{vi.advanceTimersByTime(PROGRESS_DELAY_MS+PROGRESS_MIN_MS);});
    view.rerender(<Presence active={false}/>);
    expect(state(view)).toBe('hidden');
  });
  it('announces the bar line only while it is shown',()=>{
    const view=render(<BarProgress label="목록 불러오는 중"/>);
    expect(view.queryByRole('status')).toBeNull();
    act(()=>{vi.advanceTimersByTime(PROGRESS_DELAY_MS);});
    expect(view.getByRole('status',{name:'목록 불러오는 중'}).classList.contains('top-bar__progress')).toBe(true);
    act(()=>{vi.advanceTimersByTime(PROGRESS_MIN_MS);});
    view.rerender(<BarProgress label={false}/>);
    expect(view.queryByRole('status')).toBeNull();
    expect(document.querySelector('.loading-line.is-leaving')).not.toBeNull();
    act(()=>{vi.advanceTimersByTime(PROGRESS_FADE_MS);});
    expect(document.querySelector('.loading-line')).toBeNull();
  });
});
