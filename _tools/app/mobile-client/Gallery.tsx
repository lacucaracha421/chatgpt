import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {PlayIcon, PhotoIcon} from '@heroicons/react/24/outline';
import type {Asset} from './types';
import {dateLabel, justifiedRows, rowHeight} from './model';
import {invalidateTicket, loadThumbnail, mediaTicket} from './media';

function Tile({asset, index, width, height, onOpen, onReady, paused}: {asset: Asset; index: number; width: number; height: number; onOpen(index: number): void; onReady(asset:Asset):void; paused:boolean}) {
  const [preview, setPreview] = useState(asset.preview);
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!paused && !asset.preview) void loadThumbnail(asset, controller.signal).then(ready => {
      if (!controller.signal.aborted && ready.preview) {setPreview(ready.preview); onReady(ready);}
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, onReady, paused]);
  const retry = () => {
    if (retried || asset.pending || asset.thumbnail_available === false) return;
    setRetried(true); invalidateTicket(asset, 'thumbnail');
    void mediaTicket(asset, 'thumbnail').then(t => setPreview(t.url), () => {});
  };
  return <button className="media-tile" style={{width}} onClick={() => onOpen(index)} aria-label={`${asset.creator_name || asset.creator_handle || (asset.kind === 'video' ? '영상' : '이미지')}, ${dateLabel(asset)}`} data-asset-id={asset.id}>
    <span className="tile-picture" style={{height}}>
      {preview ? <img src={preview} alt="" draggable={false} onError={retry}/> : <PhotoIcon className="missing-media" aria-hidden="true"/>}
      {asset.kind === 'video' && <span className="video-mark"><PlayIcon/>영상</span>}
    </span>
    <span className="tile-caption"><span>{asset.creator_name || asset.creator_handle || '작가 정보 없음'}</span><time>{dateLabel(asset)}</time></span>
  </button>;
}

export function Gallery({items, density, identity, restoreScroll, onScroll, onOpen, onReady, onNearEnd, paused}: {items: Asset[]; density: number; identity: string; restoreScroll: number; onScroll(top: number): void; onOpen(index: number): void; onReady(asset:Asset):void; onNearEnd():void; paused:boolean}) {
  const parent = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const rows = useMemo(() => justifiedRows(items, width, rowHeight(density, width)), [items, width, density]);
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => parent.current, estimateSize: i => rows[i].height + 42, overscan: 2});
  const oldRows = useRef(rows);
  useLayoutEffect(() => {
    const scroll = parent.current;
    if (!scroll) return;
    let total = 0, anchor = oldRows.current[0]?.items[0]?.asset.id;
    for (const row of oldRows.current) { anchor = row.items[0]?.asset.id; if (total + row.height + 42 > scroll.scrollTop) break; total += row.height + 42; }
    const offset = scroll.scrollTop - total;
    let newTop = 0;
    for (const row of rows) { if (row.items.some(item => item.asset.id === anchor)) break; newTop += row.height + 42; }
    virtualizer.measure();
    if (oldRows.current !== rows && oldRows.current.some(r => r.items.some(i => i.asset.id === anchor))) scroll.scrollTop = newTop + Math.max(0, offset);
    oldRows.current = rows;
  }, [rows, virtualizer]);
  useLayoutEffect(() => { if (parent.current) parent.current.scrollTop = restoreScroll; }, [identity]); // restore only when a committed view/page changes
  useEffect(() => {
    const element = parent.current; if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(1, element.clientWidth - 32)));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const checkEnd = () => {const element = parent.current; if (element && element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight) onNearEnd();};
  useEffect(checkEnd, [items.length, onNearEnd]);
  return <div className="gallery-scroll" ref={parent} onScroll={event => {onScroll(event.currentTarget.scrollTop); checkEnd();}} aria-label="자산 목록" tabIndex={0}>
    <div className="gallery-canvas" style={{height: virtualizer.getTotalSize()}}>
      {virtualizer.getVirtualItems().map(virtual => <div className="gallery-row" key={virtual.key} style={{transform: `translateY(${virtual.start}px)`}}>
        {rows[virtual.index].items.map(item => <Tile key={item.asset.id} {...item} height={rows[virtual.index].height} onOpen={onOpen} onReady={onReady} paused={paused}/>) }
      </div>)}
    </div>
  </div>;
}
