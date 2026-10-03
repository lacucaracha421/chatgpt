import {ClassificationBatchSheet} from './ClassificationBatchSheet';
import {AreaSwitch, MotionScope, viewReady} from '../src/shared/motion/AreaSwitch';
import {AssetInfoSheet} from './AssetInfoSheet';
import {FindContext,FindButton} from './FindContext';
import {FindSheet} from './FindSheet';
import {tabletFindEntries,useFindWorks,useFindNoteTitles,type FindDestination} from './findData';
import {NotesStore} from '../src/notes/store';
import {mobileNotesRequest} from './notesTransport';
import {PrivateVault} from './PrivateVault';
import {ReleaseCalendar} from './ReleaseCalendar';
import {onVisible,visibleInterval} from './useVisibleInterval';
import {fetchAssetFilterVersion, fetchListGeneration, pageGenerationOf, ASSET_LIST_CHANGED_EVENT} from './listGeneration';
import {HeaderTools} from './HeaderTools';
import {Notes} from './Notes';
import {usePublicationCheck} from './usePublicationCheck';
import {validCharacterIndex,type CharacterIndex} from './characterModel';
import {useCharacterReviewBackgroundFlush} from './useCharacterReview';
import {SimilarityReview} from './SimilarityReview';
import {LibraryTrash} from './LibraryTrash';
import {useLibraryTrash} from './useLibraryTrash';
import {useSimilarityReviewBackgroundFlush} from './useSimilarityReview';
import {useDuplicateDecisionFlush} from './CatalogDuplicates';
import type {ViewerCharacterContext} from './Viewer';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {BookOpenIcon, PhotoIcon, PencilSquareIcon, HomeIcon, RectangleStackIcon, AdjustmentsHorizontalIcon, ArrowsUpDownIcon, LockClosedIcon, ChevronRightIcon, PlayIcon, Squares2X2Icon} from '@heroicons/react/24/outline';
import {Exchange} from './Exchange';
import {useExchange} from './useExchange';
import {sendingSummary} from './homeDashboard';

import {Button, IconButton, Mark} from './ui';
import {closeVisibleShade,useSectionShade} from './SectionShade';
import {api, errorText, native} from './transport';
import {clearMediaCache} from './media';
import {resetWarmProgress, startThumbnailWarm} from './thumbnailWarm';
import {startCollectionWarm} from './collectionWarm';
import {DEFAULT_DENSITY, DENSITIES, densityIndex, densityOf, normalizePage, pagePath, RequestGate, validDensity, viewKey} from './model';
import {StepSlider} from './StepSlider';
import type {Asset, AssetFiltersValue, Classification, Page, SavedPosition, Status, View} from './types';
import {EMPTY_FILTERS, ASSET_FILTER_VERSION, ASSET_SORTS, MEDIA_SECTIONS, SORT_LABELS, hasActiveFilters, sameFilters, sortOf, type AssetSort} from './assetFilters';
import {FilterChips,type FilterGroup} from './FilterChips';
import {BarProgress,LoadingLine,TopBar,SearchButton,closeVisibleSearch} from './TopBar';
import {BottomSheet} from './BottomSheet';
import {LibraryRoot,type LibrarySegment} from './LibraryRoot';
import {AssetScopeChips} from './AssetScopeChips';
import {viewSearchChips,assetSuggestions,chipName,searchChip,addSearchChip,searchView,removeViewSearch,invalidSearchChoices,type AssetSuggestion,type AssetSearchChip} from './assetSearchModel';
import {assetSearchKey,type AssetSearchName} from '../src/assets/assetSearch';
import {AssetSearch} from './AssetSearch';
import {useLibraryArtists} from './useLibraryArtists';
import {characterPath} from './characterModel';
import {FolderCards} from './FolderCards';
import {Albums,useAlbumTree} from './Albums';
import {albumAncestors,albumPage,albumView,type AlbumAssetPage} from './albumModel';
import {LIBRARY_ROOT,mergeLibraryEntries,ancestorsOf,entryView} from './libraryModel';
import './library.css';
import {Gallery} from './Gallery';
import {readAssetToc, supportsAssetToc, useAssetToc, type AssetTocPage} from './assetToc';
import {AlbumBatchSheet} from './AlbumBatchSheet';
import {SelectionBar} from '../src/assets/SelectionBar';
import {Home} from './Home';
import {Collections, type CollectionsPlace, type CollectionsRequest} from './Collections';
import {resetReleaseStore} from './releaseStore';
import {useCollectionEditBackgroundFlush} from './useCollectionEdits';
import {Catalog} from './Catalog';
import {readRecentFolders, rememberFolder, RECENT_FOLDERS_KEY} from './homeModel';
import {Viewer} from './Viewer';
import {Settings} from './Settings';
import {Artists} from './Artists';
import type {LibraryArtist} from './artistsModel';
import {CharacterBrowser} from './CharacterBrowser';
import {FaultGame} from './FaultGame';
import {faultCandidates} from '../src/games/fault/host';
import {useLevelMotion,useScrollMemory} from './motion';
import {setOutboxConnection} from './outboxConnection';
import {usePrivacyMode} from './privacyMode';
/** The durable outboxes follow the connection before any screen re-renders against it. */
const adoptConnection=(next:Status)=>{setOutboxConnection(next.configured?next.endpoint:null);return next;};

