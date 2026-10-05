import {groupReleaseDays, groupReleases, isVisibleCalendarRelease, releaseDateLabel} from '../src/collections/releaseCalendarFormat';
import {daysUntil} from '../src/shared/displayDate';
export type ReleasePrecision = 'exact' | 'month' | 'quarter' | 'year' | 'tbd';
export {releaseDateLabel,releaseEventLine,releaseTokenLabel} from '../src/collections/releaseCalendarFormat';
export type ReleaseKind = 'game' | 'movie' | 'anime';

export type ReleaseCover = {
  url?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
};

export type ReleaseCalendarEvent = {
  id: string;
  itemId: string;
  kind: 'date_set' | 'date_changed' | 'released';
  previousValue: string | null;
  currentValue: string | null;
  detectedAt: string | null;
  readAt: string | null;
};

export type ReleaseCalendarEntry = {
  id: string;
  kind: ReleaseKind;
  title: string;
  originalTitle: string | null;
  date: string | null;
  precision: ReleasePrecision;
  region: string | null;
  platforms: string[];
  releaseType: string | null;
  cover: ReleaseCover | null;
  /** A new platform version of a game already released elsewhere (the PC marks it). */
  port: boolean;
  unread: ReleaseCalendarEvent[];
};

export type UpcomingIntent = {itemId?: string; action?: string};
export type ReleaseCalendarReply = {
  publishedAt: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  entries: ReleaseCalendarEntry[];
  wishlist: ReleaseCalendarEntry[];
  pending: UpcomingIntent[];
};

export type KindFilter = 'all' | ReleaseKind;

export type ReleaseDayGroup = {key: string; label: string; items: ReleaseCalendarEntry[]};
export type ReleaseMonthGroup = {key: string; label: string; items: number; days: ReleaseDayGroup[]};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRECISIONS: ReleasePrecision[] = ['exact', 'month', 'quarter', 'year', 'tbd'];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function coverOf(value: unknown): ReleaseCover | null {
  const row = record(value);
  if (!row) return null;
  const cover: ReleaseCover = {};
  for (const key of ['url', 'sha256', 'contentType'] as const) {
    const item = row[key];
    if (typeof item === 'string' && item) cover[key] = item;
  }
  for (const key of ['sizeBytes'] as const) {
    if (typeof row[key] === 'number' && Number.isFinite(row[key])) cover[key] = row[key] as number;
  }
  return Object.keys(cover).length ? cover : null;
}

function eventOf(value: unknown, itemId: string): ReleaseCalendarEvent | null {
  const row = record(value);
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  if (row.kind !== 'date_set' && row.kind !== 'date_changed' && row.kind !== 'released') return null;
  return {
    id: row.id,
    itemId: typeof row.itemId === 'string' && row.itemId ? row.itemId : itemId,
    kind: row.kind,
    previousValue: stringOrNull(row.previousValue),
    currentValue: stringOrNull(row.currentValue),
    detectedAt: stringOrNull(row.detectedAt),
    readAt: stringOrNull(row.readAt),
  };
}

function entryOf(value: unknown): ReleaseCalendarEntry | null {
  const row = record(value);
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.title !== 'string' || !row.title) return null;
  if (row.kind !== 'game' && row.kind !== 'movie' && row.kind !== 'anime') return null;
  const date = typeof row.date === 'string' && DATE_RE.test(row.date) ? row.date : null;
  const precision = PRECISIONS.includes(row.precision as ReleasePrecision)
    ? row.precision as ReleasePrecision
    : date ? 'exact' : 'tbd';
  const eventValues = Array.isArray(row.events) ? row.events : Array.isArray(row.unread) ? row.unread : [];
  const unread = eventValues
    .map(event => eventOf(event, row.id as string))
    .filter((event): event is ReleaseCalendarEvent => !!event && !event.readAt);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    originalTitle: stringOrNull(row.originalTitle),
    date,
    precision: date || precision === 'tbd' ? precision : 'tbd',
    region: stringOrNull(row.region),
    platforms: Array.isArray(row.platforms) ? row.platforms.filter((item): item is string => typeof item === 'string' && !!item) : [],
    releaseType: stringOrNull(row.releaseType),
    cover: coverOf(row.cover),
    port: row.port === true,
    unread,
  };
}

/** Normalize the server snapshot without letting a malformed optional row break the whole screen. */
export function normalizeReleaseCalendarReply(value: unknown): ReleaseCalendarReply {
  const row = record(value);
  const entries = Array.isArray(row?.entries) ? row.entries.map(entryOf).filter((entry): entry is ReleaseCalendarEntry => !!entry) : [];
  const wishlist = Array.isArray(row?.wishlist) ? row.wishlist.map(entryOf).filter((entry): entry is ReleaseCalendarEntry => !!entry) : [];
  const pending = Array.isArray(row?.pending) ? row.pending.map(item => record(item)).filter((item): item is Record<string, unknown> => !!item).map(item => ({itemId: typeof item.itemId === 'string' ? item.itemId : undefined, action: typeof item.action === 'string' ? item.action : undefined})) : [];
  return {
    publishedAt: stringOrNull(row?.publishedAt),
    rangeStart: stringOrNull(row?.rangeStart),
    rangeEnd: stringOrNull(row?.rangeEnd),
    entries,
    wishlist,
    pending,
  };
}

export function wishlistIds(reply: ReleaseCalendarReply): Set<string> {
  return new Set(reply.wishlist.map(entry => entry.id));
}

/** Apply the same local outbox overlay used by Home C to a snapshot's interest ids. */
export function visibleWishlistIds(authoritative: Set<string>, intents: Record<string, {action: 'add' | 'remove'}>): Set<string> {
  const ids = new Set(authoritative);
  for (const [itemId, intent] of Object.entries(intents)) {
    if (intent.action === 'add') ids.add(itemId);
    else ids.delete(itemId);
  }
  return ids;
}

export function releaseDaysUntil(date: string | null, today = new Date()): number | null {
  return date && DATE_RE.test(date) ? daysUntil(date, today) : null;
}

/** PC and tablet share the window, section order and within-section date order. */
export function groupReleaseEntries(items: ReleaseCalendarEntry[], now = new Date()): ReleaseMonthGroup[] {
  return groupReleases(items, now).map(group => ({
    key: group.key,
    label: group.label,
    items: group.items.length,
    days: groupReleaseDays(group.items, group.key === 'recent').map(day => {
      const first = day[0]!;
      return {
        key: `${group.key}:${first.date ?? 'tbd'}:${first.precision}`,
        label: first.precision === 'tbd' ? '날짜 미정' : releaseDateLabel(first.date, first.precision, now.getFullYear()),
        items: day,
      };
    }),
  }));
}

export function filterReleaseEntries(entries: ReleaseCalendarEntry[], kind: KindFilter, wishlistOnly: boolean, wishlist: Set<string>, now = new Date()): ReleaseCalendarEntry[] {
  return entries.filter(entry => isVisibleCalendarRelease(entry, now) && (kind === 'all' || entry.kind === kind) && (!wishlistOnly || wishlist.has(entry.id)));
}
