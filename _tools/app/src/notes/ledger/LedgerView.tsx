/** PC frame and persistence for the shared accepted ledger screen. */
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowPathRoundedSquareIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { Button } from "../../shared/ui/Button";
import { keyBetween } from "../model";
import type { Note, NotesStore } from "../store";
import { addMonths, localToday } from "./cycle";
import { forkedIds, keepOnly, LEDGER_LIMITS, ledgerLimitProblem, ledgerSizeProblem, monthLabel, signedWon, sortRecurring, validIncomeDay, won, type LedgerEntry, type Planned, type Recurring } from "./model";
import { baseIncome, ledgerEntries, monthNotesOf, monthSummary, monthCharges, type Charge } from "./summary";
import { amountText, dotDate, formatAmountInput, parseAmount, parseDay, weekday } from "./input";
import { Dialog } from "../../shared/ui/Dialog";
import { LedgerContents, QuickEntry } from "./LedgerContents";
import { RecurringEditor, PlanEditor, type RecurringChanges, type PlanChanges } from "./LedgerEditors";
import "./ledger.css";
export { ledgerCard } from "./card";

const monthNumber = (month: string) => Number(month.slice(5, 7));
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
/** Board card of a ledger: this month's headline figure, how much of the income is spent, the next charge. */
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
    <input ref={inputRef} aria-label={label} inputMode="numeric" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onBlur={(e) => onChange(formatAmountInput(e.target.value, allowIn))} /></span>;
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
  const composing = useRef(false), busy = useRef(false);
  const ref = amountRef ?? ownRef;
  const incoming = amount.trimStart().startsWith("+");
  async function submit() {
    if (composing.current || busy.current) return;
    const day = parseDay(date, month);
    if (!day) { setProblem("날짜는 09-25처럼 적어 주세요."); return; }
    const parsed = parseAmount(amount);
    if (!parsed || parsed.amount === 0) { setProblem("금액을 적어 주세요."); ref.current?.focus(); return; }
    if (nameTooLong(name.trim())) { setProblem("기록 이름은 100자까지 쓸 수 있습니다."); return; }
    setProblem("");
    busy.current = true;
    try { await onSubmit({ date: day, amount: parsed.amount, name: name.trim(), in: parsed.in }); } finally { busy.current = false; }
  }
  return <div className="ledger-entry-form" role="group" aria-label={label} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => { if (!composing.current) formKeys(() => void submit(), onCancel)(e); }}>
    <div className="ledger-entry-form__row">
      <input className="ledger-input ledger-entry-form__date" aria-label="날짜" autoComplete="off" value={date} onChange={(e) => setDate(e.target.value)} />
      <span className="ledger-input ledger-amount-input ledger-entry-form__amount">
        <button type="button" tabIndex={-1} className="ledger-kind" aria-pressed={incoming} onClick={() => setAmount(incoming ? amount.replace(/^\s*\+/, "") : `+${amount}`)}>{incoming ? "들어온 돈" : "나간 돈"}</button>
        <span aria-hidden="true">₩</span>
        <input ref={ref} aria-label="금액" inputMode="numeric" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={(e) => setAmount(formatAmountInput(e.target.value))} />
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
function ChargeForm({ charge, busy, onConfirm, onCancel }: { charge: Charge; busy: boolean; onConfirm: (amount: number) => Promise<boolean>; onCancel: () => void }) {
  const [amount, setAmount] = useState(amountText(charge.amount));
  const [problem, setProblem] = useState("");
  const confirm = () => { const parsed = parseAmount(amount); if (!parsed || parsed.in) { setProblem("금액은 0 이상의 정수로 적어 주세요."); return; } void onConfirm(parsed.amount); };
  return <div className="ledger-entry-form" role="group" aria-label={`${charge.recurring.name} 결제 확정`} onKeyDown={formKeys(confirm, onCancel)}>
    <div className="ledger-entry-form__row">
      <span className="ledger-entry-form__caption">{dotDate(charge.date)} {charge.recurring.name}</span>
      <AmountInput label="실제 금액" value={amount} onChange={setAmount} />
      <Button variant="primary" disabled={busy} onClick={confirm}>실제 금액으로 확정</Button>
      <Button disabled={busy} onClick={() => void onConfirm(0)}>이번 달은 건너뜀</Button>
      <Button variant="ghost" onClick={onCancel}>취소</Button>
    </div>
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

function IncomeForm({ month, ledgerIncome, override, incomeDay, onSave, onCancel }: { month: string; ledgerIncome: number | null; override: number | null; incomeDay: number | null; onSave: (income: number | null, override: number | null, incomeDay: number | null) => void; onCancel: () => void }) {
  const [base, setBase] = useState(amountText(ledgerIncome));
  const [only, setOnly] = useState(amountText(override));
  const [day, setDay] = useState(incomeDay === null ? "" : String(incomeDay));
  const [problem, setProblem] = useState("");
  function submit() {
    const b = base.trim() ? parseAmount(base) : null, o = only.trim() ? parseAmount(only) : null;
    if ((base.trim() && !b) || (only.trim() && !o)) { setProblem("금액은 0원 이상 1조 원 미만으로 적어 주세요."); return; }
    const d = day.trim() ? Number(day) : null;
    if (d !== null && !validIncomeDay(d)) { setProblem("들어오는 날은 1~31 사이로 적어 주세요. 31일은 짧은 달에 말일이 됩니다."); return; }
    onSave(b?.amount ?? null, o?.amount ?? null, d);
  }
  return <div className="ledger-form ledger-income" role="group" aria-label="수입 고치기" onKeyDown={formKeys(submit, onCancel)}>
    <label className="ledger-field"><span>매달 수입</span><AmountInput label="매달 수입" value={base} onChange={setBase} placeholder="없음" /></label>
    <div className="ledger-field"><span>들어오는 날</span><span className="ledger-income-day">
      <span aria-hidden="true">매달</span>
      <input className="ledger-input" aria-label="들어오는 날" inputMode="numeric" autoComplete="off" placeholder="안 정함" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, "").slice(0, 2))} />
      <span aria-hidden="true">일</span>
      {day && <button type="button" className="ledger-text-button" onClick={() => setDay("")}>지우기</button>}</span></div>
    <label className="ledger-field"><span>{monthNumber(month)}월만 다르게</span><AmountInput label={`${monthNumber(month)}월 수입`} value={only} onChange={setOnly} placeholder="비우면 매달 수입" /></label>
    <div className="ledger-form__actions"><Button variant="primary" onClick={submit}>저장</Button><Button variant="ghost" onClick={onCancel}>취소</Button></div>
    {problem && <p className="ledger-problem" role="alert">{problem}</p>}
  </div>;
}

