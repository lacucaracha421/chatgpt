import {act,cleanup,render,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),thumbnail:vi.fn(async(asset)=>asset)}));
vi.mock('./transport',()=>({api:mocks.api}));
vi.mock('./media',()=>({loadThumbnail:mocks.thumbnail}));
import {FolderCards,useFolderCovers} from './FolderCards';
const folders=[{id:'original',name:'오리지널',parent_id:null,asset_count:1}];
const advance=(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{
  vi.useFakeTimers();mocks.api.mockReset();
  vi.stubGlobal('IntersectionObserver',undefined);
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('retries a failed landscape shelf listing while the folder remains visible',async()=>{
  mocks.api.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({items:[{id:'cover',kind:'image',preview:'https://example.invalid/cover'}],has_more:false,next_cursor:null});
  const view=render(<FolderCards items={folders} entries={folders} paused={false} revision={1} strip onSelect={()=>{}}/>);
  await advance();expect(mocks.api).toHaveBeenCalledTimes(1);expect(view.container.querySelector('img')).toBeNull();
  await advance(1000);expect(mocks.api).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/cover');
});
it('bounds listing retries and cancels them while paused',async()=>{
  mocks.api.mockRejectedValue(new Error('offline'));
  const view=renderHook(({paused})=>useFolderCovers(folders,paused,1,folders),{initialProps:{paused:false}});
  act(()=>view.result.current.onVisible('original',true));
  for(let second=0;second<60;second++)await advance(1000);
  expect(mocks.api).toHaveBeenCalledTimes(4);
  await advance(60_000);expect(mocks.api).toHaveBeenCalledTimes(4);
  view.rerender({paused:true});view.rerender({paused:false});await advance();
  expect(mocks.api).toHaveBeenCalledTimes(5);
  view.rerender({paused:true});await advance(60_000);expect(mocks.api).toHaveBeenCalledTimes(5);
});
it('retries missing descendant covers instead of marking the empty parent complete',async()=>{
  const entries=[...folders,{id:'child',name:'하위 폴더',parent_id:'original',asset_count:1}];
  let childCalls=0;
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.includes('classification_id=child')){
      if(++childCalls===1)throw new Error('offline');
      return {items:[{id:'cover',kind:'image'}],has_more:false,next_cursor:null};
    }
    return {items:[],has_more:false,next_cursor:null};
  });
  const view=renderHook(()=>useFolderCovers(folders,false,1,entries));
  act(()=>view.result.current.onVisible('original',true));await advance();
  expect(view.result.current.covers.original).toEqual([]);
  await advance(1000);expect(view.result.current.covers.original?.[0]?.id).toBe('cover');
  expect(childCalls).toBe(2);
});
