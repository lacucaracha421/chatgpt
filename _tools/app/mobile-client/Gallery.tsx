import {warmOriginalTickets} from './originalTicketWarm';
import {usePullToRefresh} from './usePullToRefresh';
import {useEffect, useLayoutEffect, useMemo, useRef, useState,type ReactNode} from 'react';
import {ARRIVE_RISE_PX, ARRIVE_WAIT_MS, arrive, holdArrival, holdImage, useAppendArrivals} from './motion';
import {observeElementRect, useVirtualizer, type Virtualizer} from '@tanstack/react-virtual';
import {PlayIcon, PhotoIcon} from '@heroicons/react/24/outline';
import type {Asset} from './types';
import {dateLabel, justifiedRows, rowHeight} from './model';
import {invalidateTicket, loadThumbnail, mediaTicket, prefetchThumbnails} from './media';

/**
 * Private Vault tiles. `asset.preview` is the native vault route, used as-is: no tickets,
 * thumbnail loading/prefetch, original warming or retries through the library media client.
 */
export type GalleryVaultSource = {label(asset: Asset): string};

function Tile({asset, index, width, height, onOpen, onReady, paused, vault, arriving, onArrived}: {asset: Asset; index: number; width: number; height: number; onOpen(index: number): void; onReady(asset:Asset):void; paused:boolean; vault?:GalleryVaultSource;
  /** Appended by a page load and not shown yet: the tile waits for its thumbnail, then rises in. */arriving:boolean; onArrived(id:string):void}) {
  const host=useRef<HTMLButtonElement>(null), image=useRef<HTMLImageElement>(null);
  useEffect(()=>{
    const element=host.current;if(paused||vault||!element||!window.IntersectionObserver)return;
    let visible:AbortController|undefined;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){
        if(!visible){visible=new AbortController();warmOriginalTickets([asset],visible.signal);}
      }else{visible?.abort();visible=undefined;}
    },{root:element.closest('.gallery-scroll'),rootMargin:'0px'});
    observer.observe(element);
    return()=>{observer.disconnect();visible?.abort();};
  },[asset.id,asset.kind,asset.pending,paused,vault]);
  const [preview, setPreview] = useState(asset.preview);
  const [retried, setRetried] = useState(false);
  // A new thumbnail revision is a new image: it reloads while the tile keeps the old one.
  useEffect(() => {
    const controller = new AbortController();
    if (!paused && !vault && !asset.preview) void loadThumbnail(asset, controller.signal).then(ready => {
      if (!controller.signal.aborted && ready.preview) {setPreview(ready.preview); onReady(ready);}
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, asset.thumbnail_available, asset.thumbnail_revision, asset.pending, onReady, paused, vault]);
  const hasPreview=!!preview;
  // An appended tile stays transparent in its final box until its thumbnail is decoded (or a
  // short wait ends), then rises in once. Any other tile whose first image comes late fades it in.
  const waiting=useRef(false);
  useLayoutEffect(()=>{
    if(!arriving||waiting.current)return;
    waiting.current=holdArrival(host.current);
    if(!waiting.current)onArrived(asset.id);
  },[]);// eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(()=>{if(hasPreview&&!waiting.current)holdImage(image.current);},[hasPreview]);
  const settle=()=>{if(waiting.current){waiting.current=false;onArrived(asset.id);arrive(host.current,ARRIVE_RISE_PX);}else arrive(image.current);};
  useEffect(()=>{
    if(!waiting.current)return;
    const timer=window.setTimeout(()=>{
      if(!waiting.current)return;
      // Shown before its thumbnail: the image then fades in by itself when it comes.
      waiting.current=false;holdImage(image.current);onArrived(asset.id);arrive(host.current,ARRIVE_RISE_PX);
    },hasPreview||!(vault||asset.thumbnail_available===false)?ARRIVE_WAIT_MS:0);
    return()=>window.clearTimeout(timer);
  },[hasPreview]);// eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => {
    if (vault) {setPreview(undefined); return;}
    if (retried || asset.pending || asset.thumbnail_available === false) return;
    setRetried(true); invalidateTicket(asset, 'thumbnail');
    void mediaTicket(asset, 'thumbnail').then(t => setPreview(t.url), () => {});
  };
  return <button ref={host} className="media-tile" style={{width}} onClick={() => onOpen(index)} aria-label={vault ? vault.label(asset) : `${asset.creator_name || asset.creator_handle || (asset.kind === 'video' ? '영상' : '이미지')}, ${dateLabel(asset)}`} data-asset-id={asset.id}>
    <span className="tile-picture" style={{height}}>
      {preview ? <img ref={image} src={preview} alt="" draggable={false} onError={() => {settle(); retry();}} onLoad={event => {
        const element = event.currentTarget;
        // A vault item without index dimensions takes its shape from the decoded thumbnail.
        if (vault && !asset.ratio && !(asset.width && asset.height) && element.naturalWidth > 0 && element.naturalHeight > 0) onReady({...asset, ratio: element.naturalWidth / element.naturalHeight});
        void (typeof element.decode === 'function' ? element.decode() : Promise.resolve()).catch(() => {}).then(settle);
      }}/> : <PhotoIcon className="missing-media" aria-hidden="true"/>}
      {asset.kind === 'video' && <span className="video-mark" aria-label="영상"><PlayIcon/></span>}
    </span>
  </button>;
}

