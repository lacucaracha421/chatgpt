import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReleaseCalendarRefreshSettings } from "./ReleaseCalendarRefreshSettings";
const gateway = vi.hoisted(() => ({ releaseCalendar: { calendar: vi.fn(), refreshNow: vi.fn() } }));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("renders shared fetched timestamps and preserves missing records", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 1, 16));
  gateway.releaseCalendar.calendar.mockResolvedValue({ sources: [
    { provider: "igdb", fetchedAt: "2026-10-01T15:07:40" },
    { provider: "tmdb", fetchedAt: "2026-09-30T15:07:40" },
    { provider: "tmdb_tv", fetchedAt: null },
  ] });
  render(<ReleaseCalendarRefreshSettings />);
  expect(await screen.findByText("게임 · 마지막으로 받음 15:07")).toBeInTheDocument();
  expect(screen.getByText("영화 · 마지막으로 받음 어제 15:07")).toBeInTheDocument();
  expect(screen.getByText("애니 · 받은 기록 없음")).toBeInTheDocument();
});
