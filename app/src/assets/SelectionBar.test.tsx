import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetView } from "../library/types";
import { SelectionBar } from "./SelectionBar";

const baseProps = {
  view: { kind: "classification", classificationId: null } as AssetView,
  selectedCount: 3,
  inspectorOpen: false,
  batchPending: false,
  onInspectorToggle: vi.fn(),
  onFavorite: vi.fn(),
  onTrash: vi.fn(),
  onClearSelection: vi.fn(),
};

afterEach(cleanup);

it("renders nothing when the selection is empty", () => {
  const { container } = render(<SelectionBar {...baseProps} selectedCount={0} />);

  expect(container).toBeEmptyDOMElement();
});

it("shows the selection size and keeps browsing commands keyboard reachable", async () => {
  const user = userEvent.setup();
  const onFavorite = vi.fn();
  const onClearSelection = vi.fn();
  render(<SelectionBar {...baseProps} onFavorite={onFavorite} onClearSelection={onClearSelection} />);

  expect(screen.getByRole("toolbar", { name: "선택 작업" })).toBeVisible();
  expect(screen.getByText("3개 선택")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "좋아요 켜기" }));
  expect(onFavorite).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole("button", { name: "좋아요 끄기" }));
  expect(onFavorite).toHaveBeenCalledWith(false);
  await user.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(onClearSelection).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeVisible();
});

it("keeps collection actions inside a collection detail view", async () => {
  const user = userEvent.setup();
  const onRemoveFromCollection = vi.fn();
  render(
    <SelectionBar
      {...baseProps}
      view={{ kind: "collection", collectionId: "collection-1" }}
      onRemoveFromCollection={onRemoveFromCollection}
    />,
  );

  await user.click(screen.getByRole("button", { name: "이 컬렉션에서 제거" }));
  expect(onRemoveFromCollection).toHaveBeenCalledOnce();
});

it("sets the selected asset as the collection cover when exactly one is selected", async () => {
  const user = userEvent.setup();
  const onSetCover = vi.fn();
  render(
    <SelectionBar
      {...baseProps}
      view={{ kind: "collection", collectionId: "collection-1" }}
      selectedCount={1}
      onSetCover={onSetCover}
    />,
  );

  await user.click(screen.getByRole("button", { name: "대표 이미지로 지정" }));
  expect(onSetCover).toHaveBeenCalledOnce();
});

it("hides the cover action outside a single-selection collection detail", () => {
  render(
    <SelectionBar
      {...baseProps}
      view={{ kind: "collection", collectionId: "collection-1" }}
      selectedCount={2}
    />,
  );

  expect(screen.queryByRole("button", { name: "대표 이미지로 지정" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이 컬렉션에서 제거" })).toBeVisible();
});

it("does not show collection actions outside a collection detail view", () => {
  render(<SelectionBar {...baseProps} selectedCount={1} />);

  expect(screen.queryByRole("button", { name: "이 컬렉션에서 제거" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "대표 이미지로 지정" })).not.toBeInTheDocument();
});

it("toggles the inspector from the selection bar", async () => {
  const user = userEvent.setup();
  const onInspectorToggle = vi.fn();
  const { rerender } = render(
    <SelectionBar {...baseProps} selectedCount={1} inspectorOpen={false} onInspectorToggle={onInspectorToggle} />,
  );

  await user.click(screen.getByRole("button", { name: "정보 열기" }));
  expect(onInspectorToggle).toHaveBeenCalledOnce();

  rerender(<SelectionBar {...baseProps} selectedCount={1} inspectorOpen={true} onInspectorToggle={onInspectorToggle} />);
  expect(screen.getByRole("button", { name: "정보 닫기" })).toBeVisible();
});

it("disables batch actions while a batch operation is pending", () => {
  render(<SelectionBar {...baseProps} batchPending />);

  expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "좋아요 켜기" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "선택 해제" })).not.toBeDisabled();
});