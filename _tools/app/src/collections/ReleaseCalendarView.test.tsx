import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, ReleaseCalendar, ReleaseCalendarGateway, ReleaseTitle, ReleaseWishlistItem } from "../library/types";
import { groupReleases, releaseDateLabel, releaseEventLine, releaseTokenLabel } from "./releaseCalendarFormat";
import { ReleaseCalendarView } from "./ReleaseCalendarView";

afterEach(cleanup);

function title(id: string, name: string, date: string | null, precision: ReleaseTitle["precision"], kind: ReleaseTitle["kind"] = "game"): ReleaseTitle {
  return { id, kind, provider: kind === "game" ? "igdb" : "tmdb", externalId: id.split(":")[1]!, title: name, originalTitle: null, cover: null,
    platforms: kind === "game" ? ["PC", "PS5"] : [], date, precision, region: kind === "game" ? "worldwide" : "korea", popularity: 1, dates: [] };
}

function calendar(entries: ReleaseCalendar["entries"], sources: ReleaseCalendar["sources"] = [
  { provider: "igdb", fetchedAt: new Date().toISOString(), attemptedAt: null, errorCode: null, due: false },
  { provider: "tmdb", fetchedAt: new Date().toISOString(), attemptedAt: null, errorCode: null, due: false },
]): ReleaseCalendar {
  return { rangeStart: "2026-09-26", rangeEnd: "2027-03-28", entries, sources };
}

function gateway(initial: ReleaseCalendar, wishlist: ReleaseWishlistItem[] = []): ReleaseCalendarGateway {
  let items = wishlist;
  return {
    calendar: vi.fn().mockResolvedValue(initial),
    refresh: vi.fn().mockResolvedValue(initial),
    wishlist: vi.fn().mockImplementation(async () => items),
    add: vi.fn().mockImplementation(async (id: string) => {
      const entry = initial.entries.find(candidate => candidate.id === id)!;
      const item: ReleaseWishlistItem = { ...entry, source: "calendar", addedAt: "", muted: false, lastCheckedAt: null, nextCheckAt: null, released: false, unread: [] };
      items = [...items, item];
      return item;
    }),
    remove: vi.fn().mockImplementation(async (id: string) => { items = items.filter(item => item.id !== id); }),
    setMuted: vi.fn(),
    acknowledge: vi.fn().mockImplementation(async (ids: string[]) => { items = items.map(item => ({ ...item, unread: item.unread.filter(event => !ids.includes(event.id)) })); }),
    runDue: vi.fn(),
  };
}

function mount(api: ReleaseCalendarGateway, onWishlistChange = vi.fn()) {
  return render(<LibraryProvider gateway={{ releaseCalendar: api } as unknown as LibraryGateway}><ReleaseCalendarView onWishlistChange={onWishlistChange} /></LibraryProvider>);
}

describe("release calendar wording", () => {
  it("states each precision the way it is known", () => {
    expect(releaseDateLabel("2026-10-22", "exact", 2026)).toBe("10월 22일");
    expect(releaseDateLabel("2026-10-01", "month", 2026)).toBe("10월 중");
    expect(releaseDateLabel("2027-01-01", "month", 2026)).toBe("2027년 1월 중");
    expect(releaseDateLabel("2027-01-01", "quarter", 2026)).toBe("2027 Q1");
    expect(releaseDateLabel("2027-01-01", "year", 2026)).toBe("2027년 중");
    expect(releaseDateLabel(null, "tbd", 2026)).toBe("미정");
    expect(releaseTokenLabel("2026-Q4", 2026)).toBe("2026 Q4");
    expect(releaseTokenLabel("2026-11", 2026)).toBe("11월 중");
    expect(releaseEventLine({ id: "e", itemId: "igdb:1", kind: "date_changed", previousValue: "2026-10-02", currentValue: "2026-10-09", detectedAt: "", readAt: null }, 2026)).toBe("발매일 변경 · 10월 2일 → 10월 9일");
  });

  it("groups months first, then an unnarrowed quarter or year after its last month, then TBD", () => {
    const groups = groupReleases([
      title("igdb:1", "Q4", "2026-10-01", "quarter"),
      title("igdb:2", "Dec", "2026-12-05", "exact"),
      title("igdb:3", "TBD", null, "tbd"),
      title("igdb:4", "Oct", "2026-10-01", "month"),
      title("igdb:5", "Year", "2027-01-01", "year"),
      title("igdb:6", "Jan", "2027-01-10", "exact"),
    ]);
    expect(groups.map(group => group.label)).toEqual(["2026년 10월", "2026년 12월", "2026 Q4 · 월 미정", "2027년 1월", "2027년 · 시기 미정", "미정"]);
  });
});

describe("ReleaseCalendarView", () => {
  it("lists upcoming titles by month and toggles the wishlist", async () => {
    const api = gateway(calendar([
      { ...title("igdb:1", "기다리는 게임", "2026-10-22", "exact"), watched: false },
      { ...title("tmdb:2", "개봉 영화", "2026-11-01", "month", "movie"), watched: false },
    ]));
    const changed = vi.fn();
    mount(api, changed);
    const october = await screen.findByRole("region", { name: "2026년 10월" });
    expect(within(october).getByText("기다리는 게임")).toBeInTheDocument();
    expect(within(october).getByText("10월 22일")).toBeInTheDocument();
    expect(within(october).getByText("PC · PS5")).toBeInTheDocument();
    expect(screen.getByText("11월 중")).toBeInTheDocument();
    expect(api.refresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "기다리는 게임 관심 목록에 추가" }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith("igdb:1"));
    expect(await screen.findByRole("button", { name: "기다리는 게임 관심 목록에서 빼기" })).toHaveAttribute("aria-pressed", "true");
    expect(changed).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^관심 목록/, pressed: false }));
    expect(screen.queryByText("개봉 영화")).not.toBeInTheDocument();
    expect(screen.getByText("기다리는 게임")).toBeInTheDocument();
  });

  it("refreshes a due source in the background and explains a missing connection", async () => {
    const stale = calendar([], [
      { provider: "igdb", fetchedAt: null, attemptedAt: null, errorCode: null, due: true },
      { provider: "tmdb", fetchedAt: null, attemptedAt: null, errorCode: "credential_not_configured", due: false },
    ]);
    const api = gateway(stale);
    mount(api);
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/영화 \(TMDB\): 연결 설정이 필요합니다/)).toBeInTheDocument();
    expect(screen.getByText(/TMDB API but is not endorsed/)).toBeInTheDocument();
  });

  it("shows unread wishlist changes until they are acknowledged by id", async () => {
    const watched = title("tmdb:5", "관심 영화", "2026-10-09", "exact", "movie");
    const api = gateway(calendar([{ ...watched, watched: true }]), [{
      ...watched, source: "calendar", addedAt: "", muted: false, lastCheckedAt: null, nextCheckAt: null, released: false,
      unread: [{ id: "ev1", itemId: "tmdb:5", kind: "date_changed", previousValue: "2026-10-02", currentValue: "2026-10-09", detectedAt: "", readAt: null }],
    }]);
    mount(api);
    expect(await screen.findByText(/발매일 변경 · .*10월 2일 → .*10월 9일/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "관심 영화 알림 확인" }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith(["ev1"]));
    await waitFor(() => expect(screen.queryByText(/발매일 변경/)).not.toBeInTheDocument());
  });
});
