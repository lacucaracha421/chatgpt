/**
 * PC ledger (가계부) screen: left = month summary, upcoming charges and this month's plans;
 * right = 기록 (inline Tab/Enter entry row over the day-grouped table), 고정·구독 and 계획.
 * Design: docs/research/budget-notes-design-20260925.md §3.2 and §7. Figures come only from
 * ./summary and ./cycle; this file only reads and writes notes through the store.
 */
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowPathRoundedSquareIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Button } from "../../shared/ui/Button";
import { keyBetween } from "../model";
import type { Note, NotesStore } from "../store";
import { addDays, addMonths, cycleLabel, inTrial, isEnded, localToday, monthEnd, monthlyEquivalent, monthStart, nextCharges, recurringTotals } from "./cycle";
import { forkedIds, keepOnly, LEDGER, LEDGER_LIMITS, LEDGER_MONTH, ledgerLimitProblem, ledgerSizeProblem, monthLabel, sortRecurring, won, type LedgerEntry, type LedgerUnit, type Planned, type Recurring } from "./model";
import { baseIncome, donePlans, ledgerEntries, monthNotesOf, monthSummary, type Charge } from "./summary";
import { amountText, daysUntil, dotDate, formatAmountInput, parseAmount, parseDay, parseMonth, weekday } from "./input";
import "./ledger.css";

type Tab = "entries" | "recurring" | "plans";
const TABS: [Tab, string][] = [["entries", "기록"], ["recurring", "고정·구독"], ["plans", "계획"]];
const monthNumber = (month: string) => Number(month.slice(5, 7));
const signedWon = (amount: number) => (amount < 0 ? `−${won(-amount)}` : won(amount));
const codePoints = (text: string) => Array.from(text).length;
const nameTooLong = (text: string) => codePoints(text) > LEDGER_LIMITS.nameChars;
/** Every save checks the item limits and the whole-note size first (design §4.4). */
const saveProblem = (note: Note) => ledgerLimitProblem(note) ?? ledgerSizeProblem(note);

/** Notes list preview of a ledger: this month's 쓸 수 있는 돈 (or 쓴 돈 without an income). */
export function ledgerPreview(ledger: Note, notes: Note[], today = localToday()): string {
  const month = today.slice(0, 7);
  const s = monthSummary(ledger, monthNotesOf(notes, ledger.id), month, today);
  return s.available !== null ? `${monthNumber(month)}월 쓸 수 있는 돈 ${signedWon(s.available)}` : `${monthNumber(month)}월 쓴 돈 ${won(s.spent)}`;
}
/** Month notes stay internal while their ledger exists (also in trash); orphans show read-only in 보관함. */
export function hiddenLedgerMonths(notes: Note[]): Set<string> {
  const ledgers = new Set(notes.filter((n) => n.type === LEDGER).map((n) => n.id));
  return new Set(notes.filter((n) => n.type === LEDGER_MONTH && n.ledger !== undefined && ledgers.has(n.ledger)).map((n) => n.id));
}

/** Enter submits (never while an IME is composing), Esc cancels; buttons keep their own Enter. */
function formKeys(submit: () => void, cancel?: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const tag = (event.target as HTMLElement).tagName;
    if (event.key === "Enter" && tag !== "BUTTON" && tag !== "TEXTAREA") { event.preventDefault(); submit(); }
    else if (event.key === "Escape" && cancel) { event.preventDefault(); event.stopPropagation(); cancel(); }
  };
}

function AmountInput({ value, onChange, label, allowIn = false, placeholder = "0", inputRef }: { value: string; onChange: (value: string) => void; label: string; allowIn?: boolean; placeholder?: string; inputRef?: RefObject<HTMLInputElement | null> }) {
  return <span className="ledger-input ledger-amount-input"><span aria-hidden="true">₩</span>
    <input ref={inputRef} aria-label={label} inputMode="numeric" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => onChange(formatAmountInput(e.target.value, allowIn))} /></span>;
}

type EntryDraft = { date: string; amount: number; name: string; in: boolean };
type EntryInitial = { date: string; amount: string; name: string; in: boolean };

