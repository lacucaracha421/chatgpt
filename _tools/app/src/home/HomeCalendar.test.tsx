import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HomeCalendar } from "./HomeCalendar";
import type { HomeReleaseCard } from "./HomeAttention";
import { releaseCalendarModel, type CalendarPayment } from "./homeCalendarModel";

afterEach(cleanup);

// Saturday 2026-09-26: the grid runs from Monday 9.21 to Sunday 10.4.
const TODAY = "2026-09-26";
const AT = new Date(2026, 8, 26, 12);
const card = (key: string, name: string, date: string | null, extra: Partial<HomeReleaseCard> = {}): HomeReleaseCard => ({ key, name, date, detail: "게임", onOpen: vi.fn(), ...extra });
const show = (cards: HomeReleaseCard[], onOpenCalendar = vi.fn()) => {
  render(<HomeCalendar model={releaseCalendarModel(cards, TODAY)} at={AT} onOpenCalendar={onOpenCalendar} />);
  return onOpenCalendar;
};
const cell = (date: string) => {
  const heads = document.querySelectorAll<HTMLElement>(".home-cal__day");
  return heads[[...Array(14).keys()].findIndex(index => new Date(Date.UTC(2026, 8, 21 + index)).toISOString().slice(0, 10) === date)]!;
};

it("lays out two weeks from Monday under Korean weekday heads", () => {
  show([]);
  expect([...document.querySelectorAll(".home-cal__weekday")].map(node => node.textContent)).toEqual(["월", "화", "수", "목", "금", "토", "일"]);
  expect(document.querySelectorAll(".home-cal__day")).toHaveLength(14);
  expect(screen.getByRole("region", { name: "발매 캘린더" })).toBeTruthy();
  // The first cell and each first of a month name the month; the others only the day.
  expect(cell("2026-09-21")).toHaveTextContent("9.21");
  expect(cell("2026-09-22").querySelector(".home-cal__date")?.textContent).toBe("22");
  expect(cell("2026-10-01").querySelector(".home-cal__date")?.textContent).toBe("10.1");
});

it("marks NEW on a past day, 오늘 on today's cell and D-n on later days that have a release", () => {
  const past = card("past", "지난 게임", "2026-09-23", { fresh: true });
  const today = card("today", "오늘 게임", TODAY);
  const later = card("later", "다음 게임", "2026-09-30");
  show([past, today, later]);
  expect(within(cell("2026-09-23")).getByText("NEW")).toBeTruthy();
  expect(within(cell("2026-09-23")).queryByText(/^D-/)).toBeNull();
  expect(cell(TODAY).dataset.tense).toBe("today");
  // Today has no 오늘 badge, only the filled square behind its date.
  expect(within(cell(TODAY)).queryByText("오늘")).toBeNull();
  expect(cell(TODAY).querySelector(".home-cal__date")).toBeTruthy();
  expect(within(cell("2026-09-30")).getByText("D-4")).toBeTruthy();
  // A later day without a release shows no D-day.
  expect(within(cell("2026-09-29")).queryByText(/^D-/)).toBeNull();
});

it("opens the release of a cell with one release", async () => {
  const one = card("one", "하나뿐인 게임", "2026-09-28");
  show([one]);
  await userEvent.click(within(cell("2026-09-28")).getByRole("button", { name: /하나뿐인 게임/ }));
  expect(one.onOpen).toHaveBeenCalledOnce();
});

it("groups several text releases of one day under +n and lets each be opened", async () => {
  const rows = [card("a", "첫째", "2026-09-27"), card("b", "둘째", "2026-09-27", { fresh: true }), card("c", "셋째", "2026-09-27"), card("d", "넷째", "2026-09-27")];
  show(rows);
  const trigger = within(cell("2026-09-27")).getByRole("button", { name: "9.27 발매 4개" });
  expect(within(trigger).getByText("+3")).toBeTruthy();
  // NEW comes first in the text summary.
  expect(within(trigger).getByText("NEW")).toBeTruthy();
  expect(trigger.querySelector("img")).toBeNull();
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("menuitem", { name: /셋째/ }));
  expect(rows[2]!.onOpen).toHaveBeenCalledOnce();
  expect(rows[1]!.onOpen).not.toHaveBeenCalled();
});

