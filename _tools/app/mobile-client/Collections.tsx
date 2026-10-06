import {AreaSwitch} from '../src/shared/motion/AreaSwitch';
import { useDelayedBusy } from "../src/shared/useDelayedBusy";
import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {TrackingRows} from './CollectionTracking';
import {useHorizontalWheel} from '../src/shared/ui/useHorizontalWheel';
import {usePublicationCheck} from './usePublicationCheck';
import {CollectionPersonal,PersonalActions,PersonalRecord,workRecordFacts,type PersonalSheet} from './CollectionPersonal';
import {koreanGenres} from '../src/collections/genreNames';
import {CollectionList} from '../src/collections/CollectionList';
import {CaseFacts} from '../src/collections/case/CollectionCase';
import {moreWorkFacts, workFacts} from '../src/collections/work/workFacts';
import {latestKoreanRelease} from '../src/collections/releaseCaption';
import {ShelfTile, ShelfViewSheet, useShelfViews} from './CollectionShelf';
import {useShelfPutDown} from '../src/collections/useShelfPutDown';
import {CaseWork, MangaWork, sharedVolume} from './CollectionWork';
import {TabletMangaShelf} from './CollectionMangaShelf';
import type {MangaShelfPick} from '../src/collections/MangaShelfRow';
import {AvPerformerScreen} from './AvPerformer';
import {useCollectionEdits} from './useCollectionEdits';
import {AuthorityQueue, CollectionWorkForm, type WorkForm} from './CollectionAuthorityForms';
import {useProviderStatus} from './CollectionProviders';
import {WorkManage, WorkManageButton, type ManageSheet} from './CollectionWorkManage';
import {CollectionTrashSheet, lifecycleIntents, useCollectionTrash} from './CollectionTrash';
import {lifecycleInFlight} from './collectionCommandOutbox';
import {CollectionReleases} from './CollectionReleases';
import {invalidateReleases, observePublication} from './releaseStore';
import {localToday, NO_RELEASES, RELEASE_COUNTS_PATH, releaseBoardEntry, releaseCaption, releaseCounts, releaseRevision, type ReleaseCaption, type ReleaseCounts} from './collectionReleasesModel';
import {normalizeReleaseCalendarReply, type ReleaseCalendarReply} from './releaseCalendarModel';
import {FilmDetails} from './FilmDetails';
import {CollectionBindings} from './CollectionBindings';
import type {BindProvider} from './collectionBindingsModel';
import {useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent} from 'react';
import {displayDate} from '../src/shared/displayDate';
import {afterDecode,arrive,useAppendArrivals,useCardArrival,useLevelMotion,type CardArrival} from './motion';
import {cancelSegmentSwap,swapSegment} from '../src/shared/motion/viewSwap';
import {BellIcon, CalendarDaysIcon, SparklesIcon, StarIcon, ArrowsUpDownIcon, ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon, RectangleStackIcon, Squares2X2Icon, TrashIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {SparklesIcon as SparklesSolidIcon, StarIcon as StarSolid} from '@heroicons/react/24/solid';
import {Button, Dialog, DialogDescription, EmptyState, IconButton, SectionLabel} from './ui';
import {BottomSheet} from './BottomSheet';
import {Overlay} from './Overlay';
import {SegmentedControl} from '../src/shared/ui/SegmentedControl';
import {ReleaseCalendar} from './ReleaseCalendar';
import {CreateWorkButton,SearchButton,TopBar,TopBarSearch} from './TopBar';
import {StepSlider} from './StepSlider';
import {usePullToRefresh} from './usePullToRefresh';
import {useSectionShade} from './SectionShade';
import {PhysicalCover} from '../src/collections/physical/PhysicalCover';
import {PaperbackEngine, type BookTexture} from '../src/collections/physical/PaperbackEngine';
import {usePrivacyMode} from './privacyMode';
import {Scrubber} from './Scrubber';
import type {ScrubberSort} from './scrubberModel';

import {api, errorText} from './transport';
import {ARTWORK_BUSY_RETRIES, ARTWORK_BUSY_RETRY_MS, ARTWORK_RETRY_MS, ArtworkMemory, ArtworkMemoryContext, artworkSource, artworkTicket, artworkVersion, decoded, mediaBusy, validArtworkUrl, type LoadedArtwork, type Retries} from './collectionArtwork';
import {collectionCardCredit, collectionCardDate, originalTitle, collectionCover, collectionPath, defaultCollectionFilters, editions, editionVolumes, ratingLabel, SORT_LABELS, sortDirectionLabels, volumeLabel, volumeReleaseLabel} from './collectionModel';
import type {CollectionDetail, CollectionKind, CollectionPage, CollectionSummary, CollectionFilters as Filters} from './collectionModel';
import {AvCast, AvLookupSender, AvPerformerShelves, AvRelatedWorks, AvViewTabs, type AvListView, AV_LIST_VIEW_KEY} from './AvCollections';
import {KIND_LABEL} from '../src/collections/collectionFormat';
import './library.css';
import './Collections.css';

/** AV is a published collection type; the tablet keeps its list and detail surfaces here. */
type CollectionTab = CollectionKind | 'av';
const labels:Record<CollectionTab,string> = KIND_LABEL;
const TABS:CollectionTab[] = ['game','manga','movie','av'];
/** A list query has settled on `key`: its first page (or its failure) is on screen. */
// The detail pane names the work's own maker role rather than a generic "제작자".
const makerLabels:Record<CollectionKind,string> = {game:'개발사',manga:'작가',movie:'제작사',av:'메이커'};

/**
 * One artwork image. `physical` renders the shared PC collectible (the game case) from
 * the same ticket, and falls back to the flat image if that renderer cannot draw it; list
 * cards never pass it, so 3D stays inside the work detail.
 */
export function Artwork({item,id,revision,original=false,active=true,label,physical,arrival}:{item:CollectionSummary;id?:string|null;revision:string;original?:boolean;active?:boolean;label?:string;physical?:'book'|'game';
  /** The list card this cover belongs to, held until the cover is decoded (or cannot be). */arrival?:CardArrival}) {
  const memory=useContext(ArtworkMemoryContext),kept=original?null:memory;
  const [privacy] = usePrivacyMode();
  const source=artworkSource(item,id,revision,original);
  const host=useRef<HTMLSpanElement>(null), [visible,setVisible]=useState(original), [failed,setFailed]=useState<string|null>(null);
  // A cover this screen already decoded is shown in the first frame; one that arrives later fades in.
  const [image,setImage]=useState<LoadedArtwork|null>(()=>{const url=kept?.get(source);return url?{source,url}:null;});
  const [flat,setFlat]=useState<string|null>(null);
  const loaded=useRef<string|null>(image?.source??null),shown=useRef<string|null>(null),arriving=useRef(!image);
  const [attempt,setAttempt]=useState(0),retries=useRef<Retries>({source,failed:0,busy:0}),retryTimer=useRef(0);
  /** Schedules the next try of this source, or returns false once its retries are spent. */
  const retryLater=(error:unknown)=>{
    if(retries.current.source!==source)retries.current={source,failed:0,busy:0};
    const state=retries.current,busy=mediaBusy(error)&&state.busy<ARTWORK_BUSY_RETRIES;
    const delay=busy?ARTWORK_BUSY_RETRY_MS:ARTWORK_RETRY_MS[state.failed];
    if(delay===undefined)return false;
    if(busy)state.busy++;else state.failed++;
    window.clearTimeout(retryTimer.current);retryTimer.current=window.setTimeout(()=>setAttempt(value=>value+1),delay);
    return true;
  };
  useEffect(()=>()=>window.clearTimeout(retryTimer.current),[]);
  useEffect(()=>{if(original || !host.current)return; if(!('IntersectionObserver' in window)){setVisible(true);return;} const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'120px'});observer.observe(host.current);return()=>observer.disconnect();},[original]);
  useEffect(()=>{
    // Leaving the tab or the screen ends the retries; coming back starts a fresh budget.
    if(privacy||!active||!visible){retries.current={source,failed:0,busy:0};return;}
    if((!id&&!item.coverAssetId)||loaded.current===source)return;
    setFailed(null);const controller=new AbortController();
    const request=kept?.request(item,id,revision,original,controller.signal)??artworkTicket(item,id,revision,original,controller.signal);
    void request.then(async ticket=>{
      if(controller.signal.aborted)return;
      if(!validArtworkUrl(ticket.url))throw new Error('Invalid artwork');
      // A replacement keeps the shown image until its own bytes are ready; the same URL just stays.
      if(shown.current&&shown.current!==ticket.url)await decoded(ticket.url);
      if(controller.signal.aborted)return;
      kept?.put(source,ticket);
      loaded.current=source;setImage({source,url:ticket.url});
    }).catch(error=>{if(!controller.signal.aborted&&!retryLater(error))setFailed(source);});
    return()=>{controller.abort();window.clearTimeout(retryTimer.current);};
  },[source,active,visible,attempt,privacy]);
  const broken=failed===source,ready=!privacy&&!!image&&!broken&&(!!id||!!item.coverAssetId);
  shown.current=ready?image.url:null;
  const solid=ready&&physical&&flat!==source;
  // A card with no cover to wait for (none, or it failed) arrives at once.
  const absent=!id&&!item.coverAssetId;
  useEffect(()=>{if(privacy||absent||broken)arrival?.ready();},[privacy,absent,broken,arrival]);
  // While the card still waits, the card's arrival shows this cover; it does not fade on its own.
  if(ready&&arrival?.waiting())arriving.current=false;
  return <span ref={host} className={`collection-art collection-art-${item.type}${solid?' is-physical':''}`}>{privacy?<span className="privacy-mask" aria-label="비공개 모드"/>:ready?(solid?<PhysicalCover kind={physical} src={image.url} alt={label??item.name} scope={item.id} revision={artworkVersion(item,id,revision,original)} large onError={()=>setFlat(source)}/>:<img src={image.url} alt={label??item.name} className={arriving.current?'collection-art-arrive':undefined} onLoad={arrival&&(event=>{const element=event.currentTarget;afterDecode(element,()=>{arrival.ready();arrive(element);});})} onError={()=>{arrival?.ready();loaded.current=null;arriving.current=true;kept?.forget(source);if(retryLater(null))setImage(null);else setFailed(source);}}/>):<span className="collection-art-placeholder"><RectangleStackIcon/><span>{broken?'이미지를 불러오지 못했습니다':(!id&&!item.coverAssetId)?'표지 없음':original?<BusyLabel busy>불러오는 중…</BusyLabel>:'표지'}</span></span>}</span>;
}
type Pose={rx:number;ry:number};
type View={pose:Pose;zoom:number;x:number;y:number};
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
/** Turning limits keep the printed front in view: the book has no spine or back art. */
const BOOK_LIMITS={rest:{rx:.13,ry:.34},rx:[-.35,.45],ry:[-.2,.95]} as const;
type Limits=typeof BOOK_LIMITS;
const MAX_ZOOM=3;
/**
 * The cover viewer's touch model: one finger turns the object inside its limits, two fingers
 * pinch to zoom (1–3×) and move the zoomed view, the wheel zooms on a desktop preview, and a
 * double tap returns to the resting pose at 1×.
 */
