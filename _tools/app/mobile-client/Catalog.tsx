import {usePublicationCheck} from './usePublicationCheck';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type MutableRefObject} from 'react';
import {useLevelMotion} from './motion';
import {catalogDisplayTitle} from '../src/manga/catalogDisplayTitle';
import {ArrowLeftIcon,BookmarkIcon,BookOpenIcon,ChevronDownIcon,MagnifyingGlassIcon,FunnelIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {BookmarkIcon as BookmarkSolidIcon} from '@heroicons/react/24/solid';
import {SearchButton,TopBar,TopBarSearch} from './TopBar';
import {Button,IconButton} from './ui';
import {api,errorText} from './transport';
import {catalogImageTicket} from './catalogMedia';
import {CatalogReader} from './CatalogReader';
import {CatalogRefreshBanner,CatalogRefreshControl,useCatalogRefresh,useNow} from './CatalogRefresh';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {CatalogSettings} from './CatalogSettings';
import {useBookmarks,usePendingRetry} from './useBookmarks';
import {BOOKMARK_CONTRACT_VERSION,type BookmarkAuthority} from './bookmarkOutbox';
import {DEFAULT_CATALOG_QUERY,FILTER_JSON_MAX_BYTES,catalogPath,catalogPathIssue,catalogDetailPath,catalogEditionsPath,catalogReaderPath,catalogTagQuery,catalogError,supportsDisplayPreferences,supportsSuggestions,catalogSuggestionPath,suggestionQuery,utf8Bytes,SUGGESTION_LIMIT,SUGGESTION_TEXT_MAX_BYTES,type CatalogSuggestion,type CatalogQuery,type CatalogItem,type CatalogPage,type CatalogDetail,type CatalogEditions,type CatalogReaderManifest} from './catalogModel';
import {DEFAULT_CATALOG_PREFERENCES,clearCatalogPreferences,readCatalogPreferences,writeCatalogPreferences,type CatalogPreferences} from './catalogPreferences';
import './Catalog.css';

function lruGet<K,V>(map:Map<K,V>,key:K){const value=map.get(key);if(value!==undefined){map.delete(key);map.set(key,value);}return value;}
function lruSet<K,V>(map:Map<K,V>,key:K,value:V,limit:number){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);}


/** The one background reader-manifest request for the currently selected work. */
type ReaderPrefetch={cacheKey:string;owner:string;controller:AbortController;promise:Promise<CatalogReaderManifest>};
function readerCacheKey(item:Pick<CatalogItem,'provider'|'providerWorkId'>,revision:string,filterKey:string){return `${revision}:${filterKey}:${item.provider}:${item.providerWorkId}`;}

function CatalogCover({item,revision,active,onUrl}:{item:CatalogItem;revision:string;active:boolean;onUrl?(url:string|null):void}){
  const [image,setImage]=useState<{source:string;url:string}|null>(null),[failed,setFailed]=useState<string|null>(null),[visible,setVisible]=useState(false);
  const host=useRef<HTMLSpanElement>(null),loaded=useRef<string|null>(null);
  const source=JSON.stringify([item.provider,item.providerWorkId,item.thumbnailUrl,revision]);
  useEffect(()=>{if(!host.current)return;if(!window.IntersectionObserver){setVisible(true);return;}const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'120px'});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!active||!visible||!item.thumbnailUrl||loaded.current===source)return;setFailed(null);
    const controller=new AbortController();
    void catalogImageTicket({workId:item.providerWorkId,revision,kind:'cover',index:0,url:item.thumbnailUrl},controller.signal).then(ticket=>{
      if(controller.signal.aborted)return;
      if(!ticket.url.startsWith('https://app.lakomics.local/media-cache/')&&!(import.meta.env.DEV&&ticket.url.startsWith('data:image/')))throw new Error('Invalid catalog cover');
      loaded.current=source;setImage({source,url:ticket.url});
    }).catch(()=>{if(!controller.signal.aborted)setFailed(source);});
    return()=>controller.abort();
  },[source,active,visible]);
  const shown=image?.source===source&&failed!==source?image.url:null;
  useEffect(()=>{onUrl?.(shown);},[shown,onUrl]);
  return <span className="catalog-cover-image" ref={host}>{image?.source===source&&failed!==source?<img src={image.url} alt="" onError={()=>{loaded.current=null;setFailed(source);}}/>:null}</span>;
}

