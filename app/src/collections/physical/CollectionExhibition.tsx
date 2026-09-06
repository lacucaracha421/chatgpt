import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import "./physicalCollections.css";
export function exhibitionPage(count: number, requested = 0) {
  const columns = count > 9 ? 4 : 3;
  const capacity = columns * columns;
  const pages = Math.max(1, Math.ceil(count / capacity));
  const page = Math.max(0, Math.min(pages - 1, Number.isFinite(requested) ? Math.floor(requested) : 0));
  return { columns, capacity, pages, page, start: page * capacity, end: Math.min(count, (page + 1) * capacity) };
}
export function CollectionExhibition<T>({items, page, onPageChange, render, scrollRef}: {items:readonly T[]; page:number; onPageChange:(page:number)=>void; render:(item:T,index:number)=>ReactNode; scrollRef?:RefObject<HTMLDivElement|null>}) {
  const root=useRef<HTMLDivElement>(null),[height,setHeight]=useState(600);
  const layout=exhibitionPage(items.length,page);
  useLayoutEffect(()=>{
    const element=root.current;if(!element)return;
    const update=()=>{const style=getComputedStyle(element); const available=element.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-36;if(available>0)setHeight(Math.max(320,available));};update();
    const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(update);observer?.observe(element);return()=>observer?.disconnect();
  },[]);
  const width=(height-(layout.columns-1)*4)*256/368+(layout.columns-1)*14;
  return <div className="collection-exhibition" ref={element=>{root.current=element;if(scrollRef)scrollRef.current=element;}}>
    <div className="collection-exhibition__wall" style={{"--exhibit-columns":layout.columns,height,width,maxWidth:"100%"} as CSSProperties} aria-label={`${layout.columns}행 ${layout.columns}열 전시`}>
      {items.slice(layout.start,layout.end).map((item,index)=>render(item,layout.start+index))}
    </div>
    <nav className="collection-exhibition__pages" aria-label="전시 페이지">
      <span>{layout.columns} × {layout.columns}</span>
      {layout.pages>1&&<><button type="button" disabled={layout.page===0} onClick={()=>onPageChange(layout.page-1)} aria-label="이전 전시 페이지">‹</button><span aria-live="polite">{layout.page+1} / {layout.pages}</span><button type="button" disabled={layout.page===layout.pages-1} onClick={()=>onPageChange(layout.page+1)} aria-label="다음 전시 페이지">›</button></>}
    </nav>
  </div>;
}
