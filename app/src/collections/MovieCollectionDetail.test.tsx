import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSummary } from "../library/types";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { MovieCollectionDetail } from "./MovieCollectionDetail";

afterEach(cleanup);

const movie: CollectionSummary = {
  id: "movie-1",
  name: "퍼펙트 블루",
  description: null,
  type: "movie",
  coverAssetId: null,
  selectedWorkArtworkId: "poster-1",
  selectedHeroArtworkId: null,
  selectedBackdropArtworkId: "backdrop-1",
  assetCount: 0,
  unreadReleaseCount: 0,
  year: 1997,
  originalTitle: "Perfect Blue",
  runtimeMinutes: 81,
  author: null,
  developer: null,
  publisher: null,
  platforms: null,
  productionCompany: "매드하우스",
  releaseDate: "1997-07-12",
  director: "곤 사토시",
  externalScore: 84,
  myScore: 4.5,
  genres: "애니메이션 · 스릴러",
  overview: "현실과 환상의 경계가 무너진다.",
  showcase: false,
  showcaseOrder: null,
  createdAt: "t",
  updatedAt: "t",
};

function renderDetail(overrides: Partial<React.ComponentProps<typeof MovieCollectionDetail>> = {}, privacyMode = false) {
  const props: React.ComponentProps<typeof MovieCollectionDetail> = {
    collection: movie,
    posterUrl: "poster-url",
    backdropUrl: "backdrop-url",
    providerConnected: true,
    providerBusy: false,
    providerError: null,
    onEdit: vi.fn(),
    onToggleShowcase: vi.fn(),
    onDelete: vi.fn(),
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    onChangeArtwork: vi.fn(),
    ...overrides,
  };
  render(
    <PrivacyProvider privacyMode={privacyMode} setPrivacyMode={vi.fn()}>
      <MovieCollectionDetail {...props} />
    </PrivacyProvider>,
  );
  return props;
}

it("renders a backdrop-led flat-poster movie detail with available metadata", () => {
  renderDetail();

  expect(screen.getByRole("region", { name: "영화 배경 이미지" })).toHaveStyle({ backgroundImage: 'url("backdrop-url")' });
  expect(screen.getByRole("img", { name: "퍼펙트 블루 포스터" })).toHaveAttribute("src", "poster-url");
  expect(screen.getByRole("heading", { name: "퍼펙트 블루", level: 1 })).toBeInTheDocument();
  for (const value of ["Perfect Blue", "TMDB 84", "내 평점 4.5", "현실과 환상의 경계가 무너진다."]) {
    expect(screen.getByText(value)).toBeVisible();
  }
  expect(document.querySelector(".movie-collection-detail__facts")).toHaveTextContent("1997-07-12 · 81분 · 곤 사토시 · 매드하우스 · 애니메이션 · 스릴러");
});

it("drops the backdrop image, poster, and skeleton in privacy mode", () => {
  renderDetail({}, true);

  const backdrop = screen.getByRole("region", { name: "영화 배경 이미지" });
  expect(backdrop).not.toHaveStyle({ backgroundImage: 'url("backdrop-url")' });
  expect(backdrop).toHaveClass("movie-collection-detail__backdrop--empty");
  expect(screen.queryByRole("img", { name: "퍼펙트 블루 포스터" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "퍼펙트 블루", level: 1 })).toBeInTheDocument();
});

it("uses a neutral backdrop and exposes only valid provider actions", async () => {
  const user = userEvent.setup();
  const disconnected = renderDetail({ backdropUrl: null, providerConnected: false });

  const backdrop = screen.getByRole("region", { name: "영화 배경 이미지" });
  expect(backdrop).not.toHaveStyle({ backgroundImage: 'url("poster-url")' });
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  expect(screen.getByRole("menuitem", { name: "TMDB에 연결" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "TMDB 새로고침" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "포스터·배경 변경" })).toBeDisabled();
  expect(disconnected.onConnectProvider).not.toHaveBeenCalled();

  cleanup();
  renderDetail();
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  expect(screen.queryByRole("menuitem", { name: "TMDB에 연결" })).not.toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "TMDB 새로고침" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "포스터·배경 변경" })).toBeEnabled();
});
