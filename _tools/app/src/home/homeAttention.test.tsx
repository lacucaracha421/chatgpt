import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../notes/store';
import type { Recurring } from '../notes/ledger/model';
import { attentionRows, HOME_VISIT_KEY, newHomeArrivals, readHomeVisit, writeHomeVisit } from './homeAttention';
import { HomePresence, HomeToday } from './HomeAttention';
import { useHomeVisit } from './useHomeVisit';
const today = '2026-10-30';
const note = (id: string, fields: Partial<Note> = {}): Note => ({ id, title:id, body:'', pinned:true, deleted:false, updatedAt:today, createdAt:today, localRevision:1, conflict:false, pending:false, ...fields });
const recurring = (fields: Partial<Recurring> = {}): Recurring => ({ id:'sub',name:'구독',amount:10000,every:1,unit:'month',start:'2026-11-01',trial:false,until:null,memo:'',order:'a',remindDays:2,...fields });
beforeEach(() => localStorage.clear());
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
describe('shared attention rows', () => {
  it('orders subscriptions, today reminders, nonzero reviews, pinned tasks, then connection problems', () => {
    const rows = attentionRows([note('ledger',{type:'ledger',pinned:false,recurring:[recurring()]}), note('task',{body:'- [ ] 남음\n- [x] 완료'}),note('plain',{body:'일반 글'})], [ {key:'pending',label:'처리 대기',count:2},{key:'tagger',label:'태거',count:5},{key:'similar',label:'유사 이미지 검토',count:1},{key:'unsorted',label:'미분류 에셋',count:3},{key:'duplicates',label:'중복 판본',count:0} ], [{key:'server',label:'서버',value:'연결됨',tone:'ok'},{key:'cloud',label:'클라우드',value:'문제 1개',tone:'off'}],today);
    expect(rows.map(r=>r.key)).toEqual(['subscriptions','reminder:ledger:sub:2026-11-01','unsorted','similar','pending','tagger','note:task','connection:cloud']);
    expect(rows[1]?.days).toBe(2); expect(rows[6]?.secondary).toBe('남은 항목 1개');
  });
  it('uses actual monthly charges including price history and yearly renewals', () => {
    const rows=attentionRows([note('ledger',{type:'ledger',recurring:[recurring({start:'2026-10-31',amount:20000,priceHistory:[{until:'2026-11-01',amount:10000}]}),recurring({id:'year',start:'2026-10-01',unit:'year',amount:120000,remindDays:null})]})],[],[],today);
    expect(rows[0]?.label).toBe('구독 이번 달 ₩130,000');
    expect(rows[0]?.secondary).toBe('다음 결제 1일 후 · 구독');
  });
  it.each(['2026-10-29','2026-11-02'])('hides reminders outside the window on %s', date => {
    expect(attentionRows([note('ledger',{type:'ledger',recurring:[recurring() ]})],[],[],date).filter(r=>r.days!==undefined)).toEqual([]);
  });
  it('deduplicates trial end and first charge, including D-day zero', () => {
    const rows = attentionRows([note('ledger',{type:'ledger',recurring:[recurring({trial:true})]})],[],[],'2026-11-01');
    expect(rows.filter(r=>r.days!==undefined)).toHaveLength(1);
    expect(rows[1]).toMatchObject({label:'구독 무료 끝남',days:0});
  });
  it('has no subscription row without subscriptions; excludes done, unpinned, archived, concealed and deleted notes', () => {
    expect(attentionRows([note('ledger',{type:'ledger',recurring:[]}),note('done',{body:'- [x] 끝'}),note('unpinned',{pinned:false,body:'- [ ] 남음'}),note('archive',{archived:true,body:'- [ ] 남음'}),note('hidden',{concealed:true,body:'- [ ] 남음'}),note('trash',{deleted:true,body:'- [ ] 남음'})],[],[],today)).toEqual([]);
  });
  it('uses legacy checklist notes and counts all tasks beyond a five-item preview', () => {
    const rows=attentionRows([note('legacy',{type:'checklist',items:Array.from({length:8},(_,i)=>({id:String(i),text:String(i),checked:i===0,order:String(i)}))})],[],[],today);
    expect(rows[0]?.secondary).toBe('남은 항목 7개');
  });
  it('renders the quiet empty state and opens the exact row', () => {
    vi.useFakeTimers(); const open=vi.fn(); const view=render(<HomeToday rows={[]} onOpen={open}/>);
    expect(screen.getByText('오늘 할 것이 없습니다')).toBeTruthy();
    view.rerender(<HomeToday rows={[{key:'task',label:'작업',noteId:'n'}]} onOpen={open}/>);
    act(()=>vi.advanceTimersByTime(160));
    fireEvent.click(screen.getByText('작업')); expect(open).toHaveBeenCalledWith({key:'task',label:'작업',noteId:'n'});
  });
});
describe('device visit and NEW', () => {
  const item={key:'work',token:'work:2026-11-01',date:'2026-11-01',fresh:false};
  it('does not announce all history on first visit, and retains known unread NEW', () => {
    const visit=readHomeVisit('pc'); expect(newHomeArrivals([item],visit,'2026-11-02')).toEqual([]);
    expect(newHomeArrivals([{...item,fresh:true}],visit,'2026-11-02')).toHaveLength(1);
  });
  it('discovers passed dates after the previous visit and retains them on the next visit', () => {
    writeHomeVisit('pc',{lastVisit:new Date(2026,9,30,23,59).toISOString(),pending:[],opened:[]});
    const first=renderHook(()=>useHomeVisit('pc',[item],'2026-11-02',true,new Date(2026,10,2).toISOString()));
    expect(first.result.current.arrivals).toHaveLength(1); first.unmount();
    const next=renderHook(()=>useHomeVisit('pc',[item],'2026-11-03',true,new Date(2026,10,3).toISOString()));
    expect(next.result.current.arrivals).toHaveLength(1);
    act(()=>next.result.current.opened(item.token)); expect(next.result.current.arrivals).toEqual([]);
    expect(readHomeVisit('pc').opened).toContain(item.token);
  });
  it('adopts each scope and paused visit without copying pending NEW to another connection', () => {
    writeHomeVisit('pc',{lastVisit:'2026-10-30T00:00:00Z',pending:[],opened:[]});
    const hook=renderHook(({scope,active})=>useHomeVisit(scope,[item],'2026-11-02',active,'2026-11-02T12:00:00Z'),{initialProps:{scope:'pc',active:true}});
    expect(hook.result.current.arrivals).toHaveLength(1);
    hook.rerender({scope:'tablet',active:true}); expect(hook.result.current.arrivals).toEqual([]);
    expect(readHomeVisit('tablet').pending).toEqual([]);
    hook.rerender({scope:'pc',active:false}); hook.rerender({scope:'pc',active:true});
    expect(hook.result.current.arrivals).toHaveLength(1);
  });
  it('uses the local date boundary, not the UTC date of a late-night visit', () => {
    const visit={lastVisit:new Date(2026,10,1,0,30).toISOString(),pending:[],opened:[]};
    expect(newHomeArrivals([item],visit,'2026-11-01')).toEqual([]);
  });
  it('keeps scopes separate and tolerates malformed or unavailable localStorage', () => {
    localStorage.setItem(HOME_VISIT_KEY+'pc','broken'); expect(readHomeVisit('pc').lastVisit).toBeNull();
    writeHomeVisit('pc',{lastVisit:'2026-10-30T12:00:00Z',pending:[item.token],opened:[]}); expect(readHomeVisit('tablet').pending).toEqual([]);
    vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('disabled');});
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('disabled');});
    expect(readHomeVisit('pc').pending).toEqual([]); expect(()=>writeHomeVisit('pc',{lastVisit:null,pending:[],opened:[]})).not.toThrow();
  });
});
describe('row motion', () => {
  it('retains a retiring row while space collapses and expands new rows over 140ms', () => {
    vi.useFakeTimers(); const view=render(<HomePresence items={[{key:'a',content:<span>A</span>}]}/>);
    view.rerender(<HomePresence items={[{key:'b',content:<span>B</span>}]}/>);
    expect(screen.getByText('A').closest('.home-presence')?.getAttribute('data-visible')).toBe('false');
    expect(screen.getByText('B').closest('.home-presence')?.getAttribute('data-visible')).toBe('false');
    act(()=>vi.advanceTimersByTime(16)); expect(screen.getByText('B').closest('.home-presence')?.getAttribute('data-visible')).toBe('true');
    act(()=>vi.advanceTimersByTime(140)); expect(screen.queryByText('A')).toBeNull();
  });
  it('resolves instantly with reduced motion', () => {
    vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
    const view=render(<HomePresence items={[{key:'a',content:'A'}]}/>); view.rerender(<HomePresence items={[]}/>);
    expect(screen.queryByText('A')).toBeNull();
  });
});
