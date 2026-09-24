import {act,cleanup,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,api:vi.fn()}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:()=>({measure:()=>{},getTotalSize:()=>200,getVirtualItems:()=>[{key:0,index:0,start:0}]})}));
import {Gallery} from './Gallery';
import {clearMediaCache} from './media';

afterEach(()=>{cleanup();clearMediaCache();vi.useRealTimers();vi.unstubAllGlobals();mocks.native.mockReset();});
it('warms intersecting gallery images only and keeps valid tickets across visibility and page appends',async()=>{
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  const observers=new Map<Element,(visible:boolean)=>void>();
  vi.stubGlobal('IntersectionObserver',class{
    constructor(private callback:(entries:{isIntersecting:boolean}[])=>void){}
    observe(element:Element){observers.set(element,visible=>this.callback([{isIntersecting:visible}]));}
    disconnect(){}
  });
  mocks.native.mockImplementation(async(op:string,payload:{assetIds:string[]})=>{
    expect(op).toBe('mediaTickets');
    return {items:payload.assetIds.map(assetId=>({assetId,expires_at:new Date(Date.now()+300_000).toISOString()}))};
  });
  const items=[{id:'a',kind:'image',preview:'https://test.invalid/a'},{id:'b',kind:'image',preview:'https://test.invalid/b'}];
  const props={density:1,identity:'library',restoreScroll:0,onScroll:()=>{},onOpen:()=>{},onReady:()=>{},onNearEnd:()=>{},paused:false};
  const view=render(<Gallery {...props} items={items}/>);
  const a=view.container.querySelector('[data-asset-id="a"]')!;
  expect(observers.has(a)).toBe(true);
  await act(async()=>{observers.get(a)!(true);await vi.advanceTimersByTimeAsync(0);});
  expect(mocks.native).toHaveBeenCalledTimes(1);
  expect(mocks.native.mock.calls[0][1]).toEqual({assetIds:['a']});
  view.rerender(<Gallery {...props} items={[...items,{id:'c',kind:'image',preview:'https://test.invalid/c'}]}/>);
  await act(async()=>{observers.get(a)!(false);observers.get(a)!(true);await vi.advanceTimersByTimeAsync(0);});
  expect(mocks.native).toHaveBeenCalledTimes(1);
  view.rerender(<Gallery {...props} items={items} paused/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(300_000);});
  expect(mocks.native).toHaveBeenCalledTimes(1);
});
