import { useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Field, TextInput } from '../../shared/ui/TextInput';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { displayDate } from '../../shared/displayDate';
import { localToday } from './cycle';
import { amountText, parseAmount } from './input';
import { isDate, isMonth, LEDGER_LIMITS, won, type Planned, type Recurring, type LedgerUnit } from './model';
import { cancellationDate, priceChange, shiftDateMonths, trialMonths } from './presentation';

type Saved = boolean | Promise<boolean>;
export type RecurringChanges = Partial<Recurring>;
export type PlanChanges = Partial<Planned>;

/** Optional slice-A fields enter the patch only when the user changes that control. */
export function RecurringEditor({ initial, today = localToday(), onSave, onClose, onDelete, error }: {
  initial?: Recurring | null; today?: string; onSave(changes: RecurringChanges): Saved; onClose(): void; onDelete?(): Saved; error?: string | null;
}) {
  const [name, setName] = useState(initial?.name ?? ''), [amount, setAmount] = useState(amountText(initial?.amount));
  const [every, setEvery] = useState(String(initial?.every ?? 1)), [unit, setUnit] = useState<LedgerUnit>(initial?.unit ?? 'month');
  const [start, setStart] = useState(initial?.start ?? today), [trial, setTrial] = useState(initial?.trial ?? false);
  const [from, setFrom] = useState(initial?.trialFrom ?? today), [months, setMonths] = useState(String(initial ? trialMonths(initial) ?? 1 : 1));
  const [trialChanged, setTrialChanged] = useState(false), [remind, setRemind] = useState(String(initial?.remindDays ?? ''));
  const [remindChanged, setRemindChanged] = useState(false), [until, setUntil] = useState(initial?.until ?? null), [memo, setMemo] = useState(initial?.memo ?? '');
  const [changingPrice, setChangingPrice] = useState(false), [effective, setEffective] = useState(today), [problem, setProblem] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), composing = useRef(false);
  const cycle = unit === 'month' ? every === '1' ? 'monthly' : 'months' : unit === 'year' && every === '1' ? 'yearly' : 'legacy';
  async function save() {
    if (lock.current || composing.current) return;
    const parsed = parseAmount(amount), n = Number(every), freeMonths = Number(months);
    const fail = (message: string) => setProblem(message);
    if (!name.trim() || Array.from(name.trim()).length > LEDGER_LIMITS.nameChars) return fail('이름은 1~100자로 적어 주세요.');
    if (!parsed || parsed.in) return fail('가격은 0 이상의 정수로 적어 주세요.');
    if (!isDate(start) || !Number.isInteger(n) || n < 1 || n > 120) return fail('가격, 주기와 첫 결제일을 확인해 주세요.');
    if (trialChanged && trial && (!isDate(from) || from >= start || !Number.isInteger(freeMonths) || freeMonths < 1 || freeMonths > 120)) return fail('무료 기간과 시작일을 확인해 주세요.');
    let patch: RecurringChanges = { name: name.trim(), amount: parsed.amount, every: n, unit, start, trial, until, memo };
    if (trialChanged) patch.trialFrom = trial ? from : null;
    if (remindChanged) patch.remindDays = remind === '' ? null : Number(remind);
    if (initial && parsed.amount !== initial.amount) {
      const change = priceChange(initial, parsed.amount, effective);
      if (!change) return fail('적용일은 마지막 가격 변경일보다 뒤여야 합니다. 가격 이력은 24개까지 저장할 수 있습니다.');
      patch = { ...patch, ...change };
    }
    if (initial) for (const key of Object.keys(patch)) if (patch[key] === initial[key]) delete patch[key];
    lock.current = true; setBusy(true); setProblem('');
    try { if (await onSave(patch)) onClose(); } finally { lock.current = false; setBusy(false); }
  }
  function freePeriod(nextFrom: string, nextMonths: string) {
    setFrom(nextFrom); setMonths(nextMonths); setTrialChanged(true);
    if (isDate(nextFrom) && Number.isInteger(Number(nextMonths)) && Number(nextMonths) >= 1 && Number(nextMonths) <= 120) setStart(shiftDateMonths(nextFrom, Number(nextMonths)));
  }
  const histories = initial?.priceHistory ?? [];
  return <div className="ledger-editor" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !e.nativeEvent.isComposing && e.keyCode !== 229 && !composing.current) { e.preventDefault(); void save(); }
  }}>
    <Field label="이름"><TextInput value={name} placeholder="넷플릭스, 월세, 보험…" onChange={e => setName(e.target.value)} /></Field>
    <div className="ledger-editor-field"><span>주기</span><SegmentedControl label="주기" value={cycle} options={[{ value: 'monthly', label: '매달' }, { value: 'months', label: 'N달마다' }, { value: 'yearly', label: '1년' }, ...(cycle === 'legacy' ? [{ value: 'legacy', label: `${every}${unit === 'week' ? '주' : '년'}마다` }] : [])]} onChange={v => {
      if (v === cycle || v === 'legacy') return;
      setUnit(v === 'yearly' ? 'year' : 'month'); setEvery(v === 'months' ? '3' : '1');
    }} /></div>
    {(cycle === 'months' || cycle === 'legacy') && <Field label="주기 간격"><TextInput inputMode="numeric" value={every} onChange={e => setEvery(e.target.value)} /></Field>}
    <div className="ledger-editor-field"><span>시작</span><SegmentedControl label="시작" value={trial ? 'free' : 'paid'} options={[{ value: 'free', label: `처음 ${months}달 무료` }, { value: 'paid', label: '바로 결제' }]} onChange={v => {
      if ((v === 'free') === trial) return;
      setTrial(v === 'free'); setTrialChanged(true); if (v === 'free') freePeriod(from, months); else setStart(from);
    }} /></div>
    {trial && <div className="ledger-editor-pair"><Field label="무료 시작일"><TextInput type="date" value={from} onChange={e => freePeriod(e.target.value, months)} /></Field><Field label="무료 개월"><TextInput inputMode="numeric" value={months} onChange={e => freePeriod(from, e.target.value)} /></Field></div>}
    {initial && !changingPrice ? <div className="ledger-editor-field"><span>가격</span><b>{won(initial.amount)}</b><Button size="sm" variant="quiet" onClick={() => setChangingPrice(true)}>가격 바꾸기</Button></div> : <Field label="가격"><TextInput inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} /></Field>}
    {changingPrice && <Field label="가격 적용일"><TextInput type="date" value={effective} onChange={e => setEffective(e.target.value)} /></Field>}
    {histories.map((h, index) => <p className="ledger-price-history" key={h.until}>{displayDate(h.until)}에 {won(h.amount)}에서 {(histories[index + 1]?.amount ?? initial!.amount) >= h.amount ? '올림' : '내림'}</p>)}
    <Field label="첫 결제"><TextInput type="date" value={start} onChange={e => { setStart(e.target.value); }} /></Field>
    <Field label="알림"><select className="ui-text-input" value={remind} onChange={e => { setRemind(e.target.value); setRemindChanged(true); }}><option value="">없음</option>{[1, 3, 7].map(d => <option key={d} value={d}>{d}일 전</option>)}{remind !== '' && !['1', '3', '7'].includes(remind) && <option value={remind}>{remind}일 전</option>}</select></Field>
    <Field label="해지"><select className="ui-text-input" value={until === null ? 'continue' : until === today ? 'now' : 'scheduled'} onChange={e => setUntil(e.target.value === 'continue' ? null : e.target.value === 'now' ? today : cancellationDate({ ...(initial ?? {}), name, amount: parseAmount(amount)?.amount ?? 0, every: Number(every), unit, start, trial, until: null, memo, id: initial?.id ?? '', order: initial?.order ?? '' }, today))}><option value="continue">계속</option><option value="scheduled">갱신 전에 해지 예약</option><option value="now">바로 끝남</option></select></Field>
    {until && <p className="ledger-price-history">{displayDate(until)}부터 결제 없음</p>}
    <Field label="메모"><TextInput value={memo} placeholder="선택" maxLength={LEDGER_LIMITS.memoChars} onChange={e => setMemo(e.target.value)} /></Field>
    {(problem || error) && <p className="ledger-problem" role="alert">{problem || error}</p>}
    <div className="ledger-editor-actions">{onDelete && <Button variant="ghost" disabled={busy} onClick={async () => { if (await onDelete()) onClose(); }}>삭제</Button>}<Button variant="ghost" onClick={onClose}>닫기</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>저장</Button></div>
  </div>;
}

