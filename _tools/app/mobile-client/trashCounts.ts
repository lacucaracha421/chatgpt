import {useSyncExternalStore} from 'react';
import {deletedTrashNotes, type TrashSection} from '../src/safety/trashSections';
import type {NotesStore} from '../src/notes/store';
import {api} from './transport';
import {AUTHORITY_STATUS_PATH, authorityIdentity, sameAuthority} from './collectionCommandOutbox';
import type {AuthorityIdentity} from './collectionCommandOutbox';
import type {TrashPage} from './libraryTrashModel';

/** Read a complete total for this opening. Partial, locked and paginated reads have no total. */
export async function readTabletTrashCount(endpoint:string, store:NotesStore, signal:AbortSignal):Promise<number|null> {
  try {
    const [assets, collections] = await Promise.all([
      api<TrashPage>('/v1/library/trash?limit=1',signal,undefined,'GET',false,endpoint),
      (async()=>{
        const identity=authorityIdentity(await api(AUTHORITY_STATUS_PATH,signal,undefined,'GET',false,endpoint));
        if(!identity)return null;
        const params=new URLSearchParams({libraryId:identity.libraryId,epoch:String(identity.epoch)});
        const reply=await api<AuthorityIdentity&{items:unknown[];hasMore?:boolean}>(`/v1/collections/authority/trash?${params}`,signal,undefined,'GET',false,endpoint);
        return sameAuthority(reply,identity)&&Array.isArray(reply.items)&&!reply.hasMore?reply.items.length:null;
      })(),
      store.refresh(),
    ]);
    const notes=store.snapshot();
    if(signal.aborted||!assets.active||!Number.isSafeInteger(assets.total_count)||assets.total_count<0||collections===null||!notes.ready||!notes.unlocked||notes.error)return null;
    return assets.total_count+collections+deletedTrashNotes(notes.notes).length;
  } catch { return null; }
}

const counts = new Map<string, Partial<Record<TrashSection, number>>>();
const listeners = new Set<() => void>();
export function setTabletTrashCount(endpoint: string, section: TrashSection, count: number) {
  const current = counts.get(endpoint) ?? {};
  if (current[section] === count) return;
  counts.set(endpoint, {...current, [section]:count});
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useTabletTrashCount(endpoint: string, store: NotesStore) {
  const known = useSyncExternalStore(subscribe, () => counts.get(endpoint));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return (known?.assets ?? 0) + (known?.collections ?? 0) + (state.ready ? deletedTrashNotes(state.notes).length : known?.notes ?? 0);
}
