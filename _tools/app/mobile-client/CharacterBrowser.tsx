import {LibraryHeader,type LibraryCrumb} from './LibraryHeader';
import {FilterChips,type FilterGroup} from './FilterChips';
import {usePublicationCheck} from './usePublicationCheck';
import {useCallback,useEffect,useId,useRef,useState,type MutableRefObject} from 'react';
import {ChevronLeftIcon,ChevronRightIcon,ChevronUpIcon,FolderIcon,PhotoIcon,UserGroupIcon} from '@heroicons/react/24/outline';
import {Button,IconButton} from './ui';
import {api,errorText} from './transport';
import {loadThumbnail} from './media';
import {Gallery} from './Gallery';
import {RequestGate} from './model';
import type {Asset,AssetFiltersValue} from './types';
import {ASSET_FILTER_VERSION,EMPTY_FILTERS,filterKey,filterVersionOf,hasActiveFilters,sameFilters} from './assetFilters';
import {filterSummary} from './AssetFilters';
import {characterChildren,characterExclusion,characterExclusionTarget,characterPath,validCharacterIndex,type CharacterFilter,type CharacterIndex,type CharacterNode,type CharacterPage} from './characterModel';
import {CharacterReviewChip} from './CharacterReview';
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
type Location={node:string|null;filter:CharacterFilter;filters:AssetFiltersValue};
type Cached={page:CharacterPage;scroll:number};
const ROOT:Location={node:null,filter:'all',filters:{...EMPTY_FILTERS}};
const labels:Record<CharacterFilter,string>={all:'전체',unclassified:'미분류',needs_review:'추가 확인'};

/** The character context a character gallery hands to its viewer, or null for any other scope. */
export function viewerCharacterContext(node:CharacterNode|undefined|null,index:CharacterIndex|undefined) {
  const target=characterExclusionTarget(node);
  const capability=characterExclusion(index);
  if(!target||!capability||!Array.isArray(target.protectedAssetIds)||!target.protectedAssetIds.every(id=>typeof id==='string'))return null;
  return {targetId:target.sourceId,name:target.name,libraryId:capability.libraryId,revision:capability.revision,protectedAssetIds:target.protectedAssetIds};
}

