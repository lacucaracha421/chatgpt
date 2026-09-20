import {fetchAssetFilterVersion, fetchListGeneration, ASSET_LIST_CHANGED_EVENT} from './listGeneration';
import {HeaderTools} from './HeaderTools';
import {Notes} from './Notes';
import {usePublicationCheck} from './usePublicationCheck';
import {validCharacterIndex,type CharacterIndex} from './characterModel';
import type {ViewerCharacterContext} from './Viewer';
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Bars3Icon, BookOpenIcon, PhotoIcon, PencilSquareIcon, Squares2X2Icon, ArrowsPointingInIcon, ViewfinderCircleIcon, HomeIcon, RectangleStackIcon, AdjustmentsHorizontalIcon, ArrowPathIcon, ChevronRightIcon, XMarkIcon, FunnelIcon} from '@heroicons/react/24/outline';

import {Button, Dialog, DialogDescription, IconButton, Mark} from './ui';
import {api, errorText, native} from './transport';
import {clearMediaCache} from './media';
import {DENSITIES, normalizePage, pagePath, RequestGate, viewKey} from './model';
import type {Asset, AssetFiltersValue, Classification, Page, Revisit, SavedPosition, Status, View} from './types';
import {EMPTY_FILTERS, ASSET_FILTER_VERSION, hasActiveFilters, sameFilters} from './assetFilters';
import {AssetFilters, filterSummary} from './AssetFilters';
import {Gallery} from './Gallery';
import {Home} from './Home';
import {Collections} from './Collections';
import {Catalog} from './Catalog';
import {readRecentFolders, rememberFolder, RECENT_FOLDERS_KEY} from './homeModel';
import {Viewer} from './Viewer';
import {Settings} from './Settings';
import {ClassificationIndex, isAll} from './ClassificationIndex';
import {Albums} from './Albums';
import {CharacterBrowser} from './CharacterBrowser';

