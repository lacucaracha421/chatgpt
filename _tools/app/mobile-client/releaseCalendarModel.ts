export type ReleasePrecision = 'exact' | 'month' | 'quarter' | 'year' | 'tbd';
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

function releaseTokenLabel(token: string | null, referenceYear: number): string {
  if (!token || token === 'tbd') return '미정';
  const day = DATE_RE.test(token) ? token : null;
  if (day) return releaseDateLabel(day, 'exact', referenceYear);
  const month = /^(\d{4})-(\d{2})$/.exec(token);
  if (month) return releaseDateLabel(`${token}-01`, 'month', referenceYear);
  const quarter = /^(\d{4})-Q([1-4])$/.exec(token);
  if (quarter) return `${quarter[1]} Q${quarter[2]}`;
  if (/^\d{4}$/.test(token)) return `${token}년 중`;
  return token;
}

export function releaseEventLine(event: Pick<ReleaseCalendarEvent, 'kind' | 'previousValue' | 'currentValue'>, referenceYear = new Date().getFullYear()): string {
  const current = releaseTokenLabel(event.currentValue, referenceYear);
  switch (event.kind) {
    case 'date_set': return `발매일 공개 · ${current}`;
    case 'date_changed': return `발매일 변경 · ${releaseTokenLabel(event.previousValue, referenceYear)} → ${current}`;
    case 'released': return current;
  }
}

export function releaseDaysUntil(date: string | null, today = new Date()): number | null {
  if (!date || !DATE_RE.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(year, month - 1, day) - start) / 86_400_000);
}

/** Precision-aware wording shared with the PC calendar: exact, month, quarter, year, TBD. */
export function releaseDateLabel(date: string | null, precision: ReleasePrecision, referenceYear = new Date().getFullYear()): string {
  const parts = date ? DATE_RE.exec(date) : null;
  if (!parts || precision === 'tbd') return '미정';
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const prefix = year === referenceYear ? '' : `${year}년 `;
  switch (precision) {
    case 'exact': return `${prefix}${month}월 ${day}일`;
    case 'month': return `${prefix}${month}월 중`;
    case 'quarter': return `${year} Q${Math.floor((month - 1) / 3) + 1}`;
    case 'year': return `${year}년 중`;
  }
}

function periodOf(entry: ReleaseCalendarEntry): {monthKey: string; monthLabel: string; dayKey: string; dayLabel: string; order: string} {
  const parts = entry.date ? DATE_RE.exec(entry.date) : null;
  if (!parts || entry.precision === 'tbd') return {monthKey: 'tbd', monthLabel: '미정', dayKey: 'tbd', dayLabel: '날짜 미정', order: '9999-99-z'};
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  if (entry.precision === 'exact') return {monthKey: `${parts[1]}-${parts[2]}`, monthLabel: `${year}년 ${month}월`, dayKey: entry.date!, dayLabel: `${month}월 ${Number(parts[3])}일`, order: `${entry.date}-a`};
  if (entry.precision === 'month') return {monthKey: `${parts[1]}-${parts[2]}`, monthLabel: `${year}년 ${month}월`, dayKey: `${parts[1]}-${parts[2]}-month`, dayLabel: `${month}월 중`, order: `${parts[1]}-${parts[2]}-b`};
  if (entry.precision === 'quarter') {
    const quarter = Math.floor((month - 1) / 3) + 1;
    return {monthKey: `${parts[1]}-Q${quarter}`, monthLabel: `${year} Q${quarter} · 월 미정`, dayKey: `${parts[1]}-Q${quarter}`, dayLabel: `${year} Q${quarter} · 월 미정`, order: `${year}-${String(quarter * 3).padStart(2, '0')}-c`};
  }
  return {monthKey: `${parts[1]}-year`, monthLabel: `${year}년 · 시기 미정`, dayKey: `${parts[1]}-year`, dayLabel: `${year}년 · 시기 미정`, order: `9999-${year}-d`};
}

/** Group exact dates within month sections while retaining PC's broader period buckets. */
export function groupReleaseEntries(items: ReleaseCalendarEntry[]): ReleaseMonthGroup[] {
  const months = new Map<string, {order: string; label: string; days: Map<string, {order: string; label: string; items: ReleaseCalendarEntry[]}>}>();
  items.forEach((entry, index) => {
    const period = periodOf(entry);
    const month = months.get(period.monthKey) ?? {order: period.order, label: period.monthLabel, days: new Map()};
    const day = month.days.get(period.dayKey) ?? {order: period.order, label: period.dayLabel, items: []};
    day.items.push(entry);
    day.order = `${day.order}:${String(index).padStart(5, '0')}`.slice(0, 32);
    month.days.set(period.dayKey, day);
    month.order = month.order < period.order ? month.order : period.order;
    months.set(period.monthKey, month);
  });
  return [...months.entries()]
    .sort(([, left], [, right]) => left.order.localeCompare(right.order))
    .map(([key, month]) => ({
      key,
      label: month.label,
      items: [...month.days.values()].reduce((sum, day) => sum + day.items.length, 0),
      days: [...month.days.values()].sort((left, right) => left.order.localeCompare(right.order)).map(day => ({key: `${key}:${day.label}`, label: day.label, items: day.items})),
    }));
}

export function filterReleaseEntries(entries: ReleaseCalendarEntry[], kind: KindFilter, wishlistOnly: boolean, wishlist: Set<string>): ReleaseCalendarEntry[] {
  return entries.filter(entry => (kind === 'all' || entry.kind === kind) && (!wishlistOnly || wishlist.has(entry.id)));
}
