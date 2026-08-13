import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import { ClassificationSidebar } from "./ClassificationSidebar";
import { buildClassificationTree } from "./buildTree";

const entries: ClassificationEntry[] = [
  { id: "root", kind: "root", name: "Games", parentId: null, iconKey: null, colorKey: null },
  { id: "work", kind: "work", name: "Blue Archive", parentId: "root", iconKey: null, colorKey: null },
  { id: "tag", kind: "tag", name: "Arona", parentId: "work", iconKey: null, colorKey: null },
];

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
    getExtensionConnection: vi.fn(),
    listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]),
    createAlbum: vi.fn(),
    renameAlbum: vi.fn(),
    moveAlbum: vi.fn(),
    updateAlbumAppearance: vi.fn(),
    deleteAlbum: vi.fn(),
    createClassification: vi.fn().mockResolvedValue(entries[1]),
    renameClassification: vi.fn().mockResolvedValue(undefined),
    moveClassification: vi.fn().mockResolvedValue(undefined),
    updateClassificationAppearance: vi.fn().mockResolvedValue(undefined),
    deleteClassification: vi.fn().mockResolvedValue(undefined),
    listAssets: vi.fn(),
    indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(),
    decideSimilarityReview: vi.fn(),
    getAsset: vi.fn(),
    trashAssets: vi.fn(),
    restoreAsset: vi.fn(),
    restoreAssets: vi.fn(),
    listTrash: vi.fn(),
    emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn(),
    setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(),
    listMetadataBackups: vi.fn(),
    restoreMetadataBackup: vi.fn(),
    purgeExpiredTrash: vi.fn(),
    setAssetFavorite: vi.fn(),
    setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(),
    setAssetClassification: vi.fn(),
    patchAssetAlbums: vi.fn(),
    getAssetAlbums: vi.fn().mockResolvedValue([]),
    getMangaRoot: vi.fn().mockResolvedValue(null),
    setMangaRoot: vi.fn().mockResolvedValue(undefined),
    scanManga: vi.fn().mockResolvedValue(0),
    listMangaSeries: vi.fn().mockResolvedValue([]),
    ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(),
    retryVideoPreparation: vi.fn(),
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
          entries={props.entries ?? entries}
          view={view}
          expandedIds={expandedIds}
          sidebarWidth={sidebarWidth}
          reviewCount={props.reviewCount ?? 0}
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

  it("reports whether disconnected entries were omitted", () => {
    const tree = buildClassificationTree([...entries, { id: "lost", kind: "tag", name: "Lost", parentId: "missing", iconKey: null, colorKey: null }]);

    expect(tree.hasOrphans).toBe(true);
  });
});

