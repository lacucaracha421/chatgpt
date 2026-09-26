import type { CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";

/**
 * 신간 on the PC, as the tablet shows it (`mobile-client/collectionReleases.ts`): the grid tile's
 * marker after the year and stars, and the 신간 view's 한국 정발 / 일본 rows. The data is the
 * library's own — the release board (`list_release_board`: 신간 알림, owned counts, Kakao and
 * MangaDex volumes) and the unread inbox — so both surfaces agree with what the tablet reads.
 */

/** `new` = unread 신간 알림 (■, accent), `out` = released but unowned (muted), `ahead` = pre-registered (□). */
export type ReleaseCaption = { kind: "new" | "out" | "ahead"; text: string; date: string | null };

export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const validDate = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** A short caption date: `9.24` this year, `2027.1.5` otherwise. */
export function shortReleaseDate(date: string, today: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${String(year) === today.slice(0, 4) ? "" : `${year}.`}${month}.${day}`;
}

/** Unread 신간 알림 grouped by work. */
export function groupInbox(items: ReleaseInboxItem[]): Map<string, ReleaseInboxItem[]> {
  const byWork = new Map<string, ReleaseInboxItem[]>();
  for (const item of items) byWork.set(item.collectionId, [...(byWork.get(item.collectionId) ?? []), item]);
  return byWork;
}

const isMangaDex = (item: ReleaseInboxItem) => item.provider === "mangadex";

/** The owned count of the Kakao edition, or null when no count was recorded (then nothing is owned). */
export function kakaoOwned(entry: ReleaseBoardEntry | undefined): number | null {
  const kakao = entry?.releaseSchedule.kakao;
  if (!kakao) return null;
  return entry.ownedVolumes.find((owned) => owned.editionIndex === kakao.editionIndex)?.count ?? null;
}

export type KoreanVolume = { volumeNumber: number; date: string | null; upcoming: boolean; released: boolean; fresh: boolean };
export type KoreanRow = { work: CollectionSummary; owned: number | null; volumes: KoreanVolume[]; fresh: number };
export type JapanRow = { work: CollectionSummary; latest: number; ahead: number | null; aheadVolumes: { volumeNumber: number; fresh: boolean }[]; fresh: number };

/** One work's Kakao volumes beyond the owned count, in volume order, with unread ones marked. */
function unownedKorean(entry: ReleaseBoardEntry | undefined, events: ReleaseInboxItem[], today: string): KoreanVolume[] {
  const kakao = entry?.releaseSchedule.kakao;
  if (!kakao) return [];
  const owned = kakaoOwned(entry) ?? 0;
  const fresh = new Set(events.filter((item) => !isMangaDex(item)).map((item) => item.event.volumeNumber));
  const seen = new Set<number>();
  return kakao.volumes
    .filter((volume) => Number.isInteger(volume.volumeNumber) && volume.volumeNumber > owned && !seen.has(volume.volumeNumber) && seen.add(volume.volumeNumber))
    .map((volume) => {
      const date = validDate(volume.date);
      // `status` is as of the last Kakao check, so a known date decides against today.
      return { volumeNumber: volume.volumeNumber, date, upcoming: date ? date > today : volume.status === "upcoming", released: date ? date <= today : volume.status === "released", fresh: fresh.has(volume.volumeNumber) };
    })
    .sort((a, b) => a.volumeNumber - b.volumeNumber);
}

/** A Korean volume's line: "3권 · 9월 16일 발매됨", "4권 · 10월 10일 발매 예정", "5권 · 발매일 미정". */
export function koreanVolumeLine(volume: KoreanVolume, today: string): string {
  const head = `${volume.volumeNumber}권`;
  if (!volume.date) return volume.released ? `${head} · 발매됨` : `${head} · 발매일 미정`;
  const [year, month, day] = volume.date.split("-").map(Number);
  const when = `${year === Number(today.slice(0, 4)) ? "" : `${year}년 `}${month}월 ${day}일`;
  return `${head} · ${when} ${volume.upcoming ? "발매 예정" : "발매됨"}`;
}

/**
 * 한국 정발: every watched work whose Kakao edition has a volume beyond the owned count, with
 * those volumes. Works are ordered by the date that matters: the soonest upcoming volume first,
 * then the most recently released, then works without dates.
 */
export function koreanReleases(works: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, today: string): KoreanRow[] {
  const rows: (KoreanRow & { group: number; key: string })[] = [];
  for (const work of works) {
    const entry = board.get(work.id);
    if (!entry?.releaseWatch.enabled || !entry.releaseSchedule.kakao) continue;
    const events = inbox.get(work.id) ?? [];
    const volumes = unownedKorean(entry, events, today);
    if (!volumes.length) continue;
    const soonest = volumes.filter((volume) => volume.upcoming && volume.date).map((volume) => volume.date!).sort()[0];
    const latest = volumes.filter((volume) => volume.released && volume.date).map((volume) => volume.date!).sort().reverse()[0];
    rows.push({ work, owned: kakaoOwned(entry), volumes, fresh: events.length, group: soonest ? 0 : latest ? 1 : 2, key: soonest ?? latest ?? "" });
  }
  rows.sort((a, b) => a.group - b.group || (a.group === 0 ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)) || a.work.name.localeCompare(b.work.name, "ko"));
  return rows.map(({ group: _group, key: _key, ...row }) => row);
}

/**
 * 일본: every watched work with MangaDex data, its latest Japanese volume and how far it is ahead
 * of the Korean edition (and which volumes). Newly detected volumes (unread MangaDex events) are
 * marked; those works come first, then the furthest ahead.
 */
export function japanReleases(works: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>): JapanRow[] {
  const rows: JapanRow[] = [];
  for (const work of works) {
    const entry = board.get(work.id);
    const mangadex = entry?.releaseSchedule.mangadex;
    if (!entry?.releaseWatch.enabled || !mangadex) continue;
    const listed = mangadex.volumes.map((volume) => volume.volumeNumber).filter(Number.isFinite);
    const latest = mangadex.latestVolume ?? (listed.length ? Math.max(...listed) : null);
    if (latest == null) continue;
    const events = inbox.get(work.id) ?? [];
    const fresh = new Set(events.filter(isMangaDex).map((item) => item.event.volumeNumber));
    const kakaoVolumes = entry.releaseSchedule.kakao?.volumes ?? [];
    const korean = kakaoVolumes.length ? Math.max(0, ...kakaoVolumes.map((volume) => volume.volumeNumber)) : null;
    const ahead = korean != null && latest > korean ? latest - korean : null;
    const numbers = new Set<number>();
    if (ahead) for (let volume = korean! + 1; volume <= latest; volume++) numbers.add(volume);
    for (const volume of fresh) if (volume <= latest) numbers.add(volume);
    const aheadVolumes = [...numbers].sort((a, b) => a - b).map((volumeNumber) => ({ volumeNumber, fresh: fresh.has(volumeNumber) }));
    rows.push({ work, latest, ahead, aheadVolumes, fresh: events.length });
  }
  const news = (row: JapanRow) => Number(row.aheadVolumes.some((volume) => volume.fresh));
  return rows.sort((a, b) => news(b) - news(a) || (b.ahead ?? 0) - (a.ahead ?? 0) || a.work.name.localeCompare(b.work.name, "ko"));
}

/** One unread event as a line: "13권 새로 나옴 · 2026.10.3" or "13권 발매일 2026.10.1 → 2026.10.15". */
export function releaseLine(item: ReleaseInboxItem): string {
  const { event } = item;
  const date = (value: string | null) => { const valid = validDate(value); return valid ? valid.split("-").map(Number).join(".") : value ?? ""; };
  const volume = `${event.volumeNumber}권`;
  if (event.kind === "new_volume") return event.currentValue ? `${volume} 새로 나옴 · ${date(event.currentValue)}` : `${volume} 새로 나옴`;
  if (event.kind === "release_date_changed") return `${volume} 발매일 ${date(event.previousValue) || "미정"} → ${date(event.currentValue) || "미정"}`;
  const status = (value: string | null) => value === "upcoming" ? "출간 예정" : value === "released" ? "출간됨" : value ?? "미정";
  return `${volume} ${status(event.previousValue)} → ${status(event.currentValue)}`;
}

/**
 * The grid tile's 신간 marker, in priority:
 * - `new` (unread 신간 알림): "신간 13권 · 9.24", the unowned Korean volumes already out (only the
 *   newest when no owned count is recorded) and the latest of their dates. A notice the schedule
 *   cannot name (a MangaDex volume, a date change, a game or movie) reads "신간 알림 N".
 * - `out` (watched, nothing unread): the same wording for Korean volumes out but not owned.
 * - `ahead` (watched, nothing unread or out): "9권 예약 · 11.20", the soonest dated pre-registered volume.
 * Owned volumes are never announced. Without board data (an older gateway) the unread new-volume
 * events name what they can.
 */
export function releaseCaption(collection: CollectionSummary, entry: ReleaseBoardEntry | undefined, events: ReleaseInboxItem[], today: string): ReleaseCaption | null {
  const unread = Math.max(collection.unreadReleaseCount, events.length);
  if (collection.type !== "manga") return unread > 0 ? { kind: "new", text: `신간 알림 ${unread}`, date: null } : null;
  const watching = entry?.releaseWatch.enabled ?? false;
  if (unread <= 0 && !watching) return null;
  const owned = kakaoOwned(entry);
  const volumes = entry?.releaseSchedule.kakao
    ? unownedKorean(entry, events, today)
    : events.filter((item) => !isMangaDex(item) && item.event.kind === "new_volume" && Number.isInteger(item.event.volumeNumber))
      .map((item) => { const date = validDate(item.event.currentValue); return { volumeNumber: item.event.volumeNumber, date, upcoming: !!date && date > today, released: !date || date <= today, fresh: true }; })
      .sort((a, b) => a.volumeNumber - b.volumeNumber);
  const out = volumes.filter((volume) => volume.released);
  if (out.length) {
    const high = out[out.length - 1]!.volumeNumber;
    const low = entry?.releaseSchedule.kakao && owned == null ? high : out[0]!.volumeNumber;
    const latest = out.map((volume) => volume.date).filter((date): date is string => !!date).sort().reverse()[0];
    return { kind: unread > 0 ? "new" : "out", text: `신간 ${low === high ? low : `${low}–${high}`}권`, date: latest ? shortReleaseDate(latest, today) : null };
  }
  if (unread > 0) return { kind: "new", text: `신간 알림 ${unread}`, date: null };
  const soonest = volumes.filter((volume): volume is KoreanVolume & { date: string } => volume.upcoming && !!volume.date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.volumeNumber - b.volumeNumber)[0];
  return soonest ? { kind: "ahead", text: `${soonest.volumeNumber}권 예약`, date: shortReleaseDate(soonest.date, today) } : null;
}
