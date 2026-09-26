import {useEffect,useMemo,useState,type MutableRefObject,type ReactNode} from 'react';
import {ArrowLeftIcon,ArrowPathIcon,CheckIcon,ChevronDownIcon,ChevronLeftIcon,ChevronRightIcon,EllipsisHorizontalIcon,PlusIcon,WalletIcon} from '@heroicons/react/24/outline';
import {PinIcon} from './PinIcon';
import {Button,IconButton} from './ui';
import {keyBetween} from '../src/notes/model';
import type {Note,NotesStore} from '../src/notes/store';
import {addDays,addMonths,cycleLabel,dayNumber,inTrial,isEnded,localToday,monthlyEquivalent,nextCharges,recurringTotals} from '../src/notes/ledger/cycle';
import {forkedIds,keepOnly,ledgerLimitProblem,ledgerSizeProblem,monthLabel,won,type LedgerEntry,type Planned,type Recurring} from '../src/notes/ledger/model';
import {baseIncome,donePlans,ledgerEntries,monthNotesOf,monthSummary,type Charge,type MonthSummary} from '../src/notes/ledger/summary';
import {ChargeSheet,EntrySheet,IncomeSheet,longDate,PlanSheet,RecurringSheet,type EntryDraft} from './NoteLedgerSheets';
import './ledger.css';

/**
 * The tablet 가계부 (design docs/research/budget-notes-design-20260925.md §3.1, §7): one
 * ledger note holds income, recurring charges and plans; entries live in hidden month
 * notes. Every figure is derived by the shared `src/notes/ledger` model on each render.
 */
type Tab='month'|'entries'|'recurring'|'plans';
type LedgerSheet={kind:'entry';draft:EntryDraft}|{kind:'income'}|{kind:'recurring';item:Recurring|null}|{kind:'plan';item:Planned|null}|{kind:'charge';charge:Charge}|null;
const TABS:[Tab,string][]=[['month','이번 달'],['entries','기록'],['recurring','고정·구독'],['plans','계획']];
const WEEKDAYS='일월화수목금토';
const weekday=(date:string)=>WEEKDAYS[new Date(dayNumber(date)*86_400_000).getUTCDay()]!;
/** Won with a leading minus for money that is short. */
export const signedWon=(amount:number)=>amount<0?`−${won(-amount)}`:won(amount);
const plain=(amount:number)=>signedWon(amount).replace('₩','');
const monthOnly=(month:string)=>`${Number(month.slice(5,7))}월`;
const daysUntil=(date:string,today:string)=>{const d=dayNumber(date)-dayNumber(today);return d===0?'오늘':d===1?'내일':`${d}일 후`;};
const nextOrder=(list:{order:string}[])=>keyBetween(list.reduce<string|null>((max,item)=>max===null||item.order>max?item.order:max,null),null);

function Label({children,more,onMore}:{children:ReactNode;more?:string;onMore?():void}) {
  return <h3 className="ledger-label"><span>{children}</span><i aria-hidden="true"/>{more&&<button type="button" onClick={onMore}>{more}<ChevronRightIcon aria-hidden="true"/></button>}</h3>;
}
function Meter({summary}:{summary:MonthSummary}) {
  if(!summary.incomeSet||summary.income<=0)return null;
  const spent=Math.min(100,summary.spent/summary.income*100),scheduled=Math.min(100-spent,summary.scheduled/summary.income*100);
  return <div className="ledger-meter" aria-hidden="true"><i className="is-spent" style={{width:`${spent}%`}}/><i className="is-scheduled" style={{width:`${scheduled}%`}}/></div>;
}
const Fork=({onKeep}:{onKeep():void})=><span className="ledger-fork"><span>두 기기에서 다르게 고침</span><Button size="sm" variant="ghost" onClick={event=>{event.stopPropagation();onKeep();}}>이것만 남기기</Button></span>;

