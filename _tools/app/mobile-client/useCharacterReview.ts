import {onVisible} from './useVisibleInterval';
/**
 * App-level character-review delivery and the "검토 N" counts shown at the entry points.
 */
import {useEffect, useState} from 'react';
import {api} from './transport';
import {CHARACTER_REVIEW_EVENT, queuedReviewPairs, readReviewIntents, reviewPairKey} from './characterReviewOutbox';
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
    const removeVisible=onVisible(send);
    window.addEventListener('online', send);
    window.addEventListener(CHARACTER_REVIEW_EVENT, send);
    return () => {
      removeVisible();
      window.removeEventListener('online', send);
      window.removeEventListener(CHARACTER_REVIEW_EVENT, send);
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
  // A pause keeps the last known count so the row does not vanish and return; it is re-read on return.
  if (!total || total.key !== key) return null;
  return Math.max(0, total.value - total.queued);
}

/** One series' waiting candidates, split by character (most first). */
export type ReviewGroup = {seriesId: string; seriesName: string; count: number; characters: {id: string; name: string; count: number}[]};
/**
 * Home's 캐릭터 검토 split: the total left (as `useCharacterReviewCount`), the per-series and
 * per-character counts of the candidates actually read, and `rest`, the candidates beyond them.
 */
export type ReviewBreakdown = {total: number; groups: ReviewGroup[]; rest: number};
/** The review route has no per-character counts: Home reads at most this many candidates to split them. */
export const BREAKDOWN_PAGE = 50;
export const BREAKDOWN_PAGES = 2;

/** Groups feed candidates by series and character; pairs in `hidden` (queued on this device) are left out. */
export function groupReviewItems(items: ReviewFeed['items'], targets: ReviewFeed['targets'], hidden: Set<string> = new Set()): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const item of items) {
    if (hidden.has(reviewPairKey(item.targetId, item.assetId))) continue;
    const target = targets[item.targetId];
    const seriesId = target?.seriesId ?? '';
    let group = groups.get(seriesId);
    if (!group) groups.set(seriesId, group = {seriesId, seriesName: target?.seriesName || '시리즈 없음', count: 0, characters: []});
    group.count += 1;
    const character = group.characters.find(entry => entry.id === item.targetId);
    if (character) character.count += 1;
    else group.characters.push({id: item.targetId, name: target?.name || '이름 없음', count: 1});
  }
  const most = <T extends {count: number}>(a: T, b: T, an: string, bn: string) => b.count - a.count || an.localeCompare(bn, 'ko');
  return [...groups.values()]
    .map(group => ({...group, characters: group.characters.sort((a, b) => most(a, b, a.name, b.name))}))
    .sort((a, b) => most(a, b, a.seriesName, b.seriesName));
}

/**
 * The review total with its series/character split, read from the first candidate pages
 * (bounded: `BREAKDOWN_PAGES` × `BREAKDOWN_PAGE`). `null` while unknown or when the feature is off.
 */
export function useCharacterReviewBreakdown(enabled: boolean, refreshKey: unknown): ReviewBreakdown | null {
  const [value, setValue] = useState<ReviewBreakdown | null>(null);
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      const items: ReviewFeed['items'] = [];
      const targets: ReviewFeed['targets'] = {};
      let cursor: string | null = null, total: number | null = null;
      for (let page = 0; page < BREAKDOWN_PAGES; page += 1) {
        let feed: ReviewFeed | null;
        try { feed = await api<ReviewFeed>(reviewPath({cursor, limit: BREAKDOWN_PAGE}), controller.signal); }
        catch (reason) { if (page === 0) throw reason; break; } // A later page failing (e.g. a republish) keeps what was read.
        if (page === 0) {
          if (feed?.ready !== true || !Number.isSafeInteger(feed.counts?.total)) return null;
          total = feed.counts.total;
        }
        if (Array.isArray(feed?.items)) items.push(...feed.items);
        Object.assign(targets, feed?.targets ?? {});
        cursor = feed?.hasMore && feed.nextCursor ? feed.nextCursor : null;
        if (!cursor) break;
      }
      // Read together with the last page, like `useCharacterReviewCount`.
      const left = Math.max(0, total! - queuedFeedDecisions());
      const groups = groupReviewItems(items, targets, queuedReviewPairs());
      const shown = groups.reduce((sum, group) => sum + group.count, 0);
      return {total: left, groups, rest: Math.max(0, left - shown)};
    })().then(next => { if (!controller.signal.aborted) setValue(next); },
      () => { if (!controller.signal.aborted) setValue(null); });
    return () => controller.abort();
  }, [enabled, refreshKey, changed]);
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const read = () => { clearTimeout(timer); timer = window.setTimeout(() => setChanged(n => n + 1), 1000); };
    window.addEventListener(CHARACTER_REVIEW_EVENT, read);
    return () => { clearTimeout(timer); window.removeEventListener(CHARACTER_REVIEW_EVENT, read); };
  }, [enabled]);
  // A pause keeps the last known split; it is re-read on return.
  return value;
}