/** The entry row: 날짜 · 금액 · 이름 · 추가. Works with Tab and Enter only; `+` before the amount = 들어온 돈. */
function EntryForm({ label, month, initial, submitLabel = "추가", link, onUnlink, onSubmit, onCancel, onDelete, amountRef }: {
  label: string; month: string; initial: EntryInitial; submitLabel?: string; link?: string; onUnlink?: () => void;
  onSubmit: (draft: EntryDraft) => Promise<boolean> | boolean; onCancel?: () => void; onDelete?: () => void; amountRef?: RefObject<HTMLInputElement | null>;
}) {
  const [date, setDate] = useState(initial.date.slice(5));
  const [amount, setAmount] = useState((initial.in && initial.amount ? "+" : "") + initial.amount);
  const [name, setName] = useState(initial.name);
  const [problem, setProblem] = useState("");
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = amountRef ?? ownRef;
  const incoming = amount.trimStart().startsWith("+");
  async function submit() {
    const day = parseDay(date, month);
    if (!day) { setProblem("날짜는 09-25처럼 적어 주세요."); return; }
    const parsed = parseAmount(amount);
    if (!parsed || parsed.amount === 0) { setProblem("금액을 적어 주세요."); ref.current?.focus(); return; }
    if (nameTooLong(name.trim())) { setProblem("기록 이름은 100자까지 쓸 수 있습니다."); return; }
    setProblem("");
    if (await onSubmit({ date: day, amount: parsed.amount, name: name.trim(), in: parsed.in }) && !onCancel) {
      setAmount(""); setName(""); ref.current?.focus();
    }
  }
  return <div className="ledger-entry-form" role="group" aria-label={label} onKeyDown={formKeys(() => void submit(), onCancel)}>
    <div className="ledger-entry-form__row">
      <input className="ledger-input ledger-entry-form__date" aria-label="날짜" autoComplete="off" value={date} onChange={(e) => setDate(e.target.value)} />
      <span className="ledger-input ledger-amount-input ledger-entry-form__amount">
        <button type="button" tabIndex={-1} className="ledger-kind" aria-pressed={incoming} onClick={() => setAmount(incoming ? amount.replace(/^\s*\+/, "") : `+${amount}`)}>{incoming ? "들어온 돈" : "나간 돈"}</button>
        <span aria-hidden="true">₩</span>
        <input ref={ref} aria-label="금액" inputMode="numeric" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(formatAmountInput(e.target.value))} />
      </span>
      <input className="ledger-input ledger-entry-form__name" aria-label="이름" placeholder="이름 (선택)" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      <Button variant="primary" onClick={() => void submit()}>{submitLabel}</Button>
      {onCancel && <Button variant="ghost" onClick={onCancel}>취소</Button>}
      {onDelete && <Button variant="ghost" onClick={onDelete}>삭제</Button>}
    </div>
    {link && <p className="ledger-link">계획 “{link}”과 연결해 기록합니다 <button type="button" className="ledger-text-button" onClick={onUnlink}>연결 빼기</button></p>}
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

