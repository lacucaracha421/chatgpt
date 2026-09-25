import {usePublicationCheck} from './usePublicationCheck';
import {CollectionMetadata} from './CollectionMetadata';
import {CollectionPersonal,PersonalActions,PersonalRecord,type PersonalSheet} from './CollectionPersonal';
import {koreanGenres} from '../src/collections/genreNames';
import {useCollectionEdits} from './useCollectionEdits';
import {CollectionReleases} from './CollectionReleases';
import {NO_RELEASES, RELEASE_COUNTS_PATH, releaseCounts, type ReleaseCounts} from './collectionReleases';
import {FilmDetails} from './FilmDetails';
import {CollectionBindings} from './CollectionBindings';
import type {BindProvider} from './collectionBindings';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {useLevelMotion} from './motion';
import {ArrowsUpDownIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon, RectangleStackIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {StarIcon as StarSolid} from '@heroicons/react/24/solid';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {BottomSheet} from './BottomSheet';
import {SearchButton,TopBar,TopBarSearch} from './TopBar';
import {StepSlider} from './StepSlider';
import {usePullToRefresh} from './usePullToRefresh';
import {PhysicalCover} from '../src/collections/physical/PhysicalCover';
import {PaperbackEngine, type BookTexture} from '../src/collections/physical/PaperbackEngine';
import {loadCoverImage} from '../src/collections/physical/loadCoverImage';
import {drawGameCase, GAME_CASE_REST} from '../src/collections/drawGameCase';

import {api, errorText, native} from './transport';
import {mediaTicket} from './media';
import {collectionCardCredit, collectionCardDate, collectionCover, collectionPath, defaultCollectionFilters, editions, editionVolumes, ratingLabel, SORT_LABELS, sortDirectionLabels, volumeLabel, volumeReleaseLabel} from './collectionModel';
import type {CollectionDetail, CollectionKind, CollectionPage, CollectionSummary, CollectionFilters as Filters} from './collectionModel';
import type {Ticket} from './types';
import './library.css';
import './Collections.css';

/** AV is a tab before it is a published type: the PC side is still being built. */
type CollectionTab = CollectionKind | 'av';
const labels:Record<CollectionTab,string> = {game:'게임',manga:'만화',movie:'영화',av:'AV'};
const TABS = Object.keys(labels) as CollectionTab[];
// The detail pane names the work's own maker role rather than a generic "제작자".
const makerLabels:Record<CollectionKind,string> = {game:'개발사',manga:'작가',movie:'제작사'};
/** Manga facts beside the cover: publisher, year and status, then the genres as Korean chips. */
function MangaFacts({item}:{item:CollectionDetail}) {
  const rows=([['출판사',item.publisher],['출간년도',item.year],['상태',item.series?.status]] as const).filter(([,value])=>value!=null&&value!=='');
  const genres=koreanGenres(item.genres);
  return <>
    {rows.length>0&&<dl className="collection-detail-facts" aria-label="작품 정보">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd className={typeof value==='number'?'numeric':undefined}>{value}</dd></div>)}</dl>}
    {genres.length>0&&<ul className="collection-genres" aria-label="장르">{genres.map(genre=><li key={genre}>{genre}</li>)}</ul>}
  </>;
}
const detailMaker = (item:CollectionDetail) => (item.type==='game'?item.developer:item.type==='manga'?item.author:item.productionCompany)?.trim() ?? '';

// Only visible artwork requests enter this small queue; native owns the disk cache.
let artworkActive=0;
const artworkQueue:(()=>void)[]=[];
function artworkTicket(item:CollectionSummary, artworkId:string|undefined|null, revision:string, original:boolean, signal:AbortSignal):Promise<Ticket> {
  return new Promise((resolve,reject)=>{
    const cancel=()=>{const index=artworkQueue.indexOf(start);if(index>=0)artworkQueue.splice(index,1);reject(new DOMException('Cancelled','AbortError'));};
    const start=()=>{if(signal.aborted){cancel();return;} artworkActive++;
      const promise=artworkId ? native<Ticket>('collectionArtwork',{collectionId:item.id,artworkId,variant:original?'original':'thumbnail',revision,digest:item.artworkVersions?.[artworkId]?.[original?'original':'thumbnail']??''},signal) : mediaTicket({id:item.coverAssetId!,kind:'image'},original?'original':'thumbnail',signal);
      void promise.then(resolve,reject).finally(()=>{signal.removeEventListener('abort',cancel);artworkActive--;while(artworkActive<4&&artworkQueue.length)artworkQueue.shift()!();});
    };
    signal.addEventListener('abort',cancel,{once:true}); if(artworkActive<4)start();else artworkQueue.push(start);
  });
}
/**
 * What identifies an artwork's bytes. A published digest names them exactly, and native keys its
 * cache by it, so a publication revision alone (every personal edit, such as Showcase, bumps it)
 * is not a new image. Without a digest the revision is the only version there is.
 */
function artworkVersion(item:CollectionSummary,id:string|null|undefined,revision:string,original:boolean) {
  return id?item.artworkVersions?.[id]?.[original?'original':'thumbnail']||revision:'';
}
function artworkSource(item:CollectionSummary,id:string|null|undefined,revision:string,original:boolean) {
  return JSON.stringify([item.id,id??null,item.coverAssetId??null,original?'original':'thumbnail',artworkVersion(item,id,revision,original)]);
}
/** Resolves once `url` is decoded (or cannot be), so a replacement never blanks the old image. */
async function decoded(url:string) {
  const image=new Image();image.src=url;
  try{await image.decode?.();}catch{/* the element's own onError reports it */}
}
const validArtworkUrl=(url:string)=>/^https:\/\//.test(url)||(import.meta.env.DEV&&url.startsWith('data:image/'));
type LoadedArtwork = {source:string;url:string};
/**
 * One artwork image. `physical` renders the shared PC collectible (the game case) from
 * the same ticket, and falls back to the flat image if that renderer cannot draw it; list
 * cards never pass it, so 3D stays inside the work detail.
 */