function useTurnGesture(limits:Limits,onView:(view:View)=>void) {
  const rest=():View=>({pose:{...limits.rest},zoom:1,x:0,y:0});
  const view=useRef<View>(rest()),pointers=useRef(new Map<number,{x:number;y:number}>());
  const start=useRef<{view:View;points:{x:number;y:number}[]}|null>(null);
  const emit=(next:View)=>{view.current=next;onView(next);};
  const begin=()=>{start.current={view:{...view.current,pose:{...view.current.pose}},points:[...pointers.current.values()]};};
  const bound=(next:View):View=>{const room=(next.zoom-1)*160;return {...next,x:clamp(next.x,-room,room),y:clamp(next.y,-room,room)};};
  return {
    reset:()=>emit(rest()),
    handlers:{
      onPointerDown:(event:ReactPointerEvent<HTMLElement>)=>{event.currentTarget.setPointerCapture?.(event.pointerId);pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});begin();},
      onPointerMove:(event:ReactPointerEvent<HTMLElement>)=>{
        if(!pointers.current.has(event.pointerId)||!start.current)return;
        pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
        const now=[...pointers.current.values()],from=start.current;
        if(now.length===1&&from.points.length===1){
          const dx=now[0].x-from.points[0].x,dy=now[0].y-from.points[0].y;
          emit({...from.view,pose:{ry:clamp(from.view.pose.ry+dx*.008,limits.ry[0],limits.ry[1]),rx:clamp(from.view.pose.rx-dy*.006,limits.rx[0],limits.rx[1])}});
        } else if(now.length>=2&&from.points.length>=2){
          const span=(points:{x:number;y:number}[])=>Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y)||1;
          const mid=(points:{x:number;y:number}[])=>({x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2});
          const zoom=clamp(from.view.zoom*span(now)/span(from.points),1,MAX_ZOOM),a=mid(from.points),b=mid(now);
          emit(bound({...from.view,zoom,x:from.view.x+b.x-a.x,y:from.view.y+b.y-a.y}));
        }
      },
      onPointerUp:(event:ReactPointerEvent<HTMLElement>)=>{pointers.current.delete(event.pointerId);begin();},
      onPointerCancel:(event:ReactPointerEvent<HTMLElement>)=>{pointers.current.delete(event.pointerId);begin();},
      onWheel:(event:React.WheelEvent<HTMLElement>)=>emit(bound({...view.current,zoom:clamp(view.current.zoom*(event.deltaY<0?1.12:1/1.12),1,MAX_ZOOM)})),
      onDoubleClick:()=>emit(rest()),
    },
  };
}
/**
 * The manga cover as the PC's paperback, drawn by its own book engine and context while the
 * viewer is open. `onFail` hands the viewer back to the flat cover when WebGL2, the texture or
 * the context is unavailable.
 */
function TurnableBook({url,label,onFail}:{url:string;label:string;onFail():void}) {
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  const engine=useRef<PaperbackEngine|null>(null),texture=useRef<BookTexture|null>(null),frame=useRef(0);
  const current=useRef<View>({pose:{...BOOK_LIMITS.rest},zoom:1,x:0,y:0});
  const [ready,setReady]=useState(false);
  const failed=useRef(onFail);failed.current=onFail;
  const draw=useCallback(()=>{
    frame.current=0;const box=host.current?.getBoundingClientRect(),book=engine.current,art=texture.current,view=current.current;
    if(!box||!book||!art||box.width<1||box.height<1)return;
    let scale=Math.min(window.devicePixelRatio||1,2);scale=Math.min(scale,Math.sqrt(1_600_000/(box.width*box.height)));
    const width=Math.round(box.width*scale),height=Math.round(box.height*scale);
    try {book.draw(art,{width,height,rx:view.pose.rx,ry:view.pose.ry,rz:0,zoom:Math.min(.92,width/height*1.5/art.ratio)*view.zoom});}
    catch {failed.current();return;}
    if(canvas.current)canvas.current.style.transform=`translate(${view.x}px,${view.y}px)`;
  },[]);
  const request=useCallback(()=>{if(!frame.current)frame.current=requestAnimationFrame(draw);},[draw]);
  const gesture=useTurnGesture(BOOK_LIMITS,view=>{current.current=view;request();});
  useEffect(()=>{
    const element=canvas.current;if(!element)return;
    const controller=new AbortController();let book:PaperbackEngine;
    try {book=new PaperbackEngine(element);} catch {failed.current();return;}
    engine.current=book;
    const lost=(event:Event)=>{event.preventDefault();failed.current();};
    element.addEventListener('webglcontextlost',lost);
    void book.texture(url,url,1024,controller.signal).then(value=>{if(controller.signal.aborted)return;texture.current=value;setReady(true);request();},()=>{if(!controller.signal.aborted)failed.current();});
    const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(request);if(host.current)resize?.observe(host.current);
    return()=>{controller.abort();resize?.disconnect();element.removeEventListener('webglcontextlost',lost);if(frame.current)cancelAnimationFrame(frame.current);frame.current=0;texture.current=null;engine.current=null;book.dispose();};
  },[url,request]);
  return <div ref={host} className={`collection-turnable ${ready?'is-ready':''}`} role="img" aria-label={`${label} 입체 표지`} {...gesture.handlers}>
    <canvas ref={canvas} aria-hidden="true"/><BusyLabel busy={!ready}><span className="collection-turnable__status" role="status">입체 표지를 준비하는 중…</span></BusyLabel>
  </div>;
}
/** The manga cover viewer's body: the flat artwork, or the paperback when switched on. */
function CoverStage({item,id,revision,label,mode,onFlat}:{item:CollectionDetail;id:string|null|undefined;revision:string;label:string;mode:'3d'|'flat';onFlat():void}) {
  const [url,setUrl]=useState<{source:string;url:string}|null>(null);
  const source=artworkSource(item,id,revision,true);
  const physical=mode==='3d'&&item.type==='manga';
  useEffect(()=>{
    if(!physical||(!id&&!item.coverAssetId)||url?.source===source)return;
    const controller=new AbortController();
    void artworkTicket(item,id,revision,true,controller.signal).then(ticket=>{if(!controller.signal.aborted&&validArtworkUrl(ticket.url))setUrl({source,url:ticket.url});},()=>{if(!controller.signal.aborted)onFlat();});
    return()=>controller.abort();
  },[physical,source]);
  if(!physical)return <Artwork item={item} id={id} revision={revision} label={label} original/>;
  if(url?.source!==source)return <span className="collection-turnable" role="status"><BusyLabel busy>입체 표지를 준비하는 중…</BusyLabel></span>;
  return <TurnableBook key={source} url={url.url} label={label} onFail={onFlat}/>;
}
function SeriesDetails({item,revision,active}:{item:CollectionDetail;revision:string;active:boolean}) {
  const stripWheel=useHorizontalWheel();
  const seasons=item.series?.seasons??[];
  const [seasonId,setSeasonId]=useState(seasons.find(s=>s.seasonNumber>0)?.id??seasons[0]?.id),[limit,setLimit]=useState(30);
  const selected=seasons.find(s=>s.id===seasonId)??seasons[0];
  return <section className="collection-block collection-series" aria-label="시즌 및 회차"><SectionLabel as="h2" title="시즌" count={seasons.length} unit="개" />
    {seasons.length>1&&<div ref={stripWheel} className="collection-season-strip" role="group" aria-label="시즌">{seasons.map(season=><button className="collection-season" key={season.id} aria-pressed={selected?.id===season.id} onClick={()=>{setSeasonId(season.id);setLimit(30);}}><Artwork item={item} id={season.posterArtworkId} revision={revision} active={active}/><strong>{season.name}</strong><small className="numeric">{[displayDate(season.airDate),`${season.episodes.length}화`].filter(Boolean).join(' · ')}</small></button>)}</div>}
    {selected&&<><ol className="collection-episodes" aria-label={`${selected.name} 회차`}>{selected.episodes.slice(0,limit).map(episode=><li key={episode.id}><span className="numeric">{episode.episodeNumber}</span><strong>{episode.name}</strong><small>{[displayDate(episode.airDate),episode.runtimeMinutes?`${episode.runtimeMinutes}분`:null].filter(Boolean).join(' · ')}</small></li>)}</ol>{selected.episodes.length>limit&&<Button variant="ghost" onClick={()=>setLimit(n=>n+30)}>회차 더 보기</Button>}</>}
    {!!item.series?.cast.length&&<p className="collection-cast">출연 · {item.series.cast.join(' · ')}</p>}</section>;
}
const Stars=({score}:{score:number})=><span className="collection-score" aria-label={`내 별점 ${score.toFixed(1)}점`}><StarSolid aria-hidden="true"/><span className="numeric">{score.toFixed(1)}</span></span>;
/** A work's 신간 marker after the stars; the cover itself stays clean (user choice C, 2026-09-26). */
const ReleaseLine=({caption}:{caption:ReleaseCaption})=><span className={`collection-release-line is-${caption.kind}`}>{caption.text}{caption.date&&<span className="numeric"> · {caption.date}</span>}</span>;
/**
 * A tile: cover, title, credit, then one meta line of year, stars and the 신간 marker. The line
 * never wraps: when it is too narrow the year drops out first (it wraps onto a hidden second
 * row), then the marker ends in an ellipsis. The DOM order is reversed for that (row-reverse).
 */
