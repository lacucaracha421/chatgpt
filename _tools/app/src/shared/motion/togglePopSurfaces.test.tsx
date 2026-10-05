import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssetViewer } from "../../assets/AssetViewer";
import type { AssetSummary, CatalogWorkDetail } from "../../library/types";
import { MangaCard } from "../../manga/MangaCard";
import { MangaDetail } from "../../manga/MangaDetail";

const pop = vi.hoisted(() => ({ popToggle: vi.fn() }));
vi.mock("./togglePop", () => pop);

afterEach(() => { cleanup(); pop.popToggle.mockReset(); });

function asset(id: string, favorite: boolean): AssetSummary {
  return { id, title: null, originalName: `${id}.png`, byteSize: 1, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } };
}

it("pops the PC viewer heart from a click and the F shortcut, never on open or when the asset changes", () => {
  const items = [asset("a", false), asset("b", true)];
  const onToggleFavorite = vi.fn();
  const { rerender } = render(<AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} onToggleFavorite={onToggleFavorite} />);
  rerender(<AssetViewer items={items} activeId="b" onActiveIdChange={vi.fn()} onClose={vi.fn()} onToggleFavorite={onToggleFavorite} />);
  expect(pop.popToggle).not.toHaveBeenCalled();

  const heart = screen.getByRole("button", { name: "좋아요 취소" });
  expect(heart).toHaveAttribute("data-toggle-key", "b");
  fireEvent.click(heart);
  expect(pop.popToggle).toHaveBeenLastCalledWith(heart, false);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "f" });
  expect(pop.popToggle).toHaveBeenLastCalledWith(heart, false);
  expect(onToggleFavorite).toHaveBeenCalledTimes(2);

  rerender(<AssetViewer items={items} activeId="a" onActiveIdChange={vi.fn()} onClose={vi.fn()} onToggleFavorite={onToggleFavorite} />);
  fireEvent.click(screen.getByRole("button", { name: "좋아요" }));
  expect(pop.popToggle).toHaveBeenLastCalledWith(screen.getByRole("button", { name: "좋아요" }), true);
  expect(pop.popToggle).toHaveBeenCalledTimes(3);
});

it("pops catalog bookmarks on the card and in the detail with the state they turn to", () => {
  const onBookmark = vi.fn();
  const { rerender } = render(<MangaCard title="작품" coverUrl={null} pageCount={3} onOpen={vi.fn()} bookmarked={false} onBookmark={onBookmark} />);
  rerender(<MangaCard title="작품" coverUrl={null} pageCount={3} onOpen={vi.fn()} bookmarked onBookmark={onBookmark} />);
  expect(pop.popToggle).not.toHaveBeenCalled();
  const card = screen.getByRole("button", { name: "작품 북마크 해제" });
  fireEvent.click(card);
  expect(pop.popToggle).toHaveBeenLastCalledWith(card, false);
  expect(onBookmark).toHaveBeenCalledOnce();
  cleanup();

  const detail: CatalogWorkDetail = { provider: "kHentai", providerWorkId: "3", title: "작품", titleJpn: "", thumbnailUrl: null, uploader: "tester", category: 2, posted: null, updated: null, fileCount: 3, fileSize: 1, rating: 400, views: 10, bookmarked: false, tagGroups: [] };
  const onDetailBookmark = vi.fn();
  render(<MangaDetail detail={detail} bookmarkPending={false} reading={false} editionCount={0} editions={[]} editionsLoading={false} editionsError={false} hasMoreEditions={false}
    onBookmark={onDetailBookmark} onRead={vi.fn()} onTagSearch={vi.fn()} onEdition={vi.fn()} onMoreEditions={vi.fn()} />);
  expect(pop.popToggle).toHaveBeenCalledTimes(1);
  const mark = screen.getByRole("button", { name: "북마크" });
  fireEvent.click(mark);
  expect(pop.popToggle).toHaveBeenLastCalledWith(mark, true);
  expect(onDetailBookmark).toHaveBeenCalledWith(true);
});
