import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSort, AssetView, CollectionSummary } from "../library/types";
import { AssetToolbar } from "./AssetToolbar";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));

const baseProps = {
  view: { kind: "classification", classificationId: null } as AssetView,
  classifications: [{ id: "game", kind: "root" as const, name: "게임", parentId: null, iconKey: null, colorKey: null }],
  albums: [{ id: "covers", name: "표지", parentId: null, iconKey: null, colorKey: null }],
  collections: [],
  sort: "newest" as AssetSort,
  mediaFilter: "all" as const,
  aspectFilter: "all" as const,
  directOnly: false,
  metadataVisible: true,
  privacyMode: false,
  onPrivacyModeChange: vi.fn(),
  thumbnailRowHeight: 180,
  onSortChange: vi.fn(),
  onMediaFilterChange: vi.fn(),
  onAspectFilterChange: vi.fn(),
  onDirectOnlyChange: vi.fn(),
  onMetadataVisibleChange: vi.fn(),
  onThumbnailRowHeightChange: vi.fn(),
  onReshuffle: vi.fn(),
};

afterEach(cleanup);

it("shows the fixed browsing slots regardless of the selection", () => {
  render(<AssetToolbar {...baseProps} />);

  expect(screen.getByRole("heading", { name: "저장소" })).toBeVisible();
  expect(screen.getByLabelText("정렬")).toBeVisible();
  expect(screen.getByLabelText("미리보기 크기")).toBeVisible();
  expect(screen.getByLabelText("정보 표시")).toBeVisible();
  expect(screen.getByLabelText("비공개 모드")).toBeVisible();
  expect(screen.getByLabelText("정렬 및 필터")).toBeVisible();
  expect(screen.getByLabelText("보기 설정")).toBeVisible();
  expect(screen.getByRole("button", { name: "미디어 필터: 전체" })).toBeVisible();
  expect(screen.getByRole("button", { name: "비율 필터: 전체" })).toBeVisible();
  expect(screen.queryByText("정렬·필터")).not.toBeInTheDocument();
  expect(screen.queryByText("현재 분류")).not.toBeInTheDocument();
  expect(screen.queryByText("정보")).not.toBeInTheDocument();
  expect(screen.queryByText("비공개")).not.toBeInTheDocument();
  // 선택 명령은 상단바가 아니라 SelectionBar가 담당한다.
  expect(screen.queryByText(/개 선택/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "좋아요 켜기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "휴지통으로 이동" })).not.toBeInTheDocument();
});

it("places media and aspect filters after sort only in asset browsing views", async () => {
  const user = userEvent.setup();
  const onMediaFilterChange = vi.fn();
  const onAspectFilterChange = vi.fn();
  const { rerender } = render(
    <AssetToolbar
      {...baseProps}
      onMediaFilterChange={onMediaFilterChange}
      onAspectFilterChange={onAspectFilterChange}
    />,
  );

  expect(screen.getAllByRole("combobox")).toHaveLength(1);
  expect(screen.getByRole("combobox", { name: "정렬" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "미디어 필터: 전체" }));
  await user.click(screen.getByRole("menuitem", { name: "이미지" }));
  expect(onMediaFilterChange).toHaveBeenCalledWith("images");

  await user.click(screen.getByRole("button", { name: "비율 필터: 전체" }));
  await user.click(screen.getByRole("menuitem", { name: "세로형" }));
  expect(onAspectFilterChange).toHaveBeenCalledWith("portrait");

  rerender(
    <AssetToolbar
      {...baseProps}
      view={{ kind: "collection", collectionId: "collection-1" }}
      onMediaFilterChange={onMediaFilterChange}
      onAspectFilterChange={onAspectFilterChange}
    />,
  );
  expect(screen.queryByRole("button", { name: /미디어 필터/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /비율 필터/ })).not.toBeInTheDocument();
});

it.each<AssetView>([
  { kind: "manga" },
  { kind: "settings" },
  { kind: "similarity_review" },
])("hides asset filters in the $kind view", (view) => {
  render(<AssetToolbar {...baseProps} view={view} />);

  expect(screen.queryByRole("button", { name: /미디어 필터/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /비율 필터/ })).not.toBeInTheDocument();
});

it("toggles privacy mode from the browsing controls", async () => {
  const user = userEvent.setup();
  const onPrivacyModeChange = vi.fn();
  render(<AssetToolbar {...baseProps} privacyMode onPrivacyModeChange={onPrivacyModeChange} />);

  const toggle = screen.getByRole("checkbox", { name: "비공개 모드" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(onPrivacyModeChange).toHaveBeenCalledWith(false);
});

it("does not show folder or album transfer controls that duplicate sidebar drag and drop", () => {
  render(<AssetToolbar {...baseProps} />);

  expect(screen.queryByLabelText("폴더")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "폴더로 이동" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("앨범")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "앨범에 추가" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "추가 작업" })).not.toBeInTheDocument();
});

it("places the current-classification folder toggle immediately before window controls", () => {
  const { container } = render(<AssetToolbar {...baseProps} />);
  const actions = container.querySelector(".view-toolbar__view-actions")!;
  const windowControls = container.querySelector(".window-controls")!;

  expect(actions.querySelector('input[aria-label="이 분류만"]')).toBeInTheDocument();
  expect(actions.nextElementSibling).toBe(windowControls);
});

it("acts as the window title bar with drag region and window controls", () => {
  const { container } = render(<AssetToolbar {...baseProps} />);
  const header = container.querySelector(".view-toolbar")!;
  expect(header).toHaveAttribute("data-tauri-drag-region");
  expect(container.querySelector(".view-toolbar h2")).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 최소화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 최대화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 최소화" }).querySelector("svg")).toBeInTheDocument();
});

it("uses the shared view toolbar with window controls", () => {
  const { container } = render(<AssetToolbar {...baseProps} />);
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("shows the collection name as the location in a collection detail view", () => {
  const collections: CollectionSummary[] = [{ id: "collection-1", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 3, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" }];
  render(<AssetToolbar {...baseProps} view={{ kind: "collection", collectionId: "collection-1" }} collections={collections} />);

  expect(screen.getByRole("heading", { name: "엘든 링" })).toBeVisible();
});

it("shows the reshuffle command only for random sort outside the recent view", async () => {
  const user = userEvent.setup();
  const onReshuffle = vi.fn();
  const { rerender } = render(<AssetToolbar {...baseProps} sort="random" onReshuffle={onReshuffle} />);

  await user.click(screen.getByRole("button", { name: "다시 섞기" }));
  expect(onReshuffle).toHaveBeenCalledOnce();

  rerender(<AssetToolbar {...baseProps} />);
  expect(screen.queryByRole("button", { name: "다시 섞기" })).not.toBeInTheDocument();
});

it("reserves the reshuffle slot without an interactive control", () => {
  const { container, rerender } = render(<AssetToolbar {...baseProps} />);

  const placeholder = container.querySelector(".asset-toolbar__action-placeholder") as HTMLElement;
  expect(placeholder.getAttribute("aria-hidden")).toBe("true");
  expect(placeholder.closest("button")).toBeNull();

  rerender(<AssetToolbar {...baseProps} sort="random" />);
  expect(container.querySelector(".asset-toolbar__action-placeholder")).toBeNull();
  expect(screen.getByRole("button", { name: "다시 섞기" })).toBeVisible();
});