function WorkCard({work,revision,active,meta=true,caption,onOpen,arriving=false,onArrived}:{work:CollectionSummary;revision:string;active:boolean;meta?:boolean;caption?:ReleaseCaption|null;onOpen(id:string):void;
  /** Appended by scrolling and not shown yet: the whole card rises in once its cover is decoded. */arriving?:boolean;onArrived?(id:string):void}) {
  const host=useRef<HTMLButtonElement>(null),arrival=useCardArrival(host,arriving,()=>onArrived?.(work.id));
  const credit=collectionCardCredit(work),date=meta?collectionCardDate(work):null,score=meta?work.myScore??null:null;
  const tail=(score!=null||caption)&&<span className="collection-card-meta__tail">{score!=null&&<Stars score={score}/>}{score!=null&&caption&&<span className="collection-card-meta__sep" aria-hidden="true">·</span>}{caption&&<ReleaseLine caption={caption}/>}</span>;
  return <button ref={host} className="collection-tile" onClick={()=>onOpen(work.id)}><Artwork item={work} id={collectionCover(work)} revision={revision} active={active} arrival={arrival}/><span className="collection-title">{work.name}</span>{credit&&<span className="collection-credit">{credit}</span>}{(date||tail)&&<span className="collection-card-meta">{tail}{date&&<span className="collection-date numeric">{date}</span>}</span>}</button>;
}

/** `slot` is the slot (type) of the committed list on screen. */
type ListState={key:string;slot:string;items:CollectionSummary[];page:CollectionPage|null;next:string|null;busy:boolean;more:boolean;error:string;moreError:string;legacy:boolean};
const EMPTY_LIST:ListState={key:'',slot:'',items:[],page:null,next:null,busy:false,more:false,error:'',moreError:'',legacy:false};
/** Covers readied before a swap: the S11 portrait first screen (4 columns x 3 rows). */
const FIRST_SCREEN_COVERS=12;
/** A swap waits at most this long for the new first screen's covers before it commits. */
const SWAP_PREPARE_MS=250;
/** Resolves when `work` settles or after `ms`, whichever is first. */
function settleWithin(work:Promise<unknown>,ms:number){
  let timer=0;
  return Promise.race([work.catch(()=>undefined),new Promise<void>(resolve=>{timer=window.setTimeout(resolve,ms);})]).finally(()=>clearTimeout(timer));
}
/**
 * One continuously scrolled Collection query. The first page commits the query; later pages
 * are appended only while they come from the same publication revision, otherwise the query
 * restarts. A committed query is not re-read when the tab is merely shown again.
 *
 * Switching queries keeps the previous list on screen until the new first page commits, and
 * `prepare` (capped at SWAP_PREPARE_MS) readies what that page shows first before it does. Each
 * `slot` (a Collection type) remembers its last committed query: switching back to a slot whose
 * query is unchanged shows it without a request, re-read in the background only when a newer
 * publication revision has been read since. A refresh (`key` changes), a new search or filter
 * within the slot, or a revision change while fetching reads the server as before.
 */
function useCollectionList(path:(cursor:string|null)=>string,key:string,enabled:boolean,{slot='',validate,prepare,present,allowMore=true,warm=false}:{slot?:string;validate?:(page:CollectionPage)=>void;prepare?:(page:CollectionPage,signal:AbortSignal)=>Promise<unknown>;
  /** Shows a slot switch (another type's list replacing the shown one): `apply` commits it. */present?:(apply:()=>void,slot:string)=>void;allowMore?:boolean;warm?:boolean}={}) {
  const [state,setState]=useState<ListState>(EMPTY_LIST);
  const latest=useRef(state);latest.current=state;
  const committed=useRef('');
  const warmAttempted=useRef(false);
  const firstPending=useRef(false);
  const memory=useRef(new Map<string,ListState>()),shownSlot=useRef(slot),newest=useRef<string|null>(null);
  const [nonce,setNonce]=useState(0),[revalidating,setRevalidating]=useState(false);
  const pathRef=useRef(path);pathRef.current=path;
  const validateRef=useRef(validate);validateRef.current=validate;
  const prepareRef=useRef(prepare);prepareRef.current=prepare;
  const presentRef=useRef(present);presentRef.current=present;
  // Each slot remembers its committed query as it grows.
  useEffect(()=>{
    if(!state.page||state.busy||state.error||state.key!==committed.current||state.key!==key)return;
    memory.current.set(slot,{...state,more:false});shownSlot.current=slot;
  },[state]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{
    setRevalidating(false);
    if(!enabled)return;
    if(committed.current===key){setState(current=>current.busy?{...current,busy:false}:current);return;}
    if(warm){if(warmAttempted.current)return;warmAttempted.current=true;}
    const controller=new AbortController();
    firstPending.current=true;
    const firstPage=()=>api<CollectionPage>(pathRef.current(null),controller.signal).then(result=>{validateRef.current?.(result);newest.current=result.revision;return result;});
    const commit=(result:CollectionPage)=>{committed.current=key;setState({key,slot,items:result.items,page:result,next:result.nextCursor,busy:false,more:false,error:'',moreError:'',legacy:false});};
    // A slot switch over a shown list goes through `present` (the shared view swap); its commit is
    // dropped once this request is superseded.
    const switching=slot!==shownSlot.current&&!!latest.current.page&&!!presentRef.current;
    const show=(apply:()=>void)=>{const guarded=()=>{if(!controller.signal.aborted)apply();};if(switching)presentRef.current!(guarded,slot);else guarded();};
    const kept=slot!==shownSlot.current?memory.current.get(slot):undefined;
    if(kept?.key===key){
      show(()=>{committed.current=key;setState(kept);});
      // Shown at once; re-read quietly only if a newer publication was read since.
      if(kept.page?.revision!==newest.current){
        // A remembered partial list must not fetch its old cursor alongside this first page.
        setRevalidating(true);
        void firstPage().then(result=>{if(!controller.signal.aborted){commit(result);setRevalidating(false);}}).catch(()=>{if(!controller.signal.aborted)setRevalidating(false);});
      }
      return()=>{controller.abort();firstPending.current=false;};
    }
    const swapping=latest.current.items.length>0;
    setState(current=>({...current,key,busy:true,error:'',legacy:false,moreError:''}));
    void firstPage().then(async result=>{
      if(controller.signal.aborted)return;
      // The previous list stays until the new first screen is ready (or the cap passes).
      if(swapping&&prepareRef.current)await settleWithin(prepareRef.current(result,controller.signal),SWAP_PREPARE_MS);
      if(controller.signal.aborted)return;
      show(()=>commit(result));
    }).catch(reason=>{if(controller.signal.aborted)return;const legacy=(reason as {status?:number}).status===404;setState(current=>({...current,busy:false,legacy,error:legacy?'':errorText(reason)}));}).finally(()=>{if(!controller.signal.aborted)firstPending.current=false;});
    return()=>{controller.abort();firstPending.current=false;};
  },[key,enabled,nonce]);
  useEffect(()=>{
    if(!warm&&enabled&&warmAttempted.current&&!firstPending.current&&committed.current!==key)setNonce(value=>value+1);
  },[warm,enabled]);
  const restart=useCallback(()=>{committed.current='';setNonce(n=>n+1);},[]);
  // This effect runs only after the first page has committed. Collections are small: keep
  // the shown list stable while draining the cursor, then append in one render. On failure,
  // publish the pages already received and retain the failed cursor for explicit retry.
  useEffect(()=>{
    if(!enabled||!allowMore||revalidating||state.busy||state.error||state.moreError||!state.next||state.key!==key||state.key!==committed.current)return;
    const controller=new AbortController(),current=state;
    const items=[...current.items],seen=new Set(items.map(work=>work.id));
    let next=current.next;
    const append=(moreError='')=>setState(value=>({...value,items,next,more:false,moreError}));
    setState(value=>({...value,more:true}));
    void (async()=>{
      try {
        while(next){
          const result=await api<CollectionPage>(pathRef.current(next),controller.signal);
          if(controller.signal.aborted)return;
          validateRef.current?.(result);
          if(result.revision!==current.page?.revision){newest.current=result.revision;restart();return;}
          if(result.nextCursor===next)throw new Error('목록 커서가 진행되지 않습니다.');
          for(const work of result.items)if(!seen.has(work.id)){seen.add(work.id);items.push(work);}
          next=result.nextCursor;
        }
        append();
      } catch(reason){if(!controller.signal.aborted)append(errorText(reason));}
    })();
    return()=>controller.abort();
  },[key,enabled,allowMore,nonce,revalidating,state.key,state.page,state.next,state.busy,state.error,state.moreError,restart]);
  // Scroll and scrubber callers can still signal the end; the committed-page effect owns I/O.
  const loadMore=useCallback(()=>{},[]);
  const retryMore=useCallback(()=>{setState(value=>({...value,moreError:''}));},[]);
  return {...state,reload:restart,loadMore,retryMore,committed:state.key===committed.current&&!!state.page};
}
const nearEnd=(element:HTMLElement)=>element.clientHeight>0&&element.scrollHeight-element.scrollTop-element.clientHeight<element.clientHeight;

