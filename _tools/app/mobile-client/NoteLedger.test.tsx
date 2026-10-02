import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Notes,type MobileNote} from './Notes';
import {pressKey} from './NoteLedgerSheets';
import type {LedgerEntry,Planned,Recurring} from '../src/notes/ledger/model';
const mock=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mock.native,errorText:(e:Error)=>e.message}));

// The mockup fixture (docs/prototypes/budget-notes-20260925, summary.test.ts): on 2026-09-25,
// 2,300,000 − 1,612,500 − 124,890 = 562,610.
const rec=(id:string,name:string,amount:number,start:string,change:Partial<Recurring>={}):Recurring=>({id,name,amount,every:1,unit:'month',start,trial:false,until:null,memo:'',order:id,...change});
const plan=(id:string,name:string,amount:number,month:string|null,change:Partial<Planned>={}):Planned=>({id,name,amount,month,memo:'',dropped:false,order:id,...change});
const entry=(id:string,date:string,amount:number,name:string,change:Partial<LedgerEntry>={}):LedgerEntry=>({id,date,amount,name,createdAt:`${date}T12:00:00Z`,...change});
const LEDGER_ID='11111111-2222-4333-8444-555555555555';
const monthId=(month:string)=>`${month.replace('-','')}`.padEnd(32,'a');
const base={pinned:false,deleted:false,createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-20T00:00:00Z',localRevision:1,pending:false,conflict:false,body:''};
const ledger:MobileNote={...base,id:LEDGER_ID,type:'ledger',title:'가계부',pinned:true,income:2300000,
  recurring:[rec('rent','월세',800000,'2026-01-01'),rec('insurance','보험',98400,'2026-01-05'),rec('phone','통신',55000,'2026-01-10'),rec('netflix','넷플릭스',17000,'2026-01-03'),
    rec('millie','밀리의 서재',29700,'2026-03-12',{every:3}),rec('coupang','쿠팡 와우',7890,'2026-01-27'),rec('gpt','ChatGPT Plus',28000,'2026-01-29'),
    rec('google','Google One',24000,'2026-03-14',{unit:'year'}),rec('nintendo','닌텐도 온라인',19900,'2025-11-02',{unit:'year',until:'2026-11-02'}),rec('disney','디즈니+',9900,'2026-10-01',{trial:true})],
  planned:[plan('shoes','러닝화',89000,'2026-09'),plan('umbrella','접이식 우산',25000,'2026-09'),plan('tent','텐트',300000,'2026-09',{dropped:true}),plan('arm','모니터암',45000,null)]};
const september:LedgerEntry[]=[entry('e1','2026-09-25',9500,'점심 김치찌개'),entry('e2','2026-09-25',3200,'편의점'),entry('e3','2026-09-24',31800,'저녁 장보기'),
  entry('e4','2026-09-19',22000,'접이식 우산',{planned:'umbrella'}),entry('e5','2026-09-12',420000,'여행 숙소'),entry('e6','2026-09-06',125900,'마트')];
const monthNote=(month:string,entries:LedgerEntry[]):MobileNote=>({...base,id:monthId(month),type:'ledger-month',title:`가계부 ${month}`,archived:true,ledger:LEDGER_ID,month,income:null,entries});
const text:MobileNote={...base,id:'c'.repeat(32),title:'다음에 볼 작품',body:'메모'};

let db:MobileNote[]=[];
const saves=()=>mock.native.mock.calls.filter(([op])=>op==='notesSave').map(([,p])=>p as Record<string,unknown>);
function serve(notes:MobileNote[]){
  db=notes;
  mock.native.mockImplementation(async(op:string,p:Record<string,unknown>)=>{
    if(op==='notesLedgerMonthId')return {id:monthId(String(p.month))};
    if(op==='notesSave'){const note={...base,...db.find(n=>n.id===p.id),...p,localRevision:Number(p.expectedRevision)+1,pending:true,updatedAt:new Date().toISOString()} as MobileNote;db=[note,...db.filter(n=>n.id!==note.id)];return note;}
    return {unlocked:true,notes:db};
  });
}
beforeEach(()=>{mock.native.mockReset();vi.useFakeTimers({toFake:['Date'],now:new Date(2026,8,25,12)});serve([text,ledger,monthNote('2026-09',september)]);});
afterEach(()=>{cleanup();vi.useRealTimers();});
const renderNotes=(backRef:{current:(()=>boolean)|null}={current:null})=>render(<Notes active backRef={backRef}/>);
async function openLedger(){fireEvent.click(await screen.findByRole('button',{name:/^가계부/}));await screen.findByRole('heading',{name:'구독'});}
const sheet=async()=>within(await screen.findByRole('dialog'));
const lastSave=(id:string)=>saves().filter(s=>s.id===id).at(-1)!;

const section=(name:string)=>within(screen.getByRole('region',{name}));
const openSub=(name:string)=>fireEvent.click(section('구독').getByRole('button',{name:new RegExp(`^${name}`)}));
it('keeps the number pad for entry editing',()=>{expect(pressKey('','0')).toBe('');expect(pressKey('12','000')).toBe('12000');expect(pressKey('12000','⌫')).toBe('1200');});
it('renders old ledgers with the accepted budget figures and this-month strip',async()=>{
 renderNotes();await openLedger();
 for(const [label,value] of [['예산','₩2,300,000'],['고정','₩1,035,990'],['쓴 돈','₩612,400'],['남은 돈','₩651,610']])expect(screen.getByLabelText(label!).textContent).toBe(value);
 expect(section('이번 달 결제 예정').getAllByRole('listitem')).toHaveLength(2);expect(screen.queryByText('가계부 2026-09')).toBeNull();expect(saves()).toHaveLength(0);
});
it('renders lifecycle pills, trial amount, reminders and next charge',async()=>{
 serve([text,{...ledger,recurring:[rec('r','무료',17000,'2026-09-28',{trial:true,trialFrom:'2026-06-28',remindDays:3}),rec('n','연간',120000,'2026-03-01',{unit:'year'}),rec('c','분기',30000,'2026-01-01',{every:3,until:'2026-10-01'})]}]);renderNotes();await openLedger();const subs=section('구독');
 for(const pill of ['매달','1년 갱신','3달마다','처음 3달 무료','무료 D-3','해지 예약'])expect(subs.getByText(pill)).toBeTruthy();expect(subs.getByRole('button',{name:/^연간/}).textContent).toContain('2027.3.1 · ₩120,000월 ₩10,000');expect(section('이번 달 결제 예정').getByText('D-3')).toBeTruthy();
});
it('changes price and reminder, preserving old price and unknown fields',async()=>{
 serve([text,{...ledger,recurring:[rec('r','구독',10000,'2026-01-01',{extraField:'keep'})]}]);renderNotes();await openLedger();openSub('구독');let s=await sheet();
 fireEvent.click(s.getByRole('button',{name:'가격 바꾸기'}));fireEvent.change(s.getByLabelText('가격'),{target:{value:'8000'}});fireEvent.change(s.getByLabelText('가격 적용일'),{target:{value:'2026-09-25'}});fireEvent.change(s.getByLabelText('알림'),{target:{value:'7'}});fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect((lastSave(LEDGER_ID).recurring as Recurring[])[0]).toMatchObject({amount:8000,priceHistory:[{until:'2026-09-25',amount:10000}],remindDays:7,extraField:'keep'});expect((lastSave(LEDGER_ID).recurring as Recurring[])[0]).not.toHaveProperty('trialFrom');openSub('구독');s=await sheet();expect(s.getByText('9.25에 ₩10,000에서 내림')).toBeTruthy();
});
it.each(['scheduled','now'])('cancels %s before the trial’s first charge',async mode=>{
 serve([text,{...ledger,recurring:[rec('r','구독',10000,'2026-10-01',{trial:true})]}]);renderNotes();await openLedger();openSub('구독');const s=await sheet();fireEvent.change(s.getByLabelText('해지'),{target:{value:mode}});fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(lastSave(LEDGER_ID)).toBeTruthy());expect((lastSave(LEDGER_ID).recurring as Recurring[])[0]!.until).toBe(mode==='now'?'2026-09-25':'2026-10-01');
});
it('adds a cycle and trial, leaving optional fields absent on old name-only edits',async()=>{
 renderNotes();await openLedger();openSub('월세');let s=await sheet();fireEvent.change(s.getByLabelText('이름'),{target:{value:'집세'}});fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 const rent=(lastSave(LEDGER_ID).recurring as Recurring[]).find(r=>r.id==='rent')!;for(const key of ['trialFrom','priceHistory','remindDays'])expect(rent).not.toHaveProperty(key);
 fireEvent.click(screen.getByRole('button',{name:'+ 구독 추가'}));s=await sheet();fireEvent.change(s.getByLabelText('이름'),{target:{value:'새 구독'}});fireEvent.change(s.getByLabelText('가격'),{target:{value:'30000'}});fireEvent.click(s.getByRole('radio',{name:'N달마다'}));fireEvent.click(s.getByRole('radio',{name:'처음 1달 무료'}));fireEvent.change(s.getByLabelText('무료 개월'),{target:{value:'2'}});fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect((lastSave(LEDGER_ID).recurring as Recurring[]).find(r=>r.name==='새 구독')).toMatchObject({every:3,trial:true,trialFrom:'2026-09-25',start:'2026-11-25'});
});
it('expands the wish, buys into today’s entry, removes it and keeps entry editing',async()=>{
 renderNotes();await openLedger();fireEvent.click(section('사고 싶은 것').getByRole('button',{name:/러닝화/}));expect(screen.getByText('이번 달에 사면 남는 돈').parentElement!.textContent).toContain('₩562,610');expect((document.querySelector('.ledger-budget-meter__plan') as HTMLElement).style.width).not.toBe('0%');fireEvent.click(screen.getByRole('button',{name:'샀음'}));await waitFor(()=>expect(section('사고 싶은 것').queryByText('러닝화')).toBeNull());
 expect((lastSave(monthId('2026-09')).entries as LedgerEntry[]).find(e=>e.planned==='shoes')).toMatchObject({amount:89000,date:'2026-09-25'});fireEvent.click(section('지출').getByRole('button',{name:/러닝화/}));const s=await sheet();for(let i=0;i<5;i++)fireEvent.click(s.getByRole('button',{name:'지우기'}));for(const k of ['8','4','000'])fireEvent.click(s.getByRole('button',{name:k}));fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect((lastSave(monthId('2026-09')).entries as LedgerEntry[]).find(e=>e.planned==='shoes')!.amount).toBe(84000);
});
it('edits wishlist where and priority, without populating them on name-only edits',async()=>{
 renderNotes();await openLedger();fireEvent.click(section('사고 싶은 것').getByRole('button',{name:/러닝화/}));fireEvent.click(screen.getByRole('button',{name:'고치기'}));let s=await sheet();fireEvent.change(s.getByLabelText('이름'),{target:{value:'운동화'}});fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());let p=(lastSave(LEDGER_ID).planned as Planned[]).find(p=>p.id==='shoes')!;expect(p).not.toHaveProperty('where');expect(p).not.toHaveProperty('priority');
 fireEvent.click(screen.getByRole('button',{name:'고치기'}));s=await sheet();fireEvent.change(s.getByLabelText('구매처'),{target:{value:'쿠팡'}});fireEvent.change(s.getByLabelText('우선순위'),{target:{value:'2'}});fireEvent.click(s.getByRole('button',{name:'저장'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());p=(lastSave(LEDGER_ID).planned as Planned[]).find(p=>p.id==='shoes')!;expect(p).toMatchObject({where:'쿠팡',priority:2});
});
it('quick input is IME safe and creates the native month note on first use',async()=>{
 serve([text,{...ledger,recurring:[],planned:[]}]);renderNotes();await openLedger();const field=screen.getByLabelText('지출 빠른 입력');fireEvent.change(field,{target:{value:'점심 8000'}});fireEvent.compositionStart(field);fireEvent.keyDown(field,{key:'Enter'});expect(saves()).toHaveLength(0);fireEvent.compositionEnd(field);fireEvent.keyDown(field,{key:'Enter'});await waitFor(()=>expect(lastSave(monthId('2026-09'))).toBeTruthy());
 expect(lastSave(monthId('2026-09'))).toMatchObject({type:'ledger-month',ledger:LEDGER_ID,archived:true,entries:[expect.objectContaining({amount:8000,name:'점심',date:'2026-09-25'})]});expect(mock.native).toHaveBeenCalledWith('notesLedgerMonthId',{ledger:LEDGER_ID,month:'2026-09'});await waitFor(()=>expect((field as HTMLInputElement).value).toBe(''));
});
it('keeps the screen and prevents duplicate saves while the month id is pending',async()=>{
 serve([text,{...ledger,recurring:[],planned:[]}]);const original=mock.native.getMockImplementation()!;let resolve!:(v:{id:string})=>void;const pending=new Promise<{id:string}>(r=>{resolve=r;});mock.native.mockImplementation((op,p)=>op==='notesLedgerMonthId'?pending:original(op,p));renderNotes();await openLedger();const field=screen.getByLabelText('지출 빠른 입력');fireEvent.change(field,{target:{value:'점심 8000'}});fireEvent.keyDown(field,{key:'Enter'});fireEvent.keyDown(field,{key:'Enter'});expect(screen.getByLabelText('예산').textContent).toBe('₩2,300,000');resolve({id:monthId('2026-09')});await waitFor(()=>expect((field as HTMLInputElement).value).toBe(''));expect(lastSave(monthId('2026-09')).entries).toHaveLength(1);
});
it('retains entry sheets on limit errors and preserves Korean composition',async()=>{
 serve([text,{...ledger,recurring:[],planned:[]},monthNote('2026-09',Array.from({length:300},(_,i)=>entry(`f${i}`,'2026-09-25',1000,'마트')))]);renderNotes();await openLedger();fireEvent.click(screen.getByRole('button',{name:'기록'}));const s=await sheet();const field=s.getByPlaceholderText('이름 (선택)');act(()=>field.focus());fireEvent.compositionStart(field);fireEvent.input(field,{target:{value:'ㅎ'},isComposing:true});fireEvent.keyDown(field,{key:'Enter'});expect(document.activeElement).toBe(field);fireEvent.compositionEnd(field);fireEvent.click(s.getByRole('button',{name:'1'}));fireEvent.click(s.getByRole('button',{name:'저장'}));expect((await s.findByRole('alert')).textContent).toContain('300개');expect(screen.getByRole('dialog')).toBeTruthy();expect(saves()).toHaveLength(0);
});
it('Back closes the sheet before leaving the ledger',async()=>{
 const backRef:{current:(()=>boolean)|null}={current:null};renderNotes(backRef);await openLedger();fireEvent.click(screen.getByRole('button',{name:'기록'}));await screen.findByRole('dialog');act(()=>{expect(backRef.current?.()).toBe(true);});await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(screen.getByRole('heading',{name:'구독'})).toBeTruthy();act(()=>{expect(backRef.current?.()).toBe(true);});await waitFor(()=>expect(screen.queryByRole('heading',{name:'구독'})).toBeNull());
});
