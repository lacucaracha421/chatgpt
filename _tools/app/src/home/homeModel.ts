import type { AuthoritySyncHealth, CloudBackfillProgress, CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem, ReleaseWishlistItem } from "../library/types";
import { koreanReleases, releaseCaption, shortReleaseDate, type ReleaseCaption } from "../collections/releaseCaption";
import { releaseEventLine } from "../collections/releaseCalendarFormat";
import { checklistMarkdown, noteColorValue } from "../notes/model";
import { memoItems, memoMode, memoPreview, parseMemo } from "../notes/memo/memoModel";
import type { Note } from "../notes/store";
import type { AvPerformerProfile } from "../collections/avTypes";
import { LEDGER, LEDGER_MONTH } from "../notes/ledger/model";
import { monthNotesOf, monthSummary } from "../notes/ledger/summary";

/**
 * PC Home (HOME-DASH-001, layout D): pure shaping of data other screens
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
export type ReleaseKind = "manga" | "game" | "movie" | "anime";
export type ReleaseRow = { key: string; kind: ReleaseKind; name: string; caption: ReleaseCaption | { kind: "info"; text: string; date: null };
  collection?: CollectionSummary; title?: ReleaseWishlistItem; date?: string | null; volume?: number | null; watch?: boolean };

/**
 * Released unread manga notices (most notices first) and released 관심 목록 items, newest event first.
 */
