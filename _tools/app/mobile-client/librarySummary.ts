import {api, ApiError} from './transport';

export const LIBRARY_SUMMARY_PATH = '/v1/library/summary';

const GENERATION_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Counts for the Home library card, over the same visible Assets the library list shows.
 * `addedToday`/`addedThisWeek` are cut at the device's local midnight (week starts
 * Monday); `todayStart`/`weekStart` are those cuts as UTC instants.
 */
export type LibrarySummary = {
  total: number;
  addedToday: number;
  addedThisWeek: number;
  unclassified: number;
  todayStart: string;
  weekStart: string;
  listGeneration: string;
};

/** Minutes east of UTC for `now`, the server's `tzOffsetMinutes` (KST = 540). */
export function tzOffsetMinutes(now: Date = new Date()): number {
  // `getTimezoneOffset` is minutes *behind* UTC; `|| 0` folds a `-0` to `0`.
  return -now.getTimezoneOffset() || 0;
}

export function librarySummaryPath(now: Date = new Date()): string {
  return `${LIBRARY_SUMMARY_PATH}?tzOffsetMinutes=${tzOffsetMinutes(now)}`;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The reply as a {@link LibrarySummary}, or `null` when it does not have that shape. */
export function parseLibrarySummary(reply: unknown): LibrarySummary | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const r = reply as Record<string, unknown>;
  if (!isCount(r.total) || !isCount(r.addedToday) || !isCount(r.addedThisWeek) || !isCount(r.unclassified)) return null;
  if (typeof r.todayStart !== 'string' || typeof r.weekStart !== 'string') return null;
  if (typeof r.listGeneration !== 'string' || !GENERATION_PATTERN.test(r.listGeneration)) return null;
  return {
    total: r.total, addedToday: r.addedToday, addedThisWeek: r.addedThisWeek,
    unclassified: r.unclassified, todayStart: r.todayStart, weekStart: r.weekStart,
    listGeneration: r.listGeneration,
  };
}

/**
 * The library summary, or `null` when the server predates the route (404) or answers
 * with an unexpected shape, so the card can hide instead of failing Home. Transport and
 * auth failures still propagate.
 */
export async function fetchLibrarySummary(signal?: AbortSignal, now: Date = new Date()): Promise<LibrarySummary | null> {
  let reply: unknown;
  try {
    reply = await api<unknown>(librarySummaryPath(now), signal);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
  return parseLibrarySummary(reply);
}
