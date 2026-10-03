import {useTabletAssetMask} from './assetMask';
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {StableImage} from '../src/shared/ui/StableImage';
import {warmOriginalTickets} from './originalTicketWarm';
import {usePullToRefresh} from './usePullToRefresh';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,type PointerEvent,type ReactNode} from 'react';
import {defaultRangeExtractor, observeElementOffset, observeElementRect, useVirtualizer, type Virtualizer} from '@tanstack/react-virtual';
import {PhotoIcon} from '@heroicons/react/24/outline';
import {collectedDate} from '../src/assets/masonryLayout';
import {formatDuration} from '../src/video/formatDuration';
import {revealGalleryDateCount} from '../src/assets/galleryDateFeedback';
import type {Asset} from './types';
import {dateLabel, justifiedRows, ratio, rowHeight} from './model';
import {invalidateTicket, loadThumbnail, mediaTicket, prefetchThumbnails, prepareAssets} from './media';
import {Scrubber} from './Scrubber';
import type {ScrubberSort} from './scrubberModel';
import {rangeAt, type SparseGallerySource} from './assetToc';
import {galleryAnchor, galleryAnchorTop, settleGalleryImages, sparseGalleryRows, type SparseRow} from './sparseGallery';
import {buildJustifiedGalleryRows, GALLERY_DATE_HEADING_HEIGHT, type GalleryRowAccessors, type JustifiedGalleryRow} from '../src/assets/galleryRows';

/**
 * Private Vault tiles. `asset.preview` is the native vault route, used as-is: no tickets,
 * thumbnail loading/prefetch, original warming or retries through the library media client.
 */
export type GalleryVaultSource = {label(asset: Asset): string};

