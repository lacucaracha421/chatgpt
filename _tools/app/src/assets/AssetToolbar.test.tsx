import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  metadataVisible: true, privacyMode: false, thumbnailRowHeight: 180,
  onPrivacyModeChange: vi.fn(), onSortChange: vi.fn(), onMediaFilterChange: vi.fn(), onAspectFilterChange: vi.fn(),
  onMetadataVisibleChange: vi.fn(), onThumbnailRowHeightChange: vi.fn(), onReshuffle: vi.fn(),
};

afterEach(() => { cleanup(); localStorage.clear(); });

function renderChrome(ui: React.ReactElement) {
  return render(<WorkspaceChromeProvider scope="assets-test"><aside aria-label="index"><ChromeTarget name="header" /><ChromeTarget name="actions" /><ChromeSettingsDock /></aside>{ui}</WorkspaceChromeProvider>);
}

it("keeps only title and View in the toolbar, with every choice in View", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} inspectorAvailable onInspectorOpenChange={vi.fn()} />);
  const header = screen.getByRole("toolbar", { name: "자산 도구" });
  expect(within(header).getByRole("heading", { name: "전체" })).toBeVisible();
  expect(within(header).getByRole("button", { name: "에셋 검색" })).toBeVisible();
  expect(within(header).getByRole("button", { name: "보기" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
  expect(screen.queryByRole("radiogroup", { name: "종류" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "보기" }));
  for (const name of ["종류", "정렬", "배치", "비율"]) expect(screen.getByRole("radiogroup", { name })).toBeVisible();
  expect(screen.getByRole("slider", { name: "한 줄에" })).toBeVisible();
  expect(screen.getByRole("switch", { name: "정보" })).toBeVisible();
});

it("groups 보기 into labelled sections: scope and kind first, layout and sort next, rarely used choices last", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} view={{ kind: "classification", classificationId: "game" }} inspectorAvailable onInspectorOpenChange={vi.fn()}
    scopeControl={<span>미분류 2 · 전체 167</span>} scopeHelp={<button type="button" aria-label="미분류와 전체 설명" />} />);
  await user.click(screen.getByRole("button", { name: "보기" }));
  const menu = screen.getByRole("menu");
  const sections = [...menu.querySelectorAll<HTMLElement>(".ui-view-options__section")];
  expect(sections.map(section => section.querySelector(".ui-section-label__title")?.textContent)).toEqual(["범위", "종류", "배치", "정렬", "비율", "표시"]);
  expect(within(sections[0].querySelector<HTMLElement>(".ui-section-label")!).getByRole("button", { name: "미분류와 전체 설명" })).toBeInTheDocument();
  expect(within(sections[0]).getByText("미분류 2 · 전체 167")).toBeInTheDocument();
  expect(within(sections[2]).getByRole("slider", { name: "한 줄에" })).toBeInTheDocument();
  expect(within(sections[5]).getAllByRole("switch").map(item => item.getAttribute("aria-label"))).toEqual(["비공개 모드", "NSFW 필터", "정보"]);
});

it("changes media kind from the segmented control", async () => {
  const user = userEvent.setup();
  const onMediaFilterChange = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} onMediaFilterChange={onMediaFilterChange} />);
  await user.click(screen.getByRole("button", { name: "보기" }));
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
  await user.click(screen.getByRole("button", { name: "보기" }));
  await user.click(screen.getByRole("button", { name: "다시 섞기" }));
  expect(onReshuffle).toHaveBeenCalledOnce();
});

it("keeps the folder scope choice out of the 보기 menu", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} view={{ kind: "classification", classificationId: "game" }} />);
  await user.click(screen.getByRole("button", { name: "보기" }));
  expect(screen.queryByRole("switch", { name: "하위 폴더 포함" })).not.toBeInTheDocument();
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

it("keeps View in the toolbar when the scope has no kind choice", () => {
  renderChrome(<AssetToolbar {...baseProps} view={{ kind: "trash" }} />);
  expect(screen.queryByRole("radiogroup", { name: "종류" })).not.toBeInTheDocument();
  expect(document.querySelector(".ui-section-bar")).toBeNull();
  const header = screen.getByRole("toolbar", { name: "자산 도구" });
  expect(within(header).queryByRole("button", { name: "정렬" })).not.toBeInTheDocument();
  expect(within(header).getByRole("button", { name: "보기" })).toBeVisible();
});


it("changes size with minus and plus while the slider has focus", async () => {
  renderChrome(<AssetToolbar {...baseProps} />);
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  const slider = screen.getByRole("slider", { name: "한 줄에" });
  const initial = Number((slider as HTMLInputElement).value);
  fireEvent.keyDown(slider, { key: "+" });
  expect(Number((slider as HTMLInputElement).value)).toBe(initial + 1);
  fireEvent.keyDown(slider, { key: "-" });
  expect(Number((slider as HTMLInputElement).value)).toBe(initial);
});
