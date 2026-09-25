/**
 * Ledger (가계부) notes: types, limits, won formatting and the text fallback body.
 * See docs/research/budget-notes-design-20260925.md §4. Rust (`notes/ledger.rs`) and
 * Android (`NotesModel.java`) validate the same limits and build the same fallback;
 * all three run `tests/fixtures/notes-v2/` (payload examples and ledger-vectors.json).
 */
export const LEDGER = "ledger";
export const LEDGER_MONTH = "ledger-month";
export type LedgerKind = typeof LEDGER | typeof LEDGER_MONTH;
export type LedgerUnit = "week" | "month" | "year";

/** A recurring charge (subscription or fixed bill). `start` is the first paid charge and the day anchor. */
export type Recurring = {
  id: string; name: string; amount: number; every: number; unit: LedgerUnit; start: string;
  /** Free trial until `start`. */ trial: boolean;
  /** No charge on or after this date (cancelled or ends); null = open-ended. */ until: string | null;
  memo: string; order: string;
  /** Set on the local copy when two devices changed the same item differently. */ forkOf?: string;
  [extra: string]: unknown;
};
/** Something to buy; `month` null = 언젠가. Done is derived (an entry references it), never stored. */
export type Planned = {
  id: string; name: string; amount: number; month: string | null; memo: string; dropped: boolean; order: string;
  forkOf?: string; [extra: string]: unknown;
};
/** One record in a month note. `in` = money in (refund or one-off income). */
export type LedgerEntry = {
  id: string; date: string; amount: number; name: string; in?: boolean; createdAt: string;
  /** Confirms (or, with amount 0, skips) one derived charge. */ recurring?: { id: string; date: string };
  /** Buys this plan. */ planned?: string;
  forkOf?: string; [extra: string]: unknown;
};

export const LEDGER_LIMITS = {
  recurring: 200, planned: 300,
  /** Per month note: 300 worst-case entries (UUID ids, refs, 100-char Korean names) fit 256 KiB. */ entries: 300, nameChars: 100, memoChars: 500,
  /** Amounts are integer won, 0 <= x < 10^12. */ amountBound: 1_000_000_000_000,
  everyMax: 120, bodyBytes: 24 * 1024,
  /** 들어오는 날: day of the month 1–31; past the month's end it means the last day. */ incomeDayMax: 31,
} as const;

const codePoints = (text: string) => Array.from(text).length;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------------------------------
// Calendar strings: `YYYY-MM-DD` local dates and `YYYY-MM` months, no time zone.

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function isMonth(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}
export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isMonth(value.slice(0, 7))) return false;
  const day = Number(value.slice(8, 10));
  return day >= 1 && day <= daysInMonth(Number(value.slice(0, 4)), Number(value.slice(5, 7)));
}
/** "2026-09" → "2026년 9월". */
export function monthLabel(month: string): string {
  return isMonth(month) ? `${Number(month.slice(0, 4))}년 ${Number(month.slice(5, 7))}월` : month;
}
/** Title of a hidden month note. */
export const monthTitle = (month: string) => `가계부 ${monthLabel(month)}`;

// ---------------------------------------------------------------------------------------
// Won

