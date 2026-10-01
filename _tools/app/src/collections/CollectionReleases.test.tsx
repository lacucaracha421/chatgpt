import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, CollectionTrackingGateway, LibraryGateway, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";
import { CollectionReleases } from "./CollectionReleases";
import { japanReleaseLedger, koreanReleaseLedger, releaseLedgerCounts } from "./releaseLedger";
import { invalidateReleaseData, resetReleaseDataForTests, useReleaseData, type ReleaseData } from "./releaseData";

const today = "2026-09-29";
const work = (id: string) => ({ id, name: id, type: "manga", unreadReleaseCount: 0 }) as CollectionSummary;
const entry = (id: string, owned: number, volumes: [number, string | null, "released" | "upcoming" | null][]): ReleaseBoardEntry => ({
  collectionId: id, releaseWatch: { enabled: true, available: true }, ownedVolumes: [{ editionIndex: 0, count: owned }],
  releaseSchedule: { kakao: { editionIndex: 0, checkedAt: "2026-09-29T15:20:00", volumes: volumes.map(([volumeNumber, date, status]) => ({ volumeNumber, date, status })) }, mangadex: null },
});
const notice = (id: string, volumeNumber: number, provider: ReleaseInboxItem["provider"] = "kakao"): ReleaseInboxItem => ({
  collectionId: id, collectionName: id, provider, event: { id: `${id}-${volumeNumber}`, kind: "new_volume", volumeNumber, previousValue: null, currentValue: null, detectedAt: "2026-09-29T15:20:00" },
});
const works = ["먼 예정", "지난 미보유", "새 권", "가까운 예정"].map(work);
const data: ReleaseData = { board: new Map([
  ["새 권", entry("새 권", 23, [[24, "2026-09-22", "released"], [25, "2027-01-05", "upcoming"]])],
  ["지난 미보유", entry("지난 미보유", 3, [[4, "2026-08-01", "released"], [5, "2026-08-10", "released"], [6, "2026-08-19", "released"]])],
  ["가까운 예정", entry("가까운 예정", 7, [[8, "2026-09-30", "upcoming"]])],
  ["먼 예정", entry("먼 예정", 13, [[14, "2026-10-21", "upcoming"]])],
]), inbox: [notice("새 권", 24)] };
const byWork = new Map([["새 권", data.inbox]]);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-29T16:00:00")); });
afterEach(() => { cleanup(); resetReleaseDataForTests(); vi.useRealTimers(); });

function setup(extra: Partial<CollectionTrackingGateway> = {}) {
  const api = { acknowledge: vi.fn().mockResolvedValue(undefined), ...extra } as unknown as CollectionTrackingGateway;
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  const props = { provider: "kakao" as const, collections: works, data, loading: false, error: null, coverUrl: () => null, onOpen, onChanged, onProviderChange: vi.fn() };
  const wrap = (children: React.ReactNode) => <LibraryProvider gateway={{ collectionTracking: api } as LibraryGateway}>{children}</LibraryProvider>;
  return { api, onOpen, onChanged, props, wrap };
}

it("counts exclusive volume kinds and orders new, released/unowned, then upcoming by date", () => {
  const rows = koreanReleaseLedger(works, data.board, byWork, today);
  expect(rows.map(row => row.work.id)).toEqual(["새 권", "지난 미보유", "가까운 예정", "먼 예정"]);
  expect(releaseLedgerCounts(rows)).toEqual({ fresh: 1, unowned: 3, upcoming: 3 });
  expect(rows[0]).toMatchObject({ owned: 23, status: "NEW", date: "2027-01-05", chips: [{ kind: "new", label: "24권" }, { kind: "upcoming", label: "25권 2027.1.5" }] });
  expect(rows[1]).toMatchObject({ date: "2026-08-19", status: "미보유 3", chips: [{ kind: "plain" }, { kind: "plain" }, { kind: "plain" }] });
  expect(rows[2]).toMatchObject({ status: "D-1", chips: [{ label: "8권 9.30" }] });
  expect(rows[3]).toMatchObject({ status: "D-22" });
});

it("does not fill an upcoming chip just because it has an unread event, or count an unknown release as already out", () => {
  const upcoming = entry("up", 0, [[1, "2026-09-30", "released"], [2, null, null], [3, null, "upcoming"]]);
  const rows = koreanReleaseLedger([work("up")], new Map([["up", upcoming]]), new Map([["up", [notice("up", 1)]]]), today);
  expect(rows[0].chips.map(chip => chip.kind)).toEqual(["upcoming", "plain", "upcoming"]);
  expect(releaseLedgerCounts(rows)).toEqual({ fresh: 0, unowned: 0, upcoming: 2 });
});

it("treats a scheduled release today as released, with an unread NEW mark", () => {
  const released = entry("today", 0, [[1, today, "upcoming"]]);
  const rows = koreanReleaseLedger([work("today")], new Map([["today", released]]), new Map([["today", [notice("today", 1)]]]), today);
  expect(rows[0]).toMatchObject({ status: "NEW", date: today, chips: [{ kind: "new", label: "1권" }] });
});

