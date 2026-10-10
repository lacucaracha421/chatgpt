import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, ReleaseCalendar, ReleaseCalendarGateway, ReleaseTitle, ReleaseWishlistItem } from "../library/types";
import { groupReleaseDays, groupReleases, releaseCalendarStart, releaseDateLabel, releaseEventLine, releaseTokenLabel } from "./releaseCalendarFormat";
import { upcomingRows } from "../home/homeModel";
import { ReleaseCalendarView } from "./ReleaseCalendarView";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 27, 12));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function title(id: string, name: string, date: string | null, precision: ReleaseTitle["precision"], kind: ReleaseTitle["kind"] = "game"): ReleaseTitle {
  return { id, kind, provider: kind === "game" ? "igdb" : "tmdb", externalId: id.slice(id.indexOf(":") + 1), title: name, originalTitle: null, cover: null,
    platforms: kind === "game" ? ["PC", "PS5"] : [], date, precision, region: kind === "game" ? "worldwide" : kind === "anime" ? "JP" : "korea", popularity: 1, dates: [] };
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
    refreshNow: vi.fn().mockResolvedValue(initial),
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

function mount(api: ReleaseCalendarGateway, onWishlistChange = vi.fn(), props: { query?: string; onOpenSettings?: () => void } = {}) {
  return render(<LibraryProvider gateway={{ releaseCalendar: api } as unknown as LibraryGateway}><ReleaseCalendarView {...props} onWishlistChange={onWishlistChange} /></LibraryProvider>);
}

describe("server calendar handover", () => {
  it("shows a background handover failure through the existing error presentation and retains content", async () => {
    const api = gateway(calendar([{ ...title("igdb:1", "Retained title", "2026-10-22", "exact"), watched: false }]));
    let report!: (error: unknown) => void;
    const stop = vi.fn();
    api.subscribeWishlistError = handler => { report = handler; return stop; };
    const mounted = mount(api);
    await screen.findByText("Retained title");
    act(() => report({ code: "wishlist_seed_too_large", message: "이관 용량이 너무 큽니다." }));
    expect(screen.getByText("이관 용량이 너무 큽니다.")).toBeInTheDocument();
    expect(screen.getByText("Retained title")).toBeInTheDocument();
    mounted.unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("shows a pending wishlist add immediately while retaining the covers", async () => {
    const entry = { ...title("igdb:1", "Pending title", "2026-10-22", "exact"), watched: false };
    const api = gateway(calendar([entry]));
    let resolveAdd!: (item: ReleaseWishlistItem) => void;
    let changed!: () => void;
    api.subscribeChanged = handler => { changed = handler; return () => {}; };
    api.add = vi.fn().mockImplementation(() => new Promise<ReleaseWishlistItem>(resolve => { resolveAdd = resolve; }));
    mount(api);
    await screen.findByText("Pending title");
    fireEvent.click(screen.getByRole("button", { name: "Pending title 관심 목록에 추가" }));
    expect(screen.getByRole("button", { name: "Pending title 관심 목록에서 빼기" })).toBeInTheDocument();
    expect(screen.getByText("Pending title")).toBeInTheDocument();
    await act(async () => { changed(); });
    expect(screen.getByRole("button", { name: "Pending title 관심 목록에서 빼기" })).toBeInTheDocument();
    const item: ReleaseWishlistItem = { ...entry, source: "calendar", addedAt: "", muted: false, lastCheckedAt: null, nextCheckAt: null, released: false, unread: [] };
    api.wishlist = vi.fn().mockResolvedValue([item]);
    await act(async () => { resolveAdd(item); });
    expect(screen.getByRole("button", { name: "Pending title 관심 목록에서 빼기" })).toBeInTheDocument();
  });

  it("restores membership after a real rejected edit without clearing the calendar", async () => {
    const entry = { ...title("igdb:1", "Rejected title", "2026-10-22", "exact"), watched: false };
    const api = gateway(calendar([entry]));
    api.add = vi.fn().mockRejectedValue(new Error("rejected"));
    mount(api);
    await screen.findByText("Rejected title");
    fireEvent.click(screen.getByRole("button", { name: "Rejected title 관심 목록에 추가" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rejected title 관심 목록에 추가" })).toBeInTheDocument());
    expect(screen.getByText("Rejected title")).toBeInTheDocument();
  });

  it("does not discover providers when the server owns a due calendar", async () => {
    const cached = calendar([{ ...title("igdb:1", "Server title", "2026-10-22", "exact"), watched: false }]);
    cached.sources[0]!.due = true;
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    api.serverStatus = vi.fn().mockResolvedValue({ version: 1, busy: false, sources: cached.sources });
    mount(api);
    await screen.findByText("Server title");
    await waitFor(() => expect(api.serverStatus).toHaveBeenCalled());
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it.each(["rateLimited", "unavailable"] as const)("keeps the calendar and status after %s", async outcome => {
    const cached = calendar([{ ...title("igdb:1", "Keep title", "2026-10-22", "exact"), watched: false }]);
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    api.serverStatus = vi.fn().mockResolvedValue({ version: 1, busy: false, sources: cached.sources });
    api.requestServerRun = vi.fn().mockResolvedValue({ outcome, retryAfterSeconds: 12 });
    mount(api);
    await screen.findByText("Keep title");
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Keep title")).toBeInTheDocument();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(api.requestServerRun).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("잠시");
  });

  it("stops after two unchanged idle reads and keeps content on a status error", async () => {
    vi.useFakeTimers();
    const cached = calendar([{ ...title("igdb:1", "Keep title", "2026-10-22", "exact"), watched: false }]);
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    api.serverStatus = vi.fn().mockResolvedValue({ version: 1, busy: false, finishedAt: "before", sources: cached.sources });
    api.requestServerRun = vi.fn().mockResolvedValue({ outcome: "queued" });
    mount(api);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(api.serverStatus).toHaveBeenCalledTimes(4); // initial + before + two idle reads
    expect(api.calendar).toHaveBeenCalledTimes(2);
    expect(api.refresh).not.toHaveBeenCalled();
    vi.mocked(api.serverStatus!).mockRejectedValueOnce(new Error("unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Keep title")).toBeInTheDocument();
  });

  it("a status failure blanks source labels without failing the cached calendar", async () => {
    const cached = calendar([{ ...title("igdb:1", "Offline title", "2026-10-22", "exact"), watched: false }]);
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    api.serverStatus = vi.fn().mockRejectedValue(new Error("status unavailable"));
    mount(api);
    await screen.findByText("Offline title");
    await waitFor(() => expect(api.serverStatus).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/^갱신 /)).toBeNull();
  });

  it("ends the spinner after idle reads while document revalidation is still pending", async () => {
    vi.useFakeTimers();
    const cached = calendar([{ ...title("igdb:1", "Visible title", "2026-10-22", "exact"), watched: false }]);
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    api.serverStatus = vi.fn().mockResolvedValue({ version: 1, busy: false, sources: cached.sources });
    api.requestServerRun = vi.fn().mockResolvedValue({ outcome: "queued" });
    api.revalidate = vi.fn(() => new Promise<ReleaseCalendar>(() => {}));
    mount(api);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(api.revalidate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    expect(screen.getByText("Visible title")).toBeInTheDocument();
  });

  it("falls back to a local refresh when the run response observes OFF", async () => {
    const cached = calendar([{ ...title("igdb:1", "Keep title", "2026-10-22", "exact"), watched: false }]);
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    api.serverStatus = vi.fn().mockResolvedValue({ version: 1, busy: false, sources: cached.sources });
    api.requestServerRun = vi.fn().mockResolvedValue({ outcome: "local" });
    mount(api);
    await screen.findByText("Keep title");
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("replaces cached content after the background notification without blanking it", async () => {
    const cached = calendar([{ ...title("igdb:1", "Cached title", "2026-10-22", "exact"), watched: false }]);
    const fresh = calendar([{ ...title("igdb:2", "Fresh title", "2026-10-23", "exact"), watched: false }]);
    const api = gateway(cached);
    let notify = () => {};
    const unsubscribe = vi.fn();
    api.subscribeChanged = handler => { notify = handler; return unsubscribe; };
    const mounted = mount(api);
    await screen.findByText("Cached title");
    let resolve!: (value: ReleaseCalendar) => void;
    vi.mocked(api.calendar).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    act(() => notify());
    expect(screen.getByText("Cached title")).toBeInTheDocument();
    await act(async () => resolve(fresh));
    expect(screen.getByText("Fresh title")).toBeInTheDocument();
    expect(screen.queryByText("Cached title")).toBeNull();
    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("swaps the calendar after the requested server wake completes", async () => {
    vi.useFakeTimers();
    const cached = calendar([{ ...title("igdb:1", "Before check", "2026-10-22", "exact"), watched: false }]);
    const fresh = calendar([{ ...title("igdb:2", "After check", "2026-10-23", "exact"), watched: false }]);
    const api = gateway(cached);
    vi.mocked(api.calendar).mockResolvedValueOnce(cached).mockResolvedValue(fresh);
    api.serverEnabled = vi.fn().mockResolvedValue(true);
    const before = { version: 1, busy: false, finishedAt: "before", sources: cached.sources };
    api.serverStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(before)
      .mockResolvedValue({ ...before, finishedAt: "after", sources: fresh.sources });
    api.requestServerRun = vi.fn().mockResolvedValue({ outcome: "queued" });
    mount(api);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(screen.getByText("Before check")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText("After check")).toBeInTheDocument();
    expect(screen.queryByText("Before check")).toBeNull();
    expect(api.serverStatus).toHaveBeenCalledTimes(3);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it("returns to local calendar status when the feature is no longer advertised", async () => {
    const cached = calendar([{ ...title("igdb:1", "Server title", "2026-10-22", "exact"), watched: false }]);
    const api = gateway(cached);
    api.serverEnabled = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    api.serverStatus = vi.fn().mockResolvedValue({ version: 1, busy: false,
      sources: [{ ...cached.sources[0]!, errorCode: "rate_limited" }] });
    mount(api);
    await screen.findByText(/게임 \(IGDB\):/);
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith(true));
    expect(screen.queryByText(/게임 \(IGDB\):/)).toBeNull();
    expect(screen.getByText("Server title")).toBeInTheDocument();
  });
});

describe("release calendar wording", () => {
  it("keeps today minus seven, drops minus eight, and uses local calendar days across DST", () => {
    const now = new Date(2026, 9, 3, 0, 30);
    expect(releaseCalendarStart(now)).toBe("2026-09-26");
    expect(releaseCalendarStart(new Date(2026, 2, 9, 0, 30))).toBe("2026-03-02");
    const groups = groupReleases([
      title("igdb:old", "Too old", "2026-09-25", "exact"),
      title("igdb:week", "Week", "2026-09-26", "exact"),
      title("igdb:yesterday", "Yesterday", "2026-10-02", "exact"),
      title("igdb:today", "Today", "2026-10-03", "exact"),
      title("igdb:month", "September", "2026-09-01", "month"),
      title("igdb:expired", "August", "2026-08-01", "month"),
    ], now);
    expect(groups.map(group => group.label)).toEqual(["지난 7일", "2026년 9월", "2026년 10월"]);
    expect(groupReleaseDays(groups[0]!.items).flat().map(item => item.id)).toEqual(["igdb:week", "igdb:yesterday"]);
    expect(groups.flatMap(group => group.items).map(item => item.id)).not.toContain("igdb:old");
  });
  it("states each precision the way it is known", () => {
    expect(releaseDateLabel("2026-10-22", "exact", 2026)).toBe("10.22");
    expect(releaseDateLabel("2026-10-01", "month", 2026)).toBe("10월 중");
    expect(releaseDateLabel("2027-01-01", "month", 2026)).toBe("2027년 1월 중");
    expect(releaseDateLabel("2027-01-01", "quarter", 2026)).toBe("2027 Q1");
    expect(releaseDateLabel("2027-01-01", "year", 2026)).toBe("2027년 중");
    expect(releaseDateLabel(null, "tbd", 2026)).toBe("미정");
    expect(releaseTokenLabel("2026-Q4", 2026)).toBe("2026 Q4");
    expect(releaseTokenLabel("2026-11", 2026)).toBe("11월 중");
    expect(releaseEventLine({ id: "e", itemId: "igdb:1", kind: "date_changed", previousValue: "2026-10-02", currentValue: "2026-10-09", detectedAt: "", readAt: null }, 2026)).toBe("발매일 변경 · 10.2 → 10.9");
  });

  it("groups months first, a quarter after its last month, bare years after every month, then TBD", () => {
    const groups = groupReleases([
      title("igdb:1", "Q4", "2026-10-01", "quarter"),
      title("igdb:2", "Dec", "2026-12-05", "exact"),
      title("igdb:3", "TBD", null, "tbd"),
      title("igdb:4", "Oct", "2026-10-01", "month"),
      title("igdb:5", "Year", "2027-01-01", "year"),
      title("igdb:6", "Jan", "2027-01-10", "exact"),
      title("igdb:7", "This year", "2026-01-01", "year"),
    ]);
    expect(groups.map(group => group.label)).toEqual(["2026년 10월", "2026년 12월", "2026 Q4 · 월 미정", "2027년 1월", "2026년 · 시기 미정", "2027년 · 시기 미정", "미정"]);
  });
});

describe("ReleaseCalendarView", () => {
  it("shows the past week first, folded and oldest first, and keeps its wishlist controls working", async () => {
    vi.setSystemTime(new Date(2026, 9, 3, 0, 30));
    const entries = [
      title("igdb:old", "8일 전", "2026-09-25", "exact"),
      title("igdb:week", "7일 전", "2026-09-26", "exact"),
      title("igdb:yesterday", "어제 작품", "2026-10-02", "exact"),
      title("igdb:today", "오늘 작품", "2026-10-03", "exact"),
    ].map(item => ({ ...item, watched: false }));
    const api = gateway(calendar(entries));
    mount(api);
    const recent = await screen.findByRole("region", { name: "지난 7일" });
    expect(recent).toHaveClass("is-recent");
    expect(within(recent).queryAllByRole("listitem")).toHaveLength(0);
    await userEvent.click(within(recent).getByRole("button", { name: "펼치기" }));
    expect(within(recent).getAllByRole("listitem").map(item => item.textContent)).toEqual([expect.stringContaining("7일 전"), expect.stringContaining("어제 작품")]);
    expect(screen.queryByText("8일 전")).not.toBeInTheDocument();
    expect(within(recent).queryByText(/D-|오늘/)).not.toBeInTheDocument();
    expect(screen.getByText("오늘")).toBeInTheDocument();
    expect(recent.compareDocumentPosition(screen.getByRole("region", { name: "2026년 10월" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(recent).getByRole("button", { name: "7일 전 관심 목록에 추가" }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith("igdb:week"));
    await screen.findByRole("button", { name: "7일 전 관심 목록에서 빼기" });
    await userEvent.click(screen.getByRole("button", { name: "관심 1" }));
    expect(screen.getByText("7일 전")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "7일 전 관심 목록에서 빼기" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("igdb:week"));
  });
  it("lists upcoming titles by month and toggles the wishlist", async () => {
    const api = gateway(calendar([
      { ...title("igdb:1", "기다리는 게임", "2026-10-22", "exact"), watched: false },
      { ...title("tmdb:2", "개봉 영화", "2026-11-01", "month", "movie"), watched: false },
    ]));
    const changed = vi.fn();
    mount(api, changed);
    const october = await screen.findByRole("region", { name: "2026년 10월" });
    expect(within(october).getByText("기다리는 게임")).toBeInTheDocument();
    expect(within(october).getByText("10.22")).toBeInTheDocument();
    expect(within(october).getByRole("img", { name: "PC" })).toHaveAttribute("title", "PC (Steam): PC");
    expect(within(october).getByRole("img", { name: "PS5" })).toHaveAttribute("title", "PlayStation: PS5");
    expect(within(october).queryByText("이식")).not.toBeInTheDocument();
    expect(screen.getByText("11월 중")).toBeInTheDocument();
    expect(screen.queryByText("국내 개봉")).not.toBeInTheDocument();
    expect(api.refresh).not.toHaveBeenCalled();
    const topRow = screen.getByRole("region", { name: "발매 캘린더" }).querySelector(".release-calendar__top-row") as HTMLElement;
    expect(within(topRow).getByRole("radio", { name: "전체 2" })).toBeInTheDocument();
    expect(within(topRow).getAllByRole("radio", { name: / 1$/ })).toHaveLength(2);
    expect(within(topRow).getByRole("button", { name: "관심 0", pressed: false })).toBeInTheDocument();

    const watchButton = screen.getByRole("button", { name: "기다리는 게임 관심 목록에 추가" });
    expect(watchButton.closest(".release-calendar__cover")).not.toBeNull();

    await userEvent.click(watchButton);
    await waitFor(() => expect(api.add).toHaveBeenCalledWith("igdb:1"));
    expect(await screen.findByRole("button", { name: "기다리는 게임 관심 목록에서 빼기" })).toHaveAttribute("aria-pressed", "true");
    expect(changed).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "관심 1", pressed: false }));
    expect(screen.queryByText("개봉 영화")).not.toBeInTheDocument();
    expect(screen.getByText("기다리는 게임")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith(true));
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

  it.each(["movie", "anime"] as const)("shows unread %s wishlist changes until they are acknowledged by id", async (kind) => {
    const id = kind === "anime" ? "tmdb:tv:5:s2" : "tmdb:5";
    const watched = title(id, "관심 작품", "2026-10-09", "exact", kind);
    const api = gateway(calendar([{ ...watched, watched: true }]), [{
      ...watched, source: "calendar", addedAt: "", muted: false, lastCheckedAt: null, nextCheckAt: null, released: false,
      unread: [{ id: "ev1", itemId: id, kind: "date_changed", previousValue: "2026-10-02", currentValue: "2026-10-09", detectedAt: "", readAt: null }],
    }]);
    mount(api);
    expect(await screen.findByText(/발매일 변경 · .*10\.2 → .*10\.9/)).toBeInTheDocument();
    expect(screen.getByText("NEW 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "관심 1", pressed: false }));
    expect(screen.getByRole("button", { name: "관심 1", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "모두 확인" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "관심 작품 알림 확인" }));
    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith(["ev1"]));
    await waitFor(() => expect(screen.queryByText(/발매일 변경/)).not.toBeInTheDocument());
  });
});


it("filters anime seasons and uses the same wishlist add and remove flow", async () => {
  const api = gateway(calendar([
    { ...title("igdb:1", "게임", "2026-10-01", "exact"), watched: false },
    { ...title("tmdb:123", "영화 제목", "2026-10-01", "exact", "movie"), watched: false },
    { ...title("tmdb:tv:123:s1", "새 애니", "2026-10-01", "exact", "anime"), watched: false },
    { ...title("tmdb:tv:123:s2", "새 애니 · 시즌 2", "2026-11-01", "exact", "anime"), watched: false },
  ]));
  mount(api);
  expect(await screen.findByText("영화 제목")).toBeInTheDocument();
  expect(screen.getByText("새 애니")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "애니 2" }));
  expect(screen.getByRole("radio", { name: "애니 2" })).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByText("영화 제목")).not.toBeInTheDocument();
  expect(screen.queryByText("일본 방영")).not.toBeInTheDocument();
  expect(screen.getAllByText("ANIME")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "새 애니 · 시즌 2 관심 목록에 추가" }));
  await waitFor(() => expect(api.add).toHaveBeenCalledWith("tmdb:tv:123:s2"));
  await userEvent.click(screen.getByRole("button", { name: /^관심 / }));
  expect(screen.queryByText("새 애니")).not.toBeInTheDocument();
  expect(screen.getByText("새 애니 · 시즌 2")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "새 애니 · 시즌 2 관심 목록에서 빼기" }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith("tmdb:tv:123:s2"));
  expect(await screen.findByText("관심 목록 비어 있음")).toBeInTheDocument();
});

it("labels an anime source failure separately from movies", async () => {
  mount(gateway(calendar([], [
    { provider: "tmdb_tv", fetchedAt: null, attemptedAt: null, errorCode: "credential_not_configured", due: false },
  ])));
  expect(await screen.findByText(/애니 \(TMDB\): 연결 설정이 필요합니다/)).toBeInTheDocument();
});


it("preserves anime kind and Japanese broadcast wording in Home rows", () => {
  const watched: ReleaseWishlistItem = {
    ...title("tmdb:tv:123:s2", "애니 · 시즌 2", "2026-10-09", "exact", "anime"),
    source: "calendar", addedAt: "", muted: false, lastCheckedAt: null, nextCheckAt: null, released: false, unread: [],
  };
  const rows = upcomingRows([], new Map(), new Map(), [watched], "2026-09-27");
  expect(rows).toHaveLength(1);
  // Home shows only the kind chip for movies and anime (2026-09-28), no "일본 방영" text.
  expect(rows[0]).toMatchObject({ kind: "anime", detail: "", name: "애니 · 시즌 2" });
});

it("uses the distinct search and calendar empty states", async () => {
  mount(gateway(calendar([])));
  expect(await screen.findByText("6개월 안의 발매 정보 없음")).toBeInTheDocument();

  cleanup();
  mount(gateway(calendar([{ ...title("igdb:1", "기다리는 게임", "2026-10-01", "exact"), watched: false }])), vi.fn(), { query: "없는 작품" });
  expect(await screen.findByText("검색 결과 없음")).toBeInTheDocument();
});

it("shows skeleton tiles during the initial calendar load", () => {
  const api = gateway(calendar([]));
  api.calendar = vi.fn(() => new Promise<ReleaseCalendar>(() => {}));
  mount(api);
  expect(screen.getAllByRole("status", { name: "발매 정보 불러오는 중" }).length).toBeGreaterThan(1);
});
