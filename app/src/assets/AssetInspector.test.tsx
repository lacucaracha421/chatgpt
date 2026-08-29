import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, CollectionSummary, LibraryGateway } from "../library/types";
import { AssetInspector } from "./AssetInspector";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
afterEach(() => { cleanup(); openUrl.mockClear(); vi.unstubAllGlobals(); });

const collections: CollectionSummary[] = [
  { id: "elden", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 1, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: "프롬소프트", developer: "프롬소프트", publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null, externalScore: 96, myScore: 5, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" },
  { id: "frieren", name: "프리렌", description: null, type: "manga", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 1, unreadReleaseCount: 0, year: 2020, originalTitle: null, runtimeMinutes: null, author: "야마다 카네히토", developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" },
];

it("hides the open control when there is no selection", () => {
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[]} open={false} onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("stays collapsed by default and renders nothing while closed", () => {
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open={false} onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("closes from Escape while focus is inside the inspector", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={onOpenChange} />
    </LibraryProvider>,
  );

  screen.getByRole("button", { name: "정보 닫기" }).focus();
  await user.keyboard("{Escape}");

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("shows one-asset metadata and opens its source URL", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("example.com/source/a")).toBeVisible();
  expect(screen.getByText("200×100")).toBeVisible();
  expect(screen.queryByText("a.png")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "출처 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://example.com/source/a");
});

it("copies the source URL to the clipboard", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 복사" }));
  expect(writeText).toHaveBeenCalledWith("https://example.com/source/a");
});

it("opens the viewer from the preview and groups the metadata into sections", async () => {
  const user = userEvent.setup();
  const onOpenAsset = vi.fn();
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={vi.fn()} onOpenAsset={onOpenAsset} />
    </LibraryProvider>,
  );

  expect(screen.getByRole("heading", { name: "출처" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "파일" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "가져오기" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "a.png 감상 화면으로 열기" }));
  expect(onOpenAsset).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
});

it("shows the playback duration only for video assets", () => {
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[videoAsset()]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("1:05")).toBeVisible();

  cleanup();
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByText("재생 시간")).not.toBeInTheDocument();
});

it("shows source and provenance details with quiet external links", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[completeAsset()]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("Example Artist (@example)")).toBeVisible();
  expect(screen.getByText("브라우저 확장")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "제작자 페이지 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://x.com/example");
});

it("edits source metadata, normalizes blank values, and returns the updated asset", async () => {
  const user = userEvent.setup();
  const updated = { ...completeAsset(), creatorName: "Updated Artist", creatorHandle: null };
  const updateAssetMetadata = vi.fn().mockResolvedValue(updated);
  const onAssetUpdated = vi.fn();
  render(
    <LibraryProvider gateway={createGateway(updateAssetMetadata)}>
      <AssetInspector assets={[completeAsset()]} open onOpenChange={vi.fn()} onAssetUpdated={onAssetUpdated} />
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
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[completeAsset()]} open onOpenChange={onOpenChange} />
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
    <LibraryProvider gateway={createGateway(updateAssetMetadata)}>
      <AssetInspector assets={[completeAsset()]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 정보 편집" }));
  await user.clear(screen.getByLabelText("제작자 이름"));
  await user.type(screen.getByLabelText("제작자 이름"), "Draft Artist");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("저장 실패");
  expect(screen.getByLabelText("제작자 이름")).toHaveValue("Draft Artist");
});

it("shows the active collection metadata for a game collection", () => {
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} currentCollection={collections[0]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  const section = screen.getByRole("region", { name: "컬렉션 정보" });
  expect(within(section).getByText("엘든 링")).toBeVisible();
  expect(within(section).getByText("프롬소프트")).toBeVisible();
  expect(within(section).getByText("96")).toBeVisible();
  expect(within(section).getByText("5")).toBeVisible();
});

it("shows the active collection metadata for a manga collection", () => {
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} currentCollection={collections[1]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  const section = screen.getByRole("region", { name: "컬렉션 정보" });
  expect(within(section).getByText("프리렌")).toBeVisible();
  expect(within(section).getByText("야마다 카네히토")).toBeVisible();
  expect(within(section).getByText("2020")).toBeVisible();
});

it("hides collection metadata when more than one asset is selected", () => {
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a"), asset("b")]} currentCollection={collections[0]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("2개 자산 선택")).toBeVisible();
  expect(screen.queryByRole("region", { name: "컬렉션 정보" })).not.toBeInTheDocument();
});

function createGateway(updateAssetMetadata = vi.fn()): LibraryGateway {
  return {
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

function videoAsset(): AssetSummary {
  return { ...asset("video"), originalName: "video.mp4", media: { kind: "video", durationMs: 65_000, preparationState: "ready", scrubFrameCount: 0 } };
}
it("shows feedback when copying the source URL fails", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockRejectedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(
    <LibraryProvider gateway={createGateway()}>
      <AssetInspector assets={[asset("a")]} open onOpenChange={vi.fn()} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "출처 복사" }));

  expect(await screen.findByText("출처를 복사하지 못했습니다.")).toBeVisible();
});
