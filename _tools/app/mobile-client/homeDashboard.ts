import {useEffect, useState, useSyncExternalStore} from 'react';
import {rowView, type ExchangeSnapshot} from './exchange';
import {koreanReleases, localToday, NO_RELEASES, RELEASE_COUNTS_PATH, releaseCaption, releaseCounts, type MangaShelf, type ReleaseCaption, type ReleaseCounts} from './collectionReleases';
import type {CollectionSummary} from './collectionModel';
import {currentShelf, invalidateReleases, loadShelf, observePublication, releaseEpoch, subscribeReleases} from './releaseStore';
import {useSimilarityReviewCount} from './useSimilarityReview';
import {useDuplicateCount} from './CatalogDuplicates';
import {useCachedHomeSource, useCachedHomeSourceRead} from './homeCache';
import {ApiError, api, native} from './transport';
import type {RefreshJob} from './CatalogRefresh';
import {fetchLibrarySummary, type LibrarySummary} from './librarySummary';
import type {Asset, Revisit} from './types';
import type {Note, NotesState} from '../src/notes/store';
import {daysAfter,UPCOMING_DAYS} from '../src/home/homeModel';
import {commitUpcomingWishlist, flushUpcomingWishlist, readUpcomingWishlistIntents, reconcileUpcomingWishlist, visibleUpcomingWishlist} from './upcomingWishlistOutbox';

export {clockLabel,daysAfter,UPCOMING_DAYS} from '../src/home/homeModel';

/** Shared source cache for the attention-only Home; refreshes retain previous values. */
export type TodoKey = 'pending' | 'character' | 'similar' | 'duplicates';
export const TODO_LABELS: Record<TodoKey, {label: string; unit: string; note: string}> = {
  pending: {label: '처리 대기', unit: '건', note: '수집 요청 · 분류 전'},
  character: {label: '캐릭터 검토', unit: '건', note: '자동 분류 후보 확인'},
  similar: {label: '유사 이미지', unit: '쌍', note: '같은 그림일 수 있음'},
  duplicates: {label: '중복 판본', unit: '건', note: '카탈로그 · 같은 작품'},
};
export const TODO_ORDER: TodoKey[] = ['pending', 'character', 'similar', 'duplicates'];

export type ReleaseRow = {id: string; name: string; unread: number; caption: ReleaseCaption | null};
export type UpcomingRow = {id: string; name: string; date: string; volumeNumber: number};
export type SendingSummary = {name: string; more: number; peer: string; progress: number | null};

export type HomeCover = {url?: string | null; sha256?: string | null; sizeBytes?: number | null; contentType?: string | null};
export type UpcomingHomeEntry = {
  id: string; kind: 'game' | 'movie' | 'anime'; title: string; originalTitle?: string | null;
  date?: string | null; precision?: string | null; region?: string | null; platforms?: string[];
  releaseType?: string | null; cover?: HomeCover | null; description?: string | null; port?: boolean;
};
export type UpcomingWatchEvent = {
  id: string; kind: 'date_set' | 'date_changed' | 'released'; previousValue?: string | null;
  currentValue?: string | null; detectedAt: string; readAt?: string | null;
};
export type UpcomingWishItem = UpcomingHomeEntry & {
  source: 'calendar' | 'manual'; addedAt: string; muted: boolean; released: boolean;
  events: UpcomingWatchEvent[];
};
export type UpcomingHomeReply = {version?: number; revision?: string | number | null; entries?: UpcomingHomeEntry[]; wishlist?: UpcomingWishItem[]; pending?: {itemId?: string; action?: string}[]};
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
/* ---- 신간 · 발매 예정 cover shelf ---- */
/** A `YYYY-MM-DD` date from `shortReleaseDate`'s "9.24" / "2025.9.24" (the year defaults to today's). */
export function releaseDateOf(short: string | null | undefined, today = localToday()) {
  const parts = short?.split('.').map(Number) ?? [];
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part))) return null;
  const [year, month, day] = parts.length === 3 ? parts : [Number(today.slice(0, 4)), ...parts];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export type ShelfEntry =
  | {kind: 'new'; id: string; name: string; date: string | null; volumes: string}
  | {kind: 'upcoming'; id: string; name: string; date: string; volumeNumber: number; days: number};
