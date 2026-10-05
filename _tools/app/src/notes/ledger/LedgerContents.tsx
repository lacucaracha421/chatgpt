import { EmptyState } from "../../shared/ui/EmptyState";
import { useHorizontalWheel } from "../../shared/ui/useHorizontalWheel";
import { useRef, useState, type ReactNode } from 'react';
import { Badge } from '../../shared/ui/Badge';
import { DDay } from '../../shared/ui/DDay';
import { Button } from '../../shared/ui/Button';
import { TextInput } from '../../shared/ui/TextInput';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { chargeAmount, inTrial, isEnded, monthlyEquivalent, nextCharge } from './cycle';
import { displayDate } from '../../shared/displayDate';
import { forkedIds, sortRecurring, signedWon, won, type LedgerEntry, type Planned, type Recurring } from './model';
import { donePlans, type LedgerLike, type MonthSummary } from './summary';
import { budgetFigures, monthlyEvents, parseQuickEntry, subscriptionPills } from './presentation';

export function QuickEntry({ onSave }: { onSave(value: { name: string; amount: number }): Promise<boolean> }) {
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const composing = useRef(false), saving = useRef(false);
  async function save() {
    if (composing.current || saving.current) return;
    const submitted = text;
    const parsed = parseQuickEntry(submitted);
    if (!parsed) { setError('이름과 금액을 적어 주세요. 예: 점심 8000'); return; }
    saving.current = true; setBusy(true); setError('');
    try { if (await onSave(parsed)) setText(current => current === submitted ? '' : current); } finally { saving.current = false; setBusy(false); }
  }
  return <div className="ledger-quick">
    <TextInput aria-label="지출 빠른 입력" placeholder="예: 점심 8000" value={text}
      onChange={e => setText(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={e => { if (e.key === 'Enter' && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void save(); } }} />
    <Button size="sm" variant="quiet" disabled={busy} onClick={() => void save()}>추가</Button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

/** Accepted screen pieces; each host owns the frame, entry editor and storage writes. */
export function LedgerContents({ ledger, summary, all, today, spending, quickInput, onRecurring, onPlan, onBuy, onKeepRecurring, onKeepPlan }: {
  ledger: LedgerLike; summary: MonthSummary; all: LedgerEntry[]; today: string; spending: ReactNode; quickInput: ReactNode;
  onRecurring(item: Recurring | null): void; onPlan(item: Planned | null): void; onBuy(item: Planned): Promise<boolean>;
  onKeepRecurring(id: string): void; onKeepPlan(id: string): void;
}) {
  const stripWheel = useHorizontalWheel();
  const [selected, setSelected] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  const buying = useRef(false);
  const figures = budgetFigures(ledger, summary, all), done = donePlans(all);
  const recurring = sortRecurring(ledger.recurring ?? []), plans = sortRecurring(ledger.planned ?? []).filter(p => !p.dropped && !done.has(p.id));
  const dropped = sortRecurring(ledger.planned ?? []).filter(p => p.dropped);
  const chosen = plans.find(p => p.id === selected);
  const forksRec = forkedIds(recurring), forksPlan = forkedIds(plans);
  const events = monthlyEvents(ledger, summary.month, today, all);
  const ratio = (amount: number) => figures.budget && figures.budget > 0 ? Math.max(0, Math.min(100, amount / figures.budget * 100)) : 0;
  const fixedWidth = ratio(figures.fixed), spentWidth = Math.min(100 - fixedWidth, ratio(figures.spent));
  const planWidth = Math.min(100 - fixedWidth - spentWidth, ratio(chosen?.amount ?? 0));
  const row = (r: Recurring) => {
    const next = nextCharge(r, today), free = inTrial(r, today) && !isEnded(r, today);
    return <li key={r.id}>
      <button type="button" className="ledger-subscription" onClick={() => onRecurring(r)}>
        <strong>{r.name}</strong><span className="ledger-value">{free ? '무료' : won(chargeAmount(r, today))}</span>
        <span className="ledger-pills">{subscriptionPills(r, today).map(pill => <Badge key={pill}>{pill}</Badge>)}</span>
        <span className="ledger-next">{next ? <>{displayDate(next.date)} · {won(next.amount)}</> : r.until ? <>{displayDate(r.until)}까지 사용</> : '결제 없음'}
          {(r.unit !== 'month' || r.every !== 1) && <small>월 {won(monthlyEquivalent({ ...r, amount: next?.amount ?? r.amount }))}</small>}
        </span>
      </button>
      {forksRec.has(r.id) && <div className="ledger-conflict">두 기기에서 다르게 고침 <Button size="sm" variant="quiet" onClick={() => onKeepRecurring(r.id)}>이것만 남기기</Button></div>}
    </li>;
  };
  return <div className="ledger-content">
    <dl className="ledger-budget" aria-label="월 요약">
      {(['예산', '고정', '쓴 돈', '남은 돈'] as const).map((label, i) => <div key={label}><dt>{label}</dt><dd aria-label={label}>{[figures.budget, figures.fixed, figures.spent, figures.left][i] === null ? '—' : signedWon([figures.budget, figures.fixed, figures.spent, figures.left][i]!)}</dd></div>)}
    </dl>
    <div className="ledger-budget-meter" role="img" aria-label={`고정 ${won(figures.fixed)}, 쓴 돈 ${won(figures.spent)}${chosen ? `, ${chosen.name} ${won(chosen.amount)}` : ''}`}>
      <i className="ledger-budget-meter__fixed" style={{ width: `${fixedWidth}%` }} /><i className="ledger-budget-meter__spent" style={{ width: `${spentWidth}%` }} /><i className="ledger-budget-meter__plan" style={{ width: `${planWidth}%` }} />
    </div>
    <div className="ledger-meter-key"><span>고정</span><span>쓴 돈</span><span>사고 싶은 것 (고른 것)</span></div>
    <section aria-label="이번 달 결제 예정"><SectionLabel as="h3" title="이번 달 결제 예정" />
      {events.length ? <ul ref={stripWheel} className="ledger-timeline">{events.map(e => <li key={`${e.recurring.id}:${e.kind}:${e.date}`}>
        <button type="button" onClick={() => onRecurring(e.recurring)}><span>{displayDate(e.date)}<DDay days={e.days} /></span><strong>{e.recurring.name}{e.kind === 'trialEnd' ? ' · 무료 끝' : e.kind === 'cancellationEnd' ? ' · 끝남' : ''}</strong><span>{e.kind === 'cancellationEnd' ? '해지 예약' : won(e.amount)}</span></button>
      </li>)}</ul> : <EmptyState inline className="ledger-empty" title="결제 예정 없음" />}
    </section>
    <div className="ledger-columns">
      <section aria-label="구독"><SectionLabel as="h3" title="구독" />
        <ul className="ledger-items">{recurring.filter(r => !isEnded(r, today)).sort((a, b) => (nextCharge(a, today)?.date ?? a.until ?? '9999').localeCompare(nextCharge(b, today)?.date ?? b.until ?? '9999')).map(row)}</ul>
        {!recurring.length && <EmptyState inline className="ledger-empty" title="구독 없음" />}
        {recurring.some(r => isEnded(r, today)) && <details><summary>종료됨</summary><ul className="ledger-items">{recurring.filter(r => isEnded(r, today)).map(row)}</ul></details>}
        <Button size="sm" variant="quiet" onClick={() => onRecurring(null)}>+ 구독 추가</Button>
      </section>
      <div className="ledger-right">
        <section aria-label="사고 싶은 것"><SectionLabel as="h3" title="사고 싶은 것" /><ul className="ledger-items">{plans.map(p => <li key={p.id} className="ledger-wish">
          <button type="button" className="ledger-wish__main" aria-expanded={selected === p.id} onClick={() => setSelected(selected === p.id ? null : p.id)}>
            <span className="ledger-priority">{'★'.repeat(p.priority ?? 1)}</span><strong>{p.name}</strong><span className="ledger-value">{won(p.amount)}</span>
            <small>{[p.where, p.month ? `${p.month.slice(0, 4) === today.slice(0, 4) ? '' : `${p.month.slice(0, 4)}년 `}${Number(p.month.slice(5))}월` : '언젠가'].filter(Boolean).join(' · ')}</small>
          </button>
          {selected === p.id && <div className="ledger-wish__expanded"><span>이번 달에 사면 남는 돈 <b>{figures.left === null ? '—' : signedWon(figures.left - p.amount)}</b></span>
            <Button size="sm" variant="quiet" onClick={() => onPlan(p)}>고치기</Button>
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={async () => { if (buying.current) return; buying.current = true; setBusy(p.id); try { if (await onBuy(p)) setSelected(null); } finally { buying.current = false; setBusy(null); } }}>샀음</Button>
          </div>}
          {forksPlan.has(p.id) && <div className="ledger-conflict">두 기기에서 다르게 고침 <Button size="sm" variant="quiet" onClick={() => onKeepPlan(p.id)}>이것만 남기기</Button></div>}
        </li>)}</ul>
          {!plans.length && <EmptyState inline className="ledger-empty" title="사고 싶은 것 없음" />}
          {dropped.length > 0 && <details><summary>안 사기로 한 것 {dropped.length}</summary>
            <ul className="ledger-items">{dropped.map(p => <li key={p.id} className="ledger-wish">
              <button type="button" className="ledger-wish__main" onClick={() => onPlan(p)}><strong>{p.name}</strong><span className="ledger-value">{won(p.amount)}</span></button>
            </li>)}</ul>
          </details>}
          <Button size="sm" variant="quiet" onClick={() => onPlan(null)}>+ 사고 싶은 것</Button>
        </section>
        <section aria-label="지출"><SectionLabel as="h3" title="지출" />{spending}{quickInput}</section>
      </div>
    </div>
  </div>;
}
