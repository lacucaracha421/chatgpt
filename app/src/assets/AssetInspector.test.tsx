import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AlbumEntry, AssetSummary, ClassificationEntry, CollectionSummary, LibraryGateway } from "../library/types";
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
const collections: CollectionSummary[] = [
  { id: "elden", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, assetCount: 1, unreadReleaseCount: 0, year: null, author: "프롬소프트", director: null, externalScore: 96, myScore: 95, genres: null, overview: null, showcase: false, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" },
  { id: "frieren", name: "프리렌", description: null, type: "manga", coverAssetId: null, selectedWorkArtworkId: null, assetCount: 1, unreadReleaseCount: 0, year: 2020, author: "야마다 카네히토", director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" },
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

it("shows source and provenance details with quiet external links", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[completeAsset()]} classifications={[]} albums={[]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("Example Artist (@example)")).toBeVisible();
  expect(screen.getByText("브라우저 확장")).toBeVisible();
  expect(screen.getByText("31d1f90c-214b-41e2-9d84-f9d964bb5bc3")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "제작자 페이지 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://x.com/example");
});

it("edits source metadata, normalizes blank values, and returns the updated asset", async () => {
  const user = userEvent.setup();
  const updated = { ...completeAsset(), creatorName: "Updated Artist", creatorHandle: null };
  const updateAssetMetadata = vi.fn().mockResolvedValue(updated);
  const onAssetUpdated = vi.fn();
  render(
    <LibraryProvider gateway={createGateway([], [], false, updateAssetMetadata)}>
      <AssetInspector assets={[completeAsset()]} classifications={[]} albums={[]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} onAssetUpdated={onAssetUpdated} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  await user.clear(screen.getByLabelText("제작자 이름"));
  await user.type(screen.getByLabelText("제작자 이름"), "  Updated Artist  ");
  await user.clear(screen.getByLabelText("계정명"));
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(updateAssetMetadata).toHaveBeenCalledWith({
    assetId: "complete",
    sourcePublishedAt: "2026-08-01T10:20:30Z",
    creatorName: "Updated Artist",
    creatorHandle: null,
    creatorUrl: "https://x.com/example",
  });
  expect(onAssetUpdated).toHaveBeenCalledWith(updated);
});

it("cancels editing on the first Escape without closing the inspector", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[completeAsset()]} classifications={[]} albums={[]} open onOpenChange={onOpenChange} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByLabelText("제작자 이름")).not.toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();

  await user.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("keeps the draft open when saving fails", async () => {
  const user = userEvent.setup();
  const updateAssetMetadata = vi.fn().mockRejectedValue(new Error("저장 실패"));
  render(
    <LibraryProvider gateway={createGateway([], [], false, updateAssetMetadata)}>
      <AssetInspector assets={[completeAsset()]} classifications={[]} albums={[]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  await user.clear(screen.getByLabelText("제작자 이름"));
  await user.type(screen.getByLabelText("제작자 이름"), "Draft Artist");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("저장 실패");
  expect(screen.getByLabelText("제작자 이름")).toHaveValue("Draft Artist");
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
  const getAssetCollections = vi.fn().mockResolvedValue([]);
  const gateway = { getAssetClassifications, getAssetAlbums, getAssetCollections } as unknown as LibraryGateway;
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
  expect(await screen.findByText("폴더, 앨범과 컬렉션 상태를 불러오지 못했습니다.")).toBeVisible();
});

it("checks a collection that every selected asset has and toggles it off", async () => {
  const gateway = createGateway([], [], false, vi.fn(), ["elden"]);
  const onPatchCollection = vi.fn();
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a")]} classifications={[]} albums={[]} collections={collections} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} onPatchCollection={onPatchCollection} />
    </LibraryProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", { name: "엘든 링 컬렉션" });
  expect(checkbox).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "프리렌 컬렉션" })).not.toBeChecked();

  await userEvent.click(checkbox);
  expect(onPatchCollection).toHaveBeenCalledWith("elden", "remove");
});

