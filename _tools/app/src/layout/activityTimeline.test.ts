import { expect, it, vi } from "vitest";
import { ActivityTimeline, RECENT_MS, type ActivityItem } from "./activityTimeline";
const job = (id: string, state: ActivityItem["state"] = "running"): ActivityItem => ({ id, kind: "import", label: id, state, done: 0 });

it("reveals running work only after more than one second and holds a shown row for a second", () => {
  const timeline = new ActivityTimeline();
  expect(timeline.read([job("a")], 0).running).toHaveLength(0);
  expect(timeline.read([job("a")], 1000).running).toHaveLength(0);
  expect(timeline.read([job("a")], 1001).running).toHaveLength(1);
  const finished = job("a", "done");
  expect(timeline.read([finished], 1100).running).toHaveLength(1);
  expect(timeline.read([finished], 2000).recent).toHaveLength(0);
  expect(timeline.read([finished], 2001).recent).toHaveLength(1);
});

it("shows short work only in recent results, with problems independent of the delay", () => {
  const timeline = new ActivityTimeline();
  timeline.read([job("quick")], 0);
  const sections = timeline.read([job("quick", "done"), job("failed", "failed"), job("waiting", "queued")], 500);
  expect(sections.running).toHaveLength(0);
  expect(sections.problems.map(row => row.id)).toEqual(["failed"]);
  expect(sections.waiting.map(row => row.id)).toEqual(["waiting"]);
  expect(sections.recent.map(row => row.label)).toEqual(["quick"]);
});

it("retains only the ten newest results within one hour", () => {
  const timeline = new ActivityTimeline();
  const items = Array.from({ length: 12 }, (_, n) => ({ ...job(String(n), "done"), label: `job ${n}`, finishedAt: n }));
  expect(timeline.read(items, 20).recent.map(row => row.label)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"].map(n => `job ${n}`));
  expect(timeline.read(items, RECENT_MS + 11).recent).toHaveLength(0);
});

it("uses native start time and keeps the row identity when only the count changes", () => {
  const timeline = new ActivityTimeline();
  const item = { ...job("native"), startedAt: 0 };
  expect(timeline.read([item], 2000).running[0].id).toBe("native");
  expect(timeline.read([{ ...item, done: 3 }], 2100).running[0]).toMatchObject({ id: "native", done: 3 });
});

it("holds a visible row even if its source disappears and delays a newly running queued job", () => {
  const timeline = new ActivityTimeline();
  timeline.read([job("a")], 0); timeline.read([job("a")], 1001);
  expect(timeline.read([], 1100).running).toHaveLength(1);
  expect(timeline.read([], 2001).running).toHaveLength(0);
  timeline.read([job("b", "queued")], 3000);
  expect(timeline.read([job("b")], 10000).running).toHaveLength(0);
  expect(timeline.read([job("b")], 11001).running).toHaveLength(1);
});

it("folds identical finished results into the newest one, keeps failures apart and dismisses the whole group", () => {
  const timeline = new ActivityTimeline();
  const closeA = vi.fn(), closeB = vi.fn(), closeC = vi.fn();
  const done = (id: string, label: string, detail: string, finishedAt: number, dismiss?: () => void) => ({ ...job(id, "done"), label, detail, finishedAt, dismiss });
  const items = [done("a1", "게시", "캘린더", 1, closeA), done("b1", "확인", "위시", 2), done("a2", "게시", "캘린더", 3, closeB), done("a3", "게시", "캘린더", 5, closeC), done("b2", "확인", "위시", 4)];
  const recent = timeline.read(items, 10).recent;
  expect(recent.map(row => [row.label, row.repeat])).toEqual([["게시", 3], ["확인", 2]]);
  expect(recent[0].id).toBe(timeline.read(items.slice(0, 3), 10).recent[0].id);
  recent[0].dismiss?.();
  expect([closeA, closeB, closeC].map(close => close.mock.calls.length)).toEqual([1, 1, 1]);
  const withFailure = timeline.read([...items.slice(0, 1), { ...done("f", "게시", "캘린더", 6), state: "failed" as const }], 10);
  expect(withFailure.problems.map(row => row.id)).toEqual(["f"]);
  expect(withFailure.recent.map(row => row.repeat)).toEqual([undefined]);
});