export function PlanEditor({ initial, month, onSave, onClose, onDelete, error }: { initial?: Planned | null; month: string; onSave(changes: PlanChanges): Saved; onClose(): void; onDelete?(): Saved; error?: string | null }) {
  const [name, setName] = useState(initial?.name ?? ''), [amount, setAmount] = useState(amountText(initial?.amount ?? 0)), [when, setWhen] = useState(initial ? initial.month ?? '' : month), [memo, setMemo] = useState(initial?.memo ?? '');
  const [where, setWhere] = useState(initial?.where ?? ''), [priority, setPriority] = useState(String(initial?.priority ?? 1)), [whereChanged, setWhereChanged] = useState(false), [priorityChanged, setPriorityChanged] = useState(false);
  const [problem, setProblem] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), composing = useRef(false);
  async function save(dropped = initial?.dropped ?? false) {
    if (lock.current || composing.current) return;
    const parsed = parseAmount(amount);
    if (!parsed || parsed.in) { setProblem('가격은 0 이상의 정수로 적어 주세요.'); return; }
    if (!name.trim() || Array.from(name.trim()).length > 100 || (when && !isMonth(when)) || Array.from(where).length > 100) { setProblem('이름, 가격, 구매처와 달을 확인해 주세요.'); return; }
    const patch: PlanChanges = { name: name.trim(), amount: parsed.amount, month: when || null, memo, dropped };
    if (whereChanged) patch.where = where;
    if (priorityChanged) patch.priority = Number(priority);
    if (initial) for (const key of Object.keys(patch)) if (patch[key] === initial[key]) delete patch[key];
    lock.current = true; setBusy(true); setProblem('');
    try { if (await onSave(patch)) onClose(); } finally { lock.current = false; setBusy(false); }
  }
  return <div className="ledger-editor" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <Field label="이름"><TextInput value={name} placeholder="사고 싶은 것" onChange={e => setName(e.target.value)} /></Field>
    <Field label="가격"><TextInput inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
    <Field label="구매처"><TextInput value={where} onChange={e => { setWhere(e.target.value); setWhereChanged(true); }} /></Field>
    <Field label="우선순위"><select className="ui-text-input" value={priority} onChange={e => { setPriority(e.target.value); setPriorityChanged(true); }}><option value="0">없음</option><option value="1">★</option><option value="2">★★</option></select></Field>
    <Field label="목표 달"><TextInput type="month" value={when} onChange={e => setWhen(e.target.value)} /></Field><Button size="sm" variant="quiet" onClick={() => setWhen('')}>언젠가</Button>
    <Field label="메모"><TextInput value={memo} maxLength={500} onChange={e => setMemo(e.target.value)} /></Field>
    {(problem || error) && <p className="ledger-problem" role="alert">{problem || error}</p>}
    <div className="ledger-editor-actions">{onDelete && <Button variant="ghost" disabled={busy} onClick={async () => { if (await onDelete()) onClose(); }}>삭제</Button>}{initial && <Button variant="ghost" disabled={busy} onClick={() => void save(!initial.dropped)}>{initial.dropped ? '다시 사기로' : '안 사기로 함'}</Button>}<Button variant="ghost" onClick={onClose}>닫기</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>저장</Button></div>
  </div>;
}
