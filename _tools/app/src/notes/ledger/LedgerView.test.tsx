import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChromeTarget, WorkspaceChromeProvider } from "../../layout/WorkspaceChrome";
import { NotesWorkspace } from "../NotesView";
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

it("renders the month summary figures from the fixture", async () => {
  await openLedger([ledgerNote(), monthNote("2026-09", september)]);
  expect(screen.getByRole("heading", { name: "2026년 9월" })).toBeInTheDocument();
  expect(screen.getByLabelText("이번 달 쓸 수 있는 돈 ₩562,610")).toBeInTheDocument();
  expect(screen.getByText(/하루 약/)).toHaveTextContent("하루 약 ₩93,768 · 남은 날 6일");
  const figs = Object.fromEntries([...document.querySelectorAll(".ledger-figs > div")].map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]));
  expect(figs).toEqual({ 수입: "2,300,000", "쓴 돈": "1,612,500", 예정: "124,890", "고정·구독 이번 달": "1,035,990" });
  const upcoming = within(screen.getByRole("region", { name: "다가오는 결제" })).getAllByRole("listitem").map((li) => li.textContent);
  expect(upcoming.slice(0, 2)).toEqual(["9.27쿠팡 와우₩7,890", "9.29ChatGPT Plus₩28,000"]);
  // 기록 shows entries by day plus the derived charges already due (muted, 고정·구독 자동).
  const day = screen.getByRole("region", { name: "9.25 금요일" });
  expect(within(day).getByRole("button", { name: /점심 김치찌개/ })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "9.1 화요일" })).getByRole("button", { name: /월세.*고정·구독 자동/ })).toBeInTheDocument();
  // Alt+→ moves to October: a future month shows only income, charges and plans.
  fireEvent.keyDown(screen.getByRole("heading", { name: "2026년 9월" }), { key: "ArrowRight", altKey: true });
  expect(screen.getByRole("heading", { name: "2026년 10월" })).toBeInTheDocument();
  expect(screen.getByText("10월 기록이 없어요.")).toBeInTheDocument();
});

it("without an income shows 쓴 돈 as the headline", async () => {
  await openLedger([ledgerNote({ income: null, recurring: [], planned: [] }), monthNote("2026-09", september)]);
  expect(screen.getByLabelText("쓴 돈 ₩612,400")).toBeInTheDocument();
  expect(screen.getByText("수입을 적으면 쓸 수 있는 돈이 보여요")).toBeInTheDocument();
});

it("adds entries with the keyboard only: Ctrl+N, Tab, Enter and a leading + for money in", async () => {
  const { fake, store } = await openLedger([ledgerNote(), monthNote("2026-09", september)]);
  const row = screen.getByRole("group", { name: "새 기록" });
  fireEvent.keyDown(row, { key: "n", ctrlKey: true });
  const amount = within(row).getByRole("textbox", { name: "금액" });
  await waitFor(() => expect(amount).toHaveFocus());
  await userEvent.keyboard("12000");
  expect(amount).toHaveValue("12,000");
  await userEvent.tab();
  expect(within(row).getByRole("textbox", { name: "이름" })).toHaveFocus();
  await userEvent.keyboard("커피{Enter}");
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "m-2026-09", type: "ledger-month" });
  expect(last(fake.saves()).entries).toContainEqual(expect.objectContaining({ date: TODAY, amount: 12000, name: "커피" }));
  // The row stays for the next entry, focus back on the amount.
  expect(amount).toHaveValue("");
  expect(amount).toHaveFocus();
  await userEvent.keyboard("+18000{Tab}환불{Enter}");
  await settle(store);
  expect(last(fake.saves()).entries).toContainEqual(expect.objectContaining({ amount: 18000, name: "환불", in: true }));
  // Tab order: 날짜 → 금액 → 이름 → 추가; a typed day of the shown month lands in that month.
  const date = within(row).getByRole("textbox", { name: "날짜" });
  await userEvent.clear(date); await userEvent.type(date, "3");
  await userEvent.tab(); expect(amount).toHaveFocus();
  await userEvent.keyboard("5000{Enter}");
  await settle(store);
  expect(last(fake.saves()).entries).toContainEqual(expect.objectContaining({ date: "2026-09-03", amount: 5000, name: "" }));
  expect(screen.getByLabelText(/이번 달 쓸 수 있는 돈/)).toHaveAttribute("aria-label", `이번 달 쓸 수 있는 돈 ₩${(562610 - 12000 + 18000 - 5000).toLocaleString("en-US")}`);
});

