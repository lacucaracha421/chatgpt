import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const likes=vi.hoisted(()=>({useLikesAlbum:vi.fn()}));
vi.mock('./useLikesAlbum',()=>likes);
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>({measure(){},getTotalSize:()=>1000,getVirtualItems:()=>Array.from({length:count},(_,index)=>({key:index,index,start:index*estimateSize(index)}))})}));
import {Gallery} from './Gallery';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows no heart on gallery tiles and reads no likes (the heart lives in the viewer)',()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  const props={items:[{id:'member',kind:'image',preview:'data:image/png;base64,AA',width:300,height:300,favorite:true}],density:1,identity:'likes',restoreScroll:0,onScroll:vi.fn(),onOpen:vi.fn(),onReady:vi.fn(),onNearEnd:vi.fn(),paused:false};
  render(<Gallery {...props}/>);
  expect(screen.queryByRole('button',{name:'좋아요'})).toBeNull();
  expect(likes.useLikesAlbum).not.toHaveBeenCalled();
});
