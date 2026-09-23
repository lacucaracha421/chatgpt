type DisplayDate = string | number | Date | null | undefined;

/** Calendar dates keep their precision; timestamps use the viewer's local date. */
export function displayDate(value: DisplayDate, now = new Date()): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const range = value.split(/\s*[~–]\s*/);
    if (range.length === 2) {
      const [start, end] = range.map(part => formatSingleDate(part, now));
      if (start === null || end === null) return value;
      return start === end ? start : `${start}–${end}`;
    }
  }
  return formatSingleDate(value, now) ?? String(value);
}

function formatSingleDate(value: string | number | Date, now: Date): string | null {
  if (typeof value === "string") {
    const calendar = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
    if (calendar) {
      const [, year, month, day] = calendar;
      if (!month) return year;
      if (Number(month) < 1 || Number(month) > 12) return null;
      // Keep the year for month-only dates so precision remains unambiguous.
      if (!day) return `${year}.${month}`;
      const parsed = new Date(`${value}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.getUTCDate() !== Number(day)) return null;
      return `${Number(year) === now.getFullYear() ? "" : `${year}.`}${month}.${day}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
    const calendarPart = value.slice(0, 10);
    const parsedCalendar = new Date(`${calendarPart}T00:00:00Z`);
    if (!Number.isFinite(parsedCalendar.getTime()) || parsedCalendar.toISOString().slice(0, 10) !== calendarPart) return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year === now.getFullYear() ? "" : `${year}.`}${month}.${day}`;
}

export function displayDateRange(start: DisplayDate, end: DisplayDate, now = new Date()): string {
  const first = displayDate(start, now);
  const last = displayDate(end, now);
  return first === last ? first : `${first}–${last}`;
}
