import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSummary, TmdbFilmData } from "../library/types";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { MovieCollectionDetail } from "./MovieCollectionDetail";
import { WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { CollectionInfoPanel } from "./CollectionInfoPanel";

afterEach(() => { cleanup(); vi.useRealTimers(); });

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

  expect(screen.getByRole("region", { name: "영화 배경 이미지" }).querySelector(".movie-collection-detail__backdrop-art")).toHaveAttribute("src", "backdrop-url");
  expect(screen.getByRole("img", { name: "퍼펙트 블루 포스터" })).toHaveAttribute("src", "poster-url");
  expect(screen.getByRole("heading", { name: "퍼펙트 블루", level: 1 })).toBeInTheDocument();
  for (const value of ["Perfect Blue", "TMDB 84", "내 평점 4.5", "현실과 환상의 경계가 무너진다."]) {
    expect(screen.getByText(value)).toBeVisible();
  }
  expect(document.querySelector(".movie-collection-detail__facts")).toHaveTextContent("1997.07.12 · 81분 · 곤 사토시 · 매드하우스 · 애니메이션 · 스릴러");
});

it("formats release and air dates and translates stored TV genres in detail and info", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 23));
  const collection = { ...movie, releaseDate: "2026-09-19", genres: "Action & Adventure · 애니메이션" };
  renderDetail({ collection, series: { status: "Ended", lastAirDate: "2025-12-31", seasons: [], cast: [] } });
  expect(document.querySelector(".movie-collection-detail__facts")).toHaveTextContent("최근 방영 2025.12.31 · 09.19");
  expect(document.querySelector(".movie-collection-detail__facts")).toHaveTextContent("액션 & 모험 · 애니메이션");
  cleanup();
  render(<CollectionInfoPanel collection={collection} />);
  expect(screen.getByText("09.19")).toBeInTheDocument();
  expect(screen.getByText("액션 & 모험 · 애니메이션")).toBeInTheDocument();
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
  expect(screen.getByRole("menuitem", { name: "TMDB 연결 작품 변경" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "TMDB 새로고침" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "포스터·배경 변경" })).toBeEnabled();
});

const film: TmdbFilmData = {
  cast: Array.from({ length: 10 }, (_, index) => ({ name: `배우 ${index + 1}`, character: `배역 ${index + 1}` })),
  releases: [
    { country: "KR", releaseType: 3, date: "2020-02-01", certification: "15" },
    { country: "JP", releaseType: 1, date: "2019-10-01", certification: "" },
    { country: "KR", releaseType: 4, date: "2020-04-01", certification: "15" },
    { country: "US", releaseType: 2, date: "2020-03-01", certification: "PG-13" },
  ],
  related: {
    collectionName: "영화 시리즈",
    parts: [
      { movieId: 2, title: "외부 작품", releaseDate: "2010-01-01", posterPath: "/external.jpg" },
      { movieId: 3, title: "보유 작품", releaseDate: "2020-01-01", posterPath: "/local.jpg", localCollectionId: "local-3" },
    ],
  },
};

it("shows eight cast members and Korean plus earliest releases with disclosure", async () => {
  renderDetail({ film });
  const cast = screen.getByRole("region", { name: "출연" });
  expect(within(cast).getAllByRole("listitem")).toHaveLength(8);
  expect(cast).toHaveTextContent("배우 1 (배역 1)");
  expect(cast).not.toHaveTextContent("배우 9");
  const releases = screen.getByRole("region", { name: "개봉 정보" });
  expect(within(releases).getAllByRole("listitem")).toHaveLength(3);
  expect(releases).toHaveTextContent("2019.10.01일본프리미어");
  expect(releases).toHaveTextContent("2020.02.01한국극장 개봉15");
  expect(releases).toHaveTextContent("디지털");
  expect(releases).not.toHaveTextContent("미국");
  const user = userEvent.setup();
  await user.click(within(releases).getByRole("button", { name: "전체 보기", expanded: false }));
  expect(within(releases).getAllByRole("listitem")).toHaveLength(4);
  expect(releases).toHaveTextContent("2020.03.01미국제한 개봉PG-13");
  await user.click(within(releases).getByRole("button", { name: "접기", expanded: true }));
  expect(releases).not.toHaveTextContent("미국");
});

it("opens a local related work and keeps external ones inert", async () => {
  const onOpenCollection = vi.fn();
  renderDetail({ film, onOpenCollection });
  const rail = screen.getByRole("list", { name: "관련 작품 목록" });
  const buttons = within(rail).getAllByRole("button");
  expect(buttons).toHaveLength(1);
  await userEvent.setup().click(buttons[0]);
  expect(onOpenCollection).toHaveBeenCalledWith(film.related!.parts.find(part => part.localCollectionId)!.localCollectionId);
});

it("puts local related works first with a library badge and no navigation without a handler", () => {
  renderDetail({ film });
  const rail = screen.getByRole("list", { name: "관련 작품 목록" });
  const items = within(rail).getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("보유 작품2020라이브러리");
  expect(items[1]).toHaveTextContent("외부 작품2010");
  expect(items[1]).toHaveClass("movie-collection-detail__related-part--external");
  expect(within(rail).queryByRole("button")).not.toBeInTheDocument();
  expect(within(rail).queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText("영화 시리즈")).toBeVisible();
  expect(items[0].querySelector("img")).toHaveAttribute("src", "http://lakomics.localhost/tmdb-image-preview/poster/%2Flocal.jpg");
});

it("prioritizes personal rating in both detail and sidebar information", () => {
  renderDetail();
  const scores = document.querySelector(".movie-collection-detail__scores")!;
  expect(scores.children[0]).toHaveTextContent("내 평점 4.5");
  expect(scores.children[0].tagName).toBe("STRONG");
  expect(scores.children[1]).toHaveTextContent("TMDB 84");
  cleanup();
  render(<CollectionInfoPanel collection={movie} compact />);
  const labels = Array.from(document.querySelectorAll("dt"), node => node.textContent);
  expect(labels.indexOf("내 평점")).toBeLessThan(labels.indexOf("TMDB 평점"));
});

it("hides Film sections without data and does not show Film data for TV", () => {
  for (const overrides of [{}, { film: { cast: [], releases: [], related: null } }, {
    film, series: { status: null, lastAirDate: null, seasons: [], cast: [] },
  }]) {
    renderDetail(overrides);
    for (const name of ["출연", "개봉 정보", "관련 작품"]) {
      expect(screen.queryByRole("region", { name })).not.toBeInTheDocument();
    }
    cleanup();
  }
});

it("keeps text but hides related posters in privacy mode", () => {
  renderDetail({ film }, true);
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(screen.getByText("보유 작품")).toBeVisible();
  expect(screen.getByRole("region", { name: "출연" })).toBeVisible();
});

it("keeps Film sections in the body when the workspace sidebar is enabled", () => {
  const props = renderDetail({ film });
  cleanup();
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}>
    <WorkspaceChromeProvider scope="collection">
      <MovieCollectionDetail {...props} />
    </WorkspaceChromeProvider>
  </PrivacyProvider>);
  const article = screen.getByRole("article", { name: "영화 상세" });
  for (const name of ["출연", "개봉 정보", "관련 작품"]) {
    expect(within(article).getByRole("region", { name })).toBeVisible();
  }
});
