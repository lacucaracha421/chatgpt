import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import type { TmdbSeason, TmdbSeriesData } from "../library/types";
import { SeriesSeasons } from "./SeriesSeasons";

afterEach(cleanup);

function season(id: number, seasonNumber: number, count: number): TmdbSeason {
  return { id, seasonNumber, name: `시즌 ${seasonNumber}`, overview: null, airDate: null,
    posterPath: "/remote.jpg", posterArtworkId: `local-${id}`,
    episodes: Array.from({ length: count }, (_, i) => ({ id: id * 1000 + i, episodeNumber: i + 1, name: `에피소드 ${i + 1}`, overview: "줄거리", airDate: "2026-01-01", runtimeMinutes: 24 })),
  };
}
const series: TmdbSeriesData = { status: "Ended", lastAirDate: null, cast: ["출연자"], seasons: [season(1, 0, 1), season(2, 1, 52), season(3, 2, 2)] };

it("uses cached posters and bounded episode pages, resetting selection on season changes", async () => {
  const user = userEvent.setup();
  render(<SeriesSeasons series={series} />);
  expect(screen.getByRole("button", { name: "시즌 1 52개 에피소드" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByRole("listitem")).toHaveLength(50);
  expect(screen.getAllByRole("presentation")[0]).toHaveAttribute("src", "http://lakomics.localhost/work-artwork-thumbnail/local-1");
  await user.click(screen.getByRole("button", { name: "다음 에피소드" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("에피소드 51")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "시즌 2 2개 에피소드" }));
  expect(screen.getByText("에피소드 1")).toBeVisible();
  expect(screen.queryByText("에피소드 51")).not.toBeInTheDocument();
});

it("does not request poster images in privacy mode", () => {
  const { container } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><SeriesSeasons series={series} /></PrivacyProvider>);
  expect(container.querySelector("img")).toBeNull();
});

it("opens the full poster on double click and closes with Escape", async () => {
  const user = userEvent.setup();
  render(<SeriesSeasons series={series} />);
  const button = screen.getByRole("button", { name: "시즌 1 52개 에피소드" });
  await user.click(button);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.dblClick(button);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "시즌 포스터 표지" })).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/local-2");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
