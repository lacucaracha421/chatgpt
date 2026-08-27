import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionCoverGrid } from "./CollectionCoverGrid";

afterEach(cleanup);

describe("CollectionCoverGrid", () => {
  it("uses asynchronously decoded thumbnails for cover tiles", () => {
    render(
      <CollectionCoverGrid
        collectionId="collection/one"
        covers={[{ fileName: "vol 1.png", shelf: 1, volumeLabel: "vol.1" }]}
        selectedFileName={null}
        shelfFilter={null}
        onShelfFilterChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("img", { name: "vol.1" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/collection-cover-thumbnail/collection%2Fone/vol%201.png",
    );
    expect(screen.getByRole("img", { name: "vol.1" })).toHaveAttribute("decoding", "async");
  });
});