/** 내 별점 filter stops: 전체, then 0.5 … 5.0 (exact match, as the server applies it). */
const RATING_STEPS:Filters['rating'][]=['all',.5,1,1.5,2,2.5,3,3.5,4,4.5,5];
/**
 * The 내 별점 filter: a stepped slider plus a separate 미평가 toggle (never both). Dragging
 * settles for a moment before the list reloads, so one gesture is one request.
 */
function RatingFilterSlider({value,onChange}:{value:Filters['rating'];onChange(value:Filters['rating']):void}) {
  const step=typeof value==='number'?Math.min(10,Math.max(1,Math.round(value*2))):0;
  const [draft,setDraft]=useState(step);
  const commit=useRef(onChange);commit.current=onChange;
  useEffect(()=>{setDraft(step);},[step,value]);
  useEffect(()=>{
    if(draft===step)return;
    const timer=window.setTimeout(()=>commit.current(RATING_STEPS[draft]),250);
    return()=>clearTimeout(timer);
  },[draft,step]);
  const text=(index:number)=>index===step?ratingLabel(value):ratingLabel(RATING_STEPS[index]);
  return <div className="collection-rating-filter">
    <StepSlider label="내 별점" count={RATING_STEPS.length} index={draft} defaultIndex={0} valueText={text} className={value==='unrated'?'is-idle':undefined} onChange={setDraft}/>
    <button className={`filter-chip${value==='unrated'?' selected':''}`} aria-pressed={value==='unrated'} onClick={()=>onChange(value==='unrated'?'all':'unrated')}>미평가만</button>
    <p className="hint">고른 별점과 같은 작품만 보여 줍니다.</p>
  </div>;
}
/** A place another tab asks Collections to show (Home's 신간 and 발매 예정); `key` makes a repeat ask count. */
export type CollectionsPlace={kind:'releases'}|{kind:'work';id:string};
export type CollectionsRequest=CollectionsPlace&{key:number};
/** `onReturnHome`: set while the screen was opened from Home; closing that entry level (신간 or the work opened) returns there. */
export function Collections({active,prefetch=false,paused,backRef,request,onReturnHome,directWork}:{active:boolean;prefetch?:boolean;paused:boolean;backRef:React.MutableRefObject<(()=>boolean)|null>;request?:CollectionsRequest|null;onReturnHome?:()=>void;directWork?:string}) {
  const filterWheel=useHorizontalWheel();
  const [tab,setTab]=useState<CollectionTab>('game'),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [privacyMode]=usePrivacyMode();
  const [searchOpen,setSearchOpen]=useState(false);
  const type:CollectionKind=tab;
  const [filtersByType,setFiltersByType]=useState<Record<CollectionKind,Filters>>(()=>({game:defaultCollectionFilters(),manga:defaultCollectionFilters(),movie:defaultCollectionFilters(),av:defaultCollectionFilters()}));
  const filters=filtersByType[type];
  const [refresh,setRefresh]=useState(0);
  // What the server serves may have changed: the lists re-read, and so does the shared 신간 read on its next show.
  const bump=useCallback(()=>{invalidateReleases();setRefresh(n=>n+1);},[]);
  const [showcaseAll,setShowcaseAll]=useState(false),[calendarOpen,setCalendarOpen]=useState(false);
  const [sheet,setSheet]=useState<'sort'|'rating'|'view'|'performerSort'|null>(null);
  // 보기 per type (격자 · 선반, 한 줄에 N개), the case a tap turned to the front, and the order a work was opened from.
  const [viewOf,patchView]=useShelfViews();
  const [picked,setPicked]=useState<string|null>(null),[order,setOrder]=useState<string[]>(()=>directWork?[directWork]:[]);
  // 만화 · 선반: the picked spine, and the volume a shelf opened its work at.
  const [mangaPick,setMangaPick]=useState<MangaShelfPick>(null),[openedVolume,setOpenedVolume]=useState<{id:string;volumeId:string}|null>(null);
  const shelfPutDown=useShelfPutDown(()=>{setPicked(null);setMangaPick(null);});
  const stepping=useRef(false);
  // The AV performer page: `from` is the work it was opened from (Back returns there).
  const [performer,setPerformer]=useState<{id:string;from:string|null}|null>(null),[performerOrder,setPerformerOrder]=useState<'newest'|'oldest'>('newest');
  const [personalSheet,setPersonalSheet]=useState<PersonalSheet>(null);
  // MangaDex / 카카오 연결: the open search sheet in the manga detail.
  const [bindSheet,setBindSheet]=useState<BindProvider|null>(null);
  // The large 작품 연결 panel (not yet connected) spans the width under the cover and info.
  const [bindHost,setBindHost]=useState<HTMLDivElement|null>(null);
  // 신간: unread counts for the entry badge and manga card badges, and the 신간 screen level (Collections tab only).
  const [releases,setReleases]=useState<ReleaseCounts>(NO_RELEASES),[inboxOpen,setInboxOpen]=useState(false);
  // The release list revision (moves when the PC publishes events or anything is confirmed). The
  // 신간 screen's last read lives in the shared release store (Home reads the same shelf).
  const [releaseListRevision,setReleaseListRevision]=useState<number|null>(null);
  const takeReleaseCounts=useCallback((reply:unknown)=>{setReleases(releaseCounts(reply));setReleaseListRevision(releaseRevision(reply));},[]);
  const [selected,setSelected]=useState<string|null>(directWork??null),[detail,setDetail]=useState<{revision:string;item:CollectionDetail;entityRevision?:number;readAt?:number}|null>(null),[detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const [avView,setAvView]=useState<AvListView>(()=>{try{return localStorage.getItem(AV_LIST_VIEW_KEY)==='performers'?'performers':'works';}catch{return 'works';}});
  const [edition,setEdition]=useState(0),[coverIndex,setCoverIndex]=useState<number|null>(null),[overview,setOverview]=useState(false);
  // The viewer opens covers in their physical form; the choice holds while browsing.
  const [coverMode,setCoverMode]=useState<'3d'|'flat'>('3d');
  const sectionRef=useRef<HTMLElement>(null),listRef=useRef<HTMLDivElement>(null),showcaseRef=useRef<HTMLDivElement>(null),detailRef=useRef<HTMLDivElement>(null),performerRef=useRef<HTMLDivElement>(null);
  const listScroll=useRef(0);
  const live=active&&!paused;
  const warming=prefetch&&!privacyMode&&!paused&&!directWork;
  const browseLive=live&&!directWork;
  useEffect(()=>{if(privacyMode)setCoverIndex(null);},[privacyMode]);
  useEffect(()=>{if(privacyMode&&tab==='av'){setTab('game');setSelected(null);setPerformer(null);setDetail(null);}else if(privacyMode)setPerformer(null);},[privacyMode,tab]);
  const filtered=!!search||filters.rating!=='all';
  const [calendarReply,setCalendarReply]=useState<ReleaseCalendarReply|null>(null);
  const overlayOpen=showcaseAll||inboxOpen||calendarOpen;

  // Typing searches after a short pause; Enter applies at once.
  useEffect(()=>{const value=query.trim();if(value===search)return;const timer=window.setTimeout(()=>setSearch(value),350);return()=>clearTimeout(timer);},[query,search]);
  // Covers decoded on this screen; a list swap readies the new first screen's covers first.
  const [artworks]=useState(()=>new ArtworkMemory());
  const prepareCovers=useCallback((page:CollectionPage,signal:AbortSignal)=>artworks.preload(page.items.slice(0,FIRST_SCREEN_COVERS),page.revision??'',signal),[artworks]);
  const mainKey=JSON.stringify([collectionPath(type,search,false,null,filters),refresh]);
  // A type switch is a segment switch: the shared view swap moves the new list in from the side of
  // the chosen type once it commits (covers prepared first); the section bar stays still.
  const typeOrder=(value:string)=>TABS.indexOf(value as CollectionTab);
  const shownTab=useRef<string>(type),swapOwner=useRef({}).current;
  const presentType=useCallback((apply:()=>void,slot:string)=>{
    const list=listRef.current,from=shownTab.current;
    swapSegment(swapOwner,{forward:typeOrder(slot)>=typeOrder(from),target:list,still:list?.querySelector<HTMLElement>(':scope > .section-shade-rows, :scope > .ui-section-bar'),commit:()=>{shownTab.current=slot;apply();}});
  },[swapOwner]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>()=>cancelSegmentSwap(swapOwner),[swapOwner]);
  const main=useCollectionList(cursor=>collectionPath(type,search,false,cursor,filters),mainKey,browseLive||warming,
    {slot:type,allowMore:live,warm:!live,prepare:live?prepareCovers:undefined,present:live?presentType:undefined,validate:result=>{if(result.ready&&result.filterVersion!==1)throw new Error('별점 필터와 정렬을 사용하려면 서버 업데이트가 필요합니다.');}});
  const wantShowcase=browseLive;
  const showcaseKey=JSON.stringify([collectionPath(type,'',true,null),refresh]);
  const showcase=useCollectionList(cursor=>collectionPath(type,'',true,cursor),showcaseKey,wantShowcase,{slot:type,prepare:prepareCovers});
  // Refreshes retain this type's painted exhibition; a different type loads within the overlay.
  const shownShowcase=showcase.committed||showcase.items[0]?.type===type;
  const showcaseItems=shownShowcase?showcase.items:[];
  const showcasePage=shownShowcase?showcase.page:null;
  const listPull=usePullToRefresh(listRef,bump,main.busy,!live||!!selected||overlayOpen||!!performer);
  const showcasePull=usePullToRefresh(showcaseRef,bump,showcase.busy,!live||!showcaseAll||!!selected);
  const detailPull=usePullToRefresh(detailRef,()=>setDetailRefresh(n=>n+1),!!selected&&!detail&&!detailError,!active||paused||!selected);
  // An accepted personal edit changes what the server serves; re-read both views.
  const edits=useCollectionEdits({active:active&&!paused,onSettled:()=>{bump();setDetailRefresh(n=>n+1);}});
  const [workForm,setWorkForm]=useState<WorkForm|null>(null);
  // 작품 관리 (the detail's ⋯) and the 휴지통 shortcut.
  const [manage,setManage]=useState<ManageSheet>(null),[trashOpen,setTrashOpen]=useState(false);
  const providerStatus=useProviderStatus(active&&!paused,refresh);
  const trash=useCollectionTrash(edits.authority,browseLive,refresh);
  const localCreate=edits.authority.rows.find(row=>row.command.commandType==='createWork'&&row.command.workId===selected);
  const localCreateState=localCreate?.state;
  // Retire accepted overlays only against the raw server read, never the optimistic display.
  useEffect(()=>{main.items.forEach(work=>edits.authority.reconcile(work));if(detail&&detail.revision!=='local-create')edits.authority.reconcile(detail.item,'detail');},[main.items,detail,edits.authority.identity?.libraryId,edits.authority.identity?.epoch,edits.authority.rows]);

  const detailKey=JSON.stringify([selected,detailRefresh]);
  const committedDetail=useRef('');
  useEffect(()=>{
    // A step to the previous/next work keeps the shown work (inert) until the next one is ready.
    const step=stepping.current;stepping.current=false;
    committedDetail.current='';if(!step)setDetail(current=>current?.item.id===selected?current:null);
    setDetailError('');setCoverIndex(null);setOverview(false);setPersonalSheet(null);setBindSheet(null);setManage(null);
    if(!step&&detailRef.current)detailRef.current.scrollTop=0;
  },[selected]);
  useEffect(()=>{
    if(!active||paused||!selected||committedDetail.current===detailKey)return;
    if(localCreateState&&localCreateState!=='accepted'){
      const created=edits.authority.creations.find(work=>work.id===selected);
      if(created)setDetail({revision:'local-create',item:created});
      return;
    }
    const controller=new AbortController();setDetailError('');
    const readStartedAt=Date.now();
    void api<{revision:string;item:CollectionDetail;entityRevision?:number}>(`/v1/collections/${encodeURIComponent(selected)}`,controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      committedDetail.current=detailKey;setDetail({...result,readAt:readStartedAt});
      edits.authority.reconcile(result.item,'detail',readStartedAt);
      setEdition(current=>editions(result.item.volumes).includes(current)?current:editions(result.item.volumes)[0]??0);
    }).catch(reason=>{if(!controller.signal.aborted)setDetailError(errorText(reason));});
    return()=>controller.abort();
  },[active,paused,selected,detailKey,localCreateState]);
  // The shared conditional poll (60 s while visible) keeps the chip and badges current; a pull re-reads at once.
  usePublicationCheck(active&&!paused,RELEASE_COUNTS_PATH,undefined,takeReleaseCounts);
  useEffect(()=>{if(!refresh||!active||paused)return;const controller=new AbortController();void api(RELEASE_COUNTS_PATH,controller.signal,undefined,'GET',true).then(reply=>{if(!controller.signal.aborted)takeReleaseCounts(reply);},()=>{});return()=>controller.abort();},[refresh]);
  // Games and movies use the same upcoming snapshot as Home and the calendar screen.
  useEffect(()=>{
    if(!browseLive||(tab!=='game'&&tab!=='movie'))return;
    const controller=new AbortController();
    void api<unknown>('/v1/home/upcoming',controller.signal).then(value=>{if(!controller.signal.aborted)setCalendarReply(normalizeReleaseCalendarReply(value));},()=>{});
    return()=>controller.abort();
  },[browseLive,refresh,tab]);
  usePublicationCheck(live&&coverIndex===null,'/v1/collections/status',main.page?.revision,(reply,changed)=>{edits.observeStatus(reply);if(!changed)return;bump();setDetailRefresh(n=>n+1);});
  // A list read under a newer publication than the kept 신간 shelf (read here or by Home) outdates it.
  useEffect(()=>observePublication(main.page?.revision),[main.page?.revision]);
  // Restore the list position when its committed query is shown again, before it is painted.
  // A remembered query (a type switched back to) commits without passing through loading.
  useLayoutEffect(()=>{if(!selected&&!overlayOpen&&!performer&&listRef.current&&main.committed)listRef.current.scrollTop=listScroll.current;},[selected,overlayOpen,performer,main.committed,main.key,active]);

  // A work opened over 신간 closes back to 신간; the entry level opened from Home closes back to Home.
  const closeWork=useCallback(()=>{if(directWork){onReturnHome?.();return;}setSelected(null);if(!overlayOpen&&!performer)onReturnHome?.();},[directWork,overlayOpen,performer,onReturnHome]);
  // The performer page returns to the work it was opened from.
  const closePerformer=useCallback(()=>{if(performer?.from)setSelected(performer.from);setPerformer(null);},[performer]);
  const closeInbox=useCallback(()=>{setInboxOpen(false);onReturnHome?.();},[onReturnHome]);
  const back=useCallback(()=>{
    if(workForm){setWorkForm(null);return true;}
    if(manage){setManage(null);return true;}
    if(coverIndex!==null){setCoverIndex(null);return true;}
    if(sheet){setSheet(null);return true;}
    if(trashOpen){setTrashOpen(false);return true;}
    if(personalSheet){setPersonalSheet(null);return true;}
    if(bindSheet){setBindSheet(null);return true;}
    if(selected){closeWork();return true;}
    if(performer){closePerformer();return true;}
    if(inboxOpen){closeInbox();return true;}
    if(showcaseAll){setShowcaseAll(false);return true;}
    if(calendarOpen){setCalendarOpen(false);return true;}
    return false;
  },[workForm,manage,coverIndex,sheet,trashOpen,personalSheet,bindSheet,selected,performer,inboxOpen,showcaseAll,calendarOpen,closeWork,closePerformer,closeInbox]);
  useEffect(()=>{backRef.current=back;return()=>{backRef.current=null;};},[back,backRef]);
  useEffect(()=>{if(!active||paused)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&coverIndex===null&&!sheet&&!personalSheet&&!bindSheet&&!manage&&!trashOpen){if(back())event.preventDefault();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[active,paused,back,coverIndex,sheet,personalSheet,bindSheet,manage,trashOpen]);
  useEffect(()=>{if(!active){setSheet(null);setTrashOpen(false);}},[active]);

  const chooseTab=(next:CollectionTab)=>{if(next===tab)return;listScroll.current=0;if(showcaseRef.current)showcaseRef.current.scrollTop=0;setCalendarOpen(false);setInboxOpen(false);setQuery('');setSearch('');setPicked(null);setMangaPick(null);setTab(next);};
  const chooseAvView=(next:AvListView)=>{setAvView(next);try{localStorage.setItem(AV_LIST_VIEW_KEY,next);}catch{/* optional device preference */}};
  const changeFilters=(next:Filters)=>{if(next.sort===filters.sort&&next.direction===filters.direction&&next.rating===filters.rating)return;listScroll.current=0;if(listRef.current)listRef.current.scrollTop=0;setFiltersByType(current=>({...current,[type]:next}));};
  /** Opens a work; `from` is the list it was opened in, which a swipe on the work steps through. */
  const openWork=(id:string,from?:string[],at?:{volumeId:string;edition:number}|null)=>{if(listRef.current&&!overlayOpen&&!performer)listScroll.current=listRef.current.scrollTop;setSheet(null);setOrder(from?.includes(id)?from:[id]);setOpenedVolume(at?{id,volumeId:at.volumeId}:null);if(at)setEdition(at.edition);setSelected(id);};
  const stepWork=(offset:-1|1)=>{const index=order.indexOf(selected??''),next=order[index+offset];if(index<0||!next)return;stepping.current=true;setSelected(next);};
  /** On the shelf a first tap turns the case to the front; a tap on the picked case opens it. */
  const tapWork=(items:CollectionSummary[])=>(id:string)=>{if(picked===id)openWork(id,items.map(work=>work.id));else setPicked(id);};
  const openPerformer=(id:string)=>{setSheet(null);setPerformer(current=>({id,from:selected??current?.from??null}));setSelected(null);};
  const openInbox=()=>{if(listRef.current&&!showcaseAll)listScroll.current=listRef.current.scrollTop;setSheet(null);setInboxOpen(true);};
  // Home opens the 신간 screen or one work's detail here.
  useEffect(()=>{
    if(!request)return;
    setSheet(null);setCoverIndex(null);setShowcaseAll(false);setCalendarOpen(false);
    setPerformer(null);
    if(request.kind==='releases'){setSelected(null);setInboxOpen(true);}
    else {setInboxOpen(false);setOrder([request.id]);setSelected(request.id);}
  },[request]);
  const unreadOf=(work:CollectionSummary)=>releases.byCollection[work.id]??0;
  // The 신간 screen reads owned counts and 신간 알림 through the edit outbox, so a queued change shows at once.
  const ownedOf=(work:CollectionSummary,edition:number)=>edits.visible(work.id,'ownedVolumes',{editionIndex:edition,count:work.ownedVolumes?.find(entry=>entry.editionIndex===edition)?.count??null}).value.count;
  const watching=(work:CollectionSummary)=>work.type==='manga'&&!!work.releaseWatch&&edits.visible(work.id,'releaseWatch',work.releaseWatch.enabled).value;
  const today=localToday();
  const captionOf=(work:CollectionSummary)=>{
    const kakao=work.releaseSchedule?.kakao;
    return releaseCaption(work,unreadOf(work),kakao?ownedOf(work,kakao.editionIndex):null,watching(work),today);
  };
  const calendarInterestCount=calendarReply?.wishlist.filter(entry=>entry.kind===tab).reduce((sum,entry)=>sum+entry.unread.length,0)??0;
  const showcaseCount=showcasePage?.totalCount??(showcase.committed?showcaseItems.length:undefined);
  const trashCount=trash.items.filter(work=>!privacyMode||work.type!=='av').length;
  // A deleted work leaves the shelves at once: while its delete is on its way, and once confirmed
  // until the list is read again (a read after the confirmation is the server's word). A delete
  // that could not be sent shows its work again, with the shelf queue's 대기 row.
  const listSeenAt=useRef(new Map<string,number>());
  useEffect(()=>{const value=main.page?.revision;if(value&&!listSeenAt.current.has(value))listSeenAt.current.set(value,Date.now());},[main.page?.revision]);
  const deletedWorks=new Set([...lifecycleIntents(edits.authority).values()].filter(row=>row.command.commandType==='deleteWork'&&(lifecycleInFlight(row)
    ||(row.state==='accepted'&&(listSeenAt.current.get(main.page?.revision??'')??Infinity)<(row.acceptedAt??0)))).map(row=>row.command.workId));
  const onDeleted=(id:string)=>{setOrder(current=>current.filter(value=>value!==id));closeWork();};

  const item=detail?.item?edits.authority.work(detail.item):undefined, volumes=item?editionVolumes(item.volumes,edition):[], editionOptions=item?editions(item.volumes):[];
  const covers=item?[{id:collectionCover(item),label:item.name},...volumes.map(v=>({id:v.coverArtworkId,label:[volumeLabel(v),volumeReleaseLabel(v)].filter(Boolean).join(' · ')}))]:[];
  const physical=item?.type==='manga';
  const revision=main.page?.revision??'';
  // A queued rating shows on the cards too, until the list re-reads the server.
  const card=(published:CollectionSummary)=>{const work=edits.authority.work(published);const value=edits.visible(work.id,'myScore',work.myScore??null).value;return value===(work.myScore??null)?work:{...work,myScore:value};};

  // The type switch is the list's first row; scrolled away, the top bar pulls it down as a shade.
  const typeOptions=TABS.filter(value=>!privacyMode||value!=='av').map(value=>({value,label:labels[value]}));
  // Shortcuts and view controls share the section bar's right group on both surfaces.
  const shortcuts=<div className="collection-shortcuts" role="group" aria-label="컬렉션 바로가기">
    <Button variant="quiet" size="sm" aria-label="쇼케이스" aria-pressed={showcaseAll} onClick={()=>setShowcaseAll(open=>!open)}>{showcaseAll?<SparklesSolidIcon aria-hidden="true"/>:<SparklesIcon aria-hidden="true"/>}<span className="collection-shortcuts__label">쇼케이스</span></Button>
    {(tab==='game'||tab==='movie')&&<Button variant="quiet" size="sm" aria-label={`발매 캘린더${calendarInterestCount>0?` ${calendarInterestCount.toLocaleString()}`:''}`} onClick={()=>setCalendarOpen(true)}><CalendarDaysIcon aria-hidden="true"/><span className="collection-shortcuts__label">발매 캘린더</span>{calendarInterestCount>0&&<span className="numeric collection-shortcuts__count is-new">{calendarInterestCount.toLocaleString()}</span>}</Button>}
    {tab==='manga'&&<Button variant="quiet" size="sm" aria-label={`신간${releases.unread>0?` ${releases.unread.toLocaleString()}`:''}`} onClick={openInbox}><BellIcon aria-hidden="true"/><span className="collection-shortcuts__label">신간</span>{releases.unread>0&&<span className="numeric collection-shortcuts__count is-new">{releases.unread.toLocaleString()}</span>}</Button>}
    {trash.available&&<Button variant="quiet" size="sm" aria-label={`휴지통${trashCount>0?` ${trashCount.toLocaleString()}`:''}`} onClick={()=>{setSheet(null);setTrashOpen(true);}}><TrashIcon aria-hidden="true"/><span className="collection-shortcuts__label">휴지통</span>{trashCount>0&&<span className="numeric collection-shortcuts__count">{trashCount.toLocaleString()}</span>}</Button>}
  </div>;
  const sections=useSectionShade({label:'컬렉션 유형',options:typeOptions,value:tab,onChange:chooseTab,trailing:<>{shortcuts}<span className="collection-shortcuts__divider" aria-hidden="true"/><Button variant="quiet" size="sm" aria-label="정렬" onClick={()=>setSheet('sort')}><ArrowsUpDownIcon aria-hidden="true"/></Button><Button variant="quiet" size="sm" aria-label="내 별점" aria-pressed={filters.rating!=='all'} onClick={()=>setSheet('rating')}><StarIcon aria-hidden="true"/></Button><Button variant="quiet" size="sm" aria-label="보기" onClick={()=>setSheet('view')}><Squares2X2Icon aria-hidden="true"/></Button></>},{active:live&&!selected&&!overlayOpen&&!performer});
  // Search lives in the shared bar: a magnifier that opens the field, kept open while a query is set.
  const searching=searchOpen||!!query||!!search;
  const closeSearch=()=>{setQuery('');setSearch('');setSearchOpen(false);};
  const header=selected
    ?<TopBar back={{label:'뒤로',onClick:closeWork}} crumbs={<span className="top-bar__crumbs is-alone">{directWork?'홈':<>컬렉션 › {inboxOpen?'신간':performer?'AV › 배우':`${labels[type]}${showcaseAll?' › 쇼케이스':''}`}</>}</span>} actions={item?<div style={{display:'contents'}} inert={item.id!==selected||undefined}><PersonalActions item={item} edits={edits}/>{edits.authority.identity&&<WorkManageButton onOpen={()=>setManage('menu')}/>}</div>:undefined}/>
    :performer
      ?<TopBar back={{label:'뒤로',onClick:closePerformer}} crumbs={<span className="top-bar__crumbs is-alone">컬렉션 › AV › 배우</span>}/>
    :searching&&tab!=='av'&&!overlayOpen
        ?<TopBarSearch title="컬렉션" loading={main.busy&&'컬렉션 불러오는 중'} onClose={closeSearch}><form className="top-bar__search collection-search" role="search" onSubmit={event=>{event.preventDefault();setSearch(query.trim());(document.activeElement as HTMLElement|null)?.blur();}}>
          <MagnifyingGlassIcon aria-hidden="true"/><input aria-label="컬렉션 검색" type="search" enterKeyHint="search" autoFocus={searchOpen} placeholder={`제목이나 ${makerLabels[type]} 찾기`} value={query} onChange={event=>setQuery(event.target.value)}/>
          {query&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={()=>{setQuery('');setSearch('');}}/>}
        </form></TopBarSearch>
        :<TopBar find={tab==='av'} barRef={sections.barRef} title={sections.title('컬렉션')} loading={main.busy&&'컬렉션 불러오는 중'} actions={<>{tab!=='av'&&<SearchButton onClick={()=>setSearchOpen(true)}/>}{edits.authority.identity&&<CreateWorkButton onClick={()=>setWorkForm({mode:'create',type})}/>}</>}/>;
  const showAvLoading=useDelayedBusy(main.busy&&!main.committed);
  const showDetailLoading=useDelayedBusy(!!selected&&!item&&!detailError);
  const unpublished=(state:{legacy:boolean;page:CollectionPage|null})=>state.legacy||state.page?.ready===false;
  const unpublishedNotice=<EmptyState icon={RectangleStackIcon} title="컬렉션이 아직 공유되지 않았습니다" />;

  // Works and performers remain navigation levels; shortcuts use the overlay motion.
  useLevelMotion(sectionRef,active?performer?.id??'':null,performer?1:0);
  // The list body follows the committed list's type, so a switch to or from AV keeps the old list
  // painted until the new one swaps in.
  const listTab=(main.slot||tab) as CollectionTab;
  // The grid keeps the layout of the type it shows until the new type's page commits.
  const shownType=main.items[0]?.type??type;
  // Cards appended by scrolling rise in once each; a committed first page (a type switch, a
  // remembered list, a refresh) shows at once.
  const mainArrivals=useAppendArrivals(main.page,main.items.map(work=>work.id));
  const showcaseArrivals=useAppendArrivals(showcase.page,showcase.items.map(work=>work.id));
  const mainScrubberSort=useMemo<ScrubberSort>(()=>tab==='av'&&avView==='performers'
    ?{kind:'fallback'}
    :filters.sort==='name'
    ?{kind:'name',values:main.items.map(work=>work.name)}
    :filters.sort==='recent'||filters.sort==='media_date'
      ?{kind:'date',values:main.items.map(work=>work.releaseDate??work.av?.releaseDate??work.createdAt??work.year)}
      :{kind:'fallback'},[avView,filters.sort,main.items,tab]);
  const showcaseScrubberSort=useMemo<ScrubberSort>(()=>({kind:'fallback'}),[]);
  const view=viewOf(shownType);
  const listActive=live&&!selected&&!overlayOpen&&!performer;
  const showcaseActive=live&&!selected&&!performer&&showcaseAll;
  // Both surfaces use the type's same layout, per-row setting and shared shelf geometry.
  const workList=(listed:CollectionSummary[],kind:CollectionKind,label:string,workRevision:string,visible:boolean,arrivals:typeof mainArrivals)=>{
    const items=deletedWorks.size?listed.filter(work=>!deletedWorks.has(work.id)):listed;
    const settings=viewOf(kind),order=items.map(work=>work.id);
    if(settings.layout==='shelf')return <CollectionList items={items} view={{layout:'shelf',perRow:settings.perRow,grouping:'sort'}} label={label} onPick={setPicked} windowRows pickedId={picked}
      render={work=><ShelfTile item={card(work)} revision={workRevision} active={visible} privacy={privacyMode} picked={picked===work.id} onTap={tapWork(items)}/>}/>;
    if(settings.layout==='bookcase'&&kind==='manga')return <TabletMangaShelf items={items.map(card)} label={label} revision={workRevision} active={visible} privacy={privacyMode}
      owned={ownedOf} pick={mangaPick} onPick={setMangaPick} onOpen={(id,at)=>openWork(id,order,at)}/>;
    return <div className={`collection-grid collection-grid-${kind} is-counted`} style={{'--columns':settings.perRow} as CSSProperties}>{items.map(work=><WorkCard key={work.id} work={card(work)} revision={workRevision} active={visible} caption={captionOf(work)} onOpen={id=>openWork(id,order)} arriving={arrivals.arriving(work.id)} onArrived={arrivals.arrived}/>)}</div>;
  };
  const collectionTypeLabel=<SectionLabel as="h2" className="collection-type-label" title={filtered?'검색 결과':labels[type]} count={!filtered&&main.page?.totalCount!=null ? main.page.totalCount : undefined} />;
  const typeHeader=<div className="collection-section collection-all"><div className="collection-type-header">{collectionTypeLabel}</div></div>;
  const mainOrder=main.items.map(work=>work.id);
  const localWorks=edits.authority.creations.filter(work=>work.type===shownType&&!main.items.some(published=>published.id===work.id)&&(!search||work.name.includes(search))&&filters.rating==='all');
  const worksView=workList([...localWorks,...main.items],shownType,`${labels[listTab]} 작품 목록`,revision,listActive,mainArrivals);
  // The opened work as the shared work screen, its information as the section below the stage.
  const visibleScore=(work:CollectionDetail)=>edits.visible(work.id,'myScore',work.myScore??null).value;
  const visibleRecord=(work:CollectionDetail)=>workRecordFacts(work,edits);
  const workInfo=(work:CollectionDetail)=><>
    <AuthorityQueue authority={edits.authority} workId={work.id} item={work} onForm={setWorkForm}/>
    <PersonalRecord item={work} edits={edits} onSheet={setPersonalSheet}/>
    <CollectionPersonal item={work} edits={edits} sheet={personalSheet} onSheet={setPersonalSheet}/>
    <section className="work-info" aria-label="작품 정보"><SectionLabel title="작품 정보"/><CaseFacts rows={[...workFacts(work,work.av??null),...moreWorkFacts(work,work.av??null,work.series?{status:work.series.status}:null)]}/></section>
    {work.type==='movie'&&work.overview?.trim()&&<section className="work-info" aria-label="개요"><SectionLabel title="개요"/><p className={`collection-overview ${overview?'':'is-clamped'}`}>{work.overview}</p><Button variant="ghost" className="collection-overview-toggle" aria-expanded={overview} onClick={()=>setOverview(open=>!open)}>{overview?'접기':'더 보기'}</Button></section>}
    {work.type==='movie'&&work.series&&<SeriesDetails item={work} revision={detail?.revision??''} active={active&&!paused}/>}
    {work.type==='movie'&&work.film&&<FilmDetails key={work.id} film={work.film}/>}
    {work.type==='av'&&<><AvCast item={work} items={main.items} complete={tab==='av'&&!filtered&&main.committed&&!main.next} revision={revision} onPerson={openPerformer}/><AvRelatedWorks item={work} items={main.items} onOpen={id=>openWork(id,mainOrder)}/></>}
  </>;
  const editionVolumesShared=item?.type==='manga'?volumes.map(volume=>sharedVolume(volume,today)):[];
  const mangaInfo=item?.type==='manga'&&<>
    <header className="tablet-work__identity"><h1>{item.name}</h1>{originalTitle(item)&&<small>{originalTitle(item)}</small>}</header>
    <AuthorityQueue authority={edits.authority} workId={item.id} item={item} onForm={setWorkForm}/>
    {(item.ownedVolumes!=null||item.releaseWatch!=null||editionOptions.length>1)&&<section className="collection-personal" aria-label="소장"><SectionLabel title="소장"/><TrackingRows item={item} edits={edits} onOwned={edition=>setPersonalSheet(`owned-${edition}`)}/>{editionOptions.length>1&&<div ref={filterWheel} className="filter-chips collection-editions" role="radiogroup" aria-label="판본">{editionOptions.map(value=><button key={value} role="radio" aria-checked={edition===value} className={`filter-chip ${edition===value?'selected':''}`} onClick={()=>{setEdition(value);setCoverIndex(null);}}>{value===0?'기본판':`판본 ${value+1}`}</button>)}</div>}</section>}
    <PersonalRecord item={item} edits={edits} onSheet={setPersonalSheet} includeTracking={false}/>
    <CollectionPersonal item={item} edits={edits} sheet={personalSheet} onSheet={setPersonalSheet}/>
    <section className="work-info" aria-label="작품 정보"><SectionLabel title="작품 정보"/><CaseFacts rows={[...workFacts(item,null),...moreWorkFacts(item,null,null)]}/>
      {koreanGenres(item.genres).length>0&&<ul className="collection-genres" aria-label="장르">{koreanGenres(item.genres).map(genre=><li key={genre}>{genre}</li>)}</ul>}</section>
    <CollectionBindings key={item.id} item={item} active={active&&!paused} refreshKey={`${detailRefresh}:${detail!.revision}`} sheet={bindSheet} onSheet={setBindSheet} panelHost={bindHost}/>
    <div ref={setBindHost} className="collection-bind-host"/>
  </>;
  // Direct entries use the app's Home-to-work readiness gate, without mounting a shelf.
  const workView = <>{header}
    <div ref={detailRef} className="collection-detail" aria-busy={!!selected&&!item&&!detailError} style={{display:selected?undefined:'none'}}>{selected&&<>{detailPull}{detailError&&<div className="inline-error" role="alert">{detailError}<Button onClick={()=>setDetailRefresh(value=>value+1)}>다시 시도</Button></div>}{!item||showDetailLoading?(showDetailLoading&&!detailError&&<p role="status" className="hint">작품을 불러오는 중…</p>)
      :item.type==='manga'
        ?<MangaWork key={item.id} item={item} revision={detail!.revision} active={active&&!paused} privacy={privacyMode} volumes={editionVolumesShared} owned={ownedOf(item,edition)} initialVolumeId={openedVolume?.id===item.id?openedVolume.volumeId:null}
          latestKorean={latestKoreanRelease(releaseBoardEntry(item,ownedOf,watching),edition,today)} onEnlarge={id=>{if(!privacyMode)setCoverIndex(volumes.findIndex(volume=>volume.id===id)+1);}} info={mangaInfo}/>
        :<CaseWork item={item} portraitSources={main.items} revision={detail!.revision} active={active&&!paused} privacy={privacyMode} position={Math.max(1,order.indexOf(item.id)+1)} total={Math.max(1,order.length)} score={visibleScore} record={visibleRecord} onStep={stepWork} info={workInfo}/>}</>}</div>
    </>;
  return <ArtworkMemoryContext.Provider value={artworks}><section ref={sectionRef} className={`mobile-collections ${selected?'has-detail':''}`} style={{display:active?undefined:'none'}} aria-label="컬렉션">
    {item&&edits.authority.identity&&<WorkManage key={item.id} item={item} authority={edits.authority} status={providerStatus} active={active&&!paused} entityRevision={detail?.item.id===item.id?detail.entityRevision:null}
      refreshing={edits.authority.acknowledgements.some(row=>row.command.workId===item.id&&(row.acceptedAt??0)>(detail?.readAt??0))} sheet={manage} onSheet={setManage} onForm={setWorkForm} onDeleted={onDeleted}/>}
    {trashOpen&&<CollectionTrashSheet trash={trash} authority={edits.authority} privacy={privacyMode} onClose={()=>setTrashOpen(false)}/>}
    {workForm&&edits.authority.identity&&<CollectionWorkForm key={`${workForm.mode}:${workForm.item?.id??'new'}:${workForm.retry?.command.operationId??''}`} form={workForm} authority={edits.authority} onClose={()=>setWorkForm(null)} onCreated={(id,kind)=>{chooseTab(kind);closeSearch();openWork(id);}}/>}
    {directWork ? workView : <AreaSwitch activeKey={selected?'work':'shelf'} retained={['shelf','work']} waitForReady crossFade={false} views={{shelf: <>
    <div style={{display:'contents'}} inert={overlayOpen&&!selected&&!performer||undefined}>{header}</div>
    {!selected&&!overlayOpen&&!performer&&!searching&&sections.shade}
    <div ref={listRef} className="collection-scroll" {...shelfPutDown} inert={overlayOpen||undefined} aria-hidden={overlayOpen||undefined} style={{display:performer?'none':undefined}} onScroll={event=>{listScroll.current=event.currentTarget.scrollTop;if(nearEnd(event.currentTarget))main.loadMore();}}>
      {listPull}
      {sections.inline}
      <AuthorityQueue authority={edits.authority} onForm={setWorkForm}/>
      {listTab==='av'?<>
      <AvLookupSender/>
      {main.error&&<div className="error-message" role="alert">{main.error}<Button variant="ghost" onClick={main.reload}>처음부터 새로고침</Button></div>}
      {unpublished(main)?unpublishedNotice:(main.busy&&!main.committed)||showAvLoading?showAvLoading&&<p className="hint" role="status">AV 컬렉션을 불러오는 중…</p>:main.committed&&!main.items.length?<EmptyState icon={RectangleStackIcon} title="PC 앱이 AV 작품을 아직 보내지 않았습니다" />:<>
        <AvViewTabs view={avView} onView={chooseAvView}/>
        {avView==='works'?<>{typeHeader}{worksView}</>:<AvPerformerShelves items={main.items} revision={revision} active={listActive} privacy={privacyMode} perRow={view.perRow} picked={picked} onTap={tapWork(main.items)} onPerformer={openPerformer}/>}
      </>}
      <BusyLabel busy={!!(main.more)}><p className="hint collection-more-status" role="status">더 불러오는 중…</p></BusyLabel>
      {main.moreError&&<div className="inline-error" role="alert"><span>{main.moreError}</span><Button variant="ghost" onClick={()=>{main.retryMore();window.setTimeout(main.loadMore);}}>다시 시도</Button></div>}
      </>:<>
      {main.error&&<div className="error-message" role="alert">{main.error}<Button variant="ghost" onClick={main.reload}>처음부터 새로고침</Button></div>}
      {unpublished(main)?unpublishedNotice:<>
        {typeHeader}
        {main.committed&&!main.items.length&&<EmptyState icon={RectangleStackIcon} title={filtered?'조건에 맞는 작품이 없습니다':'아직 작품이 없습니다'} />}
        {worksView}
        <BusyLabel busy={!!(main.more)}><p className="hint collection-more-status" role="status">더 불러오는 중…</p></BusyLabel>
      {main.moreError&&<div className="inline-error" role="alert"><span>{main.moreError}</span><Button variant="ghost" onClick={()=>{main.retryMore();window.setTimeout(main.loadMore);}}>다시 시도</Button></div>}
      </>}</>}
      <Scrubber scrollRef={listRef} total={main.items.length} sort={mainScrubberSort} hidden={!active||paused||!!selected||overlayOpen||!!performer||sheet!==null} onEndReached={main.loadMore}/>
    </div>
    {/* Always mounted so its pull-to-refresh gesture is attached; hidden until opened. */}
    <Overlay deferContent open={showcaseAll} covered={!live||!!performer} title="쇼케이스" count={showcaseCount} onClose={()=>setShowcaseAll(false)}>
    {ready=><div ref={showcaseRef} className="collection-scroll" onScroll={event=>{if(nearEnd(event.currentTarget))showcase.loadMore();}}>{showcaseAll&&<>
      {showcasePull}
      <SegmentedControl label="쇼케이스 컬렉션 유형" options={typeOptions} value={tab} onChange={chooseTab}/>
      <BusyLabel busy={!!(showcase.busy&&!showcaseItems.length)}><p className="hint" role="status">쇼케이스를 불러오는 중…</p></BusyLabel>
      <p className="hint collection-showcase-note">PC에서 정한 순서대로 보여 줍니다.</p>
      {showcase.error&&<div className="error-message" role="alert">{showcase.error}<Button variant="ghost" onClick={showcase.reload}>처음부터 새로고침</Button></div>}
      {showcase.committed&&!showcase.busy&&!showcaseItems.length&&<p className="hint">쇼케이스에 고른 작품이 없습니다.</p>}
      <BusyLabel busy={!ready} idle={ready ? unpublished(showcase)?unpublishedNotice:workList(showcaseItems,type,`${labels[type]} 쇼케이스 작품 목록`,showcasePage?.revision??'',showcaseActive,showcaseArrivals) : null}><p className="hint" role="status">쇼케이스를 준비하는 중…</p></BusyLabel>
      <BusyLabel busy={!!(showcase.more)}><p className="hint collection-more-status" role="status">더 불러오는 중…</p></BusyLabel>
      {showcase.moreError&&<div className="inline-error" role="alert"><span>{showcase.moreError}</span><Button variant="ghost" onClick={showcase.retryMore}>다시 시도</Button></div>}
      <Scrubber scrollRef={showcaseRef} total={showcaseItems.length} sort={showcaseScrubberSort} hidden={!active||paused||!!selected||!showcaseAll} onEndReached={showcase.loadMore}/>
    </>}</div>}
    </Overlay>
    <Overlay open={calendarOpen} covered={!live||!!performer} title="발매 캘린더" count={calendarInterestCount} onClose={()=>setCalendarOpen(false)}>
      {calendarOpen&&(tab==='game'||tab==='movie')&&<ReleaseCalendar embedded onSnapshot={setCalendarReply} initialKind={tab} onClose={()=>setCalendarOpen(false)}/>}
    </Overlay>
    <Overlay open={inboxOpen} covered={!live||!!performer} title="신간" count={releases.unread} onClose={closeInbox}>
    {inboxOpen&&<CollectionReleases active={active&&!paused&&!selected} counts={releases} refresh={refresh} revision={releaseListRevision} onCounts={setReleases} onRevision={setReleaseListRevision} onOpen={id=>openWork(id)} ownedOf={ownedOf} watching={watching}
      cover={(work,workRevision,name)=>work?<Artwork item={work} id={collectionCover(work)} revision={workRevision} active={active&&!paused&&!selected} label={name}/>:<span className="collection-art collection-art-manga"><span className="collection-art-placeholder"><RectangleStackIcon/></span></span>}/>}
    </Overlay>
    <div ref={performerRef} className="collection-scroll collection-performer-pane" style={{display:performer?undefined:'none'}}>{performer&&<AvPerformerScreen personId={performer.id} currentId={performer.from} active={active&&!paused&&!selected} privacy={privacyMode} perRow={viewOf('av').perRow} order={performerOrder}
      onOpen={(id,ids)=>openWork(id,ids)} onPerformer={id=>setPerformer(current=>({id,from:current?.from??null}))} onSort={()=>setSheet('performerSort')} onView={()=>setSheet('view')}/>}</div>
    </>, work: workView}}/>}
    {sheet==='sort'&&<BottomSheet title="정렬" onClose={()=>setSheet(null)}>
      <p className="collection-sheet-label">기준</p><div role="radiogroup" aria-label="정렬 기준">{(Object.keys(SORT_LABELS) as Filters['sort'][]).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={filters.sort===value} onClick={()=>changeFilters({...filters,sort:value})}>{SORT_LABELS[value]}<span className="radio-dot"/></button>)}</div>
      <p className="collection-sheet-label">순서</p><div role="radiogroup" aria-label="정렬 순서">{(['desc','asc'] as const).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={filters.direction===value} onClick={()=>changeFilters({...filters,direction:value})}>{sortDirectionLabels(filters.sort)[value]}<span className="radio-dot"/></button>)}</div>
    </BottomSheet>}
    {sheet==='performerSort'&&<BottomSheet title="정렬" onClose={()=>setSheet(null)}>
      <div role="radiogroup" aria-label="정렬 순서">{([['newest','발매일 최신순'],['oldest','발매일 오래된순']] as const).map(([value,label])=><button key={value} className="sheet-option" role="radio" aria-checked={performerOrder===value} onClick={()=>setPerformerOrder(value)}>{label}<span className="radio-dot"/></button>)}</div>
    </BottomSheet>}
    {sheet==='rating'&&<BottomSheet title="내 별점" onClose={()=>setSheet(null)}><RatingFilterSlider value={filters.rating} onChange={rating=>changeFilters({...filters,rating})}/>{filters.rating!=='all'&&<Button variant="quiet" onClick={()=>changeFilters({...filters,rating:'all'})}>초기화</Button>}</BottomSheet>}
    {sheet==='view'&&<ShelfViewSheet type={performer&&!selected?'av':type} view={viewOf(performer&&!selected?'av':type)} onChange={patch=>patchView(performer&&!selected?'av':type,patch)} onClose={()=>setSheet(null)}/>}
    {!privacyMode&&active&&!paused&&coverIndex!==null&&item&&covers[coverIndex]&&<Dialog open title={covers[coverIndex].label} onClose={()=>setCoverIndex(null)} variant="wide"><div className="collection-appreciation"><DialogDescription className="sr-only">선택한 표지를 크게 감상합니다.</DialogDescription>
      <div className="dialog-header">{physical&&<div className="collection-cover-mode" role="radiogroup" aria-label="표지 보기 방식">{(['3d','flat'] as const).map(value=><button key={value} role="radio" aria-checked={coverMode===value} onClick={()=>setCoverMode(value)}>{value==='3d'?'입체':'평면'}</button>)}</div>}<IconButton label="표지 감상 닫기" icon={XMarkIcon} onClick={()=>setCoverIndex(null)}/></div>
      <div className="collection-cover-stage"><CoverStage key={`${edition}:${coverIndex}:${coverMode}`} item={item} id={covers[coverIndex].id} revision={detail!.revision} label={covers[coverIndex].label} mode={physical?coverMode:'flat'} onFlat={()=>setCoverMode('flat')}/></div>
      <footer><IconButton label="이전 표지" icon={ChevronLeftIcon} disabled={coverIndex===0} onClick={()=>setCoverIndex(value=>value!-1)}/><span className="numeric muted">{coverIndex+1} / {covers.length}</span><IconButton label="다음 표지" icon={ChevronRightIcon} disabled={coverIndex===covers.length-1} onClick={()=>setCoverIndex(value=>value!+1)}/></footer></div></Dialog>}
  </section></ArtworkMemoryContext.Provider>;
}
