import type { ReleaseDatePrecision, ReleaseTitle, ReleaseWishlistEvent } from "../library/types";
import { displayDate, localDay } from "../shared/displayDate";

/**
 * Precision-aware wording for the 발매 캘린더: "10월 22일", "10월 중", "2027 Q1", "2027년 중",
 * "미정". The year is added when it differs from `referenceYear`.
 */
export function releaseDateLabel(date: string | null, precision: ReleaseDatePrecision, referenceYear = new Date().getFullYear()): string {
  const parts = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!parts || precision === "tbd") return "미정";
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const prefix = year === referenceYear ? "" : `${year}년 `;
  switch (precision) {
    // The shared date: 9.12, or 2027.1.5 outside the reference year.
    case "exact": return displayDate(date!, new Date(referenceYear, 0, 1));
    case "month": return `${prefix}${month}월 중`;
    case "quarter": return `${year} Q${Math.floor((month - 1) / 3) + 1}`;
    case "year": return `${year}년 중`;
  }
}

/** A month section heading drops the reference year: "2026년 10월" → "10월" (PC and tablet). */
export function releaseGroupHeading(label: string, referenceYear = new Date().getFullYear()): string {
  const month = /^(\d{4})년 (\d{1,2})월$/.exec(label);
  return month && Number(month[1]) === referenceYear ? `${month[2]}월` : label;
}

/** The wording of an event value (`2026-10-15`, `2026-10`, `2026-Q4`, `2026` or `tbd`). */
export function releaseTokenLabel(token: string | null, referenceYear = new Date().getFullYear()): string {
  if (!token || token === "tbd") return "미정";
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (match) return releaseDateLabel(token, "exact", referenceYear);
  match = /^(\d{4})-(\d{2})$/.exec(token);
  if (match) return releaseDateLabel(`${token}-01`, "month", referenceYear);
  match = /^(\d{4})-Q([1-4])$/.exec(token);
  if (match) return `${match[1]} Q${match[2]}`;
  if (/^\d{4}$/.test(token)) return `${token}년 중`;
  return token;
}

export function releaseEventLine<T extends Pick<ReleaseWishlistEvent, "kind" | "previousValue" | "currentValue">>(event: T, referenceYear = new Date().getFullYear()): string {
  const current = releaseTokenLabel(event.currentValue, referenceYear);
  switch (event.kind) {
    case "date_set": return `발매일 공개 · ${current}`;
    case "date_changed": return `발매일 변경 · ${releaseTokenLabel(event.previousValue, referenceYear)} → ${current}`;
    case "released": return `발매됨 · ${current}`;
  }
}

export type ReleaseGroup<T> = { key: string; label: string; items: T[] };

/** Use calendar arithmetic on the viewer's local date, including across DST changes. */
export function releaseCalendarStart(now = new Date()): string {
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return localDay(start);
}

/** Imprecise dates remain while their stated period overlaps the calendar window. */
export function isVisibleCalendarRelease(item: Pick<ReleaseTitle, "date" | "precision">, now = new Date()): boolean {
  if (!item.date || item.precision === "tbd") return true;
  const start = releaseCalendarStart(now);
  if (item.precision === "exact") return item.date >= start;
  const [year, month] = item.date.split("-").map(Number);
  const until = item.precision === "month" ? new Date(year, month, 1)
    : item.precision === "quarter" ? new Date(year, Math.ceil(month / 3) * 3, 1)
    : new Date(year + 1, 0, 1);
  return localDay(until) > start;
}

/** One heading per date/precision, oldest first (the past week too, user 2026-10-06). */
export function groupReleaseDays<T extends Pick<ReleaseTitle, "date" | "precision">>(items: T[], newestFirst = false): T[][] {
  const days = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.date ?? "9999-99-99"}|${item.precision}`;
    const day = days.get(key) ?? [];
    day.push(item);
    days.set(key, day);
  }
  return [...days.entries()].sort(([a], [b]) => newestFirst ? b.localeCompare(a) : a.localeCompare(b)).map(([, day]) => day);
}

/**
 * The past week first, then month sections; a quarter or year that is not narrowed further
 * gets its own section after the last month it covers; TBD last.
 */
export function groupReleases<T extends Pick<ReleaseTitle, "date" | "precision">>(items: T[], now = new Date()): Array<ReleaseGroup<T>> {
  const groups = new Map<string, { order: string; label: string; items: T[] }>();
  const today = localDay(now);
  for (const item of items) {
    if (!isVisibleCalendarRelease(item, now)) continue;
    const parts = item.date ? /^(\d{4})-(\d{2})/.exec(item.date) : null;
    let key = "tbd"; let order = "9999-99-z"; let label = "미정";
    if (item.precision === "exact" && item.date && item.date < today) {
      key = "recent"; order = "0000"; label = "지난 7일";
    } else if (parts && item.precision !== "tbd") {
      const year = parts[1]!; const month = Number(parts[2]);
      if (item.precision === "exact" || item.precision === "month") {
        key = `${year}-${parts[2]}`; order = `${key}-a`; label = `${year}년 ${month}월`;
      } else if (item.precision === "quarter") {
        const quarter = Math.floor((month - 1) / 3) + 1;
        key = `${year}-Q${quarter}`; order = `${year}-${String(quarter * 3).padStart(2, "0")}-b`; label = `${year} Q${quarter} · 월 미정`;
      } else {
        // Bare years sit after every dated month, just before 미정 (user, 2026-09-28).
        key = year; order = `9999-${year}`; label = `${year}년 · 시기 미정`;
      }
    }
    const group = groups.get(key) ?? { order, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([, a], [, b]) => a.order.localeCompare(b.order)).map(([key, group]) => ({ key, label: group.label, items: group.items }));
}

export const RELEASE_SOURCE_PROBLEM: Record<string, string> = {
  credential_not_configured: "연결 설정이 필요합니다.",
  invalid_credential: "인증 정보를 확인해 주세요.",
  rate_limited: "요청 한도에 도달했습니다. 잠시 뒤 다시 시도합니다.",
  timed_out: "응답 시간이 초과됐습니다.",
  unavailable: "서비스에 연결하지 못했습니다.",
  invalid_response: "응답을 읽지 못했습니다.",
};
