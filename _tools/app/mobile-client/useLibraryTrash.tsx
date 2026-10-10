import {onVisible, visibleInterval} from './useVisibleInterval';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {errorText} from './transport';
import type {Asset} from './types';
import {ASSET_LIFECYCLE_EVENT, pendingTrashIds, readLifecycle, setLifecycle, type LifecycleState} from './libraryTrashModel';
import {TrashSnackbar} from './LibraryTrash';

const UNDO_MS = 6000;
/** How long after a local trash/restore a list-generation change keeps the viewer open. */
const OWN_CHANGE_MS = 60_000;
/** Availability poll while the lifecycle replica is not adopted yet. */
const AVAILABILITY_POLL_MS = 15_000;

type ViewerLike = {items: Asset[]; index: number};

/**
 * App-level Library Trash state: which Assets to hide locally, the undo snackbar and the
 * trash browser. The native outbox is the durable truth; this hook only mirrors it so the
 * library hides a trashed Asset at once, before the server has accepted it.
 */
export function useLibraryTrash<V extends ViewerLike>(configured: boolean, endpoint: string,
  setViewer: (update: (current: V | null) => V | null) => void) {
  const [available, setAvailable] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden;
  const known = useRef(new Map<string, Asset>());
  const [knownVersion, setKnownVersion] = useState(0);
  const [undo, setUndo] = useState<{asset: Asset; index: number; key: number} | null>(null);
  const [batchUndo,setBatchUndo]=useState<{ids:string[];key:number}|null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const backRef = useRef<(() => boolean) | null>(null);
  const changedAt = useRef(0);
  const connection=useRef(endpoint);connection.current=endpoint;

  // A new connection starts with nothing hidden and nothing to undo.
  useEffect(() => {
    known.current.clear(); setHidden(new Set()); setUndo(null); setBatchUndo(null); setError(''); setOpen(false); setAvailable(false);
  }, [endpoint]);

  useEffect(() => {
    if (!configured) return;
    let active = true;
    // The lifecycle replica is adopted by the first native pass, so availability can arrive
    // late: poll only until it has. After that every local edit arrives as an event, and a
    // resume re-reads once (a replaced connection or intents queued before a restart).
    let poll: (() => void) | undefined;
    const polling = (on: boolean) => {
      if (on && !poll && active) poll = visibleInterval(read, AVAILABILITY_POLL_MS);
      else if (!on && poll) { poll(); poll = undefined; }
    };
    const apply = (state: LifecycleState) => {
      if (!active) return;
      setAvailable(state.available);
      polling(!state.available);
      const pending = pendingTrashIds(state);
      if (pending.length) setHidden(current => pending.every(id => current.has(id)) ? current : new Set([...current, ...pending]));
    };
    function read() { void readLifecycle().then(apply, () => {}); }
    const onEvent = (event: Event) => { const detail = (event as CustomEvent<LifecycleState>).detail; if (detail) apply(detail); };
    if(document.visibilityState!=='hidden')read();
    polling(true);
    // While polling, the interval already reads on resume.
    const removeResume = onVisible(() => { if (!poll) read(); });
    window.addEventListener(ASSET_LIFECYCLE_EVENT, onEvent);
    return () => { active = false; polling(false); removeResume(); window.removeEventListener(ASSET_LIFECYCLE_EVENT, onEvent); };
  }, [configured, endpoint]);

  useEffect(() => {
    if (!undo && !batchUndo && !error) return;
    const timer = window.setTimeout(() => { setUndo(null); setBatchUndo(null); setError(''); }, UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo, batchUndo, error]);

  /** Move one Asset to the trash from the viewer: no confirmation, advance, offer undo. */
  const trash = useCallback(async (asset: Asset, index: number) => {
    setError('');setBatchUndo(null);
    try {
      const state = await setLifecycle(asset.id, 'trash');
      if (state.tombstoned) { setError('이미 영구 삭제된 자산입니다.'); return; }
    } catch (reason) { setError(errorText(reason) || '휴지통으로 옮기지 못했습니다.'); return; }
    known.current.set(asset.id, asset); setKnownVersion(value => value + 1);
    changedAt.current = Date.now();
    setHidden(current => new Set(current).add(asset.id));
    setViewer(current => {
      if (!current) return current;
      const at = current.items.findIndex(item => item.id === asset.id);
      if (at < 0) return current;
      const items = current.items.filter(item => item.id !== asset.id);
      if (!items.length) return null;
      // The next Asset slides into the same position; at the end, the previous one shows.
      return {...current, items, index: Math.min(at, items.length - 1)};
    });
    setUndo({asset, index, key: Date.now()});
  }, [setViewer]);

  /** Batch writes report refusals to the selection bar; they never become permanent deletion. */
  const trashSelected = useCallback(async (asset: Asset) => {
    const state = await setLifecycle(asset.id, 'trash');
    const row = state.items.find(item => item.assetId === asset.id);
    if (!state.available || state.tombstoned || row?.state === 'blocked' || row?.state === 'dropped') {
      throw new Error('휴지통으로 옮기지 못했습니다. 다시 시도해 주세요.');
    }
    known.current.set(asset.id, asset); setKnownVersion(value => value + 1);
    changedAt.current = Date.now();
    setHidden(current => new Set(current).add(asset.id));
  }, []);

  const offerBatchUndo=useCallback((ids:string[])=>{
    if(ids.length){setUndo(null);setError('');setBatchUndo({ids,key:Date.now()});}
  },[]);
  const undoBatch=useCallback(async()=>{
    const last=batchUndo;setBatchUndo(null);
    if(!last)return;
    const owner=endpoint;
    const restoredIds:string[]=[],failedIds:string[]=[];
    for(const id of last.ids){
      if(connection.current!==owner)return;
      try {
        const state=await setLifecycle(id,'restore');
        if(connection.current!==owner)return;
        const row=state.items.find(item=>item.assetId===id);
        if(!state.available||state.tombstoned||row?.state==='blocked'||row?.state==='dropped')throw new Error('복원 실패');
        restoredIds.push(id);
      } catch {failedIds.push(id);}
    }
    changedAt.current=Date.now();
    setHidden(current=>{const next=new Set(current);for(const id of restoredIds)next.delete(id);return next;});
    if(failedIds.length)setError(`${last.ids.length}개 중 ${failedIds.length}개를 되돌리지 못했습니다. 휴지통에서 다시 시도해 주세요.`);
  },[batchUndo,endpoint]);

  /** Undo: cancels a not-yet-sent trash, or sends the restore after it. */
  const undoLast = useCallback(async () => {
    const last = undo;
    setUndo(null);
    if (!last) return;
    try { await setLifecycle(last.asset.id, 'restore'); }
    catch (reason) { setError(errorText(reason) || '되돌리지 못했습니다.'); return; }
    changedAt.current = Date.now();
    setHidden(current => { const next = new Set(current); next.delete(last.asset.id); return next; });
    setViewer(current => {
      if (!current || current.items.some(item => item.id === last.asset.id)) return current;
      const at = Math.min(last.index, current.items.length);
      return {...current, items: [...current.items.slice(0, at), last.asset, ...current.items.slice(at)], index: at};
    });
  }, [undo, setViewer]);

  /** The trash browser queued restores: show those Assets again. */
  const restored = useCallback((ids: string[]) => {
    changedAt.current = Date.now();
    setHidden(current => { const next = new Set(current); for (const id of ids) next.delete(id); return next; });
  }, []);

  /** Whether a list refresh was probably caused by this device's own trash or restore. */
  const recent = useCallback(() => Date.now() - changedAt.current < OWN_CHANGE_MS, []);

  const snackbar: ReactNode = error
    ? <div className="trash-snackbar" role="alert"><span>{error}</span></div>
    : batchUndo ? <TrashSnackbar key={batchUndo.key} onUndo={()=>{void undoBatch();}}/>
    : undo ? <TrashSnackbar key={undo.key} onUndo={() => { void undoLast(); }}/> : null;

  return {available, hidden, hiddenRef, known: known.current, knownVersion, open, setOpen, backRef, trash, trashSelected, offerBatchUndo, restored, recent, snackbar};
}
