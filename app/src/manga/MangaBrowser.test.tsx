import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MangaSeries } from "../library/types";
import { MangaBrowser } from "./MangaBrowser";

afterEach(cleanup);

const series: MangaSeries[] = [
  { id: "s1", title: "T1", author: "a", pageCount: 60 },
  { id: "s2", title: "T2", author: "b", pageCount: 40 },
];

describe("MangaBrowser", () => {
  it("scans and shows the cover grid when the root is set", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    await waitFor(() => expect(gateway.scanManga).toHaveBeenCalled());
    expect(await screen.findByText("T1")).toBeVisible();
    expect(screen.getByText("T2")).toBeVisible();
    expect(screen.getAllByRole("img").length).toBe(2);
  });

  it("shows the setup prompt when the root is not set", async () => {
    const gateway = createGateway({ root: null, series: [] });
    render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    expect(await screen.findByText("망가 폴더가 설정되지 않았습니다")).toBeVisible();
  });

  it("uses the shared view toolbar with window controls", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const { container } = render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
    expect(await screen.findByRole("toolbar")).toBeInTheDocument();
    expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
  });

  it("opens the viewer when a cover is clicked", async () => {
    const gateway = createGateway({ root: "C:\\manga", series });
    const onOpenSeries = vi.fn();
    render(<LibraryProvider gateway={gateway}><MangaBrowser onOpenSeries={onOpenSeries} /></LibraryProvider>);
    await userEvent.click(await screen.findByText("T1"));
    expect(onOpenSeries).toHaveBeenCalledWith(series[0]);
  });
});

function createGateway(overrides: { root: string | null; series: MangaSeries[] }): LibraryGateway {
  const base: LibraryGateway = {
    openLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    patchAssetClassifications: vi.fn(), getAssetClassifications: vi.fn(), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    getMangaRoot: vi.fn().mockResolvedValue(overrides.root),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(overrides.series.length),
    listMangaSeries: vi.fn().mockResolvedValue(overrides.series),
  };
  return base;
}
