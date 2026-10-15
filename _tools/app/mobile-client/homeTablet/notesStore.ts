import {NotesStore} from '../../src/notes/store';
import {mobileNotesRequest} from '../notesTransport';

const stores = new Map<string, NotesStore>();

/** The notes store Home's 빠른 메모 and 링크 보관 write through, one per server, kept across Home visits so a queued edit is never dropped. */
export function tabletHomeNotes(scope: string): NotesStore {
  let store = stores.get(scope);
  if (!store) { store = new NotesStore(mobileNotesRequest); stores.set(scope, store); }
  return store;
}

export function resetTabletHomeNotes() { stores.clear(); }