/**
 * A retained tab is hidden with display:none, which reports a zero-size scroller. Passing that
 * on would shrink the rendered rows to the overscan and unmount the tiles below it, so every
 * returning tab re-created and re-decoded their images (a visible flicker). The last real size
 * is kept instead; a later real resize still lays the rows out again.
 */
const observeShownRect = (instance: Virtualizer<HTMLDivElement, Element>, callback: (rect: {width: number; height: number}) => void) =>
  observeElementRect(instance, rect => { if (rect.width > 0 && rect.height > 0) callback(rect); });

export function Gallery({items, density, identity, restoreScroll, onScroll, onOpen, onReady, onNearEnd, paused, intro, onRefresh, busy=false, stale=false, vault}: {items: Asset[]; density: number; identity: string; restoreScroll: number; onScroll(top: number): void; onOpen(index: number): void; onReady(asset:Asset):void; onNearEnd():void; paused:boolean;intro?:ReactNode;onRefresh?():void;busy?:boolean;/** The items belong to the previous place and stay only until the new one commits. */stale?:boolean;
  /** Private Vault mode: same layout and gestures, no library media client. */
  vault?:GalleryVaultSource}) {
  const parent = useRef<HTMLDivElement>(null);
  const pull=usePullToRefresh(parent,onRefresh,busy,paused);
  const introduction=useRef<HTMLDivElement>(null);
  const [introHeight,setIntroHeight]=useState(0);
  useLayoutEffect(()=>{
    const element=introduction.current;
    if(!element){setIntroHeight(0);return;}
    const measure=()=>{if(parent.current?.clientWidth)setIntroHeight(element.getBoundingClientRect().height);};
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[intro!=null]);
  const [width, setWidth] = useState(600);
  const rows = useMemo(() => justifiedRows(items, width, rowHeight(density, width)), [items, width, density]);
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => parent.current, estimateSize: i => rows[i].height + 10, overscan: 2,scrollMargin:introHeight,observeElementRect:observeShownRect});
  const oldRows = useRef(rows);
  // Assets added by a page append (same gallery, same head, more items) arrive once each; the
  // first page of a place, a replaced list and tiles re-mounted while scrolling back never do.
  const arrivals = useAppendArrivals(identity, useMemo(() => items.map(asset => asset.id), [items]));
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
    if (paused || vault || lastRow < 0 || !element || element.clientHeight <= 0) return;
    const controller = new AbortController(), ahead: Asset[] = [];
    let height = 0;
    for (let index = lastRow + 1; index < rows.length && height < element.clientHeight * 2; index++) {
      height += rows[index].height; ahead.push(...rows[index].items.map(item => item.asset));
    }
    prefetchThumbnails(ahead, controller.signal);
    return () => controller.abort();
  }, [lastRow, rows, paused, vault]);
  const checkEnd = () => {const element = parent.current; if (!paused && element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight) onNearEnd();};
  useEffect(checkEnd, [items.length, onNearEnd, paused]);
  return <div className={`gallery-scroll${stale?' is-stale':''}`} ref={parent} onScroll={event => {if (!paused && event.currentTarget.clientHeight > 0) onScroll(event.currentTarget.scrollTop); checkEnd();}} aria-label="자산 목록" tabIndex={0}>
    {/* The refresh pill is a zero-height sticky overlay, so it never changes the intro height. */}
    {pull}
    {intro!=null&&<div ref={introduction}>{intro}</div>}
    <div className="gallery-canvas" style={{height: virtualizer.getTotalSize()}}>
      {virtualizer.getVirtualItems().map(virtual => <div className="gallery-row" key={virtual.key} style={{transform: `translateY(${virtual.start-introHeight}px)`}}>
        {rows[virtual.index].items.map(item => <Tile key={item.asset.id} {...item} height={rows[virtual.index].height} onOpen={onOpen} onReady={onReady} paused={paused} vault={vault} arriving={arrivals.arriving(item.asset.id)} onArrived={arrivals.arrived}/>) }
      </div>)}
    </div>
  </div>;
}