/**
 * The cover shelf, left to right: the newly released volumes (newest first; one without a known
 * date counts as today's), then the dated volumes due within `window` days, soonest first.
 */
export function shelfEntries(releases: ReleaseRow[], upcoming: UpcomingRow[], today = localToday(), window = UPCOMING_DAYS): ShelfEntry[] {
  const fresh = releases.map((row): ShelfEntry => {
    const text = row.caption?.text ?? `신간 알림 ${row.unread}`;
    return {kind: 'new', id: row.id, name: row.name, date: row.caption?.kind === 'new' ? releaseDateOf(row.caption.date, today) : null,
      volumes: text.startsWith('신간 알림') ? text : text.replace(/^신간 /, '')};
  }).sort((a, b) => (b.date ?? today).localeCompare(a.date ?? today));
  const soon = upcoming.map(row => ({...row, days: daysAfter(row.date, today)}))
    .filter(row => row.days >= 0 && row.days <= window)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko') || a.volumeNumber - b.volumeNumber)
    .map((row): ShelfEntry => ({kind: 'upcoming', ...row}));
  return [...fresh, ...soon];
}

/* ---- 다시 보기 ---- */
export type RevisitGroup = {key: string; title: string; name?: string; count: number; items: Asset[]; label: string};
const dotDate = (at: string | null | undefined) => {
  const date = at ? new Date(at) : null;
  return date && Number.isFinite(date.getTime()) ? `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}` : null;
};
const savedAt = (asset: Asset) => asset.collected_at ?? asset.created_at ?? null;
/**
 * The two 다시 보기 groups from `/v1/library/revisit`: 과거의 이날 (saved around this date in
 * earlier years) and the first 다시 만난 작가 group. Empty groups are left out.
 */
export function revisitGroups(reply: Revisit | null | undefined, now = Date.now()): RevisitGroup[] {
  const groups: RevisitGroup[] = [];
  for (const bundle of reply?.bundles ?? []) {
    if (bundle.kind === 'date' && bundle.items?.length) {
      const dates = bundle.items.map(savedAt).filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort();
      const first = dotDate(dates[0]), last = dotDate(dates[dates.length - 1]);
      const when = first && last ? (first === last ? `${first} 저장` : `${first} – ${last} 저장`) : '예전에 저장';
      groups.push({key: 'date', title: bundle.title || '과거의 이날', count: bundle.items.length, items: bundle.items, label: `${when} · ${bundle.items.length}장`});
    }
    if (bundle.kind === 'creator') {
      const group = bundle.groups?.find(entry => entry.items?.length);
      if (!group) continue;
      const name = group.creator_name || group.creator_handle;
      const newest = group.items.map(savedAt).filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort().reverse()[0];
      const months = newest ? Math.floor((now - Date.parse(newest)) / (30.44 * 86_400_000)) : 0;
      const gap = months >= 12 ? `${Math.floor(months / 12)}년 만 · ` : months >= 1 ? `${months}개월 만 · ` : '';
      groups.push({key: group.creator_key, title: `${bundle.title || '다시 만난 작가'} · ${name}`, name, count: group.asset_count, items: group.items, label: `${gap}소장 ${group.asset_count.toLocaleString('ko-KR')}장`});
    }
  }
  return groups;
}
export const REVISIT_PATH = '/v1/library/revisit?limit=12';
/**
 * Reads 다시 보기 once per visit (the server's groups only change by day) and again after
 * `key` moves (다시 연결). A failed read keeps what was shown; nothing shown means no section.
 */
export function useHomeRevisit(enabled: boolean, scope: string, forceKey?: unknown) {
  return useCachedHomeSource({
    enabled, scope, source: 'revisit', signalKey: 'listGeneration', initial: [] as RevisitGroup[], forceKey,
    read: async signal => revisitGroups(await api<Revisit>(REVISIT_PATH, signal)),
  });
}

export type HomeMemos = {notes: Note[]; locked: boolean} | null;
/** Reads the on-device notes (no network) whenever Home is shown and `key` moves. */
export function useHomeMemos(enabled: boolean, scope: string, forceKey?: unknown): HomeMemos {
  return useCachedHomeSource({
    enabled, scope, source: 'memos', signalKey: 'notes', initial: null as HomeMemos, forceKey,
    read: async () => {
      const state = await native<NotesState>('notesState', {});
      return {notes: state.unlocked ? state.notes ?? [] : [], locked: !state.unlocked};
    },
  });
}

