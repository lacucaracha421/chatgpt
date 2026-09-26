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
import {collectionPath, type CollectionPage, type CollectionSummary, type KakaoReleaseVolume} from './collectionModel';

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
  const params = new URLSearchParams({limit: '100', kinds: RELEASE_KINDS.join(',')});
  if (cursor) params.set('cursor', cursor);
  return api<ReleaseList>(`${RELEASES_PATH}?${params}`, signal);
}

/** Every unread event (all three kinds), page after page; bounded so a runaway list cannot loop. */
export async function allUnreadReleases(signal?: AbortSignal): Promise<{items: ReleaseEvent[]; counts: ReleaseCounts}> {
  const items: ReleaseEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null, counts = NO_RELEASES;
  for (let page = 0; page < 20; page++) {
    const reply: ReleaseList = await releasesPage(cursor, signal);
    if (page === 0) counts = releaseCounts(reply);
    for (const event of reply.items ?? []) if (!seen.has(event.eventId)) { seen.add(event.eventId); items.push(event); }
    if (!reply.hasMore || !reply.nextCursor) break;
    cursor = reply.nextCursor;
  }
  return {items, counts};
}

export type MangaShelf = {works: CollectionSummary[]; revision: string; ready: boolean};
/**
 * Every published manga Collection (the list route has no 신간 알림 filter), page after page
 * of one publication revision. A publication that lands mid-read restarts it once.
 */
