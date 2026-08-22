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
    director: null,
    externalScore: 91,
    myScore: null,
    genres: "Fantasy",
    overview: "Imported overview",
    showcase: false,
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
  });
});
