import {useRef} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {useLevelMotion,useScrollMemory} from './motion';

function Level({levelKey,depth}:{levelKey:string|null;depth:number}){const host=useRef<HTMLDivElement>(null);useLevelMotion(host,levelKey,depth);return <div ref={host} data-testid="level"/>;}
let animate:ReturnType<typeof vi.fn>;
function reduced(value:boolean){vi.stubGlobal('matchMedia',(query:string)=>({matches:value&&query.includes('reduce'),media:query,addEventListener(){},removeEventListener(){}}));}
beforeEach(()=>{animate=vi.fn(()=>({cancel(){}}));(HTMLElement.prototype as unknown as {animate:unknown}).animate=animate;reduced(false);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
const firstFrame=(call:number)=>(animate.mock.calls[call][0] as Keyframe[])[0];

it('slides a deeper level in from the right and a shallower one from the left',()=>{
  const view=render(<Level levelKey="root" depth={0}/>);
  expect(animate).not.toHaveBeenCalled();
  view.rerender(<Level levelKey="folder" depth={1}/>);
  expect(firstFrame(0).transform).toBe('translateX(32px)');
  view.rerender(<Level levelKey="root" depth={0}/>);
  expect(firstFrame(1).transform).toBe('translateX(-32px)');
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
