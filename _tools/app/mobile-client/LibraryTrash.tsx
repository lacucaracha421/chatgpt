import {useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, ArrowUturnLeftIcon, CheckCircleIcon, PhotoIcon, TrashIcon} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import {errorText} from './transport';
import {mediaTicket} from './media';
import type {Asset} from './types';
import {
  ASSET_LIFECYCLE_EVENT, TILE_LABEL, dismissLifecycle, formatBytes, readLifecycle, readTrash, setLifecycle,
  trashDate, trashThumbnails, trashTiles, type LifecycleState, type TrashItem, type TrashTile,
} from './libraryTrash';
import './libraryTrash.css';

const POLL = 5000;

/**
 * Full-screen Library Trash browser: what is in the server trash plus this device's
 * not-yet-accepted intents, with restore (single, selection, all). There is no empty action:
 * emptying the trash, and the retention purge, stay on the PC.
 */
export function LibraryTrash({onClose, backRef, known, onRestored}: {
  onClose(): void;
  backRef: MutableRefObject<(() => boolean) | null>;
  /** Assets this session moved to the trash, so a pending tile can show its metadata. */
  known: ReadonlyMap<string, Asset>;
  /** Assets whose restore was queued, so the library can show them again. */
  onRestored?(ids: string[]): void;
}) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [totals, setTotals] = useState({count: 0, bytes: 0});
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [active, setActive] = useState(true);
  const [lifecycle, setLifecycleState] = useState<LifecycleState>({available: false, items: []});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  const activeIds = useRef('');

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    backRef.current = () => { onClose(); return true; };
    return () => { backRef.current = null; };
  }, [backRef, onClose]);

  const reload = useCallback(async () => {
    try {
      const [page, state] = await Promise.all([readTrash(null), readLifecycle().catch(() => ({available: false, items: []}))]);
      if (!alive.current) return;
      setItems(page.items ?? []); setCursor(page.next_cursor); setHasMore(!!page.has_more);
      setTotals({count: page.total_count ?? 0, bytes: page.total_bytes ?? 0}); setActive(page.active !== false);
      setLifecycleState(state); setPhase('ready'); setError('');
      activeIds.current = state.items.filter(row => row.state === 'pending' || row.state === 'sending').map(row => row.assetId).sort().join(',');
    } catch (reason) {
      if (!alive.current) return;
      setError(errorText(reason) || '휴지통을 불러오지 못했습니다.'); setPhase(current => current === 'ready' ? 'ready' : 'error');
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // Follow the native outbox: when an intent settles, the server list has moved too.
  useEffect(() => {
    const apply = (state: LifecycleState) => {
      setLifecycleState(state);
      const ids = state.items.filter(row => row.state === 'pending' || row.state === 'sending').map(row => row.assetId).sort().join(',');
      if (ids !== activeIds.current) { activeIds.current = ids; void reload(); }
    };
    const onEvent = (event: Event) => { const detail = (event as CustomEvent<LifecycleState>).detail; if (detail) setLifecycleState(detail); };
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void readLifecycle().then(apply, () => {}); }, POLL);
    window.addEventListener(ASSET_LIFECYCLE_EVENT, onEvent);
    return () => { clearInterval(timer); window.removeEventListener(ASSET_LIFECYCLE_EVENT, onEvent); };
  }, [reload]);

  const more = async () => {
    if (!cursor || working) return;
    setWorking(true);
    try {
      const page = await readTrash(cursor);
      if (!alive.current) return;
      setItems(current => [...current, ...page.items.filter(item => !current.some(old => old.id === item.id))]);
      setCursor(page.next_cursor); setHasMore(!!page.has_more);
    } catch (reason) { setNotice(errorText(reason)); }
    finally { if (alive.current) setWorking(false); }
  };

  const tiles = useMemo(() => trashTiles(items, lifecycle, known), [items, lifecycle, known]);

  // Thumbnails: trashed Assets through the trash-scoped tickets; a pending trash is still an
  // ordinary Asset on the server and uses the ordinary (cached) thumbnail.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const missing = tiles.filter(tile => !requested.current.has(`${tile.onServer}:${tile.id}`) && tile.status !== 'deleted' && tile.asset.thumbnail_available !== false);
    for (const tile of missing) requested.current.add(`${tile.onServer}:${tile.id}`);
    const server = missing.filter(tile => tile.onServer).map(tile => tile.id);
    for (let at = 0; at < server.length; at += 50) {
      void trashThumbnails(server.slice(at, at + 50)).then(urls => {
        if (alive.current && Object.keys(urls).length) setThumbs(current => ({...current, ...urls}));
      }, () => {});
    }
    for (const tile of missing.filter(tile => !tile.onServer)) {
      void mediaTicket(tile.asset, 'thumbnail').then(ticket => {
        if (alive.current) setThumbs(current => ({...current, [tile.id]: ticket.url}));
      }, () => {});
    }
  }, [tiles]);

  const selectable = tiles.filter(tile => tile.status !== 'restoring');
  const allSelected = selectable.length > 0 && selectable.every(tile => selected.has(tile.id));
  const toggle = (tile: TrashTile) => setSelected(current => {
    const next = new Set(current);
    if (next.has(tile.id)) next.delete(tile.id); else next.add(tile.id);
    return next;
  });

  const restore = async (chosen: TrashTile[]) => {
    if (!chosen.length || working) return;
    setWorking(true); setNotice('');
    const restored: string[] = [];
    try {
      for (const tile of chosen) {
        if (tile.status === 'restoring') continue;
        if (tile.status === 'deleted') { await dismissLifecycle(tile.id); continue; }
        const state = await setLifecycle(tile.id, 'restore', tile.entityRevision);
        if (!alive.current) return;
        setLifecycleState(state);
        if (state.tombstoned) setNotice('영구 삭제된 항목은 복원할 수 없습니다.');
        else restored.push(tile.id);
      }
      if (restored.length) onRestored?.(restored);
      setSelected(new Set());
    } catch (reason) { setNotice(errorText(reason) || '복원을 요청하지 못했습니다.'); }
    finally { if (alive.current) setWorking(false); }
  };

  const moving = tiles.filter(tile => tile.status === 'moving').length;
  const chosen = tiles.filter(tile => selected.has(tile.id));
  const deferred = lifecycle.code === 'unauthorized' ? '서버를 업데이트하면 대기 중인 항목이 전송됩니다.' : '';
  return <div className="trash-overlay" role="dialog" aria-modal="true" aria-label="휴지통">
    <header className="trash-bar">
      <IconButton label="휴지통 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="trash-title"><h1>휴지통</h1>
        {phase === 'ready' && <p className="numeric" aria-live="polite">{totals.count}개 · {formatBytes(totals.bytes)}{moving > 0 && ` · 이동 대기 ${moving}`}</p>}
      </div>
      {tiles.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map(tile => tile.id)))}>{allSelected ? '선택 해제' : '전체 선택'}</Button>}
    </header>
    <p className="hint trash-hint">비우기는 PC에서 할 수 있습니다. 보존 기간이 지나면 PC가 영구 삭제합니다.</p>
    {(notice || deferred) && <p className="error-message trash-notice" role="alert">{notice || deferred}</p>}
    {phase === 'loading' && <div className="loading-line" role="status" aria-label="휴지통 불러오는 중"/>}
    {phase === 'error' && <div className="empty-state trash-empty"><h2>휴지통을 불러오지 못했습니다</h2><p>{error}</p><Button onClick={() => { setPhase('loading'); void reload(); }}>다시 시도</Button></div>}
    {phase === 'ready' && !tiles.length && <div className="empty-state trash-empty"><TrashIcon aria-hidden="true"/><h2>휴지통이 비어 있습니다</h2>{!active && <p>이 서버는 아직 휴지통 동기화를 지원하지 않습니다.</p>}</div>}
    {phase === 'ready' && tiles.length > 0 && <div className="trash-scroll">
      <div className="trash-grid">
        {tiles.map(tile => {
          const label = TILE_LABEL[tile.status];
          const on = selected.has(tile.id);
          return <button key={tile.id} className="trash-tile" data-status={tile.status} aria-pressed={on} disabled={tile.status === 'restoring'}
            aria-label={`${tile.asset.creator_name || tile.asset.creator_handle || '자산'}${label ? `, ${label}` : ''}${tile.trashedAt ? `, ${trashDate(tile.trashedAt)}` : ''}`}
            onClick={() => toggle(tile)}>
            {thumbs[tile.id] ? <img src={thumbs[tile.id]} alt="" draggable={false}/> : <span className="trash-missing"><PhotoIcon aria-hidden="true"/></span>}
            {label && <span className="trash-badge">{label}</span>}
            {on && <CheckCircleIcon className="trash-check" aria-hidden="true"/>}
            <span className="trash-date numeric">{trashDate(tile.trashedAt)}</span>
          </button>;
        })}
      </div>
      {hasMore && <div className="trash-more"><Button variant="ghost" disabled={working} onClick={() => { void more(); }}>더 보기</Button></div>}
    </div>}
    {phase === 'ready' && tiles.length > 0 && <footer className="trash-actions">
      <span className="numeric muted">{chosen.length ? `${chosen.length}개 선택` : '복원할 항목을 선택하세요'}</span>
      <Button variant="primary" disabled={!chosen.length || working} onClick={() => { void restore(chosen); }}><ArrowUturnLeftIcon aria-hidden="true"/>복원</Button>
    </footer>}
  </div>;
}

/** "휴지통으로 이동함 · 실행 취소": shown for ~6 s after a trash, in the viewer or the library. */
export function TrashSnackbar({onUndo, message = '휴지통으로 이동함'}: {onUndo(): void; message?: string}) {
  return <div className="trash-snackbar" role="status">
    <span>{message}</span>
    <Button variant="ghost" onClick={onUndo}><ArrowUturnLeftIcon aria-hidden="true"/>실행 취소</Button>
  </div>;
}
