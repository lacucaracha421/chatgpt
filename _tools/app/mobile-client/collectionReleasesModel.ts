import {loadedPerformerNames} from './personNameCache';
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
 * The tablet reads all three kinds (a 발매됨 status change counts too), and the per-Collection
 * acknowledge form names the same three kinds, so 확인 clears exactly what was shown.
 *
 * The 신간 screen also reads each manga's `releaseSchedule` (published by an upgraded PC) to
 * list unowned Korean volumes and how far the Japanese edition is ahead; the pure helpers for
 * that live here too.
 */
import {api} from './transport';
import {collectionPath, type CollectionKind, type CollectionPage, type CollectionSummary, type KakaoReleaseVolume} from './collectionModel';
import {shortReleaseDate} from '../src/collections/releaseCaption';
import type {ReleaseBoardEntry, ReleaseInboxItem} from '../src/library/types';
export {shortReleaseDate} from '../src/collections/releaseCaption';
export {localDay as localToday} from '../src/shared/displayDate';

export const RELEASES_PATH = '/v1/collections/releases';
export const RELEASES_ACKNOWLEDGE_PATH = '/v1/collections/releases/acknowledge';
export type ReleaseKind = 'new_volume' | 'release_date_changed' | 'release_status_changed';
export const RELEASE_KINDS: ReleaseKind[] = ['new_volume', 'release_date_changed', 'release_status_changed'];
/** The count read: `counts` cover every Collection whatever the page, so one item keeps it tiny. */
export const RELEASE_COUNTS_PATH = `${RELEASES_PATH}?${new URLSearchParams({limit: '1', kinds: RELEASE_KINDS.join(',')})}`;
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
/** `revision` is the list revision after this command (one past the previous when it marked anything). */
export type AcknowledgeReply = {acknowledged: string[]; alreadyRead: string[]; missing: string[]; revision?: number};

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
  const params = new URLSearchParams({limit: '100', kinds: RELEASE_KINDS.join(',')});
  if (cursor) params.set('cursor', cursor);
  return api<ReleaseList>(`${RELEASES_PATH}?${params}`, signal);
}

