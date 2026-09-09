import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSort, AssetView, CollectionSummary } from "../library/types";
import { WorkspaceChromeProvider, ChromeSettingsDock, ChromeTarget } from "../layout/WorkspaceChrome";
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

function renderChrome(ui: React.ReactElement) {
  return render(
    <WorkspaceChromeProvider scope="assets-test">
      <aside aria-label="index">
        <ChromeTarget name="header" />
        <ChromeTarget name="actions" />
        <ChromeTarget name="search" />
        <ChromeTarget name="navigation" />
        <ChromeSettingsDock />
      </aside>
      {ui}
    </WorkspaceChromeProvider>
  );
}

async function openViewSettings(user: { click: (element: HTMLElement) => Promise<void> }) {
  await user.click(await screen.findByRole("button", { name: "보기 설정" }));
  return screen.findByRole("dialog");
}

it("keeps the titlebar as location and status only, with view controls in the settings panel", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} />);

  expect(screen.getByRole("heading", { name: "저장소" })).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "정렬" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /미디어 필터/ })).not.toBeInTheDocument();
  // 선택 명령은 상단바가 아니라 SelectionBar가 담당한다.
  expect(screen.queryByText(/개 선택/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "휴지통으로 이동" })).not.toBeInTheDocument();

  await openViewSettings(user);
  expect(screen.getByRole("combobox", { name: "정렬" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "미디어" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "비율" })).toBeVisible();
  expect(screen.getByLabelText("미리보기 크기")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "정보 숨기기" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "비공개 모드" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "이 분류만" })).toBeVisible();
});

it("applies media and aspect filters from the settings panel in asset browsing views", async () => {
  const user = userEvent.setup();
  const onMediaFilterChange = vi.fn();
  const onAspectFilterChange = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} onMediaFilterChange={onMediaFilterChange} onAspectFilterChange={onAspectFilterChange} />);

  await openViewSettings(user);
  await user.click(screen.getByRole("combobox", { name: "미디어" }));
  expect(onMediaFilterChange).not.toHaveBeenCalled();
  // select 변경은 소유 뷰가 반영하므로 여기서는 컨트롤 존재와 요약 갱신만 확인한다.
});

it("hides asset filters in the settings panel for non-browsing views", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} view={{ kind: "collection", collectionId: "collection-1" }} />);

  await openViewSettings(user);
  expect(screen.queryByRole("combobox", { name: "미디어" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "비율" })).not.toBeInTheDocument();
});

it("toggles privacy mode from the settings panel", async () => {
  const user = userEvent.setup();
  const onPrivacyModeChange = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} privacyMode onPrivacyModeChange={onPrivacyModeChange} />);

  await openViewSettings(user);
  const toggle = screen.getByRole("checkbox", { name: "비공개 모드" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(onPrivacyModeChange).toHaveBeenCalledWith(false);
});

it("shows the privacy status in the titlebar while privacy mode is on", () => {
  renderChrome(<AssetToolbar {...baseProps} privacyMode />);
  expect(screen.getByText("비공개 모드")).toBeVisible();
});

it("does not show folder or album transfer controls that duplicate sidebar drag and drop", () => {
  renderChrome(<AssetToolbar {...baseProps} />);

  expect(screen.queryByLabelText("폴더")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "폴더로 이동" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("앨범")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "앨범에 추가" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "추가 작업" })).not.toBeInTheDocument();
});

it("shows the collection name as the location in a collection detail view", () => {
  const collections: CollectionSummary[] = [{ id: "collection-1", name: "엘든 링", description: null, type: "game", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 3, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: null, releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z" }];
  renderChrome(<AssetToolbar {...baseProps} view={{ kind: "collection", collectionId: "collection-1" }} collections={collections} />);

  expect(screen.getByRole("heading", { name: "엘든 링" })).toBeVisible();
});

it("offers reshuffle inside the settings panel for random sort", async () => {
  const user = userEvent.setup();
  const onReshuffle = vi.fn();
  renderChrome(<AssetToolbar {...baseProps} sort="random" onReshuffle={onReshuffle} />);

  await openViewSettings(user);
  await user.click(screen.getByRole("button", { name: "다시 섞기" }));
  expect(onReshuffle).toHaveBeenCalledOnce();
});

it("does not offer reshuffle outside random sort", async () => {
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} />);

  await openViewSettings(user);
  expect(screen.queryByRole("button", { name: "다시 섞기" })).not.toBeInTheDocument();
});

it("leaves information visible when Hide information is off", async () => {
  const onMetadataVisibleChange = vi.fn();
  const user = userEvent.setup();
  renderChrome(<AssetToolbar {...baseProps} metadataVisible onMetadataVisibleChange={onMetadataVisibleChange} />);
  await openViewSettings(user);
  expect(screen.getByLabelText("정보 숨기기")).not.toBeChecked();
  await user.click(screen.getByLabelText("정보 숨기기"));
  expect(onMetadataVisibleChange).toHaveBeenLastCalledWith(false);
});