it("opens the release calendar from the header link for what comes after the grid and from the section's arrow", async () => {
  const onOpenCalendar = show([card("far", "먼 게임", "2026-10-05"), card("far2", "더 먼 게임", "2026-11-01")]);
  await userEvent.click(screen.getByRole("button", { name: "10.5 이후 2개" }));
  expect(onOpenCalendar).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "발매 캘린더 전체" }));
  expect(onOpenCalendar).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("먼 게임")).toBeNull();
});

it("keeps NEW releases from before this week reachable from the header", async () => {
  const old = card("old", "지난주 게임", "2026-09-10", { fresh: true });
  show([old, card("undated", "날짜 없는 알림", null, { fresh: true })]);
  await userEvent.click(screen.getByRole("button", { name: "지난 NEW 2개" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /지난주 게임/ }));
  expect(old.onOpen).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /이후/ })).toBeNull();
});

it("puts payment lines below release titles and opens the same ledger note, including overflow", async () => {
  const payments: CalendarPayment[] = Array.from({ length: 4 }, (_, index) => ({ key: String(index), date: TODAY, noteId: `ledger-${index}`, label: index === 0 ? "넷플릭스 13,500원" : `구독 ${index} 무료 끝남` }));
  const onOpenNote = vi.fn();
  render(<HomeCalendar model={releaseCalendarModel([card("game", "오늘 게임", TODAY)], TODAY, 2, { payments })} at={AT} onOpenCalendar={vi.fn()} onOpenNote={onOpenNote} />);
  const today = within(cell(TODAY));
  expect(today.getByText("오늘 게임").compareDocumentPosition(today.getByText("넷플릭스 13,500원")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(today.getByText("+2")).toBeTruthy();
  expect(today.queryByText("구독 2 무료 끝남")).toBeNull();
  await userEvent.click(today.getByRole("button", { name: "넷플릭스 13,500원" }));
  expect(onOpenNote).toHaveBeenLastCalledWith("ledger-0");
  await userEvent.click(today.getByRole("button", { name: "9.26 결제 일정 2개 더 보기" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "구독 3 무료 끝남" }));
  expect(onOpenNote).toHaveBeenLastCalledWith("ledger-3");
});

it("shows a quiet non-clickable saved count with a photo mark next to the date", () => {
  render(<HomeCalendar model={releaseCalendarModel([], TODAY, 2, { saved: [{ date: TODAY, count: 1234 }] })} at={AT} onOpenCalendar={vi.fn()} />);
  const count = within(cell(TODAY)).getByLabelText("저장한 이미지 1,234장");
  expect(count).toHaveTextContent("1,234장");
  expect(count.querySelector("svg")).toBeTruthy();
  expect(count.closest("button")).toBeNull();
  expect(count.parentElement).toBe(cell(TODAY).querySelector(".home-cal__date")!.parentElement);
  expect(cell("2026-09-22").querySelector(".home-cal__payments")?.childElementCount).toBe(0);
  expect(cell("2026-09-22").querySelector(".home-cal__saved")).toBeNull();
});

it("shows release titles and kinds without mounting supplied cover images", () => {
  show([card("anime", "사이버펑크: 엣지러너 2", "2026-09-30", {detail: "애니", cover: <img src="poster.jpg" alt="표지"/>})]);
  const day = within(cell("2026-09-30"));
  expect(day.getByText("사이버펑크: 엣지러너 2")).toBeTruthy();
  expect(day.getByText("애니")).toBeTruthy();
  expect(day.getByText("D-4")).toBeTruthy();
  expect(day.queryByRole("img")).toBeNull();
});
