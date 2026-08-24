import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionSummary, CreateCollection, UpdateCollection } from "../library/types";
import { CollectionEditDialog } from "./CollectionEditDialog";

afterEach(cleanup);

it("submits only fields owned by ordinary collection editing", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn(async (_input: CreateCollection | UpdateCollection) => undefined);
  const collection: CollectionSummary = {
    id: "work-1",
    name: "Provider title",
    description: "description",
    type: "manga",
    coverAssetId: null,
    selectedWorkArtworkId: null,
    assetCount: 0,
    unreadReleaseCount: 0,
    year: 2024,
    author: "Imported Author",
    developer: null,
    productionCompany: null,
    releaseDate: null,
    director: null,
    externalScore: 91,
    myScore: null,
    genres: "Fantasy",
    overview: "Imported overview",
    showcase: false,
    showcaseOrder: null,
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
  };

  render(
    <CollectionEditDialog
      open
      mode={{ kind: "edit", collection }}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );

  const name = screen.getByRole("textbox", { name: "이름" });
  await user.clear(name);
  await user.type(name, "Renamed Work");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(onSubmit).toHaveBeenCalledWith({
    name: "Renamed Work",
    description: "description",
    type: "manga",
    year: 2024,
    author: "Imported Author",
    director: null,
    externalScore: 91,
    myScore: null,
    developer: null,
    productionCompany: null,
    releaseDate: null,
  });
});

it("submits game developer and a half-star personal rating", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<CollectionEditDialog open mode={{ kind: "edit", collection: { ...collectionFixture, type: "game", developer: "PlatinumGames", myScore: 4.5 } }} onClose={vi.fn()} onSubmit={onSubmit} />);

  await user.selectOptions(screen.getByLabelText("내 별점"), "5");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ developer: "PlatinumGames", productionCompany: null, releaseDate: null, myScore: 5 }));
});

it("shows movie production company separately from director", () => {
  render(<CollectionEditDialog open mode={{ kind: "edit", collection: { ...collectionFixture, type: "movie", director: "Director", productionCompany: "Studio" } }} onClose={vi.fn()} onSubmit={vi.fn()} />);

  expect(screen.getByLabelText("제작사")).toHaveValue("Studio");
  expect(screen.getByLabelText("감독")).toHaveValue("Director");
});

it("submits a half-star personal rating for manga", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<CollectionEditDialog open mode={{ kind: "edit", collection: collectionFixture }} onClose={vi.fn()} onSubmit={onSubmit} />);

  await user.selectOptions(screen.getByLabelText("내 별점"), "4.5");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ myScore: 4.5 }));
});

it("submits a half-star personal rating for movie", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<CollectionEditDialog open mode={{ kind: "edit", collection: { ...collectionFixture, type: "movie" } }} onClose={vi.fn()} onSubmit={onSubmit} />);

  await user.selectOptions(screen.getByLabelText("내 별점"), "3.5");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ myScore: 3.5 }));
});

it("does not show rating or developer controls while creating a game", async () => {
  const user = userEvent.setup();
  render(<CollectionEditDialog open mode={{ kind: "create" }} onClose={vi.fn()} onSubmit={vi.fn()} />);

  await user.selectOptions(screen.getByLabelText("유형"), "game");

  expect(screen.queryByLabelText("내 별점")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("개발사")).not.toBeInTheDocument();
});

it("does not show rating or production company controls while creating a movie", async () => {
  const user = userEvent.setup();
  render(<CollectionEditDialog open mode={{ kind: "create" }} onClose={vi.fn()} onSubmit={vi.fn()} />);

  await user.selectOptions(screen.getByLabelText("유형"), "movie");

  expect(screen.queryByLabelText("내 별점")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("제작사")).not.toBeInTheDocument();
});

const collectionFixture: CollectionSummary = {
  id: "work-1",
  name: "Provider title",
  description: "description",
  type: "manga",
  coverAssetId: null,
  selectedWorkArtworkId: null,
  assetCount: 0,
  unreadReleaseCount: 0,
  year: 2024,
  author: "Imported Author",
  developer: null,
  productionCompany: null,
  releaseDate: null,
  director: null,
  externalScore: 91,
  myScore: null,
  genres: "Fantasy",
  overview: "Imported overview",
  showcase: false,
  showcaseOrder: null,
  createdAt: "2026-08-20T00:00:00Z",
  updatedAt: "2026-08-20T00:00:00Z",
};
