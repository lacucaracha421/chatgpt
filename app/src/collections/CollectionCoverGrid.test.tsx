import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionCoverGrid } from "./CollectionCoverGrid";

afterEach(cleanup);

describe("CollectionCoverGrid", () => {
  it("uses asynchronously decoded thumbnails for cover tiles", () => {
    const { container } = render(
      <CollectionCoverGrid
        collectionId="collection/one"
        covers={[{ fileName: "vol 1.png", shelf: 1, volumeLabel: "vol.1" }]}
        selectedFileName={null}
        shelfFilter={null}
        onShelfFilterChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const image = container.querySelector(".collection-overlay__cover-tile img");
    expect(image).toHaveAttribute(
      "src",
      "http://lakomics.localhost/collection-cover-thumbnail/collection%2Fone/vol%201.png",
    );
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("alt", "");
    expect(screen.getByRole("button", { name: "선반 1" })).toBeInTheDocument();
  });
});
