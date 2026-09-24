/**
 * App-level character-review delivery and the "검토 N" counts shown at the entry points.
 */
import {useEffect, useState} from 'react';
import {api} from './transport';
import {CHARACTER_REVIEW_EVENT, readReviewIntents} from './characterReviewOutbox';
import {flushCharacterReview, reviewPath, type ReviewFeed} from './characterReviewDelivery';

/** Sends queued decisions on start, after each new decision, on resume and when the network returns. */
export function useCharacterReviewBackgroundFlush(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const send = () => {
      if (document.visibilityState === 'hidden') return;
      if (Object.keys(readReviewIntents()).length) void flushCharacterReview().catch(() => {});
    };
    send();
    window.addEventListener('lakomics-resume', send);
    window.addEventListener('online', send);
    window.addEventListener(CHARACTER_REVIEW_EVENT, send);
    document.addEventListener('visibilitychange', send);
    return () => {
      window.removeEventListener('lakomics-resume', send);
      window.removeEventListener('online', send);
      window.removeEventListener(CHARACTER_REVIEW_EVENT, send);
      document.removeEventListener('visibilitychange', send);
    };
  }, [enabled]);
}

/** Feed candidates this device already decided but the server has not confirmed yet. */
function queuedFeedDecisions(target?: string | null) {
  return Object.values(readReviewIntents()).filter(intent => intent.origin === 'feed' && intent.decision !== 'cleared'
    && (!target || intent.targetId === target)).length;
}

/**
 * Candidates left to review, or `null` while unknown or when the feature is off. The server
 * count already hides confirmed decisions; queued local ones are subtracted here.
 */
export function useCharacterReviewCount(enabled: boolean, target: string | null, refreshKey: unknown): number | null {
  const [total, setTotal] = useState<{key: string; value: number; queued: number} | null>(null);
  const [changed, setChanged] = useState(0);
  const key = target ?? '';
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void api<ReviewFeed>(reviewPath({target, limit: 1}), controller.signal).then(feed => {
      if (controller.signal.aborted) return;
      // The server count and the local queue are read together, so a decision confirmed in
      // between is never subtracted twice or not at all.
      setTotal(feed?.ready === true && Number.isSafeInteger(feed.counts?.total)
        ? {key, value: feed.counts.total, queued: queuedFeedDecisions(target)} : null);
    }, () => { if (!controller.signal.aborted) setTotal(null); });
    return () => controller.abort();
  }, [enabled, target, key, refreshKey, changed]);
  useEffect(() => {
    if (!enabled) return;
    // Re-read after local decisions settle (debounced: a review session fires many events).
    let timer = 0;
    const read = () => { clearTimeout(timer); timer = window.setTimeout(() => setChanged(value => value + 1), 1000); };
    window.addEventListener(CHARACTER_REVIEW_EVENT, read);
    return () => { clearTimeout(timer); window.removeEventListener(CHARACTER_REVIEW_EVENT, read); };
  }, [enabled]);
  if (!enabled || !total || total.key !== key) return null;
  return Math.max(0, total.value - total.queued);
}