const HOME: View = {tab:'home', title:'최근 저장'};
// `전체` is the canonical every-asset listing and the default Library destination.
const LIBRARY: View = {tab:'library', title:'전체'};
function store(key: string, value: unknown) { try {localStorage.setItem(key, JSON.stringify(value));} catch { /* Optional device preference. */ } }
type Committed = Page & {generation:string|null; view: View; cursor: string | null; previous: (string | null)[]; version: number; restoreScroll: number; filters: AssetFiltersValue};
export function App() {
  const [area,setArea] = useState<'assets'|'collections'|'catalog'|'notes'>('assets');
  const [focusedCharacter,setFocusedCharacter]=useState<string|null>(null);
  const [indexHidden,setIndexHidden]=useState(false);
  const [collectionsVisited,setCollectionsVisited] = useState(false);
  const [catalogVisited,setCatalogVisited] = useState(false);
  const [charactersVisited,setCharactersVisited] = useState(false);
  const [notesVisited,setNotesVisited]=useState(false);
  const notesBack=useRef<(()=>boolean)|null>(null);
  const characterBack = useRef<(()=>boolean)|null>(null);
  const collectionBack = useRef<(()=>boolean)|null>(null);
  const catalogBack = useRef<(()=>boolean)|null>(null);
  const albumsBack = useRef<(()=>boolean)|null>(null);
  const viewerBack = useRef<(()=>boolean)|null>(null);
  const [status, setStatus] = useState<Status>({configured:false, endpoint:''});
  const [checking, setChecking] = useState(true), [settings, setSettings] = useState(false), [drawer, setDrawer] = useState(false);
  const [viewSettings, setViewSettings] = useState(false);
  // The committed query's filters. Owned here rather than inside a gallery so that a
  // filter change is an ordinary navigation: it commits a new page and Back returns to
  // the previous view instead of silently mutating the one on screen.
  const [filters, setFilters] = useState<AssetFiltersValue>({...EMPTY_FILTERS});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterVersion, setFilterVersion] = useState<number | null>(null);
  const [filterNotice, setFilterNotice] = useState('');
  const [page, setPage] = useState<Committed>({items:[], has_more:false, next_cursor:null, view:LIBRARY, cursor:null, previous:[], version:0, restoreScroll:0, generation:null, filters:{...EMPTY_FILTERS}});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [indexError, setIndexError] = useState('');
  const [characterIndex,setCharacterIndex]=useState<CharacterIndex>();
  const [indexRevision,setIndexRevision]=useState(0);
  const [classifications, setClassifications] = useState<Classification[]>([]);
  const [recentFolders,setRecentFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [revisit, setRevisit] = useState<Revisit>({bundles:[]}), [captures, setCaptures] = useState<Asset[]>([]);
  const [secondaryError, setSecondaryError] = useState('');
  const [viewer, setViewer] = useState<{items: Asset[]; index: number; pending?: boolean; source?:'library'; character?:ViewerCharacterContext|null} | null>(null);
  const [density, setDensity] = useState(() => {try {const d = JSON.parse(localStorage.getItem('lakomics.mobile.density') ?? '1'); return [0,1,2].includes(d) ? d as number : 1;} catch {return 1;}});
  const scroll = useRef(0), gate = useRef(new RequestGate()), secondaryGate = useRef(new RequestGate());
  const latest = useRef({page, viewer, settings, drawer, status, area, viewSettings, filtersOpen}); latest.current = {page, viewer, settings, drawer, status, area, viewSettings, filtersOpen};
  const lastIntent = useRef<{view:View; cursor:string|null; previous:(string|null)[]; filters:AssetFiltersValue}>({view:LIBRARY,cursor:null,previous:[],filters:{...EMPTY_FILTERS}});
  const lastLibrary = useRef<SavedPosition | undefined>(undefined);
  // Committed assets view left behind when a Character folder is opened from the index.
  const beforeCharacter = useRef<SavedPosition | undefined>(undefined);
  const observedGeneration = useRef<string|null>(null);
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
    const promise = api<Page>(path, controller.signal).then(normalizePage);
    prefetched.current = {path, controller, promise};
    void promise.catch(() => {if (prefetched.current?.promise === promise) prefetched.current = null;});
    return promise;
  }, []);

  const load = useCallback(async (view: View, cursor: string | null = null, previous: (string | null)[] = [], restore = 0, fresh = false, nextFilters: AssetFiltersValue = EMPTY_FILTERS) => {
    const visible = latest.current.page;
    if (visible.view.tab === 'library' && view.tab === 'home') lastLibrary.current = {view:visible.view,cursor:visible.cursor,previous:visible.previous,scroll:scroll.current,filters:visible.filters};
    cancelMore();
    const request = gate.current.begin(); lastIntent.current = {view,cursor,previous,filters:nextFilters}; setBusy(true); setError(''); setFilterNotice('');
    // Declared outside the `try` so the failure path can tell a refused filter request from
    // an ordinary transport failure. A character scope has its own reader and its own
    // placeholder page, so it is not part of this route's filter contract.
    const filtered = hasActiveFilters(nextFilters) && view.tab === 'library' && !view.revisit && !view.characters;
    try {
      // `null` means this server predates the generation endpoint, so degrade to
      // always-fresh reads instead of failing the load that carries the actual list.
      let generation = await fetchListGeneration(request.signal);
      if (!gate.current.current(request.id)) return;
      if (generation !== null && generation !== observedGeneration.current) {viewCache.current.clear(); observedGeneration.current = generation;}
      const candidate = fresh ? undefined : viewCache.current.get(`${viewKey(view, nextFilters)}:${cursor}`);
      const cached = generation && candidate?.generation === generation ? candidate : undefined;
      // A server that cannot promise the filter contract must not be asked to pretend.
      // The refusal happens before the page fetch so an unfiltered list can never be
      // committed under a filtered identity.
      if (filtered && filterVersion === null) throw new Error('이 서버는 자산 필터를 지원하지 않습니다. 서버를 업데이트해 주세요.');
      // A character scope is served by its own reader, not by the page route, so its
      // synthetic empty page is a placeholder that carries no contract. It is therefore
      // never validated against the filter version below.
      const synthetic = !!view.characters;
      let response:Page = synthetic ? {items:[],has_more:false,next_cursor:null} : cached ?? normalizePage(await api<Page>(pagePath(view, cursor, nextFilters), request.signal));
      // A page that asked for filters but came back without the contract was answered by a
      // server that ignored the parameters, so it is refused rather than shown as filtered.
      if (filtered && !synthetic && !cached && response.filter_version !== ASSET_FILTER_VERSION) throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      if (!cached && !view.characters && generation) {
        // Bind a fetched page to a stable generation; a mutation crossing the fetch must
        // not bless stale rows as current. Retry within the same navigation request.
        for (let attempt=0; attempt<3; attempt++) {
          const after = await fetchListGeneration(request.signal);
          if (after === null || after === generation) break;
          if (attempt === 2) throw new Error('목록이 변경되었습니다. 다시 시도해 주세요.');
          generation = after; viewCache.current.clear();
          response = normalizePage(await api<Page>(pagePath(view,cursor,nextFilters),request.signal));
        }
      }
      if (filtered && !synthetic && response.filter_version !== ASSET_FILTER_VERSION)
        throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      observedGeneration.current=generation;
      const items = response.items;
      if (!gate.current.current(request.id)) return;
      scroll.current = restore;
      setPage({ ...response, items, view, cursor, previous, restoreScroll:restore, generation, version:request.id, filters:nextFilters });
    } catch (reason) { if (gate.current.current(request.id)) {
      // The previous page stays mounted and committed on failure: an error must not
      // discard a usable gallery, and it must not leave the heading claiming filters
      // the visible page does not have.
      if (filtered && !hasActiveFilters(latest.current.page.filters)) setFilterNotice(errorText(reason));
      setError(errorText(reason));
    } }
    finally { if (gate.current.current(request.id)) setBusy(false); }
  }, [cancelMore, filterVersion]);
  useEffect(() => {
    if (!status.configured) return;
    let running=false, active=true;
    const controller=new AbortController();
    const check=async () => {
      if (!active || running || document.visibilityState === 'hidden') return;
      running=true;
      try {
        const generation=await fetchListGeneration(controller.signal);
        if (!active) return;
        const state=latest.current;
        // Without the endpoint there is no cheap change signal: leave the committed
        // view alone and let the foreground/resume refresh handle navigation.
        if (generation === null) return;
        if (generation !== observedGeneration.current) {
          viewCache.current.clear(); cancelMore(); clearMediaCache();
          setViewer(null);
          await load(state.page.view,state.page.cursor,state.page.previous,scroll.current,true,state.page.filters);
          setIndexRevision(value=>value+1);
        }
      } catch { /* Retain last committed view on transport failure; cache reuse still validates. */ }
      finally {running=false;}
    };
    const changed=()=>{observedGeneration.current=null;void check();};
    const timer=window.setInterval(()=>void check(),5000);
    window.addEventListener('focus',check); window.addEventListener('lakomics-resume',check); document.addEventListener('visibilitychange',check);
    window.addEventListener(ASSET_LIST_CHANGED_EVENT,changed);
    return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',check);window.removeEventListener('lakomics-resume',check);document.removeEventListener('visibilitychange',check);window.removeEventListener(ASSET_LIST_CHANGED_EVENT,changed);};
  },[status.configured,status.endpoint,load,cancelMore]);
  useEffect(() => {
    if (!page.version) return;
    const key = `${viewKey(page.view, page.filters)}:${page.cursor}`;
    viewCache.current.delete(key); viewCache.current.set(key,page);
    if (viewCache.current.size > 4) viewCache.current.delete(viewCache.current.keys().next().value!);
    // Prefetch the next page of the same filtered query, so appended pages keep the
    // filter set rather than reverting to an unfiltered continuation.
    if (page.view.tab === 'library' && page.has_more && page.next_cursor) void nextPage(page.view,page.next_cursor,page.filters).catch(() => {});
  }, [page, nextPage]);
  const append = useCallback(async () => {
    const current = latest.current.page;
    if (morePending.current || !current.has_more || !current.next_cursor || (latest.current.viewer&&latest.current.viewer.source!=='library')) return;
    morePending.current = true; setLoadingMore(true); setMoreError('');
    const request = moreGate.current.begin();
    try {
      const generation=await fetchListGeneration(request.signal);
      // A server without the endpoint keeps the pre-existing append behavior: pages are
      // appended without a generation guard rather than blocking the load.
      if (generation !== null && generation !== current.generation) {viewCache.current.clear(); await load(current.view,current.cursor,current.previous,scroll.current,true,current.filters);return;}
      const response = await nextPage(current.view,current.next_cursor,current.filters);
      if (generation !== null) {
        const after=await fetchListGeneration(request.signal);
        if (after !== null && after !== generation) {viewCache.current.clear(); await load(current.view,current.cursor,current.previous,scroll.current,true,current.filters);return;}
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
      setViewer(viewer=>viewer?.source==='library'?{...viewer,items:[...viewer.items,...response.items.filter(item=>!viewer.items.some(old=>old.id===item.id))]}:viewer);
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
    const results = await Promise.allSettled([
      api<Revisit>('/v1/library/revisit?limit=8', request.signal),
      api<{captures: Asset[]}>('/v1/captures/pending?limit=40', request.signal),
    ]);
    if (!secondaryGate.current.current(request.id)) return;
    if (results[0].status === 'fulfilled') setRevisit(results[0].value);
    if (results[1].status === 'fulfilled') setCaptures(results[1].value.captures.map(item => ({...item,pending:true})).reverse());
    if (results.some(result => result.status === 'rejected')) setSecondaryError('다시보기 또는 처리 대기 목록을 갱신하지 못했습니다.');
  }, []);
  useEffect(() => { void native<Status>('status').then(setStatus).catch(reason => setError(errorText(reason))).finally(() => setChecking(false)); return () => {gate.current.cancel(); secondaryGate.current.cancel();}; }, []);
  useEffect(() => {
    if (!status.configured) return;
    setRecentFolders(readRecentFolders(status.endpoint));
    const controller = new AbortController(); setIndexError('');
    void api<{items:Classification[]}>('/v1/library/classifications', controller.signal).then(result => setClassifications(result.items)).catch(reason => {if (!controller.signal.aborted) setIndexError(errorText(reason));});
    void load(LIBRARY);
    return () => {controller.abort(); gate.current.cancel(); secondaryGate.current.cancel(); moreGate.current.cancel(); prefetched.current?.controller.abort();};
  }, [status, load]);
  useEffect(() => { if (page.version && page.view.tab === 'home' && !page.cursor) void refreshSecondary(); return () => secondaryGate.current.cancel(); }, [page.version, page.view.tab, page.cursor, refreshSecondary]);
  const refresh = useCallback(() => {
    const state = latest.current;
    if (!state.status.configured || state.viewer || state.settings) return;
    viewCache.current.clear();
    void load(state.page.view, state.page.cursor, state.page.previous, 0, true, state.page.filters);
  }, [load]);
  // Leaves the character boundary for the actual context it was opened from, falling back to
  // Home when nothing was committed beforehand. Deliberately not routed through the global
  // back chain, which would close an unrelated open surface first.
  const restoreBeforeCharacter = useCallback(() => {
    const saved = beforeCharacter.current; beforeCharacter.current = undefined;
    setArea('assets');
    if (saved) void load(saved.view, saved.cursor, saved.previous, saved.scroll, false, saved.filters);
    else void load(LIBRARY, null, [], 0, false, EMPTY_FILTERS);
  }, [load]);
  useEffect(() => {
    const visible = () => {if (document.visibilityState === 'visible' && latest.current.status.configured && latest.current.page.view.tab === 'home') void refreshSecondary();};
    const back = () => {
      const state = latest.current;
      // The filter dialog is the innermost surface, so it closes first and consumes the press.
      if (state.filtersOpen) setFiltersOpen(false);
      else if (state.viewSettings) setViewSettings(false);
      else if (state.settings) setSettings(false);
      else if (state.viewer && viewerBack.current?.()) { /* Viewer overlay consumed back. */ }
      else if (state.viewer) setViewer(null);
      else if (state.drawer) setDrawer(false);
      else if (state.area === 'collections') {if (!collectionBack.current?.()) setArea('assets');}
      else if (state.area === 'notes') {if (!notesBack.current?.()) setArea('assets');}
      else if (state.area === 'catalog') {if (!catalogBack.current?.()) setArea('assets');}
      else if (state.page.view.characters && characterBack.current?.()) {  }
      else if (albumsBack.current?.()) {  }
      else if (state.page.view.characters) {restoreBeforeCharacter();}
      // A filtered view is a narrower view, so Back returns to the same scope without
      // the filters rather than jumping to All. Only a filtered All falls through to the
      // unfiltered All, which is the same rule `isAll` already applies to a cursor.
      else if (hasActiveFilters(state.page.filters)) void load(state.page.view, null, [], 0, true, EMPTY_FILTERS);
      else if (!isAll(state.page.view) || state.page.cursor) void load(LIBRARY, null, [], 0, false, EMPTY_FILTERS);
      else void native('finish').catch(() => {});
    };
    window.addEventListener('lakomics-resume', visible); document.addEventListener('visibilitychange', visible); window.addEventListener('lakomics-back', back);
    return () => {window.removeEventListener('lakomics-resume', visible); document.removeEventListener('visibilitychange', visible); window.removeEventListener('lakomics-back', back);};
  }, [refreshSecondary, load, restoreBeforeCharacter]);
  useEffect(() => {
    if (!page.version || !page.view.classification) return;
    setRecentFolders(previous => {const ids = rememberFolder(previous,page.view.classification!); store(RECENT_FOLDERS_KEY,{scope:status.endpoint,ids}); return ids;});
  },[page.version,page.view.classification,status.endpoint]);
  const select = (view: View) => {
    // Remember the real browsing context only when entering the character boundary, and only
    // from a non-character view. Re-selecting another folder inside it keeps the original
    // context instead of stacking a synthetic character parent.
    if(view.characters && !latest.current.page.view.characters && latest.current.page.version)
      beforeCharacter.current = {view:latest.current.page.view,cursor:latest.current.page.cursor,previous:latest.current.page.previous,scroll:scroll.current,filters:latest.current.page.filters};
    // Filters are already committed into the navigation identity, so a restored scope
    // brings its own filter set back with it rather than inheriting the current one. Home
    // and Revisit are never filtered, so they are loaded with none.
    const unfiltered = view.characters || view.tab === 'home' || !!view.revisit;
    setArea('assets'); setDrawer(false);
    if(view.characters) setCharactersVisited(true); void load(view, null, [], 0, false, unfiltered ? EMPTY_FILTERS : latest.current.page.filters);
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
    if (sameFilters(next, state.page.filters)) {setFiltersOpen(false); return;}
    setFiltersOpen(false); setFilters(next);
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
  const openAll = () => {setArea('assets'); setDrawer(false); if(!isAll(latest.current.page.view) || hasActiveFilters(latest.current.page.filters)) void load(LIBRARY, null, [], 0, false, EMPTY_FILTERS);};
  const selectView = (view: View) => {if(isAll(view)) openAll(); else select(view);};
  // Settle area and drawer before loading, so a press from another area cannot leave it mounted.
  const openLibrary = () => {
    setArea('assets'); setDrawer(false);
    if(latest.current.page.view.tab === 'library' && latest.current.area === 'assets') return;
    const saved=lastLibrary.current;
    if(saved && !isAll(saved.view)) void load(saved.view,saved.cursor,saved.previous,saved.scroll,false,saved.filters);
    else openAll();
  };
  const openCurrent = (index: number) => {
    // Opening the still-visible gallery cancels its uncommitted replacement.
    gate.current.cancel(); cancelMore(); setBusy(false); setError('');
    lastIntent.current = {view:page.view,cursor:page.cursor,previous:page.previous,filters:page.filters};
    setViewer({items:page.items,index,source:'library'});
  };
  const updateStatus = (next: Status) => {
    gate.current.cancel(); secondaryGate.current.cancel(); cancelMore(); viewCache.current.clear(); observedGeneration.current=null; clearMediaCache();
    setViewer(null); setViewSettings(false); setFiltersOpen(false); setFilterVersion(null); setFilterNotice(''); setFilters({...EMPTY_FILTERS}); setCharacterIndex(undefined); setClassifications([]); setCaptures([]); setRevisit({bundles:[]});
    setCollapsed(new Set()); knownFolders.current.clear(); lastLibrary.current = undefined; beforeCharacter.current = undefined; setRecentFolders([]);
    try {localStorage.removeItem(RECENT_FOLDERS_KEY);} catch { /* optional */ }
    try {localStorage.removeItem('lakomics.mobile.position');} catch { /* optional */ }
    setPage({generation:null,items:[],has_more:false,next_cursor:null,view:LIBRARY,cursor:null,previous:[],version:0,restoreScroll:0,filters:{...EMPTY_FILTERS}});
    setArea('assets'); setNotesVisited(false); setCollectionsVisited(false); setCatalogVisited(false); setCharactersVisited(false);
    setStatus(next);
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
  const folderParents=new Map<string,string|null>(classifications.map(item=>[item.id,item.parent_id]));
  const treeId=(id:string)=>{const node=characterIndex?.nodes.find(n=>n.id===id);return node?.kind==='series'?node.sourceId:node?.kind==='group'?`character-group:${node.sourceId}`:id;};
  for(const node of characterIndex?.nodes??[]){const id=treeId(node.id);if(!folderParents.has(id))folderParents.set(id,node.parentId?treeId(node.parentId):null);}
  const knownFolders=useRef(new Set<string>());
  useLayoutEffect(()=>{
    const additions=[...folderParents.keys()].filter(id=>!knownFolders.current.has(id));
    if(!additions.length)return;
    additions.forEach(id=>knownFolders.current.add(id));
    setCollapsed(old=>new Set([...old,...additions]));
  },[classifications,characterIndex]);
  const foldAll=()=>setCollapsed(new Set(folderParents.keys()));
  const focusFolder=()=>{const next=new Set(folderParents.keys());let id=page.view.characters?(focusedCharacter?treeId(focusedCharacter):null):page.view.classification??null;const seen=new Set<string>();while(id&&!seen.has(id)){seen.add(id);next.delete(id);id=folderParents.get(id)??null;}setCollapsed(next);};

  // Home and Revisit are not filterable: they answer a different question from a scoped
  // gallery, so the control is absent there rather than present and inert.
  const filterable = area === 'assets' && page.view.tab === 'library' && !page.view.characters && !page.view.revisit;
  // `page.filters` is what the visible page was actually fetched under; `filters` is what the
  // user has asked for. They differ only while a change is in flight or after it failed.
  const filterPending = filterable && !sameFilters(filters, page.filters);
  const folderTools = <div className="folder-tools" role="group" aria-label="폴더 보기"><IconButton label="모든 폴더 접기" icon={ArrowsPointingInIcon} onClick={foldAll}/><IconButton label="현재 위치만 펼치기" icon={ViewfinderCircleIcon} disabled={!(page.view.characters?focusedCharacter:page.view.classification)} onClick={focusFolder}/></div>;
  const demo = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
  return <div className="mobile-app">
    <header className="app-header"><button className="brand" aria-label="사이드바 열기" disabled={!status.configured} onClick={()=>{if(area==='assets'){if(window.matchMedia?.('(orientation:landscape) and (min-width:1000px)').matches)setIndexHidden(v=>!v);else setDrawer(v=>!v);}else window.dispatchEvent(new Event('lakomics-sidebar'));}}><Bars3Icon className="navigation-icon" aria-hidden="true"/><Mark/><span>LAKOMICS</span><span className="brand-divider"/><span className="section-name">{area === 'notes' ? 'Notes' : area === 'catalog' ? 'Catalog' : area === 'collections' ? 'Collections' : page.view.tab === 'home' ? 'Home' : 'Library'}</span></button><div id="context-location">{(area==='catalog'||area==='notes')&&<h2 className="header-area">{area==='catalog'?'Catalog':'Notes'}</h2>}</div><div className="header-actions"><div id="context-tools"/>{demo && <span className="demo-label">디자인 미리보기</span>}<IconButton label="연결 및 설정" icon={AdjustmentsHorizontalIcon} onClick={() => setSettings(true)}/></div></header>
    {status.configured ? <div className="app-body">
      <aside className="desktop-index" style={{display:area!=='assets'||indexHidden?'none':undefined}}><div className="index-title"><span>라이브러리</span><RectangleStackIcon/></div>{folderTools}{indexError && <p className="error-message">{indexError}</p>}<ClassificationIndex items={classifications} characters={characterIndex} view={page.view} onSelect={selectView} collapsed={collapsed} setCollapsed={setCollapsed}/><Albums active={area==='assets'&&!settings&&!viewer} paused={settings||!!viewer||drawer} onOpen={(items,index)=>setViewer({items,index})} backRef={albumsBack}/></aside>
      <main className="library-main" style={{display:area!=='assets'?'none':undefined}}>
        <HeaderTools active={area==='assets'} target="context-location"><div className={`gallery-heading ${page.view.characters?'is-character':''}`}><div className="location"><span className="location-square"/><h2>{page.view.title}</h2><span className="numeric muted">{page.view.tab==='library' && page.items.length ? `${page.items.length}개${page.has_more ? '+' : ''}` : ''}</span>{filterable && hasActiveFilters(page.filters) && <span className="asset-filter-summary">{filterSummary(page.filters)}</span>}{filterPending && <span className="asset-filter-summary">필터 적용 대기</span>}</div><div className="heading-actions">{filterable && <IconButton label={hasActiveFilters(filters) ? `자산 필터: ${filterSummary(filters)}` : '자산 필터'} icon={FunnelIcon} active={hasActiveFilters(page.filters)} onClick={()=>setFiltersOpen(true)}/>}{page.view.tab === 'library' && <IconButton label={`갤러리 보기: ${DENSITIES[density]}`} icon={Squares2X2Icon} onClick={()=>setViewSettings(true)}/>}<IconButton label="새로고침" icon={ArrowPathIcon} disabled={busy} onClick={refresh}/></div></div></HeaderTools>
        {filterNotice && <div className="inline-error" role="alert"><span>{filterNotice}</span><Button variant="ghost" onClick={retryFilters}>다시 시도</Button><Button variant="ghost" onClick={clearFilters}>필터 해제</Button></div>}
        {busy && <div className="loading-line" role="status" aria-label="목록 불러오는 중"/>}
        {error && <div className="inline-error" role="alert"><span>{error}</span><Button onClick={() => {const intent = lastIntent.current; void load(intent.view,intent.cursor,intent.previous,0,false,intent.filters);}}>다시 시도</Button></div>}
        {page.view.characters ? null : page.view.tab === 'home' ? <Home items={page.items} classifications={classifications} recentFolders={recentFolders} revisit={revisit} captures={captures} busy={busy} paused={area !== 'assets' || settings || !!viewer} secondaryError={secondaryError} revision={page.version} onSelect={select} onOpen={openCurrent} onPending={() => setViewer({items:captures,index:0,pending:true})}/> : <>
        {page.items.length > 0 ? <Gallery items={page.items} density={density} identity={`${viewKey(page.view, page.filters)}:${page.cursor}:${page.version}`} restoreScroll={page.restoreScroll} onScroll={top => {scroll.current = top;}} onOpen={openCurrent} onReady={thumbnailReady} onNearEnd={nearEnd} paused={area !== 'assets' || settings || !!viewer}/> : <div className="empty-state"><RectangleStackIcon/><h2>{busy ? '라이브러리를 불러오고 있습니다' : hasActiveFilters(page.filters) ? '조건에 맞는 자산이 없습니다' : '아직 자산이 없습니다'}</h2><p>{busy ? '잠시만 기다려 주세요.' : hasActiveFilters(page.filters) ? '필터를 해제하면 이 분류의 자산을 모두 볼 수 있습니다.' : 'PC에서 보관한 자산이 클라우드에 동기화되면 여기에 나타납니다.'}</p></div>}
        {loadingMore && <div className="loading-line" role="status" aria-label="다음 자산을 불러오는 중"/>}{moreError && <div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" disabled={busy || loadingMore} onClick={() => {void append();}}>다시 시도</Button></div>}
        </>}
        {charactersVisited && <CharacterBrowser onLocation={setFocusedCharacter} initialNode={page.view.characterNode} key={status.endpoint} active={area==='assets'&&!!page.view.characters} paused={settings||!!viewer||drawer} density={density} refreshKey={page.view.characters?page.version:0} onOpen={(items,index,character)=>setViewer({items,index,character})} backRef={characterBack} onExit={restoreBeforeCharacter}/>}
      </main>
      {collectionsVisited && <Collections key={`collections:${status.endpoint}`} active={area==='collections'} paused={settings || !!viewer || drawer} backRef={collectionBack}/>}
      {notesVisited && <Notes key={`notes:${status.endpoint}`} active={area==='notes'&&!settings} backRef={notesBack}/>}
      {catalogVisited && <Catalog key={`catalog:${status.endpoint}`} endpoint={status.endpoint} active={area==='catalog'} paused={settings || !!viewer || drawer} backRef={catalogBack}/>}
    </div> : <main className="welcome"><Mark/><span className="eyebrow">YOUR ARCHIVE, WITH YOU</span><h1>어디서든,<br/>나의 라이브러리.</h1><p>보관한 이미지와 영상을 감상하고,<br/>다른 앱에 첨부할 때도 바로 찾아보세요.</p><Button variant="primary" disabled={checking} onClick={() => setSettings(true)}>{checking ? '연결 확인 중' : '라이브러리 연결'}<ChevronRightIcon/></Button>{error && <p className="error-message" role="alert">{error}</p>}<span className="welcome-footer">LAKOMICS <span>／</span> MOBILE</span></main>}
    {status.configured && <nav className="bottom-nav" aria-label="주요 탐색"><button className={area==='assets' && page.view.tab === 'home' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'home' ? 'page' : undefined} onClick={() => select(HOME)}><HomeIcon/><span>Home</span></button><button className={area==='assets' && page.view.tab === 'library' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'library' ? 'page' : undefined} onClick={openLibrary}><PhotoIcon aria-hidden="true"/><span>Library</span></button><button className={area==='collections'?'active':''} aria-current={area==='collections'?'page':undefined} onClick={()=>{setDrawer(false);setCollectionsVisited(true);setArea('collections');}}><RectangleStackIcon/><span>Collections</span></button><button className={area==='catalog'?'active':''} aria-current={area==='catalog'?'page':undefined} onClick={()=>{setDrawer(false);setCatalogVisited(true);setArea('catalog');}}><BookOpenIcon aria-hidden="true"/><span>Catalog</span></button><button className={area==='notes'?'active':''} aria-current={area==='notes'?'page':undefined} onClick={()=>{setDrawer(false);setNotesVisited(true);setArea('notes');}}><PencilSquareIcon aria-hidden="true"/><span>Notes</span></button></nav>}
    {drawer && <Dialog open title="분류" onClose={() => setDrawer(false)}><DialogDescription className="sr-only">분류를 선택하면 해당 자산 목록을 엽니다.</DialogDescription><div className="dialog-header library-drawer-heading"><span className="sr-only">라이브러리</span><IconButton label="분류 닫기" icon={XMarkIcon} onClick={() => setDrawer(false)}/></div>{folderTools}{indexError && <p className="error-message">{indexError}</p>}<ClassificationIndex items={classifications} characters={characterIndex} view={page.view} onSelect={selectView} collapsed={collapsed} setCollapsed={setCollapsed}/><Albums active={area==='assets'&&!settings&&!viewer} paused={settings||!!viewer} onOpen={(items,index)=>setViewer({items,index})} backRef={albumsBack}/></Dialog>}
    {viewSettings && <Dialog open title="갤러리 보기" onClose={()=>setViewSettings(false)}><DialogDescription className="sr-only">썸네일 크기를 선택합니다. 설정은 이 기기에 저장됩니다.</DialogDescription><div className="view-density" role="group" aria-label="썸네일 크기">{DENSITIES.map((label,value)=><Button key={label} variant="ghost" aria-pressed={density===value} onClick={()=>{setDensity(value);store('lakomics.mobile.density',value);}}>{label}</Button>)}</div><div className="view-settings-footer"><Button variant="ghost" onClick={()=>setViewSettings(false)}>닫기</Button></div></Dialog>}
    {filtersOpen && <Dialog open title="자산 필터" onClose={()=>setFiltersOpen(false)}><DialogDescription className="sr-only">미디어 종류, 비율과 영상 길이로 자산 목록을 좁힙니다. 선택하면 목록이 다시 불러와지고, 뒤로 가면 필터 없는 목록으로 돌아갑니다.</DialogDescription><AssetFilters value={filters} onChange={applyFilters}/><div className="view-settings-footer"><Button variant="ghost" onClick={()=>setFiltersOpen(false)}>닫기</Button></div></Dialog>}
    {settings && <Settings onCacheCleared={() => {clearMediaCache(); viewCache.current.clear(); setPage(current => ({...current,items:current.items.map(({preview,...asset}) => asset)}));}} status={status} onStatus={updateStatus} onClose={() => setSettings(false)}/>}
    {viewer && <Viewer onNearEnd={viewer.source==='library'?nearEnd:undefined} backRef={viewerBack} endpoint={status.endpoint} character={viewer.character} onCharacterExcluded={characterExcluded} items={viewer.items} index={viewer.index} onIndex={index => {setViewer({...viewer,index});}} onClose={() => setViewer(null)}/>}
  </div>;
}
