import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import {dateLabel} from './model';
import * as media from './media';
import * as warm from './originalTicketWarm';
const measured=vi.hoisted(()=>({sizes:[] as number[]}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
 measured.sizes=Array.from({length:count},(_,i)=>estimateSize(i));
 return {measure(){},getTotalSize:()=>measured.sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>measured.sizes.map((_size,index)=>({key:index,index,start:measured.sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
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

it('vault mode keeps the tile layout but never uses the library media client',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.stubGlobal('IntersectionObserver',class{constructor(private callback:(entries:{isIntersecting:boolean}[])=>void){} observe(){this.callback([{isIntersecting:true}]);} disconnect(){}});
 const spies=[vi.spyOn(media,'loadThumbnail'),vi.spyOn(media,'prefetchThumbnails'),vi.spyOn(media,'mediaTicket'),vi.spyOn(media,'invalidateTicket'),vi.spyOn(warm,'warmOriginalTickets')];
 const onReady=vi.fn();
 const items=[{id:'shaped',kind:'image',preview:'https://app.lakomics.local/vault/s/a'},{id:'bare',kind:'video'}];
 render(<Gallery items={items} vault={{label:asset=>`항목 ${asset.id}`}} density={1} identity="vault" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={onReady} onNearEnd={()=>{}} paused={false}/>);
 const tile=screen.getByRole('button',{name:'항목 shaped'});
 expect(screen.getByRole('button',{name:'항목 bare'}).querySelector('.missing-media')).toBeTruthy();
 const image=tile.querySelector('img')!;
 Object.defineProperties(image,{naturalWidth:{value:300},naturalHeight:{value:200}});
 fireEvent.load(image);
 expect(onReady).toHaveBeenCalledWith(expect.objectContaining({id:'shaped',ratio:1.5}));
 fireEvent.error(image);
 expect(tile.querySelector('img')).toBeNull();
 for(const spy of spies)expect(spy).not.toHaveBeenCalled();
});
