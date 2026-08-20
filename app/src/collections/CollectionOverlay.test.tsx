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
  it("prefers a local collection cover and falls back to stored WorkArtwork", async () => {
    renderOverlay({
      listCollectionCovers: vi.fn().mockResolvedValue([{ fileName: "local.jpg", volumeLabel: "1", shelf: 1 }]),
    });
    await waitFor(() => expect(document.querySelector(".collection-overlay__hero img")).toHaveAttribute(
      "src",
      "http://lakomics.localhost/collection-cover/collection-1/local.jpg",
    ));
    cleanup();

    renderOverlay();
    expect(await screen.findByRole("img", { name: "던전밥" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/artwork-1",
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
