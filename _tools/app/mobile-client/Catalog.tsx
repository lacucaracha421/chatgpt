import {usePublicationCheck} from './usePublicationCheck';
import {HeaderTools} from './HeaderTools';
import {useCallback,useEffect,useRef,useState,type MutableRefObject} from 'react';
import {ArrowLeftIcon,ArrowPathIcon,BookmarkIcon,BookOpenIcon,MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {BookmarkIcon as BookmarkSolidIcon} from '@heroicons/react/24/solid';
import {Button,IconButton} from './ui';
import {api,errorText} from './transport';
import {catalogImageTicket} from './catalogMedia';
import {CatalogReader} from './CatalogReader';
import {CatalogRefresh} from './CatalogRefresh';
import {useBookmarks,usePendingRetry} from './useBookmarks';
import {BOOKMARK_CONTRACT_VERSION,type BookmarkAuthority} from './bookmarkOutbox';
import {DEFAULT_CATALOG_QUERY,catalogPath,catalogDetailPath,catalogEditionsPath,catalogReaderPath,catalogTagQuery,catalogError,type CatalogQuery,type CatalogItem,type CatalogPage,type CatalogDetail,type CatalogEditions,type CatalogReaderManifest} from './catalogModel';
import './Catalog.css';

function lruGet<K,V>(map:Map<K,V>,key:K){const value=map.get(key);if(value!==undefined){map.delete(key);map.set(key,value);}return value;}
function lruSet<K,V>(map:Map<K,V>,key:K,value:V,limit:number){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);}

/** The one background reader-manifest request for the currently selected work. */
type ReaderPrefetch={cacheKey:string;owner:string;controller:AbortController;promise:Promise<CatalogReaderManifest>};
function readerCacheKey(item:Pick<CatalogItem,'provider'|'providerWorkId'>,revision:string){return `${revision}:${item.provider}:${item.providerWorkId}`;}

function CatalogCover({item,revision,active}:{item:CatalogItem;revision:string;active:boolean}){
  const [url,setUrl]=useState(''),[failed,setFailed]=useState(false),[visible,setVisible]=useState(false);
  const host=useRef<HTMLSpanElement>(null);
  useEffect(()=>{if(!host.current)return;if(!window.IntersectionObserver){setVisible(true);return;}const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'120px'});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!active||!visible||!item.thumbnailUrl)return;setFailed(false);
    const controller=new AbortController();
    void catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl},controller.signal).then(ticket=>{
      if(controller.signal.aborted)return;
      if(!ticket.url.startsWith('https://app.lakomics.local/media-cache/')&&!(import.meta.env.DEV&&ticket.url.startsWith('data:image/')))throw new Error('Invalid catalog cover');
      setUrl(ticket.url);
    }).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
    return()=>controller.abort();
  },[item.providerWorkId,item.thumbnailUrl,revision,active,visible]);
  return <span className="catalog-cover-image" ref={host}>{url&&!failed?<img src={url} alt="" onError={()=>setFailed(true)}/>:null}</span>;
}

