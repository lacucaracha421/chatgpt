type DisplayDate = string | number | Date | null | undefined;

export type DisplayDateTimeOptions = {
  withTime?: boolean;
};

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
      if (!day) return `${year}.${Number(month)}`;
      if (!parseCalendarDate(year, month, day)) return null;
      return `${Number(year) === now.getFullYear() ? "" : `${year}.`}${Number(month)}.${Number(day)}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
    const calendarPart = value.slice(0, 10);
    if (!parseCalendarDate(calendarPart.slice(0, 4), calendarPart.slice(5, 7), calendarPart.slice(8, 10))) return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return formatLocalDate(date, now);
}

function formatLocalDate(date: Date, now: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year === now.getFullYear() ? "" : `${year}.`}${month}.${day}`;
}

function parseCalendarDate(yearText: string, monthText?: string, dayText?: string): Date | null {
  const year = Number(yearText);
  const month = monthText ? Number(monthText) : 1;
  const day = dayText ? Number(dayText) : 1;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

type ParsedDisplayValue = {
  date: Date;
  hasTime: boolean;
};

function parseDisplayValue(value: DisplayDate): ParsedDisplayValue | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const calendar = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
    if (calendar) {
      const [, year, month, day] = calendar;
      const date = parseCalendarDate(year, month, day);
      return date ? { date, hasTime: false } : null;
    }
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
    const calendarPart = value.slice(0, 10);
    if (!parseCalendarDate(calendarPart.slice(0, 4), calendarPart.slice(5, 7), calendarPart.slice(8, 10))) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? { date, hasTime: true } : null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? { date, hasTime: true } : null;
}

export function displayTime(value: DisplayDate, _now = new Date()): string {
  const parsed = parseDisplayValue(value);
  if (!parsed) return "";
  return `${String(parsed.date.getHours()).padStart(2, "0")}:${String(parsed.date.getMinutes()).padStart(2, "0")}`;
}

export function displayDateTime(value: DisplayDate, now = new Date(), options: DisplayDateTimeOptions = {}): string {
  const parsed = parseDisplayValue(value);
  if (!parsed) return value == null || value === "" ? "" : String(value);
  const dateLabel = displayDate(value, now);
  if (!parsed.hasTime) return dateLabel;

  const time = displayTime(parsed.date);
  const dayDifference = localDayNumber(parsed.date) - localDayNumber(now);
  if (dayDifference === 0) return time;
  if (dayDifference === -1) return `어제 ${time}`;
  return options.withTime ? `${dateLabel} ${time}` : dateLabel;
}

export function displayDDay(value: DisplayDate, now = new Date()): string | null {
  const parsed = parseDisplayValue(value);
  if (!parsed) return null;
  const difference = localDayNumber(parsed.date) - localDayNumber(now);
  if (difference === 0) return "D-DAY";
  return difference > 0 ? `D-${difference}` : null;
}

export function displayCount(value: number, unit = ""): string {
  return `${new Intl.NumberFormat("ko-KR").format(value)}${unit}`;
}

function localDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function displayDateRange(start: DisplayDate, end: DisplayDate, now = new Date()): string {
  const first = displayDate(start, now);
  const last = displayDate(end, now);
  return first === last ? first : `${first}–${last}`;
}
