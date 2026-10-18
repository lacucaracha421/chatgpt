import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeMonth } from "./HomeMonth";
import { monthDays, type MonthRelease } from "./homeMonthModel";

afterEach(cleanup);

const release = (key: string, fresh = false): MonthRelease => ({
  key, name: key, fresh, kind: "manga", detail: "12권", date: "2026-10-09", onOpen: vi.fn(),
});

function show(releases: MonthRelease[], hideAmounts = false) {
  const days = monthDays("2026-10", "2026-10-18", {
    releases, saved: [], memos: new Map([["2026-10-09", "메모"]]),
    entries: [{ id: "spent", date: "2026-10-09", amount: 8000, name: "점심", createdAt: "2026-10-09T12:00:00Z" }],
    payments: [{ key: "charge", date: "2026-10-09", noteId: "ledger", name: "구독", amount: 1000, kind: "charge" }],
  });
  const view = render(<HomeMonth month="2026-10" today="2026-10-18" at={new Date("2026-10-18T12:00:00Z")} selected="2026-10-09"
    days={days} totals={null} earlier={[]} hideAmounts={hideAmounts} onMonth={vi.fn()} onSelect={vi.fn()}
    onToday={vi.fn()} onOpenCalendar={vi.fn()} onEnterPanel={vi.fn()} />);
  return { view, cell: screen.getByRole("gridcell", { name: /10월 9일/ }) };
}

it("counts a charge as two lines, so two releases and a charge become two chips and +1", () => {
  const { cell } = show([release("첫 작품"), release("새 작품", true)]);
  const content = within(cell);
  expect(content.getByText("새 작품").compareDocumentPosition(content.getByText("첫 작품")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(content.getAllByText("12권")).toHaveLength(2);
  expect(content.queryByText("구독")).toBeNull();
  expect(content.getByText("+1")).toBeTruthy();
  expect(cell.getAttribute("aria-label")).toContain("한글날");
  expect(cell.getAttribute("aria-label")).toContain("메모 있음");
});

it("limits a busy day to the first two releases and the remaining entry count", () => {
  const { cell } = show([release("첫 작품"), release("둘째 작품"), release("새 작품", true)]);
  const content = within(cell);
  expect(content.getByText("새 작품")).toBeTruthy();
  expect(content.getByText("첫 작품")).toBeTruthy();
  expect(content.queryByText("둘째 작품")).toBeNull();
  expect(content.queryByText("구독")).toBeNull();
  expect(content.getByText("+2")).toBeTruthy();
  expect(cell.getAttribute("aria-label")).toContain("결제 예정 1개");
});

it("hides both charge and spending amounts in privacy mode", () => {
  const { cell } = show([], true);
  expect(cell.textContent).not.toMatch(/1,000|8,000/);
  expect(cell.getAttribute("aria-label")).not.toContain("8,000");
  expect(within(cell).getAllByText("••••")).toHaveLength(2);
});