function ForkBar({ onKeep }: { onKeep: () => void }) {
  return <div className="ledger-fork"><span>두 기기에서 다르게 고침</span><Button size="sm" onClick={onKeep}>이것만 남기기</Button></div>;
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
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const chargeSaving = useRef(false);
  const [chargeBusy, setChargeBusy] = useState(false);
  const [editingRec, setEditingRec] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const monthNotes = useMemo(() => monthNotesOf(notes, ledger.id), [notes, ledger.id]);
  const entries = useMemo(() => ledgerEntries(monthNotes), [monthNotes]);
  const summary = useMemo(() => monthSummary(ledger, monthNotes, month, today, entries), [ledger, monthNotes, month, today, entries]);
  const recurring = ledger.recurring ?? [];
  const planned = ledger.planned ?? [];
  const forkedEntries = useMemo(() => forkedIds(entries), [entries]);
  const override = monthNotes.find((n) => n.month === month && n.income != null)?.income ?? null;
  const base = baseIncome(ledger, monthNotes, month);

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
      // Finish the initial empty-month save before writing its first entry.
      if (!await store.flush()) { setError(store.snapshot().error ?? "가계부 기록을 저장하지 못했습니다."); return false; }
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
    return saveMonth(draft.date.slice(0, 7), (list) => {
      if (entry.recurring) {
        // Recheck after the asynchronous month creation/flush, including moved confirmations.
        const all = ledgerEntries(freshMonthNotes());
        const link = entry.recurring;
        if (all.some(e => e.recurring?.id === link.id && e.recurring.date === link.date)) return list;
        const current = store.snapshot().notes.find(n => n.id === ledger.id) ?? ledger;
        if (monthCharges(current.recurring ?? [], all, link.date.slice(0, 7)).some(c => c.recurring.id === link.id && c.date === link.date && c.confirmedBy)) return list;
      }
      return [...list, entry];
    });
  }
  async function confirmCharge(charge: Charge, amount: number): Promise<boolean> {
    if (chargeSaving.current) return false;
    chargeSaving.current = true;
    setChargeBusy(true);
    try {
      const ok = await addEntry({ date: charge.date, amount, name: charge.recurring.name, in: false }, { recurring: { id: charge.recurring.id, date: charge.date } });
      if (ok) setConfirming(null);
      return ok;
    } finally { chargeSaving.current = false; setChargeBusy(false); }
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
  async function saveIncome(income: number | null, only: number | null, incomeDay: number | null) {
    if ((income !== (ledger.income ?? null) || incomeDay !== (ledger.incomeDay ?? null)) && !saveLedger(() => ({ ...(income !== (ledger.income ?? null) ? { income } : {}), ...(incomeDay !== (ledger.incomeDay ?? null) ? { incomeDay } : {}) }))) return;
    const hasMonthNote = monthNotes.some((n) => n.month === month);
    if (only !== override && (only !== null || hasMonthNote) && !await saveMonth(month, (list) => list, { income: only })) return;
    setIncomeOpen(false);
  }
  function saveRecurring(id: string | null, draft: RecurringChanges) {
    const ok = saveLedger((current) => {
      const list = current.recurring ?? [];
      const old = id ? list.find((r) => r.id === id) : undefined;
      return { recurring: upsert(list, { ...(old ?? { id: crypto.randomUUID(), order: orderAfter(list) }), ...draft } as Recurring) };
    });
    return ok;
  }
  function savePlan(id: string | null, draft: PlanChanges) {
    const ok = saveLedger((current) => {
      const list = current.planned ?? [];
      const old = id ? list.find((p) => p.id === id) : undefined;
      return { planned: upsert(list, { ...(old ?? { id: crypto.randomUUID(), order: orderAfter(list), dropped: false }), ...draft } as Planned) };
    });
    return ok;
  }
  const focusEntryRow = () => document.querySelector<HTMLInputElement>('[aria-label="지출 빠른 입력"]')?.focus();
  const days = useMemo(() => {
    const grouped = new Map<string, { entries: LedgerEntry[]; charges: Charge[] }>();
    const at = (date: string) => { let day = grouped.get(date); if (!day) grouped.set(date, day = { entries: [], charges: [] }); return day; };
    for (const entry of summary.entries) at(entry.date).entries.push(entry);
    for (const charge of summary.pastCharges) at(charge.date).charges.push(charge);
    return [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [summary]);
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
      ? <ChargeForm charge={c} busy={chargeBusy} onCancel={() => setConfirming(null)} onConfirm={amount => confirmCharge(c, amount)} />
      : <button type="button" className="ledger-entry__main" onClick={() => setConfirming(key)}>
          <span className="ledger-entry__icon" aria-hidden="true"><ArrowPathRoundedSquareIcon /></span>
          <span className="ledger-entry__name">{c.recurring.name}</span>
          <span className="ledger-entry__tag">고정·구독 자동</span>
          <span className="ledger-entry__amount">{won(c.amount)}</span>
        </button>}
  </li>; };


  const spending = <>{summary.reviewCount > 0 && <p className="ledger-review" role="status">확인할 기록 {summary.reviewCount}건</p>}
    {!days.length && <p className="ledger-empty">기록 없음</p>}
    {days.map(([date, day]) => <section key={date} className="ledger-day" aria-label={`${dotDate(date)} ${weekday(date)}`}>
      <header className="ledger-day__head">{dotDate(date)}</header><ul>{day.entries.map(entryRow)}{day.charges.map(chargeRow)}</ul>
    </section>)}
  </>;
  return <div className="ledger" onKeyDown={e => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); e.stopPropagation(); focusEntryRow(); }
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); setMonth(m => addMonths(m, e.key === 'ArrowLeft' ? -1 : 1)); }
  }}>
    {children}
    <div className="ledger-page">
      <div className="ledger-monthrow"><Button size="icon" variant="ghost" aria-label="이전 달" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeftIcon /></Button><h2>{monthLabel(month)}</h2><Button size="icon" variant="ghost" aria-label="다음 달" onClick={() => setMonth(addMonths(month, 1))}><ChevronRightIcon /></Button>
        {month !== currentMonth && <Button size="sm" variant="quiet" onClick={() => setMonth(currentMonth)}>이번 달로</Button>}<span className="ledger-spacer" />
        <Button size="sm" variant="quiet" onClick={() => setIncomeOpen(!incomeOpen)}>{base === null ? '예산 정하기' : `예산 ${won(base)}${summary.incomeDate ? ` · ${Number(summary.incomeDate.slice(8))}일` : ''}`}</Button>{actions}
      </div>
      {incomeOpen && <IncomeForm key={month} month={month} ledgerIncome={ledger.income ?? null} override={override} incomeDay={ledger.incomeDay ?? null} onSave={(income, only, day) => void saveIncome(income, only, day)} onCancel={() => setIncomeOpen(false)} />}
      {error && !editingRec && !editingPlan && <p className="ledger-problem" role="alert">{error}</p>}
      <LedgerContents ledger={ledger} summary={summary} all={entries} today={today} spending={spending}
        quickInput={<QuickEntry onSave={d => addEntry({ ...d, date: today, in: false })} />}
        onRecurring={r => { setError(null); setEditingRec(r?.id ?? 'new'); }} onPlan={p => { setError(null); setEditingPlan(p?.id ?? 'new'); }}
        onBuy={p => addEntry({ name: p.name, amount: p.amount, date: today, in: false }, { planned: p.id })}
        onKeepRecurring={id => saveLedger(c => ({ recurring: keepOnly(c.recurring ?? [], id) }))} onKeepPlan={id => saveLedger(c => ({ planned: keepOnly(c.planned ?? [], id) }))} />
    </div>
    {editingRec && <Dialog open title={recurring.find(r => r.id === editingRec)?.name ?? '구독 추가'} onClose={() => setEditingRec(null)}>
      <RecurringEditor key={editingRec} initial={recurring.find(r => r.id === editingRec)} today={today} error={error} onClose={() => setEditingRec(null)} onSave={d => saveRecurring(editingRec === 'new' ? null : editingRec, d)}
        onDelete={editingRec === 'new' ? undefined : () => saveLedger(c => ({ recurring: (c.recurring ?? []).filter(r => r.id !== editingRec) }))} />
    </Dialog>}
    {editingPlan && <Dialog open title={planned.find(p => p.id === editingPlan)?.name ?? '사고 싶은 것 추가'} onClose={() => setEditingPlan(null)}>
      <PlanEditor key={editingPlan} initial={planned.find(p => p.id === editingPlan)} month={month} error={error} onClose={() => setEditingPlan(null)} onSave={d => savePlan(editingPlan === 'new' ? null : editingPlan, d)}
        onDelete={editingPlan === 'new' ? undefined : () => saveLedger(c => ({ planned: (c.planned ?? []).filter(p => p.id !== editingPlan) }))} />
    </Dialog>}
  </div>;
}
