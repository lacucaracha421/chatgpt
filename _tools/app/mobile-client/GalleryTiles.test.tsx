import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Gallery} from './Gallery';
import {dateLabel} from './model';
import * as media from './media';
import * as warm from './originalTicketWarm';
import {GALLERY_DATE_HEADING_HEIGHT} from '../src/assets/galleryRows';
const measured=vi.hoisted(()=>({sizes:[] as number[],overscan:0}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,estimateSize,overscan}:{count:number;estimateSize(i:number):number;overscan:number})=>{
 measured.overscan=overscan;
 measured.sizes=Array.from({length:count},(_,i)=>estimateSize(i));
 return {measure(){},getTotalSize:()=>measured.sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>measured.sizes.map((_size,index)=>({key:index,index,start:measured.sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('keeps a bounded row cushion and paints a placeholder before a thumbnail resolves',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 render(<Gallery items={[{id:'waiting',kind:'image'}]} density={1} identity="waiting" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused/>);
 expect(screen.getByRole('button').querySelector('.missing-media')).toBeTruthy();
 expect(measured.overscan).toBe(8);
});
it('keeps accessible creator/date and video labels without caption space under tiles',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const asset={id:'one',kind:'video',preview:'data:image/png;base64,AA',width:600,height:800,creator_name:'작가',collected_at:'2026-09-23'};
 render(<Gallery items={[asset]} density={1} identity="all" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false}/>);
 expect(screen.getByRole('button',{name:`작가, ${dateLabel(asset)}`})).toBeTruthy();
 expect(screen.getByLabelText('영상')).toBeTruthy();
 expect(document.querySelector('.tile-caption')).toBeNull();
 const picture=document.querySelector('.tile-picture') as HTMLElement;
 expect(measured.sizes[0]).toBe(Number.parseFloat(picture.style.height)+GALLERY_DATE_HEADING_HEIGHT+10);
});

it('renders date headings with weekday and count, packing small dates into one row',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const items=[
  {id:'monday',kind:'image',preview:'data:image/png;base64,AA',width:600,height:600,collected_at:'2026-09-28'},
  {id:'sunday',kind:'image',preview:'data:image/png;base64,AA',width:600,height:600,collected_at:'2026-09-27'},
 ];
 render(<Gallery items={items} density={1} identity="dates" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused/>);
 const headings=[...document.querySelectorAll<HTMLElement>('[data-date-heading]')];
 expect(headings).toHaveLength(2);
 expect(headings.map(heading=>heading.querySelector('.gallery-date-heading__day')?.textContent)).toEqual(['9.28','9.27']);
 expect(headings.map(heading=>heading.querySelector('.gallery-date-heading__weekday')?.textContent)).toEqual(['월','일']);
 expect(headings.map(heading=>heading.querySelector('.gallery-date-heading__count')?.textContent)).toEqual([undefined,undefined]); // a day with one image shows no count
 expect(headings[1].style.left).toBe('260px');
 expect(headings[1].style.width).toBe('220px');
});

it('gives a large date group a full-width heading and omits headings for non-date sorts',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const items=Array.from({length:4},(_,index)=>({id:`large-${index}`,kind:'image',preview:'data:image/png;base64,AA',width:600,height:600,collected_at:'2026-09-28'}));
 const view=render(<Gallery items={items} density={1} identity="large" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused/>);
 expect(document.querySelectorAll('[data-date-heading]')).toHaveLength(1);
 expect(document.querySelector('.gallery-date-heading')?.getAttribute('style')).toContain('width: 600px');
 view.rerender(<Gallery items={items} density={1} identity="name" scrubberSort={{kind:'name',values:items.map(item=>item.id)}} restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused/>);
 expect(document.querySelectorAll('[data-date-heading]')).toHaveLength(0);
});

it('enters selection on long press, suppresses the follow-up click, and toggles on selection taps',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.useFakeTimers();
 const onSelect=vi.fn(),onToggle=vi.fn(),onOpen=vi.fn();
 const asset={id:'selectable',kind:'image',preview:'data:image/png;base64,AA',width:600,height:600};
 const view=render(<Gallery items={[asset]} density={1} identity="selection" restoreScroll={0} onScroll={()=>{}} onOpen={onOpen} onReady={()=>{}} onNearEnd={()=>{}} paused={false} selectedIds={new Set()} onSelectAsset={onSelect} onToggleSelection={onToggle}/>);
 const tile=screen.getByRole('button');
 fireEvent.pointerDown(tile,{pointerType:'touch',clientX:10,clientY:10});
 vi.advanceTimersByTime(449);
 expect(onSelect).not.toHaveBeenCalled();
 vi.advanceTimersByTime(1);
 expect(onSelect).toHaveBeenCalledWith('selectable');
 fireEvent.pointerUp(tile);
 fireEvent.click(tile);
 expect(onToggle).not.toHaveBeenCalled();
 expect(onOpen).not.toHaveBeenCalled();

 view.rerender(<Gallery items={[asset]} density={1} identity="selection" restoreScroll={0} onScroll={()=>{}} onOpen={onOpen} onReady={()=>{}} onNearEnd={()=>{}} paused={false} selectedIds={new Set(['selectable'])} onSelectAsset={onSelect} onToggleSelection={onToggle}/>);
 expect(tile.getAttribute('aria-selected')).toBe('true');
 expect(tile.querySelector('.ui-selection-check')).toBeTruthy();
 fireEvent.click(tile);
 expect(onToggle).toHaveBeenCalledWith('selectable');
 expect(onOpen).not.toHaveBeenCalled();
});

