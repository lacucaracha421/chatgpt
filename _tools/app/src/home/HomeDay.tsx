import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowPathRoundedSquareIcon, ChevronRightIcon, PhotoIcon } from "@heroicons/react/24/outline";
import type { Note, NotesStore } from "../notes/store";
import { DAY_MEMO_MAX_CHARS, writeDayMemo } from "../notes/dayMemo";
import { displayDate } from "../shared/displayDate";
import { amountText } from "../notes/ledger/input";
import { sortEntries, type LedgerEntry, type Planned } from "../notes/ledger/model";
import { ledgerWriter } from "../notes/ledger/entryWrites";
import { parseWishEntry } from "../notes/ledger/presentation";
import { EntryForm } from "../notes/ledger/LedgerView";
import { QuickEntry } from "../notes/ledger/LedgerContents";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { DDay } from "../shared/ui/DDay";
import { EmptyState } from "../shared/ui/EmptyState";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import type { PaymentEvent } from "./homeCalendarModel";
import { HomePresence } from "./HomeAttention";
import { daysAfter } from "./homeModel";
import { ledgerLists, type MonthRelease, type SubscriptionRow } from "./homeMonthModel";
import { useDayFolds, type DayFold, type DayFolds } from "./homeDayFolds";
import { ReleaseKindMark, volumeDetail } from "./ReleaseKindMark";
import { holidayOn } from "./koreanHolidays";
import { Money } from "./HomeMonth";
import "./homeMonth.css";

export const DAY_MEMO_SAVE_DELAY = 800;
const SHORT_WEEKDAYS = "일월화수목금토";

type MemoProps = {
  date: string;
  store: NotesStore | null;
  /** The saved text of this day. */
  saved: string;
  /** The month note while another device's edit collided with ours. */
  conflict: Note | null;
  unavailable: boolean;
  syncing: boolean;
  onOpenNotes(): void;
  delay: number;
};

/**
 * One short memo for the day, written like 빠른 메모: saved while typing, on blur and when the day changes.
 * The text stays on screen until the notes store reports it back, so a save never flickers the old text.
 */
export function DayMemo({ date, store, saved, conflict, unavailable, syncing, onOpenNotes, delay }: MemoProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const save = (): Promise<void> => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (draftRef.current === null || !store) return Promise.resolve();
    return writeDayMemo(store, date, draftRef.current);
  };
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });
  // Changing the day (the panel is keyed by date) or leaving Home saves what is typed.
  useEffect(() => () => { void saveRef.current(); }, []);
  useEffect(() => {
    if (draft !== null && timer.current === undefined && (draft.trim() ? draft : "") === saved) { draftRef.current = null; setDraft(null); }
  }, [draft, saved]);
  const change = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveRef.current(), delay);
  };
  return <section className="home-attention-section" aria-label="메모">
    <SectionLabel title="메모" />
    <div>
      <textarea className="ui-text-input home-day__memo" rows={1} spellCheck={false} maxLength={DAY_MEMO_MAX_CHARS} aria-label={`${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일 메모`}
        placeholder={`${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일 메모`}
        value={draft ?? saved} disabled={unavailable} onChange={event => change(event.target.value)} onBlur={() => { void save().finally(() => store?.finish()); }} />
      {unavailable && <div className="home-qmemo__status" role="status">
        <span>메모를 열어야 쓸 수 있습니다</span>
        <Button variant="quiet" size="sm" onClick={onOpenNotes}>메모 열기</Button>
      </div>}
      {!unavailable && conflict && <div className="home-qmemo__status" role="status">
        <span>다른 기기 수정과 충돌했습니다.</span>
        <Button variant="quiet" size="sm" disabled={syncing || draft !== null} onClick={() => void store?.resolve(conflict, true)}>내 내용 보관 후 서버 버전 불러오기</Button>
      </div>}
    </div>
  </section>;
}

const entryTag = (entry: LedgerEntry) => entry.recurring ? (entry.amount === 0 ? "이번 달 건너뜀" : "고정·구독 확정") : entry.planned ? "계획" : entry.in ? "들어온 돈" : "";

/** The icon, name, tag and amount of one 가계부 entry row (the host decides whether the row is a button). */
export function EntryRowParts({ entry, hideAmounts }: { entry: LedgerEntry; hideAmounts: boolean }) {
  return <>
    <span className="ledger-entry__icon" aria-hidden="true">{entry.recurring ? <ArrowPathRoundedSquareIcon /> : entry.in ? "+" : null}</span>
    <span className="ledger-entry__name">{entry.name || (entry.in ? "들어온 돈" : "이름 없음")}</span>
    <span className="ledger-entry__tag">{entryTag(entry)}</span>
    <span className={`ledger-entry__amount${entry.in ? " is-in" : ""}`}>{entry.in ? "+" : ""}<Money amount={entry.amount} hidden={hideAmounts} symbol /></span>
  </>;
}

