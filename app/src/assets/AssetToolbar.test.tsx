import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSort, AssetView } from "../library/types";
import { AssetToolbar } from "./AssetToolbar";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));

const baseProps = {
  view: { kind: "classification", classificationId: null } as AssetView,
  classifications: [{ id: "game", kind: "root" as const, name: "게임", parentId: null, iconKey: null, colorKey: null }],
  albums: [{ id: "covers", name: "표지", parentId: null, iconKey: null, colorKey: null }],
  sort: "newest" as AssetSort,
  directOnly: false,
  metadataVisible: true,
  thumbnailRowHeight: 180,
  selectedCount: 0,
  inspectorOpen: false,
  onInspectorToggle: vi.fn(),
  onSortChange: vi.fn(),
  onDirectOnlyChange: vi.fn(),
  onMetadataVisibleChange: vi.fn(),
  onThumbnailRowHeightChange: vi.fn(),
  onFavorite: vi.fn(),
  onMoveToFolder: vi.fn(),
  onAlbum: vi.fn(),
  onTrash: vi.fn(),
  onClearSelection: vi.fn(),
  batchPending: false,
  onReshuffle: vi.fn(),
};

afterEach(cleanup);

it("shows everyday browsing controls when nothing is selected", () => {
  render(<AssetToolbar {...baseProps} />);

  expect(screen.getByRole("heading", { name: "저장소" })).toBeVisible();
  expect(screen.getByLabelText("정렬")).toBeVisible();
  expect(screen.getByLabelText("미리보기 크기")).toBeVisible();
  expect(screen.getByLabelText("정보 표시")).toBeVisible();
  expect(screen.queryByText(/개 선택/)).not.toBeInTheDocument();
});

it("replaces browsing controls with compact selection actions", async () => {
  const user = userEvent.setup();
  const onFavorite = vi.fn();
  const onClearSelection = vi.fn();
  render(<AssetToolbar {...baseProps} selectedCount={3} onFavorite={onFavorite} onClearSelection={onClearSelection} />);

  expect(screen.getByText("3개 선택")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "좋아요 켜기" }));
  expect(onFavorite).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(onClearSelection).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeVisible();
  expect(screen.queryByLabelText("정렬")).not.toBeInTheDocument();
});

it("keeps uncommon selection actions in the overflow menu", async () => {
  const user = userEvent.setup();
  render(<AssetToolbar {...baseProps} selectedCount={2} />);

  await user.click(screen.getByRole("button", { name: "추가 작업" }));

  expect(screen.getByRole("menuitem", { name: "앨범에서 제거" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "좋아요 끄기" })).toBeVisible();
});

it("moves a selection to one folder and adds it to an album", async () => {
  const user = userEvent.setup();
  const onMoveToFolder = vi.fn();
  const onAlbum = vi.fn();
  render(<AssetToolbar {...baseProps} selectedCount={2} onMoveToFolder={onMoveToFolder} onAlbum={onAlbum} />);

  await user.selectOptions(screen.getByLabelText("폴더"), "game");
  await user.click(screen.getByRole("button", { name: "폴더로 이동" }));
  expect(onMoveToFolder).toHaveBeenCalledWith("game");

  await user.selectOptions(screen.getByLabelText("앨범"), "covers");
  await user.click(screen.getByRole("button", { name: "앨범에 추가" }));
  expect(onAlbum).toHaveBeenCalledWith("covers", "add");
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

it("toggles the inspector from the selection actions", async () => {
  const user = userEvent.setup();
  const onInspectorToggle = vi.fn();
  render(<AssetToolbar {...baseProps} selectedCount={1} inspectorOpen={false} onInspectorToggle={onInspectorToggle} />);

  const open = screen.getByRole("button", { name: "정보 열기" });
  await user.click(open);
  expect(onInspectorToggle).toHaveBeenCalledOnce();

  render(<AssetToolbar {...baseProps} selectedCount={1} inspectorOpen={true} onInspectorToggle={onInspectorToggle} />);
  expect(screen.getByRole("button", { name: "정보 닫기" })).toBeVisible();
});
