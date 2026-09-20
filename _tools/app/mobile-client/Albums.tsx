import {useCallback, useEffect, useRef, useState} from 'react';
import {FunnelIcon, RectangleStackIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {api, errorText, native} from './transport';
import {normalizePage, viewKey} from './model';
import type {Asset, AssetFiltersValue, Page} from './types';
import {ASSET_FILTER_VERSION, EMPTY_FILTERS, hasActiveFilters, sameFilters, withFilters} from './assetFilters';
import {AssetFilters, filterSummary} from './AssetFilters';
import {Gallery} from './Gallery';
import {ClassificationIcon, classificationColor} from '../src/classification/classificationAppearance';

/**
 * The additive Albums section.
 *
 * Classification and Album are separate canonical domains: the sidebar's Classification
 * and Character navigation is untouched and remains the only folder tree, while this
 * section reads Albums from the adopted replica. Album nodes are never merged into the
 * Classification hierarchy, and when nothing is adopted the section renders nothing at
 * all rather than an empty tree — only Album-specific surfaces are affected.
 */
export interface NativeAlbum { id: string; name: string; parentId: string | null; iconKey: string | null; colorKey: string | null }
/**
 * One Album row's icon. The replica's `iconKey`/`colorKey` use the PC appearance contract
 * (`folder_appearance.rs`).
 */
function AlbumIcon({album}: {album: NativeAlbum}) {
  return <ClassificationIcon kind="tag" iconKey={album.iconKey} testId={false} style={{color: classificationColor(album.colorKey)}}/>;
}
export interface AlbumTree { adopted: boolean; libraryId: string | null; epoch: number | null; code: string; albums: NativeAlbum[] }
/**
 * The Album scope's own response envelope, normalized into the shared page shape once.
 *
 * `filterVersion` is the agreed wire name for every page route, so this is the only place
 * the Album reader translates its camelCase envelope into the normalized page contract.
 * A reply that declares nothing stays undeclared, which is what the guards then refuse.
 */
interface AlbumAssetPage { items: Asset[]; hasMore: boolean; nextCursor: string | null; filterVersion?: unknown }
function albumPage(value: AlbumAssetPage): Page {
  return normalizePage({items:value.items,has_more:value.hasMore,next_cursor:value.nextCursor,
    filterVersion:value.filterVersion});
}

/**
 * Breadcrumb for one Album from the replica hierarchy.
 *
 * `seen` bounds the walk: `Set#add` returns the Set, so testing its return value would
 * never terminate on a cyclic hierarchy. The membership is checked first, so a malformed
 * hierarchy renders a partial path instead of hanging the section.
 */
export function albumPath(albums: NativeAlbum[], id: string): string {
  const byId = new Map(albums.map(album => [album.id, album]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const album = byId.get(current);
    if (!album) break;
    path.unshift(album.name);
    current = album.parentId ?? null;
  }
  return path.join(' / ');
}
export function Albums({active, paused, onOpen, backRef}: {active: boolean; paused: boolean; onOpen(items: Asset[], index: number): void; backRef: React.MutableRefObject<(() => boolean) | null>}) {
  const [tree, setTree] = useState<AlbumTree | null>(null), [treeError, setTreeError] = useState('');
  const [open, setOpen] = useState<NativeAlbum | null>(null);
  const [page, setPage] = useState<Page>({items: [], has_more: false, next_cursor: null});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [moreError, setMoreError] = useState(''), [loadingMore, setLoadingMore] = useState(false);
  // `committed` is what the visible page actually was fetched under, and it is updated only
  // after a successful load. `attempted` is the filter set the user has chosen, including a
  // choice whose request failed, so a retry can repeat it and the dialog can still show it.
  // Keeping them separate is what stops a failed request from labelling the old unfiltered
  // page as filtered, and stops an append from mixing the old cursor with new filters.
  const [committed, setCommitted] = useState<{album:NativeAlbum; filters:AssetFiltersValue} | null>(null);
  const [attempted, setAttempted] = useState<AssetFiltersValue>({...EMPTY_FILTERS});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const gate = useRef<AbortController | null>(null), moreGate = useRef<AbortController | null>(null);
  const morePending = useRef(false);
  const latest = useRef({open, page, paused, committed, attempted, filtersOpen}); latest.current = {open, page, paused, committed, attempted, filtersOpen};

  const loadTree = useCallback(async (signal: AbortSignal) => {
    setTreeError('');
    try {
      const value = await native<AlbumTree>('albumTree', {}, signal);
      if (!signal.aborted) setTree(value);
    } catch (reason) { if (!signal.aborted) setTreeError(errorText(reason)); }
  }, []);
  // The replica converges on its own cadence, so re-reading it when the section becomes
  // visible or the app resumes is what keeps the list current without polling here.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void loadTree(controller.signal);
    const onResume = () => { const next = new AbortController(); void loadTree(next.signal); };
    window.addEventListener('lakomics-resume', onResume);
    return () => {controller.abort(); window.removeEventListener('lakomics-resume', onResume);};
  }, [active, loadTree]);

  /**
   * Fetch one Album scope. Returns whether this call's result became the visible page.
   *
   * The returned page is committed together with the Album and the filter set it was
   * fetched under, in one `setCommitted`/`setPage` step after the response is validated.
   * Nothing is committed on failure, so the previous page and the filter set it belongs to
   * stay consistent with each other and with the heading that describes them.
   */
  const load = useCallback(async (album: NativeAlbum, cursor: string | null, nextFilters: AssetFiltersValue = EMPTY_FILTERS) => {
    gate.current?.abort();
    // A new scope or filter invalidates any in-flight continuation: its cursor belongs to
    // the result set being replaced, so appending it would splice two different queries.
    moreGate.current?.abort(); morePending.current = false; setLoadingMore(false); setMoreError('');
    const controller = new AbortController(); gate.current = controller;
    setBusy(true); setError('');
    try {
      if (!tree?.adopted || tree.libraryId === null || tree.epoch === null) throw new Error('앨범 권위가 아직 활성화되지 않았습니다.');
      const params = new URLSearchParams({libraryId: tree.libraryId, epoch: String(tree.epoch), albumId: album.id, limit: '40'});
      if (cursor) params.set('cursor', cursor);
      const response = albumPage(await api<AlbumAssetPage>(withFilters(`/v1/albums/assets?${params}`, nextFilters), controller.signal));
      if (controller.signal.aborted) return false;
      // An Album page that asked for filters but did not declare the contract was answered
      // by a server that ignored the parameters, so it is refused like the Library scope.
      if (hasActiveFilters(nextFilters) && response.filter_version !== ASSET_FILTER_VERSION)
        throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      setPage(response);
      setCommitted({album, filters:nextFilters});
      return true;
    } catch (reason) { if (!controller.signal.aborted) setError(errorText(reason)); return false; }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [tree]);
  const append = useCallback(async () => {
    const state = latest.current;
    // Appending is allowed only when the visible page was committed under the same Album
    // and filter set, and no committed scope is absent after a failure.
    if (loadingMore || morePending.current || !state.page.has_more || !state.page.next_cursor) return;
    if (!state.committed || state.committed.album.id !== state.open?.id) return;
    // A failed initial load means the visible page belongs to a *previous* filter set, so
    // its cursor must not be extended with the filters the user has since chosen.
    if (!sameFilters(state.attempted, state.committed.filters)) return;
    moreGate.current?.abort();
    const controller = new AbortController(); moreGate.current = controller;
    morePending.current = true; setLoadingMore(true); setMoreError('');
    const {album, filters} = state.committed;
    try {
      if (!tree?.libraryId || tree.epoch === null) throw new Error('앨범 권위가 아직 활성화되지 않았습니다.');
      const params = new URLSearchParams({libraryId: tree.libraryId, epoch: String(tree.epoch), albumId: album.id, limit: '40', cursor: state.page.next_cursor});
      // The continuation carries the filter set the committed page was fetched under.
      const response = albumPage(await api<AlbumAssetPage>(withFilters(`/v1/albums/assets?${params}`, filters), controller.signal));
      if (controller.signal.aborted) return;
      // Every page is validated, not only the first: a server that drops the contract
      // part-way through a walk would otherwise append unfiltered rows to a filtered list.
      if (hasActiveFilters(filters) && response.filter_version !== ASSET_FILTER_VERSION)
        throw new Error('자산 필터 응답을 확인할 수 없습니다. 서버를 업데이트해 주세요.');
      setPage(current => {
        const seen = new Set(current.items.map(item => item.id));
        return {...current, items: [...current.items, ...response.items.filter(item => !seen.has(item.id))], has_more: response.has_more, next_cursor: response.next_cursor};
      });
    } catch (reason) { if (!controller.signal.aborted) setMoreError(errorText(reason)); }
    finally { if (controller.signal.aborted) return; morePending.current = false; setLoadingMore(false); }
  }, [tree, loadingMore]);
  /** Open one Album as a fresh scope. Its filters start empty and commit with its first page. */
  const openAlbum = useCallback((album: NativeAlbum) => {
    setOpen(album); setAttempted({...EMPTY_FILTERS}); setFiltersOpen(false); setCommitted(null); setPage({items:[],has_more:false,next_cursor:null});
    void load(album, null, EMPTY_FILTERS);
  }, [load]);
  /**
   * Commit one filter choice against the open Album.
   *
   * The choice is recorded as attempted immediately so the dialog and a retry keep it, but
   * the committed identity changes only if the request succeeds. `load` already aborts an
   * in-flight append, so a continuation of the replaced result set cannot land afterwards.
   */
  const applyFilters = useCallback((next: AssetFiltersValue) => {
    const album = latest.current.open;
    setFiltersOpen(false);
    if (!album || sameFilters(next, latest.current.attempted)) return;
    setAttempted(next);
    void load(album, null, next);
  }, [load]);
  /** Retry the current attempt, which is the filter set the last failed request used. */
  const retry = useCallback(() => {
    const state = latest.current;
    if (state.open) void load(state.open, null, state.attempted);
  }, [load]);

  useEffect(() => {
    backRef.current = () => {
      if (!latest.current.open) return false;
      // The filter dialog is nested inside the Album dialog, and `App` owns the only Back
      // handler. The inner surface is closed here and the press is still consumed, so one
      // press cannot dismiss both surfaces: a later press closes the Album itself.
      if (latest.current.filtersOpen) { setFiltersOpen(false); return true; }
      setOpen(null); return true;
    };
    return () => { backRef.current = null; };
  }, [backRef]);
  useEffect(() => () => {gate.current?.abort(); moreGate.current?.abort();}, []);

  if (!tree) return treeError ? <p className="error-message">{treeError}</p> : null;
  // Only Album-specific state disappears when nothing is adopted; the Classification
  // sidebar above and below this component is unaffected.
  if (!tree.adopted || !tree.albums.length) return null;
  const known = new Set(tree.albums.map(album => album.id));
  // A child of an Album the replica does not hold would otherwise be unreachable, so it
  // is shown at the top level rather than silently dropped.
  const top = tree.albums.filter(album => album.parentId === null || !known.has(album.parentId));
  const children = open ? tree.albums.filter(album => album.parentId === open.id) : [];
  // What the visible page actually is, versus what the user has asked for. The heading
  // describes the committed page, so a failed (or in-flight) narrowed request never makes an
  // unfiltered list look filtered.
  const shown = committed && open && committed.album.id === open.id ? committed.filters : EMPTY_FILTERS;
  const pendingFilters = open && !sameFilters(attempted, shown);

  return <section className="album-section" aria-label="앨범">
    <div className="index-title"><span>앨범</span></div>
    <ul className="album-list">{top.map(album => <li key={album.id}>
      <button className={open?.id === album.id ? 'active' : ''} onClick={() => openAlbum(album)}><AlbumIcon album={album}/><span>{album.name}</span></button>
    </li>)}</ul>
    {open && <Dialog open title={open.name} onClose={() => setOpen(null)}>
      <div className="album-dialog-content">
        <DialogDescription className="sr-only">{albumPath(tree.albums, open.id)}의 자산 목록입니다.</DialogDescription>
        <div className="dialog-header"><span>{albumPath(tree.albums, open.id)}</span><IconButton label={hasActiveFilters(attempted) ? `자산 필터: ${filterSummary(attempted)}` : '자산 필터'} icon={FunnelIcon} active={hasActiveFilters(attempted)} onClick={() => setFiltersOpen(true)}/><IconButton label="앨범 닫기" icon={XMarkIcon} onClick={() => setOpen(null)}/></div>
        {hasActiveFilters(shown) && <span className="asset-filter-summary">{filterSummary(shown)}</span>}
        {children.length > 0 && <ul className="album-list">{children.map(album => <li key={album.id}>
          <button onClick={() => openAlbum(album)}><AlbumIcon album={album}/><span>{album.name}</span></button>
        </li>)}</ul>}
        {busy && <div className="loading-line" role="status" aria-label="앨범 자산을 불러오는 중"/>}
        {error && <div className="inline-error" role="alert"><span>{error}</span><Button onClick={retry}>다시 시도</Button></div>}
        {page.items.length > 0 && <Gallery items={page.items} density={1} identity={viewKey({tab:'library',title:open.name}, shown)} restoreScroll={0} onScroll={() => {}} onOpen={index => onOpen(page.items, index)} onReady={() => {}} onNearEnd={() => {if (!paused && !busy && !moreError) void append();}} paused={paused}/>}
        {!page.items.length && !busy && !error && (hasActiveFilters(shown)
          ? <div className="empty-state"><RectangleStackIcon/><h2>조건에 맞는 자산이 없습니다</h2><p>필터를 해제하면 이 앨범의 자산을 모두 볼 수 있습니다.</p></div>
          : <div className="empty-state"><RectangleStackIcon/><h2>이 앨범에 자산이 없습니다</h2><p>PC에서 이 앨범에 추가한 자산이 동기화되면 여기에 나타납니다.</p></div>)}
        {loadingMore && <div className="loading-line" role="status" aria-label="다음 자산을 불러오는 중"/>}
        {moreError && <div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" onClick={() => void append()}>다시 시도</Button></div>}
      </div>
    </Dialog>}
    {/* One shared filter surface, so the Album scope cannot drift from the Library scope.
        It shows the attempted set, so a failed choice is still visible and retryable. */}
    {filtersOpen && <Dialog open title="자산 필터" onClose={() => setFiltersOpen(false)}><DialogDescription className="sr-only">미디어 종류, 비율과 영상 길이로 앨범 자산 목록을 좁힙니다.</DialogDescription><AssetFilters value={attempted} onChange={applyFilters}/>{pendingFilters && !busy && error && <p className="hint">선택한 필터가 아직 적용되지 않았습니다. 다시 시도하거나 필터를 해제해 주세요.</p>}<div className="view-settings-footer"><Button variant="ghost" onClick={() => setFiltersOpen(false)}>닫기</Button></div></Dialog>}
  </section>;
}
