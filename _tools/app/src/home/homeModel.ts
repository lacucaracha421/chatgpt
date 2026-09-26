import type { ExchangeSnapshot } from "../exchange/exchangeStore";
import type { AuthoritySyncHealth, CloudBackfillProgress, CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem, ReleaseWishlistItem } from "../library/types";
import { koreanReleases, releaseCaption, shortReleaseDate, type ReleaseCaption } from "../collections/releaseCaption";
import { releaseEventLine } from "../collections/releaseCalendarFormat";
import { byOrder, noteColorValue, stripMarkdown } from "../notes/model";
import type { Note } from "../notes/store";
import { LEDGER, LEDGER_MONTH } from "../notes/ledger/model";
import { monthNotesOf, monthSummary } from "../notes/ledger/summary";

/**
 * PC Home (HOME-DASH-001, layout B "priority ledger"): pure shaping of data other screens
 * already read. Nothing here reads or polls; HomeView owns the reads.
 */

/** "14:32" in local time. */
export function clockLabel(at: Date | string | number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Local midnight today and on this week's Monday, as instants for `get_home_overview`. */
export function localBoundaries(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return { todayStart: today.toISOString(), weekStart: monday.toISOString() };
}

const WEEKDAYS = "일월화수목금토";
/** "10.8" and "수요일" for a `YYYY-MM-DD` date (the year only when it differs from today's). */
export function dateBlock(date: string, today: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { day: shortReleaseDate(date, today), weekday: `${WEEKDAYS[new Date(year!, month! - 1, day!).getDay()]}요일` };
}
/** Local calendar days from `today` to `date` (both `YYYY-MM-DD`). */
export function daysAfter(date: string, today: string) {
  const day = (value: string) => { const [y, m, d] = value.split("-").map(Number); return Date.UTC(y!, m! - 1, d!) / 86_400_000; };
  return Math.round(day(date) - day(today));
}
/** "토요일" for the title bar's date. */
export function weekdayLabel(now: Date) {
  return `${WEEKDAYS[now.getDay()]}요일`;
}

/* ---- 신간 · 나온 권 ---- */
export type ReleaseKind = "manga" | "game" | "movie";
export type ReleaseRow = { key: string; kind: ReleaseKind; name: string; caption: ReleaseCaption | { kind: "info"; text: string; date: null };
  collection?: CollectionSummary; title?: ReleaseWishlistItem };

/**
 * Manga with unread 신간 알림 (most notices first) and 관심 목록 games/movies with unread
 * events (released, date set or moved), newest event first.
 */
export function releaseRows(collections: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, wishlist: ReleaseWishlistItem[], today: string): ReleaseRow[] {
  const manga = collections
    .filter((work) => work.type === "manga" && Math.max(work.unreadReleaseCount, inbox.get(work.id)?.length ?? 0) > 0)
    .map((work) => ({ work, unread: Math.max(work.unreadReleaseCount, inbox.get(work.id)?.length ?? 0) }))
    .sort((a, b) => b.unread - a.unread || a.work.name.localeCompare(b.work.name, "ko"))
    .map(({ work }): ReleaseRow => ({
      key: `manga:${work.id}`, kind: "manga", name: work.name, collection: work,
      caption: releaseCaption(work, board.get(work.id), inbox.get(work.id) ?? [], today) ?? { kind: "new", text: "신간 알림", date: null },
    }));
  const year = Number(today.slice(0, 4));
  const titles = wishlist
    .filter((item) => item.unread.length > 0 && !item.muted)
    .map((item) => ({ item, latest: [...item.unread].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0]! }))
    .sort((a, b) => b.latest.detectedAt.localeCompare(a.latest.detectedAt))
    .map(({ item, latest }): ReleaseRow => ({
      key: `title:${item.id}`, kind: item.kind, name: item.title, title: item,
      caption: latest.kind === "released" ? { kind: "new", text: "발매됨 · 관심 목록", date: latest.currentValue && /^\d{4}-\d{2}-\d{2}$/.test(latest.currentValue) ? shortReleaseDate(latest.currentValue, today) : null }
        : { kind: "info", text: releaseEventLine(latest, year), date: null },
    }));
  return [...manga, ...titles];
}

/** Watched manga (신간 알림 on) for the calm line. */
export function watchedMangaCount(board: Map<string, ReleaseBoardEntry>) {
  let count = 0;
  for (const entry of board.values()) if (entry.releaseWatch.enabled) count += 1;
  return count;
}

/* ---- 발매 예정 · 나올 권 ---- */
export type UpcomingRow = { key: string; kind: ReleaseKind; date: string; name: string; detail: string; watch: boolean; collectionId?: string };
export const UPCOMING_DAYS = 30;

/**
 * Dated upcoming releases, soonest first: the Korean volumes of watched manga beyond the owned
 * count (the 신간 view's 한국 정발 rows) and 관심 목록 games/movies with an exact date.
 */
export function upcomingRows(collections: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, wishlist: ReleaseWishlistItem[], today: string): UpcomingRow[] {
  const manga = koreanReleases(collections.filter((work) => work.type === "manga"), board, inbox, today).flatMap((row) => row.volumes
    .filter((volume): volume is typeof volume & { date: string } => volume.upcoming && !!volume.date && volume.date >= today)
    .map((volume): UpcomingRow => ({ key: `manga:${row.work.id}:${volume.volumeNumber}`, kind: "manga", date: volume.date, name: row.work.name, detail: `${volume.volumeNumber}권`, watch: false, collectionId: row.work.id })));
  const titles = wishlist
    .filter((item) => !item.released && item.precision === "exact" && item.date && item.date >= today)
    .map((item): UpcomingRow => {
      const moved = item.unread.some((event) => event.kind === "date_changed");
      const where = item.kind === "game" ? item.platforms.slice(0, 3).join(" · ") : "극장 개봉";
      return { key: `title:${item.id}`, kind: item.kind, date: item.date!, name: item.title, detail: [where, moved ? "날짜 바뀜" : ""].filter(Boolean).join(" · "), watch: true };
    });
  return [...manga, ...titles].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "ko") || a.key.localeCompare(b.key));
}

