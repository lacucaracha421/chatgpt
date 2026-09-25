import {useState} from 'react';
import {BellSlashIcon, MinusIcon, PlusIcon} from '@heroicons/react/24/outline';
import {BellIcon as BellSolid} from '@heroicons/react/24/solid';
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

/** Whether a manga publication carries the tracking fields, and whether they may be edited here. */
export function trackingState(item: CollectionDetail, edits: PersonalEdits) {
  const published = item.type === 'manga' && (item.releaseWatch != null || item.ownedVolumes != null);
  return {published, editable: edits.trackingSupported && published};
}

/**
 * The owned-volume count per edition, for a manga Collection: the rows the PC's ownership panel
 * edits. They are editable only while the server advertises `collectionTrackingEdit` (an
 * upgraded PC published them); otherwise they are shown read-only with a short note. Edits
 * travel on the personal-edit outbox like my rating. 신간 알림 lives in the top bar
 * (`ReleaseWatchAction`).
 */
export function TrackingRows({item, edits, onOwned}: {item: CollectionDetail; edits: PersonalEdits; onOwned(edition: number): void}) {
  if (item.type !== 'manga') return null;
  const {published, editable} = trackingState(item, edits);
  // An upgraded PC publishes both keys; one that has not yet leaves nothing to show.
  if (!published && edits.trackingSupported) return null;
  const single = trackedEditions(item).length === 1;
  return <>
    {trackedEditions(item).map(edition => {
      const owned = edits.visible<OwnedVolumesValue>(item.id, 'ownedVolumes', {editionIndex: edition, count: publishedCount(item, edition)});
      const total = editionVolumes(item.volumes, edition).length;
      const label = single ? '소장' : `${editionName(edition)} 소장`;
      const text = owned.value.count === null ? '기록 없음' : `${owned.value.count}권까지`;
      const body = <><span className="collection-personal-label">{label}</span><span className="collection-personal-value numeric">{text}{total > 0 && <span className="muted"> / 전체 {total}권</span>}</span><PendingSlot shown={owned.pending}/></>;
      return editable
        ? <button key={edition} className={`collection-personal-row${owned.pending ? ' is-pending' : ''}`} aria-label={`${label} ${text}${owned.pending ? ', 전송 대기' : ''}, 바꾸기`} onClick={() => onOwned(edition)}>{body}</button>
        : <div key={edition} className={`collection-personal-row${owned.pending ? ' is-pending' : ''}`}>{body}</div>;
    })}
    {!edits.trackingSupported && <p className="collection-tracking-reason">PC 앱을 업데이트하면 신간 알림과 소장 권수를 여기서 바꿀 수 있습니다.</p>}
  </>;
}

export const RELEASE_WATCH_BLOCKED = '알라딘이나 카카오와 연결된 작품만 켤 수 있습니다.';
export const RELEASE_WATCH_READ_ONLY = 'PC 앱을 업데이트하면 신간 알림을 여기서 바꿀 수 있습니다.';

/**
 * 신간 알림 as a top-bar bell: a pressed bell when on, a slashed bell when off. It cannot be
 * turned on without an Aladin/Kakao binding (turning off always works), and it is read-only
 * until the PC publishes `collectionTrackingEdit`; a tap on it then says why instead.
 */
export function ReleaseWatchAction({item, edits, onReason}: {item: CollectionDetail; edits: PersonalEdits; onReason(text: string): void}) {
  if (item.type !== 'manga' || !item.releaseWatch) return null;
  const {editable} = trackingState(item, edits);
  const watch = edits.visible(item.id, 'releaseWatch', item.releaseWatch.enabled);
  const blocked = !item.releaseWatch.available && !watch.value;
  const reason = !editable ? RELEASE_WATCH_READ_ONLY : blocked ? RELEASE_WATCH_BLOCKED : '';
  const Icon = watch.value ? BellSolid : BellSlashIcon;
  const reasonId = `release-watch-reason-${item.id}`;
  return <button type="button" className={`ui-button ui-button--ghost ui-button--icon collection-bar-action${watch.pending ? ' is-pending' : ''}`}
    aria-pressed={watch.value} aria-disabled={reason ? true : undefined} aria-describedby={reason ? reasonId : undefined}
    aria-label={`신간 알림${watch.pending ? ', 전송 대기' : ''}`}
    onClick={() => reason ? onReason(reason) : edits.edit(item.id, 'releaseWatch', !watch.value, item.releaseWatch!.enabled)}>
    <Icon aria-hidden="true"/><span className="collection-bar-pending" aria-hidden="true"/>{reason && <span id={reasonId} className="sr-only">{reason}</span>}
  </button>;
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
