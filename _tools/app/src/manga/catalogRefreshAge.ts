const MINUTE = 60_000;

/** "방금 갱신" under a minute, "N분 전 갱신" within an hour, then hours and days; null when unknown. */
export function catalogRefreshAgeLabel(updatedAt: string | null, now: number): string | null {
  const time = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const minutes = Math.floor(Math.max(0, now - time) / MINUTE);
  if (minutes < 1) return "방금 갱신";
  if (minutes < 60) return `${minutes}분 전 갱신`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 전 갱신` : `${Math.floor(hours / 24)}일 전 갱신`;
}
