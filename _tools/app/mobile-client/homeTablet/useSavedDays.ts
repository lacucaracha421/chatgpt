import {useEffect, useMemo, useRef, useState} from 'react';
import type {AssetDateBucket} from '../../src/library/types';
import {gridDates, monthSavedQueries} from '../../src/home/homeMonthModel';
import {api, ApiError} from '../transport';

export const SAVED_DAYS_PATH = '/v1/library/saved-days';

/**
 * The month grid's 42 days as one request: `from` is the grid's first local date and `bounds` the 43 UTC cut points
 * of its local midnights (the PC's month queries, so a 23 or 25 hour day at a DST change counts like it does there).
 */
export function savedDaysPath(month: string): string {
  const days = monthSavedQueries(month).flatMap(query => query.localDays ?? []);
  const bounds = [...days.map(day => day.startUtc), days[days.length - 1]!.endUtc];
  return `${SAVED_DAYS_PATH}?from=${days[0]!.localDate}&bounds=${bounds.join(',')}`;
}

/** The reply's days, or `null` when it does not have the expected shape. */
export function parseSavedDays(reply: unknown): AssetDateBucket[] | null {
  const days = (reply as {days?: unknown} | null)?.days;
  if (!Array.isArray(days)) return null;
  const buckets: AssetDateBucket[] = [];
  for (const day of days) {
    const {date, count} = (day ?? {}) as {date?: unknown; count?: unknown};
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    buckets.push({date, count});
  }
  return buckets;
}

/**
 * Saved-image counts per local day for the tablet month calendar: one read per shown month. Counts already read stay
 * on screen while the next month loads, and a server without the route (404) or a failed read leaves them as they are.
 * `version` re-reads the shown month when the library changed.
 */
export function useSavedDays({month, scope, enabled, version}: {month: string; scope: string; enabled: boolean; version: string | number | null}): AssetDateBucket[] {
  const [counts, setCounts] = useState<{scope: string; byDate: Map<string, number>} | null>(null);
  const unsupported = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || unsupported.current === scope) return;
    const controller = new AbortController();
    api<unknown>(savedDaysPath(month), controller.signal, undefined, undefined, false, scope).then(reply => {
      const read = controller.signal.aborted ? null : parseSavedDays(reply);
      if (!read) return;
      const wanted = new Set(gridDates(month));
      setCounts(previous => {
        const byDate = new Map(previous?.scope === scope ? previous.byDate : []);
        for (const bucket of read) if (wanted.has(bucket.date)) byDate.set(bucket.date, bucket.count);
        return {scope, byDate};
      });
    }, reason => { if (reason instanceof ApiError && reason.status === 404) unsupported.current = scope; });
    return () => controller.abort();
  }, [month, scope, enabled, version]);
  return useMemo(() => counts?.scope === scope ? [...counts.byDate].map(([date, count]) => ({date, count})) : [], [counts, scope]);
}
