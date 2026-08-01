import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import { ClassificationSidebar } from "./ClassificationSidebar";
import { buildClassificationTree } from "./buildTree";

const entries: ClassificationEntry[] = [
  { id: "root", kind: "root", name: "Games", parentId: null },
  { id: "work", kind: "work", name: "Blue Archive", parentId: "root" },
  { id: "tag", kind: "tag", name: "Arona", parentId: "work" },
];

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn().mockResolvedValue(entries[1]),
    renameClassification: vi.fn().mockResolvedValue(undefined),
    moveClassification: vi.fn().mockResolvedValue(undefined),
    deleteClassification: vi.fn().mockResolvedValue(undefined),
    listAssets: vi.fn(),
    setAssetFavorite: vi.fn(),
    setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    ingestImage: vi.fn(),
  };
}

function renderSidebar(
  libraryGateway = gateway(),
  props: Partial<ComponentProps<typeof ClassificationSidebar>> = {},
) {
  const onViewChange = vi.fn();
  const onExpandedIdsChange = vi.fn();
  const onSidebarWidthChange = vi.fn();
  const onChanged = vi.fn();

  function Fixture() {
    const [view, setView] = useState<AssetView>(props.view ?? { kind: "classification", classificationId: null });
    const [expandedIds, setExpandedIds] = useState(props.expandedIds ?? ["root", "work"]);
    const [sidebarWidth, setSidebarWidth] = useState(props.sidebarWidth ?? 232);
    return (
      <LibraryProvider gateway={libraryGateway}>
        <ClassificationSidebar
          entries={entries}
          view={view}
          expandedIds={expandedIds}
          sidebarWidth={sidebarWidth}
          onViewChange={(nextView) => {
            setView(nextView);
            onViewChange(nextView);
          }}
          onExpandedIdsChange={(ids) => {
            setExpandedIds(ids);
            onExpandedIdsChange(ids);
          }}
          onSidebarWidthChange={(width) => {
            setSidebarWidth(width);
            onSidebarWidthChange(width);
          }}
          onChanged={onChanged}
        />
      </LibraryProvider>
    );
  }

  render(<Fixture />);
  return { libraryGateway, onChanged, onExpandedIdsChange, onSidebarWidthChange, onViewChange };
}

describe("buildClassificationTree", () => {
  it("orders roots and children alphabetically without losing their kinds", () => {
    const tree = buildClassificationTree([...entries].reverse());

    expect(tree.map((node) => node.entry.name)).toEqual(["Games"]);
    expect(tree[0].children[0].entry.kind).toBe("work");
    expect(tree[0].children[0].children[0].entry).toMatchObject({ name: "Arona", kind: "tag" });
  });

  it("returns disconnected entries as orphans instead of dropping them", () => {
    const tree = buildClassificationTree([...entries, { id: "lost", kind: "tag", name: "Lost", parentId: "missing" }]);

    expect(tree.orphans).toEqual([{ id: "lost", kind: "tag", name: "Lost", parentId: "missing" }]);
  });
});

