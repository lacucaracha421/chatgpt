// Raster lifecycle is covered separately; jsdom has no canvas/WebGL implementation.
vi.mock("./physical/collectibleRuntime", async (importOriginal) => ({
  ...await importOriginal<typeof import("./physical/collectibleRuntime")>(),
  acquireCover: (_request: unknown, listener: (value: null) => void) => { listener(null); return () => undefined; },
  attachLiveBook: (_host: unknown, _request: unknown, onReady: (value: boolean) => void) => { onReady(false); return { tilt: () => undefined, refresh: () => undefined, dispose: () => undefined }; },
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "../library/types";
import { CollectionCard } from "./CollectionCard";
import { coverSourceUrl } from "./physical/collectibleRuntime";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 23)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

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
  it.each(["game", "manga", "movie"] as const)("shows the %s year and my rating on the meta line after the credit", (type) => {
    const view = render(<CollectionCard collection={{ ...sample, type, releaseDate: "2026-10-01", year: null, myScore: 4.5 }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    const line = document.querySelector(".collection-card__line")!;
    expect(document.querySelector(".collection-card__credit")!.nextElementSibling).toBe(line);
    expect(line).toHaveTextContent("4.52026");
    expect(screen.getByLabelText("내 별점 4.5점")).toBeInTheDocument();
    view.rerender(<CollectionCard collection={{ ...sample, type, releaseDate: null, year: 2019, myScore: null }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(line).toHaveTextContent(/^2019$/);
    expect(screen.queryByLabelText(/내 별점/)).not.toBeInTheDocument();
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
    expect(screen.getByText("2019")).toHaveClass("collection-card__date");
    expect(screen.queryByText("87")).not.toBeInTheDocument();
    // My rating is on the line; the external score is not.
    expect(screen.getByLabelText("내 별점 5.0점")).toHaveTextContent("5.0");
    expect(screen.getByText("Sample")).not.toHaveAttribute("title");
    expect(screen.getByText("Developer")).not.toHaveAttribute("title");
  });

  it("shows release notices as a marker after the stars instead of a cover badge", () => {
    const { rerender } = render(<CollectionCard collection={{ ...sample, unreadReleaseCount: 0 }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText(/신간/)).not.toBeInTheDocument();
    rerender(<CollectionCard collection={{ ...sample, unreadReleaseCount: 2 }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("신간 알림 2")).toHaveClass("collection-card__release--new");
    expect(document.querySelector(".collection-card__cover")).not.toHaveTextContent(/신간/);
    // The year and the stars stay beside the marker.
    expect(document.querySelector(".collection-card__line")).toHaveTextContent("5.0·신간 알림 22019");
    rerender(<CollectionCard collection={{ ...sample, unreadReleaseCount: 0 }} releaseCaption={{ kind: "ahead", text: "9권 예약", date: "11.20" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("9권 예약")).toHaveClass("collection-card__release--ahead");
    expect(screen.getByText("· 11.20")).toHaveClass("collection-card__release-date");
    rerender(<CollectionCard collection={{ ...sample, unreadReleaseCount: 0 }} releaseCaption={{ kind: "out", text: "신간 3권", date: "9.16" }} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText("신간 3권")).toHaveClass("collection-card__release--out");
    // A Showcase row keeps only the marker.
    rerender(<CollectionCard collection={{ ...sample, unreadReleaseCount: 1 }} meta={false} coverUrl={null} selected={false} onClick={vi.fn()} />);
    expect(document.querySelector(".collection-card__line")).toHaveTextContent(/^신간 알림 1$/);
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
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("src", coverSourceUrl({ src: "cover.jpg", scope: "", revision: sample.updatedAt }));
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
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("src", coverSourceUrl({ src: "working.jpg", scope: "", revision: sample.updatedAt }));
    expect(screen.getByRole("img", { name: "Sample" })).toHaveAttribute("decoding", "async");
  });
});