/** The list `revision` of a reply, or null when missing (an older server, a fixture). */
export function releaseRevision(reply: unknown): number | null {
  const value = (reply as {revision?: unknown} | null)?.revision;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Every unread event (all three kinds), page after page; bounded so a runaway list cannot loop.
 * `revision` is the first page's list revision.
 */
export async function allUnreadReleases(signal?: AbortSignal): Promise<{items: ReleaseEvent[]; counts: ReleaseCounts; revision: number | null}> {
  const items: ReleaseEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null, counts = NO_RELEASES, revision: number | null = null;
  for (let page = 0; page < 20; page++) {
    const reply: ReleaseList = await releasesPage(cursor, signal);
    if (page === 0) { counts = releaseCounts(reply); revision = releaseRevision(reply); }
    for (const event of reply.items ?? []) if (!seen.has(event.eventId)) { seen.add(event.eventId); items.push(event); }
    if (!reply.hasMore || !reply.nextCursor) break;
    cursor = reply.nextCursor;
  }
  return {items, counts, revision};
}

export type MangaShelf = {works: CollectionSummary[]; revision: string; ready: boolean};
/**
 * Every published manga Collection (the list route has no 신간 알림 filter), page after page
 * of one publication revision. A publication that lands mid-read restarts it once.
 */
export function allMangaWorks(signal?: AbortSignal): Promise<MangaShelf> { return allWorks('manga', signal); }
/** Every published Collection of one type (the AV performer page reads the whole AV shelf this way). */
export async function allWorks(type: CollectionKind, signal?: AbortSignal): Promise<MangaShelf> {
  const filters = {sort: 'name', direction: 'asc', rating: 'all'} as const;
  for (let attempt = 0; ; attempt++) {
    const works: CollectionSummary[] = [];
    let cursor: string | null = null, first: CollectionPage | null = null;
    try {
      for (let page = 0; page < 100; page++) {
        const reply: CollectionPage = await api<CollectionPage>(collectionPath(type, '', false, cursor, filters), signal);
        first ??= reply;
        if (reply.revision !== first.revision) throw Object.assign(new Error('Collection list changed'), {status: 409});
        works.push(...await loadedPerformerNames(reply.items ?? []));
        if (!reply.nextCursor) break;
        cursor = reply.nextCursor;
      }
      return {works: works.filter(work => work.type === type), revision: first?.revision ?? '', ready: first?.ready !== false};
    } catch (reason) {
      if (attempt > 0 || (reason as {status?: number}).status !== 409 || signal?.aborted) throw reason;
    }
  }
}

/**
 * Mark events read, by id or every unread event of one Collection (all three kinds, as the
 * tablet lists them). Retrying with a fresh operation id is harmless: an event already read
 * comes back in `alreadyRead`.
 */
export function acknowledgeReleases(target: {eventIds: string[]} | {collectionId: string}, signal?: AbortSignal): Promise<AcknowledgeReply> {
  const body = 'collectionId' in target ? {...target, kinds: RELEASE_KINDS} : target;
  return api<AcknowledgeReply>(RELEASES_ACKNOWLEDGE_PATH, signal, {version: 1, operationId: crypto.randomUUID(), ...body});
}

const validDate = (value: string | null | undefined) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

export type KoreanVolume = {volumeNumber: number; date: string | null; upcoming: boolean; released: boolean; fresh: boolean};
export type KoreanRow = {work: CollectionSummary; owned: number | null; volumes: KoreanVolume[]; fresh: number};

const byCollection = (events: ReleaseEvent[]) => {
  const map = new Map<string, ReleaseEvent[]>();
  for (const event of events) map.set(event.collectionId, [...(map.get(event.collectionId) ?? []), event]);
  return map;
};

/**
 * 한국 정발: every watched work whose Kakao edition has a volume beyond the owned count, with
 * those volumes. `owned` is the visible (possibly still queued) count of the Kakao edition, or
 * null when untracked (then every volume is unowned). Works are ordered by the nearest date
 * that matters: the soonest upcoming volume first, then the most recently released, then
 * works whose dates are unknown.
 */
export function koreanReleases(works: CollectionSummary[], ownedOf: (work: CollectionSummary, edition: number) => number | null, events: ReleaseEvent[], today: string): KoreanRow[] {
  const unread = byCollection(events);
  const rows: (KoreanRow & {group: number; key: string})[] = [];
  for (const work of works) {
    const kakao = work.releaseSchedule?.kakao;
    if (!kakao) continue;
    const owned = ownedOf(work, kakao.editionIndex);
    const workEvents = unread.get(work.id) ?? [];
    const freshVolumes = new Set(workEvents.filter(event => event.provider !== 'mangadex').map(event => event.volumeNumber));
    const numbers = new Set<number>();
    const volumes = (kakao.volumes ?? []).filter((volume: KakaoReleaseVolume) => Number.isInteger(volume.volumeNumber) && volume.volumeNumber > (owned ?? 0) && !numbers.has(volume.volumeNumber) && numbers.add(volume.volumeNumber))
      .map((volume): KoreanVolume => {
        const date = validDate(volume.date);
        // `status` is as of the PC's check, so a known date decides against this device's today.
        const upcoming = date ? date > today : volume.status === 'upcoming';
        const released = date ? date <= today : volume.status === 'released';
        return {volumeNumber: volume.volumeNumber, date, upcoming, released, fresh: freshVolumes.has(volume.volumeNumber)};
      })
      .sort((a, b) => a.volumeNumber - b.volumeNumber);
    if (!volumes.length) continue;
    const soonest = volumes.filter(volume => volume.upcoming && volume.date).map(volume => volume.date!).sort()[0];
    const latest = volumes.filter(volume => volume.released && volume.date).map(volume => volume.date!).sort().reverse()[0];
    rows.push({work, owned, volumes, fresh: workEvents.length, group: soonest ? 0 : latest ? 1 : 2, key: soonest ?? latest ?? ''});
  }
  rows.sort((a, b) => a.group - b.group || (a.group === 0 ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)) || a.work.name.localeCompare(b.work.name, 'ko'));
  return rows.map(({group: _group, key: _key, ...row}) => row);
}

