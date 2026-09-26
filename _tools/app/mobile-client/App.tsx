import {PrivateVault} from './PrivateVault';
import {onVisible} from './useVisibleInterval';
import {fetchAssetFilterVersion, fetchListGeneration, pageGenerationOf, ASSET_LIST_CHANGED_EVENT} from './listGeneration';
import {HeaderTools} from './HeaderTools';
import {Notes} from './Notes';
import {usePublicationCheck} from './usePublicationCheck';
import {characterReviewLibrary,validCharacterIndex,type CharacterIndex} from './characterModel';
import {CharacterReview} from './CharacterReview';
import {useCharacterReviewBackgroundFlush} from './useCharacterReview';
import {SimilarityReview} from './SimilarityReview';
import {LibraryTrash} from './LibraryTrash';
import {useLibraryTrash} from './useLibraryTrash';
import {useSimilarityReviewBackgroundFlush} from './useSimilarityReview';
import {useDuplicateDecisionFlush} from './CatalogDuplicates';
import type {ViewerCharacterContext} from './Viewer';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {BookOpenIcon, PhotoIcon, PencilSquareIcon, HomeIcon, RectangleStackIcon, AdjustmentsHorizontalIcon, ArrowPathIcon, ChevronRightIcon, PlayIcon, ArrowsUpDownIcon} from '@heroicons/react/24/outline';
import {Exchange} from './Exchange';
import {useExchange} from './useExchange';

import {Button, IconButton, Mark} from './ui';
import {api, errorText, native} from './transport';
import {clearMediaCache} from './media';
import {resetWarmProgress, startThumbnailWarm} from './thumbnailWarm';
import {DEFAULT_DENSITY, DENSITIES, densityIndex, densityOf, normalizePage, pagePath, RequestGate, validDensity, viewKey} from './model';
import {StepSlider} from './StepSlider';
import type {Asset, AssetFiltersValue, Classification, Page, SavedPosition, Status, View} from './types';
import {EMPTY_FILTERS, ASSET_FILTER_VERSION, hasActiveFilters, sameFilters} from './assetFilters';
import {FilterChips,activeFilterCount,type FilterGroup} from './FilterChips';
import {BarProgress,LoadingLine,closeVisibleSearch} from './TopBar';
import {BottomSheet} from './BottomSheet';
import {LibraryHeader} from './LibraryHeader';
import {LibraryRoot} from './LibraryRoot';
import {FolderCards} from './FolderCards';
import {Albums,useAlbumTree} from './Albums';
import {albumAncestors,albumPage,albumView,type AlbumAssetPage} from './albumModel';
import {LIBRARY_ROOT,mergeLibraryEntries,ancestorsOf,entryView} from './libraryModel';
import './library.css';
import {Gallery} from './Gallery';
import {Home} from './Home';
import {Collections, type CollectionsPlace, type CollectionsRequest} from './Collections';
import {resetReleaseStore} from './releaseStore';
import {useCollectionEditBackgroundFlush} from './useCollectionEdits';
import {Catalog} from './Catalog';
import {readRecentFolders, rememberFolder, RECENT_FOLDERS_KEY} from './homeModel';
import {Viewer} from './Viewer';
import {Settings} from './Settings';
import {CharacterBrowser} from './CharacterBrowser';
import {FaultGame} from './FaultGame';
import {faultCandidates} from '../src/games/fault/host';
import {useLevelMotion,useScrollMemory,useTabMotion} from './motion';
import {setOutboxConnection} from './outboxConnection';
/** The durable outboxes follow the connection before any screen re-renders against it. */
const adoptConnection=(next:Status)=>{setOutboxConnection(next.configured?next.endpoint:null);return next;};