/** The ledger card in the Notes list: this month's 쓸 수 있는 돈, a thin bar and the next charge. */
export function LedgerCard({ledger,notes,onOpen,meta}:{ledger:Note;notes:Note[];onOpen():void;meta:ReactNode}) {
  const today=localToday(),month=today.slice(0,7);
  const summary=monthSummary(ledger,monthNotesOf(notes,ledger.id),month,today);
  const next=upcoming(ledger.recurring??[],[],addDays(today,1),1)[0];
  return <button className="note-card ledger-card" onClick={onOpen}>
    <strong className="note-card__title"><WalletIcon aria-hidden="true"/><span>{ledger.title.trim()||'가계부'}</span></strong>
    {ledger.pinned&&<PinIcon className="note-card__pin" role="img" aria-label="고정됨"/>}
    <span className="ledger-card__figure">{summary.available!==null?<>{monthOnly(month)} 쓸 수 있는 돈 <b className="numeric">{signedWon(summary.available)}</b></>:<>{monthOnly(month)} 쓴 돈 <b className="numeric">{won(summary.spent)}</b></>}</span>
    <Meter summary={summary}/>
    {next&&<span className="ledger-card__next">다음 결제 {longDate(next.date)} {next.recurring.name}</span>}
    <small className="note-card__foot"><span className="note-card__meta">{meta}</span></small>
  </button>;
}
/** The next `count` open charges on or after `from`, across months (confirmed ones are left out). */
function upcoming(recurring:Recurring[],entries:LedgerEntry[],from:string,count:number):Charge[] {
  const confirmed=new Set(entries.filter(e=>e.recurring).map(e=>`${e.recurring!.id}\n${e.recurring!.date}`));
  // One line per item: only its next unconfirmed charge, so a subscription never repeats.
  return recurring.flatMap(r=>nextCharges(r,from,3).filter(date=>!confirmed.has(`${r.id}\n${date}`)).slice(0,1).map(date=>({recurring:r,date,amount:r.amount,confirmedBy:null})))
    .sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0).slice(0,count);
}

