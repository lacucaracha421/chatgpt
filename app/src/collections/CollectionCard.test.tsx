// Raster lifecycle is covered separately; jsdom has no canvas/WebGL implementation.
vi.mock("./physical/collectibleRuntime", () => ({
  coverKey: (request: unknown) => JSON.stringify(request),
  acquireCover: (_request: unknown, listener: (value: null) => void) => { listener(null); return () => undefined; },
  attachLiveBook: (_host: unknown, _request: unknown, onReady: (value: boolean) => void) => { onReady(false); return { tilt: () => undefined, refresh: () => undefined, dispose: () => undefined }; },
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "../library/types";
import { CollectionCard } from "./CollectionCard";

afterEach(cleanup);

const sample: CollectionSummary = {
  id: "c1",
  name: "Sample",
  description: null,
  type: "game",
  coverAssetId: null,
  selectedWorkArtworkId: null,
  selectedHeroArtworkId: null,
  selectedBackdropArtworkId: null,
  assetCount: 3,
  unreadReleaseCount: 0,
  year: 2019,
  originalTitle: null,
  runtimeMinutes: null,
  author: "Wrong",
  developer: "Developer",
  publisher: null,
  platforms: null,
  productionCompany: "Wrong",
  releaseDate: null,
  director: null,
  externalScore: 87,
  myScore: 5,
  genres: null,
  overview: null,
  showcase: false,
  showcaseOrder: null,
  createdAt: "t",
  updatedAt: "t",
};

it("shows series season premiere range and a single date for one season", () => {
  const props = { coverUrl: null, onClick: vi.fn(), selected: false };
  const { rerender } = render(<CollectionCard {...props} collection={{ ...sample, type: "movie", seasonDateRange: ["2016-01-14", "2024-05-05"] }} />);
  expect(screen.getByText("16.1.14~24.5.5")).toBeInTheDocument();
  rerender(<CollectionCard {...props} collection={{ ...sample, type: "movie", seasonDateRange: ["2016-01-14", "2016-01-14"] }} />);
  expect(screen.getByText("16.1.14")).toBeInTheDocument();
});

describe("CollectionCard", () => {
  it("shows a compact movie release date on a separate line after the studio", () => {
    render(<CollectionCard collection={{ ...sample, type: "movie", productionCompany: "MAPPA", releaseDate: "2026-10-01" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    const date = screen.getByText("26.10.1");
    expect(date).toHaveAttribute("datetime", "2026-10-01");
    expect(screen.getByText("MAPPA").nextElementSibling).toBe(date);
  });
  it.each(["game", "manga"] as const)("shows the %s release date or the known year", (type) => {
    const view = render(<CollectionCard collection={{ ...sample, type, releaseDate: "2026-10-01" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("26.10.1")).toHaveAttribute("datetime", "2026-10-01");
    view.rerender(<CollectionCard collection={{ ...sample, type, releaseDate: null, year: 2019 }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("2019")).toHaveAttribute("datetime", "2019");
  });
  it.each([
    ["manga", { author: "Kui Ryoko", developer: "Wrong", productionCompany: "Wrong" }, "Kui Ryoko"],
    ["game", { author: "Wrong", developer: "PlatinumGames", productionCompany: "Wrong" }, "PlatinumGames"],
    ["movie", { author: "Wrong", developer: "Wrong", productionCompany: "Warner Bros." }, "Warner Bros."],
  ])("shows only the %s credit role", (type, credits, expected) => {
    const collection = { ...sample, ...credits, type } as CollectionSummary;
    render(<CollectionCard collection={collection} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText(expected)).toHaveClass("collection-card__credit");
    expect(screen.queryByText("Wrong")).not.toBeInTheDocument();
  });

  it("keeps a reserved empty credit line when the selected role is missing", () => {
    const collection = { ...sample, type: "manga" as const, author: "", developer: "Developer" };
    render(<CollectionCard collection={collection} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("Sample")).toBeInTheDocument();
    expect(document.querySelector(".collection-card__credit")).toHaveTextContent("");
    expect(screen.queryByText("Developer")).not.toBeInTheDocument();
  });

  it("keeps the card metadata sparse", () => {
    render(<CollectionCard collection={sample} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText("게임")).not.toBeInTheDocument();
    expect(screen.queryByText("3개")).not.toBeInTheDocument();
    expect(screen.getByText("2019")).toHaveAttribute("datetime", "2019");
    expect(screen.queryByText("87")).not.toBeInTheDocument();
    expect(screen.queryByText("5")).not.toBeInTheDocument();
    expect(screen.getByText("Sample")).toHaveAttribute("title", "Sample");
    expect(screen.getByText("Developer")).toHaveAttribute("title", "Developer");
  });

  it("renders release badges only for positive unread counts", () => {
    const { rerender } = render(<CollectionCard collection={{ ...sample, unreadReleaseCount: 0 }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText("신간 0")).not.toBeInTheDocument();
    rerender(<CollectionCard collection={{ ...sample, unreadReleaseCount: 2 }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("신간 2")).toBeInTheDocument();
  });

  it("uses a game package shell while manga and movie stay flat", () => {
    const { rerender } = render(<CollectionCard collection={{ ...sample, type: "game" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(document.querySelector(".collection-card__object--game")).toBeInTheDocument();
    rerender(<CollectionCard collection={{ ...sample, type: "manga" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(document.querySelector(".collection-card__package")).not.toBeInTheDocument();
    rerender(<CollectionCard collection={{ ...sample, type: "movie" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(document.querySelector(".collection-card__package")).not.toBeInTheDocument();
  });

  it("keeps click and cover alt behavior", () => {
    const onClick = vi.fn();
    render(<CollectionCard collection={sample} coverUrl="cover.jpg" selected={true} onClick={onClick} />);
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("src", "cover.jpg");
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("decoding", "async");
    expect(screen.getByRole("button")).toHaveAttribute("aria-selected", "true");
    screen.getByRole("button").click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("replaces a failed cover with the placeholder and retries a changed URL", () => {
    const view = render(
      <CollectionCard collection={sample} coverUrl="broken.jpg" selected={false} onClick={vi.fn()} />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Sample" }));
    expect(screen.queryByRole("img", { name: "Sample" })).not.toBeInTheDocument();
    expect(document.querySelector(".collection-card__placeholder")).toBeInTheDocument();

    view.rerender(
      <CollectionCard collection={sample} coverUrl="working.jpg" selected={false} onClick={vi.fn()} />,
    );
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("src", "working.jpg");
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("decoding", "async");
  });
});
