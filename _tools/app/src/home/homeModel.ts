import type { AuthoritySyncHealth, CloudBackfillProgress, CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem, ReleaseTitle, ReleaseWishlistItem } from "../library/types";
import { koreanReleases, releaseCaption, shortReleaseDate, type ReleaseCaption } from "../collections/releaseCaption";
import { releaseEventLine } from "../collections/releaseCalendarFormat";

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
  collection?: CollectionSummary; title?: ReleaseTitle; date?: string | null; volume?: number | null; watch?: boolean };

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

/* ---- 발매 예정 · 나올 권 ---- */
export type UpcomingRow = { key: string; kind: ReleaseKind; date: string; name: string; detail: string; watch: boolean; volume?: number; collectionId?: string; platforms?: string[]; moved?: boolean };
export const UPCOMING_DAYS = 14;

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

/** Existing NEW notices plus dated releases already available to this device. */
export function newlyReleasedRows(collections: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, wishlist: ReleaseWishlistItem[], today: string, calendar: ReleaseTitle[] = []): ReleaseRow[] {
  const rows = new Map(releaseRows(collections, board, inbox, wishlist, today).map(row => [row.key, row]));
  for (const release of koreanReleases(collections.filter(c => c.type === 'manga'), board, inbox, today)) {
    const volume = release.volumes.filter(v => v.released && v.date && v.date <= today).sort((a, b) => b.date!.localeCompare(a.date!) || b.volumeNumber - a.volumeNumber)[0];
    const key = `manga:${release.work.id}`;
    if (volume && !rows.has(key)) rows.set(key, { key, kind: 'manga', name: release.work.name, collection: release.work, date: volume.date, volume: volume.volumeNumber, caption: { kind: 'info', text: `${volume.volumeNumber}권`, date: null } });
  }
  const muted = new Set(wishlist.filter(title => title.muted).map(title => title.id));
  for (const title of [...wishlist, ...calendar]) {
    const key = `title:${title.id}`;
    if (!muted.has(title.id) && title.precision === 'exact' && title.date && title.date <= today && !rows.has(key)) rows.set(key, { key, kind: title.kind, name: title.title, title, date: title.date, caption: { kind: 'info', text: '발매됨', date: null } });
  }
  for (const collection of collections) {
    const key = `work:${collection.id}`;
    if (collection.type !== 'av' && collection.type !== 'manga' && collection.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(collection.releaseDate) && collection.releaseDate <= today && ![...rows.values()].some(row => row.collection?.id === collection.id || (row.name === collection.name && row.date === collection.releaseDate))) rows.set(key, { key, kind: collection.type, name: collection.name, collection, date: collection.releaseDate, caption: { kind: 'info', text: '발매됨', date: null } });
  }
  return [...rows.values()];
}