/** A derived charge: 실제 금액으로 확정, or 이번 달은 건너뜀 (a 0-won confirmation). */
function ChargeForm({ charge, onConfirm, onCancel }: { charge: Charge; onConfirm: (amount: number) => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(amountText(charge.amount));
  const [problem, setProblem] = useState("");
  const confirm = () => { const parsed = parseAmount(amount); if (!parsed) { setProblem("금액을 적어 주세요."); return; } onConfirm(parsed.amount); };
  return <div className="ledger-entry-form" role="group" aria-label={`${charge.recurring.name} 결제 확정`} onKeyDown={formKeys(confirm, onCancel)}>
    <div className="ledger-entry-form__row">
      <span className="ledger-entry-form__caption">{dotDate(charge.date)} {charge.recurring.name}</span>
      <AmountInput label="실제 금액" value={amount} onChange={setAmount} />
      <Button variant="primary" onClick={confirm}>실제 금액으로 확정</Button>
      <Button onClick={() => onConfirm(0)}>이번 달은 건너뜀</Button>
      <Button variant="ghost" onClick={onCancel}>취소</Button>
    </div>
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

function IncomeForm({ month, ledgerIncome, override, onSave, onCancel }: { month: string; ledgerIncome: number | null; override: number | null; onSave: (income: number | null, override: number | null) => void; onCancel: () => void }) {
  const [base, setBase] = useState(amountText(ledgerIncome));
  const [only, setOnly] = useState(amountText(override));
  const [problem, setProblem] = useState("");
  function submit() {
    const b = base.trim() ? parseAmount(base) : null, o = only.trim() ? parseAmount(only) : null;
    if ((base.trim() && !b) || (only.trim() && !o)) { setProblem("금액은 0원 이상 1조 원 미만으로 적어 주세요."); return; }
    onSave(b?.amount ?? null, o?.amount ?? null);
  }
  return <div className="ledger-form ledger-income" role="group" aria-label="수입 고치기" onKeyDown={formKeys(submit, onCancel)}>
    <label className="ledger-field"><span>매달 수입</span><AmountInput label="매달 수입" value={base} onChange={setBase} placeholder="없음" /></label>
    <label className="ledger-field"><span>{monthNumber(month)}월만 다르게</span><AmountInput label={`${monthNumber(month)}월 수입`} value={only} onChange={setOnly} placeholder="비우면 매달 수입" /></label>
    <div className="ledger-form__actions"><Button variant="primary" onClick={submit}>저장</Button><Button variant="ghost" onClick={onCancel}>취소</Button></div>
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

type RecurringDraft = Pick<Recurring, "name" | "amount" | "every" | "unit" | "start" | "trial" | "until" | "memo">;
function RecurringForm({ initial, today, onSave, onCancel, onDelete }: { initial?: Recurring; today: string; onSave: (draft: RecurringDraft) => void; onCancel: () => void; onDelete?: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(amountText(initial?.amount));
  const [every, setEvery] = useState(String(initial?.every ?? 1));
  const [unit, setUnit] = useState<LedgerUnit>(initial?.unit ?? "month");
  const [start, setStart] = useState(initial?.start ?? today);
  const [trial, setTrial] = useState(initial?.trial ?? false);
  const [until, setUntil] = useState(initial?.until ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [problem, setProblem] = useState("");
  function draft(untilValue = until): RecurringDraft | null {
    const parsed = parseAmount(amount), n = Number(every), month = today.slice(0, 7);
    const startDate = parseDay(start, month), untilDate = untilValue.trim() ? parseDay(untilValue, month) : null;
    const fail = (text: string) => { setProblem(text); return null; };
    if (!name.trim()) return fail("이름을 적어 주세요.");
    if (nameTooLong(name.trim()) || codePoints(memo) > LEDGER_LIMITS.memoChars) return fail("이름은 100자, 메모는 500자까지 쓸 수 있습니다.");
    if (!parsed) return fail("금액을 적어 주세요.");
    if (!Number.isInteger(n) || n < 1 || n > LEDGER_LIMITS.everyMax) return fail("주기는 1~120 사이로 적어 주세요.");
    if (!startDate) return fail("첫 결제일은 2026-09-25처럼 적어 주세요.");
    if (untilValue.trim() && !untilDate) return fail("만료일은 2026-12-31처럼 적어 주세요.");
    setProblem("");
    return { name: name.trim(), amount: parsed.amount, every: n, unit, start: startDate, trial, until: untilDate, memo };
  }
  const submit = () => { const d = draft(); if (d) onSave(d); };
  // 해지: no charge from the next renewal on (the item stays usable until then).
  const cancelNext = initial ? nextCharges(initial, addDays(today, 1), 1)[0] ?? addDays(today, 1) : null;
  return <div className="ledger-form ledger-form--grid" role="group" aria-label={initial ? `${initial.name} 고치기` : "고정·구독 추가"} onKeyDown={formKeys(submit, onCancel)}>
    <label className="ledger-field"><span>이름</span><input className="ledger-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="넷플릭스, 월세…" /></label>
    <label className="ledger-field"><span>금액</span><AmountInput label="금액" value={amount} onChange={setAmount} /></label>
    <div className="ledger-field"><span>주기</span><span className="ledger-cycle">
      <input className="ledger-input" aria-label="주기 간격" inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value.replace(/\D/g, "").slice(0, 3))} />
      <select className="ledger-input" aria-label="주기 단위" value={unit} onChange={(e) => setUnit(e.target.value as LedgerUnit)}><option value="week">주마다</option><option value="month">개월마다</option><option value="year">년마다</option></select></span></div>
    <label className="ledger-field"><span>첫 결제일</span><input className="ledger-input" value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-09-25" /></label>
    <label className="ledger-field ledger-field--check"><input type="checkbox" checked={trial} onChange={(e) => setTrial(e.target.checked)} /><span>첫 결제일까지 무료 체험</span></label>
    <label className="ledger-field"><span>만료일</span><input className="ledger-input" value={until} onChange={(e) => setUntil(e.target.value)} placeholder="비우면 계속" /></label>
    <label className="ledger-field ledger-field--wide"><span>메모</span><input className="ledger-input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
    <div className="ledger-form__actions">
      <Button variant="primary" onClick={submit}>저장</Button><Button variant="ghost" onClick={onCancel}>취소</Button>
      {initial && !initial.until && cancelNext && <Button variant="ghost" onClick={() => { const d = draft(cancelNext); if (d) onSave(d); }}>해지 · {dotDate(cancelNext)}부터 결제 없음</Button>}
      {onDelete && <Button variant="ghost" onClick={onDelete}>삭제</Button>}
    </div>
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

type PlanDraft = Pick<Planned, "name" | "amount" | "month" | "memo">;
function PlanForm({ initial, currentMonth, onSave, onCancel, onDelete }: { initial?: Planned; currentMonth: string; onSave: (draft: PlanDraft) => void; onCancel: () => void; onDelete?: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(amountText(initial?.amount));
  const [month, setMonth] = useState(initial ? initial.month ?? "" : currentMonth);
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [problem, setProblem] = useState("");
  function submit() {
    const parsed = parseAmount(amount), m = parseMonth(month, currentMonth);
    if (!name.trim()) { setProblem("이름을 적어 주세요."); return; }
    if (nameTooLong(name.trim()) || codePoints(memo) > LEDGER_LIMITS.memoChars) { setProblem("이름은 100자, 메모는 500자까지 쓸 수 있습니다."); return; }
    if (!parsed) { setProblem("금액을 적어 주세요."); return; }
    if (m === undefined) { setProblem("달은 2026-10처럼 적거나 비워 두세요."); return; }
    setProblem("");
    onSave({ name: name.trim(), amount: parsed.amount, month: m, memo });
  }
  return <div className="ledger-form ledger-form--grid" role="group" aria-label={initial ? `${initial.name} 고치기` : "계획 추가"} onKeyDown={formKeys(submit, onCancel)}>
    <label className="ledger-field"><span>이름</span><input className="ledger-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="사고 싶은 것" /></label>
    <label className="ledger-field"><span>금액</span><AmountInput label="금액" value={amount} onChange={setAmount} /></label>
    <label className="ledger-field"><span>달</span><input className="ledger-input" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="비우면 언젠가" /></label>
    <label className="ledger-field"><span>메모</span><input className="ledger-input" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
    <div className="ledger-form__actions"><Button variant="primary" onClick={submit}>저장</Button><Button variant="ghost" onClick={onCancel}>취소</Button>{onDelete && <Button variant="ghost" onClick={onDelete}>삭제</Button>}</div>
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

function ForkBar({ onKeep }: { onKeep: () => void }) {
  return <div className="ledger-fork"><span>두 기기에서 다르게 고침</span><Button size="sm" onClick={onKeep}>이것만 남기기</Button></div>;
}
function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="ledger-label">{children}<span aria-hidden="true" /></h3>;
}

export function LedgerView({ store, ledgerId, today, actions, children }: { store: NotesStore; ledgerId: string; today?: string; actions?: ReactNode; children?: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const ledger = state.notes.find((n) => n.id === ledgerId);
  return ledger ? <LedgerScreen store={store} ledger={ledger} notes={state.notes} today={today ?? localToday()} actions={actions}>{children}</LedgerScreen> : null;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}
function orderAfter<T extends Recurring | Planned>(list: T[]): string {
  const sorted = sortRecurring(list);
  return keyBetween(sorted.length ? sorted[sorted.length - 1]!.order : null, null);
}

function LedgerScreen({ store, ledger, notes, today, actions, children }: { store: NotesStore; ledger: Note; notes: Note[]; today: string; actions?: ReactNode; children?: ReactNode }) {
  const currentMonth = today.slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [tab, setTab] = useState<Tab>("entries");
  const [buying, setBuying] = useState<Planned | null>(null);
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editingRec, setEditingRec] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const monthNotes = useMemo(() => monthNotesOf(notes, ledger.id), [notes, ledger.id]);
  const entries = useMemo(() => ledgerEntries(monthNotes), [monthNotes]);
  const summary = useMemo(() => monthSummary(ledger, monthNotes, month, today, entries), [ledger, monthNotes, month, today, entries]);
  const recurring = ledger.recurring ?? [];
  const planned = ledger.planned ?? [];
  const done = useMemo(() => donePlans(entries), [entries]);
  const forkedEntries = useMemo(() => forkedIds(entries), [entries]);
  const forkedRecurring = forkedIds(recurring), forkedPlans = forkedIds(planned);
  const override = monthNotes.find((n) => n.month === month && n.income != null)?.income ?? null;
  const base = baseIncome(ledger, monthNotes, month);
  const M = monthNumber(month);

  // ---- writes -------------------------------------------------------------------------
  const freshMonthNotes = () => monthNotesOf(store.snapshot().notes, ledger.id);
  function saveLedger(change: (current: Note) => Partial<Note>): boolean {
    const current = store.snapshot().notes.find((n) => n.id === ledger.id) ?? ledger;
    const next = { ...current, ...change(current) };
    const problem = saveProblem(next);
    setError(problem);
    if (problem) return false;
    store.edit(next);
    return true;
  }
  /** Writes the month note of `m` (created on first write; its id is derived natively). */
  async function saveMonth(m: string, update: (list: LedgerEntry[]) => LedgerEntry[], extra: Partial<Note> = {}): Promise<boolean> {
    try {
      const id = await store.ledgerMonth(ledger.id, m);
      const note = store.snapshot().notes.find((n) => n.id === id);
      if (!note) return false;
      const next = { ...note, ...extra, entries: update(note.entries ?? []) };
      const problem = saveProblem(next);
      setError(problem);
      if (problem) return false;
      store.edit(next);
      return true;
    } catch (e) { setError(typeof e === "string" ? e : "가계부 기록을 저장하지 못했습니다."); return false; }
  }
  /** Every month note holding the entry (keep-both copies repeat entries); nothing is saved if any would break a limit. */
  function editContaining(id: string, update: (list: LedgerEntry[]) => LedgerEntry[]): boolean {
    const next = freshMonthNotes().filter((note) => (note.entries ?? []).some((e) => e.id === id)).map((note) => ({ ...note, entries: update(note.entries ?? []) }));
    const problem = next.map(saveProblem).find(Boolean) ?? null;
    setError(problem);
    if (problem) return false;
    for (const note of next) store.edit(note);
    return true;
  }
  function addEntry(draft: EntryDraft, extra: Partial<LedgerEntry> = {}) {
    const entry: LedgerEntry = { id: crypto.randomUUID(), date: draft.date, amount: draft.amount, name: draft.name, createdAt: new Date().toISOString(), ...(draft.in ? { in: true } : {}), ...extra };
    return saveMonth(draft.date.slice(0, 7), (list) => [...list, entry]);
  }
  async function updateEntry(old: LedgerEntry, draft: EntryDraft): Promise<boolean> {
    const next: LedgerEntry = { ...old, date: draft.date, amount: draft.amount, name: draft.name };
    if (draft.in) next.in = true; else delete next.in;
    const target = draft.date.slice(0, 7);
    if (target === old.date.slice(0, 7)) { if (!editContaining(old.id, (list) => list.map((e) => (e.id === old.id ? next : e)))) return false; }
    else {
      // Moving months: write the target first, then remove the entry from the source (design §4.2).
      if (!await saveMonth(target, (list) => [...list.filter((e) => e.id !== old.id), next])) return false;
      for (const note of freshMonthNotes()) if (note.month !== target && (note.entries ?? []).some((e) => e.id === old.id)) store.edit({ ...note, entries: (note.entries ?? []).filter((e) => e.id !== old.id) });
    }
    setEditingEntry(null);
    return true;
  }
  async function saveIncome(income: number | null, only: number | null) {
    if (income !== (ledger.income ?? null) && !saveLedger(() => ({ income }))) return;
    const hasMonthNote = monthNotes.some((n) => n.month === month);
    if (only !== override && (only !== null || hasMonthNote) && !await saveMonth(month, (list) => list, { income: only })) return;
    setIncomeOpen(false);
  }
  function saveRecurring(id: string | null, draft: RecurringDraft) {
    const ok = saveLedger((current) => {
      const list = current.recurring ?? [];
      const old = id ? list.find((r) => r.id === id) : undefined;
      return { recurring: upsert(list, { ...(old ?? { id: crypto.randomUUID(), order: orderAfter(list) }), ...draft } as Recurring) };
    });
    if (ok) setEditingRec(null);
  }
  function savePlan(id: string | null, draft: PlanDraft) {
    const ok = saveLedger((current) => {
      const list = current.planned ?? [];
      const old = id ? list.find((p) => p.id === id) : undefined;
      return { planned: upsert(list, { ...(old ?? { id: crypto.randomUUID(), order: orderAfter(list), dropped: false }), ...draft } as Planned) };
    });
    if (ok) setEditingPlan(null);
  }
  const setDropped = (id: string, dropped: boolean) => saveLedger((c) => ({ planned: (c.planned ?? []).map((p) => (p.id === id ? { ...p, dropped } : p)) }));
  function buy(plan: Planned) {
    setBuying(plan); setTab("entries");
    requestAnimationFrame(() => amountRef.current?.focus());
  }
  const focusEntryRow = () => { setTab("entries"); requestAnimationFrame(() => amountRef.current?.focus()); };

  // ---- derived view data --------------------------------------------------------------
  const defaultDate = month === currentMonth ? today : month < currentMonth ? monthEnd(month) : monthStart(month);
  const days = useMemo(() => {
    const byDay = new Map<string, { entries: LedgerEntry[]; charges: Charge[] }>();
    const day = (date: string) => { let d = byDay.get(date); if (!d) byDay.set(date, (d = { entries: [], charges: [] })); return d; };
    for (const e of summary.entries) day(e.date).entries.push(e);
    for (const c of summary.pastCharges) day(c.date).charges.push(c);
    return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, d]) => ({
      date, ...d, total: d.entries.filter((e) => !e.in).reduce((s, e) => s + e.amount, 0) + d.charges.reduce((s, c) => s + c.amount, 0),
    }));
  }, [summary]);
  const upcoming = useMemo(() => {
    if (summary.phase === "past") return [];
    const from = summary.phase === "current" ? addDays(today, 1) : monthStart(month);
    const confirmed = new Set(entries.filter((e) => e.recurring).map((e) => `${e.recurring!.id}\n${e.recurring!.date}`));
    return recurring.flatMap((r) => nextCharges(r, from, 3).map((date) => ({ r, date })))
      .filter((c) => !confirmed.has(`${c.r.id}\n${c.date}`)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 3);
  }, [summary.phase, today, month, entries, recurring]);
  const totals = recurringTotals(recurring, today);
  const nextOf = (r: Recurring) => nextCharges(r, today, 1)[0] ?? null;
  const activeRecurring = recurring.filter((r) => !isEnded(r, today)).map((r) => ({ r, next: nextOf(r) })).sort((a, b) => (a.next ?? "9999") < (b.next ?? "9999") ? -1 : (a.next ?? "9999") > (b.next ?? "9999") ? 1 : a.r.order < b.r.order ? -1 : 1);
  const endedRecurring = sortRecurring(recurring.filter((r) => isEnded(r, today)));
  const ledgerForks = recurring.filter((r) => r.forkOf).length + planned.filter((p) => p.forkOf).length;

  // ---- render pieces ------------------------------------------------------------------
  const entryRow = (e: LedgerEntry) => <li key={e.id} className={`ledger-entry${forkedEntries.has(e.id) ? " is-forked" : ""}`}>
    {editingEntry === e.id
      ? <EntryForm label="기록 고치기" submitLabel="저장" month={month} initial={{ date: e.date, amount: amountText(e.amount), name: e.name, in: !!e.in }}
          onSubmit={(d) => updateEntry(e, d)} onCancel={() => setEditingEntry(null)} onDelete={() => { editContaining(e.id, (list) => list.filter((x) => x.id !== e.id)); setEditingEntry(null); }} />
      : <button type="button" className="ledger-entry__main" onClick={() => setEditingEntry(e.id)}>
          <span className="ledger-entry__icon" aria-hidden="true">{e.recurring ? <ArrowPathRoundedSquareIcon /> : e.in ? "+" : null}</span>
          <span className="ledger-entry__name">{e.name || (e.in ? "들어온 돈" : "이름 없음")}</span>
          <span className="ledger-entry__tag">{e.recurring ? (e.amount === 0 ? "이번 달 건너뜀" : "고정·구독 확정") : e.planned ? "계획" : e.in ? "들어온 돈" : ""}</span>
          <span className={`ledger-entry__amount${e.in ? " is-in" : ""}`}>{e.in ? "+" : ""}{won(e.amount)}</span>
        </button>}
    {forkedEntries.has(e.id) && <ForkBar onKeep={() => editContaining(e.id, (list) => keepOnly(list, e.id))} />}
  </li>;
  const chargeRow = (c: Charge) => { const key = `${c.recurring.id}\n${c.date}`; return <li key={key} className="ledger-entry is-derived">
    {confirming === key
      ? <ChargeForm charge={c} onCancel={() => setConfirming(null)} onConfirm={(amount) => { setConfirming(null); void addEntry({ date: c.date, amount, name: c.recurring.name, in: false }, { recurring: { id: c.recurring.id, date: c.date } }); }} />
      : <button type="button" className="ledger-entry__main" onClick={() => setConfirming(key)}>
          <span className="ledger-entry__icon" aria-hidden="true"><ArrowPathRoundedSquareIcon /></span>
          <span className="ledger-entry__name">{c.recurring.name}</span>
          <span className="ledger-entry__tag">고정·구독 자동</span>
          <span className="ledger-entry__amount">{won(c.amount)}</span>
        </button>}
  </li>; };

  const entriesPanel = <>
    <EntryForm key={`add:${month}:${buying?.id ?? ""}`} label="새 기록" month={month} amountRef={amountRef}
      initial={{ date: defaultDate, amount: buying ? amountText(buying.amount) : "", name: buying?.name ?? "", in: false }}
      link={buying?.name} onUnlink={() => setBuying(null)}
      onSubmit={async (d) => { const plan = buying; const ok = await addEntry(d, plan ? { planned: plan.id } : {}); if (ok && plan) { setBuying(null); requestAnimationFrame(() => amountRef.current?.focus()); } return ok; }} />
    <p className="ledger-hint"><kbd>Ctrl</kbd>+<kbd>N</kbd> 새 기록 · <kbd>Tab</kbd> 다음 칸 · 금액 앞에 <kbd>+</kbd> 들어온 돈 · <kbd>Enter</kbd> 추가 · <kbd>Alt</kbd>+<kbd>←</kbd><kbd>→</kbd> 달 이동</p>
    {days.length === 0 && <p className="ledger-empty">{M}월 기록이 없어요.</p>}
    {days.map((d) => <section key={d.date} className="ledger-day" aria-label={`${dotDate(d.date)} ${weekday(d.date)}`}>
      <header className="ledger-day__head"><b>{dotDate(d.date)}</b><span>{weekday(d.date)}</span><span className="ledger-day__total">{won(d.total)}</span></header>
      <ul>{d.entries.map(entryRow)}{d.charges.map(chargeRow)}</ul>
    </section>)}
  </>;

  const recurringRow = ({ r, next }: { r: Recurring; next: string | null }) => <li key={r.id} className={`ledger-rec${isEnded(r, today) ? " is-ended" : ""}${forkedRecurring.has(r.id) ? " is-forked" : ""}`}>
    {editingRec === r.id
      ? <RecurringForm initial={r} today={today} onSave={(d) => saveRecurring(r.id, d)} onCancel={() => setEditingRec(null)} onDelete={() => { if (saveLedger((c) => ({ recurring: (c.recurring ?? []).filter((x) => x.id !== r.id) }))) setEditingRec(null); }} />
      : <button type="button" className="ledger-rec__main" onClick={() => setEditingRec(r.id)}>
          <span className="ledger-mono" aria-hidden="true">{Array.from(r.name.trim())[0] ?? "·"}</span>
          <span className="ledger-rec__name"><strong>{r.name}
            {inTrial(r, today) && <span className="ledger-badge">체험 중 · 첫 결제 {dotDate(r.start)}</span>}
            {r.until && !isEnded(r, today) && <span className="ledger-badge ledger-badge--soft">해지함 · {dotDate(r.until)} 만료</span>}
            {r.until && isEnded(r, today) && <span className="ledger-badge ledger-badge--soft">{r.until} 종료</span>}</strong>
            <small>{cycleLabel(r)}{r.memo ? ` · ${r.memo}` : ""}</small></span>
          <span className="ledger-rec__when">{next ? <><b>{dotDate(next)}</b><small>{daysUntil(next, today)}</small></> : <small>결제 없음</small>}</span>
          <span className="ledger-rec__amount"><b>{won(r.amount)}</b>{!(r.unit === "month" && r.every === 1) && <small>월 {won(monthlyEquivalent(r))}</small>}</span>
        </button>}
    {forkedRecurring.has(r.id) && <ForkBar onKeep={() => saveLedger((c) => ({ recurring: keepOnly(c.recurring ?? [], r.id) }))} />}
  </li>;
  const trialLines = recurring.filter((r) => inTrial(r, today) && !isEnded(r, today)).sort((a, b) => (a.start < b.start ? -1 : 1));
  const recurringPanel = <>
    <div className="ledger-subsum">
      <div><small>월 환산 합계</small><b>{won(totals.monthly)}</b></div>
      <p>1년 <span className="ledger-num">{won(totals.yearly)}</span> · {M}월 결제 <span className="ledger-num">{won(summary.recurringThisMonth)}</span> · 사용 중 <span className="ledger-num">{totals.active}</span>개</p>
      {trialLines.map((r) => <p key={r.id}>{monthNumber(r.start)}월부터 {r.name} +{amountText(r.amount)}</p>)}
    </div>
    <div className="ledger-toolbar"><Button size="sm" onClick={() => setEditingRec("new")}><PlusIcon aria-hidden="true" />고정·구독 추가</Button></div>
    {editingRec === "new" && <RecurringForm today={today} onSave={(d) => saveRecurring(null, d)} onCancel={() => setEditingRec(null)} />}
    {!recurring.length && editingRec !== "new" && <p className="ledger-empty">구독이나 월세처럼 반복해서 나가는 돈을 적어 두세요.</p>}
    <ul className="ledger-list">{activeRecurring.map(recurringRow)}</ul>
    {endedRecurring.length > 0 && <details className="ledger-ended"><summary>종료됨 {endedRecurring.length}</summary><ul className="ledger-list">{endedRecurring.map((r) => recurringRow({ r, next: null }))}</ul></details>}
  </>;

  const planRow = (p: Planned) => { const doneBy = done.get(p.id); return <li key={p.id} className={`ledger-plan${doneBy || p.dropped ? " is-closed" : ""}${forkedPlans.has(p.id) ? " is-forked" : ""}`}>
    {editingPlan === p.id
      ? <PlanForm initial={p} currentMonth={currentMonth} onSave={(d) => savePlan(p.id, d)} onCancel={() => setEditingPlan(null)} onDelete={() => { if (saveLedger((c) => ({ planned: (c.planned ?? []).filter((x) => x.id !== p.id) }))) setEditingPlan(null); }} />
      : <div className="ledger-plan__row">
          <button type="button" className="ledger-plan__name" onClick={() => setEditingPlan(p.id)}><strong>{p.name}</strong>{p.memo && <small>{p.memo}</small>}</button>
          <span className="ledger-plan__amount">{won(p.amount)}</span>
          {doneBy ? <span className="ledger-plan__state">샀어요 · {dotDate(doneBy.date)} {won(doneBy.amount)}</span>
            : p.dropped ? <><span className="ledger-plan__state">안 사기로 함</span><Button size="sm" variant="ghost" onClick={() => setDropped(p.id, false)}>되돌리기</Button></>
            : <><Button size="sm" onClick={() => buy(p)}>샀어요</Button><Button size="sm" variant="ghost" onClick={() => setDropped(p.id, true)}>안 사기로 함</Button></>}
        </div>}
    {forkedPlans.has(p.id) && <ForkBar onKeep={() => saveLedger((c) => ({ planned: keepOnly(c.planned ?? [], p.id) }))} />}
  </li>; };
  const openPlans = sortRecurring(planned.filter((p) => !p.dropped && !done.has(p.id)));
  const closedPlans = sortRecurring(planned.filter((p) => p.dropped || done.has(p.id)));
  const planGroups = (() => {
    const groups = new Map<string, Planned[]>();
    const keyOf = (p: Planned) => p.month ?? "~";
    for (const p of [...openPlans].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))) { const k = keyOf(p); groups.set(k, [...(groups.get(k) ?? []), p]); }
    return [...groups.entries()].map(([k, list]) => ({ key: k, label: k === "~" ? "언젠가" : k === currentMonth ? "이번 달" : monthLabel(k), list }));
  })();
  const plansPanel = <>
    <div className="ledger-toolbar"><Button size="sm" onClick={() => setEditingPlan("new")}><PlusIcon aria-hidden="true" />계획 추가</Button></div>
    {editingPlan === "new" && <PlanForm currentMonth={month} onSave={(d) => savePlan(null, d)} onCancel={() => setEditingPlan(null)} />}
    {!planned.length && editingPlan !== "new" && <p className="ledger-empty">사고 싶은 것을 미리 적어 두면 그 달의 쓸 수 있는 돈에서 빠져요.</p>}
    {planGroups.map((g) => <section key={g.key} className="ledger-sec" aria-label={g.label}><SectionLabel>{g.label}</SectionLabel><ul className="ledger-list">{g.list.map(planRow)}</ul></section>)}
    {closedPlans.length > 0 && <details className="ledger-ended"><summary>끝난 계획 {closedPlans.length}</summary><ul className="ledger-list">{closedPlans.map(planRow)}</ul></details>}
  </>;

  const spentShare = summary.income > 0 ? Math.min(100, (summary.spent / summary.income) * 100) : 0;
  const scheduledShare = summary.income > 0 ? Math.min(100 - spentShare, (summary.scheduled / summary.income) * 100) : 0;
  const headline = summary.phase === "current" ? "이번 달 쓸 수 있는 돈" : summary.phase === "past" ? `${M}월 남은 돈` : `${M}월 쓸 수 있는 돈`;

  return <div className="ledger" onKeyDown={(e) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); e.stopPropagation(); focusEntryRow(); }
    else if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); setMonth((m) => addMonths(m, e.key === "ArrowLeft" ? -1 : 1)); setEditingEntry(null); setConfirming(null); }
  }}>
    {children}
    {error && <p className="ledger-problem ledger-banner" role="alert">{error}</p>}
    <div className="ledger__panes">
      <section className="ledger-summary" aria-label={`${monthLabel(month)} 요약`}>
        <div className="ledger-monthrow">
          <Button size="icon" variant="ghost" aria-label="이전 달" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeftIcon aria-hidden="true" /></Button>
          <h2>{monthLabel(month)}</h2>
          <Button size="icon" variant="ghost" aria-label="다음 달" onClick={() => setMonth(addMonths(month, 1))}><ChevronRightIcon aria-hidden="true" /></Button>
          {month !== currentMonth && <Button size="sm" variant="ghost" onClick={() => setMonth(currentMonth)}>이번 달로</Button>}
          <span className="ledger-spacer" />
          <Button size="sm" variant="ghost" aria-expanded={incomeOpen} onClick={() => setIncomeOpen(!incomeOpen)}>{base !== null ? `수입 ${amountText(base)}` : "수입 적기"}</Button>
        </div>
        {incomeOpen && <IncomeForm key={month} month={month} ledgerIncome={ledger.income ?? null} override={override} onSave={(income, only) => void saveIncome(income, only)} onCancel={() => setIncomeOpen(false)} />}
        <div className="ledger-hero">
          {summary.available !== null ? <>
            <p className="ledger-hero__k">{headline}</p>
            <p className={`ledger-hero__big${summary.available < 0 ? " is-over" : ""}`} aria-label={`${headline} ${signedWon(summary.available)}`}>{summary.available < 0 && "−"}<span className="ledger-hero__won">₩</span>{amountText(Math.abs(summary.available))}</p>
            {summary.perDay !== null && summary.perDay > 0 && <p className="ledger-hero__sub">하루 약 <span className="ledger-num">{won(summary.perDay)}</span> · 남은 날 <span className="ledger-num">{summary.remainingDays}</span>일</p>}
          </> : <>
            <p className="ledger-hero__k">{summary.phase === "current" ? "이번 달 쓴 돈" : `${M}월 쓴 돈`}</p>
            <p className="ledger-hero__big" aria-label={`쓴 돈 ${won(summary.spent)}`}><span className="ledger-hero__won">₩</span>{amountText(summary.spent)}</p>
            <p className="ledger-hero__sub">수입을 적으면 쓸 수 있는 돈이 보여요</p>
          </>}
          {summary.income > 0 && <div className="ledger-meter" role="img" aria-label={`수입 중 쓴 돈 ${Math.round(spentShare)}%, 예정 ${Math.round(scheduledShare)}%`}><i className="ledger-meter__spent" style={{ width: `${spentShare}%` }} /><i className="ledger-meter__coming" style={{ width: `${scheduledShare}%` }} /></div>}
          <dl className="ledger-figs">
            <div><dt>수입</dt><dd>{amountText(summary.income)}</dd></div>
            <div><dt>쓴 돈</dt><dd>{amountText(summary.spent)}</dd></div>
            <div><dt>예정</dt><dd>{amountText(summary.scheduled)}</dd></div>
            <div><dt>고정·구독 이번 달</dt><dd>{amountText(summary.recurringThisMonth)}</dd></div>
          </dl>
          {summary.reviewCount > 0 && <p className="ledger-review" role="status">확인할 기록 {summary.reviewCount}건 · 두 기기에서 다르게 고친 기록이 모두 더해져 있어요</p>}
          {ledgerForks > 0 && <p className="ledger-review" role="status">확인할 고정·구독·계획 {ledgerForks}건</p>}
        </div>
        {upcoming.length > 0 && <section className="ledger-sec" aria-label="다가오는 결제"><SectionLabel>다가오는 결제</SectionLabel>
          <ul className="ledger-list">{upcoming.map(({ r, date }) => <li key={`${r.id}\n${date}`} className="ledger-line"><span className="ledger-line__date">{dotDate(date)}</span><span className="ledger-line__name">{r.name}{r.trial && date === r.start ? " (체험 끝)" : ""}</span><span className="ledger-line__amount">{won(r.amount)}</span></li>)}</ul></section>}
        {summary.plans.length > 0 && <section className="ledger-sec" aria-label={`${M}월 계획`}><SectionLabel>{summary.phase === "current" ? "이번 달 계획" : `${M}월 계획`}</SectionLabel>
          <ul className="ledger-list">{summary.plans.map(({ plan, doneBy }) => <li key={plan.id} className={`ledger-line${doneBy ? " is-closed" : ""}`}>
            <span className="ledger-line__name">{plan.name}</span><span className="ledger-line__amount">{won(doneBy ? doneBy.amount : plan.amount)}</span>
            {doneBy ? <span className="ledger-plan__state">샀어요</span> : <Button size="sm" onClick={() => buy(plan)}>샀어요</Button>}</li>)}</ul></section>}
      </section>
      <section className="ledger-main" aria-label="가계부 내용">
        <div className="ledger-tabs">
          <div className="ledger-seg" role="group" aria-label="가계부 보기">{TABS.map(([id, text]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{text}</button>)}</div>
          <span className="ledger-count">{M}월 기록 <span className="ledger-num">{summary.entries.length}</span>건</span>
          {actions && <div className="ledger-actions">{actions}</div>}
        </div>
        {tab === "entries" ? entriesPanel : tab === "recurring" ? recurringPanel : plansPanel}
      </section>
    </div>
  </div>;
}
