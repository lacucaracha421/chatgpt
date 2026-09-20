import {useCallback, useEffect, useRef, useState} from 'react';
import {RectangleStackIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {api, errorText, native} from './transport';
import {normalizePage} from './model';
import type {Asset, Page} from './types';
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
interface AlbumAssetPage { items: Asset[]; hasMore: boolean; nextCursor: string | null }
function albumPage(value: AlbumAssetPage): Page {
  return normalizePage({items:value.items,has_more:value.hasMore,next_cursor:value.nextCursor});
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
  const gate = useRef<AbortController | null>(null), moreGate = useRef<AbortController | null>(null);
  const latest = useRef({open, page, paused}); latest.current = {open, page, paused};

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

  const load = useCallback(async (album: NativeAlbum, cursor: string | null) => {
    gate.current?.abort();
    const controller = new AbortController(); gate.current = controller;
    setBusy(true); setError('');
    try {
      if (!tree?.adopted || tree.libraryId === null || tree.epoch === null) throw new Error('앨범 권위가 아직 활성화되지 않았습니다.');
      const params = new URLSearchParams({libraryId: tree.libraryId, epoch: String(tree.epoch), albumId: album.id, limit: '40'});
      if (cursor) params.set('cursor', cursor);
      const response = albumPage(await api<AlbumAssetPage>(`/v1/albums/assets?${params}`, controller.signal));
      if (!controller.signal.aborted) setPage(response);
    } catch (reason) { if (!controller.signal.aborted) setError(errorText(reason)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [tree]);
  const append = useCallback(async () => {
    const state = latest.current;
    if (loadingMore || !state.page.has_more || !state.page.next_cursor || !state.open) return;
    moreGate.current?.abort();
    const controller = new AbortController(); moreGate.current = controller;
    setLoadingMore(true); setMoreError('');
    try {
      if (!tree?.libraryId || tree.epoch === null) throw new Error('앨범 권위가 아직 활성화되지 않았습니다.');
      const params = new URLSearchParams({libraryId: tree.libraryId, epoch: String(tree.epoch), albumId: state.open.id, limit: '40', cursor: state.page.next_cursor});
      const response = albumPage(await api<AlbumAssetPage>(`/v1/albums/assets?${params}`, controller.signal));
      if (controller.signal.aborted) return;
      setPage(current => {
        const seen = new Set(current.items.map(item => item.id));
        return {...current, items: [...current.items, ...response.items.filter(item => !seen.has(item.id))], has_more: response.has_more, next_cursor: response.next_cursor};
      });
    } catch (reason) { if (!controller.signal.aborted) setMoreError(errorText(reason)); }
    finally { if (!controller.signal.aborted) setLoadingMore(false); }
  }, [tree, loadingMore]);

  useEffect(() => {
    backRef.current = () => { if (!latest.current.open) return false; setOpen(null); return true; };
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

  return <section className="album-section" aria-label="앨범">
    <div className="index-title"><span>앨범</span></div>
    <ul className="album-list">{top.map(album => <li key={album.id}>
      <button className={open?.id === album.id ? 'active' : ''} onClick={() => {setOpen(album); void load(album, null);}}><AlbumIcon album={album}/><span>{album.name}</span></button>
    </li>)}</ul>
    {open && <Dialog open title={open.name} onClose={() => setOpen(null)}>
      <div className="album-dialog-content">
        <DialogDescription className="sr-only">{albumPath(tree.albums, open.id)}의 자산 목록입니다.</DialogDescription>
        <div className="dialog-header"><span>{albumPath(tree.albums, open.id)}</span><IconButton label="앨범 닫기" icon={XMarkIcon} onClick={() => setOpen(null)}/></div>
        {children.length > 0 && <ul className="album-list">{children.map(album => <li key={album.id}>
          <button onClick={() => {setOpen(album); void load(album, null);}}><AlbumIcon album={album}/><span>{album.name}</span></button>
        </li>)}</ul>}
        {busy && <div className="loading-line" role="status" aria-label="앨범 자산을 불러오는 중"/>}
        {error && <div className="inline-error" role="alert"><span>{error}</span><Button onClick={() => void load(open, null)}>다시 시도</Button></div>}
        {page.items.length > 0 && <Gallery items={page.items} density={1} identity={`album:${open.id}`} restoreScroll={0} onScroll={() => {}} onOpen={index => onOpen(page.items, index)} onReady={() => {}} onNearEnd={() => {if (!paused && !busy && !moreError) void append();}} paused={paused}/>}
        {!page.items.length && !busy && !error && <div className="empty-state"><RectangleStackIcon/><h2>이 앨범에 자산이 없습니다</h2><p>PC에서 이 앨범에 추가한 자산이 동기화되면 여기에 나타납니다.</p></div>}
        {loadingMore && <div className="loading-line" role="status" aria-label="다음 자산을 불러오는 중"/>}
        {moreError && <div className="inline-error" role="alert"><span>{moreError}</span><Button variant="ghost" onClick={() => void append()}>다시 시도</Button></div>}
      </div>
    </Dialog>}
  </section>;
}
