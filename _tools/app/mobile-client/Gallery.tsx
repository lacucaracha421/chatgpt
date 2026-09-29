import {warmOriginalTickets} from './originalTicketWarm';
import {usePullToRefresh} from './usePullToRefresh';
import {useEffect, useLayoutEffect, useMemo, useRef, useState,type PointerEvent,type ReactNode} from 'react';
import {ARRIVE_RISE_PX, ARRIVE_WAIT_MS, arrive, holdArrival, holdImage, useAppendArrivals} from './motion';
import {observeElementRect, useVirtualizer, type Virtualizer} from '@tanstack/react-virtual';
import {PlayIcon, PhotoIcon} from '@heroicons/react/24/outline';
import type {Asset} from './types';
import {dateLabel, justifiedRows, ratio, rowHeight} from './model';
import {invalidateTicket, loadThumbnail, mediaTicket, prefetchThumbnails} from './media';
import {Scrubber} from './Scrubber';
import type {ScrubberSort} from './scrubberModel';
import {buildJustifiedGalleryRows, GALLERY_DATE_HEADING_HEIGHT, type GalleryRowAccessors, type JustifiedGalleryRow} from '../src/assets/galleryRows';

/**
 * Private Vault tiles. `asset.preview` is the native vault route, used as-is: no tickets,
 * thumbnail loading/prefetch, original warming or retries through the library media client.
 */
export type GalleryVaultSource = {label(asset: Asset): string};