function validHomeEntry(value: unknown): value is UpcomingHomeEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.title === 'string' && (row.kind === 'game' || row.kind === 'movie' || row.kind === 'anime');
}

function normalizeWishlistItem(value: unknown): UpcomingWishItem | null {
  if (!validHomeEntry(value)) return null;
  const row = value as UpcomingHomeEntry & Partial<UpcomingWishItem>;
  const events = Array.isArray(row.events) ? row.events.filter((event): event is UpcomingWatchEvent => {
    if (!event || typeof event !== 'object') return false;
    const candidate = event as Partial<UpcomingWatchEvent>;
    return typeof candidate.id === 'string' && typeof candidate.detectedAt === 'string'
      && (candidate.kind === 'date_set' || candidate.kind === 'date_changed' || candidate.kind === 'released');
  }) : [];
  return {...row, source: row.source === 'manual' ? 'manual' : 'calendar',
    addedAt: typeof row.addedAt === 'string' ? row.addedAt : '', muted: row.muted === true,
    released: row.released === true, events};
}

export function normalizeUpcomingReply(value: unknown): UpcomingHomeReply {
  const reply = value && typeof value === 'object' ? value as UpcomingHomeReply : {};
  return {...reply, entries: (Array.isArray(reply.entries) ? reply.entries : []).filter(validHomeEntry),
    wishlist: (Array.isArray(reply.wishlist) ? reply.wishlist : []).flatMap(value => {
      const item = normalizeWishlistItem(value); return item ? [item] : [];
    })};
}

export function wishlistIds(reply: UpcomingHomeReply | null): Set<string> {
  return new Set((reply?.wishlist ?? []).map(entry => entry.id));
}

export const HOME_UPCOMING_CACHE_KEY = 'lakomics.mobile.homeUpcoming.v1';
const HOME_UPCOMING_CACHE_LIMIT = 4;
type UpcomingCacheEntry = {scope: string; reply: UpcomingHomeReply; at: number};

function readUpcomingCache(): UpcomingCacheEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_UPCOMING_CACHE_KEY) ?? 'null') as unknown;
    if (!Array.isArray(saved)) return [];
    return saved.flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const row = value as {scope?: unknown; reply?: unknown; at?: unknown};
      if (typeof row.scope !== 'string' || !row.scope || !row.reply || typeof row.reply !== 'object') return [];
      return [{scope: row.scope, reply: normalizeUpcomingReply(row.reply), at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0}];
    }).slice(0, HOME_UPCOMING_CACHE_LIMIT);
  } catch { return []; }
}

function cachedUpcoming(scope: string): UpcomingHomeReply | null {
  if (!scope) return null;
  return readUpcomingCache().find(value => value.scope === scope)?.reply ?? null;
}

function rememberUpcoming(scope: string, reply: UpcomingHomeReply): void {
  if (!scope) return;
  const next = [{scope, reply, at: Date.now()}, ...readUpcomingCache().filter(value => value.scope !== scope)].slice(0, HOME_UPCOMING_CACHE_LIMIT);
  try { localStorage.setItem(HOME_UPCOMING_CACHE_KEY, JSON.stringify(next)); } catch { /* Optional first paint cache. */ }
}

export function useHomeUpcoming(enabled: boolean, scope: string, forceKey?: unknown) {
  const {value: reply, ready} = useCachedHomeSourceRead<UpcomingHomeReply | null>({
    enabled, scope, source: 'upcoming', signalKey: 'upcoming', initial: cachedUpcoming(scope), forceKey,
    read: async signal => {
      await flushUpcomingWishlist(signal, scope);
      const next = normalizeUpcomingReply(await api<unknown>('/v1/home/upcoming', signal));
      reconcileUpcomingWishlist(wishlistIds(next));
      rememberUpcoming(scope, next);
      return next;
    },
  });
  const [tick, setTick] = useState(0);
  const ids = wishlistIds(reply);
  const pending = readUpcomingWishlistIntents();
  // A pending intent overrides the server: `add` shows the title, `remove` hides it.
  for (const [id, intent] of Object.entries(pending)) { if (intent.action === 'add') ids.add(id); else ids.delete(id); }
  const toggle = (itemId: string) => {
    const current = visibleUpcomingWishlist(itemId, wishlistIds(reply).has(itemId)).value;
    commitUpcomingWishlist(itemId, !current); setTick(n => n + 1);
    const controller = new AbortController();
    void flushUpcomingWishlist(controller.signal, scope).finally(() => controller.abort());
  };
  return {ready, entries: reply?.entries ?? [], wishlistItems: reply?.wishlist ?? [], wishlist: ids, wishlistPending: tick, toggle};
}

