import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
import { PinIcon, PinSolidIcon } from '../src/shared/ui/PinIcon';
import {Button, EmptyState, IconButton} from './ui';
import { keyBetween } from '../src/notes/model';
import type { Note, NotesStore } from '../src/notes/store';
import { addMonths, localToday } from '../src/notes/ledger/cycle';
import { forkedIds, keepOnly, ledgerLimitProblem, ledgerSizeProblem, monthLabel, won, type LedgerEntry, type Planned, type Recurring } from '../src/notes/ledger/model';
import { dotDate } from '../src/notes/ledger/input';
import { ledgerEntries, monthNotesOf, monthSummary, type Charge } from '../src/notes/ledger/summary';
import { LedgerContents, QuickEntry } from '../src/notes/ledger/LedgerContents';
import { EntrySheet, IncomeSheet, RecurringSheet, PlanSheet, ChargeSheet, type EntryDraft, type LedgerItemPatch } from './NoteLedgerSheets';
import '../src/notes/ledger/ledger.css';
import './ledger.css';

type LedgerSheet = { kind: 'entry'; draft: EntryDraft } | { kind: 'income' } | { kind: 'recurring'; item: Recurring | null } | { kind: 'plan'; item: Planned | null } | { kind: 'charge'; charge: Charge } | null;
const nextOrder = (list: { order: string }[]) => keyBetween(list.reduce<string | null>((max, item) => max === null || item.order > max ? item.order : max, null), null);