function Tile({asset, index, width, height, onOpen, onReady, paused, privacy, vault, arriving, onArrived, selectionMode, selected, onSelect, onToggle, onPressStart, onPressEnd}: {asset: Asset; index: number; width: number; height: number; onOpen(index: number): void; onReady(asset:Asset):void; paused:boolean; privacy?:boolean; vault?:GalleryVaultSource;
  /** Appended by a page load and not shown yet: the tile waits for its thumbnail, then rises in. */arriving:boolean; onArrived(id:string):void; selectionMode:boolean; selected:boolean; onSelect?: (id:string)=>void; onToggle?: (id:string)=>void; onPressStart?: (cancel:()=>void)=>void; onPressEnd?: (cancel:()=>void)=>void}) {
  const timer=useRef<number|null>(null), pressStart=useRef<{x:number;y:number}|null>(null), suppressClick=useRef(false), pressCancel=useRef<()=>void>(()=>{});
  const host=useRef<HTMLButtonElement>(null), image=useRef<HTMLImageElement>(null);
  const clearTimer=()=>{if(timer.current!==null){window.clearTimeout(timer.current);timer.current=null;}};
  const cancelPress=()=>{clearTimer();pressStart.current=null;suppressClick.current=true;};
  useEffect(()=>()=>clearTimer(),[]);
  const beginPress=(event:PointerEvent<HTMLButtonElement>)=>{
    if(!onSelect||event.pointerType==='mouse'&&event.button!==0)return;
    clearTimer();pressStart.current={x:event.clientX,y:event.clientY};suppressClick.current=false;
    pressCancel.current=cancelPress;onPressStart?.(cancelPress);
    timer.current=window.setTimeout(()=>{
      if(!pressStart.current)return;
      pressStart.current=null;timer.current=null;suppressClick.current=true;onSelect(asset.id);
    },GALLERY_LONG_PRESS_MS);
  };
  const movePress=(event:PointerEvent<HTMLButtonElement>)=>{
    const start=pressStart.current;if(!start)return;
    if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>GALLERY_LONG_PRESS_MOVE_PX){cancelPress();onPressEnd?.(pressCancel.current);}
  };
  const endPress=()=>{clearTimer();pressStart.current=null;onPressEnd?.(pressCancel.current);};
  const cancelPointer=()=>{cancelPress();suppressClick.current=false;onPressEnd?.(pressCancel.current);};
  useEffect(()=>{
    const element=host.current;if(paused||privacy||vault||!element||!window.IntersectionObserver)return;
    let visible:AbortController|undefined;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){
        if(!visible){visible=new AbortController();warmOriginalTickets([asset],visible.signal);}
      }else{visible?.abort();visible=undefined;}
    },{root:element.closest('.gallery-scroll'),rootMargin:'0px'});
    observer.observe(element);
    return()=>{observer.disconnect();visible?.abort();};
  },[asset.id,asset.kind,asset.pending,paused,privacy,vault]);
  const [preview, setPreview] = useState(asset.preview);
  const [retried, setRetried] = useState(false);
  // A new thumbnail revision is a new image: it reloads while the tile keeps the old one.
  useEffect(() => {
    const controller = new AbortController();
    if (!paused && !privacy && !vault && !asset.preview) void loadThumbnail(asset, controller.signal).then(ready => {
      if (!controller.signal.aborted && ready.preview) {setPreview(ready.preview); onReady(ready);}
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, asset.thumbnail_available, asset.thumbnail_revision, asset.pending, onReady, paused, privacy, vault]);
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
  return <button ref={host} className="media-tile ui-selectable-media" style={{width}} onClick={() => {
    if(suppressClick.current){suppressClick.current=false;return;}
    if(selectionMode){onToggle?.(asset.id);return;}
    if(!privacy) onOpen(index);
  }} onPointerDown={beginPress} onPointerMove={movePress} onPointerUp={endPress} onPointerCancel={cancelPointer} onContextMenu={event=>{if(onSelect)event.preventDefault();}} aria-label={privacy ? '비공개 모드로 이미지 숨김' : vault ? vault.label(asset) : `${asset.creator_name || asset.creator_handle || (asset.kind === 'video' ? '영상' : '이미지')}, ${dateLabel(asset)}`} aria-selected={selectionMode&&selected?true:undefined} data-asset-id={asset.id}>
    <span className="tile-picture" style={{height}}>
      {privacy ? <span className="artist-private-tile" aria-hidden="true" /> : preview ? <img ref={image} src={preview} alt="" draggable={false} onError={() => {settle(); retry();}} onLoad={event => {
        const element = event.currentTarget;
        // A vault item without index dimensions takes its shape from the decoded thumbnail.
        if (vault && !asset.ratio && !(asset.width && asset.height) && element.naturalWidth > 0 && element.naturalHeight > 0) onReady({...asset, ratio: element.naturalWidth / element.naturalHeight});
        void (typeof element.decode === 'function' ? element.decode() : Promise.resolve()).catch(() => {}).then(settle);
      }}/> : <PhotoIcon className="missing-media" aria-hidden="true"/>}
      {asset.kind === 'video' && <span className="video-mark" aria-label="영상"><PlayIcon/></span>}
      {selectionMode&&selected&&<span className="ui-selection-check" aria-hidden="true"/>}
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
/** Keep a bounded row cushion so a fast fling still paints neutral tiles while thumbs arrive. */
export const GALLERY_ROW_OVERSCAN = 8;
const GALLERY_LONG_PRESS_MS = 450;
const GALLERY_LONG_PRESS_MOVE_PX = 10;
const GALLERY_TILE_GAP = 10;
const GALLERY_ROW_GAP = GALLERY_TILE_GAP;

type GalleryRowItem = {asset: Asset; width: number; index: number};

const mobileGalleryRowAccessors: GalleryRowAccessors<Asset, GalleryRowItem> = {
  ratio,
  dateValue: asset => asset.collected_at ?? asset.created_at,
  packItem: (asset, index, width) => ({asset, index, width}),
  buildRows: (assets, width, target, gap, startIndex) => justifiedRows(assets, width, target, gap).map(row => ({
    ...row,
    items: row.items.map(item => ({...item, index: item.index + startIndex})),
  })),
};

function rowSize(row: JustifiedGalleryRow<GalleryRowItem>) {
  return row.height + (row.dateHeadings?.length ? GALLERY_DATE_HEADING_HEIGHT : 0) + GALLERY_ROW_GAP;
}

export function Gallery({items, density, identity, restoreScroll, onScroll, onOpen, onReady, onNearEnd, paused, privacy=false, intro, onRefresh, busy=false, stale=false, vault, scrubberHidden=false, scrubberSort, selectedIds, onSelectAsset, onToggleSelection, onClearSelection}: {items: Asset[]; density: number; identity: string; restoreScroll: number; onScroll(top: number): void; onOpen(index: number): void; onReady(asset:Asset):void; onNearEnd():void; paused:boolean;privacy?:boolean;intro?:ReactNode;onRefresh?():void;busy?:boolean;/** The items belong to the previous place and stay only until the new one commits. */stale?:boolean;
  /** Additional visibility guard for sheets owned by the parent screen. */scrubberHidden?:boolean;
  /** Optional sort metadata; the date fallback follows the existing gallery order. */scrubberSort?:ScrubberSort;
  /** Tablet Library selection; absent for Revisit, character and vault galleries. */selectedIds?:ReadonlySet<string>; onSelectAsset?(id:string):void; onToggleSelection?(id:string):void;
  /** A double tap on empty gallery space (not a tile) leaves selection mode. */onClearSelection?():void;
  /** Private Vault mode: same layout and gestures, no library media client. */
  vault?:GalleryVaultSource}) {
  const parent = useRef<HTMLDivElement>(null);
  const activePress = useRef<(() => void)|null>(null);
  const registerPress=(cancel:()=>void)=>{activePress.current?.();activePress.current=cancel;};
  const releasePress=(cancel:()=>void)=>{if(activePress.current===cancel)activePress.current=null;};
  const cancelActivePress=()=>{activePress.current?.();activePress.current=null;};
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
  const sort = useMemo<ScrubberSort>(() => scrubberSort ?? {kind:'date',values:items.map(asset => asset.collected_at ?? asset.created_at)}, [items, scrubberSort]);
  const rows = useMemo<JustifiedGalleryRow<GalleryRowItem>[]>(() => buildJustifiedGalleryRows(
    items,
    width,
    rowHeight(density, width),
    GALLERY_TILE_GAP,
    sort.kind === 'date',
    false,
    mobileGalleryRowAccessors,
  ), [items, width, density, sort]);
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => parent.current, estimateSize: i => rows[i] ? rowSize(rows[i]) : rowHeight(density, width) + GALLERY_ROW_GAP, overscan: GALLERY_ROW_OVERSCAN,scrollMargin:introHeight,observeElementRect:observeShownRect});
  const oldRows = useRef(rows);
  // Assets added by a page append (same gallery, same head, more items) arrive once each; the
  // first page of a place, a replaced list and tiles re-mounted while scrolling back never do.
  const arrivals = useAppendArrivals(identity, useMemo(() => items.map(asset => asset.id), [items]));
  useLayoutEffect(() => {
    const scroll = parent.current;
    if (!scroll) return;
    let total = introHeight, anchor = oldRows.current[0]?.items[0]?.asset.id;
    for (const row of oldRows.current) { anchor = row.items[0]?.asset.id; if (total + rowSize(row) > scroll.scrollTop) break; total += rowSize(row); }
    const offset = scroll.scrollTop - total;
    let newTop = introHeight;
    for (const row of rows) { if (row.items.some(item => item.asset.id === anchor)) break; newTop += rowSize(row); }
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
    if (paused || privacy || vault || lastRow < 0 || !element || element.clientHeight <= 0) return;
    const controller = new AbortController(), ahead: Asset[] = [];
    let height = 0;
    for (let index = lastRow + 1; index < rows.length && height < element.clientHeight * 2; index++) {
      height += rowSize(rows[index]); ahead.push(...rows[index].items.map(item => item.asset));
    }
    prefetchThumbnails(ahead, controller.signal);
    return () => controller.abort();
  }, [lastRow, rows, paused, privacy, vault]);
  const checkEnd = () => {const element = parent.current; if (!paused && element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight) onNearEnd();};
  useEffect(checkEnd, [items.length, onNearEnd, paused]);
  const lastBackgroundTap = useRef<{at:number;x:number;y:number}|null>(null);
  const backgroundTap = (event: PointerEvent<HTMLDivElement>) => {
    if (!onClearSelection || !selectedIds?.size) return;
    if (event.target instanceof Element && event.target.closest('.media-tile, button, a, input, [role="slider"]')) return;
    const now = performance.now(), last = lastBackgroundTap.current;
    if (last && now - last.at < 350 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 32) { lastBackgroundTap.current = null; onClearSelection(); return; }
    lastBackgroundTap.current = {at: now, x: event.clientX, y: event.clientY};
  };
  return <div className={`gallery-scroll${stale?' is-stale':''}`} ref={parent} onPointerUp={backgroundTap} onScroll={event => {cancelActivePress();if (!paused && event.currentTarget.clientHeight > 0) onScroll(event.currentTarget.scrollTop); checkEnd();}} aria-label="자산 목록" aria-busy={stale||undefined} inert={stale||undefined} tabIndex={0}>
    {/* The refresh pill is a zero-height sticky overlay, so it never changes the intro height. */}
    {pull}
    {intro!=null&&<div ref={introduction}>{intro}</div>}
    <div className="gallery-canvas" style={{height: virtualizer.getTotalSize()}}>
      {virtualizer.getVirtualItems().map(virtual => {
        const row = rows[virtual.index];
        if (!row) return null;
        const hasDateHeadings = Boolean(row.dateHeadings?.length);
        const packedHeadings = row.dateHeadings && row.dateHeadings.length > 1 ? row.dateHeadings : null;
        const renderTile = (item: GalleryRowItem) => <Tile key={item.asset.id} {...item} height={row.height} onOpen={onOpen} onReady={onReady} paused={paused} privacy={privacy} vault={vault} arriving={arrivals.arriving(item.asset.id)} onArrived={arrivals.arrived} selectionMode={Boolean(onSelectAsset&&selectedIds?.size)} selected={selectedIds?.has(item.asset.id)??false} onSelect={onSelectAsset} onToggle={onToggleSelection} onPressStart={registerPress} onPressEnd={releasePress}/>;
        let itemOffset = 0;
        const tileContent = packedHeadings
          ? packedHeadings.map(heading => {
            const start = itemOffset;
            itemOffset += heading.count;
            return <div key={`${heading.label}-${heading.left}`} className="gallery-row-segment" style={{width: heading.width, gap: GALLERY_TILE_GAP}}>{row.items.slice(start, start + heading.count).map(renderTile)}</div>;
          })
          : row.items.map(renderTile);
        return <div className="gallery-justified-unit" key={virtual.key} style={{height: rowSize(row), transform: `translateY(${virtual.start-introHeight}px)`}}>
          {row.dateHeadings?.map(heading => <div key={`${heading.label}-${heading.left}`} className="gallery-date-heading" data-date-heading="true" role="presentation" style={{left: heading.left, width: heading.width}}>
            <span className="gallery-date-heading__day">{heading.label}</span>
            {heading.weekday && <span className="gallery-date-heading__weekday">{heading.weekday}</span>}
            <span className="gallery-date-heading__rule" aria-hidden="true" />
            {heading.count > 1 && <span className="gallery-date-heading__count">{heading.count.toLocaleString()}</span>}
          </div>)}
          <div className="gallery-row" style={{top: hasDateHeadings ? GALLERY_DATE_HEADING_HEIGHT : 0, height: row.height, gap: packedHeadings ? GALLERY_TILE_GAP * 4 : GALLERY_TILE_GAP}}>{tileContent}</div>
        </div>;
      })}
    </div>
    <Scrubber scrollRef={parent} total={items.length} sort={sort} hidden={paused || scrubberHidden} onEndReached={onNearEnd}/>
  </div>;
}