it("adds a recurring charge with any cycle", async () => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [] })]);
  await userEvent.click(screen.getByRole("button", { name: "고정·구독" }));
  await userEvent.click(screen.getByRole("button", { name: "고정·구독 추가" }));
  const form = screen.getByRole("group", { name: "고정·구독 추가" });
  await userEvent.type(within(form).getByLabelText("이름"), "밀리의 서재");
  await userEvent.type(within(form).getByRole("textbox", { name: "금액" }), "29700");
  await userEvent.clear(within(form).getByLabelText("주기 간격")); await userEvent.type(within(form).getByLabelText("주기 간격"), "3");
  await userEvent.clear(within(form).getByLabelText("첫 결제일")); await userEvent.type(within(form).getByLabelText("첫 결제일"), "2026-09-12");
  await userEvent.click(within(form).getByRole("button", { name: "저장" }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "L", type: "ledger", recurring: [expect.objectContaining({ name: "밀리의 서재", amount: 29700, every: 3, unit: "month", start: "2026-09-12", trial: false, until: null })] });
  const row = screen.getByRole("button", { name: /밀리의 서재/ });
  expect(row).toHaveTextContent("3개월마다 · 12일");
  expect(row).toHaveTextContent("12.12");
  expect(row).toHaveTextContent("월 ₩9,900");
});

it("plan → 샀어요 prefills the entry row and links the saved entry to the plan", async () => {
  const { fake, store } = await openLedger([ledgerNote(), monthNote("2026-09", september)]);
  const plans = screen.getByRole("region", { name: "9월 계획" });
  await userEvent.click(within(plans).getByRole("button", { name: "샀어요" }));
  const row = screen.getByRole("group", { name: "새 기록" });
  const amount = within(row).getByRole("textbox", { name: "금액" });
  await waitFor(() => expect(amount).toHaveFocus());
  expect(amount).toHaveValue("89,000");
  expect(within(row).getByRole("textbox", { name: "이름" })).toHaveValue("러닝화");
  expect(screen.getByText(/계획 “러닝화”과 연결해 기록합니다/)).toBeInTheDocument();
  await userEvent.clear(amount); await userEvent.keyboard("85000{Enter}");
  await settle(store);
  expect(last(fake.saves()).entries).toContainEqual(expect.objectContaining({ amount: 85000, name: "러닝화", planned: "shoes" }));
  // The plan is done (derived from the entry): no longer scheduled, and the link is gone from the row.
  await waitFor(() => expect(screen.queryByText(/계획 “러닝화”/)).not.toBeInTheDocument());
  expect(within(plans).queryByRole("button", { name: "샀어요" })).not.toBeInTheDocument();
  const figs = [...document.querySelectorAll(".ledger-figs dd")].map((d) => d.textContent);
  expect(figs[2]).toBe("35,890");
  await userEvent.click(screen.getByRole("button", { name: "계획" }));
  expect(screen.getByText("끝난 계획 3")).toBeInTheDocument();
});

it("resolves an entry forked by two devices with 이것만 남기기", async () => {
  const forked = [...september, entry("e1b", "2026-09-25", 9900, "점심 김치찌개", { forkOf: "e1" })];
  const { fake, store } = await openLedger([ledgerNote({ recurring: [rec("gpt", "ChatGPT Plus", 28000, "2026-01-29"), rec("gpt2", "ChatGPT Plus", 29000, "2026-01-29", { forkOf: "gpt" })] }), monthNote("2026-09", forked)]);
  expect(screen.getByText(/확인할 기록 1건/)).toBeInTheDocument();
  expect(screen.getByText("확인할 고정·구독·계획 1건")).toBeInTheDocument();
  const day = screen.getByRole("region", { name: "9.25 금요일" });
  expect(within(day).getAllByText("두 기기에서 다르게 고침")).toHaveLength(2);
  const copy = within(day).getByRole("button", { name: /점심 김치찌개.*9,900/ }).closest("li")!;
  await userEvent.click(within(copy as HTMLElement).getByRole("button", { name: "이것만 남기기" }));
  await settle(store);
  const saved = last(fake.saves()).entries as LedgerEntry[];
  expect(saved.find((e) => e.id === "e1")).toBeUndefined();
  expect(saved.find((e) => e.id === "e1b")).toEqual(expect.objectContaining({ amount: 9900 }));
  expect(saved.find((e) => e.id === "e1b")).not.toHaveProperty("forkOf");
  expect(screen.queryByText(/확인할 기록/)).not.toBeInTheDocument();
  // Recurring items resolve the same way on the ledger note.
  await userEvent.click(screen.getByRole("button", { name: "고정·구독" }));
  const original = screen.getByRole("button", { name: /ChatGPT Plus.*₩28,000/ }).closest("li")!;
  await userEvent.click(within(original as HTMLElement).getByRole("button", { name: "이것만 남기기" }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "L", recurring: [expect.objectContaining({ id: "gpt", amount: 28000 })] });
  expect(last(fake.saves()).recurring).toHaveLength(1);
});

