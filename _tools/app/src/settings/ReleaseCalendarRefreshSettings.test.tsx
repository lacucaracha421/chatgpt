import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReleaseCalendarRefreshSettings } from "./ReleaseCalendarRefreshSettings";
const gateway = vi.hoisted(() => ({ releaseCalendar: { calendar: vi.fn(), refreshNow: vi.fn(), serverEnabled: vi.fn(), requestServerRun: vi.fn() } }));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => { vi.resetAllMocks(); });
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

it.each(["queued", "unavailable", "rateLimited"])("Settings requests the server for %s and avoids a misleading local count", async outcome => {
  gateway.releaseCalendar.calendar.mockResolvedValue({ rangeStart: "", rangeEnd: "", entries: [], sources: [] });
  gateway.releaseCalendar.serverEnabled.mockResolvedValue(true);
  gateway.releaseCalendar.requestServerRun.mockResolvedValue({ outcome });
  render(<ReleaseCalendarRefreshSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "새로 받기" }));
  await waitFor(() => expect(gateway.releaseCalendar.requestServerRun).toHaveBeenCalledOnce());
  expect(gateway.releaseCalendar.refreshNow).not.toHaveBeenCalled();
  expect((await screen.findByRole("status")).textContent).not.toContain("개 작품을 새로 받았습니다");
});

it("Settings uses local immediate refresh when the run reports a genuine OFF", async () => {
  const value = { rangeStart: "", rangeEnd: "", entries: [], sources: [] };
  gateway.releaseCalendar.calendar.mockResolvedValue(value);
  gateway.releaseCalendar.refreshNow.mockResolvedValue(value);
  gateway.releaseCalendar.serverEnabled.mockResolvedValue(true);
  gateway.releaseCalendar.requestServerRun.mockResolvedValue({ outcome: "local" });
  render(<ReleaseCalendarRefreshSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "새로 받기" }));
  await screen.findByText("0개 작품을 새로 받았습니다.");
  expect(gateway.releaseCalendar.refreshNow).toHaveBeenCalledOnce();
});