function Preview({id,paused,label=''}:{id?:string|null;paused:boolean;label?:string}) {
  const [loaded,setLoaded]=useState<{id:string;preview?:string}>();
  const preview=loaded?.id===id?loaded?.preview:undefined;
  useEffect(()=>{
    if(paused||!id||preview)return;
    const controller=new AbortController();
    void loadThumbnail({id,kind:'image'},controller.signal).then(a=>{if(!controller.signal.aborted)setLoaded({id,preview:a.preview});},()=>{});
    return()=>controller.abort();
  },[id,paused,preview]);
  return preview?<img src={preview} alt={label}/>:<PhotoIcon aria-hidden="true"/>;
}
function Card({node,count,paused,onSelect,previews=[],lazy=false}:{node:CharacterNode;count:number;paused:boolean;onSelect():void;previews?:string[];lazy?:boolean}) {
  const host=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(!lazy);
  useEffect(()=>{
    if(!lazy||!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);return;}
    // The strip can contain every folder, but only nearby covers enter the media queue.
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{root:host.current.parentElement,rootMargin:'0px 120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[lazy]);
  const previewPaused=paused||(lazy&&!visible);
  return <button ref={host} className="character-card" data-kind={node.kind} onClick={onSelect} aria-label={`${node.name} · ${count}개`}>
    <span className={`character-card-image${node.kind==='group'?' character-mosaic':''}`} data-count={previews.length}>
      {node.kind==='group'&&previews.length?previews.map(id=><span key={id}><Preview id={id} paused={previewPaused}/></span>):node.thumbnailAssetId?<Preview id={node.thumbnailAssetId} paused={previewPaused}/>:node.kind==='folder'?<FolderIcon/>:<PhotoIcon/>}
    </span>
    <span className="character-card-caption"><strong>{node.kind==='group'?<UserGroupIcon/>:node.kind==='folder'?<FolderIcon/>:null}{node.name}</strong><span className="muted numeric">{count}개</span></span>
    {node.excluded&&<small>자동 분류 제외</small>}
  </button>;
}

export function CharacterBrowser({entryKey=0,crumbs=[],onOptions=()=>{},onLocation,initialNode,active,paused,density,refreshKey,onOpen,backRef,onExit,review}:{review?:{enabled:boolean;refreshKey:unknown;onOpen(target:{id:string;name:string}):void};entryKey?:number;crumbs?:LibraryCrumb[];onOptions?(scopeItems:Asset[]):void;onLocation?(id:string|null):void;initialNode?:string;active:boolean;paused:boolean;density:number;refreshKey:number;onOpen(items:Asset[],index:number,character?:import('./Viewer').ViewerCharacterContext|null):void;backRef:MutableRefObject<(()=>boolean)|null>;onExit():void}) {
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
  const [more,setMore]=useState(false),[cardsPage,setCardsPage]=useState(0),[columns,setColumns]=useState(3);
  const [foldersCollapsed,setFoldersCollapsed]=useState(false);
  const folderStripId=useId();
  const [restore,setRestore]=useState(0);
  const [retry,setRetry]=useState(0);
  const host=useRef<HTMLDivElement>(null),scroll=useRef(0);
  const indexGate=useRef(new RequestGate()),pageGate=useRef(new RequestGate()),moreGate=useRef(new RequestGate());
  const cache=useRef(new Map<string,Cached>()),morePending=useRef(false);
  const [filtersOpen,setFiltersOpen]=useState<FilterGroup|null>(null);
  const latest=useRef({index,where,page,active,paused,committed,filtersOpen});latest.current={index,where,page,active,paused,committed,filtersOpen};
  // The filter set is part of the location, so it is already part of this key.
  const key=(revision:string,location:Location)=>`${revision}:${location.node}:${location.filter}:${filterKey(location.filters)}`;
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
    setPage(undefined);setCommitted(null);setError('');setMoreError('');setMore(false);setWhere(next);setCardsPage(0);
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
  const appliedInitialNode=useRef<string|undefined>(undefined);
  const appliedEntryKey=useRef(entryKey);
  // True once the user walks down the hierarchy from within the browser. This is tracked as
  // its own flag rather than by comparing `where.node` against the applied direct entry: the
  // entry effect updates its ref eagerly while `where` commits later, so comparing the two
  // reported a drill-down for a folder that had just been opened and wrongly consumed Back.
  const drilled=useRef(false);
  useEffect(()=>{if(active&&initialNode&&(appliedInitialNode.current!==initialNode||appliedEntryKey.current!==entryKey)){appliedEntryKey.current=entryKey;appliedInitialNode.current=initialNode;drilled.current=false;navigate({node:initialNode,filter:'all',filters:{...EMPTY_FILTERS}});}},[initialNode,entryKey,active,navigate]);
  // Changing a filter in the entry folder does not create a parent navigation step, and
  // entering a different child or moving between Series filters is a different scope, so
  // the filters start empty rather than carrying the previous scope's narrowing into it.
  const enterInside=useCallback((next:{node:string|null;filter:CharacterFilter})=>{
    if(next.node!==latest.current.where.node)drilled.current=true;
    navigate({...next,filters:{...EMPTY_FILTERS}});
  },[navigate]);
  usePublicationCheck(active&&!paused,'/v1/library/characters/status',index?.revision,(_reply,changed)=>{if(changed)setRetry(n=>n+1);});
  useEffect(()=>{
    backRef.current=()=>{
      const s=latest.current;
      if(s.filtersOpen){setFiltersOpen(null);return true;}
      if(hasActiveFilters(s.where.filters)){applyFilters({...EMPTY_FILTERS});return true;}
      if(!s.where.node)return false;
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
      navigate({node:parent,filter:'all',filters:s.where.filters});return true;
    };
    return()=>{backRef.current=null;};
  },[backRef,navigate,applyFilters]);
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
  useEffect(()=>{
    if(!active||!index?.ready||!index.revision||!where.node)return;
    const request=pageGate.current.begin();setBusy(true);setError('');setMoreError('');
    moreGate.current.cancel();morePending.current=false;setMore(false);
    const cached=cache.current.get(key(index.revision,where));
    // A cached page is re-validated against the contract it was stored under, so a scope
    // cannot present a page the server would now refuse simply because it was cached.
    const usable=cached&&(!hasActiveFilters(where.filters)||cached.page.filter_version===ASSET_FILTER_VERSION)?cached:undefined;
    const promise=(usable?Promise.resolve(usable.page):api<CharacterPage>(characterPath(where.node,where.filter,index.revision,null,where.filters),request.signal).then(value=>({...value,filter_version:filterVersionOf(value)??undefined})))
      .then(result=>{
        if(!pageGate.current.current(request.id))return;
        // The reader's own envelope declares the contract under the wire name, so it is resolved
        // through the one contract reader rather than read as a page field.
        if(hasActiveFilters(where.filters)&&result.filter_version!==ASSET_FILTER_VERSION)throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
        setPage(result);setCommitted(where);setRestore(usable?.scroll??scroll.current);scroll.current=usable?.scroll??scroll.current;
      });
    void promise.catch(reason=>{if(pageGate.current.current(request.id))setError((reason as {status?:number}).status===409?'캐릭터 보기가 변경되었습니다. 새로고침해 주세요.':errorText(reason));})
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
  const shown=committed&&committed.node===where.node&&committed.filter===where.filter?committed:null;
  const filterPending=!!shown&&!sameFilters(shown.filters,where.filters);
  useEffect(()=>{
    if(!active||!host.current)return;
    const observer=new ResizeObserver(()=>setColumns(Math.max(2,Math.min(6,Math.floor((host.current?.clientWidth??600)/(landscape?180:150))))));
    observer.observe(host.current);return()=>observer.disconnect();
  },[active,landscape]);
  const append=useCallback(async()=>{
    const s=latest.current;
    if(!s.active||s.paused||!s.page?.next_cursor||!s.index?.revision||!s.where.node||morePending.current)return;
    // Append only through the scope the visible page was committed under, and only when that is
    // still the scope on screen. A failed narrowing leaves the two apart, and extending the old
    // cursor under filters that never applied would splice two different result sets.
    const base=s.committed;
    if(!base||base.node!==s.where.node||base.filter!==s.where.filter||!sameFilters(base.filters,s.where.filters))return;
    morePending.current=true;setMore(true);setMoreError('');
    const request=moreGate.current.begin();
    try{
      const raw=await api<CharacterPage>(characterPath(s.where.node,s.where.filter,s.index.revision,s.page.next_cursor,base.filters),request.signal);
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
    }catch(reason){if(moreGate.current.current(request.id))setMoreError(errorText(reason));}
    finally{if(moreGate.current.current(request.id)){morePending.current=false;setMore(false);}}
  },[]);
  const ready=useCallback((asset:Asset)=>setPage(current=>current?{...current,items:current.items.map(a=>a.id===asset.id?{...a,...asset}:a)}:current),[]);
  // The committed page and its filters are one value, so an append cannot extend a page that
  // was fetched under a different scope than the one now displayed.
  const nearEnd=useCallback(()=>{if(!busy&&!moreError)void append();},[busy,moreError,append]);
  const node=index?.nodes.find(n=>n.id===where.node);
  const children=index?characterChildren(index,where.node):[];
  const capacity=columns*2,pages=Math.ceil(children.length/capacity),cardPage=Math.min(cardsPage,Math.max(0,pages-1));
  const scope=index?.scopes.find(s=>s.nodeId===where.node&&s.filter===where.filter);
  const ancestors:CharacterNode[]=[];
  let parent=node?.parentId;
  while(parent&&index&&!ancestors.some(n=>n.id===parent)){const found=index.nodes.find(n=>n.id===parent);if(!found)break;ancestors.unshift(found);parent=found.parentId;}
  const folderStrip=!landscape&&!!node;
  // While the next folder loads, the previous one stays on screen, quieted, instead of blanking;
  // once it commits the new level slides in from the side it was entered from.
  const lastPage=useRef<CharacterPage|undefined>(undefined);
  const level=useRef<{key:string;depth:number}|null>(null);
  if(!active){lastPage.current=undefined;level.current=null;}
  else if(page)lastPage.current=page;
  if(active&&committed&&index){
    let depth=committed.node?1:0,up=index.nodes.find(n=>n.id===committed.node)?.parentId;const seen=new Set<string>();
    while(up&&!seen.has(up)){seen.add(up);depth++;up=index.nodes.find(n=>n.id===up)?.parentId;}
    level.current={key:`${committed.node}:${committed.filter}`,depth};
  }
  useLevelMotion(host,level.current?.key??null,level.current?.depth??0);
  const stale=!page&&busy&&!error&&!!where.node&&!!lastPage.current;
  const galleryItems=page?.items??(stale?lastPage.current!.items:[]);
  const foldable=folderStrip&&children.length>0;
  const filterControls=(node?.kind==='series'||foldable)&&<div className="character-filters">{node?.kind==='series'&&(Object.keys(labels) as CharacterFilter[]).map(filter=><Button key={filter} variant="ghost" aria-pressed={where.filter===filter} onClick={()=>enterInside({node:node.id,filter})}>{labels[filter]}</Button>)}{foldable&&<Button size="icon" variant="ghost" className="character-fold-toggle" aria-label={foldersCollapsed?'캐릭터 폴더 펼치기':'캐릭터 폴더 접기'} aria-expanded={!foldersCollapsed} aria-controls={folderStripId} onClick={()=>setFoldersCollapsed(value=>!value)}><ChevronUpIcon aria-hidden="true"/></Button>}</div>;
  const overview=<>
    {review&&node?.kind==='character'&&<CharacterReviewChip key={node.id} enabled={review.enabled&&active&&!paused} targetId={node.sourceId} refreshKey={review.refreshKey} onOpen={()=>review.onOpen({id:node.sourceId,name:node.name})}/>}
    {!landscape&&filterControls}
    {error&&<div className="inline-error" role="alert">{error}<Button onClick={()=>{cache.current.clear();setRetry(n=>n+1);}}>새로고침</Button></div>}
    {hasActiveFilters(where.filters)&&<p className="hint">{filterSummary(where.filters)}{filterPending&&' · 표시 중인 목록에는 아직 적용되지 않았습니다.'}<Button variant="ghost" onClick={()=>applyFilters({...EMPTY_FILTERS})}>필터 해제</Button></p>}
    {busy&&<div className="loading-line" role="status" aria-label="캐릭터 보기 불러오는 중"/>}
    {index&&!index.ready&&<div className="empty-state"><h3>캐릭터 보기가 아직 공유되지 않았습니다</h3><p>PC 설정에서 모바일 캐릭터 업데이트를 실행하면 여기에서 감상할 수 있습니다.</p></div>}
    {landscape&&node?.kind==='series'&&node.heroAssetId&&<div className="character-hero"><Preview id={node.heroAssetId} paused={!active||paused} label={`${node.name} 대표 이미지`}/></div>}
    {!!children.length&&landscape&&node&&<h4 className="character-section-title">{node.kind==='group'?'그룹 캐릭터':'캐릭터 · 폴더'}</h4>}
    {!!children.length&&<div key={where.node??'root'} id={folderStrip?folderStripId:undefined} className={`character-cards${folderStrip?' character-folder-strip':pages>1?' character-cards-paged':''}`} hidden={folderStrip&&foldersCollapsed} role={folderStrip?'region':undefined} aria-label={folderStrip?'캐릭터 폴더':undefined} tabIndex={folderStrip?0:undefined} style={folderStrip?undefined:{gridTemplateColumns:`repeat(${columns},minmax(0,${landscape?'180px':'1fr'}))`}}>{(folderStrip?children:children.slice(cardPage*capacity,(cardPage+1)*capacity)).map(child=><Card key={`${index?.revision}:${child.id}`} node={child} count={index?.scopes.find(s=>s.nodeId===child.id&&s.filter==='all')?.totalCount??0} paused={!active||paused||(folderStrip&&foldersCollapsed)} lazy={folderStrip} previews={landscape&&child.kind==='group'?[...new Set(index?.nodes.filter(n=>n.parentId===child.id&&n.thumbnailAssetId).map(n=>n.thumbnailAssetId!)??[])].slice(0,4):[]} onSelect={()=>enterInside({node:child.id,filter:'all'})}/>)}</div>}
    {!folderStrip&&pages>1&&<div className="character-card-pages"><IconButton label="이전 폴더" icon={ChevronLeftIcon} disabled={!cardPage} onClick={()=>setCardsPage(cardPage-1)}/><span>{cardPage+1} / {pages}</span><IconButton label="다음 폴더" icon={ChevronRightIcon} disabled={cardPage+1>=pages} onClick={()=>setCardsPage(cardPage+1)}/></div>}
    {node?.description&&<p className="character-description">{node.description}</p>}
    {landscape&&filterControls}
    {scope&&scope.sourceCount>scope.totalCount&&<p className="character-description">서버에 보관된 {scope.totalCount}개를 표시합니다. 아직 공유되지 않은 자산 {scope.sourceCount-scope.totalCount}개가 있습니다.</p>}
    {index?.ready&&!busy&&!error&&(!where.node&&!children.length||where.node&&page?.items.length===0)&&<div className="empty-state"><h3>{where.node?(filterPending?'조건에 맞는 자산이 없습니다':hasActiveFilters(shown?.filters??EMPTY_FILTERS)?'조건에 맞는 자산이 없습니다':'이 보기에 자산이 없습니다'):'등록된 시리즈가 없습니다'}</h3>{where.node&&hasActiveFilters(shown?.filters??EMPTY_FILTERS)&&<p>필터를 해제하면 이 보기의 자산을 모두 볼 수 있습니다.</p>}</div>}
  </>;
  return <section className={`character-browser${landscape?' character-browser-landscape':''}`} style={{display:active?undefined:'none'}} aria-label="시리즈·캐릭터" ref={host}>
    <LibraryHeader title={node?.name??'시리즈'} count={page?.totalCount??scope?.totalCount} crumbs={[...crumbs,...ancestors.map(ancestor=>({id:ancestor.id,name:ancestor.name,onSelect:()=>{drilled.current=ancestor.id!==appliedInitialNode.current&&!!ancestor.parentId;navigate({node:ancestor.id,filter:'all',filters:{...EMPTY_FILTERS}});}}))]} onBack={goUp} onOptions={()=>onOptions(page?.items??[])}/>
    <Gallery items={galleryItems} stale={stale} intro={<>{overview}{where.node&&<FilterChips value={where.filters} applied={shown?.filters??EMPTY_FILTERS} onChange={applyFilters} open={filtersOpen} onOpen={setFiltersOpen}/>}</>} onRefresh={()=>{cache.current.clear();setRetry(n=>n+1);}} busy={busy} density={density} identity={`${index?.revision}:${where.node}:${where.filter}:${filterKey(shown?.filters??EMPTY_FILTERS)}`} restoreScroll={restore} onScroll={top=>{scroll.current=top;}} onOpen={i=>{if(page)onOpen(page.items,i,viewerCharacterContext(node,index));}} onReady={ready} onNearEnd={nearEnd} paused={!active||paused}/>
    {more&&<div className="loading-line is-bottom" role="status" aria-label="다음 캐릭터 자산 불러오는 중"/>}
    {moreError&&<div className="inline-error" role="alert">{moreError}<Button onClick={()=>void append()}>다시 시도</Button><Button onClick={()=>{cache.current.clear();setRetry(n=>n+1);}}>새로고침</Button></div>}
  </section>;
}
