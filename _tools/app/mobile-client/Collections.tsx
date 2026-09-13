import {HeaderTools} from './HeaderTools';
import {usePublicationCheck} from './usePublicationCheck';
import {CollectionMetadata} from './CollectionMetadata';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowPathIcon, ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, XMarkIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {api, errorText, native} from './transport';
import {mediaTicket} from './media';
import {collectionCardCredit, collectionCardDate, collectionCover, collectionPath, defaultCollectionFilters, editions, editionVolumes, volumeLabel} from './collectionModel';
import type {CollectionDetail, CollectionKind, CollectionPage, CollectionSummary, CollectionFilters as Filters} from './collectionModel';
import type {Ticket} from './types';
import {CollectionFilters} from './CollectionFilters';
import './Collections.css';

const labels = {game:'게임',manga:'만화',movie:'영화'};
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
function Artwork({item,id,revision,original=false,active=true,label}:{item:CollectionSummary;id?:string|null;revision:string;original?:boolean;active?:boolean;label?:string}) {
  const host=useRef<HTMLSpanElement>(null), [visible,setVisible]=useState(original), [url,setUrl]=useState(''), [failed,setFailed]=useState(false);
  useEffect(()=>{if(original || !host.current)return; if(!('IntersectionObserver' in window)){setVisible(true);return;} const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'120px'});observer.observe(host.current);return()=>observer.disconnect();},[original]);
  useEffect(()=>{if(!active||!visible||(!id&&!item.coverAssetId))return;setFailed(false);const controller=new AbortController();void artworkTicket(item,id,revision,original,controller.signal).then(ticket=>{if(controller.signal.aborted)return;if(!/^https:\/\//.test(ticket.url)&&!(import.meta.env.DEV&&ticket.url.startsWith('data:image/')))throw new Error('Invalid artwork');setUrl(ticket.url);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});return()=>controller.abort();},[item.id,item.coverAssetId,id,revision,original,active,visible]);
  return <span ref={host} className={`collection-art collection-art-${item.type}`}>{url&&!failed?<img src={url} alt={label??item.name} onError={()=>setFailed(true)}/>:<span className="collection-art-placeholder"><RectangleStackIcon/><span>{failed?'이미지를 불러오지 못했습니다':(!id&&!item.coverAssetId)?'표지 없음':original?'불러오는 중…':'표지'}</span></span>}</span>;
}
function HeroArtwork({item,id,revision,active}:{item:CollectionDetail;id:string;revision:string;active:boolean}) {
  const [original,setOriginal]=useState('');
  useEffect(()=>{
    if(!active||!item.artworks.find(art=>art.id===id)?.originalAvailable)return;
    const controller=new AbortController();
    void artworkTicket(item,id,revision,true,controller.signal).then(async ticket=>{
      const image=new Image();image.src=ticket.url;await image.decode();if(!controller.signal.aborted)setOriginal(ticket.url);
    }).catch(()=>{});return()=>controller.abort();
  },[item.id,id,revision,active]);
  return <div className="collection-backdrop"><Artwork item={item} id={id} revision={revision} active={active}/>{original&&<img className="collection-hero-original" src={original} alt=""/>}</div>;
}
function SeriesDetails({item,revision,active}:{item:CollectionDetail;revision:string;active:boolean}) {
  const seasons=item.series?.seasons??[];
  const [seasonId,setSeasonId]=useState(seasons.find(s=>s.seasonNumber>0)?.id??seasons[0]?.id),[limit,setLimit]=useState(30);
  const selected=seasons.find(s=>s.id===seasonId)??seasons[0];
  return <section className="collection-series" aria-label="시즌 및 회차"><div className="collection-season-grid">{seasons.map(season=><button className="collection-tile" key={season.id} aria-pressed={selected?.id===season.id} onClick={()=>{setSeasonId(season.id);setLimit(30);}}><Artwork item={item} id={season.posterArtworkId} revision={revision} active={active}/><strong>{season.name}</strong><small>{season.airDate} · {season.episodes.length}화</small></button>)}</div>{selected&&<><h2>{selected.name}</h2><ol className="collection-episodes">{selected.episodes.slice(0,limit).map(episode=><li key={episode.id}><span className="numeric">{episode.episodeNumber}</span><strong>{episode.name}</strong><small>{[episode.airDate,episode.runtimeMinutes?`${episode.runtimeMinutes}분`:null].filter(Boolean).join(' · ')}</small></li>)}</ol>{selected.episodes.length>limit&&<Button variant="ghost" onClick={()=>setLimit(n=>n+30)}>회차 더 보기</Button>}</>}{!!item.series?.cast.length&&<p className="collection-cast">출연 · {item.series.cast.join(' · ')}</p>}</section>;
}
export function Collections({active,paused,backRef}:{active:boolean;paused:boolean;backRef:React.MutableRefObject<(()=>boolean)|null>}) {
  const [type,setType]=useState<CollectionKind>('game'),[showcase,setShowcase]=useState(false),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [filtersByType,setFiltersByType]=useState<Record<CollectionKind,Filters>>(()=>({game:defaultCollectionFilters(),manga:defaultCollectionFilters(),movie:defaultCollectionFilters()}));
  const filters=filtersByType[type];
  const [page,setPage]=useState<CollectionPage|null>(null),[cursor,setCursor]=useState<string|null>(null),[previous,setPrevious]=useState<(string|null)[]>([]),[refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[legacy,setLegacy]=useState(false);
  const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<{revision:string;item:CollectionDetail}|null>(null),[detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const [edition,setEdition]=useState(0),[coverIndex,setCoverIndex]=useState<number|null>(null),[volumeLimit,setVolumeLimit]=useState(96);
  const [drawer,setDrawer]=useState(false);
  useEffect(()=>{if(!active)return;const open=()=>setDrawer(v=>!v);window.addEventListener('lakomics-sidebar',open);return()=>window.removeEventListener('lakomics-sidebar',open);},[active]);
  const listRef=useRef<HTMLDivElement>(null),listScroll=useRef(0);
  useEffect(()=>{if(!active)return;const controller=new AbortController();setBusy(true);setError('');setLegacy(false);void api<CollectionPage>(collectionPath(type,search,showcase,cursor,filters),controller.signal).then(result=>{if(!controller.signal.aborted){if(result.ready&&!showcase&&result.filterVersion!==1)throw new Error('별점 필터와 정렬을 사용하려면 서버 업데이트가 필요합니다.');setPage(result);if(listRef.current)listRef.current.scrollTop=listScroll.current;}}).catch(reason=>{if(!controller.signal.aborted){if((reason as {status?:number}).status===404)setLegacy(true);else setError(errorText(reason));}}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[active,type,search,showcase,cursor,refresh,filters]);
  useEffect(()=>{if(!active||!selected)return;const controller=new AbortController();setDetail(current=>current?.item.id===selected?current:null);setDetailError('');setCoverIndex(null);void api<{revision:string;item:CollectionDetail}>(`/v1/collections/${encodeURIComponent(selected)}`,controller.signal).then(result=>{if(!controller.signal.aborted){setDetail(result);setVolumeLimit(96);setEdition(current=>editions(result.item.volumes).includes(current)?current:editions(result.item.volumes)[0]??0);}}).catch(reason=>{if(!controller.signal.aborted)setDetailError(errorText(reason));});return()=>controller.abort();},[active,selected,detailRefresh]);
  usePublicationCheck(active&&!paused&&coverIndex===null,'/v1/collections/status',page?.revision,()=>{setCursor(null);setPrevious([]);setRefresh(n=>n+1);setDetailRefresh(n=>n+1);});
  const back=useCallback(()=>{if(coverIndex!==null){setCoverIndex(null);return true;}if(selected){setSelected(null);return true;}return false;},[coverIndex,selected]);
  useEffect(()=>{backRef.current=back;return()=>{backRef.current=null;};},[back,backRef]);
  useEffect(()=>{if(!active||paused)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&coverIndex===null){event.preventDefault();back();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[active,paused,back,coverIndex]);
  const reset=()=>{setCursor(null);setPrevious([]);setPage(null);listScroll.current=0;};
  const changeFilters=(next:Filters)=>{if(next.sort===filters.sort&&next.direction===filters.direction&&next.rating===filters.rating)return;reset();setFiltersByType(current=>({...current,[type]:next}));};
  const filtered=!!search||filters.rating!=='all';
  const item=detail?.item, volumes=item?editionVolumes(item.volumes,edition):[], editionOptions=item?editions(item.volumes):[];
  const covers=item?[{id:collectionCover(item),label:item.name},...volumes.map(v=>({id:v.coverArtworkId,label:volumeLabel(v)}))]:[];
  const background=item?(item.type==='game'?item.selectedHeroArtworkId:item.selectedBackdropArtworkId):null;
  return <section className={`mobile-collections ${selected?'has-detail':''} ${drawer?'sidebar-open':''}`} style={{display:active?undefined:'none'}} aria-label="컬렉션">
    <HeaderTools active={active} target="context-location"><div className="gallery-heading collection-header"><div className="location"><span className="location-square"/><h2>{labels[type]}{showcase?' · 쇼케이스':''}</h2>{page?.totalCount!=null&&<span className="numeric muted collection-total" aria-label="필터 결과 개수">{page.totalCount.toLocaleString()}개</span>}</div><IconButton label="새로고침" icon={ArrowPathIcon} disabled={busy} onClick={()=>selected?setDetailRefresh(value=>value+1):setRefresh(value=>value+1)}/></div></HeaderTools>
    <aside className="collection-index"><div className="index-title"><span>컬렉션</span><RectangleStackIcon/></div>{selected?<><Button variant="ghost" onClick={()=>setSelected(null)}><ArrowLeftIcon/>목록으로</Button><h2>{item?.name??'작품 불러오는 중'}</h2>{item&&<><CollectionMetadata item={item}/>{editionOptions.length>1&&<label className="collection-edition">판본<select aria-label="판본" value={edition} onChange={event=>{setEdition(Number(event.target.value));setVolumeLimit(96);setCoverIndex(null);}}>{editionOptions.map(value=><option key={value} value={value}>{value===0?'기본판':`판본 ${value+1}`}</option>)}</select></label>}</>}</>:<><div className="collection-modes">{[false,true].map(value=><Button key={String(value)} variant="ghost" aria-pressed={showcase===value} onClick={()=>{if(showcase===value)return;reset();setShowcase(value);}}>{value?'쇼케이스':'라이브러리'}</Button>)}</div><div className="collection-types">{(Object.keys(labels) as CollectionKind[]).map(value=><Button key={value} variant="ghost" aria-pressed={type===value} onClick={()=>{if(type===value)return;reset();setType(value);}}>{labels[value]}</Button>)}</div><form className="collection-search" onSubmit={event=>{event.preventDefault();reset();setSearch(query.trim());setRefresh(value=>value+1);}}><input aria-label="컬렉션 검색" placeholder="작품 검색" value={query} onChange={event=>setQuery(event.target.value)}/><Button type="submit" variant="ghost">검색</Button></form>{!showcase&&<CollectionFilters value={filters} onChange={changeFilters}/>}</>}</aside>
    <div className="collection-content">
      <div ref={listRef} onScroll={event=>{listScroll.current=event.currentTarget.scrollTop;}} className="collection-list" style={{display:selected?'none':undefined}}>
        {busy&&<p role="status">컬렉션을 불러오는 중…</p>}
        {error&&<div className="error-message" role="alert">{error}<Button variant="ghost" onClick={()=>{reset();setRefresh(value=>value+1);}}>처음부터 새로고침</Button></div>}
        {legacy||page?.ready===false?<div className="empty-state"><RectangleStackIcon/><h2>컬렉션이 아직 공유되지 않았습니다</h2><p>{legacy?'서버에 모바일 컬렉션 기능이 필요합니다. 서버 업데이트 후 PC에서 컬렉션을 게시해 주세요.':'PC의 설정에서 컬렉션을 클라우드에 게시하면 여기에서 감상할 수 있습니다.'}</p></div>:page?.ready&&<><div className={`collection-grid ${showcase?'collection-showcase':''} collection-grid-${type}`} style={showcase?{'--showcase-columns':page.items.length<=9?3:4} as React.CSSProperties:undefined}>{page.items.map(work=><button className="collection-tile" key={work.id} onClick={()=>setSelected(work.id)}><Artwork item={work} id={collectionCover(work)} revision={page.revision??''} active={active&&!paused&&!selected}/><span className="collection-title">{work.name}</span><span className="collection-credit">{collectionCardCredit(work)}</span><span className="collection-date">{collectionCardDate(work)}</span>{!showcase&&work.myScore!=null&&<span className="collection-score" aria-label={`내 별점 ${work.myScore.toFixed(1)}점`}>★ {work.myScore.toFixed(1)}</span>}</button>)}</div>{!page.items.length&&<div className="empty-state"><h2>{!showcase&&filtered?'조건에 맞는 작품이 없습니다':showcase?'쇼케이스에 작품이 없습니다':'아직 컬렉션이 없습니다'}</h2><p>{!showcase&&filtered?'검색어나 별점 조건을 바꿔 보세요.':'PC에서 작품을 정리한 뒤 다시 게시하면 반영됩니다.'}</p>{!showcase&&filtered&&<Button onClick={()=>{reset();setQuery('');setSearch('');changeFilters({...filters,rating:'all'});}}>검색·필터 초기화</Button>}</div>}<footer className="page-footer"><Button variant="ghost" disabled={!previous.length||busy} onClick={()=>{setCursor(previous[previous.length-1]);setPrevious(values=>values.slice(0,-1));listScroll.current=0;}}><ChevronLeftIcon/>이전</Button><span>{previous.length+1}</span><Button variant="ghost" disabled={!page.nextCursor||busy} onClick={()=>{if(page.nextCursor===cursor){setError('목록 커서가 진행되지 않습니다.');return;}setPrevious(values=>[...values,cursor]);setCursor(page.nextCursor);listScroll.current=0;}}>다음<ChevronRightIcon/></Button></footer></>}
      </div>
      {selected&&<div className="collection-detail">{detailError?<div className="inline-error" role="alert">{detailError}<Button onClick={()=>setDetailRefresh(value=>value+1)}>다시 시도</Button></div>:!item?<p role="status">작품을 불러오는 중…</p>:<>{background&&<HeroArtwork item={item} id={background} revision={detail!.revision} active={active&&!paused}/>}<div className={`collection-detail-intro ${background?'has-backdrop':''}`}><button className="collection-detail-cover" aria-label={`${item.name} 표지 감상`} onClick={()=>setCoverIndex(0)}><Artwork item={item} id={collectionCover(item)} revision={detail!.revision} active={active&&!paused}/></button><div><span className="collection-credit">{labels[item.type]}</span><h1>{item.name}</h1><p>{item.author||item.developer||item.director}</p>{item.runtimeMinutes&&<p>{item.runtimeMinutes}분</p>}</div></div><div className="collection-portrait-metadata"><CollectionMetadata item={item}/></div>{item.series&&<SeriesDetails key={item.id} item={item} revision={detail!.revision} active={active&&!paused}/>}
{volumes.length>0&&<section className="collection-volume-section" aria-label="권별 표지"><h2>{volumes.length}권</h2><div className="collection-volume-shelf">{volumes.slice(0,volumeLimit).map((volume,index)=><button key={volume.id} className="collection-tile" onClick={()=>setCoverIndex(index+1)}><Artwork item={item} id={volume.coverArtworkId} revision={detail!.revision} active={active&&!paused}/><span>{volumeLabel(volume)}</span></button>)}</div>{volumes.length>volumeLimit&&<Button variant="ghost" onClick={()=>setVolumeLimit(value=>value+96)}>표지 더 보기</Button>}</section>}{item.type==='movie'&&(item.overview||item.description)&&<p className="collection-overview">{item.overview||item.description}</p>}</>}</div>}
    </div>
    {active&&!paused&&coverIndex!==null&&item&&covers[coverIndex]&&<Dialog open title={covers[coverIndex].label} onClose={()=>setCoverIndex(null)} variant="wide"><div className="collection-appreciation"><DialogDescription className="sr-only">선택한 표지를 크게 감상합니다.</DialogDescription><div className="dialog-header"><IconButton label="표지 감상 닫기" icon={XMarkIcon} onClick={()=>setCoverIndex(null)}/></div><Artwork key={`${edition}:${coverIndex}`} item={item} id={covers[coverIndex].id} revision={detail!.revision} label={covers[coverIndex].label} original/><footer><IconButton label="이전 표지" icon={ChevronLeftIcon} disabled={coverIndex===0} onClick={()=>setCoverIndex(value=>value!-1)}/><IconButton label="다음 표지" icon={ChevronRightIcon} disabled={coverIndex===covers.length-1} onClick={()=>setCoverIndex(value=>value!+1)}/></footer></div></Dialog>}
  </section>;
}