export function NoteLedger({store,ledger,notes,saveState,onLeave,onMore,backRef}:{store:NotesStore;ledger:Note;notes:Note[];saveState:string;onLeave():void;onMore():void;backRef:MutableRefObject<(()=>boolean)|null>}) {
  const today=localToday(),current=today.slice(0,7);
  const [month,setMonth]=useState(current),[tab,setTab]=useState<Tab>('month'),[sheet,setSheet]=useState<LedgerSheet>(null),[problem,setProblem]=useState<string|null>(null),[showEnded,setShowEnded]=useState(false);
  useEffect(()=>{backRef.current=()=>{if(sheet){setSheet(null);return true;}return false;};return()=>{backRef.current=null;};});
  const monthNotes=useMemo(()=>monthNotesOf(notes,ledger.id),[notes,ledger.id]);
  const all=useMemo(()=>ledgerEntries(monthNotes),[monthNotes]);
  const summary=monthSummary(ledger,monthNotes,month,today,all);
  const recurring=ledger.recurring??[],planned=ledger.planned??[];
  const names=useMemo(()=>[...new Set(all.map(e=>e.name.trim()).filter(Boolean))],[all]);
  const openSheet=(next:LedgerSheet)=>{setProblem(null);setSheet(next);};
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
  const saveRecurring=(item:Recurring)=>editLedger(l=>({recurring:[...(l.recurring??[]).filter(r=>r.id!==item.id),item]}));
  const savePlan=(item:Planned)=>editLedger(l=>({planned:[...(l.planned??[]).filter(p=>p.id!==item.id),item]}));
  async function saveIncome(scope:'default'|'month',amount:number|null,incomeDay:number|null){
    const day=incomeDay!==(ledger.incomeDay??null)?{incomeDay}:{};
    if(scope==='default')return editLedger(()=>({income:amount,...day}));
    if('incomeDay' in day&&!editLedger(()=>day))return false;
    return !!await editMonth(month,()=>({income:amount}));
  }
  const openEntry=(draft:EntryDraft={})=>openSheet({kind:'entry',draft});
  const buy=(plan:Planned)=>openEntry({name:plan.name,amount:plan.amount,planned:plan.id});
  const skipCharge=async(c:Charge)=>{if(await saveEntry({id:crypto.randomUUID(),createdAt:new Date().toISOString(),date:c.date,amount:0,name:c.recurring.name,recurring:{id:c.recurring.id,date:c.date}}))setSheet(null);};
  // ---- Derived views
  const forkedEntries=forkedIds(all),forkedRecurring=forkedIds(recurring),forkedPlans=forkedIds(planned);
  const done=donePlans(all);
  const monthIncome=monthNotes.find(n=>n.month===month&&n.income!=null)?.income??null;
  const incomeBase=baseIncome(ledger,monthNotes,month);
  const headline=summary.available??summary.spent;
  const next=summary.phase==='past'?[]:upcoming(recurring,all,summary.phase==='current'?addDays(today,1):`${month}-01`,3);
  /** The payday still to come in this month joins 다가오는 결제 by date (money in). */
  const payday=summary.incomeUpcoming&&summary.incomeDate&&incomeBase!==null?{date:summary.incomeDate,amount:incomeBase}:null;
  const dateCell=(date:string)=><span className="ledger-date"><b className="numeric">{Number(date.slice(8,10))}</b><small>{weekday(date)}</small></span>;
  const paydayRow=(p:{date:string;amount:number})=><li key="payday" className="ledger-row is-in" onClick={()=>openSheet({kind:'income'})}>
    {dateCell(p.date)}
    <span className="ledger-row__name"><strong>수입</strong><small>매달 {ledger.incomeDay}일 들어와요</small></span>
    <b className="ledger-row__amount numeric">+{won(p.amount)}</b>
  </li>;
  const planRow=(plan:Planned,doneBy:LedgerEntry|null)=><li key={plan.id} className={`ledger-row is-plan${doneBy?' is-done':''}${plan.dropped?' is-dropped':''}`} onClick={()=>openSheet({kind:'plan',item:plan})}>
    <span className="ledger-check" aria-label={doneBy?'샀어요':plan.dropped?'안 사기로 함':'아직'}>{doneBy&&<CheckIcon aria-hidden="true"/>}</span>
    <span className="ledger-row__name"><strong>{plan.name}</strong><small>{doneBy?`${longDate(doneBy.date)} 기록과 연결`:plan.dropped?'안 사기로 함':plan.month?`${monthLabel(plan.month)} 안에`:'언젠가'}</small>{forkedPlans.has(plan.id)&&<Fork onKeep={()=>editLedger(l=>({planned:keepOnly(l.planned??[],plan.id)}))}/>}</span>
    <span className="ledger-row__amount">{doneBy?<><s className="numeric">{won(plan.amount)}</s><small>실제 <span className="numeric">{won(doneBy.amount)}</span></small></>:<b className="numeric">{won(plan.amount)}</b>}</span>
    {!doneBy&&!plan.dropped&&<Button className="ledger-buy" onClick={event=>{event.stopPropagation();buy(plan);}}>샀어요</Button>}
  </li>;
  const entryRow=(e:LedgerEntry,withDate=false)=><li key={e.id} className={`ledger-row${e.in?' is-in':''}`} onClick={()=>openEntry(e)}>
    {withDate&&dateCell(e.date)}
    <span className="ledger-row__name"><strong className={e.name?undefined:'is-untitled'}>{e.name||'이름 없음'}</strong>
      {(e.in||e.planned||e.recurring)&&<small>{e.in&&'들어온 돈'}{e.planned&&'계획에서 산 것'}{e.recurring&&<><ArrowPathIcon aria-hidden="true"/>{e.amount===0?'이번 달은 건너뜀':'고정·구독 확정'}</>}</small>}
      {forkedEntries.has(e.id)&&<Fork onKeep={()=>keepEntry(e.id)}/>}</span>
    <b className="ledger-row__amount numeric">{e.in?'+':''}{won(e.amount)}</b>
  </li>;
  const chargeRow=(c:Charge,muted=false)=><li key={`${c.recurring.id}:${c.date}`} className={`ledger-row${muted?' is-derived':''}`} onClick={muted?()=>openSheet({kind:'charge',charge:c}):()=>setTab('recurring')}>
    {!muted&&dateCell(c.date)}
    <span className="ledger-row__name"><strong>{c.recurring.name}</strong><small>{muted?<><ArrowPathIcon aria-hidden="true"/>자동 계산 · 눌러서 확정</>:<>{c.date.slice(0,7)!==month&&`${monthOnly(c.date.slice(0,7))} · `}{cycleLabel(c.recurring)}</>}</small></span>
    <b className="ledger-row__amount numeric">{won(c.amount)}</b>
  </li>;

  function monthTab() {
    const label=summary.phase==='past'?`${monthOnly(month)}에 남은 돈`:summary.phase==='future'?`${monthOnly(month)} 쓸 수 있는 돈 (예상)`:'이번 달 쓸 수 있는 돈';
    return <>
      <div className="ledger-hero">
        <p className="ledger-hero__label">{summary.available!==null?label:`${monthOnly(month)} 쓴 돈`}</p>
        <p className={`ledger-hero__big${headline<0?' is-short':''}`} aria-label={summary.available!==null?label:'쓴 돈'}><span className="ledger-won">{headline<0?'−₩':'₩'}</span><span className="numeric">{won(Math.abs(headline)).slice(1)}</span></p>
        {summary.available===null?<button type="button" className="ledger-hero__sub is-link" onClick={()=>openSheet({kind:'income'})}>수입을 적으면 쓸 수 있는 돈이 보여요</button>
          :summary.phase==='current'?<p className="ledger-hero__sub">하루 약 <b className="numeric">{signedWon(summary.perDay??0)}</b> · 남은 날 <b className="numeric">{summary.remainingDays}</b>일 · 결제 예정과 계획은 미리 뺐어요</p>
          :<p className="ledger-hero__sub">{summary.phase==='past'?'지난 달의 최종 금액입니다':'수입에서 이 달의 결제와 계획을 뺐어요'}</p>}
        <Meter summary={summary}/>
      </div>
      <dl className="ledger-figures">
        <div><dt><i className="is-income"/>수입</dt><dd className="numeric">{plain(summary.income)}</dd></div>
        <div><dt><i className="is-spent"/>쓴 돈</dt><dd className="numeric">{plain(summary.spent)}</dd></div>
        <div><dt><i className="is-scheduled"/>예정</dt><dd className="numeric">{plain(summary.scheduled)}</dd></div>
        <div><dt>고정·구독 이번 달</dt><dd className="numeric">{plain(summary.recurringThisMonth)}</dd></div>
      </dl>
      {summary.reviewCount>0&&<button type="button" className="ledger-review" onClick={()=>setTab('entries')}>확인할 기록 {summary.reviewCount}건 · 두 기기에서 다르게 고쳤어요</button>}
      {(next.length>0||payday)&&<section className="ledger-section"><Label more="고정·구독" onMore={()=>setTab('recurring')}>다가오는 결제</Label><ul>
        {next.filter(c=>!payday||c.date<payday.date).map(c=>chargeRow(c))}{payday&&paydayRow(payday)}{next.filter(c=>payday&&c.date>=payday.date).map(c=>chargeRow(c))}</ul></section>}
      {summary.plans.length>0&&<section className="ledger-section"><Label more="계획 전체" onMore={()=>setTab('plans')}>{summary.phase==='current'?'이번 달':monthOnly(month)} 계획</Label><ul>{summary.plans.map(p=>planRow(p.plan,p.doneBy))}</ul></section>}
      <section className="ledger-section"><Label more="기록 전체" onMore={()=>setTab('entries')}>최근 기록</Label>
        {summary.entries.length?<ul>{summary.entries.slice(0,4).map(e=>entryRow(e,true))}</ul>:<p className="ledger-empty">아직 기록이 없어요. 아래 + 기록으로 적어 보세요.</p>}
      </section>
    </>;
  }
  function entriesTab() {
    const days=new Map<string,{entries:LedgerEntry[];charges:Charge[]}>();
    for(const e of summary.entries){const day=days.get(e.date)??{entries:[],charges:[]};day.entries.push(e);days.set(e.date,day);}
    for(const c of summary.pastCharges){const day=days.get(c.date)??{entries:[],charges:[]};day.charges.push(c);days.set(c.date,day);}
    const ordered=[...days.entries()].sort((a,b)=>a[0]<b[0]?1:-1);
    if(!ordered.length)return <p className="ledger-empty">{monthLabel(month)} 기록이 없어요.</p>;
    return <>{summary.reviewCount>0&&<p className="ledger-review" role="status">확인할 기록 {summary.reviewCount}건: 남길 쪽에서 이것만 남기기를 누르세요.</p>}
      {ordered.map(([date,day])=>{const total=day.entries.filter(e=>!e.in).reduce((s,e)=>s+e.amount,0)+day.charges.reduce((s,c)=>s+c.amount,0);
        return <section key={date} className="ledger-day"><h3 className="ledger-day__head"><span>{longDate(date)} {weekday(date)}요일</span><span className="numeric">{won(total)}</span></h3>
          <ul>{day.entries.map(e=>entryRow(e))}{day.charges.map(c=>chargeRow(c,true))}</ul></section>;})}
    </>;
  }
  function recurringTab() {
    const totals=recurringTotals(recurring,today);
    const rows=recurring.map(r=>({r,next:nextCharges(r,today,1)[0]??null,ended:isEnded(r,today)}));
    const active=rows.filter(x=>!x.ended).sort((a,b)=>(a.next??'9999')<(b.next??'9999')?-1:(a.next??'9999')>(b.next??'9999')?1:a.r.name.localeCompare(b.r.name,'ko'));
    const ended=rows.filter(x=>x.ended);
    const trials=recurring.filter(r=>inTrial(r,today)&&!isEnded(r,today));
    const row=({r,next}:{r:Recurring;next:string|null})=>{
      const monthly=r.unit!=='month'||r.every!==1;
      return <li key={r.id} className="ledger-row is-recurring" onClick={()=>openSheet({kind:'recurring',item:r})}>
        <span className="ledger-mono" aria-hidden="true">{Array.from(r.name.trim())[0]?.toLocaleUpperCase()??'?'}</span>
        <span className="ledger-row__name"><strong>{r.name}{inTrial(r,today)&&<em className="ledger-badge">체험 중 · 첫 결제 {longDate(r.start)}</em>}{r.until&&!isEnded(r,today)&&<em className="ledger-badge">해지함 · {longDate(r.until)} 만료</em>}{isEnded(r,today)&&<em className="ledger-badge">{longDate(r.until!)} 종료</em>}</strong>
          <small>{cycleLabel(r)}{r.memo&&` · ${r.memo}`}</small>{forkedRecurring.has(r.id)&&<Fork onKeep={()=>editLedger(l=>({recurring:keepOnly(l.recurring??[],r.id)}))}/>}</span>
        {next?<span className="ledger-row__when"><b>{next.slice(0,4)!==today.slice(0,4)?`${next.slice(0,4)}년 `:''}{longDate(next)}</b><small>{daysUntil(next,today)}</small></span>
          :r.until&&!isEnded(r,today)&&<span className="ledger-row__when"><b>{longDate(r.until)}</b><small>{daysUntil(r.until,today)} 만료</small></span>}
        <span className="ledger-row__amount"><b className="numeric">{won(r.amount)}</b>{monthly&&<small>월 <span className="numeric">{plain(monthlyEquivalent(r))}</span></small>}</span>
      </li>;
    };
    return <>
      <div className="ledger-hero is-recurring">
        <div><p className="ledger-hero__label">월 환산 합계</p><p className="ledger-hero__big is-medium"><span className="ledger-won">₩</span><span className="numeric">{plain(totals.monthly)}</span></p></div>
        <p className="ledger-hero__sub">1년 <b className="numeric">{won(totals.yearly)}</b> · {monthOnly(month)} 청구 <b className="numeric">{won(summary.recurringThisMonth)}</b><br/>진행 중 <b className="numeric">{totals.active}</b>개{trials.map(r=><span key={r.id}> · {monthOnly(r.start.slice(0,7))}부터 {r.name} +<span className="numeric">{plain(r.amount)}</span></span>)}</p>
      </div>
      {!recurring.length?<p className="ledger-empty">구독이나 월세, 보험처럼 반복해서 나가는 돈을 추가해 보세요. 매주·매월·매년, N개월마다 모두 됩니다.</p>:<>
        <p className="ledger-sort">다음 결제순</p>
        <ul>{active.map(row)}</ul>
        {ended.length>0&&<><button type="button" className="ledger-ended-toggle" aria-expanded={showEnded} onClick={()=>setShowEnded(v=>!v)}><ChevronDownIcon aria-hidden="true"/>종료됨 <span className="numeric">{ended.length}</span></button>{showEnded&&<ul className="is-ended">{ended.map(row)}</ul>}</>}
      </>}
    </>;
  }
  function plansTab() {
    const open=planned.filter(p=>!p.dropped&&!done.has(p.id));
    const groups:[string,Planned[]][]=[
      [`${monthOnly(month)}`,open.filter(p=>p.month===month)],
      ['나중에',open.filter(p=>p.month!==null&&p.month>month).sort((a,b)=>a.month!.localeCompare(b.month!))],
      ['언젠가',open.filter(p=>p.month===null)],
      ['지난 달에 계획한 것',open.filter(p=>p.month!==null&&p.month<month)],
      ['끝난 계획',planned.filter(p=>p.dropped||done.has(p.id))],
    ];
    if(!planned.length)return <p className="ledger-empty">사고 싶은 것을 미리 적어 두면, 그 달의 쓸 수 있는 돈에서 미리 빼 둡니다.</p>;
    return <>{groups.filter(([,list])=>list.length).map(([title,list])=><section key={title} className="ledger-section"><Label>{title}</Label><ul>{list.map(p=>planRow(p,done.get(p.id)??null))}</ul></section>)}</>;
  }

  const fab=tab==='recurring'?{label:'고정·구독 추가',open:()=>openSheet({kind:'recurring',item:null})}:tab==='plans'?{label:'계획 추가',open:()=>openSheet({kind:'plan',item:null})}:{label:'기록',open:()=>openEntry()};
  return <div className="ledger-view">
    <header className="notes-top is-sub"><IconButton label="메모 목록" icon={ArrowLeftIcon} onClick={onLeave}/><h1>{ledger.title.trim()||'가계부'}</h1><span className="notes-top__space"/><span className="notes-save-state" role="status">{saveState}</span>
      <IconButton label={ledger.pinned?'고정 해제':'고정'} icon={PinIcon} active={ledger.pinned} onClick={()=>editLedger(l=>({pinned:!l.pinned}))}/>
      <IconButton label="메모 더보기" icon={EllipsisHorizontalIcon} onClick={onMore}/></header>
    <div className="ledger-monthrow">
      <IconButton label="이전 달" icon={ChevronLeftIcon} onClick={()=>setMonth(m=>addMonths(m,-1))}/>
      <h2><button type="button" onClick={()=>setMonth(current)} disabled={month===current} aria-label={month===current?monthLabel(month):`${monthLabel(month)} · 이번 달로`}>{monthLabel(month)}</button></h2>
      <IconButton label="다음 달" icon={ChevronRightIcon} onClick={()=>setMonth(m=>addMonths(m,1))}/>
      <span className="notes-top__space"/>
      <Button variant="ghost" className="ledger-income" onClick={()=>openSheet({kind:'income'})}><WalletIcon aria-hidden="true"/>{incomeBase===null?'수입 적기':<>수입 <span className="numeric">{plain(incomeBase)}</span>{summary.incomeDate&&<> · <span className="numeric">{Number(summary.incomeDate.slice(8))}</span>일</>}</>}</Button>
    </div>
    <div className="ledger-tabs" role="tablist" aria-label="가계부">{TABS.map(([key,text])=><button key={key} type="button" role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{text}</button>)}</div>
    <div className="ledger-scroll" role="tabpanel">
      {problem&&!sheet&&<p className="notes-limit" role="alert">{problem}</p>}
      {tab==='month'?monthTab():tab==='entries'?entriesTab():tab==='recurring'?recurringTab():plansTab()}
    </div>
    <Button variant="primary" className="notes-fab" onClick={fab.open}><PlusIcon aria-hidden="true"/>{fab.label}</Button>
    {sheet?.kind==='entry'&&<EntrySheet error={problem} key={sheet.draft.id??'new'} initial={sheet.draft} names={names} onClose={()=>setSheet(null)} onSave={saveEntry}
      onDelete={sheet.draft.id?()=>{deleteEntry(sheet.draft.id!);setSheet(null);}:undefined}/>}
    {sheet?.kind==='income'&&<IncomeSheet error={problem} month={month} monthIncome={monthIncome} defaultIncome={ledger.income??null} incomeDay={ledger.incomeDay??null} onSave={saveIncome} onClose={()=>setSheet(null)}/>}
    {sheet?.kind==='recurring'&&<RecurringSheet error={problem} initial={sheet.item} order={nextOrder(recurring)} onSave={saveRecurring} onClose={()=>setSheet(null)}
      onDelete={sheet.item?()=>editLedger(l=>({recurring:(l.recurring??[]).filter(r=>r.id!==sheet.item!.id)})):undefined}/>}
    {sheet?.kind==='plan'&&<PlanSheet error={problem} initial={sheet.item} month={month} order={nextOrder(planned)} onSave={savePlan} onClose={()=>setSheet(null)}
      onDelete={sheet.item?()=>editLedger(l=>({planned:(l.planned??[]).filter(p=>p.id!==sheet.item!.id)})):undefined}/>}
    {sheet?.kind==='charge'&&<ChargeSheet error={problem} name={sheet.charge.recurring.name} date={sheet.charge.date} amount={sheet.charge.amount} onClose={()=>setSheet(null)} onSkip={()=>void skipCharge(sheet.charge)}
      onConfirm={()=>openEntry({name:sheet.charge.recurring.name,amount:sheet.charge.amount,date:sheet.charge.date,recurring:{id:sheet.charge.recurring.id,date:sheet.charge.date}})}/>}
  </div>;
}
