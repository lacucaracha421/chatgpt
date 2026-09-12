export type UtcDateRange = {
  localDate: string;
  startUtc: string;
  endUtc: string;
};

export function toUtcDateRange(localDate: string): UtcDateRange {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("유효하지 않은 날짜입니다.");
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const start = new Date(year, month, day);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== day) {
    throw new Error("유효하지 않은 날짜입니다.");
  }
  return {
    localDate,
    startUtc: start.toISOString(),
    endUtc: new Date(year, month, day + 1).toISOString(),
  };
}
