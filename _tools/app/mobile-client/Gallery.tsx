import {usePullToRefresh} from './usePullToRefresh';
import {useEffect, useLayoutEffect, useMemo, useRef, useState,type ReactNode} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {PlayIcon, PhotoIcon} from '@heroicons/react/24/outline';
import type {Asset} from './types';
import {dateLabel, justifiedRows, rowHeight} from './model';
import {invalidateTicket, loadThumbnail, mediaTicket, prefetchThumbnails} from './media';

function Tile({asset, index, width, height, onOpen, onReady, paused}: {asset: Asset; index: number; width: number; height: number; onOpen(index: number): void; onReady(asset:Asset):void; paused:boolean}) {
  const [preview, setPreview] = useState(asset.preview);
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!paused && !asset.preview) void loadThumbnail(asset, controller.signal).then(ready => {
      if (!controller.signal.aborted && ready.preview) {setPreview(ready.preview); onReady(ready);}
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, asset.thumbnail_available, asset.pending, onReady, paused]);
  const retry = () => {
    if (retried || asset.pending || asset.thumbnail_available === false) return;
    setRetried(true); invalidateTicket(asset, 'thumbnail');
    void mediaTicket(asset, 'thumbnail').then(t => setPreview(t.url), () => {});
  };
  return <button className="media-tile" style={{width}} onClick={() => onOpen(index)} aria-label={`${asset.creator_name || asset.creator_handle || (asset.kind === 'video' ? '영상' : '이미지')}, ${dateLabel(asset)}`} data-asset-id={asset.id}>
    <span className="tile-picture" style={{height}}>
      {preview ? <img src={preview} alt="" draggable={false} onError={retry}/> : <PhotoIcon className="missing-media" aria-hidden="true"/>}
      {asset.kind === 'video' && <span className="video-mark" aria-label="영상"><PlayIcon/></span>}
    </span>
  </button>;
}

export function Gallery({items, density, identity, restoreScroll, onScroll, onOpen, onReady, onNearEnd, paused, intro, onRefresh, busy=false}: {items: Asset[]; density: number; identity: string; restoreScroll: number; onScroll(top: number): void; onOpen(index: number): void; onReady(asset:Asset):void; onNearEnd():void; paused:boolean;intro?:ReactNode;onRefresh?():void;busy?:boolean}) {
  const parent = useRef<HTMLDivElement>(null);
  const pull=usePullToRefresh(parent,onRefresh,busy,paused);
  const introduction=useRef<HTMLDivElement>(null);
  const [introHeight,setIntroHeight]=useState(0);
  useLayoutEffect(()=>{
    const element=introduction.current;
    if(!element){setIntroHeight(0);return;}
    const measure=()=>{if(parent.current?.clientWidth)setIntroHeight(element.getBoundingClientRect().height);};
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[intro!=null,onRefresh!=null,busy]);
  const [width, setWidth] = useState(600);
  const rows = useMemo(() => justifiedRows(items, width, rowHeight(density, width)), [items, width, density]);
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => parent.current, estimateSize: i => rows[i].height + 10, overscan: 2,scrollMargin:introHeight});
  const oldRows = useRef(rows);
  useLayoutEffect(() => {
    const scroll = parent.current;
    if (!scroll) return;
    let total = introHeight, anchor = oldRows.current[0]?.items[0]?.asset.id;
    for (const row of oldRows.current) { anchor = row.items[0]?.asset.id; if (total + row.height + 10 > scroll.scrollTop) break; total += row.height + 10; }
    const offset = scroll.scrollTop - total;
    let newTop = introHeight;
    for (const row of rows) { if (row.items.some(item => item.asset.id === anchor)) break; newTop += row.height + 10; }
    virtualizer.measure();
    if (scroll.scrollTop>=introHeight && oldRows.current !== rows && oldRows.current.some(r => r.items.some(i => i.asset.id === anchor))) scroll.scrollTop = newTop + Math.max(0, offset);
    oldRows.current = rows;
  }, [rows, virtualizer, introHeight]);
  // A cached character page may arrive after its navigation identity committed.
  useLayoutEffect(() => { if (parent.current) parent.current.scrollTop = restoreScroll; }, [identity, restoreScroll]);
  useEffect(() => {
    const element = parent.current; if (!element) return;
    // A retained tab reports zero width under display:none, not a new gallery layout.
    const observer = new ResizeObserver(() => {if (element.clientWidth > 32) setWidth(element.clientWidth - 32);});
    observer.observe(element); return () => observer.disconnect();
  }, []);
  // Warm roughly two screens below what is rendered; a new position replaces the old batch.
  const virtualRows = virtualizer.getVirtualItems();
  const lastRow = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;
  useEffect(() => {
    const element = parent.current;
    if (paused || lastRow < 0 || !element || element.clientHeight <= 0) return;
    const controller = new AbortController(), ahead: Asset[] = [];
    let height = 0;
    for (let index = lastRow + 1; index < rows.length && height < element.clientHeight * 2; index++) {
      height += rows[index].height; ahead.push(...rows[index].items.map(item => item.asset));
    }
    prefetchThumbnails(ahead, controller.signal);
    return () => controller.abort();
  }, [lastRow, rows, paused]);
  const checkEnd = () => {const element = parent.current; if (!paused && element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight) onNearEnd();};
  useEffect(checkEnd, [items.length, onNearEnd, paused]);
  return <div className="gallery-scroll" ref={parent} onScroll={event => {if (!paused && event.currentTarget.clientHeight > 0) onScroll(event.currentTarget.scrollTop); checkEnd();}} aria-label="자산 목록" tabIndex={0}>
    {(intro!=null||onRefresh)&&<div ref={introduction}>{pull}{intro}</div>}
    <div className="gallery-canvas" style={{height: virtualizer.getTotalSize()}}>
      {virtualizer.getVirtualItems().map(virtual => <div className="gallery-row" key={virtual.key} style={{transform: `translateY(${virtual.start-introHeight}px)`}}>
        {rows[virtual.index].items.map(item => <Tile key={item.asset.id} {...item} height={rows[virtual.index].height} onOpen={onOpen} onReady={onReady} paused={paused}/>) }
      </div>)}
    </div>
  </div>;
}