export const HOME_SNAPSHOT_KEY = 'lakomics.mobile.homeSnapshot';
type Stamped<T> = {value: T; at: number};
export type HomeSnapshot = {
  scope: string;
  counts: Partial<Record<TodoKey | 'releases', Stamped<number>>>;
  releases?: Stamped<ReleaseRow[]>;
  upcoming?: Stamped<UpcomingRow[]>;
  summary?: Stamped<LibrarySummary>;
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
export function rememberHomeValues(scope: string, fresh: {counts: Partial<Record<TodoKey | 'releases', number | null>>; releases?: ReleaseRow[] | null; upcoming?: UpcomingRow[] | null; summary?: LibrarySummary | null}, now = Date.now()) {
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
  if (fresh.summary) { next.summary = {value: fresh.summary, at: now}; changed = true; }
  if (changed) writeHomeSnapshot(next);
  return next;
}

/** A request failure that means "cannot reach the server" rather than a server answer. */
export function isOffline(reason: unknown) {
  if (reason instanceof DOMException && reason.name === 'AbortError') return false;
  // Android distinguishes DNS/connect failures and timeouts in these sanitized messages.
  // A missing HTTP status alone also includes malformed JSON and local bridge failures.
  return reason instanceof Error && (!(reason instanceof ApiError) || reason.status === null)
    && (reason.message === '서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.'
      || reason.message === '연결 시간이 초과되었습니다. 다시 시도해 주세요.');
}

export function homeReadProblem(reason: unknown): 'offline' | 'server' | null {
  if (reason instanceof DOMException && reason.name === 'AbortError') return null;
  return isOffline(reason) ? 'offline' : 'server';
}

export type HomeDashboardInput = {
  enabled: boolean; scope: string;
  pending: number | null;
  similarityKey: unknown;
  exchange: ExchangeSnapshot | null;
};
export function useHomeDashboard({enabled, scope, pending, similarityKey, exchange}: HomeDashboardInput) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [problems, setProblems] = useState<Record<string, 'offline' | 'server'>>({});
  useEffect(() => setProblems({}), [scope]);
  const result = (source: string, reason?: unknown) => {
    const problem = reason === undefined ? null : homeReadProblem(reason);
    setProblems(previous => {
      if (previous[source] === problem || (!problem && !previous[source])) return previous;
      const next = {...previous};
      if (problem) next[source] = problem; else delete next[source];
      return next;
    });
  };
  const similar = useSimilarityReviewCount(enabled, similarityKey, scope, refreshKey);
  const duplicates = useDuplicateCount(enabled, scope, refreshKey);
  const {value: counts, ready: countsReady} = useCachedHomeSourceRead<ReleaseCounts | null>({
    enabled, scope, source: 'releaseCounts', signalKey: 'releases', initial: null, forceKey: refreshKey,
    read: async signal => { const reply = await api<unknown>(RELEASE_COUNTS_PATH, signal); if (!signal.aborted) result('releases'); return reply ? releaseCounts(reply) : NO_RELEASES; }, onError: reason => result('releases', reason),
  });
  const {value: collectionRevision, ready: collectionsReady} = useCachedHomeSourceRead<string | null>({
    enabled, scope, source: 'collectionsStatus', signalKey: 'collections', initial: null, forceKey: refreshKey,
    read: async signal => { const reply = await api<{revision?: string | null}>('/v1/collections/status', signal); if (!signal.aborted) result('collections'); return reply?.revision ?? null; }, onError: reason => result('collections', reason),
  });
  const summary = useCachedHomeSource<LibrarySummary | null | undefined>({
    enabled, scope, source: 'summary', signalKey: 'listGeneration', initial: undefined, forceKey: refreshKey,
    read: async signal => { const reply = await fetchLibrarySummary(signal); if (!signal.aborted) result('summary'); return reply; }, onError: reason => result('summary', reason),
  });
  const catalogJob = useCachedHomeSource<RefreshJob | null>({
    enabled, scope, source: 'catalogJob', signalKey: 'catalog', initial: null, forceKey: refreshKey,
    read: async signal => (await api<{job?: RefreshJob | null}>('/v1/mobile-catalog/refresh', signal))?.job ?? null,
  });
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

  useEffect(() => { observePublication(collectionRevision); }, [collectionRevision]);

  // The heavy shelf read: only when the shared store has nothing current for this epoch.
  useEffect(() => {
    if (!enabled || currentShelf()) return;
    const controller = new AbortController();
    void loadShelf(controller.signal).then(() => { if (!controller.signal.aborted) result('shelf'); }, reason => { if (!controller.signal.aborted) result('shelf', reason); });
    return () => controller.abort();
  }, [enabled, epoch]);

  const offline = !online || Object.values(problems).includes('offline');
  const serverProblem = Object.values(problems).includes('server');
  const live: Record<TodoKey, number | null> = {pending, character: null, similar, duplicates};
  const releases = counts && shelf ? releaseRows(shelf, counts) : null;
  const upcoming = shelf ? upcomingReleases(shelf) : null;

  // Keep the last fresh values for an offline Home (only what was actually read).
  const freshKey = offline ? '' : JSON.stringify([live, counts?.unread ?? null, releases, upcoming, summary ?? null]);
  useEffect(() => {
    if (!freshKey) return;
    setSnapshot(rememberHomeValues(scope, {counts: {...live, releases: counts ? Object.keys(counts.byCollection).length : null}, releases, upcoming, summary}));
  }, [freshKey, scope]);

  const pick = <T,>(value: T | null, kept: Stamped<T> | undefined) => value ?? kept?.value ?? null;
  const todos = Object.fromEntries(TODO_ORDER.map(key => [key, pick(live[key], snapshot.counts[key])])) as Record<TodoKey, number | null>;
  const kept = Object.values(snapshot.counts).map(entry => entry?.at ?? 0);
  return {
    todos,
    /** Offline: when the kept to-do counts were last fresh. */
    todosAt: offline ? Math.max(0, ...TODO_ORDER.map(key => snapshot.counts[key]?.at ?? 0)) || null : null,
    applicable: TODO_ORDER.filter(key => key !== 'character'),
    unreadWorks: counts ? Object.keys(counts.byCollection).length : snapshot.counts.releases?.value ?? null,
    releasesReady: countsReady && collectionsReady && Boolean(shelf?.ready && (!collectionRevision || shelf.revision === collectionRevision)),
    releases: pick(releases, snapshot.releases),
    releasesAt: offline || !releases ? snapshot.releases?.at ?? null : null,
    upcoming: pick(upcoming, snapshot.upcoming),
    upcomingAt: offline || !upcoming ? snapshot.upcoming?.at ?? null : null,
    watched: shelf ? watchedCount(shelf) : null,
    sending: sendingSummary(exchange),
    peer: lastPeer(exchange),
    catalogJob: offline ? null : catalogJob,
    /** The library summary: fresh, else the kept one; null when neither exists. */
    summary: summary === null && !offline ? null : (offline ? null : summary) ?? snapshot.summary?.value ?? null,
    summaryAt: offline ? snapshot.summary?.at ?? null : null,
    /** The server answered without a summary route: count the first page instead. */
    summaryUnsupported: summary === null && !offline,
    /** Re-check now (the offline notice's 다시 연결). */
    retry: () => { invalidateReleases(); setOnline(typeof navigator === 'undefined' || navigator.onLine !== false); setRefreshKey(key => key + 1); },
    probe: refreshKey,
    refreshKey,
    offline,
    serverProblem,
    /** When the values shown offline were last fresh. */
    since: kept.length ? Math.max(...kept) : null,
  };
}
export type HomeDashboard = ReturnType<typeof useHomeDashboard>;
