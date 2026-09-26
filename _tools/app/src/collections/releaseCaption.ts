import type { CollectionSummary, ReleaseInboxItem } from "../library/types";

/** The grid card's 신간 line, shown under the title in place of the release date. */
export type ReleaseCaption = { kind: "new" | "ahead"; text: string; date: string | null };

export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const validDate = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** A short caption date: `9.24` this year, `2027.1.5` otherwise. */
export function shortReleaseDate(date: string, today: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${String(year) === today.slice(0, 4) ? "" : `${year}.`}${month}.${day}`;
}

/** Unread 신간 알림 grouped by work, as loaded for the Collection browser's inbox entry. */
export function groupInbox(items: ReleaseInboxItem[]): Map<string, ReleaseInboxItem[]> {
  const byWork = new Map<string, ReleaseInboxItem[]>();
  for (const item of items) byWork.set(item.collectionId, [...(byWork.get(item.collectionId) ?? []), item]);
  return byWork;
}

/**
 * "신간 13권 · 9.24" while the work has unread new Korean volumes (Kakao/Aladin events) already out,
 * naming the range and the latest known date; "9권 예약 · 11.20" when its only unread new volumes are
 * dated in the future (the soonest one). Other unread notices (MangaDex volumes, date or status
 * changes, or no inbox data) read "신간 알림 N". Nothing without unread notices: the PC grid does not
 * load per-work volume schedules, so acknowledged pre-registered volumes are not shown.
 */
export function releaseCaption(collection: CollectionSummary, items: ReleaseInboxItem[], today: string): ReleaseCaption | null {
  const unread = Math.max(collection.unreadReleaseCount, items.length);
  if (unread <= 0) return null;
  const volumes = items
    .filter((item) => item.provider !== "mangadex" && item.event.kind === "new_volume" && Number.isInteger(item.event.volumeNumber))
    .map((item) => ({ number: item.event.volumeNumber, date: validDate(item.event.currentValue) }));
  const out = volumes.filter((volume) => !volume.date || volume.date <= today);
  if (out.length) {
    const numbers = out.map((volume) => volume.number);
    const low = Math.min(...numbers), high = Math.max(...numbers);
    const latest = out.map((volume) => volume.date).filter((date): date is string => !!date).sort().reverse()[0];
    return { kind: "new", text: `신간 ${low === high ? low : `${low}–${high}`}권`, date: latest ? shortReleaseDate(latest, today) : null };
  }
  const soonest = volumes.filter((volume) => volume.date).sort((a, b) => a.date!.localeCompare(b.date!) || a.number - b.number)[0];
  if (soonest) return { kind: "ahead", text: `${soonest.number}권 예약`, date: shortReleaseDate(soonest.date!, today) };
  return { kind: "new", text: `신간 알림 ${unread}`, date: null };
}
