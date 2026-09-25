/**
 * Manga release notifications (신간 알림) shared with the PC
 * (`server/lakomics-api/collection_releases.py`).
 *
 * The PC detects release events and publishes its unread ones; this device lists them and
 * confirms (확인) them. Read state is shared: a 확인 here leaves the unread list at once and
 * the PC marks the event read when it next syncs. There is no push; the Collections tab is
 * the only place they show (user decision, 2026-09-25).
 *
 * Only the two client routes are used: the unread list read and the acknowledge command.
 * The list asks for the default tablet kinds (new volumes and release-date changes), and the
 * per-Collection acknowledge form uses the same default, so a status change the tablet never
 * showed stays unread on the PC.
 */
import {api} from './transport';

export const RELEASES_PATH = '/v1/collections/releases';
export const RELEASES_ACKNOWLEDGE_PATH = '/v1/collections/releases/acknowledge';
/** The count read: `counts` cover every Collection whatever the page, so one item keeps it tiny. */
export const RELEASE_COUNTS_PATH = `${RELEASES_PATH}?limit=1`;

export type ReleaseKind = 'new_volume' | 'release_date_changed' | 'release_status_changed';
export type ReleaseEvent = {
  eventId: string;
  collectionId: string;
  collectionName: string;
  provider: 'aladin' | 'kakao' | 'mangadex';
  kind: ReleaseKind;
  volumeNumber: number;
  previousValue: string | null;
  currentValue: string | null;
  detectedAt: string;
  read?: boolean;
  readAt?: string | null;
};
export type ReleaseCounts = {unread: number; byCollection: Record<string, number>};
export type ReleaseList = {
  version: 1;
  revision: number;
  counts: {unread: number; collections: {collectionId: string; unread: number}[]};
  items: ReleaseEvent[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type AcknowledgeReply = {acknowledged: string[]; alreadyRead: string[]; missing: string[]};

export const NO_RELEASES: ReleaseCounts = {unread: 0, byCollection: {}};

/** Counts from a list reply; anything malformed (an older server, a fixture) reads as none. */
export function releaseCounts(reply: unknown): ReleaseCounts {
  const counts = (reply as Partial<ReleaseList> | null)?.counts;
  if (!counts || !Array.isArray(counts.collections)) return NO_RELEASES;
  const byCollection: Record<string, number> = {};
  for (const entry of counts.collections) {
    if (entry && typeof entry.collectionId === 'string' && Number.isInteger(entry.unread) && entry.unread > 0) byCollection[entry.collectionId] = entry.unread;
  }
  const unread = Object.values(byCollection).reduce((sum, n) => sum + n, 0);
  return {unread, byCollection};
}

export function releasesPage(cursor: string | null, signal?: AbortSignal): Promise<ReleaseList> {
  const params = new URLSearchParams({limit: '50'});
  if (cursor) params.set('cursor', cursor);
  return api<ReleaseList>(`${RELEASES_PATH}?${params}`, signal);
}

/**
 * Mark events read, by id or every unread (tablet-kind) event of one Collection. Retrying with
 * a fresh operation id is harmless: an event already read comes back in `alreadyRead`.
 */
export function acknowledgeReleases(target: {eventIds: string[]} | {collectionId: string}, signal?: AbortSignal): Promise<AcknowledgeReply> {
  return api<AcknowledgeReply>(RELEASES_ACKNOWLEDGE_PATH, signal, {version: 1, operationId: crypto.randomUUID(), ...target});
}

/** A provider date `2026-10-03` as `2026.10.3`; other text is shown as it came. */
export function releaseDate(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (!match) return text;
  return [match[1], Number(match[2]), match[3] ? Number(match[3]) : null].filter(part => part !== null).join('.');
}

/** One event as a line: "13권 새로 나옴 · 2026.10.3" or "13권 발매일 2026.10.1 → 2026.10.15". */
export function releaseLine(event: ReleaseEvent): string {
  const volume = `${event.volumeNumber}권`;
  if (event.kind === 'new_volume') {
    const date = releaseDate(event.currentValue);
    return date ? `${volume} 새로 나옴 · ${date}` : `${volume} 새로 나옴`;
  }
  if (event.kind === 'release_date_changed') return `${volume} 발매일 ${releaseDate(event.previousValue) || '미정'} → ${releaseDate(event.currentValue) || '미정'}`;
  const status = (value: string | null) => value === 'upcoming' ? '출간 예정' : value === 'released' ? '출간됨' : value ?? '미정';
  return `${volume} ${status(event.previousValue)} → ${status(event.currentValue)}`;
}

export type ReleaseGroup = {collectionId: string; name: string; events: ReleaseEvent[]};
/** Events grouped by Collection, newest group first (the list is newest first already). */
export function groupReleases(events: ReleaseEvent[]): ReleaseGroup[] {
  const groups = new Map<string, ReleaseGroup>();
  for (const event of events) {
    const group = groups.get(event.collectionId);
    if (group) group.events.push(event);
    else groups.set(event.collectionId, {collectionId: event.collectionId, name: event.collectionName, events: [event]});
  }
  return [...groups.values()];
}
