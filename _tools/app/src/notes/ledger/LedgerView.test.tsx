import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotesStore, type Note, type NotesRequest } from "../store";
import { LedgerView } from "./LedgerView";
import type { LedgerEntry, Planned, Recurring } from "./model";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => cleanup());

const T = "2026-09-20T00:00:00Z";
const TODAY = "2026-09-25";
const base = (id: string, change: Partial<Note> = {}): Note => ({ id, title: id, body: "", pinned: false, deleted: false, createdAt: T, updatedAt: T, localRevision: 1, pending: false, conflict: false, ...change });
const rec = (id: string, name: string, amount: number, start: string, change: Partial<Recurring> = {}): Recurring =>
  ({ id, name, amount, every: 1, unit: "month", start, trial: false, until: null, memo: "", order: id, ...change });
const plan = (id: string, name: string, amount: number, month: string | null, change: Partial<Planned> = {}): Planned =>
  ({ id, name, amount, month, memo: "", dropped: false, order: id, ...change });
const entry = (id: string, date: string, amount: number, name: string, change: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ id, date, amount, name, createdAt: `${date}T12:00:00Z`, ...change });

// The mockup figures (same fixture as summary.test.ts): 2,300,000 − 1,612,500 − 124,890 = 562,610 on 2026-09-25.
const recurring = [
  rec("rent", "월세", 800000, "2026-01-01"), rec("insurance", "보험", 98400, "2026-01-05"), rec("phone", "통신", 55000, "2026-01-10"),
  rec("netflix", "넷플릭스", 17000, "2026-01-03"), rec("millie", "밀리의 서재", 29700, "2026-03-12", { every: 3 }),
  rec("coupang", "쿠팡 와우", 7890, "2026-01-27"), rec("gpt", "ChatGPT Plus", 28000, "2026-01-29"),
  rec("google", "Google One", 24000, "2026-03-14", { unit: "year" }),
  rec("nintendo", "닌텐도 온라인", 19900, "2025-11-02", { unit: "year", until: "2026-11-02" }),
  rec("disney", "디즈니+", 9900, "2026-10-01", { trial: true }),
];
const planned = [plan("shoes", "러닝화", 89000, "2026-09"), plan("umbrella", "접이식 우산", 25000, "2026-09"), plan("tent", "텐트", 300000, "2026-09", { dropped: true }), plan("arm", "모니터암", 45000, null)];
const september = [
  entry("e1", "2026-09-25", 9500, "점심 김치찌개"), entry("e2", "2026-09-25", 3200, "편의점"), entry("e3", "2026-09-24", 31800, "저녁 장보기"),
  entry("e4", "2026-09-19", 22000, "접이식 우산", { planned: "umbrella" }), entry("e5", "2026-09-12", 420000, "여행 숙소"), entry("e6", "2026-09-06", 125900, "마트"),
];
const ledgerNote = (change: Partial<Note> = {}) => base("L", { type: "ledger", title: "가계부", pinned: true, income: 2300000, recurring, planned, ...change });
const monthNote = (month: string, entries: LedgerEntry[], change: Partial<Note> = {}) =>
  base(`m-${month}`, { type: "ledger-month", title: `가계부 ${month}`, ledger: "L", month, income: null, entries, archived: true, ...change });

/** In-memory stand-in for the Rust backend: saves merge the draft; month ids are `m-YYYY-MM`. */
function backend(initial: Note[]) {
  let notes = initial;
  const calls: { op: string; input: any }[] = [];
  const request = (async (op: string, input: any) => {
    calls.push({ op, input });
    if (op === "ledgerMonthId") return { id: `m-${input.month}` };
    if (op === "save") {
      const { expectedRevision, ...draft } = input;
      const old = notes.find((n) => n.id === draft.id) ?? base(draft.id, { title: "", localRevision: 0 });
      const saved: Note = { ...old, ...draft, localRevision: expectedRevision + 1, pending: true };
      notes = [saved, ...notes.filter((n) => n.id !== saved.id)];
      return saved;
    }
    return { unlocked: true, notes, lastSyncedAt: null };
  }) as NotesRequest;
  return { request, saves: () => calls.filter((c) => c.op === "save").map((c) => c.input) };
}
const last = <T,>(list: T[]) => list[list.length - 1]!;
const settle = (store: NotesStore) => waitFor(() => expect(store.snapshot().saving).toBe(false));
async function openLedger(notes: Note[]) {
  const fake = backend(notes);
  const store = new NotesStore(fake.request);
  await store.load();
  render(<LedgerView store={store} ledgerId="L" today={TODAY} />);
  return { fake, store };
}