export function releaseRows(collections: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, wishlist: ReleaseWishlistItem[], today: string): ReleaseRow[] {
  const mangaSchedules = new Map(koreanReleases(collections.filter((work) => work.type === "manga"), board, inbox, today).map((row) => [row.work.id, row]));
  const manga = collections
    .filter((work) => work.type === "manga" && Math.max(work.unreadReleaseCount, inbox.get(work.id)?.length ?? 0) > 0)
    .map((work) => ({ work, unread: Math.max(work.unreadReleaseCount, inbox.get(work.id)?.length ?? 0) }))
    .sort((a, b) => b.unread - a.unread || a.work.name.localeCompare(b.work.name, "ko"))
    .map(({ work }): ReleaseRow => {
      const events = inbox.get(work.id) ?? [];
      const scheduled = mangaSchedules.get(work.id)?.volumes.filter((volume) => volume.released && volume.date)
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.volumeNumber - a.volumeNumber)[0];
      const event = events.filter((item) => item.provider !== "mangadex" && item.event.currentValue && /^\d{4}-\d{2}-\d{2}/.test(item.event.currentValue))
        .sort((a, b) => (b.event.currentValue ?? "").localeCompare(a.event.currentValue ?? ""))[0];
      return {
        key: `manga:${work.id}`, kind: "manga", name: work.name, collection: work, watch: false,
        date: scheduled?.date ?? event?.event.currentValue?.slice(0, 10) ?? null, volume: scheduled?.volumeNumber ?? event?.event.volumeNumber ?? null,
        caption: releaseCaption(work, board.get(work.id), events, today) ?? { kind: "new", text: "신간 알림", date: null },
      };
    });
  const year = Number(today.slice(0, 4));
  const titles = wishlist
    .filter((item) => item.unread.length > 0 && !item.muted && (item.released || item.unread.some((event) => event.kind === "released")))
    .map((item) => ({ item, latest: [...item.unread].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0]! }))
    .sort((a, b) => b.latest.detectedAt.localeCompare(a.latest.detectedAt))
    .map(({ item, latest }): ReleaseRow => ({
      key: `title:${item.id}`, kind: item.kind, name: item.title, title: item,
      date: latest.currentValue && /^\d{4}-\d{2}-\d{2}/.test(latest.currentValue) ? latest.currentValue.slice(0, 10) : null, watch: true,
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
export type UpcomingRow = { key: string; kind: ReleaseKind; date: string; name: string; detail: string; watch: boolean; volume?: number; collectionId?: string; platforms?: string[]; moved?: boolean };
export const UPCOMING_DAYS = 60;

/**
 * Dated upcoming releases, soonest first: the Korean volumes of watched manga beyond the owned
 * count (the 신간 view's 한국 정발 rows) and 관심 목록 games/movies with an exact date.
 */
export function upcomingRows(collections: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, wishlist: ReleaseWishlistItem[], today: string): UpcomingRow[] {
  const manga = koreanReleases(collections.filter((work) => work.type === "manga"), board, inbox, today).flatMap((row) => row.volumes
    .filter((volume): volume is typeof volume & { date: string } => volume.upcoming && !!volume.date && volume.date >= today)
    .map((volume): UpcomingRow => ({ key: `manga:${row.work.id}:${volume.volumeNumber}`, kind: "manga", date: volume.date, name: row.work.name, detail: `${volume.volumeNumber}권`, watch: false, volume: volume.volumeNumber, collectionId: row.work.id })));
  const titles = wishlist
    .filter((item) => !item.released && item.precision === "exact" && item.date && item.date >= today)
    .map((item): UpcomingRow => {
      const moved = item.unread.some((event) => event.kind === "date_changed");
      // Movies and anime show only their kind chip on Home (user, 2026-09-28).
      const where = item.kind === "game" ? item.platforms.slice(0, 3).join(" · ") : "";
      return { key: `title:${item.id}`, kind: item.kind, date: item.date!, name: item.title, detail: [where, moved ? "날짜 바뀜" : ""].filter(Boolean).join(" · "), watch: true,
        platforms: item.kind === "game" ? item.platforms : undefined, moved };
    });
  return [...manga, ...titles].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "ko") || a.key.localeCompare(b.key));
}

/* ---- 이어지는 시리즈 ---- */
export type NextInSeriesRow<TWork = CollectionSummary> = {
  work: TWork;
  ownedCount: number;
  nextVolume: { number: number; date: string | null };
  releasedUnownedCount: number;
  fresh: boolean;
};

export type NextInSeriesSchedule = {
  editionIndex: number;
  volumes: readonly { volumeNumber: number; date: string | null; status: "upcoming" | "released" | null }[];
};

/** Released Korean volumes beyond a known owned count, unread first and then latest release. */
export function nextInSeriesRows<TWork extends { id: string; name: string }, TEvent>(
  works: readonly TWork[],
  ownedOf: (work: TWork, editionIndex: number) => number | null,
  scheduleOf: (work: TWork) => NextInSeriesSchedule | null,
  events: readonly TEvent[],
  eventWorkId: (event: TEvent) => string,
  today: string,
): NextInSeriesRow<TWork>[] {
  const freshWorks = new Set(events.map(eventWorkId));
  return works.flatMap((work) => {
      const schedule = scheduleOf(work);
      if (!schedule) return [];
      const owned = ownedOf(work, schedule.editionIndex);
      if (owned === null) return [];
      const seen = new Set<number>();
      const released = schedule.volumes
        .filter((volume) => Number.isInteger(volume.volumeNumber) && volume.volumeNumber > owned && !seen.has(volume.volumeNumber) && seen.add(volume.volumeNumber))
        .map((volume) => ({ ...volume, date: volume.date && /^\d{4}-\d{2}-\d{2}/.test(volume.date) ? volume.date.slice(0, 10) : null }))
        .filter((volume) => volume.status === "released" || Boolean(volume.date && volume.date <= today))
        .sort((a, b) => a.volumeNumber - b.volumeNumber);
      const next = released[0];
      if (!next) return [];
      return [{
        value: {
          work,
          ownedCount: owned,
          nextVolume: { number: next.volumeNumber, date: next.date },
          releasedUnownedCount: released.length,
          fresh: freshWorks.has(work.id),
        },
        latestReleaseDate: released.map((volume) => volume.date).filter((date): date is string => !!date).sort().reverse()[0] ?? "",
      }];
    })
    .sort((left, right) => Number(right.value.fresh) - Number(left.value.fresh)
      || right.latestReleaseDate.localeCompare(left.latestReleaseDate)
      || left.value.work.name.localeCompare(right.value.work.name, "ko")
      || left.value.work.id.localeCompare(right.value.work.id))
    .map((row) => row.value);
}

/* ---- 메모 ---- */
export type MemoRow =
  | { id: string; title: string; color: string | null; kind: "checklist"; done: number; total: number; items: { text: string; checked: boolean }[] }
  | { id: string; title: string; color: string | null; kind: "ledger"; month: number; amount: number; available: number | null; spent: number; scheduled: number; perDay: number | null;
    categories: { label: string; amount: number }[]; latest: { label: string; amount: number }[] }
  | { id: string; title: string; color: string | null; kind: "secret" }
  | { id: string; title: string; color: string | null; kind: "text"; snippet: string };
/** Pinned notes, most recently edited first; ledger month notes never show. Home renders the first two. */
export function memoRows(notes: Note[], today: string): MemoRow[] {
  return notes.filter((note) => note.pinned && !note.deleted && !note.archived && note.type !== LEDGER_MONTH)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((note): MemoRow => {
      const base = { id: note.id, title: note.title.trim(), color: noteColorValue(note.color) };
      if (note.type === "secret") return { ...base, kind: "secret" };
      if (note.concealed && note.type !== LEDGER) return { ...base, kind: "text", snippet: "숨긴 메모" };
      if (note.type === LEDGER) {
        const summary = monthSummary(note, monthNotesOf(notes, note.id), today.slice(0, 7), today);
        const entries = summary.entries.filter((entry) => !entry.in);
        const categoryMap = new Map<string, number>();
        for (const entry of entries) {
          const category = entry.category;
          const label = typeof category === "string" ? category.trim() : "";
          if (label) categoryMap.set(label, (categoryMap.get(label) ?? 0) + entry.amount);
        }
        const categories = [...categoryMap].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount).slice(0, 3);
        const latest = entries.slice(0, 3).map((entry) => ({ label: entry.name || "기록", amount: entry.amount }));
        return { ...base, title: base.title || "가계부", kind: "ledger", month: Number(today.slice(5, 7)),
          amount: summary.available ?? summary.spent, available: summary.available, spent: summary.spent, scheduled: summary.scheduled, perDay: summary.perDay,
          categories, latest };
      }
      const body = note.type === "checklist" ? checklistMarkdown(note.items ?? []) : note.body;
      if (note.type === "checklist" || memoMode(body) === "todo") {
        const items = memoItems(parseMemo(body)).filter(item => item.task).map(item => ({ text: item.text, checked: item.done })).sort((a,b) => Number(a.checked)-Number(b.checked));
        return { ...base, kind: "checklist", done: items.filter((item) => item.checked).length, total: items.length, items: items.slice(0, 5) };
      }
      return { ...base, kind: "text", snippet: memoPreview(body).split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean).join(" ").slice(0, 160) };
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

/** Pending S36 candidates of one character, split by verdict (`other`: neither tier). */
export type CharacterReviewTally = { targetId: string; targetName: string; automatic: number; recommended: number; other: number };
export type CharacterReviewCharacter = { targetId: string; name: string; count: number; automatic: number; recommended: number; thumbnailAssetId: string | null };
export type CharacterReviewGroup = { seriesId: string | null; seriesName: string; total: number; automatic: number; recommended: number; characters: CharacterReviewCharacter[] };
type ReviewTarget = { id: string; seriesClassificationId: string | null; displayName: string; thumbnailAssetId?: string | null; references?: readonly { assetId: string | null; status: string }[] };

/** Count candidate items per character (first-seen order). */
export function tallyCandidates(items: readonly { targetId: string; targetName: string; verdict?: string }[]): CharacterReviewTally[] {
  const tallies = new Map<string, CharacterReviewTally>();
  for (const item of items) {
    let tally = tallies.get(item.targetId);
    if (!tally) tallies.set(item.targetId, tally = { targetId: item.targetId, targetName: item.targetName, automatic: 0, recommended: 0, other: 0 });
    if (item.verdict === "automatic") tally.automatic += 1;
    else if (item.verdict === "recommended") tally.recommended += 1;
    else tally.other += 1;
  }
  return [...tallies.values()];
}

/**
 * 캐릭터 검토 split by series and character: per-character counts grouped under the character's
 * series (busiest first). A character without a known series lands in "기타".
 */
export function characterReviewGroups(
  tallies: readonly CharacterReviewTally[],
  targets: readonly ReviewTarget[],
  seriesName: (id: string) => string | undefined,
): CharacterReviewGroup[] {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const groups = new Map<string, CharacterReviewGroup>();
  for (const tally of tallies) {
    const count = tally.automatic + tally.recommended + tally.other;
    if (count === 0) continue;
    const target = byId.get(tally.targetId);
    const seriesId = target?.seriesClassificationId ?? null;
    const key = seriesId ?? "";
    let group = groups.get(key);
    if (!group) groups.set(key, group = { seriesId, seriesName: (seriesId && seriesName(seriesId)) || "기타", total: 0, automatic: 0, recommended: 0, characters: [] });
    group.total += count;
    group.automatic += tally.automatic;
    group.recommended += tally.recommended;
    group.characters.push({ targetId: tally.targetId, name: tally.targetName, count, automatic: tally.automatic, recommended: tally.recommended,
      thumbnailAssetId: target?.thumbnailAssetId ?? target?.references?.find((ref) => ref.status === "ready" && ref.assetId)?.assetId ?? null });
  }
  const result = [...groups.values()];
  for (const group of result) group.characters.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
  // "기타" last; otherwise busiest first.
  return result.sort((a, b) => Number(a.seriesId === null) - Number(b.seriesId === null) || b.total - a.total || a.seriesName.localeCompare(b.seriesName, "ko"));
}

/** Home's short performer profile: "1998.3.2 · 28세", "158cm · B83 W57 H85", "2019– · 8년차". */
export function avProfileLines(profile: Pick<AvPerformerProfile, "birthDate" | "heightCm" | "bandIn" | "waistIn" | "hipIn" | "cup" | "careerStart" | "careerEnd">, today: Date): string[] {
  const lines: string[] = [];
  const birth = profile.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(profile.birthDate) ? profile.birthDate.split("-").map(Number) : null;
  if (birth) {
    const [year, month, day] = birth as [number, number, number];
    const age = today.getFullYear() - year - (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day) ? 1 : 0);
    lines.push(`${year}.${month}.${day}${age >= 0 ? ` · ${age}세` : ""}`);
  }
  const cm = (inches: number | null) => inches ? Math.round(inches * 2.54) : null;
  const size = [cm(profile.bandIn) && `B${cm(profile.bandIn)}${profile.cup ? `(${profile.cup})` : ""}`, cm(profile.waistIn) && `W${cm(profile.waistIn)}`, cm(profile.hipIn) && `H${cm(profile.hipIn)}`].filter(Boolean).join(" ");
  const body = [profile.heightCm ? `${profile.heightCm}cm` : null, size || null].filter(Boolean).join(" · ");
  if (body) lines.push(body);
  if (profile.careerStart !== null) lines.push(profile.careerEnd !== null ? `${profile.careerStart}–${profile.careerEnd} · 은퇴` : `${profile.careerStart}– · ${Math.max(1, today.getFullYear() - profile.careerStart)}년차`);
  return lines;
}
