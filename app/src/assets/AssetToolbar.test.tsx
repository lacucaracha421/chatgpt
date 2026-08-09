import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSort, AssetView } from "../library/types";
import { AssetToolbar } from "./AssetToolbar";

const baseProps = {
  view: { kind: "classification", classificationId: null } as AssetView,
  classifications: [{ id: "game", kind: "root" as const, name: "게임", parentId: null }],
  sort: "newest" as AssetSort,
  directOnly: false,
  metadataVisible: true,
  thumbnailRowHeight: 180,
  selectedCount: 0,
  onSortChange: vi.fn(),
  onDirectOnlyChange: vi.fn(),
  onMetadataVisibleChange: vi.fn(),
  onThumbnailRowHeightChange: vi.fn(),
  onFavorite: vi.fn(),
  onClassification: vi.fn(),
  onTrash: vi.fn(),
  onClearSelection: vi.fn(),
  batchPending: false,
  onReshuffle: vi.fn(),
};

afterEach(cleanup);

it("shows everyday browsing controls when nothing is selected", () => {
  render(<AssetToolbar {...baseProps} />);

  expect(screen.getByRole("heading", { name: "전체 자산" })).toBeVisible();
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

  expect(screen.getByRole("menuitem", { name: "선택한 분류 제거" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "좋아요 끄기" })).toBeVisible();
});