export function NoteLedger({ store, ledger, notes, saveState, onLeave, onMore, backRef }: { store: NotesStore; ledger: Note; notes: Note[]; saveState: string; onLeave(): void; onMore(): void; backRef: MutableRefObject<(() => boolean) | null> }) {
  const today = localToday(), current = today.slice(0, 7);
  const [month, setMonth] = useState(current), [sheet, setSheet] = useState<LedgerSheet>(null), [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { backRef.current = () => { if (sheet) { setSheet(null); return true; } return false; }; return () => { backRef.current = null; }; });
  const monthNotes = useMemo(() => monthNotesOf(notes, ledger.id), [notes, ledger.id]);
  const all = useMemo(() => ledgerEntries(monthNotes), [monthNotes]);
  const summary = monthSummary(ledger, monthNotes, month, today, all);
  const recurring = ledger.recurring ?? [], planned = ledger.planned ?? [];
  const names = [...new Set(all.map(e => e.name.trim()).filter(Boolean))];
  const openSheet = (next: LedgerSheet) => { setProblem(null); setSheet(next); };
  // ---- Writes. The latest store copy is edited, so several quick writes never drop one another.
  const latest=(id:string)=>store.snapshot().notes.find(n=>n.id===id);
  const fail=(reason:unknown)=>{setProblem(typeof reason==='string'?reason:'가계부를 저장하지 못했습니다.');return false;};
  function write(note:Note|undefined,change:Partial<Note>):boolean {
    if(!note)return fail(null);
    const next={...note,...change};const limit=ledgerLimitProblem(next)??ledgerSizeProblem(next);
    if(limit)return fail(limit);
    setProblem(null);store.edit(next);return true;
  }
  const editLedger=(change:(ledger:Note)=>Partial<Note>)=>{const note=latest(ledger.id);return !!note&&write(note,change(note));};
  /** Writes the month note of `month` (created on first use; its id is derived natively). */
  async function editMonth(target:string,change:(note:Note)=>Partial<Note>):Promise<string|null> {
    try{const id=await store.ledgerMonth(ledger.id,target);const note=latest(id);return note&&write(note,change(note))?id:null;}catch(reason){fail(reason);return null;}
  }
  const monthNotesNow=()=>monthNotesOf(store.snapshot().notes,ledger.id);
  /** Saves into the month of its date, then removes older copies (a moved date or a keep-both month). */
  async function saveEntry(entry:LedgerEntry):Promise<boolean> {
    const id=await editMonth(entry.date.slice(0,7),note=>({entries:[...(note.entries??[]).filter(e=>e.id!==entry.id),entry]}));
    if(!id)return false;
    for(const note of monthNotesNow())if(note.id!==id&&(note.entries??[]).some(e=>e.id===entry.id))write(note,{entries:note.entries!.filter(e=>e.id!==entry.id)});
    return true;
  }
  function deleteEntry(entryId:string){for(const note of monthNotesNow())if((note.entries??[]).some(e=>e.id===entryId))write(note,{entries:note.entries!.filter(e=>e.id!==entryId)});}
  function keepEntry(entryId:string){for(const note of monthNotesNow()){const list=note.entries??[];const kept=keepOnly(list,entryId);if(kept!==list&&JSON.stringify(kept)!==JSON.stringify(list))write(note,{entries:kept});}}
  function saveRecurring(patch:LedgerItemPatch<Recurring>) {
    const note=latest(ledger.id);if(!note)return fail(null);
    const list=note.recurring??[],item=list.find(r=>r.id===patch.id);
    if(!item&&!patch.order)return fail('다른 기기에서 삭제된 구독입니다.');
    return write(note,{recurring:item?list.map(r=>r.id===patch.id?{...r,...patch}:r):[...list,patch as Recurring]});
  }
  function savePlan(patch:LedgerItemPatch<Planned>) {
    const note=latest(ledger.id);if(!note)return fail(null);
    const list=note.planned??[],item=list.find(p=>p.id===patch.id);
    if(!item&&!patch.order)return fail('다른 기기에서 삭제된 항목입니다.');
    return write(note,{planned:item?list.map(p=>p.id===patch.id?{...p,...patch}:p):[...list,patch as Planned]});
  }
  async function saveIncome(scope:'default'|'month',amount:number|null,incomeDay:number|null){
    const day=incomeDay!==(ledger.incomeDay??null)?{incomeDay}:{};
    if(scope==='default')return editLedger(()=>({income:amount,...day}));
    if('incomeDay' in day&&!editLedger(()=>day))return false;
    return !!await editMonth(month,()=>({income:amount}));
  }

  const forks = forkedIds(all);
  const monthIncome = monthNotes.find(n => n.month === month && n.income != null)?.income ?? null;
  const spending = <>{summary.reviewCount > 0 && <p className="ledger-review" role="status">확인할 기록 {summary.reviewCount}건</p>}
    <ul className="ledger-items">{summary.entries.map(e => <li key={e.id}><button type="button" className="ledger-spending-row" onClick={() => openSheet({ kind: 'entry', draft: e })}><span>{dotDate(e.date)}</span><strong>{e.name || '이름 없음'}</strong><span>{e.in ? '+' : ''}{won(e.amount)}</span></button>{forks.has(e.id) && <div className="ledger-conflict">두 기기에서 다르게 고침 <Button size="sm" variant="quiet" onClick={() => keepEntry(e.id)}>이것만 남기기</Button></div>}</li>)}</ul>
    {summary.pastCharges.map(c => <button type="button" key={`${c.recurring.id}:${c.date}`} className="ledger-spending-row is-derived" onClick={() => openSheet({ kind: 'charge', charge: c })}><span>{dotDate(c.date)}</span><strong>{c.recurring.name}</strong><span>{won(c.amount)}</span></button>)}
    {!summary.entries.length && !summary.pastCharges.length && <EmptyState inline className="ledger-empty" title="기록 없음" />}
    <Button size="sm" variant="quiet" onClick={() => openSheet({ kind: 'entry', draft: {} })}>기록</Button>
  </>;
  return <div className="ledger-view">
    <header className="notes-top is-sub"><IconButton label="메모 목록" icon={ArrowLeftIcon} onClick={onLeave} /><h1>{ledger.title.trim() || '가계부'}</h1><span className="notes-top__space" /><span role="status" className="notes-save-state">{saveState}</span><IconButton label={ledger.pinned ? "고정 해제" : "고정"} icon={PinIcon} activeIcon={PinSolidIcon} active={ledger.pinned} onClick={() => editLedger(l => ({ pinned: !l.pinned }))} /><IconButton label="메모 더보기" icon={EllipsisHorizontalIcon} onClick={onMore} /></header>
    <div className="ledger-page">
      <div className="ledger-monthrow"><IconButton label="이전 달" icon={ChevronLeftIcon} onClick={() => setMonth(addMonths(month, -1))} /><h2>{monthLabel(month)}</h2><IconButton label="다음 달" icon={ChevronRightIcon} onClick={() => setMonth(addMonths(month, 1))} />{month !== current && <Button size="sm" variant="quiet" onClick={() => setMonth(current)}>이번 달로</Button>}<span className="ledger-spacer" /><Button size="sm" variant="quiet" onClick={() => openSheet({ kind: 'income' })}>예산 정하기</Button></div>
      {problem && !sheet && <p className="ledger-problem" role="alert">{problem}</p>}
      <LedgerContents ledger={ledger} summary={summary} all={all} today={today} spending={spending} quickInput={<QuickEntry onSave={d => saveEntry({ ...d, date: today, id: crypto.randomUUID(), createdAt: new Date().toISOString() })} />}
        onRecurring={item => openSheet({ kind: 'recurring', item })} onPlan={item => openSheet({ kind: 'plan', item })}
        onBuy={p => saveEntry({ id: crypto.randomUUID(), date: today, name: p.name, amount: p.amount, planned: p.id, createdAt: new Date().toISOString() })}
        onKeepRecurring={id => editLedger(l => ({ recurring: keepOnly(l.recurring ?? [], id) }))} onKeepPlan={id => editLedger(l => ({ planned: keepOnly(l.planned ?? [], id) }))} />
    </div>
    {sheet?.kind === 'entry' && <EntrySheet key={sheet.draft.id ?? 'new'} initial={sheet.draft} names={names} error={problem} onSave={saveEntry} onClose={() => setSheet(null)} onDelete={sheet.draft.id ? () => { deleteEntry(sheet.draft.id!); setSheet(null); } : undefined} />}
    {sheet?.kind === 'income' && <IncomeSheet month={month} monthIncome={monthIncome} defaultIncome={ledger.income ?? null} incomeDay={ledger.incomeDay ?? null} error={problem} onSave={saveIncome} onClose={() => setSheet(null)} />}
    {sheet?.kind === 'recurring' && <RecurringSheet initial={sheet.item} order={nextOrder(recurring)} error={problem} onSave={saveRecurring} onClose={() => setSheet(null)} onDelete={sheet.item ? () => editLedger(l => ({ recurring: (l.recurring ?? []).filter(r => r.id !== sheet.item!.id) })) : undefined} />}
    {sheet?.kind === 'plan' && <PlanSheet initial={sheet.item} month={month} order={nextOrder(planned)} error={problem} onSave={savePlan} onClose={() => setSheet(null)} onDelete={sheet.item ? () => editLedger(l => ({ planned: (l.planned ?? []).filter(p => p.id !== sheet.item!.id) })) : undefined} />}
    {sheet?.kind === 'charge' && <ChargeSheet name={sheet.charge.recurring.name} date={sheet.charge.date} amount={sheet.charge.amount} error={problem} onClose={() => setSheet(null)} onConfirm={() => openSheet({ kind: 'entry', draft: { name: sheet.charge.recurring.name, amount: sheet.charge.amount, date: sheet.charge.date, recurring: { id: sheet.charge.recurring.id, date: sheet.charge.date } } })} onSkip={async () => { if (await saveEntry({ id: crypto.randomUUID(), date: sheet.charge.date, name: sheet.charge.recurring.name, amount: 0, recurring: { id: sheet.charge.recurring.id, date: sheet.charge.date }, createdAt: new Date().toISOString() })) setSheet(null); }} />}
  </div>;
}
