import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "../library/types";
import { GameCollectionDetail } from "./GameCollectionDetail";

afterEach(cleanup);

const collection: CollectionSummary = {
  id: "game-1",
  name: "Astral Chain",
  description: null,
  type: "game",
  coverAssetId: null,
  selectedWorkArtworkId: "work-art-1",
  selectedHeroArtworkId: "hero-art-1",
  assetCount: 12,
  unreadReleaseCount: 0,
  year: 2019,
  author: null,
  developer: "PlatinumGames",
  publisher: "Nintendo",
  platforms: "Nintendo Switch",
  productionCompany: null,
  releaseDate: "2019-08-30",
  director: null,
  externalScore: 87,
  myScore: 4.5,
  genres: "Action, Adventure",
  overview: "A special ops action game.",
  showcase: false,
  showcaseOrder: null,
  createdAt: "2026-08-26T00:00:00Z",
  updatedAt: "2026-08-26T00:00:00Z",
};

function renderDetail(overrides: Partial<React.ComponentProps<typeof GameCollectionDetail>> = {}) {
  const callbacks = {
    onEdit: vi.fn(),
    onToggleShowcase: vi.fn(),
    onDelete: vi.fn(),
    onRefreshProvider: vi.fn(),
    onChangeArtwork: vi.fn(),
  };
  render(
    <GameCollectionDetail
      collection={collection}
      coverUrl="cover.jpg"
      heroUrl="hero.jpg"
      providerConnected
      providerBusy={false}
      providerError={null}
      {...callbacks}
      {...overrides}
    />,
  );
  return callbacks;
}

describe("GameCollectionDetail", () => {
  it("uses hero artwork as the dominant labelled surface", () => {
    renderDetail();

    const hero = screen.getByRole("region", { name: "게임 대표 아트워크" });
    expect(hero).toHaveClass("game-collection-detail__hero");
    expect(screen.getByRole("img", { name: "Astral Chain 대표 아트워크" })).toHaveAttribute("src", "hero.jpg");
    expect(screen.getByRole("heading", { name: "Astral Chain" })).toBeInTheDocument();
  });

  it("falls back to a neutral hero without using the cover as hero artwork", () => {
    renderDetail({ heroUrl: null });

    const hero = screen.getByRole("region", { name: "게임 대표 아트워크" });
    expect(hero).toHaveClass("game-collection-detail__hero--empty");
    expect(screen.queryByRole("img", { name: "Astral Chain 대표 아트워크" })).not.toBeInTheDocument();
    expect(hero.style.backgroundImage).not.toContain("cover.jpg");
    expect(screen.getByRole("img", { name: "Astral Chain 표지" })).toHaveAttribute("src", "cover.jpg");
  });

  it("renders only present game metadata", () => {
    renderDetail({
      collection: {
        ...collection,
        publisher: null,
        platforms: null,
        genres: null,
        myScore: null,
        overview: null,
      },
    });

    expect(screen.getByText("PlatinumGames")).toBeInTheDocument();
    expect(screen.queryByText("Nintendo")).not.toBeInTheDocument();
    expect(screen.queryByText("Nintendo Switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Action, Adventure")).not.toBeInTheDocument();
    expect(screen.queryByText("4.5/5")).not.toBeInTheDocument();
    expect(screen.queryByText("A special ops action game.")).not.toBeInTheDocument();
  });

  it("is a native package button with keyboard lift toggling", async () => {
    const user = userEvent.setup();
    renderDetail();

    const packageButton = screen.getByRole("button", { name: "게임 패키지 들어 올리기" });
    expect(packageButton.tagName).toBe("BUTTON");
    expect(packageButton).toHaveAttribute("aria-pressed", "false");
    await user.tab();
    expect(packageButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(packageButton).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(packageButton).toHaveAttribute("aria-pressed", "false");
  });

  it("exposes management actions and invokes each callback", async () => {
    const user = userEvent.setup();
    const callbacks = renderDetail();

    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    expect(screen.getByRole("menuitem", { name: "편집" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "쇼케이스에 추가" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "삭제" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "IGDB 연결됨" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "IGDB 새로고침" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "표지·hero 변경" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "편집" }));
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await user.click(screen.getByRole("menuitem", { name: "쇼케이스에 추가" }));
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await user.click(screen.getByRole("menuitem", { name: "IGDB 새로고침" }));
    await user.click(screen.getByRole("button", { name: "작품 관리" }));
    await user.click(screen.getByRole("menuitem", { name: "표지·hero 변경" }));

    expect(callbacks.onEdit).toHaveBeenCalledOnce();
    expect(callbacks.onToggleShowcase).toHaveBeenCalledOnce();
    expect(callbacks.onDelete).toHaveBeenCalledOnce();
    expect(callbacks.onRefreshProvider).toHaveBeenCalledOnce();
    expect(callbacks.onChangeArtwork).toHaveBeenCalledOnce();
  });

  it("keeps provider errors secondary to local metadata", () => {
    renderDetail({ providerError: "IGDB를 사용할 수 없습니다." });

    expect(screen.getByRole("alert")).toHaveTextContent("IGDB를 사용할 수 없습니다.");
    expect(screen.getByRole("heading", { name: "Astral Chain" })).toBeInTheDocument();
    expect(screen.getByText("PlatinumGames")).toBeInTheDocument();
  });
});
