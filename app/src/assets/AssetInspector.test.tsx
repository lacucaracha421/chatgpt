import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AlbumEntry, AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetInspector } from "./AssetInspector";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
afterEach(() => { cleanup(); openUrl.mockClear(); });

const classifications: ClassificationEntry[] = [
  { id: "tag", kind: "tag", name: "태그", parentId: null, iconKey: null, colorKey: null },
  { id: "work", kind: "work", name: "작품", parentId: null, iconKey: null, colorKey: null },
];
const albums: AlbumEntry[] = [
  { id: "cover", name: "표지", parentId: null, iconKey: null, colorKey: null },
  { id: "reference", name: "자료", parentId: null, iconKey: null, colorKey: null },
];

it("hides the open control when there is no selection", () => {
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[]} classifications={[]} albums={[]} open={false} onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("stays collapsed by default and renders nothing while closed", () => {
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} albums={[]} open={false} onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("closes from Escape while focus is inside the inspector", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} albums={[]} open onOpenChange={onOpenChange} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  screen.getByRole("button", { name: "정보 닫기" }).focus();
  await user.keyboard("{Escape}");

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("shows one-asset metadata and opens its source URL", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} albums={[]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("a.png")).toBeVisible();
  expect(screen.getByText("example.com/source/a")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "출처 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://example.com/source/a");
});

it("checks an album that every selected asset has and toggles it off", async () => {
  const gateway = createGateway(["tag"], ["cover"]);
  const onPatchAlbum = vi.fn();
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a")]} classifications={classifications} albums={albums} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={onPatchAlbum} />
    </LibraryProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", { name: "표지 앨범" });
  expect(checkbox).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "자료 앨범" })).not.toBeChecked();

  await userEvent.click(checkbox);
  expect(onPatchAlbum).toHaveBeenCalledWith("cover", "remove");
});

it("shows indeterminate state when only some of the selection is in an album", async () => {
  const getAssetClassifications = vi.fn().mockResolvedValue(["tag"]);
  const getAssetAlbums = vi.fn().mockImplementation((assetId: string) => Promise.resolve(assetId === "a" ? ["cover"] : []));
  const gateway = { getAssetClassifications, getAssetAlbums } as unknown as LibraryGateway;
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a"), asset("b")]} classifications={classifications} albums={albums} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", { name: "표지 앨범" });
  await waitFor(() => expect(checkbox).toHaveProperty("indeterminate", true));
});

it("moves the selection to one folder", async () => {
  const user = userEvent.setup();
  const onMoveToFolder = vi.fn();
  render(
    <LibraryProvider gateway={createGateway(["tag"])}>
      <AssetInspector assets={[asset("a")]} classifications={classifications} albums={albums} open onOpenChange={vi.fn()} onMoveToFolder={onMoveToFolder} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  await user.selectOptions(await screen.findByLabelText("폴더"), "work");
  expect(onMoveToFolder).toHaveBeenCalledWith("work");
});

it("reports when classification membership cannot be loaded", async () => {
  const gateway = createGateway([], [], true);
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a")]} classifications={classifications} albums={albums} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );
  expect(await screen.findByText("폴더와 앨범 상태를 불러오지 못했습니다.")).toBeVisible();
});

function createGateway(classificationIds: string[], albumIds: string[] = [], reject = false): LibraryGateway {
  return {
    getAssetClassifications: vi.fn().mockImplementation(() => reject ? Promise.reject(new Error("membership failed")) : Promise.resolve(classificationIds)),
    getAssetAlbums: vi.fn().mockImplementation(() => reject ? Promise.reject(new Error("membership failed")) : Promise.resolve(albumIds)),
  } as unknown as LibraryGateway;
}

function asset(id: string): AssetSummary {
  return { id, title: null, originalName: `${id}.png`, byteSize: 1024, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: `https://example.com/source/${id}`, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } };
}