describe("ClassificationSidebar", () => {
  it("creates the first album from the album heading context menu", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway, { albums: [] });

    fireEvent.contextMenu(screen.getByRole("button", { name: "앨범 접기" }));
    await user.click(screen.getByRole("menuitem", { name: "새 앨범" }));
    await user.type(screen.getByRole("textbox", { name: "폴더 이름" }), "표지");
    await user.keyboard("{Enter}");

    expect(fixtureGateway.createAlbum).toHaveBeenCalledWith({ name: "표지", parentId: null });
  });

  it("shows a nested album section and selects an album", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const fixtureGateway = gateway();
    render(
      <LibraryProvider gateway={fixtureGateway}>
        <ClassificationSidebar
          entries={entries}
          albums={[
            { id: "album-root", name: "표지", parentId: null, iconKey: null, colorKey: null },
            { id: "album-child", name: "게임 표지", parentId: "album-root", iconKey: null, colorKey: null },
          ]}
          view={{ kind: "classification", classificationId: null }}
          expandedIds={[]}
          expandedAlbumIds={["album-root"]}
          sidebarWidth={232}
          reviewCount={0}
          onViewChange={onViewChange}
          onExpandedIdsChange={vi.fn()}
          onExpandedAlbumIdsChange={vi.fn()}
          onSidebarWidthChange={vi.fn()}
          onChanged={vi.fn()}
          onAlbumsChanged={vi.fn()}
        />
      </LibraryProvider>,
    );

    expect(screen.getByText("앨범 (1)")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "앨범 접기" }));
    expect(screen.queryByRole("treeitem", { name: "표지" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "앨범 펼치기" }));
    await user.click(screen.getByRole("treeitem", { name: "게임 표지" }));
    expect(onViewChange).toHaveBeenCalledWith({ kind: "album", albumId: "album-child" });
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "표지" }));
    await user.click(screen.getByRole("menuitem", { name: "하위 앨범 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "폴더 이름" }), "캐릭터");
    await user.keyboard("{Enter}");
    expect(fixtureGateway.createAlbum).toHaveBeenCalledWith({ name: "캐릭터", parentId: "album-root" });
  });
  beforeEach(() => {
  });

  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it("changes all-assets and quick views without fake classification IDs", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderSidebar();

    const quickViews = screen.getByRole("navigation", { name: "빠른 보기" });
    expect(within(quickViews).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "저장소",
      "미분류",
      "최근",
      "즐겨찾기",
      "유사 검토0",
      "망가",
    ]);

    await user.click(screen.getByRole("button", { name: "미분류" }));
    await user.click(screen.getByRole("button", { name: "즐겨찾기" }));
    await user.click(screen.getByRole("button", { name: "최근" }));
    await user.click(screen.getByRole("button", { name: "저장소" }));

    expect(onViewChange).toHaveBeenNthCalledWith(1, { kind: "unsorted" });
    expect(onViewChange).toHaveBeenNthCalledWith(2, { kind: "favorites" });
    expect(onViewChange).toHaveBeenNthCalledWith(3, { kind: "recent" });
    expect(onViewChange).toHaveBeenNthCalledWith(4, { kind: "classification", classificationId: null });
  });

  it("keeps trash and settings in the sidebar footer", () => {
    renderSidebar(gateway());

    const trash = screen.getByRole("button", { name: "휴지통" });
    const settings = screen.getByRole("button", { name: "설정" });
    expect(trash.closest(".classification-sidebar__footer")).not.toBeNull();
    expect(settings.closest(".classification-sidebar__footer")).not.toBeNull();
  });

  it("keeps compact selection surfaces inside full interaction rows", () => {
    renderSidebar();

    const storage = screen.getByRole("button", { name: "저장소" });
    expect(storage).toHaveAttribute("aria-current", "page");
    expect(storage.querySelector(":scope > .classification-sidebar__quick-view-surface")).not.toBeNull();

    const games = screen.getByRole("treeitem", { name: "Games" });
    expect(games).toHaveAttribute("aria-expanded", "true");
    expect(games.querySelector(":scope > .classification-sidebar__tree-toggle")).not.toBeNull();
    expect(games.querySelector(":scope > .classification-sidebar__tree-surface")).not.toBeNull();
    expect(games.querySelector(".classification-sidebar__tree-toggle-mark")).toHaveAttribute("data-state", "expanded");
  });

  it("marks only tree items that have a following sibling", () => {
    const siblingEntries = [
      ...entries,
      { id: "root-2", kind: "root", name: "Images", parentId: null, iconKey: null, colorKey: null },
    ] satisfies ClassificationEntry[];
    renderSidebar(gateway(), { entries: siblingEntries });

    const gamesItem = screen.getByRole("treeitem", { name: "Games" }).closest("li");
    const imagesItem = screen.getByRole("treeitem", { name: "Images" }).closest("li");
    expect(gamesItem).toHaveAttribute("data-has-next-sibling", "true");
    expect(imagesItem).not.toHaveAttribute("data-has-next-sibling");
  });

  it("opens settings from the sidebar footer", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "설정" }));

    expect(onViewChange).toHaveBeenCalledWith({ kind: "settings" });
  });

  it("opens a top-level inline folder editor when the global create request increments", async () => {
    const fixtureGateway = gateway();
    function Fixture() {
      const [request, setRequest] = useState(0);
      return <>
        <button onClick={() => setRequest((current) => current + 1)}>request</button>
        <LibraryProvider gateway={fixtureGateway}>
          <ClassificationSidebar entries={entries} view={{ kind: "classification", classificationId: null }} expandedIds={["root", "work"]} sidebarWidth={232} reviewCount={0} createClassificationRequest={request} onViewChange={vi.fn()} onExpandedIdsChange={vi.fn()} onSidebarWidthChange={vi.fn()} onChanged={vi.fn()} />
        </LibraryProvider>
      </>;
    }
    render(<Fixture />);
    await userEvent.click(screen.getByRole("button", { name: "request" }));
    expect(screen.getByRole("textbox", { name: "폴더 이름" })).toHaveFocus();
  });

  it("opens trash from the shared quick-view navigation", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "휴지통" }));

    expect(onViewChange).toHaveBeenCalledWith({ kind: "trash" });
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

  it("counts top-level folders and renders custom icon and connector colors", () => {
    const styledEntries = [
      { ...entries[0], iconKey: "photo", colorKey: "pink" },
      entries[1],
      entries[2],
      { id: "root-2", kind: "root", name: "Images", parentId: null, iconKey: null, colorKey: null },
    ] satisfies ClassificationEntry[];
    renderSidebar(gateway(), { entries: styledEntries });

    expect(screen.getByText("폴더 (2)")).toBeVisible();
    const games = screen.getByRole("treeitem", { name: "Games" });
    expect(games.querySelector("[data-icon-key='photo']")).toHaveStyle({ color: "#df6fa7" });
    expect(games.querySelector(".classification-sidebar__tree-label")).not.toHaveAttribute("style");
    const group = games.closest("li")?.querySelector(":scope > [role='group']") as HTMLElement;
    expect(group.style.getPropertyValue("--classification-branch-color")).toBe("#df6fa7");
    expect(screen.getByRole("treeitem", { name: "Blue Archive" }).querySelector("[data-icon-key='book']")).toBeInTheDocument();
  });

  it("opens the row context menu from both keyboard menu shortcuts", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const row = screen.getByRole("treeitem", { name: "Games" });
    row.focus();

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "아이콘 및 색상" })).toBeVisible();
    await user.keyboard("{Escape}");

    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(screen.getByRole("menuitem", { name: "아이콘 및 색상" })).toBeVisible();
  });

  it("updates appearance from the folder context menu", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    const { onChanged } = renderSidebar(fixtureGateway);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "아이콘 및 색상" }));
    await user.click(screen.getByRole("radio", { name: "사진" }));
    await user.click(screen.getByRole("radio", { name: "분홍" }));
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(fixtureGateway.updateClassificationAppearance).toHaveBeenCalledWith("tag", "photo", "pink"));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("creates top-level and child folders inline from context menus", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);

    fireEvent.contextMenu(screen.getByRole("tree", { name: "폴더" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "새 폴더" }));
    await user.type(screen.getByRole("textbox", { name: "폴더 이름" }), "Comics{Enter}");
    await waitFor(() => expect(fixtureGateway.createClassification).toHaveBeenCalledWith({ kind: "root", name: "Comics", parentId: null }));

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Games" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "하위 폴더 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "폴더 이름" }), "Characters{Enter}");
    await waitFor(() => expect(fixtureGateway.createClassification).toHaveBeenLastCalledWith({ kind: "tag", name: "Characters", parentId: "root" }));
  });

  it("saves an inline folder rename with Enter", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Blue Archive" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "이름 변경" }));
    const input = screen.getByRole("textbox", { name: "폴더 이름" });
    await user.clear(input);
    await user.type(input, "Archive{Enter}");

    await waitFor(() => expect(fixtureGateway.renameClassification).toHaveBeenCalledWith("work", "Archive"));
  });

  it("keeps the inline editor open when a folder name is blank or creation fails", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    vi.mocked(fixtureGateway.createClassification).mockRejectedValue(new Error("같은 위치에 같은 이름의 폴더가 있습니다."));
    renderSidebar(fixtureGateway);

    await user.click(screen.getByRole("button", { name: "새 폴더" }));
    const input = screen.getByRole("textbox", { name: "폴더 이름" });
    await user.type(input, "   {Enter}");
    expect(screen.getByText("폴더 이름을 입력해 주세요.")).toBeVisible();
    expect(fixtureGateway.createClassification).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "Games{Enter}");
    expect(await screen.findByText("같은 위치에 같은 이름의 폴더가 있습니다.")).toBeVisible();
    expect(input).toBeInTheDocument();
  });

  it("uses right-click-only folder actions in the approved order", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);
    const row = screen.getByRole("treeitem", { name: /Blue Archive/ });

    expect(screen.queryByRole("button", { name: /추가 작업/ })).not.toBeInTheDocument();
    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["하위 폴더 만들기", "이름 변경", "아이콘 및 색상", "폴더 이동", "삭제 — 하위 폴더 있음"]);
    await user.click(screen.getByRole("menuitem", { name: "이름 변경" }));
    const rename = screen.getByRole("textbox", { name: "폴더 이름" });
    await user.clear(rename);
    await user.type(rename, "Archive{Escape}");
    expect(fixtureGateway.renameClassification).not.toHaveBeenCalled();

    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "폴더 이동" }));
    expect(screen.getByRole("dialog", { name: "폴더 이동" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "취소" }));

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(fixtureGateway.deleteClassification).toHaveBeenCalledWith("tag"));
  });

  it("routes folder shortcuts through the same create, rename, and delete flows", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const games = screen.getByRole("treeitem", { name: "Games" });

    fireEvent.keyDown(games, { key: "N", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("textbox", { name: "폴더 이름" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await user.click(games);
    fireEvent.keyDown(games, { key: "n", altKey: true });
    expect(screen.getByRole("textbox", { name: "폴더 이름" })).toHaveFocus();
    await user.keyboard("{Escape}");

    fireEvent.keyDown(games, { key: "F2" });
    expect(screen.getByRole("textbox", { name: "폴더 이름" })).toHaveValue("Games");
    await user.keyboard("{Escape}");

    fireEvent.keyDown(games, { key: "Delete" });
    expect(screen.getByRole("status")).toHaveTextContent("하위 폴더가 있어 삭제할 수 없습니다.");
    expect(screen.queryByRole("dialog", { name: "폴더 삭제" })).not.toBeInTheDocument();
  });

  it("disables deletion for folders with children and explains why", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Games" }), { clientX: 20, clientY: 20 });

    const deleteItem = screen.getByRole("menuitem", { name: "삭제 — 하위 폴더 있음" });
    expect(deleteItem).toHaveAttribute("data-disabled");
    await user.click(deleteItem);
    expect(fixtureGateway.deleteClassification).not.toHaveBeenCalled();
  });

  it("explains asset promotion before deleting a child folder", async () => {
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));

    expect(screen.getByText("이 폴더의 자산은 Blue Archive 폴더로 이동합니다.")).toBeVisible();
  });

  it("explains that deleting a root preserves assets and removes its folder link", async () => {
    const user = userEvent.setup();
    const rootEntries = [...entries, { id: "empty", kind: "root", name: "Unused", parentId: null, iconKey: null, colorKey: null }] satisfies ClassificationEntry[];
    renderSidebar(gateway(), { entries: rootEntries });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Unused" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));

    expect(screen.getByText("자산은 보존되고 이 폴더 연결만 제거됩니다.")).toBeVisible();
  });

  it("selects the parent and removes the deleted child from expanded folders", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    const { onChanged, onExpandedIdsChange, onViewChange } = renderSidebar(fixtureGateway, { expandedIds: ["root", "work", "tag"] });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(fixtureGateway.deleteClassification).toHaveBeenCalledWith("tag"));
    expect(onExpandedIdsChange).toHaveBeenCalledWith(["root", "work"]);
    expect(onViewChange).toHaveBeenCalledWith({ kind: "classification", classificationId: "work" });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("selects all assets after deleting an empty root", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    const rootEntries = [...entries, { id: "empty", kind: "root", name: "Unused", parentId: null, iconKey: null, colorKey: null }] satisfies ClassificationEntry[];
    const { onViewChange } = renderSidebar(fixtureGateway, { entries: rootEntries, view: { kind: "classification", classificationId: "empty" } });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Unused" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(fixtureGateway.deleteClassification).toHaveBeenCalledWith("empty"));
    expect(onViewChange).toHaveBeenCalledWith({ kind: "classification", classificationId: null });
  });

  it("omits the moving folder and its descendants from move targets", async () => {
    const user = userEvent.setup();
    const nestedEntries = [
      ...entries,
      { id: "child", kind: "tag", name: "School Uniform", parentId: "tag", iconKey: null, colorKey: null },
    ] satisfies ClassificationEntry[];
    renderSidebar(gateway(), { entries: nestedEntries, expandedIds: ["root", "work", "tag"] });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "폴더 이동" }));

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Games");
    expect(options).toContain("Blue Archive");
    expect(options).not.toContain("Arona");
    expect(options).not.toContain("School Uniform");
  });

  it("keeps root folders fixed and uses a distinct work-folder icon", () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Games" }), { clientX: 20, clientY: 20 });
    expect(screen.getByRole("menuitem", { name: "이동 — 최상위 폴더" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("treeitem", { name: "Blue Archive" }).querySelector("[data-icon-key='book']")).toBeInTheDocument();
  });

  it("offers only root folders when moving a work folder", async () => {
    const user = userEvent.setup();
    const rootEntries = [...entries, { id: "root-2", kind: "root", name: "Images", parentId: null, iconKey: null, colorKey: null }] satisfies ClassificationEntry[];
    renderSidebar(gateway(), { entries: rootEntries });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Blue Archive" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "폴더 이동" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Games", "Images"]);
  });

  it("expands the destination after moving from the dialog", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    const rootEntries = [...entries, { id: "root-2", kind: "root", name: "Images", parentId: null, iconKey: null, colorKey: null }] satisfies ClassificationEntry[];
    const { onExpandedIdsChange } = renderSidebar(fixtureGateway, { entries: rootEntries, expandedIds: ["root", "work"] });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "폴더 이동" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "상위 폴더" }), "root-2");
    await user.click(screen.getByRole("button", { name: "이동" }));

    await waitFor(() => expect(fixtureGateway.moveClassification).toHaveBeenCalledWith("tag", "root-2"));
    expect(onExpandedIdsChange).toHaveBeenCalledWith(["root", "work", "root-2"]);
  });

  it("keeps delete confirmation open and shows the reason when deletion fails", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    vi.mocked(fixtureGateway.deleteClassification).mockRejectedValue(new Error("하위 폴더나 자산이 있어 삭제할 수 없습니다."));
    renderSidebar(fixtureGateway);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Arona" }), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제" }));

    expect(await screen.findByText("하위 폴더나 자산이 있어 삭제할 수 없습니다.")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "폴더 삭제" })).toBeInTheDocument();
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
          reviewCount={0}
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

  it("emits integer sidebar widths clamped to 176 and 320", () => {
    const { onSidebarWidthChange } = renderSidebar(gateway(), { sidebarWidth: 232 });
    const handle = screen.getByRole("separator", { name: "사이드바 너비 조절" });
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

    expect(onSidebarWidthChange).toHaveBeenNthCalledWith(1, 176);
    expect(onSidebarWidthChange).toHaveBeenNthCalledWith(2, 320);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("makes the sidebar heading a window drag region", () => {
    renderSidebar();

    expect(document.querySelector(".classification-sidebar__heading")).toHaveAttribute("data-tauri-drag-region");
  });

  it("opens the stable review queue entry and exposes its count", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderSidebar(gateway(), { reviewCount: 12 });

    const button = screen.getByRole("button", { name: "유사 검토 12개" });
    await user.click(button);
    expect(onViewChange).toHaveBeenCalledWith({ kind: "similarity_review" });
  });

  it("opens the manga quick view", async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "망가" }));

    expect(onViewChange).toHaveBeenCalledWith({ kind: "manga" });
  });
});
