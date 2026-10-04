import {LoadingLine} from './TopBar';
import {useTabletAssetMask} from './assetMask';
import type {ContentRating} from '../src/shared/privacy/contentMask';
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {usePrivacyMode} from './privacyMode';
import {assetSearchSelectionKey,type AssetSearchName} from '../src/assets/assetSearch';
import {invalidSearchChoices} from './assetSearchModel';
import type {LibraryCrumb} from './LibraryHeader';
import {FilterChips,type FilterGroup} from './FilterChips';
import {usePublicationCheck} from './usePublicationCheck';
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type MutableRefObject,type ReactNode} from 'react';
import {ArrowLeftIcon,ChevronUpIcon,InformationCircleIcon,PhotoIcon,Squares2X2Icon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {BarProgress,SearchButton} from './TopBar';
import {useSectionShade} from './SectionShade';
import {Button,IconButton,SegmentedControl} from './ui';
import {api,errorText} from './transport';
import {loadThumbnail} from './media';
import {StableImage} from '../src/shared/ui/StableImage';
import {readyFirstScreen} from './firstScreen';
import {Gallery} from './Gallery';
import {readScopedToc, readyScopedAsset, useScopedAssetToc, withScopedToc} from './scopedAssetToc';
import {pagePath,RequestGate} from './model';
import type {Asset,AssetFiltersValue,AssetMediaFilter} from './types';
import {ASSET_FILTER_VERSION,EMPTY_FILTERS,MEDIA_SECTIONS,filterKey,filterVersionOf,hasActiveFilters,sameFilters} from './assetFilters';
import {characterChildren,characterExclusion,characterExclusionTarget,characterPath,validCharacterIndex,type CharacterFilter,type CharacterIndex,type CharacterNode,type CharacterPage} from './characterModel';
import {FolderShelf} from './FolderCards';
import {FolderIcon,PeopleIcon,PersonIcon} from '../src/shared/ui/ArchiveIcons';
import {useLevelMotion} from './motion';
import './characters.css';

/**
 * A location is a scope plus its filters.
 *
 * Folding the filters into the location rather than keeping them beside it is what makes
 * the existing scope cache correct for free: the cache key already includes the whole
 * location, so two filter sets cannot collide, and Back and drill-down keep working on
 * the same value they always did.
 */
type Location={search?:readonly AssetSearchName[];node:string|null;filter:CharacterFilter;filters:AssetFiltersValue};
type Cached={page:CharacterPage;scroll:number};
const ROOT:Location={node:null,filter:'all',filters:{...EMPTY_FILTERS}};
/** The series filters the mobile app offers; 추가 확인 (needs_review) stays a server scope only. */
const SERIES_FILTERS:CharacterFilter[]=['unclassified','all'];
/**
 * A series opens on 미분류 (the images still waiting for a character); every other scope has
 * only 전체. Node ids carry their kind (`series:<id>`), so this works before the index loads.
 */
export function defaultCharacterFilter(node:string|null,index?:CharacterIndex):CharacterFilter {
  const kind=index?.nodes.find(item=>item.id===node)?.kind??(node?.startsWith('series:')?'series':undefined);
  return kind==='series'?'unclassified':'all';
}

/** The character context a character gallery hands to its viewer, or null for any other scope. */
export function viewerCharacterContext(node:CharacterNode|undefined|null,index:CharacterIndex|undefined) {
  const target=characterExclusionTarget(node);
  const capability=characterExclusion(index);
  if(!target||!capability||!Array.isArray(target.protectedAssetIds)||!target.protectedAssetIds.every(id=>typeof id==='string'))return null;
  return {targetId:target.sourceId,name:target.name,libraryId:capability.libraryId,revision:capability.revision,protectedAssetIds:target.protectedAssetIds};
}

const resolvedPreviews=new Map<string,string>();
function rememberPreview(id:string,preview:string) {
  resolvedPreviews.delete(id);resolvedPreviews.set(id,preview);
  while(resolvedPreviews.size>128)resolvedPreviews.delete(resolvedPreviews.keys().next().value!);
}
function Preview({id,paused,label='',rating}:{id?:string|null;paused:boolean;label?:string;rating?:ContentRating|null}) {
  const masked=useTabletAssetMask({contentRating:rating});
  const [loaded,setLoaded]=useState<{id:string;preview?:string}>();
  const cached=id?resolvedPreviews.get(id):undefined;
  const preview=cached??(loaded?.id===id?loaded?.preview:undefined);
  useEffect(()=>{
    if(!id||masked)return;
    if(cached){rememberPreview(id,cached);if(loaded?.id!==id||loaded.preview!==cached)setLoaded({id,preview:cached});return;}
    if(paused||loaded?.id===id&&loaded.preview)return;
    const controller=new AbortController();
    void loadThumbnail({id,kind:'image',contentRating:rating},controller.signal).then(a=>{if(!controller.signal.aborted&&a.preview){rememberPreview(id,a.preview);setLoaded({id,preview:a.preview});}},()=>{});
    return()=>controller.abort();
  },[id,paused,cached,loaded,masked,rating]);
  return masked?<span className="privacy-mask" aria-label="이미지 숨김"/>:preview?<StableImage key={id} src={preview} alt={label}/>:<PhotoIcon aria-hidden="true"/>;
}
function Card({node,count,paused,onSelect,previews=[],lazy=false,ratings}:{node:CharacterNode;count?:number;paused:boolean;onSelect():void;previews?:string[];lazy?:boolean;ratings?:CharacterIndex["contentRatings"]}) {
  const host=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(!lazy);
  useEffect(()=>{
    if(!lazy||!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);return;}
    // The strip can contain every folder, but only nearby covers enter the media queue.
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{root:host.current.parentElement,rootMargin:'0px 120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[lazy]);
  const previewPaused=paused||(lazy&&!visible);
  return <button ref={host} type="button" className="folder-shelf__card-open character-card" data-kind={node.kind} onClick={onSelect} aria-label={`${node.name}${count===undefined?'':` · ${count}장`}`}>
    <span className={`character-card-image${node.kind==='group'?' character-mosaic':''}`} data-count={previews.length}>
      {node.kind==='group'&&previews.length?previews.map(id=><span key={id}><Preview id={id} rating={ratings?.[id]} paused={previewPaused}/></span>):node.thumbnailAssetId?<Preview id={node.thumbnailAssetId} rating={ratings?.[node.thumbnailAssetId]} paused={previewPaused}/>:node.kind==='folder'?<FolderIcon/>:<PhotoIcon/>}
    </span>
    <span className="character-card-caption"><strong>{node.kind==='group'||node.kind==='series'?<PeopleIcon/>:node.kind==='folder'?<FolderIcon/>:<PersonIcon/>}<span className="folder-shelf__name">{node.name}</span></strong>{count!==undefined&&<small className="folder-shelf__meta">{count.toLocaleString('ko-KR')}장</small>}</span>
    {node.excluded&&<small className="character-card__status">자동 분류 제외</small>}
  </button>;
}

export function CharacterBrowser({search,onSearch,onInvalidSearch,scopeChips,hostBusy=false,entryKey=0,onOptions=()=>{},onLocation,initialNode,active,paused,density,refreshKey,onOpen,backRef,onExit}:{search?:readonly AssetSearchName[];onSearch?():void;onInvalidSearch?(chips:AssetSearchName[]):void;scopeChips?:ReactNode;/** The host's own load of this scope (the list generation read), shown in the same bar slot. */hostBusy?:boolean;/** Kept for character-local view options supplied by the host; asset filters are rendered in the top bar. */optionsHost?:HTMLElement|null;onCloseOptions?():void;entryKey?:number;crumbs?:LibraryCrumb[];onOptions?(scopeItems:Asset[]):void;onLocation?(id:string|null):void;initialNode?:string;active:boolean;paused:boolean;density:number;refreshKey:number;onOpen(items:Asset[],index:number,character?:import('./Viewer').ViewerCharacterContext|null):void;backRef:MutableRefObject<(()=>boolean)|null>;onExit():void}) {
  const [privacy]=usePrivacyMode();
  const [landscape,setLandscape]=useState(()=>window.matchMedia?.('(orientation: landscape) and (min-width: 900px)').matches??false);
  useEffect(()=>{const media=window.matchMedia?.('(orientation: landscape) and (min-width: 900px)');if(!media)return;const change=()=>setLandscape(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  const [index,setIndex]=useState<CharacterIndex>();
  const [where,setWhere]=useState<Location>(ROOT);
  useEffect(()=>{onLocation?.(where.node);},[where.node,onLocation]);
  const [page,setPage]=useState<CharacterPage>();
  // The scope and filters the visible page was actually fetched under. It is set only when a
  // page commits, so a failed narrowing leaves it describing the page still on screen. That is
  // what lets an append use the right filters instead of the ones that never applied.
  const [committed,setCommitted]=useState<Location|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[moreError,setMoreError]=useState('');
  const [more,setMore]=useState(false);
  const [foldersCollapsed,setFoldersCollapsed]=useState(false);
  const folderStripId=useId();
  const [restore,setRestore]=useState(0);
  const [retry,setRetry]=useState(0);
  const host=useRef<HTMLDivElement>(null),scroll=useRef(0);
  const indexGate=useRef(new RequestGate()),pageGate=useRef(new RequestGate()),moreGate=useRef(new RequestGate());
  const cache=useRef(new Map<string,Cached>()),morePending=useRef(false);
  const [filtersOpen,setFiltersOpen]=useState<FilterGroup|null>(null),[filterHelpOpen,setFilterHelpOpen]=useState(false);
  const latest=useRef({index,where,page,active,paused,committed,filtersOpen,onInvalidSearch});latest.current={index,where,page,active,paused,committed,filtersOpen,onInvalidSearch};
  // The filter set is part of the location, so it is already part of this key.
  const key=(revision:string,location:Location)=>`${revision}:${location.node}:${location.filter}:${filterKey(location.filters)}:${assetSearchSelectionKey(location.search)}`;
  const remember=useCallback(()=>{
    const s=latest.current;
    if(s.index?.revision&&s.page&&s.committed?.node){
      const k=key(s.index.revision,s.committed);cache.current.delete(k);cache.current.set(k,{page:s.page,scroll:scroll.current});
      while(cache.current.size>6)cache.current.delete(cache.current.keys().next().value!);
    }
  },[]);
  const navigate=useCallback((next:Location)=>{
    remember();pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;
    setRestore(0);scroll.current=0;
    setPage(undefined);setCommitted(null);setError('');setMoreError('');setMore(false);setWhere(next);
  },[remember]);
  /**
   * Commit one filter change inside the current scope.
   *
   * Keep the prior committed page until replacement succeeds. `drilled` is untouched:
   * narrowing contents is not a hierarchy navigation step.
   */
  const applyFilters=useCallback((next:AssetFiltersValue)=>{
    setFiltersOpen(null);
    const current=latest.current.where;
    if(sameFilters(next,current.filters))return;
    // Unlike a scope change, narrowing the scope already displayed keeps the committed page on
    // screen until the replacement succeeds: the scope is unchanged, so the old page is still a
    // truthful answer for this view, and discarding it would blank the gallery for the duration
    // of every filter request and again on failure. Nothing is cached here either — caching the
    // page still on screen under the new filter key would hand it back as this filter's result.
    pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;
    setError('');setMoreError('');setMore(false);setWhere({...current,filters:next});
  },[]);
  const applyMedia=useCallback((media:AssetMediaFilter)=>{
    const current=latest.current.where;
    const next=media==='images'?{...current.filters,media,duration:'all' as const}:{...current.filters,media};
    applyFilters(next);
  },[applyFilters]);
  const applyCharacterFilter=useCallback((filter:CharacterFilter)=>{
    const current=latest.current.where;
    if(current.filter===filter)return;
    // The series scope stays mounted while its page is replaced. This is the character-folder
    // equivalent of the PC pageScope rule: a filter switch is not hierarchy navigation.
    pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;
    setError('');setMoreError('');setMore(false);setWhere({...current,filter});
  },[]);
  const appliedInitialNode=useRef<string|undefined>(undefined);
  const appliedEntryKey=useRef(entryKey);
  // True once the user walks down the hierarchy from within the browser. This is tracked as
  // its own flag rather than by comparing `where.node` against the applied direct entry: the
  // entry effect updates its ref eagerly while `where` commits later, so comparing the two
  // reported a drill-down for a folder that had just been opened and wrongly consumed Back.
  const drilled=useRef(false);
  // Before paint, so an entry never shows a frame of the previous folder's header or shelf.
  useLayoutEffect(()=>{if(active&&initialNode&&(appliedInitialNode.current!==initialNode||appliedEntryKey.current!==entryKey)){appliedEntryKey.current=entryKey;appliedInitialNode.current=initialNode;drilled.current=false;navigate({node:initialNode,filter:defaultCharacterFilter(initialNode,latest.current.index),filters:{...EMPTY_FILTERS},search});}},[initialNode,entryKey,active,navigate,search]);
  useEffect(()=>{
    if(!active||assetSearchSelectionKey(search)===assetSearchSelectionKey(latest.current.where.search))return;
    pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;setMore(false);
    setWhere(current=>({...current,search}));
  },[active,search]);
  // Changing a filter in the entry folder does not create a parent navigation step, and
  // entering a different child or moving between Series filters is a different scope, so
  // the filters start empty rather than carrying the previous scope's narrowing into it.
  const enterInside=useCallback((next:{node:string|null;filter:CharacterFilter})=>{
    if(next.node!==latest.current.where.node)drilled.current=true;
    navigate({...next,filters:{...EMPTY_FILTERS},search:latest.current.where.search});
  },[navigate]);
  usePublicationCheck(active&&!paused,'/v1/library/characters/status',index?.revision,(_reply,changed)=>{if(changed)setRetry(n=>n+1);});
  useEffect(()=>{
    backRef.current=()=>{
      const s=latest.current;
      if(s.filtersOpen){setFiltersOpen(null);return true;}
      if(hasActiveFilters(s.where.filters)){applyFilters({...EMPTY_FILTERS});return true;}
      if(!s.where.node)return false;
      // Resetting also returns a series from 전체 이미지 to its default 미분류 before leaving.
      const home=defaultCharacterFilter(s.where.node,s.index);
      if(s.where.filter!==home){applyCharacterFilter(home);return true;}
      // A folder opened directly from the index is a top-level entry, not an in-browser
      // drill-down. Consuming Back there would strand the user on the bare series
      // overview, so decline it and let the host restore the actual prior context.
      if(!drilled.current)return false;
      const node=s.index?.nodes.find(n=>n.id===s.where.node);
      const parent=node?.parentId??null;
      if(!parent&&appliedInitialNode.current)return false;
      // Stepping back up to the folder this boundary was opened with ends the drill-down, so
      // the next Back leaves the boundary instead of walking into a synthetic series parent.
      if(!parent||parent===appliedInitialNode.current)drilled.current=false;
      // Stepping up keeps the scope filters: the parent folder is the same kind of scope as
      // the child, so carrying the filter set lets the user keep narrowing while walking up.
      navigate({node:parent,filter:defaultCharacterFilter(parent,s.index),filters:s.where.filters,search:s.where.search});return true;
    };
    return()=>{backRef.current=null;};
  },[backRef,navigate,applyFilters,applyCharacterFilter]);
  // The header arrow means "leave this folder", not a global Back press: it steps up one
  // level inside the browser, or hands the direct entry back to the host so the host can
  // restore the prior context without closing an unrelated open surface.
  const goUp=()=>{if(backRef.current?.())return;onExit();};
  useEffect(()=>{
    if(!active)return;
    const request=indexGate.current.begin();setBusy(true);setError('');
    pageGate.current.cancel();moreGate.current.cancel();morePending.current=false;setMore(false);
    void api<CharacterIndex>('/v1/library/characters',request.signal).then(result=>{
      if(!indexGate.current.current(request.id))return;
      if(!validCharacterIndex(result))throw new Error('캐릭터 보기를 지원하는 앱과 서버가 필요합니다.');
      // Technical metadata may change without a new membership publication.
      // A host refresh must not restore an old page solely because revision is unchanged.
      cache.current.clear();
      setIndex({...result});
      if(latest.current.where.node&&!result.nodes.some(n=>n.id===latest.current.where.node)){setPage(undefined);setWhere(ROOT);scroll.current=0;setRestore(0);}
    }).catch(reason=>{if(indexGate.current.current(request.id))setError((reason as {status?:number}).status===404?'서버에 캐릭터 보기 업데이트가 필요합니다.':errorText(reason));})
      .finally(()=>{if(indexGate.current.current(request.id))setBusy(false);});
    return()=>indexGate.current.cancel();
  },[active,refreshKey,retry,remember]);
  const recoverSearch=async(location:Location,reason:unknown,signal:AbortSignal)=>{
    if((reason as {status?:number})?.status!==422||!location.search?.length||!latest.current.onInvalidSearch)return false;
    const invalid=await invalidSearchChoices(location.search,chip=>chip.kind==='character'&&location.node&&latest.current.index?.revision
      ?api(characterPath(location.node,'all',latest.current.index.revision,null),signal)
      :api(pagePath({tab:'library',title:'에셋',search:[chip]},null,EMPTY_FILTERS,1),signal),signal);
    if(!invalid.length)return false;
    latest.current.onInvalidSearch?.(invalid);return true;
  };
  useEffect(()=>{
    if(!active||!index?.ready||!index.revision||!where.node)return;
    const request=pageGate.current.begin();setBusy(true);setError('');setMoreError('');
    moreGate.current.cancel();morePending.current=false;setMore(false);
    const cached=cache.current.get(key(index.revision,where));
    // A cached page is re-validated against the contract it was stored under, so a scope
    // cannot present a page the server would now refuse simply because it was cached.
    const usable=cached&&(!hasActiveFilters(where.filters)||cached.page.filter_version===ASSET_FILTER_VERSION)?cached:undefined;
    const promise=(usable?Promise.resolve(usable.page):withScopedToc(
      api<CharacterPage&{listGeneration?:string}>(characterPath(where.node,where.filter,index.revision,null,where.filters,where.search),request.signal).then(value=>({...value,list_generation:value.listGeneration,filter_version:filterVersionOf(value)??undefined})),
      readScopedToc(characterPath(where.node,where.filter,index.revision,null,where.filters,where.search,true),request.signal),'newest'))
      // A switch keeps the old page, and an entry its empty gallery, until the new first screen
      // is decoded (capped like the PC's first viewport); later images load in place.
      .then(result=>readyFirstScreen(result.items,request.signal).then(items=>{
        const prepared=new Map(items.map(asset=>[asset.id,asset]));
        return {...result,items,assetRanges:result.assetRanges?{...result.assetRanges,ranges:result.assetRanges.ranges.map(range=>({...range,items:range.items.map(asset=>prepared.get(asset.id)??asset)}))}:undefined};
      }))
      .then(result=>{
        if(!pageGate.current.current(request.id))return;
        // The reader's own envelope declares the contract under the wire name, so it is resolved
        // through the one contract reader rather than read as a page field.
        if(hasActiveFilters(where.filters)&&result.filter_version!==ASSET_FILTER_VERSION)throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
        setPage(result);setCommitted(where);setRestore(usable?.scroll??scroll.current);scroll.current=usable?.scroll??scroll.current;
      });
    void promise.catch(async reason=>{if(pageGate.current.current(request.id)){if(await recoverSearch(where,reason,request.signal)||!pageGate.current.current(request.id))return;setError((reason as {status?:number}).status===409?'캐릭터 보기가 변경되었습니다. 새로고침해 주세요.':errorText(reason));}})
      .finally(()=>{if(pageGate.current.current(request.id))setBusy(false);});
    return()=>pageGate.current.cancel();
  },[active,index,where]);
  useEffect(()=>()=>{indexGate.current.cancel();pageGate.current.cancel();moreGate.current.cancel();},[]);
  // A scope change (drill-down, Series filter, or Back) closes the dialog, so the surface can
  // never be left open over a page it no longer describes.
  useEffect(()=>{setFiltersOpen(null);},[where.node,where.filter]);
  // The gallery's identity follows the page that is actually visible, so a failed narrowing
  // cannot re-key the gallery and reset its scroll anchor. The filter summary in the overview
  // reports what the user asked for, so a failed choice stays visible and retryable.
  // `shown` is the page scope that is actually on screen. A filter switch changes `where` first,
  // but leaves this value alone until the replacement page commits, so Gallery keeps its identity
  // and the old images do not flash out during the request.
  const shown=committed&&committed.node===where.node?committed:null;
  const filterPending=!!shown&&(shown.filter!==where.filter||!sameFilters(shown.filters,where.filters)||assetSearchSelectionKey(shown.search)!==assetSearchSelectionKey(where.search));
  const append=useCallback(async()=>{
    const s=latest.current;
    if(!s.active||s.paused||s.page?.assetRanges||!s.page?.next_cursor||!s.index?.revision||!s.where.node||morePending.current)return;
    // Append only through the scope the visible page was committed under, and only when that is
    // still the scope on screen. A failed narrowing leaves the two apart, and extending the old
    // cursor under filters that never applied would splice two different result sets.
    const base=s.committed;
    if(!base||base.node!==s.where.node||base.filter!==s.where.filter||!sameFilters(base.filters,s.where.filters)||assetSearchSelectionKey(base.search)!==assetSearchSelectionKey(s.where.search))return;
    morePending.current=true;setMore(true);setMoreError('');
    const request=moreGate.current.begin();
    try{
      const raw=await api<CharacterPage>(characterPath(s.where.node,s.where.filter,s.index.revision,s.page.next_cursor,base.filters,base.search),request.signal);
      if(!moreGate.current.current(request.id))return;
      // Resolved through the same reader as the other scopes, since this envelope declares the
      // contract under the wire name rather than the normalized page field.
      const declared=filterVersionOf(raw);
      const result:CharacterPage={...raw,filter_version:declared??undefined};
      if(result.revision!==s.index.revision||result.next_cursor===s.page.next_cursor)throw new Error('목록이 변경되었습니다. 새로고침해 주세요.');
      // Every appended page is validated, not only the first: a server that dropped the
      // contract part-way through a walk would otherwise splice unfiltered rows into a
      // filtered scope.
      if(hasActiveFilters(base.filters)&&result.filter_version!==ASSET_FILTER_VERSION)throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      setPage(current=>current?{...result,items:[...current.items,...result.items.filter(a=>!current.items.some(b=>a.id===b.id))]}:current);
    }catch(reason){if(moreGate.current.current(request.id)&&!await recoverSearch(s.where,reason,request.signal)&&moreGate.current.current(request.id))setMoreError(errorText(reason));}
    finally{if(moreGate.current.current(request.id)){morePending.current=false;setMore(false);}}
  },[]);
  const ready=useCallback((asset:Asset)=>setPage(current=>current?readyScopedAsset(current,asset):current),[]);
  const sparse=useScopedAssetToc(page,setPage,active&&!paused&&!busy&&!filterPending,
    async(cursor,signal)=>{
      const base=committed;
      if(!base?.node||!index?.revision)throw new Error('목록이 변경되었습니다. 새로고침해 주세요.');
      const raw=await api<CharacterPage&{listGeneration?:string}>(characterPath(base.node,base.filter,index.revision,cursor,base.filters,base.search),signal);
      if(raw.revision!==index.revision||hasActiveFilters(base.filters)&&filterVersionOf(raw)!==ASSET_FILTER_VERSION)throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      return {...raw,list_generation:raw.listGeneration,filter_version:filterVersionOf(raw)??undefined};
    },()=>{cache.current.clear();setRetry(n=>n+1);},setMoreError,
    (reason,signal)=>committed?recoverSearch(committed,reason,signal):Promise.resolve(false));
  // The committed page and its filters are one value, so an append cannot extend a page that
  // was fetched under a different scope than the one now displayed.
  const nearEnd=useCallback(()=>{if(!busy&&!moreError)void append();},[busy,moreError,append]);
  const node=index?.nodes.find(n=>n.id===where.node);
  const children=index?characterChildren(index,where.node):[];
  const scope=index?.scopes.find(s=>s.nodeId===where.node&&s.filter===where.filter);
  const ancestors:CharacterNode[]=[];
  let parent=node?.parentId;
  while(parent&&index&&!ancestors.some(n=>n.id===parent)){const found=index.nodes.find(n=>n.id===parent);if(!found)break;ancestors.unshift(found);parent=found.parentId;}
  const folderStrip=!!node&&node.kind!=='character';
  // While the next folder loads, the previous one stays on screen, quieted, instead of blanking;
  // once it commits the new level slides in from the side it was entered from.
  const lastPage=useRef<CharacterPage|undefined>(undefined);
  const visibleGalleryIdentity=useRef('character:empty');
  if(shown&&index?.revision)visibleGalleryIdentity.current=key(index.revision,shown);
  // The folder the visible tiles belong to; it changes only when a new folder's page commits, so the
  // gallery's folder move (the PC's FolderMove) runs once, from the old tiles to the new ones.
  const galleryFolder=useRef<{scope:string;path:string[]}|undefined>(undefined);
  if(shown&&galleryFolder.current?.scope!==(shown.node??'root')){
    const path:string[]=[],seen=new Set<string>();
    for(let id=shown.node;id&&!seen.has(id);id=index?.nodes.find(item=>item.id===id)?.parentId??null){seen.add(id);path.unshift(id);}
    galleryFolder.current={scope:shown.node??'root',path};
  }
  const level=useRef<{key:string;depth:number}|null>(null);
  // Entering from outside the browser is a new place: a page kept from an earlier visit is not
  // this folder's content, so it never stands in while the entered folder loads.
  const entering=active&&!!initialNode&&(appliedInitialNode.current!==initialNode||appliedEntryKey.current!==entryKey)&&!lastPage.current;
  if(!active){lastPage.current=undefined;level.current=null;}
  else if(page&&!entering)lastPage.current=page;
  if(active&&committed&&index){
    let depth=committed.node?1:0,up=index.nodes.find(n=>n.id===committed.node)?.parentId;const seen=new Set<string>();
    while(up&&!seen.has(up)){seen.add(up);depth++;up=index.nodes.find(n=>n.id===up)?.parentId;}
    // Character filters replace the page inside one level. Keep the level key stable so the
    // retained gallery does not replay the hierarchy fade when 미분류 and 전체 swap.
    // Folder to folder is the gallery's folder move; this level only covers the index root.
    level.current={key:committed.node?'folder':'root',depth};
  }
  useLevelMotion(host,search?.length?'asset-search':level.current?.key??null,level.current?.depth??0,false);
  const stale=!!shown&&filterPending||(!page&&busy&&!error&&!!where.node&&!!lastPage.current);
  const galleryItems=entering?[]:page?.items??(stale?lastPage.current!.items:[]);
  useFirstAppearance(host,children.length,active&&!paused&&!stale&&!busy,"classification-characters",".character-card");
  const foldable=folderStrip&&children.length>0;
  const childCharacterCount=children.filter(child=>child.kind!=='folder').length;
  const childFolderCount=children.filter(child=>child.kind==='folder').length;
  const shelfLabel=childCharacterCount>0&&childFolderCount>0?`캐릭터 ${childCharacterCount} · 폴더 ${childFolderCount}`:childCharacterCount>0?`캐릭터 ${childCharacterCount}`:`폴더 ${childFolderCount}`;
  const scopeCount=(filter:CharacterFilter)=>node?.kind==='series'?index?.scopes.find(scope=>scope.nodeId===node.id&&scope.filter===filter)?.totalCount:undefined;
  const filterControls=node?.kind==='series'&&<div className="folder-filter character-filters">
    <SegmentedControl<CharacterFilter> label="이미지 범위" options={SERIES_FILTERS.map(filter=>({value:filter,label:filter==='unclassified'?'미분류':'전체',count:scopeCount(filter)}))} value={where.filter} onChange={applyCharacterFilter}/>
    <IconButton label="미분류와 전체 설명" icon={InformationCircleIcon} onClick={()=>setFilterHelpOpen(true)}/>
  </div>;
  const shelf=children.length>0&&<FolderShelf label={shelfLabel} cards={children.map(child=><Card key={child.id} node={child} ratings={index?.contentRatings} count={index?.scopes.find(scope=>scope.nodeId===child.id&&scope.filter==='all')?.totalCount} paused={!active||paused||(folderStrip&&foldersCollapsed)} lazy={folderStrip} previews={child.kind==='group'?[...new Set(index?.nodes.filter(n=>n.parentId===child.id&&n.thumbnailAssetId).map(n=>n.thumbnailAssetId!)??[])].slice(0,4):[]} onSelect={()=>enterInside({node:child.id,filter:defaultCharacterFilter(child.id,index)})}/>) } accessory={foldable&&<Button size="icon" variant="ghost" className="character-fold-toggle" aria-label={foldersCollapsed?'캐릭터 폴더 펼치기':'캐릭터 폴더 접기'} aria-expanded={!foldersCollapsed} aria-controls={folderStripId} onClick={()=>setFoldersCollapsed(value=>!value)}><ChevronUpIcon aria-hidden="true"/></Button>} cardsId={folderStripId} cardsHidden={foldersCollapsed} />;
  const overview=<>
    {error&&<div className="inline-error" role="alert">{error}<Button onClick={()=>{cache.current.clear();setRetry(n=>n+1);}}>새로고침</Button></div>}
    {index&&!index.ready&&<div className="empty-state"><h3>캐릭터 보기가 아직 공유되지 않았습니다</h3><p>PC 설정에서 모바일 캐릭터 업데이트를 실행하면 여기에서 감상할 수 있습니다.</p></div>}
    {landscape&&node?.kind==='series'&&node.heroAssetId&&<div className="character-hero"><Preview id={node.heroAssetId} rating={index?.contentRatings?.[node.heroAssetId]} paused={!active||paused} label={`${node.name} 대표 이미지`}/></div>}
    {!!children.length&&shelf}
    {filterControls}
    {node?.description&&<p className="character-description">{node.description}</p>}
    {scope&&scope.sourceCount>scope.totalCount&&<p className="character-description">서버에 보관된 {scope.totalCount}개를 표시합니다. 아직 공유되지 않은 자산 {scope.sourceCount-scope.totalCount}개가 있습니다.</p>}
    {index?.ready&&!busy&&!error&&(!where.node&&!children.length||where.node&&page?.items.length===0)&&<div className="empty-state"><h3>{where.node?(filterPending?'조건에 맞는 자산이 없습니다':node?.kind==='series'&&where.filter==='unclassified'?'미분류 이미지가 없습니다':hasActiveFilters(shown?.filters??EMPTY_FILTERS)?'조건에 맞는 자산이 없습니다':'이 보기에 자산이 없습니다'):'등록된 시리즈가 없습니다'}</h3></div>}
  </>;
  // 종류 is the gallery's first row; scrolled away, the current crumb names it and the bar pulls down.
  const kindShade=useSectionShade<AssetMediaFilter>({label:'종류',options:MEDIA_SECTIONS,value:where.filters.media,onChange:applyMedia},{active:active&&!paused&&!!where.node});
  const breadcrumbNodes=node?[...ancestors,node]:[];
  const characterHeader=<header ref={where.node?kindShade.barRef:undefined} className="top-bar library-header asset-topbar character-header">
    <IconButton label="뒤로" icon={ArrowLeftIcon} onClick={goUp}/>
    <div className="top-bar__titles">
      <nav className="character-breadcrumb" aria-label="현재 위치">
        {breadcrumbNodes.length?breadcrumbNodes.map((item,itemIndex)=><span key={item.id}>{itemIndex>0&&<span className="character-breadcrumb__separator" aria-hidden="true">›</span>}{itemIndex<breadcrumbNodes.length-1?<button type="button" onClick={()=>enterInside({node:item.id,filter:defaultCharacterFilter(item.id,index)})}>{item.name}</button>:<span className="character-breadcrumb__current" aria-current="page">{where.node?kindShade.title(item.name):item.name}</span>}</span>):<span className="character-breadcrumb__current" aria-current="page">시리즈</span>}
      </nav>
      <h1 className="sr-only" aria-label={node?.name??'시리즈'}/>
    </div>
    <span className="top-bar__space"/>
    {onSearch&&<SearchButton onClick={onSearch}/>}
    {where.node&&<FilterChips media={false} sheet={false} variant="toolbar" showReset={false} value={where.filters} applied={where.filters} onChange={applyFilters} open={null} onOpen={setFiltersOpen}/>}
    <Button type="button" size="icon" variant="ghost" className="top-bar__options" aria-label="보기 옵션" onClick={()=>onOptions(page?.items??[])}><Squares2X2Icon aria-hidden="true"/></Button>
    <BarProgress label={(busy||hostBusy)&&'캐릭터 보기 불러오는 중'}/>
  </header>;
  return <section className={`character-browser${landscape?' character-browser-landscape':''}`} style={{display:active?undefined:'none'}} aria-label="시리즈·캐릭터" ref={host}>
    {characterHeader}
    {where.node&&kindShade.shade}
    <Gallery privacy={privacy} sparse={sparse} folderScope={galleryFolder.current?.scope} folderPath={galleryFolder.current?.path} items={galleryItems} stale={stale} intro={<>{scopeChips}{where.node?<>{kindShade.inline}{overview}</>:overview}</>} onRefresh={()=>{cache.current.clear();setRetry(n=>n+1);}} busy={busy} density={density} identity={visibleGalleryIdentity.current} restoreScroll={restore} onScroll={top=>{scroll.current=top;}} onOpen={i=>{if(page)onOpen(page.items,i,viewerCharacterContext(node,index));}} onReady={ready} onNearEnd={nearEnd} paused={!active||paused} scrubberHidden={filtersOpen!==null}/>
    {where.node&&<FilterChips media={false} row={false} value={where.filters} applied={where.filters} onChange={applyFilters} open={filtersOpen} onOpen={setFiltersOpen}/>}
    <LoadingLine label={(more)&&'다음 캐릭터 자산 불러오는 중'} className="is-bottom"/>
    {moreError&&<div className="inline-error" role="alert">{moreError}<Button onClick={()=>{if(sparse){cache.current.clear();setRetry(n=>n+1);}else void append();}}>다시 시도</Button><Button onClick={()=>{cache.current.clear();setRetry(n=>n+1);}}>새로고침</Button></div>}
    {filterHelpOpen&&<BottomSheet title="미분류와 전체" onClose={()=>setFilterHelpOpen(false)}><div className="folder-filter__explanation"><p><strong>미분류</strong>: 이 폴더에 바로 들어 있고 아직 캐릭터나 하위 폴더에 없는 이미지</p><p><strong>전체</strong>: 캐릭터와 하위 폴더까지 모두</p></div></BottomSheet>}
  </section>;
}
