import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import * as model from './model';

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('ignores hidden width measurements and does not paginate or save hidden scroll events',()=>{
  const observers:{callback:()=>void;element?:Element}[]=[];
  vi.stubGlobal('ResizeObserver',class{
    entry:{callback:()=>void;element?:Element};
    constructor(callback:()=>void){this.entry={callback};observers.push(this.entry);}
    observe(element:Element){this.entry.element=element;} unobserve(){} disconnect(){}
  });
  const layout=vi.spyOn(model,'justifiedRows');
  const props={items:[{id:'one',kind:'image' as const,preview:'blob:one'}],density:1,identity:'library',restoreScroll:0,onScroll:vi.fn(),onOpen:vi.fn(),onReady:vi.fn(),onNearEnd:vi.fn(),paused:false};
  const view=render(<Gallery {...props}/>);
  const scroll=screen.getByLabelText('자산 목록'); let width=800;
  Object.defineProperties(scroll,{clientWidth:{get:()=>width},clientHeight:{value:600},scrollHeight:{value:1000}});
  const measure=()=>observers.filter(entry=>entry.element===scroll).at(-1)!.callback();
  act(measure);
  expect(layout.mock.lastCall?.[1]).toBe(768);
  scroll.scrollTop=420;
  view.rerender(<Gallery {...props} paused/>);
  width=0;
  act(measure);
  expect(layout.mock.lastCall?.[1]).toBe(768);
  fireEvent.scroll(scroll);
  expect(props.onScroll).not.toHaveBeenCalled();
  expect(props.onNearEnd).not.toHaveBeenCalled();
  expect(scroll.scrollTop).toBe(420);
  width=1000;
  act(measure);
  expect(layout.mock.lastCall?.[1]).toBe(968);
  view.rerender(<Gallery {...props}/>);
  expect(props.onNearEnd).toHaveBeenCalledTimes(1);
});
it('restores an asynchronously returned cached scroll position without requiring another navigation',()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  const props={items:[],density:1,identity:'series:one',restoreScroll:0,onScroll:vi.fn(),onOpen:vi.fn(),onReady:vi.fn(),onNearEnd:vi.fn(),paused:false};
  const view=render(<Gallery {...props} intro={<div>Series overview</div>}/>);
  const scroll=screen.getByLabelText('자산 목록');
  expect(scroll.contains(screen.getByText('Series overview'))).toBe(true);
  view.rerender(<Gallery {...props} restoreScroll={640} intro={<div>Series overview</div>}/>);
  expect(scroll.scrollTop).toBe(640);
  view.rerender(<Gallery {...props} identity="character:one"/>);
  expect(scroll.scrollTop).toBe(0);
  expect(screen.queryByText('Series overview')).toBeNull();
});