export function Catalog({active,paused,backRef,endpoint=''}:{active:boolean;paused:boolean;backRef:MutableRefObject<(()=>boolean)|null>;endpoint?:string}){
  const [sidebar,setSidebar]=useState(false);
  useEffect(()=>{if(!active)return;const toggle=()=>setSidebar(v=>!v);window.addEventListener('lakomics-sidebar',toggle);return()=>window.removeEventListener('lakomics-sidebar',toggle);},[active]);
  const [query,setQuery]=useState<CatalogQuery>(DEFAULT_CATALOG_QUERY),[draft,setDraft]=useState('');
  const [cursor,setCursor]=useState<string|null>(null),[previous,setPrevious]=useState<(string|null)[]>([]);
  const [page,setPage]=useState<CatalogPage|null>(null),[refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[countError,setCountError]=useState('');
  const [countRetry,setCountRetry]=useState(0);
  const [selected,setSelected]=useState<CatalogItem|null>(null),[detail,setDetail]=useState<CatalogDetail|null>(null);
  const [detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const [editions,setEditions]=useState<CatalogEditions|null>(null),[editionCursor,setEditionCursor]=useState<string|null>(null),[editionError,setEditionError]=useState('');
  const [reader,setReader]=useState<CatalogReaderManifest|null>(null),[readerBusy,setReaderBusy]=useState(false),[readerError,setReaderError]=useState('');
  const committed=useRef(''),list=useRef<HTMLDivElement>(null),scroll=useRef(0),publication=useRef<string|null>(null);
  const authorityCursor=useRef<number|null|undefined>(undefined);
  const published=page?.publicationRevision;
  const statusPath='/v1/mobile-catalog/status';
  const [authority,setAuthority]=useState<BookmarkAuthority|null>(null);
  const onStatus=useCallback((reply:unknown,changed:boolean)=>{
    // The authority is re-read on every check, because a server can start or stop
    // advertising the write capability without the publication moving.
    const status=reply as {authorityLibraryId?:string|null;authorityEpoch?:number|null;authorityContractVersion?:number|null;authorityCursor?:number|null;capabilities?:{bookmarkWrite?:boolean}};
    const epoch=status.authorityEpoch;
    const nextCursor=typeof status.authorityCursor==='number'?status.authorityCursor:null;
    const bookmarkChanged=authorityCursor.current!==undefined&&authorityCursor.current!==nextCursor;
    authorityCursor.current=nextCursor;
    setAuthority(status.authorityLibraryId!=null&&status.capabilities?.bookmarkWrite===true&&typeof epoch==='number'&&epoch>=1
      ?{libraryId:status.authorityLibraryId,epoch,contractVersion:status.authorityContractVersion??BOOKMARK_CONTRACT_VERSION}
      :null);
    if(changed)reload();
    else if(bookmarkChanged)refreshBookmarks();
  },[selected]);
  usePublicationCheck(active&&!paused&&!reader,statusPath,published,onStatus,5_000);
  const bookmarks=useBookmarks({active:active&&!paused,authority});
  const pendingWork=selected?bookmarks.hasPending(selected.provider,selected.providerWorkId):false;
  usePendingRetry(active&&!paused,pendingWork,bookmarks.flush);
  const pageCache=useRef(new Map<string,CatalogPage>()),detailCache=useRef(new Map<string,CatalogDetail>()),editionCache=useRef(new Map<string,CatalogEditions>()),readerCache=useRef(new Map<string,CatalogReaderManifest>());
  const prefetches=useRef(new Map<string,AbortController>()),readerRequest=useRef<AbortController|null>(null),readerPrefetch=useRef<ReaderPrefetch|null>(null);
  const path=catalogPath(query,cursor),key=`${path}:${refresh}`;

  const readerOwner = `${active}:${paused}:${selected?.provider ?? ''}:${selected?.providerWorkId ?? ''}:${page?.publicationRevision ?? ''}:${page?.context ?? ''}:${key}`;
  const currentReaderOwner = useRef(readerOwner); currentReaderOwner.current = readerOwner;
  useEffect(() => {
    readerRequest.current?.abort(); readerRequest.current = null;
    readerPrefetch.current?.controller.abort(); readerPrefetch.current = null;
    setReader(null); setReaderBusy(false); setReaderError('');
    return () => { readerRequest.current?.abort(); readerPrefetch.current?.controller.abort(); };
  }, [readerOwner]);

  const resetPublicationCaches=(revision:string|null)=>{
    if(publication.current&&revision&&publication.current!==revision){pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();readerCache.current.clear();}
    if(revision)publication.current=revision;
  };
  const prefetchNext=(result:CatalogPage)=>{
    if(!result.nextCursor||!result.publicationRevision)return;const next=catalogPath(query,result.nextCursor);
    if(pageCache.current.has(next)||prefetches.current.has(next))return;
    const controller=new AbortController();prefetches.current.set(next,controller);
    void api<CatalogPage>(next,controller.signal).then(value=>{if(!controller.signal.aborted&&value.publicationRevision===result.publicationRevision)lruSet(pageCache.current,next,value,12);}).catch(()=>{}).finally(()=>prefetches.current.delete(next));
  };
  useEffect(()=>()=>{for(const controller of prefetches.current.values())controller.abort();readerRequest.current?.abort();readerPrefetch.current?.controller.abort();},[]);
  useEffect(()=>{
    if(!active||paused||committed.current===key)return;
    const cached=lruGet(pageCache.current,path);
    if(cached){resetPublicationCaches(cached.publicationRevision);committed.current=key;setPage(cached);setBusy(false);setError('');prefetchNext(cached);return;}
    const controller=new AbortController();setBusy(true);setError('');setCountError('');
    void api<CatalogPage>(path,controller.signal).then(result=>{
      if(controller.signal.aborted)return;resetPublicationCaches(result.publicationRevision);lruSet(pageCache.current,path,result,12);
      committed.current=key;setPage(result);setBusy(false);if(list.current)list.current.scrollTop=0;prefetchNext(result);
    }).catch(reason=>{if(!controller.signal.aborted){setError(catalogError(reason)||errorText(reason));setBusy(false);}});
    return()=>controller.abort();
  },[active,paused,key,path,query,cursor]);
  useEffect(()=>{
    if(!active||paused||!page?.countToken||page.countStatus==='ready')return;
    const controller=new AbortController(),countToken=page.countToken;setCountError('');
    void api<{publicationRevision:string;totalCount:number}>(`/v1/mobile-catalog/count?${new URLSearchParams({token:countToken})}`,controller.signal).then(count=>{
      if(!controller.signal.aborted)setPage(current=>current?.countToken===countToken&&current.publicationRevision===count.publicationRevision?{...current,totalCount:count.totalCount,countStatus:'ready'}:current);
    }).catch(reason=>{if(!controller.signal.aborted){setCountError(catalogError(reason)||errorText(reason));setPage(current=>current?.countToken===countToken?{...current,countStatus:'unavailable'}:current);}});
    return()=>controller.abort();
  },[active,paused,page?.countToken,countRetry]);
  useEffect(()=>{
    backRef.current=()=>{if(reader){closeReader();return true;}if(selected){setSelected(null);return true;}return false;};return()=>{backRef.current=null;};
  },[reader,selected,backRef]);
  useEffect(()=>{if(!selected&&list.current)list.current.scrollTop=scroll.current;},[selected]);
  useEffect(()=>{
    if(!selected||!page?.context||!page.publicationRevision||!active||paused)return;
    const cacheKey=`${page.publicationRevision}:${selected.provider}:${selected.providerWorkId}`,cached=lruGet(detailCache.current,cacheKey);
    if(cached){setDetail(cached);setDetailError('');return;}
    const controller=new AbortController();setDetail(null);setDetailError('');
    void api<{publicationRevision:string;item:CatalogDetail&{bookmarkRevision?:number}}>(catalogDetailPath(selected,page.context),controller.signal).then(result=>{if(!controller.signal.aborted&&result.publicationRevision===page.publicationRevision){lruSet(detailCache.current,cacheKey,result.item,48);setDetail(result.item);if(typeof result.item.bookmarkRevision==='number')bookmarks.observe(result.item.provider,result.item.providerWorkId,result.item.bookmarkRevision,result.item.bookmarked);}}).catch(reason=>{if(!controller.signal.aborted)setDetailError(catalogError(reason)||errorText(reason));});
    return()=>controller.abort();
  },[selected,page?.context,page?.publicationRevision,active,paused,detailRefresh]);
  useEffect(()=>{
    if(!selected||!page?.context||!page.publicationRevision||!active||paused)return;
    const requestPath=catalogEditionsPath(selected.groupId,page.context,editionCursor),cacheKey=`${page.publicationRevision}:${requestPath}`,cached=lruGet(editionCache.current,cacheKey);
    if(cached){setEditions(cached);setEditionError('');return;}
    const controller=new AbortController();setEditionError('');
    void api<CatalogEditions>(requestPath,controller.signal).then(result=>{if(!controller.signal.aborted&&result.publicationRevision===page.publicationRevision){lruSet(editionCache.current,cacheKey,result,48);setEditions(result);}}).catch(reason=>{if(!controller.signal.aborted)setEditionError(catalogError(reason)||errorText(reason));});
    return()=>controller.abort();
  },[selected?.groupId,page?.context,page?.publicationRevision,editionCursor,active,paused,detailRefresh]);
  useEffect(()=>{
    // The detail page is already open, so the reader manifest can be fetched while the
    // user decides. This is manifest-only: page bytes stay demand-driven.
    if(!active||paused||!selected||!detail||!page?.context||!page.publicationRevision||reader)return;
    const owner=readerOwner,revision=page.publicationRevision,cacheKey=readerCacheKey(selected,revision);
    if(readerPrefetch.current?.cacheKey===cacheKey&&readerPrefetch.current.owner===owner)return;
    readerPrefetch.current?.controller.abort();readerPrefetch.current=null;
    if(lruGet(readerCache.current,cacheKey))return;
    const controller=new AbortController();
    const promise=api<CatalogReaderManifest>(catalogReaderPath(selected,page.context),controller.signal);
    readerPrefetch.current={cacheKey,owner,controller,promise};
    // A transport that ignores abort must still be unable to publish stale work.
    void promise.then(result=>{
      if(controller.signal.aborted||currentReaderOwner.current!==owner||result.publicationRevision!==revision||result.provider!==selected.provider||result.providerWorkId!==selected.providerWorkId)return;
      lruSet(readerCache.current,cacheKey,result,24);
    }).catch(()=>{/* Background work stays invisible; the 읽기 action is the retry path. */}).finally(()=>{if(readerPrefetch.current?.controller===controller)readerPrefetch.current=null;});
  },[active,paused,selected,detail,page?.context,page?.publicationRevision,reader,readerOwner]);

  function closeReader(){readerRequest.current?.abort();readerRequest.current=null;setReaderBusy(false);setReader(null);}
  const loadReader=(force=false)=>{
    if(!active||paused||!selected||!page?.context||!page.publicationRevision)return;const owner=readerOwner;const cacheKey=readerCacheKey(selected,page.publicationRevision);
    if(!force){const cached=lruGet(readerCache.current,cacheKey);if(cached){setReader(cached);setReaderError('');return;}}
    readerRequest.current?.abort();const controller=new AbortController();readerRequest.current=controller;setReaderBusy(true);setReaderError('');
    // An explicit Read adopts the request that is already in flight for this exact
    // publication/work/context instead of asking the server for a second copy. A forced
    // refresh discards that request and asks the server for a fresh manifest.
    const running=readerPrefetch.current,reusable=!force&&running&&running.cacheKey===cacheKey&&running.owner===owner?running:null;
    // A forced refresh must not adopt the background request, and the background request
    // must not publish itself after the user asked for fresh data.
    if(running&&!reusable){running.controller.abort();readerPrefetch.current=null;}
    const request=reusable?reusable.promise:api<CatalogReaderManifest>(catalogReaderPath(selected,page.context),controller.signal);
    void request.then(result=>{
      if(controller.signal.aborted||currentReaderOwner.current!==owner||result.publicationRevision!==page.publicationRevision||result.provider!==selected.provider||result.providerWorkId!==selected.providerWorkId)return;lruSet(readerCache.current,cacheKey,result,24);setReader(result);
    }).catch(reason=>{if(!controller.signal.aborted)setReaderError(catalogError(reason)||errorText(reason));}).finally(()=>{if(readerRequest.current===controller){readerRequest.current=null;setReaderBusy(false);}});
  };
  function visibleEditionBookmark(item:CatalogEditions['items'][number]){
    if(detail?.provider===item.provider&&detail.providerWorkId===item.providerWorkId){
      return bookmarks.stateFor(detail.provider,detail.providerWorkId,detail.bookmarked,detail.bookmarkRevision);
    }
    return bookmarks.stateFor(item.provider,item.providerWorkId,item.bookmarked);
  }
  function visibleGroupBookmark(item:CatalogItem){
    const direct=bookmarks.stateFor(item.provider,item.providerWorkId,item.bookmarked);
    if(direct.pending&&direct.desired)return {desired:true,pending:true};
    if(editions?.groupId===item.groupId&&editions.items.length===editions.totalCount){
      const states=editions.items.map(visibleEditionBookmark);
      return {desired:states.some(state=>state.desired),pending:states.some(state=>state.pending)};
    }
    if(direct.pending&&!direct.desired&&item.versionCount===1)return {desired:false,pending:true};
    return {desired:item.hasBookmarkedVersion,pending:direct.pending};
  }
  function applyBookmarkPresentation(provider:'kHentai',providerWorkId:string,desired:boolean){
    const groupId=selected?.provider===provider&&selected.providerWorkId===providerWorkId?selected.groupId:null;
    const completeEditions=groupId&&editions?.groupId===groupId&&editions.items.length===editions.totalCount?editions.items:null;
    const groupDesired=(item:CatalogItem)=>{
      if(!groupId||item.groupId!==groupId)return item.hasBookmarkedVersion;
      if(desired)return true;
      if(completeEditions)return completeEditions.some(version=>version.providerWorkId!==providerWorkId&&visibleEditionBookmark(version).desired);
      return item.versionCount===1?false:item.hasBookmarkedVersion;
    };
    setPage(current=>current?{...current,items:current.items.map(item=>item.groupId===groupId?{...item,bookmarked:item.providerWorkId===providerWorkId?desired:item.bookmarked,hasBookmarkedVersion:groupDesired(item)}:item)}:current);
    setSelected(current=>current&&current.provider===provider&&current.providerWorkId===providerWorkId?{...current,bookmarked:desired,hasBookmarkedVersion:groupDesired(current)}:current);
    setDetail(current=>current&&current.provider===provider&&current.providerWorkId===providerWorkId?{...current,bookmarked:desired}:current);
    setEditions(current=>current?{...current,items:current.items.map(item=>item.provider===provider&&item.providerWorkId===providerWorkId?{...item,bookmarked:desired}:item)}:current);
    pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();
  }
  function change(next:Partial<CatalogQuery>){setQuery(current=>({...current,...next}));setCursor(null);setPrevious([]);setSelected(null);setReader(null);scroll.current=0;}
  function open(item:CatalogItem){scroll.current=list.current?.scrollTop??0;setSelected(item);setEditionCursor(null);setEditions(null);setReader(null);setReaderError('');}
  function refreshBookmarks(){for(const controller of prefetches.current.values())controller.abort();prefetches.current.clear();pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();committed.current='';setRefresh(n=>n+1);if(selected)setDetailRefresh(n=>n+1);}
  function reload(){for(const controller of prefetches.current.values())controller.abort();prefetches.current.clear();pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();readerCache.current.clear();committed.current='';setCursor(null);setPrevious([]);setSelected(null);setReader(null);setRefresh(n=>n+1);}

  return <section className="mobile-catalog" style={{display:active?'flex':'none'}} aria-label="만화 카탈로그">
    <div className="catalog-content" style={{display:selected?'none':undefined}}>
      <HeaderTools active={active}><span className="numeric catalog-total">{page?.countStatus==='ready'?page.totalCount?.toLocaleString():''}</span>{page?.ready?<CatalogRefresh active={active&&!paused&&!selected} language={query.language} publication={page.publicationRevision} endpoint={endpoint} onPublished={reload}/>:<IconButton label="카탈로그 새로고침" icon={ArrowPathIcon} disabled={busy} onClick={reload}/>}</HeaderTools>
      {sidebar&&<aside className="catalog-options"><Button variant="ghost" onClick={()=>{reload();setSidebar(false);}}>목록 다시 불러오기</Button><label><input type="checkbox" checked={query.revealBlocked} onChange={event=>change({revealBlocked:event.target.checked})}/>차단 항목 보기</label></aside>}
      <form className="catalog-search" onSubmit={event=>{event.preventDefault();change({text:draft});}}><MagnifyingGlassIcon aria-hidden="true"/><input aria-label="카탈로그 검색" value={draft} onChange={event=>setDraft(event.target.value)} placeholder="제목, 작가, 태그…"/><Button type="submit" variant="ghost">검색</Button></form>
      <div className="catalog-filters"><select aria-label="카탈로그 언어" value={query.language} onChange={event=>change({language:event.target.value as CatalogQuery['language']})}><option value="korean">한국어</option><option value="japanese">일본어</option><option value="all">전체 언어</option></select><select aria-label="카탈로그 정렬" value={query.sort} onChange={event=>change({sort:event.target.value as CatalogQuery['sort']})}><option value="latest">최신순</option><option value="views">조회순</option><option value="hotDay">오늘 인기</option><option value="hotWeek">이번 주 인기</option><option value="hotMonth">이번 달 인기</option></select><Button variant="ghost" aria-pressed={query.scope==='bookmarked'} onClick={()=>change(query.scope==='all'?{scope:'bookmarked',sort:'latest'}:{scope:'all'})}><BookmarkIcon/>북마크</Button></div>
      {busy&&<div className="loading-line" role="status" aria-label="카탈로그 불러오는 중"/>}{error&&<div className="inline-error" role="alert">{error}<Button onClick={()=>{committed.current='';setRefresh(n=>n+1);}}>다시 시도</Button></div>}{countError&&<div className="catalog-count-error">개수를 확인하지 못했습니다.<Button size="sm" variant="ghost" onClick={()=>setCountRetry(n=>n+1)}>다시 시도</Button></div>}
      <div ref={list} className="catalog-scroll" onScroll={event=>{scroll.current=event.currentTarget.scrollTop;}}>
        {page?.ready===false?<div className="empty-state"><BookOpenIcon/><h2>카탈로그가 아직 공유되지 않았습니다</h2><p>PC 설정의 온라인 카탈로그에서 모바일에 게시해 주세요.</p></div>:page?.ready&&<>{page.items.length?<div className="catalog-grid">{page.items.map(item=>{const state=visibleGroupBookmark(item);return <button className="catalog-card" disabled={busy||committed.current!==key} key={`${item.provider}:${item.groupId}`} onClick={()=>open(item)}><div className="catalog-cover"><CatalogCover item={item} revision={page.publicationRevision??'0'.repeat(64)} active={active&&!paused&&!selected&&!reader}/><span className="catalog-cover-pages">{item.fileCount}p</span>{state.desired&&<BookmarkSolidIcon className={`catalog-saved${state.pending?' catalog-saved--pending':''}`} aria-label={state.pending?'북마크 저장 대기':'북마크됨'}/>}</div><strong>{item.title}</strong><span>{item.artists.join(' · ')||'작가 미상'}</span>{item.versionCount>1&&<span>{item.versionCount}개 판본</span>}</button>;})}</div>:<div className="empty-state"><h2>검색 결과가 없습니다</h2><p>검색어나 언어 조건을 바꿔 보세요.</p></div>}<footer className="page-footer"><Button disabled={!previous.length||busy} onClick={()=>{setCursor(previous[previous.length-1]??null);setPrevious(value=>value.slice(0,-1));}}>이전</Button><span>{previous.length+1}</span><Button disabled={!page.nextCursor||busy} onClick={()=>{setPrevious(value=>[...value,cursor]);setCursor(page.nextCursor);}}>다음</Button></footer></>}
      </div>
    </div>
    {selected&&<div className="catalog-detail"><div className="catalog-heading"><IconButton label="카탈로그 목록으로" icon={ArrowLeftIcon} onClick={()=>setSelected(null)}/><span>상세 정보</span></div>{detailError?<div role="alert" className="inline-error">{detailError}<Button onClick={()=>setDetailRefresh(n=>n+1)}>다시 시도</Button></div>:!detail?<p role="status">상세 정보를 불러오는 중…</p>:<><div className="catalog-detail-intro"><div className="catalog-detail-cover"><CatalogCover item={{...selected,thumbnailUrl:detail.thumbnailUrl}} revision={page?.publicationRevision??'0'.repeat(64)} active={active&&!paused&&!reader}/></div><div><h2>{detail.title}</h2>{detail.titleJpn&&detail.titleJpn!==detail.title&&<p className="muted">{detail.titleJpn}</p>}<p>{detail.fileCount}페이지 · 조회 {detail.views.toLocaleString()}</p>{(()=>{const state=bookmarks.stateFor(detail.provider,detail.providerWorkId,detail.bookmarked,detail.bookmarkRevision);const MarkIcon=state.desired?BookmarkSolidIcon:BookmarkIcon;return <><div className="catalog-primary-actions"><Button className="catalog-read-action" disabled={readerBusy} onClick={()=>loadReader(false)}><BookOpenIcon/>{readerBusy?'페이지 확인 중…':'읽기'}</Button><Button className="catalog-bookmark-action" aria-label={state.pending?state.desired?'북마크 저장 중':'북마크 해제 중':state.desired?'북마크 해제':'북마크'} aria-pressed={state.desired} disabled={!authority&&!state.pending} onClick={()=>{const desired=!state.desired;bookmarks.toggle(detail.provider,detail.providerWorkId,desired);applyBookmarkPresentation(detail.provider,detail.providerWorkId,desired);}}><MarkIcon className={state.pending?'catalog-bookmark-pending':undefined}/>{state.desired?'북마크됨':'북마크'}</Button></div>{bookmarks.failure?<span className="catalog-bookmark-state catalog-bookmark-error" role="alert">{bookmarks.failure}</span>:state.pending&&<span className="catalog-bookmark-state" role="status">저장 대기</span>}</>;})()}{readerError&&<p className="catalog-reader-error">{readerError}</p>}</div></div><div className="catalog-tags">{detail.tagGroups.map(group=><div key={group.namespace}><h3>{group.namespace}</h3><div>{group.values.map(value=><Button key={value} size="sm" variant="ghost" onClick={()=>{const text=catalogTagQuery(group.namespace,value);setDraft(text);change({text});}}>{group.labels?.[value]??value}</Button>)}</div></div>)}</div></>}
      <section className="catalog-editions" aria-label="카탈로그 판본"><h3>판본{editions?` · ${editions.totalCount}`:''}</h3>{editionError?<div role="alert">{editionError}<Button onClick={()=>setDetailRefresh(n=>n+1)}>다시 시도</Button></div>:editions?.items.map(item=>{const state=visibleEditionBookmark(item);return <button key={item.providerWorkId} className="catalog-edition" aria-current={detail?.providerWorkId===item.providerWorkId?'true':undefined} onClick={()=>setSelected(current=>current?{...current,...item}:current)}><span>{item.title}</span><small>{item.fileCount}p{state.desired?' · 북마크':''}{state.pending?' · 저장 대기':''}</small></button>;})}{editionCursor&&<Button variant="ghost" onClick={()=>setEditionCursor(null)}>처음 판본</Button>}{editions?.nextCursor&&<Button variant="ghost" onClick={()=>setEditionCursor(editions.nextCursor)}>다음 판본</Button>}</section>
    </div>}
    {reader&&selected&&<CatalogReader manifest={reader} title={detail?.title??selected.title} onClose={closeReader} onRefresh={()=>loadReader(true)} refreshing={readerBusy}/>}
  </section>;
}
