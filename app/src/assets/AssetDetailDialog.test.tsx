import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type {
  AssetSummary,
  ClassificationEntry,
  LibraryGateway,
} from "../library/types";
import { AssetDetailDialog } from "./AssetGallery";

const asset: AssetSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "아로나",
  originalName: "arona.png",
  relativePath: "assets/arona.png",
  thumbnailRelativePath: "thumbnails/arona.webp",
  byteSize: 1,
  width: 400,
  height: 300,
  collectedAt: "2026-07-30T00:00:00Z",
  favorite: false,
};
const classifications: ClassificationEntry[] = [
  { id: "tag-arona", kind: "tag", name: "아로나", parentId: "work" },
  { id: "tag-clean", kind: "tag", name: "건전", parentId: "work" },
];

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    },
  });
});
afterEach(cleanup);

it("saves two direct classifications for one asset", async () => {
  const user = userEvent.setup();
  const libraryGateway = gateway();

  render(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={asset}
        classifications={classifications}
        onClose={vi.fn()}
      />
    </LibraryProvider>,
  );

  await waitFor(() =>
    expect(libraryGateway.getAssetClassifications).toHaveBeenCalledWith(asset.id),
  );
  expect(screen.getByRole("img", { name: "아로나" })).toHaveAttribute(
    "src",
    "http://lakomics.localhost/asset/00000000-0000-4000-8000-000000000001",
  );
  await user.click(screen.getByRole("checkbox", { name: "아로나" }));
  await user.click(screen.getByRole("checkbox", { name: "건전" }));
  await user.click(screen.getByRole("button", { name: "분류 저장" }));

  await waitFor(() =>
    expect(libraryGateway.setAssetClassifications).toHaveBeenCalledWith(asset.id, [
      "tag-arona",
      "tag-clean",
    ]),
  );
  expect(libraryGateway.setAssetClassifications).toHaveBeenCalledTimes(1);
});

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    deleteClassification: vi.fn(),
    listAssets: vi.fn(),
    setAssetClassifications: vi.fn().mockResolvedValue(undefined),
    getAssetClassifications: vi.fn().mockResolvedValue([]),
    ingestImage: vi.fn(),
  };
}