describe("ClassificationSidebar", () => {
  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
    });
  });

  afterEach(cleanup);

  it("changes all-assets and quick views without fake classification IDs", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "즐겨찾기" }));
    await user.click(screen.getByRole("button", { name: "최근" }));
    await user.click(screen.getByRole("button", { name: "전체 자산" }));

    expect(onViewChange).toHaveBeenNthCalledWith(1, { kind: "favorites" });
    expect(onViewChange).toHaveBeenNthCalledWith(2, { kind: "recent" });
    expect(onViewChange).toHaveBeenNthCalledWith(3, { kind: "classification", classificationId: null });
  });

  it("expands and collapses without changing the selected view", async () => {
    const user = userEvent.setup();
    const { onExpandedIdsChange, onViewChange } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Games 접기" }));
    expect(onExpandedIdsChange).toHaveBeenCalledWith(["work"]);
    expect(onViewChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("treeitem", { name: /Blue Archive/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Games 펼치기" }));
    expect(onExpandedIdsChange).toHaveBeenLastCalledWith(["work", "root"]);
  });

  it("selects a classification row without toggling its expansion", async () => {
    const user = userEvent.setup();
    const { onExpandedIdsChange, onViewChange } = renderSidebar();

    await user.click(screen.getByRole("treeitem", { name: /Blue Archive/ }));

    expect(onViewChange).toHaveBeenCalledWith({ kind: "classification", classificationId: "work" });
    expect(onExpandedIdsChange).not.toHaveBeenCalled();
  });

  it("creates root and selected child classifications using the existing rules", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);

    await user.click(screen.getByRole("button", { name: "분류 추가" }));
    await user.type(screen.getByLabelText("이름"), "Comics");
    await user.click(screen.getByRole("button", { name: "추가" }));
    await waitFor(() => expect(fixtureGateway.createClassification).toHaveBeenCalledWith({ kind: "root", name: "Comics", parentId: null }));

    await user.click(screen.getByRole("treeitem", { name: /Games/ }));
    await user.click(screen.getByRole("button", { name: "분류 추가" }));
    await user.type(screen.getByLabelText("이름"), "New work");
    await user.click(screen.getByRole("button", { name: "추가" }));
    await waitFor(() => expect(fixtureGateway.createClassification).toHaveBeenLastCalledWith({ kind: "work", name: "New work", parentId: "root" }));
  });

  it("uses the same rename, move, and delete actions from ellipsis and right-click", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);
    const row = screen.getByRole("treeitem", { name: /Blue Archive/ });

    await user.click(screen.getByRole("button", { name: "Blue Archive 추가 작업" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["이름 변경", "이동", "삭제"]);
    await user.click(screen.getByRole("menuitem", { name: "이름 변경" }));
    expect(screen.getByRole("dialog", { name: "분류 이름 변경" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "취소" }));

    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "이동" }));
    expect(screen.getByRole("dialog", { name: "분류 이동" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "취소" }));

    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(fixtureGateway.deleteClassification).toHaveBeenCalledWith("work"));
  });

  it("honors controlled expanded IDs", () => {
    renderSidebar(gateway(), { expandedIds: [] });

    expect(screen.queryByRole("treeitem", { name: /Blue Archive/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Games 펼치기" })).toBeInTheDocument();
  });

  it("uses one roving tab stop for visible rows and moves it vertically", () => {
    renderSidebar();
    const games = screen.getByRole("treeitem", { name: "Games" });
    const blueArchive = screen.getByRole("treeitem", { name: "Blue Archive" });
    const arona = screen.getByRole("treeitem", { name: "Arona" });

    expect([games, blueArchive, arona].map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    games.focus();
    fireEvent.keyDown(games, { key: "ArrowDown" });
    expect(blueArchive).toHaveFocus();
    fireEvent.keyDown(blueArchive, { key: "End" });
    expect(arona).toHaveFocus();
    fireEvent.keyDown(arona, { key: "Home" });
    expect(games).toHaveFocus();
    fireEvent.keyDown(games, { key: "ArrowUp" });
    expect(games).toHaveFocus();
  });

  it("uses Left and Right for visible hierarchy without selecting rows", () => {
    const { onExpandedIdsChange, onViewChange } = renderSidebar(gateway(), { expandedIds: [] });
    const games = screen.getByRole("treeitem", { name: "Games" });

    games.focus();
    fireEvent.keyDown(games, { key: "ArrowRight" });
    expect(onExpandedIdsChange).toHaveBeenLastCalledWith(["root"]);
    fireEvent.keyDown(games, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "Blue Archive" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Blue Archive" }), { key: "ArrowLeft" });
    expect(games).toHaveFocus();
    fireEvent.keyDown(games, { key: "ArrowLeft" });
    expect(onExpandedIdsChange).toHaveBeenLastCalledWith([]);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("recovers focus to the nearest visible ancestor after a controlled collapse", () => {
    const fixtureGateway = gateway();
    const onViewChange = vi.fn();
    const onExpandedIdsChange = vi.fn();
    const onSidebarWidthChange = vi.fn();
    const onChanged = vi.fn();
    const sidebar = (expandedIds: string[]) => (
      <LibraryProvider gateway={fixtureGateway}>
        <ClassificationSidebar
          entries={entries}
          view={{ kind: "classification", classificationId: null }}
          expandedIds={expandedIds}
          sidebarWidth={232}
          onViewChange={onViewChange}
          onExpandedIdsChange={onExpandedIdsChange}
          onSidebarWidthChange={onSidebarWidthChange}
          onChanged={onChanged}
        />
      </LibraryProvider>
    );
    const { rerender } = render(sidebar(["root", "work"]));
    const arona = screen.getByRole("treeitem", { name: "Arona" });

    arona.focus();
    rerender(sidebar([]));

    const games = screen.getByRole("treeitem", { name: "Games" });
    expect(games).toHaveFocus();
    expect(games.tabIndex).toBe(0);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("keeps expand-button keyboard events out of tree-row navigation", async () => {
    const user = userEvent.setup();
    const { onExpandedIdsChange, onViewChange } = renderSidebar();
    const expand = screen.getByRole("button", { name: "Games 접기" });

    expand.focus();
    fireEvent.keyDown(expand, { key: "ArrowDown" });
    expect(expand).toHaveFocus();
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onExpandedIdsChange).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onExpandedIdsChange).toHaveBeenLastCalledWith(["work"]);
    await user.keyboard(" ");
    expect(onExpandedIdsChange).toHaveBeenLastCalledWith(["work", "root"]);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("keeps menu-trigger keyboard events out of tree-row navigation", async () => {
    const user = userEvent.setup();
    const { onExpandedIdsChange, onViewChange } = renderSidebar();
    const trigger = screen.getByRole("button", { name: "Games 추가 작업" });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveFocus();
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onExpandedIdsChange).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(" ");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("emits integer sidebar widths clamped to 184 and 360", () => {
    const { onSidebarWidthChange } = renderSidebar(gateway(), { sidebarWidth: 232 });
    const handle = screen.getByRole("separator", { name: "사이드바 크기 조절" });
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(handle, "setPointerCapture");
    vi.spyOn(handle, "releasePointerCapture");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -100.4 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400.4 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onSidebarWidthChange).toHaveBeenNthCalledWith(1, 184);
    expect(onSidebarWidthChange).toHaveBeenNthCalledWith(2, 360);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});
