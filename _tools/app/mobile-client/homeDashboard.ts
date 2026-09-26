import {useEffect, useState, useSyncExternalStore} from 'react';
import {rowView, type ExchangeSnapshot} from './exchange';
import {koreanReleases, localToday, NO_RELEASES, RELEASE_COUNTS_PATH, releaseCaption, releaseCounts, shortReleaseDate, type MangaShelf, type ReleaseCaption, type ReleaseCounts} from './collectionReleases';
import type {CollectionSummary} from './collectionModel';
import {currentShelf, loadShelf, observePublication, releaseEpoch, subscribeReleases} from './releaseStore';
import {useCharacterReviewCount} from './useCharacterReview';
import {useSimilarityReviewCount} from './useSimilarityReview';
import {useDuplicateCount} from './CatalogDuplicates';
import {useVisibleInterval} from './useVisibleInterval';
import {ApiError, api} from './transport';

/**
 * Home's dashboard: the to-do counts, 신간 and 발매 예정, the 보내는 중 strip and the
 * connection line, from data the tablet already reads elsewhere.
 *
 * - Counts: the same single-row reads the Library root and Catalog use for their review rows.
 * - 신간 / 발매 예정: the release counts read (tiny) and the manga shelf from the shared release
 *   store, read at most once per Collections publication whichever of Home and the 신간 screen
 *   asks first.
 * - 받은 파일 / 보내는 중 / PC: the native exchange snapshot the App already holds.
 * - Offline: the last fresh values are kept in a small per-connection snapshot so Home can say
 *   what it last knew and when.
 */
export type TodoKey = 'pending' | 'character' | 'similar' | 'duplicates' | 'arrived';
export const TODO_LABELS: Record<TodoKey, {label: string; unit: string}> = {
  pending: {label: '처리 대기', unit: '건'},
  character: {label: '캐릭터', unit: '건'},
  similar: {label: '유사', unit: '쌍'},
  duplicates: {label: '중복 판본', unit: '건'},
  arrived: {label: '받은 파일', unit: '개'},
};
export const TODO_ORDER: TodoKey[] = ['pending', 'character', 'similar', 'duplicates', 'arrived'];
/** The pending-capture read's page size: a full page reads as "40+". */
export const PENDING_LIMIT = 40;

export type ReleaseRow = {id: string; name: string; unread: number; caption: ReleaseCaption | null};
export type UpcomingRow = {id: string; name: string; date: string; volumeNumber: number};
export type SendingSummary = {name: string; more: number; peer: string; progress: number | null};

const ownedOf = (work: CollectionSummary, edition: number) => work.ownedVolumes?.find(entry => entry.editionIndex === edition)?.count ?? null;
const watching = (work: CollectionSummary) => work.type === 'manga' && !!work.releaseWatch?.enabled;

/** Works with unread 신간 알림, most notifications first; only works the shelf knows are listed. */
export function releaseRows(shelf: MangaShelf | null, counts: ReleaseCounts, today = localToday()): ReleaseRow[] {
  const works = new Map((shelf?.works ?? []).map(work => [work.id, work]));
  return Object.entries(counts.byCollection).flatMap(([id, unread]) => {
    const work = works.get(id);
    if (!work) return [];
    const kakao = work.releaseSchedule?.kakao;
    return [{id, name: work.name, unread, caption: releaseCaption(work, unread, kakao ? ownedOf(work, kakao.editionIndex) : null, watching(work), today)}];
  }).sort((a, b) => b.unread - a.unread || a.name.localeCompare(b.name, 'ko'));
}

/** Dated, not yet released Korean volumes of watched manga beyond the owned count, soonest first. */
export function upcomingReleases(shelf: MangaShelf | null, today = localToday()): UpcomingRow[] {
  const watched = (shelf?.works ?? []).filter(watching);
  return koreanReleases(watched, ownedOf, [], today).flatMap(row => row.volumes
    .filter((volume): volume is typeof volume & {date: string} => volume.upcoming && !!volume.date)
    .map(volume => ({id: row.work.id, name: row.work.name, date: volume.date, volumeNumber: volume.volumeNumber})))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko') || a.volumeNumber - b.volumeNumber);
}

export function watchedCount(shelf: MangaShelf | null) { return (shelf?.works ?? []).filter(watching).length; }

