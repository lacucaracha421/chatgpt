import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, MangaDexWorkPreview } from "../library/types";
import { MangaDexImportDialog } from "./MangaDexImportDialog";

afterEach(cleanup);

const preview: MangaDexWorkPreview = {
  mangaId: "manga-1",
  proposedTitle: "던전밥",
  alternateTitles: ["Delicious in Dungeon"],
  author: "쿠이 료코",
  year: 2014,
  status: "completed",
  genres: "판타지, 코미디",
  overview: "던전에서 식재료를 구하는 모험 이야기",
  covers: [
    { coverId: "cover-1", fileName: "cover-1.jpg", volume: "1", language: "ja" },
    { coverId: "cover-2", fileName: "cover-2.jpg", volume: "2", language: "ja" },
  ],
};

const collection = {
  id: "collection-1",
  name: "던전밥",
  type: "manga",
} as CollectionSummary;

function renderDialog(target: { kind: "new" } | { kind: "existing"; collection: CollectionSummary } = { kind: "new" }) {
  const gateway = {
    searchMangaDex: vi.fn().mockResolvedValue([{
      mangaId: "manga-1",
      title: "던전밥",
      alternateTitles: ["Delicious in Dungeon"],
      author: "쿠이 료코",
      year: 2014,
      status: "completed",
      primaryCoverFileName: "cover-1.jpg",
    }]),
    previewMangaDex: vi.fn().mockResolvedValue(preview),
    applyMangaDex: vi.fn().mockResolvedValue(collection),
  } as unknown as LibraryGateway;
  const onApplied = vi.fn().mockResolvedValue(undefined);

  render(
    <LibraryProvider gateway={gateway}>
      <MangaDexImportDialog open target={target} onClose={() => undefined} onApplied={onApplied} />
    </LibraryProvider>,
  );
  return { gateway, onApplied };
}

describe("MangaDexImportDialog", () => {
  it("selects a text result and creates without requesting or choosing a cover", async () => {
    const user = userEvent.setup();
    const { gateway, onApplied } = renderDialog();

    await user.type(screen.getByRole("searchbox", { name: "만화 검색" }), "  던전밥  ");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(gateway.searchMangaDex).toHaveBeenCalledWith("던전밥");

    const result = await screen.findByRole("button", { name: /던전밥/ });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(result);

    expect(gateway.previewMangaDex).not.toHaveBeenCalled();
    expect(result).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "작품 만들기" });
    expect(apply).toBeEnabled();
    await user.click(apply);

    await waitFor(() => expect(gateway.applyMangaDex).toHaveBeenCalledWith({
      target: { kind: "new", name: "던전밥" },
      mangaId: "manga-1",
    }));
    expect(onApplied).toHaveBeenCalledWith(collection);
  });

  it("keeps the selected preview when applying to an existing collection fails", async () => {
    const user = userEvent.setup();
    const existing = { ...collection, id: "collection-9" };
    const { gateway } = renderDialog({ kind: "existing", collection: existing });
    vi.mocked(gateway.applyMangaDex).mockRejectedValueOnce(new Error("연결하지 못했습니다."));

    await user.type(screen.getByRole("searchbox", { name: "만화 검색" }), "던전밥");
    await user.click(screen.getByRole("button", { name: "검색" }));
    const result = await screen.findByRole("button", { name: /던전밥/ });
    await user.click(result);
    await user.click(screen.getByRole("button", { name: "연결" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("연결하지 못했습니다.");
    expect(result).toHaveAttribute("aria-pressed", "true");
    expect(gateway.previewMangaDex).not.toHaveBeenCalled();
    expect(gateway.applyMangaDex).toHaveBeenCalledWith({
      target: { kind: "existing", collectionId: "collection-9" },
      mangaId: "manga-1",
    });
  });
});