it("shows indeterminate collection state when only some of the selection is in a collection", async () => {
  const getAssetCollections = vi.fn().mockImplementation((assetId: string) => Promise.resolve(assetId === "a" ? ["elden"] : []));
  const gateway = { getAssetClassifications: vi.fn().mockResolvedValue([]), getAssetAlbums: vi.fn().mockResolvedValue([]), getAssetCollections } as unknown as LibraryGateway;
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a"), asset("b")]} classifications={[]} albums={[]} collections={collections} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} onPatchCollection={vi.fn()} />
    </LibraryProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", { name: "엘든 링 컬렉션" });
  await waitFor(() => expect(checkbox).toHaveProperty("indeterminate", true));
});

it("shows the active collection metadata for a game collection", async () => {
  const gateway = createGateway([], [], false, vi.fn(), ["elden"]);
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a")]} classifications={[]} albums={[]} collections={collections} currentCollection={collections[0]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );
  const section = await screen.findByRole("region", { name: "컬렉션 정보" });
  expect(within(section).getByText("엘든 링")).toBeVisible();
  expect(within(section).getByText("프롬소프트")).toBeVisible();
  expect(within(section).getByText("96")).toBeVisible();
  expect(within(section).getByText("95")).toBeVisible();
});

it("shows the active collection metadata for a manga collection", async () => {
  render(
    <LibraryProvider gateway={createGateway([], [], false, vi.fn(), ["frieren"])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} albums={[]} collections={collections} currentCollection={collections[1]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );
  const section = await screen.findByRole("region", { name: "컬렉션 정보" });
  expect(within(section).getByText("프리렌")).toBeVisible();
  expect(within(section).getByText("야마다 카네히토")).toBeVisible();
  expect(within(section).getByText("2020")).toBeVisible();
});

it("hides collection metadata when more than one asset is selected", async () => {
  render(
    <LibraryProvider gateway={createGateway([], [], false, vi.fn(), ["elden"])}>
      <AssetInspector assets={[asset("a"), asset("b")]} classifications={[]} albums={[]} collections={collections} currentCollection={collections[0]} open onOpenChange={vi.fn()} onMoveToFolder={vi.fn()} onPatchAlbum={vi.fn()} />
    </LibraryProvider>,
  );
  await screen.findByText("2개 자산 선택");
  expect(screen.queryByRole("region", { name: "컬렉션 정보" })).not.toBeInTheDocument();
});

function createGateway(classificationIds: string[], albumIds: string[] = [], reject = false, updateAssetMetadata = vi.fn(), collectionIds: string[] = []): LibraryGateway {
  return {
    getAssetClassifications: vi.fn().mockImplementation(() => reject ? Promise.reject(new Error("membership failed")) : Promise.resolve(classificationIds)),
    getAssetAlbums: vi.fn().mockImplementation(() => reject ? Promise.reject(new Error("membership failed")) : Promise.resolve(albumIds)),
    getAssetCollections: vi.fn().mockImplementation(() => reject ? Promise.reject(new Error("membership failed")) : Promise.resolve(collectionIds)),
    updateAssetMetadata,
  } as unknown as LibraryGateway;
}

function completeAsset(): AssetSummary {
  return {
    ...asset("complete"),
    sourcePublishedAt: "2026-08-01T10:20:30Z",
    creatorName: "Example Artist",
    creatorHandle: "example",
    creatorUrl: "https://x.com/example",
    importSource: "browser_extension",
    importBatchId: "31d1f90c-214b-41e2-9d84-f9d964bb5bc3",
    originalModifiedAt: "2026-08-01T09:00:00Z",
  };
}

function asset(id: string): AssetSummary {
  return { id, title: null, originalName: `${id}.png`, byteSize: 1024, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: `https://example.com/source/${id}`, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } };
}
