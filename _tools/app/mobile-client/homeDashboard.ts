import {useEffect, useState, useSyncExternalStore} from 'react';
import {rowView, type ExchangeSnapshot} from './exchange';
import {koreanReleases, localToday, NO_RELEASES, RELEASE_COUNTS_PATH, releaseCaption, releaseCounts, shortReleaseDate, type MangaShelf, type ReleaseCaption, type ReleaseCounts} from './collectionReleases';
import type {CollectionSummary} from './collectionModel';
import {currentShelf, loadShelf, observePublication, releaseEpoch, subscribeReleases} from './releaseStore';
import {useCharacterReviewBreakdown, type ReviewBreakdown} from './useCharacterReview';
import {useSimilarityReviewCount} from './useSimilarityReview';
import {useDuplicateCount} from './CatalogDuplicates';
import {useVisibleInterval} from './useVisibleInterval';
import {ApiError, api, native} from './transport';
import type {RefreshJob} from './CatalogRefresh';
import {fetchLibrarySummary, type LibrarySummary} from './librarySummary';
import type {CharacterIndex} from './characterModel';
import {byOrder, noteColorValue, stripMarkdown} from '../src/notes/model';
import type {Note, NotesState} from '../src/notes/store';
import {LEDGER, LEDGER_MONTH} from '../src/notes/ledger/model';
import {monthNotesOf, monthSummary} from '../src/notes/ledger/summary';

/**
 * Home's information dashboard (HOME-DASH-001, layout R2), from data the tablet already reads
 * elsewhere.
 *
 * - 확인할 것: the same single-row count reads the Library root and Catalog use; 캐릭터 검토 reads
 *   the first candidate pages instead, to split its total by series and character (the review
 *   route has no per-character counts).
 * - 신간 / 발매 예정: the release counts read (tiny) and the manga shelf from the shared release
 *   store, read at most once per Collections publication whichever of Home and the 신간 screen
 *   asks first.
 * - 전송 / PC: the native exchange snapshot the App already holds.
 * - 자산 현황: the library summary (`/v1/library/summary`); an older server without it falls
 *   back to counting the first page of recent saves. 캐릭터 자동 태그 comes from the character
 *   index the App already holds.
 * - 메모: the on-device notes store (works offline).
 * - 서버 상태: reachability, the PC's last visit and the catalog refresh job.
 * - Offline: the last fresh values are kept in a small per-connection snapshot so Home can say
 *   what it last knew and when.
 */
export type TodoKey = 'pending' | 'character' | 'similar' | 'duplicates';
export const TODO_LABELS: Record<TodoKey, {label: string; unit: string; note: string}> = {
  pending: {label: '처리 대기', unit: '건', note: '수집 요청 · 분류 전'},
  character: {label: '캐릭터 검토', unit: '건', note: '자동 분류 후보 확인'},
  similar: {label: '유사 이미지', unit: '쌍', note: '같은 그림일 수 있음'},
  duplicates: {label: '중복 판본', unit: '건', note: '카탈로그 · 같은 작품'},
};
export const TODO_ORDER: TodoKey[] = ['pending', 'character', 'similar', 'duplicates'];
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

/** Series and characters shown under 캐릭터 검토; the rest folds into "외 N건". */
export const REVIEW_SERIES = 3, REVIEW_CHARACTERS = 3;
/**
 * 캐릭터 검토's lines ("백합 › 라라 5 · 마리 2"): the busiest series and characters, only non-zero,
 * and `rest`, every candidate not shown by name (other series or characters, or not yet read).
 */
export function reviewLines(review: ReviewBreakdown | null) {
  if (!review) return {lines: [], rest: 0};
  const lines = review.groups.filter(group => group.count > 0).slice(0, REVIEW_SERIES).map(group => ({
    ...group, characters: group.characters.filter(entry => entry.count > 0).slice(0, REVIEW_CHARACTERS),
  }));
  const named = lines.reduce((sum, line) => sum + line.characters.reduce((all, entry) => all + entry.count, 0), 0);
  return {lines, rest: Math.max(0, review.total - named)};
}

