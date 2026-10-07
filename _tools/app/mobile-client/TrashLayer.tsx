import {useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MutableRefObject} from 'react';
import {ArrowLeftIcon, DocumentTextIcon} from '@heroicons/react/24/outline';
import {deletedTrashNotes, rememberedTrashSection, rememberTrashSection, trashTabs, TRASH_EMPTY, type TrashSection} from '../src/safety/trashSections';
import {displayDate} from '../src/shared/displayDate';
import type {NotesStore} from '../src/notes/store';
import type {Asset} from './types';
import {Button, EmptyState, IconButton, Skeleton, Tabs} from './ui';
import {LibraryTrash} from './LibraryTrash';
import {CollectionTrashContent, useCollectionTrash} from './CollectionTrash';
import {useCollectionAuthority} from './useCollectionAuthority';
import {usePrivacyMode} from './privacyMode';
import {setTabletTrashCount} from './trashCounts';
import {useVisibleInterval} from './useVisibleInterval';
import './libraryTrash.css';

export function NotesTrashContent({store}: {store: NotesStore}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const notes = deletedTrashNotes(state.notes);
  const error = state.error ?? (state.ready && !state.unlocked ? '메모를 먼저 열어 주세요.' : null);
  return <>
    {error && <p role="alert" className="trash-notice">{error}<Button onClick={() => void (state.unlocked ? store.sync() : store.refresh())}>다시 시도</Button></p>}
    {!state.ready ? <div className="collection-trash" aria-label="휴지통을 불러오는 중">{[0,1,2].map(index => <Skeleton key={index} className="collection-trash-row" label={null}/>)}</div>
      : error && !notes.length ? null : !notes.length ? <EmptyState title={TRASH_EMPTY} inline/>
      : <ul className="collection-trash" aria-label="휴지통 메모">{notes.map(note => <li className="collection-trash-row" key={note.id}>
        <DocumentTextIcon aria-hidden="true"/>
        <span className="collection-trash-text"><strong>{note.title || '제목 없는 메모'}</strong><small>옮긴 날 {displayDate(note.updatedAt)}</small></span>
        <Button aria-label={`${note.title || '제목 없는 메모'} 되살리기`} disabled={state.saving} onClick={() => {store.edit({...note, deleted:false}); void store.finish();}}>되살리기</Button>
      </li>)}</ul>}
  </>;
}

export function TrashLayer({endpoint, store, known, onRestored, onClose, backRef}: {
  endpoint: string; store: NotesStore; known: ReadonlyMap<string, Asset>; onRestored(ids: string[]): void;
  onClose(): void; backRef: MutableRefObject<(() => boolean) | null>;
}) {
  const [section, setSection] = useState<TrashSection>(rememberedTrashSection);
  const [shown, setShown] = useState(section);
  const [assets, setAssets] = useState<{ready: boolean; count: number | undefined}>({ready:false, count:undefined});
  const [refresh, setRefresh] = useState(0);
  const authority = useCollectionAuthority(true, () => setRefresh(value => value + 1), true);
  const trash = useCollectionTrash(authority, true, refresh);
  const notes = useSyncExternalStore(store.subscribe, store.snapshot);
  const [privacy] = usePrivacyMode();
  const assetBack = useRef<(() => boolean) | null>(null);
  useEffect(() => {backRef.current = () => {onClose(); return true;}; return () => {backRef.current = null;};}, [backRef, onClose]);
  useEffect(() => {void store.load();}, [store]);
  useVisibleInterval(() => {if (section === 'collections') setRefresh(value => value + 1); else if (section === 'notes' && notes.unlocked) void store.sync('background');}, section === 'assets' ? null : 60_000, true);
  const ready = section === 'assets' ? assets.ready : section === 'collections' ? trash.available || !!trash.failure || !!authority.statusError : notes.ready;
  useLayoutEffect(() => {if (ready) setShown(section);}, [ready, section]);
  const assetState = useCallback((ready: boolean, count: number | undefined) => {
    setAssets(current => current.ready === ready && current.count === count ? current : {ready, count});
    if (count !== undefined) setTabletTrashCount(endpoint, 'assets', count);
  }, [endpoint]);
  return <section className="trash-overlay trash-browser-tablet" role="dialog" aria-modal="true" aria-label="휴지통">
    <header className="trash-bar"><IconButton label="휴지통 닫기" icon={ArrowLeftIcon} onClick={onClose}/><h1>휴지통</h1></header>
    <Tabs label="휴지통 섹션" tabs={trashTabs({assets:assets.ready ? assets.count : undefined, collections:trash.available ? trash.items.length : undefined, notes:notes.ready ? deletedTrashNotes(notes.notes).length : undefined}, {collections:trash.hasMore})} value={section} onChange={next => {setSection(next); rememberTrashSection(next);}}/>
    <div className="trash-sections" inert={section !== shown}>
      <div className="trash-section" style={{display:shown === 'assets' ? undefined : 'none'}}><LibraryTrash embedded backRef={assetBack} known={known} onRestored={onRestored} onClose={onClose} onState={assetState}/></div>
      <div className="trash-section trash-section-list" style={{display:shown === 'collections' ? undefined : 'none'}}>
        {authority.statusError && <p role="alert">{authority.statusError}<Button onClick={() => {authority.retryStatus(); trash.retry();}}>다시 시도</Button></p>}
        {(!authority.statusError || trash.available) && <CollectionTrashContent trash={trash} authority={authority} privacy={privacy}/>}
      </div>
      <div className="trash-section trash-section-list" style={{display:shown === 'notes' ? undefined : 'none'}}><NotesTrashContent store={store}/></div>
    </div>
  </section>;
}
