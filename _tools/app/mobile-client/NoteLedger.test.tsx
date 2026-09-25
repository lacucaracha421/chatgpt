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
async function openLedger(){fireEvent.click(await screen.findByRole('button',{name:/^가계부/}));await screen.findByRole('tablist',{name:'가계부'});}
const sheet=async()=>within(await screen.findByRole('dialog'));
const lastSave=(id:string)=>saves().filter(s=>s.id===id).at(-1)!;

it('number pad presses: no leading zeros, 000, backspace and at most 12 digits',()=>{
  expect(pressKey('','0')).toBe('');expect(pressKey('','000')).toBe('');
  expect(pressKey('12','000')).toBe('12000');expect(pressKey('12000','⌫')).toBe('1200');
  expect(pressKey('999999999999','1')).toBe('999999999999');expect(pressKey('99999999999','000')).toBe('99999999999');
});
it('shows the month figures from the fixture on the card and the 이번 달 tab, and keeps month notes out of the list and 보관함',async()=>{
  renderNotes();
  const card=await screen.findByRole('button',{name:/^가계부/});
  expect(card.textContent).toContain('9월 쓸 수 있는 돈 ₩562,610');
  expect(card.textContent).toContain('다음 결제 9월 27일 쿠팡 와우');
  // The archived month note is hidden: no 보관함 link, no card titled after the month.
  expect(screen.queryByText('가계부 2026-09')).toBeNull();
  expect(screen.queryByRole('button',{name:/보관함/})).toBeNull();
  // Search matches the ledger by title only (its fallback body is not searched).
  fireEvent.change(screen.getByRole('textbox',{name:'메모 검색'}),{target:{value:'김치찌개'}});
  expect(screen.queryByRole('button',{name:/^가계부/})).toBeNull();
  fireEvent.change(screen.getByRole('textbox',{name:'메모 검색'}),{target:{value:''}});
  await openLedger();
  expect(screen.getByLabelText('이번 달 쓸 수 있는 돈').textContent).toBe('₩562,610');
  const figures=document.querySelector('.ledger-figures')!.textContent!;
  for(const value of ['수입2,300,000','쓴 돈1,612,500','예정124,890','고정·구독 이번 달1,035,990'])expect(figures).toContain(value);
  expect(document.querySelector('.ledger-hero__sub')!.textContent).toContain('하루 약 ₩93,768 · 남은 날 6일');
  expect(screen.getByRole('button',{name:/수입 2,300,000/})).toBeTruthy();
  // 다가오는 결제 continues into October.
  const upcoming=screen.getByRole('heading',{name:/다가오는 결제/}).parentElement!;
  const rows=[...upcoming.querySelectorAll('li')];
  expect(rows.map(n=>n.querySelector('strong')!.textContent).slice(0,2)).toEqual(['쿠팡 와우','ChatGPT Plus']);
  expect(rows).toHaveLength(3);expect(rows[2]!.textContent).toContain('10월 ·');
  // Past months are final: the previous month has no scheduled plans.
  fireEvent.click(screen.getByRole('button',{name:'이전 달'}));
  expect(await screen.findByText('2026년 8월')).toBeTruthy();
  expect(screen.getByLabelText('8월에 남은 돈')).toBeTruthy();
});
it('adds an entry with the number pad into the month note, keeping the keyboard closed, and 저장하고 하나 더 keeps the sheet open',async()=>{
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('button',{name:'기록'}));
  const s=await sheet();
  // Opening the sheet focuses no text field (the Android keyboard stays down).
  expect(document.activeElement?.tagName).not.toBe('INPUT');
  for(const key of ['1','2','000'])fireEvent.click(s.getByRole('button',{name:key}));
  fireEvent.click(s.getByRole('button',{name:'5'}));fireEvent.click(s.getByRole('button',{name:'지우기'}));
  expect(document.querySelector('.ledger-amount')!.textContent).toBe('₩12,000');
  // Recent names are one tap.
  fireEvent.click(s.getByRole('button',{name:'편의점'}));
  expect((s.getByPlaceholderText('이름 (선택)') as HTMLInputElement).value).toBe('편의점');
  fireEvent.click(s.getByRole('button',{name:'저장하고 하나 더'}));
  await waitFor(()=>expect((lastSave(monthId('2026-09')).entries as LedgerEntry[]).some(e=>e.amount===12000&&e.name==='편의점'&&e.date==='2026-09-25'&&!e.in)).toBe(true));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await waitFor(()=>expect(document.querySelector('.ledger-amount')!.textContent).toBe('₩0'));
  // A refund: 들어온 돈.
  fireEvent.click(s.getByRole('radio',{name:'들어온 돈'}));
  fireEvent.click(s.getByRole('button',{name:'3'}));fireEvent.click(s.getByRole('button',{name:'000'}));
  fireEvent.click(s.getByRole('button',{name:'어제'}));
  fireEvent.click(s.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  const entries=lastSave(monthId('2026-09')).entries as LedgerEntry[];
  expect(entries.find(e=>e.amount===3000)).toMatchObject({in:true,date:'2026-09-24'});
  expect(entries).toHaveLength(september.length+2);
  expect(screen.getByLabelText('이번 달 쓸 수 있는 돈').textContent).toBe('₩553,610');
});
it('creates the month note on first use through the native month id',async()=>{
  serve([text,ledger]);
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('button',{name:'기록'}));
  const s=await sheet();
  fireEvent.click(s.getByRole('button',{name:'7'}));fireEvent.click(s.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(saves().some(p=>p.id===monthId('2026-09'))).toBe(true));
  expect(mock.native).toHaveBeenCalledWith('notesLedgerMonthId',{ledger:LEDGER_ID,month:'2026-09'});
  expect(lastSave(monthId('2026-09'))).toMatchObject({type:'ledger-month',ledger:LEDGER_ID,month:'2026-09',archived:true,entries:[expect.objectContaining({amount:7})]});
});
it('adds a recurring charge with its cycle and lists it by next charge',async()=>{
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('tab',{name:'고정·구독'}));
  expect(screen.getByText('월 환산 합계')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'고정·구독 추가'}));
  const s=await sheet();
  fireEvent.change(s.getByPlaceholderText('넷플릭스, 월세, 보험…'),{target:{value:'헬스장'}});
  fireEvent.change(s.getByRole('textbox',{name:'금액'}),{target:{value:'165000'}});
  fireEvent.click(s.getByRole('button',{name:'주기 늘리기'}));fireEvent.click(s.getByRole('button',{name:'주기 늘리기'}));
  fireEvent.click(s.getByRole('radio',{name:'개월마다'}));
  fireEvent.click(s.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect((lastSave(LEDGER_ID)?.recurring as Recurring[]|undefined)?.some(r=>r.name==='헬스장')).toBe(true));
  expect((lastSave(LEDGER_ID).recurring as Recurring[]).find(r=>r.name==='헬스장')).toMatchObject({amount:165000,every:3,unit:'month',start:'2026-09-25',trial:false,until:null});
  expect(await screen.findByText('3개월마다 · 25일')).toBeTruthy();
  expect(screen.getByText('헬스장').closest('li')!.textContent).toContain('월 55,000');
});
it('plan → 샀어요 opens a pre-filled entry linked to the plan and marks the plan done',async()=>{
  renderNotes();await openLedger();
  const row=screen.getByText('러닝화').closest('li')!;
  fireEvent.click(within(row).getByRole('button',{name:'샀어요'}));
  const s=await sheet();
  expect(document.querySelector('.ledger-amount')!.textContent).toBe('₩89,000');
  expect((s.getByPlaceholderText('이름 (선택)') as HTMLInputElement).value).toBe('러닝화');
  expect(s.queryByRole('button',{name:'저장하고 하나 더'})).toBeNull();
  // The real price differs: 89,000 → 84,000.
  for(let i=0;i<5;i++)fireEvent.click(s.getByRole('button',{name:'지우기'}));
  for(const key of ['8','4','000'])fireEvent.click(s.getByRole('button',{name:key}));
  fireEvent.click(s.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect((lastSave(monthId('2026-09'))?.entries as LedgerEntry[]|undefined)?.some(e=>e.planned==='shoes')).toBe(true));
  expect((lastSave(monthId('2026-09')).entries as LedgerEntry[]).find(e=>e.planned==='shoes')).toMatchObject({amount:84000,name:'러닝화',date:'2026-09-25'});
  const planRow=()=>document.querySelector('.ledger-row.is-plan')!;
  await waitFor(()=>expect(planRow().className).toContain('is-done'));
  expect(planRow().textContent).toContain('러닝화');expect(planRow().textContent).toContain('실제 ₩84,000');
  // The plan no longer counts as scheduled; the entry counts as spent: 562,610 + 89,000 − 84,000.
  expect(screen.getByLabelText('이번 달 쓸 수 있는 돈').textContent).toBe('₩567,610');
});
it('shows forked entries and resolves them with 이것만 남기기',async()=>{
  serve([ledger,monthNote('2026-09',[...september,entry('e1-copy','2026-09-25',9000,'점심 김치찌개',{forkOf:'e1'})])]);
  renderNotes();await openLedger();
  expect(screen.getByRole('button',{name:/확인할 기록 1건/})).toBeTruthy();
  fireEvent.click(screen.getByRole('tab',{name:'기록'}));
  expect(screen.getAllByText('두 기기에서 다르게 고침')).toHaveLength(2);
  const copy=screen.getByText('₩9,000').closest('li')!;
  fireEvent.click(within(copy).getByRole('button',{name:'이것만 남기기'}));
  await waitFor(()=>expect(saves().some(p=>p.id===monthId('2026-09'))).toBe(true));
  const entries=lastSave(monthId('2026-09')).entries as LedgerEntry[];
  expect(entries.find(e=>e.id==='e1')).toBeUndefined();
  expect(entries.find(e=>e.id==='e1-copy')).toEqual(expect.not.objectContaining({forkOf:expect.anything()}));
  await waitFor(()=>expect(screen.queryByText('두 기기에서 다르게 고침')).toBeNull());
});
it('shows derived charges in 기록 and skips one with a 0-won entry',async()=>{
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('tab',{name:'기록'}));
  const derived=screen.getAllByText('월세').find(n=>n.closest('li')?.className.includes('is-derived'))!.closest('li')!;
  fireEvent.click(derived);
  fireEvent.click((await sheet()).getByRole('button',{name:'이번 달은 건너뜀'}));
  await waitFor(()=>expect((lastSave(monthId('2026-09'))?.entries as LedgerEntry[]|undefined)?.some(e=>e.recurring?.id==='rent')).toBe(true));
  expect((lastSave(monthId('2026-09')).entries as LedgerEntry[]).find(e=>e.recurring?.id==='rent')).toMatchObject({amount:0,date:'2026-09-01',recurring:{id:'rent',date:'2026-09-01'}});
});
it('Back closes a ledger sheet first, then leaves the ledger',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  renderNotes(backRef);await openLedger();
  fireEvent.click(screen.getByRole('button',{name:'기록'}));await screen.findByRole('dialog');
  act(()=>{expect(backRef.current?.()).toBe(true);});
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('tablist',{name:'가계부'})).toBeTruthy();
  act(()=>{expect(backRef.current?.()).toBe(true);});
  await waitFor(()=>expect(screen.queryByRole('tablist',{name:'가계부'})).toBeNull());
  expect(await screen.findByText('다음에 볼 작품')).toBeTruthy();
  expect(backRef.current?.()).toBe(false);
});
it('the 가계부 option opens the existing ledger, or creates one pinned',async()=>{
  renderNotes();await screen.findByText('다음에 볼 작품');
  fireEvent.click(screen.getByRole('button',{name:'새 메모'}));
  fireEvent.click((await sheet()).getByRole('button',{name:'가계부'}));
  expect(await screen.findByLabelText('이번 달 쓸 수 있는 돈')).toBeTruthy();
  expect(saves().some(p=>p.type==='ledger')).toBe(false);
  cleanup();mock.native.mockReset();serve([text]);
  renderNotes();await screen.findByText('다음에 볼 작품');
  fireEvent.click(screen.getByRole('button',{name:'새 메모'}));
  fireEvent.click((await sheet()).getByRole('button',{name:'가계부'}));
  await waitFor(()=>expect(saves().some(p=>p.type==='ledger')).toBe(true));
  expect(saves().find(p=>p.type==='ledger')).toMatchObject({pinned:true,title:'가계부',income:null,recurring:[],planned:[]});
  expect(await screen.findByRole('button',{name:'수입을 적으면 쓸 수 있는 돈이 보여요'})).toBeTruthy();
});
it('sets this month’s income separately from the default',async()=>{
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('button',{name:/수입 2,300,000/}));
  const s=await sheet();
  fireEvent.click(s.getByRole('radio',{name:'9월만'}));
  for(let i=0;i<7;i++)fireEvent.click(s.getByRole('button',{name:'지우기'}));
  for(const key of ['2','5','000','0','0'])fireEvent.click(s.getByRole('button',{name:key}));
  fireEvent.click(s.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(lastSave(monthId('2026-09'))?.income).toBe(2500000));
  expect(saves().some(p=>p.id===LEDGER_ID)).toBe(false);
  await waitFor(()=>expect(screen.getByLabelText('이번 달 쓸 수 있는 돈').textContent).toBe('₩762,610'));
});
it('refuses an entry over the monthly limit, keeping the sheet and the typed amount (also for 저장하고 하나 더)',async()=>{
  const full=Array.from({length:300},(_,i)=>entry(`f${i}`,'2026-09-02',1000,'마트'));
  serve([ledger,monthNote('2026-09',full)]);
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('button',{name:'기록'}));
  const s=await sheet();
  for(const key of ['4','000'])fireEvent.click(s.getByRole('button',{name:key}));
  fireEvent.click(s.getByRole('button',{name:'저장하고 하나 더'}));
  expect((await s.findByRole('alert')).textContent).toBe('기록은 300개까지 저장할 수 있습니다.');
  fireEvent.click(s.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(s.getByRole('alert').textContent).toContain('300개'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(document.querySelector('.ledger-amount')!.textContent).toBe('₩4,000');
  expect(saves().some(p=>p.id===monthId('2026-09'))).toBe(false);
});
it('refuses a recurring item that would make the ledger note too large, keeping the typed input',async()=>{
  const long='가'.repeat(100),memo='나'.repeat(500);
  const recurring=Array.from({length:199},(_,i)=>rec(`r${i}`,`${long.slice(0,95)}${i}`,1000,'2026-01-01',{memo}));
  serve([{...ledger,recurring,planned:[]}]);
  renderNotes();await openLedger();
  fireEvent.click(screen.getByRole('tab',{name:'고정·구독'}));
  fireEvent.click(screen.getByRole('button',{name:'고정·구독 추가'}));
  const s=await sheet();
  fireEvent.change(s.getByPlaceholderText('넷플릭스, 월세, 보험…'),{target:{value:long}});
  fireEvent.change(s.getByRole('textbox',{name:'금액'}),{target:{value:'5000'}});
  fireEvent.change(s.getByPlaceholderText('선택'),{target:{value:memo}});
  fireEvent.click(s.getByRole('button',{name:'저장'}));
  expect((await s.findByRole('alert')).textContent).toBe('가계부 항목이 너무 많습니다. 끝난 항목을 지워 주세요.');
  expect((s.getByPlaceholderText('넷플릭스, 월세, 보험…') as HTMLInputElement).value).toBe(long);
  expect(saves().some(p=>p.id===LEDGER_ID)).toBe(false);
});
it('the 가계부 option restores a ledger from the trash instead of creating a second one',async()=>{
  serve([text,{...ledger,deleted:true},monthNote('2026-09',september)]);
  renderNotes();await screen.findByText('다음에 볼 작품');
  fireEvent.click(screen.getByRole('button',{name:'새 메모'}));
  fireEvent.click((await sheet()).getByRole('button',{name:'가계부'}));
  expect((await screen.findByLabelText('이번 달 쓸 수 있는 돈')).textContent).toBe('₩562,610');
  await waitFor(()=>expect(saves().some(p=>p.id===LEDGER_ID&&p.deleted===false)).toBe(true));
  expect(saves().filter(p=>p.type==='ledger'&&p.id!==LEDGER_ID)).toHaveLength(0);
});
