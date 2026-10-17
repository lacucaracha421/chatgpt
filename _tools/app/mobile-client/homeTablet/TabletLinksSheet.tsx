import {useEffect} from 'react';
import type {NotesStore} from '../../src/notes/store';
import {BottomSheet} from '../BottomSheet';
import {TabletLinks} from './TabletLinks';
import './homeTablet.css';

/**
 * 링크 보관 left Home (HOME-CAL-001) and opens from 더보기 and 찾기: the same dedicated note, here as a sheet with
 * the paste field and every kept link.
 */
export function TabletLinksSheet({store, root, privacy, onOpenNotes, onClose}: {store: NotesStore; root: string; privacy: boolean; onOpenNotes(): void; onClose(): void}) {
  // Home loads the store on its own visits; opened from another tab, the sheet reads it itself.
  useEffect(() => { void (store.snapshot().ready ? store.refresh() : store.load()); }, [store]);
  return <BottomSheet title="링크 보관" onClose={onClose}>
    <div className="home-links-sheet"><TabletLinks store={store} root={root} privacy={privacy} all onOpenNotes={() => { onClose(); onOpenNotes(); }} /></div>
  </BottomSheet>;
}
