import {useCallback, useEffect, useRef, useState} from 'react';
import {HomeIcon, RectangleStackIcon, AdjustmentsHorizontalIcon, Bars3Icon, ArrowPathIcon, ChevronRightIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton, Mark} from './ui';
import {api, errorText, native} from './transport';
import {clearMediaCache} from './media';
import {DENSITIES, normalizePage, pagePath, RequestGate, viewKey} from './model';
import type {Asset, Classification, Page, Revisit, SavedPosition, Status, View} from './types';
import {Gallery} from './Gallery';
import {Home} from './Home';
import {Collections} from './Collections';
import {Catalog} from './Catalog';
import {readRecentFolders, rememberFolder, RECENT_FOLDERS_KEY} from './homeModel';
import {Viewer} from './Viewer';
import {Settings} from './Settings';
import {ClassificationIndex} from './ClassificationIndex';

const HOME: View = {tab:'home', title:'최근 저장'};
function store(key: string, value: unknown) { try {localStorage.setItem(key, JSON.stringify(value));} catch { /* Optional device preference. */ } }
type Committed = Page & {view: View; cursor: string | null; previous: (string | null)[]; version: number; restoreScroll: number};
export function App() {
  const [area,setArea] = useState<'assets'|'collections'|'catalog'>('assets');
  const [collectionsVisited,setCollectionsVisited] = useState(false);
  const [catalogVisited,setCatalogVisited] = useState(false);
  const collectionBack = useRef<(()=>boolean)|null>(null);
  const catalogBack = useRef<(()=>boolean)|null>(null);
  const [status, setStatus] = useState<Status>({configured:false, endpoint:''});
  const [checking, setChecking] = useState(true), [settings, setSettings] = useState(false), [drawer, setDrawer] = useState(false);
  const [page, setPage] = useState<Committed>({items:[], has_more:false, next_cursor:null, view:HOME, cursor:null, previous:[], version:0, restoreScroll:0});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [indexError, setIndexError] = useState('');
  const [classifications, setClassifications] = useState<Classification[]>([]);
  const [recentFolders,setRecentFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [revisit, setRevisit] = useState<Revisit>({bundles:[]}), [captures, setCaptures] = useState<Asset[]>([]);
  const [secondaryError, setSecondaryError] = useState('');
  const [viewer, setViewer] = useState<{items: Asset[]; index: number; pending?: boolean} | null>(null);
  const [density, setDensity] = useState(() => {try {const d = JSON.parse(localStorage.getItem('lakomics.mobile.density') ?? '1'); return [0,1,2].includes(d) ? d as number : 1;} catch {return 1;}});
  const scroll = useRef(0), gate = useRef(new RequestGate()), secondaryGate = useRef(new RequestGate());
  const latest = useRef({page, viewer, settings, drawer, status, area}); latest.current = {page, viewer, settings, drawer, status, area};
  const lastIntent = useRef<{view:View; cursor:string|null; previous:(string|null)[]}>({view:HOME,cursor:null,previous:[]});
  const lastLibrary = useRef<SavedPosition | undefined>(undefined);
  const viewCache = useRef(new Map<string, Committed>());
  const moreGate = useRef(new RequestGate());
  const [loadingMore, setLoadingMore] = useState(false), [moreError, setMoreError] = useState('');
  const morePending = useRef(false);
  const prefetched = useRef<{path:string; controller:AbortController; promise:Promise<Page>} | null>(null);
  const cancelMore = useCallback(() => {
    moreGate.current.cancel(); prefetched.current?.controller.abort(); prefetched.current = null;
    morePending.current = false; setLoadingMore(false); setMoreError('');
  }, []);
  const nextPage = useCallback((view:View, cursor:string) => {
    const path = pagePath(view, cursor);
    if (prefetched.current?.path === path) return prefetched.current.promise;
    prefetched.current?.controller.abort();
    const controller = new AbortController();
    const promise = api<Page>(path, controller.signal).then(normalizePage);
    prefetched.current = {path, controller, promise};
    void promise.catch(() => {if (prefetched.current?.promise === promise) prefetched.current = null;});
    return promise;
  }, []);

  const load = useCallback(async (view: View, cursor: string | null = null, previous: (string | null)[] = [], restore = 0, fresh = false) => {
    const visible = latest.current.page;
    if (visible.view.tab === 'library' && view.tab === 'home') lastLibrary.current = {view:visible.view,cursor:visible.cursor,previous:visible.previous,scroll:scroll.current};
    cancelMore();
    const request = gate.current.begin(); lastIntent.current = {view,cursor,previous}; setBusy(true); setError('');
    try {
      const cached = fresh ? undefined : viewCache.current.get(`${viewKey(view)}:${cursor}`);
      const response = cached ?? normalizePage(await api<Page>(pagePath(view, cursor), request.signal));
      const items = response.items;
      if (!gate.current.current(request.id)) return;
      scroll.current = restore;
      setPage({ ...response, items, view, cursor, previous, restoreScroll:restore, version:request.id });
    } catch (reason) { if (gate.current.current(request.id)) setError(errorText(reason)); }
    finally { if (gate.current.current(request.id)) setBusy(false); }
  }, [cancelMore]);
  useEffect(() => {
    if (!page.version) return;
    const key = `${viewKey(page.view)}:${page.cursor}`;
    viewCache.current.delete(key); viewCache.current.set(key,page);
    if (viewCache.current.size > 4) viewCache.current.delete(viewCache.current.keys().next().value!);
    if (page.view.tab === 'library' && page.has_more && page.next_cursor) void nextPage(page.view,page.next_cursor).catch(() => {});
  }, [page, nextPage]);
  const append = useCallback(async () => {
    const current = latest.current.page;
    if (morePending.current || !current.has_more || !current.next_cursor || latest.current.viewer) return;
    morePending.current = true; setLoadingMore(true); setMoreError('');
    const request = moreGate.current.begin();
    try {
      const response = await nextPage(current.view,current.next_cursor);
      if (!moreGate.current.current(request.id) || latest.current.page.version !== current.version) return;
      // Do not advance forever if a broken server returns its input cursor.
      if (response.has_more && response.next_cursor === current.next_cursor) throw new Error('목록 커서가 진행되지 않습니다.');
      prefetched.current = null;
      setPage(previous => {
        const seen = new Set(previous.items.map(item => item.id));
        return {...previous, items:[...previous.items,...response.items.filter(item => !seen.has(item.id))],
          has_more:response.has_more, next_cursor:response.next_cursor};
      });
    } catch (reason) {if (moreGate.current.current(request.id)) setMoreError(errorText(reason));}
    finally {if (moreGate.current.current(request.id)) {morePending.current = false; setLoadingMore(false);}}
  }, [nextPage]);
  const nearEnd = useCallback(() => {if (!busy && !loadingMore && !moreError) void append();}, [busy,loadingMore,moreError,append]);
  const thumbnailReady = useCallback((asset:Asset) => {
    setPage(current => ({...current,items:current.items.map(item => item.id === asset.id ? {...item,...asset} : item)}));
  }, []);
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
    void load(HOME);
    return () => {controller.abort(); gate.current.cancel(); secondaryGate.current.cancel(); moreGate.current.cancel(); prefetched.current?.controller.abort();};
  }, [status, load]);
  useEffect(() => { if (page.version && page.view.tab === 'home' && !page.cursor) void refreshSecondary(); return () => secondaryGate.current.cancel(); }, [page.version, page.view.tab, page.cursor, refreshSecondary]);
  const refresh = useCallback(() => {
    const state = latest.current;
    if (!state.status.configured || state.viewer || state.settings) return;
    viewCache.current.clear();
    void load(state.page.view, state.page.cursor, state.page.previous, 0, true);
  }, [load]);
  useEffect(() => {
    const visible = () => {if (document.visibilityState === 'visible' && latest.current.status.configured && latest.current.page.view.tab === 'home') void refreshSecondary();};
    const back = () => {
      const state = latest.current;
      if (state.settings) setSettings(false);
      else if (state.viewer) setViewer(null);
      else if (state.drawer) setDrawer(false);
      else if (state.area === 'collections') {if (!collectionBack.current?.()) setArea('assets');}
      else if (state.area === 'catalog') {if (!catalogBack.current?.()) setArea('assets');}
      else if (state.page.view.tab !== 'home' || state.page.cursor) void load(HOME);
      else void native('finish').catch(() => {});
    };
    window.addEventListener('lakomics-resume', visible); document.addEventListener('visibilitychange', visible); window.addEventListener('lakomics-back', back);
    return () => {window.removeEventListener('lakomics-resume', visible); document.removeEventListener('visibilitychange', visible); window.removeEventListener('lakomics-back', back);};
  }, [refreshSecondary, load]);
  useEffect(() => {
    if (!page.version || !page.view.classification) return;
    setRecentFolders(previous => {const ids = rememberFolder(previous,page.view.classification!); store(RECENT_FOLDERS_KEY,{scope:status.endpoint,ids}); return ids;});
  },[page.version,page.view.classification,status.endpoint]);
  const select = (view: View) => {
    setArea('assets'); setDrawer(false); void load(view);
  };
  const openCurrent = (index: number) => {
    // Opening the still-visible gallery cancels its uncommitted replacement.
    gate.current.cancel(); cancelMore(); setBusy(false); setError('');
    lastIntent.current = {view:page.view,cursor:page.cursor,previous:page.previous};
    setViewer({items:page.items,index});
  };
  const updateStatus = (next: Status) => {
    gate.current.cancel(); secondaryGate.current.cancel(); cancelMore(); viewCache.current.clear(); clearMediaCache();
    setViewer(null); setClassifications([]); setCaptures([]); setRevisit({bundles:[]});
    setCollapsed(new Set()); lastLibrary.current = undefined; setRecentFolders([]);
    try {localStorage.removeItem(RECENT_FOLDERS_KEY);} catch { /* optional */ }
    try {localStorage.removeItem('lakomics.mobile.position');} catch { /* optional */ }
    setPage({items:[],has_more:false,next_cursor:null,view:HOME,cursor:null,previous:[],version:0,restoreScroll:0});
    setArea('assets'); setCollectionsVisited(false); setCatalogVisited(false);
    setStatus(next);
  };
  const demo = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
  return <div className="mobile-app">
    <header className="app-header"><div className="brand"><Mark/><span>LAKOMICS</span><span className="brand-divider"/><span className="section-name">{area === 'catalog' ? 'Catalog' : area === 'collections' ? 'Collections' : page.view.tab === 'home' ? 'Home' : 'Library'}</span></div><div className="header-actions">{demo && <span className="demo-label">디자인 미리보기</span>}<IconButton label="연결 및 설정" icon={AdjustmentsHorizontalIcon} onClick={() => setSettings(true)}/></div></header>
    {status.configured ? <div className="app-body">
      <aside className="desktop-index" style={{display:area!=='assets'?'none':undefined}}><div className="index-title"><span>라이브러리</span><RectangleStackIcon/></div>{indexError && <p className="error-message">{indexError}</p>}<ClassificationIndex items={classifications} view={page.view} onSelect={select} collapsed={collapsed} setCollapsed={setCollapsed}/><div className="index-footer"><span className="status-dot"/>클라우드 연결됨</div></aside>
      <main className="library-main" style={{display:area!=='assets'?'none':undefined}}>
        <div className="gallery-heading"><span className="portrait-only"><IconButton label="분류 열기" icon={Bars3Icon} onClick={() => setDrawer(true)}/></span><div className="location"><span className="location-square"/><h2>{page.view.title}</h2><span className="numeric muted">{page.items.length ? `${page.items.length}개${page.has_more ? '+' : ''}` : ''}</span></div><div className="heading-actions">{page.view.tab === 'library' && <Button variant="ghost" className="density-button" aria-label={`갤러리 밀도: ${DENSITIES[density]}`} onClick={() => setDensity(value => {const next = (value + 1) % 3; store('lakomics.mobile.density',next); return next;})}><span className={`density-symbol density-${density}`} aria-hidden="true">▥</span>{DENSITIES[density]}</Button>}<IconButton label="새로고침" icon={ArrowPathIcon} disabled={busy} onClick={refresh}/></div></div>
        {busy && <div className="loading-line" role="status" aria-label="목록 불러오는 중"/>}
        {error && <div className="inline-error" role="alert"><span>{error}</span><Button onClick={() => {const intent = lastIntent.current; void load(intent.view,intent.cursor,intent.previous);}}>다시 시도</Button></div>}
        {page.view.tab === 'home' ? <Home items={page.items} classifications={classifications} recentFolders={recentFolders} revisit={revisit} captures={captures} busy={busy} paused={area !== 'assets' || settings || !!viewer} secondaryError={secondaryError} revision={page.version} onSelect={select} onOpen={openCurrent} onPending={() => setViewer({items:captures,index:0,pending:true})}/> : <>
        {page.items.length > 0 ? <Gallery items={page.items} density={density} identity={`${viewKey(page.view)}:${page.cursor}:${page.version}`} restoreScroll={page.restoreScroll} onScroll={top => {scroll.current = top;}} onOpen={openCurrent} onReady={thumbnailReady} onNearEnd={nearEnd} paused={area !== 'assets' || settings || !!viewer}/> : <div className="empty-state"><RectangleStackIcon/><h2>{busy ? '라이브러리를 불러오고 있습니다' : '아직 자산이 없습니다'}</h2><p>{busy ? '잠시만 기다려 주세요.' : 'PC에서 보관한 자산이 클라우드에 동기화되면 여기에 나타납니다.'}</p></div>}
        {loadingMore && <div className="loading-line" role="status" aria-label="다음 자산을 불러오는 중"/>}{moreError && <div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" disabled={busy || loadingMore} onClick={() => {void append();}}>다시 시도</Button></div>}
        </>}
      </main>
      {collectionsVisited && <Collections key={status.endpoint} active={area==='collections'} paused={settings || !!viewer || drawer} backRef={collectionBack}/>}
      {catalogVisited && <Catalog key={status.endpoint} active={area==='catalog'} paused={settings || !!viewer || drawer} backRef={catalogBack}/>}
    </div> : <main className="welcome"><Mark/><span className="eyebrow">YOUR ARCHIVE, WITH YOU</span><h1>어디서든,<br/>나의 라이브러리.</h1><p>보관한 이미지와 영상을 감상하고,<br/>다른 앱에 첨부할 때도 바로 찾아보세요.</p><Button variant="primary" disabled={checking} onClick={() => setSettings(true)}>{checking ? '연결 확인 중' : '라이브러리 연결'}<ChevronRightIcon/></Button>{error && <p className="error-message" role="alert">{error}</p>}<span className="welcome-footer">LAKOMICS <span>／</span> MOBILE</span></main>}
    {status.configured && <nav className="bottom-nav" aria-label="주요 탐색"><button className={area==='assets' && page.view.tab === 'home' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'home' ? 'page' : undefined} onClick={() => select(HOME)}><HomeIcon/><span>Home</span></button><button className={area==='assets' && page.view.tab === 'library' ? 'active' : ''} aria-current={area==='assets' && page.view.tab === 'library' ? 'page' : undefined} onClick={() => {setArea('assets');if(page.view.tab === 'library') return; const saved=lastLibrary.current; if(saved) {void load(saved.view,saved.cursor,saved.previous,saved.scroll);} else select({tab:'library',title:'최근 저장'});}}><RectangleStackIcon/><span>Library</span></button><button className={area==='collections'?'active':''} aria-current={area==='collections'?'page':undefined} onClick={()=>{setDrawer(false);setCollectionsVisited(true);setArea('collections');}}><RectangleStackIcon/><span>Collections</span></button><button className={area==='catalog'?'active':''} aria-current={area==='catalog'?'page':undefined} onClick={()=>{setDrawer(false);setCatalogVisited(true);setArea('catalog');}}><RectangleStackIcon/><span>Catalog</span></button></nav>}
    {drawer && <Dialog open title="분류" onClose={() => setDrawer(false)}><DialogDescription className="sr-only">분류를 선택하면 해당 자산 목록을 엽니다.</DialogDescription><div className="dialog-header"><span>라이브러리</span><IconButton label="분류 닫기" icon={XMarkIcon} onClick={() => setDrawer(false)}/></div>{indexError && <p className="error-message">{indexError}</p>}<ClassificationIndex items={classifications} view={page.view} onSelect={select} collapsed={collapsed} setCollapsed={setCollapsed}/></Dialog>}
    {settings && <Settings onCacheCleared={() => {clearMediaCache(); viewCache.current.clear(); setPage(current => ({...current,items:current.items.map(({preview,...asset}) => asset)}));}} status={status} onStatus={updateStatus} onClose={() => setSettings(false)}/>}
    {viewer && <Viewer items={viewer.items} index={viewer.index} onIndex={index => {setViewer({...viewer,index});}} onClose={() => setViewer(null)}/>}
  </div>;
}
