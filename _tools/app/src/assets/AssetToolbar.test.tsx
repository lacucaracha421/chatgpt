import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSort, AssetView, CollectionSummary } from "../library/types";
import { ChromeSettingsDock, ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { AssetToolbar } from "./AssetToolbar";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }) }));

const baseProps = {
  view: { kind: "classification", classificationId: null } as AssetView,
  classifications: [{ id: "game", kind: "root" as const, name: "게임", parentId: null, iconKey: null, colorKey: null }],
  albums: [{ id: "covers", name: "표지", parentId: null, iconKey: null, colorKey: null }],
  collections: [], sort: "newest" as AssetSort, mediaFilter: "all" as const, aspectFilter: "all" as const,
  directOnly: false, metadataVisible: true, privacyMode: false, thumbnailRowHeight: 180,
  onPrivacyModeChange: vi.fn(), onSortChange: vi.fn(), onMediaFilterChange: vi.fn(), onAspectFilterChange: vi.fn(),
  onDirectOnlyChange: vi.fn(), onMetadataVisibleChange: vi.fn(), onThumbnailRowHeightChange: vi.fn(), onReshuffle: vi.fn(),
};

afterEach(cleanup);

function renderChrome(ui: React.ReactElement) {
  return render(<WorkspaceChromeProvider scope="assets-test"><aside aria-label="index"><ChromeTarget name="header" /><ChromeTarget name="actions" /><ChromeSettingsDock /></aside>{ui}</WorkspaceChromeProvider>);
}

it("puts kind, sort, and view controls in the toolbar and removes sidebar view settings", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} inspectorAvailable onInspectorOpenChange={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "전체" })).toBeVisible();
  expect(screen.getByRole("radiogroup", { name: "종류" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "보기 설정" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "보기" }));
  expect(screen.getByRole("radiogroup", { name: "배치" })).toBeVisible();
  expect(screen.getByLabelText("미리보기 크기")).toBeVisible();
  expect(screen.getByRole("switch", { name: "정보" })).toBeVisible();
  expect(screen.queryByRole("switch", { name: "정보 숨기기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "비공개 모드" })).not.toBeInTheDocument();
});

it("changes media kind from the segmented control", async () => {
  const user = userEvent.setup();
  const onMediaFilterChange = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} onMediaFilterChange={onMediaFilterChange} />);
  await user.click(within(screen.getByRole("radiogroup", { name: "종류" })).getByRole("radio", { name: "영상" }));
  expect(onMediaFilterChange).toHaveBeenCalledWith("videos");
});

it("keeps aspect filtering inside the 보기 menu", async () => {
  const user = userEvent.setup();
  const onAspectFilterChange = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} onAspectFilterChange={onAspectFilterChange} />);
  expect(screen.queryByRole("button", { name: "비율" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "보기" }));
  await user.click(within(screen.getByRole("radiogroup", { name: "비율" })).getByRole("radio", { name: "세로형" }));
  expect(onAspectFilterChange).toHaveBeenCalledWith("portrait");
});

it("offers reshuffle only from the random sort menu", async () => {
  const user = userEvent.setup();
  const onReshuffle = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} sort="random" onReshuffle={onReshuffle} />);
  await user.click(screen.getByRole("button", { name: "정렬" }));
  await user.click(screen.getByRole("menuitem", { name: "다시 섞기" }));
  expect(onReshuffle).toHaveBeenCalledOnce();
});

it("offers 하위 폴더 포함 only in a folder, off while the folder shows only itself", async () => {
  const user = userEvent.setup();
  const onDirectOnlyChange = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} directOnly view={{ kind: "classification", classificationId: "game" }} onDirectOnlyChange={onDirectOnlyChange} />);
  await user.click(screen.getByRole("button", { name: "보기" }));
  const include = screen.getByRole("switch", { name: "하위 폴더 포함" });
  expect(include).not.toBeChecked();
  await user.click(include);
  expect(onDirectOnlyChange).toHaveBeenCalledWith(false);
});

it("shows collection names and no folder count", () => {
  const collections: CollectionSummary[] = [{ id: "collection-1", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 3, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" }];
  const { unmount } = renderChrome(<AssetToolbar {...baseProps} view={{ kind: "collection", collectionId: "collection-1" }} collections={collections} />);
  expect(screen.getByRole("heading", { name: "엘든 링" })).toBeVisible();
  unmount();
  renderChrome(<AssetToolbar {...baseProps} view={{ kind: "classification", classificationId: "game" }} classifications={[{ ...baseProps.classifications[0], assetCount: 428, totalAssetCount: 12345 }]} />);
  expect(screen.getByRole("heading", { name: "게임" })).toBeVisible();
  expect(screen.queryByText(/12,345/)).not.toBeInTheDocument();
});
