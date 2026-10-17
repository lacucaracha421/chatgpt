import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetView } from "../library/types";
import { SelectionBar } from "./SelectionBar";

const baseProps = {
  view: { kind: "classification", classificationId: null } as AssetView,
  selectedCount: 3,
  batchPending: false,
  onTrash: vi.fn(),
  onClearSelection: vi.fn(),
};

afterEach(cleanup);

it("renders nothing when the selection is empty", () => {
  const { container } = render(<SelectionBar {...baseProps} selectedCount={0} />);

  expect(container).toBeEmptyDOMElement();
});

it("supports a narrow album-only selection bar without desktop actions", async () => {
  const user = userEvent.setup();
  const onAddToAlbum = vi.fn();
  render(<SelectionBar selectedCount={2} batchPending={false} onAddToAlbum={onAddToAlbum} onClearSelection={vi.fn()} />);

  expect(screen.getByRole("button", { name: "앨범에 추가" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "휴지통으로" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "앨범에 추가" }));
  expect(onAddToAlbum).toHaveBeenCalledOnce();
});

it("shows the selection size and keeps browsing commands keyboard reachable", async () => {
  const user = userEvent.setup();
  const onClearSelection = vi.fn();
  render(<SelectionBar {...baseProps} onClearSelection={onClearSelection} />);

  expect(screen.getByRole("toolbar", { name: "선택 작업" })).toBeVisible();
  expect(screen.getByText("3개 선택")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(onClearSelection).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "휴지통으로" })).toBeVisible();
});

it("places the character picker action first without a shortcut hint", () => {
  render(<SelectionBar {...baseProps} onCharacterToggle={vi.fn()} />);
  const toolbar = screen.getByRole("toolbar", { name: "선택 작업" });
  const buttons = within(toolbar).getAllByRole("button");
  expect(buttons[0]).toHaveTextContent("캐릭터");
  expect(buttons[0]).not.toHaveTextContent("C");
});

it("renders icon-only narrow actions with accessible names", () => {
  render(<SelectionBar {...baseProps} compact onCharacterToggle={vi.fn()} onAssignArtist={vi.fn()} />);

  expect(screen.getByRole("button", { name: "캐릭터 지정" })).toBeVisible();
  expect(screen.getByRole("button", { name: "작가 지정" })).toBeVisible();
  expect(screen.queryByText("캐릭터")).not.toBeInTheDocument();
  expect(screen.queryByText("작가 지정")).not.toBeInTheDocument();
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

  await user.click(screen.getByRole("button", { name: "이 컬렉션에서 빼기" }));
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
  expect(screen.getByRole("button", { name: "이 컬렉션에서 빼기" })).toBeVisible();
});

it("does not show collection actions outside a collection detail view", () => {
  render(<SelectionBar {...baseProps} selectedCount={1} />);

  expect(screen.queryByRole("button", { name: "이 컬렉션에서 빼기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "대표 이미지로 지정" })).not.toBeInTheDocument();
});

it("disables batch actions while a batch operation is pending", () => {
  render(<SelectionBar {...baseProps} batchPending />);

  expect(screen.getByRole("button", { name: "휴지통으로" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "선택 해제" })).not.toBeDisabled();
});

it.each([1, 3])("offers classification next to album assignment for %i selected assets through the shared picker slot", async (selectedCount) => {
  const user = userEvent.setup();
  const onCharacterToggle = vi.fn();
  render(<SelectionBar selectedCount={selectedCount} batchPending={false} onAddToAlbum={vi.fn()} onClearSelection={vi.fn()} characterLabel="분류" characterOpen onCharacterToggle={onCharacterToggle} characterPicker={<div>분류 변경 시트</div>} />);
  expect(screen.getByRole("button", { name: "앨범에 추가" })).toBeVisible();
  const classification = screen.getByRole("button", { name: "분류 지정" });
  expect(classification).toHaveTextContent("분류");
  expect(classification).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("분류 변경 시트")).toBeVisible();
  expect(screen.queryByText("C")).not.toBeInTheDocument();
  await user.click(classification);
  expect(onCharacterToggle).toHaveBeenCalledOnce();
});

it("adds the image menu button only where a host asks for it, before the clear button", async () => {
  const user = userEvent.setup();
  const onMore = vi.fn();
  const { rerender } = render(<SelectionBar {...baseProps} />);
  expect(screen.queryByRole("button", { name: "선택 항목 메뉴" })).not.toBeInTheDocument();
  rerender(<SelectionBar {...baseProps} onMore={onMore} />);
  const buttons = screen.getAllByRole("button");
  expect(buttons[buttons.length - 1]).toHaveAccessibleName("선택 해제");
  expect(buttons[buttons.length - 2]).toHaveAccessibleName("선택 항목 메뉴");
  await user.click(screen.getByRole("button", { name: "선택 항목 메뉴" }));
  expect(onMore).toHaveBeenCalledOnce();
});