it("uses the same Japanese ledger with edition ownership and a quiet ahead note", () => {
  const jp = entry("日本", 2, [[1, "2026-01-01", "released"], [2, "2026-02-01", "released"]]);
  jp.ownedVolumes.push({ editionIndex: 1, count: 3 });
  jp.releaseSchedule.mangadex = { checkedAt: null, latestVolume: 5, volumes: [1, 2, 3, 4, 5].map(volumeNumber => ({ volumeNumber, editionIndex: 1 })) };
  const rows = japanReleaseLedger([work("日本")], new Map([["日本", jp]]), new Map([["日本", [notice("日本", 5, "mangadex")]]]), today);
  expect(rows[0]).toMatchObject({ owned: 3, ahead: "한국보다 3권 앞섬", status: "NEW", date: null, chips: [{ label: "4권", kind: "plain" }, { label: "5권", kind: "new" }] });
  const { props, wrap } = setup();
  render(wrap(<CollectionReleases {...props} provider="mangadex" collections={[work("日本")]} data={{ board: new Map([["日本", jp]]), inbox: [notice("日本", 5, "mangadex")] }} />));
  expect(within(screen.getByRole("row", { name: "日本" })).getAllByRole("cell")[5]).toHaveTextContent("한국보다 3권 앞섬");
});

it("renders one shared toolbar, volume counts, chip kinds, dates and status cells", () => {
  const { props, wrap } = setup({ runUpdates: vi.fn() });
  render(wrap(<CollectionReleases {...props} />));
  expect(screen.getAllByRole("toolbar")).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "신간" })).toBeInTheDocument();
  expect(screen.getByText("15:20 확인")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "한국 정발 4" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
  const counts = screen.getByLabelText("권별 집계");
  expect(counts).toHaveTextContent("1새로 나옴3나왔지만 아직 없음3발매 예정");
  const fresh = screen.getByRole("row", { name: "새 권" });
  expect(within(fresh).getByText("1–23 권")).toBeInTheDocument();
  expect(within(fresh).getByText("24권")).toHaveClass("ui-badge--accent");
  expect(within(fresh).getByText("25권 2027.1.5")).toHaveAttribute("data-chip-kind", "upcoming");
  expect(within(screen.getByRole("row", { name: "지난 미보유" })).getByText("4권")).toHaveClass("ui-badge--plain");
  expect(screen.getByText("D-1")).toBeInTheDocument();
  expect(screen.getByText("D-22")).toBeInTheDocument();
  expect(screen.getByText("미보유 3")).toBeInTheDocument();
});

it("opens the work from any row cell and by keyboard, while confirmation stays separate", async () => {
  const { props, wrap, api, onOpen } = setup();
  render(wrap(<CollectionReleases {...props} />));
  const row = screen.getByRole("row", { name: "새 권" });
  await userEvent.click(within(row).getByText("24권"));
  expect(onOpen).toHaveBeenCalledWith("새 권");
  expect(api.acknowledge).not.toHaveBeenCalled();
  onOpen.mockClear();
  within(row).getByRole("button", { name: "새 권" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledWith("새 권");
  onOpen.mockClear();
  await userEvent.click(within(row).getByRole("button", { name: "새 권 확인" }));
  expect(api.acknowledge).toHaveBeenCalledWith("새 권", ["새 권-24"]);
  expect(onOpen).not.toHaveBeenCalled();
});

it("keeps the previous ledger, covers and counts inert while refreshing, then swaps once", () => {
  const { props, wrap, onOpen } = setup();
  const view = render(wrap(<CollectionReleases {...props} coverUrl={() => "/cover-a"} />));
  const table = screen.getByRole("table");
  const row = screen.getByRole("row", { name: "새 권" });
  view.rerender(wrap(<CollectionReleases {...props} collections={[]} data={null} loading coverUrl={() => "/cover-a"} />));
  expect(screen.getByRole("table")).toBe(table);
  expect(screen.getByRole("row", { name: "새 권" })).toBe(row);
  expect(screen.getByLabelText("권별 집계")).toHaveTextContent("1새로 나옴3나왔지만 아직 없음3발매 예정");
  expect(row.closest(".collection-releases__body")).toHaveAttribute("inert");
  expect(screen.queryByText("소장하지 않은 정발 권이 없습니다.")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("신간 읽는 중")).not.toBeInTheDocument();
  expect(row.querySelector("img")).toHaveAttribute("src", "/cover-a");
  fireEvent.click(row);
  expect(onOpen).not.toHaveBeenCalled();
  view.rerender(wrap(<CollectionReleases {...props} collections={[]} data={{ board: new Map(), inbox: [] }} />));
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByText("신간 알림을 켠 만화가 없습니다.")).toBeInTheDocument();
});

it("keeps the real cached ledger until an invalidated read completes", async () => {
  let complete!: (entries: ReleaseBoardEntry[]) => void;
  const { api, props, wrap } = setup({ releaseBoard: vi.fn().mockResolvedValue([...data.board.values()]), listInbox: vi.fn().mockResolvedValue(data.inbox) });
  function View() {
    const release = useReleaseData(api, works, true);
    return <CollectionReleases {...props} data={release.data} loading={release.loading} error={release.error} />;
  }
  render(wrap(<View />));
  await screen.findByRole("row", { name: "새 권" });
  vi.mocked(api.releaseBoard!).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  // The hook notification triggers a fresh asynchronous read while the old table remains.
  act(() => invalidateReleaseData());
  expect(screen.getByRole("row", { name: "새 권" })).toBeInTheDocument();
  expect(screen.getByRole("table").closest(".collection-releases__body")).toHaveAttribute("inert");
  act(() => complete([]));
  await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
});