function surface(store: NotesStore) {
  return render(<WorkspaceChromeProvider scope="notes"><ChromeTarget name="navigation" /><ChromeTarget name="actions" /><ChromeTarget name="search" /><NotesWorkspace store={store} /></WorkspaceChromeProvider>);
}

it("keeps month notes out of the list and 보관함, and opens the one ledger from 새 메모", async () => {
  const orphan = base("m-old", { type: "ledger-month", title: "가계부 2025년 1월", ledger: "gone", month: "2025-01", income: null, entries: [], archived: true, body: "# 2025년 1월 기록 (0건)" });
  const fake = backend([ledgerNote(), monthNote("2026-09", september), orphan, base("memo", { title: "장보기" })]);
  const store = new NotesStore(fake.request); surface(store);
  const list = await screen.findByLabelText("메모 목록");
  await within(list).findByRole("button", { name: /가계부/ });
  expect(within(list).getAllByRole("button").map((b) => b.querySelector(".notes-card__title-text")!.textContent)).toEqual(["가계부", "장보기"]);
  expect(within(list).getByRole("button", { name: /가계부/ })).toHaveTextContent(/월 쓸 수 있는 돈 ₩/);
  expect(screen.getByRole("button", { name: /모든 메모/ })).toHaveTextContent("2");
  await userEvent.click(screen.getByRole("button", { name: "보관함" }));
  // Only the month whose ledger no longer exists shows (read-only); months of the ledger stay hidden.
  expect(within(list).getAllByRole("button").map((b) => b.querySelector(".notes-card__title-text")!.textContent)).toEqual(["가계부 2025년 1월"]);
  await userEvent.click(within(list).getByRole("button", { name: /가계부 2025년 1월/ }));
  expect(screen.getByText("새 버전의 앱에서 만든 메모입니다. 앱을 업데이트하면 편집할 수 있습니다.")).toBeInTheDocument();
  // 새 메모 → 가계부 opens the existing ledger instead of creating a second one.
  await userEvent.click(screen.getByRole("button", { name: "새 메모" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "가계부" }));
  expect(await screen.findByRole("group", { name: "새 기록" })).toBeInTheDocument();
  expect(fake.saves().filter((s) => s.type === "ledger")).toHaveLength(0);
});

it("creates a pinned 가계부 when none exists", async () => {
  const fake = backend([]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: "새 메모" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "가계부" }));
  await settle(store);
  expect(fake.saves()).toEqual([expect.objectContaining({ type: "ledger", title: "가계부", pinned: true, income: null, recurring: [], planned: [] })]);
  expect(screen.getByText("수입을 적으면 쓸 수 있는 돈이 보여요")).toBeInTheDocument();
  // Setting the default income through the 수입 button.
  await userEvent.click(screen.getByRole("button", { name: "수입 적기" }));
  await userEvent.type(screen.getByRole("textbox", { name: "매달 수입" }), "2300000{Enter}");
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ type: "ledger", income: 2300000 });
  expect(fake.saves().some((s) => s.type === "ledger-month")).toBe(false);
});

