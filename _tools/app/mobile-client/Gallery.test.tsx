import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
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