/** "10.8" and "수요일" for a `YYYY-MM-DD` date. */
export function dateBlock(date: string, today = localToday()) {
  const [year, month, day] = date.split('-').map(Number);
  return {day: shortReleaseDate(date, today), weekday: `${'일월화수목금토'[new Date(year, month - 1, day).getDay()]}요일`};
}
/** "14:32" in local time. */
export function clockLabel(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The outgoing transfers in progress, as one line: the first file, how many more, and the overall progress. */
export function sendingSummary(snapshot: ExchangeSnapshot | null): SendingSummary | null {
  const rows = (snapshot?.outgoing ?? []).filter(row => rowView(row, false).tone === 'active');
  if (!rows.length) return null;
  const size = rows.reduce((sum, row) => sum + Math.max(0, row.sizeBytes), 0);
  const bytes = rows.reduce((sum, row) => sum + Math.max(0, Math.min(row.bytes, row.sizeBytes)), 0);
  const first = rows[0];
  const peer = snapshot?.devices.find(device => device.deviceId === first.peerId)?.name || first.peer;
  return {name: first.fileName, more: rows.length - 1, peer, progress: size > 0 ? bytes / size : null};
}

/** The other device seen most recently (the PC), from the exchange snapshot. */
export function lastPeer(snapshot: ExchangeSnapshot | null) {
  const devices = (snapshot?.devices ?? []).filter(device => device.deviceId !== snapshot?.deviceId && Number.isFinite(Date.parse(device.lastSeenAt)));
  return devices.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0] ?? null;
}
export function agoLabel(at: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  const date = new Date(at);
  return `${date.getMonth() + 1}.${date.getDate()} ${clockLabel(date.getTime())}`;
}

