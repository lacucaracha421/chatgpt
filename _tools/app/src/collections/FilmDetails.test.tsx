import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { TmdbFilmData } from "../library/types";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { FilmDetails } from "./FilmDetails";

afterEach(cleanup);
function renderDetail({ film, onOpenCollection }: { film: TmdbFilmData; onOpenCollection?: (id: string) => void }, privacyMode = false) {
  return render(<PrivacyProvider privacyMode={privacyMode} setPrivacyMode={vi.fn()}><FilmDetails film={film} onOpenCollection={onOpenCollection} /></PrivacyProvider>);
}
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
  expect(releases).toHaveTextContent("2019.10.1일본프리미어");
  expect(releases).toHaveTextContent("2020.2.1한국극장 개봉15");
  expect(releases).toHaveTextContent("디지털");
  expect(releases).not.toHaveTextContent("미국");
  const user = userEvent.setup();
  await user.click(within(releases).getByRole("button", { name: "전체 보기", expanded: false }));
  expect(within(releases).getAllByRole("listitem")).toHaveLength(4);
  expect(releases).toHaveTextContent("2020.3.1미국제한 개봉PG-13");
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
  expect(items[1]).toHaveClass("work-film-related-part--external");
  expect(within(rail).queryByRole("button")).not.toBeInTheDocument();
  expect(within(rail).queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText("영화 시리즈")).toBeVisible();
  expect(items[0].querySelector("img")).toHaveAttribute("src", "http://lakomics.localhost/tmdb-image-preview/poster/%2Flocal.jpg");
});

it("keeps text but hides related posters in privacy mode", () => {
  renderDetail({ film }, true);
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(screen.getByText("보유 작품")).toBeVisible();
  expect(screen.getByRole("region", { name: "출연" })).toBeVisible();
});

it("leaves empty film sections out and replaces a failed related poster with text", () => {
  renderDetail({ film: { cast: [], releases: [], related: null } });
  expect(screen.queryByRole("region")).toBeNull();
  cleanup(); renderDetail({ film });
  const poster = document.querySelector<HTMLImageElement>('.work-film-related-poster img')!;
  fireEvent.error(poster);
  expect(screen.getByText("포스터 없음")).toBeInTheDocument();
});