export type ReleaseCaption = {kind: 'new' | 'out' | 'ahead'; text: string; date: string | null};
/**
 * The grid tile's 신간 marker, shown after the year and stars. In priority:
 * - `new` (unread 신간 알림): "신간 13권 · 9.24", naming the unowned Korean volumes already out
 *   (only the newest when the owned count is unknown) and the latest of their dates. An unread
 *   notice the schedule cannot name (a MangaDex volume, a date change, no schedule from an
 *   older PC, or a game/movie) reads "신간 알림 N".
 * - `out` (watched, nothing unread): the same wording for Korean volumes already out but not owned.
 * - `ahead` (watched, nothing unread or out): "9권 예약 · 11.20", the soonest dated pre-registered volume.
 * The volumes are the 신간 screen's 한국 정발 rows (`koreanReleases`), so both agree.
 */
export function releaseCaption(work: CollectionSummary, unread: number, owned: number | null, watching: boolean, today: string): ReleaseCaption | null {
  if (work.type !== 'manga') return unread > 0 ? {kind: 'new', text: `신간 알림 ${unread}`, date: null} : null;
  if (unread <= 0 && !watching) return null;
  const volumes = work.releaseSchedule?.kakao ? koreanReleases([work], () => owned, [], today)[0]?.volumes ?? [] : [];
  const out = volumes.filter(volume => volume.released);
  if (out.length) {
    // Without an owned count every volume is unowned, so only the newest one is named.
    const high = out[out.length - 1].volumeNumber, low = owned == null ? high : out[0].volumeNumber;
    const latest = out.map(volume => volume.date).filter((date): date is string => !!date).sort().reverse()[0];
    return {kind: unread > 0 ? 'new' : 'out', text: `신간 ${low === high ? low : `${low}–${high}`}권`, date: latest ? shortReleaseDate(latest, today) : null};
  }
  if (unread > 0) return {kind: 'new', text: `신간 알림 ${unread}`, date: null};
  const soonest = volumes.filter((volume): volume is KoreanVolume & {date: string} => volume.upcoming && !!volume.date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.volumeNumber - b.volumeNumber)[0];
  return soonest ? {kind: 'ahead', text: `${soonest.volumeNumber}권 예약`, date: shortReleaseDate(soonest.date, today)} : null;
}

/**
 * One published manga's 신간 data in the PC's board shape (`ReleaseBoardEntry`), so the shared
 * release rules (`src/collections/releaseLedger.ts`, `releaseCaption.ts`) read it. Owned counts
 * and 신간 알림 are this device's visible values, a queued edit included.
 */
export function releaseBoardEntry(work: CollectionSummary, ownedOf: (work: CollectionSummary, edition: number) => number | null, watching: (work: CollectionSummary) => boolean): ReleaseBoardEntry {
  const kakao = work.releaseSchedule?.kakao ?? null;
  const tracked = [...new Set([...(work.ownedVolumes ?? []).map(entry => entry.editionIndex), ...(kakao ? [kakao.editionIndex] : [])])];
  return {
    collectionId: work.id,
    releaseWatch: {enabled: watching(work), available: work.releaseWatch?.available ?? false},
    ownedVolumes: tracked.flatMap(editionIndex => { const count = ownedOf(work, editionIndex); return count === null ? [] : [{editionIndex, count}]; }),
    releaseSchedule: {kakao, mangadex: work.releaseSchedule?.mangadex ?? null},
  };
}
/** Events from providers the apps still support; Aladin was retired (2026-10-09) and its stored events stay hidden, as on the PC. */
export function supportedReleaseEvents(events: readonly ReleaseEvent[]): (ReleaseEvent & {provider: 'kakao' | 'mangadex'})[] {
  return events.filter((event): event is ReleaseEvent & {provider: 'kakao' | 'mangadex'} => event.provider !== 'aladin');
}
/** A published unread event in the PC's inbox shape. */
export function releaseInboxItem(event: ReleaseEvent & {provider: 'kakao' | 'mangadex'}): ReleaseInboxItem {
  return {collectionId: event.collectionId, collectionName: event.collectionName, provider: event.provider, event: {id: event.eventId, kind: event.kind, volumeNumber: event.volumeNumber, previousValue: event.previousValue, currentValue: event.currentValue, detectedAt: event.detectedAt}};
}
