import {useRef} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {usePullToRefresh} from './usePullToRefresh';
afterEach(cleanup);
function Harness({refresh,busy=false,paused=false}:{refresh():void;busy?:boolean;paused?:boolean}){const host=useRef<HTMLDivElement>(null);const indicator=usePullToRefresh(host,refresh,busy,paused);return <div ref={host} data-testid="scroll">{indicator}</div>;}
function pull(element:HTMLElement,x=0,y=140){fireEvent.touchStart(element,{touches:[{clientX:0,clientY:0}]});fireEvent.touchMove(element,{touches:[{clientX:x,clientY:y}]});}
it('refreshes exactly once on release after a downward pull at the top',()=>{
 const refresh=vi.fn();const view=render(<Harness refresh={refresh}/>);const host=screen.getByTestId('scroll');
 pull(host);expect(screen.getByText('놓으면 새로고침')).toBeTruthy();expect(refresh).not.toHaveBeenCalled();fireEvent.touchEnd(host);expect(refresh).toHaveBeenCalledOnce();
 view.rerender(<Harness refresh={refresh} busy/>);expect(screen.getByText('새로고침 중')).toBeTruthy();pull(host);fireEvent.touchEnd(host);expect(refresh).toHaveBeenCalledOnce();
});
it('leaves scrolling, horizontal swipes, mouse input, short pulls and cancelled touches alone',()=>{
 const refresh=vi.fn();render(<Harness refresh={refresh}/>);const host=screen.getByTestId('scroll');
 host.scrollTop=20;pull(host);fireEvent.touchEnd(host);host.scrollTop=0;
 pull(host,140,20);fireEvent.touchEnd(host);pull(host,0,50);fireEvent.touchEnd(host);
 pull(host);fireEvent.touchCancel(host);fireEvent.touchEnd(host);
 fireEvent.mouseDown(host,{clientY:0});fireEvent.mouseMove(host,{clientY:200});fireEvent.mouseUp(host);
 expect(refresh).not.toHaveBeenCalled();
});
it('does not pull when hidden or when two fingers are used',()=>{
 const refresh=vi.fn();const view=render(<Harness refresh={refresh} paused/>);const host=screen.getByTestId('scroll');pull(host);fireEvent.touchEnd(host);
 view.rerender(<Harness refresh={refresh}/>);fireEvent.touchStart(host,{touches:[{clientX:0,clientY:0},{clientX:20,clientY:0}]});fireEvent.touchMove(host,{touches:[{clientX:0,clientY:200}]});fireEvent.touchEnd(host);
 expect(refresh).not.toHaveBeenCalled();
});
