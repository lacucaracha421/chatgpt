import {onVisible} from './useVisibleInterval';
/**
 * App-level similarity-review delivery and the "유사 이미지 검토 N" count.
 */
import {useEffect, useState} from 'react';
import {api} from './transport';
import {useCachedHomeSource} from './homeCache';
import {nextSimilarityDue, queuedSimilarity, readSimilarityIntents, SIMILARITY_REVIEW_EVENT} from './similarityReviewOutbox';
import {flushSimilarityReview, similarityPath, type SimilarityFeed} from './similarityReviewDelivery';

/**
 * Sends due decisions of a durable outbox on start, when the undo window of a new decision
 * ends, on resume and when the network returns. Shared by the review outboxes.
 */
export function useDueFlush(enabled: boolean, nextDue: () => number | null, flush: () => Promise<unknown>, event: string) {
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const send = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      const due = nextDue();
      if (due === null) return;
      if (due <= Date.now()) void flush().catch(() => {}).finally(schedule);
      else schedule();
    };
    // Wake up when the earliest queued intent becomes due (a deferred one retries later).
    const schedule = () => {
      clearTimeout(timer);
      const due = nextDue();
      const wait = due === null ? null : due > Date.now() ? due - Date.now() + 50 : 30_000;
      if (wait !== null) timer = window.setTimeout(send, wait);
    };
    send();
    const removeVisible=onVisible(send);
    window.addEventListener('online', send);
    window.addEventListener(event, send);
    return () => {
      clearTimeout(timer);
      removeVisible();
      window.removeEventListener('online', send);
      window.removeEventListener(event, send);
    };
  }, [enabled, nextDue, flush, event]);
}

export function useSimilarityReviewBackgroundFlush(enabled: boolean) {
  useDueFlush(enabled, nextSimilarityDue, flushSimilarityReview, SIMILARITY_REVIEW_EVENT);
}

/**
 * Pairs left to review, or `null` while unknown or when the feature is off. The server count
 * already hides confirmed decisions; queued local decisions are subtracted here.
 */
export function useSimilarityReviewCount(enabled: boolean, refreshKey: unknown, scope = '', forceKey: unknown = refreshKey): number | null {
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const read = () => { clearTimeout(timer); timer = window.setTimeout(() => setChanged(value => value + 1), 1000); };
    window.addEventListener(SIMILARITY_REVIEW_EVENT, read);
    return () => { clearTimeout(timer); window.removeEventListener(SIMILARITY_REVIEW_EVENT, read); };
  }, [enabled]);
  const total = useCachedHomeSource<{value: number; queued: number} | null>({
    enabled, scope, source: 'similarity', initial: null, forceKey: `${String(forceKey)}:${changed}`, forceOnMount: !scope,
    read: async signal => {
      const feed = await api<SimilarityFeed>(similarityPath({limit: 1}), signal);
      return feed?.ready === true && Number.isSafeInteger(feed.counts?.open)
        ? {value: feed.counts.open, queued: queuedSimilarity(readSimilarityIntents()).reviews.size} : null;
    },
  });
  // A pause (a dialog, the viewer or another tab over the Library) keeps the last known count
  // instead of removing the row, which would move everything below it; it is re-read on return.
  if (!total) return null;
  return Math.max(0, total.value - total.queued);
}
