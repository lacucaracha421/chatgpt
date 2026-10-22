import {useEffect, useMemo, useState} from 'react';
import {ChevronRightIcon, PhotoIcon, PlusIcon} from '@heroicons/react/24/outline';
import type {Note, NotesStore} from '../../src/notes/store';
import {sortEntries, type LedgerEntry} from '../../src/notes/ledger/model';
import {ledgerWriter} from '../../src/notes/ledger/entryWrites';
import {QuickEntry} from '../../src/notes/ledger/LedgerContents';
import {DayChargeRow, DayLedgerLists, DayMemo, DayReleases, EntryRowParts, DAY_MEMO_SAVE_DELAY} from '../../src/home/HomeDay';
import {useDayFolds} from '../../src/home/homeDayFolds';
import {holidayOn} from '../../src/home/koreanHolidays';
import {Money} from '../../src/home/HomeMonth';
import type {PaymentEvent} from '../../src/home/homeCalendarModel';
import type {MonthRelease} from '../../src/home/homeMonthModel';
import {BottomSheet} from '../BottomSheet';
import {EntrySheet} from '../NoteLedgerSheets';
import {Badge, Button, EmptyState, SectionLabel} from '../ui';

import '../../src/notes/ledger/ledger.css';
import '../ledger.css';

const SHORT_WEEKDAYS = '일월화수목금토';

export type TabletDaySheetProps = {
  date: string;
  today: string;
  releases: MonthRelease[];
  /** Images saved on this day; the row shows only above zero. */
  savedCount: number;
  hideAmounts: boolean;
  store: NotesStore | null;
  /** The ledger Home writes to; null when the notes have none. */
  ledger: Note | null;
  /** The notes cannot be written now (not read yet, locked or without the keyring). */
  notesUnavailable: boolean;
  syncing: boolean;
  memo: string;
  memoNote: Note | null;
  entries: LedgerEntry[];
  /** Every record of the ledger (all months): recent names, and which things to buy are already bought. */
  allEntries: LedgerEntry[];
  payments: PaymentEvent[];
  memoDelay?: number;
  onOpenNotes(): void;
  /** Opens the library (the tablet has no date filter yet, so all Assets, as on the PC). */
  onOpenSaved(): void;
  onClose(): void;
};

type LedgerProps = Pick<TabletDaySheetProps, 'date' | 'store' | 'ledger' | 'entries' | 'allEntries' | 'payments' | 'hideAmounts' | 'onOpenNotes'> & {unavailable: boolean};

/**
 * The day's 가계부 on the tablet: the shared rows, the 가계부's own quick input, and its entry sheet (number pad)
 * for adding or fixing a record, stacked above this sheet. Unconfirmed subscription charges are read-only.
 */
