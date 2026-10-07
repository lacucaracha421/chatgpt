import {useSyncExternalStore} from 'react';
import {deletedTrashNotes, type TrashSection} from '../src/safety/trashSections';
import type {NotesStore} from '../src/notes/store';

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