/** An unconfirmed subscription charge of the day: read-only, confirming stays in 메모 › 가계부. */
export function DayChargeRow({ payment, hideAmounts }: { payment: PaymentEvent; hideAmounts: boolean }) {
  return <div className="ledger-entry is-derived"><span className="ledger-entry__main" role="group" aria-label={`${payment.name} 결제 예정`}>
    <span className="ledger-entry__icon" aria-hidden="true"><ArrowPathRoundedSquareIcon /></span>
    <span className="ledger-entry__name">{payment.name}</span>
    <span className="ledger-entry__tag">{payment.kind === "trialEnd" ? "무료 끝남" : "고정·구독 자동"}</span>
    <span className="ledger-entry__amount">{payment.kind === "trialEnd" ? null : <Money amount={payment.amount} hidden={hideAmounts} symbol />}</span>
  </span></div>;
}

type LedgerProps = {
  date: string;
  store: NotesStore | null;
  /** The ledger Home writes to; null when the notes have none. */
  ledger: Note | null;
  unavailable: boolean;
  entries: LedgerEntry[];
  payments: PaymentEvent[];
  hideAmounts: boolean;
  onOpenNotes(): void;
};

/** The day's 가계부 rows with the 가계부's own quick entry and edit form; unconfirmed subscription charges are read-only. */
function DayLedger({ date, store, ledger, unavailable, entries, payments, hideAmounts, onOpenNotes }: LedgerProps) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [undo, setUndo] = useState<LedgerEntry | null>(null);
  const dismissUndo = useCallback(() => setUndo(null), []);
  useAutoDismiss(undo ? undo.id : null, dismissUndo);
  const writer = useMemo(() => store && ledger ? ledgerWriter(store, ledger.id, setError) : null, [store, ledger?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(() => setFresh(null), 1500);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const rows = sortEntries(entries);
  const charges = payments.filter(payment => payment.kind === "charge");
  const total = rows.filter(entry => !entry.in).reduce((sum, entry) => sum + entry.amount, 0) + charges.reduce((sum, payment) => sum + payment.amount, 0);
  const entryContent = (entry: LedgerEntry) => {
    if (editing === entry.id && writer) return <EntryForm label="기록 고치기" submitLabel="저장" month={date.slice(0, 7)}
      initial={{ date: entry.date, amount: amountText(entry.amount), name: entry.name, in: !!entry.in }}
      onSubmit={async draft => { if (!await writer.updateEntry(entry, draft)) return false; setEditing(null); return true; }}
      onCancel={() => setEditing(null)}
      onDelete={() => { if (writer.removeEntry(entry.id)) { setEditing(null); setUndo(entry); } }} />;
    const inner = <EntryRowParts entry={entry} hideAmounts={hideAmounts} />;
    // The edit form would show the amount, so privacy mode keeps the row read-only.
    return hideAmounts || !writer ? <span className="ledger-entry__main" role="group" aria-label={entry.name || "기록"}>{inner}</span>
      : <button type="button" className="ledger-entry__main" onClick={() => setEditing(entry.id)}>{inner}</button>;
  };
  const items = [
    ...rows.map(entry => ({ key: entry.id, content: <div className="ledger-entry" data-fresh={fresh === entry.id ? "" : undefined}>{entryContent(entry)}</div> })),
    ...payments.map(payment => ({ key: `charge:${payment.key}`, content: <DayChargeRow payment={payment} hideAmounts={hideAmounts} /> })),
  ];
  return <section className="home-attention-section" aria-label="가계부">
    <SectionLabel title="가계부" actions={items.length > 0 && !unavailable ? <span className="home-day__sum" aria-label="하루 합계"><Money amount={total} hidden={hideAmounts} symbol /></span> : undefined} />
    <div>
      {unavailable ? <div className="home-qmemo__status" role="status">
        <span>메모를 열어야 쓸 수 있습니다</span>
        <Button variant="quiet" size="sm" onClick={onOpenNotes}>메모 열기</Button>
      </div> : !ledger ? <div className="home-qmemo__status" role="status">
        <span>가계부가 없습니다</span>
        <Button variant="quiet" size="sm" onClick={onOpenNotes}>메모에서 만들기</Button>
      </div> : <>
        {items.length ? <div className="ledger-items home-day__rows"><HomePresence items={items} /></div>
          : <EmptyState inline className="ledger-empty" title="기록 없음" />}
        {error && <p className="ledger-problem" role="alert">{error}</p>}
        <QuickEntry label="이날 지출 빠른 입력" onSave={async draft => {
          if (!writer) return false;
          const id = crypto.randomUUID();
          const ok = await writer.addEntry({ ...draft, date, in: false }, { id });
          if (ok) setFresh(id);
          return ok;
        }} />
      </>}
    </div>
    {undo && writer && <Toast actionLabel="되돌리기" onAction={() => { void writer.restoreEntry(undo); setUndo(null); }} onDismiss={dismissUndo}>기록을 지웠습니다</Toast>}
  </section>;
}

type FoldProps = { title: string; count: number; open: boolean; onToggle(): void; children: ReactNode };

/** A list that stays folded until opened; the fold eases in and out (instantly under reduced motion). */
function DayFoldSection({ title, count, open, onToggle, children }: FoldProps) {
  const id = useId();
  return <section className="home-attention-section" aria-label={title}>
    <SectionLabel title={title} count={count} collapsible={{ open, onToggle, controls: id }} />
    <div id={id} className="home-fold" data-open={open} inert={!open}><div className="home-fold__inner">{children}</div></div>
  </section>;
}

export type DayListsProps = { store: NotesStore | null; ledger: Note; allEntries: LedgerEntry[]; today: string; hideAmounts: boolean; folds: DayFolds; onToggle(fold: DayFold): void };

/** Under the 가계부: every running subscription (read-only) and the things to buy, which can be added here (other edits stay in the 가계부 note). */
export function DayLedgerLists({ store, ledger, allEntries, today, hideAmounts, folds, onToggle }: DayListsProps) {
  const { subscriptions, wishes } = useMemo(() => ledgerLists(ledger, allEntries, today), [ledger, allEntries, today]);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const writer = useMemo(() => store ? ledgerWriter(store, ledger.id, setError) : null, [store, ledger.id]);
  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(() => setFresh(null), 1500);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  const now = new Date(`${today}T12:00:00`);
  const subscriptionRow = ({ item, next }: SubscriptionRow) => <div key={item.id} className="ledger-entry is-derived"><span className="ledger-entry__main">
    <span className="ledger-entry__icon" aria-hidden="true"><ArrowPathRoundedSquareIcon /></span>
    <span className="ledger-entry__name">{item.name}</span>
    <span className="ledger-entry__tag">{next ? displayDate(next.date, now) : item.until ? `${displayDate(item.until, now)}까지` : "결제 없음"}</span>
    <span className="ledger-entry__amount"><Money amount={next?.amount ?? item.amount} hidden={hideAmounts} symbol /></span>
  </span></div>;
  const when = (plan: Planned) => plan.month ? `${plan.month.slice(0, 4) === today.slice(0, 4) ? "" : `${plan.month.slice(0, 4)}년 `}${Number(plan.month.slice(5))}월` : "언젠가";
  const wishRow = (plan: Planned) => <div className="ledger-entry is-derived" data-fresh={fresh === plan.id ? "" : undefined}><span className="ledger-entry__main">
    <span className="ledger-entry__name">{plan.name}</span>
    <span className="ledger-entry__tag">{[plan.where, when(plan)].filter(Boolean).join(" · ")}</span>
    <span className="ledger-entry__amount">{plan.amount > 0 && <Money amount={plan.amount} hidden={hideAmounts} symbol />}</span>
  </span></div>;
  const addWish = async (draft: { name: string; amount: number }) => {
    if (!writer) return false;
    const before = new Set((ledger.planned ?? []).map(plan => plan.id));
    if (!writer.addPlan(draft)) return false;
    const added = store?.snapshot().notes.find(note => note.id === ledger.id)?.planned?.find(plan => !before.has(plan.id));
    if (added) setFresh(added.id);
    return true;
  };
  return <>
    <DayFoldSection title="모든 구독" count={subscriptions.length} open={folds.subscriptions} onToggle={() => onToggle("subscriptions")}>
      {subscriptions.length ? <div className="ledger-items">{subscriptions.map(subscriptionRow)}</div> : <EmptyState inline className="ledger-empty" title="구독 없음" />}
    </DayFoldSection>
    <DayFoldSection title="사고 싶은 것" count={wishes.length} open={folds.wishes} onToggle={() => onToggle("wishes")}>
      {wishes.length ? <div className="ledger-items"><HomePresence items={wishes.map(plan => ({ key: plan.id, content: wishRow(plan) }))} /></div> : <EmptyState inline className="ledger-empty" title="사고 싶은 것 없음" />}
      {error && <p className="ledger-problem" role="alert">{error}</p>}
      <QuickEntry label="사고 싶은 것 빠른 입력" placeholder="예: 키보드 120000" hint="이름을 적어 주세요. 금액은 뒤에 붙입니다. 예: 키보드 120000" parse={parseWishEntry} onSave={async draft => addWish(draft)} />
    </DayFoldSection>
  </>;
}

/** The day's releases as the Home release rows (shared with the tablet day sheet); nothing when there are none. */
export function DayReleases({ releases, today }: { releases: MonthRelease[]; today: string }) {
  if (!releases.length) return null;
  return <section className="home-attention-section" aria-label="발매">
    <SectionLabel title="발매" count={releases.length} />
    <div>{releases.map(release => <button type="button" key={release.key} className="home-arrival-row" onClick={release.onOpen}>
      {release.cover && <span className="home-arrival-cover">{release.cover}</span>}
      <span className="home-attention-copy"><span className="home-day__release-name"><ReleaseKindMark kind={release.kind} />{release.name}</span>{volumeDetail(release.detail) && <small>{volumeDetail(release.detail)}</small>}</span>
      {release.fresh ? <Badge variant="accent">NEW</Badge> : <DDay days={daysAfter(release.date, today)} />}
    </button>)}</div>
  </section>;
}

export type HomeDayProps = {
  date: string;
  today: string;
  releases: MonthRelease[];
  savedCount: number;
  hideAmounts: boolean;
  store: NotesStore | null;
  ledger: Note | null;
  /** The notes cannot be written now (not read yet, locked or without the keyring). */
  notesUnavailable: boolean;
  syncing: boolean;
  memo: string;
  memoNote: Note | null;
  entries: LedgerEntry[];
  /** Every record of the ledger (all months), to tell which things to buy are already bought. */
  allEntries: LedgerEntry[];
  payments: PaymentEvent[];
  panelRef: RefObject<HTMLElement | null>;
  memoDelay?: number;
  onToday(): void;
  onOpenSaved(): void;
  onOpenNotes(): void;
};

/** The day panel: always shown, today first. Its content is keyed by the date, so choosing another day swaps it in one step. */
export function HomeDay({ date, today, releases, savedCount, hideAmounts, store, ledger, notesUnavailable, syncing, memo, memoNote, entries, allEntries, payments, panelRef, memoDelay = DAY_MEMO_SAVE_DELAY, onToday, onOpenSaved, onOpenNotes }: HomeDayProps) {
  const weekday = SHORT_WEEKDAYS[new Date(`${date}T12:00:00`).getDay()];
  const holiday = holidayOn(date);
  const isToday = date === today;
  const [folds, toggleFold] = useDayFolds();
  return <aside className="home-day" aria-label={`${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일 (${weekday})${holiday ? ` ${holiday}` : ""}`} ref={panelRef}>
    <header className="home-day__head">
      <h3 className="home-day__title">{Number(date.slice(5, 7))}월 {Number(date.slice(8))}일 <span>({weekday}){holiday && ` ${holiday}`}</span></h3>
      {isToday ? <Badge variant="accent" className="ui-dday">오늘</Badge> : <button type="button" className="home-link" onClick={onToday}>오늘로</button>}
    </header>
    <div className="home-day__body" key={date}>
      <div className="home-day__col">
        {savedCount > 0 && <button type="button" className="home-attention-row home-day__saved" onClick={onOpenSaved}>
          <span className="home-attention-mark" aria-hidden="true"><PhotoIcon /></span>
          <span className="home-attention-copy"><span>저장한 이미지</span></span>
          <span className="home-attention-value numeric">{savedCount.toLocaleString()}장</span>
          <ChevronRightIcon aria-hidden="true" />
        </button>}
        <DayReleases releases={releases} today={today} />
      </div>
      <div className="home-day__col">
        <DayMemo date={date} store={store} saved={memo} conflict={memoNote?.conflict ? memoNote : null} unavailable={notesUnavailable} syncing={syncing} onOpenNotes={onOpenNotes} delay={memoDelay} />
      </div>
      <div className="home-day__col">
        <DayLedger date={date} store={store} ledger={ledger} unavailable={notesUnavailable} entries={entries} payments={payments} hideAmounts={hideAmounts} onOpenNotes={onOpenNotes} />
        {ledger && !notesUnavailable && <DayLedgerLists store={store} ledger={ledger} allEntries={allEntries} today={today} hideAmounts={hideAmounts} folds={folds} onToggle={toggleFold} />}
      </div>
    </div>
  </aside>;
}

