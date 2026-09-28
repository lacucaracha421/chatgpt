export type ScrubberDateValue = string | number | Date | null | undefined;

export type ScrubberSort =
  | {kind: 'date'; values: readonly ScrubberDateValue[]}
  | {kind: 'name'; values: readonly (string | null | undefined)[]}
  | {kind: 'fallback'};

export type ScrubberTick = {position: number; label?: string; major: boolean; index: number};

export type ScrubberModel = {
  total: number;
  ticks: ScrubberTick[];
  labelAt(index: number): string | null;
};

const BASE_INITIAL: Record<string, string> = {ㄱ: 'ㄱ', ㄲ: 'ㄱ', ㄴ: 'ㄴ', ㄷ: 'ㄷ', ㄸ: 'ㄷ', ㄹ: 'ㄹ', ㅁ: 'ㅁ', ㅂ: 'ㅂ', ㅃ: 'ㅂ', ㅅ: 'ㅅ', ㅆ: 'ㅅ', ㅇ: 'ㅇ', ㅈ: 'ㅈ', ㅉ: 'ㅈ', ㅊ: 'ㅊ', ㅋ: 'ㅋ', ㅌ: 'ㅌ', ㅍ: 'ㅍ', ㅎ: 'ㅎ'};
const HANGUL_BASE = ['ㄱ', 'ㄱ', 'ㄴ', 'ㄷ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅂ', 'ㅅ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

function positionOf(index: number, total: number) {
  return total <= 1 ? 0 : Math.max(0, Math.min(1, index / (total - 1)));
}

function clampIndex(index: number, total: number) {
  return total <= 0 ? 0 : Math.max(0, Math.min(total - 1, Math.round(index)));
}

export function scrubberIndexAt(ratio: number, total: number) {
  const value = Math.max(0, Math.min(1, ratio));
  return clampIndex(value * Math.max(0, total - 1), total);
}

export function scrubberRatioAt(index: number, total: number) {
  return positionOf(clampIndex(index, total), total);
}

function dateParts(value: ScrubberDateValue): {year: number; month: number} | null {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{1,2})/.exec(value.trim());
    if (match) return {year: Number(match[1]), month: Number(match[2])};
  }
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(Math.abs(value) < 100_000_000_000 ? value * 1000 : value) : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return {year: date.getFullYear(), month: date.getMonth() + 1};
}

export function koreanInitial(value: string | null | undefined): string {
  const first = Array.from(value?.trim() ?? '')[0] ?? '';
  if (!first) return '#';
  const code = first.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return HANGUL_BASE[Math.floor((code - 0xac00) / 588)] ?? '#';
  if (BASE_INITIAL[first]) return BASE_INITIAL[first];
  const latin = first.toLocaleUpperCase('en-US');
  return /^[A-Z]$/.test(latin) ? latin : '#';
}

function dateTicks(values: readonly ScrubberDateValue[], total: number): ScrubberTick[] {
  const ticks: ScrubberTick[] = [];
  const years = new Set<number>();
  const months = new Set<string>();
  values.forEach((value, index) => {
    const parts = dateParts(value);
    if (!parts) return;
    const monthKey = `${parts.year}-${parts.month}`;
    if (!years.has(parts.year)) {
      years.add(parts.year);
      ticks.push({position: positionOf(index, total), label: String(parts.year), major: true, index});
    }
    if (!months.has(monthKey)) {
      months.add(monthKey);
      if (ticks.every(tick => tick.index !== index)) ticks.push({position: positionOf(index, total), major: false, index});
    }
  });
  return ticks.sort((a, b) => a.index - b.index || Number(b.major) - Number(a.major));
}

function nameTicks(values: readonly (string | null | undefined)[], total: number): ScrubberTick[] {
  const seen = new Set<string>();
  const ticks: ScrubberTick[] = [];
  values.forEach((value, index) => {
    const label = koreanInitial(value);
    if (seen.has(label)) return;
    seen.add(label);
    ticks.push({position: positionOf(index, total), label, major: true, index});
  });
  return ticks;
}

function fallbackTicks(total: number): ScrubberTick[] {
  if (total <= 0) return [];
  return Array.from({length: 11}, (_, step) => ({position: step / 10, major: true, index: scrubberIndexAt(step / 10, total)}));
}

export function generateScrubberTicks(sort: ScrubberSort, total = sort.kind === 'fallback' ? 0 : sort.values.length): ScrubberTick[] {
  const count = Math.max(0, total);
  if (sort.kind === 'date') return dateTicks(sort.values, count);
  if (sort.kind === 'name') return nameTicks(sort.values, count);
  return fallbackTicks(count);
}

export function scrubberLabelAt(sort: ScrubberSort, index: number): string | null {
  const value = sort.kind === 'fallback' ? null : sort.values[clampIndex(index, sort.values.length)];
  if (sort.kind === 'date') {
    const parts = dateParts(value);
    return parts ? `${parts.year}년 ${parts.month}월` : null;
  }
  if (sort.kind === 'name') return koreanInitial(value as string | null | undefined);
  return null;
}

export function buildScrubberModel(sort: ScrubberSort, total = sort.kind === 'fallback' ? 0 : sort.values.length): ScrubberModel {
  const count = Math.max(0, total);
  return {total: count, ticks: generateScrubberTicks(sort, count), labelAt: index => scrubberLabelAt(sort, index)};
}
