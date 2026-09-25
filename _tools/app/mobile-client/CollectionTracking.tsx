import {useState} from 'react';
import {MinusIcon, PlusIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription} from './ui';
import {MAX_OWNED_COUNT, type OwnedVolumesValue} from './collectionEditOutbox';
import {editions, editionVolumes, type CollectionDetail} from './collectionModel';
import type {PersonalEdits} from './CollectionPersonal';

const editionName = (edition: number) => edition === 0 ? '기본판' : `판본 ${edition + 1}`;
const PendingSlot = ({shown}: {shown: boolean}) => <span className="collection-personal-pending is-slot" role="status">{shown ? '전송 대기' : ''}</span>;

/** Editions a count can be kept for: every tracked one, every one with volumes, and 기본판. */
export function trackedEditions(item: CollectionDetail): number[] {
  if (item.ownedVolumes == null) return [];
  return [...new Set([0, ...item.ownedVolumes.map(entry => entry.editionIndex), ...editions(item.volumes)])].filter(e => e >= 0 && e <= 3).sort((a, b) => a - b);
}
const publishedCount = (item: CollectionDetail, edition: number) => item.ownedVolumes?.find(entry => entry.editionIndex === edition)?.count ?? null;

/**
 * 신간 알림 and the owned-volume count per edition, for a manga Collection: the rows the PC's
 * ownership panel edits. They are editable only while the server advertises
 * `collectionTrackingEdit` (an upgraded PC published them); otherwise they are shown read-only
 * with a short note. Edits travel on the personal-edit outbox like my rating.
 */
export function TrackingRows({item, edits, onOwned}: {item: CollectionDetail; edits: PersonalEdits; onOwned(edition: number): void}) {
  if (item.type !== 'manga') return null;
  const published = item.releaseWatch != null || item.ownedVolumes != null;
  // An upgraded PC publishes both keys; one that has not yet leaves nothing to show.
  if (!published && edits.trackingSupported) return null;
  const editable = edits.trackingSupported && published;
  const watch = item.releaseWatch ? edits.visible(item.id, 'releaseWatch', item.releaseWatch.enabled) : null;
  const blocked = !!item.releaseWatch && !item.releaseWatch.available && !watch?.value;
  const single = trackedEditions(item).length === 1;
  return <>
    {watch && (editable
      ? <button className={`collection-personal-row${watch.pending ? ' is-pending' : ''}`} aria-pressed={watch.value} disabled={blocked} aria-describedby={blocked ? `release-watch-reason-${item.id}` : undefined} aria-label={`신간 알림${watch.pending ? ', 전송 대기' : ''}`} onClick={() => edits.edit(item.id, 'releaseWatch', !watch.value, item.releaseWatch!.enabled)}>
          <span className="collection-personal-label">신간 알림</span><span className="collection-personal-value">{watch.value ? '켜짐' : '꺼짐'}</span><PendingSlot shown={watch.pending}/><span className="collection-personal-switch" aria-hidden="true"/>
        </button>
      : <div className={`collection-personal-row${watch.pending ? ' is-pending' : ''}`}><span className="collection-personal-label">신간 알림</span><span className="collection-personal-value">{watch.value ? '켜짐' : '꺼짐'}</span><PendingSlot shown={watch.pending}/></div>)}
    {blocked && editable && <p id={`release-watch-reason-${item.id}`} className="collection-tracking-reason">알라딘이나 카카오와 연결된 작품만 켤 수 있습니다.</p>}
    {trackedEditions(item).map(edition => {
      const owned = edits.visible<OwnedVolumesValue>(item.id, 'ownedVolumes', {editionIndex: edition, count: publishedCount(item, edition)});
      const total = editionVolumes(item.volumes, edition).length;
      const label = single ? '소장' : `${editionName(edition)} 소장`;
      const text = owned.value.count === null ? '기록 없음' : `${owned.value.count}권까지`;
      const body = <><span className="collection-personal-label">{label}</span><span className="collection-personal-value numeric">{text}{total > 0 && <span className="muted"> / {total}권</span>}</span><PendingSlot shown={owned.pending}/></>;
      return editable
        ? <button key={edition} className={`collection-personal-row${owned.pending ? ' is-pending' : ''}`} aria-label={`${label} ${text}${owned.pending ? ', 전송 대기' : ''}, 바꾸기`} onClick={() => onOwned(edition)}>{body}</button>
        : <div key={edition} className={`collection-personal-row${owned.pending ? ' is-pending' : ''}`}>{body}</div>;
    })}
    {!edits.trackingSupported && <p className="collection-tracking-reason">PC 앱을 업데이트하면 신간 알림과 소장 권수를 여기서 바꿀 수 있습니다.</p>}
  </>;
}

/** The owned-count editor: large −/+ steps, a number field for a jump, and 0 / 전체 shortcuts. */
export function OwnedSheet({item, edition, edits, onClose}: {item: CollectionDetail; edition: number; edits: PersonalEdits; onClose(): void}) {
  const authoritative: OwnedVolumesValue = {editionIndex: edition, count: publishedCount(item, edition)};
  const shown = edits.visible<OwnedVolumesValue>(item.id, 'ownedVolumes', authoritative).value.count;
  const total = editionVolumes(item.volumes, edition).length;
  const [draft, setDraft] = useState(String(shown ?? 0));
  const parsed = /^\d{1,4}$/.test(draft) ? Number(draft) : NaN;
  const valid = Number.isInteger(parsed) && parsed <= MAX_OWNED_COUNT;
  const count = valid ? parsed : 0;
  const step = (delta: number) => setDraft(String(Math.max(0, Math.min(MAX_OWNED_COUNT, count + delta))));
  const title = trackedEditions(item).length === 1 ? '소장 권수' : `${editionName(edition)} 소장 권수`;
  return <Dialog open title={title} onClose={onClose}><DialogDescription className="collection-sheet-label">1권부터 고른 권까지 소장한 것으로 PC에 기록됩니다.</DialogDescription>
    <div className="library-sheet collection-owned-sheet">
      <div className="collection-owned-stepper">
        <button type="button" aria-label="한 권 빼기" disabled={count <= 0} onClick={() => step(-1)}><MinusIcon aria-hidden="true"/></button>
        <label className="collection-owned-value"><input aria-label="소장 권수" className="numeric" inputMode="numeric" pattern="[0-9]*" value={draft} onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, '').slice(0, 4))} onFocus={event => event.currentTarget.select()}/><span>권까지</span></label>
        <button type="button" aria-label="한 권 더하기" disabled={count >= MAX_OWNED_COUNT} onClick={() => step(1)}><PlusIcon aria-hidden="true"/></button>
      </div>
      <div className="filter-chips collection-owned-shortcuts" role="group" aria-label="빠른 선택">
        <button type="button" className={`filter-chip${valid && count === 0 ? ' selected' : ''}`} onClick={() => setDraft('0')}>0권</button>
        {total > 0 && <button type="button" className={`filter-chip${valid && count === total ? ' selected' : ''}`} onClick={() => setDraft(String(total))}>전체 {total}권</button>}
      </div>
      {!valid && <p className="collection-memo-counter is-over" role="alert">0–{MAX_OWNED_COUNT.toLocaleString()}권 사이로 적어 주세요.</p>}
      <Button variant="primary" disabled={!valid} onClick={() => { edits.edit(item.id, 'ownedVolumes', {editionIndex: edition, count}, authoritative); onClose(); }}>저장</Button>
      <Button variant="ghost" onClick={onClose}>취소</Button>
    </div>
  </Dialog>;
}