/* ---- Offline snapshot ---- */
export const HOME_SNAPSHOT_KEY = 'lakomics.mobile.homeSnapshot';
type Stamped<T> = {value: T; at: number};
export type HomeSnapshot = {
  scope: string;
  counts: Partial<Record<TodoKey | 'releases', Stamped<number>>>;
  releases?: Stamped<ReleaseRow[]>;
  upcoming?: Stamped<UpcomingRow[]>;
};
const SNAPSHOT_ROWS = 6;
export function readHomeSnapshot(scope: string): HomeSnapshot {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY) ?? 'null') as HomeSnapshot | null;
    if (saved?.scope === scope && saved.counts && typeof saved.counts === 'object') return saved;
  } catch { /* An unreadable snapshot is no snapshot. */ }
  return {scope, counts: {}};
}
function writeHomeSnapshot(snapshot: HomeSnapshot) {
  try { localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch { /* Optional: offline values only. */ }
}
/** Merge fresh values into the snapshot; unknown values keep what was there. */
export function rememberHomeValues(scope: string, fresh: {counts: Partial<Record<TodoKey | 'releases', number | null>>; releases?: ReleaseRow[] | null; upcoming?: UpcomingRow[] | null}, now = Date.now()) {
  const current = readHomeSnapshot(scope);
  const counts = {...current.counts};
  let changed = false;
  for (const [key, value] of Object.entries(fresh.counts) as [TodoKey | 'releases', number | null][]) {
    if (value === null || value === undefined) continue;
    counts[key] = {value, at: now}; changed = true;
  }
  const next: HomeSnapshot = {...current, counts};
  if (fresh.releases) { next.releases = {value: fresh.releases.slice(0, SNAPSHOT_ROWS), at: now}; changed = true; }
  if (fresh.upcoming) { next.upcoming = {value: fresh.upcoming.slice(0, SNAPSHOT_ROWS), at: now}; changed = true; }
  if (changed) writeHomeSnapshot(next);
  return next;
}

/** A request failure that means "cannot reach the server" rather than a server answer. */
export function isOffline(reason: unknown) {
  if (reason instanceof DOMException && reason.name === 'AbortError') return false;
  return reason instanceof ApiError ? reason.status === null : true;
}

export type HomeDashboardInput = {
  enabled: boolean; scope: string;
  pending: number | null;
  reviewEnabled: boolean; reviewKey: unknown; similarityKey: unknown;
  exchange: ExchangeSnapshot | null;
};
/** How often Home re-checks the release counts and the Collections publication while visible. */
const CHECK_MS = 60_000;

export function useHomeDashboard({enabled, scope, pending, reviewEnabled, reviewKey, similarityKey, exchange}: HomeDashboardInput) {
  const character = useCharacterReviewCount(enabled && reviewEnabled, null, reviewKey);
  const similar = useSimilarityReviewCount(enabled, similarityKey);
  const duplicates = useDuplicateCount(enabled);
  const [counts, setCounts] = useState<ReleaseCounts | null>(null);
  const [probe, setProbe] = useState(0);
  const [unreachable, setUnreachable] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const epoch = useSyncExternalStore(subscribeReleases, releaseEpoch);
  const shelf = useSyncExternalStore(subscribeReleases, currentShelf);
  const [snapshot, setSnapshot] = useState(() => readHomeSnapshot(scope));
  useEffect(() => setSnapshot(readHomeSnapshot(scope)), [scope]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  // Two small reads per visit (and per minute while visible): the unread counts, and the
  // Collections publication revision that decides whether the kept shelf is still current.
  useVisibleInterval(() => setProbe(n => n + 1), enabled ? CHECK_MS : null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const fail = (reason: unknown) => { if (!controller.signal.aborted && isOffline(reason)) setUnreachable(true); };
    void api<unknown>(RELEASE_COUNTS_PATH, controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      setUnreachable(false); setCounts(reply ? releaseCounts(reply) : NO_RELEASES);
    }, fail);
    void api<{revision?: string | null}>('/v1/collections/status', controller.signal).then(reply => {
      if (!controller.signal.aborted) observePublication(reply?.revision ?? null);
    }, fail);
    return () => controller.abort();
  }, [enabled, probe]);

  // The heavy shelf read: only when the shared store has nothing current for this epoch.
  useEffect(() => {
    if (!enabled || currentShelf()) return;
    const controller = new AbortController();
    void loadShelf(controller.signal).catch(reason => { if (!controller.signal.aborted && isOffline(reason)) setUnreachable(true); });
    return () => controller.abort();
  }, [enabled, epoch]);

  const offline = !online || unreachable;
  const arrived = exchange?.configured ? exchange.unseen : null;
  const live: Record<TodoKey, number | null> = {pending, character: reviewEnabled ? character : null, similar, duplicates, arrived};
  const releases = counts && shelf ? releaseRows(shelf, counts) : null;
  const upcoming = shelf ? upcomingReleases(shelf) : null;

  // Keep the last fresh values for an offline Home (only what was actually read).
  const freshKey = offline ? '' : JSON.stringify([live, counts?.unread ?? null, releases, upcoming]);
  useEffect(() => {
    if (!freshKey) return;
    const {arrived: _arrived, ...stored} = live;
    setSnapshot(rememberHomeValues(scope, {counts: {...stored, releases: counts ? Object.keys(counts.byCollection).length : null}, releases, upcoming}));
  }, [freshKey, scope]);

  const pick = <T,>(value: T | null, kept: Stamped<T> | undefined) => value ?? kept?.value ?? null;
  const todos = Object.fromEntries(TODO_ORDER.map(key => [key, pick(live[key], key === 'arrived' ? undefined : snapshot.counts[key])])) as Record<TodoKey, number | null>;
  const kept = Object.values(snapshot.counts).map(entry => entry?.at ?? 0);
  return {
    todos,
    applicable: TODO_ORDER.filter(key => key !== 'character' || reviewEnabled).filter(key => key !== 'arrived' || !!exchange?.configured),
    unreadWorks: counts ? Object.keys(counts.byCollection).length : snapshot.counts.releases?.value ?? null,
    releases: pick(releases, snapshot.releases),
    releasesAt: offline || !releases ? snapshot.releases?.at ?? null : null,
    upcoming: pick(upcoming, snapshot.upcoming),
    upcomingAt: offline || !upcoming ? snapshot.upcoming?.at ?? null : null,
    watched: shelf ? watchedCount(shelf) : null,
    sending: sendingSummary(exchange),
    peer: lastPeer(exchange),
    offline,
    /** When the values shown offline were last fresh. */
    since: kept.length ? Math.max(...kept) : null,
  };
}
export type HomeDashboard = ReturnType<typeof useHomeDashboard>;
