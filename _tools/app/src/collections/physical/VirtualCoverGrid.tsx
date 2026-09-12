import { useVirtualizer, defaultRangeExtractor } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import "./physicalCollections.css";
type Props<T> = { textRows?:boolean; items:readonly T[]; itemKey:(item:T)=>string; render:(item:T,index:number)=>ReactNode; label:string; scrollRef?:RefObject<HTMLDivElement|null>; centered?:boolean; className?:string; metadataHeight?:number; legacyMetrics?:boolean; onEmptyContextMenu?:()=>void };
export function VirtualCoverGrid<T>({textRows=false,items,itemKey,render,label,scrollRef,centered=false,className="",metadataHeight=42,legacyMetrics=false,onEmptyContextMenu}:Props<T>) {
  const local=useRef<HTMLDivElement>(null),[width,setWidth]=useState(960);
  const [focusIndex,setFocusIndex]=useState<number|null>(null);
  const ref=useCallback((element:HTMLDivElement|null)=>{local.current=element;if(scrollRef)scrollRef.current=element;},[scrollRef]);
  const gap=24,minWidth=legacyMetrics?(window.innerWidth<=860?118:132):148;
  const availableColumns=Math.max(1,Math.floor((width+gap)/(minWidth+gap)));
  const columns=textRows?1:centered?Math.min(availableColumns,Math.max(1,items.length)):availableColumns;
  const cellWidth=centered?Math.min(176,(width-gap*(columns-1))/columns):(width-gap*(columns-1))/columns;
  const rowHeight=textRows?44:cellWidth*(legacyMetrics?1.5:368/256)+metadataHeight+gap,rows=Math.ceil(items.length/columns),virtual=items.length>64;
  const rowVirtualizer=useVirtualizer({count:rows,getScrollElement:()=>local.current,estimateSize:()=>rowHeight,overscan:1,enabled:virtual,rangeExtractor:range=>{const indexes=defaultRangeExtractor(range);const focused=focusIndex===null?-1:Math.floor(focusIndex/columns);if(focused>=0&&focused<rows&&!indexes.includes(focused))indexes.push(focused);return indexes.sort((a,b)=>a-b);},getItemKey:index=>items[index*columns]?itemKey(items[index*columns]):index,initialRect:{width:960,height:640}});
  useLayoutEffect(()=>{
    const element=local.current;if(!element)return;
    const measure=()=>{const next=element.clientWidth-24;if(next>0)setWidth(next);};measure();
    const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(measure);observer?.observe(element);return()=>observer?.disconnect();
  },[]);
  useLayoutEffect(()=>{rowVirtualizer.measure();},[rowHeight,rowVirtualizer]);
  function handleKey(event:KeyboardEvent<HTMLDivElement>) {
    if(event.altKey||event.metaKey||event.target instanceof HTMLInputElement)return;
    const cell=(event.target as HTMLElement).closest<HTMLElement>("[data-cover-index]");if(!cell)return;
    const index=Number(cell.dataset.coverIndex);
    let next=index;
    if(event.key==="ArrowRight")next++;else if(event.key==="ArrowLeft")next--;
    else if(event.key==="ArrowDown")next+=columns;else if(event.key==="ArrowUp")next-=columns;
    else if(event.key==="Home")next=0;else if(event.key==="End")next=items.length-1;else return;
    event.preventDefault();next=Math.max(0,Math.min(items.length-1,next));setFocusIndex(next);
    if(virtual)rowVirtualizer.scrollToIndex(Math.floor(next/columns),{align:"auto"});
    requestAnimationFrame(()=>local.current?.querySelector<HTMLElement>(`[data-cover-index="${next}"] button`)?.focus({preventScroll:false}));
  }
  const rowStyle={...(textRows?{gap:0}:{}),gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`,width:centered?Math.min(width,columns*cellWidth+(columns-1)*gap):undefined} satisfies CSSProperties;
  const cell=(item:T,index:number)=><div className="virtual-cover-grid__cell" key={itemKey(item)} data-cover-index={index}>{render(item,index)}</div>;
  return <div ref={ref} className={`virtual-cover-grid ${legacyMetrics ? "virtual-cover-grid--legacy" : ""} ${className} ${textRows ? "virtual-cover-grid--text" : ""}`} role="group" aria-label={label} onKeyDown={handleKey}
    onFocusCapture={event=>{const index=(event.target as HTMLElement).closest<HTMLElement>("[data-cover-index]")?.dataset.coverIndex;if(index!==undefined)setFocusIndex(Number(index));}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocusIndex(null);}}
    onContextMenu={event=>{if(onEmptyContextMenu&&!(event.target as HTMLElement).closest("button")){event.preventDefault();onEmptyContextMenu();}}}>
    {virtual?<div className="virtual-cover-grid__spacer" style={{height:rowVirtualizer.getTotalSize()}}>
      {rowVirtualizer.getVirtualItems().map(row=><div key={row.key} className="virtual-cover-grid__row" style={{...rowStyle,position:"absolute",top:0,left:0,right:0,transform:`translateY(${row.start}px)`}}>
        {items.slice(row.index*columns,(row.index+1)*columns).map((item,offset)=>cell(item,row.index*columns+offset))}
      </div>)}
    </div>:<div className="virtual-cover-grid__regular" style={rowStyle}>{items.map(cell)}</div>}
  </div>;
}
