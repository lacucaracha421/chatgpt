import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import {dateLabel} from './model';
const measured=vi.hoisted(()=>({sizes:[] as number[]}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
 measured.sizes=Array.from({length:count},(_,i)=>estimateSize(i));
 return {measure(){},getTotalSize:()=>measured.sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>measured.sizes.map((_size,index)=>({key:index,index,start:measured.sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('keeps accessible creator/date and video labels without caption space under tiles',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const asset={id:'one',kind:'video',preview:'data:image/png;base64,AA',width:600,height:800,creator_name:'작가',collected_at:'2026-09-23'};
 render(<Gallery items={[asset]} density={1} identity="all" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false}/>);
 expect(screen.getByRole('button',{name:`작가, ${dateLabel(asset)}`})).toBeTruthy();
 expect(screen.getByLabelText('영상')).toBeTruthy();
 expect(document.querySelector('.tile-caption')).toBeNull();
 const picture=document.querySelector('.tile-picture') as HTMLElement;
 expect(measured.sizes[0]).toBe(Number.parseFloat(picture.style.height)+10);
});