const HOME: View = {tab:'home', title:'홈'};
const LIBRARY = LIBRARY_ROOT;
async function readPage(view:View,cursor:string|null,filters:AssetFiltersValue,signal:AbortSignal):Promise<Page> {
  const path=pagePath(view,cursor,filters);
  const reply=await api<AlbumAssetPage&Page>(path,signal);
  const page=view.album ? albumPage(reply) : normalizePage(reply);
  const generation=pageGenerationOf(reply);
  return generation ? {...page,list_generation:generation} : page;
}
function store(key: string, value: unknown) { try {localStorage.setItem(key, JSON.stringify(value));} catch { /* Optional device preference. */ } }
type HomeOrigin = {area:'collections'|'notes'|'catalog'} | {area:'library';entry:string;scroll:number};
type Committed = Page & {generation:string|null; view: View; cursor: string | null; previous: (string | null)[]; version: number; restoreScroll: number; filters: AssetFiltersValue};
export function App() {
  const [area,setArea] = useState<'assets'|'collections'|'catalog'|'notes'>('assets');
  const [focusedCharacter,setFocusedCharacter]=useState<string|null>(null);
  const [characterEntry,setCharacterEntry]=useState(0);
  const [collectionsVisited,setCollectionsVisited] = useState(false);
  const [catalogVisited,setCatalogVisited] = useState(false);
  const [charactersVisited,setCharactersVisited] = useState(false);
  const [notesVisited,setNotesVisited]=useState(false);
  const notesBack=useRef<(()=>boolean)|null>(null);
  const characterBack = useRef<(()=>boolean)|null>(null);
  const collectionBack = useRef<(()=>boolean)|null>(null);
  const catalogBack = useRef<(()=>boolean)|null>(null);
  const [librarySegment,setLibrarySegment]=useState<'folders'|'albums'>('folders');
  const [vaultOpen,setVaultOpen]=useState(false);
  // 보내기/받기: a utility screen opened from the Home header or an arrival toast.
  const [exchangeOpen,setExchangeOpen]=useState(false);
  const exchangeBack=useRef<(()=>boolean)|null>(null);
  const vaultBack=useRef<(()=>boolean)|null>(null);
  const viewerBack = useRef<(()=>boolean)|null>(null);
  const [status, setStatus] = useState<Status>({configured:false, endpoint:''});
  // Queued personal Collection edits are sent on start and on return, whatever screen is open.
  useCollectionEditBackgroundFlush(status.configured);
  // Queued character-review decisions are sent the same way, and when the network returns.
  useCharacterReviewBackgroundFlush(status.configured);
  // The full-screen character review, optionally filtered to one character.
  const [review,setReview]=useState<{target:{id:string;name:string}|null}|null>(null);
  const [reviewClosed,setReviewClosed]=useState(0);
  const reviewBack=useRef<(()=>boolean)|null>(null);
  // Similarity review decisions wait out their undo window, then go the same way.
  useSimilarityReviewBackgroundFlush(status.configured);
  // Catalog duplicate-edition decisions, likewise after their undo window.
  useDuplicateDecisionFlush(status.configured);
  const [similarity,setSimilarity]=useState(false);
  const [similarityClosed,setSimilarityClosed]=useState(0);
  const similarityBack=useRef<(()=>boolean)|null>(null);
  const [checking, setChecking] = useState(true), [settings, setSettings] = useState(false);
  const [viewSettings, setViewSettings] = useState(false);
  // A character scope portals its own filter row into the open 보기 옵션 sheet through this host.
  const [optionsHost, setOptionsHost] = useState<HTMLDivElement|null>(null);
  // The album or character scope the options sheet was opened from, and the FAULT game launched from it.
  const [optionsScope, setOptionsScope] = useState<Asset[]>([]);
  const [fault, setFault] = useState<Asset[] | null>(null);
  // The committed query's filters. Owned here rather than inside a gallery so that a
  // filter change is an ordinary navigation: it commits a new page and Back returns to
  // the previous view instead of silently mutating the one on screen.
  const [filters, setFilters] = useState<AssetFiltersValue>({...EMPTY_FILTERS});
  const [filtersOpen, setFiltersOpen] = useState<FilterGroup|null>(null);
  const [filterVersion, setFilterVersion] = useState<number | null>(null);
  const [filterNotice, setFilterNotice] = useState('');
  const [page, setPage] = useState<Committed>({items:[], has_more:false, next_cursor:null, view:LIBRARY, cursor:null, previous:[], version:0, restoreScroll:0, generation:null, filters:{...EMPTY_FILTERS}});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [indexError, setIndexError] = useState('');
  const [characterIndex,setCharacterIndex]=useState<CharacterIndex>();
  const [indexRevision,setIndexRevision]=useState(0);
  const [classifications, setClassifications] = useState<Classification[]>([]);
  // Recent folder visits are still recorded per connection (no screen shows them at the moment).
  const [,setRecentFolders] = useState<string[]>([]);
  // Pending captures for Home's 처리 대기 tile; null until the first read.
  const [captures, setCaptures] = useState<Asset[]|null>(null);
  // Places Home asks the Collections and Catalog tabs to open.
  const [collectionRequest,setCollectionRequest]=useState<CollectionsRequest|null>(null),[duplicateRequest,setDuplicateRequest]=useState(0);
  // A note Home asks the Notes tab to open.
  const [noteRequest,setNoteRequest]=useState<{id:string;key:number}|null>(null);
  // Where Back returns when a screen was opened from Home: the destination's entry level goes
  // straight back to Home instead of its own tab root. Any bottom-nav tap forgets it. The Library
  // destination replaces Home's page, so it also keeps the entry view and Home's scroll offset.
  const [homeOrigin,setHomeOrigin]=useState<HomeOrigin|null>(null);
  const homeOriginRef=useRef(homeOrigin); homeOriginRef.current=homeOrigin;
  const homeRestore=useRef<number|null>(null);
  const [secondaryError, setSecondaryError] = useState('');
  const [viewer, setViewer] = useState<{items: Asset[]; index: number; pending?: boolean; source?:'library'; character?:ViewerCharacterContext|null} | null>(null);
  // Library Trash: local hiding, the undo snackbar and the trash browser.
  const trash = useLibraryTrash(status.configured, status.endpoint, setViewer);
  const exchange = useExchange(status.configured, status.endpoint, exchangeOpen);
  const visibleItems = useMemo(() => trash.hidden.size ? page.items.filter(item => !trash.hidden.has(item.id)) : page.items, [page.items, trash.hidden]);
  const [density, setDensity] = useState(() => {try {return validDensity(JSON.parse(localStorage.getItem('lakomics.mobile.density') ?? '1'));} catch {return DEFAULT_DENSITY;}});
  const entries=useMemo(()=>mergeLibraryEntries(classifications,characterIndex),[classifications,characterIndex]);
  const entriesRef=useRef(entries);entriesRef.current=entries;
  const {tree:albumTree,error:albumError}=useAlbumTree(status.configured&&area==='assets'&&!settings&&!viewer&&page.view.tab==='library'&&(librarySegment==='albums'||!!page.view.album),indexRevision,status.endpoint);
  const albumTreeRef=useRef(albumTree);albumTreeRef.current=albumTree;
  const appRef=useRef<HTMLDivElement>(null),mainRef=useRef<HTMLElement>(null),bodyRef=useRef<HTMLDivElement>(null);
  const scroll = useRef(0), gate = useRef(new RequestGate()), secondaryGate = useRef(new RequestGate());
  const latest = useRef({page, viewer, settings, status, area, viewSettings, filtersOpen, filterVersion, fault, review, similarity, vaultOpen, exchangeOpen}); latest.current = {page, viewer, settings, status, area, viewSettings, filtersOpen, filterVersion, fault, review, similarity, vaultOpen, exchangeOpen};
  const lastIntent = useRef<{view:View; cursor:string|null; previous:(string|null)[]; filters:AssetFiltersValue}>({view:LIBRARY,cursor:null,previous:[],filters:{...EMPTY_FILTERS}});
  const lastLibrary = useRef<SavedPosition | undefined>(undefined);
  // Committed classification or root to restore after leaving character browsing.
  const beforeCharacter = useRef<SavedPosition | undefined>(undefined);
  const observedGeneration = useRef<string|null>(null);
  // Whether this server's pages carry their own list generation: `null` until a page
  // answers, so an older server keeps the generation-bracketed fetch it always had.
  const pageGenerations = useRef<boolean|null>(null);
  useEffect(() => {pageGenerations.current = null;}, [status.endpoint]);
  const viewCache = useRef(new Map<string, Committed>());
  const moreGate = useRef(new RequestGate());
  const [loadingMore, setLoadingMore] = useState(false), [moreError, setMoreError] = useState('');
  const morePending = useRef(false);
  const prefetched = useRef<{path:string; controller:AbortController; promise:Promise<Page>} | null>(null);
  const cancelMore = useCallback(() => {
    moreGate.current.cancel(); prefetched.current?.controller.abort(); prefetched.current = null;
    morePending.current = false; setLoadingMore(false); setMoreError('');
  }, []);
  const nextPage = useCallback((view:View, cursor:string, filters:AssetFiltersValue) => {
    const path = pagePath(view, cursor, filters);
    if (prefetched.current?.path === path) return prefetched.current.promise;
    prefetched.current?.controller.abort();
    const controller = new AbortController();
    const promise = readPage(view,cursor,filters,controller.signal);
    prefetched.current = {path, controller, promise};
    void promise.catch(() => {if (prefetched.current?.promise === promise) prefetched.current = null;});
    return promise;
  }, []);

  const load = useCallback(async (view: View, cursor: string | null = null, previous: (string | null)[] = [], restore = 0, fresh = false, nextFilters: AssetFiltersValue = EMPTY_FILTERS) => {
    const visible = latest.current.page;
    if(visible.version) viewCache.current.set(`${viewKey(visible.view,visible.filters)}:${visible.cursor}`,{...visible,restoreScroll:scroll.current});
    if (visible.view.tab === 'library' && view.tab === 'home') lastLibrary.current = {view:visible.view,cursor:visible.cursor,previous:visible.previous,scroll:scroll.current,filters:visible.filters};
    cancelMore();
    const request = gate.current.begin(); lastIntent.current = {view,cursor,previous,filters:nextFilters}; setBusy(true); setError(''); setFilterNotice('');
    // Declared outside the `try` so the failure path can tell a refused filter request from
    // an ordinary transport failure. A character scope has its own reader and its own
    // placeholder page, so it is not part of this route's filter contract.
    const filtered = hasActiveFilters(nextFilters) && view.tab === 'library' && !view.root && !view.revisit && !view.characters;
    try {
      // A server that cannot promise the filter contract must not be asked to pretend.
      // The refusal happens before the page fetch so an unfiltered list can never be
      // committed under a filtered identity. Albums declare support on their own page
      // envelope, preserving that route's existing response-level validation.
      if (filtered && !view.album && latest.current.filterVersion === null) throw new Error('이 서버는 자산 필터를 지원하지 않습니다. 서버를 업데이트해 주세요.');
      // A character scope is served by its own reader, not by the page route, so its
      // synthetic empty page is a placeholder that carries no contract. It is therefore
      // never validated against the filter version below.
      const synthetic = !!view.characters;
      const key = `${viewKey(view, nextFilters)}:${cursor}`;
      let generation: string|null = null;
      let cached: Committed|undefined;
      let response: Page|undefined;
      // One round trip: a server whose pages carry their own generation needs no
      // bracketing reads. A cached candidate still asks the cheap endpoint first, since
      // only that can tell whether the cache is current without refetching the page.
      if (!synthetic && pageGenerations.current && (fresh || !viewCache.current.has(key))) {
        const reply = await readPage(view,cursor,nextFilters,request.signal);
        if (!gate.current.current(request.id)) return;
        // A page without the field means the server went back to an older build: forget
        // the capability and redo this load the bracketed way below.
        if (reply.list_generation) {
          response = reply; generation = reply.list_generation;
          if (generation !== observedGeneration.current) viewCache.current.clear();
        } else pageGenerations.current = false;
      }
      if (!response) {
        // `null` means this server predates the generation endpoint, so degrade to
        // always-fresh reads instead of failing the load that carries the actual list.
        generation = await fetchListGeneration(request.signal);
        if (!gate.current.current(request.id)) return;
        if (generation !== null && generation !== observedGeneration.current) {viewCache.current.clear(); observedGeneration.current = generation;}
        const candidate = fresh ? undefined : viewCache.current.get(key);
        cached = generation && candidate?.generation === generation ? candidate : undefined;
        response = synthetic ? {items:[],has_more:false,next_cursor:null} : cached ?? await readPage(view,cursor,nextFilters,request.signal);
        // A page that asked for filters but came back without the contract was answered by a
        // server that ignored the parameters, so it is refused rather than shown as filtered.
        if (filtered && !synthetic && !cached && response.filter_version !== ASSET_FILTER_VERSION) throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
        if (!cached && !synthetic && response.list_generation) {
          // The page names the generation of its own snapshot, which binds it exactly, and
          // later loads on this server skip the bracketing reads.
          pageGenerations.current = true;
          if (response.list_generation !== generation) viewCache.current.clear();
          generation = response.list_generation;
        } else if (!cached && !synthetic && generation) {
          pageGenerations.current = false;
          // Bind a fetched page to a stable generation; a mutation crossing the fetch must
          // not bless stale rows as current. Retry within the same navigation request.
          for (let attempt=0; attempt<3; attempt++) {
            const after = await fetchListGeneration(request.signal);
            if (after === null || after === generation) break;
            if (attempt === 2) throw new Error('목록이 변경되었습니다. 다시 시도해 주세요.');
            generation = after; viewCache.current.clear();
            response = await readPage(view,cursor,nextFilters,request.signal);
          }
        }
      }
      if (filtered && !synthetic && response.filter_version !== ASSET_FILTER_VERSION)
        throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      observedGeneration.current=generation;
      const items = response.items;
      if (!gate.current.current(request.id)) return;
      const restored = cached && restore === 0 ? cached.restoreScroll : restore;
      scroll.current = restored;
      setFilters(nextFilters);setFiltersOpen(null);
      setPage({ ...response, items, view, cursor, previous, restoreScroll:restored, generation, version:request.id, filters:nextFilters });
    } catch (reason) { if (gate.current.current(request.id)) {
      // The previous page stays mounted and committed on failure: an error must not
      // discard a usable gallery, and it must not leave the heading claiming filters
      // the visible page does not have.
      if (filtered && !hasActiveFilters(latest.current.page.filters)) setFilterNotice(errorText(reason));
      setError(errorText(reason));
    } }
    finally { if (gate.current.current(request.id)) setBusy(false); }
  }, [cancelMore]);
  useEffect(() => {
    if (!status.configured) return;
    let running=false, active=true;
    let pendingGeneration:string|null=null;
    const controller=new AbortController();
    const check=async () => {
      if (!active || running || document.visibilityState === 'hidden') return;
      running=true;
      try {
        const hint=pendingGeneration;pendingGeneration=null;
        const generation=hint??await fetchListGeneration(controller.signal);
        if (!active) return;
        const state=latest.current;
        // Without the endpoint there is no cheap change signal: leave the committed
        // view alone and let the foreground/resume refresh handle navigation.
        if (!generation) return;
        if (generation !== observedGeneration.current) {
          viewCache.current.clear(); cancelMore(); clearMediaCache();
          // This device's own trash/restore moves the generation too; the viewer already
          // shows the result, so it stays open instead of closing under the user.
          if (!trash.recent()) setViewer(null);
          await load(state.page.view,state.page.cursor,state.page.previous,scroll.current,true,state.page.filters);
          setIndexRevision(value=>value+1);
        }
      } catch { /* Retain last committed view on transport failure; cache reuse still validates. */ }
      finally {running=false;if(active&&pendingGeneration!==null)void check();}
    };
    const changed=()=>{observedGeneration.current=null;void check();};
    const generationEvent=(event:Event)=>{const value=(event as CustomEvent<{generation?:string}>).detail?.generation;if(typeof value==='string'){pendingGeneration=value;void check();}};
    const removeVisible=onVisible(()=>{if(pendingGeneration!==null)void check();});
    window.addEventListener('lakomics-list-generation',generationEvent);
    window.addEventListener(ASSET_LIST_CHANGED_EVENT,changed);
    return()=>{active=false;controller.abort();removeVisible();window.removeEventListener('lakomics-list-generation',generationEvent);window.removeEventListener(ASSET_LIST_CHANGED_EVENT,changed);};
  },[status.configured,status.endpoint,load,cancelMore]);
  useLayoutEffect(() => {
    if (!page.version) return;
    const key = `${viewKey(page.view, page.filters)}:${page.cursor}`;
    viewCache.current.delete(key); viewCache.current.set(key,{...page,restoreScroll:scroll.current});
    if (viewCache.current.size > 4) viewCache.current.delete(viewCache.current.keys().next().value!);
    // Prefetch the next page of the same filtered query, so appended pages keep the
    // filter set rather than reverting to an unfiltered continuation.
    if (page.view.tab === 'library' && !page.view.root && page.has_more && page.next_cursor) void nextPage(page.view,page.next_cursor,page.filters).catch(() => {});
  }, [page, nextPage]);
  const append = useCallback(async () => {
    const current = latest.current.page;
    if (morePending.current || !current.has_more || !current.next_cursor || (latest.current.viewer&&latest.current.viewer.source!=='library')) return;
    morePending.current = true; setLoadingMore(true); setMoreError('');
    const request = moreGate.current.begin();
    try {
      const reload=async()=>{viewCache.current.clear(); await load(current.view,current.cursor,current.previous,scroll.current,true,current.filters);};
      let response: Page;
      // A page that carries its own generation is appended only when it was read under the
      // committed page's generation: one round trip, or none for a finished prefetch.
      const own = pageGenerations.current ? await nextPage(current.view,current.next_cursor,current.filters) : undefined;
      if (own && !own.list_generation) pageGenerations.current = false;
      if (own?.list_generation) {
        if (own.list_generation !== current.generation) {await reload();return;}
        response = own;
      } else {
        const generation=await fetchListGeneration(request.signal);
        // A server without the endpoint keeps the pre-existing append behavior: pages are
        // appended without a generation guard rather than blocking the load.
        if (generation !== null && generation !== current.generation) {await reload();return;}
        response = await nextPage(current.view,current.next_cursor,current.filters);
        if (generation !== null) {
          const after=await fetchListGeneration(request.signal);
          if (after !== null && after !== generation) {await reload();return;}
        }
      }
      if (!moreGate.current.current(request.id) || latest.current.page.version !== current.version) return;
      // Every appended page is validated, not only the first: a server that dropped the
      // contract part-way through a walk would otherwise splice unfiltered rows into a
      // filtered list, which is the same defect as accepting it on the first page.
      if (hasActiveFilters(current.filters) && response.filter_version !== ASSET_FILTER_VERSION)
        throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      // Do not advance forever if a broken server returns its input cursor.
      if (response.has_more && response.next_cursor === current.next_cursor) throw new Error('목록 커서가 진행되지 않습니다.');
      prefetched.current = null;
      setViewer(viewer=>viewer?.source==='library'?{...viewer,items:[...viewer.items,...response.items.filter(item=>!viewer.items.some(old=>old.id===item.id)&&!trash.hiddenRef.current.has(item.id))]}:viewer);
      setPage(previous => {
        const seen = new Set(previous.items.map(item => item.id));
        return {...previous, items:[...previous.items,...response.items.filter(item => !seen.has(item.id))],
          has_more:response.has_more, next_cursor:response.next_cursor};
      });
    } catch (reason) {if (moreGate.current.current(request.id)) setMoreError(errorText(reason));}
    finally {if (moreGate.current.current(request.id)) {morePending.current = false; setLoadingMore(false);}}
  }, [nextPage,load]);
  const nearEnd = useCallback(() => {
    // The committed page is what supplies the cursor, so a failed filter change must not be
    // continued: appending would extend the previous result set under the new filters.
    if (busy || loadingMore || moreError || !sameFilters(latest.current.page.filters, filters)) return;
    void append();
  }, [busy,loadingMore,moreError,filters,append]);
  const thumbnailReady = useCallback((asset:Asset) => {
    setPage(current => ({...current,items:current.items.map(item => item.id === asset.id ? {...item,...asset} : item)}));
  }, []);
  /** Apply a server-confirmed exclusion: only that character boundary is invalidated. */
  const characterExcluded = useCallback(() => {
    viewCache.current.clear(); cancelMore(); observedGeneration.current = null;
    setViewer(null); setIndexRevision(value => value + 1);
    const state = latest.current.page;
    void load(state.view, state.cursor, state.previous, scroll.current, true, state.filters);
  }, [load, cancelMore]);
  const refreshSecondary = useCallback(async () => {
    const request = secondaryGate.current.begin(); setSecondaryError('');
    try {
      const result = await api<{captures: Asset[]}>('/v1/captures/pending?limit=40', request.signal);
      if (secondaryGate.current.current(request.id)) setCaptures(result.captures.map(item => ({...item,pending:true})).reverse());
    } catch {
      if (secondaryGate.current.current(request.id) && !request.signal.aborted) setSecondaryError('처리 대기 목록을 갱신하지 못했습니다.');
    }
  }, []);
  // Warm every thumbnail into the native cache while the app is open on an unmetered link.
  useEffect(() => status.configured ? startThumbnailWarm(status.endpoint) : undefined, [status.configured, status.endpoint]);
  useEffect(() => { void native<Status>('status').then(next=>setStatus(adoptConnection(next))).catch(reason => setError(errorText(reason))).finally(() => setChecking(false)); return () => {gate.current.cancel(); secondaryGate.current.cancel();}; }, []);
  useEffect(() => {
    if (!status.configured) return;
    setRecentFolders(readRecentFolders(status.endpoint));
    const controller = new AbortController(); setIndexError('');
    void api<{items:Classification[]}>('/v1/library/classifications', controller.signal).then(result => setClassifications(result.items)).catch(reason => {if (!controller.signal.aborted) setIndexError(errorText(reason));});
    // A root card can be tapped before this passive startup effect runs.
    // Do not overwrite that newer navigation with the initial root read.
    if(lastIntent.current.view.root) void load(LIBRARY);
    return () => {controller.abort(); gate.current.cancel(); secondaryGate.current.cancel(); moreGate.current.cancel(); prefetched.current?.controller.abort();};
  }, [status, load]);
  useEffect(() => { if (page.version && page.view.tab === 'home' && !page.cursor) void refreshSecondary(); return () => secondaryGate.current.cancel(); }, [page.version, page.view.tab, page.cursor, refreshSecondary]);
  const refresh = useCallback(() => {
    const state = latest.current;
    if (!state.status.configured || state.viewer || state.settings) return;
    viewCache.current.clear();
    setIndexRevision(value=>value+1);
    void load(state.page.view, state.page.cursor, state.page.previous, 0, true, state.page.filters);
  }, [load]);
  // Leaves the character boundary for the actual context it was opened from, falling back to
  // the Library root when nothing was committed beforehand. Deliberately not routed through the global
  // back chain, which would close an unrelated open surface first.
  const restoreBeforeCharacter = useCallback(() => {
    const saved = beforeCharacter.current; beforeCharacter.current = undefined;
    setArea('assets');
    if (saved) void load(saved.view, saved.cursor, saved.previous, saved.scroll, false, saved.filters);
    else void load(LIBRARY, null, [], 0, false, EMPTY_FILTERS);
  }, [load]);
  const goParent=useCallback(()=>{
    const current=latest.current.page.view;
    if(current.album){
      const tree=albumTreeRef.current;
      const ancestors=tree?albumAncestors(tree.albums,current.album.id):[];
      const parent=ancestors[ancestors.length-1];
      setLibrarySegment('albums');
      void load(parent&&tree?albumView(tree,parent):LIBRARY,null,[],0,false,EMPTY_FILTERS);
      return;
    }
    const entry=entriesRef.current.find(item=>item.id===current.classification);
    const parent=entriesRef.current.find(item=>item.id===entry?.parent_id);
    if(parent?.characterNode){
      const above=entriesRef.current.find(item=>item.id===parent.parent_id);
      beforeCharacter.current={view:above?entryView(above):LIBRARY,cursor:null,previous:[],scroll:0,filters:EMPTY_FILTERS};
      setCharactersVisited(true);setCharacterEntry(value=>value+1);
    }
    void load(parent?entryView(parent):LIBRARY,null,[],0,false,EMPTY_FILTERS);
  },[load]);
  // Leaves Collections, Notes or Catalog for the assets area (Home when that is where it was opened
  // from), forgetting the Home origin.
  const returnHome=useCallback(()=>{setHomeOrigin(null);setArea('assets');},[]);
  const forgetHome=useCallback(()=>setHomeOrigin(null),[]);
  // Back at the Library entry opened from Home (or at the Library root) goes back to Home with
  // Home's scroll offset instead of stepping up the hierarchy or leaving the app.
  const libraryHome=useCallback(()=>{
    const origin=homeOriginRef.current, view=latest.current.page.view;
    if(origin?.area!=='library'||(viewKey(view)!==origin.entry&&!view.root))return false;
    homeRestore.current=origin.scroll; setHomeOrigin(null); setArea('assets');
    void load(HOME, null, [], 0, false, EMPTY_FILTERS);
    return true;
  },[load]);
  const exitCharacters=useCallback(()=>{if(!libraryHome())restoreBeforeCharacter();},[libraryHome,restoreBeforeCharacter]);
  useEffect(() => {
    const visible = () => {if (document.visibilityState === 'visible' && latest.current.status.configured && latest.current.page.view.tab === 'home') void refreshSecondary();};
    const back = () => {
      const state = latest.current;
      // The FAULT game covers everything, so it closes before any surface beneath it.
      if (state.vaultOpen) {if(!vaultBack.current?.())setVaultOpen(false);}
      else if (state.fault) setFault(null);
      else if (state.exchangeOpen) {if (!exchangeBack.current?.()) setExchangeOpen(false);}
      // The review screen covers the app too; it closes its zoom first, then itself.
      else if (state.review) {if (!reviewBack.current?.()) setReview(null);}
      else if (state.similarity) {if (!similarityBack.current?.()) setSimilarity(false);}
      else if (trash.backRef.current?.()) { /* The trash browser consumed back. */ }
      // The filter dialog is the innermost surface, so it closes first and consumes the press.
      else if (state.filtersOpen) setFiltersOpen(null);
      else if (state.viewSettings) setViewSettings(false);
      else if (state.settings) setSettings(false);
      else if (state.viewer && viewerBack.current?.()) { /* Viewer overlay consumed back. */ }
      else if (state.viewer) setViewer(null);
      // An open top-bar search closes (and clears) before Back navigates anywhere.
      else if (closeVisibleSearch()) { /* The search bar consumed back. */ }
      else if (state.area === 'collections') {if (!collectionBack.current?.()) returnHome();}
      else if (state.area === 'notes') {if (!notesBack.current?.()) returnHome();}
      else if (state.area === 'catalog') {if (!catalogBack.current?.()) returnHome();}
      else if (state.page.view.characters && characterBack.current?.()) {  }
      else if (state.page.view.characters) {if (!libraryHome()) restoreBeforeCharacter();}
      // Clear a committed or failed narrowing before stepping up the hierarchy.
      else if (hasActiveFilters(state.page.filters)||hasActiveFilters(lastIntent.current.filters)) void load(state.page.view, null, [], 0, true, EMPTY_FILTERS);
      else if (libraryHome()) { /* The Library entry opened from Home returned there. */ }
      else if (!state.page.view.root) goParent();
      else void native('finish').catch(() => {});
    };
    const removeVisible=onVisible(visible); window.addEventListener('lakomics-back', back);
    return () => {removeVisible(); window.removeEventListener('lakomics-back', back);};
  }, [refreshSecondary, load, restoreBeforeCharacter,goParent,returnHome,libraryHome]);
  useEffect(() => {
    const folderId=page.view.classification??(page.view.characterNode?entries.find(entry=>entry.characterNode===page.view.characterNode)?.id:undefined);
    if (!page.version || !folderId) return;
    setRecentFolders(previous => {const ids = rememberFolder(previous,folderId); store(RECENT_FOLDERS_KEY,{scope:status.endpoint,ids}); return ids;});
  },[page.version,page.view.classification,page.view.characterNode,status.endpoint]);
  const select = (requested: View) => {
    const entry=entries.find(item=>item.id===requested.classification);
    const view=entry?.characterNode?entryView(entry):requested;
    if(view.album)setLibrarySegment('albums');
    // Remember the real browsing context only when entering the character boundary, and only
    // from a non-character view. Re-selecting another folder inside it keeps the original
    // context instead of stacking a synthetic character parent.
    if(view.characters && !latest.current.page.view.characters && latest.current.page.version)
      beforeCharacter.current = latest.current.page.view.tab==='library' ? {view:latest.current.page.view,cursor:latest.current.page.cursor,previous:latest.current.page.previous,scroll:scroll.current,filters:latest.current.page.filters} : {view:LIBRARY,cursor:null,previous:[],scroll:0,filters:EMPTY_FILTERS};
    // An explicit folder selection starts unfiltered. Tab restoration uses the saved
    // scope and its own filters instead of this entry path.
    setArea('assets');
    if(view.characters){setCharactersVisited(true);setCharacterEntry(value=>value+1);}
    void load(view, null, [], 0, false, EMPTY_FILTERS);
  };
  /**
   * Commit one filter change as a normal navigation.
   *
   * The cursor and scroll are dropped because a cursor minted under the old filter set
   * would resume at an arbitrary position, and the old page's offsets mean nothing in a
   * narrower result set. The choice is recorded as `attempted` immediately so the dialog and
   * a retry keep it, but the committed filter set lives on the page and changes only when a
   * request succeeds. That separation is what keeps the heading, the gallery identity and the
   * append cursor all describing the page actually on screen.
   */
  const applyFilters = (next: AssetFiltersValue) => {
    const state = latest.current;
    if (sameFilters(next, state.page.filters)) {gate.current.cancel();cancelMore();setBusy(false);setError('');setFilterNotice('');setFilters(next);setFiltersOpen(null);lastIntent.current={view:state.page.view,cursor:state.page.cursor,previous:state.page.previous,filters:next};return;}
    setFiltersOpen(null); setFilters(next);
    // Home and Revisit are not filterable, so a filter change can only originate from a
    // filterable Library scope and is committed against that same scope.
    void load(state.page.view, null, [], 0, true, next);
  };
  /** Retry the attempted set, which is what the last failed request used. */
  const retryFilters = () => {
    const state = latest.current;
    if (sameFilters(filters, state.page.filters)) return;
    void load(state.page.view, null, [], 0, true, filters);
  };
  const clearFilters = () => applyFilters({...EMPTY_FILTERS});
  const openRoot=()=>{setArea('assets');void load(LIBRARY,null,[],0,false,EMPTY_FILTERS);};
  const retainAssets = () => {
    const state = latest.current, current = state.page, intent = lastIntent.current;
    // A retained tab is also a navigation intent: a delayed replacement must not win later.
    if (viewKey(intent.view,intent.filters) !== viewKey(current.view,current.filters) || intent.cursor !== current.cursor) {
      gate.current.cancel(); cancelMore(); setBusy(false); setError(''); setFilterNotice(''); setFilters(current.filters);
      lastIntent.current = {view:current.view,cursor:current.cursor,previous:current.previous,filters:current.filters};
    }
    // Older servers have no change signal, so returning still needs a fresh read.
    if (state.area !== 'assets' && current.generation === null)
      void load(current.view,current.cursor,current.previous,scroll.current,true,current.filters);
  };
  // Reselecting Library goes to its root; returning from another tab keeps its position.
  const openLibrary = () => {
    setArea('assets');
    if(latest.current.page.view.tab === 'library') {if(latest.current.area==='assets')openRoot();else retainAssets();return;}
    const saved=lastLibrary.current;
    if(saved) void load(saved.view,saved.cursor,saved.previous,saved.scroll,false,saved.filters);
    else openRoot();
  };
  const openCollections = (place:CollectionsPlace) => {
    setCollectionsVisited(true); setArea('collections');
    setCollectionRequest(current => ({...place,key:(current?.key ?? 0)+1}));
  };
  const openHome = () => {
    setHomeOrigin(null); homeRestore.current = null;
    setArea('assets');
    if (latest.current.page.view.tab === 'home') retainAssets();
    else select(HOME);
  };
  // Records a Library entry opened from Home, with Home's scroll offset (Home unmounts there).
  const fromHome = (entry:View) => {
    const top = appRef.current?.querySelector<HTMLElement>('.home-scroll')?.scrollTop ?? 0;
    homeRestore.current = null; setHomeOrigin({area:'library',entry:viewKey(entry),scroll:top});
  };
  const openCurrent = (index: number) => {
    // Opening the still-visible gallery cancels its uncommitted replacement.
    gate.current.cancel(); cancelMore(); setBusy(false); setError('');
    lastIntent.current = {view:page.view,cursor:page.cursor,previous:page.previous,filters:page.filters};
    setViewer({items:visibleItems,index,source:'library'});
  };
  const updateStatus = (next: Status) => {
    gate.current.cancel(); secondaryGate.current.cancel(); cancelMore(); viewCache.current.clear(); observedGeneration.current=null; clearMediaCache();
    setViewer(null); setReview(null); setSimilarity(false); setExchangeOpen(false); setViewSettings(false); setFiltersOpen(null); setFilterVersion(null); setFilterNotice(''); setFilters({...EMPTY_FILTERS}); setCharacterIndex(undefined); setClassifications([]); setLibrarySegment('folders'); setCaptures(null); setCollectionRequest(null); setNoteRequest(null); setDuplicateRequest(0); resetReleaseStore();
    lastLibrary.current = undefined; beforeCharacter.current = undefined; lastIntent.current={view:LIBRARY,cursor:null,previous:[],filters:EMPTY_FILTERS}; setRecentFolders([]);
    try {localStorage.removeItem(RECENT_FOLDERS_KEY);} catch { /* optional */ }
    try {localStorage.removeItem('lakomics.mobile.position');} catch { /* optional */ }
    setPage({generation:null,items:[],has_more:false,next_cursor:null,view:LIBRARY,cursor:null,previous:[],version:0,restoreScroll:0,filters:{...EMPTY_FILTERS}});
    setHomeOrigin(null); homeRestore.current = null;
    setArea('assets'); setNotesVisited(false); setCollectionsVisited(false); setCatalogVisited(false); setCharactersVisited(false);
    setStatus(adoptConnection(next));
  };
  usePublicationCheck(status.configured&&area==='assets'&&!settings&&!viewer,'/v1/library/characters/status',characterIndex?.revision,(_reply,changed)=>{if(changed)setIndexRevision(n=>n+1);});
  useEffect(()=>{
    if(!status.configured)return;const controller=new AbortController();
    // Probed beside the existing index reads so a scope never has to discover the missing
    // contract from a failed page. A `null` result means "cannot filter", not "no error".
    void fetchAssetFilterVersion(controller.signal).then(value=>{if(!controller.signal.aborted)setFilterVersion(value);}).catch(()=>{if(!controller.signal.aborted)setFilterVersion(null);});
    void api<CharacterIndex>('/v1/library/characters',controller.signal).then(value=>{if(!controller.signal.aborted&&validCharacterIndex(value))setCharacterIndex(value);}).catch(()=>{});
    void api<{items:Classification[]}>('/v1/library/classifications',controller.signal).then(value=>{if(!controller.signal.aborted)setClassifications(value.items);}).catch(()=>{});
    return()=>controller.abort();
  },[status.endpoint,status.configured,indexRevision]);
  const filterable = area==='assets' && page.view.tab==='library' && !page.view.root && !page.view.characters && !page.view.revisit;
  const currentEntry=entries.find(item=>item.id===page.view.classification);
  const childEntries=entries.filter(item=>item.parent_id===currentEntry?.id);
  const currentAlbum=albumTree?.albums.find(album=>album.id===page.view.album?.id);
  const albumRoot=()=>{setLibrarySegment('albums');openRoot();};
  const crumbs=page.view.album ? [{id:'root',name:'라이브러리',onSelect:albumRoot},{id:'albums',name:'앨범',onSelect:albumRoot},...(albumTree?albumAncestors(albumTree.albums,page.view.album.id).map(album=>({id:`album:${album.id}`,name:album.name,onSelect:()=>select(albumView(albumTree,album))})):[])] : [{id:'root',name:'라이브러리',onSelect:openRoot},...ancestorsOf(entries,currentEntry?.id).map(entry=>({id:entry.id,name:entry.name,onSelect:()=>select(entryView(entry))}))];
  const seriesNode=characterIndex?.nodes.find(node=>node.id===focusedCharacter);
  const seriesEntry=entries.find(item=>item.id===seriesNode?.seriesId);
  const characterCrumbs=[{id:'root',name:'라이브러리',onSelect:openRoot},...ancestorsOf(entries,seriesEntry?.id).map(entry=>({id:entry.id,name:entry.name,onSelect:()=>select(entryView(entry))}))];
  const paused=area!=='assets'||settings||!!viewer||!!fault||!!review||similarity||trash.open||exchangeOpen;
  const reviewLibrary=characterReviewLibrary(characterIndex);
  const closeReview=()=>{setReview(null);setReviewClosed(n=>n+1);};
  const intro=<>{filterable&&!sameFilters(filters,page.filters)&&<p className="hint">필터 적용 대기</p>}{!!childEntries.length&&<section className="folder-intro"><h2>폴더 {childEntries.length}</h2><FolderCards strip items={childEntries} entries={entries} characters={characterIndex} paused={paused} revision={indexRevision+1} onSelect={select}/></section>}{page.view.album&&albumTree&&albumTree.albums.some(album=>album.parentId===page.view.album?.id&&album.id!==page.view.album?.id)&&<section className="folder-intro"><h2>하위 앨범</h2><Albums key={`${albumTree.libraryId}:${albumTree.epoch}:${page.view.album.id}`} tree={albumTree} parentId={page.view.album.id} paused={paused} revision={indexRevision+1} onSelect={select}/></section>}{!page.items.length&&<div className="empty-state"><RectangleStackIcon/><h2>{busy?'라이브러리를 불러오고 있습니다':hasActiveFilters(page.filters)?'조건에 맞는 자산이 없습니다':'아직 자산이 없습니다'}</h2></div>}</>;
  // A drill-down level is a committed Library place; its depth decides the entrance direction.
  // Home, other tabs and filter changes are not levels, so they never slide.
  const levelDepth=(view:View)=>{
    if(view.root)return 0;
    if(view.album)return 1+(albumTree?albumAncestors(albumTree.albums,view.album.id).length:0);
    const entry=view.characters?entries.find(item=>item.characterNode===view.characterNode):currentEntry;
    return 1+(entry?ancestorsOf(entries,entry.id).length:0);
  };
  const libraryLevel=status.configured&&area==='assets'&&page.view.tab==='library'&&page.version>0;
  useLevelMotion(mainRef,libraryLevel?viewKey(page.view):null,libraryLevel?levelDepth(page.view):0);
  // A committed tab switch settles the new tab's content under its still bar.
  useTabMotion(bodyRef,area==='assets'?page.view.tab:area);
  // Back from a Library entry opened from Home puts Home's scroll offset back once it is shown.
  // Home's cards render from their kept snapshot first, so a second try covers late growth.
  useLayoutEffect(()=>{
    const top=homeRestore.current;
    if(top===null||area!=='assets'||page.view.tab!=='home')return;
    homeRestore.current=null;
    const apply=()=>{const element=appRef.current?.querySelector<HTMLElement>('.home-scroll');if(element&&element.scrollTop<top)element.scrollTop=top;};
    apply();const frame=requestAnimationFrame(apply);
    return()=>cancelAnimationFrame(frame);
  },[area,page.view.tab,page.version]);
  // Retained tabs lose their scrollers' offsets while hidden; put them back on return.
  useScrollMemory(appRef,`${area}:${page.view.root?'root':page.view.characters?'characters':page.view.tab}`);
  const rootShown=area==='assets'&&!!page.view.root&&!page.view.characters;
  // While hidden, the root keeps the covers and count of its own last page, not the open folder's.
  const rootPage=useRef<{items:Asset[];total?:number}>({items:[]});
  if(page.view.root)rootPage.current={items:visibleItems,total:page.version&&!page.has_more?visibleItems.length:undefined};
  const demo = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
  return <div className="mobile-app" ref={appRef}>
    {/* Every configured area except Home draws its own title bar. */}
    {!(status.configured&&(area!=='assets'||page.view.tab==='library'))&&<header className="app-header"><div className="home-brand"><Mark/>{!status.configured&&<span>LAKOMICS</span>}</div><div id="context-location"/><div className="header-actions"><div id="context-tools"/>{demo&&<span className="demo-label">디자인 미리보기</span>}{status.configured&&area==='assets'&&page.view.tab==='home'&&<span className="exchange-entry"><IconButton label={exchange.unseen?`보내기/받기, 새 파일 ${exchange.unseen}개`:'보내기/받기'} icon={ArrowsUpDownIcon} onClick={()=>setExchangeOpen(true)}/>{exchange.unseen>0&&<span className="exchange-badge numeric" aria-hidden="true">{exchange.unseen>99?'99+':exchange.unseen}</span>}</span>}{area==='assets'&&page.view.tab==='home'&&<IconButton label="연결 및 설정" icon={AdjustmentsHorizontalIcon} onClick={()=>setSettings(true)}/>}</div><BarProgress label={status.configured&&area==='assets'&&page.view.tab==='home'&&busy&&'목록 불러오는 중'}/></header>}
    {status.configured ? <div className="app-body" ref={bodyRef} data-active-tab={area==='assets'?page.view.tab:area}>
      <main className="library-main" ref={mainRef} style={{display:area!=='assets'?'none':undefined}}>
        {page.view.tab==='home'&&<HeaderTools active={area==='assets'} target="context-location"><div className="gallery-heading"><h2>{page.view.title}</h2><IconButton label="새로고침" icon={ArrowPathIcon} disabled={busy} onClick={refresh}/></div></HeaderTools>}
        {page.view.tab==='library'&&!page.view.root&&!page.view.characters&&<LibraryHeader title={page.view.title} count={hasActiveFilters(page.filters)?`${page.items.length}${page.has_more?'+':''}`:currentEntry?.asset_count??currentAlbum?.assetCount??`${page.items.length}${page.has_more?'+':''}`} crumbs={crumbs} onBack={()=>window.dispatchEvent(new Event('lakomics-back'))} loading={busy&&'목록 불러오는 중'} onOptions={()=>{setOptionsScope(page.view.album?page.items:[]);setViewSettings(true);}} changed={activeFilterCount(page.filters)+(density!==DEFAULT_DENSITY?1:0)}/>}
        {/* The Library root stays mounted while a folder is open, so going back shows its folders,
            covers and position at once instead of rebuilding them. */}
        <LibraryRoot key={`root:${status.endpoint}`} active={rootShown} entries={entries} characters={characterIndex} items={rootPage.current.items} total={rootPage.current.total} onTrash={trash.available?()=>trash.setOpen(true):undefined} paused={paused||!rootShown} busy={busy} revision={indexRevision+1} onSelect={select} onRefresh={refresh} albumTree={albumTree} albumError={albumError} segment={librarySegment} onSegment={setLibrarySegment} restoreScroll={page.restoreScroll} onScroll={top=>{scroll.current=top;}} review={reviewLibrary?{enabled:true,refreshKey:`${characterIndex?.revision}:${reviewClosed}`,onOpen:()=>setReview({target:null})}:undefined} similarity={{enabled:true,refreshKey:similarityClosed,onOpen:()=>setSimilarity(true)}}/>
        {page.view.characters || page.view.root ? null : page.view.tab === 'home' ? <Home items={visibleItems} hasMore={page.has_more} captures={captures} busy={busy} paused={paused} secondaryError={secondaryError} scope={status.endpoint} exchange={exchange.snapshot} characters={characterIndex}
          review={{enabled:!!reviewLibrary,refreshKey:`${characterIndex?.revision}:${reviewClosed}`}} similarityKey={similarityClosed}
          onRecent={() => {fromHome({tab:'library',title:'최근 저장'});select({tab:'library',title:'최근 저장'});}} onLibrary={() => {fromHome(lastLibrary.current?.view ?? LIBRARY);openLibrary();}} onRefresh={refresh}
          onNotes={id => {setHomeOrigin(id ? {area:'notes'} : null);setNotesVisited(true);setArea('notes');if (id) setNoteRequest(current => ({id,key:(current?.key ?? 0)+1}));}}
          onPending={() => {if (captures?.length) setViewer({items:captures,index:0,pending:true});}}
          onReview={() => setReview({target:null})} onSimilarity={() => setSimilarity(true)} onExchange={() => setExchangeOpen(true)} onSettings={() => setSettings(true)}
          onDuplicates={() => {setHomeOrigin({area:'catalog'});setCatalogVisited(true);setArea('catalog');setDuplicateRequest(n => n+1);}}
          onReleases={() => {setHomeOrigin({area:'collections'});openCollections({kind:'releases'});}} onWork={id => {setHomeOrigin({area:'collections'});openCollections({kind:'work',id});}}/> : <>
        <Gallery items={visibleItems} intro={intro} onRefresh={refresh} busy={busy} density={density} identity={`${viewKey(page.view,page.filters)}:${page.cursor}:${page.version}`} restoreScroll={page.restoreScroll} onScroll={top=>{scroll.current=top;}} onOpen={openCurrent} onReady={thumbnailReady} onNearEnd={nearEnd} paused={paused}/>
        <LoadingLine label={loadingMore&&'다음 자산을 불러오는 중'} className="is-bottom"/>
        </>}
        {charactersVisited && <CharacterBrowser hostBusy={busy} optionsHost={optionsHost} onCloseOptions={()=>setViewSettings(false)} entryKey={characterEntry} crumbs={characterCrumbs} onOptions={items=>{setOptionsScope(items);setViewSettings(true);}} onLocation={setFocusedCharacter} initialNode={page.view.characterNode} key={status.endpoint} active={area==='assets'&&!!page.view.characters} paused={settings||!!viewer||!!fault||!!review} density={density} refreshKey={page.view.characters?page.version:0} onOpen={(items,index,character)=>setViewer({items,index,character})} backRef={characterBack} onExit={exitCharacters} review={reviewLibrary?{enabled:true,refreshKey:`${characterIndex?.revision}:${reviewClosed}`,onOpen:target=>setReview({target})}:undefined}/>}
        <div className="floating-notices">
          {indexError&&rootShown&&<p className="error-message">{indexError}</p>}
          {filterNotice && <div className="inline-error" role="alert"><span>{filterNotice}</span><Button variant="ghost" onClick={retryFilters}>다시 시도</Button><Button variant="ghost" onClick={clearFilters}>필터 해제</Button></div>}
          {error && <div className="inline-error" role="alert"><span>{error}</span><Button onClick={() => {const intent = lastIntent.current; void load(intent.view,intent.cursor,intent.previous,0,false,intent.filters);}}>다시 시도</Button></div>}
          {moreError && !page.view.root && !page.view.characters && page.view.tab!=='home' && <div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" disabled={busy || loadingMore} onClick={() => {void append();}}>다시 시도</Button></div>}
        </div>
      </main>
      {collectionsVisited && <Collections key={`collections:${status.endpoint}`} active={area==='collections'} paused={settings || !!viewer} backRef={collectionBack} request={collectionRequest} onReturnHome={homeOrigin?.area==='collections'?returnHome:undefined}/>}
      {notesVisited && <Notes key={`notes:${status.endpoint}`} active={area==='notes'&&!settings} backRef={notesBack} request={noteRequest} onReturnHome={homeOrigin?.area==='notes'?returnHome:undefined} onHomeEntryGone={homeOrigin?.area==='notes'?forgetHome:undefined}/>}
      {catalogVisited && <Catalog key={`catalog:${status.endpoint}`} endpoint={status.endpoint} active={area==='catalog'} paused={settings || !!viewer} backRef={catalogBack} openDuplicates={duplicateRequest} onReturnHome={homeOrigin?.area==='catalog'?returnHome:undefined}/>}
    </div> : <main className="welcome"><Mark/><span className="eyebrow">YOUR ARCHIVE, WITH YOU</span><h1>어디서든,<br/>나의 라이브러리.</h1><p>보관한 이미지와 영상을 감상하고,<br/>다른 앱에 첨부할 때도 바로 찾아보세요.</p><Button variant="primary" disabled={checking} onClick={() => setSettings(true)}>{checking ? '연결 확인 중' : '라이브러리 연결'}<ChevronRightIcon/></Button>{error && <p className="error-message" role="alert">{error}</p>}<span className="welcome-footer">LAKOMICS <span>／</span> MOBILE</span></main>}
    {status.configured && <nav className="bottom-nav" aria-label="주요 탐색"><button className={area==='assets' && page.view.tab === 'home' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'home' ? 'page' : undefined} onClick={openHome}><HomeIcon/><span>Home</span></button><button className={area==='assets' && page.view.tab === 'library' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'library' ? 'page' : undefined} onClick={()=>{setHomeOrigin(null);openLibrary();}}><PhotoIcon aria-hidden="true"/><span>Library</span></button><button className={area==='collections'?'active':''} aria-current={area==='collections'?'page':undefined} onClick={()=>{setHomeOrigin(null);setCollectionsVisited(true);setArea('collections');}}><RectangleStackIcon/><span>Collections</span></button><button className={area==='catalog'?'active':''} aria-current={area==='catalog'?'page':undefined} onClick={()=>{setHomeOrigin(null);setCatalogVisited(true);setArea('catalog');}}><BookOpenIcon aria-hidden="true"/><span>Catalog</span></button><button className={area==='notes'?'active':''} aria-current={area==='notes'?'page':undefined} onClick={()=>{setHomeOrigin(null);setNotesVisited(true);setArea('notes');}}><PencilSquareIcon aria-hidden="true"/><span>Notes</span></button></nav>}
    {viewSettings&&<BottomSheet title="보기 옵션" onClose={()=>setViewSettings(false)}>{/* Filters first: a chip closes this sheet and opens its own choice sheet (never nested). */}{filterable&&!page.view.characters&&<><p className="view-options-label">필터</p><FilterChips sheet={false} value={filters} applied={page.filters} onChange={applyFilters} open={null} onOpen={group=>{setViewSettings(false);setFiltersOpen(group);}}/></>}<div className="view-options-host" ref={setOptionsHost}/><StepSlider className="view-options-density" label="썸네일 크기" count={DENSITIES.length} index={densityIndex(density)} defaultIndex={densityIndex(DEFAULT_DENSITY)} valueText={index=>DENSITIES[index]} onChange={index=>{const next=densityOf(index);setDensity(next);store('lakomics.mobile.density',next);}}/>{faultCandidates(optionsScope).length>0&&<button className="sheet-option" onClick={()=>{setViewSettings(false);setFault(optionsScope);}}>FAULT로 플레이<PlayIcon aria-hidden="true" width={18} height={18}/></button>}</BottomSheet>}
    {filterable&&<FilterChips row={false} value={filters} applied={page.filters} onChange={applyFilters} open={filtersOpen} onOpen={setFiltersOpen}/>}
    {vaultOpen && <PrivateVault density={density} onClose={()=>setVaultOpen(false)} backRef={vaultBack}/>}
    {settings && <Settings onOpenVault={()=>{setSettings(false);setVaultOpen(true);}} onCacheCleared={() => {clearMediaCache(); resetWarmProgress(); viewCache.current.clear(); setPage(current => ({...current,items:current.items.map(({preview,...asset}) => asset)}));}} status={status} onStatus={updateStatus} onClose={() => setSettings(false)}/>}
    {fault && <FaultGame items={fault} onClose={() => setFault(null)}/>}
    {similarity && <SimilarityReview backRef={similarityBack} onClose={()=>{setSimilarity(false);setSimilarityClosed(n=>n+1);}}/>}
    {review && reviewLibrary && <CharacterReview key={review.target?.id??'all'} libraryId={reviewLibrary} target={review.target} backRef={reviewBack} onClose={closeReview}/>}
    {viewer && <Viewer onNearEnd={viewer.source==='library'?nearEnd:undefined} backRef={viewerBack} endpoint={status.endpoint} character={viewer.character} reviewLibrary={reviewLibrary} onCharacterExcluded={characterExcluded} items={viewer.items} index={viewer.index} onIndex={index => {setViewer({...viewer,index});}} onClose={() => setViewer(null)} onTrash={trash.available&&!viewer.pending?asset=>{void trash.trash(asset,viewer.index);}:undefined} trashNotice={trash.snackbar}/>}
    {trash.open && <LibraryTrash key={status.endpoint} backRef={trash.backRef} known={trash.known} onRestored={trash.restored} onClose={() => trash.setOpen(false)}/>}
    {!viewer && trash.snackbar}
    {exchangeOpen && status.configured && <Exchange snapshot={exchange.snapshot} onSnapshot={exchange.setSnapshot} backRef={exchangeBack} onClose={()=>setExchangeOpen(false)}/>}
    {exchange.toast && status.configured && !viewer && !fault && !vaultOpen && <div className="exchange-toast" role="status" key={exchange.toast.key}><span>{exchange.toast.text}</span><Button variant="ghost" onClick={()=>{exchange.dismissToast();setExchangeOpen(true);}}>보기</Button></div>}
  </div>;
}