/** How many days after `today` a `YYYY-MM-DD` date falls (local calendar days). */
export function daysAfter(date: string, today = localToday()) {
  const day = (value: string) => { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
  return Math.round(day(date) - day(today));
}
/** The 발매 예정 window. */
export const UPCOMING_DAYS = 30;

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

/**
 * 자산 현황's 오늘 추가, counted from the first page of recent saves (newest first). When every
 * asset on a page that has more is from today, the true count is unknown: `more` says "N+".
 */
export function addedToday(items: {collected_at?: string | null; created_at?: string | null}[], hasMore: boolean, now = new Date()) {
  const today = localToday(now);
  const count = items.filter(item => {
    const at = item.collected_at ?? item.created_at;
    const date = at ? new Date(at) : null;
    return !!date && Number.isFinite(date.getTime()) && localToday(date) === today;
  }).length;
  return {count, more: hasMore && count > 0 && count === items.length};
}

/**
 * 캐릭터 자동 태그 progress from the character index the App already holds: each series'
 * `unclassified` scope against its `all` scope. Null when the index has no such scopes.
 */
export function characterTagging(index: CharacterIndex | null | undefined) {
  if (!index?.ready) return null;
  let all = 0, left = 0, seen = false;
  for (const node of index.nodes) {
    if (node.kind !== 'series') continue;
    const total = index.scopes.find(scope => scope.nodeId === node.id && scope.filter === 'all')?.totalCount;
    const open = index.scopes.find(scope => scope.nodeId === node.id && scope.filter === 'unclassified')?.totalCount;
    if (typeof total !== 'number' || typeof open !== 'number') continue;
    all += total; left += Math.min(open, total); seen = true;
  }
  return seen && all > 0 ? {done: (all - left) / all, left} : null;
}

/* ---- 메모 ---- */
export type MemoRow =
  | {id: string; title: string; color: string | null; kind: 'checklist'; done: number; total: number}
  | {id: string; title: string; color: string | null; kind: 'ledger'; month: number; label: '쓸 수 있는 돈' | '쓴 돈'; amount: number}
  | {id: string; title: string; color: string | null; kind: 'secret'}
  | {id: string; title: string; color: string | null; kind: 'text'; snippet: string};
/** Pinned notes, most recently edited first, as one line each; month notes of a 가계부 never show. */
export function memoRows(notes: Note[], today = localToday()): MemoRow[] {
  return notes.filter(note => note.pinned && !note.deleted && !note.archived && note.type !== LEDGER_MONTH)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((note): MemoRow => {
      const base = {id: note.id, title: note.title.trim(), color: noteColorValue(note.color)};
      if (note.type === 'secret') return {...base, kind: 'secret'};
      if (note.type === LEDGER) {
        const summary = monthSummary(note, monthNotesOf(notes, note.id), today.slice(0, 7), today);
        return {...base, title: base.title || '가계부', kind: 'ledger', month: Number(today.slice(5, 7)),
          ...(summary.available !== null ? {label: '쓸 수 있는 돈' as const, amount: summary.available} : {label: '쓴 돈' as const, amount: summary.spent})};
      }
      if (note.type === 'checklist' && !note.readOnly) {
        const items = [...(note.items ?? [])].sort(byOrder);
        return {...base, kind: 'checklist', done: items.filter(item => item.checked).length, total: items.length};
      }
      return {...base, kind: 'text', snippet: note.body.split('\n').map(stripMarkdown).map(line => line.trim()).filter(Boolean).join(' ').slice(0, 160)};
    });
}
export type HomeMemos = {rows: MemoRow[]; locked: boolean} | null;
/** Reads the on-device notes (no network) whenever Home is shown and `key` moves. */
export function useHomeMemos(enabled: boolean, key: unknown): HomeMemos {
  const [memos, setMemos] = useState<HomeMemos>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void native<NotesState>('notesState', {}).then(state => {
      if (live) setMemos({rows: memoRows(state.notes ?? []), locked: !state.unlocked});
    }, () => { if (live) setMemos(current => current ?? {rows: [], locked: true}); });
    return () => { live = false; };
  }, [enabled, key]);
  return memos;
}

