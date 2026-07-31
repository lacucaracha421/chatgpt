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
const otherAsset: AssetSummary = {
  ...asset,
  id: "00000000-0000-4000-8000-000000000002",
  title: "호시노",
  originalName: "hoshino.png",
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

it("keeps save disabled when direct classifications fail to load", async () => {
  const user = userEvent.setup();
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.getAssetClassifications).mockRejectedValue({
    code: "database_failed",
    message: "분류를 불러오지 못했습니다.",
  });

  render(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={asset}
        classifications={classifications}
        onClose={vi.fn()}
      />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("status")).toHaveTextContent(
    "분류를 불러오지 못했습니다.",
  );
  const save = screen.getByRole("button", { name: "분류 저장" });
  expect(save).toBeDisabled();
  await user.click(save);
  expect(libraryGateway.setAssetClassifications).not.toHaveBeenCalled();
});

it("ignores load completion from the previously open asset", async () => {
  let resolveFirst!: (ids: string[]) => void;
  const firstLoad = new Promise<string[]>((resolve) => {
    resolveFirst = resolve;
  });
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.getAssetClassifications).mockImplementation((id) =>
    id === asset.id ? firstLoad : Promise.resolve(["tag-clean"]),
  );

  const { rerender } = render(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={asset}
        classifications={classifications}
        onClose={vi.fn()}
      />
    </LibraryProvider>,
  );
  rerender(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={otherAsset}
        classifications={classifications}
        onClose={vi.fn()}
      />
    </LibraryProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "건전" })).toBeChecked(),
  );

  resolveFirst(["tag-arona"]);
  await firstLoad;

  expect(screen.getByRole("checkbox", { name: "건전" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "아로나" })).not.toBeChecked();
});

it("does not let an earlier save close the newly open asset", async () => {
  let resolveSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const onClose = vi.fn();
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.getAssetClassifications).mockResolvedValue([]);
  vi.mocked(libraryGateway.setAssetClassifications).mockReturnValue(pendingSave);
  const user = userEvent.setup();

  const { rerender } = render(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={asset}
        classifications={classifications}
        onClose={onClose}
      />
    </LibraryProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "분류 저장" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "분류 저장" }));

  rerender(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={otherAsset}
        classifications={classifications}
        onClose={onClose}
      />
    </LibraryProvider>,
  );
  expect(await screen.findByRole("heading", { name: "호시노" })).toBeInTheDocument();

  resolveSave();
  await pendingSave;

  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "호시노" })).toBeInTheDocument();
});

it("can close during save without closing again when the save completes", async () => {
  let resolveSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const onClose = vi.fn();
  const libraryGateway = gateway();
  vi.mocked(libraryGateway.setAssetClassifications).mockReturnValue(pendingSave);
  const user = userEvent.setup();

  render(
    <LibraryProvider gateway={libraryGateway}>
      <AssetDetailDialog
        asset={asset}
        classifications={classifications}
        onClose={onClose}
      />
    </LibraryProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "분류 저장" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "분류 저장" }));
  await user.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalledTimes(1);

  resolveSave();
  await pendingSave;

  expect(onClose).toHaveBeenCalledTimes(1);
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