it('leaves selection on a double tap on empty gallery space, not on a tile',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const asset={id:'selectable',kind:'image',width:100,height:100,preview:'data:image/png;base64,AA=='};
 const onClear=vi.fn();
 const view=render(<Gallery items={[asset]} density={1} identity="clear" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false} selectedIds={new Set(['selectable'])} onSelectAsset={()=>{}} onToggleSelection={()=>{}} onClearSelection={onClear}/>);
 const scroll=view.container.querySelector('.gallery-scroll')!;
 const tile=view.container.querySelector('.media-tile')!;
 fireEvent.pointerUp(tile,{clientX:10,clientY:10});fireEvent.pointerUp(tile,{clientX:10,clientY:10});
 expect(onClear).not.toHaveBeenCalled();
 fireEvent.pointerUp(scroll,{clientX:300,clientY:500});fireEvent.pointerUp(scroll,{clientX:302,clientY:501});
 expect(onClear).toHaveBeenCalledOnce();
});
it('cancels a long press after movement or gallery scroll',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.useFakeTimers();
 const onSelect=vi.fn();
 const asset={id:'cancelled',kind:'image',preview:'data:image/png;base64,AA',width:600,height:600};
 const view=render(<Gallery items={[asset]} density={1} identity="cancel" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused={false} selectedIds={new Set()} onSelectAsset={onSelect} onToggleSelection={()=>{}}/>);
 const tile=screen.getByRole('button');
 fireEvent.pointerDown(tile,{pointerType:'touch',clientX:10,clientY:10});
 fireEvent.pointerMove(tile,{clientX:21,clientY:10});
 vi.advanceTimersByTime(500);
 expect(onSelect).not.toHaveBeenCalled();
 fireEvent.pointerDown(tile,{pointerType:'touch',clientX:10,clientY:10});
 fireEvent.scroll(screen.getByLabelText('자산 목록'));
 vi.advanceTimersByTime(500);
 expect(onSelect).not.toHaveBeenCalled();
 view.unmount();
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

it('uses one duration pill and touch-only selection indicators, with quiet date counts',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const items=[{id:'one',kind:'video',preview:'data:image/png;base64,AA',width:600,height:600,duration_ms:42000,favorite:true,collected_at:'2026-09-28'}, {id:'two',kind:'image',preview:'data:image/png;base64,AA',width:600,height:600,collected_at:'2026-09-28'}];
 const props={items,density:1,identity:'calm',restoreScroll:0,onScroll:vi.fn(),onOpen:vi.fn(),onReady:vi.fn(),onNearEnd:vi.fn(),paused:false,onSelectAsset:vi.fn(),onToggleSelection:vi.fn()};
 const {container,rerender}=render(<Gallery {...props}/>);
 expect(container.querySelectorAll('.video-mark')).toHaveLength(1);
 expect(container.querySelector('.video-mark')?.textContent).toBe('▶ 0:42');
 expect(container.querySelector('.tile-caption')).toBeNull();
 expect(container.querySelector('.tile-favorite')).toBeNull();
 expect(container.querySelector('.tile-select')).toBeNull();
 expect(container.querySelector('.gallery-date-heading__rule')).toBeNull();
 expect(container.querySelector('.gallery-date-heading__count')?.textContent).toBe('2');
 expect(container.querySelector('.gallery-date-heading')?.getAttribute('tabindex')).toBe('0');
 rerender(<Gallery {...props} selectedIds={new Set(['two'])}/>);
 expect(container.querySelectorAll('.tile-select')).toHaveLength(2);
 expect(container.querySelector('.tile-favorite')).toBeNull();
 rerender(<Gallery {...props} favoritesView/>);
 expect(container.querySelector('.tile-favorite')).toBeNull();
});

it('hides the video pill on tiny tiles while keeping video metadata accessible',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 render(<Gallery items={[{id:'tiny',kind:'video',width:60,height:800,preview:'blob:tiny',duration_ms:42000}]} density={1} identity="tiny" restoreScroll={0} onScroll={()=>{}} onOpen={()=>{}} onReady={()=>{}} onNearEnd={()=>{}} paused/>);
 const tile=document.querySelector('[data-asset-id="tiny"]')!;
 expect(tile.getAttribute('aria-description')).toBe('영상 0:42');
 expect(tile.querySelector('.video-mark')).toBeNull();
});
