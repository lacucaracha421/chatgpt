import { cleanup, render, screen } from "@testing-library/react";
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
  assetCount: 3,
  unreadReleaseCount: 0,
  year: 2019,
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

describe("CollectionCard", () => {
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
    expect(screen.queryByText("2019")).not.toBeInTheDocument();
    expect(screen.queryByText("87")).not.toBeInTheDocument();
    expect(screen.queryByText("5")).not.toBeInTheDocument();
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
    expect(screen.getByRole("button")).toHaveAttribute("aria-selected", "true");
    screen.getByRole("button").click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