/* ---- 전송 ---- */
const ACTIVE_OUTGOING = new Set(["queued", "zipping", "hashing", "uploading", "waiting", "interrupted"]);
export type SendingSummary = { name: string; more: number; peer: string | null; progress: number | null };
/** Outgoing transfers still under way, as one line: the first file, how many more, overall progress. */
export function sendingSummary(snapshot: ExchangeSnapshot): SendingSummary | null {
  const rows = snapshot.outgoing.filter((row) => ACTIVE_OUTGOING.has(row.state));
  if (!rows.length) return null;
  const size = rows.reduce((sum, row) => sum + Math.max(0, row.sizeBytes), 0);
  const done = rows.reduce((sum, row) => sum + Math.max(0, Math.min(row.done, row.sizeBytes)), 0);
  return { name: rows[0]!.fileName, more: rows.length - 1, peer: rows[0]!.toName, progress: size > 0 ? done / size : null };
}
/** The device received files came from most recently. */
export function receivedFrom(snapshot: ExchangeSnapshot) {
  return [...snapshot.received].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0]?.fromName ?? null;
}

/* ---- 메모 ---- */
export type MemoRow =
  | { id: string; title: string; color: string | null; kind: "checklist"; done: number; total: number }
  | { id: string; title: string; color: string | null; kind: "ledger"; month: number; label: "쓸 수 있는 돈" | "쓴 돈"; amount: number }
  | { id: string; title: string; color: string | null; kind: "secret" }
  | { id: string; title: string; color: string | null; kind: "text"; snippet: string };
/** Pinned notes, most recently edited first, one line each (the tablet Home's rule); ledger month notes never show. */
export function memoRows(notes: Note[], today: string): MemoRow[] {
  return notes.filter((note) => note.pinned && !note.deleted && !note.archived && note.type !== LEDGER_MONTH)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((note): MemoRow => {
      const base = { id: note.id, title: note.title.trim(), color: noteColorValue(note.color) };
      if (note.type === "secret") return { ...base, kind: "secret" };
      if (note.type === LEDGER) {
        const summary = monthSummary(note, monthNotesOf(notes, note.id), today.slice(0, 7), today);
        return { ...base, title: base.title || "가계부", kind: "ledger", month: Number(today.slice(5, 7)),
          ...(summary.available !== null ? { label: "쓸 수 있는 돈" as const, amount: summary.available } : { label: "쓴 돈" as const, amount: summary.spent }) };
      }
      if (note.type === "checklist" && !note.readOnly) {
        const items = [...(note.items ?? [])].sort(byOrder);
        return { ...base, kind: "checklist", done: items.filter((item) => item.checked).length, total: items.length };
      }
      return { ...base, kind: "text", snippet: note.body.split("\n").map(stripMarkdown).map((line) => line.trim()).filter(Boolean).join(" ").slice(0, 160) };
    });
}

/* ---- 연결 ---- */
const UNREACHABLE = new Set(["network", "timeout", "server"]);
/**
 * The server is unreachable when the last server-sync attempt (authority pass or asset lane)
 * or a cloud transfer failed for a network reason; `since` is the earliest such failure.
 */
export function serverOutage(health: AuthoritySyncHealth | null, cloud: CloudBackfillProgress | null): { since: string | null } | null {
  const times: string[] = [];
  for (const failure of [health?.authorityPassFailure, health?.assetLaneFailure]) if (failure && UNREACHABLE.has(failure.code)) times.push(failure.at);
  for (const activity of cloud?.activity ?? []) {
    if (activity.lastReason && UNREACHABLE.has(activity.lastReason) && activity.lastError) times.push(activity.lastAttemptAt ?? "");
  }
  if (!times.length) return null;
  const known = times.filter(Boolean).sort();
  return { since: known[0] ?? null };
}

export type CloudLine = { tone: "ok" | "busy" | "idle" | "off"; text: string };
/** The cloud replication state in the status panel's words. */
export function cloudLine(progress: CloudBackfillProgress | null, problemCount: number): CloudLine | null {
  if (problemCount > 0) return { tone: "off", text: `문제 ${problemCount.toLocaleString()}개` };
  if (!progress) return null;
  const remaining = progress.queued + progress.preparing + progress.uploading + progress.committing;
  if (progress.replicationEnabled === false) return { tone: "idle", text: "동기화 꺼짐" };
  if (progress.controlState === "paused") return { tone: "idle", text: remaining > 0 ? `일시 정지 · ${remaining.toLocaleString()}개 대기` : "일시 정지" };
  if (remaining > 0) return { tone: "busy", text: `올리는 중 · ${remaining.toLocaleString()}개 남음` };
  return { tone: "ok", text: "동기화됨" };
}

/** "방금", "12분 전", "3시간 전", else "9.24 14:02". */
export function agoLabel(at: string, now: Date) {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  const date = new Date(at);
  return `${date.getMonth() + 1}.${date.getDate()} ${clockLabel(date)}`;
}
