import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityList, resetActivityFold, useActivitySections } from "./ActivityList";
import type { ActivityItem, ActivitySections } from "./activityTimeline";
const job = (id: string, state: ActivityItem["state"] = "running"): ActivityItem => ({ id, kind: "import", label: id, state, done: 2 });
const sections = (overrides: Partial<ActivitySections> = {}): ActivitySections => ({ problems: [], running: [], waiting: [], recent: [], ...overrides });
afterEach(() => { cleanup(); resetActivityFold(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("orders problems, running, waiting and recent results in one list", () => {
  const { container } = render(<ActivityList sections={sections({ problems: [job("problem", "failed")], running: [job("active")], waiting: [job("queued", "queued")], recent: [job("finished", "done")] })} />);
  expect([...container.querySelectorAll('[role="group"]')].map(node => node.getAttribute("aria-label"))).toEqual(["문제", "진행 중", "대기"]);
  expect(screen.queryByText("finished")).not.toBeInTheDocument();
  act(() => screen.getByRole("button", { name: /최근 끝남/ }).click());
  expect(screen.getByRole("group", { name: "최근 끝남" })).toHaveTextContent("finished");
});

it("remembers the recent fold during this app run and keeps problems outside it", () => {
  const value = sections({ problems: [{ ...job("problem", "failed"), dismiss: vi.fn(), retry: vi.fn() }], recent: [job("finished", "done")] });
  const { unmount } = render(<ActivityList sections={value} />);
  expect(screen.getByRole("alert")).toBeVisible();
  act(() => screen.getByRole("button", { name: /최근 끝남/ }).click());
  unmount(); render(<ActivityList sections={value} />);
  expect(screen.getByRole("button", { name: /최근 끝남/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "problem 다시 시도" })).toBeVisible();
  expect(screen.getByRole("button", { name: "problem 닫기" })).toBeVisible();
});

it("renders meters only for known totals and does not replace a row when numbers change", () => {
  const value = { ...job("count"), total: 10 };
  const { rerender } = render(<ActivityList sections={sections({ running: [value, job("unknown")] })} />);
  const meter = screen.getByRole("progressbar", { name: "count 진행률" });
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  rerender(<ActivityList sections={sections({ running: [{ ...value, done: 4 }, job("unknown")] })} />);
  expect(screen.getByRole("progressbar")).toBe(meter);
  expect(meter).toHaveAttribute("aria-valuenow", "4");
});

it("uses one deadline to show a slow job and hold it after completion", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  function Harness({ items }: { items: ActivityItem[] }) { return <ActivityList sections={useActivitySections(items)} />; }
  const { rerender } = render(<Harness items={[job("slow")]} />);
  act(() => vi.advanceTimersByTime(1000)); expect(screen.queryByText("slow")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1)); expect(within(screen.getByRole("group", { name: "진행 중" })).getByText("slow")).toBeVisible();
  rerender(<Harness items={[job("slow", "done")]} />);
  act(() => vi.advanceTimersByTime(999)); expect(screen.queryByRole("button", { name: /최근 끝남/ })).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1)); expect(screen.getByRole("button", { name: /최근 끝남/ })).toBeVisible();
});

it("keeps an import result after eight seconds and expires it after one hour", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  function Harness() { return <ActivityList sections={useActivitySections([job("import-result", "done")])} />; }
  render(<Harness />);
  act(() => screen.getByRole("button", { name: /최근 끝남/ }).click());
  act(() => vi.advanceTimersByTime(9000));
  expect(screen.getByText("import-result")).toBeVisible();
  act(() => vi.advanceTimersByTime(3_600_000));
  expect(screen.queryByRole("group", { name: "최근 끝남" })).not.toBeInTheDocument();
});

it("removes rows instantly when reduced motion is requested", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const { rerender } = render(<ActivityList sections={sections({ running: [job("motion")] })} />);
  rerender(<ActivityList sections={sections()} />);
  expect(screen.queryByText("motion")).not.toBeInTheDocument();
});

it("shows a folded recent result with a quiet count and one dismiss", () => {
  const close = vi.fn();
  render(<ActivityList sections={sections({ recent: [{ ...job("recent:x", "done"), label: "게시", repeat: 6, dismiss: close }, job("other", "done")] })} />);
  expect(screen.getByRole("button", { name: /최근 끝남/ })).toHaveTextContent("2");
  act(() => screen.getByRole("button", { name: /최근 끝남/ }).click());
  expect(screen.getByRole("group", { name: "최근 끝남" })).toHaveTextContent("×6");
  act(() => screen.getByRole("button", { name: "게시 닫기" }).click());
  expect(close).toHaveBeenCalledTimes(1);
});