it("shows the limit or size message instead of saving, and keeps what was typed", async () => {
  const full = Array.from({ length: 300 }, (_, i) => entry(`f${i}`, "2026-09-10", 1000, "점심"));
  const many = Array.from({ length: 299 }, (_, i) => plan(`p${i}`, "물건", 1000, null, { memo: "가".repeat(500), order: `p${String(i).padStart(3, "0")}` }));
  const { fake, store } = await openLedger([ledgerNote({ planned: many }), monthNote("2026-09", full)]);
  const before = fake.saves().length;
  // Entry limit (300 per month note): the entry row keeps its amount and name.
  const row = screen.getByRole("group", { name: "새 기록" });
  await userEvent.type(within(row).getByRole("textbox", { name: "금액" }), "12000");
  await userEvent.type(within(row).getByRole("textbox", { name: "이름" }), "커피{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("기록은 300개까지 저장할 수 있습니다.");
  expect(within(row).getByRole("textbox", { name: "금액" })).toHaveValue("12,000");
  expect(within(row).getByRole("textbox", { name: "이름" })).toHaveValue("커피");
  // Whole-note size: 300 plans with long memos pass the item limits but not 256 KiB.
  // Scoped queries: a page-wide getByRole("button") computes the accessible name of every
  // button in the ~300 rendered rows, which took over a second and timed the test out under load.
  await userEvent.click(within(screen.getByRole("group", { name: "가계부 보기" })).getByRole("button", { name: "계획" }));
  await userEvent.click(screen.getByText("계획 추가", { selector: "button" }));
  const form = screen.getByRole("group", { name: "계획 추가" });
  await userEvent.type(within(form).getByLabelText("이름"), "텐트");
  await userEvent.type(within(form).getByRole("textbox", { name: "금액" }), "300000");
  await userEvent.type(within(form).getByLabelText("메모"), "가".repeat(20));
  await userEvent.click(within(form).getByRole("button", { name: "저장" }));
  expect(screen.getByRole("alert")).toHaveTextContent("가계부 항목이 너무 많습니다. 끝난 항목을 지워 주세요.");
  expect(within(screen.getByRole("group", { name: "계획 추가" })).getByLabelText("이름")).toHaveValue("텐트");
  await settle(store);
  expect(fake.saves().length).toBe(before);
});

it("restores the ledger from 휴지통 instead of creating a second one", async () => {
  const fake = backend([ledgerNote({ deleted: true }), monthNote("2026-09", september)]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: "새 메모" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "가계부" }));
  await settle(store);
  expect(fake.saves()).toEqual([expect.objectContaining({ id: "L", type: "ledger", deleted: false })]);
  expect(await screen.findByRole("group", { name: "새 기록" })).toBeInTheDocument();
  // The ledger takes the whole notes area; closing it returns to the board.
  await userEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
  expect(within(screen.getByLabelText("메모 목록")).getByRole("button", { name: /가계부/ })).toBeInTheDocument();
});

it("lists each subscription once in 다가오는 결제", async () => {
  await openLedger([ledgerNote({ recurring: [rec("claude", "Claude", 29000, "2026-01-28")] }), monthNote("2026-09", [])]);
  const upcoming = within(screen.getByRole("region", { name: "다가오는 결제" })).getAllByRole("listitem").map((li) => li.textContent);
  expect(upcoming).toEqual(["9.28Claude₩29,000"]);
});

it("sets the payday (들어오는 날) and shows the upcoming income among the charges", async () => {
  const { fake, store } = await openLedger([ledgerNote({ recurring: [rec("claude", "Claude", 29000, "2026-01-28")] }), monthNote("2026-09", [])]);
  await userEvent.click(screen.getByRole("button", { name: "수입 2,300,000" }));
  const day = screen.getByRole("textbox", { name: "들어오는 날" });
  await userEvent.type(day, "32{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("1~31");
  await userEvent.clear(day);
  await userEvent.type(day, "27{Enter}");
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "L", income: 2300000, incomeDay: 27 });
  expect(screen.getByRole("button", { name: "수입 2,300,000 · 27일" })).toBeInTheDocument();
  const upcoming = within(screen.getByRole("region", { name: "다가오는 결제" })).getAllByRole("listitem").map((li) => li.textContent);
  expect(upcoming).toEqual(["9.27수입+₩2,300,000", "9.28Claude₩29,000"]);
  // 31 in a 30-day month means the last day; clearing the day removes the line.
  await userEvent.click(screen.getByRole("button", { name: "수입 2,300,000 · 27일" }));
  await userEvent.clear(screen.getByRole("textbox", { name: "들어오는 날" }));
  await userEvent.type(screen.getByRole("textbox", { name: "들어오는 날" }), "31{Enter}");
  await settle(store);
  expect(screen.getByRole("button", { name: "수입 2,300,000 · 30일" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "수입 2,300,000 · 30일" }));
  await userEvent.click(screen.getByRole("button", { name: "지우기" }));
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "L", incomeDay: null });
  expect(within(screen.getByRole("region", { name: "다가오는 결제" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["9.28Claude₩29,000"]);
});

it("does not list a payday that already passed this month", async () => {
  await openLedger([ledgerNote({ incomeDay: 25, recurring: [rec("claude", "Claude", 29000, "2026-01-28")] }), monthNote("2026-09", [])]);
  expect(screen.getByRole("button", { name: "수입 2,300,000 · 25일" })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "다가오는 결제" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["9.28Claude₩29,000"]);
});