function Tile({asset, index, width, height, onOpen, onReady, paused, privacy: requestedPrivacy, vault, selectionMode, selected, onSelect, onToggle, onPressStart, onPressEnd}: {asset: Asset; index: number; width: number; height: number; onOpen(index: number): void; onReady(asset:Asset):void; paused:boolean; privacy?:boolean; vault?:GalleryVaultSource;
  selectionMode:boolean; selected:boolean; favoritesView:boolean; onSelect?: (id:string)=>void; onToggle?: (id:string)=>void; onPressStart?: (cancel:()=>void)=>void; onPressEnd?: (cancel:()=>void)=>void}) {
  const privacy=useTabletAssetMask(asset,requestedPrivacy);
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
  const [loadedPreview, setPreview] = useState(asset.preview);
  const preview=loadedPreview??(vault?undefined:asset.preview);
  const [retried, setRetried] = useState(false);
  // A new thumbnail revision is a new image: it reloads while the tile keeps the old one.
  useEffect(() => {
    const controller = new AbortController();
    if (!paused && !privacy && !vault && !asset.preview) void loadThumbnail(asset, controller.signal).then(ready => {
      if (!controller.signal.aborted && ready.preview) {setPreview(ready.preview); onReady(ready);}
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, asset.thumbnail_available, asset.thumbnail_revision, asset.pending, onReady, paused, privacy, vault]);
  const settle = () => { if (image.current) image.current.style.opacity = ""; };
  const retry = () => {
    if (vault) {setPreview(undefined); return;}
    if (retried || asset.pending || asset.thumbnail_available === false) return;
    setRetried(true); invalidateTicket(asset, 'thumbnail');
    void mediaTicket(asset, 'thumbnail').then(t => setPreview(t.url), () => {});
  };
  return <div className="media-tile-shell" style={{width,position:'relative',flexShrink:0}}><button ref={host} className="media-tile ui-selectable-media" style={{width}} onClick={() => {
    if(suppressClick.current){suppressClick.current=false;return;}
    if(selectionMode){onToggle?.(asset.id);return;}
    if(!requestedPrivacy) onOpen(index);
  }} onPointerDown={beginPress} onPointerMove={movePress} onPointerUp={endPress} onPointerCancel={cancelPointer} onContextMenu={event=>{if(onSelect)event.preventDefault();}} aria-label={privacy ? '비공개 모드로 이미지 숨김' : vault ? vault.label(asset) : `${asset.creator_name || asset.creator_handle || (asset.kind === 'video' ? '영상' : '이미지')}, ${dateLabel(asset)}`} aria-description={!privacy && asset.kind === "video" ? `영상 ${formatDuration(asset.duration_ms)}` : undefined} aria-selected={selectionMode&&selected?true:undefined} data-asset-id={asset.id} data-date-label={collectedDate(asset.collected_at ?? asset.created_at).label}>
    <span className="tile-picture" style={{height}}>
      {privacy ? <span className="artist-private-tile" aria-hidden="true" /> : preview ? <StableImage ref={image} decodeFirst={false} src={preview} alt="" draggable={false} onError={() => {settle(); retry();}} onLoad={event => {
        const element = event.currentTarget;
        // A vault item without index dimensions takes its shape from the decoded thumbnail.
        if (vault && !asset.ratio && !(asset.width && asset.height) && element.naturalWidth > 0 && element.naturalHeight > 0) onReady({...asset, ratio: element.naturalWidth / element.naturalHeight});
        void (typeof element.decode === 'function' ? element.decode() : Promise.resolve()).catch(() => {}).then(settle);
      }}/> : <PhotoIcon className="missing-media" aria-hidden="true"/>}
      {asset.kind === 'video' && width > 100 && <span className="video-mark video-duration-pill" aria-label="영상">▶ {formatDuration(asset.duration_ms)}</span>}
      {selected && onSelect && <span className="tile-select" data-selected={selected} aria-hidden="true">{selected && <span className="ui-selection-check"/>}</span>}
    </span>
  </button></div>;
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

type GalleryRowItem = {asset: Asset; width: number; index: number; globalIndex?:number};

const mobileGalleryRowAccessors: GalleryRowAccessors<Asset, GalleryRowItem> = {
  ratio,
  dateValue: asset => asset.collected_at ?? asset.created_at,
  packItem: (asset, index, width) => ({asset, index, width}),
  buildRows: (assets, width, target, gap, startIndex) => justifiedRows(assets, width, target, gap).map(row => ({
    ...row,
    items: row.items.map(item => ({...item, index: item.index + startIndex})),
  })),
};

function rowSize(row: JustifiedGalleryRow<GalleryRowItem> & {spacer?:boolean}) {
  if(row.spacer)return row.height;
  return row.height + (row.dateHeadings?.length ? GALLERY_DATE_HEADING_HEIGHT : 0) + GALLERY_ROW_GAP;
}

export function Gallery({items, density, identity, restoreScroll, onScroll, onOpen, onReady, onNearEnd, paused, privacy=false, intro, onRefresh, busy=false, stale=false, vault, scrubberHidden=false, scrubberSort, selectedIds, favoritesView=false, onSelectAsset, onToggleSelection, onClearSelection, sparse}: {sparse?:SparseGallerySource; items: Asset[]; density: number; identity: string; restoreScroll: number; onScroll(top: number): void; onOpen(index: number): void; onReady(asset:Asset):void; onNearEnd():void; paused:boolean;privacy?:boolean;intro?:ReactNode;onRefresh?():void;busy?:boolean;/** The items belong to the previous place and stay only until the new one commits. */stale?:boolean;
  /** Additional visibility guard for sheets owned by the parent screen. */scrubberHidden?:boolean;
  /** Optional sort metadata; the date fallback follows the existing gallery order. */scrubberSort?:ScrubberSort;
  /** Tablet Library selection; absent for Revisit, character and vault galleries. */selectedIds?:ReadonlySet<string>; favoritesView?:boolean; onSelectAsset?(id:string):void; onToggleSelection?(id:string):void;
  /** A double tap on empty gallery space (not a tile) leaves selection mode. */onClearSelection?():void;
  /** Private Vault mode: same layout and gestures, no library media client. */
  vault?:GalleryVaultSource}) {
  const parent = useRef<HTMLDivElement>(null);
  useFirstAppearance(parent, items.length, !paused && !stale, vault ? 'vault-gallery' : 'asset-gallery');
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
  const sort = useMemo<ScrubberSort>(() => sparse ? {kind:'toc',totalCount:sparse.toc.totalCount,buckets:sparse.toc.buckets} : scrubberSort ?? {kind:'date',values:items.map(asset => asset.collected_at ?? asset.created_at)}, [items, scrubberSort, sparse?.toc]);
  const rows = useMemo<SparseRow<GalleryRowItem>[]>(() => {
    const target=rowHeight(density,width);
    if(!sparse)return buildJustifiedGalleryRows(items,width,target,GALLERY_TILE_GAP,sort.kind==='date',false,mobileGalleryRowAccessors).map(row=>({...row,startIndex:row.items[0]?.index??0,count:row.items.length,key:row.items[0]?.asset.id??'empty'}));
    const visible=new Map(items.map((asset,index)=>[asset.id,{asset,index}]));
    return sparseGalleryRows(sparse,(start)=>{
      const range=sparse.ranges.find(range=>range.startIndex===start)!;
      const positions=new Map(range.items.map((asset,index)=>[asset.id,start+index]));
      const assets=range.items.flatMap(asset=>visible.has(asset.id)?[visible.get(asset.id)!.asset]:[]);
      return buildJustifiedGalleryRows(assets,width,target,GALLERY_TILE_GAP,true,false,mobileGalleryRowAccessors).map(row=>{
        const packed=row.items.map(item=>({...item,index:visible.get(item.asset.id)!.index,globalIndex:positions.get(item.asset.id)!}));
        return {...row,items:packed,startIndex:packed[0]?.globalIndex??start,count:packed.length?(packed[packed.length-1].globalIndex!-packed[0].globalIndex!+1):0,key:packed[0]?.asset.id??`empty:${start}`};
      });
    },rowSize,(target+GALLERY_ROW_GAP)/Math.max(1,width/target));
  }, [items, width, density, sort.kind, sparse?.ranges,sparse?.toc]);
  const seekController=useRef<AbortController|null>(null),backgroundController=useRef<AbortController|null>(null);
  const [destination,setDestination]=useState<{index:number;controller:AbortController}|null>(null);
  const destinationRows=useMemo(()=>{
    if(!destination)return [];
    const first=rows.findIndex(row=>!row.spacer&&destination.index>=row.startIndex&&destination.index<row.startIndex+row.count);
    if(first<0)return [];
    const result:number[]=[];let height=0;
    for(let i=first;i<rows.length&&!rows[i].spacer&&height<(parent.current?.clientHeight||1000)+rowHeight(density,width);i++){result.push(i);height+=rowSize(rows[i]);}
    return result;
  },[destination,rows,density,width]);
  const oldRows = useRef(rows);
  const offsetPublisher=useRef<((offset:number,scrolling:boolean)=>void)|null>(null);
  const observeOffset=useCallback((instance:Virtualizer<HTMLDivElement,Element>,callback:(offset:number,scrolling:boolean)=>void)=>{
    offsetPublisher.current=callback;return observeElementOffset(instance,callback);
  },[]);
  const moveViewport=(top:number)=>{
    const scroll=parent.current;if(!scroll)return;
    scroll.scrollTop=top;offsetPublisher.current?.(scroll.scrollTop,false);
  };
  // Retain the painted viewport through a height correction before its offset is updated.
  const retainedRows:number[]=[];
  if(oldRows.current!==rows) {
    let top=introHeight;const scrollTop=parent.current?.scrollTop??0,bottom=scrollTop+(parent.current?.clientHeight||1000);
    const ids=new Set<string>();
    for(const row of oldRows.current) {if(top<bottom&&top+rowSize(row)>scrollTop)for(const item of row.items)ids.add(item.asset.id);top+=rowSize(row);}
    rows.forEach((row,index)=>{if(row.items.some(item=>ids.has(item.asset.id)))retainedRows.push(index);});
  }
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => parent.current, getItemKey:i=>rows[i].key, estimateSize: i => rowSize(rows[i]), overscan: GALLERY_ROW_OVERSCAN,scrollMargin:introHeight,observeElementRect:observeShownRect,observeElementOffset:observeOffset,
    rangeExtractor:range=>[...new Set([...defaultRangeExtractor(range),...destinationRows,...retainedRows])].sort((a,b)=>a-b)});
  useLayoutEffect(() => {
    const scroll = parent.current;
    if (!scroll) return;
    const anchor=galleryAnchor(oldRows.current,scroll.scrollTop-introHeight,rowSize);
    virtualizer.measure();
    if(scroll.scrollTop>=introHeight&&oldRows.current!==rows&&anchor) {
      const top=galleryAnchorTop(rows,anchor,rowSize);
      if(top!==undefined)moveViewport(introHeight+top);
    }
    oldRows.current = rows;
  }, [rows, virtualizer, introHeight]);
  useEffect(()=>{
    seekController.current?.abort();backgroundController.current?.abort();setDestination(null);
    return()=>{seekController.current?.abort();backgroundController.current?.abort();};
  },[identity,paused,busy,privacy]);
  const screenCount=()=>Math.max(40,Math.ceil((parent.current?.clientHeight||1000)/rowHeight(density,width))*Math.ceil(width/rowHeight(density,width))*2);
  const seek=useCallback((index:number)=>{
    seekController.current?.abort();backgroundController.current?.abort();
    const controller=new AbortController();seekController.current=controller;setDestination(null);
    if(!sparse)return;
    // Publish rows offscreen first. Current tiles remain mounted until their destination decodes.
    const screenAssets=(assets:Asset[],startIndex:number)=>{
      const packed=buildJustifiedGalleryRows(assets,width,rowHeight(density,width),GALLERY_TILE_GAP,true,false,mobileGalleryRowAccessors);
      const first=packed.findIndex(row=>row.items.some(item=>item.index===index-startIndex));
      const selected:Asset[]=[];let height=0;
      for(let i=Math.max(0,first);i<packed.length&&height<(parent.current?.clientHeight||1000)+rowHeight(density,width);i++){selected.push(...packed[i].items.map(item=>item.asset));height+=rowSize(packed[i]);}
      return {assets:selected,height};
    };
    const existing=rangeAt(sparse.ranges,index);
    const count=existing?Math.min(screenCount(),existing.startIndex+existing.items.length-index):screenCount();
    void sparse.load(index,count,controller.signal,async(assets,signal,startIndex)=>{
      if(privacy)return assets;
      const firstScreen=screenAssets(assets,startIndex).assets;
      const ready=await prepareAssets(firstScreen.filter(asset=>!asset.preview),signal),byId=new Map(ready.map(asset=>[asset.id,asset]));
      return assets.map(asset=>byId.get(asset.id)??asset);
    },existing?undefined:range=>screenAssets(range.items,range.startIndex).height>=(parent.current?.clientHeight||1000)+rowHeight(density,width)).then(loaded=>{
      if(loaded&&!controller.signal.aborted)setDestination({index,controller});
      else if(!controller.signal.aborted){controller.abort();setGapRetry(value=>value+1);}
    });
  },[sparse,density,width,privacy]);
  useEffect(()=>{
    if(!destination || !destinationRows.length || destination.controller.signal.aborted)return;
    const scroll=parent.current;if(!scroll)return;
    const keys=new Set(destinationRows.map(index=>rows[index].key));
    const elements=[...scroll.querySelectorAll<HTMLElement>('[data-gallery-row]')].filter(row=>keys.has(row.dataset.galleryRow!)).flatMap(row=>[...row.querySelectorAll<HTMLImageElement>('img')]);
    let live=true;
    void settleGalleryImages(elements,destination.controller.signal).then(()=>{
      if(!live||destination.controller.signal.aborted)return;
      let top=introHeight;for(let i=0;i<destinationRows[0];i++)top+=rowSize(rows[i]);
      moveViewport(top);onScroll(top);destination.controller.abort();setDestination(null);
    },reason=>{
      if(!live||destination.controller.signal.aborted)return;
      sparse?.reportError(reason instanceof Error?reason.message:'썸네일을 준비하지 못했습니다.');
      destination.controller.abort();setDestination(null);
    });
    return()=>{live=false;};
  },[destination,destinationRows,rows,introHeight,onScroll]);
  const indexAtScroll=useCallback(()=>galleryAnchor(rows,(parent.current?.scrollTop??0)-introHeight,rowSize)?.index??0,[rows,introHeight]);
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
      if(rows[index].spacer)break;
      height += rowSize(rows[index]); ahead.push(...rows[index].items.map(item => item.asset));
    }
    prefetchThumbnails(ahead, controller.signal);
    return () => controller.abort();
  }, [lastRow, rows, paused, privacy, vault]);
  const checkEnd = () => {const element = parent.current; if (!sparse && !paused && element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight) onNearEnd();};
  useEffect(checkEnd, [items.length, onNearEnd, paused]);
  const visibleGap=virtualRows.find(virtual=>rows[virtual.index]?.spacer && virtual.end>Math.max(introHeight,parent.current?.scrollTop??0) && virtual.start<(parent.current?.scrollTop??0)+(parent.current?.clientHeight||0)*2);
  const gapRow=visibleGap?rows[visibleGap.index]:undefined;
  const gapIndex=gapRow&&visibleGap?gapRow.startIndex+Math.max(0,Math.min(gapRow.count-1,Math.floor(((parent.current?.scrollTop??0)-visibleGap.start)/gapRow.height*gapRow.count))):undefined;
  const [gapRetry,setGapRetry]=useState(0);
  useEffect(()=>{
    if(paused || busy || !sparse || gapIndex===undefined || destination || seekController.current&&!seekController.current.signal.aborted)return;
    const controller=new AbortController();backgroundController.current=controller;
    void sparse.load(gapIndex,screenCount(),controller.signal);
    return()=>controller.abort();
  },[gapIndex,sparse?.toc,gapRow?.key,paused,busy,destination,gapRetry]);
  const lastBackgroundTap = useRef<{at:number;x:number;y:number}|null>(null);
  const backgroundTap = (event: PointerEvent<HTMLDivElement>) => {
    if (!onClearSelection || !selectedIds?.size) return;
    if (event.target instanceof Element && event.target.closest('.media-tile, button, a, input, [role="slider"]')) return;
    const now = performance.now(), last = lastBackgroundTap.current;
    if (last && now - last.at < 350 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 32) { lastBackgroundTap.current = null; onClearSelection(); return; }
    lastBackgroundTap.current = {at: now, x: event.clientX, y: event.clientY};
  };
  return <div className={`gallery-scroll${stale?' is-stale':''}`} ref={parent} onPointerOver={event => { if (event.pointerType !== "touch") revealGalleryDateCount(parent.current, event.target); }} onPointerLeave={() => revealGalleryDateCount(parent.current, document.activeElement)} onFocusCapture={event => { if (event.target.matches(":focus-visible")) revealGalleryDateCount(parent.current, event.target); }} onBlurCapture={event => revealGalleryDateCount(parent.current, event.relatedTarget)} onPointerUp={backgroundTap} onScroll={event => {cancelActivePress();if (!paused && event.currentTarget.clientHeight > 0) onScroll(event.currentTarget.scrollTop); checkEnd();}} aria-label="자산 목록" aria-busy={stale||undefined} inert={stale||undefined} tabIndex={0}>
    {/* The refresh pill is a zero-height sticky overlay, so it never changes the intro height. */}
    {pull}
    {intro!=null&&<div ref={introduction}>{intro}</div>}
    <div className="gallery-canvas" style={{height: virtualizer.getTotalSize()}}>
      {virtualizer.getVirtualItems().map(virtual => {
        const row = rows[virtual.index];
        if (!row) return null;
        if(row.spacer)return <div key={virtual.key} className="gallery-sparse-spacer" aria-hidden="true" data-spacer-start={row.startIndex} style={{position:'absolute',width:'100%',height:row.height,transform:`translateY(${virtual.start-introHeight}px)`}}/>;
        const hasDateHeadings = Boolean(row.dateHeadings?.length);
        const packedHeadings = row.dateHeadings && row.dateHeadings.length > 1 ? row.dateHeadings : null;
        const renderTile = (item: GalleryRowItem) => <Tile key={item.asset.id} {...item} height={row.height} onOpen={onOpen} onReady={onReady} paused={paused} privacy={privacy} vault={vault} favoritesView={favoritesView} selectionMode={Boolean(onSelectAsset&&selectedIds?.size)} selected={selectedIds?.has(item.asset.id)??false} onSelect={onSelectAsset} onToggle={onToggleSelection} onPressStart={registerPress} onPressEnd={releasePress}/>;
        let itemOffset = 0;
        const tileContent = packedHeadings
          ? packedHeadings.map(heading => {
            const start = itemOffset;
            itemOffset += heading.count;
            return <div key={`${heading.label}-${heading.left}`} className="gallery-row-segment" style={{width: heading.width, gap: GALLERY_TILE_GAP}}>{row.items.slice(start, start + heading.count).map(renderTile)}</div>;
          })
          : row.items.map(renderTile);
        return <div className="gallery-justified-unit" data-gallery-row={row.key} inert={destinationRows.includes(virtual.index)||undefined} key={virtual.key} style={{height: rowSize(row), transform: `translateY(${virtual.start-introHeight}px)`}}>
          {row.dateHeadings?.map(heading => <div key={`${heading.label}-${heading.left}`} className="gallery-date-heading" data-date-heading="true" data-gallery-date="" data-date-label={heading.label} tabIndex={0} style={{left: heading.left, width: heading.width}}>
            <span className="gallery-date-heading__day">{heading.label}</span>
            {heading.weekday && <span className="gallery-date-heading__weekday">{heading.weekday}</span>}
            {heading.count > 1 && <span className="gallery-date-heading__count">{heading.count.toLocaleString()}</span>}
          </div>)}
          <div className="gallery-row" style={{top: hasDateHeadings ? GALLERY_DATE_HEADING_HEIGHT : 0, height: row.height, gap: packedHeadings ? GALLERY_TILE_GAP * 4 : GALLERY_TILE_GAP}}>{tileContent}</div>
        </div>;
      })}
    </div>
    <Scrubber scrollRef={parent} total={sparse?.toc.totalCount??items.length} sort={sort} onSeek={sparse?seek:undefined} indexAtScroll={sparse?indexAtScroll:undefined} hidden={paused || scrubberHidden} onEndReached={onNearEnd}/>
  </div>;
}
