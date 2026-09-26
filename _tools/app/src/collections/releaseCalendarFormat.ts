import type { ReleaseDatePrecision, ReleaseTitle, ReleaseWishlistEvent } from "../library/types";

/**
 * Precision-aware wording for the 발매 캘린더: "10월 22일", "10월 중", "2027 Q1", "2027년 중",
 * "미정". The year is added when it differs from `referenceYear`.
 */
export function releaseDateLabel(date: string | null, precision: ReleaseDatePrecision, referenceYear = new Date().getFullYear()): string {
  const parts = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!parts || precision === "tbd") return "미정";
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const prefix = year === referenceYear ? "" : `${year}년 `;
  switch (precision) {
    case "exact": return `${prefix}${month}월 ${day}일`;
    case "month": return `${prefix}${month}월 중`;
    case "quarter": return `${year} Q${Math.floor((month - 1) / 3) + 1}`;
    case "year": return `${year}년 중`;
  }
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

export function releaseEventLine(event: ReleaseWishlistEvent, referenceYear = new Date().getFullYear()): string {
  const current = releaseTokenLabel(event.currentValue, referenceYear);
  switch (event.kind) {
    case "date_set": return `발매일 공개 · ${current}`;
    case "date_changed": return `발매일 변경 · ${releaseTokenLabel(event.previousValue, referenceYear)} → ${current}`;
    case "released": return `발매됨 · ${current}`;
  }
}

export type ReleaseGroup<T> = { key: string; label: string; items: T[] };

/**
 * Month sections for exact and month dates; a quarter or year that is not narrowed further
 * gets its own section after the last month it covers; TBD last.
 */
export function groupReleases<T extends Pick<ReleaseTitle, "date" | "precision">>(items: T[]): Array<ReleaseGroup<T>> {
  const groups = new Map<string, { order: string; label: string; items: T[] }>();
  for (const item of items) {
    const parts = item.date ? /^(\d{4})-(\d{2})/.exec(item.date) : null;
    let key = "tbd"; let order = "9999-99-z"; let label = "미정";
    if (parts && item.precision !== "tbd") {
      const year = parts[1]!; const month = Number(parts[2]);
      if (item.precision === "exact" || item.precision === "month") {
        key = `${year}-${parts[2]}`; order = `${key}-a`; label = `${year}년 ${month}월`;
      } else if (item.precision === "quarter") {
        const quarter = Math.floor((month - 1) / 3) + 1;
        key = `${year}-Q${quarter}`; order = `${year}-${String(quarter * 3).padStart(2, "0")}-b`; label = `${year} Q${quarter} · 월 미정`;
      } else {
        key = year; order = `${year}-12-c`; label = `${year}년 · 시기 미정`;
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