function Artwork({item,id,revision,original=false,active=true,label,physical}:{item:CollectionSummary;id?:string|null;revision:string;original?:boolean;active?:boolean;label?:string;physical?:'book'|'game'}) {
  const host=useRef<HTMLSpanElement>(null), [visible,setVisible]=useState(original), [image,setImage]=useState<LoadedArtwork|null>(null), [failed,setFailed]=useState<string|null>(null);
  const [flat,setFlat]=useState<string|null>(null);
  const source=artworkSource(item,id,revision,original),loaded=useRef<string|null>(null),shown=useRef<string|null>(null);
  useEffect(()=>{if(original || !host.current)return; if(!('IntersectionObserver' in window)){setVisible(true);return;} const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'120px'});observer.observe(host.current);return()=>observer.disconnect();},[original]);
  useEffect(()=>{
    if(!active||!visible||(!id&&!item.coverAssetId)||loaded.current===source)return;
    setFailed(null);const controller=new AbortController();
    void artworkTicket(item,id,revision,original,controller.signal).then(async ticket=>{
      if(controller.signal.aborted)return;
      if(!validArtworkUrl(ticket.url))throw new Error('Invalid artwork');
      // A replacement keeps the shown image until its own bytes are ready; the same URL just stays.
      if(shown.current&&shown.current!==ticket.url)await decoded(ticket.url);
      if(controller.signal.aborted)return;
      loaded.current=source;setImage({source,url:ticket.url});
    }).catch(()=>{if(!controller.signal.aborted)setFailed(source);});
    return()=>controller.abort();
  },[source,active,visible]);
  const broken=failed===source,ready=!!image&&!broken&&(!!id||!!item.coverAssetId);
  shown.current=ready?image.url:null;
  const solid=ready&&physical&&flat!==source;
  return <span ref={host} className={`collection-art collection-art-${item.type}${solid?' is-physical':''}`}>{ready?(solid?<PhysicalCover kind={physical} src={image.url} alt={label??item.name} scope={item.id} revision={artworkVersion(item,id,revision,original)} large onError={()=>setFlat(source)}/>:<img src={image.url} alt={label??item.name} onError={()=>{loaded.current=null;setFailed(source);}}/>):<span className="collection-art-placeholder"><RectangleStackIcon/><span>{broken?'이미지를 불러오지 못했습니다':(!id&&!item.coverAssetId)?'표지 없음':original?'불러오는 중…':'표지'}</span></span>}</span>;
}
type Pose={rx:number;ry:number};
type View={pose:Pose;zoom:number;x:number;y:number};
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
/** Turning limits keep the printed front in view: neither physical form has spine or back art. */
const BOOK_LIMITS={rest:{rx:.13,ry:.34},rx:[-.35,.45],ry:[-.2,.95]} as const;
const CASE_LIMITS={rest:GAME_CASE_REST,rx:[-.4,.4],ry:[-.85,.85]} as const;
type Limits=typeof BOOK_LIMITS|typeof CASE_LIMITS;
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
    <canvas ref={canvas} aria-hidden="true"/>{!ready&&<span className="collection-turnable__status" role="status">입체 표지를 준비하는 중…</span>}
  </div>;
}
/** The game cover as the PC's case, re-projected by its own renderer at the touched angle. */
function TurnableCase({url,label,onFail}:{url:string;label:string;onFail():void}) {
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),image=useRef<HTMLImageElement|null>(null),frame=useRef(0);
  const current=useRef<View>({pose:{...CASE_LIMITS.rest},zoom:1,x:0,y:0}),settle=useRef(0);
  const [ready,setReady]=useState(false);
  const failed=useRef(onFail);failed.current=onFail;
  // A lighter raster while the finger moves, then a sharp one once it rests.
  const draw=useCallback((sharp:boolean)=>{
    frame.current=0;const box=host.current?.getBoundingClientRect(),element=canvas.current,view=current.current;
    if(!box||!element||!image.current||box.width<1)return;
    const cssWidth=Math.min(box.width,box.height*184/260);
    // `width` is in CSS pixels; the renderer applies the device pixel ratio itself.
    const detail=sharp?Math.min(view.zoom,2):1;
    if(!drawGameCase(element,image.current,cssWidth*detail/2,undefined,{...view.pose,maxRatio:16})){failed.current();return;}
    element.style.width=`${cssWidth}px`;element.style.height=`${cssWidth*260/184}px`;
    element.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
  },[]);
  const request=useCallback(()=>{
    if(!frame.current)frame.current=requestAnimationFrame(()=>draw(false));
    clearTimeout(settle.current);settle.current=window.setTimeout(()=>draw(true),160);
  },[draw]);
  const gesture=useTurnGesture(CASE_LIMITS,view=>{current.current=view;request();});
  useEffect(()=>{
    const controller=new AbortController();
    void loadCoverImage(url,controller.signal).then(value=>{if(controller.signal.aborted){value.src='';return;}image.current=value;setReady(true);draw(true);},()=>{if(!controller.signal.aborted)failed.current();});
    const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(()=>draw(true));if(host.current)resize?.observe(host.current);
    return()=>{controller.abort();resize?.disconnect();if(frame.current)cancelAnimationFrame(frame.current);clearTimeout(settle.current);if(image.current)image.current.src='';image.current=null;};
  },[url,draw]);
  return <div ref={host} className={`collection-turnable ${ready?'is-ready':''}`} role="img" aria-label={`${label} 입체 케이스`} {...gesture.handlers}>
    <canvas ref={canvas} aria-hidden="true"/>{!ready&&<span className="collection-turnable__status" role="status">입체 케이스를 준비하는 중…</span>}
  </div>;
}
/** The cover viewer's body: the flat artwork, or the type's physical form when switched on. */
function CoverStage({item,id,revision,label,mode,onFlat}:{item:CollectionDetail;id:string|null|undefined;revision:string;label:string;mode:'3d'|'flat';onFlat():void}) {
  const [url,setUrl]=useState<{source:string;url:string}|null>(null);
  const source=artworkSource(item,id,revision,true);
  const physical=mode==='3d'&&(item.type==='manga'||item.type==='game');
  useEffect(()=>{
    if(!physical||(!id&&!item.coverAssetId)||url?.source===source)return;
    const controller=new AbortController();
    void artworkTicket(item,id,revision,true,controller.signal).then(ticket=>{if(!controller.signal.aborted&&validArtworkUrl(ticket.url))setUrl({source,url:ticket.url});},()=>{if(!controller.signal.aborted)onFlat();});
    return()=>controller.abort();
  },[physical,source]);
  if(!physical)return <Artwork item={item} id={id} revision={revision} label={label} original/>;
  if(url?.source!==source)return <span className="collection-turnable" role="status">입체 표지를 준비하는 중…</span>;
  return item.type==='manga'?<TurnableBook key={source} url={url.url} label={label} onFail={onFlat}/>:<TurnableCase key={source} url={url.url} label={label} onFail={onFlat}/>;
}
function HeroArtwork({item,id,revision,active}:{item:CollectionDetail;id:string;revision:string;active:boolean}) {
  const [original,setOriginal]=useState<LoadedArtwork|null>(null),loaded=useRef<string|null>(null);
  const available=item.artworks.find(art=>art.id===id)?.originalAvailable===true;
  const source=JSON.stringify([artworkSource(item,id,revision,true),available]);
  useEffect(()=>{
    if(!active||!available||loaded.current===source)return;
    const controller=new AbortController();
    void artworkTicket(item,id,revision,true,controller.signal).then(async ticket=>{
      if(controller.signal.aborted)return;
      const image=new Image();image.src=ticket.url;await image.decode();
      if(!controller.signal.aborted){loaded.current=source;setOriginal({source,url:ticket.url});}
    // A failed replacement stops showing an original that no longer matches this artwork.
    }).catch(()=>{if(!controller.signal.aborted)setOriginal(current=>current?.source===source?current:null);});return()=>controller.abort();
  },[source,active]);
  return <div className="collection-backdrop"><Artwork item={item} id={id} revision={revision} active={active}/>{available&&original&&<img className="collection-hero-original" src={original.url} alt="" onError={()=>{loaded.current=null;setOriginal(null);}}/>}</div>;
}
function SeriesDetails({item,revision,active}:{item:CollectionDetail;revision:string;active:boolean}) {
  const seasons=item.series?.seasons??[];
  const [seasonId,setSeasonId]=useState(seasons.find(s=>s.seasonNumber>0)?.id??seasons[0]?.id),[limit,setLimit]=useState(30);
  const selected=seasons.find(s=>s.id===seasonId)??seasons[0];
  return <section className="collection-block collection-series" aria-label="시즌 및 회차"><h2>시즌 {seasons.length}개</h2>
    {seasons.length>1&&<div className="collection-season-strip" role="group" aria-label="시즌">{seasons.map(season=><button className="collection-season" key={season.id} aria-pressed={selected?.id===season.id} onClick={()=>{setSeasonId(season.id);setLimit(30);}}><Artwork item={item} id={season.posterArtworkId} revision={revision} active={active}/><strong>{season.name}</strong><small className="numeric">{[season.airDate,`${season.episodes.length}화`].filter(Boolean).join(' · ')}</small></button>)}</div>}
    {selected&&<><ol className="collection-episodes" aria-label={`${selected.name} 회차`}>{selected.episodes.slice(0,limit).map(episode=><li key={episode.id}><span className="numeric">{episode.episodeNumber}</span><strong>{episode.name}</strong><small>{[episode.airDate,episode.runtimeMinutes?`${episode.runtimeMinutes}분`:null].filter(Boolean).join(' · ')}</small></li>)}</ol>{selected.episodes.length>limit&&<Button variant="ghost" onClick={()=>setLimit(n=>n+30)}>회차 더 보기</Button>}</>}
    {!!item.series?.cast.length&&<p className="collection-cast">출연 · {item.series.cast.join(' · ')}</p>}</section>;
}
const Stars=({score}:{score:number})=><span className="collection-score" aria-label={`내 별점 ${score.toFixed(1)}점`}><StarSolid aria-hidden="true"/><span className="numeric">{score.toFixed(1)}</span></span>;
function WorkCard({work,revision,active,meta=true,unread=0,onOpen}:{work:CollectionSummary;revision:string;active:boolean;meta?:boolean;/** Unread 신간 알림 of this manga, as on the PC card. */unread?:number;onOpen(id:string):void}) {
  const credit=collectionCardCredit(work),date=collectionCardDate(work);
  return <button className="collection-tile" onClick={()=>onOpen(work.id)}><Artwork item={work} id={collectionCover(work)} revision={revision} active={active}/>{work.type==='manga'&&unread>0&&<span className="collection-release-badge numeric">신간 {unread}</span>}<span className="collection-title">{work.name}</span>{credit&&<span className="collection-credit">{credit}</span>}{meta&&(date||work.myScore!=null)&&<span className="collection-card-meta">{date&&<span className="collection-date numeric">{date}</span>}{work.myScore!=null&&<Stars score={work.myScore}/>}</span>}</button>;
}