/** 2300000 → "₩2,300,000" (integer won, grouping without locale data). */
export function won(amount: number): string {
  return "₩" + String(Math.trunc(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export const validAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < LEDGER_LIMITS.amountBound;
export const validIncomeDay = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= LEDGER_LIMITS.incomeDayMax;
/** The date income arrives in `month`: day `incomeDay`, or the month's last day when shorter. */
export function incomeDateIn(month: string, incomeDay: number | null | undefined): string | null {
  if (!isMonth(month) || !validIncomeDay(incomeDay)) return null;
  return `${month}-${String(Math.min(incomeDay, daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------
// Limits (the backend checks the same; the UI checks before queueing a draft)

const validKey = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 64 && /^[\x21-\x7e]+$/.test(value);

function collectionProblem<T extends { id: string; forkOf?: string }>(list: T[], max: number, label: string, check: (entry: T) => string | null): string | null {
  if (list.length > max) return `${label}은 ${max}개까지 저장할 수 있습니다.`;
  const ids = new Set<string>();
  for (const entry of list) {
    if (!validKey(entry.id) || ids.has(entry.id) || (entry.forkOf !== undefined && !validKey(entry.forkOf))) return `${label} 형식이 올바르지 않습니다.`;
    ids.add(entry.id);
    const problem = check(entry);
    if (problem) return problem;
  }
  return null;
}
const NAME_PROBLEM = "이름은 100자, 메모는 500자까지 쓸 수 있습니다.";
const AMOUNT_PROBLEM = "금액은 0원 이상 1조 원 미만의 정수로 입력해 주세요.";

export type LedgerContent = { type?: string; income?: number | null; incomeDay?: number | null; recurring?: Recurring[]; planned?: Planned[]; ledger?: string; month?: string; entries?: LedgerEntry[] };

/** Every ledger limit; returns a Korean message or null. */
export function ledgerLimitProblem(note: LedgerContent): string | null {
  if (note.income != null && !validAmount(note.income)) return AMOUNT_PROBLEM;
  if (note.incomeDay != null && !validIncomeDay(note.incomeDay)) return "수입이 들어오는 날은 1~31일 중에서 골라 주세요.";
  const recurring = collectionProblem(note.recurring ?? [], LEDGER_LIMITS.recurring, "고정·구독", (r) => {
    if (codePoints(r.name) > LEDGER_LIMITS.nameChars || codePoints(r.memo) > LEDGER_LIMITS.memoChars) return NAME_PROBLEM;
    if (!validAmount(r.amount)) return AMOUNT_PROBLEM;
    if (!Number.isInteger(r.every) || r.every < 1 || r.every > LEDGER_LIMITS.everyMax || !["week", "month", "year"].includes(r.unit)) return "주기는 1~120 사이로 입력해 주세요.";
    if (!isDate(r.start) || (r.until !== null && !isDate(r.until)) || !validKey(r.order)) return "고정·구독 날짜가 올바르지 않습니다.";
    return null;
  });
  if (recurring) return recurring;
  const planned = collectionProblem(note.planned ?? [], LEDGER_LIMITS.planned, "계획", (p) => {
    if (codePoints(p.name) > LEDGER_LIMITS.nameChars || codePoints(p.memo) > LEDGER_LIMITS.memoChars) return NAME_PROBLEM;
    if (!validAmount(p.amount)) return AMOUNT_PROBLEM;
    if ((p.month !== null && !isMonth(p.month)) || !validKey(p.order)) return "계획 형식이 올바르지 않습니다.";
    return null;
  });
  if (planned) return planned;
  if (note.type === LEDGER_MONTH && (!validKey(note.ledger) || !isMonth(note.month))) return "가계부 월 기록 형식이 올바르지 않습니다.";
  return collectionProblem(note.entries ?? [], LEDGER_LIMITS.entries, "기록", (e) => {
    if (codePoints(e.name) > LEDGER_LIMITS.nameChars) return "기록 이름은 100자까지 쓸 수 있습니다.";
    if (!validAmount(e.amount)) return AMOUNT_PROBLEM;
    if (!isDate(e.date) || !validKey(e.createdAt)) return "기록 날짜가 올바르지 않습니다.";
    if (e.recurring && (!validKey(e.recurring.id) || !isDate(e.recurring.date))) return "기록 형식이 올바르지 않습니다.";
    if (e.planned !== undefined && !validKey(e.planned)) return "기록 형식이 올바르지 않습니다.";
    return null;
  });
}

const PLAINTEXT_BYTES = 256 * 1024;
/**
 * The backend's whole-payload limit (256 KiB) for a ledger or month note, checked before a
 * draft is queued. Counts the note as the UI holds it (a slight over-estimate).
 */
export function ledgerSizeProblem(note: LedgerContent & { title: string }): string | null {
  const body = note.type === LEDGER_MONTH
    ? monthFallback({ month: note.month ?? "", income: note.income ?? null, entries: note.entries ?? [] })
    : ledgerFallback({ title: note.title, income: note.income ?? null, incomeDay: note.incomeDay ?? null, recurring: note.recurring ?? [], planned: note.planned ?? [] });
  if (utf8Bytes(JSON.stringify({ ...note, body })) <= PLAINTEXT_BYTES) return null;
  return note.type === LEDGER_MONTH ? "이번 달 기록이 너무 많습니다. 오래된 기록을 줄여 주세요." : "가계부 항목이 너무 많습니다. 끝난 항목을 지워 주세요.";
}

// ---------------------------------------------------------------------------------------
// Canonical order and the text fallback body (pre-ledger clients show it read-only)

const byOrderId = (a: { order: string; id: string }, b: { order: string; id: string }) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** Entries: date desc, createdAt desc, then id (code-unit comparison, as native). */
export function byEntryOrder(a: LedgerEntry, b: LedgerEntry): number {
  if (a.date !== b.date) return a.date > b.date ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export const sortRecurring = <T extends Recurring | Planned>(list: T[]) => [...list].sort(byOrderId);
export const sortEntries = (list: LedgerEntry[]) => [...list].sort(byEntryOrder);

const oneLine = (text: string) => text.split(/[\r\n]+/).filter(Boolean).join(" ");
const words = (...parts: string[]) => parts.filter(Boolean).join(" ");
const cycleWord = (r: Pick<Recurring, "every" | "unit">) =>
  r.every === 1 ? { week: "매주", month: "매월", year: "매년" }[r.unit] : `${r.every}${{ week: "주", month: "개월", year: "년" }[r.unit]}마다`;

/**
 * Joins lines; over 24 KiB keeps the longest prefix that fits with a final "… N건 더",
 * where N counts the dropped list lines ("- ").
 */
function fitLines(lines: string[]): string {
  const full = lines.join("\n");
  if (utf8Bytes(full) <= LEDGER_LIMITS.bodyBytes) return full;
  const after: number[] = new Array(lines.length + 1).fill(0);
  for (let i = lines.length - 1; i >= 0; i--) after[i] = after[i + 1]! + (lines[i]!.startsWith("- ") ? 1 : 0);
  let best = 0;
  let prefix = 0;
  for (let p = 0; p <= lines.length; p++) {
    if (p > 0) prefix += utf8Bytes(lines[p - 1]!) + (p > 1 ? 1 : 0);
    if (prefix + (p > 0 ? 1 : 0) + utf8Bytes(`… ${after[p]}건 더`) <= LEDGER_LIMITS.bodyBytes) best = p;
  }
  return [...lines.slice(0, best), `… ${after[best]}건 더`].join("\n");
}

export function ledgerFallback(note: { title: string; income: number | null; incomeDay?: number | null; recurring: Recurring[]; planned: Planned[] }): string {
  const lines = [`# ${oneLine(note.title) || "가계부"}`];
  if (note.income !== null) lines.push(`월 수입 ${won(note.income)}${note.incomeDay != null ? ` · 매달 ${note.incomeDay}일` : ""}`);
  if (note.recurring.length) {
    lines.push("", "## 고정·구독");
    for (const r of sortRecurring(note.recurring))
      lines.push(`- ${words(oneLine(r.name), won(r.amount))} · ${cycleWord(r)} · ${r.start}부터${r.trial ? " · 무료 체험" : ""}${r.until ? ` · ${r.until} 만료` : ""}`);
  }
  if (note.planned.length) {
    lines.push("", "## 사고 싶은 것");
    for (const p of sortRecurring(note.planned)) lines.push(`- ${words(oneLine(p.name), won(p.amount))} · ${p.month ?? "언젠가"}${p.dropped ? " · 안 사기로 함" : ""}`);
  }
  return fitLines(lines);
}

export function monthFallback(note: { month: string; income: number | null; entries: LedgerEntry[] }): string {
  const lines = [`# ${monthLabel(note.month)} 기록 (${note.entries.length}건)`];
  if (note.income !== null) lines.push(`수입 ${won(note.income)}`);
  for (const e of sortEntries(note.entries)) lines.push(`- ${words(`${e.date.slice(5)} ${e.in ? "+" : ""}${won(e.amount)}`, oneLine(e.name))}`);
  return fitLines(lines);
}

// ---------------------------------------------------------------------------------------
// Forks: "두 기기에서 다르게 고침"

type Forkable = { id: string; forkOf?: string };
/** Items still waiting for 이것만 남기기 (the originals and their copies). */
export function forkedIds<T extends Forkable>(list: T[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of list) if (entry.forkOf) { ids.add(entry.id); if (list.some((other) => other.id === entry.forkOf)) ids.add(entry.forkOf); }
  return ids;
}
/** 이것만 남기기: keeps `id`, deletes its counterpart(s) and clears `forkOf`. */
export function keepOnly<T extends Forkable>(list: T[], id: string): T[] {
  const chosen = list.find((entry) => entry.id === id);
  if (!chosen) return list;
  const group = chosen.forkOf ?? chosen.id;
  return list
    .filter((entry) => entry.id === id || (entry.id !== group && entry.forkOf !== group))
    .map((entry) => {
      if (entry.id !== id || entry.forkOf === undefined) return entry;
      const { forkOf: _dropped, ...rest } = entry;
      return rest as T;
    });
}

export const isLedgerKind = (note: { type?: string }) => note.type === LEDGER || note.type === LEDGER_MONTH;
/**
 * Until the ledger screens exist, the generic editors show ledger notes read-only with
 * their fallback body (pin, trash and archive still work, as for unknown types).
 */
export function genericView<T extends { type?: string; readOnly?: boolean }>(note: T | null): T | null {
  return note && isLedgerKind(note) && !note.readOnly ? { ...note, readOnly: true } : note;
}
