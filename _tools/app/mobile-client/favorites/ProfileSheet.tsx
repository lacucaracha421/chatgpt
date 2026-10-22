import {useEffect, useState, type MutableRefObject} from 'react';
import {PlusIcon} from '@heroicons/react/24/outline';
import type {FavoriteEntry, FavoriteSet} from '../../src/library/types';
import {BusyLabel} from '../../src/shared/ui/BusyLabel';
import {KIND_LABEL} from '../../src/collections/collectionFormat';
import {FAVORITE_WORK_LIMIT, FavoriteProfileFields, useFavoriteProfileDraft} from '../../src/collections/favorites/FavoriteProfileFields';
import {BottomSheet} from '../BottomSheet';
import {Button, EmptyState, SegmentedControl, TextInput} from '../ui';
import {api, errorText} from '../transport';
import {collectionPath, type CollectionKind, type CollectionPage, type CollectionSummary} from '../collectionModel';

const KINDS = (['manga', 'game', 'movie'] as const).map(value => ({value, label: KIND_LABEL[value]}));

/** 작품 연결 on the tablet (PC: the editor's 작품 연결 menu): search one published Collection type by title. */
function WorkPicker({linked, onClose, onPick}: {linked: string[]; onClose(): void; onPick(work: CollectionSummary): void}) {
  const [kind, setKind] = useState<CollectionKind>('manga'), [query, setQuery] = useState(''), [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{key: string; items: CollectionSummary[]} | null>(null), [error, setError] = useState('');
  const key = JSON.stringify([kind, query.trim()]);
  useEffect(() => {
    const controller = new AbortController();
    // Typing waits a moment; the last list stays on screen until the next one is in.
    const timer = setTimeout(() => {
      void api<CollectionPage>(collectionPath(kind, query.trim(), false, null), controller.signal).then(page => {
        if (!controller.signal.aborted) { setResult({key, items: page.items}); setError(''); }
      }, reason => { if (!controller.signal.aborted) setError(errorText(reason) || '작품을 불러오지 못했습니다.'); });
    }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = (result?.items ?? []).filter(work => !linked.includes(work.id));
  return <BottomSheet title="작품 연결" tall stacked onClose={onClose}>
    <div className="favorite-picker">
      <TextInput type="search" aria-label="작품 제목 검색" placeholder="작품 제목 검색" maxLength={120} value={query} onChange={event => setQuery(event.target.value)}/>
      <SegmentedControl fullWidth label="컬렉션 유형" options={KINDS} value={kind} onChange={setKind}/>
      <BusyLabel busy={!error && result?.key !== key} delay={400}><p className="hint" role="status">불러오는 중…</p></BusyLabel>
      {error && <p className="inline-error" role="alert">{error}<Button variant="ghost" onClick={() => setRetry(n => n + 1)}>다시 시도</Button></p>}
      <div className="favorite-picker-rows">
        {items.map(work => <button key={work.id} type="button" className="favorite-picker-row favorite-picker-select" disabled={linked.length >= FAVORITE_WORK_LIMIT} onClick={() => onPick(work)}><span className="favorite-picker-name">{work.name}</span></button>)}
        {result && !items.length && <EmptyState inline title="검색 결과 없음"/>}
      </div>
    </div>
  </BottomSheet>;
}

/**
 * 정보 편집 for a favourite character on the tablet: the PC editor's fields (shared), saved with the same `update`
 * command. A character added by name also edits its name and work name; an Asset character keeps its folder's.
 */
export function ProfileSheet({entry, name, series, workNames, busy, error, backRef, onClose, onSave}: {
  entry: FavoriteEntry; name: string; series: string; workNames: Record<string, string>; busy: boolean; error: string;
  backRef: MutableRefObject<(() => boolean) | null>; onClose(): void; onSave(set: FavoriteSet): Promise<boolean>;
}) {
  const draft = useFavoriteProfileDraft(entry, name, series);
  const [names, setNames] = useState(workNames), [picking, setPicking] = useState(false);
  useEffect(() => { backRef.current = () => { if (!picking) return false; setPicking(false); return true; }; return () => { backRef.current = null; }; }, [picking, backRef]);
  return <BottomSheet title="정보 편집" tall onClose={onClose}>
    <form className="favorite-editor favorite-profile-sheet" onSubmit={event => { event.preventDefault(); if (!busy && draft.valid) void onSave(draft.set()).then(saved => { if (saved) onClose(); }); }}>
      <FavoriteProfileFields draft={draft} focusFirst={false} workName={id => names[id] ?? workNames[id] ?? '연결된 작품'}
        workTools={<Button type="button" variant="quiet" disabled={draft.workIds.length >= FAVORITE_WORK_LIMIT} onClick={() => setPicking(true)}><PlusIcon aria-hidden="true"/>작품 연결</Button>}/>
      {error && <p className="favorite-error" role="alert">{error}</p>}
      <div className="favorite-editor__foot"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button type="submit" variant="primary" disabled={busy || !draft.valid}><BusyLabel busy={busy} delay={400} idle="완료">저장 중</BusyLabel></Button></div>
    </form>
    {picking && <WorkPicker linked={draft.workIds} onClose={() => setPicking(false)} onPick={work => { setNames(before => ({...before, [work.id]: work.name})); draft.linkWork(work.id); setPicking(false); }}/>}
  </BottomSheet>;
}
