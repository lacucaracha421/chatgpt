import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type {
  AssetPage,
  AssetSummary,
  ClassificationEntry,
  LibraryGateway,
} from "../library/types";
import { AssetBrowser, AssetGallery } from "./AssetGallery";

const classifications: ClassificationEntry[] = [
  { id: "root", kind: "root", name: "게임", parentId: null },
  { id: "other", kind: "root", name: "만화", parentId: null },
];

describe("AssetGallery", () => {
  beforeEach(() => {
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get: () => 900 },
      offsetHeight: { configurable: true, get: () => 600 },
    });
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

  it("renders fewer than one hundred images for five hundred assets", async () => {
    const items = Array.from({ length: 500 }, (_, index) => asset(index));

    render(
      <LibraryProvider gateway={gateway()}>
        <AssetGallery
          items={items}
          classifications={classifications}
          directOnly={false}
          onDirectOnlyChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("img").length).toBeLessThan(100);
  });

  it("restarts at the first page when direct-only or classification changes", async () => {
    const user = userEvent.setup();
    const libraryGateway = gateway();

    const { rerender } = render(
      <LibraryProvider gateway={libraryGateway}>
        <AssetBrowser classificationId="root" classifications={classifications} />
      </LibraryProvider>,
    );
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledWith({
        classificationId: "root",
        directOnly: false,
        after: null,
        limit: 100,
      }),
    );

    await user.click(screen.getByRole("checkbox", { name: "이 항목만" }));
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledWith({
        classificationId: "root",
        directOnly: true,
        after: null,
        limit: 100,
      }),
    );

    rerender(
      <LibraryProvider gateway={libraryGateway}>
        <AssetBrowser classificationId="other" classifications={classifications} />
      </LibraryProvider>,
    );
    await waitFor(() =>
      expect(libraryGateway.listAssets).toHaveBeenCalledWith({
        classificationId: "other",
        directOnly: true,
        after: null,
        limit: 100,
      }),
    );
  });

  it("does not duplicate a pending next-page request", async () => {
    const first: AssetPage = {
      items: Array.from({ length: 50 }, (_, index) => asset(index)),
      nextCursor: {
        collectedAt: "2026-07-30T00:00:00Z",
        id: "asset-49",
      },
    };
    const pending = new Promise<AssetPage>(() => {});
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listAssets)
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(pending);

    render(
      <LibraryProvider gateway={libraryGateway}>
        <AssetBrowser classificationId={null} classifications={classifications} />
      </LibraryProvider>,
    );

    await waitFor(() => expect(libraryGateway.listAssets).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(libraryGateway.listAssets).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale first page after the classification changes", async () => {
    let resolveOldPage!: (page: AssetPage) => void;
    const oldPage = new Promise<AssetPage>((resolve) => {
      resolveOldPage = resolve;
    });
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.listAssets)
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce({ items: [asset(1)], nextCursor: null });

    const { rerender } = render(
      <LibraryProvider gateway={libraryGateway}>
        <AssetBrowser classificationId="root" classifications={classifications} />
      </LibraryProvider>,
    );
    rerender(
      <LibraryProvider gateway={libraryGateway}>
        <AssetBrowser classificationId="other" classifications={classifications} />
      </LibraryProvider>,
    );
    expect(
      await screen.findByRole("img", { name: "asset-1.png" }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveOldPage({ items: [asset(0)], nextCursor: null });
      await oldPage;
    });

    expect(
      screen.queryByRole("img", { name: "asset-0.png" }),
    ).not.toBeInTheDocument();
  });

  it("closes stale asset details when the visible items are replaced", async () => {
    const user = userEvent.setup();
    const libraryGateway = gateway();
    const { rerender } = render(
      <LibraryProvider gateway={libraryGateway}>
        <AssetGallery
          items={[asset(0)]}
          classifications={classifications}
          directOnly={false}
          onDirectOnlyChange={vi.fn()}
        />
      </LibraryProvider>,
    );
    await user.click(
      await screen.findByRole("button", {
        name: "asset-0.png 자세히 보기",
      }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <LibraryProvider gateway={libraryGateway}>
        <AssetGallery
          items={[]}
          classifications={classifications}
          directOnly={false}
          onDirectOnlyChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

function asset(index: number): AssetSummary {
  return {
    id: `asset-${index}`,
    title: null,
    originalName: `asset-${index}.png`,
    relativePath: `assets/asset-${index}.png`,
    thumbnailRelativePath: `thumbnails/asset-${index}.webp`,
    byteSize: 1,
    width: 200,
    height: 200,
    collectedAt: "2026-07-30T00:00:00Z",
    favorite: false,
  };
}

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    deleteClassification: vi.fn(),
    listAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn().mockResolvedValue([]),
    ingestImage: vi.fn(),
  };
}