export function Catalog({active,paused,backRef,endpoint=''}:{active:boolean;paused:boolean;backRef:MutableRefObject<(()=>boolean)|null>;endpoint?:string}){
  const [preferences,setPreferences]=useState<CatalogPreferences>(()=>readCatalogPreferences(endpoint));
  const [query,setQuery]=useState<CatalogQuery>(()=>({...DEFAULT_CATALOG_QUERY,...preferences})),[draft,setDraft]=useState('');
  const [settings,setSettings]=useState(false);
  const [preferenceCheck,setPreferenceCheck]=useState(0);
  // The list is the first page plus the pages appended while scrolling.
  const [more,setMore]=useState<{items:CatalogItem[];nextCursor:string|null}|null>(null);
  const [moreBusy,setMoreBusy]=useState(false),[moreError,setMoreError]=useState('');
  const [sheet,setSheet]=useState<'language'|'sort'|null>(null);
  const [backdrop,setBackdrop]=useState<string|null>(null);
  const moreRequest=useRef<AbortController|null>(null);
  const restartedFor=useRef<string|null>(null);
  const [page,setPage]=useState<CatalogPage|null>(null),[refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[countError,setCountError]=useState('');
  const [countRetry,setCountRetry]=useState(0);
  const [selected,setSelected]=useState<CatalogItem|null>(null),[detail,setDetail]=useState<CatalogDetail|null>(null);
  const selectedKey=selected?`${selected.provider}:${selected.providerWorkId}`:null;
  const [detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const [editions,setEditions]=useState<CatalogEditions|null>(null),[editionCursor,setEditionCursor]=useState<string|null>(null),[editionError,setEditionError]=useState('');
  const [reader,setReader]=useState<CatalogReaderManifest|null>(null),[readerBusy,setReaderBusy]=useState(false),[readerError,setReaderError]=useState('');
  const section=useRef<HTMLElement>(null),committed=useRef(''),list=useRef<HTMLDivElement>(null),scroll=useRef(0),publication=useRef<string|null>(null);
  const authorityCursor=useRef<number|null|undefined>(undefined);
  const published=page?.publicationRevision;
  const statusPath='/v1/mobile-catalog/status';

  const [capability,setCapability]=useState<'checking'|'supported'|'unsupported'|'failed'>('checking');
  const [capabilityRetry,setCapabilityRetry]=useState(0);
  // Tag autocomplete, offered only by a server that advertises it.
  const [suggestable,setSuggestable]=useState(false);
  const [refreshSupported,setRefreshSupported]=useState(false);
  const [suggestOpen,setSuggestOpen]=useState(false),[options,setOptions]=useState<CatalogSuggestion[]>([]),[activeOption,setActiveOption]=useState(-1);
  const [searchOpen,setSearchOpen]=useState(false);
  const suggestRequest=useRef(0),searchInput=useRef<HTMLInputElement>(null),suggestionList=useRef<HTMLUListElement>(null);
  const activePreferences=preferences.categories!==null||preferences.excludedTags.length>0;
  const [authority,setAuthority]=useState<BookmarkAuthority|null>(null);
  const onStatus=useCallback((reply:unknown,changed:boolean)=>{
    // The authority is re-read on every check, because a server can start or stop
    // advertising the write capability without the publication moving.
    const status=reply as {authorityLibraryId?:string|null;authorityEpoch?:number|null;authorityContractVersion?:number|null;authorityCursor?:number|null;capabilities?:{bookmarkWrite?:boolean;refreshRequest?:boolean}};
    setCapability(supportsDisplayPreferences(status)?'supported':'unsupported');
    setSuggestable(supportsSuggestions(status));
    setRefreshSupported(status.capabilities?.refreshRequest===true);
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
  const searchMode=capability==='supported';
  const suggestions=suggestable&&searchMode;
  useEffect(()=>{
    // Only typing asks: 120 ms after the last keystroke, and a reply that is no longer
    // the latest request is dropped even when the transport ignores the abort.
    const text=draft.trim(),request=++suggestRequest.current;
    if(!suggestions||!suggestOpen||!active||paused||!text||utf8Bytes(text)>SUGGESTION_TEXT_MAX_BYTES){setOptions([]);setActiveOption(-1);return;}
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      void api<{items?:CatalogSuggestion[]}>(catalogSuggestionPath(text,query.revealBlocked),controller.signal).then(reply=>{
        if(controller.signal.aborted||request!==suggestRequest.current)return;
        setOptions(Array.isArray(reply.items)?reply.items.slice(0,SUGGESTION_LIMIT):[]);setActiveOption(-1);
      }).catch(()=>{if(!controller.signal.aborted&&request===suggestRequest.current)setOptions([]);});
    },120);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[draft,suggestions,suggestOpen,active,paused,query.revealBlocked]);
  useEffect(()=>{
    if(activeOption<0)return;
    suggestionList.current?.children[activeOption]?.scrollIntoView?.({block:'nearest'});
  },[activeOption]);
  const listboxOpen=suggestions&&suggestOpen&&options.length>0;
  usePublicationCheck(active&&!paused&&!reader,statusPath,published,onStatus,30_000,{
    retryKey:capabilityRetry,
    onError:()=>setCapability(current=>current==='checking'?'failed':current),
  });
  const bookmarks=useBookmarks({active:active&&!paused,authority});
  const pendingWork=selected?bookmarks.hasPending(selected.provider,selected.providerWorkId):false;
  usePendingRetry(active&&!paused,pendingWork,bookmarks.flush);
  const pageCache=useRef(new Map<string,CatalogPage>()),detailCache=useRef(new Map<string,CatalogDetail>()),editionCache=useRef(new Map<string,CatalogEditions>()),readerCache=useRef(new Map<string,CatalogReaderManifest>());
  // Detail, edition and reader caches are keyed by the filter identity as well as the
  // publication. A work the user just excluded is rejected by the server for this
  // filter, so a cache entry written under a wider filter must not be served for it.
  const filterKey=JSON.stringify([query.categories,query.excludedTags]);
  const prefetches=useRef(new Map<string,AbortController>()),readerRequest=useRef<AbortController|null>(null),readerPrefetch=useRef<ReaderPrefetch|null>(null);
  // A setting this server cannot honor must not become an unfiltered list.
  const preferencesBlocked=activePreferences&&capability==='unsupported';
  const path=catalogPath(query,null,{searchMode}),key=`${path}:${refresh}`;
  // A composed request the server or the native transport would reject is reported
  // instead of sent, so an over-long filter cannot fail silently.
  const wireIssue=catalogPathIssue(query,{searchMode});

  // The list waits for the capability decision, so it is fetched once with the right
  // search mode. Ordinary browsing also waits, but only for this one reply.
  const listReady=(capability==='supported'||capability==='unsupported')&&!preferencesBlocked&&wireIssue==='none';

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
    if(!result.nextCursor||!result.publicationRevision)return;const next=catalogPath(query,result.nextCursor,{searchMode});
    if(pageCache.current.has(next)||prefetches.current.has(next))return;
    const controller=new AbortController();prefetches.current.set(next,controller);
    void api<CatalogPage>(next,controller.signal).then(value=>{if(!controller.signal.aborted&&value.publicationRevision===result.publicationRevision)lruSet(pageCache.current,next,value,12);}).catch(()=>{}).finally(()=>prefetches.current.delete(next));
  };
  useEffect(()=>()=>{for(const controller of prefetches.current.values())controller.abort();readerRequest.current?.abort();readerPrefetch.current?.controller.abort();},[]);
  useEffect(()=>{
    if(!active||paused||!listReady||committed.current===key)return;
    const cached=lruGet(pageCache.current,path);
    if(cached){resetPublicationCaches(cached.publicationRevision);committed.current=key;resetMore();setPage(cached);setBusy(false);setError('');prefetchNext(cached);return;}
    const controller=new AbortController();setBusy(true);setError('');setCountError('');
    void api<CatalogPage>(path,controller.signal).then(result=>{
      if(controller.signal.aborted)return;resetPublicationCaches(result.publicationRevision);lruSet(pageCache.current,path,result,12);
      committed.current=key;resetMore();setPage(result);setBusy(false);if(list.current)list.current.scrollTop=0;prefetchNext(result);
    }).catch(reason=>{if(!controller.signal.aborted){setError(catalogError(reason)||errorText(reason));setBusy(false);}});
    return()=>controller.abort();
  },[active,paused,key,path,query,listReady]);
  useEffect(()=>{
    if(!active||paused||!listReady||!page?.countToken||page.countStatus==='ready')return;
    const controller=new AbortController(),countToken=page.countToken;setCountError('');
    void api<{publicationRevision:string;totalCount:number}>(`/v1/mobile-catalog/count?${new URLSearchParams({token:countToken})}`,controller.signal).then(count=>{
      if(!controller.signal.aborted)setPage(current=>current?.countToken===countToken&&current.publicationRevision===count.publicationRevision?{...current,totalCount:count.totalCount,countStatus:'ready'}:current);
    }).catch(reason=>{if(!controller.signal.aborted){setCountError(catalogError(reason)||errorText(reason));setPage(current=>current?.countToken===countToken?{...current,countStatus:'unavailable'}:current);}});
    return()=>controller.abort();
  },[active,paused,page?.countToken,countRetry,listReady]);
  useEffect(()=>{
    // Settings is a modal over the catalog, so Back closes it first and leaves the
    // list, its scroll position and the open detail exactly as they were.
    backRef.current=()=>{if(sheet){setSheet(null);return true;}if(settings){setSettings(false);return true;}if(reader){closeReader();return true;}if(selected){setSelected(null);return true;}return false;};return()=>{backRef.current=null;};
  },[sheet,settings,reader,selected,backRef]);
  // Back from a work shows the list where it was, before the first paint.
  useLayoutEffect(()=>{if(!selected&&list.current)list.current.scrollTop=scroll.current;},[selected]);
  useEffect(()=>{
    if(!selected||!page?.context||!page.publicationRevision||!active||paused)return;
    const cacheKey=`${page.publicationRevision}:${filterKey}:${selected.provider}:${selected.providerWorkId}`,cached=lruGet(detailCache.current,cacheKey);
    if(cached){setDetail(cached);setDetailError('');return;}
    const controller=new AbortController();setDetail(null);setDetailError('');
    void api<{publicationRevision:string;item:CatalogDetail&{bookmarkRevision?:number}}>(catalogDetailPath(selected,page.context),controller.signal).then(result=>{if(!controller.signal.aborted&&result.publicationRevision===page.publicationRevision){lruSet(detailCache.current,cacheKey,result.item,48);setDetail(result.item);if(typeof result.item.bookmarkRevision==='number')bookmarks.observe(result.item.provider,result.item.providerWorkId,result.item.bookmarkRevision,result.item.bookmarked);}}).catch(reason=>{if(!controller.signal.aborted)setDetailError(catalogError(reason)||errorText(reason));});
    return()=>controller.abort();
  // Keyed by the work's identity, not the object: a bookmark toggle replaces `selected` with a
  // copy carrying the new mark, and that must not re-run the detail load under the open page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selectedKey,page?.context,page?.publicationRevision,active,paused,detailRefresh,filterKey]);
  useEffect(()=>{
    if(!selected||!page?.context||!page.publicationRevision||!active||paused)return;
    const requestPath=catalogEditionsPath(selected.groupId,page.context,editionCursor),cacheKey=`${page.publicationRevision}:${filterKey}:${requestPath}`,cached=lruGet(editionCache.current,cacheKey);
    if(cached){setEditions(cached);setEditionError('');return;}
    const controller=new AbortController();setEditionError('');
    void api<CatalogEditions>(requestPath,controller.signal).then(result=>{if(!controller.signal.aborted&&result.publicationRevision===page.publicationRevision){lruSet(editionCache.current,cacheKey,result,48);setEditions(result);}}).catch(reason=>{if(!controller.signal.aborted)setEditionError(catalogError(reason)||errorText(reason));});
    return()=>controller.abort();
  },[selected?.groupId,page?.context,page?.publicationRevision,editionCursor,active,paused,detailRefresh,filterKey]);
  useEffect(()=>{
    // The detail page is already open, so the reader manifest can be fetched while the
    // user decides. This is manifest-only: page bytes stay demand-driven. It waits for
    // the settled list identity so a request is not issued for a context that the
    // capability decision is about to invalidate.
    if(!active||paused||!listReady||!selected||!detail||!page?.context||!page.publicationRevision||reader)return;
    const owner=readerOwner,revision=page.publicationRevision,cacheKey=readerCacheKey(selected,revision,filterKey);
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
  // Identity keys, so a bookmark toggle (a new `selected`/`detail` copy) does not re-request it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[active,paused,listReady,selectedKey,!!detail,page?.context,page?.publicationRevision,reader,readerOwner,filterKey]);

  function closeReader(){readerRequest.current?.abort();readerRequest.current=null;setReaderBusy(false);setReader(null);}
  const loadReader=(force=false)=>{
    if(!active||paused||!selected||!page?.context||!page.publicationRevision)return;const owner=readerOwner;const cacheKey=readerCacheKey(selected,page.publicationRevision,filterKey);
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
    const project=(item:CatalogItem)=>item.groupId===groupId?{...item,bookmarked:item.providerWorkId===providerWorkId?desired:item.bookmarked,hasBookmarkedVersion:groupDesired(item)}:item;
    setPage(current=>current?{...current,items:current.items.map(project)}:current);
    setMore(current=>current?{...current,items:current.items.map(project)}:current);
    setSelected(current=>current&&current.provider===provider&&current.providerWorkId===providerWorkId?{...current,bookmarked:desired,hasBookmarkedVersion:groupDesired(current)}:current);
    setDetail(current=>current&&current.provider===provider&&current.providerWorkId===providerWorkId?{...current,bookmarked:desired}:current);
    setEditions(current=>current?{...current,items:current.items.map(item=>item.provider===provider&&item.providerWorkId===providerWorkId?{...item,bookmarked:desired}:item)}:current);
    pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();
  }
  function resetMore(){moreRequest.current?.abort();moreRequest.current=null;setMore(null);setMoreBusy(false);setMoreError('');}
  function change(next:Partial<CatalogQuery>){setQuery(current=>({...current,...next}));resetMore();setSelected(null);setReader(null);scroll.current=0;}
  // The 인기 sorts only cover works posted in the last day/week/month (as on the PC), so
  // a search under them misses almost every match. A search is shown newest first; the
  // browsing sort is set aside and comes back when the search is cleared.
  const [browseSort,setBrowseSort]=useState<CatalogQuery['sort']|null>(null);
  function search(text:string){
    const searching=text.trim()!=='';
    if(searching&&browseSort===null){setBrowseSort(query.sort);change({text,sort:'latest'});}
    else if(!searching&&browseSort!==null){setBrowseSort(null);change(query.scope==='all'?{text,sort:browseSort}:{text});}
    else change({text});
  }
  function chooseSuggestion(option:CatalogSuggestion){
    const text=suggestionQuery(option.value);
    setDraft(text);setSuggestOpen(false);setOptions([]);setActiveOption(-1);search(text);searchInput.current?.blur();
  }
  function suggestionKey(event:React.KeyboardEvent<HTMLInputElement>){
    if(!listboxOpen)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();const step=event.key==='ArrowDown'?1:-1;
      // Past either end returns to the typed text, as on the PC.
      setActiveOption(current=>{const next=current+step;return next>=options.length?-1:next<-1?options.length-1:next;});
    }else if(event.key==='Enter'&&activeOption>=0&&options[activeOption]){event.preventDefault();chooseSuggestion(options[activeOption]);}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setSuggestOpen(false);setActiveOption(-1);}
  }
  /** Append the next cursor page. A different publication restarts the list from the top. */
  const nextCursor=more?more.nextCursor:page?.nextCursor??null;
  function loadMore(){
    if(!active||paused||!listReady||!page?.ready||!nextCursor||moreRequest.current||busy||committed.current!==key||moreError)return;
    const revision=page.publicationRevision,owner=key,requestPath=catalogPath(query,nextCursor,{searchMode});
    const accept=(result:CatalogPage)=>{
      if(result.publicationRevision!==revision){
        // Restart once per newer publication; a server that keeps answering the first
        // page from the older one must not make the list reload forever.
        if(restartedFor.current===result.publicationRevision){setMoreError('목록이 갱신되었습니다. 당겨서 새로고침해 주세요.');return;}
        restartedFor.current=result.publicationRevision;reload();return;
      }
      lruSet(pageCache.current,requestPath,result,12);
      setMore(current=>({items:[...(current?.items??[]),...result.items],nextCursor:result.nextCursor}));prefetchNext(result);
    };
    const cached=lruGet(pageCache.current,requestPath);if(cached){accept(cached);return;}
    const controller=new AbortController();moreRequest.current=controller;setMoreBusy(true);setMoreError('');
    void api<CatalogPage>(requestPath,controller.signal).then(result=>{if(!controller.signal.aborted&&committed.current===owner)accept(result);})
      .catch(reason=>{if(!controller.signal.aborted)setMoreError(catalogError(reason)||errorText(reason));})
      .finally(()=>{if(moreRequest.current===controller){moreRequest.current=null;setMoreBusy(false);}});
  }
  /**
   * Commit the panel's setting.
   *
   * An unchanged setting is not a filter change: applying it again must leave the
   * cursor, the displayed page and the scroll position exactly as they were. Only a
   * real change resets the list, and only then are the page/detail/edition/reader
   * caches cleared, because a response fetched under the wider filter could
   * otherwise be shown for the narrower one. The unsent search draft is untouched.
   */
  function applyPreferences(next:CatalogPreferences,revealBlocked=query.revealBlocked){
    setSettings(false);
    const unchanged=JSON.stringify(preferences)===JSON.stringify(next);
    if(unchanged){if(revealBlocked!==query.revealBlocked)change({revealBlocked});return;}
    setPreferences(next);
    writeCatalogPreferences(endpoint,next);
    reload();setPage(null);setDetail(null);setEditions(null);
    change({categories:next.categories,excludedTags:next.excludedTags,revealBlocked});
  }
  function resetPreferences(){
    clearCatalogPreferences(endpoint);
    setPreferences({...DEFAULT_CATALOG_PREFERENCES});
    setSettings(false);
    setPreferenceCheck(value=>value+1);
    reload();setPage(null);setDetail(null);setEditions(null);
    change({categories:null,excludedTags:[]});
  }
  function openSettings(){setSettings(true);}
  function open(item:CatalogItem){scroll.current=list.current?.scrollTop??0;setSelected(item);setEditionCursor(null);setEditions(null);setReader(null);setReaderError('');}
  function refreshBookmarks(){for(const controller of prefetches.current.values())controller.abort();prefetches.current.clear();pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();committed.current='';setRefresh(n=>n+1);if(selected)setDetailRefresh(n=>n+1);}
  function reload(){for(const controller of prefetches.current.values())controller.abort();prefetches.current.clear();pageCache.current.clear();detailCache.current.clear();editionCache.current.clear();readerCache.current.clear();committed.current='';resetMore();setSelected(null);setReader(null);setRefresh(n=>n+1);}
  // The endpoint identifies the server whose filters these are, so a different
  // server must never inherit them. The capability decision belongs to one server
  // too, so it returns to `checking` for the new endpoint.
  const endpointRef=useRef(endpoint);
  useEffect(()=>{
    if(endpointRef.current===endpoint)return;endpointRef.current=endpoint;
    setCapability('checking');setSuggestable(false);
    const stored=readCatalogPreferences(endpoint);
    setPreferences(stored);
    setQuery(current=>({...current,categories:stored.categories,excludedTags:stored.excludedTags}));
    reload();
    // `reload` only touches refs and setters, so it needs no dependency entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[endpoint]);

  const refreshState=useCatalogRefresh({supported:refreshSupported,active:active&&!paused&&!selected&&!!page?.ready,language:query.language,publication:page?.publicationRevision??null,endpoint,onPublished:reload});
  const now=useNow(active&&!paused);
  const listPull=usePullToRefresh(list,reload,busy,!active||paused||!!selected||!!reader);
  const items=(()=>{const seen=new Set<string>(),all:CatalogItem[]=[];for(const item of [...(page?.items??[]),...(more?.items??[])]){const id=`${item.provider}:${item.groupId}`;if(!seen.has(id)){seen.add(id);all.push(item);}}return all;})();
  // Saved 회피 태그 are the user's default, so they keep the chip neutral; only a narrowed
  // category set or the blocked switch differs from that default and lights the chip.
  const filterCount=(preferences.categories!==null?1:0)+(query.revealBlocked?1:0);
  const defaultTags=preferences.excludedTags.length;
  const nearEnd=(element:HTMLElement)=>element.scrollTop+element.clientHeight>=element.scrollHeight-600;
  // A first page shorter than the screen cannot be scrolled, so it asks for the next page itself.
  useEffect(()=>{if(!selected&&list.current&&page?.ready&&nextCursor&&nearEnd(list.current))loadMore();});
  useEffect(()=>{if(!selected)setBackdrop(null);},[selected]);
  const LANGUAGES:Record<CatalogQuery['language'],string>={korean:'한국어',japanese:'일본어',all:'전체 언어'};
  const SORTS:Record<CatalogQuery['sort'],string>={latest:'최신순',views:'조회순',hotDay:'오늘 인기',hotWeek:'이번 주 인기',hotMonth:'이번 달 인기'};
  const bookmarkScope=query.scope==='bookmarked';
  const revision=page?.publicationRevision??'0'.repeat(64);

  useLevelMotion(section,active?(selected?'detail':'list'):null,selected?1:0);
  // Search lives in the shared bar: the magnifier opens it, and it stays open while a query is set.
  const searching=searchOpen||!!draft||!!query.text;
  const closeSearch=()=>{setSuggestOpen(false);setSearchOpen(false);setDraft('');if(query.text)search('');};
  const searchForm=<>
        <form className="top-bar__search catalog-search" role="search" onSubmit={event=>{event.preventDefault();setSuggestOpen(false);search(draft);(document.activeElement as HTMLElement|null)?.blur();}}>
          <MagnifyingGlassIcon aria-hidden="true"/><input ref={searchInput} autoFocus={searchOpen} aria-label="카탈로그 검색" enterKeyHint="search" value={draft} onChange={event=>{setDraft(event.target.value);setSuggestOpen(true);}} onKeyDown={suggestionKey} onBlur={()=>{setSuggestOpen(false);setActiveOption(-1);}} placeholder="제목, 작가, 태그 검색" autoComplete="off"
            {...(suggestions?{role:'combobox','aria-autocomplete':'list' as const,'aria-expanded':listboxOpen,'aria-controls':'catalog-suggestions','aria-activedescendant':listboxOpen&&activeOption>=0?`catalog-suggestion-${activeOption}`:undefined}:{})}/>
          {draft&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={()=>{setDraft('');if(query.text)search('');}}/>}
          {listboxOpen&&<ul ref={suggestionList} id="catalog-suggestions" className="catalog-suggestions" role="listbox" aria-label="태그 추천">{options.map((option,index)=><li key={option.value} id={`catalog-suggestion-${index}`} role="option" aria-selected={index===activeOption} className="catalog-suggestion" onMouseDown={event=>event.preventDefault()} onClick={()=>chooseSuggestion(option)}><span className="catalog-suggestion__value">{option.value}</span>{option.label&&option.label!==option.value&&<span className="catalog-suggestion__label">{option.label}</span>}{typeof option.count==='number'&&<span className="catalog-suggestion__count numeric">{option.count.toLocaleString()}</span>}</li>)}</ul>}
        </form>
  </>;
  return <section ref={section} className="mobile-catalog" style={{display:active?'flex':'none'}} aria-label="만화 카탈로그">
    <div className="catalog-content" style={{display:selected?'none':undefined}}>
      {searching?<TopBarSearch title="카탈로그" onClose={closeSearch}>{searchForm}</TopBarSearch>
      :<TopBar title={<>카탈로그{page?.countStatus==='ready'&&page.totalCount!=null&&<span className="numeric muted catalog-total">{page.totalCount.toLocaleString()}</span>}</>}
        actions={<>{!selected&&<CatalogRefreshControl state={refreshState} publishedAt={page?.publishedAt} now={now} onReload={reload} reloadBusy={busy}/>}<SearchButton onClick={()=>setSearchOpen(true)}/></>}/>}
      <div ref={list} className="catalog-scroll" onScroll={event=>{scroll.current=event.currentTarget.scrollTop;if(nearEnd(event.currentTarget))loadMore();}}>
        {listPull}
        <CatalogRefreshBanner state={refreshState}/>
        <div className="filter-chips catalog-chips" role="group" aria-label="카탈로그 보기">
          <button className="filter-chip" aria-haspopup="dialog" aria-label={`카탈로그 언어 ${LANGUAGES[query.language]}`} onClick={()=>setSheet('language')}>{LANGUAGES[query.language]}<ChevronDownIcon aria-hidden="true"/></button>
          <button className="filter-chip" aria-haspopup="dialog" aria-label={`카탈로그 정렬 ${bookmarkScope?'최신순':SORTS[query.sort]}`} disabled={bookmarkScope} onClick={()=>setSheet('sort')}>{bookmarkScope?'최신순':SORTS[query.sort]}<ChevronDownIcon aria-hidden="true"/></button>
          <button className={`filter-chip ${bookmarkScope?'selected':''}`} aria-pressed={bookmarkScope} onClick={()=>change(bookmarkScope?{scope:'all'}:{scope:'bookmarked',sort:'latest'})}><BookmarkIcon aria-hidden="true"/>북마크</button>
          <button className={`filter-chip ${filterCount?'selected':''}`} aria-haspopup="dialog" aria-label={filterCount?`필터 ${filterCount}개 적용`:defaultTags?`필터, 기본 회피 태그 ${defaultTags}개`:'필터'} disabled={!active} onClick={openSettings}><FunnelIcon aria-hidden="true"/>필터{filterCount>0?<span className="catalog-chip-count numeric">{filterCount}</span>:defaultTags>0&&<span className="filter-chip__default">기본</span>}</button>
        </div>
        {browseSort!==null&&browseSort!=='latest'&&query.sort==='latest'&&!bookmarkScope&&<p className="catalog-search-note muted" style={{margin:'0 0 8px',fontSize:12}}>검색 중에는 최신순으로 표시합니다</p>}
        {busy&&<div className="loading-line" role="status" aria-label="카탈로그 불러오는 중"/>}{error&&<div className="inline-error" role="alert">{error}<Button onClick={()=>{committed.current='';setRefresh(n=>n+1);}}>다시 시도</Button></div>}{countError&&<div className="catalog-count-error">개수를 확인하지 못했습니다.<Button size="sm" variant="ghost" onClick={()=>setCountRetry(n=>n+1)}>다시 시도</Button></div>}
        {wireIssue!=='none'?<div className="empty-state"><h2>검색 조건이 너무 깁니다</h2><p>{wireIssue==='filterTooLarge'?`회피 태그와 분류를 합쳐 ${FILTER_JSON_MAX_BYTES}바이트까지 보낼 수 있습니다.`:'검색어와 회피 태그를 합친 요청이 너무 깁니다. 검색어를 줄여 주세요.'}</p><Button onClick={openSettings}>필터 열기</Button></div>:capability==='checking'?<div className="empty-state" role="status"><h2>카탈로그를 준비하는 중입니다</h2></div>:capability==='failed'?<div className="empty-state"><h2>서버 상태를 확인하지 못했습니다</h2><p>연결을 확인한 뒤 다시 시도해 주세요.</p><Button onClick={()=>{setCapability('checking');setCapabilityRetry(n=>n+1);}}>다시 시도</Button></div>:preferencesBlocked?<div className="empty-state"><h2>이 기기의 설정을 쓸 수 없습니다</h2><p>서버 업데이트 후에는 저장된 회피 태그가 그대로 적용됩니다. 기다리는 동안 설정을 지우면 필터 없이 볼 수 있습니다.</p><Button onClick={resetPreferences}>설정 지우고 계속</Button></div>:page?.ready===false?<div className="empty-state"><BookOpenIcon/><h2>카탈로그가 아직 공유되지 않았습니다</h2><p>PC 설정의 온라인 카탈로그에서 모바일에 게시해 주세요.</p></div>:page?.ready&&<>{items.length?<div className="catalog-grid">{items.map(item=>{const state=visibleGroupBookmark(item);return <button className="catalog-card" disabled={busy||committed.current!==key} key={`${item.provider}:${item.groupId}`} onClick={()=>open(item)}><div className="catalog-cover"><CatalogCover item={item} revision={revision} active={active&&!paused&&!selected&&!reader}/><span className="catalog-cover-pages numeric">{item.fileCount}p</span>{item.versionCount>1&&<span className="catalog-cover-versions">판본 {item.versionCount}</span>}{state.desired&&<BookmarkSolidIcon className={`catalog-saved${state.pending?' catalog-saved--pending':''}`} aria-label={state.pending?'북마크 저장 대기':'북마크됨'}/>}</div><strong aria-description={catalogDisplayTitle(item.title)!==item.title?item.title:undefined}>{catalogDisplayTitle(item.title)}</strong><span>{item.artists.join(' · ')||'작가 미상'}</span></button>;})}</div>:<div className="empty-state"><h2>검색 결과가 없습니다</h2><p>검색어나 필터를 바꿔 보세요.</p></div>}
          {moreBusy&&<p className="hint catalog-more-status" role="status">더 불러오는 중…</p>}
          {moreError&&<div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" onClick={()=>{setMoreError('');window.setTimeout(loadMore);}}>다시 시도</Button></div>}
          {items.length>0&&!nextCursor&&!moreBusy&&<p className="hint catalog-more-status">마지막 작품입니다</p>}</>}
      </div>
    </div>
    {selected&&<div className="catalog-detail">
      <header className="catalog-top is-over"><IconButton label="카탈로그 목록으로" icon={ArrowLeftIcon} onClick={()=>setSelected(null)}/></header>
      {backdrop&&<div className="catalog-backdrop" aria-hidden="true"><img src={backdrop} alt=""/></div>}
      {detailError?<div role="alert" className="inline-error">{detailError}<Button onClick={()=>setDetailRefresh(n=>n+1)}>다시 시도</Button></div>:!detail?<p role="status" className="hint catalog-detail-status">작품을 불러오는 중…</p>:<>
        <div className="catalog-detail-intro"><div className="catalog-detail-cover"><CatalogCover item={{...selected,thumbnailUrl:detail.thumbnailUrl}} revision={revision} active={active&&!paused&&!reader} onUrl={setBackdrop}/></div>
          <div className="catalog-detail-identity"><h2>{catalogDisplayTitle(detail.title)}</h2>{catalogDisplayTitle(detail.title)!==detail.title&&<p className="catalog-detail-alt"><span className="sr-only">원제 </span>{detail.title}</p>}{detail.titleJpn&&detail.titleJpn!==detail.title&&<p className="catalog-detail-alt">{detail.titleJpn}</p>}{selected.artists.length>0&&<p className="catalog-detail-credit">{selected.artists.join(' · ')}</p>}<p className="catalog-detail-facts">{detail.fileCount}페이지 · 조회 {detail.views.toLocaleString()}</p></div></div>
        {(()=>{const state=bookmarks.stateFor(detail.provider,detail.providerWorkId,detail.bookmarked,detail.bookmarkRevision);const MarkIcon=state.desired?BookmarkSolidIcon:BookmarkIcon;return <><div className="catalog-primary-actions"><Button variant="primary" className="catalog-read-action" disabled={readerBusy} onClick={()=>loadReader(false)}><BookOpenIcon/>{readerBusy?'페이지 확인 중…':'읽기'}</Button><Button className="catalog-bookmark-action" aria-label={state.pending?state.desired?'북마크 저장 중':'북마크 해제 중':state.desired?'북마크 해제':'북마크'} aria-pressed={state.desired} disabled={!authority&&!state.pending} onClick={()=>{const desired=!state.desired;bookmarks.toggle(detail.provider,detail.providerWorkId,desired);applyBookmarkPresentation(detail.provider,detail.providerWorkId,desired);}}><MarkIcon className={state.pending?'catalog-bookmark-pending':undefined}/><span className="catalog-bookmark-label">{state.desired?'북마크됨':'북마크'}</span></Button></div>{/* One status line that always keeps its height, so 저장 대기 and a failure never push the page. */}<span className={`catalog-bookmark-state${bookmarks.failure?' catalog-bookmark-error':''}`} role={bookmarks.failure?'alert':'status'}>{bookmarks.failure||(state.pending?'저장 대기':'')}</span></>;})()}{readerError&&<p className="catalog-reader-error">{readerError}</p>}
      </>}
      <section className="catalog-editions" aria-label="카탈로그 판본"><h3>판본{editions?<span className="numeric muted"> {editions.totalCount}</span>:''}</h3>{editionError?<div role="alert">{editionError}<Button onClick={()=>setDetailRefresh(n=>n+1)}>다시 시도</Button></div>:<div className="catalog-edition-row">{editions?.items.map(item=>{const state=visibleEditionBookmark(item);return <button key={item.providerWorkId} className="catalog-edition" aria-current={detail?.providerWorkId===item.providerWorkId?'true':undefined} onClick={()=>setSelected(current=>current?{...current,...item}:current)}><div className="catalog-cover"><CatalogCover item={{...selected,...item}} revision={revision} active={active&&!paused&&!reader}/></div><span>{catalogDisplayTitle(item.title)}</span><small>{item.fileCount}p{state.desired?' · 북마크':''}{state.pending?' · 저장 대기':''}</small></button>;})}</div>}{(editionCursor||editions?.nextCursor)&&<div className="catalog-edition-paging">{editionCursor&&<Button variant="ghost" onClick={()=>setEditionCursor(null)}>처음 판본</Button>}{editions?.nextCursor&&<Button variant="ghost" onClick={()=>setEditionCursor(editions.nextCursor)}>다음 판본</Button>}</div>}</section>
      {detail&&detail.tagGroups.length>0&&<section className="catalog-tags" aria-label="태그"><h3>태그</h3><dl>{detail.tagGroups.map(group=><div key={group.namespace}><dt>{group.namespace}</dt><dd>{group.values.map(value=><button key={value} className="catalog-tag" onClick={()=>{const text=catalogTagQuery(group.namespace,value);setDraft(text);search(text);}}>{group.labels?.[value]??value}</button>)}</dd></div>)}</dl><p className="hint">태그를 누르면 같은 태그로 검색합니다.</p></section>}
    </div>}
    {reader&&selected&&<CatalogReader manifest={reader} title={catalogDisplayTitle(detail?.title??selected.title)} onClose={closeReader} onRefresh={()=>loadReader(true)} refreshing={readerBusy}/>}
    {sheet==='language'&&<BottomSheet title="언어" onClose={()=>setSheet(null)}><div role="radiogroup" aria-label="카탈로그 언어">{(Object.keys(LANGUAGES) as CatalogQuery['language'][]).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={query.language===value} onClick={()=>{setSheet(null);if(query.language!==value)change({language:value});}}>{LANGUAGES[value]}<span className="radio-dot"/></button>)}</div></BottomSheet>}
    {sheet==='sort'&&<BottomSheet title="정렬" onClose={()=>setSheet(null)}><div role="radiogroup" aria-label="카탈로그 정렬">{(Object.keys(SORTS) as CatalogQuery['sort'][]).map(value=><button key={value} className="sheet-option" role="radio" aria-checked={query.sort===value} onClick={()=>{setSheet(null);if(query.sort!==value)change({sort:value});}}>{SORTS[value]}<span className="radio-dot"/></button>)}</div></BottomSheet>}
    <CatalogSettings key={preferenceCheck} open={settings} preferences={preferences} revealBlocked={query.revealBlocked} capability={capability} onClose={()=>setSettings(false)} onApply={applyPreferences} onReset={resetPreferences}/>
  </section>;
}
