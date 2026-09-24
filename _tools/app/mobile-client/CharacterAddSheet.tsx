import {useEffect, useState} from 'react';
import {BottomSheet} from './BottomSheet';
import {api, errorText} from './transport';
import {commitReviewDecision, queuedReviewPairs, reviewPairKey} from './characterReviewOutbox';
import {REVIEW_PATH, flushCharacterReview, type ReviewAssetTargets} from './characterReviewDelivery';

/**
 * Viewer "캐릭터에 추가": the characters of this Asset's own series that it is not already
 * in (the server leaves out existing members and protected references). Choosing one
 * queues an accepted decision with `origin:"viewer"`; the PC applies it later.
 */
export function CharacterAddSheet({assetId, libraryId, onClose, onAdded}: {assetId: string; libraryId: string; onClose(): void; onAdded(name: string): void}) {
  const [targets, setTargets] = useState<ReviewAssetTargets['targets'] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setTargets(null); setError('');
    void api<ReviewAssetTargets>(`${REVIEW_PATH}?${new URLSearchParams({asset: assetId})}`, controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      if (reply?.assetId !== assetId || !Array.isArray(reply.targets)) throw new Error('캐릭터 목록을 확인할 수 없습니다.');
      const queued = queuedReviewPairs();
      setTargets(reply.ready ? reply.targets.filter(target => !queued.has(reviewPairKey(target.targetId, assetId))) : []);
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [assetId]);
  const add = (target: ReviewAssetTargets['targets'][number]) => {
    try {
      commitReviewDecision({libraryId, targetId: target.targetId, assetId, decision: 'accepted', origin: 'viewer', basis: null});
    } catch (reason) { setError(errorText(reason)); return; }
    void flushCharacterReview().catch(() => {});
    onAdded(target.name);
  };
  return <BottomSheet title="캐릭터에 추가" onClose={onClose}>
    <p className="hint">이 자산이 속한 시리즈의 캐릭터만 표시합니다. PC가 반영하면 캐릭터 갤러리에 나타납니다.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {!targets && !error && <div className="loading-line" role="status" aria-label="캐릭터 불러오는 중"/>}
    {targets && !targets.length && <p className="hint">추가할 수 있는 캐릭터가 없습니다.</p>}
    {targets?.map(target => <button key={target.targetId} className="sheet-option" onClick={() => add(target)}>
      <span>{target.name}{target.seriesName && <small className="muted"> · {target.seriesName}</small>}</span>
    </button>)}
  </BottomSheet>;
}