export async function allMangaWorks(signal?: AbortSignal): Promise<MangaShelf> {
  const filters = {sort: 'name', direction: 'asc', rating: 'all'} as const;
  for (let attempt = 0; ; attempt++) {
    const works: CollectionSummary[] = [];
    let cursor: string | null = null, first: CollectionPage | null = null;
    try {
      for (let page = 0; page < 100; page++) {
        const reply: CollectionPage = await api<CollectionPage>(collectionPath('manga', '', false, cursor, filters), signal);
        first ??= reply;
        if (reply.revision !== first.revision) throw Object.assign(new Error('Collection list changed'), {status: 409});
        works.push(...(reply.items ?? []));
        if (!reply.nextCursor) break;
        cursor = reply.nextCursor;
      }
      return {works: works.filter(work => work.type === 'manga'), revision: first?.revision ?? '', ready: first?.ready !== false};
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

/** Today in local time as `YYYY-MM-DD`, the form provider dates compare against. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
const validDate = (value: string | null | undefined) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

export type KoreanVolume = {volumeNumber: number; date: string | null; upcoming: boolean; released: boolean; fresh: boolean};
export type KoreanRow = {work: CollectionSummary; owned: number | null; volumes: KoreanVolume[]; fresh: number};
export type JapanRow = {work: CollectionSummary; latest: number; ahead: number | null; aheadVolumes: {volumeNumber: number; fresh: boolean}[]; fresh: number};

/** A Korean volume's line: "3권 · 9월 16일 발매됨", "4권 · 10월 10일 발매 예정", "5권 · 발매일 미정". */
export function koreanVolumeLine(volume: KoreanVolume, today: string): string {
  const head = `${volume.volumeNumber}권`;
  if (!volume.date) return volume.released ? `${head} · 발매됨` : `${head} · 발매일 미정`;
  const [year, month, day] = volume.date.split('-').map(Number);
  const when = `${year === Number(today.slice(0, 4)) ? '' : `${year}년 `}${month}월 ${day}일`;
  return `${head} · ${when} ${volume.upcoming ? '발매 예정' : '발매됨'}`;
}

const byCollection = (events: ReleaseEvent[]) => {
  const map = new Map<string, ReleaseEvent[]>();
  for (const event of events) map.set(event.collectionId, [...(map.get(event.collectionId) ?? []), event]);
  return map;
};
const kakaoMax = (work: CollectionSummary) => Math.max(0, ...(work.releaseSchedule?.kakao?.volumes ?? []).map(volume => volume.volumeNumber));

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

/**
 * 일본: every watched work with MangaDex data, its latest Japanese volume and, when the Korean
 * edition is behind, by how many volumes and which ones. Newly detected (unread MangaDex)
 * volumes are marked. Works with a newly detected volume come first, then the furthest ahead.
 */
export function japanReleases(works: CollectionSummary[], events: ReleaseEvent[]): JapanRow[] {
  const unread = byCollection(events);
  const rows: JapanRow[] = [];
  for (const work of works) {
    const mangadex = work.releaseSchedule?.mangadex;
    if (!mangadex) continue;
    const listed = (mangadex.volumes ?? []).map(volume => volume.volumeNumber).filter(Number.isFinite);
    const latest = mangadex.latestVolume ?? (listed.length ? Math.max(...listed) : null);
    if (latest == null) continue;
    const workEvents = unread.get(work.id) ?? [];
    const fresh = new Set(workEvents.filter(event => event.provider === 'mangadex').map(event => event.volumeNumber));
    const korean = work.releaseSchedule?.kakao?.volumes?.length ? kakaoMax(work) : null;
    const ahead = korean != null && latest > korean ? latest - korean : null;
    const numbers = new Set<number>();
    if (ahead) for (let volume = korean! + 1; volume <= latest; volume++) numbers.add(volume);
    for (const volume of fresh) if (volume <= latest) numbers.add(volume);
    const aheadVolumes = [...numbers].sort((a, b) => a - b).map(volumeNumber => ({volumeNumber, fresh: fresh.has(volumeNumber)}));
    rows.push({work, latest, ahead, aheadVolumes, fresh: workEvents.length});
  }
  const news = (row: JapanRow) => Number(row.aheadVolumes.some(volume => volume.fresh));
  return rows.sort((a, b) => news(b) - news(a) || (b.ahead ?? 0) - (a.ahead ?? 0) || a.work.name.localeCompare(b.work.name, 'ko'));
}

/** A short date for a grid caption: `9.24` this year, `2027.1.5` otherwise. */
export function shortReleaseDate(date: string, today: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${String(year) === today.slice(0, 4) ? '' : `${year}.`}${month}.${day}`;
}
export type ReleaseCaption = {kind: 'new' | 'ahead'; text: string; date: string | null};
/**
 * The grid tile's 신간 line (it replaces the year/rating line): "신간 13권 · 9.24" while the work
 * has unread 신간 알림, naming the unowned Korean volumes already out (only the newest when the
 * owned count is unknown) and the latest of their dates; "9권 예약 · 11.20" for the
 * soonest dated, pre-registered unowned volume of a watched work with nothing unread. An unread
 * notice the schedule cannot name (a MangaDex volume, a date change, or no schedule from an
 * older PC) reads "신간 알림 N".
 */
export function releaseCaption(work: CollectionSummary, unread: number, owned: number | null, watching: boolean, today: string): ReleaseCaption | null {
  if (work.type !== 'manga') return null;
  const volumes = (work.releaseSchedule?.kakao?.volumes ?? []).filter(volume => Number.isInteger(volume.volumeNumber) && volume.volumeNumber > (owned ?? 0));
  if (unread > 0) {
    // A known date decides against this device's today, as on the 신간 screen.
    const out = volumes.filter(volume => { const date = validDate(volume.date); return date ? date <= today : volume.status === 'released'; });
    if (!out.length) return {kind: 'new', text: `신간 알림 ${unread}`, date: null};
    // Without an owned count every volume is unowned, so only the newest one is named.
    const numbers = out.map(volume => volume.volumeNumber), high = Math.max(...numbers), low = owned == null ? high : Math.min(...numbers);
    const latest = out.map(volume => validDate(volume.date)).filter((date): date is string => !!date).sort().reverse()[0];
    return {kind: 'new', text: `신간 ${low === high ? low : `${low}–${high}`}권`, date: latest ? shortReleaseDate(latest, today) : null};
  }
  if (!watching) return null;
  const soonest = volumes.map(volume => ({number: volume.volumeNumber, date: validDate(volume.date)}))
    .filter((volume): volume is {number: number; date: string} => !!volume.date && volume.date > today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number)[0];
  return soonest ? {kind: 'ahead', text: `${soonest.number}권 예약`, date: shortReleaseDate(soonest.date, today)} : null;
}