type ListState={key:string;items:CollectionSummary[];page:CollectionPage|null;next:string|null;busy:boolean;more:boolean;error:string;moreError:string;legacy:boolean};
const EMPTY_LIST:ListState={key:'',items:[],page:null,next:null,busy:false,more:false,error:'',moreError:'',legacy:false};
/**
 * One continuously scrolled Collection query. The first page commits the query; later pages
 * are appended only while they come from the same publication revision, otherwise the query
 * restarts. A committed query is not re-read when the tab is merely shown again.
 */
function useCollectionList(path:(cursor:string|null)=>string,key:string,enabled:boolean,validate?:(page:CollectionPage)=>void) {
  const [state,setState]=useState<ListState>(EMPTY_LIST);
  const latest=useRef(state);latest.current=state;
  const committed=useRef(''),more=useRef<AbortController|null>(null);
  const [nonce,setNonce]=useState(0);
  const pathRef=useRef(path);pathRef.current=path;
  const validateRef=useRef(validate);validateRef.current=validate;
  useEffect(()=>{
    if(!enabled)return;
    if(committed.current===key){setState(current=>current.busy?{...current,busy:false}:current);return;}
    more.current?.abort();
    const controller=new AbortController();
    setState(current=>({...current,key,busy:true,error:'',legacy:false,moreError:''}));
    void api<CollectionPage>(pathRef.current(null),controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      validateRef.current?.(result);
      committed.current=key;
      setState({key,items:result.items,page:result,next:result.nextCursor,busy:false,more:false,error:'',moreError:'',legacy:false});
    }).catch(reason=>{if(controller.signal.aborted)return;const legacy=(reason as {status?:number}).status===404;setState(current=>({...current,busy:false,legacy,error:legacy?'':errorText(reason)}));});
    return()=>controller.abort();
  },[key,enabled,nonce]);
  const reload=useCallback(()=>{committed.current='';setNonce(n=>n+1);},[]);
  const loadMore=useCallback(()=>{
    const current=latest.current;
    if(!enabled||current.busy||current.more||current.moreError||!current.next||current.key!==committed.current)return;
    const controller=new AbortController();more.current=controller;
    setState(value=>({...value,more:true}));
    void api<CollectionPage>(pathRef.current(current.next),controller.signal).then(result=>{
      if(controller.signal.aborted||latest.current.key!==current.key)return;
      validateRef.current?.(result);
      if(result.revision!==current.page?.revision){committed.current='';setNonce(n=>n+1);return;}
      if(result.nextCursor&&result.nextCursor===current.next)throw new Error('목록 커서가 진행되지 않습니다.');
      setState(value=>{const seen=new Set(value.items.map(work=>work.id));return {...value,items:[...value.items,...result.items.filter(work=>!seen.has(work.id))],next:result.nextCursor,more:false};});
    }).catch(reason=>{if(!controller.signal.aborted)setState(value=>({...value,more:false,moreError:errorText(reason)}));});
  },[enabled]);
  const retryMore=useCallback(()=>{setState(value=>({...value,moreError:''}));},[]);
  return {...state,reload,loadMore,retryMore,committed:state.key===committed.current&&!!state.page};
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
export function Collections({active,paused,backRef}:{active:boolean;paused:boolean;backRef:React.MutableRefObject<(()=>boolean)|null>}) {
  const [tab,setTab]=useState<CollectionTab>('game'),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const type:CollectionKind=tab==='av'?'game':tab;
  const [filtersByType,setFiltersByType]=useState<Record<CollectionKind,Filters>>(()=>({game:defaultCollectionFilters(),manga:defaultCollectionFilters(),movie:defaultCollectionFilters()}));
  const filters=filtersByType[type];
  const [refresh,setRefresh]=useState(0);
  const [showcaseOpen,setShowcaseOpen]=useState(false),[showcaseAll,setShowcaseAll]=useState(false);
  const [sheet,setSheet]=useState<'sort'|'rating'|null>(null);
  const [personalSheet,setPersonalSheet]=useState<PersonalSheet>(null);
  // MangaDex / 카카오 연결: the open search sheet in the manga detail.
  const [bindSheet,setBindSheet]=useState<BindProvider|null>(null);
  // 신간: unread counts for the entry badge and manga card badges, and the 신간 screen level (Collections tab only).
  const [releases,setReleases]=useState<ReleaseCounts>(NO_RELEASES),[inboxOpen,setInboxOpen]=useState(false);
  const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<{revision:string;item:CollectionDetail}|null>(null),[detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const [edition,setEdition]=useState(0),[coverIndex,setCoverIndex]=useState<number|null>(null),[volumeLimit,setVolumeLimit]=useState(96),[overview,setOverview]=useState(false);
  // The viewer opens covers in their physical form; the choice holds while browsing.
  const [coverMode,setCoverMode]=useState<'3d'|'flat'>('3d');
  const sectionRef=useRef<HTMLElement>(null),listRef=useRef<HTMLDivElement>(null),showcaseRef=useRef<HTMLDivElement>(null),detailRef=useRef<HTMLDivElement>(null);
  const listScroll=useRef(0);
  const live=active&&!paused&&tab!=='av';
  const filtered=!!search||filters.rating!=='all';

  // Typing searches after a short pause; Enter applies at once.
  useEffect(()=>{const value=query.trim();if(value===search)return;const timer=window.setTimeout(()=>setSearch(value),350);return()=>clearTimeout(timer);},[query,search]);
  const main=useCollectionList(cursor=>collectionPath(type,search,false,cursor,filters),JSON.stringify([collectionPath(type,search,false,null,filters),refresh]),live,
    result=>{if(result.ready&&result.filterVersion!==1)throw new Error('별점 필터와 정렬을 사용하려면 서버 업데이트가 필요합니다.');});
  const wantShowcase=live&&(showcaseOpen||showcaseAll)&&(!filtered||showcaseAll);
  const showcase=useCollectionList(cursor=>collectionPath(type,'',true,cursor),JSON.stringify([collectionPath(type,'',true,null),refresh]),wantShowcase);
  const listPull=usePullToRefresh(listRef,()=>setRefresh(n=>n+1),main.busy,!live||!!selected||showcaseAll||inboxOpen);
  const showcasePull=usePullToRefresh(showcaseRef,()=>setRefresh(n=>n+1),showcase.busy,!live||!showcaseAll||!!selected);
  const detailPull=usePullToRefresh(detailRef,()=>setDetailRefresh(n=>n+1),!!selected&&!detail&&!detailError,!active||paused||!selected);
  // An accepted personal edit changes what the server serves; re-read both views.
  const edits=useCollectionEdits({active:active&&!paused,onSettled:()=>{setRefresh(n=>n+1);setDetailRefresh(n=>n+1);}});

  const detailKey=JSON.stringify([selected,detailRefresh]);
  const committedDetail=useRef('');
  useEffect(()=>{
    committedDetail.current='';setDetail(current=>current?.item.id===selected?current:null);
    setDetailError('');setCoverIndex(null);setOverview(false);setVolumeLimit(96);setPersonalSheet(null);setBindSheet(null);
    if(detailRef.current)detailRef.current.scrollTop=0;
  },[selected]);
  useEffect(()=>{
    if(!active||paused||!selected||committedDetail.current===detailKey)return;
    const controller=new AbortController();setDetailError('');
    void api<{revision:string;item:CollectionDetail}>(`/v1/collections/${encodeURIComponent(selected)}`,controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      committedDetail.current=detailKey;setDetail(result);
      setEdition(current=>editions(result.item.volumes).includes(current)?current:editions(result.item.volumes)[0]??0);
    }).catch(reason=>{if(!controller.signal.aborted)setDetailError(errorText(reason));});
    return()=>controller.abort();
  },[active,paused,selected,detailKey]);
  // The shared conditional poll (60 s while visible) keeps the chip and badges current; a pull re-reads at once.
  usePublicationCheck(active&&!paused,RELEASE_COUNTS_PATH,undefined,reply=>setReleases(releaseCounts(reply)));
  useEffect(()=>{if(!refresh||!active||paused)return;const controller=new AbortController();void api(RELEASE_COUNTS_PATH,controller.signal,undefined,'GET',true).then(reply=>{if(!controller.signal.aborted)setReleases(releaseCounts(reply));},()=>{});return()=>controller.abort();},[refresh]);
  usePublicationCheck(live&&coverIndex===null,'/v1/collections/status',main.page?.revision,(reply,changed)=>{edits.observeStatus(reply);if(!changed)return;setRefresh(n=>n+1);setDetailRefresh(n=>n+1);});
  // Restore the list position when its committed query is shown again, before it is painted.
  useLayoutEffect(()=>{if(!selected&&!showcaseAll&&!inboxOpen&&listRef.current&&main.committed)listRef.current.scrollTop=listScroll.current;},[selected,showcaseAll,inboxOpen,main.committed,active]);

  const back=useCallback(()=>{
    if(coverIndex!==null){setCoverIndex(null);return true;}
    if(sheet){setSheet(null);return true;}
    if(personalSheet){setPersonalSheet(null);return true;}
    if(bindSheet){setBindSheet(null);return true;}
    if(selected){setSelected(null);return true;}
    if(inboxOpen){setInboxOpen(false);return true;}
    if(showcaseAll){setShowcaseAll(false);return true;}
    return false;
  },[coverIndex,sheet,personalSheet,bindSheet,selected,inboxOpen,showcaseAll]);
  useEffect(()=>{backRef.current=back;return()=>{backRef.current=null;};},[back,backRef]);
  useEffect(()=>{if(!active||paused)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&coverIndex===null&&!sheet&&!personalSheet&&!bindSheet){if(back())event.preventDefault();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[active,paused,back,coverIndex,sheet,personalSheet,bindSheet]);
  useEffect(()=>{if(!active)setSheet(null);},[active]);

  const chooseTab=(next:CollectionTab)=>{if(next===tab)return;listScroll.current=0;setShowcaseAll(false);setQuery('');setSearch('');setTab(next);};
  const changeFilters=(next:Filters)=>{if(next.sort===filters.sort&&next.direction===filters.direction&&next.rating===filters.rating)return;listScroll.current=0;if(listRef.current)listRef.current.scrollTop=0;setFiltersByType(current=>({...current,[type]:next}));};
  const openWork=(id:string)=>{if(listRef.current&&!showcaseAll&&!inboxOpen)listScroll.current=listRef.current.scrollTop;setSheet(null);setSelected(id);};
  const openInbox=()=>{if(listRef.current&&!showcaseAll)listScroll.current=listRef.current.scrollTop;setSheet(null);setInboxOpen(true);};
  const unreadOf=(work:CollectionSummary)=>releases.byCollection[work.id]??0;
  // The 신간 screen reads owned counts and 신간 알림 through the edit outbox, so a queued change shows at once.
  const ownedOf=(work:CollectionSummary,edition:number)=>edits.visible(work.id,'ownedVolumes',{editionIndex:edition,count:work.ownedVolumes?.find(entry=>entry.editionIndex===edition)?.count??null}).value.count;
  const watching=(work:CollectionSummary)=>work.type==='manga'&&!!work.releaseWatch&&edits.visible(work.id,'releaseWatch',work.releaseWatch.enabled).value;

  const item=detail?.item, volumes=item?editionVolumes(item.volumes,edition):[], editionOptions=item?editions(item.volumes):[];
  const covers=item?[{id:collectionCover(item),label:item.name},...volumes.map(v=>({id:v.coverArtworkId,label:[volumeLabel(v),volumeReleaseLabel(v)].filter(Boolean).join(' · ')}))]:[];
  const physical=item?.type==='manga'||item?.type==='game';
  const background=item?(item.type==='game'?item.selectedHeroArtworkId:item.selectedBackdropArtworkId):null;
  const maker=item?detailMaker(item):'';
  const revision=main.page?.revision??'';
  // The release-date sort reads as just 최신순/오래된순 (user request, 2026-09-25).
  const sortLabel=filters.sort==='media_date'?sortDirectionLabels(filters.sort)[filters.direction]:`${SORT_LABELS[filters.sort]} · ${sortDirectionLabels(filters.sort)[filters.direction]}`;
  // The memo (`description`) has its own section; manga overviews are imported provider text.
  const description=item&&item.type!=='manga'?item.overview:null;
  // A queued rating shows on the cards too, until the list re-reads the server.
  const card=(work:CollectionSummary)=>{const value=edits.visible(work.id,'myScore',work.myScore??null).value;return value===(work.myScore??null)?work:{...work,myScore:value};};

  // Search lives in the shared bar: a magnifier that opens the field, kept open while a query is set.
  const searching=searchOpen||!!query||!!search;
  const closeSearch=()=>{setQuery('');setSearch('');setSearchOpen(false);};
  const header=selected
    ?<TopBar back={{label:'뒤로',onClick:()=>setSelected(null)}} crumbs={<span className="top-bar__crumbs is-alone">컬렉션 › {inboxOpen?'신간':`${labels[type]}${showcaseAll?' › 쇼케이스':''}`}</span>} actions={item&&item.id===selected?<PersonalActions item={item} edits={edits}/>:undefined}/>
    :inboxOpen
      ?<TopBar back={{label:'뒤로',onClick:()=>setInboxOpen(false)}} crumbs={<span className="top-bar__crumbs">컬렉션</span>} title="신간"/>
    :showcaseAll
      ?<TopBar loading={showcase.busy&&'쇼케이스 불러오는 중'} back={{label:'뒤로',onClick:()=>setShowcaseAll(false)}} crumbs={<span className="top-bar__crumbs">컬렉션 › {labels[type]}</span>} title={<>쇼케이스{showcase.page?.totalCount!=null&&<span className="numeric muted"> {showcase.page.totalCount.toLocaleString()}</span>}</>}/>
      :searching&&tab!=='av'
        ?<TopBarSearch title="컬렉션" loading={main.busy&&'컬렉션 불러오는 중'} onClose={closeSearch}><form className="top-bar__search collection-search" role="search" onSubmit={event=>{event.preventDefault();setSearch(query.trim());(document.activeElement as HTMLElement|null)?.blur();}}>
          <MagnifyingGlassIcon aria-hidden="true"/><input aria-label="컬렉션 검색" type="search" enterKeyHint="search" autoFocus={searchOpen} placeholder={`제목이나 ${makerLabels[type]} 찾기`} value={query} onChange={event=>setQuery(event.target.value)}/>
          {query&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={()=>{setQuery('');setSearch('');}}/>}
        </form></TopBarSearch>
        :<TopBar title="컬렉션" loading={main.busy&&'컬렉션 불러오는 중'} actions={<><button className="collection-release-chip" aria-label={releases.unread>0?`신간 보기, 새 알림 ${releases.unread}개`:'신간 보기'} onClick={openInbox}>신간{releases.unread>0&&<span className="collection-release-count numeric">{releases.unread.toLocaleString()}</span>}</button>{tab!=='av'&&<SearchButton onClick={()=>setSearchOpen(true)}/>}</>}/>;

  const unpublished=(state:{legacy:boolean;page:CollectionPage|null})=>state.legacy||state.page?.ready===false;
  const unpublishedNotice=<div className="empty-state"><RectangleStackIcon/><h2>컬렉션이 아직 공유되지 않았습니다</h2><p>{main.legacy?'서버에 모바일 컬렉션 기능이 필요합니다. 서버 업데이트 후 PC에서 컬렉션을 게시해 주세요.':'PC의 설정에서 컬렉션을 클라우드에 게시하면 여기에서 감상할 수 있습니다.'}</p></div>;

  // Opening a work or the whole Showcase is one level deeper; Back returns from the left.
  useLevelMotion(sectionRef,active?`${selected??''}|${showcaseAll}|${inboxOpen}`:null,(selected?1:0)+(showcaseAll||inboxOpen?1:0));
  return <section ref={sectionRef} className={`mobile-collections ${selected?'has-detail':''}`} style={{display:active?undefined:'none'}} aria-label="컬렉션">
    {header}
    <div ref={listRef} className="collection-list" style={{display:selected||showcaseAll||inboxOpen?'none':undefined}} onScroll={event=>{listScroll.current=event.currentTarget.scrollTop;if(nearEnd(event.currentTarget))main.loadMore();}}>
      {listPull}
      <div className="library-segments collection-segments" role="tablist" aria-label="컬렉션 유형">{TABS.map(value=><button key={value} role="tab" aria-selected={tab===value} onClick={()=>chooseTab(value)}>{labels[value]}</button>)}</div>
      {tab==='av'?<div className="empty-state"><RectangleStackIcon/><h2>AV 컬렉션은 준비 중입니다</h2><p>PC 앱에서 AV 컬렉션이 준비되면 여기에 표시됩니다.</p></div>:<>
      {main.error&&<div className="error-message" role="alert">{main.error}<Button variant="ghost" onClick={main.reload}>처음부터 새로고침</Button></div>}
      {unpublished(main)?unpublishedNotice:<>
        {!filtered&&<section className="collection-showcase-fold" aria-label="쇼케이스">
          <div className="collection-section"><button className="collection-fold" aria-expanded={showcaseOpen} onClick={()=>setShowcaseOpen(open=>!open)}><h2>쇼케이스{showcase.page?.totalCount!=null&&<span className="numeric muted"> {showcase.page.totalCount.toLocaleString()}</span>}</h2><ChevronDownIcon aria-hidden="true"/></button>{showcaseOpen&&<Button variant="ghost" className="collection-more" onClick={()=>setShowcaseAll(true)}>전체 보기<ChevronRightIcon/></Button>}</div>
          {showcaseOpen&&<div className="collection-shelf">{showcase.busy&&!showcase.items.length&&<p role="status" className="hint">쇼케이스를 불러오는 중…</p>}{showcase.error&&<p className="error-message" role="alert">{showcase.error}</p>}{!showcase.busy&&showcase.committed&&!showcase.items.length&&<p className="hint">쇼케이스에 고른 작품이 없습니다.</p>}{showcase.items.map(work=><WorkCard key={work.id} work={card(work)} revision={showcase.page?.revision??''} active={live&&!selected} meta={false} unread={unreadOf(work)} onOpen={openWork}/>)}</div>}
        </section>}
        <div className="collection-section collection-all"><h2>{filtered?'검색 결과':'전체'}{main.page?.totalCount!=null&&<span className="numeric muted collection-total" aria-label="필터 결과 개수"> {main.page.totalCount.toLocaleString()}</span>}</h2>
        <div className="filter-chips collection-chips" role="group" aria-label="정렬과 필터">
          <button className="filter-chip" onClick={()=>setSheet('sort')}><ArrowsUpDownIcon aria-hidden="true"/>{sortLabel}<ChevronDownIcon aria-hidden="true"/></button>
          <button className={`filter-chip ${filters.rating!=='all'?'selected':''}`} onClick={()=>setSheet('rating')}>{filters.rating==='all'?'내 별점':ratingLabel(filters.rating)}<ChevronDownIcon aria-hidden="true"/></button>
          {filters.rating!=='all'&&<button className="filter-chip" onClick={()=>changeFilters({...filters,rating:'all'})}>초기화</button>}
        </div></div>
        {main.committed&&!main.items.length&&<div className="empty-state"><RectangleStackIcon/><h2>{filtered?'조건에 맞는 작품이 없습니다':'아직 작품이 없습니다'}</h2>{filtered&&<p>검색어나 별점 조건을 바꿔 보세요.</p>}</div>}
        <div className={`collection-grid collection-grid-${type}`}>{main.items.map(work=><WorkCard key={work.id} work={card(work)} revision={revision} active={live&&!selected&&!inboxOpen} unread={unreadOf(work)} onOpen={openWork}/>)}</div>
        {main.more&&<p className="hint collection-more-status" role="status">더 불러오는 중…</p>}
        {main.moreError&&<div className="inline-error" role="alert"><span>{main.moreError}</span><Button variant="ghost" onClick={()=>{main.retryMore();window.setTimeout(main.loadMore);}}>다시 시도</Button></div>}
      </>}</>}
    </div>
    {/* Always mounted so its pull-to-refresh gesture is attached; hidden until opened. */}
    <div ref={showcaseRef} className="collection-list" style={{display:showcaseAll&&!selected?undefined:'none'}} onScroll={event=>{if(nearEnd(event.currentTarget))showcase.loadMore();}}>{showcaseAll&&<>
      {showcasePull}
      <p className="hint collection-showcase-note">PC에서 정한 순서대로 보여 줍니다.</p>
      {showcase.error&&<div className="error-message" role="alert">{showcase.error}<Button variant="ghost" onClick={showcase.reload}>처음부터 새로고침</Button></div>}
      {unpublished(showcase)?unpublishedNotice:<div className={`collection-grid collection-showcase collection-grid-${type}`}>{showcase.items.map(work=><WorkCard key={work.id} work={work} revision={showcase.page?.revision??''} active={live} meta={false} unread={unreadOf(work)} onOpen={openWork}/>)}</div>}
      {showcase.more&&<p className="hint collection-more-status" role="status">더 불러오는 중…</p>}
    </>}</div>
    {inboxOpen&&<CollectionReleases active={active&&!paused&&!selected} counts={releases} refresh={refresh} onCounts={setReleases} onOpen={openWork} ownedOf={ownedOf} watching={watching}
      cover={(work,workRevision,name)=>work?<Artwork item={work} id={collectionCover(work)} revision={workRevision} active={active&&!paused&&!selected} label={name}/>:<span className="collection-art collection-art-manga"><span className="collection-art-placeholder"><RectangleStackIcon/></span></span>}/>}
    <div ref={detailRef} className="collection-detail" style={{display:selected?undefined:'none'}}>{selected&&<>{detailPull}{detailError&&<div className="inline-error" role="alert">{detailError}<Button onClick={()=>setDetailRefresh(value=>value+1)}>다시 시도</Button></div>}{!item?(!detailError&&<p role="status" className="hint">작품을 불러오는 중…</p>):<>
      {background&&<HeroArtwork item={item} id={background} revision={detail!.revision} active={active&&!paused}/>}
      <div className={`collection-detail-intro ${background?'has-backdrop':''}`}>
        <button className="collection-detail-cover" aria-label={`${item.name} 표지 감상`} onClick={()=>setCoverIndex(0)}><Artwork item={item} id={collectionCover(item)} revision={detail!.revision} active={active&&!paused}/></button>
        <div className="collection-detail-identity"><span className="collection-detail-kind">{labels[item.type]}</span><h1>{item.name}</h1>{maker&&<span className="collection-detail-credit">{makerLabels[item.type]} · {maker}</span>}
          {item.type==='manga'?<MangaFacts item={item}/>:<span className="collection-facts">{collectionCardDate(item)&&<span className="numeric">{collectionCardDate(item)}</span>}{item.series?.status&&<span>{item.series.status}</span>}{item.platforms&&<span>{item.platforms}</span>}</span>}
          <PersonalRecord item={item} edits={edits} onSheet={setPersonalSheet}/>
          {item.type==='manga'&&<CollectionBindings key={item.id} item={item} active={active&&!paused} refreshKey={`${detailRefresh}:${detail!.revision}`} sheet={bindSheet} onSheet={setBindSheet}/>}</div>
      </div>
      <CollectionPersonal item={item} edits={edits} sheet={personalSheet} onSheet={setPersonalSheet}/>
      {volumes.length>0&&<section className="collection-block collection-volume-section" aria-label="권별 표지"><h2>{volumes.length}권</h2>
        {editionOptions.length>1&&<div className="filter-chips collection-editions" role="radiogroup" aria-label="판본">{editionOptions.map(value=><button key={value} role="radio" aria-checked={edition===value} className={`filter-chip ${edition===value?'selected':''}`} onClick={()=>{setEdition(value);setVolumeLimit(96);setCoverIndex(null);}}>{value===0?'기본판':`판본 ${value+1}`}</button>)}</div>}
        <div className="collection-volume-shelf">{volumes.slice(0,volumeLimit).map((volume,index)=><button key={volume.id} className="collection-tile" onClick={()=>setCoverIndex(index+1)}><Artwork item={item} id={volume.coverArtworkId} revision={detail!.revision} active={active&&!paused} label={volumeLabel(volume)}/><span>{volumeLabel(volume)}{volumeReleaseLabel(volume)&&<span className="collection-volume-date numeric"> · {volumeReleaseLabel(volume)}</span>}</span></button>)}</div>
        {volumes.length>volumeLimit&&<Button variant="ghost" onClick={()=>setVolumeLimit(n=>n+96)}>표지 더 보기</Button>}</section>}
      {item.type==='movie'&&item.series&&<SeriesDetails item={item} revision={detail!.revision} active={active&&!paused}/>}
      {item.type==='movie'&&item.film&&<FilmDetails key={item.id} film={item.film}/>}
      {/* Manga shows its information beside the cover; the other types keep this section. */}
      {item.type!=='manga'&&<section className="collection-block collection-information" aria-label="작품 정보 영역"><h2>작품 정보</h2>
        {description&&<><p className={`collection-overview ${overview?'':'is-clamped'}`}>{description}</p><Button variant="ghost" className="collection-overview-toggle" aria-expanded={overview} onClick={()=>setOverview(open=>!open)}>{overview?'접기':'더 보기'}</Button></>}
        <CollectionMetadata item={item}/></section>}
    </>}</>}</div>
    {sheet==='sort'&&<BottomSheet title="정렬" onClose={()=>setSheet(null)}>
      <p className="collection-sheet-label">기준</p><div role="radiogroup" aria-label="정렬 기준">{(Object.keys(SORT_LABELS) as Filters['sort'][]).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={filters.sort===value} onClick={()=>changeFilters({...filters,sort:value})}>{SORT_LABELS[value]}<span className="radio-dot"/></button>)}</div>
      <p className="collection-sheet-label">순서</p><div role="radiogroup" aria-label="정렬 순서">{(['desc','asc'] as const).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={filters.direction===value} onClick={()=>changeFilters({...filters,direction:value})}>{sortDirectionLabels(filters.sort)[value]}<span className="radio-dot"/></button>)}</div>
    </BottomSheet>}
    {sheet==='rating'&&<BottomSheet title="내 별점" onClose={()=>setSheet(null)}><RatingFilterSlider value={filters.rating} onChange={rating=>changeFilters({...filters,rating})}/></BottomSheet>}
    {active&&!paused&&coverIndex!==null&&item&&covers[coverIndex]&&<Dialog open title={covers[coverIndex].label} onClose={()=>setCoverIndex(null)} variant="wide"><div className="collection-appreciation"><DialogDescription className="sr-only">선택한 표지를 크게 감상합니다.</DialogDescription>
      <div className="dialog-header">{physical&&<div className="collection-cover-mode" role="radiogroup" aria-label="표지 보기 방식">{(['3d','flat'] as const).map(value=><button key={value} role="radio" aria-checked={coverMode===value} onClick={()=>setCoverMode(value)}>{value==='3d'?'입체':'평면'}</button>)}</div>}<IconButton label="표지 감상 닫기" icon={XMarkIcon} onClick={()=>setCoverIndex(null)}/></div>
      <div className="collection-cover-stage"><CoverStage key={`${edition}:${coverIndex}:${coverMode}`} item={item} id={covers[coverIndex].id} revision={detail!.revision} label={covers[coverIndex].label} mode={physical?coverMode:'flat'} onFlat={()=>setCoverMode('flat')}/></div>
      <footer><IconButton label="이전 표지" icon={ChevronLeftIcon} disabled={coverIndex===0} onClick={()=>setCoverIndex(value=>value!-1)}/><span className="numeric muted">{coverIndex+1} / {covers.length}</span><IconButton label="다음 표지" icon={ChevronRightIcon} disabled={coverIndex===covers.length-1} onClick={()=>setCoverIndex(value=>value!+1)}/></footer></div></Dialog>}
  </section>;
}