/* ---- Offline snapshot ---- */
export const HOME_SNAPSHOT_KEY = 'lakomics.mobile.homeSnapshot';
type Stamped<T> = {value: T; at: number};
export type HomeSnapshot = {
  scope: string;
  counts: Partial<Record<TodoKey | 'releases', Stamped<number>>>;
  releases?: Stamped<ReleaseRow[]>;
  upcoming?: Stamped<UpcomingRow[]>;
  summary?: Stamped<LibrarySummary>;
  /** 캐릭터 검토 split by series and character. */
  review?: Stamped<ReviewBreakdown>;
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
export function rememberHomeValues(scope: string, fresh: {counts: Partial<Record<TodoKey | 'releases', number | null>>; releases?: ReleaseRow[] | null; upcoming?: UpcomingRow[] | null; summary?: LibrarySummary | null; review?: ReviewBreakdown | null}, now = Date.now()) {
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
  if (fresh.review) { next.review = {value: {...fresh.review, groups: fresh.review.groups.slice(0, SNAPSHOT_ROWS)}, at: now}; changed = true; }
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
  const review = useCharacterReviewBreakdown(enabled && reviewEnabled, reviewKey);
  const character = review?.total ?? null;
  const similar = useSimilarityReviewCount(enabled, similarityKey);
  const duplicates = useDuplicateCount(enabled);
  const [counts, setCounts] = useState<ReleaseCounts | null>(null);
  const [probe, setProbe] = useState(0);
  const [catalogJob, setCatalogJob] = useState<RefreshJob | null>(null);
  /** undefined: not read yet; null: this server has no summary route (count the first page instead). */
  const [summary, setSummary] = useState<LibrarySummary | null | undefined>(undefined);
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
    // 자산 현황: one small aggregate read per visit and per minute, like the other counts.
    void fetchLibrarySummary(controller.signal).then(reply => {
      if (!controller.signal.aborted) setSummary(reply);
    }, fail);
    // The catalog refresh job for 서버 상태 (older servers answer with an error: no job).
    void api<{job?: RefreshJob | null}>('/v1/mobile-catalog/refresh', controller.signal).then(reply => {
      if (!controller.signal.aborted) setCatalogJob(reply?.job ?? null);
    }, () => {});
    return () => controller.abort();
  }, [enabled, probe]);

  // The heavy shelf read: only when the shared store has nothing current for this epoch.
  useEffect(() => {
    if (!enabled || currentShelf()) return;
    const controller = new AbortController();
    void loadShelf(controller.signal).catch(reason => { if (!controller.signal.aborted && isOffline(reason)) setUnreachable(true); });
    return () => controller.abort();
  }, [enabled, epoch, probe]);

  const offline = !online || unreachable;
  const live: Record<TodoKey, number | null> = {pending, character: reviewEnabled ? character : null, similar, duplicates};
  const releases = counts && shelf ? releaseRows(shelf, counts) : null;
  const upcoming = shelf ? upcomingReleases(shelf) : null;

  // Keep the last fresh values for an offline Home (only what was actually read).
  const freshKey = offline ? '' : JSON.stringify([live, counts?.unread ?? null, releases, upcoming, summary ?? null, reviewEnabled ? review : null]);
  useEffect(() => {
    if (!freshKey) return;
    setSnapshot(rememberHomeValues(scope, {counts: {...live, releases: counts ? Object.keys(counts.byCollection).length : null}, releases, upcoming, summary, review: reviewEnabled ? review : null}));
  }, [freshKey, scope]);

  const pick = <T,>(value: T | null, kept: Stamped<T> | undefined) => value ?? kept?.value ?? null;
  const todos = Object.fromEntries(TODO_ORDER.map(key => [key, pick(live[key], snapshot.counts[key])])) as Record<TodoKey, number | null>;
  const kept = Object.values(snapshot.counts).map(entry => entry?.at ?? 0);
  return {
    todos,
    /** Offline: when the kept to-do counts were last fresh. */
    todosAt: offline ? Math.max(0, ...TODO_ORDER.map(key => snapshot.counts[key]?.at ?? 0)) || null : null,
    /** 캐릭터 검토 by series and character (fresh, else the kept split); null when unknown. */
    review: reviewEnabled ? (live.character !== null ? review : snapshot.review?.value ?? null) : null,
    applicable: TODO_ORDER.filter(key => key !== 'character' || reviewEnabled),
    unreadWorks: counts ? Object.keys(counts.byCollection).length : snapshot.counts.releases?.value ?? null,
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
    retry: () => { setOnline(typeof navigator === 'undefined' || navigator.onLine !== false); setProbe(n => n + 1); },
    probe,
    offline,
    /** When the values shown offline were last fresh. */
    since: kept.length ? Math.max(...kept) : null,
  };
}
export type HomeDashboard = ReturnType<typeof useHomeDashboard>;