const HOME: View = {tab:'home', title:'홈'};
/** How long after an edit made from the open viewer a list-generation move keeps the viewer open. */
const VIEWER_EDIT_GRACE_MS = 15_000;
const LIBRARY = LIBRARY_ROOT;
const HOME_PAGE_KEY = `${viewKey(HOME)}:null`;
function readLocalStatus(): Status {
  try {
    const raw = window.LakomicsNative?.localStatus?.();
    if (!raw) return {configured:false, endpoint:''};
    const value = JSON.parse(raw) as {configured?: unknown; endpoint?: unknown};
    if (typeof value.configured !== 'boolean' || typeof value.endpoint !== 'string') return {configured:false, endpoint:''};
    return value.configured && value.endpoint ? {configured:true, endpoint:value.endpoint} : {configured:false, endpoint:''};
  } catch { return {configured:false, endpoint:''}; }
}
async function readPage(view:View,cursor:string|null,filters:AssetFiltersValue,signal:AbortSignal):Promise<Page> {
  const path=pagePath(view,cursor,filters);
  const reply=await api<AlbumAssetPage&Page>(path,signal);
  const page=view.album ? albumPage(reply) : normalizePage(reply);
  const generation=pageGenerationOf(reply);
  return generation ? {...page,list_generation:generation} : page;
}
function store(key: string, value: unknown) { try {localStorage.setItem(key, JSON.stringify(value));} catch { /* Optional device preference. */ } }
type HomeOrigin = {area:'collections'|'notes'|'catalog'} | {area:'library';entry:string;scroll:number};
type Committed = Page & AssetTocPage & {generation:string|null; view: View; cursor: string | null; previous: (string | null)[]; version: number; restoreScroll: number; filters: AssetFiltersValue};
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
  const [librarySegment,setLibrarySegment]=useState<LibrarySegment>('folders');
  const [vaultOpen,setVaultOpen]=useState(false);
  const [vaultPresent,setVaultPresent]=useState(false),[vaultSelected,setVaultSelected]=useState(true);
  // 보내기/받기: a utility screen opened from the Home header or an arrival toast.
  const [exchangeOpen,setExchangeOpen]=useState(false);
  const exchangeBack=useRef<(()=>boolean)|null>(null);
  const [artistsOpen,setArtistsOpen]=useState(false),[artistSelection,setArtistSelection]=useState<LibraryArtist|null>(null),[calendarOpen,setCalendarOpen]=useState(false),[calendarKind,setCalendarKind]=useState<'game'|'movie'|undefined>();
  const calendarBack=useRef<(()=>boolean)|null>(null);
  const artistsBack=useRef<(()=>boolean)|null>(null);
  const vaultBack=useRef<(()=>boolean)|null>(null);
  const viewerBack = useRef<(()=>boolean)|null>(null);
  const [status, setStatus] = useState<Status>(() => adoptConnection(readLocalStatus()));
  // A saved native connection is enough to enter Home. The asynchronous status read below
  // remains authoritative and can still move the app back to the connection screen.
  const startedWithLocalConnection = useRef(status.configured);
  const [privacyMode] = usePrivacyMode();
  const [searchChips,setSearchChips]=useState<AssetSearchChip[]>([]);
  const [findOpen,setFindOpen]=useState(false),[findRetry,setFindRetry]=useState(0);
  const findStore=useMemo(()=>new NotesStore(mobileNotesRequest),[status.endpoint]);
  const findWorks=useFindWorks(findOpen&&status.configured,status.endpoint);
  const findNotes=useFindNoteTitles(findOpen&&status.configured,findStore);
  const [assetSearchOpen,setAssetSearchOpen]=useState(false),[searchNotice,setSearchNotice]=useState('');
  const [searchListsRequested,setSearchListsRequested]=useState(false);
  // Queued personal Collection edits are sent on start and on return, whatever screen is open.
  useCollectionEditBackgroundFlush(status.configured);
  // Queued character-review decisions are sent the same way, and when the network returns.
  useCharacterReviewBackgroundFlush(status.configured);
  // Similarity review decisions wait out their undo window, then go the same way.
  useSimilarityReviewBackgroundFlush(status.configured);
  // Catalog duplicate-edition decisions, likewise after their undo window.
  useDuplicateDecisionFlush(status.configured);
  const [similarity,setSimilarity]=useState(false);
  const [similarityClosed,setSimilarityClosed]=useState(0);
  const similarityBack=useRef<(()=>boolean)|null>(null);
  const [checking, setChecking] = useState(true), [settings, setSettings] = useState(false);
  const [viewSettings, setViewSettings] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // A character scope may supply local view options through this host; filters stay in its top bar.
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
  const [page, setPage] = useState<Committed>({items:[], has_more:false, next_cursor:null, view:HOME, cursor:null, previous:[], version:0, restoreScroll:0, generation:null, filters:{...EMPTY_FILTERS}});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [indexError, setIndexError] = useState('');
  const [characterIndex,setCharacterIndex]=useState<CharacterIndex>();
  const [indexRevision,setIndexRevision]=useState(0);
  const [classifications, setClassifications] = useState<Classification[]>([]);
  const [indexReady,setIndexReady]=useState(false);
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
  const [assetInfo,setAssetInfo]=useState<Asset|null>(null);
  const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set());
  const [classificationBatchIds,setClassificationBatchIds]=useState<string[]|null>(null);
  const classificationBatchBusy=useRef(false);
  const [classificationNotice,setClassificationNotice]=useState('');
  const closeClassificationBatch=useCallback(()=>{if(!classificationBatchBusy.current)setClassificationBatchIds(null);},[]);
  const [albumBatchOpen,setAlbumBatchOpen]=useState(false);
  const [albumBatchAssetIds,setAlbumBatchAssetIds]=useState<string[]>([]);
  // Library Trash: local hiding, the undo snackbar and the trash browser.
  const trash = useLibraryTrash(status.configured, status.endpoint, setViewer);
  // Likes/classification edits made from the open viewer move the list generation too; keep the viewer.
  const viewerEditAt = useRef(0);
  const exchange = useExchange(status.configured, status.endpoint, exchangeOpen);
  const visibleItems = useMemo(() => trash.hidden.size ? page.items.filter(item => !trash.hidden.has(item.id)) : page.items, [page.items, trash.hidden]);
  const [density, setDensity] = useState(() => {try {return validDensity(JSON.parse(localStorage.getItem('lakomics.mobile.density') ?? '1'));} catch {return DEFAULT_DENSITY;}});
  const entries=useMemo(()=>mergeLibraryEntries(classifications,characterIndex),[classifications,characterIndex]);
  const entriesRef=useRef(entries);entriesRef.current=entries;
  const characterIndexRef=useRef(characterIndex);characterIndexRef.current=characterIndex;
  const {tree:albumTree,error:albumError,loading:albumLoading}=useAlbumTree(status.configured&&(findOpen||(area==='assets'&&!settings&&!viewer&&page.view.tab==='library'&&(searchListsRequested||librarySegment==='albums'||!!page.view.album))),indexRevision+findRetry,status.endpoint);
  const searchArtists=useLibraryArtists(assetSearchOpen||findOpen,indexRevision,status.endpoint);
  const searchItems=useMemo(()=>assetSuggestions(entries,characterIndex,albumTree,searchArtists.artists),[entries,characterIndex,albumTree,searchArtists.artists]);
  const albumTreeRef=useRef(albumTree);albumTreeRef.current=albumTree;
  const appRef=useRef<HTMLDivElement>(null),mainRef=useRef<HTMLElement>(null);
  const scroll = useRef(0), gate = useRef(new RequestGate()), secondaryGate = useRef(new RequestGate());
  const secondaryAt = useRef(0), secondaryPending = useRef(false), capturesRef = useRef<Asset[] | null>(captures);
  capturesRef.current = captures;
  const latest = useRef({findOpen, page, viewer, settings, status, area, viewSettings, sortOpen, filtersOpen, filterVersion, fault, similarity, vaultOpen, exchangeOpen, artistsOpen, calendarOpen, selectionSize:selectedIds.size, classificationBatchOpen:!!classificationBatchIds, albumBatchOpen, assetInfo}); latest.current = {findOpen, calendarOpen, page, viewer, settings, status, area, viewSettings, sortOpen, filtersOpen, filterVersion, fault, similarity, vaultOpen, exchangeOpen, artistsOpen, selectionSize:selectedIds.size, classificationBatchOpen:!!classificationBatchIds, albumBatchOpen, assetInfo};
  const clearSelection=useCallback(()=>{setClassificationBatchIds(null);setAssetInfo(null);setSelectedIds(new Set());},[]);
  const selectAsset=useCallback((id:string)=>setSelectedIds(current=>current.has(id)?current:new Set(current).add(id)),[]);
  const toggleSelectedAsset=useCallback((id:string)=>setSelectedIds(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;}),[]);
  const openAlbumBatch=useCallback(()=>{if(!selectedIds.size)return;setAlbumBatchAssetIds([...selectedIds]);setAlbumBatchOpen(true);},[selectedIds]);
  const closeAlbumBatch=useCallback(()=>{setAlbumBatchOpen(false);setAlbumBatchAssetIds([]);},[]);
  useEffect(()=>{if(area!=='assets'&&selectedIds.size){clearSelection();if(albumBatchOpen)closeAlbumBatch();}},[albumBatchOpen,area,clearSelection,closeAlbumBatch,selectedIds]);
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
  const homePageAt = useRef(0);
  const moreGate = useRef(new RequestGate());
  const [loadingMore, setLoadingMore] = useState(false), [moreError, setMoreError] = useState('');
  const morePending = useRef(false);
  const prefetched = useRef<{path:string; controller:AbortController; promise:Promise<Page>} | null>(null);
  const cancelMore = useCallback(() => {
    moreGate.current.cancel(); prefetched.current?.controller.abort(); prefetched.current = null;
    morePending.current = false; setLoadingMore(false); setMoreError('');
  }, []);
  const recoverSearch=useCallback(async(view:View,reason:unknown,signal:AbortSignal):Promise<View|null>=>{
    if((reason as {status?:number})?.status!==422||!view.search?.length)return null;
    const invalid=await invalidSearchChoices(view.search,chip=>{
      const probe:View={tab:'library',title:'에셋',search:[chip]};
      if(chip.kind==='album')probe.album=view.album;
      if(chip.kind==='character'&&view.characterNode&&characterIndexRef.current?.revision)
        return api(characterPath(view.characterNode,'all',characterIndexRef.current.revision,null,EMPTY_FILTERS),signal);
      return api(pagePath(probe,null,EMPTY_FILTERS,1),signal);
    },signal);
    if(!invalid.length)return null;
    setSearchChips(previous=>previous.filter(chip=>!invalid.some(item=>assetSearchKey(item)===assetSearchKey(chipName(chip)))));
    setSearchNotice('사용할 수 없는 검색 조건을 지웠습니다.');
    return removeViewSearch(view,invalid);
  },[]);
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

  const load = useCallback(async (view: View, cursor: string | null = null, previous: (string | null)[] = [], restore = 0, fresh = false, nextFilters: AssetFiltersValue = EMPTY_FILTERS):Promise<boolean|void> => {
    const visible = latest.current.page;
    const placeChanged=visible.version>0&&viewKey(visible.view,visible.filters)!==viewKey(view,nextFilters);
    if(placeChanged){clearSelection();if(latest.current.albumBatchOpen)closeAlbumBatch();}
    if(visible.version) {
      viewCache.current.set(`${viewKey(visible.view,visible.filters)}:${visible.cursor}`,{...visible,restoreScroll:scroll.current});
      if (visible.view.tab === 'home') homePageAt.current = Date.now();
    }
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
      const firstGeneration = observedGeneration.current;
      const tocRequest = supportsAssetToc(view) && cursor===null ? readAssetToc(view,nextFilters,request.signal) : undefined;
      const firstRead = tocRequest ? readPage(view,cursor,nextFilters,request.signal) : undefined;
      void firstRead?.catch(()=>{});
      const key = `${viewKey(view, nextFilters)}:${cursor}`;
      let generation: string|null = null;
      let cached: Committed|undefined;
      let response: Page|undefined;
      // One round trip: a server whose pages carry their own generation needs no
      // bracketing reads. A cached candidate still asks the cheap endpoint first, since
      // only that can tell whether the cache is current without refetching the page.
      if (!synthetic && pageGenerations.current && (fresh || !viewCache.current.has(key))) {
        const reply = await (firstRead ?? readPage(view,cursor,nextFilters,request.signal));
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
        // A legacy page started before the generation probe cannot inherit a newer snapshot.
        const optimistic = firstRead && (!generation || generation===firstGeneration) ? firstRead : undefined;
        response = synthetic ? {items:[],has_more:false,next_cursor:null} : cached ?? await (optimistic ?? readPage(view,cursor,nextFilters,request.signal));
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
      setPage({ ...response, items, view, cursor, previous, restoreScroll:restored, generation, version:request.id, filters:nextFilters, tocRequest, ...(cached?.assetRanges?{assetRanges:cached.assetRanges}:{}) });
      return true;
    } catch (reason) { if (gate.current.current(request.id)) {
      const recovered=await recoverSearch(view,reason,request.signal);
      if(!gate.current.current(request.id))return;
      if(recovered){void load(recovered,null,[],0,true,nextFilters);return;}

      // The previous page stays mounted and committed on failure: an error must not
      // discard a usable gallery, and it must not leave the heading claiming filters
      // the visible page does not have.
      if (filtered && !hasActiveFilters(latest.current.page.filters)) setFilterNotice(errorText(reason));
      setError(errorText(reason));
    } }
    finally { if (gate.current.current(request.id)) setBusy(false); }
  }, [cancelMore,clearSelection,closeAlbumBatch,recoverSearch]);
  const sparse = useAssetToc(page,setPage,()=>{const current=latest.current.page;void load(current.view,null,[],0,true,current.filters);},setMoreError,async(reason,signal)=>{
    const current=latest.current.page,recovered=await recoverSearch(current.view,reason,signal);
    if(!recovered||signal.aborted||latest.current.page.version!==current.version)return false;
    void load(recovered,null,[],0,true,current.filters);return true;
  });
  useEffect(()=>{if(page.assetRanges)cancelMore();},[page.assetRanges?.toc,cancelMore]);
  useEffect(()=>{
    if(!page.assetRanges)return;
    setViewer(current=>{
      if(current?.source!=='library')return current;
      const id=current.items[current.index]?.id;
      const range=page.assetRanges?.ranges.find(range=>range.items.some(item=>item.id===id));
      const byId=new Map(visibleItems.map(item=>[item.id,item]));
      const items=range?.items.flatMap(item=>byId.has(item.id)?[byId.get(item.id)!]:[])??visibleItems,index=items.findIndex(item=>item.id===id);
      return index<0?current:{...current,items,index};
    });
  },[page.assetRanges,visibleItems]);
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
          const closeViewer = !trash.recent() && Date.now() - viewerEditAt.current > VIEWER_EDIT_GRACE_MS;
          const committed = await load(state.page.view,state.page.cursor,state.page.previous,scroll.current,true,state.page.filters);
          // Keep the viewer while the replacement list waits or fails, then swap together.
          if (active && committed && closeViewer) setViewer(current=>current===state.viewer?null:current);
          setIndexRevision(value=>value+1);
        }
      } catch { /* Retain last committed view on transport failure; cache reuse still validates. */ }
      finally {running=false;if(active&&pendingGeneration!==null)void check();}
    };
    const changed=(event:Event)=>{if((event as CustomEvent<{keepViewer?:boolean}>).detail?.keepViewer)viewerEditAt.current=Date.now();observedGeneration.current=null;void check();};
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
    if (!page.assetRanges && page.view.tab === 'library' && !page.view.root && page.has_more && page.next_cursor) void nextPage(page.view,page.next_cursor,page.filters).catch(() => {});
  }, [page, nextPage]);
  const append = useCallback(async () => {
    const current = latest.current.page;
    if(current.assetRanges && sparse) {
      if(morePending.current)return;
      const tail=latest.current.viewer?.source==='library'?latest.current.viewer.items[latest.current.viewer.items.length-1]?.id:undefined;
      const range=(tail?current.assetRanges.ranges.find(range=>range.items.some(item=>item.id===tail)):undefined)??current.assetRanges.ranges[current.assetRanges.ranges.length-1],index=range?range.startIndex+range.items.length:0;
      if(index>=current.assetRanges.toc.totalCount)return;
      morePending.current=true;setLoadingMore(true);
      const request=moreGate.current.begin();
      try {await sparse.load(index,40,request.signal);} finally {if(moreGate.current.current(request.id)){morePending.current=false;setLoadingMore(false);}}
      return;
    }
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
    } catch (reason) {if (moreGate.current.current(request.id)){const recovered=await recoverSearch(current.view,reason,request.signal);if(!moreGate.current.current(request.id))return;if(recovered)void load(recovered,null,[],0,true,current.filters);else setMoreError(errorText(reason));}}
    finally {if (moreGate.current.current(request.id)) {morePending.current = false; setLoadingMore(false);}}
  }, [nextPage,load,sparse,recoverSearch]);
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
  const refreshSecondary = useCallback(async (force = false) => {
    if (!force && capturesRef.current !== null && Date.now() - secondaryAt.current < 60_000) return;
    if (secondaryPending.current) {
      if (!force) return;
      secondaryGate.current.cancel(); secondaryPending.current = false;
    }
    secondaryPending.current = true;
    const request = secondaryGate.current.begin(); setSecondaryError('');
    try {
      const result = await api<{captures: Asset[]}>('/v1/captures/pending?limit=40', request.signal);
      if (secondaryGate.current.current(request.id)) { secondaryAt.current = Date.now(); setCaptures(result.captures.map(item => ({...item,pending:true})).reverse()); }
    } catch {
      if (secondaryGate.current.current(request.id) && !request.signal.aborted) setSecondaryError('처리 대기 목록을 갱신하지 못했습니다.');
    } finally { secondaryPending.current = false; }
  }, []);
  // Warm every thumbnail into the native cache while the app is open on an unmetered link.
  useEffect(() => status.configured ? startThumbnailWarm(status.endpoint) : undefined, [status.configured, status.endpoint]);
  useEffect(() => status.configured ? startCollectionWarm(status.endpoint) : undefined, [status.configured, status.endpoint]);
  // Home shows a vault shortcut only while the chosen USB with a vault is attached.
  const onHome=status.configured&&area==='assets'&&page.view.tab==='home'&&!vaultOpen;
  useEffect(()=>{
    if(!onHome)return;
    let live=true;
    const stop=visibleInterval(()=>{void native<{present:boolean;selected:boolean}>('vaultState').then(state=>{if(live){setVaultPresent(!!state.present);setVaultSelected(!!state.selected);}},()=>{if(live)setVaultPresent(false);});},10_000,true);
    return()=>{live=false;stop();};
  },[onHome]);
  useEffect(() => { void native<Status>('status').then(next=>setStatus(adoptConnection(next))).catch(reason => setError(errorText(reason))).finally(() => setChecking(false)); return () => {gate.current.cancel(); secondaryGate.current.cancel();}; }, []);
  useEffect(() => {
    if (!status.configured) return;
    setRecentFolders(readRecentFolders(status.endpoint));
    const controller = new AbortController(); setIndexError('');
    void api<{items:Classification[]}>('/v1/library/classifications', controller.signal).then(result => {if(!controller.signal.aborted){setClassifications(result.items);setIndexReady(true);}}).catch(reason => {if (!controller.signal.aborted) setIndexError(errorText(reason));});
    // A root card can be tapped before this passive startup effect runs.
    // Do not overwrite that newer navigation with the initial root read.
    if(lastIntent.current.view.root && !startedWithLocalConnection.current) void load(LIBRARY);
    return () => {controller.abort(); gate.current.cancel(); secondaryGate.current.cancel(); moreGate.current.cancel(); prefetched.current?.controller.abort();};
  }, [status, load]);
  useEffect(() => { if (page.version && page.view.tab === 'home' && !page.cursor) void refreshSecondary(); return () => secondaryGate.current.cancel(); }, [page.version, page.view.tab, page.cursor, refreshSecondary]);
  const refresh = useCallback(() => {
    const state = latest.current;
    if (!state.status.configured || state.viewer || state.settings) return;
    viewCache.current.clear();
    secondaryAt.current = 0;
    void refreshSecondary(true);
    setIndexRevision(value=>value+1);
    void load(state.page.view, state.page.cursor, state.page.previous, 0, true, state.page.filters);
  }, [load, refreshSecondary]);
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
  const closeArtists=useCallback(()=>{setArtistSelection(null);setArtistsOpen(false);setSearchChips([]);},[]);
  const openArtist=useCallback((artist:LibraryArtist)=>{setArtistSelection(artist);setArtistsOpen(true);},[]);
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
    const listChanged = () => {
      viewCache.current.delete(HOME_PAGE_KEY); homePageAt.current = 0; secondaryAt.current = 0;
      if (latest.current.status.configured && latest.current.page.view.tab === 'home') {
        void refreshSecondary(true);
        void load(HOME, null, [], 0, true, EMPTY_FILTERS);
      }
    };
    const back = () => {
      const state = latest.current;
      // Find consumes Back before the tab or any surface it was opened over.
      if (state.findOpen) setFindOpen(false);
      else if (state.vaultOpen) {if(!vaultBack.current?.())setVaultOpen(false);}
      else if (state.fault) setFault(null);
      else if (state.exchangeOpen) {if (!exchangeBack.current?.()) setExchangeOpen(false);}
      else if (state.similarity) {if (!similarityBack.current?.()) setSimilarity(false);}
      else if (trash.backRef.current?.()) { /* The trash browser consumed back. */ }
      // The filter dialog is the innermost surface, so it closes first and consumes the press.
      else if (state.filtersOpen) setFiltersOpen(null);
      else if (state.sortOpen) setSortOpen(false);
      else if (state.viewSettings) setViewSettings(false);
      else if (state.settings) setSettings(false);
      else if (state.assetInfo) setAssetInfo(null);
      else if (state.classificationBatchOpen) closeClassificationBatch();
      else if (state.albumBatchOpen) setAlbumBatchOpen(false);
      else if (state.selectionSize > 0) clearSelection();
      else if (state.viewer && viewerBack.current?.()) { /* Viewer overlay consumed back. */ }
      else if (state.viewer) setViewer(null);
      // An open top-bar search closes (and clears) before Back navigates anywhere.
      else if (closeVisibleSearch()) { /* The search bar consumed back. */ }
      // A section bar pulled down over a list closes before Back navigates.
      else if (closeVisibleShade()) { /* The section shade consumed back. */ }
      else if (state.calendarOpen) {if (!calendarBack.current?.()) setCalendarOpen(false);}
      else if (state.artistsOpen) {if (!artistsBack.current?.()) closeArtists();}
      else if (state.area === 'collections') {if (!collectionBack.current?.()) returnHome();}
      else if (state.area === 'notes') {if (!notesBack.current?.()) returnHome();}
      else if (state.area === 'catalog') {if (!catalogBack.current?.()) returnHome();}
      else if (state.page.view.characters && characterBack.current?.()) {  }
      else if (state.page.view.characters) {if (!libraryHome()) restoreBeforeCharacter();}
      // Clear a committed or failed narrowing before stepping up the hierarchy.
      else if (hasActiveFilters(state.page.filters)||hasActiveFilters(lastIntent.current.filters)) void load(state.page.view, null, [], scroll.current, true, EMPTY_FILTERS);
      else if (libraryHome()) { /* The Library entry opened from Home returned there. */ }
      else if (!state.page.view.root) goParent();
      else void native('finish').catch(() => {});
    };
    const removeVisible=onVisible(visible); window.addEventListener('lakomics-list-generation', listChanged); window.addEventListener('lakomics-back', back);
    return () => {removeVisible(); window.removeEventListener('lakomics-list-generation', listChanged); window.removeEventListener('lakomics-back', back);};
  }, [refreshSecondary, load, restoreBeforeCharacter,goParent,returnHome,libraryHome,closeArtists,clearSelection,closeClassificationBatch]);
  useEffect(() => {
    const folderId=page.view.classification??(page.view.characterNode?entries.find(entry=>entry.characterNode===page.view.characterNode)?.id:undefined);
    if (!page.version || !folderId) return;
    setRecentFolders(previous => {const ids = rememberFolder(previous,folderId); store(RECENT_FOLDERS_KEY,{scope:status.endpoint,ids}); return ids;});
  },[page.version,page.view.classification,page.view.characterNode,status.endpoint]);
  const select = (requested: View) => {
    setSearchChips([]);
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
    if(view.characters){if(!page.view.characters)beforeCharacter.current={view:page.view,cursor:page.cursor,previous:page.previous,scroll:scroll.current,filters:page.filters};setCharactersVisited(true);setCharacterEntry(value=>value+1);}
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
    void load(state.page.view, null, [], scroll.current, true, next);
  };
  const applyMedia = (media: AssetFiltersValue['media']) => {
    const next = media === 'images' ? {...filters, media, duration:'all' as const} : {...filters, media};
    applyFilters(next);
  };
  const applySort = (sort: AssetSort) => {
    const state = latest.current;
    const next = {...state.page.filters, sort};
    if (sortOf(state.page.filters) === sort) {setSortOpen(false);setFilters(next);return;}
    setSortOpen(false);setFilters(next);
    void load(state.page.view, null, [], scroll.current, true, next);
  };
  /** Retry the attempted set, which is what the last failed request used. */
  const retryFilters = () => {
    const state = latest.current;
    if (sameFilters(filters, state.page.filters)) return;
    void load(state.page.view, null, [], scroll.current, true, filters);
  };
  const clearFilters = () => applyFilters({...EMPTY_FILTERS});
  const openRoot=()=>{setSearchChips([]);setArea('assets');void load(LIBRARY,null,[],0,false,EMPTY_FILTERS);};
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
  const openCalendar = useCallback((kind?: 'game'|'movie') => { setCalendarKind(kind); setCalendarOpen(true); }, []);
  const closeCalendar = useCallback(() => { setCalendarKind(undefined); setCalendarOpen(false); }, []);
  const openHome = () => {
    setHomeOrigin(null); homeRestore.current = null;
    setArea('assets');
    if (latest.current.page.view.tab === 'home') retainAssets();
    else {
      const cached = viewCache.current.get(HOME_PAGE_KEY);
      if (cached && Date.now() - homePageAt.current < 60_000) {
        gate.current.cancel(); cancelMore(); setBusy(false); setError(''); setFilterNotice(''); setFilters(cached.filters);
        lastIntent.current = {view:cached.view,cursor:cached.cursor,previous:cached.previous,filters:cached.filters};
        setPage({...cached, restoreScroll:cached.restoreScroll});
      } else select(HOME);
    }
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
    const id=visibleItems[index]?.id,range=page.assetRanges?.ranges.find(range=>range.items.some(item=>item.id===id));
    if(range) {
      const byId=new Map(visibleItems.map(item=>[item.id,item])),items=range.items.flatMap(item=>byId.has(item.id)?[byId.get(item.id)!]:[]);
      setViewer({items,index:items.findIndex(item=>item.id===id),source:'library'});
    } else setViewer({items:visibleItems,index,source:'library'});
  };
  const updateStatus = (next: Status) => {
    gate.current.cancel(); secondaryGate.current.cancel(); cancelMore(); viewCache.current.clear(); observedGeneration.current=null; clearMediaCache();
    setViewer(null); setClassificationBatchIds(null); setClassificationNotice(''); clearSelection(); closeAlbumBatch(); setSimilarity(false); setExchangeOpen(false); closeArtists(); setViewSettings(false); setSortOpen(false); setFiltersOpen(null); setFilterVersion(null); setFilterNotice(''); setFilters({...EMPTY_FILTERS}); setCharacterIndex(undefined); setClassifications([]); setIndexReady(false); setLibrarySegment('folders'); secondaryAt.current = 0; secondaryPending.current = false; setCaptures(null); setCollectionRequest(null); setNoteRequest(null); setDuplicateRequest(0); resetReleaseStore();
    lastLibrary.current = undefined; beforeCharacter.current = undefined; lastIntent.current={view:LIBRARY,cursor:null,previous:[],filters:EMPTY_FILTERS}; setRecentFolders([]);
    try {localStorage.removeItem(RECENT_FOLDERS_KEY);} catch { /* optional */ }
    try {localStorage.removeItem('lakomics.mobile.position');} catch { /* optional */ }
    setPage({generation:null,items:[],has_more:false,next_cursor:null,view:LIBRARY,cursor:null,previous:[],version:0,restoreScroll:0,filters:{...EMPTY_FILTERS}});
    setHomeOrigin(null); homeRestore.current = null;
    setArea('assets'); setNotesVisited(false); setCollectionsVisited(false); setCatalogVisited(false); setCharactersVisited(false);
    setFindOpen(false);setSearchChips([]);setAssetSearchOpen(false);setSearchNotice('');setSearchListsRequested(false);
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
  // 종류 (전체 · 이미지 · 영상) is the gallery's first row; scrolled away, the top bar pulls it down.
  const kindShade = useSectionShade<AssetFiltersValue['media']>({label:'종류',options:MEDIA_SECTIONS,value:filters.media,onChange:applyMedia},{active:filterable&&!settings&&!viewer});
  const selectionGallery = filterable;
  const selectedAsset = selectedIds.size === 1
    ? visibleItems.find(asset => selectedIds.has(asset.id)) ?? sparse?.ranges.flatMap(range => range.items).find(asset => selectedIds.has(asset.id))
    : undefined;
  const currentEntry=entries.find(item=>item.id===page.view.classification);
  const childEntries=entries.filter(item=>item.parent_id===currentEntry?.id);
  const currentAlbum=albumTree?.albums.find(album=>album.id===page.view.album?.id);
  const albumRoot=()=>{setLibrarySegment('albums');openRoot();};
  const crumbs=page.view.album ? [{id:'root',name:'에셋',onSelect:albumRoot},{id:'albums',name:'앨범',onSelect:albumRoot},...(albumTree?albumAncestors(albumTree.albums,page.view.album.id).map(album=>({id:`album:${album.id}`,name:album.name,onSelect:()=>select(albumView(albumTree,album))})):[])] : [{id:'root',name:'에셋',onSelect:openRoot},...ancestorsOf(entries,currentEntry?.id).map(entry=>({id:entry.id,name:entry.name,onSelect:()=>select(entryView(entry))}))];
  const seriesNode=characterIndex?.nodes.find(node=>node.id===focusedCharacter);
  const seriesEntry=entries.find(item=>item.id===seriesNode?.seriesId);
  const characterCrumbs=[{id:'root',name:'에셋',onSelect:openRoot},...ancestorsOf(entries,seriesEntry?.id).map(entry=>({id:entry.id,name:entry.name,onSelect:()=>select(entryView(entry))}))];
  const paused=area!=='assets'||settings||!!viewer||!!fault||similarity||trash.open||exchangeOpen||artistsOpen||calendarOpen;
  const exchangeSending=sendingSummary(exchange.snapshot);
  const exchangeUnseen=exchange.snapshot?.unseen ?? 0;
  const exchangeBadge=exchangeUnseen>0 ? (exchangeUnseen>99 ? '99+' : String(exchangeUnseen)) : exchangeSending ? (exchangeSending.progress===null ? '…' : `${Math.round(exchangeSending.progress*100)}%`) : '';
  const exchangeLabel=exchangeUnseen>0 ? `전송 · 받은 파일 ${exchangeUnseen}개` : exchangeSending ? `전송 · 보내는 중 ${exchangeBadge}` : '전송';
  const intro=<>{!!childEntries.length&&<section className="folder-intro"><FolderCards strip items={childEntries} entries={entries} characters={characterIndex} paused={paused} revision={indexRevision+1} onSelect={select}/></section>}{page.view.album&&albumTree&&albumTree.albums.some(album=>album.parentId===page.view.album?.id&&album.id!==page.view.album?.id)&&<section className="folder-intro"><h2>하위 앨범</h2><Albums key={`${albumTree.libraryId}:${albumTree.epoch}:${page.view.album.id}`} tree={albumTree} parentId={page.view.album.id} paused={paused} revision={indexRevision+1} onSelect={select}/></section>}{!page.items.length&&<div className="empty-state"><RectangleStackIcon/><h2>{busy?'에셋을 불러오고 있습니다':hasActiveFilters(page.filters)?'조건에 맞는 자산이 없습니다':childEntries.length?'이 폴더에 바로 들어 있는 이미지가 없습니다':'아직 자산이 없습니다'}</h2></div>}</>;
  // A drill-down level is a committed Library place; its depth decides the entrance direction.
  // Home, other tabs and filter changes are not levels, so they never slide.
  const levelDepth=(view:View)=>{
    if(view.root)return 0;
    if(view.album)return 1+(albumTree?albumAncestors(albumTree.albums,view.album.id).length:0);
    const entry=view.characters?entries.find(item=>item.characterNode===view.characterNode):currentEntry;
    return 1+(entry?ancestorsOf(entries,entry.id).length:0);
  };
  const libraryLevel=status.configured&&area==='assets'&&page.view.tab==='library'&&page.version>0;
  useLevelMotion(mainRef,libraryLevel?(page.view.search!==undefined?'asset-search':viewKey(page.view)):null,libraryLevel?levelDepth(page.view):0);
  // AreaSwitch retains the outgoing tab until the incoming content is ready.
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
  const openPending = () => { if (captures?.length) setViewer({items: captures, index: 0, pending: true}); else void refreshSecondary(true); };
  const libraryCount=page.view.search?.length?(page.assetRanges?.toc.totalCount.toLocaleString('ko-KR')??`${page.items.length}${page.has_more?'+':''}`):hasActiveFilters(page.filters)?`${page.items.length}${page.has_more?'+':''}`:currentEntry?.asset_count??currentAlbum?.assetCount??`${page.items.length}${page.has_more?'+':''}`;
  const libraryCrumbNode=<nav className="library-breadcrumb" aria-label="현재 위치">{crumbs.map((crumb,i)=><span key={crumb.id}>{i>0&&<span aria-hidden="true">›</span>}<button type="button" onClick={crumb.onSelect}>{crumb.name}</button></span>)}</nav>;
  const commitSearch=(chips:AssetSearchChip[])=>{
    setSearchChips(chips);setAssetSearchOpen(false);setSearchNotice('');setArea('assets');
    const view=searchView(chips);
    if(view.characters){setCharactersVisited(true);if(!page.view.characters||view.characterNode!==page.view.characterNode)setCharacterEntry(value=>value+1);}
    void load(view,null,[],0,false,page.filters);
  };
  const chooseSearchScope=(item:AssetSuggestion)=>commitSearch(addSearchChip(assetSearchOpen?searchChips:viewSearchChips(page.view),item));
  const removeSearchScope=(item:AssetSearchName)=>commitSearch(viewSearchChips(page.view).filter(chip=>assetSearchKey(chipName(chip))!==assetSearchKey(item)));
  const openAssetSearch=()=>{
    let chips=viewSearchChips(page.view);
    if(!page.view.search?.length){
      const scope=searchItems.find(item=>item.kind==='album'?item.id===page.view.album?.id:item.kind==='character'?item.id===page.view.classification||item.kind==='character'&&item.view.characterNode===page.view.characterNode:item.kind==='folder'&&item.id===page.view.classification);
      chips=scope?[searchChip(scope)]:[];
    }
    if(page.view.characters&&focusedCharacter&&focusedCharacter!==page.view.characterNode){
      const current=searchItems.find(item=>item.kind==='character'&&item.view.characterNode===focusedCharacter);
      if(current)chips=addSearchChip(chips,current);
    }
    setSearchChips(chips);setSearchListsRequested(true);setAssetSearchOpen(true);
  };
  const scopeChips=<AssetScopeChips chips={page.view.search??[]} onRemove={removeSearchScope} onClear={()=>commitSearch([])}/>;
  const assetToolbar=page.view.tab==='library'&&!page.view.root&&!page.view.characters&&!page.view.revisit&&<TopBar barRef={kindShade.barRef} className="library-header asset-topbar" loading={busy&&'목록 불러오는 중'} back={{label:'뒤로',onClick:()=>window.dispatchEvent(new Event('lakomics-back'))}} crumbs={libraryCrumbNode} title={kindShade.title(page.view.title)} count={libraryCount}
    actions={<>
      <SearchButton onClick={openAssetSearch}/>
      <FilterChips media={false} sheet={false} variant="toolbar" showReset={false} value={filters} applied={filters} onChange={applyFilters} open={null} onOpen={setFiltersOpen}/>
      {!page.view.album&&<Button type="button" size="sm" variant="ghost" className="asset-topbar__sort" aria-label={`정렬 ${SORT_LABELS[sortOf(filters)]}`} onClick={()=>setSortOpen(true)}><ArrowsUpDownIcon aria-hidden="true"/><span>{SORT_LABELS[sortOf(filters)]}</span></Button>}
      <Button type="button" size="icon" variant="ghost" className="top-bar__options" aria-label="보기 옵션" onClick={()=>{setOptionsScope(page.view.album?page.items:[]);setSortOpen(false);setViewSettings(true);}}><Squares2X2Icon aria-hidden="true"/></Button>
    </>}/>;
  const revisitToolbar=page.view.tab==='library'&&!page.view.root&&!page.view.characters&&page.view.revisit&&<TopBar className="library-header" loading={busy&&'목록 불러오는 중'} back={{label:'뒤로',onClick:()=>window.dispatchEvent(new Event('lakomics-back'))}} crumbs={libraryCrumbNode} title={page.view.title} count={libraryCount}/>;
  const findNavigate=(destination:FindDestination)=>{
    closeArtists();setHomeOrigin(null);
    // Settings is an overlay; picks beneath it must become visible immediately.
    if(destination.kind!=='screen'||destination.screen!=='settings')setSettings(false);
    if(destination.kind==='work')openCollections({kind:'work',id:destination.id});
    else if(destination.kind==='artist'){setArea('assets');openArtist(destination.artist);}
    else if(destination.kind==='note'){
      setNotesVisited(true);setArea('notes');setNoteRequest(current=>({id:destination.id,key:(current?.key??0)+1}));
    }else if(destination.kind==='place'){setArea('assets');select(destination.view);}
    else if(destination.screen==='home')openHome();
    else if(destination.screen==='assets')openLibrary();
    else if(destination.screen==='settings')setSettings(true);
    else {
      setArea(destination.screen);
      if(destination.screen==='collections')setCollectionsVisited(true);
      if(destination.screen==='catalog')setCatalogVisited(true);
      if(destination.screen==='notes')setNotesVisited(true);
    }
  };
  const findEntries=tabletFindEntries({works:findWorks.works,artists:searchArtists.artists,notes:findNotes.notes,folders:entries,albums:albumTree,navigate:findNavigate});
  const motionTab=area==='assets'?page.view.tab:area;
  const assetAreaNode=(
      <main className="library-main" ref={mainRef} style={{display:artistsOpen?'none':undefined}}>
        {assetToolbar}{assetToolbar&&kindShade.shade}{revisitToolbar}
        {/* The Library root stays mounted while a folder is open, so going back shows its folders,
            covers and position at once instead of rebuilding them. */}
        <LibraryRoot endpoint={status.endpoint} onSearchFocus={()=>setSearchListsRequested(true)} onSearchSelect={chooseSearchScope} key={`root:${status.endpoint}`} active={rootShown} entries={entries} characters={characterIndex} items={rootPage.current.items} total={rootPage.current.total} onTrash={trash.available?()=>trash.setOpen(true):undefined} paused={paused||!rootShown} busy={busy} revision={indexRevision+1} onSelect={select} onOpenArtist={openArtist} onRefresh={refresh} albumTree={albumTree} albumError={albumError} albumLoading={albumLoading} segment={librarySegment} onSegment={setLibrarySegment} restoreScroll={page.restoreScroll} onScroll={top=>{scroll.current=top;}} similarity={{enabled:true,refreshKey:similarityClosed,scope:status.endpoint,onOpen:()=>setSimilarity(true)}}/>
        {page.view.characters || page.view.root ? null : page.view.tab === 'home' ? null : <>
        <Gallery stale={busy} sparse={sparse} privacy={privacyMode} items={visibleItems} intro={<>{scopeChips}{filterable?<>{kindShade.inline}{intro}</>:intro}</>} onRefresh={refresh} busy={busy} density={density} identity={`${viewKey(page.view,page.filters)}:${page.cursor}:${page.version}`} restoreScroll={page.restoreScroll} onScroll={top=>{scroll.current=top;}} onOpen={openCurrent} onReady={thumbnailReady} onNearEnd={nearEnd} paused={paused} scrubberHidden={viewSettings || !!filtersOpen} selectedIds={selectionGallery?selectedIds:undefined} onSelectAsset={selectionGallery?selectAsset:undefined} onToggleSelection={selectionGallery?toggleSelectedAsset:undefined} onClearSelection={clearSelection}/>
        {selectionGallery&&<SelectionBar selectedCount={selectedIds.size} batchPending={albumBatchOpen||!!classificationBatchIds} onAddToAlbum={openAlbumBatch} characterLabel="분류" characterShortcut={null} characterOpen={!!classificationBatchIds} onCharacterToggle={()=>{if(selectedIds.size)setClassificationBatchIds([...selectedIds]);}} characterPicker={classificationBatchIds?<ClassificationBatchSheet assetIds={classificationBatchIds} onClose={closeClassificationBatch} onBusyChange={value=>{classificationBatchBusy.current=value;}} onComplete={setClassificationNotice}/>:undefined} extraActions={selectedAsset?<Button variant="ghost" onClick={()=>setAssetInfo(selectedAsset)}>정보</Button>:undefined} onClearSelection={clearSelection}/>}
        <LoadingLine label={loadingMore&&'다음 자산을 불러오는 중'} className="is-bottom"/>
        </>}
        {charactersVisited && <CharacterBrowser search={page.view.search} onSearch={openAssetSearch} onInvalidSearch={(invalid)=>{const view=removeViewSearch(page.view,invalid);setSearchChips(previous=>previous.filter(chip=>!invalid.some(item=>assetSearchKey(item)===assetSearchKey(chipName(chip)))));setSearchNotice('사용할 수 없는 검색 조건을 지웠습니다.');void load(view,null,[],0,true,page.filters);}} scopeChips={scopeChips} hostBusy={busy} optionsHost={optionsHost} onCloseOptions={()=>setViewSettings(false)} entryKey={characterEntry} crumbs={characterCrumbs} onOptions={items=>{setOptionsScope(items);setViewSettings(true);}} onLocation={setFocusedCharacter} initialNode={page.view.characterNode} key={status.endpoint} active={area==='assets'&&!!page.view.characters} paused={settings||!!viewer||!!fault} density={density} refreshKey={page.view.characters?page.version:0} onOpen={(items,index,character)=>setViewer({items,index,character})} backRef={characterBack} onExit={exitCharacters}/>}
        <div className="floating-notices">
          {searchNotice&&<p className="hint" role="status">{searchNotice}</p>}
          {indexError&&rootShown&&<p className="error-message">{indexError}</p>}
          {filterNotice && <div className="inline-error" role="alert"><span>{filterNotice}</span><Button variant="ghost" onClick={retryFilters}>다시 시도</Button><Button variant="ghost" onClick={clearFilters}>필터 해제</Button></div>}
          {error && <div className="inline-error" role="alert"><span>{error}</span><Button onClick={() => {const intent = lastIntent.current; void load(intent.view,intent.cursor,intent.previous,0,false,intent.filters);}}>다시 시도</Button></div>}
          {moreError && !page.view.root && !page.view.characters && page.view.tab!=='home' && <div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" disabled={busy || loadingMore} onClick={() => {void append();}}>다시 시도</Button></div>}
        </div>
      </main>
  );
  const homeAreaNode=<main className="library-main">
    <HeaderTools active={area==='assets'&&page.view.tab==='home'} target="context-location"><div className="gallery-heading"><h2>{page.view.title}</h2></div></HeaderTools>
    <Home items={visibleItems} hasMore={page.has_more} captures={captures} busy={busy} paused={paused} secondaryError={secondaryError} scope={status.endpoint} exchange={exchange.snapshot} characters={characterIndex}
          review={{enabled:false,refreshKey:0}} similarityKey={similarityClosed} onArtists={() => {closeArtists();fromHome(LIBRARY);setLibrarySegment('artists');openRoot();}}
          onRecent={() => {fromHome({tab:'library',title:'최근 저장'});select({tab:'library',title:'최근 저장'});}} onRevisit={(key,title) => {const view:View={tab:'library',revisit:key,title};fromHome(view);select(view);}} onUnclassified={() => {const view:View={tab:'library',unclassified:true,title:'미분류'};fromHome(view);select(view);}} onLibrary={() => {fromHome(lastLibrary.current?.view ?? LIBRARY);openLibrary();}} onRefresh={refresh}
          onNotes={id => {setHomeOrigin(id ? {area:'notes'} : null);setNotesVisited(true);setArea('notes');if (id) setNoteRequest(current => ({id,key:(current?.key ?? 0)+1}));}}
          onPending={openPending}
          onReview={() => {}} onSimilarity={() => setSimilarity(true)} onExchange={() => setExchangeOpen(true)} onSettings={() => setSettings(true)}
          onDuplicates={() => {setHomeOrigin({area:'catalog'});setCatalogVisited(true);setArea('catalog');setDuplicateRequest(n => n+1);}}
          onReleases={() => openCalendar()} onWork={id => {setHomeOrigin({area:'collections'});openCollections({kind:'work',id});}}/>
  </main>;
  const motionViews={
    library: assetAreaNode,
    home: homeAreaNode,
    collections: collectionsVisited && <Collections key={`collections:${status.endpoint}`} active={area==='collections'} paused={settings || !!viewer} backRef={collectionBack} request={collectionRequest} onReturnHome={homeOrigin?.area==='collections'?returnHome:undefined}/>,
    notes: notesVisited && <Notes findStore={findStore} key={`notes:${status.endpoint}`} active={area==='notes'&&!settings} backRef={notesBack} request={noteRequest} onReturnHome={homeOrigin?.area==='notes'?returnHome:undefined} onHomeEntryGone={homeOrigin?.area==='notes'?forgetHome:undefined}/>,
    catalog: catalogVisited && <Catalog key={`catalog:${status.endpoint}`} endpoint={status.endpoint} active={area==='catalog'} paused={settings || !!viewer} backRef={catalogBack} openDuplicates={duplicateRequest} onReturnHome={homeOrigin?.area==='catalog'?returnHome:undefined}/>,
  };
  const tabReady=(host:HTMLElement,key:string)=>{
    const has=(selector:string)=>Array.from(host.querySelectorAll(selector)).some(element=>!element.closest('[style*="display: none"]'));
    if(!viewReady(host))return false;
    if(key==='collections'&&has('.mobile-collections'))return has('.collection-tile, .collection-card, .collection-grid > *, .manga-bookcase, .empty-state, .inline-error, .error-message, .tablet-work');
    if(key==='catalog'&&has('.mobile-catalog'))return has('.catalog-card, .empty-state:not([role="status"]), .inline-error, .catalog-detail-intro');
    if(key==='notes'&&has('.mobile-notes'))return has('.notes-unlock, .notes-list-view, .memo-editor, .notes-recovery');
    if(key==='library'&&page.view.root)return indexReady||!!indexError;
    return key!=='library'&&key!=='home' || !busy || !!error;
  };
  return <FindContext.Provider value={()=>setFindOpen(true)}><MotionScope key={status.endpoint}><div className="mobile-app" ref={appRef}>
    {/* Every configured area except Home draws its own title bar. */}
    {!(status.configured&&(area!=='assets'||page.view.tab==='library')||artistsOpen)&&<header className="app-header"><div className="home-brand"><Mark/>{!status.configured&&<span>LAKOMICS</span>}</div><div id="context-location"/><div className="header-actions"><div id="context-tools"/>{status.configured&&area==='assets'&&page.view.tab==='home'&&<FindButton/>}{demo&&<span className="demo-label">디자인 미리보기</span>}{status.configured&&area==='assets'&&page.view.tab==='home'&&privacyMode&&<span className="privacy-pill" aria-label="비공개 모드 켜짐">비공개</span>}{status.configured&&area==='assets'&&page.view.tab==='home'&&vaultPresent&&<IconButton label="비밀 보관함 열기" icon={LockClosedIcon} onClick={()=>setVaultOpen(true)}/>}{status.configured&&area==='assets'&&page.view.tab==='home'&&<span className="header-action-badge"><IconButton label={exchangeLabel} icon={ArrowsUpDownIcon} onClick={()=>setExchangeOpen(true)}/>{exchangeBadge&&<span className="header-badge" aria-hidden="true">{exchangeBadge}</span>}</span>}{area==='assets'&&page.view.tab==='home'&&<IconButton label="연결 및 설정" icon={AdjustmentsHorizontalIcon} onClick={()=>setSettings(true)}/>}</div><BarProgress label={status.configured&&area==='assets'&&page.view.tab==='home'&&busy&&'목록 불러오는 중'}/></header>}
    {status.configured ? <div className="app-body" data-active-tab={area==='assets'?page.view.tab:area}>
      <AreaSwitch activeKey={motionTab} views={motionViews} retained={['library',...(page.view.tab==='home'?['home']:[]),'collections','notes','catalog']} ready={tabReady}/>
      {assetSearchOpen&&<div className="asset-search-layer"><AssetSearch items={searchItems} chips={searchChips.map(chipName)} endpoint={status.endpoint} paused={settings||!!viewer} onClose={()=>setAssetSearchOpen(false)} onChoose={chooseSearchScope}/></div>}
      {calendarOpen && <div className="release-calendar-layer"><ReleaseCalendar onClose={closeCalendar} initialKind={calendarKind} backRef={calendarBack}/></div>}
      {artistsOpen && <Artists endpoint={status.endpoint} backRef={artistsBack} initialArtist={artistSelection ?? undefined} onClose={closeArtists} paused={settings||!!viewer} onOpenViewer={(items,index) => setViewer({items,index})}/>}
    </div> : <main className="welcome"><Mark/><span className="eyebrow">YOUR ARCHIVE, WITH YOU</span><h1>어디서든,<br/>나의 라이브러리.</h1><p>보관한 이미지와 영상을 감상하고,<br/>다른 앱에 첨부할 때도 바로 찾아보세요.</p><Button variant="primary" disabled={checking} onClick={() => setSettings(true)}>{checking ? '연결 확인 중' : '라이브러리 연결'}<ChevronRightIcon/></Button>{error && <p className="error-message" role="alert">{error}</p>}<span className="welcome-footer">LAKOMICS <span>／</span> MOBILE</span></main>}
    {status.configured && <nav className="bottom-nav" aria-label="주요 탐색"><button className={area==='assets' && page.view.tab === 'home' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'home' ? 'page' : undefined} onClick={()=>{closeArtists();openHome();}}><HomeIcon/><span>홈</span></button><button className={area==='assets' && page.view.tab === 'library' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'library' ? 'page' : undefined} onClick={()=>{closeArtists();setHomeOrigin(null);openLibrary();}}><PhotoIcon aria-hidden="true"/><span>에셋</span></button><button className={area==='collections'?'active':''} aria-current={area==='collections'?'page':undefined} onClick={()=>{closeArtists();setHomeOrigin(null);setCollectionsVisited(true);setArea('collections');}}><RectangleStackIcon/><span>컬렉션</span></button><button className={area==='catalog'?'active':''} aria-current={area==='catalog'?'page':undefined} onClick={()=>{closeArtists();setHomeOrigin(null);setCatalogVisited(true);setArea('catalog');}}><BookOpenIcon aria-hidden="true"/><span>카탈로그</span></button><button className={area==='notes'?'active':''} aria-current={area==='notes'?'page':undefined} onClick={()=>{closeArtists();setHomeOrigin(null);setNotesVisited(true);setArea('notes');}}><PencilSquareIcon aria-hidden="true"/><span>메모</span></button></nav>}
    {status.configured&&<FindSheet open={findOpen} onClose={()=>setFindOpen(false)} entries={findEntries} endpoint={status.endpoint} privacy={privacyMode} loading={findWorks.loading||findNotes.loading||albumLoading||searchArtists.state==='loading'} error={findWorks.error||findNotes.error||albumError||searchArtists.error} onRetry={()=>{setFindRetry(value=>value+1);findWorks.retry();searchArtists.retry();void findStore.load();}}/>}
    {sortOpen&&<BottomSheet title="정렬" onClose={()=>setSortOpen(false)}><div role="radiogroup" aria-label="정렬">{ASSET_SORTS.map(sort=><button key={sort} className="sheet-option" role="radio" aria-checked={sortOf(filters)===sort} onClick={()=>applySort(sort)}>{SORT_LABELS[sort]}<span className="radio-dot"/></button>)}</div></BottomSheet>}
    {viewSettings&&<BottomSheet title="보기 옵션" onClose={()=>setViewSettings(false)}><div className="view-options-host" ref={setOptionsHost}/><StepSlider className="view-options-density" label="썸네일 크기" count={DENSITIES.length} index={densityIndex(density)} defaultIndex={densityIndex(DEFAULT_DENSITY)} valueText={index=>DENSITIES[index]} onChange={index=>{const next=densityOf(index);setDensity(next);store('lakomics.mobile.density',next);}}/>{faultCandidates(optionsScope).length>0&&<button className="sheet-option" onClick={()=>{setViewSettings(false);setFault(optionsScope);}}>FAULT로 플레이<PlayIcon aria-hidden="true" width={18} height={18}/></button>}</BottomSheet>}
    {classificationNotice&&<div className="exchange-toast" role="status"><span>{classificationNotice}</span><Button variant="ghost" onClick={()=>setClassificationNotice('')}>닫기</Button></div>}
    {albumBatchOpen&&<AlbumBatchSheet assetIds={albumBatchAssetIds} open onClose={closeAlbumBatch} onComplete={clearSelection}/>}
    {filterable&&<FilterChips media={false} row={false} value={filters} applied={page.filters} onChange={applyFilters} open={filtersOpen} onOpen={setFiltersOpen}/>}
    {vaultOpen && <PrivateVault density={density} onClose={()=>setVaultOpen(false)} backRef={vaultBack}/>}
    {settings && <div className="settings-layer"><Settings onOpenVault={vaultSelected?undefined:()=>{setSettings(false);setVaultOpen(true);}} onCacheCleared={() => {clearMediaCache(); resetWarmProgress(); viewCache.current.clear(); setPage(current => ({...current,items:current.items.map(({preview,...asset}) => asset)}));}} status={status} onStatus={updateStatus} onClose={() => setSettings(false)}/></div>}
    {fault && <FaultGame items={fault} onClose={() => setFault(null)}/>}
    {similarity && <SimilarityReview backRef={similarityBack} onClose={()=>{setSimilarity(false);setSimilarityClosed(n=>n+1);}}/>}
    {assetInfo && <AssetInfoSheet asset={assetInfo} onClose={()=>setAssetInfo(null)}/>}
    {viewer && <Viewer onNearEnd={viewer.source==='library'?nearEnd:undefined} backRef={viewerBack} endpoint={status.endpoint} character={viewer.character} onCharacterExcluded={characterExcluded} items={viewer.items} index={viewer.index} onIndex={index => {setViewer({...viewer,index});}} onClose={() => setViewer(null)} onTrash={trash.available&&!viewer.pending?asset=>{void trash.trash(asset,viewer.index);}:undefined} trashNotice={trash.snackbar}/>}
    {trash.open && <LibraryTrash key={status.endpoint} backRef={trash.backRef} known={trash.known} onRestored={trash.restored} onClose={() => trash.setOpen(false)}/>}
    {!viewer && trash.snackbar}
    {exchangeOpen && status.configured && <Exchange snapshot={exchange.snapshot} onSnapshot={exchange.setSnapshot} backRef={exchangeBack} onClose={()=>setExchangeOpen(false)}/>}
    {exchange.toast && status.configured && !viewer && !fault && !vaultOpen && <div className="exchange-toast" role="status" key={exchange.toast.key}><span>{exchange.toast.text}</span><Button variant="ghost" onClick={()=>{exchange.dismissToast();setExchangeOpen(true);}}>보기</Button></div>}
  </div></MotionScope></FindContext.Provider>;
}