function TabletDayLedger({date, store, ledger, unavailable, entries, allEntries, payments, hideAmounts, onOpenNotes}: LedgerProps) {
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Partial<LedgerEntry> | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const writer = useMemo(() => store && ledger ? ledgerWriter(store, ledger.id, setError) : null, [store, ledger?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(() => setFresh(null), 1500);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const rows = sortEntries(entries);
  const charges = payments.filter(payment => payment.kind === 'charge');
  const total = rows.filter(entry => !entry.in).reduce((sum, entry) => sum + entry.amount, 0) + charges.reduce((sum, payment) => sum + payment.amount, 0);
  const names = useMemo(() => [...new Set(allEntries.map(entry => entry.name.trim()).filter(Boolean))], [allEntries]);
  const hasRows = rows.length > 0 || payments.length > 0;
  const openSheet = (draft: Partial<LedgerEntry>) => { setError(null); setSheet(draft); };
  const save = async (entry: LedgerEntry) => {
    if (!writer) return false;
    const draft = {date: entry.date, amount: entry.amount, name: entry.name, in: !!entry.in};
    const old = entries.find(row => row.id === entry.id);
    return old ? writer.updateEntry(old, draft) : writer.addEntry(draft, {id: entry.id, createdAt: entry.createdAt});
  };
  const status = (text: string, action: string) => <div className="home-qmemo__status" role="status">
    <span>{text}</span>
    <Button variant="quiet" size="sm" onClick={onOpenNotes}>{action}</Button>
  </div>;
  return <section className="home-attention-section" aria-label="가계부">
    <SectionLabel title="가계부" actions={hasRows && !unavailable && ledger ? <span className="home-day__sum" aria-label="하루 합계"><Money amount={total} hidden={hideAmounts} symbol /></span> : undefined} />
    <div>
      {unavailable ? status('메모를 열어야 쓸 수 있습니다', '메모 열기') : !ledger ? status('가계부가 없습니다', '메모에서 만들기') : <>
        {hasRows ? <div className="ledger-items home-day__rows">
          {rows.map(entry => <div key={entry.id} className="ledger-entry" data-fresh={fresh === entry.id ? '' : undefined}>
            {/* The edit sheet would show the amount, so privacy mode keeps the row read-only. */}
            {hideAmounts ? <span className="ledger-entry__main" role="group" aria-label={entry.name || '기록'}><EntryRowParts entry={entry} hideAmounts /></span>
              : <button type="button" className="ledger-entry__main" onClick={() => openSheet(entry)}><EntryRowParts entry={entry} hideAmounts={false} /></button>}
          </div>)}
          {payments.map(payment => <DayChargeRow key={payment.key} payment={payment} hideAmounts={hideAmounts} />)}
        </div> : <EmptyState inline className="ledger-empty" title="기록 없음" />}
        {error && !sheet && <p className="ledger-problem" role="alert">{error}</p>}
        <QuickEntry label="이날 지출 빠른 입력" onSave={async draft => {
          if (!writer) return false;
          const id = crypto.randomUUID();
          const ok = await writer.addEntry({...draft, date, in: false}, {id});
          if (ok) setFresh(id);
          return ok;
        }} />
        <Button variant="ghost" className="home-day__add" onClick={() => openSheet({date})}><PlusIcon aria-hidden="true" />기록 추가</Button>
      </>}
    </div>
    {sheet && writer && <EntrySheet key={sheet.id ?? 'new'} initial={sheet} names={names} error={error} onSave={save} onClose={() => setSheet(null)}
      onDelete={sheet.id ? () => { if (writer.removeEntry(sheet.id!)) setSheet(null); } : undefined} />}
  </section>;
}

/**
 * The tablet's day view (HOME-CAL-001): the PC day panel's sections in the existing bottom sheet. It is keyed by the
 * date by its host, so the memo of one day is saved when the sheet closes and never mixes with another day.
 */
export function TabletDaySheet({date, today, releases, savedCount, hideAmounts, store, ledger, notesUnavailable, syncing, memo, memoNote, entries, allEntries, payments, memoDelay = DAY_MEMO_SAVE_DELAY, onOpenNotes, onOpenSaved, onClose}: TabletDaySheetProps) {
  const [folds, toggleFold] = useDayFolds();
  const month = Number(date.slice(5, 7)), day = Number(date.slice(8));
  const weekday = SHORT_WEEKDAYS[new Date(`${date}T12:00:00`).getDay()];
  const holiday = holidayOn(date);
  return <BottomSheet title={`${month}월 ${day}일 (${weekday})${holiday ? ` ${holiday}` : ''}`} onClose={onClose}
    heading={<span className="home-day-sheet__title">{month}월 {day}일 <span>({weekday}){holiday && ` ${holiday}`}</span>{date === today && <Badge variant="accent">오늘</Badge>}</span>}>
    <div className="home-day home-day-sheet">
      {savedCount > 0 && <button type="button" className="home-attention-row home-day__saved" onClick={onOpenSaved}>
        <span className="home-attention-mark" aria-hidden="true"><PhotoIcon /></span>
        <span className="home-attention-copy"><span>저장한 이미지</span></span>
        <span className="home-attention-value numeric">{savedCount.toLocaleString()}장</span>
        <ChevronRightIcon aria-hidden="true" />
      </button>}
      <DayReleases releases={releases} today={today} />
      <DayMemo date={date} store={store} saved={memo} conflict={memoNote?.conflict ? memoNote : null} unavailable={notesUnavailable} syncing={syncing} onOpenNotes={onOpenNotes} delay={memoDelay} />
      <TabletDayLedger date={date} store={store} ledger={ledger} unavailable={notesUnavailable} entries={entries} allEntries={allEntries} payments={payments} hideAmounts={hideAmounts} onOpenNotes={onOpenNotes} />
      {ledger && !notesUnavailable && <DayLedgerLists store={store} ledger={ledger} allEntries={allEntries} today={today} hideAmounts={hideAmounts} folds={folds} onToggle={toggleFold} />}
    </div>
  </BottomSheet>;
}
