import {useState,type ReactNode} from 'react';
import {BackspaceIcon,CalendarIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {Button,Dialog,DialogDescription,IconButton} from './ui';
import {addDays,addMonths,localToday,nextCharges} from '../src/notes/ledger/cycle';
import {LEDGER_LIMITS,monthLabel,won,type LedgerEntry,type LedgerUnit,type Planned,type Recurring} from '../src/notes/ledger/model';

/**
 * Sheets of the tablet ledger (가계부): the entry sheet with its in-app number pad (the
 * Android keyboard opens only for the optional name), income, recurring and plan editors.
 * Each sheet reports a finished value; the screen writes it and closes the sheet.
 */
const MAX_DIGITS=String(LEDGER_LIMITS.amountBound-1).length;
/** One number-pad press on the digit string: 1–9, 0, 000 and ⌫; no leading zeros, at most 12 digits. */
export function pressKey(digits:string,key:string):string {
  if(key==='⌫')return digits.slice(0,-1);
  if(!/^(\d|000)$/.test(key))return digits;
  const next=(digits+key).replace(/^0+/,'');
  return next.length>MAX_DIGITS?digits:next;
}
export const amountOf=(digits:string)=>digits?Number(digits):0;
const digitsOf=(amount:number|null|undefined)=>amount?String(amount):'';
/** "2026-09-25" → "9.25". */
export const shortDate=(date:string)=>`${Number(date.slice(5,7))}.${Number(date.slice(8,10))}`;
/** "2026-09-25" → "9월 25일". */
export const longDate=(date:string)=>`${Number(date.slice(5,7))}월 ${Number(date.slice(8,10))}일`;

type Saved=boolean|Promise<boolean>;
/** The screen's save problem (limit or size); the sheet stays open with the typed input. */
function Sheet({title,onClose,className,error,children}:{title:string;onClose():void;className?:string;error?:string|null;children:ReactNode}) {
  return <Dialog open title={title} onClose={onClose}><DialogDescription className="sr-only">내용을 고친 뒤 저장하세요.</DialogDescription>
    <div className={`library-sheet ledger-sheet${className?` ${className}`:''}`}><span className="ledger-sheet__close"><IconButton label="닫기" icon={XMarkIcon} onClick={onClose}/></span>{error&&<p className="notes-limit" role="alert">{error}</p>}{children}</div>
  </Dialog>;
}
function AmountDisplay({digits,label}:{digits:string;label:string}) {
  return <output className="ledger-amount" aria-label={label}><span className="ledger-won">₩</span><span className="numeric">{won(amountOf(digits)).slice(1)}</span><i aria-hidden="true"/></output>;
}
function Keypad({onKey}:{onKey(key:string):void}) {
  return <div className="ledger-keypad" role="group" aria-label="숫자 패드">
    {['1','2','3','4','5','6','7','8','9','000','0'].map(key=><button key={key} type="button" className={`numeric${key==='000'?' is-quiet':''}`} onClick={()=>onKey(key)}>{key}</button>)}
    <button type="button" aria-label="지우기" onClick={()=>onKey('⌫')}><BackspaceIcon aria-hidden="true"/></button>
  </div>;
}
function Segment<T extends string>({value,options,onChange,label}:{value:T;options:[T,string][];onChange(value:T):void;label:string}) {
  return <div className="ledger-segment" role="radiogroup" aria-label={label}>{options.map(([key,text])=><button key={key} type="button" role="radio" aria-checked={value===key} onClick={()=>onChange(key)}>{text}</button>)}</div>;
}

export type EntryDraft=Partial<LedgerEntry>;
/**
 * 기록 sheet. The first control is the 나간/들어온 돈 switch, so opening the sheet never
 * focuses a text field (and never raises the keyboard). A draft linked to a plan or a
 * charge keeps that link; 저장하고 하나 더 keeps the date and direction for the next one.
 */
export function EntrySheet({initial,names,error,onSave,onDelete,onClose}:{initial:EntryDraft;names:string[];error?:string|null;onSave(entry:LedgerEntry):Promise<boolean>;onDelete?():void;onClose():void}) {
  const today=localToday();
  const [digits,setDigits]=useState(digitsOf(initial.amount)),[name,setName]=useState(initial.name??''),[date,setDate]=useState(initial.date??today),[income,setIncome]=useState(!!initial.in);
  const [busy,setBusy]=useState(false);
  const linked=!!(initial.planned||initial.recurring);
  const editing=!!initial.id;
  const typed=name.trim();
  const chips=names.filter(entry=>entry!==typed&&(!typed||entry.includes(typed))).slice(0,5);
  // A 0-won entry only makes sense as a skipped charge.
  const canSave=!busy&&(amountOf(digits)>0||!!initial.recurring);
  async function save(again:boolean){
    if(!canSave)return;
    const {in:_in,...rest}=initial;
    const entry:LedgerEntry={...rest,id:initial.id??crypto.randomUUID(),createdAt:initial.createdAt??new Date().toISOString(),date,amount:amountOf(digits),name:typed,...(income?{in:true}:{})};
    setBusy(true);const ok=await onSave(entry);setBusy(false);
    if(!ok)return;
    if(again){setDigits('');setName('');}else onClose();
  }
  const other=date!==today&&date!==addDays(today,-1);
  return <Sheet title={editing?'기록 고치기':'기록'} onClose={onClose} error={error} className="ledger-entry-sheet">
    <div className="ledger-entry-head">
      <Segment label="돈의 방향" value={income?'in':'out'} options={[['out','나간 돈'],['in','들어온 돈']]} onChange={value=>setIncome(value==='in')}/>
      <AmountDisplay digits={digits} label="금액"/>
    </div>
    <label className="ledger-field"><span>이름</span><input value={name} maxLength={LEDGER_LIMITS.nameChars} placeholder="이름 (선택)" enterKeyHint="done" onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Enter')(event.target as HTMLInputElement).blur();}}/></label>
    {chips.length>0&&<div className="ledger-chips" role="group" aria-label="최근 이름">{chips.map(entry=><button key={entry} type="button" className="filter-chip" onClick={()=>setName(entry)}>{entry}</button>)}<small>최근</small></div>}
    <div className="ledger-field is-row"><span>날짜</span><div className="ledger-chips">
      <button type="button" className="filter-chip" aria-pressed={date===today} onClick={()=>setDate(today)}>오늘 <small className="numeric">{shortDate(today)}</small></button>
      <button type="button" className="filter-chip" aria-pressed={date===addDays(today,-1)} onClick={()=>setDate(addDays(today,-1))}>어제</button>
      <label className="filter-chip ledger-date-chip" aria-pressed={other}><CalendarIcon aria-hidden="true"/>{other?longDate(date):'다른 날'}<input type="date" aria-label="다른 날" value={date} max="9999-12-31" onChange={event=>{if(event.target.value)setDate(event.target.value);}}/></label>
    </div></div>
    <Keypad onKey={key=>setDigits(value=>pressKey(value,key))}/>
    <div className="ledger-sheet__actions">
      {editing&&onDelete?<Button variant="ghost" className="is-danger" onClick={onDelete}>삭제</Button>
        :!linked&&<Button disabled={!canSave} onClick={()=>void save(true)}>저장하고 하나 더</Button>}
      <Button variant="primary" disabled={!canSave} onClick={()=>void save(false)}>저장</Button>
    </div>
  </Sheet>;
}

/** 수입: this month only (the month note) or the default for every month (the ledger). */
export function IncomeSheet({month,monthIncome,defaultIncome,incomeDay,error,onSave,onClose}:{month:string;monthIncome:number|null;defaultIncome:number|null;incomeDay:number|null;error?:string|null;onSave(scope:'default'|'month',amount:number|null,incomeDay:number|null):Saved;onClose():void}) {
  const [day,setDay]=useState<number|null>(incomeDay);
  const commit=async(scope:'default'|'month',amount:number|null)=>{if(await onSave(scope,amount,day))onClose();};
  const [scope,setScope]=useState<'default'|'month'>(monthIncome!==null?'month':'default');
  const [digits,setDigits]=useState(digitsOf(scope==='month'?monthIncome:defaultIncome));
  const choose=(value:'default'|'month')=>{setScope(value);setDigits(digitsOf(value==='month'?monthIncome??defaultIncome:defaultIncome));};
  return <Sheet title="수입" onClose={onClose} error={error} className="ledger-entry-sheet">
    <div className="ledger-entry-head">
      <Segment label="적용할 달" value={scope} options={[['default','매달 기본'],['month',`${monthLabel(month).split(' ')[1]}만`]]} onChange={choose}/>
      <AmountDisplay digits={digits} label="수입"/>
    </div>
    <p className="hint">{scope==='default'?'따로 정하지 않은 달은 이 금액을 씁니다. 환불이나 한 번 들어온 돈은 기록에서 들어온 돈으로 적어요.':`${monthLabel(month)}에만 쓰는 수입입니다.`}</p>
    <div className="ledger-field is-row ledger-income-day"><span>들어오는 날</span><div>
      {day===null?<Button variant="ghost" onClick={()=>setDay(25)}>날짜 정하기</Button>
        :<><span>매달</span><Stepper label="들어오는 날" value={day} max={LEDGER_LIMITS.incomeDayMax} onChange={setDay}/><span>일</span><Button variant="ghost" onClick={()=>setDay(null)}>안 정함</Button></>}
    </div></div>
    {day!==null&&day>28&&<p className="hint">{day}일이 없는 달은 그 달 마지막 날로 계산해요.</p>}
    <Keypad onKey={key=>setDigits(value=>pressKey(value,key))}/>
    <div className="ledger-sheet__actions">
      {scope==='month'&&monthIncome!==null?<Button variant="ghost" onClick={()=>void commit('month',null)}>기본 수입으로 되돌리기</Button>:<span/>}
      <Button variant="primary" onClick={()=>void commit(scope,digits?amountOf(digits):null)}>저장</Button>
    </div>
  </Sheet>;
}

const UNITS:[LedgerUnit,string][]=[['week','주'],['month','개월'],['year','년']];
const numberText=(value:string)=>value.replace(/\D/g,'').replace(/^0+(?=\d)/,'').slice(0,MAX_DIGITS);
function Stepper({value,onChange,label,max=LEDGER_LIMITS.everyMax}:{value:number;onChange(value:number):void;label:string;max?:number}) {
  return <span className="ledger-stepper" role="group" aria-label={label}>
    <button type="button" aria-label={`${label} 줄이기`} disabled={value<=1} onClick={()=>onChange(value-1)}>−</button>
    <b className="numeric" aria-live="polite">{value}</b>
    <button type="button" aria-label={`${label} 늘리기`} disabled={value>=max} onClick={()=>onChange(value+1)}>+</button>
  </span>;
}

/** 고정·구독 추가/고치기: 이름, 금액, 주기 (N주/개월/년), 첫 결제일, 체험 중, 만료일, 메모. */
export function RecurringSheet({initial,order,error,onSave,onDelete,onClose}:{initial:Recurring|null;order:string;error?:string|null;onSave(item:Recurring):Saved;onDelete?():Saved;onClose():void}) {
  const today=localToday();
  const [name,setName]=useState(initial?.name??''),[amount,setAmount]=useState(digitsOf(initial?.amount)),[every,setEvery]=useState(initial?.every??1),[unit,setUnit]=useState<LedgerUnit>(initial?.unit??'month');
  const [start,setStart]=useState(initial?.start??today),[trial,setTrial]=useState(initial?.trial??false),[until,setUntil]=useState(initial?.until??''),[memo,setMemo]=useState(initial?.memo??'');
  const valid=!!name.trim()&&!!amount&&!!start&&(!until||until>start);
  async function save(){
    if(!valid)return;
    if(await onSave({...(initial??{}),id:initial?.id??crypto.randomUUID(),order:initial?.order??order,name:name.trim(),amount:amountOf(amount),every,unit,start,trial,until:until||null,memo}))onClose();
  }
  // 해지: no charge from the next one on (the service stays until then).
  const cancelAt=nextCharges({every,unit,start,until:null},today,1)[0]??today;
  return <Sheet title={initial?'고정·구독 고치기':'고정·구독 추가'} onClose={onClose} error={error}>
    <div className="ledger-form">
      <label className="ledger-field"><span>이름</span><input value={name} maxLength={LEDGER_LIMITS.nameChars} placeholder="넷플릭스, 월세, 보험…" onChange={event=>setName(event.target.value)}/></label>
      <label className="ledger-field"><span>금액</span><input className="numeric" inputMode="numeric" value={amount?won(amountOf(amount)):''} placeholder="₩0" aria-label="금액" onChange={event=>setAmount(numberText(event.target.value))}/></label>
      <div className="ledger-field is-row"><span>주기</span><div className="ledger-cycle"><Stepper label="주기" value={every} onChange={setEvery}/><Segment<LedgerUnit> label="주기 단위" value={unit} options={UNITS.map(([key,text]):[LedgerUnit,string]=>[key,every===1?{week:'매주',month:'매월',year:'매년'}[key]:`${text}마다`])} onChange={setUnit}/></div></div>
      <label className="ledger-field"><span>첫 결제일</span><input type="date" value={start} max="9999-12-31" onChange={event=>{if(event.target.value)setStart(event.target.value);}}/></label>
      <label className="ledger-field is-check"><input type="checkbox" checked={trial} onChange={event=>setTrial(event.target.checked)}/><span>무료 체험 중 (첫 결제일까지 무료)</span></label>
      <div className="ledger-field is-row"><span>만료일</span><div className="ledger-until">
        <input type="date" aria-label="만료일" value={until} min={start} max="9999-12-31" onChange={event=>setUntil(event.target.value)}/>
        {until?<Button variant="ghost" onClick={()=>setUntil('')}>만료 없음</Button>:initial&&<Button variant="ghost" onClick={()=>setUntil(cancelAt)}>해지 ({longDate(cancelAt)}부터 결제 없음)</Button>}
      </div></div>
      {until&&until<=start&&<p className="notes-limit" role="alert">만료일은 첫 결제일보다 뒤여야 합니다.</p>}
      <label className="ledger-field"><span>메모</span><input value={memo} maxLength={LEDGER_LIMITS.memoChars} placeholder="선택" onChange={event=>setMemo(event.target.value)}/></label>
    </div>
    <div className="ledger-sheet__actions">
      {onDelete?<Button variant="ghost" className="is-danger" onClick={async()=>{if(await onDelete())onClose();}}>삭제</Button>:<span/>}
      <Button variant="primary" disabled={!valid} onClick={()=>void save()}>저장</Button>
    </div>
  </Sheet>;
}

/** 계획 추가/고치기: 이름, 금액, 달 (언젠가 or a month), 메모, 안 사기로 함. */
export function PlanSheet({initial,month,order,error,onSave,onDelete,onClose}:{initial:Planned|null;month:string;order:string;error?:string|null;onSave(plan:Planned):Saved;onDelete?():Saved;onClose():void}) {
  const [name,setName]=useState(initial?.name??''),[amount,setAmount]=useState(digitsOf(initial?.amount)),[when,setWhen]=useState<string>(initial?initial.month??'':month),[memo,setMemo]=useState(initial?.memo??'');
  const current=localToday().slice(0,7);
  const months=Array.from({length:14},(_,i)=>addMonths(current,i-1));
  if(when&&!months.includes(when))months.push(when);
  months.sort();
  const valid=!!name.trim();
  async function save(dropped=initial?.dropped??false){
    if(!valid)return;
    if(await onSave({...(initial??{}),id:initial?.id??crypto.randomUUID(),order:initial?.order??order,name:name.trim(),amount:amountOf(amount),month:when||null,memo,dropped}))onClose();
  }
  return <Sheet title={initial?'계획 고치기':'계획 추가'} onClose={onClose} error={error}>
    <div className="ledger-form">
      <label className="ledger-field"><span>이름</span><input value={name} maxLength={LEDGER_LIMITS.nameChars} placeholder="사고 싶은 것" onChange={event=>setName(event.target.value)}/></label>
      <label className="ledger-field"><span>금액</span><input className="numeric" inputMode="numeric" aria-label="금액" value={amount?won(amountOf(amount)):''} placeholder="₩0" onChange={event=>setAmount(numberText(event.target.value))}/></label>
      <label className="ledger-field"><span>언제</span><select value={when} aria-label="언제" onChange={event=>setWhen(event.target.value)}><option value="">언젠가</option>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
      <label className="ledger-field"><span>메모</span><input value={memo} maxLength={LEDGER_LIMITS.memoChars} placeholder="선택" onChange={event=>setMemo(event.target.value)}/></label>
    </div>
    <div className="ledger-sheet__actions">
      {initial&&onDelete&&<Button variant="ghost" className="is-danger" onClick={async()=>{if(await onDelete())onClose();}}>삭제</Button>}
      {initial&&<Button variant="ghost" disabled={!valid} onClick={()=>void save(!initial.dropped)}>{initial.dropped?'다시 사기로':'안 사기로 함'}</Button>}
      <Button variant="primary" disabled={!valid} onClick={()=>void save()}>저장</Button>
    </div>
  </Sheet>;
}

/** A derived charge in 기록: confirm the real amount, or skip it this time (a 0-won entry). */
export function ChargeSheet({name,date,amount,error,onConfirm,onSkip,onClose}:{name:string;date:string;amount:number;error?:string|null;onConfirm():void;onSkip():void;onClose():void}) {
  return <Sheet title={`${name} · ${longDate(date)}`} onClose={onClose} error={error}>
    <p className="hint">고정·구독에서 계산한 결제입니다 ({won(amount)}). 실제와 다르면 확정하거나 건너뛰세요.</p>
    <button type="button" className="sheet-option" onClick={onConfirm}>실제 금액으로 확정</button>
    <button type="button" className="sheet-option" onClick={onSkip}>이번 달은 건너뜀</button>
  </Sheet>;
}
