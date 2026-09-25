import {useEffect, useState} from 'react';
import {StarIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription} from './ui';
import {BottomSheet} from './BottomSheet';
import {MEMO_LIMIT, memoLength, type CollectionEditField, type CollectionEditValue} from './collectionEditOutbox';
import type {CollectionDetail} from './collectionModel';
import {OwnedSheet, trackedEditions, TrackingRows} from './CollectionTracking';

/** `owned-N` edits the owned-volume count of edition N. */
export type PersonalSheet = 'rating' | 'memo' | 'conflict' | `owned-${number}` | null;
type Visible<T> = {value: T; pending: boolean; conflict: {current: CollectionEditValue} | null};
export type PersonalEdits = {
  supported: boolean;
  /** 신간 알림 and owned volumes may be edited (`capabilities.collectionTrackingEdit`). */
  trackingSupported: boolean;
  failure: string;
  /** A short message about an edit that was not kept. */
  notice: string;
  edit(collectionId: string, field: CollectionEditField, value: CollectionEditValue, authoritative: CollectionEditValue): void;
  resolveConflict(collectionId: string, field: CollectionEditField, choice: 'overwrite' | 'discard'): void;
  visible<T extends CollectionEditValue>(collectionId: string, field: CollectionEditField, authoritative: T): Visible<T>;
};

export const scoreText = (score: number | null) => score === null ? '미평가' : `★ ${score.toFixed(1)} / 5`;
const Pending = () => <span className="collection-personal-pending" role="status">전송 대기</span>;
/** A row's pending slot is always there at a fixed width, so 전송 대기 never moves the value or switch. */
const PendingSlot = ({shown}: {shown: boolean}) => <span className="collection-personal-pending is-slot" role="status">{shown ? '전송 대기' : ''}</span>;

/**
 * My rating, Showcase membership and memo, plus 신간 알림 and owned volumes for manga
 * (`CollectionTracking.tsx`). They are editable only while the server
 * advertises `collectionPersonalEdit`; otherwise they are shown read-only without
 * an error. A queued value shows at once with the bookmark-style "전송 대기" mark.
 */
