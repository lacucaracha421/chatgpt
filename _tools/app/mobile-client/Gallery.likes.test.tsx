import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const likes=vi.hoisted(()=>({liked:new Set(['member']),available:true,pending:new Set<string>(),error:'',toggle:vi.fn()}));
vi.mock('./useLikesAlbum',()=>({useLikesAlbum:()=>likes}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>({measure(){},getTotalSize:()=>1000,getVirtualItems:()=>Array.from({length:count},(_,index)=>({key:index,index,start:index*estimateSize(index)}))})}));
import {Gallery} from './Gallery';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('fills only membership hearts, toggles without opening the tile, and hides unsupported hearts',()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  const onOpen=vi.fn();
  const props={items:[{id:'member',kind:'image',preview:'data:image/png;base64,AA',width:300,height:300,favorite:false},{id:'flag',kind:'image',preview:'data:image/png;base64,AA',width:300,height:300,favorite:true}],density:1,identity:'likes',restoreScroll:0,onScroll:vi.fn(),onOpen,onReady:vi.fn(),onNearEnd:vi.fn(),paused:false};
  const {rerender}=render(<Gallery {...props}/>);
  const hearts=screen.getAllByRole('button',{name:'좋아요'});
  expect(hearts[0].getAttribute('aria-pressed')).toBe('true');expect(hearts[1].getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(hearts[0]);expect(likes.toggle).toHaveBeenCalledWith('member');expect(onOpen).not.toHaveBeenCalled();
  likes.available=false;rerender(<Gallery {...props}/>);expect(screen.queryByRole('button',{name:'좋아요'})).toBeNull();
});