const section = (name: string) => within(screen.getByRole('region', { name }));
const details = () => within(screen.getByRole('dialog'));
const openSub = (name: string) => fireEvent.click(section('구독').getByRole('button', { name: new RegExp(`^${name}`) }));

it('renders the accepted summary and this-month strip from an old ledger', async () => {
  await openLedger([ledgerNote(), monthNote('2026-09', september)]);
  expect(screen.getByLabelText('예산')).toHaveTextContent('₩2,300,000');
  expect(screen.getByLabelText('고정')).toHaveTextContent('₩1,035,990');
  expect(screen.getByLabelText('쓴 돈')).toHaveTextContent('₩612,400');
  expect(screen.getByLabelText('남은 돈')).toHaveTextContent('₩651,610');
  const strip = section('이번 달 결제 예정');
  expect(strip.getAllByRole('listitem')).toHaveLength(2);
  expect(strip.getByText('쿠팡 와우')).toBeInTheDocument();
  expect(strip.queryByText('디즈니+')).toBeNull();
  expect(section('지출').getByRole('button', { name: /점심 김치찌개/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '다음 달' }));
  expect(section('이번 달 결제 예정').getByText('디즈니+ · 무료 끝')).toBeInTheDocument();
});
it('shows no budget safely and renders old optional fields without a migration', async () => {
  const { fake, store } = await openLedger([ledgerNote({ income: null, recurring: [], planned: [] })]);
  expect(screen.getByLabelText('예산')).toHaveTextContent('—');
  expect(screen.getByLabelText('남은 돈')).toHaveTextContent('—');
  await settle(store); expect(fake.saves()).toHaveLength(0);
});
it('shows lifecycle pills, trial amount and the real next date and amount', async () => {
  await openLedger([ledgerNote({ recurring: [
    rec('a', '매월', 10000, '2026-01-01'), rec('b', '분기', 30000, '2026-01-12', { every: 3 }),
    rec('c', '연간', 120000, '2026-03-01', { unit: 'year' }),
    rec('d', '무료구독', 17000, '2026-10-02', { trial: true, trialFrom: '2026-07-02', remindDays: 7 }),
    rec('e', '해지구독', 29000, '2026-01-28', { until: '2026-09-28', remindDays: 3 }),
    rec('f', '종료구독', 10000, '2026-01-01', { until: '2026-09-01' }),
  ], planned: [] })]);
  const subs = section('구독');
  for (const pill of ['매달', '3달마다', '1년 갱신', '처음 3달 무료', '무료 D-7', '해지 예약', '종료됨']) expect(subs.getAllByText(pill).length).toBeGreaterThan(0);
  expect(subs.getByRole('button', { name: /^무료구독/ })).toHaveTextContent('무료');
  expect(subs.getByRole('button', { name: /^연간/ })).toHaveTextContent('2027.3.1 · ₩120,000월 ₩10,000');
  expect(section('이번 달 결제 예정').getByText('D-3')).toBeInTheDocument();
});
it('counts a confirmed fixed charge once and uses the confirmed amount', async () => {
  await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-01-01')], planned: [] }), monthNote('2026-09', [entry('e', '2026-09-01', 9000, '구독', { recurring: { id: 'r', date: '2026-09-01' } }), entry('l', TODAY, 8000, '점심')])]);
  expect(screen.getByLabelText('고정')).toHaveTextContent('₩9,000');
  expect(screen.getByLabelText('쓴 돈')).toHaveTextContent('₩8,000');
});
it('changes the price with an effective date, records the old price and preserves unknown fields', async () => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-01-01', { extraField: 'keep' })] })]);
  openSub('구독'); const d = details();
  fireEvent.click(d.getByRole('button', { name: '가격 바꾸기' }));
  fireEvent.change(d.getByLabelText('가격'), { target: { value: '12000' } });
  fireEvent.change(d.getByLabelText('가격 적용일'), { target: { value: '2026-10-01' } });
  fireEvent.change(d.getByLabelText('알림'), { target: { value: '3' } });
  fireEvent.click(d.getByRole('button', { name: '저장' })); await settle(store);
  expect(last(fake.saves()).recurring[0]).toMatchObject({ amount: 12000, priceHistory: [{ until: '2026-10-01', amount: 10000 }], remindDays: 3, extraField: 'keep' });
  expect(last(fake.saves()).recurring[0]).not.toHaveProperty('trialFrom');
  openSub('구독'); expect(details().getByText('10.1에 ₩10,000에서 올림')).toBeInTheDocument();
});
it.each(['scheduled', 'now'])('cancels %s and allows cancellation before the first charge', async mode => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [rec('r', '무료구독', 17000, '2026-10-02', { trial: true })] })]);
  openSub('무료구독'); fireEvent.change(details().getByLabelText('해지'), { target: { value: mode } });
  fireEvent.click(details().getByRole('button', { name: '저장' })); await settle(store);
  expect(last(fake.saves()).recurring[0].until).toBe(mode === 'now' ? TODAY : '2026-10-02');
  expect(last(fake.saves()).recurring[0]).not.toHaveProperty('trialFrom');
});
it('edits cycle and free period without inventing unchanged optional fields', async () => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-01-01')] })]);
  openSub('구독'); let d = details();
  fireEvent.change(d.getByLabelText('이름'), { target: { value: '이름만' } });
  fireEvent.click(d.getByRole('button', { name: '저장' })); await settle(store);
  const old = last(fake.saves()).recurring[0];
  for (const field of ['priceHistory', 'trialFrom', 'remindDays']) expect(old).not.toHaveProperty(field);
  openSub('이름만'); d = details();
  fireEvent.click(d.getByRole('radio', { name: 'N달마다' }));
  fireEvent.change(d.getByLabelText('주기 간격'), { target: { value: '2' } });
  fireEvent.click(d.getByRole('radio', { name: '처음 1달 무료' }));
  fireEvent.change(d.getByLabelText('무료 시작일'), { target: { value: '2026-09-01' } });
  fireEvent.change(d.getByLabelText('무료 개월'), { target: { value: '3' } });
  fireEvent.click(d.getByRole('button', { name: '저장' })); await settle(store);
  expect(last(fake.saves()).recurring[0]).toMatchObject({ every: 2, unit: 'month', trial: true, trialFrom: '2026-09-01', start: '2026-12-01' });
});
it('expands the wishlist, overlays the meter and buys directly into today’s spending', async () => {
  const { fake, store } = await openLedger([ledgerNote(), monthNote('2026-09', september)]);
  const wishes = section('사고 싶은 것');
  fireEvent.click(wishes.getByRole('button', { name: /러닝화/ }));
  expect(wishes.getByText('이번 달에 사면 남는 돈').parentElement).toHaveTextContent('₩562,610');
  expect(document.querySelector<HTMLElement>('.ledger-budget-meter__plan')!.style.width).not.toBe('0%');
  fireEvent.click(wishes.getByRole('button', { name: '샀음' })); await settle(store);
  await waitFor(() => expect(section('사고 싶은 것').queryByText('러닝화')).toBeNull());
  expect(last(fake.saves()).entries).toContainEqual(expect.objectContaining({ name: '러닝화', amount: 89000, planned: 'shoes', date: TODAY }));
  expect(section('지출').getByRole('button', { name: /러닝화/ })).toBeInTheDocument();
});
it('edits wishlist where and priority, preserving old unset values on a name-only edit', async () => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [], planned: [plan('p', '물건', 10000, null)] })]);
  fireEvent.click(section('사고 싶은 것').getByRole('button', { name: /물건/ }));
  fireEvent.click(screen.getByRole('button', { name: '고치기' }));
  fireEvent.change(details().getByLabelText('이름'), { target: { value: '물건2' } });
  fireEvent.click(details().getByRole('button', { name: '저장' })); await settle(store);
  expect(last(fake.saves()).planned[0]).not.toHaveProperty('where'); expect(last(fake.saves()).planned[0]).not.toHaveProperty('priority');
  fireEvent.click(screen.getByRole('button', { name: '고치기' }));
  fireEvent.change(details().getByLabelText('구매처'), { target: { value: '쿠팡' } });
  fireEvent.change(details().getByLabelText('우선순위'), { target: { value: '2' } });
  fireEvent.click(details().getByRole('button', { name: '저장' })); await settle(store);
  expect(last(fake.saves()).planned[0]).toMatchObject({ where: '쿠팡', priority: 2 });
  expect(section('사고 싶은 것').getByRole('button', { name: /물건2/ })).toHaveTextContent('★★');
});
it('quick input parses a name and amount, never submitting during composition', async () => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [], planned: [] })]);
  const field = screen.getByLabelText('지출 빠른 입력');
  fireEvent.change(field, { target: { value: '점심 8,000' } });
  fireEvent.compositionStart(field); fireEvent.keyDown(field, { key: 'Enter' });
  expect(fake.saves()).toHaveLength(0);
  fireEvent.compositionEnd(field); fireEvent.keyDown(field, { key: 'Enter' }); await settle(store);
  await waitFor(() => expect(last(fake.saves()).entries).toContainEqual(expect.objectContaining({ name: '점심', amount: 8000, date: TODAY })));
  expect(field).toHaveValue('');
  fireEvent.change(field, { target: { value: '잘못된 입력' } }); fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.getByRole('alert')).toHaveTextContent('이름과 금액');
});
it('keeps content and duplicate-submit protection while a month id is pending', async () => {
  const { fake, store } = await openLedger([ledgerNote()]);
  let resolve!: (value: { id: string }) => void;
  const original = fake.request;
  const pending = new Promise<{ id: string }>(r => { resolve = r; });
  // The store transport is captured at construction; use a second store for delayed writes.
  cleanup(); const slow = new NotesStore(((op, input) => op === 'ledgerMonthId' ? pending : original(op, input)) as NotesRequest); await slow.load();
  render(<LedgerView store={slow} ledgerId="L" today={TODAY} />);
  const field = screen.getByLabelText('지출 빠른 입력'); fireEvent.change(field, { target: { value: '점심 8000' } });
  fireEvent.keyDown(field, { key: 'Enter' }); fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.getByLabelText('예산')).toHaveTextContent('₩2,300,000'); expect(section('구독').getByText('월세')).toBeInTheDocument();
  expect(field).toHaveValue('점심 8000'); resolve({ id: 'm-2026-09' });
  await waitFor(() => expect(field).toHaveValue('')); await settle(slow);
  expect(last(fake.saves()).entries.filter((e: LedgerEntry) => e.name === '점심')).toHaveLength(1); await settle(store);
});
it('keeps entry editing and its planned reference', async () => {
  const { fake, store } = await openLedger([ledgerNote(), monthNote('2026-09', september)]);
  fireEvent.click(section('지출').getByRole('button', { name: /접이식 우산/ }));
  const edit = within(screen.getByRole('group', { name: '기록 고치기' }));
  fireEvent.change(edit.getByLabelText('금액'), { target: { value: '21000' } }); fireEvent.click(edit.getByRole('button', { name: '저장' })); await settle(store);
  expect(last(fake.saves()).entries.find((e: LedgerEntry) => e.id === 'e4')).toMatchObject({ planned: 'umbrella', amount: 21000 });
});
it('keeps the typed quick input when the month is full', async () => {
  const full = Array.from({ length: 300 }, (_, i) => entry(`f${i}`, TODAY, 1000, '마트'));
  const { fake } = await openLedger([ledgerNote({ recurring: [], planned: [] }), monthNote('2026-09', full)]);
  const field = screen.getByLabelText('지출 빠른 입력'); fireEvent.change(field, { target: { value: '점심 8000' } }); fireEvent.keyDown(field, { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent('300개'); expect(field).toHaveValue('점심 8000'); expect(fake.saves()).toHaveLength(0);
});
it('shows the effective current price separately from the next charge amount', async () => {
  await openLedger([ledgerNote({ recurring: [rec('r', '가격구독', 12000, '2026-01-01', { priceHistory: [{ until: '2026-10-01', amount: 10000 }] })] })]);
  const row = section('구독').getByRole('button', { name: /^가격구독/ });
  expect(row.querySelector('.ledger-value')).toHaveTextContent('₩10,000');
  expect(row.querySelector('.ledger-next')).toHaveTextContent('10.1 · ₩12,000');
});

it.each(['실제 금액으로 확정', '이번 달은 건너뜀'])('serializes repeated charge actions: %s', async action => {
  const { store } = await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-09-01')], planned: [] }), monthNote('2026-09', [])]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = store.ledgerMonth.bind(store);
  const saving = vi.spyOn(store, 'ledgerMonth').mockImplementation(async (...args) => { await gate; return original(...args); });
  fireEvent.click(section('지출').getByRole('button', { name: /구독/ }));
  const form = within(screen.getByRole('group', { name: '구독 결제 확정' }));
  fireEvent.click(form.getByRole('button', { name: action }));
  fireEvent.click(form.getByRole('button', { name: action }));
  fireEvent.click(form.getByRole('button', { name: action === '이번 달은 건너뜀' ? '실제 금액으로 확정' : '이번 달은 건너뜀' }));
  const attempts = saving.mock.calls.length;
  await act(async () => { release(); await gate; });
  await settle(store);
  expect(attempts).toBe(1);
  expect(store.snapshot().notes.find(n => n.month === '2026-09')?.entries).toHaveLength(1);
});
it.each(['실제 금액으로 확정', '이번 달은 건너뜀'])('checks fresh confirmations in every month before writing: %s', async action => {
  const { store } = await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-09-01')], planned: [] }), monthNote('2026-09', [])]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = store.ledgerMonth.bind(store);
  vi.spyOn(store, 'ledgerMonth').mockImplementation(async (...args) => { await gate; return original(...args); });
  fireEvent.click(section('지출').getByRole('button', { name: /구독/ }));
  fireEvent.click(screen.getByRole('button', { name: action }));
  act(() => store.edit(monthNote('2026-10', [entry('remote', '2026-10-01', 0, '구독', { recurring: { id: 'r', date: '2026-09-01' } })])));
  await act(async () => { release(); await gate; });
  await settle(store);
  expect(store.snapshot().notes.flatMap(n => n.entries ?? []).filter(e => e.recurring?.id === 'r')).toHaveLength(1);
});
it('reopens dropped plans from a folded list, restores them, and can delete them', async () => {
  const { store } = await openLedger([ledgerNote({ recurring: [], planned: [plan('p', '텐트', 300000, null)] })]);
  fireEvent.click(section('사고 싶은 것').getByRole('button', { name: /텐트/ }));
  fireEvent.click(screen.getByRole('button', { name: '고치기' }));
  fireEvent.click(details().getByRole('button', { name: '안 사기로 함' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const folded = screen.getByText('안 사기로 한 것 1').closest('details')!;
  expect(folded).not.toHaveAttribute('open');
  fireEvent.click(within(folded).getByText('안 사기로 한 것 1'));
  fireEvent.click(within(folded).getByRole('button', { name: /텐트/ }));
  fireEvent.click(details().getByRole('button', { name: '다시 사기로' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.snapshot().notes.find(n => n.id === 'L')?.planned?.[0]?.dropped).toBe(false);
  if (!screen.queryByRole('button', { name: '고치기' })) fireEvent.click(section('사고 싶은 것').getByRole('button', { name: /텐트/ }));
  fireEvent.click(screen.getByRole('button', { name: '고치기' }));
  fireEvent.click(details().getByRole('button', { name: '안 사기로 함' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByText('안 사기로 한 것 1'));
  fireEvent.click(screen.getByRole('button', { name: /텐트/ }));
  fireEvent.click(details().getByRole('button', { name: '삭제' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.snapshot().notes.find(n => n.id === 'L')?.planned).toEqual([]);
  await settle(store);
});
it.each([0, 9000])('hides a resolved charge (%s won) from the shared upcoming strip', async amount => {
  await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, TODAY, { remindDays: 3 })], planned: [] }), monthNote('2026-09', [entry('e', TODAY, amount, '구독', { recurring: { id: 'r', date: TODAY } })])]);
  expect(section('이번 달 결제 예정').getByText('결제 예정 없음')).toBeInTheDocument();
});

it('releases the confirmation lock after a failed save so the user can retry', async () => {
  const { store } = await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-09-01')], planned: [] }), monthNote('2026-09', [])]);
  vi.spyOn(store, 'ledgerMonth').mockRejectedValueOnce('저장 실패');
  fireEvent.click(section('지출').getByRole('button', { name: /구독/ }));
  fireEvent.click(screen.getByRole('button', { name: '실제 금액으로 확정' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('저장 실패'));
  expect(screen.getByRole('button', { name: '이번 달은 건너뜀' })).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '이번 달은 건너뜀' }));
  await waitFor(() => expect(store.snapshot().notes.find(n => n.month === '2026-09')?.entries).toMatchObject([{ amount: 0 }]));
  await settle(store);
});
it('keeps an invalid confirmation amount intact and accepts ordinary integer typing', async () => {
  const { store } = await openLedger([ledgerNote({ recurring: [rec('r', '구독', 10000, '2026-09-01')], planned: [] }), monthNote('2026-09', [])]);
  fireEvent.click(section('지출').getByRole('button', { name: /구독/ }));
  const amount = screen.getByLabelText('실제 금액');
  fireEvent.change(amount, { target: { value: '10,000.00' } });
  fireEvent.blur(amount);
  fireEvent.click(screen.getByRole('button', { name: '실제 금액으로 확정' }));
  expect(amount).toHaveValue('10,000.00');
  expect(screen.getByRole('alert')).toHaveTextContent('정수');
  expect(store.snapshot().notes.find(n => n.month === '2026-09')?.entries).toEqual([]);
  for (const value of ['1', '10', '100', '1000', '10000']) {
    fireEvent.change(amount, { target: { value } });
    expect(amount).toHaveValue(value);
  }
  fireEvent.blur(amount);
  expect(amount).toHaveValue('10,000');
  fireEvent.click(screen.getByRole('button', { name: '실제 금액으로 확정' }));
  await waitFor(() => expect(store.snapshot().notes.find(n => n.month === '2026-09')?.entries).toMatchObject([{ amount: 10000 }]));
  await settle(store);
});
