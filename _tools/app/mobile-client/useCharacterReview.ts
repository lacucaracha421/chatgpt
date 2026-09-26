import {onVisible} from './useVisibleInterval';
/**
 * App-level character-review delivery and the "검토 N" counts shown at the entry points.
 */
import {useEffect, useState} from 'react';
import {api} from './transport';
import {CHARACTER_REVIEW_EVENT, queuedReviewPairs, readReviewIntents, reviewPairKey} from './characterReviewOutbox';
import {flushCharacterReview, reviewPath, type ReviewFeed, type ReviewTargetCount} from './characterReviewDelivery';

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
 * The review overview: the total left (as `useCharacterReviewCount`), split by series and
 * character. `exact` when the server sent per-character counts (`countsByTarget`, which also
 * means it accepts `series=`); otherwise the split covers the candidates read, and `rest` counts
 * the ones beyond the paging cap. `at` is when it was read.
 */
export type ReviewOverview = {total: number; groups: ReviewGroup[]; rest: number; exact: boolean; at: number};
/** Names the feed may not carry (an exact read has no candidate rows), from the character index. */
export type ReviewNames = {characters: Record<string, string>; series: Record<string, string>};
/** An old server has no per-character counts: the overview pages the whole list, up to this many candidates. */
export const OVERVIEW_PAGE = 50;
export const OVERVIEW_PAGES = 20;

const NO_NAMES: ReviewNames = {characters: {}, series: {}};
const seriesLabel = (id: string, given: string | null | undefined, names: ReviewNames) => given || names.series[id] || '시리즈 없음';
const characterLabel = (id: string, given: string | undefined, names: ReviewNames) => given || names.characters[id] || '이름 없음';

/** Busiest series first, and in each its busiest characters; ties by name. */
function sortGroups(groups: Iterable<ReviewGroup>): ReviewGroup[] {
  const most = <T extends {count: number}>(a: T, b: T, an: string, bn: string) => b.count - a.count || an.localeCompare(bn, 'ko');
  return [...groups]
    .map(group => ({...group, characters: [...group.characters].sort((a, b) => most(a, b, a.name, b.name))}))
    .sort((a, b) => most(a, b, a.seriesName, b.seriesName));
}
function addTo(groups: Map<string, ReviewGroup>, seriesId: string, seriesName: string, id: string, name: string, count: number) {
  let group = groups.get(seriesId);
  if (!group) groups.set(seriesId, group = {seriesId, seriesName, count: 0, characters: []});
  group.count += count;
  const character = group.characters.find(entry => entry.id === id);
  if (character) character.count += count;
  else group.characters.push({id, name, count});
}

/** Groups feed candidates by series and character; pairs in `hidden` (queued on this device) are left out. */
export function groupReviewItems(items: ReviewFeed['items'], targets: ReviewFeed['targets'], hidden: Set<string> = new Set(), names: ReviewNames = NO_NAMES): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const item of items) {
    if (hidden.has(reviewPairKey(item.targetId, item.assetId))) continue;
    const target = targets[item.targetId];
    const seriesId = target?.seriesId ?? '';
    addTo(groups, seriesId, seriesLabel(seriesId, target?.seriesName, names), item.targetId, characterLabel(item.targetId, target?.name, names), 1);
  }
  return sortGroups(groups.values());
}

/** Groups the server's exact per-character counts, less this device's queued decisions; zero rows are left out. */
export function groupReviewCounts(rows: ReviewTargetCount[], queued: Record<string, number> = {}, names: ReviewNames = NO_NAMES): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const row of rows) {
    if (typeof row?.targetId !== 'string' || !Number.isSafeInteger(row.pending)) continue;
    const left = Math.max(0, row.pending - (queued[row.targetId] ?? 0));
    if (left > 0) addTo(groups, row.seriesId ?? '', seriesLabel(row.seriesId ?? '', row.seriesName, names), row.targetId, characterLabel(row.targetId, row.name, names), left);
  }
  return sortGroups(groups.values());
}

/** Feed decisions queued on this device, by character. */
function queuedByTarget() {
  const counts: Record<string, number> = {};
  for (const intent of Object.values(readReviewIntents())) {
    if (intent.origin === 'feed' && intent.decision !== 'cleared') counts[intent.targetId] = (counts[intent.targetId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Reads the overview. One small request when the server sends `countsByTarget` (exact);
 * otherwise the whole list, page by page up to `OVERVIEW_PAGES` × `OVERVIEW_PAGE`. `null` when
 * no PC has published a review list yet. The first request failing throws.
 */
export async function readReviewOverview(signal?: AbortSignal, names: ReviewNames = NO_NAMES, now = () => Date.now()): Promise<ReviewOverview | null> {
  const head = await api<ReviewFeed>(reviewPath({limit: 1}), signal);
  if (head?.ready !== true || !Number.isSafeInteger(head.counts?.total)) return null;
  if (Array.isArray(head.countsByTarget)) {
    const groups = groupReviewCounts(head.countsByTarget, queuedByTarget(), names);
    return {total: groups.reduce((sum, group) => sum + group.count, 0), groups, rest: 0, exact: true, at: now()};
  }
  const items: ReviewFeed['items'] = [];
  const targets: ReviewFeed['targets'] = {};
  let cursor: string | null = null, total = head.counts.total;
  for (let page = 0; page < OVERVIEW_PAGES; page += 1) {
    let feed: ReviewFeed | null;
    try { feed = await api<ReviewFeed>(reviewPath({cursor, limit: OVERVIEW_PAGE}), signal); }
    catch (reason) { if (page === 0 || signal?.aborted) throw reason; break; } // A later page failing (e.g. a republish) keeps what was read.
    if (page === 0 && Number.isSafeInteger(feed?.counts?.total)) total = feed!.counts.total;
    if (Array.isArray(feed?.items)) items.push(...feed.items);
    Object.assign(targets, feed?.targets ?? {});
    cursor = feed?.hasMore && feed.nextCursor ? feed.nextCursor : null;
    if (!cursor) break;
  }
  // Read together with the last page, like `useCharacterReviewCount`.
  const left = Math.max(0, total - Object.values(queuedByTarget()).reduce((sum, n) => sum + n, 0));
  const groups = groupReviewItems(items, targets, queuedReviewPairs(), names);
  const shown = groups.reduce((sum, group) => sum + group.count, 0);
  return {total: Math.max(left, shown), groups, rest: Math.max(0, left - shown), exact: false, at: now()};
}

const OVERVIEW_KEY = 'lakomics.characters.review.overview.v1';
/** The last overview read for this library (offline), or null. */
export function readOverviewSnapshot(libraryId: string): ReviewOverview | null {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERVIEW_KEY) || 'null');
    return raw?.libraryId === libraryId && Array.isArray(raw.value?.groups) && Number.isFinite(raw.value.at) ? raw.value as ReviewOverview : null;
  } catch { return null; }
}
export function writeOverviewSnapshot(libraryId: string, value: ReviewOverview) {
  try { localStorage.setItem(OVERVIEW_KEY, JSON.stringify({libraryId, value})); } catch { /* Optional: offline values only. */ }
}
