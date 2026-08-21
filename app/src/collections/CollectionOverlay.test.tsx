import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway } from "../library/types";
import { CollectionOverlay } from "./CollectionOverlay";

afterEach(cleanup);

const collection: CollectionSummary = {
  id: "collection-1",
  name: "던전밥",
  description: null,
  type: "manga",
  coverAssetId: null,
  selectedWorkArtworkId: "artwork-1",
  assetCount: 0,
  year: 2014,
  author: "쿠이 료코",
  director: null,
  externalScore: null,
  myScore: null,
  genres: "판타지",
  overview: null,
  showcase: false,
  createdAt: "t",
  updatedAt: "t",
};

function renderOverlay(overrides: Partial<LibraryGateway> = {}, onChanged = vi.fn().mockResolvedValue(undefined)) {
  const gateway = {
    listCollectionCovers: vi.fn().mockResolvedValue([]),
    listCollectionVolumes: vi.fn().mockResolvedValue([]),
    syncMangaDexVolumeCovers: vi.fn().mockResolvedValue({ completed: 0, skipped: 0, failed: 0 }),
    getMangaDexConnection: vi.fn().mockResolvedValue(null),
    refreshMangaDex: vi.fn().mockResolvedValue(collection),
    ...overrides,
  } as unknown as LibraryGateway;
  render(
    <LibraryProvider gateway={gateway}>
      <CollectionOverlay collectionId={collection.id} collections={[collection]} onExit={() => undefined} onChanged={onChanged} />
    </LibraryProvider>,
  );
  return { gateway, onChanged };
}

describe("CollectionOverlay MangaDex flow", () => {
  it("prefers a Volume cover and falls back to stored WorkArtwork", async () => {
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([
        { id: "volume-1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "local-art" },
      ]),
    });
    await waitFor(() => expect(document.querySelector(".collection-overlay__hero img")).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/local-art",
    ));
    cleanup();

    renderOverlay();
    expect(await screen.findByRole("img", { name: "던전밥" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/artwork-1",
    );
  });

  it("shows ordered manga Volume drawers, fills placeholders, and has no fake editor", async () => {
    let finishSync!: (result: { completed: number; skipped: number; failed: number }) => void;
    const syncMangaDexVolumeCovers = vi.fn().mockReturnValue(
      new Promise((resolve) => { finishSync = resolve; }),
    );
    const listCollectionVolumes = vi.fn()
      .mockResolvedValueOnce([
        { id: "v10", volumeNumber: 10, editionIndex: 0, displayLabel: "10", coverArtworkId: null },
        { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
        { id: "v1-1", volumeNumber: 1, editionIndex: 1, displayLabel: "1.1", coverArtworkId: "art-1-1" },
      ])
      .mockResolvedValueOnce([
        { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
        { id: "v10", volumeNumber: 10, editionIndex: 0, displayLabel: "10", coverArtworkId: "art-10" },
        { id: "v1-1", volumeNumber: 1, editionIndex: 1, displayLabel: "1.1", coverArtworkId: "art-1-1" },
      ]);
    const user = userEvent.setup();
    renderOverlay({ listCollectionVolumes, syncMangaDexVolumeCovers });

    expect(await screen.findAllByRole("button", { name: /^(2|10)권 표지/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^(2|10)권 표지/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "2권 표지",
      "10권 표지 불러오는 중",
    ]);
    expect(screen.queryByRole("textbox", { name: "권 번호" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "서랍 2" }));
    expect(screen.getByRole("button", { name: "1.1권 표지" })).toBeInTheDocument();

    finishSync({ completed: 1, skipped: 2, failed: 0 });
    await user.click(screen.getByRole("button", { name: "서랍 1" }));
    expect(await screen.findByRole("img", { name: "10권 표지" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork-thumbnail/art-10",
    );
  });

  it("opens the shared import dialog when the manga is not connected", async () => {
    const user = userEvent.setup();
    renderOverlay();

    await user.click(await screen.findByRole("button", { name: "MangaDex 연결" }));
    expect(screen.getByRole("heading", { name: "MangaDex 연결" })).toBeInTheDocument();
  });

  it("refreshes a connected manga and reports the change", async () => {
    const user = userEvent.setup();
    const { gateway, onChanged } = renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
    });

    await user.click(await screen.findByRole("button", { name: "MangaDex 새로고침" }));
    await waitFor(() => expect(gateway.refreshMangaDex).toHaveBeenCalledWith("collection-1"));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("retains the artwork and shows an error when refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
      refreshMangaDex: vi.fn().mockRejectedValue(new Error("새로고침하지 못했습니다.")),
    });
    const artwork = await screen.findByRole("img", { name: "던전밥" });

    await user.click(await screen.findByRole("button", { name: "MangaDex 새로고침" }));
    expect(await screen.findByRole("status")).toHaveTextContent("새로고침하지 못했습니다.");
    expect(artwork).toBeInTheDocument();
  });
});