export function CollectionPersonal({item, edits, sheet, onSheet}: {item: CollectionDetail; edits: PersonalEdits; sheet: PersonalSheet; onSheet(sheet: PersonalSheet): void}) {
  const score = edits.visible(item.id, 'myScore', item.myScore ?? null);
  const showcase = edits.visible(item.id, 'showcase', item.showcase);
  const memo = edits.visible(item.id, 'memo', item.description ?? null);
  const editable = edits.supported;
  const trackingPending = item.type === 'manga' && ((item.releaseWatch && edits.visible(item.id, 'releaseWatch', item.releaseWatch.enabled).pending)
    || trackedEditions(item).some(editionIndex => edits.visible(item.id, 'ownedVolumes', {editionIndex, count: item.ownedVolumes?.find(entry => entry.editionIndex === editionIndex)?.count ?? null}).pending));
  const anyPending = score.pending || showcase.pending || memo.pending || !!trackingPending;
  const ownedEdition = sheet?.startsWith('owned-') ? Number(sheet.slice(6)) : null;
  // A memo conflict asks once when it appears; the banner keeps it reachable.
  const conflictKey = memo.conflict ? JSON.stringify([item.id, memo.conflict.current]) : '';
  const [asked, setAsked] = useState('');
  useEffect(() => { if (conflictKey && asked !== conflictKey && sheet === null) { setAsked(conflictKey); onSheet('conflict'); } }, [conflictKey, asked, sheet, onSheet]);

  return <>
    <section className="collection-block collection-personal" aria-label="내 기록">
      {editable
        ? <button className={`collection-personal-row${score.pending ? ' is-pending' : ''}`} aria-label={`내 평점 ${scoreText(score.value)}${score.pending ? ', 전송 대기' : ''}, 바꾸기`} onClick={() => onSheet('rating')}>
            <span className="collection-personal-label">내 평점</span><span className="collection-personal-value numeric">{scoreText(score.value)}</span><PendingSlot shown={score.pending}/>
          </button>
        : <div className={`collection-personal-row${score.pending ? ' is-pending' : ''}`}><span className="collection-personal-label">내 평점</span><span className="collection-personal-value numeric">{scoreText(score.value)}</span>{score.pending && <Pending/>}</div>}
      {editable
        ? <button className={`collection-personal-row${showcase.pending ? ' is-pending' : ''}`} aria-pressed={showcase.value} aria-label={`쇼케이스${showcase.pending ? ', 전송 대기' : ''}`} onClick={() => edits.edit(item.id, 'showcase', !showcase.value, item.showcase)}>
            <span className="collection-personal-label">쇼케이스</span><span className="collection-personal-value">{showcase.value ? '추가됨' : '추가 안 함'}</span><PendingSlot shown={showcase.pending}/><span className="collection-personal-switch" aria-hidden="true"/>
          </button>
        : (showcase.value || showcase.pending) && <div className={`collection-personal-row${showcase.pending ? ' is-pending' : ''}`}><span className="collection-personal-label">쇼케이스</span><span className="collection-personal-value">{showcase.value ? '추가됨' : '추가 안 함'}</span>{showcase.pending && <Pending/>}</div>}
      <TrackingRows item={item} edits={edits} onOwned={edition => onSheet(`owned-${edition}`)}/>
      {anyPending && edits.failure && <p className="collection-personal-failure" role="alert">{edits.failure}</p>}
      {edits.notice && <p className="collection-personal-failure" role="alert">{edits.notice}</p>}
    </section>
    {(editable || memo.value || memo.pending) && <section className="collection-block collection-memo" aria-label="내 메모">
      <div className="collection-memo-heading"><h2>내 메모</h2>{memo.pending && !memo.conflict && <Pending/>}{editable && <Button variant="ghost" className="collection-memo-edit" onClick={() => onSheet('memo')}>{memo.value ? '편집' : '메모 쓰기'}</Button>}</div>
      {memo.conflict && <div className="collection-memo-conflict" role="alert"><span>PC에서 메모가 바뀌었습니다</span><Button variant="ghost" onClick={() => onSheet('conflict')}>확인</Button></div>}
      {memo.value ? <p className={`collection-memo-text${memo.pending ? ' is-pending' : ''}`}>{memo.value}</p> : <p className="hint">메모가 없습니다.</p>}
    </section>}
    {sheet === 'rating' && <BottomSheet title="내 평점" onClose={() => onSheet(null)}>
      <div role="radiogroup" aria-label="내 평점">
        <button className="sheet-option" role="radio" aria-checked={score.value === null} onClick={() => { edits.edit(item.id, 'myScore', null, item.myScore ?? null); onSheet(null); }}>미평가<span className="radio-dot"/></button>
        <div className="collection-star-grid">{Array.from({length: 11}, (_, i) => (10 - i) / 2).map(value => <button key={value} role="radio" aria-checked={score.value === value} aria-label={`${value.toFixed(1)}점`} onClick={() => { edits.edit(item.id, 'myScore', value, item.myScore ?? null); onSheet(null); }}><StarIcon aria-hidden="true"/><span className="numeric">{value.toFixed(1)}</span></button>)}</div>
      </div>
    </BottomSheet>}
    {ownedEdition !== null && item.type === 'manga' && <OwnedSheet key={ownedEdition} item={item} edition={ownedEdition} edits={edits} onClose={() => onSheet(null)}/>}
    {sheet === 'memo' && <MemoSheet initial={memo.value ?? ''} onClose={() => onSheet(null)} onSave={value => { edits.edit(item.id, 'memo', value, item.description ?? null); onSheet(null); }}/>}
    {sheet === 'conflict' && memo.conflict && <Dialog open title="PC에서 메모가 바뀌었습니다" onClose={() => onSheet(null)}><DialogDescription className="collection-sheet-label">내 메모를 보내기 전에 PC에서 메모가 바뀌었습니다. 어느 쪽을 남길지 골라 주세요.</DialogDescription>
      <div className="library-sheet collection-memo-choice">
        <p className="collection-sheet-label">PC 메모</p><p className="collection-memo-text">{typeof memo.conflict.current === 'string' && memo.conflict.current ? memo.conflict.current : '(메모 없음)'}</p>
        <p className="collection-sheet-label">내 메모</p><p className="collection-memo-text">{memo.value || '(메모 없음)'}</p>
        <Button variant="primary" onClick={() => { edits.resolveConflict(item.id, 'memo', 'overwrite'); onSheet(null); }}>덮어쓰기</Button>
        <Button onClick={() => { edits.resolveConflict(item.id, 'memo', 'discard'); onSheet(null); }}>버리기</Button>
        <Button variant="ghost" onClick={() => onSheet(null)}>나중에</Button>
      </div>
    </Dialog>}
  </>;
}

function MemoSheet({initial, onClose, onSave}: {initial: string; onClose(): void; onSave(value: string): void}) {
  const [draft, setDraft] = useState(initial);
  const length = memoLength(draft.trim());
  const over = length > MEMO_LIMIT;
  return <Dialog open title="내 메모" onClose={onClose}><DialogDescription className="sr-only">이 작품에 대한 메모를 씁니다. PC와 함께 씁니다.</DialogDescription>
    <div className="library-sheet collection-memo-sheet">
      <textarea aria-label="내 메모" value={draft} onChange={event => setDraft(event.target.value)} rows={8}/>
      <p className={`collection-memo-counter numeric${over ? ' is-over' : ''}`} aria-live="polite">{length.toLocaleString()} / {MEMO_LIMIT.toLocaleString()}</p>
      <Button variant="primary" disabled={over} onClick={() => onSave(draft)}>저장</Button>
      <Button variant="ghost" onClick={onClose}>취소</Button>
    </div>
  </Dialog>;
}
