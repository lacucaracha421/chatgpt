import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatisticsPanel } from "./StatisticsPanel";
import type { LibraryStatistics } from "./types";

const gateway = vi.hoisted(() => ({ getLibraryStatistics: vi.fn(), measureLibraryDerivativeStorage: vi.fn() }));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: { root: "fixture" } }) }));
vi.mock("../layout/ViewToolbar", () => ({ ViewToolbar: ({ title, actions, chrome }: { title: string; actions?: React.ReactNode; chrome?: { actions?: React.ReactNode } }) => <header>{title}{actions}{chrome?.actions}</header> }));

const stats: LibraryStatistics = {
  assets: 3, collections: 1, favorites: 1, unclassified: 2, originalRecordedBytes: 1024,
  mediaKinds: [{ label: "image", count: 3 }], collectedMonths: [], creators: [], classifications: [],
  collectionAndDailyStartedAt: "2026-09-06T00:00:00Z", mostOpenedAssets: [], mostOpenedCollections: [], longUnseenAssets: [], daily: [],
};
beforeEach(() => { vi.clearAllMocks(); gateway.getLibraryStatistics.mockResolvedValue(stats); });
afterEach(cleanup);

describe("StatisticsPanel", () => {
  it("loads SQL totals without scanning files and explains the unknown historical start", async () => {
    render(<StatisticsPanel />);
    expect(await screen.findByRole("heading", { name: "보관 현황" })).toBeInTheDocument();
    expect(gateway.measureLibraryDerivativeStorage).not.toHaveBeenCalled();
    expect(screen.getByText(/기존 자산 누적 열기의 기록 시작일은/)).toBeInTheDocument();
    expect(screen.getByText("아직 일별 열기 기록이 없습니다.")).toBeInTheDocument();
  });
  it("loads on open and keeps manual refresh in the overflow, not the toolbar", async () => {
    render(<StatisticsPanel />);
    await screen.findByRole("heading", { name: "보관 현황" });
    expect(gateway.getLibraryStatistics).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "새로고침" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "통계 더보기" }));
    await user.click(await screen.findByRole("menuitem", { name: "통계 새로고침" }));
    await waitFor(() => expect(gateway.getLibraryStatistics).toHaveBeenCalledTimes(2));
  });
  it("offers a retry only after loading fails", async () => {
    gateway.getLibraryStatistics.mockRejectedValueOnce(new Error("failed"));
    render(<StatisticsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "보관 현황" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  });
  it("lets the user retry a failed opt-in storage measurement and labels bounded results", async () => {
    gateway.measureLibraryDerivativeStorage.mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce({ measuredBytes: 10, measuredFiles: 1, unavailableFiles: 2, scanLimitReached: true });
    render(<StatisticsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "파생 미디어 크기 확인" }));
    const retry = await screen.findByRole("button", { name: "파생 미디어 크기 다시 확인" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(await screen.findByText(/전체 크기가 아닌 일부 합계/)).toBeInTheDocument();
    expect(gateway.getLibraryStatistics).toHaveBeenCalledTimes(1);
    expect(gateway.measureLibraryDerivativeStorage).toHaveBeenCalledTimes(2);
  });
});
