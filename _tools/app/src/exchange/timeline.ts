/**
 * The 전송 timeline shared by the PC and the tablet: everything sent to and received from one
 * device, stacked by time. Each client normalizes its own snapshot rows into entries; this
 * module only groups, orders and labels them (no protocol knowledge).
 */
export type TimelineEntry<T> = {
  row: T;
  transferId: string;
  /** Files sent together share it; a lone file uses its own transfer id. */
  batchId: string;
  mine: boolean;
  /** ISO time the entry sorts by; empty sorts last (just queued). */
  at: string;
};

export type TimelineBlock<T> = { key: string; mine: boolean; at: string; entries: TimelineEntry<T>[] };

const time = (at: string) => {
  const value = Date.parse(at);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
};

/** Blocks oldest first (the newest sits next to the send bar), files of a block in send order. */
export function buildTimeline<T>(entries: TimelineEntry<T>[]): TimelineBlock<T>[] {
  const blocks = new Map<string, TimelineBlock<T>>();
  for (const entry of entries) {
    const key = `${entry.mine ? "out" : "in"}:${entry.batchId || entry.transferId}`;
    const block = blocks.get(key);
    if (block) block.entries.push(entry);
    else blocks.set(key, { key, mine: entry.mine, at: entry.at, entries: [entry] });
  }
  const list = [...blocks.values()];
  for (const block of list) {
    block.entries.sort((a, b) => time(a.at) - time(b.at));
    block.at = block.entries.find((entry) => entry.at)?.at ?? "";
  }
  return list.sort((a, b) => time(a.at) - time(b.at) || a.key.localeCompare(b.key));
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** Local calendar day of an ISO time, for day separators ("" when unknown). */
export function dayKey(at: string): string {
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? "" : `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

/** "9. 26" and "오늘" / "어제" / a weekday. */
export function dayLabel(at: string, now = new Date()): { date: string; note: string } {
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return { date: "", note: "" };
  const start = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((start(now) - start(value)) / 86_400_000);
  const date = value.getFullYear() === now.getFullYear() ? `${value.getMonth() + 1}. ${value.getDate()}` : `${value.getFullYear()}. ${value.getMonth() + 1}. ${value.getDate()}`;
  return { date, note: days === 0 ? "오늘" : days === 1 ? "어제" : WEEKDAYS[value.getDay()] };
}

/** "14:02" in local time. */
export function clockLabel(at: string): string {
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? "" : `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

/** Whether a name reads with a final consonant, for 과/와 and 은/는 after device names. */
function hasFinalConsonant(name: string): boolean {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return /[013678]/.test(last); // 영 일 삼 육 칠 팔
  return /[lmnr]/i.test(last);
}

/** "Galaxy Tab S11과", "DESKTOP와". */
export function withParticle(name: string, consonant: string, vowel: string): string {
  return `${name}${hasFinalConsonant(name) ? consonant : vowel}`;
}

const IMAGE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
export const isImageName = (name: string) => IMAGE.test(name);

/** "PSD", "ZIP": the file-type glyph text. */
export function extensionLabel(name: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match ? match[1].toUpperCase() : "FILE";
}

/** One file's part of a batch: bytes that count as done, its size, and whether it is finished. */
export type BatchPart = { size: number; done: number; finished: boolean };

/** Combined progress of a batch (computed here; neither snapshot carries it). */
export function batchProgress(parts: BatchPart[]) {
  const size = parts.reduce((sum, part) => sum + Math.max(0, part.size), 0);
  const done = parts.reduce((sum, part) => sum + Math.max(0, Math.min(part.size, part.done)), 0);
  return {
    size,
    done,
    finished: parts.filter((part) => part.finished).length,
    total: parts.length,
    percent: size > 0 ? Math.min(100, Math.floor((done / size) * 100)) : 0,
  };
}
